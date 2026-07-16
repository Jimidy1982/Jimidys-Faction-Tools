/**
 * Activity tracker backend:
 * - HTTP: addTrackedFaction / removeTrackedFaction / listMyActivityFactions (optional apiKey reconciles legacy trackedFactionKeys).
 *   addTrackedFaction caps each player at 3 target factions.
 * - Scheduled: every 10 min, sampleActivity reads trackedFactionKeys/_registry (1 doc), appends activitySampleWindows/{factionId}.
 */
const { setGlobalOptions } = require('firebase-functions/v2');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

/**
 * Default region for Gen2 (Firestore default "London" does NOT move functions — these deploy to us-central1).
 * Do not set invoker here: it may not apply to callables. Use callableOpts() on each onCall instead.
 */
setGlobalOptions({
  region: 'us-central1',
});

/** Origins for VIP onCall handlers (SDK still omits invoker for callables; activity uses onRequest instead). */
const CALLABLE_CORS = [
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
  'https://jimidy-s-faction-tools.web.app',
  'https://jimidy-s-faction-tools.firebaseapp.com',
  /^https:\/\/jimidy1982\.github\.io$/,
];

/** Per-callable options (VIP only — invoker may not apply to onCall in manifest). */
function callableOpts(more) {
  return {
    region: 'us-central1',
    invoker: 'public',
    cors: CALLABLE_CORS,
    ...(more || {}),
  };
}

/** Gen2 onRequest applies invoker to httpsTrigger; use for browser-facing activity registration. */
const ACTIVITY_HTTP_OPTS = {
  region: 'us-central1',
  invoker: 'public',
  cors: true,
  maxInstances: 10,
};

function httpsErrorToCallableJson(err) {
  const raw = err && err.code != null ? String(err.code).replace(/^functions\//, '') : 'internal';
  const map = {
    'invalid-argument': 'INVALID_ARGUMENT',
    'permission-denied': 'PERMISSION_DENIED',
    'not-found': 'NOT_FOUND',
    'already-exists': 'ALREADY_EXISTS',
    'failed-precondition': 'FAILED_PRECONDITION',
    'unauthenticated': 'UNAUTHENTICATED',
    'internal': 'INTERNAL',
  };
  return {
    error: {
      message: err.message || 'Error',
      status: map[raw] || 'INTERNAL',
    },
  };
}

/** Legacy tick docs (one per 5-min historically); superseded by activitySampleWindows — kept for rules only. */
const ACTIVITY_SAMPLES_COLLECTION = 'activitySamples';
/** Rolling 7-day samples per faction — shared by all users tracking that faction (1 read per faction). */
const ACTIVITY_SAMPLE_WINDOWS_COLLECTION = 'activitySampleWindows';
const TRACKED_FACTIONS_COLLECTION = 'trackedFactions';
const TRACKED_FACTION_KEYS_COLLECTION = 'trackedFactionKeys';
/** Single doc holding all faction API keys — one read per sampleActivity tick instead of N. */
const TRACKED_FACTION_KEYS_REGISTRY_ID = '_registry';
/** Factions a Torn player registered for 24/7 sampling (cross-browser / localhost vs prod). */
const ACTIVITY_REGISTRATIONS_BY_PLAYER = 'activityRegistrationsByPlayer';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Server sample interval (must match sampleActivity schedule). */
const TICK_MS = 10 * 60 * 1000;
/** Max samples retained per faction (~7 days at TICK_MS). */
const ACTIVITY_WINDOW_MAX_SAMPLES = Math.ceil(RETENTION_MS / TICK_MS) + 4;
/** Don't rewrite vipBalances lastLogin unless profile/faction changed or login older than this. */
const VIP_LOGIN_WRITE_MIN_MS = 12 * 60 * 60 * 1000;
/** Drop a user's server registration if War Dashboard has not refreshed it in this long (matches client auto-disable). */
const ACTIVITY_KEY_STALE_MS = 2 * 24 * 60 * 60 * 1000;
/** Max enemy factions one player may register for 24/7 activity sampling. */
const MAX_ACTIVITY_TRACKED_FACTIONS_PER_PLAYER = 3;

function activityKeyLastActiveMs(entry) {
  const n = entry && entry.lastActiveAt != null ? Number(entry.lastActiveAt) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Keep keys touched within ACTIVITY_KEY_STALE_MS; legacy keys without lastActiveAt are treated as stale. */
function filterActiveActivityKeys(keys, nowMs) {
  const cutoff = nowMs - ACTIVITY_KEY_STALE_MS;
  return (keys || []).filter((e) => activityKeyLastActiveMs(e) >= cutoff);
}

function trackedFactionKeysRegistryRef() {
  return db.collection(TRACKED_FACTION_KEYS_COLLECTION).doc(TRACKED_FACTION_KEYS_REGISTRY_ID);
}

/** Normalize registry map: drop factions with no keys. */
function normalizeRegistryFactions(factions) {
  const out = {};
  for (const [fid, entry] of Object.entries(factions || {})) {
    const keys = entry && Array.isArray(entry.keys) ? entry.keys : [];
    if (!keys.length) continue;
    const row = { keys };
    if (entry && entry.addedAt != null) row.addedAt = entry.addedAt;
    out[fid] = row;
  }
  return out;
}

async function writeTrackedFactionRegistry(factions) {
  const cleaned = normalizeRegistryFactions(factions);
  const ref = trackedFactionKeysRegistryRef();
  if (!Object.keys(cleaned).length) {
    await ref.delete();
    return;
  }
  await ref.set({ factions: cleaned, updatedAt: Date.now() });
}

/**
 * Read the consolidated registry. If missing, one-time migrate legacy per-faction docs into _registry.
 * @returns {Promise<Record<string, { keys: object[], addedAt?: number }>>}
 */
async function readTrackedFactionRegistry() {
  const ref = trackedFactionKeysRegistryRef();
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data() || {};
    return normalizeRegistryFactions(data.factions || {});
  }

  const legacySnap = await db.collection(TRACKED_FACTION_KEYS_COLLECTION).get();
  if (legacySnap.empty) return {};

  const factions = {};
  for (const doc of legacySnap.docs) {
    if (doc.id === TRACKED_FACTION_KEYS_REGISTRY_ID) continue;
    const keys = (doc.data() && doc.data().keys) || [];
    if (!keys.length) continue;
    const tfSnap = await db.collection(TRACKED_FACTIONS_COLLECTION).doc(doc.id).get();
    factions[doc.id] = {
      keys,
      addedAt: tfSnap.exists && tfSnap.data().addedAt != null ? tfSnap.data().addedAt : Date.now(),
    };
  }

  if (Object.keys(factions).length) {
    await writeTrackedFactionRegistry(factions);
    const batch = db.batch();
    legacySnap.docs.forEach((doc) => {
      if (doc.id !== TRACKED_FACTION_KEYS_REGISTRY_ID) batch.delete(doc.ref);
    });
    await batch.commit();
  }

  return factions;
}

/** Transactional read-modify-write on the registry doc (avoids lost updates when multiple clients register). */
async function updateTrackedFactionRegistry(mutator) {
  const ref = trackedFactionKeysRegistryRef();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const factions = snap.exists && snap.data().factions ? { ...snap.data().factions } : {};
    const result = mutator(factions);
    const cleaned = normalizeRegistryFactions(factions);
    if (!Object.keys(cleaned).length) {
      tx.delete(ref);
    } else {
      tx.set(ref, { factions: cleaned, updatedAt: Date.now() });
    }
    return result;
  });
}

function activityKeyBelongsToPlayer(entry, uid, tornPid) {
  if (uid && String(entry.userId || '') === String(uid)) return true;
  if (tornPid && String(entry.tornPlayerId || '') === String(tornPid)) return true;
  return false;
}

/** How many target factions this player already has a key on in the registry. */
function countFactionsTrackedByPlayer(factions, uid, tornPid) {
  let n = 0;
  for (const entry of Object.values(factions || {})) {
    const keys = entry.keys || [];
    if (keys.some((e) => activityKeyBelongsToPlayer(e, uid, tornPid))) n += 1;
  }
  return n;
}

function getTickId(ms) {
  return String(Math.floor(ms / TICK_MS) * TICK_MS);
}

/** Append one sample to a faction's shared 7-day window (all users read this doc). */
async function appendActivitySampleWindow(factionId, t, onlineIds) {
  const fid = String(factionId);
  const ref = db.collection(ACTIVITY_SAMPLE_WINDOWS_COLLECTION).doc(fid);
  const cutoff = Date.now() - RETENTION_MS;
  const tickId = getTickId(t);
  const ids = (onlineIds || []).map(String);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let samples = snap.exists && Array.isArray(snap.data().samples) ? snap.data().samples : [];
    samples = samples.filter((s) => {
      const st = Number(s.t);
      if (!Number.isFinite(st) || st < cutoff) return false;
      return getTickId(st) !== tickId;
    });
    samples.push({ t, onlineIds: ids });
    samples.sort((a, b) => Number(a.t) - Number(b.t));
    if (samples.length > ACTIVITY_WINDOW_MAX_SAMPLES) {
      samples = samples.slice(-ACTIVITY_WINDOW_MAX_SAMPLES);
    }
    tx.set(ref, { samples, updatedAt: Date.now() });
  });
}

async function fetchFactionMembers(apiKey, factionId) {
  const url = `https://api.torn.com/v2/faction/${factionId}/members?key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const list = data.members != null ? (Array.isArray(data.members) ? data.members : Object.values(data.members)) : [];
  return list;
}

/** Resolve Torn player id from API key (same selections as War Dashboard client). */
async function fetchTornPlayerIdFromApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new HttpsError('invalid-argument', 'apiKey is empty');
  const url = `https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new HttpsError('invalid-argument', 'Torn API: ' + String(data.error));
  const pid = data.player_id;
  if (pid == null) throw new HttpsError('internal', 'Torn API returned no player_id');
  return String(pid);
}

/**
 * Legacy rows only had { key, userId }. Match stored keys to this API key, set tornPlayerId, and refresh activityRegistrationsByPlayer.
 * @returns {Promise<string[]>} faction doc ids where this key was registered
 */
