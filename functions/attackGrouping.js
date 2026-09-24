/**
 * Faction attack grouping. One document per faction: attackGroupings/{factionId}.
 * Leader and co-leader can edit and appoint generals. Generals can edit tiers only.
 * Clients cache the document and pass the last revision; a matching revision returns no body.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CALLABLE_CORS = [
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
  'https://jimidy-s-faction-tools.web.app',
  'https://jimidy-s-faction-tools.firebaseapp.com',
  /^https:\/\/jimidy1982\.github\.io$/,
];

function callableOpts(more) {
  return {
    region: 'us-central1',
    invoker: 'public',
    cors: CALLABLE_CORS,
    ...(more || {}),
  };
}

const COLLECTION = 'attackGroupings';
const VIP_BALANCES = 'vipBalances';
const VIP_POOLS = 'vipFactionPools';
const MAX_TIERS = 10;
const MIN_TIERS = 1;
const MAX_GENERALS = 30;
const MAX_IDS_PER_TIER = 120;
const METHODS = new Set(['equal', 'statRange', 'manual']);
const TORN_USER_CACHE_TTL_MS = 3 * 60 * 1000;
const VIP_CACHE_MS = 5 * 60 * 1000;
const tornUserCache = new Map();
const vipCache = new Map();

function getDb() {
  return admin.firestore();
}

function vipLevelFromBalance(balance) {
  const b = Number(balance) || 0;
  if (b >= 100) return 3;
  if (b >= 50) return 2;
  if (b >= 10) return 1;
  return 0;
}

function pruneTornUserCache(now) {
  if (tornUserCache.size < 80) return;
  for (const [k, v] of tornUserCache) {
    if (!v || v.expiresAt <= now) tornUserCache.delete(k);
  }
}

function leadershipRole(position) {
  const p = String(position || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (p === 'leader') return 'leader';
  if (p === 'co-leader' || p === 'co leader' || p === 'coleader') return 'coleader';
  return null;
}

async function fetchUserFromApiKey(apiKey) {
  const key = String(apiKey || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '');
  if (key.length !== 16) throw new HttpsError('invalid-argument', 'Invalid API key');
  const now = Date.now();
  const cached = tornUserCache.get(key);
  if (cached && cached.expiresAt > now && cached.user) {
    return { ...cached.user, apiKey: key };
  }
  const url = `https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    const err = data.error;
    const msg = typeof err === 'object' ? err.error || err.message || 'Torn API error' : String(err);
    throw new HttpsError('invalid-argument', 'Torn API: ' + msg);
  }
  const playerId = data.player_id != null ? String(data.player_id) : null;
  if (!playerId) throw new HttpsError('internal', 'No player_id');
  const name = data.name || data.player_name || 'Player';
  const fac = data.faction && typeof data.faction === 'object' ? data.faction : null;
  const rawFactionId =
    data.faction_id != null
      ? data.faction_id
      : fac && fac.faction_id != null
        ? fac.faction_id
        : fac && fac.id != null
          ? fac.id
          : null;
  const factionId = rawFactionId != null ? String(rawFactionId) : null;
  const position = fac && fac.position != null ? String(fac.position) : '';
  const user = { playerId, name, factionId, position };
  tornUserCache.set(key, { user, expiresAt: now + TORN_USER_CACHE_TTL_MS });
  pruneTornUserCache(now);
  return { ...user, apiKey: key };
}

function assertSameFaction(userFactionId, docFactionId) {
  if (!userFactionId || String(userFactionId) !== String(docFactionId)) {
    throw new HttpsError('permission-denied', 'You must be in this faction');
  }
}

async function assertVip3(playerId, factionId) {
  const cacheKey = String(playerId) + ':' + String(factionId || '');
  const hit = vipCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    if (hit.level < 3) throw new HttpsError('permission-denied', 'Attack Grouping requires VIP 3');
    return;
  }
  const db = getDb();
  const [playerSnap, poolSnap] = await Promise.all([
    db.collection(VIP_BALANCES).doc(String(playerId)).get(),
    factionId
      ? db.collection(VIP_POOLS).doc(String(factionId)).get()
      : Promise.resolve(null),
  ]);
  const personal = playerSnap.exists ? Number(playerSnap.data().currentBalance) || 0 : 0;
  let level = vipLevelFromBalance(personal);
  if (poolSnap && poolSnap.exists) {
    const d = poolSnap.data() || {};
    const count = Number(d.memberCount) || 0;
    const combined = Number(d.combinedBalance) || 0;
    if (count >= 1) level = vipLevelFromBalance(combined);
  }
  vipCache.set(cacheKey, { level, expiresAt: Date.now() + VIP_CACHE_MS });
  if (level < 3) {
    throw new HttpsError('permission-denied', 'Attack Grouping requires VIP 3');
  }
}

function normalizeIdList(arr, max) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  const cap = max == null ? MAX_IDS_PER_TIER : max;
  for (const id of arr) {
    const s = String(id == null ? '' : id).trim();
    if (!/^\d+$/.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function normalizeBound(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function normalizeSide(raw, tierCount) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const method = METHODS.has(src.method) ? src.method : 'equal';
  const srcRanges = Array.isArray(src.ranges) ? src.ranges : [];
  const srcTiers = Array.isArray(src.tiers) ? src.tiers : [];
  const ranges = [];
  const tiers = [];
  const seen = new Set();
  for (let i = 0; i < tierCount; i++) {
    const r = srcRanges[i] && typeof srcRanges[i] === 'object' ? srcRanges[i] : {};
    let min = normalizeBound(r.min);
    let max = normalizeBound(r.max);
    if (min != null && max != null && min > max) {
      const swap = min;
      min = max;
      max = swap;
    }
    ranges.push({ min, max });
    const ids = [];
    const entry = srcTiers[i];
    const list = Array.isArray(entry)
      ? entry
      : (entry && Array.isArray(entry.ids) ? entry.ids : []);
    for (const id of list) {
      const s = String(id == null ? '' : id).trim();
      if (!/^\d+$/.test(s) || seen.has(s)) continue;
      seen.add(s);
      ids.push(s);
      if (ids.length >= MAX_IDS_PER_TIER) break;
    }
    tiers.push(ids);
  }
  return { method, ranges, tiers };
}

function emptySide(tierCount) {
  return normalizeSide({ method: 'equal', ranges: [], tiers: [] }, tierCount);
}

/** Firestore rejects an array of arrays, so each tier is stored as { ids }. */
function sideForStore(side) {
  return {
    method: side.method,
    ranges: side.ranges,
    tiers: (side.tiers || []).map((ids) => ({ ids: ids || [] })),
  };
}

