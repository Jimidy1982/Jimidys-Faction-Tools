/**
 * Racing Tournaments.
 * - Creating a league requires VIP 3 (personal balance, or the faction pool, same as the app).
 * - Anyone with the share link can view. Joining does not require VIP.
 * - gate: "faction" (owner's faction only), "invite" (staff add drivers), "open" (anyone with the link).
 * - joinLocked blocks new drivers. Staff can still remove people.
 * - Owner and admins schedule rounds and submit Torn race results.
 * - One round per season can be the open Torn race. Other rounds stay TBC until that race is done.
 * - Everyone in a submitted race scores. Joined players are marked on the client from `roster`.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { DEFAULT_POINTS, computeStandings } = require('./racingStandings');

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

const LEAGUES = 'racingLeagues';
const ROLES = 'racingLeagueRoles';
const DRIVER_NAMES = 'racingDriverNames';
const VIP_BALANCES = 'vipBalances';
const VIP_POOLS = 'vipFactionPools';

function getDb() {
  return admin.firestore();
}

function normalizeApiKey(apiKey) {
  return String(apiKey || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '');
}

function tornErrorMessage(data) {
  if (!data || data.error == null || data.error === false) return '';
  const e = data.error;
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return String(e.error || e.message || 'Torn API error');
  return String(e);
}

async function tornGet(path, apiKey) {
  const key = normalizeApiKey(apiKey);
  const join = path.includes('?') ? '&' : '?';
  const url =
    'https://api.torn.com' +
    path +
    join +
    'comment=JimidysFactionTools&key=' +
    encodeURIComponent(key);
  const res = await fetch(url);
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    throw new HttpsError('internal', 'Torn API returned an unreadable response.');
  }
  const msg = tornErrorMessage(data);
  if (msg) throw new HttpsError('failed-precondition', 'Torn API: ' + msg);
  return data;
}

async function fetchUserFromApiKey(apiKey) {
  const key = normalizeApiKey(apiKey);
  if (key.length !== 16) throw new HttpsError('invalid-argument', 'Add your 16-character Torn API key in the sidebar.');
  const data = await tornGet('/user/?selections=profile', key);
  const playerId = data.player_id != null ? String(data.player_id) : '';
  if (!playerId) throw new HttpsError('internal', 'Torn did not return a player id for that key.');
  const name = String(data.name || data.player_name || 'Player').trim() || 'Player';
  const fac = data.faction && typeof data.faction === 'object' ? data.faction : null;
  const rawFactionId =
    data.faction_id != null
      ? data.faction_id
      : fac && fac.faction_id != null
        ? fac.faction_id
        : null;
  const factionId = rawFactionId != null && String(rawFactionId).trim() !== '' ? String(rawFactionId).trim() : '';
  const factionName =
    fac && fac.faction_name != null && String(fac.faction_name).trim() !== ''
      ? String(fac.faction_name).trim()
      : '';
  return { playerId, name, factionId, factionName, apiKey: key };
}

function vipLevelFromBalance(balance) {
  const b = Number(balance) || 0;
  if (b >= 100) return 3;
  if (b >= 50) return 2;
  if (b >= 10) return 1;
  return 0;
}

async function effectiveVipLevel(user) {
  const snap = await getDb().collection(VIP_BALANCES).doc(user.playerId).get();
  const data = snap.exists ? snap.data() || {} : {};
  const personal = Number(data.currentBalance) || 0;
  let level = vipLevelFromBalance(personal);
  const fid = String(user.factionId || data.factionId || '').trim();
  if (fid) {
    const pool = await getDb().collection(VIP_POOLS).doc(fid).get();
    if (pool.exists) {
      const p = pool.data() || {};
      if ((Number(p.memberCount) || 0) >= 1) {
        level = vipLevelFromBalance(Number(p.combinedBalance) || 0);
      }
    }
  }
  return level;
}

async function assertVip3(user) {
  const level = await effectiveVipLevel(user);
  if (level < 3) {
    throw new HttpsError(
      'permission-denied',
      'Creating a league requires VIP 3. Anyone you invite can still join without VIP.'
    );
  }
  return level;
}

function roleDocId(leagueId, playerId) {
  return String(leagueId) + '_' + String(playerId);
}

function decodeTornText(value) {
  let text = String(value || '');
  for (let pass = 0; pass < 2; pass += 1) {
    const next = text
      .replace(/&#0*39;/g, "'")
      .replace(/&#x0*27;/gi, "'")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (next === text) break;
    text = next;
  }
  return text;
}

function cleanText(value, max) {
  return decodeTornText(value)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function normalizePoints(input) {
  const src = Array.isArray(input) && input.length ? input : DEFAULT_POINTS;
  const out = [];
  for (const n of src) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 0 || v > 500) {
      throw new HttpsError('invalid-argument', 'Each points value must be a whole number from 0 to 500.');
    }
    out.push(v);
    if (out.length >= 30) break;
  }
  if (!out.length) throw new HttpsError('invalid-argument', 'Add at least one scoring position.');
  return out;
}

function normalizePrizes(input) {
  const src = input && typeof input === 'object' ? input : {};
  let list = [];
  if (Array.isArray(src.places)) {
    list = src.places.map((item) => cleanText(item, 140)).slice(0, 20);
    while (list.length > 1 && !list[list.length - 1]) list.pop();
    if (list.length === 1 && !list[0]) list = [];
  } else {
    list = [src.first, src.second, src.third].map((item) => cleanText(item, 140));
    while (list.length && !list[list.length - 1]) list.pop();
  }
  return {
    places: list,
    first: list[0] || '',
    second: list[1] || '',
    third: list[2] || '',
  };
}

function normalizeDate(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new HttpsError('invalid-argument', 'Pick a race date.');
  }
  const parsed = new Date(s + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) throw new HttpsError('invalid-argument', 'That race date is not valid.');
  return s;
}

function normalizeTime(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new HttpsError('invalid-argument', 'Pick a start time.');
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new HttpsError('invalid-argument', 'Use a start time like 20:00.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new HttpsError('invalid-argument', 'That start time is not valid.');
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

function assertRaceId(raceId) {
  const s = String(raceId || '').trim();
  if (!/^\d{1,12}$/.test(s)) throw new HttpsError('invalid-argument', 'Enter a numeric Torn race ID.');
  return s;
}

async function loadLeague(leagueId) {
  const id = String(leagueId || '').trim();
  if (!id || id.length > 80) throw new HttpsError('invalid-argument', 'Missing league.');
  const ref = getDb().collection(LEAGUES).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That league does not exist.');
  return { id, ref, data: snap.data() || {} };
}

function rosterOf(data) {
  const roster = data && data.roster;
  return roster && typeof roster === 'object' ? { ...roster } : {};
}

function assertOwner(league, user) {
  if (String(league.ownerId || '') !== String(user.playerId)) {
    throw new HttpsError('permission-denied', 'Only the league owner can do that.');
  }
}

function assertStaff(league, user) {
  if (String(league.ownerId || '') === String(user.playerId)) return;
  const entry = rosterOf(league)[String(user.playerId)];
  if (!entry || entry.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only the owner or a league admin can do that.');
  }
}

function gateOf(league) {
  const gate = league && league.gate;
  if (gate === 'faction' || gate === 'invite' || gate === 'open') return gate;
  return 'open';
}

function normalizeGate(value) {
  const gate = String(value || '').trim().toLowerCase();
  if (gate === 'faction' || gate === 'invite' || gate === 'open') return gate;
  throw new HttpsError('invalid-argument', 'Pick who can join: own faction, invitation only, or open event.');
}

function assertFactionGateReady(user) {
  if (!user.factionId) {
    throw new HttpsError('failed-precondition', 'Own faction needs you to be in a Torn faction.');
  }
}

async function lookupPlayer(apiKey, playerId) {
  const id = String(playerId || '').trim();
  if (!/^\d{1,10}$/.test(id)) throw new HttpsError('invalid-argument', 'Enter a Torn player ID.');
  let data;
  try {
    data = await tornGet('/user/' + encodeURIComponent(id) + '?selections=profile', apiKey);
  } catch (e) {
    throw new HttpsError('not-found', 'Torn could not find that player ID.');
  }
  const name = cleanText(data.name || data.player_name || '', 40) || 'Player ' + id;
  const fac = data.faction && typeof data.faction === 'object' ? data.faction : null;
  const rawFactionId =
    data.faction_id != null ? data.faction_id : fac && fac.faction_id != null ? fac.faction_id : null;
  const factionId = rawFactionId != null && String(rawFactionId).trim() !== '' ? String(rawFactionId).trim() : '';
  return { playerId: id, name, factionId };
}

function assertNewDriverAllowed(league, player, staffAdd) {
  if (league.joinLocked === true) {
    throw new HttpsError('permission-denied', 'Joining is locked. Unlock the league before adding a driver.');
  }
  const gate = gateOf(league);
  if (gate === 'invite' && !staffAdd) {
    throw new HttpsError('permission-denied', 'This league is invitation only. An owner or admin has to add you.');
  }
  if (gate === 'faction') {
    const ownerFactionId = String(league.ownerFactionId || '').trim();
    if (!ownerFactionId) {
      throw new HttpsError('failed-precondition', 'This league is limited to the owner’s faction, but no faction is set.');
    }
    if (String(player.factionId || '') !== ownerFactionId) {
      const label = league.ownerFactionName ? String(league.ownerFactionName) : 'the owner’s faction';
      throw new HttpsError('permission-denied', 'Only members of ' + label + ' can join this league.');
    }
  }
}

function assertCurrentSeasonRound(league, round) {
  if (Number(round.seasonNumber) !== Number(league.seasonNumber)) {
    throw new HttpsError('failed-precondition', 'That round is in an archived season.');
  }
}

function participantCount(participants) {
  if (participants == null) return { current: 0, maximum: 0 };
  if (typeof participants === 'number') return { current: participants, maximum: 0 };
  if (typeof participants === 'object') {
    return {
      current: Number(participants.current) || 0,
      maximum: Number(participants.maximum) || 0,
    };
  }
  return { current: 0, maximum: 0 };
}

let trackNameCache = null;
let trackNameCacheAt = 0;

async function trackNameMap(apiKey) {
  if (trackNameCache && Date.now() - trackNameCacheAt < 6 * 60 * 60 * 1000) return trackNameCache;
  try {
    const data = await tornGet('/v2/racing/tracks', apiKey);
    const map = {};
    const raw = data.tracks;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
    for (const track of list) {
      if (!track || typeof track !== 'object') continue;
      const id = track.id != null ? String(track.id) : '';
      const name = decodeTornText(track.name || track.title || '');
      if (id && name) map[id] = name;
    }
    if (Object.keys(map).length) {
      trackNameCache = map;
      trackNameCacheAt = Date.now();
    }
    return map;
  } catch (e) {
    return trackNameCache || {};
  }
}

function compactRace(raw, tracks) {
  const race = raw && raw.race && typeof raw.race === 'object' ? raw.race : raw;
  if (!race || typeof race !== 'object') {
    throw new HttpsError('internal', 'Torn did not return a race.');
  }
  const schedule = race.schedule && typeof race.schedule === 'object' ? race.schedule : {};
  const req = race.requirements && typeof race.requirements === 'object' ? race.requirements : {};
  const grid = participantCount(race.participants);
  const trackId = race.track_id != null ? String(race.track_id) : '';
  return {
    id: race.id != null ? String(race.id) : '',
    title: cleanText(race.title || 'Race', 120) || 'Race',
    trackId,
    trackName: trackId && tracks && tracks[trackId] ? tracks[trackId] : trackId ? 'Track ' + trackId : '',
    status: String(race.status || ''),
    laps: Number(race.laps) || 0,
    isOfficial: race.is_official === true,
    creatorId: race.creator_id != null ? String(race.creator_id) : '',
    start: Number(schedule.start) || 0,
    joinFrom: Number(schedule.join_from) || 0,
    joinUntil: Number(schedule.join_until) || 0,
    end: schedule.end != null ? Number(schedule.end) || 0 : 0,
    participantsCurrent: grid.current,
    participantsMax: grid.maximum,
    requirements: {
      carClass: req.car_class != null && req.car_class !== '' ? String(req.car_class) : '',
      driverClass: req.driver_class != null && req.driver_class !== '' ? String(req.driver_class) : '',
      joinFee: Number(req.join_fee) || 0,
      requiresPassword: req.requires_password === true,
      requiresStock: req.requires_stock_car === true,
    },
  };
}

async function fetchRace(apiKey, raceId) {
  const data = await tornGet('/v2/racing/' + encodeURIComponent(raceId) + '/race', apiKey);
  const tracks = await trackNameMap(apiKey);
  const race = compactRace(data, tracks);
  if (!race.id) race.id = String(raceId);
  return { race, raw: data && data.race ? data.race : data };
}

function dateFromUnix(unix) {
  const n = Number(unix) || 0;
  if (!n) {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(now);
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(n * 1000));
}

function timeFromUnix(unix) {
  const n = Number(unix) || 0;
  if (!n) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(n * 1000));
  const hour = (parts.find((part) => part.type === 'hour') || {}).value || '00';
  const minute = (parts.find((part) => part.type === 'minute') || {}).value || '00';
  return hour + ':' + minute;
}

async function resolveDriverNames(apiKey, ids) {
  const unique = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 120);
  const names = {};
  if (!unique.length) return names;
  const refs = unique.map((id) => getDb().collection(DRIVER_NAMES).doc(id));
  const snaps = await getDb().getAll(...refs);
  const missing = [];
  snaps.forEach((snap) => {
    if (snap.exists && snap.data() && snap.data().name) names[snap.id] = String(snap.data().name);
    else missing.push(snap.id);
  });

  let cursor = 0;
  async function worker() {
    while (cursor < missing.length) {
      const id = missing[cursor++];
      try {
        const data = await tornGet('/user/' + encodeURIComponent(id) + '?selections=basic', apiKey);
        const name = cleanText(data.name || data.player_name || '', 40);
        if (name) names[id] = name;
      } catch (e) {
        /* leave unresolved */
      }
    }
  }
  const workers = Math.min(5, missing.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const batch = getDb().batch();
  let writes = 0;
  for (const id of missing) {
    if (!names[id]) continue;
    batch.set(getDb().collection(DRIVER_NAMES).doc(id), { name: names[id], updatedAt: Date.now() });
    writes += 1;
  }
  if (writes) await batch.commit();
  return names;
}