async function reconcileActivityKeysForApiKey(apiKeyTrim, verifiedPlayerId) {
  const factions = await readTrackedFactionRegistry();
  const matchedFactionIds = [];
  let changed = false;
  const now = Date.now();
  for (const [fid, entry] of Object.entries(factions)) {
    const keysArr = entry.keys || [];
    const hasKey = keysArr.some((e) => String(e.key || '').trim() === apiKeyTrim);
    if (!hasKey) continue;
    matchedFactionIds.push(fid);
    const needsPatch = keysArr.some(
      (e) => String(e.key || '').trim() === apiKeyTrim && String(e.tornPlayerId || '') !== verifiedPlayerId
    );
    if (needsPatch) {
      changed = true;
      entry.keys = keysArr.map((e) => {
        if (String(e.key || '').trim() === apiKeyTrim) {
          return { key: e.key, userId: e.userId, tornPlayerId: verifiedPlayerId, lastActiveAt: now };
        }
        const o = { key: e.key, userId: e.userId, lastActiveAt: activityKeyLastActiveMs(e) || now };
        if (e.tornPlayerId) o.tornPlayerId = e.tornPlayerId;
        return o;
      });
    } else {
      changed = true;
      entry.keys = keysArr.map((e) => {
        if (String(e.key || '').trim() !== apiKeyTrim) return e;
        return { ...e, lastActiveAt: now };
      });
    }
  }
  if (changed) await writeTrackedFactionRegistry(factions);
  if (matchedFactionIds.length > 0) {
    const prefRef = db.collection(ACTIVITY_REGISTRATIONS_BY_PLAYER).doc(verifiedPlayerId);
    const pSnap = await prefRef.get();
    const cur = pSnap.exists ? (pSnap.data().factionIds || []).map(String) : [];
    const merged = [...new Set([...cur, ...matchedFactionIds])];
    await prefRef.set({ factionIds: merged, updatedAt: Date.now() }, { merge: true });
  }
  return matchedFactionIds;
}

/** Members with last_action status exactly "online" (excludes "idle" — not counted as active online time). */
function onlineIds(members) {
  return members
    .filter((m) => {
      const la = m.last_action ?? {};
      const action = (la.status ?? 'Offline').toString().toLowerCase();
      return action === 'online';
    })
    .map((m) => String(m.id));
}

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/** POST JSON body: { "data": { factionId, apiKey, userId, tornPlayerId? } } — same shape as callable; response { result } | { error }. */
exports.addTrackedFaction = onRequest(ACTIVITY_HTTP_OPTS, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const data = req.body && req.body.data;
    const { factionId, apiKey, userId, tornPlayerId } = data || {};
    const fid = String(factionId || '').trim();
    const key = String(apiKey || '').trim();
    const uid = String(userId || '').trim();
    const tornPid = tornPlayerId != null && String(tornPlayerId).trim() !== '' ? String(tornPlayerId).trim() : '';
    if (!fid || !key || !uid) {
      res.status(200).json(
        httpsErrorToCallableJson(new HttpsError('invalid-argument', 'factionId, apiKey, and userId are required'))
      );
      return;
    }
    const now = Date.now();
    await updateTrackedFactionRegistry((factions) => {
      const prev = factions[fid] || {};
      const already = (prev.keys || []).some((e) => activityKeyBelongsToPlayer(e, uid, tornPid));
      if (!already) {
        const count = countFactionsTrackedByPlayer(factions, uid, tornPid);
        if (count >= MAX_ACTIVITY_TRACKED_FACTIONS_PER_PLAYER) {
          throw new HttpsError(
            'resource-exhausted',
            `You can track at most ${MAX_ACTIVITY_TRACKED_FACTIONS_PER_PLAYER} factions for activity. Remove one before adding another.`
          );
        }
      }
      const keys = (prev.keys || []).filter((e) => !activityKeyBelongsToPlayer(e, uid, tornPid));
      const entry = { key: key, userId: uid, lastActiveAt: now };
      if (tornPid) entry.tornPlayerId = tornPid;
      keys.push(entry);
      factions[fid] = { keys, addedAt: prev.addedAt != null ? prev.addedAt : now };
    });
    if (tornPid) {
      await db
        .collection(ACTIVITY_REGISTRATIONS_BY_PLAYER)
        .doc(tornPid)
        .set(
          {
            factionIds: admin.firestore.FieldValue.arrayUnion(fid),
            updatedAt: Date.now(),
          },
          { merge: true }
        );
    }
    res.status(200).json({ result: { ok: true } });
  } catch (e) {
    if (e instanceof HttpsError) {
      res.status(200).json(httpsErrorToCallableJson(e));
      return;
    }
    console.error('addTrackedFaction', e);
    res.status(200).json({
      error: { message: e.message || String(e), status: 'INTERNAL' },
    });
  }
});

/** POST JSON body: { "data": { factionId, userId, tornPlayerId? } }. */
exports.removeTrackedFaction = onRequest(ACTIVITY_HTTP_OPTS, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const data = req.body && req.body.data;
    const { factionId, userId, tornPlayerId } = data || {};
    const fid = String(factionId || '').trim();
    const uid = String(userId || '').trim();
    const tornPid = tornPlayerId != null && String(tornPlayerId).trim() !== '' ? String(tornPlayerId).trim() : '';
    if (!fid || !uid) {
      res.status(200).json(
        httpsErrorToCallableJson(new HttpsError('invalid-argument', 'factionId and userId are required'))
      );
      return;
    }
    let keysAfter = [];
    await updateTrackedFactionRegistry((factions) => {
      const prev = factions[fid];
      if (!prev) return;
      const keysBefore = prev.keys || [];
      keysAfter = keysBefore.filter((e) => !activityKeyBelongsToPlayer(e, uid, tornPid));
      if (keysAfter.length) {
        factions[fid] = { keys: keysAfter, addedAt: prev.addedAt };
      } else {
        delete factions[fid];
      }
    });
    if (tornPid) {
      const stillHasTorn = keysAfter.some((e) => String(e.tornPlayerId || '') === tornPid);
      if (!stillHasTorn) {
        await db
          .collection(ACTIVITY_REGISTRATIONS_BY_PLAYER)
          .doc(tornPid)
          .set({ factionIds: admin.firestore.FieldValue.arrayRemove(fid) }, { merge: true });
      }
    }
    res.status(200).json({ result: { ok: true } });
  } catch (e) {
    if (e instanceof HttpsError) {
      res.status(200).json(httpsErrorToCallableJson(e));
      return;
    }
    console.error('removeTrackedFaction', e);
    res.status(200).json({
      error: { message: e.message || String(e), status: 'INTERNAL' },
    });
  }
});

/**
 * POST JSON body: { "data": { userId?, tornPlayerId?, apiKey? } } — at least one required.
 * If **apiKey** is sent, verifies it with Torn, must match **tornPlayerId** when both sent, then **migrates** legacy
 * `trackedFactionKeys` rows (same stored key, missing tornPlayerId) and fills **activityRegistrationsByPlayer**.
 */
exports.listMyActivityFactions = onRequest(ACTIVITY_HTTP_OPTS, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const data = req.body && req.body.data;
    const { userId, tornPlayerId, apiKey } = data || {};
    const uid = String(userId || '').trim();
    const tornPidParam = tornPlayerId != null && String(tornPlayerId).trim() !== '' ? String(tornPlayerId).trim() : '';
    const keyTrim = apiKey != null && String(apiKey).trim() !== '' ? String(apiKey).trim() : '';

    if (!uid && !tornPidParam && !keyTrim) {
      res.status(200).json(
        httpsErrorToCallableJson(
          new HttpsError('invalid-argument', 'userId, tornPlayerId, and/or apiKey is required')
        )
      );
      return;
    }

    let effectiveTornPid = tornPidParam;
    if (keyTrim) {
      const fromApi = await fetchTornPlayerIdFromApiKey(keyTrim);
      if (tornPidParam && tornPidParam !== fromApi) {
        res.status(200).json(
          httpsErrorToCallableJson(
            new HttpsError('invalid-argument', 'tornPlayerId does not match this API key')
          )
        );
        return;
      }
      effectiveTornPid = fromApi;
      await reconcileActivityKeysForApiKey(keyTrim, effectiveTornPid);
    }

    const out = new Set();
    if (effectiveTornPid) {
      const pref = await db.collection(ACTIVITY_REGISTRATIONS_BY_PLAYER).doc(effectiveTornPid).get();
      if (pref.exists) {
        const ids = pref.data().factionIds || [];
        ids.forEach((id) => out.add(String(id)));
      }
    }
    const registry = await readTrackedFactionRegistry();
    for (const [fid, entry] of Object.entries(registry)) {
      const arr = entry.keys || [];
      const match = arr.some((k) => {
        if (uid && k.userId === uid) return true;
        if (effectiveTornPid && String(k.tornPlayerId || '') === effectiveTornPid) return true;
        return false;
      });
      if (match) out.add(fid);
    }
    const factionIds = Array.from(out).sort((a, b) => Number(a) - Number(b));
    res.status(200).json({ result: { factionIds } });
  } catch (e) {
    if (e instanceof HttpsError) {
      res.status(200).json(httpsErrorToCallableJson(e));
      return;
    }
    console.error('listMyActivityFactions', e);
    res.status(200).json({
      error: { message: e.message || String(e), status: 'INTERNAL' },
    });
  }
});

// --- VIP service (migrated from Apps Script) ---
const VIP_BALANCES_COLLECTION = 'vipBalances';
/** All VIP rows in one doc for admin list + scheduled deductions (1 read instead of N). */
const VIP_BALANCES_REGISTRY_ID = '_registry';
/** Cached faction pool totals — 1 read per getVipBalance instead of where('factionId'). */
const VIP_FACTION_POOLS_COLLECTION = 'vipFactionPools';
const VIP_TRANSACTIONS_COLLECTION = 'vipTransactions';
/** One doc per credited Torn event: doc id `${playerId}_${tornEventId}` — prevents double-count on VIP refresh. */
const VIP_TORN_EVENT_CLAIMS_COLLECTION = 'vipTornEventClaims';
/** One doc per Torn event id — incoming Xanax seen on recipient’s feed (scheduled poller). */
const VIP_INCOMING_XANAX_LOG_COLLECTION = 'vipIncomingXanaxLog';
/** Single-doc poll cursor: `state` doc holds `lastEventsFromUnix`. */
const VIP_INCOMING_XANAX_POLL_COLLECTION = 'vipIncomingXanaxPoll';
/** Never request Torn events older than this many seconds behind "now" (bounds first run + pagination). */
const VIP_INCOMING_MAX_LOOKBACK_SEC = 24 * 3600;

function vipLevelFromBalance(balance) {
  const b = Number(balance) || 0;
  if (b >= 100) return 3;
  if (b >= 50) return 2;
  if (b >= 10) return 1;
  return 0;
}

function vipRegistryRef() {
  return db.collection(VIP_BALANCES_COLLECTION).doc(VIP_BALANCES_REGISTRY_ID);
}

function vipPlayerRowFromData(data, playerId) {
  const d = data || {};
  return {
    playerName: d.playerName != null ? String(d.playerName) : '',
    factionName: d.factionName != null ? String(d.factionName) : '',
    factionId: d.factionId != null && String(d.factionId).trim() !== '' ? String(d.factionId).trim() : '',
    totalXanaxSent: Number(d.totalXanaxSent) || 0,
    currentBalance: Number(d.currentBalance) || 0,
    lastDeductionDate: d.lastDeductionDate ?? null,
    vipLevel: Number(d.vipLevel) || vipLevelFromBalance(Number(d.currentBalance) || 0),
    lastLoginDate: d.lastLoginDate ?? null,
  };
}