function publicGrouping(doc) {
  const tierCount = Math.max(MIN_TIERS, Math.min(MAX_TIERS, parseInt(doc.tierCount, 10) || 5));
  return {
    revision: Number(doc.revision) || 0,
    updatedAt: Number(doc.updatedAt) || 0,
    updatedByName: doc.updatedByName ? String(doc.updatedByName) : '',
    updatedByPlayerId: doc.updatedByPlayerId ? String(doc.updatedByPlayerId) : '',
    warEnemyFactionId: doc.warEnemyFactionId ? String(doc.warEnemyFactionId) : '',
    tierCount,
    generalPlayerIds: normalizeIdList(doc.generalPlayerIds, MAX_GENERALS),
    our: normalizeSide(doc.our, tierCount),
    targets: normalizeSide(doc.targets, tierCount),
  };
}

function viewerFrom(user, docData) {
  const role = leadershipRole(user.position);
  const generals = normalizeIdList(docData && docData.generalPlayerIds, MAX_GENERALS);
  const isGeneral = generals.includes(String(user.playerId));
  const canManageGenerals = role === 'leader' || role === 'coleader';
  const canEdit = canManageGenerals || isGeneral;
  let label = 'member';
  if (role) label = role;
  else if (isGeneral) label = 'general';
  return {
    playerId: String(user.playerId),
    name: user.name || '',
    canEdit,
    canManageGenerals,
    isGeneral,
    role: label,
  };
}

function assertCanEdit(user, docData) {
  const viewer = viewerFrom(user, docData);
  if (!viewer.canEdit) {
    throw new HttpsError(
      'permission-denied',
      'Only the leader, a co-leader, or a general can edit attack grouping'
    );
  }
  return viewer;
}