function mapResults(rawResults, names) {
  const list = Array.isArray(rawResults) ? rawResults : [];
  const mapped = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const driverId = row.driver_id != null ? String(row.driver_id) : '';
    if (!driverId) continue;
    const position = row.position == null ? null : Number(row.position);
    mapped.push({
      position: position != null && Number.isFinite(position) ? position : null,
      driverId,
      driverName: names[driverId] || 'Player ' + driverId,
      carName: cleanText(row.car_item_name || '', 80),
      carClass: row.car_class != null && row.car_class !== '' ? String(row.car_class) : '',
      raceTime: row.race_time == null ? null : Number(row.race_time),
      bestLap: row.best_lap_time == null ? null : Number(row.best_lap_time),
      crashed: row.has_crashed === true,
    });
  }
  mapped.sort((a, b) => {
    if (a.position == null) return 1;
    if (b.position == null) return -1;
    return a.position - b.position;
  });
  return mapped.slice(0, 120);
}

async function syncRoleNames(leagueId, leagueName) {
  const snap = await getDb().collection(ROLES).where('leagueId', '==', leagueId).get();
  if (snap.empty) return;
  let batch = getDb().batch();
  let n = 0;
  for (const doc of snap.docs) {
    batch.update(doc.ref, { leagueName });
    n += 1;
    if (n === 400) {
      await batch.commit();
      batch = getDb().batch();
      n = 0;
    }
  }
  if (n) await batch.commit();
}

