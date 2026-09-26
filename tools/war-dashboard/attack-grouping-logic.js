/**
 * Pure helpers for Attack Grouping tier builds.
 * Browser global: AttackGroupingLogic. Node: module.exports.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.AttackGroupingLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const METHODS = ['equal', 'statRange', 'manual'];
    const MIN_TIERS = 1;
    const MAX_TIERS = 10;
    const DEFAULT_TIERS = 5;

    function clampTierCount(n) {
        const v = parseInt(n, 10);
        if (!Number.isFinite(v)) return DEFAULT_TIERS;
        return Math.max(MIN_TIERS, Math.min(MAX_TIERS, v));
    }

    function normalizeMethod(method) {
        return METHODS.indexOf(method) >= 0 ? method : 'equal';
    }

    function statOf(bsMap, id) {
        if (!bsMap) return null;
        const n = Number(bsMap[String(id)]);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }

    function compareStatDesc(a, b) {
        if (a.stat == null && b.stat == null) {
            return String(a.name || a.id).localeCompare(String(b.name || b.id));
        }
        if (a.stat == null) return 1;
        if (b.stat == null) return -1;
        if (b.stat !== a.stat) return b.stat - a.stat;
        return String(a.name || a.id).localeCompare(String(b.name || b.id));
    }

    function memberRows(members, bsMap) {
        const list = Array.isArray(members) ? members : [];
        return list.map(function (m) {
            const id = m && m.id != null ? String(m.id) : '';
            return {
                id: id,
                name: m && m.name ? String(m.name) : id,
                stat: statOf(bsMap, id)
            };
        }).filter(function (row) { return /^\d+$/.test(row.id); });
    }

    /** Strongest players land in tier 0. Extra players go to the top tiers. */
    function equalSplit(members, bsMap, tierCount) {
        const n = clampTierCount(tierCount);
        const rows = memberRows(members, bsMap).sort(compareStatDesc);
        const tiers = [];
        for (let i = 0; i < n; i++) tiers.push([]);
        const base = Math.floor(rows.length / n);
        let extra = rows.length % n;
        let idx = 0;
        for (let t = 0; t < n; t++) {
            const size = base + (extra > 0 ? 1 : 0);
            if (extra > 0) extra -= 1;
            for (let i = 0; i < size && idx < rows.length; i++, idx++) {
                tiers[t].push(rows[idx].id);
            }
        }
        return tiers;
    }

    function inRange(stat, range) {
        if (stat == null || !range) return false;
        if (range.min != null && stat < range.min) return false;
        if (range.max != null && stat > range.max) return false;
        return true;
    }

    /**
     * First matching tier wins (tier 1 is checked first).
     * Players with no estimated stats, or outside every range, are unassigned.
     */
    function applyRanges(members, bsMap, ranges) {
        const list = Array.isArray(ranges) ? ranges : [];
        const tiers = list.map(function () { return []; });
        const unassigned = [];
        const rows = memberRows(members, bsMap).sort(compareStatDesc);
        rows.forEach(function (row) {
            if (row.stat == null) {
                unassigned.push(row.id);
                return;
            }
            for (let i = 0; i < list.length; i++) {
                if (inRange(row.stat, list[i])) {
                    tiers[i].push(row.id);
                    return;
                }
            }
            unassigned.push(row.id);
        });
        return { tiers: tiers, unassigned: unassigned };
    }

    function quantileCut(sortedAsc, p) {
        if (!sortedAsc.length) return null;
        const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(p * (sortedAsc.length - 1))));
        return sortedAsc[idx];
    }

    /** High band first. The last tier is the open remainder. */
    function defaultRanges(members, bsMap, tierCount) {
        const n = clampTierCount(tierCount);
        const stats = memberRows(members, bsMap)
            .map(function (row) { return row.stat; })
            .filter(function (v) { return v != null; })
            .sort(function (a, b) { return a - b; });
        const ranges = [];
        for (let i = 0; i < n; i++) {
            if (!stats.length || i === n - 1) {
                ranges.push({ min: null, max: null });
                continue;
            }
            const p = (n - 1 - i) / n;
            ranges.push({ min: quantileCut(stats, p), max: null });
        }
        return ranges;
    }

    function rangesConfigured(ranges) {
        if (!Array.isArray(ranges) || !ranges.length) return false;
        return ranges.some(function (r) {
            return r && (r.min != null || r.max != null);
        });
    }

    function emptySide(tierCount, method) {
        const n = clampTierCount(tierCount);
        const ranges = [];
        const tiers = [];
        for (let i = 0; i < n; i++) {
            ranges.push({ min: null, max: null });
            tiers.push([]);
        }
        return { method: normalizeMethod(method), ranges: ranges, tiers: tiers };
    }

    function resizeSide(side, tierCount) {
        const n = clampTierCount(tierCount);
        const next = emptySide(n, side && side.method);
        const prevRanges = side && Array.isArray(side.ranges) ? side.ranges : [];
        const prevTiers = side && Array.isArray(side.tiers) ? side.tiers : [];
        for (let i = 0; i < n; i++) {
            if (prevRanges[i]) {
                next.ranges[i] = {
                    min: prevRanges[i].min != null ? prevRanges[i].min : null,
                    max: prevRanges[i].max != null ? prevRanges[i].max : null
                };
            }
            if (Array.isArray(prevTiers[i])) next.tiers[i] = prevTiers[i].map(String);
        }
        return next;
    }

    function parseStatInput(raw) {
        const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
        if (!s) return null;
        const m = s.match(/^(\d+(?:\.\d+)?)([kmbt])?$/);
        if (!m) return null;
        const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]] || 1;
        const n = Number(m[1]) * mult;
        if (!Number.isFinite(n) || n < 0) return null;
        return n;
    }

    function formatStat(n, precise) {
        if (n == null || !Number.isFinite(Number(n))) return '—';
        const v = Number(n);
        const abs = Math.abs(v);
        function trim(x, places) {
            const factor = places > 0 ? Math.pow(10, places) : 1;
            const rounded = Math.round(x * factor) / factor;
            return String(rounded).replace(/\.0$/, '');
        }
        const big = precise ? 2 : 1;
        const small = precise ? 2 : 0;
        let scaled = v;
        let suffix = '';
        let places = 0;
        if (abs >= 1e12) {
            scaled = v / 1e12;
            suffix = 't';
            places = big;
        } else if (abs >= 1e9) {
            scaled = v / 1e9;
            suffix = 'b';
            places = big;
        } else if (abs >= 1e6) {
            scaled = v / 1e6;
            suffix = 'm';
            places = small;
        } else if (abs >= 1e3) {
            scaled = v / 1e3;
            suffix = 'k';
            places = small;
        } else {
            return String(Math.round(v));
        }
        const oneDecimal = Math.round(scaled * 10) / 10;
        if (!precise && Math.abs(oneDecimal) < 10) return oneDecimal.toFixed(1) + suffix;
        return trim(scaled, places) + suffix;
    }

    function formatStatInput(n) {
        if (n == null || !Number.isFinite(Number(n))) return '';
        return formatStat(n, true);
    }

    return {
        METHODS: METHODS,
        MIN_TIERS: MIN_TIERS,
        MAX_TIERS: MAX_TIERS,
        DEFAULT_TIERS: DEFAULT_TIERS,
        clampTierCount: clampTierCount,
        normalizeMethod: normalizeMethod,
        statOf: statOf,
        compareStatDesc: compareStatDesc,
        memberRows: memberRows,
        equalSplit: equalSplit,
        applyRanges: applyRanges,
        defaultRanges: defaultRanges,
        rangesConfigured: rangesConfigured,
        emptySide: emptySide,
        resizeSide: resizeSide,
        parseStatInput: parseStatInput,
        formatStat: formatStat,
        formatStatInput: formatStatInput
    };
});
