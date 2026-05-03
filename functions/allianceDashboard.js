/**
 * Alliance Dashboard: Firestore-backed alliance roster + shared weapon vault.
 * - Alliance creator may add any faction ID (no consent from that faction), rename, remove factions, repair index.
 * - Other leaders/co-leaders may add their own faction only (verified on roster).
 * - allianceFactionMemberships: index so leaders can list alliances their faction was added to.
 * - Vault: any member of an allied faction may add/update rows.
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

const ALLIANCES = 'alliances';
const VAULT = 'vaultItems';
/** Cached Torn `faction?selections=territory` per roster faction (doc id = factionId). */
const FACTION_TERRITORY = 'factionTerritory';
/** One doc per (alliance, faction): doc id `${allianceId}_${factionId}` — used by allianceListMine. */
const ALLIANCE_FACTION_MEMBERSHIPS = 'allianceFactionMemberships';

function membershipDocId(allianceId, factionId) {
  return `${String(allianceId)}_${String(factionId)}`;
}

function getDb() {
  return admin.firestore();
}

function normalizeApiKey(apiKey) {
  return String(apiKey || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '');
}

async function fetchUserFromApiKey(apiKey) {
  const key = normalizeApiKey(apiKey);
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

/** Position / rank label for a member in v2 faction members list. */
function memberPositionLabel(m) {
  if (!m || typeof m !== 'object') return '';
  const raw =
    m.position ??
    m.rank_name ??
    m.rank_name_text ??
    (m.rank && typeof m.rank === 'object' ? m.rank.name : null) ??
    m.role ??
    '';
  return String(raw).trim();
}

async function fetchMemberPositionInFaction(apiKey, factionId, playerId) {
  const key = normalizeApiKey(apiKey);
  const fid = String(factionId || '').trim();
  const pid = String(playerId || '').trim();
  if (!fid || !pid) throw new HttpsError('invalid-argument', 'factionId and playerId required');
  const url = `https://api.torn.com/v2/faction/${encodeURIComponent(fid)}/members?striptags=true&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new HttpsError('invalid-argument', 'Torn API (members): ' + String(data.error));
  const members = data.members || [];
  const list = Array.isArray(members) ? members : Object.values(members);
  const m = list.find((x) => String(x.id) === pid);
  if (!m) throw new HttpsError('permission-denied', 'Your player is not listed in that faction’s members API response.');
  return memberPositionLabel(m);
}

function isLeaderOrCoLeader(positionLabel) {
  const p = String(positionLabel || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!p) return false;
  if (p === 'leader') return true;
  if (p === 'co-leader' || p === 'coleader' || p === 'co leader') return true;
  return false;
}

async function assertLeaderOrCoLeaderOfFaction(apiKey, factionId, playerId) {
  const pos = await fetchMemberPositionInFaction(apiKey, factionId, playerId);
  if (!isLeaderOrCoLeader(pos)) {
    throw new HttpsError(
      'permission-denied',
      `Only Leader or Co-leader can change the alliance roster (your position: "${pos || 'Unknown'}").`
    );
  }
  return pos;
}

async function fetchFactionDisplayName(apiKey, factionId) {
  const key = normalizeApiKey(apiKey);
  const fid = String(factionId || '').trim();
  if (!fid) return 'Faction';
  const url = `https://api.torn.com/v2/faction/${encodeURIComponent(fid)}?key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) return `Faction ${fid}`;
  const name = data.basic?.name || data.name || data.faction_name;
  return name ? String(name) : `Faction ${fid}`;
}

function factionsMapFromAlliance(data) {
  const f = data && data.factions;
  if (!f || typeof f !== 'object') return {};
  return f;
}

function assertFactionInAlliance(allianceData, factionId) {
  const map = factionsMapFromAlliance(allianceData);
  if (!map[String(factionId)]) {
    throw new HttpsError('permission-denied', 'Your faction is not part of this alliance.');
  }
}

function assertAllianceCreator(allianceData, playerId) {
  if (String(allianceData.createdByPlayerId || '') !== String(playerId || '')) {
    throw new HttpsError('permission-denied', 'Only the alliance creator can do this.');
  }
}

/** Creator, or Leader/Co-leader of a faction on this alliance roster, may set manual territory text. */
async function assertCanManualTerritory(allianceData, user, apiKey) {
  if (String((allianceData || {}).createdByPlayerId || '') === String(user.playerId || '')) return;
  if (!user.factionId) {
    throw new HttpsError('permission-denied', 'You must be in a faction to edit territory notes.');
  }
  assertFactionInAlliance(allianceData, user.factionId);
  await assertLeaderOrCoLeaderOfFaction(apiKey, user.factionId, user.playerId);
}

async function fetchTornTerritoryForKeyOwner(apiKey) {
  const key = normalizeApiKey(apiKey);
  const url = `https://api.torn.com/faction/?selections=territory&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new HttpsError('invalid-argument', 'Torn API (territory): ' + String(data.error));
  return data.territory != null ? data.territory : null;
}

function territoryToSummary(t) {
  if (t == null) return '';
  if (typeof t === 'string') return String(t).trim().slice(0, 8000);
  try {
    const s = JSON.stringify(t);
    return s.length > 8000 ? s.slice(0, 8000) + '…' : s;
  } catch (e) {
    return '';
  }
}

/** 2–4 letter territory codes for manual roster hints (cleared on API territory sync). */
function normalizeManualTileCodesList(input) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const c = String(x ?? '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
    if (c.length < 2 || c.length > 4) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= 40) break;
  }
  return out;
}

/** Create alliance and seed with creator’s faction (must be Leader or Co-leader). */
exports.allianceCreate = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { apiKey, allianceName } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  if (!user.factionId) throw new HttpsError('failed-precondition', 'You must be in a faction to create an alliance.');
  await assertLeaderOrCoLeaderOfFaction(apiKey, user.factionId, user.playerId);
  const name = String(allianceName || '').trim().slice(0, 80) || 'Alliance';
  const facName = await fetchFactionDisplayName(apiKey, user.factionId);
  const id = getDb().collection(ALLIANCES).doc().id;
  const now = Date.now();
  const batch = getDb().batch();
  const allRef = getDb().collection(ALLIANCES).doc(id);
  batch.set(allRef, {
    name,
    createdAt: now,
    createdByPlayerId: user.playerId,
    factions: {
      [user.factionId]: {
        name: facName,
        addedAt: now,
        addedByPlayerId: user.playerId,
      },
    },
  });
  const memRef = getDb().collection(ALLIANCE_FACTION_MEMBERSHIPS).doc(membershipDocId(id, user.factionId));
  batch.set(memRef, {
    allianceId: id,
    factionId: user.factionId,
    factionName: facName,
    addedAt: now,
    addedByPlayerId: user.playerId,
  });
  await batch.commit();
  return { allianceId: id, name };
});

/**
 * Add a faction to an alliance:
 * - If caller is the alliance creator: may add any faction ID (no membership in that faction required).
 * - Else: caller must be Leader/Co-leader of the faction being added and that faction must match their API key faction.
 */
exports.allianceAddFaction = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { apiKey, allianceId, factionIdToAdd } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  const aid = String(allianceId || '').trim();
  const fid = String(factionIdToAdd || '').trim();
  if (!aid || !fid) throw new HttpsError('invalid-argument', 'allianceId and factionIdToAdd are required.');
  const ref = getDb().collection(ALLIANCES).doc(aid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Alliance not found.');
  const allianceData = snap.data();
  const existing = factionsMapFromAlliance(allianceData);
  if (existing[fid]) {
    return { ok: true, factionId: fid, name: existing[fid].name || `Faction ${fid}`, alreadyMember: true };
  }

  const isCreator = String(user.playerId) === String(allianceData.createdByPlayerId || '');
  if (isCreator) {
    // Creator roster build: no permission from the added faction required.
  } else {
    if (user.factionId !== fid) {
      throw new HttpsError(
        'permission-denied',
        'Only the alliance creator can add arbitrary factions. To add your own faction, use an API key for an account in that faction with Leader or Co-leader rank.'
      );
    }
    await assertLeaderOrCoLeaderOfFaction(apiKey, fid, user.playerId);
  }

  const facName = await fetchFactionDisplayName(apiKey, fid);
  const now = Date.now();
  const batch = getDb().batch();
  batch.set(
    ref,
    {
      factions: {
        [fid]: {
          name: facName,
          addedAt: now,
          addedByPlayerId: user.playerId,
        },
      },
    },
    { merge: true }
  );
  const memRef = getDb().collection(ALLIANCE_FACTION_MEMBERSHIPS).doc(membershipDocId(aid, fid));
  batch.set(
    memRef,
    {
      allianceId: aid,
      factionId: fid,
      factionName: facName,
      addedAt: now,
      addedByPlayerId: user.playerId,
    },
    { merge: true }
  );
  await batch.commit();
  return { ok: true, factionId: fid, name: facName };
});

/** Update alliance display name (creator only). */
exports.allianceRename = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { apiKey, allianceId, newName } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  const aid = String(allianceId || '').trim();
  const name = String(newName || '').trim().slice(0, 80);
  if (!aid) throw new HttpsError('invalid-argument', 'allianceId required');
  if (!name) throw new HttpsError('invalid-argument', 'Display name is required.');
  const ref = getDb().collection(ALLIANCES).doc(aid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Alliance not found.');
  assertAllianceCreator(snap.data(), user.playerId);
  await ref.update({ name });
  return { ok: true, name };
});

/**
 * Remove a faction from the roster (creator only). Keeps at least one faction.
 * Deletes vault rows held by the removed faction and the membership index doc.
 */
exports.allianceRemoveFaction = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const { apiKey, allianceId, factionIdToRemove } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  const aid = String(allianceId || '').trim();
  const fid = String(factionIdToRemove || '').trim();
  if (!aid || !fid) throw new HttpsError('invalid-argument', 'allianceId and factionIdToRemove are required.');
  const ref = getDb().collection(ALLIANCES).doc(aid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Alliance not found.');
  const d = snap.data();
  assertAllianceCreator(d, user.playerId);
  const fmap = factionsMapFromAlliance(d);
  if (!fmap[fid]) throw new HttpsError('not-found', 'That faction is not in this alliance.');
  const fids = Object.keys(fmap);
  if (fids.length <= 1) {
    throw new HttpsError('failed-precondition', 'Cannot remove the last faction from an alliance.');
  }

  const batch = getDb().batch();
  batch.update(ref, { [`factions.${fid}`]: admin.firestore.FieldValue.delete() });
  batch.delete(getDb().collection(ALLIANCE_FACTION_MEMBERSHIPS).doc(membershipDocId(aid, fid)));
  batch.delete(ref.collection(FACTION_TERRITORY).doc(fid));
  await batch.commit();

  const vaultSnap = await ref.collection(VAULT).where('holderFactionId', '==', fid).get();
  let vbatch = getDb().batch();
  let vcount = 0;
  for (const doc of vaultSnap.docs) {
    vbatch.delete(doc.ref);
    vcount++;
    if (vcount >= 450) {
      await vbatch.commit();
      vbatch = getDb().batch();
      vcount = 0;
    }
  }
  if (vcount > 0) await vbatch.commit();
  return { ok: true, removedFactionId: fid };
});

/** List alliances this player’s faction appears in (Leader / Co-leader only). */
exports.allianceListMine = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  if (!user.factionId) throw new HttpsError('failed-precondition', 'You must be in a faction.');
  await assertLeaderOrCoLeaderOfFaction(apiKey, user.factionId, user.playerId);

  const byId = new Map();

  const q = await getDb().collection(ALLIANCE_FACTION_MEMBERSHIPS).where('factionId', '==', user.factionId).get();
  for (const doc of q.docs) {
    const row = doc.data() || {};
    const allianceId = String(row.allianceId || '').trim();
    if (!allianceId) continue;
    const aSnap = await getDb().collection(ALLIANCES).doc(allianceId).get();
    if (!aSnap.exists) continue;
    const ad = aSnap.data();
    const fmap = factionsMapFromAlliance(ad);
    if (!fmap[user.factionId]) continue;
    byId.set(allianceId, {
      allianceId,
      name: ad.name || 'Alliance',
      factionCount: Object.keys(fmap).length,
      myFactionId: user.factionId,
      addedAt: row.addedAt != null ? Number(row.addedAt) : null,
    });
  }

  // Alliances created before the membership index: creator’s roster still has their faction but no index row.
  const createdSnap = await getDb()
    .collection(ALLIANCES)
    .where('createdByPlayerId', '==', user.playerId)
    .limit(100)
    .get();
  for (const aDoc of createdSnap.docs) {
    const allianceId = aDoc.id;
    if (byId.has(allianceId)) continue;
    const ad = aDoc.data() || {};
    const fmap = factionsMapFromAlliance(ad);
    if (!fmap[user.factionId]) continue;
    const meta = fmap[user.factionId] || {};
    const addedAtVal =
      meta.addedAt != null
        ? Number(meta.addedAt)
        : ad.createdAt != null
          ? Number(ad.createdAt)
          : Date.now();
    const memRef = getDb().collection(ALLIANCE_FACTION_MEMBERSHIPS).doc(membershipDocId(allianceId, user.factionId));
    await memRef.set(
      {
        allianceId,
        factionId: user.factionId,
        factionName: String(meta.name || `Faction ${user.factionId}`).slice(0, 120),
        addedAt: addedAtVal,
        addedByPlayerId: String(meta.addedByPlayerId || ad.createdByPlayerId || user.playerId),
      },
      { merge: true }
    );
    byId.set(allianceId, {
      allianceId,
      name: ad.name || 'Alliance',
      factionCount: Object.keys(fmap).length,
      myFactionId: user.factionId,
      addedAt: addedAtVal,
    });
  }

  const out = [...byId.values()].sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
  return { playerId: user.playerId, alliances: out };
});

/** Rebuild membership index docs from alliance.factions (creator only; fixes alliances created before indexing). */
exports.allianceBackfillMembershipIndex = onCall(callableOpts({ maxInstances: 5 }), async (request) => {
  const { apiKey, allianceId } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  const aid = String(allianceId || '').trim();
  if (!aid) throw new HttpsError('invalid-argument', 'allianceId required');
  const ref = getDb().collection(ALLIANCES).doc(aid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Alliance not found.');
  const d = snap.data();
  assertAllianceCreator(d, user.playerId);
  const factions = factionsMapFromAlliance(d);
  const fids = Object.keys(factions);
  const maxOps = 450;
  let batch = getDb().batch();
  let ops = 0;
  for (const fid of fids) {
    const meta = factions[fid] || {};
    const docRef = getDb().collection(ALLIANCE_FACTION_MEMBERSHIPS).doc(membershipDocId(aid, fid));
    batch.set(
      docRef,
      {
        allianceId: aid,
        factionId: String(fid),
        factionName: String(meta.name || `Faction ${fid}`).slice(0, 120),
        addedAt: meta.addedAt != null ? Number(meta.addedAt) : Date.now(),
        addedByPlayerId: String(meta.addedByPlayerId || user.playerId),
      },
      { merge: true }
    );
    ops++;
    if (ops >= maxOps) {
      await batch.commit();
      batch = getDb().batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { ok: true, count: fids.length };
});

/** Upsert a vault row (any member of an allied faction). */
exports.allianceVaultUpsert = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, allianceId, itemId, label, location, notes, holderFactionId } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  const aid = String(allianceId || '').trim();
  if (!aid) throw new HttpsError('invalid-argument', 'allianceId required');
  if (!user.factionId) throw new HttpsError('failed-precondition', 'You must be in a faction.');
  const ref = getDb().collection(ALLIANCES).doc(aid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Alliance not found.');
  assertFactionInAlliance(snap.data(), user.factionId);
  const labelClean = String(label || '').trim().slice(0, 120);
  const locClean = String(location || '').trim().slice(0, 200);
  if (!labelClean) throw new HttpsError('invalid-argument', 'Weapon / item label is required.');
  const notesClean = String(notes || '').trim().slice(0, 500);
  const holder = holderFactionId != null && String(holderFactionId).trim() !== '' ? String(holderFactionId).trim() : user.factionId;
  assertFactionInAlliance(snap.data(), holder);
  const now = Date.now();
  const vaultCol = ref.collection(VAULT);
  const docRef = itemId ? vaultCol.doc(String(itemId)) : vaultCol.doc();
  const payload = {
    label: labelClean,
    location: locClean,
    notes: notesClean,
    holderFactionId: holder,
    updatedAt: now,
    updatedByPlayerId: user.playerId,
    updatedByPlayerName: user.name,
  };
  await docRef.set(payload, { merge: true });
  return { ok: true, itemId: docRef.id };
});

/** Remove a vault row (any member of an allied faction). */
exports.allianceVaultDelete = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, allianceId, itemId } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  const aid = String(allianceId || '').trim();
  const iid = String(itemId || '').trim();
  if (!aid || !iid) throw new HttpsError('invalid-argument', 'allianceId and itemId required');
  if (!user.factionId) throw new HttpsError('failed-precondition', 'You must be in a faction.');
  const ref = getDb().collection(ALLIANCES).doc(aid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Alliance not found.');
  assertFactionInAlliance(snap.data(), user.factionId);
  await ref.collection(VAULT).doc(iid).delete();
  return { ok: true };
});

/**
 * Pull Torn `faction?selections=territory` for the API key owner’s faction and store under this alliance.
 * Only that faction’s roster row is updated. Always sets source=api (overrides manual).
 */
exports.allianceTerritorySyncFromApi = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, allianceId } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  const aid = String(allianceId || '').trim();
  if (!aid) throw new HttpsError('invalid-argument', 'allianceId required');
  if (!user.factionId) {
    throw new HttpsError('failed-precondition', 'Your API key must belong to a player in a faction to sync territory.');
  }
  const ref = getDb().collection(ALLIANCES).doc(aid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Alliance not found.');
  const d = snap.data();
  assertFactionInAlliance(d, user.factionId);

  const terr = await fetchTornTerritoryForKeyOwner(apiKey);
  const summary = territoryToSummary(terr) || '(No territory payload from Torn)';
  const terrRef = ref.collection(FACTION_TERRITORY).doc(String(user.factionId));
  const baseRow = {
    source: 'api',
    summary,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastApiSyncPlayerId: user.playerId,
    manualEditorPlayerId: admin.firestore.FieldValue.delete(),
    manualTileCodes: admin.firestore.FieldValue.delete(),
  };
  try {
    await terrRef.set({ ...baseRow, payload: terr == null ? null : terr }, { merge: true });
  } catch (e) {
    await terrRef.set(baseRow, { merge: true });
  }
  return { ok: true, factionId: user.factionId };
});

/**
 * Manual territory note for any roster faction. Creator or Leader/Co-leader of a roster faction may edit.
 * Overwritten when that faction’s leader later runs allianceTerritorySyncFromApi.
 */
exports.allianceTerritorySetManual = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, allianceId, factionId, summary } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  const aid = String(allianceId || '').trim();
  const fid = String(factionId || '').trim();
  const text = String(summary || '').trim().slice(0, 8000);
  if (!aid || !fid) throw new HttpsError('invalid-argument', 'allianceId and factionId are required.');
  if (!text) throw new HttpsError('invalid-argument', 'Territory text is required.');
  const ref = getDb().collection(ALLIANCES).doc(aid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Alliance not found.');
  const d = snap.data();
  const fmap = factionsMapFromAlliance(d);
  if (!fmap[fid]) throw new HttpsError('not-found', 'That faction is not on this alliance roster.');
  await assertCanManualTerritory(d, user, apiKey);

  await ref.collection(FACTION_TERRITORY).doc(fid).set({
    source: 'manual',
    summary: text,
    payload: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    manualEditorPlayerId: user.playerId,
    lastApiSyncPlayerId: admin.firestore.FieldValue.delete(),
  });
  return { ok: true, factionId: fid };
});

/**
 * Manual territory tile codes (2–4 letters) for a roster faction; merged on intel cards with Torn payload.
 * Cleared when that faction runs allianceTerritorySyncFromApi.
 * Same permission as allianceTerritorySetManual.
 */
exports.allianceTerritorySetManualTileCodes = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const { apiKey, allianceId, factionId, tileCodes } = request.data || {};
  const user = await fetchUserFromApiKey(apiKey);
  const aid = String(allianceId || '').trim();
  const fid = String(factionId || '').trim();
  if (!aid || !fid) throw new HttpsError('invalid-argument', 'allianceId and factionId are required.');
  const ref = getDb().collection(ALLIANCES).doc(aid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Alliance not found.');
  const d = snap.data();
  const fmap = factionsMapFromAlliance(d);
  if (!fmap[fid]) throw new HttpsError('not-found', 'That faction is not on this alliance roster.');
  await assertCanManualTerritory(d, user, apiKey);

  const normalized = normalizeManualTileCodesList(tileCodes);
  const terrRef = ref.collection(FACTION_TERRITORY).doc(fid);
  if (normalized.length === 0) {
    await terrRef.set(
      {
        manualTileCodes: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await terrRef.set(
      {
        manualTileCodes: normalized,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
  return { ok: true, factionId: fid, manualTileCodes: normalized };
});