exports.racingListMine = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const user = await fetchUserFromApiKey((request.data || {}).apiKey);
  const vipLevel = await effectiveVipLevel(user);
  const snap = await getDb().collection(ROLES).where('playerId', '==', user.playerId).get();
  const leagues = snap.docs
    .map((doc) => {
      const d = doc.data() || {};
      return {
        leagueId: d.leagueId || '',
        leagueName: d.leagueName || 'League',
        role: d.role || 'member',
      };
    })
    .filter((row) => row.leagueId);
  leagues.sort((a, b) => String(a.leagueName).localeCompare(String(b.leagueName)));
  return {
    playerId: user.playerId,
    name: user.name,
    vipLevel,
    leagues,
  };
});

exports.racingCreateLeague = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  await assertVip3(user);
  const name = cleanText(body.name, 60);
  if (name.length < 2) throw new HttpsError('invalid-argument', 'Give the league a name (at least 2 characters).');
  const gate = normalizeGate(body.gate || 'open');
  if (gate === 'faction') assertFactionGateReady(user);
  const id = getDb().collection(LEAGUES).doc().id;
  const now = Date.now();
  const prizes = normalizePrizes(body.grandPrizes);
  const pointsTable = normalizePoints(body.pointsTable);
  const roster = {
    [user.playerId]: { name: user.name, role: 'owner', at: now },
  };
  const batch = getDb().batch();
  batch.set(getDb().collection(LEAGUES).doc(id), {
    name,
    ownerId: user.playerId,
    ownerName: user.name,
    ownerFactionId: user.factionId || '',
    ownerFactionName: user.factionName || '',
    gate,
    joinLocked: false,
    pointsTable,
    grandPrizes: prizes,
    seasonNumber: 1,
    seasonLabel: 'Season 1',
    roster,
    createdAt: now,
    updatedAt: now,
  });
  batch.set(getDb().collection(ROLES).doc(roleDocId(id, user.playerId)), {
    leagueId: id,
    playerId: user.playerId,
    playerName: user.name,
    role: 'owner',
    leagueName: name,
    updatedAt: now,
  });
  await batch.commit();
  return { leagueId: id };
});

