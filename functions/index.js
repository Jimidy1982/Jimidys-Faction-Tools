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
    };
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
    const poolSnap = await db.collection(VIP_BALANCES_COLLECTION).where('factionId', '==', fid).get();
    factionMemberCount = poolSnap.size;
    let sum = 0;
    poolSnap.forEach((doc) => {
      sum += Number(doc.data().currentBalance) || 0;
    });
    if (factionMemberCount >= 1) {
      factionCombinedBalance = sum;
      effectiveLevel = vipLevelFromBalance(sum);
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
      if (apiKeyClean.length === 16) {
        const keyOk = await verifyTornApiKeyMatchesPlayerId(apiKeyClean, pid);
        if (keyOk) {
          tornProf = await fetchTornPlayerProfileForVipPoolSafe(apiKeyClean, pid);
        }
      }
      const tornFid = tornProf && tornProf.factionId ? String(tornProf.factionId).trim() : '';

      if (!docSnap.exists) {
        if (!tornFid) return null;
        const poolSnap = await db.collection(VIP_BALANCES_COLLECTION).where('factionId', '==', tornFid).get();
        if (poolSnap.empty) return null;
        let sum = 0;
        poolSnap.forEach((doc) => {
          sum += Number(doc.data().currentBalance) || 0;
        });
        const effectiveLevel = vipLevelFromBalance(sum);
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
          factionCombinedBalance: sum,
          factionMemberCount: poolSnap.size,
        };
        if (tornProf && tornProf.factionName) out.factionName = tornProf.factionName;
        return out;
      }

      const d = docSnap.data();
      const docFid = d.factionId != null ? String(d.factionId).trim() : '';
      const poolQueryFactionId = tornFid || docFid;
      const merged = { ...d, playerId: pid };
      if (tornProf) {
        if (tornProf.playerName) merged.playerName = tornProf.playerName;
        if (tornProf.factionName) merged.factionName = tornProf.factionName;
        if (tornFid) merged.factionId = tornFid;
      }
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

    const snap = await db.collection(VIP_BALANCES_COLLECTION).get();
    const failed = [];
    let updated = 0;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    let n = 0;
    for (const doc of snap.docs) {
      const pid = doc.id;
      if (n++ > 0) await delay(150);
      try {
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
        await doc.ref.set(patch, { merge: true });
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
        total: snap.size,
        updated,
        failedCount: failed.length,
      },
      { merge: true }
    );

    return {
      success: true,
      total: snap.size,
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

    await db
      .collection(VIP_INCOMING_XANAX_LOG_COLLECTION)
      .doc(tornEventId)
      .set(
        {
          tornEventId,
          tornEventTimestamp: ts,
          recipientPlayerId: recipientPid,
          senderPlayerId: senderPid,
          senderName: parsed.playerName,
          amount: parsed.amount,
          rawEventSnippet: html.length > 500 ? html.slice(0, 500) : html,
          seenAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

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

/** Faction chain watch list (VIP editors + member signups) — see functions/chainWatch.js */
const chainWatch = require('./chainWatch');
exports.chainWatchGet = chainWatch.chainWatchGet;
exports.chainWatchSaveConfig = chainWatch.chainWatchSaveConfig;
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