function vipRegistryRowToAdminBalance(playerId, row) {
  return {
    playerId: String(playerId),
    playerName: row.playerName ?? '',
    factionName: row.factionName ?? '',
    factionId: row.factionId ?? '',
    totalXanaxSent: row.totalXanaxSent ?? 0,
    currentBalance: row.currentBalance ?? 0,
    lastDeductionDate: row.lastDeductionDate ?? null,
    vipLevel: row.vipLevel ?? 0,
    lastLoginDate: row.lastLoginDate ?? null,
  };
}

async function writeVipBalancesRegistry(players, extra = {}) {
  const ref = vipRegistryRef();
  if (!players || !Object.keys(players).length) {
    await ref.delete();
    return;
  }
  const snap = await ref.get();
  const prevData = snap.exists ? snap.data() : {};
  await ref.set({
    ...prevData,
    players,
    updatedAt: Date.now(),
    playerCount: Object.keys(players).length,
    ...extra,
  });
}

/**
 * Merge any per-player vipBalances docs missing from the registry (registry may have been
 * bootstrapped incrementally via touchVipLogin before a full backfill ran).
 */
async function backfillVipRegistryFromLegacyDocs(players, markComplete) {
  const legacySnap = await db.collection(VIP_BALANCES_COLLECTION).get();
  const merged = { ...players };
  let changed = false;
  for (const doc of legacySnap.docs) {
    if (doc.id === VIP_BALANCES_REGISTRY_ID) continue;
    if (merged[doc.id]) continue;
    merged[doc.id] = vipPlayerRowFromData(doc.data(), doc.id);
    changed = true;
  }
  const extra = {};
  if (markComplete) extra.backfillComplete = true;
  if (changed || markComplete) {
    await writeVipBalancesRegistry(merged, extra);
    if (changed) await rebuildAllVipFactionPoolsFromRegistry(merged);
  }
  return merged;
}

/**
 * Read consolidated VIP registry. Backfills once from all legacy per-player docs if needed.
 * @returns {Promise<Record<string, object>>}
 */
async function readVipBalancesRegistry() {
  const ref = vipRegistryRef();
  const snap = await ref.get();
  if (!snap.exists) {
    return backfillVipRegistryFromLegacyDocs({}, true);
  }

  const data = snap.data() || {};
  const players =
    data.players && typeof data.players === 'object' ? { ...data.players } : {};

  if (data.backfillComplete !== true) {
    return backfillVipRegistryFromLegacyDocs(players, true);
  }

  return players;
}

async function syncVipRegistryPlayer(playerId, newData, prevData) {
  const pid = String(playerId);
  const ref = vipRegistryRef();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const players = data.players && typeof data.players === 'object' ? { ...data.players } : {};
    players[pid] = vipPlayerRowFromData(newData, pid);
    tx.set(ref, {
      players,
      updatedAt: Date.now(),
      playerCount: Object.keys(players).length,
      backfillComplete: data.backfillComplete === true,
    });
  });
  await applyVipFactionPoolDelta(prevData, newData);
}

async function adjustVipFactionPool(factionId, deltaBalance, deltaCount) {
  const fid = String(factionId || '').trim();
  if (!fid || (deltaBalance === 0 && deltaCount === 0)) return;
  const ref = db.collection(VIP_FACTION_POOLS_COLLECTION).doc(fid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : { combinedBalance: 0, memberCount: 0 };
    const sum = Math.max(0, (Number(cur.combinedBalance) || 0) + deltaBalance);
    const count = Math.max(0, (Number(cur.memberCount) || 0) + deltaCount);
    if (count <= 0) tx.delete(ref);
    else tx.set(ref, { combinedBalance: sum, memberCount: count, updatedAt: Date.now() });
  });
}

async function applyVipFactionPoolDelta(prevData, newData) {
  const prev = prevData ? vipPlayerRowFromData(prevData) : null;
  const next = newData ? vipPlayerRowFromData(newData) : null;
  const prevFid = prev?.factionId || '';
  const newFid = next?.factionId || '';
  const prevBal = Number(prev?.currentBalance) || 0;
  const newBal = Number(next?.currentBalance) || 0;
  if (prevFid && prevFid !== newFid) {
    await adjustVipFactionPool(prevFid, -prevBal, -1);
  }
  if (newFid) {
    if (prevFid === newFid) await adjustVipFactionPool(newFid, newBal - prevBal, 0);
    else await adjustVipFactionPool(newFid, newBal, 1);
  }
}

async function rebuildAllVipFactionPoolsFromRegistry(players) {
  const byFaction = {};
  for (const row of Object.values(players || {})) {
    const fid = row.factionId ? String(row.factionId).trim() : '';
    if (!fid) continue;
    if (!byFaction[fid]) byFaction[fid] = { sum: 0, count: 0 };
    byFaction[fid].sum += Number(row.currentBalance) || 0;
    byFaction[fid].count += 1;
  }
  const batch = db.batch();
  for (const [fid, agg] of Object.entries(byFaction)) {
    batch.set(db.collection(VIP_FACTION_POOLS_COLLECTION).doc(fid), {
      combinedBalance: agg.sum,
      memberCount: agg.count,
      updatedAt: Date.now(),
    });
  }
  if (Object.keys(byFaction).length) await batch.commit();
}

async function readVipFactionPoolTotals(factionId) {
  const fid = String(factionId || '').trim();
  if (!fid) return null;
  const snap = await db.collection(VIP_FACTION_POOLS_COLLECTION).doc(fid).get();
  if (!snap.exists) return null;
  const d = snap.data();
  return {
    combinedBalance: Number(d.combinedBalance) || 0,
    memberCount: Number(d.memberCount) || 0,
  };
}

/** Milliseconds for sorting vipTransactions (timestamp may be ISO string or Firestore Timestamp). */
function vipTransactionTimestampMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof v === 'object') {
    if (typeof v.toDate === 'function') {
      try {
        return v.toDate().getTime();
      } catch (_) {
        return 0;
      }
    }
    if (typeof v.toMillis === 'function') {
      try {
        return v.toMillis();
      } catch (_) {
        return 0;
      }
    }
    if (v.seconds != null) return Number(v.seconds) * 1000 + Math.floor(Number(v.nanoseconds || 0) / 1e6);
  }
  return 0;
}

function vipTornEventClaimDocId(playerId, tornEventId) {
  const safe = String(tornEventId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${String(playerId)}_${safe}`;
}

/**
 * Parse "You were sent Nx Xanax from …" from the recipient's event feed (admin key).
 * Torn HTML varies (spaces in href, duplicate URLs); resolve XID from query string and name from anchor or plain text.
 * @returns {{ amount: number, playerId: number, playerName: string } | null}
 */
function parseIncomingXanaxEventHtml(eventHtml) {
  const s = String(eventHtml || '');
  if (!s.includes('You were sent') || !/xanax/i.test(s)) return null;
  const xanaxMatch = s.match(/You were sent (\d+)x Xanax from/i);
  if (!xanaxMatch) return null;
  const amount = parseInt(xanaxMatch[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  let playerId = null;
  for (const re of [/[?&]XID=(\d+)\b/i, /\bXID\s*=\s*(\d+)/i]) {
    const m = s.match(re);
    if (m) {
      const id = parseInt(m[1], 10);
      if (Number.isFinite(id) && id > 0) {
        playerId = id;
        break;
      }
    }
  }
  if (!playerId) return null;

  let playerName = '';
  const fromAnchor = s.match(/You were sent \d+x Xanax from\s*(?:<a\b[^>]*>)([\s\S]*?)<\/a>/i);
  if (fromAnchor) {
    playerName = String(fromAnchor[1] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!playerName) {
    const plain = s.match(/You were sent \d+x Xanax from\s+([^<\n][^<]{0,80})/i);
    if (plain) playerName = String(plain[1] || '').trim();
  }
  if (!playerName) playerName = `Player ${playerId}`;

  return {
    amount,
    playerId,
    playerName,
  };
}

/**
 * Idempotent VIP credits from Torn events (same logic as applyVipTornXanaxCredits callable).
 * @param {string} playerId
 * @param {string} playerName
 * @param {{ tornEventId: string, tornEventTimestamp: number, amount: number }[]} credits
 * @param {{ factionName?: string, factionId?: string }} opts
 */
async function applyVipTornXanaxCreditsInternal(playerId, playerName, credits, opts) {
  const normalized = [];
  for (const c of credits) {
    const id = c.tornEventId != null ? String(c.tornEventId).trim() : '';
    const ts = Number(c.tornEventTimestamp);
    const amt = Number(c.amount);
    if (!id || !Number.isFinite(ts) || !Number.isFinite(amt) || amt <= 0) continue;
    normalized.push({ tornEventId: id, tornEventTimestamp: Math.floor(ts), amount: Math.floor(amt) });
  }
  if (normalized.length === 0) return { appliedCount: 0, deltaXanax: 0, balance: null };

  const balanceRef = db.collection(VIP_BALANCES_COLLECTION).doc(playerId);

  return db.runTransaction(async (transaction) => {
    const balSnap = await transaction.get(balanceRef);
    let d = balSnap.exists ? balSnap.data() : {};
    const baseTotal = Number(d.totalXanaxSent) || 0;
    const baseCurrent = Number(d.currentBalance) || 0;

    const newCredits = [];
    for (const c of normalized) {
      const claimId = vipTornEventClaimDocId(playerId, c.tornEventId);
      const claimRef = db.collection(VIP_TORN_EVENT_CLAIMS_COLLECTION).doc(claimId);
      const claimSnap = await transaction.get(claimRef);
      if (claimSnap.exists) continue;
      newCredits.push(c);
    }

    if (newCredits.length === 0) {
      return {
        appliedCount: 0,
        deltaXanax: 0,
        balance: {
          playerId: d.playerId != null ? d.playerId : Number(playerId),
          playerName: d.playerName != null ? d.playerName : playerName,
          totalXanaxSent: baseTotal,
          currentBalance: baseCurrent,
          lastDeductionDate: d.lastDeductionDate ?? null,
          vipLevel: d.vipLevel ?? vipLevelFromBalance(baseCurrent),
          lastLoginDate: d.lastLoginDate ?? null,
        },
      };
    }

    let delta = 0;
    let runBalance = baseCurrent;
    for (const c of newCredits) {
      delta += c.amount;
      runBalance += c.amount;
      const claimId = vipTornEventClaimDocId(playerId, c.tornEventId);
      const claimRef = db.collection(VIP_TORN_EVENT_CLAIMS_COLLECTION).doc(claimId);
      transaction.set(claimRef, {
        playerId,
        tornEventId: c.tornEventId,
        tornEventTimestamp: c.tornEventTimestamp,
        amount: c.amount,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const logRef = db.collection(VIP_TRANSACTIONS_COLLECTION).doc();
      const eventIso =
        c.tornEventTimestamp > 0
          ? new Date(c.tornEventTimestamp * 1000).toISOString()
          : new Date().toISOString();
      transaction.set(logRef, {
        timestamp: eventIso,
        tornEventId: c.tornEventId,
        tornEventTimestamp: c.tornEventTimestamp,
        playerId,
        playerName,
        amount: c.amount,
        transactionType: 'Incoming Xanax',
        balanceAfter: runBalance,
      });
    }

    const newTotal = baseTotal + delta;
    const newCurrent = baseCurrent + delta;
    const vipLevel = vipLevelFromBalance(newCurrent);
    const docUpdate = {
      playerId,
      playerName: playerName || d.playerName || '',
      totalXanaxSent: newTotal,
      currentBalance: newCurrent,
      lastDeductionDate: d.lastDeductionDate ?? null,
      vipLevel,
      lastLoginDate: d.lastLoginDate ?? null,
    };
    if (opts.factionName != null && String(opts.factionName).trim() !== '') {
      docUpdate.factionName = String(opts.factionName);
    }
    if (opts.factionId != null && String(opts.factionId).trim() !== '') {
      docUpdate.factionId = String(opts.factionId);
    }
    transaction.set(balanceRef, docUpdate, { merge: true });

    return {
      appliedCount: newCredits.length,
      deltaXanax: delta,
      balance: {
        playerId: docUpdate.playerId,
        playerName: docUpdate.playerName,
        totalXanaxSent: newTotal,
        currentBalance: newCurrent,
        lastDeductionDate: docUpdate.lastDeductionDate,
        vipLevel,
        lastLoginDate: docUpdate.lastLoginDate,
      },
      _registrySync: { prev: balSnap.exists ? d : null, next: { ...d, ...docUpdate } },
    };
  }).then(async (result) => {
    if (result._registrySync) {
      await syncVipRegistryPlayer(playerId, result._registrySync.next, result._registrySync.prev);
    }
    const { _registrySync, ...out } = result;
    return out;
  });
}

/**
 * True if this Torn key belongs to the given player (key owner id from user/?selections=basic).
 */
async function verifyTornApiKeyMatchesPlayerId(apiKeyClean, playerId) {
  try {
    const res = await fetch(
      `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(apiKeyClean)}`
    );
    const data = await res.json();
    if (data.error) return false;
    const owner =
      data.player_id != null
        ? String(data.player_id)
        : data.id != null
          ? String(data.id)
          : '';
    return owner !== '' && owner === String(playerId);
  } catch {
    return false;
  }
}

/** Name + faction from user/{id}?selections=profile (caller must have verified key matches playerId). */
async function fetchTornPlayerProfileForVipPoolSafe(apiKeyClean, playerId) {
  try {
    const res = await fetch(
      `https://api.torn.com/user/${playerId}?selections=profile&key=${encodeURIComponent(apiKeyClean)}`
    );
    const data = await res.json();
    if (data.error) return null;
    let playerName = data.name != null ? String(data.name).trim() : '';
    let factionName = '';
    let factionId = '';
    const fac = data.faction;
    if (fac && typeof fac === 'object') {
      if (fac.faction_name != null && String(fac.faction_name).trim() !== '') {
        factionName = String(fac.faction_name).trim();
      }
      if (fac.faction_id != null && String(fac.faction_id).trim() !== '') {
        factionId = String(fac.faction_id).trim();
      }
    }
    if (!playerName) playerName = `Player ${playerId}`;
    return { playerName, factionName, factionId };
  } catch {
    return null;
  }
}