exports.racingUpdateLeague = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertOwner(league.data, user);
  const patch = { updatedAt: Date.now() };
  let renamed = null;
  if (body.name != null) {
    const name = cleanText(body.name, 60);
    if (name.length < 2) throw new HttpsError('invalid-argument', 'Give the league a name (at least 2 characters).');
    patch.name = name;
    renamed = name;
  }
  if (body.pointsTable != null) patch.pointsTable = normalizePoints(body.pointsTable);
  if (body.grandPrizes != null) patch.grandPrizes = normalizePrizes(body.grandPrizes);
  if (body.gate != null) {
    const gate = normalizeGate(body.gate);
    if (gate === 'faction') assertFactionGateReady(user);
    patch.gate = gate;
    patch.ownerFactionId = user.factionId || '';
    patch.ownerFactionName = user.factionName || '';
  }
  await league.ref.update(patch);
  if (renamed) await syncRoleNames(league.id, renamed);
  return { ok: true };
});

exports.racingDeleteLeague = onCall(callableOpts({ maxInstances: 5 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertOwner(league.data, user);

  async function drain(collectionName) {
    const q = league.ref.collection(collectionName);
    for (;;) {
      const snap = await q.limit(400).get();
      if (snap.empty) break;
      const batch = getDb().batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      if (snap.size < 400) break;
    }
  }
  await drain('rounds');
  await drain('seasons');
  for (;;) {
    const snap = await getDb().collection(ROLES).where('leagueId', '==', league.id).limit(400).get();
    if (snap.empty) break;
    const batch = getDb().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < 400) break;
  }
  await league.ref.delete();
  return { ok: true };
});

