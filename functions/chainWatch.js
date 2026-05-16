/**
 * Faction chain watch list: owner + designated organisers edit; all faction members read/sign up/remove self.
 * All access via callables; Firestore path: factionChainWatch/{factionId}
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const { validateAdminApiKey } = require('./adminAuth');

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

const COLLECTION = 'factionChainWatch';
const ARCHIVED_SUB = 'archived';
const MAX_HOUR_SLOTS = 50 * 24; // 50 days hourly
const MAX_ORGANIZERS = 30;
const MAX_ARCHIVES_LIST = 40;
/** Auto-archive when chain start was 3+ days ago and nothing changed for 3+ days. */
const AUTO_ARCHIVE_AFTER_START_SEC = 3 * 24 * 3600;
const AUTO_ARCHIVE_INACTIVITY_SEC = 3 * 24 * 3600;

/** Next TCT calendar midnight (00:00 UTC) after the instant `startSec`. */
function tctNextMidnightUnix(startSec) {
  const d = new Date(startSec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0) / 1000);
}

/** Hourly slots from chain start until end of that TCT day (hours until next 00:00 UTC). */
function firstTctDaySlotCount(startSec) {
  if (startSec == null || !Number.isFinite(startSec)) return 0;
  const nextMid = tctNextMidnightUnix(startSec);
  const n = Math.max(0, Math.floor((nextMid - startSec) / 3600));
  return n === 0 ? 1 : n;
}

function maxVisibleTctDaysForStart(startSec) {
  const first = firstTctDaySlotCount(startSec);
  return 1 + Math.ceil((MAX_HOUR_SLOTS - first) / 24);
}
const CHAIN_TARGETS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
const CHAIN_TARGET_SET = new Set(CHAIN_TARGETS);

function getDb() {
  return admin.firestore();
}

