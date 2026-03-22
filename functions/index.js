/**
 * Activity tracker backend:
 * - HTTP: addTrackedFaction / removeTrackedFaction / listMyActivityFactions (optional apiKey reconciles legacy trackedFactionKeys).
 * - Scheduled: every 5 min, sampleActivity reads trackedFactionKeys, writes activitySamples.
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

const ACTIVITY_SAMPLES_COLLECTION = 'activitySamples';
const TRACKED_FACTIONS_COLLECTION = 'trackedFactions';
const TRACKED_FACTION_KEYS_COLLECTION = 'trackedFactionKeys';
/** Factions a Torn player registered for 24/7 sampling (cross-browser / localhost vs prod). */
const ACTIVITY_REGISTRATIONS_BY_PLAYER = 'activityRegistrationsByPlayer';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TICK_MS = 5 * 60 * 1000;

function getTickId(ms) {
  return String(Math.floor(ms / TICK_MS) * TICK_MS);
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
  const snap = await db.collection(TRACKED_FACTION_KEYS_COLLECTION).get();
  const matchedFactionIds = [];
  for (const doc of snap.docs) {
    const keysArr = doc.data().keys || [];
    const hasKey = keysArr.some((e) => String(e.key || '').trim() === apiKeyTrim);
    if (!hasKey) continue;
    matchedFactionIds.push(doc.id);
    const needsPatch = keysArr.some(
      (e) => String(e.key || '').trim() === apiKeyTrim && String(e.tornPlayerId || '') !== verifiedPlayerId
    );
    if (needsPatch) {
      const newKeys = keysArr.map((e) => {
        if (String(e.key || '').trim() === apiKeyTrim) {
          return { key: e.key, userId: e.userId, tornPlayerId: verifiedPlayerId };
        }
        const o = { key: e.key, userId: e.userId };
        if (e.tornPlayerId) o.tornPlayerId = e.tornPlayerId;
        return o;
      });
      await doc.ref.set({ keys: newKeys });
    }
  }
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
    const ref = db.collection(TRACKED_FACTION_KEYS_COLLECTION).doc(fid);
    const snap = await ref.get();
    const keys = (snap.exists && snap.data().keys) || [];
    const next = keys.filter((e) => e.userId !== uid);
    const entry = { key: key, userId: uid };
    if (tornPid) entry.tornPlayerId = tornPid;
    next.push(entry);
    await ref.set({ keys: next });
    await db.collection(TRACKED_FACTIONS_COLLECTION).doc(fid).set({ addedAt: Date.now() }, { merge: true });
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
    const ref = db.collection(TRACKED_FACTION_KEYS_COLLECTION).doc(fid);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(200).json({ result: { ok: true } });
      return;
    }
    const keysBefore = snap.data().keys || [];
    const keys = keysBefore.filter((e) => e.userId !== uid);
    if (tornPid) {
      const stillHasTorn = keys.some((e) => String(e.tornPlayerId || '') === tornPid);
      if (!stillHasTorn) {
        await db
          .collection(ACTIVITY_REGISTRATIONS_BY_PLAYER)
          .doc(tornPid)
          .set({ factionIds: admin.firestore.FieldValue.arrayRemove(fid) }, { merge: true });
      }
    }
    if (keys.length === 0) {
      await ref.delete();
      await db.collection(TRACKED_FACTIONS_COLLECTION).doc(fid).delete();
    } else {
      await ref.set({ keys });
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
    const allKeys = await db.collection(TRACKED_FACTION_KEYS_COLLECTION).get();
    allKeys.forEach((doc) => {
      const arr = doc.data().keys || [];
      const match = arr.some((k) => {
        if (uid && k.userId === uid) return true;
        if (effectiveTornPid && String(k.tornPlayerId || '') === effectiveTornPid) return true;
        return false;
      });
      if (match) out.add(doc.id);
    });
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
const VIP_TRANSACTIONS_COLLECTION = 'vipTransactions';

/** Get VIP balance by playerId or playerName. Returns same shape as Apps Script (playerId, playerName, totalXanaxSent, currentBalance, lastDeductionDate, vipLevel, lastLoginDate) or null. */
exports.getVipBalance = onCall(
  callableOpts({ maxInstances: 10 }),
  async (request) => {
    const { playerId, playerName } = request.data || {};
    if (playerId) {
      const doc = await db.collection(VIP_BALANCES_COLLECTION).doc(String(playerId)).get();
      if (!doc.exists) return null;
      const d = doc.data();
      return {
        playerId: d.playerId,
        playerName: d.playerName,
        totalXanaxSent: d.totalXanaxSent ?? 0,
        currentBalance: d.currentBalance ?? 0,
        lastDeductionDate: d.lastDeductionDate ?? null,
        vipLevel: d.vipLevel ?? 0,
        lastLoginDate: d.lastLoginDate ?? null,
      };
    }
    if (playerName) {
      const snap = await db.collection(VIP_BALANCES_COLLECTION).where('playerName', '==', String(playerName)).limit(1).get();
      if (snap.empty) return null;
      const d = snap.docs[0].data();
      return {
        playerId: d.playerId,
        playerName: d.playerName,
        totalXanaxSent: d.totalXanaxSent ?? 0,
        currentBalance: d.currentBalance ?? 0,
        lastDeductionDate: d.lastDeductionDate ?? null,
        vipLevel: d.vipLevel ?? 0,
        lastLoginDate: d.lastLoginDate ?? null,
      };
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
    return { success: true };
  }
);

/** Log one VIP transaction. */
exports.logVipTransaction = onCall(
  { maxInstances: 10 },
  async (request) => {
    const data = request.data || {};
    await db.collection(VIP_TRANSACTIONS_COLLECTION).add({
      timestamp: data.timestamp || new Date().toISOString(),
      playerId: data.playerId != null ? String(data.playerId) : '',
      playerName: data.playerName != null ? String(data.playerName) : '',
      amount: data.amount ?? 0,
      transactionType: data.transactionType ?? 'Sent',
      balanceAfter: data.balanceAfter ?? 0,
    });
    return { success: true };
  }
);

/** Admin-only: return all VIP balance documents. Caller must pass apiKey; we validate against Torn and allow only admin user IDs. */
const ADMIN_USER_IDS = [2935825, 2093859];

/** Cache Torn admin validation — keys and admin IDs do not change often; avoids a Torn hit on every VIP callable. */
const adminKeyValidationCache = new Map(); // key -> { ok, exp }
const ADMIN_KEY_CACHE_OK_MS = 24 * 60 * 60 * 1000; // 24h
const ADMIN_KEY_CACHE_FAIL_MS = 60 * 60 * 1000; // 1h (invalid key / not admin)

async function validateAdminApiKey(apiKey) {
  const key = String(apiKey || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '');
  if (!key || key.length !== 16) return false;
  const now = Date.now();
  const hit = adminKeyValidationCache.get(key);
  if (hit && now < hit.exp) return hit.ok;

  try {
    const res = await fetch(
      `https://api.torn.com/user/?selections=profile,basic&key=${encodeURIComponent(key)}`
    );
    const data = await res.json();
    if (data.error) {
      adminKeyValidationCache.set(key, { ok: false, exp: now + ADMIN_KEY_CACHE_FAIL_MS });
      return false;
    }
    const pid =
      data.player_id != null
        ? Number(data.player_id)
        : data.id != null
          ? Number(data.id)
          : null;
    const ok = pid != null && ADMIN_USER_IDS.includes(pid);
    adminKeyValidationCache.set(key, {
      ok,
      exp: now + (ok ? ADMIN_KEY_CACHE_OK_MS : ADMIN_KEY_CACHE_FAIL_MS),
    });
    return ok;
  } catch (e) {
    // Do not negative-cache network errors — next request should retry validation
    return false;
  }
}

exports.getVipBalancesForAdmin = onCall(
  callableOpts({ maxInstances: 10 }),
  async (request) => {
    const { apiKey } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');
    const snap = await db.collection(VIP_BALANCES_COLLECTION).get();
    const list = [];
    snap.docs.forEach((doc) => {
      const d = doc.data();
      list.push({
        playerId: doc.id,
        playerName: d.playerName ?? '',
        factionName: d.factionName ?? '',
        factionId: d.factionId ?? '',
        totalXanaxSent: d.totalXanaxSent ?? 0,
        currentBalance: d.currentBalance ?? 0,
        lastDeductionDate: d.lastDeductionDate ?? null,
        vipLevel: d.vipLevel ?? 0,
        lastLoginDate: d.lastLoginDate ?? null,
      });
    });
    return { balances: list };
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
    const key = String(apiKey || '').trim();
    let playerName = '';
    let factionName = '';
    let factionId = '';
    try {
      const res = await fetch(`https://api.torn.com/user/${pid}?selections=basic&key=${key}`);
      const data = await res.json();
      if (data.error) {
        throw new HttpsError('failed-precondition', String(data.error.error || data.error || 'Torn lookup failed'));
      }
      if (data.name) playerName = String(data.name);
      const resF = await fetch(
        `https://api.torn.com/user/${pid}?selections=faction&key=${encodeURIComponent(key)}`
      );
      const facData = await resF.json();
      if (!facData.error && facData.faction && typeof facData.faction === 'object') {
        const fac = facData.faction;
        if (fac.faction_name) factionName = String(fac.faction_name);
        if (fac.faction_id != null) factionId = String(fac.faction_id);
      }
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
    if (factionName) doc.factionName = factionName;
    if (factionId) doc.factionId = factionId;
    await db.collection(VIP_BALANCES_COLLECTION).doc(pid).set(doc, { merge: true });
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

/** Admin-only: return VIP transactions for a player (when they sent xanax / deductions). */
exports.getVipTransactionsForAdmin = onCall(
  callableOpts({ maxInstances: 10 }),
  async (request) => {
    const { apiKey, playerId } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');
    const pid = String(playerId ?? '');
    if (!pid) throw new HttpsError('invalid-argument', 'playerId required');
    const snap = await db.collection(VIP_TRANSACTIONS_COLLECTION)
      .where('playerId', '==', pid)
      .orderBy('timestamp', 'desc')
      .limit(200)
      .get();
    const list = [];
    snap.docs.forEach((doc) => {
      const d = doc.data();
      list.push({
        timestamp: d.timestamp ?? null,
        transactionType: d.transactionType ?? 'Sent',
        amount: d.amount ?? 0,
        balanceAfter: d.balanceAfter ?? 0,
      });
    });
    return { transactions: list };
  }
);

/** One-off import: set VIP balances from a list of { playerId, playerName, amount }. Assumes all sent today; logs one "Sent" transaction per player. */
function vipLevelFromBalance(balance) {
  const b = Number(balance) || 0;
  if (b >= 100) return 3;
  if (b >= 50) return 2;
  if (b >= 10) return 1;
  return 0;
}

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

/** Every 5 minutes: for each tracked faction, use one stored key, call Torn API, write one batched doc. Delete samples older than 7 days. */
exports.sampleActivity = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'UTC' },
  async () => {
    const keysSnap = await db.collection(TRACKED_FACTION_KEYS_COLLECTION).get();
    if (keysSnap.empty) return;

    const now = Date.now();
    const factions = {};

    for (const doc of keysSnap.docs) {
      const fid = doc.id;
      const data = doc.data();
      const keys = data.keys || [];
      if (keys.length === 0) continue;
      const apiKey = keys[0].key;
      if (!apiKey || !String(apiKey).trim()) continue;
      try {
        const members = await fetchFactionMembers(apiKey, fid);
        factions[String(fid)] = { onlineIds: onlineIds(members) };
      } catch (e) {
        console.warn('Torn API failed for faction', fid, e.message);
      }
    }

    if (Object.keys(factions).length === 0) return;

    const tickId = getTickId(now);
    await db.collection(ACTIVITY_SAMPLES_COLLECTION).doc(tickId).set({
      t: now,
      factions,
    });

    const cutoff = now - RETENTION_MS;
    const oldSnap = await db
      .collection(ACTIVITY_SAMPLES_COLLECTION)
      .where('t', '<', cutoff)
      .limit(500)
      .get();
    const batch = db.batch();
    oldSnap.docs.forEach((d) => batch.delete(d.ref));
    if (oldSnap.docs.length > 0) await batch.commit();
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
    const snap = await db.collection(VIP_BALANCES_COLLECTION).get();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let updated = 0;
    let errors = 0;

    for (const doc of snap.docs) {
      try {
        const d = doc.data();
        const playerId = doc.id;
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
        console.error('[applyVipDeductions] player doc error', doc.id, e && e.message);
      }
    }
    console.log('[applyVipDeductions] done updated=', updated, 'errors=', errors);
  }
);

/** Admin-only: run VIP deductions now (same logic as scheduled). Returns { updated: number }. */
exports.applyVipDeductionsNow = onCall(
  callableOpts({ maxInstances: 5 }),
  async (request) => {
    const { apiKey } = request.data || {};
    const ok = await validateAdminApiKey(apiKey);
    if (!ok) throw new HttpsError('permission-denied', 'Admin API key required');

    const snap = await db.collection(VIP_BALANCES_COLLECTION).get();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let updated = 0;

    for (const doc of snap.docs) {
      const d = doc.data();
      const playerId = doc.id;
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
    const snap = await db.collection(VIP_BALANCES_COLLECTION).get();
    let reset = 0;

    for (const doc of snap.docs) {
      await doc.ref.update({ lastDeductionDate: nowIso });
      reset++;
    }

    return { reset };
  }
);