async function fetchOwnMemberIdSet(apiKey) {
  const url = `https://api.torn.com/v2/faction/members?striptags=true&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    const err = data.error;
    const msg = typeof err === 'object' ? err.error || err.message || 'Torn API error' : String(err);
    throw new HttpsError('failed-precondition', 'Could not verify faction members: ' + msg);
  }
  const members = data.members || [];
  const list = Array.isArray(members) ? members : Object.values(members);
  const ids = new Set();
  for (const m of list) {
    const id = m && (m.id != null ? m.id : m.player_id);
    if (id != null && /^\d+$/.test(String(id))) ids.add(String(id));
  }
  return ids;
}

async function loadAuthorized(request) {
  const body = request.data || {};
  const fid = String(body.factionId || '').trim();
  if (!/^\d+$/.test(fid)) throw new HttpsError('invalid-argument', 'factionId required');
  const user = await fetchUserFromApiKey(body.apiKey);
  assertSameFaction(user.factionId, fid);
  await assertVip3(user.playerId, fid);
  return { user, fid, body };
}

exports.attackGroupingGet = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { user, fid, body } = await loadAuthorized(request);
  const ref = getDb().collection(COLLECTION).doc(fid);
  const snap = await ref.get();
  const exists = snap.exists;
  const doc = exists ? snap.data() || {} : null;
  const revision = exists ? Number(doc.revision) || 0 : 0;
  const known = Number(body.revision);
  const unchanged = exists && Number.isFinite(known) && known > 0 && known === revision;
  return {
    exists,
    revision,
    unchanged,
    viewer: viewerFrom(user, doc),
    grouping: unchanged || !exists ? null : publicGrouping(doc),
  };
});

exports.attackGroupingSave = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { user, fid, body } = await loadAuthorized(request);
  const tierCount = parseInt(body.tierCount, 10);
  if (!Number.isFinite(tierCount) || tierCount < MIN_TIERS || tierCount > MAX_TIERS) {
    throw new HttpsError('invalid-argument', 'Tier count must be from 1 to 10');
  }
  const warEnemyFactionId = String(body.warEnemyFactionId || '').trim();
  if (!/^\d+$/.test(warEnemyFactionId)) {
    throw new HttpsError('invalid-argument', 'A current war enemy is required');
  }
  const our = normalizeSide(body.our, tierCount);
  const targets = normalizeSide(body.targets, tierCount);

  const ref = getDb().collection(COLLECTION).doc(fid);
  const grouping = await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() || {} : {};
    const viewer = assertCanEdit(user, prev);
    const revision = (Number(prev.revision) || 0) + 1;
    const next = {
      revision,
      updatedAt: Date.now(),
      updatedByPlayerId: String(user.playerId),
      updatedByName: user.name || '',
      warEnemyFactionId,
      tierCount,
      generalPlayerIds: normalizeIdList(prev.generalPlayerIds, MAX_GENERALS),
      our: sideForStore(our),
      targets: sideForStore(targets),
    };
    tx.set(ref, next);
    return { grouping: publicGrouping(next), viewer };
  });
  return { exists: true, revision: grouping.grouping.revision, unchanged: false, ...grouping };
});

exports.attackGroupingSetGenerals = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { user, fid, body } = await loadAuthorized(request);
  if (!leadershipRole(user.position)) {
    throw new HttpsError('permission-denied', 'Only the leader or a co-leader can choose generals');
  }
  const memberIds = await fetchOwnMemberIdSet(user.apiKey);
  const requested = normalizeIdList(body.generalPlayerIds, MAX_GENERALS).filter((id) => memberIds.has(id));

  const ref = getDb().collection(COLLECTION).doc(fid);
  const saved = await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() || {} : {};
    if (!leadershipRole(user.position)) {
      throw new HttpsError('permission-denied', 'Only the leader or a co-leader can choose generals');
    }
    const tierCount = Math.max(MIN_TIERS, Math.min(MAX_TIERS, parseInt(prev.tierCount, 10) || 5));
    const revision = (Number(prev.revision) || 0) + 1;
    const next = {
      revision,
      updatedAt: Date.now(),
      updatedByPlayerId: String(user.playerId),
      updatedByName: user.name || '',
      warEnemyFactionId: prev.warEnemyFactionId ? String(prev.warEnemyFactionId) : '',
      tierCount,
      generalPlayerIds: requested,
      our: sideForStore(prev.our ? normalizeSide(prev.our, tierCount) : emptySide(tierCount)),
      targets: sideForStore(prev.targets ? normalizeSide(prev.targets, tierCount) : emptySide(tierCount)),
    };
    tx.set(ref, next);
    return publicGrouping(next);
  });
  return {
    exists: true,
    revision: saved.revision,
    unchanged: false,
    viewer: viewerFrom(user, saved),
    grouping: saved,
  };
});