exports.racingJoinLeague = onCall(callableOpts({ maxInstances: 20 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  const roster = rosterOf(league.data);
  const existing = roster[user.playerId];
  if (existing && (existing.role === 'owner' || existing.role === 'admin' || existing.role === 'member')) {
    return { role: existing.role, alreadyIn: true };
  }
  assertNewDriverAllowed(league.data, user, false);
  if (Object.keys(roster).length >= 200) {
    throw new HttpsError('resource-exhausted', 'This league is full (200 drivers).');
  }
  roster[user.playerId] = { name: user.name, role: 'member', at: Date.now() };
  const batch = getDb().batch();
  batch.update(league.ref, { roster, updatedAt: Date.now() });
  batch.set(getDb().collection(ROLES).doc(roleDocId(league.id, user.playerId)), {
    leagueId: league.id,
    playerId: user.playerId,
    playerName: user.name,
    role: 'member',
    leagueName: league.data.name || 'League',
    updatedAt: Date.now(),
  });
  await batch.commit();
  return { role: 'member', alreadyIn: false };
});

exports.racingLeaveLeague = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  const roster = rosterOf(league.data);
  const existing = roster[user.playerId];
  if (!existing) return { ok: true };
  if (existing.role === 'owner') {
    throw new HttpsError('failed-precondition', 'The owner cannot leave. Delete the league instead.');
  }
  if (existing.role === 'admin') {
    throw new HttpsError('failed-precondition', 'Ask the owner to remove you as admin before leaving.');
  }
  delete roster[user.playerId];
  const batch = getDb().batch();
  batch.update(league.ref, { roster, updatedAt: Date.now() });
  batch.delete(getDb().collection(ROLES).doc(roleDocId(league.id, user.playerId)));
  await batch.commit();
  return { ok: true };
});

exports.racingAddAdmin = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertOwner(league.data, user);
  const playerId = String(body.playerId || '').trim();
  if (!/^\d{1,10}$/.test(playerId)) throw new HttpsError('invalid-argument', 'Enter a Torn player ID.');
  if (playerId === String(league.data.ownerId)) {
    throw new HttpsError('failed-precondition', 'The owner is already in charge of this league.');
  }
  const lookedUp = await lookupPlayer(user.apiKey, playerId);
  const name = lookedUp.name;
  const roster = rosterOf(league.data);
  if (!roster[playerId]) assertNewDriverAllowed(league.data, lookedUp, true);
  if (!roster[playerId] && Object.keys(roster).length >= 200) {
    throw new HttpsError('resource-exhausted', 'This league is full (200 drivers).');
  }
  roster[playerId] = { name, role: 'admin', at: roster[playerId] ? roster[playerId].at || Date.now() : Date.now() };
  const batch = getDb().batch();
  batch.update(league.ref, { roster, updatedAt: Date.now() });
  batch.set(getDb().collection(ROLES).doc(roleDocId(league.id, playerId)), {
    leagueId: league.id,
    playerId,
    playerName: name,
    role: 'admin',
    leagueName: league.data.name || 'League',
    updatedAt: Date.now(),
  });
  await batch.commit();
  return { playerId, name };
});

exports.racingRemoveAdmin = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertOwner(league.data, user);
  const playerId = String(body.playerId || '').trim();
  const roster = rosterOf(league.data);
  const existing = roster[playerId];
  if (!existing || existing.role !== 'admin') {
    throw new HttpsError('failed-precondition', 'That player is not an admin.');
  }
  roster[playerId] = { name: existing.name, role: 'member', at: existing.at || Date.now() };
  const batch = getDb().batch();
  batch.update(league.ref, { roster, updatedAt: Date.now() });
  batch.set(getDb().collection(ROLES).doc(roleDocId(league.id, playerId)), {
    leagueId: league.id,
    playerId,
    playerName: existing.name || 'Player',
    role: 'member',
    leagueName: league.data.name || 'League',
    updatedAt: Date.now(),
  });
  await batch.commit();
  return { ok: true };
});

