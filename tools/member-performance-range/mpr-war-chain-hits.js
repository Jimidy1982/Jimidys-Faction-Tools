/** Ranked war + chain report merge for Member Performance (not part of consumption tracker). */
function mprWcTornFetchUrl(url) {
    return typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(url) : url;
}

/** Same burst + throttle pattern as War & Chain Reporter (`fetchTornApiInChunks` in app.js). */
async function mprWcFetchTornApiInChunks(apiKey, requests, chunkSize = 10) {
    const batchTornApiCalls = window.batchTornApiCalls;
    if (typeof batchTornApiCalls !== 'function') {
        throw new Error('batchTornApiCalls is not available (load the main app first).');
    }
    const allData = {};
    const throttleDelay = 667;
    const firstBurstCount = 50;
    const burstRequests = requests.slice(0, firstBurstCount);
    const throttledRequests = requests.slice(firstBurstCount);

    if (burstRequests.length > 0) {
        for (let i = 0; i < burstRequests.length; i += chunkSize) {
            const chunk = burstRequests.slice(i, i + chunkSize);
            Object.assign(allData, await batchTornApiCalls(apiKey, chunk));
        }
    }
    if (throttledRequests.length > 0) {
        await new Promise(r => setTimeout(r, 30000));
    }
    if (throttledRequests.length > 0) {
        for (let i = 0; i < throttledRequests.length; i += chunkSize) {
            const chunk = throttledRequests.slice(i, i + chunkSize);
            Object.assign(allData, await batchTornApiCalls(apiKey, chunk));
            if (i + chunkSize < throttledRequests.length) {
                await new Promise(r => setTimeout(r, throttleDelay));
            }
        }
    }
    return allData;
}

function mprWcNormalizeRankedWarsArray(warListPayload) {
    const root = (warListPayload && warListPayload.rankedwars) || {};
    if (Array.isArray(root)) return root;
    const nested = root.rankedwars;
    if (Array.isArray(nested)) return nested;
    if (nested && typeof nested === 'object') return Object.values(nested);
    if (root && typeof root === 'object') return Object.values(root);
    return [];
}

function mprWcWarOverlapsRange(war, fromTs, toTs) {
    if (!war || war.start == null) return false;
    const warEnd = war.end > 0 ? war.end : Math.floor(Date.now() / 1000);
    return war.start <= toTs && warEnd >= fromTs;
}

function mprWcRankedWarWindowEnd(war) {
    if (!war || war.start == null) return null;
    return war.end > 0 ? Number(war.end) : Math.floor(Date.now() / 1000);
}

/** Inclusive overlap of [a0,a1] and [b0,b1] on the timeline (seconds). */
function mprWcUnixIntervalsOverlap(a0, a1, b0, b1) {
    if (a0 == null || a1 == null || b0 == null || b1 == null) return false;
    const as = Math.min(a0, a1);
    const ae = Math.max(a0, a1);
    const bs = Math.min(b0, b1);
    const be = Math.max(b0, b1);
    return as <= be && ae >= bs;
}

/**
 * True if chain [start,end] intersects any ranked war we loaded (same list used for war reports).
 * When unknown, pass assumeOverlapIfUnknown so we do not double-count vs ranked war reports.
 */
function mprWcChainOverlapsAnyRankedWar(chainStart, chainEnd, overlappingWars, assumeOverlapIfUnknown) {
    if (!Array.isArray(overlappingWars) || overlappingWars.length === 0) return false;
    if (chainStart == null || !Number.isFinite(Number(chainStart))) return !!assumeOverlapIfUnknown;
    const c0 = Number(chainStart);
    const c1 = chainEnd != null && Number.isFinite(Number(chainEnd)) ? Number(chainEnd) : c0;
    for (const war of overlappingWars) {
        if (!war || war.start == null) continue;
        const w0 = Number(war.start);
        const w1 = mprWcRankedWarWindowEnd(war);
        if (!Number.isFinite(w0) || w1 == null || !Number.isFinite(w1)) continue;
        if (mprWcUnixIntervalsOverlap(c0, c1, w0, w1)) return true;
    }
    return false;
}