async function fetchUserFromApiKey(apiKey) {
  const key = String(apiKey || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '');
  if (key.length !== 16) throw new HttpsError('invalid-argument', 'Invalid API key');
  const url = `https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new HttpsError('invalid-argument', 'Torn API: ' + String(data.error));
  const playerId = data.player_id != null ? String(data.player_id) : null;
  if (!playerId) throw new HttpsError('internal', 'No player_id');
  const name =
    data.name ||
    data.player_name ||
    (data.profile && data.profile.name) ||
    'Player';
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
  return { playerId, name, factionId, apiKey: key };
}

function assertSameFaction(userFactionId, docFactionId) {
  if (!userFactionId || String(userFactionId) !== String(docFactionId)) {
    throw new HttpsError('permission-denied', 'You must be in this faction');
  }
}

function normalizeOrganizerIds(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const id of arr) {
    const s = String(id).trim();
    if (!/^\d+$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_ORGANIZERS) break;
  }
  return out;
}

/** Owner always can edit; organisers can edit settings; legacy docs without owner allow any member until claimed. */
function viewerPermissions(docData, userPlayerId) {
  const pid = String(userPlayerId);
  const owner =
    docData && docData.ownerPlayerId != null && docData.ownerPlayerId !== ''
      ? String(docData.ownerPlayerId)
      : null;
  const organizerPlayerIds = normalizeOrganizerIds(docData && docData.organizerPlayerIds);

  if (!owner) {
    return {
      canEdit: true,
      isOwner: false,
      canManageOrganizers: false,
      ownerPlayerId: null,
      ownerName: docData && docData.ownerName ? String(docData.ownerName) : null,
      organizerPlayerIds,
    };
  }

  const isOwner = pid === owner;
  const isOrganizer = organizerPlayerIds.includes(pid);
  return {
    canEdit: isOwner || isOrganizer,
    isOwner,
    canManageOrganizers: isOwner,
    ownerPlayerId: owner,
    ownerName: docData && docData.ownerName ? String(docData.ownerName) : null,
    organizerPlayerIds,
  };
}

function assertCanEditSchedule(docData, user) {
  const perms = viewerPermissions(docData, user.playerId);
  if (!perms.canEdit) {
    throw new HttpsError(
      'permission-denied',
      'Only the chain watch owner or designated organisers can edit settings'
    );
  }
  return perms;
}

function metaFieldsFromDoc(docData) {
  if (!docData) return {};
  const out = {};
  if (docData.ownerPlayerId != null && docData.ownerPlayerId !== '') {
    out.ownerPlayerId = String(docData.ownerPlayerId);
  }
  if (docData.ownerName != null && docData.ownerName !== '') {
    out.ownerName = String(docData.ownerName);
  }
  if (Array.isArray(docData.organizerPlayerIds)) {
    out.organizerPlayerIds = normalizeOrganizerIds(docData.organizerPlayerIds);
  }
  return out;
}

function defaultSlotsObject() {
  const slots = {};
  for (let i = 0; i < MAX_HOUR_SLOTS; i++) slots[String(i)] = [];
  return slots;
}

/** Remove one watcher column (0-based index; never 0). Shift higher cols down. */
function stripWatcherColumnFromSlots(slots, removeColIdx) {
  const out = {};
  for (let i = 0; i < MAX_HOUR_SLOTS; i++) {
    const k = String(i);
    const list = Array.isArray(slots[k]) ? slots[k] : [];
    const next = [];
    for (const w of list) {
      const c = Number(w.col);
      if (!Number.isFinite(c)) continue;
      if (c === removeColIdx) continue;
      if (c > removeColIdx) {
        next.push({ ...w, col: c - 1 });
      } else {
        next.push(w);
      }
    }
    out[k] = next;
  }
  return out;
}

function defaultSettings() {
  return {
    chainName: '',
    chainStartUnix: null,
    chainTarget: 1000,
    backupColumns: 1,
    rewardType: 'cash',
    rewardFirst: 0,
    rewardSubsequent: 0,
    maxSignupsPer24h: 10,
  };
}

function normalizeDoc(d) {
  if (!d) return null;
  const settings = { ...defaultSettings(), ...(d.settings || {}) };
  let slots = d.slots;
  if (!slots || typeof slots !== 'object') slots = defaultSlotsObject();
  else {
    for (let i = 0; i < MAX_HOUR_SLOTS; i++) {
      const k = String(i);
      if (!Array.isArray(slots[k])) slots[k] = [];
    }
  }
  const chainState = {
    lastCurrent: d.chainState?.lastCurrent != null ? Number(d.chainState.lastCurrent) : 0,
    brokeAtHit: d.chainState?.brokeAtHit != null ? Number(d.chainState.brokeAtHit) : null,
    brokeAtUnix: d.chainState?.brokeAtUnix != null ? Number(d.chainState.brokeAtUnix) : null,
  };
  return { settings, slots, chainState };
}

/** Active watch slots in the rolling 24h window (leaving removes you; ended hours do not count). */
function countActiveSignupsLast24h(slots, playerId, nowMs, chainStartUnix) {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  const nowSec = Math.floor(nowMs / 1000);
  const startSec =
    chainStartUnix != null && Number.isFinite(Number(chainStartUnix))
      ? Math.floor(Number(chainStartUnix))
      : null;
  let n = 0;
  Object.entries(slots).forEach(([key, arr]) => {
    if (startSec != null) {
      const idx = parseInt(key, 10);
      if (Number.isFinite(idx)) {
        const slotEndSec = startSec + (idx + 1) * 3600;
        if (nowSec >= slotEndSec) return;
      }
    }
    (arr || []).forEach((w) => {
      if (String(w.playerId) === String(playerId) && watcherAtToMs(w.at) > cutoff) n++;
    });
  });
  return n;
}

function archiveSummaryFromDoc(archiveId, d) {
  const s = d.settings || {};
  const cs = d.chainState || {};
  return {
    archiveId: String(archiveId),
    archivedAt: d.archivedAt?.toMillis?.() || null,
    archivedByPlayerId: d.archivedByPlayerId != null ? String(d.archivedByPlayerId) : null,
    archivedByName: d.archivedByName ? String(d.archivedByName) : null,
    chainName: s.chainName != null ? String(s.chainName) : '',
    chainTarget: s.chainTarget != null ? Number(s.chainTarget) : null,
    chainStartUnix: s.chainStartUnix != null ? Number(s.chainStartUnix) : null,
    brokeAtHit: cs.brokeAtHit != null ? Number(cs.brokeAtHit) : null,
    lastCurrent: cs.lastCurrent != null ? Number(cs.lastCurrent) : null,
  };
}

function watcherAtToMs(at) {
  if (at == null) return 0;
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t < 1e12 ? t : t;
}

/** Latest signup or doc update (ms). */
function lastActivityMsFromDoc(raw) {
  if (!raw) return null;
  let maxMs = 0;
  if (raw.updatedAt && typeof raw.updatedAt.toMillis === 'function') {
    maxMs = Math.max(maxMs, raw.updatedAt.toMillis());
  }
  const slots = raw.slots && typeof raw.slots === 'object' ? raw.slots : {};
  Object.values(slots).forEach((arr) => {
    (arr || []).forEach((w) => {
      maxMs = Math.max(maxMs, watcherAtToMs(w.at));
    });
  });
  return maxMs > 0 ? maxMs : null;
}

function shouldAutoArchiveStaleChain(raw) {
  if (!raw) return false;
  const start = raw.settings?.chainStartUnix;
  if (start == null || !Number.isFinite(Number(start))) return false;
  const startSec = Math.floor(Number(start));
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < startSec + AUTO_ARCHIVE_AFTER_START_SEC) return false;

  const lastMs = lastActivityMsFromDoc(raw);
  const inactivityCutoffMs = Date.now() - AUTO_ARCHIVE_INACTIVITY_SEC * 1000;
  if (lastMs == null) return true;
  return lastMs < inactivityCutoffMs;
}

async function archiveChainWatchDoc(ref, raw, meta) {
  const norm = normalizeDoc(raw);
  const archiveRef = ref.collection(ARCHIVED_SUB).doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const reason = meta.reason != null ? String(meta.reason) : 'manual';

  await archiveRef.set({
    archivedAt: now,
    archivedByPlayerId: meta.playerId != null ? String(meta.playerId) : null,
    archivedByName: meta.name != null ? String(meta.name) : 'System',
    archiveReason: reason,
    settings: norm.settings,
    slots: norm.slots,
    chainState: norm.chainState,
    ownerPlayerId: raw.ownerPlayerId != null ? String(raw.ownerPlayerId) : null,
    ownerName: raw.ownerName != null ? String(raw.ownerName) : null,
    organizerPlayerIds: normalizeOrganizerIds(raw.organizerPlayerIds),
  });

  await ref.delete();

  return {
    success: true,
    archiveId: archiveRef.id,
    archivedAt: Date.now(),
    archiveReason: reason,
  };
}

async function maybeAutoArchiveStale(ref, raw) {
  if (!shouldAutoArchiveStaleChain(raw)) return null;
  return archiveChainWatchDoc(ref, raw, {
    playerId: null,
    name: 'Auto-archive (inactive 3+ days)',
    reason: 'auto_stale',
  });
}

async function listArchiveSummaries(fid, limit = MAX_ARCHIVES_LIST) {
  const snap = await getDb()
    .collection(COLLECTION)
    .doc(String(fid))
    .collection(ARCHIVED_SUB)
    .orderBy('archivedAt', 'desc')
    .limit(Math.min(MAX_ARCHIVES_LIST, Math.max(1, limit)))
    .get();
  return snap.docs.map((doc) => archiveSummaryFromDoc(doc.id, doc.data()));
}

function buildArchivedGetResponse(snap, user) {
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Archived chain watch not found');
  }
  const raw = snap.data();
  const norm = normalizeDoc(raw);
  const perms = viewerPermissions(raw, user.playerId);
  return {
    archived: true,
    archiveId: snap.id,
    archivedAt: raw.archivedAt?.toMillis?.() || null,
    archivedByPlayerId: raw.archivedByPlayerId != null ? String(raw.archivedByPlayerId) : null,
    archivedByName: raw.archivedByName ? String(raw.archivedByName) : null,
    exists: true,
    settings: norm.settings,
    slots: norm.slots,
    chainState: norm.chainState,
    ownerPlayerId: raw.ownerPlayerId != null ? String(raw.ownerPlayerId) : null,
    ownerName: raw.ownerName ? String(raw.ownerName) : null,
    organizerPlayerIds: normalizeOrganizerIds(raw.organizerPlayerIds),
    viewer: {
      playerId: user.playerId,
      name: user.name,
      canEdit: false,
      isOwner: perms.isOwner,
      canManageOrganizers: false,
      readOnlyArchive: true,
    },
    chainTargets: CHAIN_TARGETS,
    maxHourSlots: MAX_HOUR_SLOTS,
  };
}

async function buildGetResponse(snap, user, factionId) {
  const raw = snap.exists ? snap.data() : null;
  const perms = viewerPermissions(raw, user.playerId);
  let archives = [];
  try {
    archives = await listArchiveSummaries(factionId);
  } catch (e) {
    /* non-fatal if index missing on first deploy */
  }
  const viewer = {
    playerId: user.playerId,
    name: user.name,
    canEdit: snap.exists ? perms.canEdit : true,
    isOwner: perms.isOwner,
    canManageOrganizers: perms.canManageOrganizers,
  };

  if (!snap.exists) {
    return {
      exists: false,
      settings: defaultSettings(),
      slots: defaultSlotsObject(),
      chainState: { lastCurrent: 0, brokeAtHit: null, brokeAtUnix: null },
      ownerPlayerId: null,
      ownerName: null,
      organizerPlayerIds: [],
      archives,
      viewer,
      chainTargets: CHAIN_TARGETS,
      maxHourSlots: MAX_HOUR_SLOTS,
    };
  }

  const norm = normalizeDoc(raw);
  return {
    exists: true,
    updatedAt: raw.updatedAt?.toMillis?.() || null,
    settings: norm.settings,
    slots: norm.slots,
    chainState: norm.chainState,
    ownerPlayerId: perms.ownerPlayerId,
    ownerName: perms.ownerName,
    organizerPlayerIds: perms.organizerPlayerIds,
    archives,
    viewer,
    chainTargets: CHAIN_TARGETS,
    maxHourSlots: MAX_HOUR_SLOTS,
  };
}

/** Public read for faction members */
exports.chainWatchGet = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, factionId } = request.data || {};
  const fid = String(factionId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const ref = getDb().collection(COLLECTION).doc(fid);
  let snap = await ref.get();
  if (snap.exists) {
    const auto = await maybeAutoArchiveStale(ref, snap.data());
    if (auto) snap = await ref.get();
  }
  return buildGetResponse(snap, user, fid);
});

/** Owner/organiser: freeze current schedule to history and clear active slot for a new chain watch. */
exports.chainWatchArchive = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { apiKey, factionId } = request.data || {};
  const fid = String(factionId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const ref = getDb().collection(COLLECTION).doc(fid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('failed-precondition', 'No active chain watch to archive');
  }

  assertCanEditSchedule(snap.data(), user);

  return archiveChainWatchDoc(ref, snap.data(), {
    playerId: user.playerId,
    name: user.name,
    reason: 'manual',
  });
});

/** App admin: archive any faction's active chain watch (support requests). */
exports.chainWatchAdminArchive = onCall(callableOpts({ maxInstances: 5 }), async (request) => {
  const { apiKey, factionId } = request.data || {};
  const fid = String(factionId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');

  const ok = await validateAdminApiKey(apiKey);
  if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');

  const user = await fetchUserFromApiKey(apiKey);

  const ref = getDb().collection(COLLECTION).doc(fid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('failed-precondition', 'No active chain watch for this faction');
  }

  return archiveChainWatchDoc(ref, snap.data(), {
    playerId: user.playerId,
    name: user.name,
    reason: 'admin',
  });
});

/** Scheduled: archive stale chain watches (inactive 3+ days after chain start). */
exports.chainWatchAutoArchiveStale = onSchedule(
  { schedule: 'every 6 hours', timeZone: 'UTC' },
  async () => {
    const snap = await getDb().collection(COLLECTION).get();
    let archived = 0;
    for (const doc of snap.docs) {
      const raw = doc.data();
      if (!shouldAutoArchiveStaleChain(raw)) continue;
      try {
        await archiveChainWatchDoc(doc.ref, raw, {
          playerId: null,
          name: 'Auto-archive (inactive 3+ days)',
          reason: 'auto_stale',
        });
        archived += 1;
      } catch (e) {
        console.warn('chainWatchAutoArchiveStale failed', doc.id, e.message);
      }
    }
    if (archived > 0) console.log('chainWatchAutoArchiveStale archived', archived);
  }
);

/** List past archived chain watches (newest first). */
exports.chainWatchListArchives = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, factionId, limit } = request.data || {};
  const fid = String(factionId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const archives = await listArchiveSummaries(fid, limit != null ? Number(limit) : MAX_ARCHIVES_LIST);
  return { archives };
});

/** Read one archived chain watch (read-only schedule + rewards data). */
exports.chainWatchGetArchive = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, factionId, archiveId } = request.data || {};
  const fid = String(factionId || '').trim();
  const aid = String(archiveId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');
  if (!aid) throw new HttpsError('invalid-argument', 'archiveId required');

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const snap = await getDb().collection(COLLECTION).doc(fid).collection(ARCHIVED_SUB).doc(aid).get();
  return buildArchivedGetResponse(snap, user);
});

exports.chainWatchSaveConfig = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { apiKey, factionId, settings: incoming } = request.data || {};
  const fid = String(factionId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');
  if (!incoming || typeof incoming !== 'object') throw new HttpsError('invalid-argument', 'settings required');

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const chainTarget = Number(incoming.chainTarget);
  if (!CHAIN_TARGET_SET.has(chainTarget)) {
    throw new HttpsError('invalid-argument', 'Invalid chain target');
  }

  const chainStartUnix =
    incoming.chainStartUnix != null && incoming.chainStartUnix !== ''
      ? Math.floor(Number(incoming.chainStartUnix))
      : null;
  if (chainStartUnix != null && (!Number.isFinite(chainStartUnix) || chainStartUnix < 1e9)) {
    throw new HttpsError('invalid-argument', 'Invalid chain start time');
  }

  let backupColumns = Math.min(3, Math.max(1, Math.floor(Number(incoming.backupColumns) || 1)));
  const rewardType = incoming.rewardType === 'xanax' ? 'xanax' : 'cash';
  const rewardFirst = Math.max(0, Number(incoming.rewardFirst) || 0);
  const rewardSubsequent = Math.max(0, Number(incoming.rewardSubsequent) || 0);
  const maxSignupsPer24h = Math.min(999, Math.max(1, Math.floor(Number(incoming.maxSignupsPer24h) || 10)));

  let visibleTctDays =
    incoming.visibleTctDays != null && incoming.visibleTctDays !== ''
      ? Math.floor(Number(incoming.visibleTctDays))
      : undefined;

  const chainNameRaw =
    incoming.chainName != null && incoming.chainName !== ''
      ? String(incoming.chainName).trim().slice(0, 80)
      : null;

  const ref = getDb().collection(COLLECTION).doc(fid);
  const snap = await ref.get();
  const clearSlots = !!incoming.clearAllSignups;

  if (snap.exists) {
    assertCanEditSchedule(snap.data(), user);
  }

  const removeColRaw = incoming.removeWatcherColumn0;
  const removeCol =
    removeColRaw != null && removeColRaw !== ''
      ? Math.floor(Number(removeColRaw))
      : null;

  const ownerPatch = {};
  if (!snap.exists || !snap.data().ownerPlayerId) {
    ownerPatch.ownerPlayerId = user.playerId;
    ownerPatch.ownerName = user.name;
  }
  if (!snap.exists) {
    ownerPatch.organizerPlayerIds = [];
  }

  if (snap.exists && removeCol != null && Number.isFinite(removeCol)) {
    const prev = snap.data();
    const bcPrev = Math.min(3, Math.max(1, Math.floor(Number(prev.settings?.backupColumns) || 1)));
    if (removeCol < 1 || removeCol >= bcPrev) {
      throw new HttpsError('invalid-argument', 'Invalid column to remove');
    }
    backupColumns = bcPrev - 1;
    const norm = normalizeDoc(prev);
    let vtdRm = norm.settings.visibleTctDays;
    if (vtdRm != null && vtdRm !== '') {
      vtdRm = Math.min(
        maxVisibleTctDaysForStart(chainStartUnix),
        Math.max(1, Math.floor(Number(vtdRm)))
      );
    } else {
      vtdRm = 1;
    }
    const settings = {
      chainName:
        chainNameRaw != null
          ? chainNameRaw
          : norm.settings.chainName != null
            ? String(norm.settings.chainName)
            : '',
      chainStartUnix,
      chainTarget,
      backupColumns,
      rewardType,
      rewardFirst,
      rewardSubsequent,
      maxSignupsPer24h,
      visibleTctDays: vtdRm,
    };
    const newSlots = stripWatcherColumnFromSlots(norm.slots, removeCol);
    await ref.set(
      {
        settings,
        slots: newSlots,
        chainState: norm.chainState,
        ...metaFieldsFromDoc(prev),
        ...ownerPatch,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { success: true };
  }

  if (!snap.exists) {
    let vdNew = visibleTctDays;
    if (vdNew === undefined || !Number.isFinite(vdNew)) vdNew = 1;
    const maxD0 = maxVisibleTctDaysForStart(chainStartUnix);
    vdNew = Math.min(maxD0, Math.max(1, vdNew));
    await ref.set({
      settings: {
        chainName: chainNameRaw != null ? chainNameRaw : '',
        chainStartUnix,
        chainTarget,
        backupColumns,
        rewardType,
        rewardFirst,
        rewardSubsequent,
        maxSignupsPer24h,
        visibleTctDays: vdNew,
      },
      slots: defaultSlotsObject(),
      chainState: { lastCurrent: 0, brokeAtHit: null, brokeAtUnix: null },
      ownerPlayerId: user.playerId,
      ownerName: user.name,
      organizerPlayerIds: [],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true };
  }

  const prev = snap.data();
  const normPrev = normalizeDoc(prev);
  const prevStartStored =
    prev.settings?.chainStartUnix != null && Number.isFinite(Number(prev.settings.chainStartUnix))
      ? Math.floor(Number(prev.settings.chainStartUnix))
      : null;
  if (chainStartUnix == null && prevStartStored != null) {
    chainStartUnix = prevStartStored;
  }
  const bcPrev = Math.min(3, Math.max(1, Math.floor(Number(prev.settings?.backupColumns) || 1)));

  if (backupColumns < bcPrev) {
    throw new HttpsError(
      'failed-precondition',
      'To remove a backup watcher column, use the − button on that column header in the schedule.'
    );
  }

  if (visibleTctDays === undefined || !Number.isFinite(visibleTctDays)) {
    const prevV = prev.settings?.visibleTctDays;
    visibleTctDays = prevV != null && prevV !== '' ? Math.floor(Number(prevV)) : 1;
  }
  if (prevStartStored !== chainStartUnix) {
    visibleTctDays = 1;
  }
  const maxVd = maxVisibleTctDaysForStart(chainStartUnix);
  visibleTctDays = Math.min(maxVd, Math.max(1, visibleTctDays));

  const prevName =
    snap.exists && snap.data().settings?.chainName != null
      ? String(snap.data().settings.chainName)
      : '';
  const settings = {
    chainName: chainNameRaw != null ? chainNameRaw : prevName,
    chainStartUnix,
    chainTarget,
    backupColumns,
    rewardType,
    rewardFirst,
    rewardSubsequent,
    maxSignupsPer24h,
    visibleTctDays,
  };

  const slotsPayload = clearSlots ? defaultSlotsObject() : normPrev.slots;

  await ref.set(
    {
      settings,
      slots: slotsPayload,
      ...metaFieldsFromDoc(prev),
      ...ownerPatch,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { success: true };
});

/** Owner sets who may edit schedule settings (owner always can). */
exports.chainWatchSetOrganizers = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { apiKey, factionId, organizerPlayerIds } = request.data || {};
  const fid = String(factionId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const ref = getDb().collection(COLLECTION).doc(fid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('failed-precondition', 'Chain watch not configured yet');
  }

  const data = snap.data();
  const owner =
    data.ownerPlayerId != null && data.ownerPlayerId !== '' ? String(data.ownerPlayerId) : null;
  if (!owner) {
    throw new HttpsError('failed-precondition', 'Save the schedule once to become the owner before assigning organisers');
  }
  if (owner !== user.playerId) {
    throw new HttpsError('permission-denied', 'Only the chain watch owner can change organisers');
  }

  const ids = normalizeOrganizerIds(organizerPlayerIds).filter((id) => id !== owner);

  await ref.set(
    {
      organizerPlayerIds: ids,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { success: true, organizerPlayerIds: ids };
});

exports.chainWatchSignup = onCall(callableOpts({ maxInstances: 30 }), async (request) => {
  const { apiKey, factionId, slotIndex } = request.data || {};
  const fid = String(factionId || '').trim();
  const idx = Math.floor(Number(slotIndex));
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');
  if (!Number.isFinite(idx) || idx < 0 || idx >= MAX_HOUR_SLOTS) {
    throw new HttpsError('invalid-argument', 'Invalid slot');
  }

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const ref = getDb().collection(COLLECTION).doc(fid);

  await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError('failed-precondition', 'Chain watch not configured yet');
    }
    const raw = snap.data();
    const base = normalizeDoc(raw);
    const settings = base.settings;
    if (settings.chainStartUnix == null) {
      throw new HttpsError('failed-precondition', 'Chain start not configured yet');
    }

    const chainStartSec = Math.floor(Number(settings.chainStartUnix));
    const slotStartSec = chainStartSec + idx * 3600;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= slotStartSec) {
      throw new HttpsError('failed-precondition', 'This watch hour has already started; signups are closed.');
    }

    const maxPer = settings.maxSignupsPer24h || 10;
    const nowMs = Date.now();
    if (
      countActiveSignupsLast24h(base.slots, user.playerId, nowMs, settings.chainStartUnix) >= maxPer
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Active watch limit reached — leave a current/future slot or wait for older signups to age out'
      );
    }

    const key = String(idx);
    const list = Array.isArray(base.slots[key]) ? [...base.slots[key]] : [];
    const backupCols = Math.min(3, Math.max(1, settings.backupColumns || 1));

    if (list.some((w) => String(w.playerId) === String(user.playerId))) {
      throw new HttpsError('already-exists', 'You are already signed up for this hour');
    }

    let col = -1;
    for (let c = 0; c < backupCols; c++) {
      if (!list.some((w) => Number(w.col) === c)) {
        col = c;
        break;
      }
    }
    if (col < 0) throw new HttpsError('failed-precondition', 'This time slot is full');

    list.push({
      playerId: user.playerId,
      name: user.name,
      col,
      at: nowMs,
    });

    base.slots[key] = list;
    tx.set(
      ref,
      {
        settings: base.settings,
        slots: base.slots,
        chainState: base.chainState,
        ...metaFieldsFromDoc(raw),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { success: true };
});

exports.chainWatchRemoveSelf = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, factionId, slotIndex } = request.data || {};
  const fid = String(factionId || '').trim();
  const idx = Math.floor(Number(slotIndex));
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');
  if (!Number.isFinite(idx) || idx < 0 || idx >= MAX_HOUR_SLOTS) {
    throw new HttpsError('invalid-argument', 'Invalid slot');
  }

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const ref = getDb().collection(COLLECTION).doc(fid);
  await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No chain watch data');
    const base = normalizeDoc(snap.data());
    const chainStart = base.settings?.chainStartUnix != null ? Number(base.settings.chainStartUnix) : null;
    if (chainStart != null && Number.isFinite(chainStart)) {
      const slotEndSec = chainStart + (idx + 1) * 3600;
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= slotEndSec) {
        throw new HttpsError('failed-precondition', 'This watch hour has already ended; you cannot leave a completed slot.');
      }
    }
    const key = String(idx);
    const list = (base.slots[key] || []).filter((w) => String(w.playerId) !== String(user.playerId));
    base.slots[key] = list;
    tx.set(
      ref,
      {
        slots: base.slots,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { success: true };
});

/** Optional: sync live chain hits from client (same API as dashboard) to detect break */
exports.chainWatchSyncChain = onCall(callableOpts({ maxInstances: 30 }), async (request) => {
  const { apiKey, factionId, current, cooldown } = request.data || {};
  const fid = String(factionId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const cur = Math.max(0, Math.floor(Number(current) || 0));
  const cd = Math.max(0, Math.floor(Number(cooldown) || 0));

  const ref = getDb().collection(COLLECTION).doc(fid);
  await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const base = normalizeDoc(snap.data());
    const prev = base.chainState.lastCurrent || 0;
    let brokeAtHit = base.chainState.brokeAtHit;
    let brokeAtUnix = base.chainState.brokeAtUnix;

    if (prev > 0 && cur === 0 && cd > 0 && brokeAtHit == null) {
      brokeAtHit = prev;
      brokeAtUnix = Math.floor(Date.now() / 1000);
    }

    base.chainState = {
      lastCurrent: cur,
      brokeAtHit,
      brokeAtUnix,
    };

    tx.set(
      ref,
      {
        chainState: base.chainState,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { success: true };
});