exports.racingArchiveSeason = onCall(callableOpts({ maxInstances: 5 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertOwner(league.data, user);
  const seasonNumber = Number(league.data.seasonNumber) || 1;
  const roundsSnap = await league.ref.collection('rounds').where('seasonNumber', '==', seasonNumber).get();
  const rounds = roundsSnap.docs.map((doc) => doc.data() || {});
  const pointsTable = Array.isArray(league.data.pointsTable) ? league.data.pointsTable : DEFAULT_POINTS.slice();
  const keepRoster = body.keepRoster !== false && body.keepRoster !== 'false';
  const roster = rosterOf(league.data);
  const nextRoster = {};
  const dropped = [];
  Object.keys(roster).forEach((id) => {
    const entry = roster[id];
    if (keepRoster || (entry && (entry.role === 'owner' || entry.role === 'admin'))) nextRoster[id] = entry;
    else dropped.push(id);
  });
  const standings = computeStandings(rounds, pointsTable, roster);
  const next = seasonNumber + 1;
  const batch = getDb().batch();
  batch.set(league.ref.collection('seasons').doc(String(seasonNumber)), {
    seasonNumber,
    label: league.data.seasonLabel || 'Season ' + seasonNumber,
    archivedAt: Date.now(),
    pointsTable,
    grandPrizes: normalizePrizes(league.data.grandPrizes),
    standings,
    roundCount: rounds.length,
  });
  const leaguePatch = {
    seasonNumber: next,
    seasonLabel: 'Season ' + next,
    updatedAt: Date.now(),
  };
  if (!keepRoster) leaguePatch.roster = nextRoster;
  dropped.forEach((id) => {
    batch.delete(getDb().collection(ROLES).doc(roleDocId(league.id, id)));
  });
  batch.update(league.ref, leaguePatch);
  await batch.commit();
  return { seasonNumber: next, keptRoster: keepRoster, removedDrivers: dropped.length };
});

exports.racingSetJoinLock = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const joinLocked = body.locked === true || body.locked === 'true';
  await league.ref.update({ joinLocked, updatedAt: Date.now() });
  return { joinLocked };
});

exports.racingInviteDriver = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const lookedUp = await lookupPlayer(user.apiKey, body.playerId);
  if (lookedUp.playerId === String(league.data.ownerId)) {
    throw new HttpsError('failed-precondition', 'The owner is already on this league.');
  }
  const roster = rosterOf(league.data);
  const existing = roster[lookedUp.playerId];
  if (existing && (existing.role === 'owner' || existing.role === 'admin' || existing.role === 'member')) {
    return { playerId: lookedUp.playerId, name: existing.name || lookedUp.name, alreadyIn: true };
  }
  assertNewDriverAllowed(league.data, lookedUp, true);
  if (Object.keys(roster).length >= 200) {
    throw new HttpsError('resource-exhausted', 'This league is full (200 drivers).');
  }
  roster[lookedUp.playerId] = { name: lookedUp.name, role: 'member', at: Date.now() };
  const batch = getDb().batch();
  batch.update(league.ref, { roster, updatedAt: Date.now() });
  batch.set(getDb().collection(ROLES).doc(roleDocId(league.id, lookedUp.playerId)), {
    leagueId: league.id,
    playerId: lookedUp.playerId,
    playerName: lookedUp.name,
    role: 'member',
    leagueName: league.data.name || 'League',
    updatedAt: Date.now(),
  });
  await batch.commit();
  return { playerId: lookedUp.playerId, name: lookedUp.name, alreadyIn: false };
});

exports.racingRemoveDriver = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const playerId = String(body.playerId || '').trim();
  if (playerId === String(league.data.ownerId)) {
    throw new HttpsError('failed-precondition', 'The owner stays on the league.');
  }
  const roster = rosterOf(league.data);
  const existing = roster[playerId];
  if (!existing) return { ok: true };
  if (existing.role === 'admin' && String(league.data.ownerId) !== String(user.playerId)) {
    throw new HttpsError('permission-denied', 'Only the owner can remove an admin.');
  }
  delete roster[playerId];
  const batch = getDb().batch();
  batch.update(league.ref, { roster, updatedAt: Date.now() });
  batch.delete(getDb().collection(ROLES).doc(roleDocId(league.id, playerId)));
  await batch.commit();
  return { ok: true };
});

function normalizePrizeList(input) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of raw) {
    const text = cleanText(item, 200);
    if (!text) continue;
    out.push(text);
    if (out.length >= 20) break;
  }
  return out;
}

function prizesFromBody(body) {
  if (Array.isArray(body.prizes)) return normalizePrizeList(body.prizes);
  const one = cleanText(body.prize, 200);
  return one ? [one] : [];
}

function roundPayloadFromBody(body, seasonNumber) {
  const prizes = prizesFromBody(body);
  return {
    seasonNumber,
    title: cleanText(body.title, 80) || 'Round',
    scheduledDate: normalizeDate(body.scheduledDate),
    scheduledTime: normalizeTime(body.scheduledTime),
    prizes,
    prize: prizes[0] || '',
  };
}