/** Chain report API start/end (seconds), best-effort for overlap vs ranked wars. */
function mprWcChainReportTimeBounds(cr) {
    if (!cr || typeof cr !== 'object') return { start: null, end: null };
    const s =
        mprWcParseTornNumeric(cr.start) ??
        mprWcParseTornNumeric(cr.start_time) ??
        mprWcParseTornNumeric(cr.chain_start) ??
        mprWcParseTornNumeric(cr.depart);
    const e =
        mprWcParseTornNumeric(cr.end) ??
        mprWcParseTornNumeric(cr.end_time) ??
        mprWcParseTornNumeric(cr.chain_end) ??
        mprWcParseTornNumeric(cr.arrive) ??
        s;
    return { start: s, end: e };
}

/** Same contribution fields as `processRankedWarReports` in app.js (points/score), plus explicit respect if present. */
function mprWcWarMemberRespectLike(memberData) {
    if (!memberData || typeof memberData !== 'object') return 0;
    const raw =
        memberData.points ||
        memberData.score ||
        memberData.respect ||
        memberData.respect_total ||
        0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
}

function mprWcEnsureHitRow(hitsById, id) {
    const k = String(id);
    if (!hitsById[k]) {
        hitsById[k] = {
            war: 0,
            chain: 0,
            outside: 0,
            warRespect: 0,
            outsideRespect: 0,
            chainWarRespect: 0,
            outsideRespectHasChainRespect: false,
            /** Sum of max(0, respect - 10) for chain bonus hits whose defender was an enemy on a ranked war report in this fetch. */
            chainBonusExtraWar: 0,
            /** Same for bonuses not matched to an enemy defender (treated as outside for strip). */
            chainBonusExtraOutside: 0,
            /** Sum of full `respect` on bonus lines classified war (defender on enemy roster). */
            chainBonusRespectSumWar: 0,
            /** Sum of full `respect` on bonus lines classified outside. */
            chainBonusRespectSumOutside: 0,
            /** Each `bonuses[]` row for this attacker (merged across chains in range). */
            chainBonusDetails: [],
            /** How `outsideRespect` was built: one row per chain report where this member had hits. */
            outsideRespectChainLines: []
        };
    }
    return hitsById[k];
}

/** All enemy player IDs from ranked war reports (non-own factions), for classifying chain bonus defenders. */
function mprWcCollectEnemyMemberIdsFromWarReports(warReportData, ownFactionId) {
    const own = String(ownFactionId);
    const set = new Set();
    for (const report of Object.values(warReportData || {})) {
        if (report && report.error) continue;
        if (!report || !report.rankedwarreport || !report.rankedwarreport.factions) continue;
        for (const factionData of Object.values(report.rankedwarreport.factions)) {
            if (String(factionData.id) === own) continue;
            if (!Array.isArray(factionData.members)) continue;
            for (const memberData of factionData.members) {
                const mid = memberData.id != null ? String(memberData.id) : '';
                if (mid) set.add(mid);
            }
        }
    }
    return set;
}

function mprWcNormalizedChainBonusList(chainreport) {
    if (!chainreport) return [];
    const raw = chainreport.bonuses;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return Object.values(raw);
    return [];
}