/**
 * Build getVipBalance response. When poolQueryFactionId (or doc.factionId) matches any VIP row(s),
 * vipLevel uses the sum of their currentBalance — even for a single payer and a zero-balance self row.
 * @param {object} d vipBalances document fields
 * @param {string} [poolQueryFactionId] Torn-verified faction id for the pool query (preferred over stale doc.factionId)
 */
async function buildVipBalanceResponseFromDocData(d, poolQueryFactionId = '') {
  const personalBal = Number(d.currentBalance) || 0;
  const personalLevel = vipLevelFromBalance(personalBal);
  const docFid = d.factionId != null ? String(d.factionId).trim() : '';
  const fid =
    poolQueryFactionId != null && String(poolQueryFactionId).trim() !== ''
      ? String(poolQueryFactionId).trim()
      : docFid;
  let factionCombinedBalance = null;
  let factionMemberCount = 0;
  let effectiveLevel = personalLevel;

  if (fid) {
    const pool = await readVipFactionPoolTotals(fid);
    if (pool && pool.memberCount >= 1) {
      factionMemberCount = pool.memberCount;
      factionCombinedBalance = pool.combinedBalance;
      effectiveLevel = vipLevelFromBalance(pool.combinedBalance);
    }
  }

  const out = {
    playerId: d.playerId,
    playerName: d.playerName,
    totalXanaxSent: d.totalXanaxSent ?? 0,
    currentBalance: personalBal,
    lastDeductionDate: d.lastDeductionDate ?? null,
    vipLevel: effectiveLevel,
    lastLoginDate: d.lastLoginDate ?? null,
  };
  if (d.factionName != null && String(d.factionName) !== '') out.factionName = String(d.factionName);
  if (fid) out.factionId = fid;
  if (factionCombinedBalance != null) out.factionCombinedBalance = factionCombinedBalance;
  if (factionMemberCount >= 1 && factionCombinedBalance != null) out.factionMemberCount = factionMemberCount;
  return out;
}

/**
 * Merge last login + current Torn faction/name when the player’s own API key is verified.
 * Creates a zero-balance row if missing so faction pooling and admin “last login” stay accurate.
 * Skips writes when login is recent and name/faction are unchanged (cuts VIP write churn).
 */
async function mergeVipLoginTouchFromTorn(docRef, tornProf, existingData) {
  if (!tornProf) return existingData || null;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const pid = docRef.id;
  const nextName = tornProf.playerName || existingData?.playerName || `Player ${pid}`;
  const nextFid = tornProf.factionId
    ? String(tornProf.factionId).trim()
    : existingData?.factionId != null
      ? String(existingData.factionId).trim()
      : '';
  const nextFName = tornProf.factionName
    ? String(tornProf.factionName)
    : existingData?.factionName != null
      ? String(existingData.factionName)
      : '';

  if (existingData) {
    const lastLoginMs = existingData.lastLoginDate ? new Date(existingData.lastLoginDate).getTime() : 0;
    const recent =
      Number.isFinite(lastLoginMs) && lastLoginMs > 0 && nowMs - lastLoginMs < VIP_LOGIN_WRITE_MIN_MS;
    const prevFid = existingData.factionId != null ? String(existingData.factionId).trim() : '';
    const sameMeta =
      String(existingData.playerName || '') === String(nextName) &&
      prevFid === nextFid &&
      String(existingData.factionName || '') === nextFName;
    if (recent && sameMeta) {
      return { ...existingData, playerId: pid };
    }
  }

  const patch = {
    playerId: pid,
    playerName: nextName,
    lastLoginDate: nowIso,
  };
  if (nextFid) patch.factionId = nextFid;
  if (nextFName) patch.factionName = nextFName;

  if (!existingData) {
    patch.totalXanaxSent = 0;
    patch.currentBalance = 0;
    patch.lastDeductionDate = null;
    patch.vipLevel = 0;
  }

  await docRef.set(patch, { merge: true });
  const merged = { ...(existingData || {}), ...patch };
  await syncVipRegistryPlayer(docRef.id, merged, existingData);
  return merged;
}

/** Record login + refresh faction from the player’s own verified API key (no admin key required). */
exports.touchVipLogin = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { playerId, apiKey } = request.data || {};
  const pid = playerId != null ? String(playerId).trim() : '';
  if (!pid) throw new HttpsError('invalid-argument', 'playerId required');
  const apiKeyClean = String(apiKey || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '');
  if (apiKeyClean.length !== 16) {
    throw new HttpsError('invalid-argument', 'Valid 16-character Torn API key required');
  }
  const keyOk = await verifyTornApiKeyMatchesPlayerId(apiKeyClean, pid);
  if (!keyOk) throw new HttpsError('permission-denied', 'API key does not match player');
  const tornProf = await fetchTornPlayerProfileForVipPoolSafe(apiKeyClean, pid);
  if (!tornProf) throw new HttpsError('failed-precondition', 'Could not load Torn profile');
  const docRef = db.collection(VIP_BALANCES_COLLECTION).doc(pid);
  const docSnap = await docRef.get();
  const merged = await mergeVipLoginTouchFromTorn(docRef, tornProf, docSnap.exists ? docSnap.data() : null);
  return {
    success: true,
    lastLoginDate: merged?.lastLoginDate ?? null,
    factionId: merged?.factionId ?? null,
    factionName: merged?.factionName ?? null,
  };
});

/** Get VIP balance by playerId or playerName. Optional apiKey (16-char): must match playerId so we can read Torn faction and grant pooled VIP when there is no vipBalances row yet. */
exports.getVipBalance = onCall(
  callableOpts({ maxInstances: 10 }),
  async (request) => {
    const { playerId, playerName, apiKey } = request.data || {};
    const apiKeyClean = String(apiKey || '')
      .trim()
      .replace(/[^A-Za-z0-9]/g, '');

    if (playerId) {
      const pid = String(playerId);
      const docRef = db.collection(VIP_BALANCES_COLLECTION).doc(pid);
      const docSnap = await docRef.get();

      let tornProf = null;
      let keyOk = false;
      if (apiKeyClean.length === 16) {
        keyOk = await verifyTornApiKeyMatchesPlayerId(apiKeyClean, pid);
        if (keyOk) {
          tornProf = await fetchTornPlayerProfileForVipPoolSafe(apiKeyClean, pid);
        }
      }
      const tornFid = tornProf && tornProf.factionId ? String(tornProf.factionId).trim() : '';

      if (!docSnap.exists) {
        if (keyOk && tornProf) {
          const merged = await mergeVipLoginTouchFromTorn(docRef, tornProf, null);
          return buildVipBalanceResponseFromDocData(merged, tornFid);
        }
        if (!tornFid) return null;
        const pool = await readVipFactionPoolTotals(tornFid);
        if (!pool || pool.memberCount < 1) return null;
        const effectiveLevel = vipLevelFromBalance(pool.combinedBalance);
        const name = tornProf ? tornProf.playerName : `Player ${pid}`;
        const out = {
          playerId: pid,
          playerName: name,
          totalXanaxSent: 0,
          currentBalance: 0,
          lastDeductionDate: null,
          vipLevel: effectiveLevel,
          lastLoginDate: null,
          factionId: tornFid,
          factionCombinedBalance: pool.combinedBalance,
          factionMemberCount: pool.memberCount,
        };
        if (tornProf && tornProf.factionName) out.factionName = tornProf.factionName;
        return out;
      }

      const d = docSnap.data();
      let merged = { ...d, playerId: pid };
      if (keyOk && tornProf) {
        merged = (await mergeVipLoginTouchFromTorn(docRef, tornProf, d)) || merged;
      } else if (tornProf) {
        if (tornProf.playerName) merged.playerName = tornProf.playerName;
        if (tornProf.factionName) merged.factionName = tornProf.factionName;
        if (tornFid) merged.factionId = tornFid;
      }
      const docFid = merged.factionId != null ? String(merged.factionId).trim() : '';
      const poolQueryFactionId = tornFid || docFid;
      return buildVipBalanceResponseFromDocData(merged, poolQueryFactionId);
    }
    if (playerName) {
      const snap = await db.collection(VIP_BALANCES_COLLECTION).where('playerName', '==', String(playerName)).limit(1).get();
      if (snap.empty) return null;
      return buildVipBalanceResponseFromDocData(snap.docs[0].data());
    }
    throw new HttpsError('invalid-argument', 'playerId or playerName required');
  }
);

