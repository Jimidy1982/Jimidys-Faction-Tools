/**
 * Member Performance — OC score (same participation formula as Organised Crime Stats),
 * war/outside hits (`mpr-war-chain-hits.js`), activity hours (timeplayed delta), consumption cost.
 */
(function () {
    'use strict';

    const MPR_CONSUMPTION_KEYS = [
        { id: 'xanax', itemName: 'Xanax', isPoints: false },
        { id: 'vicodin', itemName: 'Vicodin', isPoints: false },
        { id: 'ketamine', itemName: 'Ketamine', isPoints: false },
        { id: 'speed', itemName: 'Speed', isPoints: false },
        { id: 'shrooms', itemName: 'Shrooms', isPoints: false },
        { id: 'cannabis', itemName: 'Cannabis', isPoints: false },
        { id: 'pcp', itemName: 'PCP', isPoints: false },
        { id: 'opium', itemName: 'Opium', isPoints: false },
        { id: 'ecstasy', itemName: 'Ecstasy', isPoints: false },
        { id: 'lsd', itemName: 'LSD', isPoints: false },
        { id: 'loveJuice', itemName: 'Love Juice', isPoints: false },
        { id: 'bloodbags', itemName: 'Blood Bag', isPoints: false },
        { id: 'firstAidKit', itemName: 'First Aid Kit', isPoints: false },
        { id: 'smallFirstAidKit', itemName: 'Small First Aid Kit', isPoints: false },
        { id: 'morphine', itemName: 'Morphine', isPoints: false },
        { id: 'ipecacSyrup', itemName: 'Ipecac Syrup', isPoints: false },
        { id: 'beer', itemName: 'Bottle of Beer', isPoints: false },
        { id: 'lollipop', itemName: 'Lollipop', isPoints: false },
        { id: 'sweetHearts', itemName: 'Box of Sweet Hearts', isPoints: false },
        { id: 'gooseJuice', itemName: 'Can of Goose Juice', isPoints: false },
        { id: 'dampValley', itemName: 'Can of Damp Valley', isPoints: false },
        { id: 'crocozade', itemName: 'Can of Crocozade', isPoints: false },
        { id: 'santaShooters', itemName: 'Can of Santa Shooters', isPoints: false },
        { id: 'munster', itemName: 'Can of Munster', isPoints: false },
        { id: 'redCow', itemName: 'Can of Red Cow', isPoints: false },
        { id: 'rockstarRudolph', itemName: 'Can of Rockstar Rudolph', isPoints: false },
        { id: 'taurineElite', itemName: 'Can of Taurine Elite', isPoints: false },
        { id: 'xmass', itemName: 'Can of X-MASS', isPoints: false },
        { id: 'points', itemName: 'Points', isPoints: true }
    ];

    const MPR_SORT_LS_KEY = 'mpr_member_performance_sort_v1';
    const MPR_SORT_VALID_COLUMNS = new Set([
        'name',
        'daysInFaction',
        'estimatedStats',
        'crimeScore',
        'ocHighestSuccess',
        'ocEarnings',
        'ocFactionCut',
        'warHits',
        'outsideHits',
        'warAvgRespectPerHit',
        'outsideAvgRespectPerHit',
        'activityHours',
        'lastOnline',
        'consumptionCost',
        'overallRanking'
    ]);

    function mprLoadSortPreference() {
        const def = { column: 'crimeScore', direction: 'desc' };
        try {
            const raw = localStorage.getItem(MPR_SORT_LS_KEY);
            if (!raw) return def;
            const o = JSON.parse(raw);
            let col = o.column;
            if (col === 'ocSuccessPct') col = 'ocHighestSuccess';
            const dir = o.direction === 'asc' ? 'asc' : 'desc';
            if (typeof col === 'string' && MPR_SORT_VALID_COLUMNS.has(col)) return { column: col, direction: dir };
        } catch (e) {
            /* ignore */
        }
        return def;
    }

    function mprPersistSortPreference() {
        try {
            localStorage.setItem(
                MPR_SORT_LS_KEY,
                JSON.stringify({ column: mprSortState.column, direction: mprSortState.direction })
            );
        } catch (e) {
            /* quota */
        }
    }

    let mprSortState = mprLoadSortPreference();
    let mprLastRows = [];
    /** Set after a successful fetch so changing faction cut % can recompute OC $ columns without refetching. */
    let mprRedoContext = null;
    /** Faction name, tool label, and TCT range line for “Copy table” (faction mail). Cleared when a new fetch starts. */
    let mprLastReportCopyMeta = null;
    /** Set after each fetch when FF Scouter estimates are missing for a setup reason (not per-player gaps). */
    let mprFfScouterIssueState = null;

    const MPR_FF_SCOUTER_URL = 'https://ffscouter.com';
    const MPR_TOOL_DISPLAY_NAME = 'Member Performance';

    /** Best-effort faction name from v2/faction/members payload (shape varies by API version). */
    function mprFactionNameFromMembersData(memData) {
        if (!memData || typeof memData !== 'object') return '';
        const m = memData;
        const tryStr = v => {
            if (v == null) return '';
            const s = String(v).trim();
            return s && s !== '[object Object]' ? s : '';
        };
        const cands = [
            tryStr(m.faction && m.faction.name),
            tryStr(m.faction && m.faction.basic && m.faction.basic.name),
            tryStr(m.faction_name),
            tryStr(m.name),
            Array.isArray(m.members) && m.members[0]
                ? tryStr(m.members[0].faction && m.members[0].faction.name)
                : ''
        ];
        for (const s of cands) {
            if (s) return s;
        }
        return '';
    }

    const MPR_LS_FACTION_CUT = 'mprFactionCutPercent';
    const MPR_COLUMN_LS_KEY = 'mpr_member_performance_columns_v1';
    const MPR_DISPLAY_LS_KEY = 'mpr_member_performance_display_v1';
    const MPR_RANKING_LS_KEY = 'mpr_overall_ranking_prefs_v1';

    const MPR_RANKING_METRICS = [
        { id: 'totalHits', label: 'Total hits' },
        { id: 'crimeScore', label: 'Crime score' },
        { id: 'activityHours', label: 'Activity (h)' },
        { id: 'battleStats', label: 'Battle stats' },
        { id: 'avgRespectWarChain', label: 'Avg respect / hit (war & chain)' }
    ];

    function mprDefaultDisplayPrefs() {
        return { stickyMemberColumn: true };
    }

    function mprLoadDisplayPrefs() {
        const def = mprDefaultDisplayPrefs();
        try {
            const raw = localStorage.getItem(MPR_DISPLAY_LS_KEY);
            if (!raw) return { ...def };
            const o = JSON.parse(raw);
            if (!o || typeof o !== 'object') return { ...def };
            return {
                stickyMemberColumn: typeof o.stickyMemberColumn === 'boolean' ? o.stickyMemberColumn : def.stickyMemberColumn
            };
        } catch (e) {
            return { ...def };
        }
    }

    function mprPersistDisplayPrefs() {
        try {
            localStorage.setItem(MPR_DISPLAY_LS_KEY, JSON.stringify(mprDisplayPrefs));
        } catch (e) {
            /* quota */
        }
    }

    let mprDisplayPrefs = mprLoadDisplayPrefs();

    function mprDashCell() {
        return '<span style="color:#888">0</span>';
    }

    function mprApplyStickyMemberClass() {
        const el = document.getElementById('mprTableScrollMain');
        if (!el) return;
        if (mprDisplayPrefs && mprDisplayPrefs.stickyMemberColumn) el.classList.add('mpr-sticky-member-on');
        else el.classList.remove('mpr-sticky-member-on');
    }

    function mprUpdateDualScrollMetrics() {
        const main = document.getElementById('mprTableScrollMain');
        const top = document.getElementById('mprTableScrollTop');
        const inner = document.getElementById('mprTableScrollTopInner');
        const wrap = document.getElementById('mprTableWrap');
        if (!main || !top || !inner || !wrap) return;
        const sw = Math.max(wrap.scrollWidth || 0, main.scrollWidth || 0, 1);
        inner.style.width = `${sw}px`;
        inner.style.minWidth = `${sw}px`;
        inner.style.height = '1px';
        const overflow = sw > main.clientWidth + 2;
        top.style.display = overflow ? 'block' : 'none';
        if (overflow) {
            requestAnimationFrame(() => {
                top.scrollLeft = main.scrollLeft;
            });
        }
        main.classList.toggle('mpr-table-hscroll--grab', overflow);
    }

    function mprWireDualHScrollAndDrag() {
        const main = document.getElementById('mprTableScrollMain');
        const top = document.getElementById('mprTableScrollTop');
        const inner = document.getElementById('mprTableScrollTopInner');
        const wrap = document.getElementById('mprTableWrap');
        if (!main || !top || !inner || !wrap || main.dataset.mprHScrollWired === '1') return;
        main.dataset.mprHScrollWired = '1';

        let mprHScrollProg = false;
        const syncTopFromMain = () => {
            if (mprHScrollProg) return;
            mprHScrollProg = true;
            top.scrollLeft = main.scrollLeft;
            mprHScrollProg = false;
        };
        const syncMainFromTop = () => {
            if (mprHScrollProg) return;
            mprHScrollProg = true;
            main.scrollLeft = top.scrollLeft;
            mprHScrollProg = false;
        };
        main.addEventListener('scroll', syncTopFromMain, { passive: true });
        top.addEventListener('scroll', syncMainFromTop, { passive: true });

        let roResizeT = null;
        const scheduleMetrics = () => {
            if (roResizeT) cancelAnimationFrame(roResizeT);
            roResizeT = requestAnimationFrame(() => {
                roResizeT = null;
                mprUpdateDualScrollMetrics();
            });
        };
        const ro = new ResizeObserver(scheduleMetrics);
        ro.observe(wrap);
        ro.observe(main);

        let winT;
        window.addEventListener('resize', () => {
            clearTimeout(winT);
            winT = setTimeout(mprUpdateDualScrollMetrics, 120);
        });

        let drag = false;
        let dragStartX = 0;
        let dragStartScroll = 0;
        main.addEventListener('mousedown', ev => {
            if (ev.button !== 0) return;
            if (main.scrollWidth <= main.clientWidth + 2) return;
            if (
                ev.target.closest(
                    'a,button,input,select,textarea,summary,label,[role="button"],.tools-member-id-cb-label,th'
                )
            ) {
                return;
            }
            drag = true;
            dragStartX = ev.pageX;
            dragStartScroll = main.scrollLeft;
            main.classList.add('mpr-table-hscroll--grabbing');
            document.body.style.userSelect = 'none';
            ev.preventDefault();
        });
        document.addEventListener(
            'mousemove',
            ev => {
                if (!drag) return;
                main.scrollLeft = dragStartScroll - (ev.pageX - dragStartX);
            },
            { passive: true }
        );
        document.addEventListener('mouseup', () => {
            if (!drag) return;
            drag = false;
            main.classList.remove('mpr-table-hscroll--grabbing');
            document.body.style.userSelect = '';
        });

        mprUpdateDualScrollMetrics();
    }

    const MPR_COLUMN_META = [
        {
            id: 'overallRanking',
            label: 'Overall rank',
            group: 'ranking',
            tip: 'Combined rank for this roster. Open Breakdown for each metric.'
        },
        {
            id: 'estimatedStats',
            label: 'Estimated stats',
            group: 'intel',
            tip: 'Battle stats estimate from FF Scouter. Register your API key at ffscouter.com if this stays blank.'
        },
        {
            id: 'crimeScore',
            label: 'OC score',
            group: 'oc',
            tip: 'OC participation score for the range. Open Details for a per-difficulty view.'
        },
        {
            id: 'ocHighestSuccess',
            label: 'Highest OC',
            group: 'oc',
            defaultVisible: false,
            tip: 'Highest OC difficulty this member completed successfully in the range.'
        },
        {
            id: 'ocEarnings',
            label: 'OC est. earnings',
            group: 'oc',
            defaultVisible: false,
            tip: 'Rough share of successful OC rewards (cash and priced items), after faction cut %.'
        },
        {
            id: 'ocFactionCut',
            label: 'OC faction cut (est.)',
            group: 'oc',
            defaultVisible: false,
            tip: 'Rough faction share of the same OC rewards, using the cut % in Table options.'
        },
        {
            id: 'warHits',
            label: 'War hits',
            group: 'war',
            tip: 'Ranked-war report attacks, plus chain “war” hits on chains whose time range does not overlap a ranked war in this fetch (territory/raid). Respect for those uses member chain respect × (war hits ÷ total chain hits).'
        },
        {
            id: 'outsideHits',
            label: 'Outside hits',
            group: 'war',
            tip: 'Outside hits in the selected range. See the note above the table if limits apply.'
        },
        {
            id: 'warAvgRespectPerHit',
            label: 'Avg respect / war hit',
            group: 'war',
            defaultVisible: false,
            tip: 'Ranked war report score/respect, minus chain milestone strip max(0, R−10) on war-enemy bonus lines.'
        },
        {
            id: 'outsideAvgRespectPerHit',
            label: 'Avg respect / outside hit',
            group: 'war',
            defaultVisible: false,
            tip: 'Chain reports: respect × (outside chain hits ÷ chain attacks), summed; then minus milestone strip on outside-class bonus lines.'
        },
        {
            id: 'activityHours',
            label: 'Activity (h)',
            group: 'intel',
            tip: 'Hours played in the range (from timeplayed snapshots).'
        },
        {
            id: 'daysInFaction',
            label: 'Days in faction',
            group: 'intel',
            defaultVisible: false,
            tip: 'Days in this faction at the end of the range (from members data or join date).'
        },
        {
            id: 'lastOnline',
            label: 'Last online',
            group: 'intel',
            defaultVisible: false,
            tip: 'Last activity from faction members (TCT where available).'
        },
        {
            id: 'consumptionCost',
            label: 'Consumption $',
            group: 'war',
            tip: 'Armory usage in the range, priced from this fetch. Open Details for line items.'
        }
    ];

    const MPR_COLUMN_GROUP_ORDER = ['ranking', 'oc', 'intel', 'war'];
    const MPR_COLUMN_GROUP_LABELS = {
        ranking: 'Overall ranking',
        oc: 'Organised crime',
        intel: 'Stats & activity',
        war: 'War & armory'
    };
    const MPR_COLUMN_GROUP_TIPS = {
        ranking: 'Show or hide the blended overall rank column.',
        oc: 'Toggle OC participation, peak success difficulty, and money estimates (faction cut % applies only to the $ columns).',
        intel: 'Toggle estimated battle stats, days in faction, last online, and timeplayed-based activity hours.',
        war: 'Toggle war and armory columns, including optional respect averages.'
    };

    const MPR_MEMBER_HEADER_TIP =
        'Member name (opens profile). Click to sort. Toggle [player ID] in the header.';
    const MPR_TABLE_OPTIONS_SUMMARY_TIP =
        'Columns, overall ranking, OC cut %, and display options. Saved in this browser.';
    const MPR_COLUMN_VISIBILITY_HEADING_TIP =
        'Choose which data columns appear in the roster. Your checkboxes are saved locally in this browser.';
    const MPR_FACTION_CUT_INPUT_TIP =
        'Faction share of successful OC rewards before the rest is split to participants. Only affects the two OC $ columns; OC score is unchanged. Saved locally.';
    const MPR_DISPLAY_SECTION_TIP =
        'Layout for the roster table. Saved in this browser together with your other table options.';
    const MPR_DISPLAY_STICKY_TIP =
        'Pins the Member column on the left with a shadow so names stay visible when you scroll wide tables horizontally.';
    const MPR_OVERALL_RANKING_HEADING_TIP =
        'Tick the stats to include in the overall score. Breakdown shows rank in each area; excluded lines are not part of the blend.';

    function mprDefaultRankingPrefs() {
        const o = {};
        MPR_RANKING_METRICS.forEach(m => {
            o[m.id] = true;
        });
        return o;
    }

    function mprLoadRankingPrefs() {
        const def = mprDefaultRankingPrefs();
        try {
            const raw = localStorage.getItem(MPR_RANKING_LS_KEY);
            if (!raw) return def;
            const p = JSON.parse(raw);
            if (!p || typeof p !== 'object') return def;
            MPR_RANKING_METRICS.forEach(m => {
                if (Object.prototype.hasOwnProperty.call(p, m.id)) def[m.id] = !!p[m.id];
            });
            return def;
        } catch (e) {
            return def;
        }
    }

    function mprPersistRankingPrefs(prefs) {
        try {
            localStorage.setItem(MPR_RANKING_LS_KEY, JSON.stringify(prefs));
        } catch (e) {
            /* quota */
        }
    }

    function mprRankingPrefsFromUI() {
        const p = mprLoadRankingPrefs();
        const root = document.getElementById('mprOverallRankingWrap');
        if (!root) return p;
        root.querySelectorAll('input[data-mpr-ranking-metric]').forEach(inp => {
            const k = inp.getAttribute('data-mpr-ranking-metric');
            if (k && Object.prototype.hasOwnProperty.call(p, k)) p[k] = !!inp.checked;
        });
        return p;
    }

    function mprSyncOverallRankingCheckboxes() {
        const prefs = mprLoadRankingPrefs();
        const root = document.getElementById('mprOverallRankingWrap');
        if (!root) return;
        root.querySelectorAll('input[data-mpr-ranking-metric]').forEach(inp => {
            const k = inp.getAttribute('data-mpr-ranking-metric');
            if (k && Object.prototype.hasOwnProperty.call(prefs, k)) inp.checked = !!prefs[k];
        });
    }

    function mprRowRankingRaw(row, metricId) {
        if (!row || typeof row !== 'object') return null;
        switch (metricId) {
            case 'totalHits':
                if (row.warHits == null || row.outsideHits == null) return null;
                return Number(row.warHits) + Number(row.outsideHits);
            case 'crimeScore':
                return row.crimeScore != null && !Number.isNaN(Number(row.crimeScore)) ? Number(row.crimeScore) : null;
            case 'activityHours':
                if (row.activityPending) return null;
                return row.activityHours != null && !Number.isNaN(Number(row.activityHours))
                    ? Number(row.activityHours)
                    : null;
            case 'battleStats':
                if (row.estimatedStatsSort == null || row.estimatedStatsSort === -Infinity) return null;
                return row.estimatedStatsSort;
            case 'avgRespectWarChain':
                return row.avgRespectWarChain != null && !Number.isNaN(Number(row.avgRespectWarChain))
                    ? Number(row.avgRespectWarChain)
                    : null;
            default:
                return null;
        }
    }

    /** Competition ranking: higher value = better; rank 1 is best. Skips null / non-finite. */
    function mprCompetitionRanksDescending(pairs) {
        const valid = pairs.filter(x => x.v != null && Number.isFinite(x.v));
        valid.sort((a, b) => b.v - a.v);
        const map = new Map();
        let i = 0;
        while (i < valid.length) {
            const val = valid[i].v;
            let j = i;
            while (j < valid.length && valid[j].v === val) j++;
            const rank = i + 1;
            for (let k = i; k < j; k++) map.set(valid[k].id, rank);
            i = j;
        }
        return map;
    }

    function mprFormatRankingMetricDisplay(metricId, raw) {
        if (raw == null || !Number.isFinite(raw)) return '0';
        switch (metricId) {
            case 'totalHits':
                return String(Math.round(raw));
            case 'crimeScore':
                return String(Math.round(raw * 10) / 10);
            case 'activityHours':
                return raw.toFixed(1);
            case 'battleStats':
                return Number(raw).toLocaleString();
            case 'avgRespectWarChain':
                return raw.toFixed(3);
            default:
                return String(raw);
        }
    }

    function mprApplyOverallRanking(rows) {
        if (!Array.isArray(rows) || !rows.length) return;
        const prefs = mprRankingPrefsFromUI();
        const metricIds = MPR_RANKING_METRICS.map(m => m.id);
        const byMetricRanks = {};
        const byMetricNorm = {};

        metricIds.forEach(mid => {
            const pairs = rows.map(r => ({ id: r.id, v: mprRowRankingRaw(r, mid) }));
            byMetricRanks[mid] = mprCompetitionRanksDescending(pairs);
            const vals = pairs.map(x => x.v).filter(v => v != null && Number.isFinite(v));
            const lo = vals.length ? Math.min(...vals) : 0;
            const hi = vals.length ? Math.max(...vals) : 0;
            byMetricNorm[mid] = v => {
                if (v == null || !Number.isFinite(v)) return null;
                if (hi <= lo) return 0.5;
                return (v - lo) / (hi - lo);
            };
        });

        const compositeById = new Map();
        rows.forEach(r => {
            let sum = 0;
            let n = 0;
            metricIds.forEach(mid => {
                if (!prefs[mid]) return;
                const raw = mprRowRankingRaw(r, mid);
                const nv = byMetricNorm[mid](raw);
                if (nv != null) {
                    sum += nv;
                    n++;
                }
            });
            compositeById.set(r.id, n > 0 ? sum / n : null);
        });

        const overallRankMap = mprCompetitionRanksDescending(
            rows.map(r => ({ id: r.id, v: compositeById.get(r.id) })).filter(x => x.v != null)
        );

        rows.forEach(r => {
            const comp = compositeById.get(r.id);
            r.overallComposite = comp;
            r.overallRank = comp == null ? null : overallRankMap.get(r.id) || null;
            const breakdown = {};
            metricIds.forEach(mid => {
                const raw = mprRowRankingRaw(r, mid);
                breakdown[mid] = {
                    rank: byMetricRanks[mid].get(r.id) ?? null,
                    valueLabel: mprFormatRankingMetricDisplay(mid, raw),
                    inComposite: !!prefs[mid]
                };
            });
            r.overallRankBreakdown = breakdown;
        });
    }

    /** Defaults when `MPR_COLUMN_LS_KEY` has no saved object (first visit or cleared storage). */
    function mprDefaultColumnVisibility() {
        const o = {};
        MPR_COLUMN_META.forEach(c => {
            o[c.id] = c.defaultVisible === false ? false : true;
        });
        return o;
    }

    function mprLoadColumnVisibility() {
        const base = mprDefaultColumnVisibility();
        try {
            const raw = localStorage.getItem(MPR_COLUMN_LS_KEY);
            if (!raw) return base;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return base;
            MPR_COLUMN_META.forEach(c => {
                if (Object.prototype.hasOwnProperty.call(parsed, c.id)) base[c.id] = !!parsed[c.id];
            });
            if (Object.prototype.hasOwnProperty.call(parsed, 'ocSuccessPct') && !Object.prototype.hasOwnProperty.call(parsed, 'ocHighestSuccess')) {
                base.ocHighestSuccess = !!parsed.ocSuccessPct;
            }
            return base;
        } catch (e) {
            return base;
        }
    }

    function mprPersistColumnVisibility() {
        try {
            localStorage.setItem(MPR_COLUMN_LS_KEY, JSON.stringify(mprColumnVisibility));
        } catch (e) {
            /* quota */
        }
    }

    let mprColumnVisibility = mprLoadColumnVisibility();
    const MPR_ACTIVITY_RETRY_DELAY_MS = 2000;

    /** localStorage: timeplayed snapshots for Member Performance (separate from Battle Stats keys). */
    const MPR_TIMEPLAYED_LS_KEY = 'mpr_timeplayed_snapshots_v1';
    /** Whole timeplayed blob dropped after this age on read (last persist refreshes `cachedAt`). Longer = fewer refetches; ~5MB localStorage cap still applies. */
    const MPR_TIMEPLAYED_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    /** If we already have this player’s timeplayed at a unix time within ±this many seconds, reuse it for the requested snapshot (fewer Torn calls). */
    const MPR_TIMEPLAYED_TIMESTAMP_SLACK_SEC = 12 * 60 * 60;

    /**
     * Armory news: v2 segment cache — each batch is one exhaustive API run over [qFrom,qTo] (inclusive unix).
     * New ranges reuse overlapping batches and only call Torn for gaps (split gaps get separate batch ids).
     */
    const MPR_NEWS_CACHE_LS_KEY = 'mpr_armory_news_segments_v2';
    const MPR_NEWS_SEGMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const MPR_NEWS_MAX_BATCHES_PER_KEY = 56;

    const MPR_CHECKLIST_STEPS = [
        { id: 'members', label: 'Faction members (v2)' },
        { id: 'crimes', label: 'Completed crimes in date range (OC)' },
        { id: 'items', label: 'Item market values + points market' },
        { id: 'news', label: 'Faction armory news (consumption)' },
        { id: 'war', label: 'Ranked wars & chain reports (hits)' },
        { id: 'ffscout', label: 'Estimated stats (FF Scouter)' },
        { id: 'activity', label: 'Activity (timeplayed snapshots)' }
    ];

    function mprGetProgressEls() {
        return {
            progressMessage: document.getElementById('mprProgressMessage'),
            progressDetails: document.getElementById('mprProgressDetails'),
            progressPercentage: document.getElementById('mprProgressPercentage'),
            progressFill: document.getElementById('mprProgressFill')
        };
    }

    function mprChecklistEnsure() {
        const ul = document.getElementById('mprChecklist');
        if (!ul) return null;
        const stepLis = ul.querySelectorAll('[data-mpr-step]');
        if (!ul.dataset.mprBuilt || stepLis.length !== MPR_CHECKLIST_STEPS.length) {
            ul.innerHTML = MPR_CHECKLIST_STEPS.map(
                s => `<li data-mpr-step="${s.id}" class="mpr-check mpr-check--pending">${mprEscapeHtml(s.label)}</li>`
            ).join('');
            ul.dataset.mprBuilt = '1';
        }
        return ul;
    }

    function mprChecklistReset() {
        const ul = mprChecklistEnsure();
        if (!ul) return;
        ul.querySelectorAll('[data-mpr-step]').forEach(li => {
            li.className = 'mpr-check mpr-check--pending';
        });
    }

    function mprChecklistSet(stepId, status) {
        const ul = document.getElementById('mprChecklist');
        if (!ul) return;
        const li = ul.querySelector(`[data-mpr-step="${stepId}"]`);
        if (!li) return;
        const label = MPR_CHECKLIST_STEPS.find(s => s.id === stepId);
        const text = label ? label.label : stepId;
        li.className = 'mpr-check mpr-check--' + status;
        li.textContent = text;
    }

    /** Same rate limits & countdown UX as the welcome panel (fetchWithRateLimit). */
    async function mprApiJson(url, progressEls) {
        const els = progressEls || mprGetProgressEls();
        if (typeof window.fetchWithRateLimit === 'function') {
            return window.fetchWithRateLimit(url, {
                progressMessage: els.progressMessage,
                progressDetails: els.progressDetails,
                retryOnRateLimit: true
            });
        }
        const tornUrl = typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(url) : url;
        const res = await fetch(tornUrl);
        return res.json();
    }

    function mprParseUnixLoose(val) {
        if (val == null || val === '') return null;
        if (typeof val === 'number' && !isNaN(val) && val > 1e9 && val < 2e10) return Math.floor(val);
        const s = String(val).trim();
        const digits = parseInt(s.replace(/\D/g, '') || '0', 10);
        if (!isNaN(digits) && digits > 1e9 && digits < 2e10) return digits;
        return null;
    }

    /** Days in current faction from API fields when present, else from faction join timestamp. */
    function mprDaysInFaction(member, nowTs) {
        const n = Math.floor(Number(nowTs) || Date.now() / 1000);
        if (!member || typeof member !== 'object') return null;
        const direct =
            member.days_in_faction ??
            member.days_in_faction_member ??
            (member.faction && (member.faction.days_in_faction ?? member.faction.days_in_faction_member));
        if (direct != null && String(direct).trim() !== '') {
            const d = parseInt(String(direct).replace(/[^\d-]/g, ''), 10);
            if (!isNaN(d) && d >= 0 && d < 50000) return d;
        }
        const joined =
            mprParseUnixLoose(member.joined_faction) ||
            mprParseUnixLoose(member.faction && member.faction.joined) ||
            mprParseUnixLoose(member.faction && member.faction.timestamp);
        if (joined != null) return Math.max(0, Math.floor((n - joined) / 86400));
        return null;
    }

    /** From v2/faction/members `last_action` (same fields as War Dashboard / battle stats). */
    function mprFormatRelativeFromUnixSeconds(ts) {
        const now = Math.floor(Date.now() / 1000);
        const diff = Math.max(0, now - ts);
        const days = Math.floor(diff / 86400);
        if (days === 0) return 'Today';
        if (days === 1) return '1 day ago';
        return `${days} days ago`;
    }

    /** FF Scouter `bs_estimate` — same source as Faction Battle Stats. */
    function mprNormalizeBsEstimate(val) {
        if (val == null || val === '' || val === 'N/A') return null;
        if (typeof val === 'number' && !isNaN(val)) return val;
        const n = parseFloat(String(val).replace(/,/g, ''));
        return typeof n === 'number' && !isNaN(n) ? n : null;
    }

    function mprLastOnlineFromMember(m) {
        const la = (m && m.last_action) || {};
        const ts = la.timestamp != null ? Number(la.timestamp) : null;
        const tsOk = ts != null && !isNaN(ts) && ts > 0;
        const relative = la.relative != null ? String(la.relative).trim() : '';
        const statusRaw = la.status != null ? String(la.status).trim() : '';
        const status = statusRaw.toLowerCase();
        let display = relative;
        if (!display && tsOk) display = mprFormatRelativeFromUnixSeconds(ts);
        if (!display && statusRaw) display = statusRaw.charAt(0).toUpperCase() + statusRaw.slice(1).toLowerCase();
        if (!display) display = '0';
        let sortVal = tsOk ? ts : 0;
        if (!tsOk && (status === 'online' || status === 'idle')) sortVal = Math.floor(Date.now() / 1000);
        const title = tsOk ? mprFormatTctUtc(ts) : (relative || statusRaw || '').trim();
        return { sortVal, display, title };
    }

    function mprParseYmd(ymd) {
        if (!ymd || typeof ymd !== 'string') return null;
        const p = ymd.split('-').map(Number);
        if (p.length !== 3 || p.some(n => !Number.isFinite(n))) return null;
        return { y: p[0], m: p[1] - 1, d: p[2] };
    }

    function mprClampInt(n, lo, hi, fallback) {
        const x = Math.floor(Number(n));
        if (!Number.isFinite(x)) return fallback;
        return Math.max(lo, Math.min(hi, x));
    }

    function mprTctInstantUnix(ymd, hour, minute, second) {
        const parts = mprParseYmd(ymd);
        if (!parts) return null;
        const h = mprClampInt(hour, 0, 23, 0);
        const m = mprClampInt(minute, 0, 59, 0);
        const s = mprClampInt(second, 0, 59, 0);
        return Math.floor(Date.UTC(parts.y, parts.m, parts.d, h, m, s) / 1000);
    }

    function mprFormatTctUtc(ts) {
        return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' TCT';
    }

    function mprUtcYmd() {
        const t = new Date();
        const y = t.getUTCFullYear();
        const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
        const d = String(t.getUTCDate()).padStart(2, '0');
        return `${y}-${mo}-${d}`;
    }

    function mprFillHmsSelect(sel, isHour) {
        if (!sel) return;
        sel.innerHTML = '';
        const max = isHour ? 23 : 59;
        for (let i = 0; i <= max; i++) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = String(i).padStart(2, '0');
            sel.appendChild(opt);
        }
    }

    function mprPopulateTctTimeSelects() {
        const root = document.getElementById('mprTctTimesRoot');
        if (root && root.dataset.mprTctPopulated === '1') {
            return;
        }

        const startH = document.getElementById('mprStartHourTCT');
        const startM = document.getElementById('mprStartMinTCT');
        const startS = document.getElementById('mprStartSecTCT');
        const endH = document.getElementById('mprEndHourTCT');
        const endM = document.getElementById('mprEndMinTCT');
        const endS = document.getElementById('mprEndSecTCT');
        if (!startH || !startM || !startS || !endH || !endM || !endS) return;

        mprFillHmsSelect(startH, true);
        mprFillHmsSelect(startM, false);
        mprFillHmsSelect(startS, false);
        mprFillHmsSelect(endH, true);
        mprFillHmsSelect(endM, false);
        mprFillHmsSelect(endS, false);

        startH.value = '0';
        startM.value = '0';
        startS.value = '0';
        endH.value = '23';
        endM.value = '59';
        endS.value = '59';

        if (root) root.dataset.mprTctPopulated = '1';
    }

    function mprUseExactTimesDesired() {
        const cb = document.getElementById('mprExactRangeTimes');
        return !!(cb && cb.checked && window.consumptionExactWarTimesVipUnlocked);
    }

    function mprSyncHmsSectionVisibility() {
        const wrap = document.getElementById('mprExactTimesDetail');
        const desired = mprUseExactTimesDesired();
        if (wrap) {
            if (desired) {
                wrap.removeAttribute('hidden');
                mprPopulateTctTimeSelects();
            } else {
                wrap.setAttribute('hidden', 'hidden');
            }
        }
    }

    function mprUpdateExactTimesVipUI() {
        const en = document.getElementById('mprExactTimesEnabled');
        const cb = document.getElementById('mprExactRangeTimes');
        if (en) en.style.display = 'block';
        if (cb) cb.disabled = false;
        mprSyncHmsSectionVisibility();
    }

    function mprReadHmsFromSelects(startHourId, startMinId, startSecId) {
        const hEl = document.getElementById(startHourId);
        const mEl = document.getElementById(startMinId);
        const sEl = document.getElementById(startSecId);
        if (!hEl || !mEl || !sEl) return { h: 0, m: 0, s: 0 };
        return {
            h: mprClampInt(parseInt(hEl.value, 10), 0, 23, 0),
            m: mprClampInt(parseInt(mEl.value, 10), 0, 59, 0),
            s: mprClampInt(parseInt(sEl.value, 10), 0, 59, 0)
        };
    }

    /** `daysInclusive` calendar days in TCT ending today, matching full-day fetch bounds. */
    function mprApplyQuickRangeDaysInclusive(daysInclusive) {
        const n = Math.min(366, Math.max(1, Math.floor(Number(daysInclusive)) || 1));
        const now = new Date();
        const y = now.getUTCFullYear();
        const mo = now.getUTCMonth();
        const d = now.getUTCDate();
        const endUtc = new Date(Date.UTC(y, mo, d));
        const startUtc = new Date(Date.UTC(y, mo, d));
        startUtc.setUTCDate(startUtc.getUTCDate() - (n - 1));
        const toYmd = dt => dt.toISOString().slice(0, 10);
        const endYmd = toYmd(endUtc);
        const startYmd = toYmd(startUtc);
        const startInput = document.getElementById('mprStartDate');
        const endInput = document.getElementById('mprEndDate');
        if (startInput) {
            if (startInput._flatpickr) startInput._flatpickr.setDate(startYmd, false);
            else startInput.value = startYmd;
        }
        if (endInput) {
            if (endInput._flatpickr) endInput._flatpickr.setDate(endYmd, false);
            else endInput.value = endYmd;
        }
    }

    function mprEscapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function mprFfScouterLinkHtml() {
        return `<a href="${MPR_FF_SCOUTER_URL}" target="_blank" rel="noopener noreferrer" style="color:#ffd700;text-decoration:underline;">FFScouter</a>`;
    }

    function mprClassifyFfScouterFailure(err) {
        const msg = err && err.message ? String(err.message) : '';
        if (/not registered|register your api key/i.test(msg)) {
            return { type: 'unregistered', detail: msg };
        }
        if (/FF Scouter API Error/i.test(msg)) {
            return { type: 'api', detail: msg };
        }
        return { type: 'error', detail: msg || 'Unknown error' };
    }

    function mprFfScouterBannerHtml(state) {
        if (!state || !state.type) return '';
        const link = mprFfScouterLinkHtml();
        if (state.type === 'unregistered') {
            return `<strong>Estimated stats:</strong> Register your Torn API key at ${link} (same key as here).`;
        }
        if (state.type === 'no_helper') {
            return `<strong>Estimated stats:</strong> Reload the page or open this tool from the main app, then register at ${link} if needed.`;
        }
        if (state.type === 'api' || state.type === 'error') {
            const d = state.detail ? mprEscapeHtml(state.detail) : '';
            return `<strong>Estimated stats:</strong> ${d ? `${d} ` : ''}See ${link}.`;
        }
        return '';
    }

    /** Short message for the Estimated stats column when no value exists for this reason. */
    function mprFfScouterCellHtml(state) {
        if (!state || !state.type) return '';
        const link = mprFfScouterLinkHtml();
        if (state.type === 'unregistered') {
            return `<div style="max-width:220px;margin:0 auto;text-align:left;line-height:1.35;"><span style="color:#ffb74d;font-size:0.88em;">Not registered.</span> ${link}</div>`;
        }
        if (state.type === 'no_helper') {
            return `<div style="max-width:220px;margin:0 auto;text-align:left;line-height:1.35;"><span style="color:#ffb74d;font-size:0.88em;">Could not load.</span> Reload the page. ${link}</div>`;
        }
        const short = state.detail ? mprEscapeHtml(state.detail.slice(0, 120)) : 'Request failed.';
        return `<div style="max-width:220px;margin:0 auto;text-align:left;line-height:1.35;"><span style="color:#ffb74d;font-size:0.88em;">${short}</span> ${link}</div>`;
    }

    function mprUpdateFfScouterNoteEl() {
        const el = document.getElementById('mprFfScouterNote');
        if (!el) return;
        if (!mprFfScouterIssueState) {
            el.style.display = 'none';
            el.innerHTML = '';
            return;
        }
        el.style.display = 'block';
        el.innerHTML = mprFfScouterBannerHtml(mprFfScouterIssueState);
    }

    /** Aligns with Organised Crime Stats `parseCrimeRewards` (v2 completed crimes). */
    function mprParseCrimeRewards(rewards) {
        if (!rewards) return { money: 0, itemCount: 0, items: [] };
        if (typeof rewards === 'number' && !isNaN(rewards)) return { money: rewards, itemCount: 0, items: [] };
        const money = typeof rewards.money === 'number' ? rewards.money : 0;
        const rawItems = Array.isArray(rewards.items) ? rewards.items : [];
        let itemCount = 0;
        const items = rawItems.map(it => {
            const qty = typeof it.quantity === 'number' ? it.quantity : 1;
            itemCount += qty;
            const id = it.id != null ? it.id : it.name || '?';
            const name = it.name || it.label || `Item #${id}`;
            return { id, name, quantity: qty };
        });
        return { money, itemCount, items };
    }

    function mprRewardItemsDollarValue(items, itemValues) {
        if (!items || !Array.isArray(items) || !itemValues || typeof itemValues !== 'object') return 0;
        let sum = 0;
        for (const it of items) {
            const qty = typeof it.quantity === 'number' ? it.quantity : 1;
            const name = it.name || it.label || '';
            const price = name && typeof itemValues[name] === 'number' ? itemValues[name] : 0;
            sum += qty * price;
        }
        return sum;
    }

    /**
     * Same participation scoring as Organised Crime Stats (difficulty × participants/6 per slot).
     * Optional: player / faction $ estimates from successful crime rewards (Organised Crime Stats split).
     */
    function mprProcessCrimeScoresOnly(crimes, playerNames, currentMemberIds, factionCutPercent, itemValues) {
        const cut = Math.min(100, Math.max(0, Number(factionCutPercent)));
        const iv = itemValues && typeof itemValues === 'object' ? itemValues : {};
        const playerMap = {};
        currentMemberIds.forEach(memberId => {
            playerMap[memberId] = {
                id: memberId,
                name: playerNames[memberId] || `Player ${memberId}`,
                totalParticipations: 0,
                successfulParticipations: 0,
                failedParticipations: 0,
                highestDifficultySucceeded: 0,
                totalScore: 0,
                successRate: 0,
                ocEarningsEstimate: 0,
                ocFactionCutEstimate: 0,
                difficultyBreakdown: {},
                difficultyCrimeTypeBreakdown: {}
            };
            for (let i = 1; i <= 10; i++) {
                playerMap[memberId].difficultyBreakdown[i] = { successful: 0, failed: 0, total: 0 };
            }
        });

        crimes.forEach(crime => {
            const difficulty = crime.difficulty;
            let hasCurrentMember = false;
            if (crime.slots && Array.isArray(crime.slots)) {
                hasCurrentMember = crime.slots.some(
                    slot => slot.user && slot.user.id && currentMemberIds.has(slot.user.id.toString())
                );
            }
            if (!hasCurrentMember) return;

            const crimeName =
                crime.crime_name ??
                crime.name ??
                crime.title ??
                'Crime #' + (crime.crime_id ?? crime.type ?? 'unknown');
            const crimeTypeKey = String(crimeName).trim().toLowerCase();

            if (!crime.slots || !Array.isArray(crime.slots)) return;

            const crimeStatus = crime.status == null ? '' : String(crime.status);
            const participantsInCrime = crime.slots.filter(
                slot => slot.user && slot.user.id && currentMemberIds.has(slot.user.id.toString())
            ).length;
            const rewardParsed =
                crimeStatus === 'Successful' && crime.rewards ? mprParseCrimeRewards(crime.rewards) : { money: 0, items: [] };
            const itemDollars = mprRewardItemsDollarValue(rewardParsed.items, iv);
            const totalRewardDollars = (rewardParsed.money || 0) + itemDollars;
            const shareReward =
                crimeStatus === 'Successful' &&
                participantsInCrime > 0 &&
                (rewardParsed.money > 0 || (rewardParsed.items && rewardParsed.items.length > 0));
            const playerMoneyMult = shareReward ? (1 - cut / 100) / participantsInCrime : 0;
            const factionMoneyMult = shareReward ? (cut / 100) / participantsInCrime : 0;

            crime.slots.forEach(slot => {
                if (!slot.user || !slot.user.id) return;
                const playerId = slot.user.id.toString();
                if (!currentMemberIds.has(playerId)) return;

                let pm = playerMap[playerId];
                if (!pm) {
                    pm = {
                        id: playerId,
                        name: playerNames[playerId] || `Player ${playerId}`,
                        totalParticipations: 0,
                        successfulParticipations: 0,
                        failedParticipations: 0,
                        highestDifficultySucceeded: 0,
                        totalScore: 0,
                        successRate: 0,
                        ocEarningsEstimate: 0,
                        ocFactionCutEstimate: 0,
                        difficultyBreakdown: {},
                        difficultyCrimeTypeBreakdown: {}
                    };
                    for (let i = 1; i <= 10; i++) {
                        pm.difficultyBreakdown[i] = { successful: 0, failed: 0, total: 0 };
                    }
                    playerMap[playerId] = pm;
                }

                pm.totalParticipations++;
                const totalParticipants = crime.slots.length;
                const participationRatio = totalParticipants / 6;
                const participationScore = Math.round(difficulty * participationRatio);
                pm.totalScore += participationScore;

                if (shareReward) {
                    pm.ocEarningsEstimate += totalRewardDollars * playerMoneyMult;
                    pm.ocFactionCutEstimate += totalRewardDollars * factionMoneyMult;
                }

                if (pm.difficultyBreakdown[difficulty]) {
                    pm.difficultyBreakdown[difficulty].total++;
                    if (slot.user.outcome === 'Successful') {
                        pm.difficultyBreakdown[difficulty].successful++;
                    } else {
                        pm.difficultyBreakdown[difficulty].failed++;
                    }
                }

                if (!pm.difficultyCrimeTypeBreakdown[difficulty]) {
                    pm.difficultyCrimeTypeBreakdown[difficulty] = {};
                }
                const pct = pm.difficultyCrimeTypeBreakdown[difficulty];
                if (!pct[crimeTypeKey]) {
                    pct[crimeTypeKey] = { crimeName, total: 0, successful: 0, failed: 0 };
                }
                pct[crimeTypeKey].total++;
                if (slot.user.outcome === 'Successful') {
                    pct[crimeTypeKey].successful++;
                    pm.successfulParticipations++;
                    const diffNum = parseInt(String(difficulty), 10);
                    if (diffNum >= 1 && diffNum <= 10 && diffNum > (pm.highestDifficultySucceeded || 0)) {
                        pm.highestDifficultySucceeded = diffNum;
                    }
                } else {
                    pct[crimeTypeKey].failed++;
                    pm.failedParticipations++;
                }
            });
        });

        Object.values(playerMap).forEach(player => {
            if (player.totalParticipations > 0) {
                player.successRate = Math.round((player.successfulParticipations / player.totalParticipations) * 100);
            }
        });

        return playerMap;
    }

    function mprGetAccountStartTimestamp(member) {
        if (!member || typeof member !== 'object') return null;
        const tryUnix = val => {
            if (val == null || val === '') return null;
            const n = typeof val === 'number' ? val : parseInt(String(val).replace(/[^\d]/g, ''), 10);
            if (!isNaN(n) && n > 1e9 && n < 2e10) return Math.floor(n);
            return null;
        };
        const raw =
            member.signed_up ??
            member.sign_up ??
            member.user_joined ??
            member.signedUp ??
            member.signUp ??
            member.userJoined ??
            member.signup;
        const fromRaw = tryUnix(raw);
        if (fromRaw != null) return fromRaw;
        const basic = member.basic;
        if (basic && typeof basic === 'object') {
            const b = tryUnix(basic.signed_up ?? basic.sign_up ?? basic.user_joined ?? basic.signup);
            if (b != null) return b;
        }
        const life = member.life;
        if (life && typeof life === 'object') {
            const l = tryUnix(life.created ?? life.created_at ?? life.started);
            if (l != null) return l;
        }
        const age = member.age ?? basic?.age;
        if (age != null && age !== '') {
            const ageDays = parseInt(String(age).replace(/[^\d]/g, '') || '0', 10);
            if (!isNaN(ageDays) && ageDays >= 0 && ageDays < 10000) {
                return Math.floor(Date.now() / 1000) - ageDays * 86400;
            }
        }
        return null;
    }

    function mprEffectiveStartSnapshotTs(nominalFromTs, member) {
        const n = Math.floor(Number(nominalFromTs));
        if (isNaN(n)) return nominalFromTs;
        const start = mprGetAccountStartTimestamp(member);
        if (start != null && !isNaN(start) && start > n) return Math.floor(start);
        return n;
    }

    function mprCrimeExecutedTs(crime) {
        const t = crime.executed_at;
        if (t == null) return null;
        const n = typeof t === 'number' ? t : parseInt(String(t), 10);
        return !isNaN(n) ? n : null;
    }

    async function mprFetchCrimesInRange(apiKey, fromTs, toTs, progressEls, onProgress) {
        const all = [];
        let offset = 0;
        const limit = 100;
        let page = 0;
        let hasMore = true;

        while (hasMore && page < 50) {
            page++;
            if (onProgress) onProgress(page, all.length);
            const url = `https://api.torn.com/v2/faction/crimes?cat=completed&offset=${offset}&limit=${limit}&sort=DESC&key=${encodeURIComponent(apiKey)}`;
            const data = await mprApiJson(url, progressEls);
            if (data.error) throw new Error(data.error.error || 'Crimes API error');
            const crimes = data.crimes || [];
            if (crimes.length === 0) {
                hasMore = false;
                break;
            }
            const execTsList = crimes.map(mprCrimeExecutedTs).filter(x => x != null);
            for (const c of crimes) {
                const ex = mprCrimeExecutedTs(c);
                if (ex != null && ex >= fromTs && ex <= toTs) all.push(c);
            }
            const maxEx = execTsList.length ? Math.max(...execTsList) : null;
            if (maxEx != null && maxEx < fromTs) {
                hasMore = false;
            } else if (!data._metadata?.links?.next) {
                hasMore = false;
            } else {
                offset += limit;
            }
        }
        return all;
    }

    function mprNewsCacheKeySegment(apiKey) {
        const k = String(apiKey || '').replace(/[^A-Za-z0-9]/g, '');
        if (k.length <= 8) return k || 'none';
        return `${k.slice(0, 8)}_${k.slice(-4)}`;
    }

    function mprLoadNewsSegStore() {
        try {
            const raw = localStorage.getItem(MPR_NEWS_CACHE_LS_KEY);
            if (!raw) return { keys: {} };
            const o = JSON.parse(raw);
            if (!o || o.version !== 2 || typeof o.keys !== 'object') return { keys: {} };
            const now = Date.now();
            const ttl = MPR_NEWS_SEGMENT_TTL_MS;
            let dirty = false;
            for (const seg of Object.keys(o.keys)) {
                const kd = o.keys[seg];
                if (!kd || !Array.isArray(kd.batches)) {
                    delete o.keys[seg];
                    dirty = true;
                    continue;
                }
                const before = kd.batches.length;
                kd.batches = kd.batches.filter(
                    b =>
                        b &&
                        typeof b.qFrom === 'number' &&
                        typeof b.qTo === 'number' &&
                        b.cachedAt &&
                        now - b.cachedAt <= ttl
                );
                if (kd.batches.length !== before) dirty = true;
                if (typeof kd.nextBatchId !== 'number' || kd.nextBatchId < 1) {
                    kd.nextBatchId = 1;
                    dirty = true;
                }
            }
            if (dirty) {
                try {
                    localStorage.setItem(MPR_NEWS_CACHE_LS_KEY, JSON.stringify({ version: 2, keys: o.keys }));
                } catch (e2) {
                    /* ignore */
                }
            }
            return { keys: o.keys };
        } catch (e) {
            return { keys: {} };
        }
    }

    function mprSaveNewsSegStore(store) {
        try {
            localStorage.setItem(MPR_NEWS_CACHE_LS_KEY, JSON.stringify({ version: 2, keys: store.keys || {} }));
        } catch (e) {
            /* quota */
        }
    }

    function mprEvictExcessNewsBatches(kd) {
        if (!kd.batches || kd.batches.length <= MPR_NEWS_MAX_BATCHES_PER_KEY) return;
        kd.batches.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));
        while (kd.batches.length > MPR_NEWS_MAX_BATCHES_PER_KEY) {
            kd.batches.shift();
        }
    }

    function mprNewsUncoveredGaps(batches, fromTs, toTs) {
        const ttl = MPR_NEWS_SEGMENT_TTL_MS;
        const now = Date.now();
        const alive = (batches || []).filter(
            b =>
                b &&
                typeof b.qFrom === 'number' &&
                typeof b.qTo === 'number' &&
                b.cachedAt &&
                now - b.cachedAt <= ttl
        );
        if (!alive.length) return [{ from: fromTs, to: toTs }];

        const ivs = alive
            .map(b => ({ lo: Math.min(b.qFrom, b.qTo), hi: Math.max(b.qFrom, b.qTo) }))
            .sort((a, b) => a.lo - b.lo);
        const merged = [];
        for (const iv of ivs) {
            if (!merged.length || iv.lo > merged[merged.length - 1].hi + 1) {
                merged.push({ lo: iv.lo, hi: iv.hi });
            } else {
                merged[merged.length - 1].hi = Math.max(merged[merged.length - 1].hi, iv.hi);
            }
        }

        const gaps = [];
        let cursor = fromTs;
        for (const m of merged) {
            if (m.hi < fromTs) continue;
            if (m.lo > toTs) break;
            const overlapLo = Math.max(m.lo, fromTs);
            const overlapHi = Math.min(m.hi, toTs);
            if (cursor < overlapLo) gaps.push({ from: cursor, to: overlapLo - 1 });
            cursor = Math.max(cursor, overlapHi + 1);
            if (cursor > toTs) break;
        }
        if (cursor <= toTs) gaps.push({ from: cursor, to: toTs });
        return gaps;
    }

    function mprNewsMergeAdjacentGaps(gaps) {
        if (!gaps || gaps.length <= 1) return gaps || [];
        const s = [...gaps].sort((a, b) => a.from - b.from);
        const out = [{ from: s[0].from, to: s[0].to }];
        for (let i = 1; i < s.length; i++) {
            const g = s[i];
            const L = out[out.length - 1];
            if (g.from <= L.to + 1) L.to = Math.max(L.to, g.to);
            else out.push({ from: g.from, to: g.to });
        }
        return out;
    }

    function mprMergeNewsEntriesFromAliveBatches(batches, fromTs, toTs) {
        const ttl = MPR_NEWS_SEGMENT_TTL_MS;
        const now = Date.now();
        const byId = new Map();
        for (const b of batches || []) {
            if (!b || !Array.isArray(b.entries) || !b.cachedAt || now - b.cachedAt > ttl) continue;
            for (const e of b.entries) {
                if (!e || e.timestamp == null) continue;
                const ts = Number(e.timestamp);
                if (ts < fromTs || ts > toTs) continue;
                if (!byId.has(e.id)) byId.set(e.id, e);
            }
        }
        return Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp);
    }

    function mprAppendNewsBatch(store, seg, qFrom, qTo, rawEntries) {
        if (!store.keys[seg]) store.keys[seg] = { nextBatchId: 1, batches: [] };
        const kd = store.keys[seg];
        const batchId = kd.nextBatchId;
        kd.nextBatchId = batchId + 1;
        const entries = (rawEntries || []).map(e =>
            typeof e === 'object' && e != null ? { ...e, _mprBatch: batchId } : e
        );
        kd.batches.push({
            batchId,
            qFrom,
            qTo,
            cachedAt: Date.now(),
            entries
        });
        mprEvictExcessNewsBatches(kd);
        mprSaveNewsSegStore(store);
        return batchId;
    }

    /** One exhaustive armory news pull for [fromTs, toTs] (inclusive); does not read/write segment cache. */
    async function mprFetchNewsArmoryPaged(fromTs, toTs, apiKey, progressEls, progressCallback) {
        const allNews = [];
        const seenEntryIds = new Set();
        let lastTimestamp = toTs;
        let currentPage = 0;
        let hasMorePages = true;
        const rangeSpan = toTs - fromTs;

        while (hasMorePages) {
            currentPage++;
            if (currentPage > 100) break;
            const url = `https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&to=${lastTimestamp}&from=${fromTs}&cat=armoryAction&key=${encodeURIComponent(apiKey)}`;
            const newsData = await mprApiJson(url, progressEls);
            if (newsData.error) throw new Error(newsData.error.error || 'News API error');
            const news = newsData.news || [];
            if (news.length === 0) {
                hasMorePages = false;
                if (progressCallback) progressCallback(currentPage, allNews.length, 1);
            } else {
                const newEntries = news.filter(entry => {
                    const ok = entry.timestamp >= fromTs && entry.timestamp <= toTs;
                    const dup = seenEntryIds.has(entry.id);
                    if (ok && !dup) {
                        seenEntryIds.add(entry.id);
                        return true;
                    }
                    return false;
                });
                if (newEntries.length === 0) hasMorePages = false;
                else {
                    allNews.push(...newEntries);
                    const oldestTimestamp = Math.min(...news.map(e => e.timestamp));
                    lastTimestamp = oldestTimestamp - 1;
                    const fraction = rangeSpan > 0 ? Math.min(1, (toTs - lastTimestamp) / rangeSpan) : 1;
                    if (progressCallback) progressCallback(currentPage, allNews.length, fraction);
                    if (oldestTimestamp < fromTs) hasMorePages = false;
                }
            }
        }
        if (progressCallback) progressCallback(currentPage, allNews.length, 1);
        return { entries: allNews, pages: currentPage };
    }

    async function mprFetchNewsForRange(fromTimestamp, toTimestamp, apiKey, progressEls, progressCallback) {
        const seg = mprNewsCacheKeySegment(apiKey);
        const store = mprLoadNewsSegStore();
        if (!store.keys[seg]) store.keys[seg] = { nextBatchId: 1, batches: [] };
        const kd = store.keys[seg];
        if (typeof kd.nextBatchId !== 'number' || kd.nextBatchId < 1) kd.nextBatchId = 1;
        if (!Array.isArray(kd.batches)) kd.batches = [];

        let gaps = mprNewsUncoveredGaps(kd.batches, fromTimestamp, toTimestamp);
        gaps = mprNewsMergeAdjacentGaps(gaps);

        if (!gaps.length) {
            const merged = mprMergeNewsEntriesFromAliveBatches(kd.batches, fromTimestamp, toTimestamp);
            if (progressCallback) progressCallback(1, merged.length, 1);
            return merged.map(e => ({ ...e }));
        }

        let pageOffset = 0;
        for (let gi = 0; gi < gaps.length; gi++) {
            const gap = gaps[gi];
            const { entries, pages } = await mprFetchNewsArmoryPaged(
                gap.from,
                gap.to,
                apiKey,
                progressEls,
                progressCallback
                    ? (page, count, frac) => {
                          const gFrac = (gi + frac) / gaps.length;
                          progressCallback(pageOffset + page, count, gFrac);
                      }
                    : null
            );
            pageOffset += pages;
            mprAppendNewsBatch(store, seg, gap.from, gap.to, entries);
        }

        const merged = mprMergeNewsEntriesFromAliveBatches(store.keys[seg].batches, fromTimestamp, toTimestamp);
        if (progressCallback) progressCallback(pageOffset || 1, merged.length, 1);
        return merged.map(e => ({ ...e }));
    }

    function mprEmptyConsumptionRow(playerId, playerName) {
        const o = {
            name: playerName,
            id: playerId
        };
        MPR_CONSUMPTION_KEYS.forEach(k => {
            o[k.id] = 0;
        });
        return o;
    }

    function mprAccumulateNewsEntry(byId, logText) {
        const playerMatch = logText.match(/<a href[^>]*XID=(\d+)[^>]*>([^<]+)<\/a>/);
        if (!playerMatch) return;
        const playerId = playerMatch[1];
        const playerName = playerMatch[2];
        if (!byId.has(playerId)) byId.set(playerId, mprEmptyConsumptionRow(playerId, playerName));
        const row = byId.get(playerId);

        if (logText.includes("used one of the faction's Xanax items")) row.xanax++;
        else if (logText.includes("used one of the faction's Vicodin items")) row.vicodin++;
        else if (logText.includes("used one of the faction's Ketamine items")) row.ketamine++;
        else if (logText.includes("used one of the faction's Speed items")) row.speed++;
        else if (logText.includes("used one of the faction's Shrooms items")) row.shrooms++;
        else if (logText.includes("used one of the faction's Cannabis items")) row.cannabis++;
        else if (logText.includes("used one of the faction's PCP items")) row.pcp++;
        else if (logText.includes("used one of the faction's Opium items")) row.opium++;
        else if (logText.includes("used one of the faction's Ecstasy items")) row.ecstasy++;
        else if (logText.includes("used one of the faction's LSD items")) row.lsd++;
        else if (logText.includes("used one of the faction's Love Juice items")) row.loveJuice++;
        else if (
            logText.includes("used one of the faction's Blood Bag") ||
            logText.includes("used one of the faction's Empty Blood Bag")
        ) {
            row.bloodbags++;
        } else if (logText.includes("used one of the faction's First Aid Kit items") && !logText.includes('Small')) {
            row.firstAidKit++;
        } else if (logText.includes("used one of the faction's Small First Aid Kit items")) {
            row.smallFirstAidKit++;
        } else if (logText.includes("used one of the faction's Morphine items")) row.morphine++;
        else if (logText.includes("used one of the faction's Ipecac Syrup items")) row.ipecacSyrup++;
        else if (logText.includes("used one of the faction's Bottle of Beer items")) row.beer++;
        else if (logText.includes("used one of the faction's Lollipop items")) row.lollipop++;
        else if (logText.includes("used one of the faction's Box of Sweet Hearts items")) row.sweetHearts++;
        else if (logText.includes("used one of the faction's Can of Goose Juice items")) row.gooseJuice++;
        else if (logText.includes("used one of the faction's Can of Damp Valley items")) row.dampValley++;
        else if (logText.includes("used one of the faction's Can of Crocozade items")) row.crocozade++;
        else if (logText.includes("used one of the faction's Can of Santa Shooters items")) row.santaShooters++;
        else if (logText.includes("used one of the faction's Can of Munster items")) row.munster++;
        else if (logText.includes("used one of the faction's Can of Red Cow items")) row.redCow++;
        else if (logText.includes("used one of the faction's Can of Rockstar Rudolph items")) row.rockstarRudolph++;
        else if (logText.includes("used one of the faction's Can of Taurine Elite items")) row.taurineElite++;
        else if (logText.includes("used one of the faction's Can of X-MASS items")) row.xmass++;
        else if (logText.includes('used') && logText.includes("of the faction's points")) {
            const pointsMatch = logText.match(/used\s+(\d+)\s+of\s+the\s+faction's\s+points/);
            if (pointsMatch) row.points += parseInt(pointsMatch[1], 10);
        }
    }

    function mprConsumptionCostDollars(row, itemValues) {
        let sum = 0;
        for (const col of MPR_CONSUMPTION_KEYS) {
            const qty = row[col.id] || 0;
            const price = col.isPoints ? itemValues.Points || 0 : itemValues[col.itemName] || 0;
            sum += qty * price;
        }
        return sum;
    }

    function mprConsumptionDetailsHtml(row, itemValues) {
        const lines = [];
        for (const col of MPR_CONSUMPTION_KEYS) {
            const qty = row[col.id] || 0;
            if (!qty) continue;
            const price = col.isPoints ? itemValues.Points || 0 : itemValues[col.itemName] || 0;
            const sub = qty * price;
            const label = col.isPoints ? 'Points' : col.itemName;
            lines.push(`${qty}× ${mprEscapeHtml(label)} — $${Math.round(sub).toLocaleString()}`);
        }
        if (!lines.length) return '<span style="color:#888;">No armory usage in range</span>';
        return lines.join('<br>');
    }

    async function mprBuildItemValues(apiKey, progressEls) {
        const itemsUrl = `https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(apiKey)}`;
        const itemsData = await mprApiJson(itemsUrl, progressEls);
        if (itemsData.error) throw new Error(itemsData.error.error || 'Items API error');

        const itemValues = {};
        const itemNameMapping = {
            Xanax: 'Xanax',
            Vicodin: 'Vicodin',
            Ketamine: 'Ketamine',
            Speed: 'Speed',
            Shrooms: 'Shrooms',
            Cannabis: 'Cannabis',
            PCP: 'PCP',
            Opium: 'Opium',
            Ecstasy: 'Ecstasy',
            LSD: 'LSD',
            'Love Juice': 'Love Juice',
            'Blood Bag': 'Blood Bag',
            'First Aid Kit': 'First Aid Kit',
            'Small First Aid Kit': 'Small First Aid Kit',
            Morphine: 'Morphine',
            'Ipecac Syrup': 'Ipecac Syrup',
            'Bottle of Beer': 'Bottle of Beer',
            Lollipop: 'Lollipop',
            'Box of Sweet Hearts': 'Box of Sweet Hearts',
            'Can of Goose Juice': 'Can of Goose Juice',
            'Can of Damp Valley': 'Can of Damp Valley',
            'Can of Crocozade': 'Can of Crocozade',
            'Can of Santa Shooters': 'Can of Santa Shooters',
            'Can of Munster': 'Can of Munster',
            'Can of Red Cow': 'Can of Red Cow',
            'Can of Rockstar Rudolph': 'Can of Rockstar Rudolph',
            'Can of Taurine Elite': 'Can of Taurine Elite',
            'Can of X-MASS': 'Can of X-MASS'
        };

        Object.values(itemsData.items || {}).forEach(item => {
            if (!item.type || item.type === 'Weapon' || item.type === 'Armor' || item.type === 'Temporary' || item.type === 'Special') {
                return;
            }
            if (itemNameMapping[item.name]) {
                itemValues[itemNameMapping[item.name]] = item.market_value || 0;
            }
        });

        const bloodBagItems = Object.values(itemsData.items || {}).filter(
            item => item.name.includes('Blood Bag') && item.market_value > 0 && item.type && item.type !== 'Weapon' && item.type !== 'Armor'
        );
        if (bloodBagItems.length > 0) {
            const total = bloodBagItems.reduce((sum, item) => sum + item.market_value, 0);
            itemValues['Blood Bag'] = Math.round(total / bloodBagItems.length);
        }

        try {
            const pointsUrl = `https://api.torn.com/market/?selections=pointsmarket&key=${encodeURIComponent(apiKey)}`;
            const pointsMarketData = await mprApiJson(pointsUrl, progressEls);
            if (!pointsMarketData.error && pointsMarketData.pointsmarket) {
                const listings = Object.values(pointsMarketData.pointsmarket).sort((a, b) => a.cost - b.cost);
                if (listings.length >= 5) itemValues.Points = listings[4].cost;
                else if (listings.length > 0) itemValues.Points = listings[0].cost;
            }
        } catch (e) {
            console.warn('[MPR] Points market:', e);
        }

        return itemValues;
    }

    function mprExtractTimeplayed(data) {
        if (!data || data.personalstats == null) return null;
        const ps = data.personalstats;
        if (Array.isArray(ps) && ps.length > 0) {
            const item = ps[0];
            if (item && typeof item.value === 'number' && !isNaN(item.value)) return item.value;
            if (item && typeof item.value === 'string' && item.value !== '') {
                const n = parseInt(item.value, 10);
                return !isNaN(n) ? n : null;
            }
        }
        if (typeof ps === 'object' && !Array.isArray(ps) && ps.timeplayed != null) {
            const v = ps.timeplayed;
            if (typeof v === 'number' && !isNaN(v)) return v;
            if (typeof v === 'string' && v !== '') {
                const n = parseInt(v, 10);
                return !isNaN(n) ? n : null;
            }
        }
        return null;
    }

    function mprLoadTimeplayedSnapshotCache() {
        try {
            const raw = localStorage.getItem(MPR_TIMEPLAYED_LS_KEY);
            if (!raw) return { data: {} };
            const o = JSON.parse(raw);
            if (!o.cachedAt || Date.now() - o.cachedAt > MPR_TIMEPLAYED_CACHE_TTL_MS) {
                try {
                    localStorage.removeItem(MPR_TIMEPLAYED_LS_KEY);
                } catch (e2) {
                    /* ignore */
                }
                return { data: {} };
            }
            return { data: typeof o.data === 'object' && o.data != null ? o.data : {} };
        } catch (e) {
            return { data: {} };
        }
    }

    function mprPickCachedTimeplayedForTs(playerMap, requestedTs) {
        if (!playerMap || typeof playerMap !== 'object') return null;
        const req = Math.floor(Number(requestedTs));
        if (isNaN(req)) return null;
        const exact = playerMap[String(req)];
        if (typeof exact === 'number' && !isNaN(exact)) return exact;
        let bestVal = null;
        let bestDelta = MPR_TIMEPLAYED_TIMESTAMP_SLACK_SEC + 1;
        for (const k of Object.keys(playerMap)) {
            const ts = parseInt(k, 10);
            if (isNaN(ts)) continue;
            const v = playerMap[k];
            if (typeof v !== 'number' || isNaN(v)) continue;
            const d = Math.abs(ts - req);
            if (d <= MPR_TIMEPLAYED_TIMESTAMP_SLACK_SEC && d < bestDelta) {
                bestDelta = d;
                bestVal = v;
            }
        }
        return bestVal;
    }

    /** Pre-fill `store` from localStorage so we only enqueue API calls for missing snapshots. */
    function mprHydrateActivityStoreFromCache(store, memberIds, membersById, fromTs, endTs, cacheByPlayer) {
        if (!cacheByPlayer || typeof cacheByPlayer !== 'object') return;
        memberIds.forEach(mid => {
            const id = String(mid);
            const member = membersById[id];
            if (!member || !store[id]) return;
            const startSnap = mprEffectiveStartSnapshotTs(fromTs, member);
            const want = [endTs, startSnap];
            const pmap = cacheByPlayer[id] || cacheByPlayer[String(mid)];
            if (!pmap || typeof pmap !== 'object') return;
            want.forEach(ts => {
                if (typeof store[id][ts] === 'number' && !isNaN(store[id][ts])) return;
                const v = mprPickCachedTimeplayedForTs(pmap, ts);
                if (v != null) store[id][ts] = v;
            });
        });
    }

    function mprPersistTimeplayedSnapshotCache(store, memberIds) {
        const prev = mprLoadTimeplayedSnapshotCache().data;
        const base = typeof prev === 'object' && prev != null ? JSON.parse(JSON.stringify(prev)) : {};
        memberIds.forEach(mid => {
            const id = String(mid);
            if (!store[id]) return;
            if (!base[id]) base[id] = {};
            Object.keys(store[id]).forEach(tsK => {
                const v = store[id][tsK];
                if (typeof v === 'number' && !isNaN(v)) base[id][tsK] = v;
            });
        });
        try {
            localStorage.setItem(MPR_TIMEPLAYED_LS_KEY, JSON.stringify({ cachedAt: Date.now(), data: base }));
        } catch (e) {
            /* quota / private mode */
        }
    }

    function mprTryActivityPairComplete(store, membersById, fromTs, endTs, pid, activityPairDone, onPlayerActivity) {
        const idStr = String(pid);
        if (typeof onPlayerActivity !== 'function' || activityPairDone.has(idStr)) return;
        const member = membersById[idStr];
        if (!member) return;
        const startSnap = mprEffectiveStartSnapshotTs(fromTs, member);
        const a = store[idStr][endTs];
        const b = store[idStr][startSnap];
        if (typeof a === 'number' && typeof b === 'number' && !isNaN(a) && !isNaN(b)) {
            const h = (a - b) / 3600;
            const hoursVal = h >= 0 && h < 10000 && isFinite(h) ? h : null;
            activityPairDone.add(idStr);
            try {
                onPlayerActivity(idStr, hoursVal);
            } catch (cbErr) {
                console.warn('[MPR] onPlayerActivity', idStr, cbErr);
            }
        }
    }

    function mprBuildMissingTimeplayedRequests(memberIds, membersById, fromTs, endTs, store, apiKey) {
        const requests = [];
        memberIds.forEach(mid => {
            const id = String(mid);
            const member = membersById[id];
            const startSnap = mprEffectiveStartSnapshotTs(fromTs, member);
            if (!store[id]) store[id] = {};
            if (typeof store[id][endTs] !== 'number' || isNaN(store[id][endTs])) {
                requests.push({
                    playerId: id,
                    timestamp: endTs,
                    url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${endTs}&key=${encodeURIComponent(apiKey)}`
                });
            }
            if (typeof store[id][startSnap] !== 'number' || isNaN(store[id][startSnap])) {
                requests.push({
                    playerId: id,
                    timestamp: startSnap,
                    url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${startSnap}&key=${encodeURIComponent(apiKey)}`
                });
            }
        });
        return requests;
    }

    function mprComputeActivityHoursMap(memberIds, membersById, fromTs, endTs, store) {
        const hoursById = {};
        memberIds.forEach(mid => {
            const id = String(mid);
            const member = membersById[id];
            const startSnap = mprEffectiveStartSnapshotTs(fromTs, member);
            const a = store[id] && store[id][endTs];
            const b = store[id] && store[id][startSnap];
            if (typeof a === 'number' && typeof b === 'number' && !isNaN(a) && !isNaN(b)) {
                const h = (a - b) / 3600;
                hoursById[id] = h >= 0 && h < 10000 && isFinite(h) ? h : null;
            } else {
                hoursById[id] = null;
            }
        });
        return hoursById;
    }

    /**
     * Timeplayed uses the same sequential queue as Faction Battle Stats (`batchApiCallsWithRateLimit`).
     * Optional `onPlayerActivity(pid, hours)` runs as soon as both range snapshots exist for that member
     * so the Activity column can update row-by-row without slowing total API throughput.
     */
    async function mprFetchActivityHours(memberIds, membersById, fromTs, toTs, apiKey, progressEls, onPlayerActivity) {
        const nowCap = Math.floor(Date.now() / 1000);
        const endTs = Math.min(toTs, nowCap);
        const store = {};
        memberIds.forEach(mid => {
            store[String(mid)] = {};
        });

        const activityPairDone = new Set();

        const { data: cacheByPlayer } = mprLoadTimeplayedSnapshotCache();
        mprHydrateActivityStoreFromCache(store, memberIds, membersById, fromTs, endTs, cacheByPlayer);
        memberIds.forEach(mid => {
            mprTryActivityPairComplete(store, membersById, fromTs, endTs, String(mid), activityPairDone, onPlayerActivity);
        });

        const onSuccess = (data, request) => {
            const tp = mprExtractTimeplayed(data);
            const pid = String(request.playerId);
            if (tp === null) return;
            if (!store[pid]) store[pid] = {};
            store[pid][request.timestamp] = tp;
            mprTryActivityPairComplete(store, membersById, fromTs, endTs, pid, activityPairDone, onPlayerActivity);
        };

        if (typeof window.batchApiCallsWithRateLimit !== 'function') {
            console.warn('[MPR] batchApiCallsWithRateLimit missing');
            mprPersistTimeplayedSnapshotCache(store, memberIds);
            return mprComputeActivityHoursMap(memberIds, membersById, fromTs, endTs, store);
        }

        const allRequests = [];
        memberIds.forEach(mid => {
            const id = String(mid);
            const member = membersById[id];
            const startSnap = mprEffectiveStartSnapshotTs(fromTs, member);
            if (typeof store[id][endTs] !== 'number' || isNaN(store[id][endTs])) {
                allRequests.push({
                    playerId: id,
                    timestamp: endTs,
                    url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${endTs}&key=${encodeURIComponent(apiKey)}`
                });
            }
            if (typeof store[id][startSnap] !== 'number' || isNaN(store[id][startSnap])) {
                allRequests.push({
                    playerId: id,
                    timestamp: startSnap,
                    url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${startSnap}&key=${encodeURIComponent(apiKey)}`
                });
            }
        });

        if (progressEls.progressDetails && allRequests.length === 0) {
            progressEls.progressDetails.textContent = 'Activity: all snapshots from cache (±12h match) — no timeplayed API calls.';
        }

        if (allRequests.length > 0) {
            await window.batchApiCallsWithRateLimit(allRequests, {
                progressMessage: progressEls.progressMessage,
                progressDetails: progressEls.progressDetails,
                progressPercentage: progressEls.progressPercentage,
                progressFill: progressEls.progressFill,
                progressSegmentStart: 0,
                progressSegmentWidth: 0.85,
                progressDetailsPrefix: 'Activity (timeplayed): ',
                onSuccess,
                onError: (err, req) => console.warn('[MPR] timeplayed', req && req.playerId, err)
            });
        }

        let hoursById = mprComputeActivityHoursMap(memberIds, membersById, fromTs, endTs, store);
        const missingIds = memberIds.filter(mid => hoursById[String(mid)] == null).map(String);
        if (missingIds.length > 0) {
            if (progressEls.progressDetails) {
                progressEls.progressDetails.textContent = `Retrying activity for ${missingIds.length} member(s) with incomplete snapshots…`;
            }
            await new Promise(r => setTimeout(r, MPR_ACTIVITY_RETRY_DELAY_MS));
            const retryReqs = mprBuildMissingTimeplayedRequests(memberIds, membersById, fromTs, endTs, store, apiKey);
            if (retryReqs.length > 0) {
                await window.batchApiCallsWithRateLimit(retryReqs, {
                    progressMessage: progressEls.progressMessage,
                    progressDetails: progressEls.progressDetails,
                    progressPercentage: progressEls.progressPercentage,
                    progressFill: progressEls.progressFill,
                    progressSegmentStart: 0.85,
                    progressSegmentWidth: 0.15,
                    progressDetailsPrefix: 'Activity retry: ',
                    onSuccess,
                    onError: (err, req) => console.warn('[MPR] timeplayed retry', req && req.playerId, err)
                });
            }
            hoursById = mprComputeActivityHoursMap(memberIds, membersById, fromTs, endTs, store);
        }

        mprPersistTimeplayedSnapshotCache(store, memberIds);
        return hoursById;
    }

    function mprCrimeDetailsHtml(player) {
        if (!player.totalParticipations) {
            return '<span style="color:#888;">No OC in range</span>';
        }
        let inner = '<table style="width:100%;border-collapse:collapse;font-size:0.9em;"><thead><tr><th>D</th><th>Total</th><th>OK</th><th>Fail</th><th>%</th></tr></thead><tbody>';
        for (let diff = 1; diff <= 10; diff++) {
            const br = player.difficultyBreakdown[diff];
            if (!br || !br.total) continue;
            const pct = Math.round((br.successful / br.total) * 100);
            inner += `<tr><td>${diff}</td><td>${br.total}</td><td style="color:#4ecdc4">${br.successful}</td><td style="color:#ff6b6b">${br.failed}</td><td>${pct}%</td></tr>`;
        }
        inner += '</tbody></table>';
        return inner;
    }

    function mprSortValue(row, col) {
        switch (col) {
            case 'name':
                return (row.name || '').toLowerCase();
            case 'lastOnline':
                return row.lastOnlineSort == null || row.lastOnlineSort === 0 ? -Infinity : row.lastOnlineSort;
            case 'daysInFaction':
                return row.daysInFaction == null ? -Infinity : row.daysInFaction;
            case 'estimatedStats':
                return row.estimatedStatsSort == null || row.estimatedStatsSort === -Infinity
                    ? -Infinity
                    : row.estimatedStatsSort;
            case 'crimeScore':
                return row.crimeScore;
            case 'ocHighestSuccess':
                return row.ocHighestSuccessSort == null || row.ocHighestSuccessSort === -Infinity
                    ? -Infinity
                    : row.ocHighestSuccessSort;
            case 'ocEarnings':
                return row.ocEarnings == null ? -Infinity : row.ocEarnings;
            case 'ocFactionCut':
                return row.ocFactionCut == null ? -Infinity : row.ocFactionCut;
            case 'warHits':
                return row.warHits;
            case 'outsideHits':
                return row.outsideHits;
            case 'warAvgRespectPerHit':
                return row.warAvgRespectPerHit == null ? -Infinity : row.warAvgRespectPerHit;
            case 'outsideAvgRespectPerHit':
                return row.outsideAvgRespectPerHit == null ? -Infinity : row.outsideAvgRespectPerHit;
            case 'overallRanking':
                return row.overallRank == null ? -Infinity : -row.overallRank;
            case 'activityHours':
                if (row.activityPending) return -Infinity;
                return row.activityHours == null ? -Infinity : row.activityHours;
            case 'consumptionCost':
                return row.consumptionCost;
            default:
                return 0;
        }
    }

    function mprVisibleDataColumns() {
        return MPR_COLUMN_META.filter(c => mprColumnVisibility[c.id] !== false);
    }

    function mprMoneyCell(n) {
        if (n == null || (typeof n === 'number' && Number.isNaN(n))) return mprDashCell();
        const v = Number(n);
        if (v < 0) return mprDashCell();
        if (v === 0) {
            return '<span style="color:#bbb">$0</span>';
        }
        return `<strong>$${Math.round(v).toLocaleString()}</strong>`;
    }

    function mprTableDataCellHtml(row, colId) {
        switch (colId) {
            case 'daysInFaction':
                if (row.daysInFaction == null) return '0';
                return String(row.daysInFaction);
            case 'estimatedStats': {
                const hasVal =
                    row.estimatedStatsSort != null && row.estimatedStatsSort !== -Infinity;
                if (hasVal) {
                    const estDisplay =
                        row.estimatedStatsDisplay != null && row.estimatedStatsDisplay !== ''
                            ? mprEscapeHtml(row.estimatedStatsDisplay)
                            : '0';
                    return `<span title="From FF Scouter">${estDisplay}</span>`;
                }
                if (mprFfScouterIssueState) {
                    return mprFfScouterCellHtml(mprFfScouterIssueState);
                }
                return `<span title="Not available from FF Scouter">0</span>`;
            }
            case 'crimeScore': {
                const partsN = row.ocParts == null ? null : Number(row.ocParts);
                const partsStr = partsN == null || Number.isNaN(partsN) ? '0' : String(partsN);
                const scoreN = row.crimeScore == null ? null : Number(row.crimeScore);
                const scoreHtml =
                    scoreN == null || Number.isNaN(scoreN)
                        ? mprDashCell()
                        : `<strong style="color:#ffd700">${String(scoreN)}</strong>`;
                return `${scoreHtml} <span style="color:#aaa;font-size:0.85em">(${partsStr} parts)</span><details style="margin-top:4px;"><summary style="cursor:pointer;color:var(--accent-color);font-size:0.85em;">Details</summary><div style="margin-top:6px;padding:8px;background:var(--secondary-color);border-radius:6px;max-width:360px;">${mprCrimeDetailsHtml(
                    row.ocPlayer || { totalParticipations: 0, difficultyBreakdown: {} }
                )}</div></details>`;
            }
            case 'ocHighestSuccess': {
                const d = row.ocHighestSuccessDiff;
                if (d == null || d < 1) return '0';
                return `<strong style="color:#ffd700">D${d}</strong>`;
            }
            case 'ocEarnings':
                return mprMoneyCell(row.ocEarnings);
            case 'ocFactionCut':
                return mprMoneyCell(row.ocFactionCut);
            case 'warHits':
                if (row.warHits == null) return '0';
                return String(row.warHits);
            case 'outsideHits':
                if (row.outsideHits == null) return '0';
                return String(row.outsideHits);
            case 'warAvgRespectPerHit': {
                if (row.warAvgRespectPerHit == null) return '<span style="color:#888">0.00</span>';
                return `<strong>${Number(row.warAvgRespectPerHit).toFixed(2)}</strong>`;
            }
            case 'outsideAvgRespectPerHit': {
                if (row.outsideAvgRespectPerHit == null) {
                    const tip =
                        row.outsideAvgRespectUnknown && row.outsideHits != null && row.outsideHits > 0
                            ? 'No chain respect data for this player.'
                            : '';
                    if (tip) {
                        return `<span style="color:#888" title="${mprEscapeHtml(tip)}">0.00</span>`;
                    }
                    return '<span style="color:#888">0.00</span>';
                }
                return `<strong>${Number(row.outsideAvgRespectPerHit).toFixed(2)}</strong>`;
            }
            case 'overallRanking': {
                const rnk = row.overallRank;
                const lines = mprOverallRankingBreakdownHtml(row.overallRankBreakdown);
                const head =
                    rnk == null ? mprDashCell() : `<strong style="color:#ffd700">#${rnk}</strong>`;
                return `${head}<details style="margin-top:4px;"><summary style="cursor:pointer;color:var(--accent-color);font-size:0.85em;">Breakdown</summary><div style="margin-top:6px;padding:8px;background:var(--secondary-color);border-radius:6px;max-width:340px;text-align:left;">${lines}</div></details>`;
            }
            case 'activityHours':
                return row.activityPending
                    ? '<span class="mpr-activity-loading" title="Loading activity…"><span class="mpr-activity-spinner" aria-hidden="true"></span><span>Updating…</span></span>'
                    : row.activityHours == null
                      ? '0.0'
                      : `${Number(row.activityHours).toFixed(1)}`;
            case 'lastOnline': {
                const loTitle = row.lastOnlineTitle ? mprEscapeHtml(row.lastOnlineTitle) : '';
                return `<span title="${loTitle}">${mprEscapeHtml(row.lastOnlineDisplay || '0')}</span>`;
            }
            case 'consumptionCost': {
                const rawC = row.consumptionCost;
                if (rawC == null || (typeof rawC === 'number' && Number.isNaN(rawC))) return mprDashCell();
                const costNum = Number(rawC);
                const detailsBlock = `<details style="margin-top:4px;"><summary style="cursor:pointer;color:var(--accent-color);font-size:0.85em;">Details</summary><div style="margin-top:6px;padding:8px;background:var(--secondary-color);border-radius:6px;max-width:380px;">${mprConsumptionDetailsHtml(
                    row.consumptionRow,
                    row._itemValues || {}
                )}</div></details>`;
                if (costNum <= 0) {
                    return `<span style="color:#bbb">$0</span>${detailsBlock}`;
                }
                return `<strong>$${Math.round(costNum).toLocaleString()}</strong>${detailsBlock}`;
            }
            default:
                return '0';
        }
    }

    function mprTdStyleForColumn(colId) {
        if (colId === 'crimeScore' || colId === 'consumptionCost' || colId === 'overallRanking') {
            return 'padding:10px;vertical-align:top;';
        }
        if (colId === 'lastOnline') return 'padding:10px;text-align:center;white-space:nowrap;font-size:0.92em;color:#ccc;';
        return 'padding:10px;text-align:center;';
    }

    function mprOverallRankingBreakdownHtml(br) {
        if (!br || typeof br !== 'object') {
            return '<span style="color:#888;font-size:0.88em;">No breakdown yet.</span>';
        }
        return MPR_RANKING_METRICS.map(m => {
            const b = br[m.id];
            const rankTxt = b && b.rank != null ? `#${b.rank}` : '#0';
            const valEsc = mprEscapeHtml(b && b.valueLabel != null ? b.valueLabel : '0');
            const excl = b && !b.inComposite ? ' <span style="color:#666;">(excluded)</span>' : '';
            return `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:0.88em;margin:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:4px;"><span style="color:#aaa;">${mprEscapeHtml(
                m.label
            )}${excl}</span><span style="white-space:nowrap;"><strong>${rankTxt}</strong> <span style="color:#888">(${valEsc})</span></span></div>`;
        }).join('');
    }

    function mprRenderTable(rows) {
        const wrap = document.getElementById('mprTableWrap');
        if (!wrap) return;
        if (rows && rows.length) mprApplyOverallRanking(rows);
        const sorted = [...rows].sort((a, b) => {
            const va = mprSortValue(a, mprSortState.column);
            const vb = mprSortValue(b, mprSortState.column);
            let c = 0;
            if (typeof va === 'string' || typeof vb === 'string') {
                c = String(va).localeCompare(String(vb));
            } else {
                c = (va || 0) - (vb || 0);
            }
            return mprSortState.direction === 'asc' ? c : -c;
        });

        const visible = mprVisibleDataColumns();
        const minW = Math.max(520, 200 + visible.length * 118);

        const showId = typeof window.toolsGetShowMemberIdInBrackets === 'function' && window.toolsGetShowMemberIdInBrackets();
        const nameSortInd =
            mprSortState.column === 'name'
                ? `<span class="sort-indicator">${mprSortState.direction === 'asc' ? '▲' : '▼'}</span>`
                : '';
        const nameHeaderClickable = `<span data-mpr-sort="name" style="cursor:pointer;color:var(--accent-color);">Member${nameSortInd}</span>`;
        const nameThInner =
            typeof window.toolsMemberColumnHeaderWrap === 'function'
                ? window.toolsMemberColumnHeaderWrap(nameHeaderClickable, { align: 'flex-start', labelColor: '#aaa' })
                : nameHeaderClickable;
        const nameTh = `<th data-column="name" title="${mprEscapeHtml(MPR_MEMBER_HEADER_TIP)}" style="padding:10px;text-align:left;background:var(--secondary-color);border-bottom:1px solid var(--border-color);vertical-align:middle;">${nameThInner}</th>`;
        const headerCells = visible
            .map(c => {
                const arrowInd =
                    mprSortState.column === c.id
                        ? `<span class="sort-indicator">${mprSortState.direction === 'asc' ? '▲' : '▼'}</span>`
                        : '';
                const ht = c.tip ? ` title="${mprEscapeHtml(c.tip)}"` : '';
                return `<th data-column="${c.id}" data-mpr-sort="${c.id}"${ht} style="cursor:pointer;padding:10px;text-align:center;background:var(--secondary-color);color:var(--accent-color);border-bottom:1px solid var(--border-color);">${mprEscapeHtml(c.label)}${arrowInd}</th>`;
            })
            .join('');

        let html = `<table class="mpr-roster-table" style="width:max-content;min-width:${minW}px;border-collapse:collapse;"><thead><tr>${nameTh}${headerCells}</tr></thead><tbody>`;

        sorted.forEach(row => {
            const label =
                typeof window.toolsFormatMemberDisplayLabel === 'function'
                    ? window.toolsFormatMemberDisplayLabel(row, showId)
                    : mprEscapeHtml(row.name);
            const linkAttrs =
                typeof window.toolsMemberLinkAttrs === 'function' ? window.toolsMemberLinkAttrs(row.name, row.id) : '';
            const nameCell = `<a class="player-link" href="https://www.torn.com/profiles.php?XID=${row.id}" target="_blank" rel="noopener noreferrer"${linkAttrs}>${label}</a>`;
            const tds = visible
                .map(c => `<td data-column="${c.id}" style="${mprTdStyleForColumn(c.id)}">${mprTableDataCellHtml(row, c.id)}</td>`)
                .join('');
            html += `<tr style="border-bottom:1px solid var(--border-color);"><td data-column="name" style="padding:10px;text-align:left;">${nameCell}</td>${tds}</tr>`;
        });
        html += '</tbody></table>';
        wrap.innerHTML = html;
        mprApplyStickyMemberClass();
        mprWireDualHScrollAndDrag();
        mprUpdateDualScrollMetrics();

        wrap.querySelectorAll('[data-mpr-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.getAttribute('data-mpr-sort');
                if (mprSortState.column === col) {
                    mprSortState.direction = mprSortState.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    mprSortState.column = col;
                    mprSortState.direction = col === 'name' ? 'asc' : 'desc';
                }
                mprPersistSortPreference();
                mprRenderTable(mprLastRows);
            });
        });
    }

    async function mprEnsureWarChainHitsScript() {
        if (typeof window.factionToolsFetchWarChainHitsForRange === 'function') return;
        const id = 'mpr-war-chain-hits-script';
        if (!document.getElementById(id)) {
            const s = document.createElement('script');
            s.id = id;
            s.src = './tools/member-performance-range/mpr-war-chain-hits.js';
            document.body.appendChild(s);
        }
        for (let i = 0; i < 200; i++) {
            if (typeof window.factionToolsFetchWarChainHitsForRange === 'function') return;
            await new Promise(r => setTimeout(r, 50));
        }
    }

    function mprBuildPerformanceRows(
        membersArray,
        ocMap,
        byConsumptionId,
        hitsById,
        warMeta,
        itemValues,
        fromTs,
        toTs,
        activityHoursById,
        activityPending,
        estimatedStatsById
    ) {
        const nowTs = Math.floor(Date.now() / 1000);
        const rangeEndTs = Math.min(toTs, nowTs);
        return membersArray.map(m => {
            const id = String(m.id);
            const ocPlayer = ocMap[id] || {
                id,
                name: m.name,
                totalParticipations: 0,
                successfulParticipations: 0,
                failedParticipations: 0,
                totalScore: 0,
                successRate: 0,
                highestDifficultySucceeded: 0,
                difficultyBreakdown: {},
                difficultyCrimeTypeBreakdown: {}
            };
            const cons = byConsumptionId.get(id) || mprEmptyConsumptionRow(id, m.name);
            const h = hitsById[id];
            const warHits = h ? h.war : warMeta.ok ? 0 : null;
            const outsideHits = h ? h.outside : warMeta.ok ? 0 : null;
            const warRespectSum = h && h.warRespect != null ? Number(h.warRespect) : warMeta.ok ? 0 : null;
            const outsideRespectSum = h && h.outsideRespect != null ? Number(h.outsideRespect) : warMeta.ok ? 0 : null;
            const chainWarRespectSum = h && h.chainWarRespect != null ? Number(h.chainWarRespect) : warMeta.ok ? 0 : null;
            const chainBonusExtraWar =
                h && h.chainBonusExtraWar != null ? Math.max(0, Number(h.chainBonusExtraWar)) : warMeta.ok ? 0 : 0;
            const chainBonusExtraOutside =
                h && h.chainBonusExtraOutside != null ? Math.max(0, Number(h.chainBonusExtraOutside)) : warMeta.ok ? 0 : 0;
            const chainBonusRespectSumWar =
                h && h.chainBonusRespectSumWar != null ? Math.max(0, Number(h.chainBonusRespectSumWar)) : warMeta.ok ? 0 : 0;
            const chainBonusRespectSumOutside =
                h && h.chainBonusRespectSumOutside != null
                    ? Math.max(0, Number(h.chainBonusRespectSumOutside))
                    : warMeta.ok
                      ? 0
                      : 0;
            const chainHitsTotal = h && h.chain != null ? Number(h.chain) : warMeta.ok ? 0 : null;
            const chainBonusDetails = Array.isArray(h?.chainBonusDetails)
                ? h.chainBonusDetails.map(d => ({
                      chain: d.chain,
                      defender: d.defender != null ? String(d.defender) : '',
                      respectFull: typeof d.respectFull === 'number' ? d.respectFull : Number(d.respectFull) || 0,
                      stripExtra: typeof d.stripExtra === 'number' ? d.stripExtra : Number(d.stripExtra) || 0,
                      warBucket: !!d.warBucket,
                      unclassified: !!d.unclassified
                  }))
                : [];
            const outsideRespectChainLines = Array.isArray(h?.outsideRespectChainLines)
                ? h.outsideRespectChainLines.map(L => ({
                      reportKey: L.reportKey != null ? String(L.reportKey) : '',
                      chainEnd: L.chainEnd != null ? Number(L.chainEnd) : null,
                      chainId: L.chainId != null ? L.chainId : null,
                      memberAttacks: Number(L.memberAttacks) || 0,
                      warOnChain: Number(L.warOnChain) || 0,
                      outsideOnChain: Number(L.outsideOnChain) || 0,
                      respectUsed: typeof L.respectUsed === 'number' ? L.respectUsed : Number(L.respectUsed) || 0,
                      fromMemberRow: !!L.fromMemberRow,
                      contribution: typeof L.contribution === 'number' ? L.contribution : Number(L.contribution) || 0
                  }))
                : [];
            const outsideRespectHasChain = !!(h && h.outsideRespectHasChainRespect);
            /**
             * Σ member chain respect across all reports: must sum per-chain `respectUsed` (each row’s trEff).
             * Do not use outsideRespect + chainWarRespect alone: territory/raid chain war respect is merged into
             * `warRespect`, so that sum would drop whole chains’ war share and look like “one chain” totals.
             */
            let chainTotalRespectFromChains = null;
            if (outsideRespectChainLines.length > 0) {
                chainTotalRespectFromChains = outsideRespectChainLines.reduce(
                    (s, L) => s + (Number(L.respectUsed) || 0),
                    0
                );
            } else if (
                outsideRespectSum != null &&
                Number.isFinite(Number(outsideRespectSum)) &&
                chainWarRespectSum != null &&
                Number.isFinite(Number(chainWarRespectSum))
            ) {
                chainTotalRespectFromChains = Number(outsideRespectSum) + Number(chainWarRespectSum);
            }
            /**
             * Outside respect average (MPR): same war-class milestone strip on chain total and on war report,
             * then (chain after strip − war report after strip − other-defender strip) ÷ outside hits.
             * No proration by chain-war hits ÷ war hits and no × (outside ÷ chain attacks).
             */
            let outsidePathStripFirst = null;
            let warRespectRemovedForOutsidePath = null;
            if (
                outsideRespectHasChain &&
                chainTotalRespectFromChains != null &&
                Number.isFinite(Number(chainTotalRespectFromChains)) &&
                warRespectSum != null &&
                Number.isFinite(Number(warRespectSum))
            ) {
                const chainAfter = Math.max(0, Number(chainTotalRespectFromChains) - chainBonusExtraWar);
                const warAfter = Math.max(0, Number(warRespectSum) - chainBonusExtraWar);
                warRespectRemovedForOutsidePath = warAfter;
                outsidePathStripFirst = Math.max(0, chainAfter - warAfter);
            }
            const outsideRespectFromApiSplit =
                warMeta.ok && outsideRespectSum != null && Number.isFinite(Number(outsideRespectSum))
                    ? Number(outsideRespectSum)
                    : null;
            const outsideRespectAdjustedForAvg =
                outsideRespectHasChain && outsidePathStripFirst != null && Number.isFinite(outsidePathStripFirst)
                    ? Math.max(0, outsidePathStripFirst - chainBonusExtraOutside)
                    : outsideRespectHasChain &&
                        outsideRespectSum != null &&
                        Number.isFinite(Number(outsideRespectSum))
                      ? Math.max(0, Number(outsideRespectSum) - chainBonusExtraOutside)
                      : null;
            const warRespectAdjustedForWarAvg =
                warRespectSum != null && Number.isFinite(Number(warRespectSum))
                    ? Math.max(0, Number(warRespectSum) - chainBonusExtraWar)
                    : null;
            let warAvgRespectPerHit = null;
            if (
                warHits != null &&
                warHits > 0 &&
                warRespectAdjustedForWarAvg != null &&
                Number.isFinite(warRespectAdjustedForWarAvg)
            ) {
                warAvgRespectPerHit = warRespectAdjustedForWarAvg / warHits;
            }
            let outsideAvgRespectPerHit = null;
            let outsideAvgRespectUnknown = false;
            if (outsideHits != null && outsideHits > 0 && outsideRespectSum != null && Number.isFinite(outsideRespectSum)) {
                if (outsideRespectHasChain) {
                    outsideAvgRespectPerHit = outsideRespectAdjustedForAvg / outsideHits;
                } else {
                    outsideAvgRespectUnknown = true;
                }
            }
            let avgRespectWarChain = null;
            if (
                warMeta.ok &&
                warHits != null &&
                outsideHits != null &&
                warRespectSum != null &&
                outsideRespectSum != null &&
                chainWarRespectSum != null
            ) {
                const denomWC = (Number(warHits) || 0) + (Number(outsideHits) || 0);
                if (denomWC > 0) {
                    const warResAdjWC =
                        warRespectSum != null && Number.isFinite(Number(warRespectSum))
                            ? Math.max(0, Number(warRespectSum) - chainBonusExtraWar)
                            : 0;
                    const cwrAdj = Math.max(0, Number(chainWarRespectSum) - chainBonusExtraWar);
                    /** Outside leg = chain API “outside” pool only (not chain−war residual — that would double-count war vs war column). */
                    const osrOutsideBase =
                        outsideRespectSum != null && Number.isFinite(Number(outsideRespectSum))
                            ? Number(outsideRespectSum)
                            : outsidePathStripFirst != null && Number.isFinite(outsidePathStripFirst)
                              ? outsidePathStripFirst
                              : 0;
                    const osrAdj = Math.max(0, osrOutsideBase - chainBonusExtraOutside);
                    avgRespectWarChain = (warResAdjWC + osrAdj + cwrAdj) / denomWC;
                }
            }
            const ah = activityPending ? null : activityHoursById[id];
            const cost = mprConsumptionCostDollars(cons, itemValues);
            const lo = mprLastOnlineFromMember(m);
            const rawBs =
                estimatedStatsById && (estimatedStatsById[id] ?? estimatedStatsById[Number(id)]);
            const estN = mprNormalizeBsEstimate(rawBs);
            const estimatedStatsSort = estN != null ? estN : -Infinity;
            const estimatedStatsDisplay = estN != null ? Number(estN).toLocaleString() : '0';
            return {
                id,
                name: m.name,
                lastOnlineSort: lo.sortVal,
                lastOnlineDisplay: lo.display,
                lastOnlineTitle: lo.title,
                daysInFaction: mprDaysInFaction(m, rangeEndTs),
                estimatedStatsSort,
                estimatedStatsDisplay,
                crimeScore: ocPlayer.totalScore,
                ocParts: ocPlayer.totalParticipations,
                ocPlayer,
                ocHighestSuccessDiff:
                    ocPlayer.highestDifficultySucceeded >= 1 && ocPlayer.highestDifficultySucceeded <= 10
                        ? ocPlayer.highestDifficultySucceeded
                        : 0,
                ocHighestSuccessSort:
                    ocPlayer.highestDifficultySucceeded >= 1 && ocPlayer.highestDifficultySucceeded <= 10
                        ? ocPlayer.highestDifficultySucceeded
                        : -Infinity,
                ocEarnings: typeof ocPlayer.ocEarningsEstimate === 'number' ? ocPlayer.ocEarningsEstimate : 0,
                ocFactionCut: typeof ocPlayer.ocFactionCutEstimate === 'number' ? ocPlayer.ocFactionCutEstimate : 0,
                warHits,
                outsideHits,
                warRespectRaw:
                    warMeta.ok && warRespectSum != null && Number.isFinite(Number(warRespectSum))
                        ? Number(warRespectSum)
                        : null,
                warRespectAdjustedForWarAvg,
                chainHitsTotal,
                chainWarRespectFromChains:
                    warMeta.ok && chainWarRespectSum != null && Number.isFinite(Number(chainWarRespectSum))
                        ? Number(chainWarRespectSum)
                        : null,
                chainTotalRespectFromChains:
                    warMeta.ok && chainTotalRespectFromChains != null && Number.isFinite(chainTotalRespectFromChains)
                        ? chainTotalRespectFromChains
                        : null,
                outsideRespectRaw:
                    warMeta.ok && outsidePathStripFirst != null && Number.isFinite(outsidePathStripFirst)
                        ? outsidePathStripFirst
                        : warMeta.ok && outsideRespectSum != null && Number.isFinite(Number(outsideRespectSum))
                          ? Number(outsideRespectSum)
                          : null,
                outsideRespectFromApiSplit,
                outsideRespectAdjustedForAvg,
                chainBonusStripOutside: chainBonusExtraOutside,
                chainBonusStripWarExtra: chainBonusExtraWar,
                warRespectRemovedForOutsidePath:
                    warMeta.ok &&
                    warRespectRemovedForOutsidePath != null &&
                    Number.isFinite(warRespectRemovedForOutsidePath)
                        ? warRespectRemovedForOutsidePath
                        : null,
                chainBonusRespectSumWar,
                chainBonusRespectSumOutside,
                chainBonusDetails,
                outsideRespectChainLines,
                outsideRespectHasChain,
                warAvgRespectPerHit,
                outsideAvgRespectPerHit,
                outsideAvgRespectUnknown,
                avgRespectWarChain,
                activityHours: ah,
                activityPending: !!activityPending,
                consumptionCost: cost,
                consumptionRow: cons,
                _itemValues: itemValues
            };
        });
    }

    function mprRecomputeRowsFromTableOptions() {
        if (!mprRedoContext) return;
        const cutEl = document.getElementById('mprFactionCutPercent');
        const cut = cutEl ? Math.min(100, Math.max(0, parseFloat(cutEl.value) || 20)) : 20;
        const ctx = mprRedoContext;
        const ocMapFresh = mprProcessCrimeScoresOnly(
            ctx.crimesInRange,
            ctx.playerNames,
            ctx.currentMemberIds,
            cut,
            ctx.itemValues
        );
        mprLastRows = mprBuildPerformanceRows(
            ctx.membersArray,
            ocMapFresh,
            ctx.byConsumptionId,
            ctx.hitsById,
            ctx.warMeta,
            ctx.itemValues,
            ctx.fromTs,
            ctx.toTs,
            ctx.activityHoursById || {},
            false,
            ctx.estimatedStatsById || {}
        );
        mprRenderTable(mprLastRows);
    }

    /** Move OC faction cut out of #mprColumnToggles before innerHTML is cleared on each fetch (preserves input & listeners). */
    function mprDetachOcFactionCutWrap() {
        const wrap = document.getElementById('mprOcFactionCutWrap');
        const inner = document.getElementById('mprTableOptionsInner');
        if (!wrap || !inner) return;
        inner.appendChild(wrap);
        wrap.style.display = 'none';
    }

    function mprAttachOcFactionCutToOrganisedGroup() {
        const wrap = document.getElementById('mprOcFactionCutWrap');
        const host = document.getElementById('mprColumnToggles');
        if (!wrap || !host) return;
        const ocGroup = host.querySelector('.mpr-col-group[data-mpr-group="oc"]');
        if (!ocGroup) return;
        ocGroup.appendChild(wrap);
        wrap.style.display = '';
    }

    function mprEnsureColumnTogglePanel() {
        const host = document.getElementById('mprColumnToggles');
        if (!host || host.dataset.mprBuilt) return;
        host.dataset.mprBuilt = '1';
        const parts = [];
        MPR_COLUMN_GROUP_ORDER.forEach(gid => {
            const cols = MPR_COLUMN_META.filter(c => c.group === gid);
            if (!cols.length) return;
            const title = MPR_COLUMN_GROUP_LABELS[gid] || gid;
            const groupTitleTip = MPR_COLUMN_GROUP_TIPS[gid] ? ` title="${mprEscapeHtml(MPR_COLUMN_GROUP_TIPS[gid])}"` : '';
            const toggles = cols
                .map(c => {
                    const vis = mprColumnVisibility[c.id] !== false;
                    const ct = c.tip ? ` title="${mprEscapeHtml(c.tip)}"` : '';
                    return `<label class="mpr-col-toggle-label"${ct}><input type="checkbox" data-mpr-col="${c.id}" ${vis ? 'checked' : ''}/><span>${mprEscapeHtml(c.label)}</span></label>`;
                })
                .join('');
            parts.push(
                `<div class="mpr-col-group" data-mpr-group="${gid}"><div class="mpr-col-group-title"${groupTitleTip}>${mprEscapeHtml(title)}</div><div class="mpr-col-group-toggles">${toggles}</div></div>`
            );
        });
        host.innerHTML = parts.join('');
        host.querySelectorAll('input[data-mpr-col]').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = cb.getAttribute('data-mpr-col');
                if (!id) return;
                mprColumnVisibility[id] = cb.checked;
                mprPersistColumnVisibility();
                mprRenderTable(mprLastRows);
            });
        });
        mprAttachOcFactionCutToOrganisedGroup();
    }

    async function handleMprFetch() {
        const apiKey = (localStorage.getItem('tornApiKey') || '').trim();
        if (!apiKey) {
            alert('Please enter your API key in the sidebar first.');
            return;
        }

        mprUpdateExactTimesVipUI();
        mprPopulateTctTimeSelects();

        const startEl = document.getElementById('mprStartDate');
        const endEl = document.getElementById('mprEndDate');

        let startYmd = (startEl && startEl.value.trim()) || '';
        const endYmd = (endEl && endEl.value.trim()) || mprUtcYmd();
        if (!startYmd) {
            const t = new Date();
            const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, 0, 0));
            d.setUTCDate(d.getUTCDate() - 30);
            startYmd = d.toISOString().slice(0, 10);
        }

        const useExact = mprUseExactTimesDesired();
        let fromTs;
        let toTs;
        if (useExact) {
            const sh = mprReadHmsFromSelects('mprStartHourTCT', 'mprStartMinTCT', 'mprStartSecTCT');
            const eh = mprReadHmsFromSelects('mprEndHourTCT', 'mprEndMinTCT', 'mprEndSecTCT');
            fromTs = mprTctInstantUnix(startYmd, sh.h, sh.m, sh.s);
            toTs = mprTctInstantUnix(endYmd, eh.h, eh.m, eh.s);
        } else {
            fromTs = mprTctInstantUnix(startYmd, 0, 0, 0);
            toTs = mprTctInstantUnix(endYmd, 23, 59, 59);
        }
        if (fromTs == null || toTs == null) {
            alert('Invalid date. Use the calendar pickers (YYYY-MM-DD, TCT).');
            return;
        }
        if (fromTs > toTs) {
            alert(
                useExact
                    ? 'Range start must be on or before end (TCT), including exact times.'
                    : 'Start date must be on or before end date (TCT).'
            );
            return;
        }

        const progressContainer = document.getElementById('mprProgressContainer');
        const progressEls = mprGetProgressEls();
        const { progressMessage, progressPercentage, progressFill, progressDetails } = progressEls;
        const spinner = document.getElementById('mprLoadingSpinner');
        const btn = document.getElementById('mprFetchBtn');
        const results = document.getElementById('mprResultsSection');
        const tableOpts = document.getElementById('mprTableOptions');
        const copyRow = document.getElementById('mprCopyTableRow');

        const setProg = (pct, msg, det) => {
            if (progressPercentage) progressPercentage.textContent = `${Math.round(pct)}%`;
            if (progressFill) progressFill.style.width = `${Math.min(100, pct)}%`;
            if (progressMessage && msg) progressMessage.textContent = msg;
            if (progressDetails && det != null) progressDetails.textContent = det;
        };

        try {
            mprRedoContext = null;
            mprLastReportCopyMeta = null;
            mprFfScouterIssueState = null;
            const ffScouterNoteEl = document.getElementById('mprFfScouterNote');
            if (ffScouterNoteEl) {
                ffScouterNoteEl.style.display = 'none';
                ffScouterNoteEl.innerHTML = '';
            }
            const colToggleHost = document.getElementById('mprColumnToggles');
            if (colToggleHost) {
                mprDetachOcFactionCutWrap();
                delete colToggleHost.dataset.mprBuilt;
                colToggleHost.innerHTML = '';
            }
            if (btn) btn.disabled = true;
            if (spinner) spinner.style.display = 'inline-block';
            if (results) results.style.display = 'none';
            if (tableOpts) tableOpts.style.display = 'none';
            if (copyRow) copyRow.style.display = 'none';
            if (progressContainer) progressContainer.style.display = 'block';
            mprChecklistReset();
            mprChecklistEnsure();
            setProg(0, 'Starting…', 'Using your welcome panel rate limit.');

            mprChecklistSet('members', 'active');
            setProg(2, 'Faction members…', '');
            const memUrl = `https://api.torn.com/v2/faction/members?key=${encodeURIComponent(apiKey)}`;
            const memData = await mprApiJson(memUrl, progressEls);
            if (memData.error) throw new Error(memData.error.error || 'Members API error');
            mprChecklistSet('members', 'done');

            const membersArray = memData.members || [];
            const currentMemberIds = new Set(membersArray.map(m => String(m.id)));
            const playerNames = {};
            const membersById = {};
            membersArray.forEach(m => {
                const id = String(m.id);
                playerNames[id] = m.name;
                membersById[id] = m;
            });

            let factionNameForCopy = mprFactionNameFromMembersData(memData);
            if (!factionNameForCopy) {
                try {
                    const profUrl = `https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(apiKey)}`;
                    const prof = await mprApiJson(profUrl, progressEls);
                    if (!prof.error) {
                        const fn = (prof.faction_name || prof.faction?.faction_name || '').trim();
                        if (fn) factionNameForCopy = fn;
                    }
                } catch (e) {
                    /* ignore — copy header still has tool + range */
                }
            }
            mprLastReportCopyMeta = {
                factionName: factionNameForCopy,
                toolName: MPR_TOOL_DISPLAY_NAME,
                dateRange: `Range (TCT): ${mprFormatTctUtc(fromTs)} → ${mprFormatTctUtc(toTs)}`
            };

            const ffScoutPromise = (() => {
                if (typeof window.getFFAndBattleStatsForMembers !== 'function') {
                    return Promise.resolve({ ff: {}, bs: {} });
                }
                const ids = membersArray.map(m => m.id).filter(id => id != null && id !== '');
                if (!ids.length) return Promise.resolve({ ff: {}, bs: {} });
                return window.getFFAndBattleStatsForMembers(apiKey, ids);
            })();

            mprChecklistSet('crimes', 'active');
            setProg(8, 'Completed crimes (OC)…', 'v2/faction/crimes, newest first');
            const crimesInRange = await mprFetchCrimesInRange(apiKey, fromTs, toTs, progressEls, (page, n) => {
                setProg(8 + Math.min(18, page * 2), 'Crimes…', `Page ${page}, ${n} in range`);
            });
            mprChecklistSet('crimes', 'done');

            mprChecklistSet('items', 'active');
            setProg(28, 'Item prices…', 'torn/?selections=items + points market');
            const itemValues = await mprBuildItemValues(apiKey, progressEls);
            mprChecklistSet('items', 'done');

            const cutElForOc = document.getElementById('mprFactionCutPercent');
            const factionCutPctForOc = cutElForOc ? Math.min(100, Math.max(0, parseFloat(cutElForOc.value) || 20)) : 20;
            const ocMap = mprProcessCrimeScoresOnly(crimesInRange, playerNames, currentMemberIds, factionCutPctForOc, itemValues);

            mprChecklistSet('news', 'active');
            setProg(38, 'Armory news…', 'v2/faction/news (consumption)');
            const allNews = await mprFetchNewsForRange(fromTs, toTs, apiKey, progressEls, (page, count, frac) => {
                setProg(38 + Math.min(20, frac * 20), 'Armory news…', `Page ${page}, ${count} rows`);
            });
            mprChecklistSet('news', 'done');

            const byConsumptionId = new Map();
            for (const entry of allNews) {
                mprAccumulateNewsEntry(byConsumptionId, entry.text || '');
            }

            mprChecklistSet('war', 'active');
            setProg(60, 'War & chain hits…', '');
            let warMeta = { ok: false, hitsById: {}, warnings: [], message: '' };
            try {
                await mprEnsureWarChainHitsScript();
                if (typeof window.factionToolsFetchWarChainHitsForRange === 'function') {
                    warMeta = await window.factionToolsFetchWarChainHitsForRange(apiKey, fromTs, toTs);
                } else {
                    warMeta.message = 'War/chain helper not available.';
                }
                mprChecklistSet('war', 'done');
            } catch (e) {
                console.warn('[MPR] War/chain:', e);
                warMeta.message = e.message || 'War/chain fetch failed';
                mprChecklistSet('war', 'error');
            }
            const hitsById = warMeta.ok && warMeta.hitsById ? warMeta.hitsById : {};

            const rangeEl = document.getElementById('mprRangeSummary');
            if (rangeEl) {
                rangeEl.textContent = `Range: ${mprFormatTctUtc(fromTs)} → ${mprFormatTctUtc(toTs)} · ${crimesInRange.length} completed crime(s) with execution time in range · ${allNews.length} armory news row(s) scanned.`;
            }
            const note = document.getElementById('mprWarChainNote');
            if (note) {
                const debugHint =
                    warMeta.debugWarChain &&
                    ' War/chain diagnostics: see browser console and window.__mprWarChainDebug.';
                if (warMeta.warnings && warMeta.warnings.length) {
                    note.style.display = 'block';
                    note.textContent = warMeta.warnings.join(' ') + (debugHint || '');
                } else if (!warMeta.ok && warMeta.message) {
                    note.style.display = 'block';
                    note.textContent = 'War / outside hits: ' + warMeta.message;
                } else if (debugHint) {
                    note.style.display = 'block';
                    note.textContent = debugHint.trim();
                } else {
                    note.style.display = 'none';
                    note.textContent = '';
                }
            }

            let estimatedStatsById = {};
            mprFfScouterIssueState = null;
            mprChecklistSet('ffscout', 'active');
            setProg(64, 'Estimated stats (FF Scouter)…', 'Same batched pull as Faction Battle Stats');
            const memberIdsForFf = membersArray.map(m => m.id).filter(id => id != null && id !== '');
            try {
                const ffPack = await ffScoutPromise;
                estimatedStatsById = (ffPack && ffPack.bs) || {};
                if (memberIdsForFf.length > 0) {
                    if (typeof window.getFFAndBattleStatsForMembers !== 'function') {
                        mprFfScouterIssueState = { type: 'no_helper', detail: '' };
                    }
                }
                mprChecklistSet('ffscout', 'done');
            } catch (ffErr) {
                console.warn('[MPR] FF Scouter / estimated stats:', ffErr);
                mprFfScouterIssueState = mprClassifyFfScouterFailure(ffErr);
                mprChecklistSet('ffscout', 'error');
            }
            mprUpdateFfScouterNoteEl();

            mprChecklistSet('activity', 'active');
            setProg(
                72,
                'Activity (timeplayed)…',
                `Loading ${membersArray.length * 2} snapshot(s) — table below is ready; this column updates when done.`
            );

            const rowsPending = mprBuildPerformanceRows(
                membersArray,
                ocMap,
                byConsumptionId,
                hitsById,
                warMeta,
                itemValues,
                fromTs,
                toTs,
                {},
                true,
                estimatedStatsById
            );
            mprLastRows = rowsPending;
            if (tableOpts) tableOpts.style.display = 'block';
            mprEnsureColumnTogglePanel();
            mprRenderTable(rowsPending);
            if (results) results.style.display = 'block';
            if (copyRow) copyRow.style.display = 'block';

            const memberIds = membersArray.map(m => m.id);
            let activityHours = {};
            try {
                activityHours = await mprFetchActivityHours(
                    memberIds,
                    membersById,
                    fromTs,
                    toTs,
                    apiKey,
                    progressEls,
                    (pid, hoursVal) => {
                        const idStr = String(pid);
                        const row = mprLastRows.find(r => r.id === idStr);
                        if (row) {
                            row.activityPending = false;
                            row.activityHours = hoursVal;
                        }
                        const done = mprLastRows.filter(r => !r.activityPending).length;
                        if (progressEls.progressDetails) {
                            progressEls.progressDetails.textContent = `Activity: ${done}/${mprLastRows.length} members (timeplayed ready)`;
                        }
                        mprRenderTable(mprLastRows);
                    }
                );
            } catch (actErr) {
                console.warn('[MPR] Activity fetch failed:', actErr);
                mprChecklistSet('activity', 'error');
            }
            mprChecklistSet('activity', 'done');

            mprLastRows.forEach(r => {
                r.activityPending = false;
                r.activityHours = Object.prototype.hasOwnProperty.call(activityHours, r.id) ? activityHours[r.id] : null;
            });
            mprRedoContext = {
                crimesInRange,
                membersArray,
                playerNames,
                currentMemberIds,
                byConsumptionId,
                hitsById,
                warMeta,
                itemValues,
                fromTs,
                toTs,
                activityHoursById: { ...activityHours },
                estimatedStatsById
            };
            setProg(100, 'Done.', '');
            mprRenderTable(mprLastRows);
        } catch (e) {
            console.error('[MPR]', e);
            alert(e.message || String(e));
        } finally {
            if (btn) btn.disabled = false;
            if (spinner) spinner.style.display = 'none';
            if (progressContainer) progressContainer.style.display = 'none';
        }
    }

    function mprWireCopyTableButton() {
        const btn = document.getElementById('mprCopyTableBtn');
        if (!btn || btn.dataset.mprCopyWired) return;
        btn.dataset.mprCopyWired = '1';
        btn.addEventListener('click', async () => {
            const fn = window.battleStatsCopyTableToClipboard;
            if (typeof fn !== 'function') {
                alert('Copy helper is not loaded. Try refreshing the page.');
                return;
            }
            const table = document.querySelector('#mprTableWrap table.mpr-roster-table');
            const fallbackTitle =
                (mprLastReportCopyMeta && mprLastReportCopyMeta.factionName) || 'Member performance report';
            await fn(btn, table, {
                excludeColumns: [],
                copyMeta: mprLastReportCopyMeta
                    ? {
                          factionName: mprLastReportCopyMeta.factionName || '',
                          toolName: mprLastReportCopyMeta.toolName || MPR_TOOL_DISPLAY_NAME,
                          dateRange: mprLastReportCopyMeta.dateRange || ''
                      }
                    : undefined,
                factionTitle: fallbackTitle
            });
        });
    }

    function mprWireTableOptionsStaticTips() {
        const root = document.getElementById('mprTableOptions');
        if (!root || root.dataset.mprStaticTips) return;
        root.dataset.mprStaticTips = '1';
        const sum = root.querySelector('summary');
        if (sum) sum.title = MPR_TABLE_OPTIONS_SUMMARY_TIP;
        const head = document.getElementById('mprColumnVisibilityHeading');
        if (head) head.title = MPR_COLUMN_VISIBILITY_HEADING_TIP;
        const cutIn = document.getElementById('mprFactionCutPercent');
        if (cutIn) cutIn.title = MPR_FACTION_CUT_INPUT_TIP;
        const cutLab = document.getElementById('mprFactionCutLabel');
        if (cutLab) cutLab.title = MPR_FACTION_CUT_INPUT_TIP;
        const cutHelp = document.getElementById('mprFactionCutHelp');
        if (cutHelp) cutHelp.title = MPR_FACTION_CUT_INPUT_TIP;
        const dHead = document.getElementById('mprDisplayOptionsHeading');
        if (dHead) dHead.title = MPR_DISPLAY_SECTION_TIP;
        const stickyLab = document.getElementById('mprOptStickyMemberLabel');
        if (stickyLab) stickyLab.title = MPR_DISPLAY_STICKY_TIP;
        const rkHead = document.getElementById('mprOverallRankingHeading');
        if (rkHead) rkHead.title = MPR_OVERALL_RANKING_HEADING_TIP;
        const rkHelp = document.getElementById('mprOverallRankingHelp');
        if (rkHelp) rkHelp.title = MPR_OVERALL_RANKING_HEADING_TIP;
    }

    function mprWireOverallRankingOptions() {
        const root = document.getElementById('mprOverallRankingWrap');
        if (!root || root.dataset.mprRankingWired === '1') return;
        root.dataset.mprRankingWired = '1';
        mprSyncOverallRankingCheckboxes();
        root.querySelectorAll('input[data-mpr-ranking-metric]').forEach(inp => {
            inp.addEventListener('change', () => {
                const p = mprRankingPrefsFromUI();
                mprPersistRankingPrefs(p);
                mprRenderTable(mprLastRows);
            });
        });
    }

    function mprWireDisplayOptionControls() {
        const stickyCb = document.getElementById('mprOptStickyMember');
        if (!stickyCb || stickyCb.dataset.mprDisplayWired) return;
        stickyCb.dataset.mprDisplayWired = '1';
        stickyCb.checked = !!(mprDisplayPrefs && mprDisplayPrefs.stickyMemberColumn);
        const sync = () => {
            mprDisplayPrefs = {
                stickyMemberColumn: !!stickyCb.checked
            };
            mprPersistDisplayPrefs();
            mprApplyStickyMemberClass();
            mprRenderTable(mprLastRows);
        };
        stickyCb.addEventListener('change', sync);
        mprApplyStickyMemberClass();
    }

    function initMemberPerformanceRange() {
        if (window.logToolUsage) window.logToolUsage('member-performance');
        mprWireTableOptionsStaticTips();
        mprWireDisplayOptionControls();
        mprWireOverallRankingOptions();
        mprWireCopyTableButton();
        mprWireDualHScrollAndDrag();

        const btn = document.getElementById('mprFetchBtn');
        if (btn && !btn.dataset.mprWired) {
            btn.dataset.mprWired = '1';
            btn.addEventListener('click', () => handleMprFetch());
        }

        /* Name [ID] toggle lives in the Member column header (toolsMemberColumnHeaderWrap); app.js persists to localStorage and dispatches toolsMemberIdDisplayChanged. */
        if (!window._mprToolsMemberIdListener) {
            window._mprToolsMemberIdListener = true;
            window.addEventListener('toolsMemberIdDisplayChanged', () => {
                mprRenderTable(mprLastRows);
            });
        }

        setTimeout(() => {
            mprPopulateTctTimeSelects();
            mprUpdateExactTimesVipUI();

            const exactCb = document.getElementById('mprExactRangeTimes');
            if (exactCb && !exactCb.dataset.mprExactWired) {
                exactCb.dataset.mprExactWired = '1';
                exactCb.addEventListener('change', () => mprSyncHmsSectionVisibility());
            }

            if (window.initDatePickers) {
                const startDef = new Date(Date.now() - 30 * 86400000);
                window.initDatePickers('mprStartDate', 'mprEndDate', {
                    startDefaultDate: startDef,
                    endDefaultDate: 'today'
                });
            }
            const quickRoot = document.getElementById('mprQuickRangeBtns');
            if (quickRoot && !quickRoot.dataset.mprWired) {
                quickRoot.dataset.mprWired = '1';
                quickRoot.addEventListener('click', e => {
                    const b = e.target.closest('[data-mpr-range-days]');
                    if (!b) return;
                    const days = parseInt(b.getAttribute('data-mpr-range-days'), 10);
                    if (days > 0) mprApplyQuickRangeDaysInclusive(days);
                });
            }
        }, 100);

        const cutInput = document.getElementById('mprFactionCutPercent');
        if (cutInput && !cutInput.dataset.mprWiredLs) {
            cutInput.dataset.mprWiredLs = '1';
            try {
                const saved = localStorage.getItem(MPR_LS_FACTION_CUT);
                if (saved != null && saved !== '') cutInput.value = saved;
            } catch (e) {
                /* ignore */
            }
            const persistCutAndRecompute = () => {
                try {
                    localStorage.setItem(MPR_LS_FACTION_CUT, String(cutInput.value));
                } catch (e) {
                    /* ignore */
                }
                mprRecomputeRowsFromTableOptions();
            };
            cutInput.addEventListener('change', persistCutAndRecompute);
            cutInput.addEventListener('input', persistCutAndRecompute);
        }
    }

    window.initMemberPerformanceRange = initMemberPerformanceRange;
})();