/** Torn often sends numbers as strings, sometimes with thousands separators. */
function mprWcParseTornNumeric(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(String(raw).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** Extra chain-bonus respect above the base 10 for one bonus line (Torn milestone payouts). */
function mprWcChainBonusExtraRespect(respectVal) {
    const r = mprWcParseTornNumeric(respectVal);
    if (r == null || r <= 0) return 0;
    return Math.max(0, r - 10);
}

/** Per-attacker total respect on one chain (v2 `attackers` or torn-style `members` row). Torn may send string. */
function mprWcAttackerChainRespectTotal(attacker) {
    if (!attacker || typeof attacker !== 'object') return null;
    const raw =
        attacker.respect ??
        attacker.respect_total ??
        attacker.respectTotal ??
        attacker.total_respect ??
        null;
    return mprWcParseTornNumeric(raw);
}

/**
 * v2 chainreport.attackers can be an array or an object map. Returns a plain array of attacker rows.
 * @param {unknown} rawAttackers
 * @returns {object[]}
 */
function mprWcNormalizedChainAttackersList(rawAttackers) {
    if (Array.isArray(rawAttackers)) return rawAttackers;
    if (rawAttackers && typeof rawAttackers === 'object') return Object.values(rawAttackers);
    return [];
}

/**
 * Chain hit counts: v2 often uses `attacks: { total, war }`; torn `chainreport.members` uses flat
 * `attacks` (number) and `war` on the same object ([Torn chainreport members](https://api.torn.com/torn/)).
 * @param {object} row
 * @returns {{ total: number, warInChain: number }}
 */
function mprWcChainParticipantHitCounts(row) {
    if (!row || typeof row !== 'object') return { total: 0, warInChain: 0 };
    const atk = row.attacks;
    if (atk && typeof atk === 'object') {
        const total = atk.total != null ? Number(atk.total) : 0;
        const warInChain = atk.war != null ? Number(atk.war) : 0;
        const t = Number.isFinite(total) ? Math.max(0, total) : 0;
        const w = Number.isFinite(warInChain) ? Math.max(0, warInChain) : 0;
        return { total: t, warInChain: Math.min(w, t) };
    }
    const flatTotal = mprWcParseTornNumeric(atk);
    if (flatTotal != null && flatTotal >= 0) {
        const total = Math.max(0, flatTotal);
        const w = mprWcParseTornNumeric(row.war);
        const warInChain = w != null ? Math.max(0, Math.min(w, total)) : 0;
        return { total, warInChain };
    }
    return { total: 0, warInChain: 0 };
}

/** Stable member id for a chain row (v2 `id`, torn `userID`, or map key hint). */
function mprWcChainParticipantMemberId(row, idHint) {
    if (!row || typeof row !== 'object') return '';
    let id =
        row.id ??
        row.userID ??
        row.user_id ??
        row.userId ??
        row.player_id ??
        row.playerId ??
        null;
    if (id == null || id === '') {
        const h = idHint != null ? String(idHint) : '';
        if (/^\d+$/.test(h)) id = h;
    }
    return id != null && id !== '' ? String(id) : '';
}

/**
 * Prefer `chainreport.attackers`; if absent/empty use `chainreport.members` (torn-style / alternate payloads).
 * @param {object} cr
 * @returns {object[]}
 */
function mprWcNormalizedChainParticipantsList(cr) {
    if (!cr || typeof cr !== 'object') return [];
    const fromAttackers = mprWcNormalizedChainAttackersList(cr.attackers);
    if (fromAttackers.length > 0) return fromAttackers;
    const mem = cr.members;
    if (mem && typeof mem === 'object' && !Array.isArray(mem)) {
        return Object.entries(mem)
            .map(([key, row]) => {
                if (!row || typeof row !== 'object') return null;
                if (mprWcChainParticipantMemberId(row, key)) return row;
                if (/^\d+$/.test(key)) return { ...row, userID: row.userID ?? row.id ?? Number(key) };
                return row;
            })
            .filter(Boolean);
    }
    return [];
}

/**
 * Raw API response for one chain → inner object with `members` / `respect` / `bonuses` / optional `attackers`.
 * v1: `https://api.torn.com/torn/{ID}?selections=chainreport` ([Torn API](https://www.torn.com/api.html)).
 * @param {object} report
 * @returns {object|null}
 */
function mprWcGetChainReportObject(report) {
    if (!report || typeof report !== 'object' || report.error) return null;
    const cr = report.chainreport;
    if (cr && typeof cr === 'object') return cr;
    if (report.members && typeof report.members === 'object' && !Array.isArray(report.members)) return report;
    return null;
}

/**
 * ID for `https://api.torn.com/torn/{ID}?selections=chainreport` from a v2 `…/chains` row.
 * Prefer explicit ids; use numeric `chain` only when it looks like a log id (not a short hit-count).
 * @param {object} chainData
 * @returns {string|null}
 */
function mprWcTornChainReportLookupId(chainData) {
    if (!chainData || typeof chainData !== 'object') return null;
    const n = v => {
        const x = Number(v);
        return Number.isFinite(x) && x > 0 ? Math.trunc(x) : null;
    };
    const explicit =
        n(chainData.id) ??
        n(chainData.chain_id) ??
        n(chainData.chainID) ??
        n(chainData.log);
    if (explicit != null) return String(explicit);
    const ch = n(chainData.chain);
    if (ch != null && ch >= 100000) return String(ch);
    const fac = n(chainData.faction) ?? n(chainData.faction_id);
    if (fac != null) return String(fac);
    return null;
}

/**
 * After merge: shape of API payloads vs rows that got outside hit counts but no chain-respect attribution.
 * @param {Record<string, unknown>} chainReportData
 * @param {Object.<string, object>} hitsById
 */
function mprWcBuildWarChainFetchDebug(chainReportData, hitsById) {
    let reportsWithChain = 0;
    let attackerArray = 0;
    let attackerObject = 0;
    let attackerMissing = 0;
    const tcSamples = [];
    const firstAttackerKeySamples = [];
    for (const report of Object.values(chainReportData || {})) {
        if (report && report.error) continue;
        const cr = mprWcGetChainReportObject(report);
        if (!cr) continue;
        reportsWithChain++;
        const raw = cr.attackers;
        if (Array.isArray(raw)) attackerArray++;
        else if (raw && typeof raw === 'object') attackerObject++;
        else attackerMissing++;
        if (tcSamples.length < 5) {
            const parsed = mprWcParseTornNumeric(cr.respect);
            tcSamples.push({ raw: cr.respect, parsed, chainOk: parsed != null && parsed > 0 });
        }
        if (firstAttackerKeySamples.length < 2) {
            const list = mprWcNormalizedChainAttackersList(raw);
            const first = list[0];
            if (first && typeof first === 'object') {
                firstAttackerKeySamples.push(Object.keys(first).sort());
            }
        }
    }
    /** First parsed row per first chain report (why outside respect stayed 0). */
    const participantRowSamples = [];
    for (const report of Object.values(chainReportData || {})) {
        if (report && report.error) continue;
        const cr = mprWcGetChainReportObject(report);
        if (!cr) continue;
        const plist = mprWcNormalizedChainParticipantsList(cr);
        const p0 = plist[0];
        if (p0 && typeof p0 === 'object' && participantRowSamples.length < 3) {
            const { total, warInChain } = mprWcChainParticipantHitCounts(p0);
            participantRowSamples.push({
                memberId: mprWcChainParticipantMemberId(p0, ''),
                attacksType: typeof p0.attacks,
                total,
                warInChain,
                outsideAdd: Math.max(0, total - warInChain),
                trKnown: mprWcAttackerChainRespectTotal(p0),
                keys: Object.keys(p0).sort()
            });
        }
    }
    const rowsOutsideNoFlag = [];
    for (const [id, row] of Object.entries(hitsById || {})) {
        if (row.outside > 0 && !row.outsideRespectHasChainRespect) {
            rowsOutsideNoFlag.push({
                id,
                outside: row.outside,
                outsideRespect: row.outsideRespect,
                chain: row.chain
            });
        }
    }
    return {
        reportsWithChain,
        attackerShapes: { array: attackerArray, object: attackerObject, missing: attackerMissing },
        tcSamples,
        firstAttackerKeySamples,
        participantRowSamples,
        membersWithOutsideHitsButNoChainRespectFlag: rowsOutsideNoFlag.length,
        sampleMembersMissingRespect: rowsOutsideNoFlag.slice(0, 12)
    };
}

/**
 * Merge chain report payloads into per-member chain attack totals.
 * Fetches use v1 `https://api.torn.com/torn/{ID}?selections=chainreport` ([Torn API](https://www.torn.com/api.html));
 * each member row has `respect` (total on that chain), `attacks`, `war` (chain war hits). Outside respect from
 * that chain = `respect × (attacks − war) / attacks` — i.e. total chain respect minus the war-hit share; same as
 * subtracting `respect × (war / attacks)` from `respect`. Chain-level `respect` fills rows missing per-member totals.
 * Chain `war` hits on chains whose time range does **not** overlap a fetched ranked war add to `row.war` and
 * `row.warRespect` (same `respect × war ÷ attacks` proration); when the chain overlaps a ranked war, those hits stay
 * in `chainWarRespect` only so ranked `row.war` stays from war reports.
 * Milestone payouts are **not** in per-member `respect`; they appear only under `bonuses` (e.g. `chain`, `attacker`,
 * `defender`, `respect`). Torn applies war bonuses to ranked-war report respect separately; here we only tag each
 * bonus line’s overhang `max(0, bonusRespect − 10)` as war vs outside using whether `defender` is on an enemy roster
 * from ranked war reports in this fetch (same check you described).
 *
 * @param {Record<string, unknown>} chainReportData
 * @param {Object.<string, object>} hitsById
 * @param {Set<string>|null|undefined} enemyMemberIdSet — defender IDs from enemy factions on ranked war reports; if empty/absent, bonus strips are skipped.
 * @param {object[]|null|undefined} overlappingRankedWars — wars in range (for overlap); chain `war` hits on chains **outside** these windows count as territory/raid and merge into `row.war` / `row.warRespect`.
 */
function mprWcMergeChainReportsIntoHits(chainReportData, hitsById, enemyMemberIdSet, overlappingRankedWars) {
    const enemySet = enemyMemberIdSet instanceof Set ? enemyMemberIdSet : new Set();
    const canStripBonuses = enemySet.size > 0;
    const rankedList = Array.isArray(overlappingRankedWars) ? overlappingRankedWars : [];

    for (const [reportKey, report] of Object.entries(chainReportData || {})) {
        if (report && report.error) continue;
        const cr = mprWcGetChainReportObject(report);
        if (cr) {
            const { start: chainStart, end: chainEnd } = mprWcChainReportTimeBounds(cr);
            const chainDuringRankedWar = mprWcChainOverlapsAnyRankedWar(
                chainStart,
                chainEnd,
                rankedList,
                rankedList.length > 0
            );
            const participants = mprWcNormalizedChainParticipantsList(cr);
            if (participants.length === 0) {
                // fall through to bonus strip block below
            } else {
                const TC = mprWcParseTornNumeric(cr.respect);
                const TCok = TC != null && TC > 0;

                const entries = participants.map(row => {
                    const memberId = mprWcChainParticipantMemberId(row, '');
                    const { total, warInChain } = mprWcChainParticipantHitCounts(row);
                    const t = total || 0;
                    const outsideAdd = Math.max(0, t - (warInChain || 0));
                    const trKnown = mprWcAttackerChainRespectTotal(row);
                    return { memberId, t, warInChain, outsideAdd, trKnown };
                });

                const sumT = entries.reduce((s, e) => s + (e.t > 0 ? e.t : 0), 0);
                let sumKnown = 0;
                let sumTUnknown = 0;
                for (const e of entries) {
                    if (e.t <= 0) continue;
                    if (e.trKnown != null) sumKnown += e.trKnown;
                    else sumTUnknown += e.t;
                }

                entries.forEach(e => {
                    const { memberId, t, warInChain, outsideAdd, trKnown } = e;
                    if (!memberId) return;
                    const row = mprWcEnsureHitRow(hitsById, memberId);
                    row.chain += t;
                    row.outside += outsideAdd;
                    const wic = Math.max(0, warInChain || 0);
                    if (t > 0 && wic > 0 && !chainDuringRankedWar) {
                        row.war += wic;
                    }
                    if (t <= 0) return;

                    let trEff = null;
                    if (trKnown != null) {
                        trEff = trKnown;
                    } else if (TCok && sumT > 0) {
                        const remainder = Math.max(0, TC - sumKnown);
                        if (sumTUnknown > 0) {
                            trEff = remainder * (t / sumTUnknown);
                        } else if (sumKnown === 0) {
                            trEff = TC * (t / sumT);
                        }
                    }

                    if (trEff != null && Number.isFinite(trEff) && trEff >= 0) {
                        const outsideContrib = trEff * (outsideAdd / t);
                        row.outsideRespect += outsideContrib;
                        if (wic > 0) {
                            const warShare = trEff * (wic / t);
                            if (chainDuringRankedWar) {
                                row.chainWarRespect += warShare;
                            } else {
                                row.warRespect += warShare;
                            }
                        }
                        row.outsideRespectHasChainRespect = true;
                        if (!Array.isArray(row.outsideRespectChainLines)) row.outsideRespectChainLines = [];
                        row.outsideRespectChainLines.push({
                            reportKey: reportKey || '',
                            chainEnd: cr.end != null ? Number(cr.end) : null,
                            chainId: cr.chain != null ? cr.chain : null,
                            memberAttacks: t,
                            warOnChain: wic,
                            outsideOnChain: outsideAdd,
                            respectUsed: trEff,
                            fromMemberRow: trKnown != null,
                            contribution: outsideContrib
                        });
                    }
                });
            }
        }
        if (cr && canStripBonuses) {
            const bonusList = mprWcNormalizedChainBonusList(cr);
            for (const b of bonusList) {
                if (!b || typeof b !== 'object') continue;
                const aid = b.attacker != null ? String(b.attacker) : '';
                if (!aid) continue;
                const did = b.defender != null ? String(b.defender) : '';
                const bonusFull = mprWcParseTornNumeric(b.respect) ?? 0;
                const extra = mprWcChainBonusExtraRespect(b.respect);
                const row = mprWcEnsureHitRow(hitsById, aid);
                const warBucket = !!(did && enemySet.has(did));
                if (warBucket) {
                    if (bonusFull > 0) row.chainBonusRespectSumWar += bonusFull;
                    if (extra > 0) row.chainBonusExtraWar += extra;
                } else {
                    if (bonusFull > 0) row.chainBonusRespectSumOutside += bonusFull;
                    if (extra > 0) row.chainBonusExtraOutside += extra;
                }
                if (!Array.isArray(row.chainBonusDetails)) row.chainBonusDetails = [];
                row.chainBonusDetails.push({
                    chain: b.chain != null && b.chain !== '' ? b.chain : null,
                    defender: did,
                    respectFull: bonusFull,
                    stripExtra: extra > 0 ? extra : 0,
                    warBucket,
                    unclassified: false
                });
            }
        } else if (cr) {
            const bonusList = mprWcNormalizedChainBonusList(cr);
            for (const b of bonusList) {
                if (!b || typeof b !== 'object') continue;
                const aid = b.attacker != null ? String(b.attacker) : '';
                if (!aid) continue;
                const did = b.defender != null ? String(b.defender) : '';
                const bonusFull = mprWcParseTornNumeric(b.respect) ?? 0;
                const extra = mprWcChainBonusExtraRespect(b.respect);
                const row = mprWcEnsureHitRow(hitsById, aid);
                if (!Array.isArray(row.chainBonusDetails)) row.chainBonusDetails = [];
                row.chainBonusDetails.push({
                    chain: b.chain != null && b.chain !== '' ? b.chain : null,
                    defender: did,
                    respectFull: bonusFull,
                    stripExtra: extra > 0 ? extra : 0,
                    warBucket: false,
                    unclassified: true
                });
            }
        }
    }
}

/** Merge ranked war reports for our faction only (war attack counts, as in `processRankedWarReports` in app.js). */
function mprWcMergeWarReportsIntoHits(warReportData, hitsById, ownFactionId) {
    const own = String(ownFactionId);
    for (const report of Object.values(warReportData || {})) {
        if (report && report.error) continue;
        if (!report || !report.rankedwarreport || !report.rankedwarreport.factions) continue;
        for (const factionData of Object.values(report.rankedwarreport.factions)) {
            if (String(factionData.id) !== own) continue;
            if (!Array.isArray(factionData.members)) continue;
            for (const memberData of factionData.members) {
                const memberId = memberData.id != null ? String(memberData.id) : '';
                if (!memberId) continue;
                const attacks = memberData.attacks || 0;
                const row = mprWcEnsureHitRow(hitsById, memberId);
                row.war += attacks || 0;
                row.warRespect += mprWcWarMemberRespectLike(memberData);
            }
        }
    }
}

/**
 * War hits + chain hits for the same [fromTs, toTs] as consumption (War & Chain Reporter endpoints).
 * @returns {{ ok: boolean, hitsById: Object.<string, {war:number, chain:number, outside:number, warRespect:number, outsideRespect:number, chainWarRespect:number, outsideRespectHasChainRespect:boolean, chainBonusExtraWar:number, chainBonusExtraOutside:number}>, warnings: string[], message?: string }}
 */
async function mprFetchWarChainHitsForRange(apiKey, fromTs, toTs) {
    const warnings = [];
    const hitsById = {};
    const key = (apiKey || '').trim();
    if (!key) {
        return { ok: false, hitsById, warnings, message: 'No API key.' };
    }
    if (typeof window.batchTornApiCalls !== 'function') {
        return { ok: false, hitsById, warnings, message: 'API batch helper not loaded.' };
    }

    const userUrl = mprWcTornFetchUrl(`https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(key)}`);
    const userRes = await fetch(userUrl);
    const userData = await userRes.json();
    if (userData.error) {
        return { ok: false, hitsById, warnings, message: userData.error.error || 'User API error' };
    }
    const factionId =
        userData.faction_id ||
        userData.faction?.faction_id ||
        (userData.faction && userData.faction.id != null ? userData.faction.id : null);
    if (!factionId) {
        return {
            ok: false,
            hitsById,
            warnings,
            message: 'No faction on profile (same requirement as War & Chain Reporter).'
        };
    }
    const fid = String(factionId);

    const warListRequest = {
        name: 'rankedwars',
        url: `https://api.torn.com/v2/faction/${fid}/rankedwars`,
        params: ''
    };
    const warListData = await window.batchTornApiCalls(key, [warListRequest]);
    const warRoot = warListData.rankedwars;
    if (warRoot && warRoot.error) {
        return { ok: false, hitsById, warnings, message: warRoot.error.error || 'Ranked wars error' };
    }

    const allWars = mprWcNormalizeRankedWarsArray(warListData);
    let overlapping = allWars.filter(w => mprWcWarOverlapsRange(w, fromTs, toTs));
    overlapping.sort((a, b) => (b.start || 0) - (a.start || 0));
    const WAR_CAP = 100;
    if (overlapping.length > WAR_CAP) {
        warnings.push(`Ranked war reports capped at ${WAR_CAP} wars (this range overlaps ${overlapping.length}).`);
        overlapping = overlapping.slice(0, WAR_CAP);
    }

    const chainListRequest = {
        name: 'chains',
        url: `https://api.torn.com/v2/faction/${fid}/chains`,
        params: `limit=100&sort=DESC&to=${toTs}&from=${fromTs}&timestamp=${Math.floor(Date.now() / 1000)}`
    };
    const chainListData = await window.batchTornApiCalls(key, [chainListRequest]);
    const chainRoot = chainListData.chains;
    if (chainRoot && chainRoot.error) {
        return { ok: false, hitsById, warnings, message: chainRoot.error.error || 'Chains list error' };
    }
    const chainsResponse = chainRoot || {};
    const chainsArray = chainsResponse.chains || [];
    if (chainsArray.length >= 100) {
        warnings.push('Chain list is limited to 100 chains (Torn API); very busy ranges may be incomplete.');
    }

    /** Ranked war reports first so chain bonus lines can be matched to enemy defenders. */
    let warReportData = {};
    if (overlapping.length > 0) {
        const warReportRequests = overlapping.map((warData, index) => {
            const warId = warData.id || warData.war_id;
            return {
                name: `war_${index}`,
                url: `https://api.torn.com/v2/faction/${warId}/rankedwarreport`,
                params: ''
            };
        });
        warReportData = await mprWcFetchTornApiInChunks(key, warReportRequests);
    }
    const enemyMemberIdSet = mprWcCollectEnemyMemberIdsFromWarReports(warReportData, fid);
    if (chainsArray.length > 0 && enemyMemberIdSet.size === 0) {
        warnings.push('Chains in range but no ranked war in range: chain bonus respect is not adjusted against war defenders.');
    }

    if (chainsArray.length > 0) {
        const chainReportRequests = chainsArray
            .map((chainData, index) => {
                const tornId = mprWcTornChainReportLookupId(chainData);
                if (!tornId) {
                    warnings.push(`Chain ${index + 1}/${chainsArray.length} skipped — no torn id for chainreport.`);
                    return null;
                }
                const ts = chainData.end || chainData.start || index;
                return {
                    name: `chain_${index}`,
                    url: `https://api.torn.com/torn/${encodeURIComponent(tornId)}`,
                    params: `selections=chainreport&timestamp=${ts}`
                };
            })
            .filter(Boolean);
        const chainReportData = await mprWcFetchTornApiInChunks(key, chainReportRequests);
        mprWcMergeChainReportsIntoHits(chainReportData, hitsById, enemyMemberIdSet, overlapping);
        const debugWarChain = mprWcBuildWarChainFetchDebug(chainReportData, hitsById);
        try {
            window.__mprWarChainDebug = debugWarChain;
        } catch (e) {
            /* ignore */
        }
        console.info('[MPR war/chain]', debugWarChain);
    }

    if (overlapping.length > 0) {
        mprWcMergeWarReportsIntoHits(warReportData, hitsById, fid);
    }

    /** @type {object|undefined} */
    let debugWarChainReturn;
    try {
        debugWarChainReturn = chainsArray.length > 0 ? window.__mprWarChainDebug : undefined;
    } catch (e2) {
        debugWarChainReturn = undefined;
    }

    return {
        ok: true,
        hitsById,
        warnings,
        message: '',
        ...(debugWarChainReturn ? { debugWarChain: debugWarChainReturn } : {})
    };
}
window.factionToolsFetchWarChainHitsForRange = mprFetchWarChainHitsForRange;