/** Update or create VIP balance row. */
exports.updateVipBalance = onCall(
  callableOpts({ maxInstances: 10 }),
  async (request) => {
    const data = request.data || {};
    const playerId = data.playerId != null ? String(data.playerId) : '';
    const playerName = data.playerName != null ? String(data.playerName) : '';
    if (!playerId) throw new HttpsError('invalid-argument', 'playerId required');
    const ref = db.collection(VIP_BALANCES_COLLECTION).doc(playerId);
    const prevSnap = await ref.get();
    const prev = prevSnap.exists ? prevSnap.data() : {};
    const oldBal = Number(prev.currentBalance) || 0;
    const oldSent = Number(prev.totalXanaxSent) || 0;
    const doc = {
      playerId: data.playerId,
      playerName: playerName,
      totalXanaxSent: data.totalXanaxSent ?? 0,
      currentBalance: data.currentBalance ?? 0,
      lastDeductionDate: data.lastDeductionDate ?? null,
      vipLevel: data.vipLevel ?? 0,
      lastLoginDate: data.lastLoginDate ?? null,
    };
    if (data.factionName != null && data.factionName !== '') doc.factionName = data.factionName;
    if (data.factionId != null && data.factionId !== '') doc.factionId = String(data.factionId);
    await ref.set(doc, { merge: true });
    await syncVipRegistryPlayer(playerId, { ...prev, ...doc }, prev);
    const newBal = Number(doc.currentBalance) || 0;
    const newSent = Number(doc.totalXanaxSent) || 0;
    const dBal = newBal - oldBal;
    const dSent = newSent - oldSent;
    const wantAdminLog = data.adminEditLog === true;
    const adminKey = String(data.apiKey || '')
      .trim()
      .replace(/[^A-Za-z0-9]/g, '');
    if (wantAdminLog && (dBal !== 0 || dSent !== 0) && (await validateAdminApiKey(adminKey))) {
      const logRow = {
        timestamp: new Date().toISOString(),
        playerId,
        playerName: playerName || String(prev.playerName || ''),
        transactionType: 'Admin adjustment',
        amount: dBal,
        balanceAfter: newBal,
      };
      if (dSent !== 0) logRow.deltaTotalXanaxSent = dSent;
      await db.collection(VIP_TRANSACTIONS_COLLECTION).add(logRow);
    }
    return { success: true };
  }
);

/** Log one VIP transaction. */
exports.logVipTransaction = onCall(
  callableOpts({ maxInstances: 10 }),
  async (request) => {
    const data = request.data || {};
    const row = {
      timestamp: data.timestamp || new Date().toISOString(),
      playerId: data.playerId != null ? String(data.playerId) : '',
      playerName: data.playerName != null ? String(data.playerName) : '',
      amount: data.amount ?? 0,
      transactionType: data.transactionType ?? 'Sent',
      balanceAfter: data.balanceAfter ?? 0,
    };
    if (data.tornEventId != null && String(data.tornEventId).trim() !== '') {
      row.tornEventId = String(data.tornEventId);
    }
    if (data.tornEventTimestamp != null && Number.isFinite(Number(data.tornEventTimestamp))) {
      row.tornEventTimestamp = Number(data.tornEventTimestamp);
    }
    await db.collection(VIP_TRANSACTIONS_COLLECTION).add(row);
    return { success: true };
  }
);

/**
 * Apply Xanax credits from Torn event IDs idempotently (dedupe on refresh).
 * Each credit: { tornEventId, tornEventTimestamp (unix sec), amount }.
 */
exports.applyVipTornXanaxCredits = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const data = request.data || {};
  const playerId = data.playerId != null ? String(data.playerId).trim() : '';
  const playerName = data.playerName != null ? String(data.playerName) : '';
  const credits = Array.isArray(data.credits) ? data.credits : [];
  if (!playerId) throw new HttpsError('invalid-argument', 'playerId required');
  if (credits.length === 0) return { appliedCount: 0, deltaXanax: 0, balance: null };

  const factionName = data.factionName != null ? String(data.factionName) : '';
  const factionId = data.factionId != null ? String(data.factionId) : '';
  return applyVipTornXanaxCreditsInternal(playerId, playerName, credits, { factionName, factionId });
});

const { validateAdminApiKey } = require('./adminAuth');

/**
 * Load display name and faction from Torn `user/{id}?selections=profile` (name + faction.faction_name / faction_id).
 * @returns {{ playerName: string, factionName: string, factionId: string, factionPatch: 'set'|'clear'|'omit' }}
 */
async function fetchTornPlayerNameAndFactionForVip(keyClean, pid) {
  let playerName = '';
  let factionName = '';
  let factionId = '';
  const res = await fetch(
    `https://api.torn.com/user/${pid}?selections=profile&key=${encodeURIComponent(keyClean)}`
  );
  const data = await res.json();
  if (data.error) {
    const err = data.error;
    const msg =
      typeof err === 'object' && err != null && err.error != null
        ? String(err.error)
        : typeof err === 'string'
          ? err
          : 'Torn lookup failed';
    throw new HttpsError('failed-precondition', msg);
  }
  if (data.name) playerName = String(data.name).trim();
  const fac = data.faction;
  let factionPatch = 'omit';
  if (fac && typeof fac === 'object') {
    if (fac.faction_name != null && String(fac.faction_name).trim() !== '') {
      factionName = String(fac.faction_name).trim();
    }
    if (fac.faction_id != null && String(fac.faction_id).trim() !== '') {
      factionId = String(fac.faction_id).trim();
    }
    if (factionName || factionId) {
      factionPatch = 'set';
    } else {
      factionPatch = 'clear';
    }
  } else if (fac === null || fac === '') {
    factionPatch = 'clear';
  }
  if (!playerName) playerName = `Player ${pid}`;
  return { playerName, factionName, factionId, factionPatch };
}

exports.getVipBalancesForAdmin = onCall(
  callableOpts({ maxInstances: 10 }),
  async (request) => {
    const { apiKey } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');
    const players = await readVipBalancesRegistry();
    const list = Object.entries(players).map(([id, row]) => vipRegistryRowToAdminBalance(id, row));
    return { balances: list };
  }
);

/**
 * Admin-only: save the Torn API key used by the scheduled job `syncVipIncomingXanaxFromEvents` to poll your event feed.
 * Stored at vipIncomingXanaxPoll/settings (same key you use here — must pass validateAdminApiKey).
 */