exports.racingCreateRound = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const seasonNumber = Number(league.data.seasonNumber) || 1;
  const payload = roundPayloadFromBody(body, seasonNumber);
  if (payload.title.length < 1) throw new HttpsError('invalid-argument', 'Name this round.');
  const now = Date.now();
  const ref = league.ref.collection('rounds').doc();
  await ref.set({
    ...payload,
    status: 'tbc',
    tornRaceId: null,
    race: null,
    results: null,
    createdAt: now,
    updatedAt: now,
    createdById: user.playerId,
  });
  await league.ref.update({ updatedAt: now });
  return { roundId: ref.id };
});

exports.racingUpdateRound = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const roundRef = league.ref.collection('rounds').doc(String(body.roundId || ''));
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) throw new HttpsError('not-found', 'That round does not exist.');
  const round = roundSnap.data() || {};
  assertCurrentSeasonRound(league.data, round);
  const payload = roundPayloadFromBody(
    {
      title: body.title != null ? body.title : round.title,
      scheduledDate: body.scheduledDate != null ? body.scheduledDate : round.scheduledDate,
      scheduledTime: body.scheduledTime != null ? body.scheduledTime : round.scheduledTime,
      prizes: Array.isArray(body.prizes)
        ? body.prizes
        : body.prize != null
          ? [body.prize]
          : Array.isArray(round.prizes)
            ? round.prizes
            : round.prize
              ? [round.prize]
              : [],
    },
    round.seasonNumber
  );
  await roundRef.update({ ...payload, updatedAt: Date.now() });
  return { ok: true };
});

exports.racingDeleteRound = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const roundRef = league.ref.collection('rounds').doc(String(body.roundId || ''));
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) return { ok: true };
  assertCurrentSeasonRound(league.data, roundSnap.data() || {});
  await roundRef.delete();
  return { ok: true };
});

async function roundsInTransaction(tx, leagueRef) {
  const snap = await tx.get(leagueRef.collection('rounds'));
  return snap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() || {} }));
}

function findUsedRace(rounds, raceId, exceptRoundId) {
  return rounds.find(
    (round) => String(round.data.tornRaceId || '') === String(raceId) && round.id !== exceptRoundId
  );
}

exports.racingOpenRound = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const raceId = assertRaceId(body.raceId);
  const roundId = String(body.roundId || '').trim();
  if (!roundId) throw new HttpsError('invalid-argument', 'Pick the calendar round this race belongs to.');
  const fetched = await fetchRace(user.apiKey, raceId);
  if (fetched.race.status === 'finished') {
    throw new HttpsError(
      'failed-precondition',
      'That race has already finished. Submit it as a result instead of opening entry.'
    );
  }
  if (fetched.race.status !== 'open' && fetched.race.status !== 'in_progress') {
    throw new HttpsError('failed-precondition', 'Torn does not have that race open for entry.');
  }

  await getDb().runTransaction(async (tx) => {
    const leagueSnap = await tx.get(league.ref);
    if (!leagueSnap.exists) throw new HttpsError('not-found', 'That league does not exist.');
    const leagueData = leagueSnap.data() || {};
    assertStaff(leagueData, user);
    const rounds = await roundsInTransaction(tx, league.ref);
    const target = rounds.find((round) => round.id === roundId);
    if (!target) throw new HttpsError('not-found', 'That round does not exist.');
    assertCurrentSeasonRound(leagueData, target.data);
    if (target.data.status === 'completed') {
      throw new HttpsError('failed-precondition', 'That round already has results.');
    }
    const used = findUsedRace(rounds, raceId, roundId);
    if (used) throw new HttpsError('already-exists', 'That Torn race is already on this league.');
    const otherOpen = rounds.find(
      (round) =>
        round.id !== roundId &&
        round.data.status === 'open' &&
        Number(round.data.seasonNumber) === Number(leagueData.seasonNumber)
    );
    if (otherOpen) {
      throw new HttpsError(
        'failed-precondition',
        'Only one race can be open for entry. Clear "' +
          (otherOpen.data.title || 'the current round') +
          '" first.'
      );
    }
    tx.update(target.ref, {
      status: 'open',
      tornRaceId: raceId,
      race: fetched.race,
      results: null,
      updatedAt: Date.now(),
      openedById: user.playerId,
    });
  });
  return { ok: true, race: fetched.race };
});

exports.racingClearRound = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const roundRef = league.ref.collection('rounds').doc(String(body.roundId || ''));
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) throw new HttpsError('not-found', 'That round does not exist.');
  const round = roundSnap.data() || {};
  assertCurrentSeasonRound(league.data, round);
  if (round.status === 'completed') {
    throw new HttpsError('failed-precondition', 'Delete the round if you need to remove a submitted result.');
  }
  await roundRef.update({
    status: 'tbc',
    tornRaceId: null,
    race: null,
    results: null,
    updatedAt: Date.now(),
  });
  return { ok: true };
});

