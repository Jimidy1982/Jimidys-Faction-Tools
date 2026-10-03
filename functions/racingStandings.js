/**
 * Grand Prix standings.
 * Points come from the league table (default 25, 18, 15, 12, 10, 8, 6, 4, 2, 1).
 * Positions past the table score 0. A missing position (DNF / not classified) scores 0.
 * Tie-break: points, wins, 2nds, 3rds, best finish, name.
 */

const DEFAULT_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

function pointsForPosition(pointsTable, position) {
  const pos = Number(position);
  if (!Number.isFinite(pos) || pos < 1) return 0;
  const table = Array.isArray(pointsTable) ? pointsTable : DEFAULT_POINTS;
  const raw = table[pos - 1];
  const pts = Number(raw);
  return Number.isFinite(pts) && pts > 0 ? pts : 0;
}

function computeStandings(rounds, pointsTable, roster) {
  const map = new Map();
  const list = Array.isArray(rounds) ? rounds : [];
  for (const round of list) {
    if (!round || round.status !== 'completed' || !Array.isArray(round.results)) continue;
    for (const result of round.results) {
      if (!result) continue;
      const driverId = String(result.driverId || '').trim();
      if (!driverId) continue;
      if (!map.has(driverId)) {
        map.set(driverId, {
          driverId,
          driverName: result.driverName ? String(result.driverName) : 'Player ' + driverId,
          points: 0,
          wins: 0,
          seconds: 0,
          thirds: 0,
          starts: 0,
          bestFinish: null,
        });
      }
      const row = map.get(driverId);
      if (result.driverName) row.driverName = String(result.driverName);
      const pos = result.position == null || result.position === '' ? null : Number(result.position);
      const classified = pos != null && Number.isFinite(pos);
      row.points += pointsForPosition(pointsTable, classified ? pos : null);
      row.starts += 1;
      if (pos === 1) row.wins += 1;
      if (pos === 2) row.seconds += 1;
      if (pos === 3) row.thirds += 1;
      if (classified && (row.bestFinish == null || pos < row.bestFinish)) row.bestFinish = pos;
    }
  }

  const rosterIds = new Set(Object.keys(roster || {}));
  const standings = [...map.values()].map((row) => ({
    ...row,
    inLeague: rosterIds.has(String(row.driverId)),
  }));

  standings.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.seconds !== a.seconds) return b.seconds - a.seconds;
    if (b.thirds !== a.thirds) return b.thirds - a.thirds;
    const af = a.bestFinish == null ? 9999 : a.bestFinish;
    const bf = b.bestFinish == null ? 9999 : b.bestFinish;
    if (af !== bf) return af - bf;
    const byName = String(a.driverName).localeCompare(String(b.driverName));
    if (byName !== 0) return byName;
    return String(a.driverId).localeCompare(String(b.driverId));
  });

  return standings;
}

module.exports = {
  DEFAULT_POINTS,
  pointsForPosition,
  computeStandings,
};