exports.registerVipIncomingXanaxPollKey = onCall(callableOpts({ maxInstances: 3 }), async (request) => {
  const { apiKey } = request.data || {};
  const ok = await validateAdminApiKey(apiKey);
  if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');
  const key = String(apiKey || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '');
  if (key.length !== 16) throw new HttpsError('invalid-argument', 'Valid 16-character Torn API key required');
  await db.collection(VIP_INCOMING_XANAX_POLL_COLLECTION).doc('settings').set(
    {
      apiKey: key,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { success: true };
});

/** Admin-only: recent incoming Xanax rows from the server poller (vipIncomingXanaxLog). */
const VIP_INCOMING_SCHEDULE_MINUTES = 10;

exports.getVipIncomingXanaxLogForAdmin = onCall(
  callableOpts({ maxInstances: 10 }),
  async (request) => {
    const { apiKey, limit } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');
    const lim = Math.min(200, Math.max(1, parseInt(String(limit != null ? limit : 100), 10) || 100));
    const logRef = db.collection(VIP_INCOMING_XANAX_LOG_COLLECTION).orderBy('tornEventTimestamp', 'desc').limit(lim);
    const stateRef = db.collection(VIP_INCOMING_XANAX_POLL_COLLECTION).doc('state');
    const [snap, stateSnap] = await Promise.all([logRef.get(), stateRef.get()]);

    const entries = [];
    snap.docs.forEach((doc) => {
      const d = doc.data();
      entries.push({
        tornEventId: d.tornEventId != null ? String(d.tornEventId) : doc.id,
        tornEventTimestamp: d.tornEventTimestamp != null ? Number(d.tornEventTimestamp) : null,
        senderPlayerId: d.senderPlayerId != null ? String(d.senderPlayerId) : '',
        senderName: d.senderName != null ? String(d.senderName) : '',
        amount: d.amount != null ? Number(d.amount) : 0,
        recipientPlayerId: d.recipientPlayerId != null ? String(d.recipientPlayerId) : '',
      });
    });

    const pollInfo = {
      lastPollAtMs: null,
      nextSyncApproxMs: null,
      lastEventsFromUnix: null,
      lastEventCount: null,
      lastPollPages: null,
      lastPollSource: null,
      lastPulledNewestEventId: null,
      lastPulledNewestEventTimestamp: null,
      lastPulledNewestEventPreview: null,
      scheduleIntervalMinutes: VIP_INCOMING_SCHEDULE_MINUTES,
    };
    if (stateSnap.exists) {
      const d = stateSnap.data();
      if (d.lastPollAt && typeof d.lastPollAt.toMillis === 'function') {
        pollInfo.lastPollAtMs = d.lastPollAt.toMillis();
        pollInfo.nextSyncApproxMs = pollInfo.lastPollAtMs + VIP_INCOMING_SCHEDULE_MINUTES * 60 * 1000;
      }
      if (d.lastEventsFromUnix != null && Number.isFinite(Number(d.lastEventsFromUnix))) {
        pollInfo.lastEventsFromUnix = Number(d.lastEventsFromUnix);
      }
      if (d.lastEventCount != null && Number.isFinite(Number(d.lastEventCount))) {
        pollInfo.lastEventCount = Number(d.lastEventCount);
      }
      if (d.lastPollPages != null && Number.isFinite(Number(d.lastPollPages))) {
        pollInfo.lastPollPages = Number(d.lastPollPages);
      }
      if (d.lastPollSource != null) pollInfo.lastPollSource = String(d.lastPollSource);
      if (d.lastPulledNewestEventId != null && String(d.lastPulledNewestEventId).trim() !== '') {
        pollInfo.lastPulledNewestEventId = String(d.lastPulledNewestEventId);
      }
      if (d.lastPulledNewestEventTimestamp != null && Number.isFinite(Number(d.lastPulledNewestEventTimestamp))) {
        pollInfo.lastPulledNewestEventTimestamp = Number(d.lastPulledNewestEventTimestamp);
      }
      if (d.lastPulledNewestEventPreview != null && String(d.lastPulledNewestEventPreview).trim() !== '') {
        pollInfo.lastPulledNewestEventPreview = String(d.lastPulledNewestEventPreview);
      }
    }

    return { entries, pollInfo };
  }
);

/** Admin-only: add/update VIP row from player ID + balance (missed events, free trials). Resolves name via Torn API. */
exports.adminAddVipPlayer = onCall(
  callableOpts({ maxInstances: 5 }),
  async (request) => {
    const { apiKey, playerId, currentBalance, totalXanaxSent } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');
    const pid = String(playerId ?? '').replace(/[^\d]/g, '');
    if (!pid) throw new HttpsError('invalid-argument', 'Valid player ID required');
    const bal = Number(currentBalance);
    if (Number.isNaN(bal) || bal < 0 || Math.floor(bal) !== bal) {
      throw new HttpsError('invalid-argument', 'Current balance must be a non-negative whole number');
    }
    let sent = 0;
    if (totalXanaxSent != null && totalXanaxSent !== '') {
      const t = Number(totalXanaxSent);
      if (!Number.isNaN(t) && t >= 0 && Math.floor(t) === t) sent = t;
    }
    const keyClean = String(apiKey || '')
      .trim()
      .replace(/[^A-Za-z0-9]/g, '');
    let playerName = '';
    let factionName = '';
    let factionId = '';
    try {
      const prof = await fetchTornPlayerNameAndFactionForVip(keyClean, pid);
      playerName = prof.playerName;
      factionName = prof.factionName;
      factionId = prof.factionId;
    } catch (e) {
      if (e instanceof HttpsError) throw e;
    }
    if (!playerName) playerName = `Player ${pid}`;
    const vipLevel = vipLevelFromBalance(bal);
    const nowIso = new Date().toISOString();
    const doc = {
      playerId: pid,
      playerName,
      totalXanaxSent: sent,
      currentBalance: bal,
      lastDeductionDate: nowIso,
      vipLevel,
      lastLoginDate: nowIso,
    };
    if (factionName || factionId) {
      doc.factionName = factionName;
      doc.factionId = factionId;
    }
    await db.collection(VIP_BALANCES_COLLECTION).doc(pid).set(doc, { merge: true });
    await syncVipRegistryPlayer(pid, doc, null);
    await db.collection(VIP_TRANSACTIONS_COLLECTION).add({
      timestamp: nowIso,
      playerId: pid,
      playerName,
      amount: bal,
      transactionType: 'Manual add',
      balanceAfter: bal,
    });
    return { success: true, playerName, playerId: pid };
  }
);

/**
 * Admin-only: re-fetch every VIP balance row’s player name and faction from Torn (`selections=profile`) and merge.
 * Clears stored faction only when the profile response explicitly indicates no faction (never on missing/ambiguous faction).
 */
exports.refreshVipProfilesFromTorn = onCall(
  callableOpts({ maxInstances: 2, timeoutSeconds: 300 }),
  async (request) => {
    const { apiKey } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');
    const keyClean = String(apiKey || '')
      .trim()
      .replace(/[^A-Za-z0-9]/g, '');
    if (keyClean.length !== 16) {
      throw new HttpsError('invalid-argument', 'Valid 16-character Torn API key required');
    }

    const players = await readVipBalancesRegistry();
    const failed = [];
    let updated = 0;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    let n = 0;
    for (const pid of Object.keys(players)) {
      if (n++ > 0) await delay(150);
      try {
        const prevRow = players[pid];
        const { playerName, factionName, factionId, factionPatch } =
          await fetchTornPlayerNameAndFactionForVip(keyClean, pid);
        const patch = {
          playerName,
          lastProfileRefreshAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (factionPatch === 'set') {
          patch.factionName = factionName;
          patch.factionId = factionId;
        } else if (factionPatch === 'clear') {
          patch.factionName = admin.firestore.FieldValue.delete();
          patch.factionId = admin.firestore.FieldValue.delete();
        }
        const ref = db.collection(VIP_BALANCES_COLLECTION).doc(pid);
        await ref.set(patch, { merge: true });
        const merged = { ...prevRow, ...patch };
        if (factionPatch === 'clear') {
          delete merged.factionName;
          delete merged.factionId;
        }
        await syncVipRegistryPlayer(pid, merged, prevRow);
        players[pid] = vipPlayerRowFromData(merged, pid);
        updated++;
      } catch (e) {
        const msg =
          e instanceof HttpsError
            ? e.message
            : e && e.message
              ? String(e.message)
              : String(e);
        failed.push({ playerId: pid, error: msg.slice(0, 240) });
      }
    }

    await db.collection('vipAdminMeta').doc('lastProfileRefresh').set(
      {
        at: admin.firestore.FieldValue.serverTimestamp(),
        total: Object.keys(players).length,
        updated,
        failedCount: failed.length,
      },
      { merge: true }
    );

    return {
      success: true,
      total: Object.keys(players).length,
      updated,
      failedCount: failed.length,
      failed: failed.slice(0, 40),
    };
  }
);

/** Admin-only: return VIP transactions for a player (when they sent xanax / deductions). */
exports.getVipTransactionsForAdmin = onCall(
  callableOpts({ maxInstances: 10 }),
  async (request) => {
    const { apiKey, playerId } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');
    const pid = String(playerId ?? '');
    if (!pid) throw new HttpsError('invalid-argument', 'playerId required');
    // Equality-only query: avoids composite index (where + orderBy would need playerId+timestamp index).
    const snap = await db.collection(VIP_TRANSACTIONS_COLLECTION).where('playerId', '==', pid).get();
    const list = snap.docs.map((doc) => {
      const d = doc.data();
      const row = {
        _ts: vipTransactionTimestampMs(d.timestamp),
        timestamp: d.timestamp ?? null,
        transactionType: d.transactionType ?? 'Sent',
        amount: d.amount ?? 0,
        balanceAfter: d.balanceAfter ?? 0,
      };
      if (d.tornEventId != null && String(d.tornEventId).trim() !== '') row.tornEventId = String(d.tornEventId);
      if (d.deltaTotalXanaxSent != null && Number.isFinite(Number(d.deltaTotalXanaxSent))) {
        row.deltaTotalXanaxSent = Number(d.deltaTotalXanaxSent);
      }
      return row;
    });
    list.sort((a, b) => b._ts - a._ts);
    const transactions = list.slice(0, 200).map((row) => {
      const out = {
        timestamp: row.timestamp,
        transactionType: row.transactionType,
        amount: row.amount,
        balanceAfter: row.balanceAfter,
      };
      if (row.tornEventId != null && String(row.tornEventId).trim() !== '') {
        out.tornEventId = String(row.tornEventId);
      }
      if (row.deltaTotalXanaxSent != null && Number.isFinite(Number(row.deltaTotalXanaxSent))) {
        out.deltaTotalXanaxSent = Number(row.deltaTotalXanaxSent);
      }
      return out;
    });
    return { transactions };
  }
);

/** One-off import: set VIP balances from a list of { playerId, playerName, amount }. Assumes all sent today; logs one "Sent" transaction per player. */
exports.importVipBalances = onCall(
  callableOpts({ maxInstances: 1 }),
  async (request) => {
    const { entries } = request.data || {};
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new HttpsError('invalid-argument', 'entries array required');
    }
    const now = new Date().toISOString();
    let imported = 0;
    for (const e of entries) {
      const playerId = e.playerId != null ? String(e.playerId) : '';
      const playerName = e.playerName != null ? String(e.playerName) : '';
      const amount = Number(e.amount) || 0;
      if (!playerId) continue;
      const ref = db.collection(VIP_BALANCES_COLLECTION).doc(playerId);
      const vipLevel = vipLevelFromBalance(amount);
      await ref.set({
        playerId: playerId,
        playerName: playerName,
        totalXanaxSent: amount,
        currentBalance: amount,
        lastDeductionDate: now,
        vipLevel,
        lastLoginDate: now,
      }, { merge: true });
      await syncVipRegistryPlayer(playerId, {
        playerId,
        playerName,
        totalXanaxSent: amount,
        currentBalance: amount,
        lastDeductionDate: now,
        vipLevel,
        lastLoginDate: now,
      }, null);
      await db.collection(VIP_TRANSACTIONS_COLLECTION).add({
        timestamp: now,
        playerId,
        playerName,
        amount,
        transactionType: 'Sent',
        balanceAfter: amount,
      });
      imported++;
    }
    return { success: true, imported };
  }
);

/** Every 10 minutes: for each tracked faction, use one stored key, call Torn API, append shared window doc. */
exports.sampleActivity = onSchedule(
  { schedule: 'every 10 minutes', timeZone: 'UTC' },
  async () => {
    const registry = await readTrackedFactionRegistry();
    if (!Object.keys(registry).length) return;

    const now = Date.now();
    let registryChanged = false;
    const prunedRegistry = {};
    for (const [fid, entry] of Object.entries(registry)) {
      const keysBefore = entry.keys || [];
      const keys = filterActiveActivityKeys(keysBefore, now);
      if (keys.length !== keysBefore.length) registryChanged = true;
      if (!keys.length) continue;
      prunedRegistry[fid] = { keys, addedAt: entry.addedAt };
    }
    if (registryChanged) await writeTrackedFactionRegistry(prunedRegistry);

    const factions = {};
    for (const [fid, entry] of Object.entries(prunedRegistry)) {
      const apiKey = (entry.keys[0] && entry.keys[0].key) || '';
      if (!apiKey || !String(apiKey).trim()) continue;
      try {
        const members = await fetchFactionMembers(apiKey, fid);
        factions[String(fid)] = { onlineIds: onlineIds(members) };
      } catch (e) {
        console.warn('Torn API failed for faction', fid, e.message);
      }
    }

    if (Object.keys(factions).length === 0) return;

    await Promise.all(
      Object.entries(factions).map(([fid, data]) =>
        appendActivitySampleWindow(fid, now, data.onlineIds || []).catch((e) => {
          console.warn('activitySampleWindows write failed for faction', fid, e.message);
        })
      )
    );
  }
);

// 48 hours between deductions (1 xanax per 48h while balance > 0)
const VIP_DEDUCTION_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

/** Apply 1 xanax per 2 days from lastDeductionDate (last time we ran deductions for this player). */
function vipDeductionsFromLastDate(lastDeductionDateIso, nowMs) {
  if (!lastDeductionDateIso) return 0;
  const lastMs = new Date(lastDeductionDateIso).getTime();
  return Math.floor((nowMs - lastMs) / VIP_DEDUCTION_INTERVAL_MS);
}

exports.applyVipDeductions = onSchedule(
  { schedule: 'every 6 hours', timeZone: 'UTC', timeoutSeconds: 300 },
  async () => {
    console.log('[applyVipDeductions] scheduled run start');
    const players = await readVipBalancesRegistry();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let updated = 0;
    let errors = 0;

    for (const [playerId, d] of Object.entries(players)) {
      try {
        const lastDeductionDate = d.lastDeductionDate ?? null;
        if (!lastDeductionDate) continue;

        const currentBalance = Number(d.currentBalance) ?? 0;
        const deductions = vipDeductionsFromLastDate(lastDeductionDate, now);
        if (deductions <= 0) continue;

        const newBalance = Math.max(0, currentBalance - deductions);
        const newLevel = vipLevelFromBalance(newBalance);

        await db.collection(VIP_BALANCES_COLLECTION).doc(playerId).update({
          currentBalance: newBalance,
          lastDeductionDate: nowIso,
          vipLevel: newLevel,
        });

        const nextRow = {
          ...d,
          currentBalance: newBalance,
          lastDeductionDate: nowIso,
          vipLevel: newLevel,
        };
        players[playerId] = vipPlayerRowFromData(nextRow, playerId);
        await applyVipFactionPoolDelta(d, nextRow);

        await db.collection(VIP_TRANSACTIONS_COLLECTION).add({
          timestamp: nowIso,
          playerId,
          playerName: d.playerName ?? '',
          amount: deductions,
          transactionType: 'Deduction',
          balanceAfter: newBalance,
        });
        updated++;
      } catch (e) {
        errors++;
        console.error('[applyVipDeductions] player doc error', playerId, e && e.message);
      }
    }
    await writeVipBalancesRegistry(players);
    console.log('[applyVipDeductions] done updated=', updated, 'errors=', errors);
  }
);

function tornEventTimestamp(ev) {
  const ts = typeof ev.timestamp === 'number' ? ev.timestamp : parseInt(ev.timestamp, 10);
  return Number.isFinite(ts) ? ts : NaN;
}

/** One page of user events. Optional sort (e.g. DESC), limit (max 100), to (unix upper bound inclusive per Torn docs). */
async function fetchTornUserEventsPage(apiKey, fromUnix, opts) {
  const optsIn = opts || {};
  const from = Math.floor(Number(fromUnix) || 0);
  const q = [`selections=events`, `from=${from}`, `key=${encodeURIComponent(apiKey)}`];
  if (optsIn.sort) q.push(`sort=${encodeURIComponent(String(optsIn.sort))}`);
  if (optsIn.limit != null) {
    const lim = Math.min(100, Math.max(1, Math.floor(Number(optsIn.limit))));
    q.push(`limit=${lim}`);
  }
  if (optsIn.to != null && Number.isFinite(Number(optsIn.to))) {
    q.push(`to=${Math.floor(Number(optsIn.to))}`);
  }
  const url = `https://api.torn.com/user/?${q.join('&')}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(String(data.error.error || data.error));
  const ev = data.events;
  return ev && typeof ev === 'object' ? ev : {};
}

/**
 * Walk the feed in windows until a page has fewer than 100 events (or empty), merging by event id.
 * Uses from + to + sort=DESC + limit=100 when supported; falls back to a single legacy request on error.
 * @returns {Promise<{ eventsObj: Record<string, unknown>, pages: number }>}
 */
async function collectEventsSince(apiKey, requestFrom) {
  const merged = new Map();
  let toBound = null;
  let pages = 0;
  let usedPlainFallback = false;

  for (let guard = 0; guard < 100; guard++) {
    pages += 1;
    let batch;
    try {
      const opts = usedPlainFallback
        ? {}
        : {
            sort: 'DESC',
            limit: 100,
            ...(toBound != null ? { to: toBound } : {}),
          };
      batch = await fetchTornUserEventsPage(apiKey, requestFrom, opts);
    } catch (e) {
      if (!usedPlainFallback && pages === 1) {
        usedPlainFallback = true;
        batch = await fetchTornUserEventsPage(apiKey, requestFrom, {});
        for (const [id, ev] of Object.entries(batch)) merged.set(id, ev);
        break;
      }
      console.warn('[collectEventsSince] page error', pages, e && e.message);
      break;
    }

    const entries = Object.entries(batch);
    if (entries.length === 0) break;

    for (const [id, ev] of entries) merged.set(id, ev);

    if (usedPlainFallback || entries.length < 100) break;

    const timestamps = entries.map(([, ev]) => tornEventTimestamp(ev)).filter(Number.isFinite);
    if (timestamps.length === 0) break;
    const minTs = Math.min(...timestamps);
    const nextTo = minTs - 1;
    if (nextTo < requestFrom) break;
    toBound = nextTo;
  }

  const eventsObj = {};
  merged.forEach((v, k) => {
    eventsObj[k] = v;
  });
  return { eventsObj, pages };
}

const VIP_INCOMING_MANUAL_DEBOUNCE_MS = 45 * 1000;

function stripHtmlToPlainPreview(html, maxLen) {
  const s = String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Newest Torn event in merged feed (any category), by timestamp then event id.
 * @param {[string, unknown][]} entriesPairs from Object.entries(eventsObj)
 */
function pickNewestFeedEvent(entriesPairs) {
  let bestId = '';
  let bestTs = -Infinity;
  let bestPreview = '';
  for (const [eventId, ev] of entriesPairs) {
    if (!ev || typeof ev !== 'object') continue;
    const ts = tornEventTimestamp(ev);
    if (!Number.isFinite(ts)) continue;
    const idStr = String(eventId);
    if (ts > bestTs || (ts === bestTs && idStr > bestId)) {
      bestTs = ts;
      bestId = idStr;
      const raw = ev && typeof ev === 'object' && 'event' in ev ? String(/** @type {{ event?: unknown }} */ (ev).event ?? '') : '';
      bestPreview = stripHtmlToPlainPreview(raw, 900);
    }
  }
  if (!Number.isFinite(bestTs) || bestTs === -Infinity) {
    return { tornEventId: '', tornEventTimestamp: null, preview: '' };
  }
  return {
    tornEventId: bestId,
    tornEventTimestamp: Math.floor(bestTs),
    preview: bestPreview,
  };
}

/**
 * Shared VIP incoming-Xanax poll (scheduled + optional manual callable).
 * @param {string} source 'schedule' | 'manual'
 * @param {{ overrideApiKey?: string, persistPollKeyIfMissing?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string, totalEvents?: number, pages?: number, xanaxSenders?: number, nextCursor?: number }>}
 */
async function runVipIncomingXanaxPollCore(source, opts) {
  const optsIn = opts || {};
  const override = String(optsIn.overrideApiKey || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '');

  let apiKey = '';
  let persistPollKeyAfterSuccess = false;

  if (override.length === 16) {
    const adminOk = await validateAdminApiKey(override);
    if (!adminOk) {
      console.error(`[runVipIncomingXanaxPollCore:${source}] override API key is not an admin player id`);
      return { ok: false, reason: 'invalid_admin_key' };
    }
    apiKey = override;
    if (optsIn.persistPollKeyIfMissing === true) {
      const settingsSnapEarly = await db.collection(VIP_INCOMING_XANAX_POLL_COLLECTION).doc('settings').get();
      const storedEarly = settingsSnapEarly.exists
        ? String(settingsSnapEarly.data().apiKey || '')
            .trim()
            .replace(/[^A-Za-z0-9]/g, '')
        : '';
      if (!storedEarly || storedEarly.length !== 16) persistPollKeyAfterSuccess = true;
    }
  } else {
    const settingsSnap = await db.collection(VIP_INCOMING_XANAX_POLL_COLLECTION).doc('settings').get();
    apiKey = settingsSnap.exists
      ? String(settingsSnap.data().apiKey || '')
          .trim()
          .replace(/[^A-Za-z0-9]/g, '')
      : '';
    if (!apiKey || apiKey.length !== 16) {
      console.warn(
        `[runVipIncomingXanaxPollCore:${source}] No apiKey in vipIncomingXanaxPoll/settings — admin can run Recheck VIP once to save it, or use Register server Xanax poller`
      );
      return { ok: false, reason: 'no_settings' };
    }
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) {
      console.error(`[runVipIncomingXanaxPollCore:${source}] poll key is not an admin player id`);
      return { ok: false, reason: 'invalid_admin_key' };
    }
  }

  let recipientPid = '';
  try {
    recipientPid = await fetchTornPlayerIdFromApiKey(apiKey);
  } catch (e) {
    console.error(`[runVipIncomingXanaxPollCore:${source}] profile`, e && e.message);
    return { ok: false, reason: 'profile_error' };
  }

  const stateRef = db.collection(VIP_INCOMING_XANAX_POLL_COLLECTION).doc('state');
  const stateSnap = await stateRef.get();
  const nowSec = Math.floor(Date.now() / 1000);
  const floorFrom = Math.max(0, nowSec - VIP_INCOMING_MAX_LOOKBACK_SEC);
  const prev = stateSnap.exists ? Number(stateSnap.data().lastEventsFromUnix) : NaN;
  let requestFrom =
    Number.isFinite(prev) && prev > 0 ? prev : floorFrom;
  requestFrom = Math.max(requestFrom, floorFrom);

  let eventsObj;
  let pages = 1;
  try {
    const collected = await collectEventsSince(apiKey, requestFrom);
    eventsObj = collected.eventsObj;
    pages = collected.pages;
  } catch (e) {
    console.error(`[runVipIncomingXanaxPollCore:${source}] Torn events`, e.message);
    return { ok: false, reason: 'torn_error' };
  }

  const entries = Object.entries(eventsObj);
  let nextCursor = requestFrom;
  for (const [, ev] of entries) {
    const ts = tornEventTimestamp(ev);
    if (Number.isFinite(ts)) nextCursor = Math.max(nextCursor, ts);
  }

  const bySender = new Map();

  for (const [eventId, ev] of entries) {
    if (!ev || !ev.event) continue;
    const html = String(ev.event);
    if (!html.includes('You were sent') || !/xanax/i.test(html)) continue;
    const parsed = parseIncomingXanaxEventHtml(html);
    if (!parsed || !parsed.playerId) continue;

    const ts = tornEventTimestamp(ev);
    if (!Number.isFinite(ts)) continue;

    const senderPid = String(parsed.playerId);
    const tornEventId = String(eventId);

    const logRef = db.collection(VIP_INCOMING_XANAX_LOG_COLLECTION).doc(tornEventId);
    try {
      await logRef.create({
        tornEventId,
        tornEventTimestamp: ts,
        recipientPlayerId: recipientPid,
        senderPlayerId: senderPid,
        senderName: parsed.playerName,
        amount: parsed.amount,
        rawEventSnippet: html.length > 500 ? html.slice(0, 500) : html,
        seenAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      // Already logged (ALREADY_EXISTS) — skip rewrite to avoid billed no-op writes.
      const code = e && (e.code || e.status);
      if (code !== 6 && code !== 'already-exists' && String(e && e.message || '').indexOf('ALREADY_EXISTS') === -1) {
        console.warn('[runVipIncomingXanaxPollCore] xanax log write', tornEventId, e && e.message);
      }
    }

    if (!bySender.has(senderPid)) bySender.set(senderPid, []);
    bySender.get(senderPid).push({
      tornEventId,
      tornEventTimestamp: ts,
      amount: parsed.amount,
      senderName: parsed.playerName,
    });
  }

  for (const [senderPid, rows] of bySender) {
    const firstName = rows[0].senderName;
    const creditObjs = rows.map((r) => ({
      tornEventId: r.tornEventId,
      tornEventTimestamp: r.tornEventTimestamp,
      amount: r.amount,
    }));
    try {
      await applyVipTornXanaxCreditsInternal(senderPid, firstName, creditObjs, {});
    } catch (e) {
      console.error(`[runVipIncomingXanaxPollCore:${source}] apply sender`, senderPid, e && e.message);
    }
  }

  let newestMeta = pickNewestFeedEvent(entries);
  if (entries.length === 0) {
    newestMeta = {
      tornEventId: '',
      tornEventTimestamp: null,
      preview: 'No Torn events returned this run (empty window or nothing new in range).',
    };
  } else if (!newestMeta.tornEventId && !newestMeta.preview) {
    newestMeta = {
      tornEventId: '',
      tornEventTimestamp: null,
      preview: `${entries.length} raw event(s) merged but none had a readable timestamp (unexpected Torn response shape).`,
    };
  }

  await stateRef.set(
    {
      lastEventsFromUnix: nextCursor,
      lastPollAt: admin.firestore.FieldValue.serverTimestamp(),
      lastEventCount: entries.length,
      lastPollPages: pages,
      lastPollSource: source,
      recipientPlayerId: recipientPid,
      lastPulledNewestEventId: newestMeta.tornEventId || null,
      lastPulledNewestEventTimestamp:
        newestMeta.tornEventTimestamp != null ? newestMeta.tornEventTimestamp : null,
      lastPulledNewestEventPreview: newestMeta.preview || null,
    },
    { merge: true }
  );

  if (persistPollKeyAfterSuccess) {
    await db.collection(VIP_INCOMING_XANAX_POLL_COLLECTION).doc('settings').set(
      {
        apiKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`[runVipIncomingXanaxPollCore:${source}] saved poll API key to vipIncomingXanaxPoll/settings (first admin sync)`);
  }

  console.log(
    `[runVipIncomingXanaxPollCore:${source}] events=${entries.length} pages=${pages} xanaxSenders=${bySender.size} nextCursor=${nextCursor}`
  );

  return {
    ok: true,
    totalEvents: entries.length,
    pages,
    xanaxSenders: bySender.size,
    nextCursor,
  };
}

/**
 * Every 10 minutes: read the recipient’s Torn event feed (stored poll key), multi-page until backlog drained,
 * log Xanax lines, credit senders, advance lastEventsFromUnix.
 */
exports.syncVipIncomingXanaxFromEvents = onSchedule(
  {
    schedule: 'every 10 minutes',
    timeZone: 'UTC',
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    await runVipIncomingXanaxPollCore('schedule', {});
  }
);

/**
 * Any user with a valid Torn key can trigger the same poll as the scheduler (debounced globally ~45s).
 * Lets the welcome “recheck VIP” path refresh all senders without waiting 10 minutes.
 */
exports.syncVipIncomingXanaxNow = onCall(
  callableOpts({ maxInstances: 5, timeoutSeconds: 540 }),
  async (request) => {
    const { apiKey } = request.data || {};
    try {
      await fetchTornPlayerIdFromApiKey(apiKey);
    } catch {
      throw new HttpsError('invalid-argument', 'Valid Torn API key required');
    }

    const keyNorm = String(apiKey || '')
      .trim()
      .replace(/[^A-Za-z0-9]/g, '');

    const settingsSnap = await db.collection(VIP_INCOMING_XANAX_POLL_COLLECTION).doc('settings').get();
    const pollKey = settingsSnap.exists
      ? String(settingsSnap.data().apiKey || '')
          .trim()
          .replace(/[^A-Za-z0-9]/g, '')
      : '';

    let pollOpts = {};
    if (!pollKey || pollKey.length !== 16) {
      const adminOk = await validateAdminApiKey(keyNorm);
      if (!adminOk) {
        return { ok: true, skipped: true, reason: 'poll_not_registered' };
      }
      pollOpts = { overrideApiKey: keyNorm, persistPollKeyIfMissing: true };
    }

    const stateRef = db.collection(VIP_INCOMING_XANAX_POLL_COLLECTION).doc('state');
    const debounce = await db.runTransaction(async (t) => {
      const snap = await t.get(stateRef);
      const last = snap.exists ? Number(snap.data().lastManualSyncMs) || 0 : 0;
      const now = Date.now();
      if (now - last < VIP_INCOMING_MANUAL_DEBOUNCE_MS) {
        return {
          skip: true,
          retryAfterSec: Math.ceil((VIP_INCOMING_MANUAL_DEBOUNCE_MS - (now - last)) / 1000),
        };
      }
      t.set(stateRef, { lastManualSyncMs: now }, { merge: true });
      return { skip: false };
    });

    if (debounce.skip) {
      return { ok: true, skipped: true, retryAfterSec: debounce.retryAfterSec };
    }

    const result = await runVipIncomingXanaxPollCore('manual', pollOpts);
    return { ok: true, skipped: false, ...result };
  }
);

/** Admin-only: run VIP deductions now (same logic as scheduled). Returns { updated: number }. */
exports.applyVipDeductionsNow = onCall(
  callableOpts({ maxInstances: 5 }),
  async (request) => {
    const { apiKey } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');

    const players = await readVipBalancesRegistry();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let updated = 0;

    for (const [playerId, d] of Object.entries(players)) {
      const lastDeductionDate = d.lastDeductionDate ?? null;
      if (!lastDeductionDate) continue;

      const currentBalance = Number(d.currentBalance) ?? 0;
      const deductions = vipDeductionsFromLastDate(lastDeductionDate, now);
      if (deductions <= 0) continue;

      const newBalance = Math.max(0, currentBalance - deductions);
      const newLevel = vipLevelFromBalance(newBalance);

      await db.collection(VIP_BALANCES_COLLECTION).doc(playerId).update({
        currentBalance: newBalance,
        lastDeductionDate: nowIso,
        vipLevel: newLevel,
      });

      const nextRow = { ...d, currentBalance: newBalance, lastDeductionDate: nowIso, vipLevel: newLevel };
      players[playerId] = vipPlayerRowFromData(nextRow, playerId);
      await applyVipFactionPoolDelta(d, nextRow);

      await db.collection(VIP_TRANSACTIONS_COLLECTION).add({
        timestamp: nowIso,
        playerId,
        playerName: d.playerName ?? '',
        amount: deductions,
        transactionType: 'Deduction',
        balanceAfter: newBalance,
      });
      updated++;
    }
    await writeVipBalancesRegistry(players);
    return { updated };
  }
);

/** One-time: set every VIP balance doc's lastDeductionDate to now so the next deduction is in 2 days. Admin-only. Use after restoring balances so they don't get zeroed again. */
exports.resetVipDeductionClock = onCall(
  callableOpts({ maxInstances: 1 }),
  async (request) => {
    const { apiKey } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');

    const nowIso = new Date().toISOString();
    const players = await readVipBalancesRegistry();
    let reset = 0;

    for (const playerId of Object.keys(players)) {
      await db.collection(VIP_BALANCES_COLLECTION).doc(playerId).update({ lastDeductionDate: nowIso });
      players[playerId] = { ...players[playerId], lastDeductionDate: nowIso };
      reset++;
    }
    await writeVipBalancesRegistry(players);

    return { reset };
  }
);

/** Faction chain watch list (owner/organisers + member signups) — see functions/chainWatch.js */
const chainWatch = require('./chainWatch');
exports.chainWatchGet = chainWatch.chainWatchGet;
exports.chainWatchSaveConfig = chainWatch.chainWatchSaveConfig;
exports.chainWatchSetOrganizers = chainWatch.chainWatchSetOrganizers;
exports.chainWatchArchive = chainWatch.chainWatchArchive;
exports.chainWatchAdminArchive = chainWatch.chainWatchAdminArchive;
exports.chainWatchAutoArchiveStale = chainWatch.chainWatchAutoArchiveStale;
exports.chainWatchListArchives = chainWatch.chainWatchListArchives;
exports.chainWatchGetArchive = chainWatch.chainWatchGetArchive;
exports.chainWatchRestoreFromArchive = chainWatch.chainWatchRestoreFromArchive;
exports.chainWatchAdminRecoveryReport = chainWatch.chainWatchAdminRecoveryReport;
exports.chainWatchAdminRestoreActive = chainWatch.chainWatchAdminRestoreActive;
exports.chainWatchSignup = chainWatch.chainWatchSignup;
exports.chainWatchRemoveSelf = chainWatch.chainWatchRemoveSelf;
exports.chainWatchSyncChain = chainWatch.chainWatchSyncChain;

/** Alliance roster + shared vault — see functions/allianceDashboard.js */
const allianceDashboard = require('./allianceDashboard');
exports.allianceCreate = allianceDashboard.allianceCreate;
exports.allianceAddFaction = allianceDashboard.allianceAddFaction;
exports.allianceRename = allianceDashboard.allianceRename;
exports.allianceRemoveFaction = allianceDashboard.allianceRemoveFaction;
exports.allianceListMine = allianceDashboard.allianceListMine;
exports.allianceBackfillMembershipIndex = allianceDashboard.allianceBackfillMembershipIndex;
exports.allianceVaultUpsert = allianceDashboard.allianceVaultUpsert;
exports.allianceVaultDelete = allianceDashboard.allianceVaultDelete;
exports.allianceTerritorySyncFromApi = allianceDashboard.allianceTerritorySyncFromApi;
exports.allianceTerritorySetManualTileCodes = allianceDashboard.allianceTerritorySetManualTileCodes;