exports.racingSubmitRace = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const raceId = assertRaceId(body.raceId);
  const roundId = body.roundId != null && String(body.roundId).trim() !== '' ? String(body.roundId).trim() : '';
  const fetched = await fetchRace(user.apiKey, raceId);
  if (fetched.race.status !== 'finished') {
    throw new HttpsError('failed-precondition', 'That race has not finished yet. Open it for entry, or wait for the result.');
  }
  const rawResults = (function () {
    const results = fetched.raw && fetched.raw.results;
    if (Array.isArray(results)) return results;
    if (results && typeof results === 'object') return Object.values(results);
    return [];
  })();
  if (!rawResults.length) {
    throw new HttpsError('failed-precondition', 'Torn has no finishing order for that race yet.');
  }
  const names = await resolveDriverNames(
    user.apiKey,
    rawResults.map((row) => (row && row.driver_id != null ? row.driver_id : ''))
  );
  const results = mapResults(rawResults, names);
  if (!results.length) throw new HttpsError('failed-precondition', 'Torn has no drivers on that race.');

  let savedRoundId = roundId;
  await getDb().runTransaction(async (tx) => {
    const leagueSnap = await tx.get(league.ref);
    if (!leagueSnap.exists) throw new HttpsError('not-found', 'That league does not exist.');
    const leagueData = leagueSnap.data() || {};
    assertStaff(leagueData, user);
    const rounds = await roundsInTransaction(tx, league.ref);
    const used = findUsedRace(rounds, raceId, roundId);
    if (used) throw new HttpsError('already-exists', 'That Torn race is already on this league.');

    const patch = {
      status: 'completed',
      tornRaceId: raceId,
      race: fetched.race,
      results,
      submittedById: user.playerId,
      submittedByName: user.name,
      submittedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (fetched.race && Number(fetched.race.start)) {
      patch.scheduledDate = dateFromUnix(fetched.race.start);
      const racedTime = timeFromUnix(fetched.race.start);
      if (racedTime) patch.scheduledTime = racedTime;
    }

    if (roundId) {
      const target = rounds.find((round) => round.id === roundId);
      if (!target) throw new HttpsError('not-found', 'That round does not exist.');
      assertCurrentSeasonRound(leagueData, target.data);
      tx.update(target.ref, patch);
      savedRoundId = target.id;
      return;
    }

    const ref = league.ref.collection('rounds').doc();
    tx.set(ref, {
      seasonNumber: Number(leagueData.seasonNumber) || 1,
      title: fetched.race.title || 'Race ' + raceId,
      scheduledDate: dateFromUnix(fetched.race.start),
      scheduledTime: timeFromUnix(fetched.race.start),
      prizes: [],
      prize: '',
      createdAt: Date.now(),
      createdById: user.playerId,
      ...patch,
    });
    savedRoundId = ref.id;
  });

  return { ok: true, roundId: savedRoundId, drivers: results.length };
});

function suggestionFromRace(race, usedIds) {
  return {
    id: race.id,
    title: race.title,
    trackName: race.trackName,
    status: race.status,
    start: race.start,
    laps: race.laps,
    isOfficial: race.isOfficial,
    participantsCurrent: race.participantsCurrent,
    alreadyUsed: usedIds.has(String(race.id)),
  };
}

async function fetchMyRaces(apiKey) {
  try {
    return await tornGet('/v2/user/races?limit=10&sort=desc', apiKey);
  } catch (e) {
    const msg = String(e && e.message ? e.message : '').toLowerCase();
    if (msg.includes('sort') || msg.includes('parameter')) {
      return tornGet('/v2/user/races?limit=10', apiKey);
    }
    throw e;
  }
}

exports.racingSuggestRaces = onCall(callableOpts({ maxInstances: 10 }), async (request) => {
  const body = request.data || {};
  const user = await fetchUserFromApiKey(body.apiKey);
  const league = await loadLeague(body.leagueId);
  assertStaff(league.data, user);
  const [raceData, tracks, roundsSnap] = await Promise.all([
    fetchMyRaces(user.apiKey),
    trackNameMap(user.apiKey),
    league.ref.collection('rounds').get(),
  ]);
  const usedIds = new Set();
  roundsSnap.docs.forEach((doc) => {
    const id = (doc.data() || {}).tornRaceId;
    if (id != null && String(id) !== '') usedIds.add(String(id));
  });
  const rawList = Array.isArray(raceData.races)
    ? raceData.races
    : raceData.races && typeof raceData.races === 'object'
      ? Object.values(raceData.races)
      : [];
  const open = [];
  const finished = [];
  for (const raw of rawList) {
    let race;
    try {
      race = compactRace(raw, tracks);
    } catch (e) {
      continue;
    }
    if (!race.id) continue;
    const card = suggestionFromRace(race, usedIds);
    if (race.status === 'open' || race.status === 'in_progress') open.push(card);
    else if (race.status === 'finished') finished.push(card);
  }
  open.sort((a, b) => (b.start || 0) - (a.start || 0));
  finished.sort((a, b) => (b.start || 0) - (a.start || 0));
  return { open: open.slice(0, 25), finished: finished.slice(0, 25) };
});
