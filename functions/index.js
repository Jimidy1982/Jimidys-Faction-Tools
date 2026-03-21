/**
 * Activity tracker backend:
 * - Callable: addTrackedFaction(factionId, apiKey, userId) / removeTrackedFaction(factionId, userId)
 * - Scheduled: every 5 min, read trackedFactionKeys (one key per faction), call Torn API, write activitySamples. 7-day retention.
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const ACTIVITY_SAMPLES_COLLECTION = 'activitySamples';
const TRACKED_FACTIONS_COLLECTION = 'trackedFactions';
const TRACKED_FACTION_KEYS_COLLECTION = 'trackedFactionKeys';
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

function onlineIds(members) {
  return members
    .filter((m) => {
      const la = m.last_action ?? {};
      const action = (la.status ?? 'Offline').toString().toLowerCase();
      return action === 'online' || action === 'idle';
    })
    .map((m) => String(m.id));
}

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/** Add a faction to track using the caller's API key. Keys stored per-faction (multiple users can add same faction with their own keys). */
exports.addTrackedFaction = onCall(
  { maxInstances: 10 },
  async (request) => {
    const { factionId, apiKey, userId } = request.data || {};
    const fid = String(factionId || '').trim();
    const key = String(apiKey || '').trim();
    const uid = String(userId || '').trim();
    if (!fid || !key || !uid) {
      throw new HttpsError('invalid-argument', 'factionId, apiKey, and userId are required');
    }
    const ref = db.collection(TRACKED_FACTION_KEYS_COLLECTION).doc(fid);
    const snap = await ref.get();
    const keys = (snap.exists && snap.data().keys) || [];
    const next = keys.filter((e) => e.userId !== uid);
    next.push({ key: key, userId: uid });
    await ref.set({ keys: next });
    await db.collection(TRACKED_FACTIONS_COLLECTION).doc(fid).set({ addedAt: Date.now() }, { merge: true });
    return { ok: true };
  }
);

/** Remove this user's key for the faction. If no keys left, faction is no longer tracked. */
exports.removeTrackedFaction = onCall(
  { maxInstances: 10 },
  async (request) => {
    const { factionId, userId } = request.data || {};
    const fid = String(factionId || '').trim();
    const uid = String(userId || '').trim();
    if (!fid || !uid) {
      throw new HttpsError('invalid-argument', 'factionId and userId are required');
    }
    const ref = db.collection(TRACKED_FACTION_KEYS_COLLECTION).doc(fid);
    const snap = await ref.get();
    if (!snap.exists) return { ok: true };
    const keys = (snap.data().keys || []).filter((e) => e.userId !== uid);
    if (keys.length === 0) {
      await ref.delete();
      await db.collection(TRACKED_FACTIONS_COLLECTION).doc(fid).delete();
    } else {
      await ref.set({ keys });
    }
    return { ok: true };
  }
);

// --- VIP service (migrated from Apps Script) ---
const VIP_BALANCES_COLLECTION = 'vipBalances';
const VIP_TRANSACTIONS_COLLECTION = 'vipTransactions';

/** Get VIP balance by playerId or playerName. Returns same shape as Apps Script (playerId, playerName, totalXanaxSent, currentBalance, lastDeductionDate, vipLevel, lastLoginDate) or null. */
exports.getVipBalance = onCall(
  { maxInstances: 10 },
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
  { maxInstances: 10 },
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
  { maxInstances: 10 },
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
  { maxInstances: 5 },
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
  { maxInstances: 10 },
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
  { maxInstances: 1 },
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
  { maxInstances: 5 },
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
  { maxInstances: 1 },
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
