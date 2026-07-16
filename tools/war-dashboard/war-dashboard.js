/**
 * War Dashboard: enemy selection (current war or custom ID), our team + enemy tables,
 * status/location from v2 faction members, FF from FF Scouter, attack links, filters, auto-refresh.
 */
(function () {
    'use strict';

    window.__WAR_DASHBOARD_BUILD = '20260716a';

    const STORAGE_KEYS = {
        enemyFactionId: 'war_dashboard_enemy_faction_id',
        refreshInterval: 'war_dashboard_refresh_interval',
        chainRefreshInterval: 'war_dashboard_chain_refresh_interval',
        ffBlue: 'war_dashboard_ff_blue',
        ffGreen: 'war_dashboard_ff_green',
        ffOrange: 'war_dashboard_ff_orange',
        respectWarlordEnabled: 'war_dashboard_respect_warlord_enabled',
        respectWarlordPercent: 'war_dashboard_respect_warlord_percent',
        ffNoticeHidden: 'war_dashboard_ff_notice_hidden',
        enemyPickerMinimised: 'war_dashboard_enemy_picker_minimised',
        enemyFactionIds: 'war_dashboard_enemy_faction_ids',
        refreshSectionMinimised: 'war_dashboard_refresh_section_minimised',
        ffSectionMinimised: 'war_dashboard_ff_section_minimised',
        trackOurChain: 'war_dashboard_track_our_chain',
        trackEnemyChain: 'war_dashboard_track_enemy_chain',
        autoRefreshEnabled: 'war_dashboard_auto_refresh_enabled',
        activityTrackerConfig: 'war_dashboard_activity_tracker_config',
        activityTrackerDisabledFactions: 'war_dashboard_activity_tracker_disabled_factions',
        activityTrackerLastVisit: 'war_dashboard_activity_tracker_last_visit',
        activityTrackerSectionExpanded: 'war_dashboard_activity_tracker_section_expanded',
        activityAutoWarEnemyFactionId: 'war_dashboard_activity_auto_war_enemy_faction_id'
    };

    const ACTIVITY_DATA_PREFIX = 'war_dashboard_activity_data_';
    /** Per-faction timestamp (ms): ignore Firestore + local samples with t < this (user cleared cache; shared cloud docs cannot be deleted per user). */
    const ACTIVITY_CLOUD_IGNORE_BEFORE_PREFIX = 'war_dashboard_activity_cloud_ignore_before_';
    /** Max `t` (ms) from Firestore activitySampleWindows we've merged — UI sync label only. */
    const ACTIVITY_CLOUD_CURSOR_KEY = 'war_dashboard_activity_cloud_cursor_v1';
    /** Matches server sampleActivity schedule (TICK_MS). */
    const ACTIVITY_INTERVAL_MS = 10 * 60 * 1000;
    /** Max factions one player may track (matches server MAX_ACTIVITY_TRACKED_FACTIONS_PER_PLAYER). */
    const MAX_ACTIVITY_TRACKED_FACTIONS = 3;
    const MAX_ENEMY_FACTIONS = 3;
    const WAR_DASHBOARD_RIBBON_VIP_REQUIRED = 2;
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const ACTIVITY_DATA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    /** One doc per faction: { samples: [{ t, onlineIds }], updatedAt } — shared by all users tracking that faction. */
    const ACTIVITY_SAMPLE_WINDOWS_COLLECTION = 'activitySampleWindows';
    /** Must match functions/chainWatch.js MAX_HOUR_SLOTS (50 days of hourly slots). */
    const CHAIN_WATCH_MAX_HOUR_SLOTS = 50 * 24;
    /** Re-fetch cloud samples at most this often (matches 5-min server tick). One doc read per tracked faction. */
    const ACTIVITY_FIRESTORE_REFRESH_MS = ACTIVITY_INTERVAL_MS;
    /** In-memory cache of merged Firestore + localStorage activity data per faction (so getActivityData stays sync). */
    let activityDataCache = {};
    /** Last Firestore activitySampleWindows fetch (ms). */
    let activitySamplesCloudFetchAt = 0;
    /** Parsed cloud samples from last fetch: { byFaction, docsRead, lastFetch, readError }. */
    let activitySamplesCloudCache = null;
    /** In-flight dedupe so parallel callers share one Firestore read. */
    let activitySamplesCloudFetchPromise = null;
    /** Cached max sample timestamp from Firestore (mirrors localStorage cursor). */
    let activityCloudCursorT = 0;
    /** Per faction: { cloudDocsRead, cloudSampleCount, lastFetch, readError } for UI. */
    let activityDataCloudMeta = {};
    /** Per faction: { ok, error, at } after addTrackedFaction callable. */
    let activityCloudRegisterState = {};

    const CHAIN_AT_ZERO_THROTTLE_MS = 60 * 1000; // when chain at 0, only refetch once per minute
    let lastOurChainFetchTime = 0;
    let lastEnemyChainFetchTime = 0;

    const FF_CACHE_PREFIX = 'war_dashboard_ff_';
    const FF_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
    const FF_REFRESH_DAY_KEY = 'war_dashboard_ff_last_refresh_date_'; // + factionId
    const FACTION_NAME_CACHE_PREFIX = 'war_dashboard_faction_name_';
    const NOTE_PREFIX = 'war_dashboard_note_'; // + player ID, persisted until user clears cache

    let refreshTimer = null;
    let countdownTick = null;
    let chainTickIntervalId = null;
    let chainRefreshTimer = null;
    let nextRefreshAt = null;
    let lastEnemyMembers = [];
    let lastEnemyFF = {};
    let lastEnemyBS = {};
    let lastOurMembers = [];
    let lastOurFF = {};
    let lastOurBS = {};
    let enemySortColumn = 'level';
    let enemySortDir = 'desc';
    let ourSortColumn = 'level';
    let ourSortDir = 'desc';
    let lastEnemyFactionId = null;
    let lastEnemyName = null;
    let lastEnemyWarKind = null;
    let lastRetaliationTargetIds = new Set();
    let lastOurFactionId = null;
    let currentUserPlayerId = null;
    let currentUserAbroadCountry = null;
    /** Chain data from API: { current, max, timeout, cooldown, modifier, start, end }. Display state ticks down. */
    let lastOurChain = null;
    let lastEnemyChain = null;
    /** Mutable display state: { timeout, cooldown } ticked every second */
    let ourChainDisplay = { timeout: 0, cooldown: 0 };
    let enemyChainDisplay = { timeout: 0, cooldown: 0 };
    let userProfileCacheByKey = {};
    let userProfilePromiseByKey = {};
    let dashboardLoadPromise = null;
    let enemyFactionStates = [];

    let activityTrackerIntervalId = null;
    let activityTrackerCountdownIntervalId = null;
    let nextActivitySampleAt = 0;
    let activityTrackerChartInstances = {};
    /** Per-faction sort state for activity tracker table: { [factionId]: { by: string, dir: 'asc'|'desc' } }. Default by: 'stats', dir: 'desc'. */
    let activityTrackerTableSort = {};

    /** Chain watch list (Firebase callables); cached ~5 min + sessionStorage. */
    const CHAIN_WATCH_POLL_MS = 5 * 60 * 1000;
    const CHAIN_WATCH_CACHE_PREFIX = 'war_dashboard_chain_watch_v1_';
    let chainWatchPayload = null;
    let chainWatchLastFetchMs = 0;
    /** Set when chainWatchGet fails or preconditions missing (shown in modal instead of infinite Loading). */
    let chainWatchLastError = '';

    function chainWatchErrorText(err) {
        if (!err) return 'Unknown error';
        const code = err.code != null ? String(err.code) : '';
        const msg = err.message != null ? String(err.message) : '';
        if (code && msg) return code + ': ' + msg;
        return msg || code || String(err);
    }

    /** User-facing message when chainWatchGet fails (e.g. permission). */
    function friendlyChainWatchLoadError(raw) {
        const s = (raw || '').toLowerCase();
        if (s.includes('must be in this faction') || s.includes('permission-denied')) {
            return 'We could not verify your faction from Torn with this API key. Click Apply on War Dashboard (or reload) so your faction loads, and ensure the sidebar key is for the account in your faction.';
        }
        return raw || 'Could not load chain watch.';
    }

    function chainWatchOwnerLabel(p) {
        const name = p && p.ownerName ? String(p.ownerName) : '';
        const id = p && p.ownerPlayerId != null ? String(p.ownerPlayerId) : '';
        if (name && id) return escapeHtml(name) + ' (' + escapeHtml(id) + ')';
        if (id) return 'player ' + escapeHtml(id);
        return '';
    }

    function chainWatchRenderOrganizerUl(ids) {
        const ul = document.getElementById('war-dashboard-cw-organizer-ul');
        const listEl = document.getElementById('war-dashboard-cw-organizer-ids');
        if (!ul || !listEl) return;
        const clean = (Array.isArray(ids) ? ids : [])
            .map(function (s) {
                return String(s).trim();
            })
            .filter(function (s) {
                return /^\d+$/.test(s);
            });
        listEl.value = clean.join(',');
        ul.innerHTML = clean.length
            ? clean
                  .map(function (id) {
                      return (
                          '<li style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span>' +
                          escapeHtml(id) +
                          '</span><button type="button" class="btn war-dashboard-cw-organizer-remove" data-id="' +
                          escapeHtml(id) +
                          '" style="padding:2px 8px;font-size:11px;">Remove</button></li>'
                      );
                  })
                  .join('')
            : '<li style="color:#9e9e9e;">None yet</li>';
    }

    /** Count chain-watch signups in a given watcher column (0-based) across all hour slots. */
    function chainWatchCountSignupsInColumn(slots, colIdx) {
        let n = 0;
        Object.keys(slots || {}).forEach(function (key) {
            (slots[key] || []).forEach(function (w) {
                if (Number(w.col) === colIdx) n++;
            });
        });
        return n;
    }

    /** Human label for watcher slot column index: primary vs backups (matches modal + Our Chain roster). */
    function chainWatchColumnLabel(colIdx) {
        const c = Number(colIdx);
        if (c === 0) return 'Watcher';
        if (c === 1) return 'Backup 1';
        if (c === 2) return 'Backup 2';
        if (Number.isFinite(c) && c >= 0) return 'Column ' + (c + 1);
        return '?';
    }

    /** Display label for minutes; bucket width matches ACTIVITY_INTERVAL_MS. */
    const CHAIN_WATCH_ACTIVITY_SAMPLE_MIN = 5;

    /**
     * Merged Faction activity tracker samples (online only). Slot window [slotStartSec, slotEndSec) unix.
     * Raw samples are deduped by floor(t / ACTIVITY_INTERVAL_MS): multiple ticks in the same bucket count once
     * (fixes inflated minutes when local + cloud merges duplicate nearby samples).
     * Past + had samples + never online => fail (exclude reward). Past + zero samples => no_data (do not exclude).
     */
    function evaluateWatcherSlotAttendance(factionId, playerId, slotStartSec, slotEndSec) {
        const nowMs = Date.now();
        const t0ms = slotStartSec * 1000;
        const t1ms = slotEndSec * 1000;
        const pid = String(playerId);

        if (nowMs < t0ms) {
            return { phase: 'future', sampleCount: 0, onlineHits: 0, presentOnce: false, onlineMinutesApprox: 0, verdict: 'na' };
        }

        const windowEndExclusive = Math.min(nowMs, t1ms);
        const phase = nowMs >= t1ms ? 'past' : 'current';

        const data = getActivityData(String(factionId));
        const samples = data.samples || [];
        const sampleBuckets = new Set();
        const onlineBuckets = new Set();
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            const st = s.t;
            if (st < t0ms || st >= windowEndExclusive) continue;
            const b = Math.floor(st / ACTIVITY_INTERVAL_MS);
            sampleBuckets.add(b);
            const ids = s.onlineIds || [];
            for (let j = 0; j < ids.length; j++) {
                if (String(ids[j]) === pid) {
                    onlineBuckets.add(b);
                    break;
                }
            }
        }

        const sampleCount = sampleBuckets.size;
        const onlineHits = onlineBuckets.size;
        const presentOnce = onlineHits > 0;
        const onlineMinutesApprox = onlineHits * CHAIN_WATCH_ACTIVITY_SAMPLE_MIN;

        let verdict;
        if (phase === 'past') {
            if (sampleCount === 0) verdict = 'no_data';
            else if (!presentOnce) verdict = 'fail';
            else verdict = 'ok';
        } else {
            verdict = presentOnce ? 'ok' : 'pending';
        }

        return { phase: phase, sampleCount: sampleCount, onlineHits: onlineHits, presentOnce: presentOnce, onlineMinutesApprox: onlineMinutesApprox, verdict: verdict };
    }

    /** Minutes + status icon for Our Chain roster line (compact). */
    function chainWatchAttendanceInlineHtml(factionId, w, slotStartSec, slotEndSec) {
        if (!factionId || !w) return '';
        const att = evaluateWatcherSlotAttendance(factionId, w.playerId, slotStartSec, slotEndSec);
        if (att.phase === 'future') return '';
        let icon;
        if (att.phase === 'past' && att.verdict === 'no_data') icon = '?';
        else if (att.presentOnce) icon = '✓';
        else if (att.phase === 'past') icon = '✗';
        else icon = '…';
        const tip =
            att.phase === 'past' && att.verdict === 'no_data'
                ? 'No activity samples this hour — add this faction under Faction activity tracker.'
                : 'Estimated ' +
                  att.onlineMinutesApprox +
                  ' min online (~' +
                  CHAIN_WATCH_ACTIVITY_SAMPLE_MIN +
                  ' min per sample when listed online).';
        return (
            ' <span class="war-dashboard-chain-watch-att" title="' +
            escapeHtml(tip) +
            '">' +
            att.onlineMinutesApprox +
            'm ' +
            icon +
            '</span>'
        );
    }

    /** One cell under a watcher name in the schedule table. */
    function chainWatchHtmlWatcherAttendance(factionId, w, slotStartSec, slotEndSec) {
        if (!factionId || !w) return '';
        const att = evaluateWatcherSlotAttendance(factionId, w.playerId, slotStartSec, slotEndSec);
        if (att.phase === 'future') {
            return '<div class="war-dashboard-cw-att"><span class="war-dashboard-cw-att-muted" title="Watch not started">—</span></div>';
        }
        let icon;
        let iconClass = 'war-dashboard-cw-att-icon';
        if (att.phase === 'past' && att.verdict === 'no_data') {
            icon = '?';
            iconClass += ' war-dashboard-cw-att--nodata';
        } else if (att.presentOnce) {
            icon = '✓';
            iconClass += ' war-dashboard-cw-att--ok';
        } else if (att.phase === 'past') {
            icon = '✗';
            iconClass += ' war-dashboard-cw-att--fail';
        } else {
            icon = '…';
            iconClass += ' war-dashboard-cw-att--pending';
        }
        const tip =
            att.phase === 'past' && att.verdict === 'no_data'
                ? 'No activity samples this hour — add this faction under Faction activity tracker for 24/7 data.'
                : 'Online ≈ ' +
                  att.onlineMinutesApprox +
                  ' min (' +
                  att.sampleCount +
                  ' unique ' +
                  CHAIN_WATCH_ACTIVITY_SAMPLE_MIN +
                  '-min windows with data; listed online in ' +
                  att.onlineHits +
                  ' of them).';
        return (
            '<div class="war-dashboard-cw-att" title="' +
            escapeHtml(tip) +
            '"><span class="war-dashboard-cw-att-min">' +
            att.onlineMinutesApprox +
            'm</span> <span class="' +
            iconClass +
            '" aria-hidden="true">' +
            icon +
            '</span></div>'
        );
    }

    /** VIP: verified no-shows and unverified (no samples) past hours. */
    function collectChainWatchAttendanceIssues(factionId, payload) {
        const noShows = [];
        const unverified = [];
        if (!factionId || !payload || !payload.settings) return { noShows: noShows, unverified: unverified };
        const start = payload.settings.chainStartUnix != null ? Number(payload.settings.chainStartUnix) : null;
        if (start == null || !Number.isFinite(start)) return { noShows: noShows, unverified: unverified };
        const slots = payload.slots || {};
        const nowMs = Date.now();
        Object.keys(slots).forEach(function (key) {
            const si = parseInt(key, 10);
            if (!Number.isFinite(si)) return;
            const slotStart = start + si * 3600;
            const slotEnd = slotStart + 3600;
            if (nowMs < slotEnd) return;
            (slots[key] || []).forEach(function (w) {
                const att = evaluateWatcherSlotAttendance(factionId, w.playerId, slotStart, slotEnd);
                if (att.phase !== 'past') return;
                const name = w.name || String(w.playerId);
                const row = {
                    playerId: String(w.playerId),
                    name: name,
                    slotIndex: si,
                    slotLabel: formatTctTimeRangeShort(slotStart, slotEnd)
                };
                if (att.verdict === 'fail') noShows.push(row);
                else if (att.verdict === 'no_data') unverified.push(row);
            });
        });
        return { noShows: noShows, unverified: unverified };
    }

    /** VIP: increment visible TCT days (+24h of slots after first partial day). */
    function wireChainWatchAddDayButton() {
        const btn = document.getElementById('war-dashboard-cw-add-day');
        if (!btn) return;
        btn.addEventListener('click', async function () {
            const apiKey = getApiKey();
            const fn = getWarDashboardFunctions();
            if (!apiKey || !fn || !lastOurFactionId || !chainWatchPayload) return;
            const p = chainWatchPayload;
            const s = p.settings || {};
            const startUnix = s.chainStartUnix != null ? Number(s.chainStartUnix) : null;
            if (startUnix == null) return;
            const cur = chainWatchPickVisibleTctDaysFromForm(s);
            const maxD = chainWatchMaxVisibleTctDays(startUnix);
            const next = cur + 1;
            if (next > maxD) return;
            btn.disabled = true;
            try {
                let unix = null;
                const dateEl = document.getElementById('war-dashboard-cw-start-date');
                const hourEl = document.getElementById('war-dashboard-cw-start-hour');
                if (dateEl && hourEl && dateEl.value) {
                    unix = unixFromUtcDateHour(dateEl.value, hourEl.value);
                }
                if (unix == null && s.chainStartUnix != null) {
                    unix = Number(s.chainStartUnix);
                }
                function pickNum(id, fallback) {
                    const el = document.getElementById(id);
                    if (el && el.value !== '') return Number(el.value);
                    return Number(fallback);
                }
                function pickStr(id, fallback) {
                    const el = document.getElementById(id);
                    return el ? el.value : fallback;
                }
                await fn.httpsCallable('chainWatchSaveConfig')({
                    apiKey: apiKey,
                    factionId: String(lastOurFactionId),
                    settings: {
                        chainStartUnix: unix,
                        chainTarget: pickNum('war-dashboard-cw-target', s.chainTarget),
                        backupColumns: Math.min(3, Math.max(1, Number(s.backupColumns) || 1)),
                        rewardType: pickStr('war-dashboard-cw-reward-type', s.rewardType) === 'xanax' ? 'xanax' : 'cash',
                        rewardFirst: pickNum('war-dashboard-cw-r1', s.rewardFirst),
                        rewardSubsequent: pickNum('war-dashboard-cw-r2', s.rewardSubsequent),
                        maxSignupsPer24h: pickNum('war-dashboard-cw-max24', s.maxSignupsPer24h),
                        clearAllSignups: false,
                        visibleTctDays: next
                    }
                });
                await fetchChainWatchData(true);
                await renderChainWatchScheduleModal();
            } catch (e) {
                alert((e && e.message) ? e.message : 'Could not add day');
            } finally {
                btn.disabled = false;
            }
        });
    }

    /** VIP: Backup 1 / Backup 2 header − removes that watcher column (calls save). */
    function wireChainWatchRemoveColumnButtons() {
        const root = document.getElementById('war-dashboard-chain-watch-modal-body');
        if (!root) return;
        root.querySelectorAll('.war-dashboard-cw-remove-col').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                const apiKey = getApiKey();
                const fn = getWarDashboardFunctions();
                if (!apiKey || !fn || !lastOurFactionId || !chainWatchPayload) return;
                const colIdx = parseInt(btn.getAttribute('data-remove-col'), 10);
                if (!Number.isFinite(colIdx) || colIdx < 1) return;
                const p = chainWatchPayload;
                const s = p.settings || {};
                const bc = Math.min(3, Math.max(1, Number(s.backupColumns) || 1));
                if (colIdx >= bc) return;
                const n = chainWatchCountSignupsInColumn(p.slots || {}, colIdx);
                if (n > 0) {
                    const ok = window.confirm(
                        'This column has ' +
                            n +
                            ' signup' +
                            (n === 1 ? '' : 's') +
                            ' across the schedule. Removing it will remove those people from those slots. Continue?'
                    );
                    if (!ok) return;
                }
                btn.disabled = true;
                const beforeSlots = p.slots ? JSON.parse(JSON.stringify(p.slots)) : {};
                const beforeBackupColumns = bc;
                try {
                    // Optimistic UI: remove this watcher column immediately and shift higher columns left.
                    const nextSlots = {};
                    Object.keys(p.slots || {}).forEach(function (slotKey) {
                        const list = Array.isArray(p.slots[slotKey]) ? p.slots[slotKey] : [];
                        const next = [];
                        list.forEach(function (w) {
                            const c = Number(w.col);
                            if (!Number.isFinite(c)) return;
                            if (c === colIdx) return;
                            if (c > colIdx) next.push(Object.assign({}, w, { col: c - 1 }));
                            else next.push(w);
                        });
                        nextSlots[slotKey] = next;
                    });
                    p.slots = nextSlots;
                    s.backupColumns = Math.max(1, bc - 1);
                    await renderChainWatchScheduleModal();

                    let unix = null;
                    const dateEl = document.getElementById('war-dashboard-cw-start-date');
                    const hourEl = document.getElementById('war-dashboard-cw-start-hour');
                    if (dateEl && hourEl && dateEl.value) {
                        unix = unixFromUtcDateHour(dateEl.value, hourEl.value);
                    }
                    if (unix == null && s.chainStartUnix != null) {
                        unix = Number(s.chainStartUnix);
                    }
                    function pickNum(id, fallback) {
                        const el = document.getElementById(id);
                        if (el && el.value !== '') return Number(el.value);
                        return Number(fallback);
                    }
                    function pickStr(id, fallback) {
                        const el = document.getElementById(id);
                        return el ? el.value : fallback;
                    }
                    await fn.httpsCallable('chainWatchSaveConfig')({
                        apiKey: apiKey,
                        factionId: String(lastOurFactionId),
                        settings: {
                            chainStartUnix: unix,
                            chainTarget: pickNum('war-dashboard-cw-target', s.chainTarget),
                            backupColumns: bc,
                            rewardType: pickStr('war-dashboard-cw-reward-type', s.rewardType) === 'xanax' ? 'xanax' : 'cash',
                            rewardFirst: pickNum('war-dashboard-cw-r1', s.rewardFirst),
                            rewardSubsequent: pickNum('war-dashboard-cw-r2', s.rewardSubsequent),
                            maxSignupsPer24h: pickNum('war-dashboard-cw-max24', s.maxSignupsPer24h),
                            clearAllSignups: false,
                            removeWatcherColumn0: colIdx,
                            visibleTctDays: chainWatchPickVisibleTctDaysFromForm(s)
                        }
                    });
                } catch (e) {
                    p.slots = beforeSlots;
                    s.backupColumns = beforeBackupColumns;
                    await fetchChainWatchData(true).catch(function () {});
                    await renderChainWatchScheduleModal();
                    alert((e && e.message) ? e.message : 'Could not remove column');
                    btn.disabled = false;
                    return;
                }
                try {
                    await fetchChainWatchData(true);
                } catch (e) {
                    console.warn('chainWatchGet after remove column', e);
                }
                await renderChainWatchScheduleModal();
                btn.disabled = false;
            });
        });
    }

    /** VIP: + above the schedule table adds a backup watcher column (calls save). */
    function wireChainWatchAddColumnButton() {
        const btn = document.getElementById('war-dashboard-cw-header-add-col');
        if (!btn) return;
        btn.addEventListener('click', async function () {
            const apiKey = getApiKey();
            const fn = getWarDashboardFunctions();
            if (!apiKey || !fn || !lastOurFactionId || !chainWatchPayload) return;
            const p = chainWatchPayload;
            const s = p.settings || {};
            const bc = Math.min(3, Math.max(1, Number(s.backupColumns) || 1));
            if (bc >= 3) return;
            btn.disabled = true;
            const prevBackupColumns = bc;
            try {
                // Optimistic UI: add column instantly, then sync to backend.
                s.backupColumns = Math.min(3, prevBackupColumns + 1);
                await renderChainWatchScheduleModal();

                let unix = null;
                const dateEl = document.getElementById('war-dashboard-cw-start-date');
                const hourEl = document.getElementById('war-dashboard-cw-start-hour');
                if (dateEl && hourEl && dateEl.value) {
                    unix = unixFromUtcDateHour(dateEl.value, hourEl.value);
                }
                if (unix == null && s.chainStartUnix != null) {
                    unix = Number(s.chainStartUnix);
                }
                function pickNum(id, fallback) {
                    const el = document.getElementById(id);
                    if (el && el.value !== '') return Number(el.value);
                    return Number(fallback);
                }
                function pickStr(id, fallback) {
                    const el = document.getElementById(id);
                    return el ? el.value : fallback;
                }
                await fn.httpsCallable('chainWatchSaveConfig')({
                    apiKey: apiKey,
                    factionId: String(lastOurFactionId),
                    settings: {
                        chainStartUnix: unix,
                        chainTarget: pickNum('war-dashboard-cw-target', s.chainTarget),
                        backupColumns: prevBackupColumns + 1,
                        rewardType: pickStr('war-dashboard-cw-reward-type', s.rewardType) === 'xanax' ? 'xanax' : 'cash',
                        rewardFirst: pickNum('war-dashboard-cw-r1', s.rewardFirst),
                        rewardSubsequent: pickNum('war-dashboard-cw-r2', s.rewardSubsequent),
                        maxSignupsPer24h: pickNum('war-dashboard-cw-max24', s.maxSignupsPer24h),
                        clearAllSignups: false,
                        visibleTctDays: chainWatchPickVisibleTctDaysFromForm(s)
                    }
                });
                await fetchChainWatchData(true);
                await renderChainWatchScheduleModal();
            } catch (e) {
                s.backupColumns = prevBackupColumns;
                await fetchChainWatchData(true).catch(function () {});
                await renderChainWatchScheduleModal();
                alert((e && e.message) ? e.message : 'Could not add column');
            } finally {
                btn.disabled = false;
            }
        });
    }

    function wireChainWatchOrganizers() {
        const addBtn = document.getElementById('war-dashboard-cw-organizer-add-btn');
        const input = document.getElementById('war-dashboard-cw-organizer-input');
        const saveBtn = document.getElementById('war-dashboard-cw-organizer-save');
        const msg = document.getElementById('war-dashboard-cw-organizer-msg');
        const listEl = document.getElementById('war-dashboard-cw-organizer-ids');
        if (!listEl || !chainWatchPayload) return;

        function readIdsFromHidden() {
            const raw = listEl.value || '';
            if (!raw.trim()) return [];
            return raw
                .split(',')
                .map(function (s) {
                    return String(s).trim();
                })
                .filter(function (s) {
                    return /^\d+$/.test(s);
                });
        }

        function writeIdsToHidden(ids) {
            chainWatchRenderOrganizerUl(ids);
        }

        writeIdsToHidden(readIdsFromHidden());

        if (addBtn && input) {
            addBtn.addEventListener('click', function () {
                const id = String(input.value || '').trim();
                if (!/^\d+$/.test(id)) {
                    if (msg) msg.textContent = 'Enter a numeric Torn player ID.';
                    return;
                }
                const ids = readIdsFromHidden();
                if (ids.indexOf(id) >= 0) {
                    if (msg) msg.textContent = 'Already listed.';
                    return;
                }
                ids.push(id);
                writeIdsToHidden(ids);
                input.value = '';
                if (msg) msg.textContent = '';
            });
        }

        const ulWrap = document.getElementById('war-dashboard-cw-organizer-ul');
        if (ulWrap) {
            ulWrap.addEventListener('click', function (ev) {
                const btn = ev.target.closest('.war-dashboard-cw-organizer-remove');
                if (!btn) return;
                const id = btn.getAttribute('data-id');
                writeIdsToHidden(readIdsFromHidden().filter(function (x) {
                    return x !== id;
                }));
                if (msg) msg.textContent = '';
            });
        }

        if (saveBtn) {
            saveBtn.addEventListener('click', async function () {
                const apiKey = getApiKey();
                const fn = getWarDashboardFunctions();
                if (!apiKey || !fn || !lastOurFactionId) return;
                saveBtn.disabled = true;
                if (msg) msg.textContent = 'Saving…';
                try {
                    const res = await fn.httpsCallable('chainWatchSetOrganizers')({
                        apiKey: apiKey,
                        factionId: String(lastOurFactionId),
                        organizerPlayerIds: readIdsFromHidden()
                    });
                    await fetchChainWatchData(true);
                    await renderChainWatchScheduleModal();
                    if (msg) msg.textContent = 'Organisers saved.';
                    if (res && res.data && Array.isArray(res.data.organizerPlayerIds) && listEl) {
                        listEl.value = res.data.organizerPlayerIds.join(',');
                    }
                } catch (e) {
                    if (msg) msg.textContent = (e && e.message) ? String(e.message) : 'Save failed';
                } finally {
                    saveBtn.disabled = false;
                }
            });
        }
    }

    /** Collapsible schedule editor (localStorage remembers collapsed state when a schedule exists). */
    function wireChainWatchVipCollapse(docExists) {
        const btn = document.getElementById('war-dashboard-cw-vip-toggle');
        const body = document.getElementById('war-dashboard-cw-vip-body');
        if (!btn || !body) return;
        let collapsed = false;
        try {
            if (docExists) {
                collapsed = localStorage.getItem('war_dashboard_cw_vip_collapsed') === '1';
            }
        } catch (e) { /* ignore */ }
        if (collapsed) {
            body.classList.add('war-dashboard-cw-vip-body--collapsed');
            btn.setAttribute('aria-expanded', 'false');
        } else {
            body.classList.remove('war-dashboard-cw-vip-body--collapsed');
            btn.setAttribute('aria-expanded', 'true');
        }
        btn.addEventListener('click', function () {
            body.classList.toggle('war-dashboard-cw-vip-body--collapsed');
            const isCollapsed = body.classList.contains('war-dashboard-cw-vip-body--collapsed');
            btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
            try {
                localStorage.setItem('war_dashboard_cw_vip_collapsed', isCollapsed ? '1' : '0');
            } catch (e) { /* ignore */ }
        });
    }

    function getApiKey() {
        return (localStorage.getItem('tornApiKey') || '').trim();
    }

    async function fetchJson(url) {
        if (typeof window.fetchWithRateLimit === 'function') {
            const data = await window.fetchWithRateLimit(url, { retryOnRateLimit: true, retryDelay: 30000 });
            if (data && data.error) {
                throw new Error(typeof data.error === 'object' ? (data.error.error || JSON.stringify(data.error)) : data.error);
            }
            return data;
        }
        const fetchUrl =
            typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(url) : url;
        const res = await fetch(fetchUrl);
        const data = await res.json();
        if (data.error) throw new Error(typeof data.error === 'object' ? (data.error.error || JSON.stringify(data.error)) : data.error);
        return data;
    }

    function warDashboardFriendlyError(err) {
        const msg = err && err.message ? String(err.message) : String(err || '');
        if (/too many requests/i.test(msg)) {
            return 'Too many Torn API requests. Please wait about 60 seconds, then refresh once. I have slowed dashboard refreshes to reduce this.';
        }
        return msg || 'Failed to load data.';
    }

    async function getUserProfile(apiKey) {
        const key = String(apiKey || '');
        const cached = userProfileCacheByKey[key];
        if (cached && (Date.now() - cached.at) < 5 * 60 * 1000) return cached.value;
        if (userProfilePromiseByKey[key]) return userProfilePromiseByKey[key];

        userProfilePromiseByKey[key] = (async function () {
            if (typeof window.getUserData === 'function') {
                const appUser = await window.getUserData(apiKey);
                if (appUser && appUser.playerId != null) {
                    return {
                        factionId: appUser.factionId,
                        factionName: appUser.factionName || '',
                        playerId: appUser.playerId
                    };
                }
                const lastUserErr = window.__lastTornUserDataError;
                if (lastUserErr) {
                    throw new Error(
                        typeof lastUserErr === 'object'
                            ? (lastUserErr.error || JSON.stringify(lastUserErr))
                            : String(lastUserErr)
                    );
                }
                throw new Error('Could not verify your Torn profile. Check your API key and try again.');
            }

            const data = await fetchJson(`https://api.torn.com/user/?selections=profile&key=${apiKey}`);
            const parsed =
                typeof window.parseTornProfileIdentity === 'function'
                    ? window.parseTornProfileIdentity(data)
                    : null;
            if (parsed) {
                return {
                    factionId: parsed.factionId,
                    factionName: parsed.factionName,
                    playerId: parsed.playerId
                };
            }
            return {
                factionId: data.faction_id || data.faction?.faction_id || data.faction?.id || null,
                factionName: data.faction_name || data.faction?.faction_name || data.faction?.name || '',
                playerId: data.player_id != null ? Number(data.player_id) : null
            };
        })();

        try {
            const value = await userProfilePromiseByKey[key];
            userProfileCacheByKey[key] = { at: Date.now(), value };
            return value;
        } finally {
            delete userProfilePromiseByKey[key];
        }
    }

    /**
     * Ranked war enemy for our faction (same idea as War Payout: ongoing, else next upcoming).
     * Returns { war, enemyFactionId, enemyName, kind: 'ongoing' | 'upcoming' } or null.
     */
    async function getCurrentWarEnemy(apiKey, ourFactionId) {
        const data = await fetchJson(`https://api.torn.com/v2/faction/${ourFactionId}/rankedwars?key=${apiKey}`);
        const raw = data.rankedwars || [];
        const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
        const now = Math.floor(Date.now() / 1000);

        const ongoing = list.find(function (w) {
            return w.start <= now && (!w.end || w.end >= now);
        });
        if (ongoing && ongoing.factions && ongoing.factions.length >= 2) {
            const enemy = ongoing.factions.find(function (f) {
                return String(f.id) !== String(ourFactionId);
            });
            if (enemy) {
                return {
                    war: ongoing,
                    enemyFactionId: String(enemy.id),
                    enemyName: enemy.name || 'Faction ' + enemy.id,
                    kind: 'ongoing'
                };
            }
        }

        const upcomingCandidates = list.filter(function (w) {
            return w.start > now && w.factions && w.factions.length >= 2;
        });
        upcomingCandidates.sort(function (a, b) {
            return a.start - b.start;
        });
        const upcoming = upcomingCandidates[0];
        if (upcoming) {
            const enemy = upcoming.factions.find(function (f) {
                return String(f.id) !== String(ourFactionId);
            });
            if (enemy) {
                return {
                    war: upcoming,
                    enemyFactionId: String(enemy.id),
                    enemyName: enemy.name || 'Faction ' + enemy.id,
                    kind: 'upcoming'
                };
            }
        }

        return null;
    }

    /** Fetch faction chain: GET faction/{id}?selections=chain */
    async function fetchFactionChain(apiKey, factionId) {
        if (!factionId) return null;
        const data = await fetchJson(`https://api.torn.com/faction/${factionId}?selections=chain&key=${apiKey}`);
        const chain = data.chain;
        if (!chain || typeof chain !== 'object') return null;
        return {
            current: chain.current != null ? Number(chain.current) : 0,
            max: chain.max != null ? Number(chain.max) : 0,
            timeout: Math.max(0, Number(chain.timeout) || 0),
            cooldown: Math.max(0, Number(chain.cooldown) || 0),
            modifier: chain.modifier != null ? Number(chain.modifier) : 0,
            start: chain.start,
            end: chain.end
        };
    }

    /** Fetch faction members (our faction: no id in path; enemy: id in path) */
    async function fetchFactionMembers(apiKey, factionId) {
        const base = 'https://api.torn.com/v2/faction';
        const url = factionId
            ? `${base}/${factionId}/members?striptags=true&key=${apiKey}`
            : `${base}/members?striptags=true&key=${apiKey}`;
        const data = await fetchJson(url);
        const members = data.members || [];
        return Array.isArray(members) ? members : Object.values(members);
    }

    const RECENT_ATTACKS_CACHE_MS = 60 * 1000;
    let recentAttacksCache = { key: '', ourFactionId: '', attacks: [], fetchedAt: 0 };
    let recentAttacksFetchPromise = null;

    function filterRecentIncomingAttackers(attacks, ourFactionId, enemyFactionId, fromSec) {
        const our = String(ourFactionId);
        const enemy = String(enemyFactionId);
        const out = new Set();
        (attacks || []).forEach(function (attack) {
            if (!attack) return;
            const ts = Number(attack.started || attack.timestamp || attack.ended || 0);
            if (!Number.isFinite(ts) || ts < fromSec) return;
            const attackerFactionId = attack.attacker && attack.attacker.faction && attack.attacker.faction.id;
            const defenderFactionId = attack.defender && attack.defender.faction && attack.defender.faction.id;
            const attackerId = attack.attacker && attack.attacker.id;
            if (String(attackerFactionId) === enemy && String(defenderFactionId) === our && attackerId != null) {
                out.add(String(attackerId));
            }
        });
        return out;
    }

    /** One shared /faction/attacks fetch per minute; filter per enemy client-side (avoids N duplicate calls). */
    async function ensureRecentAttacksLoaded(apiKey, ourFactionId) {
        if (!apiKey || !ourFactionId) return [];
        const cacheKey = String(apiKey) + ':' + String(ourFactionId);
        const now = Date.now();
        if (
            recentAttacksCache.key === cacheKey
            && recentAttacksCache.ourFactionId === String(ourFactionId)
            && recentAttacksCache.fetchedAt
            && (now - recentAttacksCache.fetchedAt) < RECENT_ATTACKS_CACHE_MS
        ) {
            return recentAttacksCache.attacks;
        }
        if (recentAttacksFetchPromise) return recentAttacksFetchPromise;
        const nowSec = Math.floor(Date.now() / 1000);
        const fromSec = nowSec - (5 * 60);
        recentAttacksFetchPromise = (async function () {
            const url = `https://api.torn.com/v2/faction/attacks?limit=100&sort=ASC&from=${fromSec}&key=${apiKey}`;
            const data = await fetchJson(url);
            const raw = data.attacks || [];
            const attacks = Array.isArray(raw) ? raw : Object.values(raw);
            recentAttacksCache = {
                key: cacheKey,
                ourFactionId: String(ourFactionId),
                attacks: attacks,
                fetchedAt: Date.now()
            };
            return attacks;
        })().finally(function () {
            recentAttacksFetchPromise = null;
        });
        return recentAttacksFetchPromise;
    }

    async function fetchRecentIncomingAttackers(apiKey, ourFactionId, enemyFactionId) {
        if (!apiKey || !ourFactionId || !enemyFactionId) return new Set();
        const fromSec = Math.floor(Date.now() / 1000) - (5 * 60);
        const attacks = await ensureRecentAttacksLoaded(apiKey, ourFactionId).catch(function () { return []; });
        return filterRecentIncomingAttackers(attacks, ourFactionId, enemyFactionId, fromSec);
    }

    function isUsefulFactionName(factionId, name) {
        const value = String(name || '').trim();
        if (!value) return false;
        const id = String(factionId || '').trim();
        return value !== 'Faction' && value !== ('Faction ' + id) && value !== id;
    }

    function getCachedFactionName(factionId) {
        try {
            const raw = localStorage.getItem(FACTION_NAME_CACHE_PREFIX + String(factionId || '').trim());
            if (!raw) return '';
            const parsed = JSON.parse(raw);
            return parsed && parsed.name ? String(parsed.name) : '';
        } catch (e) {
            return '';
        }
    }

    function setCachedFactionName(factionId, name) {
        if (!isUsefulFactionName(factionId, name)) return;
        try {
            localStorage.setItem(FACTION_NAME_CACHE_PREFIX + String(factionId).trim(), JSON.stringify({
                name: String(name).trim(),
                cachedAt: Date.now()
            }));
        } catch (e) { /* ignore */ }
    }

    /** Fetch faction name — same URL and parsing as Faction Battle Stats (app.js). */
    async function fetchFactionName(apiKey, factionId) {
        if (!factionId || !apiKey) return null;
        const cachedName = getCachedFactionName(factionId);
        if (cachedName) return cachedName;
        const url = `https://api.torn.com/v2/faction/${factionId}?key=${apiKey}`;
        try {
            if (typeof window.batchTornApiCalls === 'function') {
                const tornData = await window.batchTornApiCalls(apiKey, [
                    { name: 'factionInfo', url: `https://api.torn.com/v2/faction/${factionId}`, params: '' }
                ]);
                const data = tornData?.factionInfo;
                if (data && !data.error) {
                    let name = data.basic?.name || data.name || data.faction_name;
                    if (name) {
                        setCachedFactionName(factionId, name);
                        return name;
                    }
                }
            }
            const res = await fetch(url);
            const data = await res.json();
            if (data && data.error) return null;
            const raw = data?.faction || data;
            let name = raw?.basic?.name || raw?.name || raw?.faction_name;
            if (name) setCachedFactionName(factionId, name);
            return name || null;
        } catch (e) {
            return null;
        }
    }

    /** FF Scouter: cache per faction, refresh on first use each day, expire after 1 week */
    function getFFCache(factionId) {
        try {
            const raw = localStorage.getItem(FF_CACHE_PREFIX + factionId);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj.cachedAt || (Date.now() - obj.cachedAt) > FF_CACHE_TTL_MS) return null;
            return obj;
        } catch (e) { return null; }
    }

    function setFFCache(factionId, data) {
        try {
            localStorage.setItem(FF_CACHE_PREFIX + factionId, JSON.stringify({
                cachedAt: Date.now(),
                ff: data.ff || {},
                bs: data.bs || {}
            }));
            const dayKey = FF_REFRESH_DAY_KEY + factionId;
            localStorage.setItem(dayKey, new Date().toDateString());
        } catch (e) { /* ignore */ }
    }

    function shouldRefreshFFToday(factionId) {
        const last = localStorage.getItem(FF_REFRESH_DAY_KEY + factionId);
        return last !== new Date().toDateString();
    }

    /** Uses the same FF Scouter pull as Faction Battle Stats (app.js getFFAndBattleStatsForMembers). */
    async function fetchFFForMembers(apiKey, memberIds) {
        if (!memberIds || memberIds.length === 0) return { ff: {}, bs: {} };
        const fn = window.getFFAndBattleStatsForMembers;
        if (typeof fn !== 'function') throw new Error('FF Scouter not available. Ensure the main app is loaded.');
        return fn(apiKey, memberIds);
    }

    function getFFColor(ff, blue, green, orange) {
        if (ff == null || ff === '' || isNaN(ff)) return '';
        const v = Number(ff);
        if (v < blue) return '#4fc3f7';
        if (v < green) return '#81c784';
        if (v < orange) return '#ffb74d';
        return '#e57373';
    }

    function statusFromMember(m) {
        const la = m.last_action || {};
        const st = m.status || {};
        const actionStatus = (la.status || 'Offline').toLowerCase();
        const state = (st.state || '').toLowerCase();
        const description = st.description || '';
        return {
            actionStatus: actionStatus,
            state: state,
            description: description,
            until: st.until
        };
    }

    /** Return CSS color for Status column: Online=green, Idle=orange, Abroad=blue, else inherit. */
    function getStatusColor(status, nowSec) {
        const expired = status.until != null && nowSec >= status.until;
        if (!expired) {
            const state = (status.state || '').toLowerCase();
            const desc = (status.description || '').toLowerCase();
            if (state.includes('abroad') || state.includes('traveling') || desc.includes('abroad')) return '#6eb5ff';
        }
        const a = (status.actionStatus || '').toLowerCase();
        if (a === 'online') return '#81c784';
        if (a === 'idle') return '#ffb74d';
        return '';
    }

    /** Return CSS color for Location/state column: Okay=green, Abroad=blue, else red. */
    function getLocationStateColor(status, nowSec) {
        const expired = status.until != null && nowSec >= status.until;
        if (expired) return '#81c784'; // Okay when expired
        const state = (status.state || '').toLowerCase();
        const desc = (status.description || '').toLowerCase();
        if (state.includes('abroad') || state.includes('traveling') || desc.includes('abroad')) return '#6eb5ff';
        if (state === 'okay' || desc === 'okay') return '#81c784';
        return '#e57373'; // anything else (hospital, jail, etc.)
    }

    /** Parse country from status description (e.g. "Traveling in Japan" -> "japan") for same-country abroad check. */
    function parseAbroadCountry(member) {
        const st = member.status || {};
        const desc = (st.description || '').toLowerCase();
        const state = (st.state || '').toLowerCase();
        if (!state.includes('abroad') && !state.includes('traveling') && !desc.includes('abroad')) return null;
        const m = desc.match(/(?:traveling\s+in|abroad\s*[-–]\s*|in\s+)([a-z\s]{2,30}?)(?:\s*$|\s+for|\.|,)/i) || desc.match(/([a-z][a-z\s]{2,25})/);
        return m ? m[1].trim().toLowerCase() : (desc || null);
    }

    function isAbroad(m, nowSec) {
        const status = statusFromMember(m);
        const state = (status.state || '').toLowerCase();
        const desc = (status.description || '').toLowerCase();
        const statusExpired = status.until != null && nowSec >= status.until;
        return !statusExpired && (state.includes('abroad') || state.includes('traveling') || desc.includes('abroad'));
    }

    /** True if enemy can be shown in recommended (not abroad, or abroad in same country as current user). */
    function canShowInRecommended(enemy) {
        if (!isAbroad(enemy, Math.floor(Date.now() / 1000))) return true;
        if (currentUserAbroadCountry == null) return false;
        const enemyCountry = parseAbroadCountry(enemy);
        if (!enemyCountry || !currentUserAbroadCountry) return false;
        return enemyCountry.includes(currentUserAbroadCountry) || currentUserAbroadCountry.includes(enemyCountry);
    }

    // --- Faction activity tracker (local cache, 5-min samples, graph + active times TCT) ---
    function getActivityConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.activityTrackerConfig);
            if (!raw) return { tracked: [] };
            const obj = JSON.parse(raw);
            if (!Array.isArray(obj.tracked)) return { tracked: [] };
            obj.tracked.forEach(function (t) {
                if (t && isActivityFactionLocallyDisabled(t.factionId)) {
                    t.enabled = false;
                    if (t.disabledAt == null) t.disabledAt = Date.now();
                }
            });
            return obj;
        } catch (e) { return { tracked: [] }; }
    }

    function setActivityConfig(config) {
        try {
            localStorage.setItem(STORAGE_KEYS.activityTrackerConfig, JSON.stringify(config));
        } catch (e) { /* ignore */ }
    }

    function getActivityDisabledFactionMap() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.activityTrackerDisabledFactions);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) { return {}; }
    }

    function setActivityDisabledFactionMap(map) {
        try {
            localStorage.setItem(STORAGE_KEYS.activityTrackerDisabledFactions, JSON.stringify(map || {}));
        } catch (e) { /* ignore */ }
    }

    function isActivityFactionLocallyDisabled(factionId) {
        const fid = String(factionId || '').trim();
        if (!fid) return false;
        return getActivityDisabledFactionMap()[fid] != null;
    }

    function setActivityFactionLocallyDisabled(factionId, disabled) {
        const fid = String(factionId || '').trim();
        if (!fid) return;
        const map = getActivityDisabledFactionMap();
        if (disabled) map[fid] = Date.now();
        else delete map[fid];
        setActivityDisabledFactionMap(map);
    }

    /** True if factionId is already tracked, or under the per-player cap. */
    function canAddActivityTrackedFaction(factionId) {
        const fid = String(factionId || '').trim();
        const tracked = getActivityConfig().tracked || [];
        if (fid && tracked.some(function (t) { return String(t.factionId) === fid; })) return true;
        return tracked.length < MAX_ACTIVITY_TRACKED_FACTIONS;
    }

    function getActivityTrackedEntry(factionId) {
        const fid = String(factionId || '').trim();
        if (!fid) return null;
        return (getActivityConfig().tracked || []).find(function (t) {
            return String(t.factionId) === fid;
        }) || null;
    }

    function isActivityFactionEnabled(factionId) {
        const entry = getActivityTrackedEntry(factionId);
        return !!(entry && entry.enabled && !isActivityFactionLocallyDisabled(factionId));
    }

    function getEnabledActivityTrackedFactionIds() {
        return (getActivityConfig().tracked || [])
            .filter(function (t) { return t && t.enabled && !isActivityFactionLocallyDisabled(t.factionId); })
            .map(function (t) { return String(t.factionId); })
            .filter(Boolean);
    }

    function activityTrackedLimitMessage() {
        return (
            'You can track at most ' +
            MAX_ACTIVITY_TRACKED_FACTIONS +
            ' factions for activity. Remove one before adding another.'
        );
    }

    /**
     * If local list exceeds the cap (legacy), keep earliest startedAt and unregister extras on the server.
     * @returns {boolean} true if list was trimmed
     */
    function enforceActivityTrackedLimitLocal() {
        const config = getActivityConfig();
        if (!config.tracked || config.tracked.length <= MAX_ACTIVITY_TRACKED_FACTIONS) return false;
        const sorted = config.tracked.slice().sort(function (a, b) {
            return (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0);
        });
        const keep = sorted.slice(0, MAX_ACTIVITY_TRACKED_FACTIONS);
        const drop = sorted.slice(MAX_ACTIVITY_TRACKED_FACTIONS);
        config.tracked = keep;
        setActivityConfig(config);
        drop.forEach(function (t) {
            syncTrackedFactionToFirestore(t.factionId, 'remove');
        });
        return true;
    }

    function getActivityLastVisit() {
        const raw = localStorage.getItem(STORAGE_KEYS.activityTrackerLastVisit);
        return raw ? parseInt(raw, 10) : 0;
    }

    function setActivityLastVisit(ms) {
        try {
            localStorage.setItem(STORAGE_KEYS.activityTrackerLastVisit, String(ms));
        } catch (e) { /* ignore */ }
    }

    function getActivityCloudIgnoreBeforeMs(factionId) {
        try {
            const v = localStorage.getItem(ACTIVITY_CLOUD_IGNORE_BEFORE_PREFIX + String(factionId));
            if (!v) return 0;
            const n = parseInt(v, 10);
            return Number.isFinite(n) && n > 0 ? n : 0;
        } catch (e) {
            return 0;
        }
    }

    function setActivityCloudIgnoreBeforeMs(factionId, ms) {
        try {
            localStorage.setItem(ACTIVITY_CLOUD_IGNORE_BEFORE_PREFIX + String(factionId), String(ms));
        } catch (e) { /* ignore */ }
    }

    function clearActivityCloudIgnoreBeforeMs(factionId) {
        try {
            localStorage.removeItem(ACTIVITY_CLOUD_IGNORE_BEFORE_PREFIX + String(factionId));
        } catch (e) { /* ignore */ }
    }

    /** Get activity data from localStorage only (7-day trim). Used for merge and fallback. */
    function getActivityDataFromStorage(factionId) {
        try {
            const raw = localStorage.getItem(ACTIVITY_DATA_PREFIX + factionId);
            if (!raw) return { samples: [], members: [] };
            const obj = JSON.parse(raw);
            const samples = Array.isArray(obj.samples) ? obj.samples : [];
            const members = Array.isArray(obj.members) ? obj.members : [];
            const cutoff = Date.now() - ACTIVITY_DATA_RETENTION_MS;
            const ignoreBefore = getActivityCloudIgnoreBeforeMs(factionId);
            const trimmed = samples.filter(function (s) {
                if (!s || s.t < cutoff) return false;
                return ignoreBefore <= 0 || s.t >= ignoreBefore;
            });
            return { samples: trimmed, members };
        } catch (e) { return { samples: [], members: [] }; }
    }

    /** Sync: return cached merged data if present, else localStorage (7-day). */
    function getActivityData(factionId) {
        if (activityDataCache[factionId]) return activityDataCache[factionId];
        return getActivityDataFromStorage(factionId);
    }

    function getActivityCloudCursorT() {
        if (activityCloudCursorT > 0) return activityCloudCursorT;
        try {
            const raw = localStorage.getItem(ACTIVITY_CLOUD_CURSOR_KEY);
            const n = raw != null ? Number(raw) : 0;
            if (Number.isFinite(n) && n > 0) {
                activityCloudCursorT = n;
                return n;
            }
        } catch (e) { /* ignore */ }
        return 0;
    }

    function setActivityCloudCursorT(t) {
        const n = Number(t);
        if (!Number.isFinite(n) || n <= 0) return;
        activityCloudCursorT = n;
        try {
            localStorage.setItem(ACTIVITY_CLOUD_CURSOR_KEY, String(n));
        } catch (e) { /* ignore */ }
    }

    function clearActivityCloudCursor() {
        activityCloudCursorT = 0;
        try {
            localStorage.removeItem(ACTIVITY_CLOUD_CURSOR_KEY);
        } catch (e) { /* ignore */ }
    }

    function getActivityCloudFactionIds(options) {
        if (options && options.factionIds && options.factionIds.length) {
            return options.factionIds.map(function (id) { return String(id); }).filter(function (id) {
                return isActivityFactionEnabled(id);
            });
        }
        return getEnabledActivityTrackedFactionIds();
    }

    function parseActivityWindowDoc(data) {
        const out = [];
        if (!data || !Array.isArray(data.samples)) return out;
        data.samples.forEach(function (s) {
            if (!s) return;
            const tVal = s.t != null && typeof s.t.toMillis === 'function' ? s.t.toMillis() : Number(s.t);
            const ids = s.onlineIds || s.o;
            if (!Number.isFinite(tVal) || !Array.isArray(ids)) return;
            out.push({ t: tVal, onlineIds: ids.map(String) });
        });
        return out;
    }

    function maxSampleTFromSamples(samples) {
        let maxT = 0;
        (samples || []).forEach(function (s) {
            if (s && Number.isFinite(s.t) && s.t > maxT) maxT = s.t;
        });
        return maxT;
    }

    /** Load persisted samples from localStorage into memory — charts render instantly on refresh. */
    function hydrateActivityDataCacheFromLocalStorage(factionIds) {
        const ids = factionIds || getActivityConfig().tracked.map(function (t) {
            return String(t.factionId);
        });
        ids.forEach(function (fid) {
            const stored = getActivityDataFromStorage(fid);
            if ((stored.samples && stored.samples.length) || (stored.members && stored.members.length)) {
                activityDataCache[fid] = stored;
            }
        });
    }

    function formatActivityRelativeTime(ms) {
        if (ms == null || !ms) return '—';
        const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        if (sec < 45) return 'just now';
        if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
        if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
        return Math.floor(sec / 86400) + 'd ago';
    }

    /** Firestore fetch: one shared doc per tracked faction (1 read each, not ~2k tick docs). */
    async function fetchActivitySamplesCloud(options) {
        const force = (options && options.force) || (options && options.full);
        const now = Date.now();
        if (
            !force &&
            activitySamplesCloudCache != null &&
            activitySamplesCloudFetchAt &&
            now - activitySamplesCloudFetchAt < ACTIVITY_FIRESTORE_REFRESH_MS
        ) {
            return activitySamplesCloudCache;
        }
        if (activitySamplesCloudFetchPromise) {
            return activitySamplesCloudFetchPromise;
        }

        activitySamplesCloudFetchPromise = (async function () {
            var db = null;
            try {
                if (typeof firebase !== 'undefined' && firebase.firestore) db = firebase.firestore();
            } catch (e) { /* ignore */ }

            const emptyResult = {
                byFaction: {},
                docsRead: 0,
                lastFetch: now,
                readError: !db
                    ? typeof firebase === 'undefined'
                        ? 'Firebase not loaded'
                        : 'Firestore unavailable'
                    : null
            };

            if (!db) {
                activitySamplesCloudCache = emptyResult;
                activitySamplesCloudFetchAt = now;
                return emptyResult;
            }

            const factionIds = getActivityCloudFactionIds(options);
            const uniqueIds = factionIds.filter(function (id, i, arr) {
                return id && arr.indexOf(id) === i;
            });

            if (!uniqueIds.length) {
                activitySamplesCloudCache = emptyResult;
                activitySamplesCloudFetchAt = now;
                return emptyResult;
            }

            var readError = null;
            var byFaction = {};
            var docsRead = 0;
            try {
                const snaps = await Promise.all(uniqueIds.map(function (fid) {
                    return db.collection(ACTIVITY_SAMPLE_WINDOWS_COLLECTION).doc(fid).get();
                }));
                let maxT = 0;
                snaps.forEach(function (snap, i) {
                    const fid = uniqueIds[i];
                    if (!snap.exists) return;
                    docsRead += 1;
                    const samples = parseActivityWindowDoc(snap.data());
                    if (samples.length) {
                        byFaction[fid] = samples;
                        const localMax = maxSampleTFromSamples(samples);
                        if (localMax > maxT) maxT = localMax;
                    }
                });
                if (maxT > getActivityCloudCursorT()) setActivityCloudCursorT(maxT);
            } catch (e) {
                readError = (e && e.message) ? e.message : String(e);
                const code = e && (e.code || e.message || '');
                if (/permission|insufficient|denied/i.test(String(code))) {
                    readError =
                        'This tab is using an outdated War Dashboard build. Hard-refresh the page (Ctrl+F5) to restore cloud activity sync.';
                    if (typeof window.showAppUpdateBanner === 'function') {
                        window.showAppUpdateBanner();
                    } else if (!document.getElementById('app-update-banner')) {
                        var staleBar = document.createElement('div');
                        staleBar.id = 'app-update-banner';
                        staleBar.setAttribute('role', 'alert');
                        staleBar.style.cssText =
                            'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;' +
                            'width:max-content;max-width:calc(100vw - 24px);box-sizing:border-box;' +
                            'padding:10px 20px;background:#b45309;color:#fff;text-align:center;font-size:14px;' +
                            'border-radius:0 0 10px 10px;box-shadow:0 4px 14px rgba(0,0,0,0.35);' +
                            'display:inline-flex;align-items:center;justify-content:center;flex-wrap:wrap;';
                        staleBar.innerHTML =
                            'War Dashboard update available — <button type="button" style="margin-left:8px;padding:4px 12px;font-weight:600;">Refresh (Ctrl+F5)</button>';
                        staleBar.querySelector('button').onclick = function () { location.reload(); };
                        if (document.body) document.body.prepend(staleBar);
                    }
                }
                console.warn('Activity Firestore read failed', e);
            }

            const result = {
                byFaction: byFaction,
                docsRead: docsRead,
                lastFetch: now,
                readError: readError
            };
            activitySamplesCloudCache = result;
            activitySamplesCloudFetchAt = now;
            return result;
        })().finally(function () {
            activitySamplesCloudFetchPromise = null;
        });

        return activitySamplesCloudFetchPromise;
    }

    function mergeActivityCloudForFaction(factionId, cloud) {
        const fid = String(factionId);
        const cutoff = Date.now() - ACTIVITY_DATA_RETENTION_MS;
        let firestoreSamples = (cloud.byFaction && cloud.byFaction[fid]) ? cloud.byFaction[fid].slice() : [];
        const ignoreBefore = getActivityCloudIgnoreBeforeMs(fid);
        if (ignoreBefore > 0) {
            firestoreSamples = firestoreSamples.filter(function (s) {
                return s.t >= ignoreBefore;
            });
        }
        const local = getActivityDataFromStorage(fid);
        const localSamples = (local.samples || []).filter(function (s) {
            return ignoreBefore <= 0 || s.t >= ignoreBefore;
        });
        const byT = {};
        localSamples.forEach(function (s) { byT[s.t] = s; });
        firestoreSamples.forEach(function (s) { byT[s.t] = s; });
        const merged = Object.keys(byT)
            .map(function (k) { return byT[k]; })
            .filter(function (s) { return s.t >= cutoff; })
            .sort(function (a, b) { return a.t - b.t; });
        activityDataCache[fid] = { samples: merged, members: local.members || [] };
        try {
            setActivityData(fid, activityDataCache[fid]);
        } catch (e) { /* ignore */ }
        activityDataCloudMeta[fid] = {
            cloudDocsRead: cloud.byFaction && cloud.byFaction[fid] ? 1 : 0,
            cloudSampleCount: firestoreSamples.length,
            lastFetch: cloud.lastFetch,
            readError: cloud.readError
        };
    }

    /** Local cache first, then Firestore (one doc per tracked faction). Persists merged result to localStorage. */
    async function refreshAllTrackedActivityFromCloud(options) {
        hydrateActivityDataCacheFromLocalStorage();
        const enabledIds = getActivityCloudFactionIds(options);
        if (!enabledIds.length) return { byFaction: {}, docsRead: 0, lastFetch: Date.now(), readError: null };
        options = Object.assign({}, options || {}, { factionIds: enabledIds });
        const cloud = await fetchActivitySamplesCloud(options);
        const cfg = getActivityConfig();
        cfg.tracked.forEach(function (t) {
            if (!t.enabled) return;
            mergeActivityCloudForFaction(t.factionId, cloud);
        });
        return cloud;
    }

    /** Periodic cloud refresh: one doc read per tracked faction, update all enabled charts. */
    function runActivityCloudRefreshTick() {
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        const cfg = getActivityConfig();
        if (!cfg.tracked.some(function (t) { return t.enabled; })) return;
        refreshAllTrackedActivityFromCloud().then(function () {
            cfg.tracked.forEach(function (t) {
                if (!t.enabled) return;
                const fid = String(t.factionId);
                if (document.getElementById('war-dashboard-activity-chart-' + fid)) {
                    renderActivityTrackerChart(fid);
                    renderActivityTrackerTable(fid);
                    updateActivityCloudStatusUI(fid);
                }
            });
        }).catch(function () {});
    }

    /** Load activity samples from Firestore, merge with local, update cache. One shared doc per faction. */
    async function ensureActivityDataLoaded(factionId, options) {
        hydrateActivityDataCacheFromLocalStorage([String(factionId)]);
        if (!isActivityFactionEnabled(factionId)) return;
        const opts = Object.assign({}, options || {}, { factionIds: [String(factionId)] });
        const cloud = await fetchActivitySamplesCloud(opts);
        mergeActivityCloudForFaction(factionId, cloud);
    }

    function updateActivityCloudStatusUI(factionId) {
        const fid = String(factionId);
        const el = document.querySelector('.war-dashboard-activity-cloud-status[data-faction-id="' + fid.replace(/"/g, '') + '"]');
        if (!el) return;
        const meta = activityDataCloudMeta[fid];
        const reg = activityCloudRegisterState[fid];
        const bits = [];
        if (!isActivityFactionEnabled(fid)) {
            el.textContent = 'Paused. No Firebase reads, writes, or server sampling while this tracker is off.';
            el.style.color = '#9e9e9e';
            return;
        }
        if (reg && reg.ok === false && reg.error) {
            bits.push('24/7 server sampling not registered: ' + reg.error);
        } else if (reg && reg.ok) {
            bits.push('Server samples (Firebase) enabled.');
        }
        const localCount = (getActivityData(fid).samples || []).length;
        if (meta) {
            if (meta.readError) {
                bits.push('Could not read cloud history — ' + meta.readError);
            } else if (meta.cloudSampleCount > 0 || meta.cloudDocsRead > 0) {
                bits.push(
                    'Shared cloud history (' +
                    meta.cloudSampleCount +
                    ' sample' + (meta.cloudSampleCount === 1 ? '' : 's') +
                    ', ' +
                    meta.cloudDocsRead +
                    ' Firestore doc' + (meta.cloudDocsRead === 1 ? '' : 's') +
                    ', ' +
                    localCount +
                    ' cached). ' +
                    formatActivityRelativeTime(meta.lastFetch) +
                    '.'
                );
            } else if (localCount > 0) {
                bits.push('Showing ' + localCount + ' cached samples (no cloud doc yet for this faction). ' + formatActivityRelativeTime(meta.lastFetch) + '.');
            } else {
                bits.push('No cloud history yet — server builds a shared doc as users track this faction.');
            }
        } else if (localCount > 0) {
            bits.push('Showing ' + localCount + ' cached samples. Syncing new cloud data…');
        }
        el.textContent = bits.length ? bits.join(' ') : 'Loading cloud status…';
        const bad = (reg && reg.ok === false) || (meta && meta.readError);
        el.style.color = bad ? '#ff8a80' : '#9e9e9e';
    }

    function updateAllActivityCloudStatusUI() {
        getActivityConfig().tracked.forEach(function (t) {
            updateActivityCloudStatusUI(t.factionId);
        });
    }

    /** Persistent anonymous id for this browser so the backend can associate our API key with our tracked factions. */
    function getOrCreateActivityUserId() {
        var key = 'war_dashboard_activity_user_id';
        try {
            var id = localStorage.getItem(key);
            if (id && id.length > 0) return id;
            id = 'uid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
            localStorage.setItem(key, id);
            return id;
        } catch (e) { return 'uid_' + Date.now(); }
    }

    /** Optional Torn player id (set after profile load) — sent to Firebase so tracked factions restore on another origin (e.g. localhost). */
    function activityPayloadTornPlayerId() {
        if (currentUserPlayerId == null || currentUserPlayerId === '') return {};
        return { tornPlayerId: String(currentUserPlayerId) };
    }

    /** Tell the backend to add/remove this faction for 24/7 sampling. Uses your API key (add) and a persistent userId. Returns a Promise. */
    function syncTrackedFactionToFirestore(factionId, action) {
        var functions = null;
        try {
            if (typeof firebase !== 'undefined' && firebase.functions) functions = firebase.functions();
        } catch (e) { /* ignore */ }
        var fid = String(factionId);
        var uid = getOrCreateActivityUserId();
        if (!functions) {
            activityCloudRegisterState[fid] = { ok: false, error: 'Firebase Functions not loaded', at: Date.now() };
            return Promise.resolve({ ok: false, error: 'Firebase Functions not loaded' });
        }
        if (action === 'add') {
            if (!isActivityFactionEnabled(fid)) {
                return Promise.resolve({ ok: false, error: 'Tracker paused' });
            }
            var apiKey = (getApiKey() || '').trim();
            if (!apiKey) {
                activityCloudRegisterState[fid] = { ok: false, error: 'No API key in sidebar', at: Date.now() };
                return Promise.resolve({ ok: false, error: 'No API key in sidebar' });
            }
            var addPayload = Object.assign({ factionId: fid, apiKey: apiKey, userId: uid }, activityPayloadTornPlayerId());
            return functions.httpsCallable('addTrackedFaction')(addPayload)
                .then(function () {
                    activityCloudRegisterState[fid] = { ok: true, error: null, at: Date.now() };
                    return { ok: true };
                })
                .catch(function (err) {
                    var code = err && err.code ? String(err.code) : '';
                    var msg = (err && err.message) ? String(err.message) : String(err);
                    var detail = (err && err.details) ? String(err.details) : '';
                    var line = [code, msg, detail].filter(Boolean).join(' — ') || 'Unknown error';
                    console.warn('addTrackedFaction failed', fid, err);
                    activityCloudRegisterState[fid] = { ok: false, error: line, at: Date.now() };
                    return { ok: false, error: line };
                });
        }
        if (action === 'remove') {
            delete activityCloudRegisterState[fid];
            var removePayload = Object.assign({ factionId: fid, userId: uid }, activityPayloadTornPlayerId());
            return functions.httpsCallable('removeTrackedFaction')(removePayload)
                .then(function () { return { ok: true }; })
                .catch(function (err) {
                    console.warn('removeTrackedFaction failed', fid, err);
                    return { ok: false, error: String(err.message || err) };
                });
        }
        return Promise.resolve({ ok: true });
    }

    /**
     * If local activity tracker list is empty, pull faction IDs from Firebase (same Torn player / registrations).
     * localStorage is per-origin; this restores after opening localhost or a new port.
     */
    async function mergeActivityTrackedFromCloudIfEmpty() {
        var cfg0 = getActivityConfig();
        if (cfg0.tracked.length > 0) return;
        var apiKey = (getApiKey() || '').trim();
        if (!apiKey || currentUserPlayerId == null || currentUserPlayerId === '') return;
        var functions = null;
        try {
            if (typeof firebase !== 'undefined' && firebase.functions) functions = firebase.functions();
        } catch (e) { return; }
        if (!functions) return;
        try {
            var res = await functions.httpsCallable('listMyActivityFactions')({
                userId: getOrCreateActivityUserId(),
                tornPlayerId: String(currentUserPlayerId),
                apiKey: apiKey
            });
            var data = res && res.data;
            var ids = (data && data.factionIds) || [];
            if (!ids.length) return;
            var cfg = getActivityConfig();
            if (cfg.tracked.length > 0) return;
            var seen = new Set();
            cfg.tracked.forEach(function (t) { seen.add(String(t.factionId)); });
            ids.forEach(function (fid) {
                var s = String(fid);
                if (seen.has(s)) return;
                if (isActivityFactionLocallyDisabled(s)) {
                    syncTrackedFactionToFirestore(s, 'remove').catch(function () {});
                    return;
                }
                if (cfg.tracked.length >= MAX_ACTIVITY_TRACKED_FACTIONS) return;
                seen.add(s);
                cfg.tracked.push({
                    factionId: s,
                    factionName: 'Faction ' + s,
                    enabled: false,
                    disabledAt: Date.now(),
                    startedAt: Date.now()
                });
            });
            setActivityConfig(cfg);
        } catch (e) {
            console.warn('listMyActivityFactions', e);
        }
    }

    function syncAllTrackedFactionsToFirestoreThenRefreshStatus() {
        var cfg = getActivityConfig();
        if (!cfg.tracked.length) return;
        Promise.all(cfg.tracked.filter(function (t) {
            return t && t.enabled && !isActivityFactionLocallyDisabled(t.factionId);
        }).map(function (t) {
            return syncTrackedFactionToFirestore(t.factionId, 'add');
        })).then(function () {
            updateAllActivityCloudStatusUI();
        }).catch(function (e) { console.warn('syncAllTrackedFactionsToFirestore', e); });
    }

    function setActivityData(factionId, data) {
        try {
            const cutoff = Date.now() - ACTIVITY_DATA_RETENTION_MS;
            const samples = (data.samples || []).filter(s => s.t >= cutoff);
            localStorage.setItem(ACTIVITY_DATA_PREFIX + factionId, JSON.stringify({
                samples,
                members: data.members || []
            }));
        } catch (e) { /* ignore */ }
    }

    function appendActivitySample(factionId, onlineIds, members) {
        const existing = getActivityData(factionId);
        const memberList = Array.isArray(members) && members.length ? members.map(m => ({ id: m.id, name: m.name || String(m.id), level: m.level })) : existing.members;
        existing.samples.push({ t: Date.now(), onlineIds: onlineIds || [] });
        setActivityData(factionId, { samples: existing.samples, members: memberList });
        if (activityDataCache[factionId]) activityDataCache[factionId] = { samples: existing.samples, members: memberList };
    }

    function updateActivityLastVisitAndCleanup() {
        const now = Date.now();
        const previousLastVisit = getActivityLastVisit();
        setActivityLastVisit(now);
        const config = getActivityConfig();
        if (previousLastVisit > 0 && (now - previousLastVisit) > TWO_DAYS_MS) {
            config.tracked.forEach(t => {
                if (t.enabled) {
                    t.enabled = false;
                    t.disabledAt = now;
                    syncTrackedFactionToFirestore(t.factionId, 'remove');
                }
            });
            setActivityConfig(config);
        }
        const threeDaysAgo = now - THREE_DAYS_MS;
        let changed = false;
        config.tracked = config.tracked.filter(t => {
            if (t.disabledAt != null && t.disabledAt < threeDaysAgo) {
                try { localStorage.removeItem(ACTIVITY_DATA_PREFIX + t.factionId); } catch (e) { /* ignore */ }
                changed = true;
                return false;
            }
            return true;
        });
        if (changed) setActivityConfig(config);
        enforceActivityTrackedLimitLocal();
    }

    function warDashboardFloor2(n) {
        return Math.floor((Number(n) || 0) * 100) / 100;
    }

    function warDashboardBaseRespect(level) {
        const lvl = Number(level);
        if (!Number.isFinite(lvl) || lvl <= 0) return null;
        return warDashboardFloor2((lvl / 200) + 1);
    }

    function warDashboardRespectChainModifier(chain) {
        const mod = Number(chain && chain.modifier);
        return Number.isFinite(mod) && mod > 0 ? mod : 1;
    }

    function warDashboardRespectWarlordConfig() {
        const enabled = document.getElementById('war-dashboard-respect-warlord-enabled')?.checked === true;
        const raw = Number(document.getElementById('war-dashboard-respect-warlord-percent')?.value);
        const percent = Number.isFinite(raw) && raw >= 0 ? raw : 15;
        return {
            enabled,
            percent,
            multiplier: enabled ? 1 + (percent / 100) : 1
        };
    }

    function warDashboardEstimateRespect(member, ffMap, respectContext) {
        const id = String(member && member.id);
        const ff = ffMap && ffMap[id] != null ? Number(ffMap[id]) : null;
        const base = warDashboardBaseRespect(member && member.level);
        if (!Number.isFinite(ff) || ff <= 0 || base == null) return null;
        const cappedFf = Math.min(ff, 3);
        const chainModifier = warDashboardRespectChainModifier(respectContext && respectContext.chain);
        const warModifier = respectContext && respectContext.isCurrentWarEnemy ? 2 : 1;
        const nowSec = Math.floor(Date.now() / 1000);
        const overseasModifier = member && isAbroad(member, nowSec) ? 1.25 : 1;
        const retaliationModifier =
            respectContext &&
            respectContext.retaliationTargetIds &&
            respectContext.retaliationTargetIds.has(id)
                ? 1.5
                : 1;
        const warlord = warDashboardRespectWarlordConfig();
        const respect =
            base *
            cappedFf *
            chainModifier *
            warModifier *
            overseasModifier *
            retaliationModifier *
            warlord.multiplier;
        return {
            respect,
            base,
            ff,
            cappedFf,
            chainModifier,
            warModifier,
            overseasModifier,
            retaliationModifier,
            warlordModifier: warlord.multiplier,
            warlordPercent: warlord.percent,
            warlordEnabled: warlord.enabled,
            isCurrentWarEnemy: !!(respectContext && respectContext.isCurrentWarEnemy)
        };
    }

    function warDashboardRespectText(calc) {
        return calc ? calc.respect.toFixed(2) : '—';
    }

    function warDashboardRespectClass(calc, ff, thresholds, respectRange) {
        if (!calc || !Number.isFinite(calc.respect)) return 'war-dashboard-respect-value--unavailable';
        const ffValue = Number(ff);
        if (Number.isFinite(ffValue)) {
            if (ffValue >= thresholds.orange) return 'war-dashboard-respect-value--danger';
            if (ffValue >= thresholds.green) return 'war-dashboard-respect-value--difficult';
        }
        const min = Number(respectRange && respectRange.min);
        const max = Number(respectRange && respectRange.max);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 'war-dashboard-respect-value--target-high';
        const score = (calc.respect - min) / (max - min);
        if (score >= 0.67) return 'war-dashboard-respect-value--target-high';
        if (score >= 0.34) return 'war-dashboard-respect-value--target-medium';
        return 'war-dashboard-respect-value--target-low';
    }

    function warDashboardRespectTooltip(calc) {
        if (!calc) {
            return 'Respect estimate unavailable until target level and FF are loaded.';
        }
        return [
            'Estimated respect for a normal attack.',
            'Torn Wiki formula: base respect = floor((target level / 200 + 1) * 100) / 100.',
            'Estimate = base × capped FF × chain × war × overseas × retaliation × warlord.',
            'Base: ' + calc.base.toFixed(2),
            'FF: ' + calc.ff.toFixed(2) + (calc.ff > 3 ? ' (capped to 3.00)' : ''),
            'Chain modifier: ×' + calc.chainModifier.toFixed(2),
            'War modifier: ×' + calc.warModifier.toFixed(2) + (calc.isCurrentWarEnemy ? ' (current ranked-war enemy)' : ' (not applied)'),
            'Overseas modifier: ×' + calc.overseasModifier.toFixed(2) + (calc.overseasModifier > 1 ? ' (enemy abroad)' : ''),
            'Retaliation modifier: ×' + calc.retaliationModifier.toFixed(2) + (calc.retaliationModifier > 1 ? ' (enemy attacked us in last 5 minutes; assumes hospitalize)' : ''),
            'Warlord modifier: ×' + calc.warlordModifier.toFixed(2) + (calc.warlordEnabled ? ' (' + calc.warlordPercent + '% selected)' : ' (off)'),
            'Result: ' + calc.respect.toFixed(2),
            'Mug applies ×0.75 in Torn, so mugging would reduce this estimate.',
            'Not included here: group attacks, exact attack result, or chain milestone bonus.'
        ].join('\n');
    }

    function getSortValue(m, column, ffMap, bsMap, nowSec, respectContext) {
        const id = String(m.id);
        const status = statusFromMember(m);
        const expired = status.until != null && nowSec >= status.until;
        const locationDisplay = formatLocationStatusDisplay(status, nowSec);
        switch (column) {
            case 'member': return (m.name || id).toLowerCase();
            case 'level': return Number(m.level) || -1;
            case 'ff': return ffMap[id] != null ? Number(ffMap[id]) : -1;
            case 'respect': {
                const calc = warDashboardEstimateRespect(m, ffMap, respectContext);
                return calc ? calc.respect : -1;
            }
            case 'eststats': return bsMap[id] != null ? Number(bsMap[id]) : -1;
            case 'status': return status.actionStatus;
            case 'location': return locationDisplay.toLowerCase();
            default: return '';
        }
    }

    function sortMembers(list, column, dir, ffMap, bsMap, respectContext) {
        const nowSec = Math.floor(Date.now() / 1000);
        const mult = dir === 'asc' ? 1 : -1;
        return [...list].sort((a, b) => {
            const va = getSortValue(a, column, ffMap, bsMap, nowSec, respectContext);
            const vb = getSortValue(b, column, ffMap, bsMap, nowSec, respectContext);
            if (typeof va === 'number' && typeof vb === 'number') return mult * (va - vb);
            return mult * String(va).localeCompare(String(vb));
        });
    }

    function updateSortIndicators(tableId, sortColumn, sortDir) {
        const table = document.getElementById(tableId);
        if (!table) return;
        table.querySelectorAll('th.war-dashboard-th-sort').forEach(th => {
            const col = th.getAttribute('data-column');
            const span = th.querySelector('.war-dashboard-sort');
            if (span) span.textContent = col === sortColumn ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
        });
    }

    function renderOurTeam(members, ffMap, bsMap, thresholds) {
        const table = document.getElementById('war-dashboard-our-table');
        const tbody = table ? table.querySelector('tbody') : null;
        const avgEl = document.getElementById('war-dashboard-our-average');
        if (!tbody) return;

        const blue = Number(document.getElementById('war-dashboard-ff-blue')?.value) || 2.5;
        const green = Number(document.getElementById('war-dashboard-ff-green')?.value) || 3.5;
        const orange = Number(document.getElementById('war-dashboard-ff-orange')?.value) || 4.5;
        bsMap = bsMap || {};

        const sorted = sortMembers(members, ourSortColumn, ourSortDir, ffMap, bsMap, null);
        updateSortIndicators('war-dashboard-our-table', ourSortColumn, ourSortDir);

        const nowSec = Math.floor(Date.now() / 1000);
        let sum = 0;
        let count = 0;
        const rowHtml = sorted.map(m => {
            const id = m.id;
            const ff = ffMap[String(id)];
            const bs = bsMap[String(id)];
            if (ff != null) { sum += ff; count++; }
            const status = statusFromMember(m);
            const statusDisplay = formatLocationStatusDisplay(status, nowSec);
            const color = getFFColor(ff, blue, green, orange);
            const statusColor = getStatusColor(status, nowSec);
            const ffText = ff != null ? ff.toFixed(2) : '—';
            const bsText = bs != null ? Number(bs).toLocaleString() : '—';
            const memLabelOur = window.toolsFormatMemberDisplayLabel({ name: m.name || id, id }, window.toolsGetShowMemberIdInBrackets());
            return `<tr>
                <td><a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener" style="color: #FFD700;"${window.toolsMemberLinkAttrs(m.name || id, id)}>${escapeHtml(memLabelOur)}</a></td>
                <td>${escapeHtml(m.level != null ? String(m.level) : '—')}</td>
                <td style="background-color: ${color || 'transparent'};">${ffText}</td>
                <td>${bsText}</td>
                <td${statusColor ? ' style="color: ' + statusColor + ';"' : ''}>${escapeHtml(status.actionStatus)}</td>
                ${warDashboardLocationCellOpenTag(status, nowSec)}${escapeHtml(statusDisplay)}</td>
            </tr>`;
        }).join('');
        tbody.innerHTML = rowHtml;

        if (avgEl) avgEl.textContent = count ? `Average FF: ${(sum / count).toFixed(2)}` : 'Average FF: —';
    }

    /** Tick down timeout/cooldown display state every second (only when tracking is on for that chain). */
    function updateChainDisplays() {
        if (getTrackOurChain() && lastOurChain) {
            if (ourChainDisplay.timeout > 0) ourChainDisplay.timeout--;
            else if (ourChainDisplay.cooldown > 0) ourChainDisplay.cooldown--;
        }
        if (getTrackEnemyChain()) {
            enemyFactionStates.forEach(function (enemy) {
                if (!enemy.chain || !enemy.chainDisplay) return;
                if (enemy.chainDisplay.timeout > 0) enemy.chainDisplay.timeout--;
                else if (enemy.chainDisplay.cooldown > 0) enemy.chainDisplay.cooldown--;
            });
            syncPrimaryEnemyFromStates();
        }
    }

    function formatMinutesSeconds(sec) {
        const s = Math.max(0, Math.floor(sec));
        const m = Math.floor(s / 60);
        const remainder = s % 60;
        return `${m}m ${remainder}s`;
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
    }

    function formatHmsCountdown(totalSec) {
        const s = Math.max(0, Math.floor(totalSec));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }

    function titleCaseWords(s) {
        return String(s || '')
            .trim()
            .replace(/\b([a-z])/g, function (_, c) {
                return c.toUpperCase();
            });
    }

    function isInHospitalStatus(status, nowSec) {
        if (status.until != null && nowSec >= status.until) return false;
        const blob = ((status.state || '') + ' ' + (status.description || '')).toLowerCase();
        return blob.includes('hospital');
    }

    function normalizeHospitalPlaceName(place) {
        const p = String(place || '').trim();
        if (!p) return 'Torn';
        if (/^torn(\s+city)?$/i.test(p)) return 'Torn';
        return titleCaseWords(p);
    }

    /** Place name for hospital countdown: "Torn" in city, otherwise country (e.g. "Switzerland"). */
    function parseHospitalPlaceName(description, state) {
        const desc = (description || '').trim();
        const lower = desc.toLowerCase();
        if (!desc || (!lower.includes('hospital') && !(state || '').toLowerCase().includes('hospital'))) {
            return 'Torn';
        }
        let m = desc.match(/hospital\s+in\s+(.+?)(?:\s+for\s+|$)/i);
        if (m) return normalizeHospitalPlaceName(m[1]);
        m = desc.match(/\bin\s+(.+?)\s+hospital\b/i);
        if (m) return normalizeHospitalPlaceName(m[1]);
        m = desc.match(/\bin\s+(.+?)(?:\s+for\s+)/i);
        if (m && lower.includes('hospital')) return normalizeHospitalPlaceName(m[1]);
        return 'Torn';
    }

    function formatHospitalCountdownDisplay(status, nowSec) {
        const remaining = Math.max(0, Math.floor(Number(status.until) - nowSec));
        if (remaining === 0) return 'Okay';
        const place = parseHospitalPlaceName(status.description, status.state);
        const hms = formatHmsCountdown(remaining);
        return hms + ' (In ' + place + ')';
    }

    /** Location column: hospital uses HH:MM:SS (+ country); other timed states use second precision under 1 minute. */
    function formatLocationStatusDisplay(status, nowSec) {
        if (status.until != null && nowSec >= status.until) return 'Okay';
        const base = (status.description || status.state || '—').trim();
        if (status.until == null || !Number.isFinite(Number(status.until))) return base;

        if (isInHospitalStatus(status, nowSec)) {
            return formatHospitalCountdownDisplay(status, nowSec);
        }

        const remaining = Math.max(0, Math.floor(Number(status.until) - nowSec));
        if (remaining >= 60) return base;
        if (remaining === 0) return 'Okay';

        const secLabel = remaining === 1 ? '1 second' : remaining + ' seconds';
        const replaced = base.replace(/\d+\s*(?:minutes?|mins?)\b/i, secLabel);
        if (replaced !== base) return replaced;

        const lower = base.toLowerCase();
        if (lower.includes('jail')) return 'In jail for ' + secLabel;
        if (lower.includes('traveling') || lower.includes('returning') || lower.includes('abroad')) {
            return base + ' (' + remaining + 's)';
        }
        return base + ' (' + remaining + 's)';
    }

    function warDashboardLocationCellOpenTag(status, nowSec) {
        const locData =
            status.until != null
                ? ' data-status-until="' +
                  escapeAttr(String(status.until)) +
                  '" data-status-desc="' +
                  escapeAttr(status.description || '') +
                  '" data-status-state="' +
                  escapeAttr(status.state || '') +
                  '"'
                : '';
        const hospitalTimer = isInHospitalStatus(status, nowSec) && status.until != null;
        const cls =
            'war-dashboard-location-cell' + (hospitalTimer ? ' war-dashboard-hospital-countdown' : '');
        const style = hospitalTimer ? '' : ' style="color: ' + getLocationStateColor(status, nowSec) + ';"';
        return '<td class="' + cls + '"' + style + locData + '>';
    }

    function updateLocationStatusTimers() {
        const nowSec = Math.floor(Date.now() / 1000);
        document.querySelectorAll('.war-dashboard-location-cell[data-status-until]').forEach(function (td) {
            const untilRaw = td.getAttribute('data-status-until');
            const until = untilRaw != null && untilRaw !== '' ? Number(untilRaw) : NaN;
            if (!Number.isFinite(until)) return;
            const status = {
                until: until,
                description: td.getAttribute('data-status-desc') || '',
                state: td.getAttribute('data-status-state') || '',
            };
            const display = formatLocationStatusDisplay(status, nowSec);
            const hospitalTimer = isInHospitalStatus(status, nowSec);
            td.textContent = display;
            if (nowSec >= until) {
                td.style.color = '#81c784';
                td.classList.remove('war-dashboard-hospital-countdown');
            } else if (hospitalTimer) {
                td.classList.add('war-dashboard-hospital-countdown');
                td.style.color = '';
            } else {
                td.classList.remove('war-dashboard-hospital-countdown');
                td.style.color = getLocationStateColor(status, nowSec);
            }
        });
    }

    /** HTML for who is on chain watch this hour (from schedule), for Our Chain box. Empty if no schedule / outside slot range. */
    function getOurChainWatchRosterHtml() {
        const p = chainWatchPayload;
        if (!p || p.exists === false) return '';
        const settings = p.settings || {};
        const start = settings.chainStartUnix != null ? Number(settings.chainStartUnix) : null;
        if (start == null || !Number.isFinite(start)) return '';
        const nowSec = Math.floor(Date.now() / 1000);
        const maxSlots = p.maxHourSlots != null ? Number(p.maxHourSlots) : CHAIN_WATCH_MAX_HOUR_SLOTS;
        const slotIndex = Math.floor((nowSec - start) / 3600);
        if (slotIndex < 0 || slotIndex >= maxSlots) return '';
        const list = (p.slots && p.slots[String(slotIndex)]) || [];
        if (list.length === 0) {
            return (
                '<div class="war-dashboard-chain-watch-line war-dashboard-chain-watch-line--empty" title="Chain watch roster for this hour (schedule)">Watch: <span class="war-dashboard-chain-watch-empty">—</span></div>'
            );
        }
        const sorted = list.slice().sort(function (a, b) {
            return Number(a.col) - Number(b.col);
        });
        const slotStartSec = start + slotIndex * 3600;
        const slotEndSec = slotStartSec + 3600;
        const parts = sorted.map(function (w) {
            const att =
                lastOurFactionId ? chainWatchAttendanceInlineHtml(lastOurFactionId, w, slotStartSec, slotEndSec) : '';
            return (
                '<strong class="war-dashboard-chain-watch-name">' +
                escapeHtml(w.name || String(w.playerId)) +
                '</strong>' +
                att
            );
        });
        return (
            '<div class="war-dashboard-chain-watch-line" title="Who is on chain watch this hour (from your faction schedule)">Watch: ' +
            parts.join(', ') +
            '</div>'
        );
    }

    /** Render one chain box (Our or Enemy). chain = API data, display = { timeout, cooldown } for tick-down. chainKey = 'our' | 'enemy' for the track toggle. */
    function renderChainBox(boxEl, title, chain, display, chainKey) {
        if (!boxEl) return;
        if (!chain) {
            boxEl.style.display = 'none';
            boxEl.setAttribute('aria-hidden', 'true');
            boxEl.innerHTML = '';
            return;
        }
        const current = chain.current != null ? chain.current : 0;
        const max = chain.max != null ? chain.max : 0;
        const modifier = chain.modifier != null ? chain.modifier : 0;
        const timeout = display && display.timeout != null ? Math.max(0, display.timeout) : 0;
        const cooldown = display && display.cooldown != null ? Math.max(0, display.cooldown) : 0;
        const isActive = timeout > 0;
        const displaySeconds = timeout > 0 ? timeout : cooldown;
        const timerLabel = timeout > 0 ? 'Timeout' : (cooldown > 0 ? 'Cooldown' : null);
        const timerText = timerLabel ? `${timerLabel}: ${formatMinutesSeconds(displaySeconds)}` : '—';
        const isUrgent = (timeout > 0 && timeout < 60) || (timeout === 0 && cooldown > 0 && cooldown < 60);
        const trackOn = chainKey === 'our' ? getTrackOurChain() : getTrackEnemyChain();
        const watchRosterHtml = chainKey === 'our' ? getOurChainWatchRosterHtml() : '';
        const extraEnemyClass = boxEl.classList.contains('war-dashboard-enemy-chain-box-extra') ? ' war-dashboard-enemy-chain-box-extra' : '';
        boxEl.className = 'war-dashboard-chain-box' +
            extraEnemyClass +
            (!trackOn ? ' war-dashboard-chain-box-off' : '') +
            (trackOn && isActive ? ' war-dashboard-chain-box-active' : '') +
            (trackOn && isUrgent ? ' war-dashboard-chain-box-urgent' : '');
        boxEl.setAttribute('aria-hidden', 'false');
        boxEl.style.display = 'flex';
        if (!trackOn) {
            boxEl.innerHTML = `
                <label class="war-dashboard-chain-track-wrap" title="Tracking off (reduces API calls): click to turn on. Refresh interval in Settings (Chain refresh).">
                    <input type="checkbox" class="war-dashboard-chain-track-input" data-chain-key="${escapeHtml(chainKey)}" aria-label="Track this chain" />
                    <span class="war-dashboard-chain-track-slider"></span>
                </label>
                <div class="war-dashboard-chain-title">${escapeHtml(title)}</div>
                ${watchRosterHtml}
                <div class="war-dashboard-chain-off-message">Tracking off</div>
            `;
        } else {
            boxEl.innerHTML = `
                <label class="war-dashboard-chain-track-wrap" title="Tracking on (increases API calls): click to turn off. Refresh interval in Settings (Chain refresh).">
                    <input type="checkbox" class="war-dashboard-chain-track-input" data-chain-key="${escapeHtml(chainKey)}" checked aria-label="Track this chain" />
                    <span class="war-dashboard-chain-track-slider"></span>
                </label>
                <div class="war-dashboard-chain-title">${escapeHtml(title)}</div>
                <div class="war-dashboard-chain-current">${escapeHtml(String(current))}</div>
                <div class="war-dashboard-chain-timer">${escapeHtml(timerText)}</div>
                <div class="war-dashboard-chain-meta">
                    <span class="war-dashboard-chain-modifier">Modifier: ${escapeHtml(String(modifier))}</span>
                    <span class="war-dashboard-chain-max">Next: ${escapeHtml(String(max))}</span>
                </div>
                ${watchRosterHtml}
            `;
        }
        const input = boxEl.querySelector('.war-dashboard-chain-track-input');
        if (input) {
            input.addEventListener('change', function () {
                const on = this.checked;
                if (chainKey === 'our') setTrackOurChain(on); else setTrackEnemyChain(on);
                renderChainBoxes();
                if (on) {
                    refreshChainWhenTurningOn(chainKey);
                    startChainRefreshTimer();
                }
            });
        }
    }

    /** Inline display must be grid/flex — setting display:block overrides CSS and stacked the chains. */
    function applyChainsRowVisibleLayout(row) {
        if (!row) return;
        if (enemyFactionStates.length) {
            row.style.display = 'grid';
            row.style.gridTemplateColumns = (typeof window !== 'undefined' && window.innerWidth <= 700)
                ? '1fr'
                : 'repeat(' + Math.min(4, enemyFactionStates.length + 1) + ', minmax(0, 1fr))';
            row.style.gap = '16px';
            row.style.alignItems = 'stretch';
            row.style.justifyContent = '';
        } else {
            row.style.display = 'flex';
            row.style.justifyContent = 'center';
            row.style.flexWrap = 'wrap';
            row.style.gap = '16px';
            row.style.gridTemplateColumns = '';
            row.style.alignItems = 'stretch';
        }
    }

    function updateChainsRowLayout() {
        const row = document.getElementById('war-dashboard-chains-row');
        if (!row) return;
        if (enemyFactionStates.length) {
            row.classList.add('war-dashboard-chains-row--dual');
            row.classList.remove('war-dashboard-chains-row--solo');
        } else {
            row.classList.add('war-dashboard-chains-row--solo');
            row.classList.remove('war-dashboard-chains-row--dual');
        }
        // Always apply layout when we have a faction — do not gate on row.style.display (startChainTick can run before runDashboard finishes).
        if (lastOurFactionId) {
            applyChainsRowVisibleLayout(row);
        }
    }

    function showWarDashboardChainsRow() {
        const row = document.getElementById('war-dashboard-chains-row');
        if (!row) return;
        if (enemyFactionStates.length) {
            row.classList.add('war-dashboard-chains-row--dual');
            row.classList.remove('war-dashboard-chains-row--solo');
        } else {
            row.classList.add('war-dashboard-chains-row--solo');
            row.classList.remove('war-dashboard-chains-row--dual');
        }
        applyChainsRowVisibleLayout(row);
    }

    /** Placeholder so Our Chain shows at 0 / tracking off when API failed or not loaded. */
    const OUR_CHAIN_PLACEHOLDER = { current: 0, max: 0, timeout: 0, cooldown: 0, modifier: 0 };
    /** Placeholder so enemy column shows side-by-side before chain API returns. */
    const ENEMY_CHAIN_PLACEHOLDER = { current: 0, max: 0, timeout: 0, cooldown: 0, modifier: 0 };

    function renderChainBoxes() {
        const ourChainForUi = lastOurChain || (lastOurFactionId ? OUR_CHAIN_PLACEHOLDER : null);
        const ourDisplayForUi = lastOurChain ? ourChainDisplay : { timeout: 0, cooldown: 0 };
        renderChainBox(
            document.getElementById('war-dashboard-our-chain-box'),
            'Our Chain',
            ourChainForUi,
            ourDisplayForUi,
            'our'
        );
        const row = document.getElementById('war-dashboard-chains-row');
        const firstEnemyBox = document.getElementById('war-dashboard-enemy-chain-box');
        if (row) {
            row.querySelectorAll('.war-dashboard-enemy-chain-box-extra').forEach(el => el.remove());
        }
        enemyFactionStates.forEach(function (enemy, index) {
            let box = index === 0 ? firstEnemyBox : null;
            if (!box && row) {
                box = document.createElement('div');
                box.className = 'war-dashboard-chain-box war-dashboard-enemy-chain-box-extra';
                box.id = 'war-dashboard-enemy-chain-box-' + enemy.id;
                row.appendChild(box);
            }
            const enemyChainForUi = enemy.chain || ENEMY_CHAIN_PLACEHOLDER;
            const enemyDisplayForUi = enemy.chain ? enemy.chainDisplay : { timeout: 0, cooldown: 0 };
            renderChainBox(
                box,
                (enemy.name || 'Faction ' + enemy.id) + ' Chain',
                enemyChainForUi,
                enemyDisplayForUi,
                'enemy'
            );
        });
        if (firstEnemyBox && !enemyFactionStates.length) {
            renderChainBox(firstEnemyBox, 'Enemy Chain', null, { timeout: 0, cooldown: 0 }, 'enemy');
        }
        updateChainsRowLayout();
        updateChainWatchBarVisibility();
    }

    function getWarDashboardFunctions() {
        try {
            if (typeof firebase !== 'undefined' && firebase.functions) return firebase.functions();
        } catch (e) { /* ignore */ }
        return null;
    }

    function readChainWatchSessionCache(factionId) {
        try {
            const raw = sessionStorage.getItem(CHAIN_WATCH_CACHE_PREFIX + String(factionId));
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (!o || !o.t || !o.data) return null;
            return o;
        } catch (e) { return null; }
    }

    function writeChainWatchSessionCache(factionId, data) {
        try {
            sessionStorage.setItem(CHAIN_WATCH_CACHE_PREFIX + String(factionId), JSON.stringify({ t: Date.now(), data: data }));
        } catch (e) { /* ignore */ }
    }

    /**
     * Ensures Chain Watch actions exist inside the Chain Watch command modal.
     */
    function ensureChainWatchBarMounted() {
        const modalBody = document.querySelector('#war-dashboard-chain-watch-command-modal .war-dashboard-command-modal-body');

        let bar = document.getElementById('war-dashboard-chain-watch-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'war-dashboard-chain-watch-bar';
            bar.className = 'war-dashboard-chain-watch-bar war-dashboard-chain-watch-command-actions';
            bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;';
            if (modalBody) {
                modalBody.appendChild(bar);
            }
        } else if (modalBody && bar.parentNode !== modalBody) {
            modalBody.appendChild(bar);
        }
        if (!document.getElementById('war-dashboard-chain-watch-new')) {
            const hint = document.getElementById('war-dashboard-chain-watch-hint');
            const hintHtml = hint
                ? hint.outerHTML
                : '<span id="war-dashboard-chain-watch-hint" class="war-dashboard-chain-watch-hint war-dashboard-command-summary" style="color:#888;font-size:12px;"></span>';
            bar.innerHTML =
                '<button type="button" id="war-dashboard-chain-watch-new" class="btn">Add new chain watch</button>' +
                '<button type="button" id="war-dashboard-chain-watch-open" class="btn">Open chain watch</button>' +
                hintHtml;
        }
        wireChainWatchBarButtons();
    }

    function wireChainWatchBarButtons() {
        const newBtn = document.getElementById('war-dashboard-chain-watch-new');
        const openBtn = document.getElementById('war-dashboard-chain-watch-open');
        if (newBtn && !newBtn.dataset.cwBarWired) {
            newBtn.dataset.cwBarWired = '1';
            newBtn.addEventListener('click', function (e) {
                e.preventDefault();
                void handleChainWatchNewClick();
            });
        }
        if (openBtn && !openBtn.dataset.cwBarWired) {
            openBtn.dataset.cwBarWired = '1';
            openBtn.addEventListener('click', function (e) {
                e.preventDefault();
                closeWarDashboardChainWatchCommandModal();
                navigateToChainWatchPage();
            });
        }
    }

    function chainWatchActiveLabel(p) {
        const n = p && p.settings && p.settings.chainName != null ? String(p.settings.chainName).trim() : '';
        return n ? '"' + n + '"' : 'A chain watch';
    }

    async function handleChainWatchNewClick() {
        if (!lastOurFactionId) {
            alert('Load your faction first from the War Dashboard.');
            return;
        }
        if (!getApiKey()) {
            alert('Set your Torn API key in the sidebar first.');
            return;
        }
        const fn = getWarDashboardFunctions();
        if (!fn) {
            alert('Firebase did not load (Functions). Refresh the page or check that scripts are not blocked.');
            return;
        }
        let p = chainWatchPayload;
        if (!p) {
            p = await fetchChainWatchData(true);
        }
        if (p && p.exists === true) {
            const label = chainWatchActiveLabel(p);
            const owner =
                p.ownerName ||
                (p.ownerPlayerId != null ? 'player ' + String(p.ownerPlayerId) : 'the chain watch owner');
            const canEdit = p.viewer && p.viewer.canEdit === true;
            if (canEdit) {
                const ok = confirm(
                    label +
                        ' is already live for your faction.\n\nArchive it and start a new chain watch? The current schedule will move to Past chain watches (signups and rewards stay readable).'
                );
                if (!ok) return;
                try {
                    await fn.httpsCallable('chainWatchArchive')({
                        apiKey: getApiKey(),
                        factionId: String(lastOurFactionId),
                    });
                    chainWatchPayload = null;
                    chainWatchLastFetchMs = 0;
                    await fetchChainWatchData(true);
                } catch (e) {
                    alert(chainWatchErrorText(e));
                    return;
                }
            } else {
                alert(
                    label +
                        ' is already live. Ask ' +
                        owner +
                        ' or a chain watch organiser to archive it before starting a new one.'
                );
                return;
            }
        }
        closeWarDashboardChainWatchCommandModal();
        showChainWatchCreateModal();
    }

    function updateChainWatchBarVisibility() {
        ensureChainWatchBarMounted();
        const bar = document.getElementById('war-dashboard-chain-watch-bar');
        const hint = document.getElementById('war-dashboard-chain-watch-hint');
        const summary = document.getElementById('war-dashboard-chain-watch-summary');
        if (!bar) return;
        if (!hasWarDashboardVip2Access()) {
            if (summary) summary.textContent = 'VIP 2 required';
            if (hint) hint.textContent = 'Chain Watch requires VIP 2.';
            bar.style.display = 'flex';
            return;
        }
        // Always show the bar on War Dashboard — visibility does not depend on enemy faction (only our faction is needed for API calls).
        bar.style.display = 'flex';
        let hintText = '';
        let summaryText = 'Schedule tools';
        if (hint) {
            if (!lastOurFactionId) {
                if (!getApiKey()) {
                    hintText = 'Set API key in the sidebar, then load the dashboard.';
                    summaryText = 'Set API key first';
                } else {
                    hintText = 'Waiting for your faction (dashboard loading or not in a faction). No enemy faction required for Chain watch.';
                    summaryText = 'Waiting for faction';
                }
            } else {
                const age = chainWatchLastFetchMs ? Math.max(0, Math.floor((Date.now() - chainWatchLastFetchMs) / 1000)) : null;
                hintText = age != null ? ('Schedule data: refreshed ' + (age < 60 ? age + 's' : Math.floor(age / 60) + 'm') + ' ago') : '';
                summaryText = age != null ? ('Refreshed ' + (age < 60 ? age + 's' : Math.floor(age / 60) + 'm') + ' ago') : 'Add or open schedule';
            }
            hint.textContent = hintText;
        }
        if (summary) summary.textContent = summaryText;
    }

    /** @returns {Promise<object|null>} chainWatchPayload on success, or null (see chainWatchLastError). */
    async function fetchChainWatchData(force) {
        chainWatchLastError = '';
        const fid = lastOurFactionId;
        const apiKey = getApiKey();
        if (!fid) {
            chainWatchLastError = 'No faction loaded yet. Load the War Dashboard, then open Chain Watch again.';
            return null;
        }
        if (!apiKey) {
            chainWatchLastError = 'Set your Torn API key in the sidebar first.';
            return null;
        }
        const fn = getWarDashboardFunctions();
        if (!fn) {
            chainWatchLastError = 'Firebase did not load (Functions). Refresh the page or check that scripts are not blocked.';
            return null;
        }
        const now = Date.now();
        if (!force && chainWatchPayload && (now - chainWatchLastFetchMs) < CHAIN_WATCH_POLL_MS) {
            return chainWatchPayload;
        }
        // Only hydrate from sessionStorage when we have no in-memory payload (cold start).
        // If chainWatchPayload already exists, restoring from cache can overwrite optimistic edits
        // or diverge from chainWatchLastFetchMs (different "age" heuristics), causing signups to flash.
        if (!force && !chainWatchPayload) {
            const cached = readChainWatchSessionCache(fid);
            if (cached && (now - cached.t) < CHAIN_WATCH_POLL_MS) {
                chainWatchPayload = cached.data;
                chainWatchLastFetchMs = cached.t;
                updateChainWatchBarVisibility();
                try {
                    await ensureActivityDataLoaded(fid);
                } catch (e) { /* ignore */ }
                renderChainBoxes();
                return chainWatchPayload;
            }
        }
        const CHAIN_WATCH_FETCH_MS = 45000;
        try {
            const payload = { apiKey: apiKey, factionId: String(fid), includeArchives: false };
            const call = fn.httpsCallable('chainWatchGet')(payload);
            var chainWatchTimeoutId;
            const timeoutPromise = new Promise(function (_, reject) {
                chainWatchTimeoutId = setTimeout(function () {
                    reject(new Error('Request timed out after ' + Math.floor(CHAIN_WATCH_FETCH_MS / 1000) + 's. Check your connection and try again.'));
                }, CHAIN_WATCH_FETCH_MS);
            });
            let res;
            try {
                res = await Promise.race([call, timeoutPromise]);
            } finally {
                if (chainWatchTimeoutId) clearTimeout(chainWatchTimeoutId);
            }
            const data = res && res.data;
            if (data && typeof data === 'object') {
                chainWatchPayload = data;
                chainWatchLastFetchMs = Date.now();
                writeChainWatchSessionCache(fid, data);
                updateChainWatchBarVisibility();
                try {
                    await ensureActivityDataLoaded(fid);
                } catch (e) { /* ignore */ }
                renderChainBoxes();
                return chainWatchPayload;
            }
            console.warn('chainWatchGet: empty or invalid data', res);
            chainWatchLastError = 'Got an empty response from the server (chainWatchGet). Try again or check the browser console.';
            return null;
        } catch (e) {
            console.warn('chainWatchGet', e);
            chainWatchLastError = chainWatchErrorText(e);
            return null;
        }
    }

    function syncChainWatchFromDashboard() {
        const fid = lastOurFactionId;
        const apiKey = getApiKey();
        if (!fid || !apiKey || !lastOurChain) return;
        const fn = getWarDashboardFunctions();
        if (!fn) return;
        fn.httpsCallable('chainWatchSyncChain')({
            apiKey,
            factionId: String(fid),
            current: lastOurChain.current != null ? Number(lastOurChain.current) : 0,
            cooldown: lastOurChain.cooldown != null ? Number(lastOurChain.cooldown) : 0
        }).catch(function () {});
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    const CHAIN_WATCH_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const CHAIN_WATCH_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    function ordinalEnglish(n) {
        const d = n % 10;
        const e = n % 100;
        if (e >= 11 && e <= 13) return n + 'th';
        if (d === 1) return n + 'st';
        if (d === 2) return n + 'nd';
        if (d === 3) return n + 'rd';
        return n + 'th';
    }

    /** e.g. "Friday 5th March" in UTC (TCT). */
    function formatTctDayHeading(unixSec) {
        const d = new Date(unixSec * 1000);
        const name = CHAIN_WATCH_WEEKDAYS[d.getUTCDay()];
        const day = d.getUTCDate();
        const month = CHAIN_WATCH_MONTHS[d.getUTCMonth()];
        return name + ' ' + ordinalEnglish(day) + ' ' + month;
    }

    /** "15:00 – 16:00 TCT" only (no date). */
    function formatTctTimeRangeShort(startSec, endSec) {
        const a = new Date(startSec * 1000);
        const b = new Date(endSec * 1000);
        return pad2(a.getUTCHours()) + ':' + pad2(a.getUTCMinutes()) + ' – ' + pad2(b.getUTCHours()) + ':' + pad2(b.getUTCMinutes()) + ' TCT';
    }

    function utcDayKeyFromUnix(unixSec) {
        const d = new Date(unixSec * 1000);
        return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }

    /** Read-only summary of chain watch settings for all viewers. */
    function chainWatchSettingsSummaryHtml(settings, start) {
        const rt = settings.rewardType === 'xanax' ? 'Xanax' : 'Cash';
        const target = settings.chainTarget != null ? String(settings.chainTarget) : '—';
        const r1 = settings.rewardFirst != null ? String(settings.rewardFirst) : '0';
        const r2 = settings.rewardSubsequent != null ? String(settings.rewardSubsequent) : '0';
        const max24 = settings.maxSignupsPer24h != null ? String(settings.maxSignupsPer24h) : '10';
        let startHtml;
        if (start == null) {
            startHtml = '<span class="war-dashboard-cw-sum-missing">Not set yet</span>';
        } else {
            const d = new Date(start * 1000);
            startHtml = escapeHtml(formatTctDayHeading(start) + ', ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC (TCT)');
        }
        const cn =
            settings.chainName != null && String(settings.chainName).trim()
                ? escapeHtml(String(settings.chainName).trim())
                : '';
        return '<dl class="war-dashboard-cw-summary-dl">' +
            (cn ? '<dt>Name</dt><dd>' + cn + '</dd>' : '') +
            '<dt>Chain start</dt><dd>' + startHtml + '</dd>' +
            '<dt>Target hits</dt><dd>' + escapeHtml(target) + '</dd>' +
            '<dt>Reward type</dt><dd>' + escapeHtml(rt) + '</dd>' +
            '<dt>First signup / each after</dt><dd>' + escapeHtml(r1) + ' / ' + escapeHtml(r2) + '</dd>' +
            '<dt>Max signups per 24h</dt><dd>' + escapeHtml(max24) + '</dd>' +
            '</dl>';
    }

    /** Format unix seconds as UTC (TCT) for display. */
    function formatTctRange(startSec, endSec) {
        const a = new Date(startSec * 1000);
        const b = new Date(endSec * 1000);
        const fmt = function (d) {
            return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
        };
        return fmt(a) + ' – ' + fmt(b) + ' TCT';
    }

    function utcDateHourFromUnix(unix) {
        if (!unix) return { date: '', hour: 12 };
        const d = new Date(unix * 1000);
        return {
            date: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()),
            hour: d.getUTCHours()
        };
    }

    function unixFromUtcDateHour(dateStr, hour) {
        if (!dateStr) return null;
        const p = dateStr.split('-').map(Number);
        if (p.length !== 3 || p.some(function (x) { return !Number.isFinite(x); })) return null;
        const h = Math.max(0, Math.min(23, Math.floor(Number(hour) || 0)));
        return Math.floor(Date.UTC(p[0], p[1] - 1, p[2], h, 0, 0) / 1000);
    }

    /** Next TCT calendar midnight (00:00 UTC) after `startSec`. */
    function chainWatchTctNextMidnightUnix(startSec) {
        if (startSec == null || !Number.isFinite(startSec)) return null;
        const d = new Date(startSec * 1000);
        return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0) / 1000);
    }

    /** Hourly slots from chain start until end of that TCT day. */
    function chainWatchFirstDaySlotCount(startSec) {
        const nextMid = chainWatchTctNextMidnightUnix(startSec);
        if (nextMid == null) return 0;
        const n = Math.max(0, Math.floor((nextMid - startSec) / 3600));
        return n === 0 ? 1 : n;
    }

    function chainWatchMaxSlotIndexWithSignups(slots) {
        let max = -1;
        Object.keys(slots || {}).forEach(function (key) {
            if ((slots[key] || []).length) {
                const si = parseInt(key, 10);
                if (!Number.isNaN(si) && si > max) max = si;
            }
        });
        return max;
    }

    /** Past hours with signups stay visible even when completed rows are collapsed. */
    function chainWatchSelectSlotIndices(startSec, slots, rowCount, nowSec, showCompletedRows) {
        let hasCompletedHours = false;
        let hasHiddenEmptyCompleted = false;
        const slotIndicesToRender = [];
        for (let i = 0; startSec != null && i < rowCount; i++) {
            const slotEndSec = startSec + (i + 1) * 3600;
            const hourCompleted = nowSec >= slotEndSec;
            const hasSignups = ((slots[String(i)] || []).length) > 0;
            if (hourCompleted) hasCompletedHours = true;
            if (!showCompletedRows && hourCompleted && !hasSignups) {
                hasHiddenEmptyCompleted = true;
                continue;
            }
            slotIndicesToRender.push(i);
        }
        return {
            slotIndicesToRender: slotIndicesToRender,
            hasCompletedHours: hasCompletedHours,
            hasHiddenEmptyCompleted: hasHiddenEmptyCompleted,
        };
    }

    function chainWatchMaxVisibleTctDays(startSec) {
        const first = chainWatchFirstDaySlotCount(startSec);
        return 1 + Math.ceil((CHAIN_WATCH_MAX_HOUR_SLOTS - first) / 24);
    }

    /** Slots shown for visibleTctDays: 1 = start→midnight, each +1 adds 24h. */
    function chainWatchSlotsForVisibleDays(startSec, visibleTctDays, maxCap) {
        const cap = Math.min(maxCap || CHAIN_WATCH_MAX_HOUR_SLOTS, CHAIN_WATCH_MAX_HOUR_SLOTS);
        if (startSec == null || !Number.isFinite(startSec)) return 0;
        const first = chainWatchFirstDaySlotCount(startSec);
        const days = Math.max(1, Math.floor(Number(visibleTctDays) || 1));
        return Math.min(cap, first + 24 * (days - 1));
    }

    function chainWatchPickVisibleTctDaysFromForm(s) {
        const el = document.getElementById('war-dashboard-cw-visible-days');
        if (el && el.value !== '' && el.value !== undefined) {
            const n = Math.floor(Number(el.value));
            if (Number.isFinite(n)) return n;
        }
        const fb = s && s.visibleTctDays != null ? Math.floor(Number(s.visibleTctDays)) : 1;
        return Number.isFinite(fb) ? fb : 1;
    }

    function computeRewardsOwed(payload, factionId) {
        const settings = payload.settings || {};
        const slots = payload.slots || {};
        const first = Number(settings.rewardFirst) || 0;
        const sub = Number(settings.rewardSubsequent) || 0;
        const rewardType = settings.rewardType === 'xanax' ? 'xanax' : 'cash';
        const rows = [];
        const all = [];
        const excludedNoShows = [];
        const chainStart = settings.chainStartUnix != null ? Number(settings.chainStartUnix) : null;
        Object.keys(slots).forEach(function (key) {
            const si = parseInt(key, 10);
            (slots[key] || []).forEach(function (w) {
                if (factionId && chainStart != null && Number.isFinite(chainStart)) {
                    const slotStart = chainStart + si * 3600;
                    const slotEnd = slotStart + 3600;
                    const ev = evaluateWatcherSlotAttendance(factionId, w.playerId, slotStart, slotEnd);
                    if (ev.phase === 'past' && ev.verdict === 'fail') {
                        excludedNoShows.push({
                            playerId: String(w.playerId),
                            name: w.name || ('Player ' + w.playerId),
                            slotIndex: si,
                            slotLabel: formatTctTimeRangeShort(slotStart, slotEnd)
                        });
                        return;
                    }
                }
                all.push({
                    playerId: String(w.playerId),
                    name: w.name || ('Player ' + w.playerId),
                    at: w.at || 0,
                    slotIndex: si
                });
            });
        });
        all.sort(function (a, b) { return a.at - b.at; });
        const firstSeen = {};
        const byPlayer = {};
        all.forEach(function (entry) {
            const pid = entry.playerId;
            const isFirst = !firstSeen[pid];
            firstSeen[pid] = true;
            const amt = isFirst ? first : sub;
            if (!byPlayer[pid]) {
                byPlayer[pid] = { name: entry.name, total: 0, breakdown: [] };
            }
            byPlayer[pid].total += amt;
            byPlayer[pid].breakdown.push({ slotIndex: entry.slotIndex, amount: amt, isFirst: isFirst });
        });
        Object.keys(byPlayer).forEach(function (pid) {
            rows.push({ playerId: pid, name: byPlayer[pid].name, total: byPlayer[pid].total, breakdown: byPlayer[pid].breakdown });
        });
        rows.sort(function (a, b) { return b.total - a.total; });
        return { rows: rows, rewardType: rewardType, excludedNoShows: excludedNoShows };
    }

    async function renderChainWatchRewardsModal() {
        const body = document.getElementById('war-dashboard-chain-watch-rewards-body');
        if (!body || !chainWatchPayload) return;
        if (lastOurFactionId) {
            // Do not block modal paint on activity fetch; refresh will merge in background.
            ensureActivityDataLoaded(lastOurFactionId).catch(function () {});
        }
        const p = chainWatchPayload;
        const comp = computeRewardsOwed(chainWatchPayload, lastOurFactionId);
        const unit = comp.rewardType === 'xanax' ? ' Xanax' : ' (cash units)';
        let html = '';
        if (p.exists !== true) {
            html += '<p style="color:#e0c080;font-size:13px;margin:0 0 12px 0;line-height:1.5;">No chain watch schedule has been saved for your faction yet, so there are no rewards to tally. Any faction member can set one up from <strong>War Dashboard → Chain watch</strong>.</p>';
        }
        html +=
            '<p style="color:#b0b0b0;font-size:13px;margin:0 0 10px 0;line-height:1.45;">Totals use first vs subsequent rewards from settings. Order follows signup time. ' +
            '<strong>Attendance:</strong> past watches with activity data but <strong>no</strong> online sample for that player in the hour are <strong>excluded</strong> (same rule as below). Hours with no samples at all are not excluded.</p>';
        html += '<div class="table-scroll-wrapper" style="max-height:50vh;"><table class="war-dashboard-table war-dashboard-chain-watch-table"><thead><tr><th>Player</th><th>Owed</th></tr></thead><tbody>';
        comp.rows.forEach(function (r) {
            html += '<tr><td>' + escapeHtml(r.name) + '</td><td>' + escapeHtml(String(r.total)) + unit + '</td></tr>';
        });
        if (!comp.rows.length) {
            html += '<tr><td colspan="2" style="color:#888;">No signups yet.</td></tr>';
        }
        html += '</tbody></table></div>';
        const ex = comp.excludedNoShows || [];
        if (ex.length) {
            html += '<p style="color:#ffcdd2;font-size:13px;margin:12px 0 6px 0;font-weight:bold;">Excluded from totals (verified no-show — had samples that hour but player never online)</p>';
            html += '<ul style="margin:0 0 12px 1.2em;color:#e0e0e0;font-size:13px;line-height:1.5;">';
            ex.forEach(function (row) {
                html +=
                    '<li>' +
                    escapeHtml(row.name) +
                    ' — ' +
                    escapeHtml(row.slotLabel) +
                    ' (slot #' +
                    escapeHtml(String(row.slotIndex)) +
                    ')</li>';
            });
            html += '</ul>';
        }
        body.innerHTML = html;
    }

    async function renderChainWatchScheduleModal() {
        const body = document.getElementById('war-dashboard-chain-watch-modal-body');
        if (!body || !chainWatchPayload) return;
        if (lastOurFactionId) {
            // Keep interactions snappy; hydrate attendance data in background.
            ensureActivityDataLoaded(lastOurFactionId).catch(function () {});
        }
        const p = chainWatchPayload;
        const settings = p.settings || {};
        const slots = p.slots || {};
        const viewer = p.viewer || {};
        const canEdit = viewer.canEdit === true;
        const isOwner = viewer.isOwner === true;
        const canManageOrganizers = viewer.canManageOrganizers === true;
        const docExists = p.exists === true;
        const organizerIds = Array.isArray(p.organizerPlayerIds) ? p.organizerPlayerIds.map(String) : [];
        const ownerLabel = chainWatchOwnerLabel(p);
        const chainState = p.chainState || {};
        const start = settings.chainStartUnix != null ? Number(settings.chainStartUnix) : null;
        const maxSlots = p.maxHourSlots != null ? Number(p.maxHourSlots) : CHAIN_WATCH_MAX_HOUR_SLOTS;
        const targets = Array.isArray(p.chainTargets) ? p.chainTargets : [];
        const brokeAtUnix = chainState.brokeAtUnix != null ? Number(chainState.brokeAtUnix) : null;
        const brokeAtHit = chainState.brokeAtHit != null ? Number(chainState.brokeAtHit) : null;
        let brokeSlotIndex = null;
        if (start != null && brokeAtUnix) {
            brokeSlotIndex = Math.floor((brokeAtUnix - start) / 3600);
        }

        const nowSec = Math.floor(Date.now() / 1000);

        let html = '';
        if (brokeAtHit != null && brokeAtHit > 0) {
            html += '<p class="war-dashboard-chain-watch-break-banner" style="margin:0 0 12px 0;padding:8px 10px;border-radius:6px;background:rgba(244,67,54,0.2);color:#ffcdd2;font-size:13px;">Chain broke at hit <strong>' + escapeHtml(String(brokeAtHit)) + '</strong>' +
                (brokeAtUnix ? ' (around ' + escapeHtml(formatTctRange(brokeAtUnix, brokeAtUnix + 60)) + ')' : '') + '</p>';
        }

        if (!docExists) {
            html += '<div style="margin:0 0 14px 0;padding:12px 14px;border-radius:8px;border:1px solid var(--border-color,#444);background:rgba(255,215,0,0.06);font-size:13px;line-height:1.5;color:#e0e0e0;">';
            html += '<p style="margin:0;"><strong>No chain watch schedule saved yet</strong> for your faction. Any member can set <strong>Chain start</strong>, target, and rewards below, then <strong>Save schedule</strong> — you become the <strong>owner</strong> and can add organisers who may edit settings.</p>';
            html += '</div>';
        } else if (!canEdit) {
            html += '<p style="color:#b0b0b0;font-size:12px;margin:0 0 12px 0;line-height:1.45;">You can sign up for watch slots below. Only the owner' +
                (ownerLabel ? ' (<strong>' + ownerLabel + '</strong>)' : '') +
                (organizerIds.length ? ' and designated organisers' : '') +
                ' can change the schedule.</p>';
        } else if (docExists && canEdit && !p.ownerPlayerId) {
            html += '<p style="color:#e0c080;font-size:12px;margin:0 0 12px 0;line-height:1.45;">This schedule has no owner yet. <strong>Save schedule</strong> below to claim ownership.</p>';
        } else if (canEdit && !isOwner && organizerIds.indexOf(String(viewer.playerId || '')) >= 0) {
            html += '<p style="color:#b0b0b0;font-size:12px;margin:0 0 12px 0;line-height:1.45;">You are a <strong>chain organiser</strong> and can edit settings. Owner: <strong>' + (ownerLabel || '—') + '</strong>.</p>';
        }

        if (canEdit) {
            const dh = utcDateHourFromUnix(start);
            const bc = Math.min(3, Math.max(1, Number(settings.backupColumns) || 1));
            html += '<div class="war-dashboard-cw-vip-wrap">';
            html += '<button type="button" class="war-dashboard-cw-vip-toggle" id="war-dashboard-cw-vip-toggle" aria-expanded="true" aria-controls="war-dashboard-cw-vip-body">';
            html += '<span class="war-dashboard-cw-vip-toggle-text">Edit schedule</span>';
            html += '<span class="war-dashboard-cw-vip-chevron" aria-hidden="true">▼</span>';
            html += '</button>';
            html += '<div class="war-dashboard-cw-vip-body" id="war-dashboard-cw-vip-body">';
            html +=
                '<div class="war-dashboard-cw-vip-rewards-row"><button type="button" class="btn war-dashboard-chain-watch-rewards-trigger" id="war-dashboard-chain-watch-rewards">Rewards owed</button></div>';
            html += '<div class="war-dashboard-cw-setup">';
            html += '<div class="war-dashboard-cw-setup-grid">';
            html += '<div class="war-dashboard-cw-field"><label for="war-dashboard-cw-start-date">Chain start (UTC / TCT)</label>';
            html += '<input type="date" id="war-dashboard-cw-start-date" value="' + escapeHtml(dh.date) + '"></div>';
            html += '<div class="war-dashboard-cw-field"><label for="war-dashboard-cw-start-hour">Hour (UTC)</label>';
            html += '<input type="number" id="war-dashboard-cw-start-hour" min="0" max="23" value="' + dh.hour + '"></div>';
            html += '<div class="war-dashboard-cw-field"><label for="war-dashboard-cw-target">Target hits</label><select id="war-dashboard-cw-target">';
            targets.forEach(function (t) {
                html += '<option value="' + t + '"' + (Number(settings.chainTarget) === t ? ' selected' : '') + '>' + escapeHtml(String(t)) + '</option>';
            });
            html += '</select></div>';
            html += '<div class="war-dashboard-cw-field"><label for="war-dashboard-cw-reward-type">Reward</label><select id="war-dashboard-cw-reward-type">';
            html += '<option value="cash"' + (settings.rewardType !== 'xanax' ? ' selected' : '') + '>Cash</option>';
            html += '<option value="xanax"' + (settings.rewardType === 'xanax' ? ' selected' : '') + '>Xanax</option>';
            html += '</select></div>';
            html += '<div class="war-dashboard-cw-field"><label for="war-dashboard-cw-r1">First signup</label>';
            html += '<input type="number" id="war-dashboard-cw-r1" min="0" step="1" value="' + escapeHtml(String(settings.rewardFirst != null ? settings.rewardFirst : 0)) + '"></div>';
            html += '<div class="war-dashboard-cw-field"><label for="war-dashboard-cw-r2">Each after</label>';
            html += '<input type="number" id="war-dashboard-cw-r2" min="0" step="1" value="' + escapeHtml(String(settings.rewardSubsequent != null ? settings.rewardSubsequent : 0)) + '"></div>';
            html += '<div class="war-dashboard-cw-field"><label for="war-dashboard-cw-max24">Max signups / 24h</label>';
            html += '<input type="number" id="war-dashboard-cw-max24" min="1" max="999" value="' + escapeHtml(String(settings.maxSignupsPer24h != null ? settings.maxSignupsPer24h : 10)) + '"></div>';
            html += '</div>';
            html += '<input type="hidden" id="war-dashboard-cw-backup" value="' + bc + '">';
            html +=
                '<input type="hidden" id="war-dashboard-cw-visible-days" value="' +
                Math.max(1, Math.floor(Number(settings.visibleTctDays) || 1)) +
                '">';
            html += '<p class="war-dashboard-cw-backup-hint" style="margin:0 0 12px 0;">Use <strong>+</strong> above the schedule table to add backup watcher columns (max 3). Use <strong>−</strong> on <strong>Backup 1</strong> or <strong>Backup 2</strong> headers to remove a column. The schedule lists from chain start until <strong>midnight TCT</strong> first; use <strong>Add next day</strong> below the table for more.</p>';
            html += '<div class="war-dashboard-cw-save-row">';
            html += '<label class="war-dashboard-cw-clear-label" style="display:flex;align-items:flex-start;gap:8px;margin:0;color:#b0b0b0;font-size:12px;line-height:1.4;width:100%;"><input type="checkbox" id="war-dashboard-cw-clear" style="margin-top:2px;flex-shrink:0;"><span>Clear all signups when saving (only if this box is checked)</span></label>';
            html += '<button type="button" class="btn" id="war-dashboard-cw-save">Save schedule</button>';
            html += '<p id="war-dashboard-cw-save-msg" style="font-size:12px;color:#888;margin:0;width:100%;"></p>';
            if (canManageOrganizers) {
                html +=
                    '<div class="war-dashboard-cw-organizers" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-color,#444);width:100%;">';
                html += '<div style="font-weight:bold;font-size:13px;margin-bottom:8px;color:var(--accent-color,#ffd700);">Chain organisers</div>';
                html +=
                    '<p style="margin:0 0 10px 0;color:#b0b0b0;font-size:12px;line-height:1.45;">Organisers can edit schedule settings (goal, days, rewards, columns). Only you (owner) can change this list. Leave empty if only you should edit.</p>';
                html += '<input type="hidden" id="war-dashboard-cw-organizer-ids" value="' + escapeHtml(organizerIds.join(',')) + '">';
                html += '<ul id="war-dashboard-cw-organizer-ul" style="margin:0 0 10px 0;padding:0;list-style:none;">';
                if (organizerIds.length) {
                    organizerIds.forEach(function (oid) {
                        html +=
                            '<li style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span>' +
                            escapeHtml(oid) +
                            '</span><button type="button" class="btn war-dashboard-cw-organizer-remove" data-id="' +
                            escapeHtml(oid) +
                            '" style="padding:2px 8px;font-size:11px;">Remove</button></li>';
                    });
                } else {
                    html += '<li style="color:#9e9e9e;">None yet</li>';
                }
                html += '</ul>';
                html += '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;">';
                html +=
                    '<label for="war-dashboard-cw-organizer-input" style="font-size:12px;color:#b0b0b0;">Torn player ID</label>';
                html += '<input type="text" id="war-dashboard-cw-organizer-input" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 123456" style="width:120px;">';
                html += '<button type="button" class="btn" id="war-dashboard-cw-organizer-add-btn">Add</button>';
                html += '<button type="button" class="btn" id="war-dashboard-cw-organizer-save">Save organisers</button>';
                html += '</div>';
                html += '<p id="war-dashboard-cw-organizer-msg" style="font-size:12px;color:#888;margin:0;"></p>';
                html += '</div>';
            } else if (docExists && ownerLabel) {
                html +=
                    '<p style="margin-top:12px;font-size:12px;color:#9e9e9e;">Owner: <strong>' +
                    ownerLabel +
                    '</strong></p>';
            }
            html += '</div></div></div></div>';
        }

        html += '<div class="war-dashboard-cw-summary">';
        html += '<div class="war-dashboard-cw-summary-title">Current settings</div>';
        html += chainWatchSettingsSummaryHtml(settings, start);
        html += '</div>';

        if (!canEdit) {
            html +=
                '<div class="war-dashboard-cw-viewer-rewards-row"><button type="button" class="btn war-dashboard-chain-watch-rewards-trigger" id="war-dashboard-chain-watch-rewards">Rewards owed</button></div>';
            html += '<p class="war-dashboard-cw-viewer-hint" style="color:#b0b0b0;font-size:13px;margin:0 0 12px 0;line-height:1.45;">Use <strong>Sign up</strong> in an empty watcher cell for that hour, or leave your slot (×) while the hour is still active. Only the owner and designated organisers can change the schedule.</p>';
        }

        const backupCols = Math.min(3, Math.max(1, Number(settings.backupColumns) || 1));
        const showAddCol = canEdit && backupCols < 3;
        const slotTableColCount = 1 + backupCols;

        const visibleTctDays = Math.max(
            1,
            Math.floor(
                settings.visibleTctDays != null && settings.visibleTctDays !== ''
                    ? Number(settings.visibleTctDays)
                    : 1
            ) || 1
        );
        const maxTctDays = start != null ? chainWatchMaxVisibleTctDays(start) : 1;
        const plannedSlots = chainWatchSlotsForVisibleDays(start, visibleTctDays, maxSlots);
        const maxSignupIdx = chainWatchMaxSlotIndexWithSignups(slots);
        const rowCount = start == null ? 0 : Math.min(maxSlots, Math.max(plannedSlots, maxSignupIdx + 1));
        const showAddDay = canEdit && start != null && visibleTctDays < maxTctDays;

        let showCompletedRows = false;
        try {
            showCompletedRows = localStorage.getItem('war_dashboard_cw_show_completed') === '1';
        } catch (e) { /* ignore */ }

        const slotPick = chainWatchSelectSlotIndices(start, slots, rowCount, nowSec, showCompletedRows);
        const slotIndicesToRender = slotPick.slotIndicesToRender;
        const hasCompletedHours = slotPick.hasCompletedHours;
        const hasHiddenEmptyCompleted = slotPick.hasHiddenEmptyCompleted;

        html += '<div class="war-dashboard-cw-table-block">';
        if ((start != null && hasCompletedHours) || showAddCol) {
            html += '<div class="war-dashboard-cw-table-top-bar">';
            if (start != null && hasCompletedHours) {
                html += '<div class="war-dashboard-cw-completed-toolbar">';
                if (!showCompletedRows) {
                    html +=
                        '<button type="button" class="btn" id="war-dashboard-cw-toggle-completed" data-set-completed="1">Show completed rows</button>';
                } else {
                    html +=
                        '<button type="button" class="btn" id="war-dashboard-cw-toggle-completed" data-set-completed="0">Hide completed rows</button>';
                }
                html += '</div>';
            }
            if (showAddCol) {
                html += '<div class="war-dashboard-cw-add-col-toolbar">';
                html +=
                    '<button type="button" class="war-dashboard-cw-add-col" id="war-dashboard-cw-header-add-col" aria-label="Add backup watcher column" title="Add another watcher column for the same hour (max 3 total).">+</button>';
                html += '</div>';
            }
            html += '</div>';
        }
        html += '<div class="table-scroll-wrapper">';
        html += '<table class="war-dashboard-chain-watch-table war-dashboard-chain-watch-table--cols"><thead><tr>';
        html += '<th class="war-dashboard-cw-th-time">Time (TCT)</th>';
        for (let c = 0; c < backupCols; c++) {
            html += '<th class="war-dashboard-cw-th-slot" scope="col"><div class="war-dashboard-cw-th-slot-inner">';
            html += '<span class="war-dashboard-cw-th-slot-label">' + escapeHtml(chainWatchColumnLabel(c)) + '</span>';
            if (canEdit && c >= 1) {
                const rmLabel = chainWatchColumnLabel(c);
                html +=
                    '<button type="button" class="war-dashboard-cw-remove-col" data-remove-col="' +
                    c +
                    '" title="Remove ' +
                    escapeHtml(rmLabel) +
                    ' column" aria-label="Remove ' +
                    escapeHtml(rmLabel) +
                    ' column">\u2212</button>';
            }
            html += '</div></th>';
        }
        html += '</tr></thead><tbody>';

        const myId = viewer.playerId != null ? String(viewer.playerId) : '';
        let prevUtcDayKey = null;
        for (let k = 0; k < slotIndicesToRender.length; k++) {
            const i = slotIndicesToRender[k];
            const slotStart = start + i * 3600;
            const slotEnd = slotStart + 3600;
            const hourStarted = nowSec >= slotStart;
            const hourCompleted = nowSec >= slotEnd;
            const dayKey = utcDayKeyFromUnix(slotStart);
            const isNewCalendarDay = prevUtcDayKey === null || dayKey !== prevUtcDayKey;
            prevUtcDayKey = dayKey;
            const rowClass = (brokeSlotIndex === i ? ' war-dashboard-chain-watch-slot--broke' : '') +
                (hourStarted ? ' war-dashboard-chain-watch-slot--started' : '');
            const list = slots[String(i)] || [];
            const mine = list.find(function (w) { return String(w.playerId) === myId; });
            const hasFreeWatcherSlot = list.length < backupCols;
            let firstFreeCol = -1;
            for (let fc = 0; fc < backupCols; fc++) {
                if (!list.some(function (x) { return Number(x.col) === fc; })) {
                    firstFreeCol = fc;
                    break;
                }
            }

            if (isNewCalendarDay) {
                html +=
                    '<tr class="war-dashboard-cw-day-row"><td class="war-dashboard-cw-day-cell" colspan="' +
                    slotTableColCount +
                    '"><div class="war-dashboard-cw-day-heading">' +
                    escapeHtml(formatTctDayHeading(slotStart)) +
                    '</div></td></tr>';
            }
            const hourCellHtml =
                '<div class="war-dashboard-cw-day-time">' + escapeHtml(formatTctTimeRangeShort(slotStart, slotEnd)) + '</div>';
            const trClass = rowClass.trim();
            html += '<tr' + (trClass ? ' class="' + trClass + '"' : '') + '><td class="war-dashboard-cw-hour-cell">' + hourCellHtml + '</td>';

            for (let c = 0; c < backupCols; c++) {
                const w = list.find(function (x) { return Number(x.col) === c; });
                if (w) {
                    const isMe = myId && String(w.playerId) === myId;
                    html += '<td class="war-dashboard-cw-slot-cell war-dashboard-cw-slot-cell--filled">';
                    html += '<div class="war-dashboard-cw-watcher-line">';
                    html += '<span class="war-dashboard-cw-watcher-name">' + escapeHtml(w.name || w.playerId) + '</span>';
                    if (isMe && !hourCompleted) {
                        html +=
                            '<button type="button" class="war-dashboard-cw-leave war-dashboard-cw-leave-icon" data-slot="' +
                            i +
                            '" title="Leave this slot" aria-label="Leave this slot">×</button>';
                    }
                    html += '</div>';
                    if (lastOurFactionId) {
                        html += chainWatchHtmlWatcherAttendance(lastOurFactionId, w, slotStart, slotEnd);
                    }
                    html += '</td>';
                } else {
                    html += '<td class="war-dashboard-cw-slot-cell war-dashboard-cw-slot-cell--empty">';
                    if (
                        c === firstFreeCol &&
                        start != null &&
                        !mine &&
                        hasFreeWatcherSlot &&
                        !hourStarted
                    ) {
                        html +=
                            '<button type="button" class="btn war-dashboard-cw-join" data-slot="' +
                            i +
                            '">Sign up</button>';
                    }
                    html += '</td>';
                }
            }
            html += '</tr>';
        }
        if (
            start != null &&
            slotIndicesToRender.length === 0 &&
            rowCount > 0 &&
            hasHiddenEmptyCompleted &&
            !showCompletedRows
        ) {
            html +=
                '<tr><td colspan="' +
                slotTableColCount +
                '" style="color:#888;">Past hours with no signups are hidden. Use <strong>Show completed rows</strong> above to see them, or check upcoming hours below.</td></tr>';
        }
        if (start != null && showAddDay) {
            html += '<tr class="war-dashboard-cw-add-day-row">';
            html += '<td colspan="' + slotTableColCount + '">';
            html +=
                '<button type="button" class="btn war-dashboard-cw-add-day" id="war-dashboard-cw-add-day">Add next day</button>';
            html +=
                '<span class="war-dashboard-cw-add-day-hint"> Unlocks the next 24 hours of hourly slots (after the first period from chain start until midnight TCT).</span>';
            html += '</td></tr>';
        }
        if (start == null) {
            html += '<tr><td colspan="' + slotTableColCount + '" style="color:#888;">No chain start time yet.' + (canEdit ? ' Set it above, then save.' : ' Ask the chain watch owner or an organiser to set the schedule.') + '</td></tr>';
        }
        html += '</tbody></table></div></div>';

        html +=
            '<p class="war-dashboard-cw-attendance-footnote" style="color:#9e9e9e;font-size:12px;margin:12px 0 0 0;line-height:1.45;">Watch attendance uses <strong>Faction activity tracker</strong> samples (~10 min, online only). Add your faction there for 24/7 history. <strong>Xm</strong> = estimated online minutes in that hour; <strong>✓</strong> seen online at least once; <strong>✗</strong> samples ran but player was not online; <strong>?</strong> no samples that hour; <strong>…</strong> hour still in progress.</p>';

        if (canEdit && lastOurFactionId) {
            const issues = collectChainWatchAttendanceIssues(lastOurFactionId, p);
            if (issues.noShows.length || issues.unverified.length) {
                html +=
                    '<div class="war-dashboard-cw-vip-issues" style="margin-top:14px;padding:12px 14px;border-radius:8px;border:1px solid rgba(255,183,77,0.4);background:rgba(0,0,0,0.25);">';
                html += '<div style="color:#ffb74d;font-weight:bold;font-size:13px;margin-bottom:8px;">Watch attendance review</div>';
                if (issues.noShows.length) {
                    html +=
                        '<p style="color:#ffcdd2;font-size:12px;margin:0 0 6px 0;">No online presence during scheduled hour (rewards excluded for these):</p>';
                    html += '<ul style="margin:0 0 10px 1.2em;color:#e8e8e8;font-size:12px;line-height:1.5;">';
                    issues.noShows.forEach(function (row) {
                        html +=
                            '<li>' +
                            escapeHtml(row.name) +
                            ' — ' +
                            escapeHtml(row.slotLabel) +
                            ' (slot #' +
                            escapeHtml(String(row.slotIndex)) +
                            ')</li>';
                    });
                    html += '</ul>';
                }
                if (issues.unverified.length) {
                    html +=
                        '<p style="color:#b0bec5;font-size:12px;margin:0 0 6px 0;">No activity samples in hour — add faction to Activity tracker to verify (rewards are not auto-excluded):</p>';
                    html += '<ul style="margin:0 0 0 1.2em;color:#b0bec5;font-size:12px;line-height:1.5;">';
                    issues.unverified.forEach(function (row) {
                        html += '<li>' + escapeHtml(row.name) + ' — ' + escapeHtml(row.slotLabel) + '</li>';
                    });
                    html += '</ul>';
                }
                html += '</div>';
            }
        }

        body.innerHTML = html;

        const toggleCompletedBtn = document.getElementById('war-dashboard-cw-toggle-completed');
        if (toggleCompletedBtn) {
            toggleCompletedBtn.addEventListener('click', function () {
                try {
                    localStorage.setItem(
                        'war_dashboard_cw_show_completed',
                        toggleCompletedBtn.getAttribute('data-set-completed') === '1' ? '1' : '0'
                    );
                } catch (e) { /* ignore */ }
                void renderChainWatchScheduleModal().catch(function (err) {
                    console.error('renderChainWatchScheduleModal', err);
                });
            });
        }

        if (canEdit) {
            wireChainWatchAddColumnButton();
            wireChainWatchRemoveColumnButtons();
            wireChainWatchAddDayButton();
            wireChainWatchVipCollapse(docExists);
            if (canManageOrganizers) wireChainWatchOrganizers();
        }

        const saveBtn = document.getElementById('war-dashboard-cw-save');
        if (saveBtn && canEdit) {
            saveBtn.addEventListener('click', async function () {
                const msg = document.getElementById('war-dashboard-cw-save-msg');
                const apiKey = getApiKey();
                const fn = getWarDashboardFunctions();
                if (!apiKey || !fn || !lastOurFactionId) return;
                const dateEl = document.getElementById('war-dashboard-cw-start-date');
                const hourEl = document.getElementById('war-dashboard-cw-start-hour');
                let unix = unixFromUtcDateHour(dateEl && dateEl.value, hourEl && hourEl.value);
                const curSettings = chainWatchPayload && chainWatchPayload.settings;
                if (unix == null && curSettings && curSettings.chainStartUnix != null) {
                    unix = Number(curSettings.chainStartUnix);
                }
                const payload = {
                    apiKey: apiKey,
                    factionId: String(lastOurFactionId),
                    settings: {
                        chainStartUnix: unix,
                        chainTarget: Number(document.getElementById('war-dashboard-cw-target').value),
                        backupColumns: Number(document.getElementById('war-dashboard-cw-backup').value),
                        rewardType: document.getElementById('war-dashboard-cw-reward-type').value,
                        rewardFirst: Number(document.getElementById('war-dashboard-cw-r1').value),
                        rewardSubsequent: Number(document.getElementById('war-dashboard-cw-r2').value),
                        maxSignupsPer24h: Number(document.getElementById('war-dashboard-cw-max24').value),
                        clearAllSignups: document.getElementById('war-dashboard-cw-clear').checked === true,
                        visibleTctDays: chainWatchPickVisibleTctDaysFromForm(chainWatchPayload && chainWatchPayload.settings)
                    }
                };
                saveBtn.disabled = true;
                if (msg) msg.textContent = 'Saving…';
                try {
                    await fn.httpsCallable('chainWatchSaveConfig')(payload);
                    await fetchChainWatchData(true);
                    await renderChainWatchScheduleModal();
                    if (msg) msg.textContent = 'Saved.';
                } catch (e) {
                    if (msg) msg.textContent = (e && e.message) ? String(e.message) : 'Save failed';
                } finally {
                    saveBtn.disabled = false;
                }
            });
        }

        body.querySelectorAll('.war-dashboard-cw-join').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                const si = parseInt(btn.getAttribute('data-slot'), 10);
                const apiKey = getApiKey();
                const fn = getWarDashboardFunctions();
                if (!apiKey || !fn || !lastOurFactionId || !chainWatchPayload) return;
                btn.disabled = true;
                const key = String(si);
                const p = chainWatchPayload;
                const s = p.settings || {};
                const backupCols = Math.min(3, Math.max(1, Number(s.backupColumns) || 1));
                const before = Array.isArray(p.slots && p.slots[key]) ? p.slots[key].slice() : [];
                try {
                    // Optimistic UI: place viewer in first free column immediately.
                    const list = before.slice();
                    const myId = p.viewer && p.viewer.playerId != null ? String(p.viewer.playerId) : '';
                    const alreadyIn = myId && list.some(function (w) { return String(w.playerId) === myId; });
                    if (!alreadyIn) {
                        let freeCol = -1;
                        for (let c = 0; c < backupCols; c++) {
                            if (!list.some(function (w) { return Number(w.col) === c; })) {
                                freeCol = c;
                                break;
                            }
                        }
                        if (freeCol >= 0) {
                            list.push({
                                playerId: myId || 'me',
                                name: (p.viewer && p.viewer.name) || 'You',
                                col: freeCol,
                                at: Date.now(),
                            });
                            p.slots[key] = list;
                            await renderChainWatchScheduleModal();
                        }
                    }

                    await fn.httpsCallable('chainWatchSignup')({ apiKey: apiKey, factionId: String(lastOurFactionId), slotIndex: si });
                } catch (e) {
                    p.slots[key] = before;
                    await fetchChainWatchData(true).catch(function () {});
                    await renderChainWatchScheduleModal();
                    alert((e && e.message) ? e.message : 'Could not sign up');
                    btn.disabled = false;
                    return;
                }
                try {
                    await fetchChainWatchData(true);
                } catch (e) {
                    console.warn('chainWatchGet after signup', e);
                }
                await renderChainWatchScheduleModal();
                btn.disabled = false;
            });
        });
        body.querySelectorAll('.war-dashboard-cw-leave').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                const si = parseInt(btn.getAttribute('data-slot'), 10);
                const apiKey = getApiKey();
                const fn = getWarDashboardFunctions();
                if (!apiKey || !fn || !lastOurFactionId || !chainWatchPayload) return;
                btn.disabled = true;
                const key = String(si);
                const p = chainWatchPayload;
                const myId = p.viewer && p.viewer.playerId != null ? String(p.viewer.playerId) : '';
                const before = Array.isArray(p.slots && p.slots[key]) ? p.slots[key].slice() : [];
                try {
                    // Optimistic UI: remove self from this hour immediately.
                    if (myId) {
                        p.slots[key] = before.filter(function (w) {
                            return String(w.playerId) !== myId;
                        });
                        await renderChainWatchScheduleModal();
                    }

                    await fn.httpsCallable('chainWatchRemoveSelf')({ apiKey: apiKey, factionId: String(lastOurFactionId), slotIndex: si });
                } catch (e) {
                    p.slots[key] = before;
                    await fetchChainWatchData(true).catch(function () {});
                    await renderChainWatchScheduleModal();
                    alert((e && e.message) ? e.message : 'Could not leave slot');
                    btn.disabled = false;
                    return;
                }
                try {
                    await fetchChainWatchData(true);
                } catch (e) {
                    console.warn('chainWatchGet after leave', e);
                }
                await renderChainWatchScheduleModal();
                btn.disabled = false;
            });
        });
    }

    function chainWatchShareUrl(fid) {
        const base = location.origin + location.pathname;
        return base + '#chain-watch/' + encodeURIComponent(String(fid));
    }

    function navigateToChainWatchPage() {
        const fid = lastOurFactionId;
        if (!fid) {
            alert('Load your faction first from the War Dashboard.');
            return;
        }
        if (!getApiKey()) {
            alert('Set your Torn API key in the sidebar first.');
            return;
        }
        window.location.hash = 'chain-watch/' + String(fid);
    }

    function showChainWatchCreateModal() {
        const overlay = document.getElementById('war-dashboard-chain-watch-create-modal');
        if (!overlay) return;
        const msg = document.getElementById('war-dashboard-cw-create-msg');
        const linkWrap = document.getElementById('war-dashboard-cw-create-link-wrap');
        if (msg) msg.textContent = '';
        if (linkWrap) linkWrap.style.display = 'none';
        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');
    }

    function closeChainWatchCreateModal() {
        const overlay = document.getElementById('war-dashboard-chain-watch-create-modal');
        if (!overlay) return;
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
    }

    function openChainWatchModal() {
        navigateToChainWatchPage();
    }

    function closeChainWatchModal() {
        const overlay = document.getElementById('war-dashboard-chain-watch-modal');
        if (!overlay) return;
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
    }

    function openChainWatchRewardsModal() {
        const overlay = document.getElementById('war-dashboard-chain-watch-rewards-modal');
        const body = document.getElementById('war-dashboard-chain-watch-rewards-body');
        if (!overlay || !body) return;
        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');
        body.innerHTML = '<p style="color:#888;">Loading…</p>';
        fetchChainWatchData(true)
            .then(function () {
                if (!chainWatchPayload) {
                    body.innerHTML =
                        '<p style="color:#f44336;font-size:14px;line-height:1.45;">' +
                        escapeHtml(friendlyChainWatchLoadError(chainWatchLastError)) +
                        '</p>';
                    return null;
                }
                return renderChainWatchRewardsModal();
            })
            .catch(function (err) {
                console.error('renderChainWatchRewardsModal', err);
                body.innerHTML =
                    '<p style="color:#f44336;font-size:14px;">' +
                    escapeHtml(err && err.message ? err.message : 'Could not render rewards.') +
                    '</p>';
            });
    }

    function closeChainWatchRewardsModal() {
        const overlay = document.getElementById('war-dashboard-chain-watch-rewards-modal');
        if (!overlay) return;
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
    }

    function renderEnemy(members, ffMap, bsMap, thresholds, options) {
        options = options || {};
        const table = options.tableId
            ? document.getElementById(options.tableId)
            : document.getElementById('war-dashboard-enemy-table');
        const tbody = table ? table.querySelector('tbody') : null;
        if (!tbody) return;

        const blue = Number(document.getElementById('war-dashboard-ff-blue')?.value) || 2.5;
        const green = Number(document.getElementById('war-dashboard-ff-green')?.value) || 3.5;
        const orange = Number(document.getElementById('war-dashboard-ff-orange')?.value) || 4.5;
        bsMap = bsMap || {};

        const filterOnline = document.getElementById('war-dashboard-filter-online')?.checked === true;
        const filterOffline = document.getElementById('war-dashboard-filter-offline')?.checked === true;
        const filterIdle = document.getElementById('war-dashboard-filter-idle')?.checked === true;
        const filterOkay = document.getElementById('war-dashboard-filter-okay')?.checked === true;
        const filterHospital = document.getElementById('war-dashboard-filter-hospital')?.checked === true;
        const filterAbroad = document.getElementById('war-dashboard-filter-abroad')?.checked === true;
        const filterRecommended = document.getElementById('war-dashboard-filter-recommended')?.checked === true;
        const anyActivity = filterOnline || filterOffline || filterIdle;
        const anyStatus = filterOkay || filterHospital || filterAbroad;

        const nowSec = Math.floor(Date.now() / 1000);
        let filtered;

        if (filterRecommended) {
            const pool = members.filter(m => {
                if (!canShowInRecommended(m)) return false;
                const action = statusFromMember(m).actionStatus;
                const matchActivity = !anyActivity ||
                    (action === 'online' && filterOnline) ||
                    (action === 'offline' && filterOffline) ||
                    (action === 'idle' && filterIdle);
                return matchActivity;
            });
            const ffVal = (member) => ffMap[String(member.id)] != null ? Number(ffMap[String(member.id)]) : null;
            const inRange = (v) => v != null && v >= blue && v <= green;
            const belowRange = (v) => v != null && v < blue;

            let tier1 = pool.filter(m => {
                const status = statusFromMember(m);
                const state = (status.state || '').toLowerCase();
                const desc = (status.description || '').toLowerCase();
                const statusExpired = status.until != null && nowSec >= status.until;
                const inHospital = !statusExpired && (state.includes('hospital') || desc.includes('hospital'));
                const inAbroad = !statusExpired && (state.includes('abroad') || state.includes('traveling') || desc.includes('abroad'));
                const isOkay = !inHospital && !inAbroad;
                return isOkay && inRange(ffVal(m));
            });
            tier1.sort((a, b) => (ffVal(a) ?? 999) - (ffVal(b) ?? 999));
            tier1 = tier1.slice(0, 5);
            const chosenIds = new Set(tier1.map(m => String(m.id)));

            let tier2 = [];
            if (chosenIds.size < 5) {
                tier2 = pool.filter(m => !chosenIds.has(String(m.id)) && inRange(ffVal(m)));
                tier2.sort((a, b) => (ffVal(a) ?? 999) - (ffVal(b) ?? 999));
                tier2 = tier2.slice(0, 5 - chosenIds.size);
                tier2.forEach(m => chosenIds.add(String(m.id)));
            }

            let tier3 = [];
            if (chosenIds.size < 5) {
                tier3 = pool.filter(m => !chosenIds.has(String(m.id)) && belowRange(ffVal(m)));
                tier3.sort((a, b) => (ffVal(b) ?? -1) - (ffVal(a) ?? -1));
                tier3 = tier3.slice(0, 5 - chosenIds.size);
            }

            filtered = [...tier1, ...tier2, ...tier3];
        } else {
            filtered = members.filter(m => {
                const status = statusFromMember(m);
                const action = status.actionStatus;
                const state = (status.state || '').toLowerCase();
                const desc = (status.description || '').toLowerCase();
                const statusExpired = status.until != null && nowSec >= status.until;
                const inHospital = !statusExpired && (state.includes('hospital') || desc.includes('hospital'));
                const inAbroad = !statusExpired && (state.includes('abroad') || state.includes('traveling') || desc.includes('abroad'));
                const isOkay = !inHospital && !inAbroad;

                const matchActivity = !anyActivity ||
                    (action === 'online' && filterOnline) ||
                    (action === 'offline' && filterOffline) ||
                    (action === 'idle' && filterIdle);

                const matchStatus = !anyStatus ||
                    (filterHospital && inHospital) ||
                    (filterAbroad && inAbroad) ||
                    (filterOkay && isOkay);

                return matchActivity && matchStatus;
            });
        }

        const respectContext = options.respectContext || {
            chain: lastOurChain,
            isCurrentWarEnemy: lastEnemyWarKind === 'ongoing',
            retaliationTargetIds: lastRetaliationTargetIds
        };
        const sortColumn = options.sortColumn || enemySortColumn;
        const sortDir = options.sortDir || enemySortDir;
        filtered = sortMembers(filtered, sortColumn, sortDir, ffMap, bsMap, respectContext);
        if (table.id) updateSortIndicators(table.id, sortColumn, sortDir);

        const respectThresholds = { blue, green, orange };
        const rowModels = filtered.map(m => {
            const id = m.id;
            const ff = ffMap[String(id)];
            return {
                member: m,
                id,
                ff,
                respectCalc: warDashboardEstimateRespect(m, ffMap, respectContext)
            };
        });
        const targetableRespectValues = rowModels
            .filter(row => {
                const ffValue = Number(row.ff);
                return row.respectCalc &&
                    Number.isFinite(row.respectCalc.respect) &&
                    (!Number.isFinite(ffValue) || ffValue < green);
            })
            .map(row => row.respectCalc.respect);
        const respectRange = targetableRespectValues.length
            ? { min: Math.min(...targetableRespectValues), max: Math.max(...targetableRespectValues) }
            : { min: null, max: null };

        const rowHtml = rowModels.map(row => {
            const m = row.member;
            const id = row.id;
            const ff = row.ff;
            const bs = bsMap[String(id)];
            const status = statusFromMember(m);
            const statusDisplay = formatLocationStatusDisplay(status, nowSec);
            const color = getFFColor(ff, blue, green, orange);
            const statusColor = getStatusColor(status, nowSec);
            const ffText = ff != null ? ff.toFixed(2) : '—';
            const respectCalc = row.respectCalc;
            const respectText = warDashboardRespectText(respectCalc);
            const respectClass = warDashboardRespectClass(respectCalc, ff, respectThresholds, respectRange);
            const respectTitle = escapeAttr(warDashboardRespectTooltip(respectCalc));
            const bsText = bs != null ? Number(bs).toLocaleString() : '—';
            const attackUrl = `https://www.torn.com/page.php?sid=attack&user2ID=${id}`;
            const noteValue = escapeHtml(getNote(id));
            const memLabelEnemy = window.toolsFormatMemberDisplayLabel({ name: m.name || id, id }, window.toolsGetShowMemberIdInBrackets());
            return `<tr>
                <td><a href="${attackUrl}" target="_blank" rel="noopener" title="Attack">🎯</a> <a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener" style="color: #FFD700;"${window.toolsMemberLinkAttrs(m.name || id, id)}>${escapeHtml(memLabelEnemy)}</a></td>
                <td>${escapeHtml(m.level != null ? String(m.level) : '—')}</td>
                <td style="background-color: ${color || 'transparent'};">${ffText}</td>
                <td class="war-dashboard-respect-col" title="${respectTitle}"><span class="war-dashboard-respect-value ${respectClass}">${respectText}</span></td>
                <td>${bsText}</td>
                <td${statusColor ? ' style="color: ' + statusColor + ';"' : ''}>${escapeHtml(status.actionStatus)}</td>
                ${warDashboardLocationCellOpenTag(status, nowSec)}${escapeHtml(statusDisplay)}</td>
                <td><input type="text" class="war-dashboard-note-input" data-player-id="${escapeHtml(id)}" value="${noteValue}" placeholder="Note…" maxlength="500" /></td>
            </tr>`;
        }).join('');

        const active = document.activeElement;
        const noteInput = (active && active.classList && active.classList.contains('war-dashboard-note-input') && table && table.contains(active))
            ? active
            : null;
        const saved = noteInput ? {
            playerId: noteInput.getAttribute('data-player-id'),
            value: noteInput.value,
            start: noteInput.selectionStart,
            end: noteInput.selectionEnd
        } : null;

        tbody.innerHTML = rowHtml;

        if (saved && saved.playerId) {
            const inputs = tbody.querySelectorAll('.war-dashboard-note-input');
            const input = Array.prototype.find.call(inputs, function (el) { return el.getAttribute('data-player-id') === saved.playerId; });
            if (input) {
                input.value = saved.value;
                input.focus();
                input.setSelectionRange(saved.start, saved.end);
            }
        }
    }

    function enemyTableHtml(enemy) {
        const tableId = 'war-dashboard-enemy-table-' + escapeHtml(enemy.id);
        return '<div class="table-scroll-wrapper" style="overflow-x: auto;">' +
            '<table id="' + tableId + '" class="war-dashboard-table war-dashboard-enemy-table" data-faction-id="' + escapeHtml(enemy.id) + '">' +
            '<colgroup>' +
            '<col style="width: 18%"><col style="width: 6%"><col style="width: 6%"><col style="width: 8%"><col style="width: 10%"><col style="width: 8%"><col style="width: 26%"><col style="width: 14%">' +
            '</colgroup>' +
            '<thead><tr>' +
            '<th data-column="member" class="war-dashboard-th-sort">Member <span class="war-dashboard-sort"></span></th>' +
            '<th data-column="level" class="war-dashboard-th-sort">Level <span class="war-dashboard-sort"></span></th>' +
            '<th data-column="ff" class="war-dashboard-th-sort">FF <span class="war-dashboard-sort"></span></th>' +
            '<th data-column="respect" class="war-dashboard-th-sort war-dashboard-respect-col" title="Estimated respect from a normal attack using the Torn Wiki formula.">Respect <span class="war-dashboard-sort"></span></th>' +
            '<th data-column="eststats" class="war-dashboard-th-sort">Est. stats <span class="war-dashboard-sort"></span></th>' +
            '<th data-column="status" class="war-dashboard-th-sort">Status <span class="war-dashboard-sort"></span></th>' +
            '<th data-column="location" class="war-dashboard-th-sort">Location / state <span class="war-dashboard-sort"></span></th>' +
            '<th>Notes</th>' +
            '</tr></thead><tbody></tbody></table></div>';
    }

    function renderEnemyPanels() {
        const container = document.getElementById('war-dashboard-enemies-list');
        if (!container) return;
        if (!enemyFactionStates.length) {
            container.innerHTML = '<p class="war-dashboard-command-help">Add an enemy faction to compare members.</p>';
            return;
        }
        container.innerHTML = enemyFactionStates.map(function (enemy) {
            const expanded = enemy.expanded !== false;
            const name = enemy.name || ('Faction ' + enemy.id);
            return '<section class="war-dashboard-enemy-panel" data-faction-id="' + escapeHtml(enemy.id) + '">' +
                '<button type="button" class="war-dashboard-enemy-panel-toggle" data-faction-id="' + escapeHtml(enemy.id) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
                '<span class="war-dashboard-enemy-panel-arrow" aria-hidden="true">' + (expanded ? '▼' : '▶') + '</span>' +
                '<span>' + escapeHtml(name) + '</span>' +
                '<small>ID: ' + escapeHtml(enemy.id) + ' · ' + ((enemy.members || []).length) + ' members</small>' +
                '</button>' +
                '<div class="war-dashboard-enemy-panel-body" style="display:' + (expanded ? 'block' : 'none') + ';">' +
                enemyTableHtml(enemy) +
                '</div>' +
                '</section>';
        }).join('');
        enemyFactionStates.forEach(function (enemy) {
            renderEnemy(enemy.members || [], enemy.ff || {}, enemy.bs || {}, null, {
                tableId: 'war-dashboard-enemy-table-' + enemy.id,
                sortColumn: enemy.sortColumn || enemySortColumn,
                sortDir: enemy.sortDir || enemySortDir,
                respectContext: {
                    chain: lastOurChain,
                    isCurrentWarEnemy: enemy.warKind === 'ongoing',
                    retaliationTargetIds: enemy.retaliationTargetIds || new Set()
                }
            });
        });
        warDashboardInjectMemberColumnHeaders();
    }

    function escapeHtml(s) {
        if (s == null) return '';
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    function getNote(playerId) {
        try {
            return localStorage.getItem(NOTE_PREFIX + playerId) || '';
        } catch (e) { return ''; }
    }

    function setNote(playerId, text) {
        try {
            if (text) localStorage.setItem(NOTE_PREFIX + playerId, text);
            else localStorage.removeItem(NOTE_PREFIX + playerId);
        } catch (e) { /* ignore */ }
    }

    function getTrackOurChain() {
        const v = localStorage.getItem(STORAGE_KEYS.trackOurChain);
        return v === null || v === 'true';
    }
    function setTrackOurChain(on) {
        try { localStorage.setItem(STORAGE_KEYS.trackOurChain, on ? 'true' : 'false'); } catch (e) { /* ignore */ }
    }
    function getTrackEnemyChain() {
        const v = localStorage.getItem(STORAGE_KEYS.trackEnemyChain);
        return v === null || v === 'true';
    }
    function setTrackEnemyChain(on) {
        try { localStorage.setItem(STORAGE_KEYS.trackEnemyChain, on ? 'true' : 'false'); } catch (e) { /* ignore */ }
    }

    function isChainAtZero(chain) {
        return chain && Number(chain.timeout || 0) === 0 && Number(chain.cooldown || 0) === 0;
    }

    function showLoading(show) {
        const el = document.getElementById('war-dashboard-loading');
        if (el) el.style.display = show ? 'block' : 'none';
    }

    function showError(msg) {
        const el = document.getElementById('war-dashboard-error');
        if (el) {
            const text = msg || '';
            if (text && String(text).indexOf('API Settings') !== -1) {
                el.innerHTML = escapeHtml(String(text)).replace(
                    'API Settings',
                    '<a href="#" class="api-settings-open-link" style="color:#FFD700;text-decoration:underline;">API Settings</a>'
                );
            } else {
                el.textContent = text;
            }
            el.style.display = msg ? 'block' : 'none';
        }
    }

    function loadSettings() {
        const interval = localStorage.getItem(STORAGE_KEYS.refreshInterval);
        const chainInterval = localStorage.getItem(STORAGE_KEYS.chainRefreshInterval);
        const blue = localStorage.getItem(STORAGE_KEYS.ffBlue);
        const green = localStorage.getItem(STORAGE_KEYS.ffGreen);
        const orange = localStorage.getItem(STORAGE_KEYS.ffOrange);
        const warlordEnabled = localStorage.getItem(STORAGE_KEYS.respectWarlordEnabled);
        const warlordPercent = localStorage.getItem(STORAGE_KEYS.respectWarlordPercent);

        const idInput = document.getElementById('war-dashboard-enemy-faction-id');
        if (idInput) idInput.value = '';
        const intervalInput = document.getElementById('war-dashboard-refresh-interval');
        if (intervalInput && interval != null) intervalInput.value = String(Math.max(30, parseInt(interval || '30', 10) || 30));
        const chainIntervalInput = document.getElementById('war-dashboard-chain-refresh-interval');
        if (chainIntervalInput) chainIntervalInput.value = String(Math.max(30, parseInt(chainInterval || '30', 10) || 30));
        const blueInput = document.getElementById('war-dashboard-ff-blue');
        if (blueInput && blue != null) blueInput.value = blue || '2.5';
        const greenInput = document.getElementById('war-dashboard-ff-green');
        if (greenInput && green != null) greenInput.value = green || '3.5';
        const orangeInput = document.getElementById('war-dashboard-ff-orange');
        if (orangeInput && orange != null) orangeInput.value = orange || '4.5';
        const warlordEnabledInput = document.getElementById('war-dashboard-respect-warlord-enabled');
        if (warlordEnabledInput && warlordEnabled != null) warlordEnabledInput.checked = warlordEnabled === '1';
        const warlordPercentInput = document.getElementById('war-dashboard-respect-warlord-percent');
        if (warlordPercentInput) warlordPercentInput.value = (warlordPercent != null && warlordPercent !== '') ? warlordPercent : '15';
        updateRecommendedLabel();
        renderEnemyPickerList();
    }

    function updateRecommendedLabel() {
        const blue = Number(document.getElementById('war-dashboard-ff-blue')?.value) || 2.5;
        const green = Number(document.getElementById('war-dashboard-ff-green')?.value) || 3.5;
        const el = document.getElementById('war-dashboard-recommended-ff-range');
        if (el) el.textContent = 'FF ' + blue + ' – ' + green;
    }

    function saveSettings() {
        const intervalInput = document.getElementById('war-dashboard-refresh-interval');
        if (intervalInput) localStorage.setItem(STORAGE_KEYS.refreshInterval, intervalInput.value);
        const chainIntervalInput = document.getElementById('war-dashboard-chain-refresh-interval');
        if (chainIntervalInput) localStorage.setItem(STORAGE_KEYS.chainRefreshInterval, chainIntervalInput.value);
        const blue = document.getElementById('war-dashboard-ff-blue')?.value;
        const green = document.getElementById('war-dashboard-ff-green')?.value;
        const orange = document.getElementById('war-dashboard-ff-orange')?.value;
        if (blue != null) localStorage.setItem(STORAGE_KEYS.ffBlue, blue);
        if (green != null) localStorage.setItem(STORAGE_KEYS.ffGreen, green);
        if (orange != null) localStorage.setItem(STORAGE_KEYS.ffOrange, orange);
        const warlordEnabled = document.getElementById('war-dashboard-respect-warlord-enabled')?.checked;
        const warlordPercent = document.getElementById('war-dashboard-respect-warlord-percent')?.value;
        if (warlordEnabled != null) localStorage.setItem(STORAGE_KEYS.respectWarlordEnabled, warlordEnabled ? '1' : '0');
        if (warlordPercent != null) localStorage.setItem(STORAGE_KEYS.respectWarlordPercent, warlordPercent || '15');
    }

    function normalizeEnemyFactionId(value) {
        return String(value || '').replace(/\D/g, '').trim();
    }

    function getStoredEnemyFactionIds() {
        const ids = [];
        try {
            const rawList = localStorage.getItem(STORAGE_KEYS.enemyFactionIds);
            if (rawList) {
                const parsed = JSON.parse(rawList);
                if (Array.isArray(parsed)) {
                    parsed.forEach(id => {
                        const clean = normalizeEnemyFactionId(id);
                        if (clean && !ids.includes(clean) && ids.length < MAX_ENEMY_FACTIONS) ids.push(clean);
                    });
                }
            }
        } catch (e) { /* ignore */ }
        if (!ids.length) {
            const legacy = normalizeEnemyFactionId(localStorage.getItem(STORAGE_KEYS.enemyFactionId) || '');
            if (legacy) ids.push(legacy);
        }
        return ids;
    }

    function setStoredEnemyFactionIds(ids) {
        const clean = [];
        (ids || []).forEach(id => {
            const normalized = normalizeEnemyFactionId(id);
            if (normalized && !clean.includes(normalized) && clean.length < MAX_ENEMY_FACTIONS) clean.push(normalized);
        });
        try {
            localStorage.setItem(STORAGE_KEYS.enemyFactionIds, JSON.stringify(clean));
            if (clean[0]) localStorage.setItem(STORAGE_KEYS.enemyFactionId, clean[0]);
            else localStorage.removeItem(STORAGE_KEYS.enemyFactionId);
        } catch (e) { /* ignore */ }
        renderEnemyPickerList();
        return clean;
    }

    function addStoredEnemyFactionId(id) {
        const clean = normalizeEnemyFactionId(id);
        if (!clean) return { ok: false, message: 'Enter an enemy faction ID.' };
        const ids = getStoredEnemyFactionIds();
        if (ids.includes(clean)) return { ok: true, ids };
        if (ids.length >= MAX_ENEMY_FACTIONS) return { ok: false, message: 'You can add up to 3 enemy factions.' };
        ids.push(clean);
        return { ok: true, ids: setStoredEnemyFactionIds(ids) };
    }

    function removeStoredEnemyFactionId(id) {
        const clean = normalizeEnemyFactionId(id);
        setStoredEnemyFactionIds(getStoredEnemyFactionIds().filter(existing => existing !== clean));
    }

    function renderEnemyPickerList() {
        const listEl = document.getElementById('war-dashboard-enemy-list');
        if (!listEl) return;
        const ids = getStoredEnemyFactionIds();
        if (!ids.length) {
            listEl.innerHTML = '<p class="war-dashboard-command-help">No enemy factions added. Add up to 3.</p>';
            return;
        }
        listEl.innerHTML = ids.map(id => {
            const state = enemyFactionStates.find(enemy => String(enemy.id) === String(id));
            const label = (state && state.name) || getCachedFactionName(id) || 'Faction ' + id;
            return '<div class="war-dashboard-enemy-list-row">' +
                '<span>' + escapeHtml(label) + ' <small>ID: ' + escapeHtml(id) + '</small></span>' +
                '<button type="button" class="btn war-dashboard-enemy-remove" data-faction-id="' + escapeHtml(id) + '">Remove</button>' +
                '</div>';
        }).join('');
    }

    function syncPrimaryEnemyFromStates() {
        const first = enemyFactionStates[0] || null;
        lastEnemyFactionId = first ? first.id : null;
        lastEnemyName = first ? first.name : null;
        lastEnemyWarKind = first ? first.warKind : null;
        lastRetaliationTargetIds = first ? first.retaliationTargetIds : new Set();
        lastEnemyMembers = first ? first.members : [];
        lastEnemyFF = first ? first.ff : {};
        lastEnemyBS = first ? first.bs : {};
        lastEnemyChain = first ? first.chain : null;
        enemyChainDisplay = first && first.chainDisplay ? first.chainDisplay : { timeout: 0, cooldown: 0 };
        lastEnemyChainFetchTime = first ? first.chainFetchTime || 0 : 0;
    }

    function updateWarDashboardEnemyLabels() {
        const storedIds = getStoredEnemyFactionIds();
        const activeStates = enemyFactionStates.length
            ? enemyFactionStates
            : storedIds.map(id => ({ id, name: getCachedFactionName(id) || 'Faction ' + id }));
        const count = activeStates.length;
        const names = activeStates.map(enemy => enemy.name || getCachedFactionName(enemy.id) || ('Faction ' + enemy.id));
        const title = count === 1 ? names[0] : 'Enemies';
        const summaryText = count ? (count + '/' + MAX_ENEMY_FACTIONS + ' selected') : 'Choose up to 3';

        const titleEl = document.getElementById('war-dashboard-enemy-title');
        if (titleEl) titleEl.textContent = title;

        const commandTitleEl = document.getElementById('war-dashboard-enemy-command-title');
        if (commandTitleEl) commandTitleEl.textContent = 'Enemies';

        const summaryEl = document.getElementById('war-dashboard-enemy-picker-summary');
        if (summaryEl) summaryEl.textContent = summaryText;

        const labelEl = document.getElementById('war-dashboard-enemy-label');
        if (labelEl) labelEl.textContent = count ? names.join(', ') : 'Add up to 3 enemy factions.';
        renderEnemyPickerList();
    }

    async function loadEnemyFactionState(apiKey, ourFactionId, enemyFactionId, currentWarEnemy) {
        let enemyName = '';
        let warKind = null;
        if (currentWarEnemy && currentWarEnemy.enemyFactionId === enemyFactionId) {
            enemyName = currentWarEnemy.enemyName || '';
            warKind = currentWarEnemy.kind || null;
            setCachedFactionName(enemyFactionId, enemyName);
        }
        if (!enemyName) {
            enemyName = getCachedFactionName(enemyFactionId) || await fetchFactionName(apiKey, enemyFactionId).catch(() => null) || '';
        }

        const [members, chainData, recentRetalIds] = await Promise.all([
            fetchFactionMembers(apiKey, enemyFactionId).catch(() => []),
            fetchFactionChain(apiKey, enemyFactionId).catch(() => null),
            fetchRecentIncomingAttackers(apiKey, ourFactionId, enemyFactionId).catch(() => new Set())
        ]);

        let ff = {};
        let bs = {};
        const memberIds = members.map(m => String(m.id));
        const cached = getFFCache(enemyFactionId);
        if (cached && cached.ff && !shouldRefreshFFToday(enemyFactionId)) {
            ff = cached.ff || {};
            bs = cached.bs || {};
        } else if (memberIds.length) {
            try {
                const data = await fetchFFForMembers(apiKey, memberIds);
                ff = data.ff || {};
                bs = data.bs || {};
                setFFCache(enemyFactionId, { ff, bs });
            } catch (e) {
                console.warn('War Dashboard enemy FF:', e.message);
                if (cached && cached.ff) {
                    ff = cached.ff || {};
                    bs = cached.bs || {};
                }
            }
        } else if (cached && cached.ff) {
            ff = cached.ff || {};
            bs = cached.bs || {};
        }

        const existing = enemyFactionStates.find(enemy => String(enemy.id) === String(enemyFactionId));
        return {
            id: enemyFactionId,
            name: enemyName || 'Faction ' + enemyFactionId,
            warKind,
            members,
            ff,
            bs,
            chain: chainData,
            chainDisplay: chainData ? { timeout: chainData.timeout, cooldown: chainData.cooldown } : { timeout: 0, cooldown: 0 },
            chainFetchTime: chainData ? Date.now() : 0,
            retaliationTargetIds: recentRetalIds || new Set(),
            expanded: existing ? existing.expanded !== false : true,
            sortColumn: existing ? existing.sortColumn : enemySortColumn,
            sortDir: existing ? existing.sortDir : enemySortDir
        };
    }

    async function runDashboard() {
        if (dashboardLoadPromise) return dashboardLoadPromise;
        dashboardLoadPromise = runDashboardInner().finally(function () {
            dashboardLoadPromise = null;
        });
        return dashboardLoadPromise;
    }

    async function runDashboardInner() {
        const apiKey = getApiKey();
        if (!apiKey) {
            showError('Please enter your API key in the sidebar.');
            return;
        }

        saveSettings();
        showError('');
        showLoading(true);

        const enemyFactionIds = getStoredEnemyFactionIds();

        try {
            const user = await getUserProfile(apiKey);
            const ourFactionId = user.factionId;
            if (!ourFactionId) {
                showError('You are not in a faction.');
                showLoading(false);
                return;
            }

            lastOurFactionId = ourFactionId;
            currentUserPlayerId = user.playerId;

            if (!enemyFactionIds.length) {
                enemyFactionStates = [];
                syncPrimaryEnemyFromStates();
                lastEnemyWarKind = null;
                lastRetaliationTargetIds = new Set();
                showWarDashboardChainsRow();
                renderChainBoxes();
                // No enemy applied: still show Our team and Our chain (collapsed)
                const [ourMembers, ourChainData] = await Promise.all([
                    fetchFactionMembers(apiKey, null),
                    fetchFactionChain(apiKey, ourFactionId).catch(() => null)
                ]);
                let ourFF = {};
                let ourBS = {};
                const ourIds = ourMembers.map(m => String(m.id));
                const ourCached = getFFCache(ourFactionId);
                if (ourCached?.ff && !shouldRefreshFFToday(ourFactionId)) {
                    ourFF = ourCached.ff || {};
                    ourBS = ourCached.bs || {};
                } else if (ourIds.length) {
                    try {
                        const ourData = await fetchFFForMembers(apiKey, ourIds);
                        ourFF = ourData.ff || {};
                        ourBS = ourData.bs || {};
                        setFFCache(ourFactionId, { ff: ourFF, bs: ourBS });
                    } catch (e) { console.warn('War Dashboard our FF:', e.message); }
                } else if (ourCached?.ff) {
                    ourFF = ourCached.ff;
                    ourBS = ourCached.bs || {};
                }
                lastOurMembers = ourMembers;
                lastOurFF = ourFF;
                lastOurBS = ourBS;
                lastOurChain = ourChainData;
                if (ourChainData) lastOurChainFetchTime = Date.now();
                ourChainDisplay = ourChainData ? { timeout: ourChainData.timeout, cooldown: ourChainData.cooldown } : { timeout: 0, cooldown: 0 };
                enemyFactionStates = [];
                syncPrimaryEnemyFromStates();
                updateWarDashboardEnemyLabels();
                const me = ourMembers.find(m => String(m.id) === String(user.playerId));
                currentUserAbroadCountry = me ? parseAbroadCountry(me) : null;
                renderOurTeam(ourMembers, ourFF, ourBS, null);
                renderEnemyPanels();
                renderChainBoxes();
                showWarDashboardChainsRow();
                document.getElementById('war-dashboard-our-team').style.display = 'block';
                document.getElementById('war-dashboard-enemy-section').style.display = 'none';
                const activitySection = document.getElementById('war-dashboard-activity-tracker');
                if (activitySection) activitySection.style.display = 'block';
                await mergeActivityTrackedFromCloudIfEmpty();
                updateActivityTrackerUI();
                syncAllTrackedFactionsToFirestoreThenRefreshStatus();
                setOurTeamCollapsed(true);
                showError('Enter an enemy faction ID or click "Add current ranked war" to compare.');
                fetchChainWatchData(false).catch(function () {});
                syncChainWatchFromDashboard();
                showLoading(false);
                return;
            }

            const current = await getCurrentWarEnemy(apiKey, ourFactionId).catch(() => null);

            const [ourMembers, ourChainData, loadedEnemies] = await Promise.all([
                fetchFactionMembers(apiKey, null),
                fetchFactionChain(apiKey, ourFactionId).catch(() => null),
                Promise.all(enemyFactionIds.map(id => loadEnemyFactionState(apiKey, ourFactionId, id, current)))
            ]);

            // FF + battle stats for our faction: cache 1 week, refresh on first use each day
            let ourFF = {};
            let ourBS = {};
            const ourIds = ourMembers.map(m => String(m.id));
            const ourCached = getFFCache(ourFactionId);
            if (ourCached && ourCached.ff && !shouldRefreshFFToday(ourFactionId)) {
                ourFF = ourCached.ff || {};
                ourBS = ourCached.bs || {};
            } else if (ourIds.length) {
                try {
                    const ourData = await fetchFFForMembers(apiKey, ourIds);
                    ourFF = ourData.ff || {};
                    ourBS = ourData.bs || {};
                    setFFCache(ourFactionId, { ff: ourFF, bs: ourBS });
                } catch (e) { console.warn('War Dashboard our FF:', e.message); }
            } else if (ourCached && ourCached.ff) {
                ourFF = ourCached.ff;
                ourBS = ourCached.bs || {};
            }

            enemyFactionStates = loadedEnemies;
            syncPrimaryEnemyFromStates();
            updateWarDashboardEnemyLabels();
            lastOurMembers = ourMembers;
            lastOurFF = ourFF;
            lastOurBS = ourBS;
            lastOurFactionId = ourFactionId;
            currentUserPlayerId = user.playerId;
            const me = ourMembers.find(m => String(m.id) === String(user.playerId));
            currentUserAbroadCountry = me ? parseAbroadCountry(me) : null;

            lastOurChain = ourChainData;
            if (ourChainData) lastOurChainFetchTime = Date.now();
            ourChainDisplay = lastOurChain ? { timeout: lastOurChain.timeout, cooldown: lastOurChain.cooldown } : { timeout: 0, cooldown: 0 };

            renderOurTeam(ourMembers, ourFF, ourBS, null);
            renderEnemyPanels();
            renderChainBoxes();
            showWarDashboardChainsRow();
            document.getElementById('war-dashboard-enemy-section').style.display = 'block';
            document.getElementById('war-dashboard-our-team').style.display = 'block';
            const activitySection = document.getElementById('war-dashboard-activity-tracker');
            if (activitySection) activitySection.style.display = 'block';
            await mergeActivityTrackedFromCloudIfEmpty();
            updateActivityTrackerUI();
            syncAllTrackedFactionsToFirestoreThenRefreshStatus();
            setOurTeamCollapsed(true);
            fetchChainWatchData(false).catch(function () {});
            syncChainWatchFromDashboard();
        } catch (err) {
            showError(warDashboardFriendlyError(err));
            console.error('War Dashboard:', err);
        } finally {
            showLoading(false);
        }
    }

    function isOurTeamExpanded() {
        const body = document.getElementById('war-dashboard-our-team-body');
        const btn = document.getElementById('war-dashboard-our-team-toggle');
        return body && btn && btn.getAttribute('aria-expanded') === 'true';
    }

    function setOurTeamCollapsed(collapsed) {
        const body = document.getElementById('war-dashboard-our-team-body');
        const btn = document.getElementById('war-dashboard-our-team-toggle');
        const arrow = btn?.querySelector('.war-dashboard-our-team-arrow');
        if (!body || !btn) return;
        if (collapsed) {
            body.style.display = 'none';
            btn.setAttribute('aria-expanded', 'false');
            if (arrow) arrow.textContent = '▶';
        } else {
            body.style.display = 'block';
            btn.setAttribute('aria-expanded', 'true');
            if (arrow) arrow.textContent = '▼';
        }
    }

    /** When user turns chain tracking back on, do a fresh pull of that chain then follow usual auto-refresh rules. */
    async function refreshChainWhenTurningOn(chainKey) {
        if (chainKey !== 'our' && chainKey !== 'enemy') return;
        const apiKey = getApiKey();
        if (!apiKey) return;
        try {
            if (chainKey === 'our') {
                if (!lastOurFactionId) return;
                const data = await fetchFactionChain(apiKey, lastOurFactionId);
                if (data) {
                    lastOurChain = data;
                    ourChainDisplay = { timeout: data.timeout, cooldown: data.cooldown };
                    lastOurChainFetchTime = Date.now();
                }
            } else {
                await Promise.all(enemyFactionStates.map(async function (enemy) {
                    const data = await fetchFactionChain(apiKey, enemy.id).catch(() => null);
                    if (!data) return;
                    enemy.chain = data;
                    enemy.chainDisplay = { timeout: data.timeout, cooldown: data.cooldown };
                    enemy.chainFetchTime = Date.now();
                }));
                syncPrimaryEnemyFromStates();
            }
            if (chainKey === 'our' || enemyFactionStates.length) {
                renderChainBoxes();
                renderEnemyPanels();
                if (isOurTeamExpanded()) renderOurTeam(lastOurMembers, lastOurFF, lastOurBS, null);
            }
        } catch (e) {
            console.warn('War Dashboard refresh chain on turn on:', e);
        }
    }

    /** Force re-fetch FF + battle stats from FF Scouter (bypass cache), then re-render. Same data source as Faction Battle Stats. */
    async function refreshBattleStatsOnly() {
        const apiKey = getApiKey();
        if (!apiKey) {
            showError('Please enter your API key in the sidebar.');
            return;
        }
        if (!enemyFactionStates.length || !lastOurFactionId) {
            showError('Load the dashboard first (Add enemy or Add current ranked war), then refresh battle stats.');
            return;
        }
        const btn = document.getElementById('war-dashboard-refresh-battle-stats');
        if (btn) btn.disabled = true;
        showLoading(true);
        showError('');
        try {
            const ourIds = lastOurMembers.map(m => String(m.id));
            const [ourData, enemyDatas] = await Promise.all([
                ourIds.length ? fetchFFForMembers(apiKey, ourIds) : Promise.resolve({ ff: {}, bs: {} }),
                Promise.all(enemyFactionStates.map(function (enemy) {
                    const ids = (enemy.members || []).map(m => String(m.id));
                    return ids.length ? fetchFFForMembers(apiKey, ids) : Promise.resolve({ ff: {}, bs: {} });
                }))
            ]);
            const ourFF = ourData.ff || {};
            const ourBS = ourData.bs || {};
            setFFCache(lastOurFactionId, { ff: ourFF, bs: ourBS });
            enemyFactionStates.forEach(function (enemy, index) {
                const enemyData = enemyDatas[index] || {};
                enemy.ff = enemyData.ff || {};
                enemy.bs = enemyData.bs || {};
                setFFCache(enemy.id, { ff: enemy.ff, bs: enemy.bs });
            });
            lastOurFF = ourFF;
            lastOurBS = ourBS;
            syncPrimaryEnemyFromStates();
            renderOurTeam(lastOurMembers, lastOurFF, lastOurBS, null);
            renderEnemyPanels();
        } catch (e) {
            showError(e.message || 'Failed to refresh battle stats.');
            console.warn('War Dashboard refresh battle stats:', e);
        } finally {
            showLoading(false);
            if (btn) btn.disabled = false;
        }
    }

    /** Status-only refresh: re-fetch faction members and chains. When chain tracking is off, skip that chain. When chain is at 0, only refetch once per minute. */
    async function refreshStatusOnly() {
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        if (!enemyFactionStates.length) return;
        const apiKey = getApiKey();
        if (!apiKey) return;

        showLoading(false);
        try {
            const now = Date.now();
            const ourChainPromise = (() => {
                if (!getTrackOurChain()) return Promise.resolve(lastOurChain);
                if (lastOurFactionId && isChainAtZero(lastOurChain) && lastOurChainFetchTime && (now - lastOurChainFetchTime < CHAIN_AT_ZERO_THROTTLE_MS))
                    return Promise.resolve(lastOurChain);
                return lastOurFactionId ? fetchFactionChain(apiKey, lastOurFactionId).then((data) => { lastOurChainFetchTime = Date.now(); return data; }).catch(() => lastOurChain) : Promise.resolve(lastOurChain);
            })();
            const sharedAttacksPromise = lastOurFactionId
                ? fetchRecentIncomingAttackers(apiKey, lastOurFactionId, enemyFactionStates[0].id).catch(() => null)
                : Promise.resolve(null);
            const enemyRefreshesPromise = Promise.all(enemyFactionStates.map(async function (enemy) {
                const membersPromise = fetchFactionMembers(apiKey, enemy.id).catch(() => enemy.members || []);
                const chainPromise = (() => {
                    if (!getTrackEnemyChain()) return Promise.resolve(enemy.chain);
                    if (isChainAtZero(enemy.chain) && enemy.chainFetchTime && (now - enemy.chainFetchTime < CHAIN_AT_ZERO_THROTTLE_MS))
                        return Promise.resolve(enemy.chain);
                    return fetchFactionChain(apiKey, enemy.id).then((data) => {
                        enemy.chainFetchTime = Date.now();
                        return data;
                    }).catch(() => enemy.chain);
                })();
                await sharedAttacksPromise;
                const retaliationTargetIds = await fetchRecentIncomingAttackers(apiKey, lastOurFactionId, enemy.id).catch(() => enemy.retaliationTargetIds || new Set());
                const [members, chain] = await Promise.all([membersPromise, chainPromise]);
                enemy.members = members;
                enemy.retaliationTargetIds = retaliationTargetIds;
                if (chain) {
                    enemy.chain = chain;
                    enemy.chainDisplay = { timeout: chain.timeout, cooldown: chain.cooldown };
                }
                return enemy;
            }));

            const [ourChainData] = await Promise.all([
                ourChainPromise,
                enemyRefreshesPromise
            ]);
            if (ourChainData) {
                lastOurChain = ourChainData;
                ourChainDisplay = { timeout: ourChainData.timeout, cooldown: ourChainData.cooldown };
            }
            syncPrimaryEnemyFromStates();
            renderEnemyPanels();
            renderChainBoxes();
            syncChainWatchFromDashboard();

            if (isOurTeamExpanded() && lastOurFactionId != null) {
                const ourMembers = await fetchFactionMembers(apiKey, null).catch(() => lastOurMembers);
                lastOurMembers = ourMembers;
                renderOurTeam(ourMembers, lastOurFF, lastOurBS, null);
            }
        } catch (e) {
            console.warn('War Dashboard status refresh:', e);
        }
    }

    function getRefreshIntervalSec() {
        return Math.max(30, Math.min(300, parseInt(document.getElementById('war-dashboard-refresh-interval')?.value || '30', 10)));
    }

    function getChainRefreshIntervalSec() {
        return Math.max(30, Math.min(300, parseInt(document.getElementById('war-dashboard-chain-refresh-interval')?.value || '30', 10)));
    }

    /** Fetch chain data only (our and/or enemy when tracking). Uses chain refresh interval, independent of main refresh. */
    async function refreshChainsOnly() {
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        const apiKey = getApiKey();
        if (!apiKey) return;
        const now = Date.now();
        const ourPromise = (() => {
            if (!getTrackOurChain() || !lastOurFactionId) return Promise.resolve(lastOurChain);
            if (lastOurFactionId && isChainAtZero(lastOurChain) && lastOurChainFetchTime && (now - lastOurChainFetchTime < CHAIN_AT_ZERO_THROTTLE_MS))
                return Promise.resolve(lastOurChain);
            return fetchFactionChain(apiKey, lastOurFactionId).then((data) => { lastOurChainFetchTime = Date.now(); return data; }).catch(() => lastOurChain);
        })();
        const enemyPromise = Promise.all(enemyFactionStates.map(function (enemy) {
            if (!getTrackEnemyChain()) return Promise.resolve(enemy.chain);
            if (isChainAtZero(enemy.chain) && enemy.chainFetchTime && (now - enemy.chainFetchTime < CHAIN_AT_ZERO_THROTTLE_MS))
                return Promise.resolve(enemy.chain);
            return fetchFactionChain(apiKey, enemy.id).then((data) => {
                enemy.chainFetchTime = Date.now();
                return data;
            }).catch(() => enemy.chain);
        }));
        try {
            const [ourChainData, enemyChainDataList] = await Promise.all([ourPromise, enemyPromise]);
            if (ourChainData) {
                lastOurChain = ourChainData;
                ourChainDisplay = { timeout: ourChainData.timeout, cooldown: ourChainData.cooldown };
            }
            enemyFactionStates.forEach(function (enemy, index) {
                const enemyChainData = enemyChainDataList[index];
                if (!enemyChainData) return;
                enemy.chain = enemyChainData;
                enemy.chainDisplay = { timeout: enemyChainData.timeout, cooldown: enemyChainData.cooldown };
            });
            syncPrimaryEnemyFromStates();
            renderChainBoxes();
            renderEnemyPanels();
            if (isOurTeamExpanded()) renderOurTeam(lastOurMembers, lastOurFF, lastOurBS, null);
            syncChainWatchFromDashboard();
        } catch (e) {
            console.warn('War Dashboard chain refresh:', e);
        }
        scheduleNextChainRefresh();
    }

    function scheduleNextChainRefresh() {
        if (chainRefreshTimer) clearTimeout(chainRefreshTimer);
        chainRefreshTimer = null;
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        const sec = getChainRefreshIntervalSec();
        chainRefreshTimer = setTimeout(() => {
            chainRefreshTimer = null;
            refreshChainsOnly();
        }, sec * 1000);
    }

    function startChainRefreshTimer() {
        if (chainRefreshTimer) clearTimeout(chainRefreshTimer);
        chainRefreshTimer = null;
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        scheduleNextChainRefresh();
    }

    function stopChainRefreshTimer() {
        if (chainRefreshTimer) {
            clearTimeout(chainRefreshTimer);
            chainRefreshTimer = null;
        }
    }

    function stopAllWarDashboardTimers() {
        stopRefreshTimer();
        stopChainTick();
        stopChainRefreshTimer();
        if (activityTrackerIntervalId) {
            clearInterval(activityTrackerIntervalId);
            activityTrackerIntervalId = null;
        }
        if (activityTrackerCountdownIntervalId) {
            clearInterval(activityTrackerCountdownIntervalId);
            activityTrackerCountdownIntervalId = null;
        }
        if (window._warDashboardActivityCloudRefreshId) {
            clearInterval(window._warDashboardActivityCloudRefreshId);
            window._warDashboardActivityCloudRefreshId = null;
        }
        if (window._warDashboardChainWatchPollId) {
            clearInterval(window._warDashboardChainWatchPollId);
            window._warDashboardChainWatchPollId = null;
        }
        if (window._warDashboardActivityStartupTimer) {
            clearTimeout(window._warDashboardActivityStartupTimer);
            window._warDashboardActivityStartupTimer = null;
        }
    }

    function startWarDashboardTimers() {
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        startRefreshTimer();
        startChainTick();
        startChainRefreshTimer();
        if (!activityTrackerIntervalId) {
            activityTrackerIntervalId = setInterval(runActivityTrackerTick, ACTIVITY_INTERVAL_MS);
        }
        if (!activityTrackerCountdownIntervalId) {
            activityTrackerCountdownIntervalId = setInterval(updateActivityCountdown, 1000);
            updateActivityCountdown();
        }
        if (!window._warDashboardActivityCloudRefreshId) {
            window._warDashboardActivityCloudRefreshId = setInterval(runActivityCloudRefreshTick, ACTIVITY_FIRESTORE_REFRESH_MS);
        }
        if (!window._warDashboardChainWatchPollId) {
            window._warDashboardChainWatchPollId = setInterval(function () {
                const p = (window.location.hash || '').replace('#', '').split('/')[0];
                if (p !== 'war-dashboard' || !lastOurFactionId) return;
                fetchChainWatchData(false).catch(function () {});
            }, CHAIN_WATCH_POLL_MS);
        }
        if (!window._warDashboardActivityStartupTimer) {
            nextActivitySampleAt = Date.now() + 5000;
            window._warDashboardActivityStartupTimer = setTimeout(function () {
                window._warDashboardActivityStartupTimer = null;
                runActivityTrackerTick();
            }, 5000);
        }
    }

    window._warDashboardStopTimers = stopAllWarDashboardTimers;

    function updateCountdownDisplay() {
        const els = Array.from(document.querySelectorAll('[data-war-dashboard-refresh-countdown]'));
        const fallback = document.getElementById('war-dashboard-refresh-countdown');
        if (!els.length && fallback) els.push(fallback);
        if (!els.length) return;
        let text = '';
        if (nextRefreshAt == null) {
            text = 'Next refresh in —s';
        } else {
            const secLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
            text = secLeft > 0 ? `Next refresh in ${secLeft}s` : 'Refreshing…';
        }
        els.forEach(el => { el.textContent = text; });
    }

    function scheduleNextRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = null;
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        const sec = getRefreshIntervalSec();
        nextRefreshAt = Date.now() + sec * 1000;
        refreshTimer = setTimeout(async () => {
            refreshTimer = null;
            await refreshStatusOnly();
            await syncActivityTrackerWithCurrentWar().then(() => updateActivityTrackerUI()).catch(() => {});
            scheduleNextRefresh();
        }, sec * 1000);
        if (!countdownTick) {
            countdownTick = setInterval(() => {
                if ((window.location.hash || '').replace('#', '').split('/')[0] !== 'war-dashboard') return;
                updateCountdownDisplay();
            }, 1000);
        }
        updateCountdownDisplay();
    }

    /** Start the chain timeout/cooldown tick (independent of Auto-refresh). Runs every second while on war-dashboard. */
    function startChainTick() {
        if (chainTickIntervalId) return;
        chainTickIntervalId = setInterval(() => {
            if ((window.location.hash || '').replace('#', '').split('/')[0] !== 'war-dashboard') return;
            updateChainDisplays();
            renderChainBoxes();
            updateLocationStatusTimers();
        }, 1000);
        renderChainBoxes();
    }

    function stopChainTick() {
        if (chainTickIntervalId) {
            clearInterval(chainTickIntervalId);
            chainTickIntervalId = null;
        }
    }

    function getAutoRefreshEnabled() {
        const stored = localStorage.getItem(STORAGE_KEYS.autoRefreshEnabled);
        return stored !== '0';
    }

    function setAutoRefreshEnabled(enabled) {
        try {
            localStorage.setItem(STORAGE_KEYS.autoRefreshEnabled, enabled ? '1' : '0');
        } catch (e) { /* ignore */ }
    }

    function startRefreshTimer() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = null;
        nextRefreshAt = null;
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        if (!getAutoRefreshEnabled()) return;
        scheduleNextRefresh();
    }

    function stopRefreshTimer() {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
        if (countdownTick) {
            clearInterval(countdownTick);
            countdownTick = null;
        }
        stopChainTick();
        stopChainRefreshTimer();
        nextRefreshAt = null;
        updateCountdownDisplay();
    }

    function setFFNoticeVisible(visible) {
        const el = document.getElementById('war-dashboard-ff-notice');
        if (el) el.style.display = visible ? 'flex' : 'none';
        localStorage.setItem(STORAGE_KEYS.ffNoticeHidden, visible ? '0' : '1');
    }

    function setEnemyPickerMinimised(minimised) {
        const body = document.getElementById('war-dashboard-enemy-picker-body');
        const arrow = document.getElementById('war-dashboard-enemy-picker-arrow');
        if (body) body.style.display = minimised ? 'none' : 'block';
        if (arrow) arrow.textContent = minimised ? '▶' : '▼';
        localStorage.setItem(STORAGE_KEYS.enemyPickerMinimised, minimised ? '1' : '0');
    }

    /** Clear enemy tracking only (does not affect Activity Tracker). */
    function clearEnemyTracking() {
        enemyFactionStates = [];
        syncPrimaryEnemyFromStates();
        try {
            localStorage.removeItem(STORAGE_KEYS.enemyFactionIds);
            localStorage.removeItem(STORAGE_KEYS.enemyFactionId);
        } catch (e) { /* ignore */ }
        const idInput = document.getElementById('war-dashboard-enemy-faction-id');
        if (idInput) idInput.value = '';
        updateWarDashboardEnemyLabels();
        renderEnemyPanels();
        renderChainBoxes();
        document.getElementById('war-dashboard-enemy-section').style.display = 'none';
        showError('Enter an enemy faction ID or click "Add current ranked war" to compare.');
    }

    function setRefreshSectionMinimised(minimised) {
        const body = document.getElementById('war-dashboard-refresh-picker-body');
        const arrow = document.getElementById('war-dashboard-refresh-picker-arrow');
        if (body) body.style.display = minimised ? 'none' : 'block';
        if (arrow) arrow.textContent = minimised ? '▶' : '▼';
        localStorage.setItem(STORAGE_KEYS.refreshSectionMinimised, minimised ? '1' : '0');
    }

    function setFFSectionMinimised(minimised) {
        const body = document.getElementById('war-dashboard-ff-picker-body');
        const arrow = document.getElementById('war-dashboard-ff-picker-arrow');
        if (body) body.style.display = minimised ? 'none' : 'block';
        if (arrow) arrow.textContent = minimised ? '▶' : '▼';
        localStorage.setItem(STORAGE_KEYS.ffSectionMinimised, minimised ? '1' : '0');
    }

    function openWarDashboardSettingsModal() {
        const overlay = document.getElementById('war-dashboard-settings-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.setAttribute('aria-hidden', 'false');
        }
    }

    function closeWarDashboardSettingsModal() {
        const overlay = document.getElementById('war-dashboard-settings-overlay');
        if (overlay) {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
        }
    }

    function openWarDashboardCommandModal(modalId) {
        const overlay = document.getElementById(modalId);
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.setAttribute('aria-hidden', 'false');
        }
    }

    function closeWarDashboardCommandModal(modalId) {
        const overlay = document.getElementById(modalId);
        if (overlay) {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
        }
    }

    function openWarDashboardEnemyModal() {
        openWarDashboardCommandModal('war-dashboard-enemy-modal');
        const input = document.getElementById('war-dashboard-enemy-faction-id');
        if (input) input.focus();
    }

    function closeWarDashboardEnemyModal() {
        closeWarDashboardCommandModal('war-dashboard-enemy-modal');
    }

    function openWarDashboardActivityTrackerModal() {
        if (!hasWarDashboardVip2Access()) {
            showWarDashboardVip2GateMessage('Activity Tracker');
            return;
        }
        openWarDashboardCommandModal('war-dashboard-activity-tracker-modal');
        updateActivityTrackerUI();
        const factionId = getActivityTrackerFactionIdFromInputs();
        if (factionId) runActivityTrackerImmediatePull(factionId);
    }

    function closeWarDashboardActivityTrackerModal() {
        closeWarDashboardCommandModal('war-dashboard-activity-tracker-modal');
    }

    function hasWarDashboardVip2Access() {
        return Number(window.currentVipLevel || 0) >= WAR_DASHBOARD_RIBBON_VIP_REQUIRED;
    }

    function showWarDashboardVip2GateMessage(featureName) {
        if (typeof window.openVipProgramInfoModal === 'function') {
            window.openVipProgramInfoModal();
        } else {
            alert((featureName || 'This feature') + ' requires VIP 2.');
        }
    }

    function setWarDashboardVip2CommandState(button, unlocked) {
        if (!button) return;
        button.classList.toggle('war-dashboard-command-btn--vip-locked', !unlocked);
        button.setAttribute('aria-disabled', unlocked ? 'false' : 'true');
        if (unlocked) {
            button.removeAttribute('title');
        } else {
            button.setAttribute('title', 'Requires VIP 2. Open How VIP works for details.');
        }
    }

    function applyWarDashboardVip2RibbonGating() {
        const unlocked = hasWarDashboardVip2Access();
        setWarDashboardVip2CommandState(document.getElementById('war-dashboard-activity-tracker-command'), unlocked);
        setWarDashboardVip2CommandState(document.getElementById('war-dashboard-chain-watch-command'), unlocked);

        const activitySummary = document.getElementById('war-dashboard-activity-tracker-summary');
        if (activitySummary) activitySummary.textContent = unlocked ? 'Manage tracked factions' : 'VIP 2 required';

        if (!unlocked) {
            const chainSummary = document.getElementById('war-dashboard-chain-watch-summary');
            if (chainSummary) chainSummary.textContent = 'VIP 2 required';
        } else {
            updateChainWatchBarVisibility();
        }
    }

    function openWarDashboardChainWatchCommandModal() {
        if (!hasWarDashboardVip2Access()) {
            showWarDashboardVip2GateMessage('Chain Watch');
            return;
        }
        updateChainWatchBarVisibility();
        openWarDashboardCommandModal('war-dashboard-chain-watch-command-modal');
    }

    function closeWarDashboardChainWatchCommandModal() {
        closeWarDashboardCommandModal('war-dashboard-chain-watch-command-modal');
    }

    function wireWarDashboardCommandModal(modalId, closeId, closeFn) {
        const modal = document.getElementById(modalId);
        if (!modal || modal._warDashboardCommandModalWired) return;
        modal._warDashboardCommandModalWired = true;
        document.getElementById(closeId)?.addEventListener('click', closeFn);
        modal.addEventListener('click', function (e) {
            if (e.target.id === modalId) closeFn();
        });
    }

    function wireWarDashboardCommandRibbon() {
        const container = document.getElementById('war-dashboard-tool-container');
        if (!container || container._warDashboardCommandRibbonWired) return;
        container._warDashboardCommandRibbonWired = true;
        container.addEventListener('click', function (e) {
            const button = e.target && e.target.closest
                ? e.target.closest('#war-dashboard-enemy-command, #war-dashboard-activity-tracker-command, #war-dashboard-chain-watch-command')
                : null;
            if (!button || !container.contains(button)) return;
            e.preventDefault();
            if (button.matches('[data-war-dashboard-vip2-command]') && !hasWarDashboardVip2Access()) {
                showWarDashboardVip2GateMessage(button.id === 'war-dashboard-chain-watch-command' ? 'Chain Watch' : 'Activity Tracker');
                return;
            }
            if (button.id === 'war-dashboard-enemy-command') openWarDashboardEnemyModal();
            else if (button.id === 'war-dashboard-activity-tracker-command') openWarDashboardActivityTrackerModal();
            else if (button.id === 'war-dashboard-chain-watch-command') openWarDashboardChainWatchCommandModal();
        });
    }

    /** Run one 5-min tick: for each enabled tracked faction (with lastVisit within 2 days), fetch members and append sample. */
    async function runActivityTrackerTick() {
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        const apiKey = getApiKey();
        if (!apiKey) return;
        const config = getActivityConfig();
        const enabledTracked = config.tracked.filter(function (t) {
            return t && t.enabled && !isActivityFactionLocallyDisabled(t.factionId);
        });
        if (!enabledTracked.length) {
            nextActivitySampleAt = 0;
            updateActivityCountdown();
            return;
        }
        nextActivitySampleAt = Date.now() + ACTIVITY_INTERVAL_MS;
        const lastVisit = getActivityLastVisit();
        if (lastVisit === 0 || (Date.now() - lastVisit) > TWO_DAYS_MS) return;
        for (const t of enabledTracked) {
            try {
                const members = await fetchFactionMembers(apiKey, t.factionId);
                const onlineIds = members
                    .filter(m => {
                        const st = statusFromMember(m);
                        const a = (st.actionStatus || '').toLowerCase();
                        return a === 'online';
                    })
                    .map(m => String(m.id));
                appendActivitySample(t.factionId, onlineIds, members);
            } catch (e) {
                console.warn('Activity tracker tick for faction', t.factionId, e);
            }
        }
        updateActivityTrackerUI();
    }

    function formatCountdown(ms) {
        if (ms <= 0) return '0:00';
        const totalSec = Math.ceil(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m + ':' + String(s).padStart(2, '0');
    }

    function updateActivityCountdown() {
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        const remaining = nextActivitySampleAt > 0 ? nextActivitySampleAt - Date.now() : 0;
        const activeText = remaining <= 0 ? 'Next sample soon…' : 'Next sample in ' + formatCountdown(remaining);
        document.querySelectorAll('.war-dashboard-activity-next-sample').forEach(function (el) {
            const block = el.closest('.war-dashboard-activity-faction-block');
            const fid = block ? block.getAttribute('data-faction-id') : '';
            el.textContent = fid && !isActivityFactionEnabled(fid) ? 'Paused' : activeText;
        });
    }

    /** Aggregate samples by hour (TCT = UTC). Returns { labels: ['00:00', ...], values: [...], countByHour: [...] }. */
    function aggregateActivityByHour(factionId) {
        const data = getActivityData(factionId);
        const byHour = Array(24).fill(0);
        const countByHour = Array(24).fill(0);
        for (const s of data.samples) {
            const d = new Date(s.t);
            const h = d.getUTCHours();
            byHour[h] += (s.onlineIds && s.onlineIds.length) ? s.onlineIds.length : 0;
            countByHour[h]++;
        }
        const labels = [];
        const values = [];
        for (let i = 0; i < 24; i++) {
            labels.push(String(i).padStart(2, '0') + ':00');
            values.push(countByHour[i] > 0 ? Math.round((byHour[i] / countByHour[i]) * 10) / 10 : 0);
        }
        return { labels, values, countByHour };
    }

    /** Per-hour (UTC) list of player IDs seen in that hour. Returns array of 24 arrays. */
    function getPlayerIdsByHour(factionId) {
        const data = getActivityData(factionId);
        const byHour = Array(24).fill(null).map(() => []);
        const seen = Array(24).fill(null).map(() => ({}));
        for (const s of data.samples) {
            if (!s.onlineIds) continue;
            const d = new Date(s.t);
            const h = d.getUTCHours();
            for (const id of s.onlineIds) {
                if (!seen[h][id]) {
                    seen[h][id] = true;
                    byHour[h].push(id);
                }
            }
        }
        return byHour;
    }

    /** Per-hour (UTC) per-player sample count in that hour. Returns array of 24 objects { playerId: count }. */
    function getPlayerSampleCountsByHour(factionId) {
        const data = getActivityData(factionId);
        const byHour = Array(24).fill(null).map(() => ({}));
        for (const s of data.samples) {
            if (!s.onlineIds) continue;
            const d = new Date(s.t);
            const h = d.getUTCHours();
            for (const id of s.onlineIds) {
                byHour[h][id] = (byHour[h][id] || 0) + 1;
            }
        }
        return byHour;
    }

    function renderActivityTrackerChart(factionId) {
        const canvas = document.getElementById('war-dashboard-activity-chart-' + factionId);
        if (!canvas || typeof Chart === 'undefined') return;
        const { labels, values, countByHour } = aggregateActivityByHour(factionId);
        if (activityTrackerChartInstances[factionId]) {
            activityTrackerChartInstances[factionId].destroy();
            delete activityTrackerChartInstances[factionId];
        }
        activityTrackerChartInstances[factionId] = new Chart(canvas, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Avg. online / sample (idle excluded)',
                    data: values,
                    backgroundColor: 'rgba(255, 215, 0, 0.6)',
                    borderColor: 'rgba(255, 215, 0, 1)',
                    borderWidth: 1,
                    hoverBackgroundColor: 'rgba(255, 215, 0, 0.85)',
                    hoverBorderColor: 'rgba(255, 255, 200, 1)',
                    hoverBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true }
                },
                plugins: {
                    notTrackedLabel: { countByHour: countByHour }
                },
                onHover(evt, elements, chart) {
                    if (chart.canvas) chart.canvas.style.cursor = elements.length ? 'pointer' : 'default';
                },
                onClick: (evt, elements, chart) => {
                    if (elements.length) {
                        const hourIndex = elements[0].index;
                        openActivityHourModal(factionId, hourIndex);
                    }
                }
            },
            plugins: [{
                id: 'notTrackedLabel',
                afterDatasetsDraw(chart) {
                    const opts = chart.options.plugins?.notTrackedLabel;
                    const countByHour = opts?.countByHour;
                    if (!countByHour || countByHour.length === 0) return;
                    const ctx = chart.ctx;
                    const yScale = chart.scales.y;
                    if (!yScale) return;
                    const meta = chart.getDatasetMeta(0);
                    if (!meta || !meta.data.length) return;
                    const centerY = (yScale.top + yScale.bottom) / 2;
                    ctx.save();
                    ctx.font = '10px sans-serif';
                    ctx.fillStyle = 'rgba(140, 140, 140, 0.9)';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    meta.data.forEach((bar, index) => {
                        if (countByHour[index] === 0) {
                            ctx.save();
                            ctx.translate(bar.x, centerY);
                            ctx.rotate(-Math.PI / 2);
                            ctx.fillText('Not tracked', 0, 0);
                            ctx.restore();
                        }
                    });
                    ctx.restore();
                }
            }]
        });
    }

    function openActivityHourModal(factionId, hourIndex) {
        const overlay = document.getElementById('war-dashboard-activity-hour-modal');
        const titleEl = document.getElementById('war-dashboard-activity-hour-modal-title');
        const tbody = document.getElementById('war-dashboard-activity-hour-modal-tbody');
        if (!overlay || !titleEl || !tbody) return;
        const hourLabel = String(hourIndex).padStart(2, '0') + ':00';
        titleEl.textContent = 'Players active during ' + hourLabel + ' (TCT)';
        const ids = getPlayerIdsByHour(factionId)[hourIndex] || [];
        const countsInHour = getPlayerSampleCountsByHour(factionId)[hourIndex] || {};
        const activityData = getActivityData(factionId);
        const membersMap = {};
        (activityData.members || []).forEach(m => { membersMap[String(m.id)] = m; });
        const cached = getFFCache(factionId);
        const enemyState = enemyFactionStates.find(enemy => String(enemy.id) === String(factionId));
        const bsMap = cached ? (cached.bs || {}) : (enemyState ? enemyState.bs || {} : {});
        const rows = ids.map(id => {
            const m = membersMap[id];
            const name = m ? (m.name || id) : id;
            const bs = bsMap[id];
            const statsNum = bs != null ? Number(bs) : -1;
            const statsDisplay = bs != null ? Number(bs).toLocaleString() : '—';
            const sampleCount = countsInHour[id] || 0;
            const minutesActive = Math.min(60, sampleCount * 5);
            return { id, name, statsNum, statsDisplay, minutesActive };
        });
        const sortBy = 'stats';
        const sortDir = 'desc';
        overlay._activityHourRows = rows;
        overlay._activityHourSort = { by: sortBy, dir: sortDir };
        sortActivityHourModalRows(overlay._activityHourRows, sortBy, sortDir);
        renderActivityHourModalBody(tbody, overlay._activityHourRows);
        updateActivityHourModalSortHeaders(overlay);
        if (rows.length === 0) tbody.innerHTML = '<tr><td colspan="3" style="color: #888;">No players recorded in this hour.</td></tr>';
        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');
    }

    function sortActivityHourModalRows(rows, by, dir) {
        const mult = dir === 'asc' ? 1 : -1;
        rows.sort((a, b) => {
            let va, vb;
            if (by === 'player') {
                va = (a.name || a.id).toLowerCase();
                vb = (b.name || b.id).toLowerCase();
                return mult * (va < vb ? -1 : va > vb ? 1 : 0);
            }
            if (by === 'stats') {
                va = a.statsNum;
                vb = b.statsNum;
                return mult * (va - vb);
            }
            if (by === 'active') {
                va = a.minutesActive;
                vb = b.minutesActive;
                return mult * (va - vb);
            }
            return 0;
        });
    }

    function renderActivityHourModalBody(tbody, rows) {
        tbody.innerHTML = rows.map(function (row) {
            const lab = window.toolsFormatMemberDisplayLabel({ name: row.name, id: row.id }, window.toolsGetShowMemberIdInBrackets());
            return '<tr><td><a href="https://www.torn.com/profiles.php?XID=' + escapeHtml(row.id) + '" target="_blank" rel="noopener" style="color: #FFD700;"' + window.toolsMemberLinkAttrs(row.name, row.id) + '>' + escapeHtml(lab) + '</a></td><td>' + escapeHtml(String(row.statsDisplay)) + '</td><td>' + row.minutesActive + ' min</td></tr>';
        }).join('');
    }

    function updateActivityHourModalSortHeaders(overlay) {
        const sort = overlay._activityHourSort;
        if (!sort) return;
        overlay.querySelectorAll('.war-dashboard-activity-hour-sortable').forEach(th => {
            const col = th.getAttribute('data-column');
            const isActive = col === sort.by;
            const arrow = isActive ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
            const label = th.textContent.replace(/\s*[▲▼]\s*$/, '').trim();
            th.textContent = label + arrow;
            th.setAttribute('aria-sort', isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        });
    }

    function handleActivityHourModalSort(overlay, column) {
        const rows = overlay._activityHourRows;
        const sort = overlay._activityHourSort;
        if (!rows || !sort) return;
        const tbody = document.getElementById('war-dashboard-activity-hour-modal-tbody');
        if (!tbody) return;
        let by = sort.by;
        let dir = sort.dir;
        if (column === by) dir = dir === 'asc' ? 'desc' : 'asc';
        else {
            by = column;
            dir = (column === 'player' ? 'asc' : 'desc');
        }
        overlay._activityHourSort = { by, dir };
        sortActivityHourModalRows(rows, by, dir);
        renderActivityHourModalBody(tbody, rows);
        updateActivityHourModalSortHeaders(overlay);
    }

    function closeActivityHourModal() {
        const overlay = document.getElementById('war-dashboard-activity-hour-modal');
        if (overlay) {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
        }
    }

    /** One TCT hour slot label: "14:00–15:00" (matches chart / hour modal). Hour h = [h:00, h+1:00). */
    function formatActivityHourSlotRangeTct(hourIndex) {
        const h = Math.max(0, Math.min(23, Math.floor(Number(hourIndex))));
        const next = (h + 1) % 24;
        const z = function (x) {
            return String(x).padStart(2, '0') + ':00';
        };
        return z(h) + '–' + z(next);
    }

    /**
     * Top N TCT hour slots (0–23) by 5-min sample count for one player.
     * @param {Array<Object>} byHourArrays from getPlayerSampleCountsByHour(factionId)
     */
    function getPlayerTopActiveHoursFromByHour(byHourArrays, playerId, limit) {
        const pid = String(playerId);
        const max = Math.max(1, Math.min(24, Number(limit) || 3));
        const scored = [];
        for (let h = 0; h < 24; h++) {
            const c = (byHourArrays[h] && byHourArrays[h][pid]) || 0;
            if (c > 0) scored.push({ hour: h, count: c });
        }
        scored.sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return a.hour - b.hour;
        });
        return scored.slice(0, max);
    }

    function formatPlayerPeakHoursFromByHour(byHourArrays, playerId) {
        const top = getPlayerTopActiveHoursFromByHour(byHourArrays, playerId, 3);
        if (!top.length) return '—';
        return top
            .map(function (x) {
                return formatActivityHourSlotRangeTct(x.hour) + ' (' + x.count + '×)';
            })
            .join('; ');
    }

    /** Format decimal hours as H:MM (e.g. 1.5 -> "1:30"). Returns "—" for invalid. */
    function formatHoursMinutes(decimalHours) {
        if (decimalHours == null || typeof decimalHours !== 'number' || isNaN(decimalHours) || decimalHours < 0) return '—';
        const h = Math.floor(decimalHours);
        let m = Math.round((decimalHours - h) * 60);
        if (m >= 60) { m = 0; h += 1; }
        return h + ':' + String(m).padStart(2, '0');
    }

    /** Format total minutes as H:MM (e.g. 25 -> "0:25", 65 -> "1:05"). */
    function formatMinutesToHMM(totalMinutes) {
        const m = Math.round(Number(totalMinutes)) || 0;
        const h = Math.floor(m / 60);
        const mins = m % 60;
        return h + ':' + String(mins).padStart(2, '0');
    }

    function formatTrackingStarted(ms) {
        const d = new Date(ms);
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    /** Per-player count of 5-min samples they were seen in. */
    function getPlayerSampleCounts(factionId) {
        const data = getActivityData(factionId);
        const counts = {};
        for (const s of data.samples) {
            if (!s.onlineIds) continue;
            for (const id of s.onlineIds) {
                counts[id] = (counts[id] || 0) + 1;
            }
        }
        return counts;
    }

    /** Hours tracked = total sampling time (number of 5-min samples × 5/60). Ensures no player can show more active hours than tracked. */
    function getHoursTracked(factionId) {
        const data = getActivityData(factionId);
        const samples = data.samples || [];
        if (samples.length === 0) return 0;
        return Math.round((samples.length * (5 / 60)) * 10) / 10;
    }

    function getActivityTrackerSort(factionId) {
        const def = { by: 'stats', dir: 'desc' };
        return activityTrackerTableSort[factionId] || def;
    }

    function setActivityTrackerSort(factionId, by, dir) {
        activityTrackerTableSort[factionId] = { by, dir };
    }

    function sortActivityTrackerMembers(members, factionId, by, dir, bsMap, sampleCounts, peakBestByPlayer) {
        const mult = dir === 'asc' ? 1 : -1;
        return [...members].sort((a, b) => {
            const idA = String(a.id);
            const idB = String(b.id);
            let cmp = 0;
            if (by === 'member') {
                const va = (a.name || idA).toLowerCase();
                const vb = (b.name || idB).toLowerCase();
                cmp = va < vb ? -1 : va > vb ? 1 : 0;
            } else if (by === 'level') {
                cmp = (a.level || 0) - (b.level || 0);
            } else if (by === 'stats') {
                cmp = (bsMap[idA] ?? -1) - (bsMap[idB] ?? -1);
            } else if (by === 'hoursActive') {
                cmp = (sampleCounts[idA] || 0) - (sampleCounts[idB] || 0);
            } else if (by === 'activeBetween') {
                cmp = (peakBestByPlayer[idA] || 0) - (peakBestByPlayer[idB] || 0);
            }
            return mult * cmp;
        });
    }

    function updateActivityTrackerTableSortHeaders(table, factionId) {
        const sort = getActivityTrackerSort(factionId);
        table.querySelectorAll('.war-dashboard-activity-tracker-sortable').forEach(th => {
            const col = th.getAttribute('data-column');
            const isActive = col === sort.by;
            const arrowEl = th.querySelector('.war-dashboard-activity-tracker-sort-arrow');
            if (arrowEl) arrowEl.textContent = isActive ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
            th.setAttribute('aria-sort', isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        });
    }

    function renderActivityTrackerTable(factionId) {
        const table = document.getElementById('war-dashboard-activity-tracker-table-' + factionId);
        const tbody = table?.querySelector('tbody');
        if (!tbody) return;
        const data = getActivityData(factionId);
        const cached = getFFCache(factionId);
        const enemyState = enemyFactionStates.find(enemy => String(enemy.id) === String(factionId));
        const ffMap = cached ? (cached.ff || {}) : (enemyState ? enemyState.ff || {} : {});
        const bsMap = cached ? (cached.bs || {}) : (enemyState ? enemyState.bs || {} : {});
        const sampleCounts = getPlayerSampleCounts(factionId);
        const hoursTracked = getHoursTracked(factionId);
        const members = data.members && data.members.length ? data.members : [];
        const sort = getActivityTrackerSort(factionId);
        const byHourCounts = getPlayerSampleCountsByHour(factionId);
        const peakBestByPlayer = {};
        members.forEach(function (m) {
            const tid = String(m.id);
            const top1 = getPlayerTopActiveHoursFromByHour(byHourCounts, tid, 1);
            peakBestByPlayer[tid] = top1.length ? top1[0].count : 0;
        });
        const sorted = sortActivityTrackerMembers(members, factionId, sort.by, sort.dir, bsMap, sampleCounts, peakBestByPlayer);
        const sampleHours = 5 / 60;
        tbody.innerHTML = sorted.map(m => {
            const id = String(m.id);
            const bs = bsMap[id];
            const bsText = bs != null ? Number(bs).toLocaleString() : '—';
            const activeBetween = formatPlayerPeakHoursFromByHour(byHourCounts, id);
            const count = sampleCounts[id] || 0;
            const hoursActive = count > 0 ? formatHoursMinutes(count * sampleHours) : '—';
            const memLabelAct = window.toolsFormatMemberDisplayLabel({ name: m.name || id, id }, window.toolsGetShowMemberIdInBrackets());
            return `<tr>
                <td><a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener" style="color: #FFD700;"${window.toolsMemberLinkAttrs(m.name || id, id)}>${escapeHtml(memLabelAct)}</a></td>
                <td>${escapeHtml(m.level != null ? String(m.level) : '—')}</td>
                <td>${bsText}</td>
                <td>${hoursActive}</td>
                <td>${escapeHtml(activeBetween)}</td>
            </tr>`;
        }).join('');
        const hoursTrackedEl = table?.querySelector('.war-dashboard-activity-hours-tracked[data-faction-id="' + factionId + '"]');
        if (hoursTrackedEl) hoursTrackedEl.textContent = formatHoursMinutes(hoursTracked);
        updateActivityTrackerTableSortHeaders(table, factionId);
    }

    function handleActivityTrackerTableSort(factionId, column) {
        const sort = getActivityTrackerSort(factionId);
        let by = sort.by;
        let dir = sort.dir;
        if (column === by) dir = dir === 'asc' ? 'desc' : 'asc';
        else {
            by = column;
            dir = (column === 'member' ? 'asc' : 'desc');
        }
        setActivityTrackerSort(factionId, by, dir);
        renderActivityTrackerTable(factionId);
    }

    function updateActivityTrackerUI() {
        hydrateActivityDataCacheFromLocalStorage();

        Object.keys(activityTrackerChartInstances).forEach(fid => {
            try { activityTrackerChartInstances[fid].destroy(); } catch (e) { /* ignore */ }
        });
        activityTrackerChartInstances = {};

        const config = getActivityConfig();
        const container = document.getElementById('war-dashboard-activity-tracker-factions');
        const empty = document.getElementById('war-dashboard-activity-tracker-empty');
        const loadBtn = document.getElementById('war-dashboard-activity-tracker-load');
        if (loadBtn) loadBtn.textContent = config.tracked.length > 0 ? 'Track this faction too' : 'Load';
        if (!container) return;
        const expandedFactionIds = [];
        container.querySelectorAll('.war-dashboard-activity-faction-block').forEach(block => {
            const body = block.querySelector('.war-dashboard-activity-faction-body');
            const fid = block.getAttribute('data-faction-id');
            if (fid && body && body.style.display === 'block') expandedFactionIds.push(fid);
        });
        container.innerHTML = '';
        config.tracked.forEach(t => {
            const fid = t.factionId;
            const wasExpanded = expandedFactionIds.indexOf(fid) !== -1;
            const name = escapeHtml(t.factionName || 'Faction ' + fid);
            const block = document.createElement('div');
            block.className = 'war-dashboard-activity-faction-block';
            block.setAttribute('data-faction-id', fid);
            block.innerHTML = `
                <div class="war-dashboard-activity-faction-header-row" style="display: flex; align-items: center; gap: 10px; padding: 8px 0; width: 100%; min-height: 40px;">
                    <button type="button" class="war-dashboard-activity-faction-header" data-faction-id="${escapeHtml(fid)}" aria-expanded="${wasExpanded ? 'true' : 'false'}" style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 0; background: none; border: none; color: var(--accent-color); font-size: 1rem; font-weight: bold; cursor: pointer; text-align: left;">
                        <span class="war-dashboard-activity-faction-arrow" aria-hidden="true" style="flex-shrink: 0;">${wasExpanded ? '▼' : '▶'}</span>
                        <span class="war-dashboard-activity-faction-name" style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${name} (${escapeHtml(fid)})${t.startedAt ? ` <span style="color: #888; font-weight: normal; font-size: 0.9em;">(started ${escapeHtml(formatTrackingStarted(t.startedAt))})</span>` : ''}</span>
                    </button>
                    <div class="war-dashboard-activity-faction-controls" style="display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;">
                        <label class="war-dashboard-activity-track-wrap war-dashboard-activity-faction-toggle-wrap" onclick="event.stopPropagation()" title="Cache will clear if tracker is off for 72 hours" style="margin: 0;">
                            <input type="checkbox" class="war-dashboard-activity-faction-enabled war-dashboard-chain-track-input" data-faction-id="${escapeHtml(fid)}" ${t.enabled ? 'checked' : ''} aria-label="Tracking on or off">
                            <span class="war-dashboard-chain-track-slider"></span>
                        </label>
                        <button type="button" class="war-dashboard-activity-faction-remove" data-faction-id="${escapeHtml(fid)}" title="Remove faction from tracker" aria-label="Remove faction from tracker" onclick="event.stopPropagation()" style="flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; background: transparent; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: #aaa; cursor: pointer;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                    </div>
                </div>
                <div class="war-dashboard-activity-faction-body" style="display: ${wasExpanded ? 'block' : 'none'}; margin-left: 12px; margin-bottom: 16px;">
                    <div style="margin-bottom: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px;">
                        <span class="war-dashboard-activity-next-sample" style="color: #888; font-size: 13px;">Next sample in —</span>
                        <button type="button" class="war-dashboard-activity-faction-clear btn" data-faction-id="${escapeHtml(fid)}" style="padding: 4px 10px; font-size: 12px;">Clear cache</button>
                    </div>
                    <p class="war-dashboard-activity-cloud-status" data-faction-id="${escapeHtml(fid)}" style="font-size: 12px; margin: 0 0 10px 0; line-height: 1.4; color: #9e9e9e;">Loading cloud status…</p>
                    <div style="margin-bottom: 16px;">
                        <h3 style="color: var(--accent-color); font-size: 14px; margin: 0 0 8px 0;">Activity by hour (Torn City Time)</h3>
                        <div class="war-dashboard-activity-chart-wrap" style="height: 200px;">
                            <canvas id="war-dashboard-activity-chart-${escapeHtml(fid)}"></canvas>
                        </div>
                    </div>
                    <div>
                        <h3 style="color: var(--accent-color); font-size: 14px; margin: 0 0 8px 0;">Players and active times (TCT)</h3>
                        <div class="table-scroll-wrapper" style="overflow-x: auto;">
                            <table id="war-dashboard-activity-tracker-table-${escapeHtml(fid)}" class="war-dashboard-table war-dashboard-activity-tracker-sortable-table">
                                <thead><tr><th class="war-dashboard-activity-tracker-sortable" data-column="member" scope="col">${warDashboardMemberHeaderHtml('<span>Member<span class="war-dashboard-activity-tracker-sort-arrow"></span></span>', { align: 'flex-start' })}</th><th class="war-dashboard-activity-tracker-sortable" data-column="level" scope="col">Level<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="stats" scope="col">Est. stats<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="hoursActive" scope="col">Hours active (<span class="war-dashboard-activity-hours-tracked" data-faction-id="${escapeHtml(fid)}">—</span> tracked)<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="activeBetween" scope="col">Peak hours (TCT, top 3)<span class="war-dashboard-activity-tracker-sort-arrow"></span></th></tr></thead>
                                <tbody></tbody>
                            </table>
                        </div>
                    </div>
                </div>
            `;
            container.appendChild(block);

            const headerBtn = block.querySelector('.war-dashboard-activity-faction-header');
            const bodyEl = block.querySelector('.war-dashboard-activity-faction-body');
            const arrow = block.querySelector('.war-dashboard-activity-faction-arrow');
            headerBtn.addEventListener('click', async (e) => {
                if (e.target.closest('.war-dashboard-activity-faction-controls')) return;
                const expanded = bodyEl.style.display === 'block';
                bodyEl.style.display = expanded ? 'none' : 'block';
                headerBtn.setAttribute('aria-expanded', !expanded);
                arrow.textContent = expanded ? '▶' : '▼';
                if (!expanded) {
                    hydrateActivityDataCacheFromLocalStorage([fid]);
                    renderActivityTrackerChart(fid);
                    renderActivityTrackerTable(fid);
                    updateActivityCloudStatusUI(fid);
                    if (isActivityFactionEnabled(fid)) {
                        refreshAllTrackedActivityFromCloud({ factionIds: [fid] }).then(function () {
                            updateActivityCloudStatusUI(fid);
                            renderActivityTrackerChart(fid);
                            renderActivityTrackerTable(fid);
                        }).catch(function () {});
                    }
                    await ensureActivityTrackerBattleStats(fid);
                }
            });

            const enabledCb = block.querySelector('.war-dashboard-activity-faction-enabled');
            enabledCb.addEventListener('change', () => {
                t.enabled = enabledCb.checked;
                if (!t.enabled) {
                    t.disabledAt = Date.now();
                    setActivityFactionLocallyDisabled(fid, true);
                } else {
                    t.disabledAt = null;
                    setActivityFactionLocallyDisabled(fid, false);
                }
                setActivityConfig(config);
                if (t.enabled) {
                    runActivityTrackerImmediatePull(fid);
                } else {
                    syncTrackedFactionToFirestore(fid, 'remove').then(function () {
                        updateActivityCloudStatusUI(fid);
                    });
                }
            });

            const clearBtn = block.querySelector('.war-dashboard-activity-faction-clear');
            clearBtn.addEventListener('click', () => {
                const factionLabel = t.factionName || 'Faction ' + fid;
                if (
                    !confirm(
                        'Clear all activity data for ' +
                            factionLabel +
                            ' in this browser? Local samples and merged cloud history from before now will be hidden; new samples will fill the graph again. (Shared server logs are not deleted; other users are unaffected.)'
                    )
                ) {
                    return;
                }
                const cut = Date.now();
                setActivityCloudIgnoreBeforeMs(fid, cut);
                try {
                    localStorage.removeItem(ACTIVITY_DATA_PREFIX + fid);
                } catch (e) { /* ignore */ }
                delete activityDataCache[fid];
                delete activityDataCloudMeta[fid];
                setActivityConfig(config);
                updateActivityTrackerUI();
            });

            const removeBtn = block.querySelector('.war-dashboard-activity-faction-remove');
            removeBtn.addEventListener('click', () => {
                const factionLabel = t.factionName || 'Faction ' + fid;
                if (!confirm('Remove ' + factionLabel + ' from the activity tracker? Its cached data will be cleared. You can add it again later by loading the faction.')) return;
                config.tracked = config.tracked.filter(x => String(x.factionId) !== String(fid));
                setActivityFactionLocallyDisabled(fid, true);
                try { localStorage.removeItem(ACTIVITY_DATA_PREFIX + fid); } catch (e) { /* ignore */ }
                clearActivityCloudIgnoreBeforeMs(fid);
                delete activityDataCache[fid];
                delete activityDataCloudMeta[fid];
                setActivityConfig(config);
                syncTrackedFactionToFirestore(fid, 'remove');
                updateActivityTrackerUI();
            });

            const sortableTable = block.querySelector('.war-dashboard-activity-tracker-sortable-table');
            sortableTable?.addEventListener('click', (e) => {
                const th = e.target.closest('.war-dashboard-activity-tracker-sortable');
                if (!th) return;
                const column = th.getAttribute('data-column');
                if (column) handleActivityTrackerTableSort(fid, column);
            });
        });

        config.tracked.forEach(t => {
            renderActivityTrackerChart(t.factionId);
            renderActivityTrackerTable(t.factionId);
            updateActivityCloudStatusUI(t.factionId);
        });

        if (config.tracked.some(function (t) { return t.enabled; })) {
            refreshAllTrackedActivityFromCloud()
                .then(function () {
                    config.tracked.forEach(function (t) {
                        renderActivityTrackerChart(t.factionId);
                        renderActivityTrackerTable(t.factionId);
                        updateActivityCloudStatusUI(t.factionId);
                    });
                })
                .catch(function (e) { console.warn('Activity cloud merge batch', e); });
        }

        if (empty) empty.style.display = config.tracked.length ? 'none' : 'block';

        // If any tracked faction still shows "Faction {id}", fetch name in background (same as Faction Battle Stats)
        const apiKey = getApiKey();
        if (apiKey) {
            config.tracked.forEach(t => {
                const defaultName = 'Faction ' + t.factionId;
                if (!t.factionName || t.factionName === defaultName) {
                    fetchFactionName(apiKey, t.factionId).then(name => {
                        if (name && name !== defaultName) {
                            t.factionName = name;
                            setActivityConfig(config);
                            updateActivityTrackerUI();
                        }
                    });
                }
            });
        }
    }

    /** Get faction ID from the Faction ID input only. */
    function getActivityTrackerFactionIdFromInputs() {
        const input = document.getElementById('war-dashboard-activity-tracker-faction-id');
        return (input?.value || '').trim();
    }

    /** When user expands a tracked faction, ensure we have battle stats (fetch if missing). */
    async function ensureActivityTrackerBattleStats(factionId) {
        const apiKey = getApiKey();
        if (!apiKey) return;
        const data = getActivityData(factionId);
        const members = data.members || [];
        const memberIds = members.map(m => String(m.id));
        if (memberIds.length === 0) return;
        try {
            const ffData = await fetchFFForMembers(apiKey, memberIds);
            setFFCache(factionId, { ff: ffData.ff || {}, bs: ffData.bs || {} });
        } catch (e) {
            console.warn('Activity tracker: could not fetch battle stats for faction', factionId, e);
        }
    }

    /**
     * Previously auto-added / re-enabled the current ranked-war enemy on every login.
     * That caused unwanted Firestore registrations and overrode trash/disable.
     * Activity tracking is opt-in only (Load / toggle); this clears leftover auto-track markers.
     */
    async function syncActivityTrackerWithCurrentWar() {
        try {
            const oldAutoId = localStorage.getItem(STORAGE_KEYS.activityAutoWarEnemyFactionId);
            if (oldAutoId) {
                setActivityFactionLocallyDisabled(oldAutoId, true);
                syncTrackedFactionToFirestore(oldAutoId, 'remove').catch(function () {});
            }
            localStorage.removeItem(STORAGE_KEYS.activityAutoWarEnemyFactionId);
        } catch (e) { /* ignore */ }
    }

    /** Ensure faction is in tracked list; add with default name if missing. Updates factionName when provided. Returns config or null if at cap. */
    function ensureActivityTrackerFactionInConfig(factionId, factionName) {
        const config = getActivityConfig();
        const existing = config.tracked.find(t => t.factionId === factionId);
        if (existing) {
            if (factionName) {
                existing.factionName = factionName;
                setActivityConfig(config);
            }
            return config;
        }
        if (!canAddActivityTrackedFaction(factionId)) return null;
        config.tracked.push({
            factionId: factionId,
            factionName: factionName || 'Faction ' + factionId,
            enabled: false,
            disabledAt: Date.now(),
            startedAt: Date.now()
        });
        setActivityFactionLocallyDisabled(factionId, true);
        setActivityConfig(config);
        return config;
    }

    /** Immediate pull: fetch faction members, append one sample, fetch and cache battle stats, then show graph and table. */
    async function runActivityTrackerImmediatePull(factionId) {
        factionId = (factionId || getActivityTrackerFactionIdFromInputs()).trim();
        if (!factionId) return;
        const apiKey = getApiKey();
        if (!apiKey) {
            showError('Please enter your API key in the sidebar.');
            return;
        }
        if (!canAddActivityTrackedFaction(factionId)) {
            showError(activityTrackedLimitMessage());
            return;
        }
        showError('');
        try {
            const [members, factionName] = await Promise.all([
                fetchFactionMembers(apiKey, factionId),
                fetchFactionName(apiKey, factionId)
            ]);
            const onlineIds = members
                .filter(m => {
                    const st = statusFromMember(m);
                    const a = (st.actionStatus || '').toLowerCase();
                    return a === 'online';
                })
                .map(m => String(m.id));
            const ensuredConfig = ensureActivityTrackerFactionInConfig(factionId, factionName || undefined);
            if (!ensuredConfig) {
                showError(activityTrackedLimitMessage());
                return;
            }
            const trackerRow = ensuredConfig.tracked.find(t => String(t.factionId) === String(factionId));
            if (trackerRow && trackerRow.enabled) {
                appendActivitySample(factionId, onlineIds, members);
            } else {
                const existing = getActivityData(factionId);
                setActivityData(factionId, { samples: existing.samples || [], members: members });
            }
            // Auto-fetch and cache battle stats (same as war dashboard) so table can show Est. stats
            const memberIds = members.map(m => String(m.id));
            if (memberIds.length > 0) {
                try {
                    const data = await fetchFFForMembers(apiKey, memberIds);
                    setFFCache(factionId, { ff: data.ff || {}, bs: data.bs || {} });
                } catch (ffErr) {
                    console.warn('Activity tracker: could not fetch battle stats for faction', factionId, ffErr);
                }
            }
            const trackerEnabled = !!(trackerRow && trackerRow.enabled);
            const reg = trackerEnabled
                ? await syncTrackedFactionToFirestore(factionId, 'add')
                : { ok: true };
            updateActivityCloudStatusUI(factionId);
            if (trackerEnabled) {
                if (!reg.ok && reg.error) showError('Cloud activity (24/7): ' + reg.error + ' — this tab will still sample every 10 min while open.');
                await refreshAllTrackedActivityFromCloud({ full: true, factionIds: [String(factionId)] });
                updateActivityCloudStatusUI(factionId);
            }
            updateActivityTrackerUI();
        } catch (e) {
            showError(e.message || 'Failed to load faction.');
        }
    }

    function setActivityTrackerSectionExpanded(expanded) {
        if (expanded) {
            openWarDashboardActivityTrackerModal();
        } else {
            closeWarDashboardActivityTrackerModal();
        }
    }

    function warDashboardMemberHeaderHtml(html, options) {
        return typeof window.toolsMemberColumnHeaderWrap === 'function'
            ? window.toolsMemberColumnHeaderWrap(html, options || { align: 'flex-start' })
            : html;
    }

    function warDashboardInjectMemberColumnHeaders() {
        const headers = Array.from(document.querySelectorAll('#war-dashboard-our-table thead th[data-column="member"], .war-dashboard-enemy-table thead th[data-column="member"]'));
        headers.forEach(function (th) {
            if (!th || th.getAttribute('data-tools-member-header') === '1') return;
            th.setAttribute('data-tools-member-header', '1');
            const sortEl = th.querySelector('.war-dashboard-sort');
            const sortHtml = sortEl ? sortEl.outerHTML : '<span class="war-dashboard-sort"></span>';
            th.innerHTML = warDashboardMemberHeaderHtml('<span>Member ' + sortHtml + '</span>', { align: 'flex-start' });
        });
    }

    function initWarDashboard() {
        if (window.logToolUsage) window.logToolUsage('war-dashboard');

        if (typeof window._warDashboardStopTimers === 'function') {
            window._warDashboardStopTimers();
        }

        if (!window._warDashboardUiWired) {
            window._warDashboardUiWired = true;
            wireWarDashboardUiOnce();
        }

        loadSettings();
        Promise.all(getActivityConfig().tracked.filter(function (t) {
            return t && t.enabled && !isActivityFactionLocallyDisabled(t.factionId);
        }).map(function (t) {
            return syncTrackedFactionToFirestore(t.factionId, 'add');
        })).then(function () {
            updateAllActivityCloudStatusUI();
        });

        if (localStorage.getItem(STORAGE_KEYS.ffNoticeHidden) === '1') setFFNoticeVisible(false);

        const autoRefreshCb = document.getElementById('war-dashboard-auto-refresh-enabled');
        if (autoRefreshCb) autoRefreshCb.checked = getAutoRefreshEnabled();
        if (!getAutoRefreshEnabled()) stopRefreshTimer();

        // Faction activity tracker
        updateActivityLastVisitAndCleanup();
        const activitySection = document.getElementById('war-dashboard-activity-tracker');
        if (activitySection) activitySection.style.display = 'block';
        updateActivityTrackerUI();
        syncActivityTrackerWithCurrentWar().then(() => updateActivityTrackerUI()).catch(() => {});

        // Only run timer when on this page; stop when user navigates away
        function onHashChange() {
            const page = (window.location.hash || '').replace('#', '').split('/')[0];
            if (page !== 'war-dashboard') {
                stopAllWarDashboardTimers();
            } else {
                startWarDashboardTimers();
            }
        }
        window.removeEventListener('hashchange', window._warDashboardHashChange);
        window._warDashboardHashChange = onHashChange;
        window.addEventListener('hashchange', onHashChange);

        // Show chains row shell before runDashboard finishes; Chain Watch commands stay in the ribbon.
        showWarDashboardChainsRow();
        updateChainWatchBarVisibility();
        runDashboard();
        startWarDashboardTimers();
    }

    function wireWarDashboardUiOnce() {
        wireWarDashboardCommandRibbon();
        wireWarDashboardCommandModal('war-dashboard-enemy-modal', 'war-dashboard-enemy-modal-close', closeWarDashboardEnemyModal);
        wireWarDashboardCommandModal('war-dashboard-activity-tracker-modal', 'war-dashboard-activity-tracker-modal-close', closeWarDashboardActivityTrackerModal);
        wireWarDashboardCommandModal('war-dashboard-chain-watch-command-modal', 'war-dashboard-chain-watch-command-modal-close', closeWarDashboardChainWatchCommandModal);
        applyWarDashboardVip2RibbonGating();
        if (!window._warDashboardVipChangedListener) {
            window._warDashboardVipChangedListener = true;
            window.addEventListener('tornToolsVipChanged', applyWarDashboardVip2RibbonGating);
        }
        warDashboardInjectMemberColumnHeaders();

        document.getElementById('war-dashboard-hide-ff-notice')?.addEventListener('click', () => setFFNoticeVisible(false));

        const autoRefreshCb = document.getElementById('war-dashboard-auto-refresh-enabled');
        if (autoRefreshCb) {
            autoRefreshCb.addEventListener('change', () => {
                setAutoRefreshEnabled(autoRefreshCb.checked);
                if (autoRefreshCb.checked) startRefreshTimer();
                else stopRefreshTimer();
            });
        }
        document.getElementById('war-dashboard-auto-refresh-slider-wrap')?.addEventListener('click', (e) => e.stopPropagation());

        document.getElementById('war-dashboard-settings-cog')?.addEventListener('click', openWarDashboardSettingsModal);
        document.getElementById('war-dashboard-settings-close')?.addEventListener('click', closeWarDashboardSettingsModal);
        document.getElementById('war-dashboard-settings-overlay')?.addEventListener('click', (e) => {
            if (e.target.id === 'war-dashboard-settings-overlay') closeWarDashboardSettingsModal();
        });
        wireChainWatchBarButtons();
        document.getElementById('war-dashboard-cw-create-close')?.addEventListener('click', closeChainWatchCreateModal);
        document.getElementById('war-dashboard-chain-watch-create-modal')?.addEventListener('click', function (e) {
            if (e.target.id === 'war-dashboard-chain-watch-create-modal') closeChainWatchCreateModal();
        });
        document.getElementById('war-dashboard-cw-create-submit')?.addEventListener('click', async function () {
            const apiKey = getApiKey();
            const fn = getWarDashboardFunctions();
            const fid = lastOurFactionId;
            const msg = document.getElementById('war-dashboard-cw-create-msg');
            const linkWrap = document.getElementById('war-dashboard-cw-create-link-wrap');
            const linkIn = document.getElementById('war-dashboard-cw-create-link');
            if (!apiKey || !fn || !fid) return;
            const nameEl = document.getElementById('war-dashboard-cw-create-name');
            const targetEl = document.getElementById('war-dashboard-cw-create-target');
            const chainName = nameEl ? String(nameEl.value || '').trim().slice(0, 80) : '';
            const chainTarget = targetEl ? Number(targetEl.value) : 1000;
            const btn = document.getElementById('war-dashboard-cw-create-submit');
            if (btn) btn.disabled = true;
            if (msg) msg.textContent = 'Creating…';
            try {
                const existing = await fn.httpsCallable('chainWatchGet')({
                    apiKey: apiKey,
                    factionId: String(fid),
                    includeArchives: false,
                });
                if (existing && existing.data && existing.data.exists) {
                    const ex = existing.data;
                    const label = chainWatchActiveLabel(ex);
                    const owner =
                        ex.ownerName ||
                        (ex.ownerPlayerId != null
                            ? 'player ' + String(ex.ownerPlayerId)
                            : 'the chain watch owner');
                    if (msg) {
                        msg.textContent =
                            label +
                            ' is already live. Use Add new chain watch to archive it (owner/organiser) or ask ' +
                            owner +
                            ' to archive before creating another.';
                    }
                    return;
                }
                const nowSec = Math.floor(Date.now() / 1000);
                await fn.httpsCallable('chainWatchSaveConfig')({
                    apiKey: apiKey,
                    factionId: String(fid),
                    settings: {
                        chainName: chainName,
                        chainStartUnix: nowSec,
                        chainTarget: chainTarget,
                        backupColumns: 1,
                        rewardType: 'cash',
                        rewardFirst: 0,
                        rewardSubsequent: 0,
                        maxSignupsPer24h: 10,
                        visibleTctDays: 1
                    }
                });
                const share = chainWatchShareUrl(fid);
                if (linkIn) linkIn.value = share;
                if (linkWrap) linkWrap.style.display = 'block';
                if (msg) msg.textContent = 'Created. Opening chain watch page…';
                closeChainWatchCreateModal();
                window.location.hash = 'chain-watch/' + String(fid);
            } catch (e) {
                if (msg) msg.textContent = (e && e.message) ? String(e.message) : 'Create failed';
            } finally {
                if (btn) btn.disabled = false;
            }
        });

        document.getElementById('war-dashboard-tool-container')?.addEventListener('click', function (e) {
            const t = e.target;
            if (!t || !t.closest) return;
            if (t.closest('.war-dashboard-chain-watch-rewards-trigger')) {
                e.preventDefault();
                openChainWatchRewardsModal();
            }
        });
        document.getElementById('war-dashboard-chain-watch-close')?.addEventListener('click', () => closeChainWatchModal());
        document.getElementById('war-dashboard-chain-watch-modal')?.addEventListener('click', (e) => {
            const t = e.target;
            if (t && t.closest && t.closest('.war-dashboard-chain-watch-rewards-trigger')) {
                e.preventDefault();
                openChainWatchRewardsModal();
                return;
            }
            if (e.target.id === 'war-dashboard-chain-watch-modal') closeChainWatchModal();
        });
        document.getElementById('war-dashboard-chain-watch-rewards-close')?.addEventListener('click', () => closeChainWatchRewardsModal());
        document.getElementById('war-dashboard-chain-watch-rewards-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'war-dashboard-chain-watch-rewards-modal') closeChainWatchRewardsModal();
        });

        document.getElementById('war-dashboard-activity-hour-modal-close')?.addEventListener('click', closeActivityHourModal);
        document.getElementById('war-dashboard-activity-hour-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'war-dashboard-activity-hour-modal') closeActivityHourModal();
            else {
                const th = e.target.closest('.war-dashboard-activity-hour-sortable');
                if (th) handleActivityHourModalSort(e.currentTarget, th.getAttribute('data-column'));
            }
        });

        document.getElementById('war-dashboard-apply-enemy')?.addEventListener('click', () => {
            const idInput = document.getElementById('war-dashboard-enemy-faction-id');
            const result = addStoredEnemyFactionId(idInput ? idInput.value : '');
            if (!result.ok) {
                showError(result.message);
                return;
            }
            if (idInput) idInput.value = '';
            runDashboard();
            startRefreshTimer();
            closeWarDashboardEnemyModal();
        });

        document.getElementById('war-dashboard-use-current-war')?.addEventListener('click', async () => {
            const apiKey = getApiKey();
            if (!apiKey) {
                showError('Please enter your API key in the sidebar.');
                return;
            }
            const btn = document.getElementById('war-dashboard-use-current-war');
            if (btn) btn.disabled = true;
            showError('');
            try {
                const user = await getUserProfile(apiKey);
                const ourFactionId = user.factionId;
                if (!ourFactionId) {
                    showError('You are not in a faction.');
                    return;
                }
                const current = await getCurrentWarEnemy(apiKey, ourFactionId);
                if (!current) {
                    showError('No active or upcoming ranked war found.');
                    return;
                }
                const idInput = document.getElementById('war-dashboard-enemy-faction-id');
                if (idInput) idInput.value = '';
                const result = addStoredEnemyFactionId(current.enemyFactionId);
                if (!result.ok) {
                    showError(result.message);
                    return;
                }
                if (btn) btn.textContent = 'Add current ranked war';
                runDashboard();
                startRefreshTimer();
                closeWarDashboardEnemyModal();
            } catch (e) {
                showError(e.message || 'Failed to load current war.');
            } finally {
                if (btn) btn.disabled = false;
            }
        });

        document.getElementById('war-dashboard-clear-enemy')?.addEventListener('click', () => {
            clearEnemyTracking();
            closeWarDashboardEnemyModal();
        });

        document.getElementById('war-dashboard-enemy-list')?.addEventListener('click', function (e) {
            const btn = e.target && e.target.closest ? e.target.closest('.war-dashboard-enemy-remove') : null;
            if (!btn) return;
            removeStoredEnemyFactionId(btn.getAttribute('data-faction-id'));
            runDashboard();
        });

        // Our team collapsible toggle
        document.getElementById('war-dashboard-our-team-toggle')?.addEventListener('click', () => {
            const expanded = isOurTeamExpanded();
            setOurTeamCollapsed(expanded);
        });

        ['war-dashboard-filter-online', 'war-dashboard-filter-offline', 'war-dashboard-filter-idle', 'war-dashboard-filter-okay', 'war-dashboard-filter-hospital', 'war-dashboard-filter-abroad', 'war-dashboard-filter-recommended'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                if (id === 'war-dashboard-filter-recommended') syncRecommendedButton();
                renderEnemyPanels();
            });
        });

        ['war-dashboard-respect-warlord-enabled', 'war-dashboard-respect-warlord-percent'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                saveSettings();
                renderEnemyPanels();
            });
            document.getElementById(id)?.addEventListener('input', () => {
                saveSettings();
                renderEnemyPanels();
            });
        });

        function syncRecommendedButton() {
            const cb = document.getElementById('war-dashboard-filter-recommended');
            const btn = document.getElementById('war-dashboard-recommended-btn');
            if (!cb || !btn) return;
            const on = cb.checked;
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.classList.toggle('war-dashboard-recommended-btn-on', on);
        }
        document.getElementById('war-dashboard-recommended-btn')?.addEventListener('click', () => {
            const cb = document.getElementById('war-dashboard-filter-recommended');
            if (!cb) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        });
        syncRecommendedButton();

        document.getElementById('war-dashboard-enemies-list')?.addEventListener('click', function (e) {
            const toggle = e.target && e.target.closest ? e.target.closest('.war-dashboard-enemy-panel-toggle') : null;
            if (toggle) {
                const factionId = toggle.getAttribute('data-faction-id');
                const enemy = enemyFactionStates.find(item => String(item.id) === String(factionId));
                if (enemy) {
                    enemy.expanded = enemy.expanded === false;
                    renderEnemyPanels();
                }
                return;
            }
            const th = e.target && e.target.closest ? e.target.closest('th.war-dashboard-th-sort') : null;
            if (!th) return;
            const table = th.closest('table[data-faction-id]');
            const factionId = table ? table.getAttribute('data-faction-id') : null;
            const enemy = enemyFactionStates.find(item => String(item.id) === String(factionId));
            const col = th.getAttribute('data-column');
            if (!enemy || !col) return;
            enemy.sortDir = enemy.sortColumn === col ? (enemy.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
            enemy.sortColumn = col;
            renderEnemyPanels();
        });
        document.querySelectorAll('#war-dashboard-our-table th.war-dashboard-th-sort').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.getAttribute('data-column');
                if (!col) return;
                ourSortDir = ourSortColumn === col ? (ourSortDir === 'asc' ? 'desc' : 'asc') : 'desc';
                ourSortColumn = col;
                renderOurTeam(lastOurMembers, lastOurFF, lastOurBS, null);
            });
        });

        document.getElementById('war-dashboard-enemies-list')?.addEventListener('input', (e) => {
            const input = e.target;
            if (!input.classList.contains('war-dashboard-note-input')) return;
            const playerId = input.getAttribute('data-player-id');
            if (playerId) setNote(playerId, input.value.trim());
        });

        document.getElementById('war-dashboard-refresh-interval')?.addEventListener('change', () => {
            saveSettings();
            startRefreshTimer();
        });
        document.getElementById('war-dashboard-chain-refresh-interval')?.addEventListener('change', () => {
            saveSettings();
            startChainRefreshTimer();
        });

        document.getElementById('war-dashboard-refresh-now')?.addEventListener('click', () => {
            refreshStatusOnly();
            scheduleNextRefresh();
        });

        document.getElementById('war-dashboard-refresh-battle-stats')?.addEventListener('click', () => {
            refreshBattleStatsOnly();
        });

        document.getElementById('war-dashboard-ff-blue')?.addEventListener('change', () => { updateRecommendedLabel(); runDashboard(); });
        document.getElementById('war-dashboard-ff-green')?.addEventListener('change', () => { updateRecommendedLabel(); runDashboard(); });
        document.getElementById('war-dashboard-ff-orange')?.addEventListener('change', () => runDashboard());

        document.getElementById('war-dashboard-activity-tracker-load')?.addEventListener('click', () => {
            const factionId = getActivityTrackerFactionIdFromInputs();
            if (!factionId) {
                showError('Enter a Faction ID first.');
                return;
            }
            runActivityTrackerImmediatePull(factionId);
        });
    }

    window.initWarDashboard = initWarDashboard;

    if (!window._warDashToolsMemberIdListener) {
        window._warDashToolsMemberIdListener = true;
        window.addEventListener('toolsMemberIdDisplayChanged', function () {
            if (lastOurMembers && lastOurMembers.length) renderOurTeam(lastOurMembers, lastOurFF, lastOurBS, null);
            if (enemyFactionStates && enemyFactionStates.length) renderEnemyPanels();
            try {
                getActivityConfig().tracked.forEach(function (t) {
                    renderActivityTrackerTable(t.factionId);
                });
            } catch (e) { /* ignore */ }
        });
    }
})();
