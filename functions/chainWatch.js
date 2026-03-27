/**
 * Faction chain watch list: VIP 2 editors configure; all faction members read/sign up/remove self.
 * All access via callables; Firestore path: factionChainWatch/{factionId}
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

const COLLECTION = 'factionChainWatch';
const VIP_EDIT_LEVEL = 2;
const MAX_HOUR_SLOTS = 50 * 24; // 50 days hourly

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

const VIP_BALANCES_COLLECTION = 'vipBalances';

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
  // Match war-dashboard getUserProfile: Torn may return faction at top level or under data.faction
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

async function getVipLevel(playerId) {
  const doc = await getDb().collection(VIP_BALANCES_COLLECTION).doc(String(playerId)).get();
  if (!doc.exists) return 0;
  const v = doc.data().vipLevel;
  return typeof v === 'number' ? v : 0;
}

function assertSameFaction(userFactionId, docFactionId) {
  if (!userFactionId || String(userFactionId) !== String(docFactionId)) {
    throw new HttpsError('permission-denied', 'You must be in this faction');
  }
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

function countSignupsLast24h(slots, playerId, nowMs) {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  let n = 0;
  Object.values(slots).forEach((arr) => {
    (arr || []).forEach((w) => {
      if (String(w.playerId) === String(playerId) && (w.at || 0) > cutoff) n++;
    });
  });
  return n;
}

/** Public read for faction members */
exports.chainWatchGet = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, factionId } = request.data || {};
  const fid = String(factionId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const vipLevel = await getVipLevel(user.playerId);
  const canEdit = vipLevel >= VIP_EDIT_LEVEL;

  const ref = getDb().collection(COLLECTION).doc(fid);
  const snap = await ref.get();
  if (!snap.exists) {
    return {
      exists: false,
      settings: defaultSettings(),
      slots: defaultSlotsObject(),
      chainState: { lastCurrent: 0, brokeAtHit: null, brokeAtUnix: null },
      viewer: {
        playerId: user.playerId,
        name: user.name,
        vipLevel,
        canEdit,
      },
      chainTargets: CHAIN_TARGETS,
      maxHourSlots: MAX_HOUR_SLOTS,
    };
  }

  const norm = normalizeDoc(snap.data());
  return {
    exists: true,
    updatedAt: snap.data().updatedAt?.toMillis?.() || null,
    settings: norm.settings,
    slots: norm.slots,
    chainState: norm.chainState,
    viewer: {
      playerId: user.playerId,
      name: user.name,
      vipLevel,
      canEdit,
    },
    chainTargets: CHAIN_TARGETS,
    maxHourSlots: MAX_HOUR_SLOTS,
  };
});

exports.chainWatchSaveConfig = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { apiKey, factionId, settings: incoming } = request.data || {};
  const fid = String(factionId || '').trim();
  if (!fid) throw new HttpsError('invalid-argument', 'factionId required');
  if (!incoming || typeof incoming !== 'object') throw new HttpsError('invalid-argument', 'settings required');

  const user = await fetchUserFromApiKey(apiKey);
  assertSameFaction(user.factionId, fid);

  const vipLevel = await getVipLevel(user.playerId);
  if (vipLevel < VIP_EDIT_LEVEL) {
    throw new HttpsError('permission-denied', 'VIP 2+ required to edit chain watch settings');
  }

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

  const ref = getDb().collection(COLLECTION).doc(fid);
  const snap = await ref.get();
  const clearSlots = !!incoming.clearAllSignups;

  const removeColRaw = incoming.removeWatcherColumn0;
  const removeCol =
    removeColRaw != null && removeColRaw !== ''
      ? Math.floor(Number(removeColRaw))
      : null;

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
        chainStartUnix,
        chainTarget,
        backupColumns,
        rewardType,
        rewardFirst,
        rewardSubsequent,
        maxSignupsPer24h,
        visibleTctDays: vdNew,
      },
      slots: clearSlots ? defaultSlotsObject() : defaultSlotsObject(),
      chainState: { lastCurrent: 0, brokeAtHit: null, brokeAtUnix: null },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true };
  }

  const prev = snap.data();
  const prevStart = prev.settings?.chainStartUnix;
  const bcPrev = Math.min(3, Math.max(1, Math.floor(Number(prev.settings?.backupColumns) || 1)));

  if (visibleTctDays === undefined || !Number.isFinite(visibleTctDays)) {
    const prevV = prev.settings?.visibleTctDays;
    visibleTctDays = prevV != null && prevV !== '' ? Math.floor(Number(prevV)) : 1;
  }
  if (prevStart !== chainStartUnix) {
    visibleTctDays = 1;
  }
  const maxVd = maxVisibleTctDaysForStart(chainStartUnix);
  visibleTctDays = Math.min(maxVd, Math.max(1, visibleTctDays));

  const settings = {
    chainStartUnix,
    chainTarget,
    backupColumns,
    rewardType,
    rewardFirst,
    rewardSubsequent,
    maxSignupsPer24h,
    visibleTctDays,
  };

  // Keep existing signups when only increasing parallel columns (same start + target).
  const mergeSlots =
    !clearSlots &&
    prevStart === settings.chainStartUnix &&
    Number(prev.settings?.chainTarget) === settings.chainTarget &&
    backupColumns >= bcPrev;

  await ref.set(
    {
      settings,
      ...(mergeSlots ? {} : { slots: defaultSlotsObject() }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { success: true };
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
    const base = normalizeDoc(snap.data());
    const settings = base.settings;
    if (settings.chainStartUnix == null) {
      throw new HttpsError('failed-precondition', 'Chain start not configured yet');
    }

    const maxPer = settings.maxSignupsPer24h || 10;
    const nowMs = Date.now();
    if (countSignupsLast24h(base.slots, user.playerId, nowMs) >= maxPer) {
      throw new HttpsError('failed-precondition', '24h signup limit reached');
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
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: false }
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
