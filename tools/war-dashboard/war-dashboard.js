/**
 * War Dashboard: enemy selection (current war or custom ID), our team + enemy tables,
 * status/location from v2 faction members, FF from FF Scouter, attack links, filters, auto-refresh.
 */
(function () {
    'use strict';

    const STORAGE_KEYS = {
        enemyFactionId: 'war_dashboard_enemy_faction_id',
        refreshInterval: 'war_dashboard_refresh_interval',
        chainRefreshInterval: 'war_dashboard_chain_refresh_interval',
        ffBlue: 'war_dashboard_ff_blue',
        ffGreen: 'war_dashboard_ff_green',
        ffOrange: 'war_dashboard_ff_orange',
        ffNoticeHidden: 'war_dashboard_ff_notice_hidden',
        enemyPickerMinimised: 'war_dashboard_enemy_picker_minimised',
        refreshSectionMinimised: 'war_dashboard_refresh_section_minimised',
        ffSectionMinimised: 'war_dashboard_ff_section_minimised',
        trackOurChain: 'war_dashboard_track_our_chain',
        trackEnemyChain: 'war_dashboard_track_enemy_chain',
        autoRefreshEnabled: 'war_dashboard_auto_refresh_enabled',
        activityTrackerConfig: 'war_dashboard_activity_tracker_config',
        activityTrackerLastVisit: 'war_dashboard_activity_tracker_last_visit',
        activityTrackerSectionExpanded: 'war_dashboard_activity_tracker_section_expanded',
        activityAutoWarEnemyFactionId: 'war_dashboard_activity_auto_war_enemy_faction_id'
    };

    const ACTIVITY_DATA_PREFIX = 'war_dashboard_activity_data_';
    /** Per-faction timestamp (ms): ignore Firestore + local samples with t < this (user cleared cache; shared cloud docs cannot be deleted per user). */
    const ACTIVITY_CLOUD_IGNORE_BEFORE_PREFIX = 'war_dashboard_activity_cloud_ignore_before_';
    const ACTIVITY_INTERVAL_MS = 5 * 60 * 1000;
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const ACTIVITY_DATA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    /** Firestore collection: one doc per 5-min tick; doc has { t, factions: { [factionId]: { onlineIds } } } — IDs are online only (not idle). 7-day retention. */
    const ACTIVITY_SAMPLES_COLLECTION = 'activitySamples';
    /** Must match functions/chainWatch.js MAX_HOUR_SLOTS (50 days of hourly slots). */
    const CHAIN_WATCH_MAX_HOUR_SLOTS = 50 * 24;
    /** Re-fetch cloud samples at most this often so 24/7 backend data actually appears without a full reload. */
    const ACTIVITY_FIRESTORE_REFRESH_MS = 2.5 * 60 * 1000;
    /** In-memory cache of merged Firestore + localStorage activity data per faction (so getActivityData stays sync). */
    let activityDataCache = {};
    /** Last time we merged Firestore into activityDataCache for each faction (ms). */
    let activityDataCloudFetchAt = {};
    /** Per faction: { firestoreCount, lastFetch, readError } for UI. */
    let activityDataCloudMeta = {};
    /** Per faction: { ok, error, at } after addTrackedFaction callable. */
    let activityCloudRegisterState = {};

    const CHAIN_AT_ZERO_THROTTLE_MS = 60 * 1000; // when chain at 0, only refetch once per minute
    let lastOurChainFetchTime = 0;
    let lastEnemyChainFetchTime = 0;

    const FF_CACHE_PREFIX = 'war_dashboard_ff_';
    const FF_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
    const FF_REFRESH_DAY_KEY = 'war_dashboard_ff_last_refresh_date_'; // + factionId
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
    let lastOurFactionId = null;
    let currentUserPlayerId = null;
    let currentUserAbroadCountry = null;
    /** Chain data from API: { current, max, timeout, cooldown, modifier, start, end }. Display state ticks down. */
    let lastOurChain = null;
    let lastEnemyChain = null;
    /** Mutable display state: { timeout, cooldown } ticked every second */
    let ourChainDisplay = { timeout: 0, cooldown: 0 };
    let enemyChainDisplay = { timeout: 0, cooldown: 0 };

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

    /** Display label for minutes; bucket width matches ACTIVITY_INTERVAL_MS (5 min). */
    const CHAIN_WATCH_ACTIVITY_SAMPLE_MIN = 5;

    /**
     * Merged Faction activity tracker samples (online only). Slot window [slotStartSec, slotEndSec) unix.
     * Raw samples are deduped by floor(t / ACTIVITY_INTERVAL_MS): multiple ticks in the same 5-min bucket count once
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
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data;
    }

    async function getUserProfile(apiKey) {
        const data = await fetchJson(`https://api.torn.com/user/?selections=profile&key=${apiKey}`);
        return {
            factionId: data.faction_id || data.faction?.faction_id || null,
            factionName: data.faction_name || data.faction?.faction_name || '',
            playerId: data.player_id
        };
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

    /** Fetch faction name — same URL and parsing as Faction Battle Stats (app.js). */
    async function fetchFactionName(apiKey, factionId) {
        if (!factionId || !apiKey) return null;
        const url = `https://api.torn.com/v2/faction/${factionId}?key=${apiKey}`;
        try {
            if (typeof window.batchTornApiCalls === 'function') {
                const tornData = await window.batchTornApiCalls(apiKey, [
                    { name: 'factionInfo', url: `https://api.torn.com/v2/faction/${factionId}`, params: '' }
                ]);
                const data = tornData?.factionInfo;
                if (data && !data.error) {
                    let name = data.basic?.name || data.name || data.faction_name;
                    if (name) return name;
                }
            }
            const res = await fetch(url);
            const data = await res.json();
            if (data && data.error) return null;
            const raw = data?.faction || data;
            let name = raw?.basic?.name || raw?.name || raw?.faction_name;
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
            return Array.isArray(obj.tracked) ? obj : { tracked: [] };
        } catch (e) { return { tracked: [] }; }
    }

    function setActivityConfig(config) {
        try {
            localStorage.setItem(STORAGE_KEYS.activityTrackerConfig, JSON.stringify(config));
        } catch (e) { /* ignore */ }
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

    function formatActivityRelativeTime(ms) {
        if (ms == null || !ms) return '—';
        const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        if (sec < 45) return 'just now';
        if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
        if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
        return Math.floor(sec / 86400) + 'd ago';
    }

    /** Load activity samples from Firestore, merge with local, update cache. Refreshes on a timer (see ACTIVITY_FIRESTORE_REFRESH_MS) so cloud ticks accumulate. */
    async function ensureActivityDataLoaded(factionId, options) {
        const force = options && options.force;
        const fid = String(factionId);
        const now = Date.now();
        if (!force && activityDataCache[fid] != null && activityDataCloudFetchAt[fid] != null &&
            (now - activityDataCloudFetchAt[fid]) < ACTIVITY_FIRESTORE_REFRESH_MS) {
            return;
        }

        var db = null;
        try {
            if (typeof firebase !== 'undefined' && firebase.firestore) db = firebase.firestore();
        } catch (e) { /* ignore */ }
        if (!db) {
            activityDataCloudMeta[fid] = {
                firestoreCount: 0,
                lastFetch: now,
                readError: typeof firebase === 'undefined' ? 'Firebase not loaded' : 'Firestore unavailable'
            };
            return;
        }
        const cutoff = Date.now() - ACTIVITY_DATA_RETENTION_MS;
        var firestoreSamples = [];
        var readError = null;
        try {
            const snap = await db.collection(ACTIVITY_SAMPLES_COLLECTION)
                .where('t', '>=', cutoff)
                .orderBy('t')
                .get();
            snap.docs.forEach(function (doc) {
                const d = doc.data();
                const factions = d.factions || {};
                const factionData = factions[fid];
                if (factionData && Array.isArray(factionData.onlineIds)) {
                    const tVal = d.t != null && typeof d.t.toMillis === 'function' ? d.t.toMillis() : Number(d.t);
                    if (Number.isFinite(tVal)) {
                        firestoreSamples.push({ t: tVal, onlineIds: factionData.onlineIds });
                    }
                }
            });
        } catch (e) {
            readError = (e && e.message) ? e.message : String(e);
            console.warn('Activity Firestore read failed for faction', fid, e);
        }
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
        const merged = Object.keys(byT).map(function (k) { return byT[k]; }).filter(function (s) { return s.t >= cutoff; }).sort(function (a, b) { return a.t - b.t; });
        activityDataCache[fid] = { samples: merged, members: local.members || [] };
        activityDataCloudFetchAt[fid] = now;
        activityDataCloudMeta[fid] = {
            firestoreCount: firestoreSamples.length,
            lastFetch: now,
            readError: readError
        };
    }

    function updateActivityCloudStatusUI(factionId) {
        const fid = String(factionId);
        const el = document.querySelector('.war-dashboard-activity-cloud-status[data-faction-id="' + fid.replace(/"/g, '') + '"]');
        if (!el) return;
        const meta = activityDataCloudMeta[fid];
        const reg = activityCloudRegisterState[fid];
        const bits = [];
        if (reg && reg.ok === false && reg.error) {
            bits.push('24/7 server sampling not registered: ' + reg.error);
        } else if (reg && reg.ok) {
            bits.push('Server samples (Firebase) enabled.');
        }
        if (meta) {
            if (meta.readError) {
                bits.push('Could not read cloud history — ' + meta.readError + (meta.readError.indexOf('index') !== -1 ? ' (create the Firestore index if the console links one.)' : ''));
            } else {
                bits.push('Cloud data points (7d window): ' + (meta.firestoreCount || 0) + '. Merged ' + formatActivityRelativeTime(meta.lastFetch) + '.');
            }
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
                seen.add(s);
                cfg.tracked.push({
                    factionId: s,
                    factionName: 'Faction ' + s,
                    enabled: true,
                    disabledAt: null,
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
        Promise.all(cfg.tracked.map(function (t) {
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
    }

    function getSortValue(m, column, ffMap, bsMap, nowSec) {
        const id = String(m.id);
        const status = statusFromMember(m);
        const expired = status.until != null && nowSec >= status.until;
        const locationDisplay = formatLocationStatusDisplay(status, nowSec);
        switch (column) {
            case 'member': return (m.name || id).toLowerCase();
            case 'level': return Number(m.level) || -1;
            case 'ff': return ffMap[id] != null ? Number(ffMap[id]) : -1;
            case 'eststats': return bsMap[id] != null ? Number(bsMap[id]) : -1;
            case 'status': return status.actionStatus;
            case 'location': return locationDisplay.toLowerCase();
            default: return '';
        }
    }

    function sortMembers(list, column, dir, ffMap, bsMap) {
        const nowSec = Math.floor(Date.now() / 1000);
        const mult = dir === 'asc' ? 1 : -1;
        return [...list].sort((a, b) => {
            const va = getSortValue(a, column, ffMap, bsMap, nowSec);
            const vb = getSortValue(b, column, ffMap, bsMap, nowSec);
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

        const sorted = sortMembers(members, ourSortColumn, ourSortDir, ffMap, bsMap);
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
        if (getTrackEnemyChain() && lastEnemyChain) {
            if (enemyChainDisplay.timeout > 0) enemyChainDisplay.timeout--;
            else if (enemyChainDisplay.cooldown > 0) enemyChainDisplay.cooldown--;
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
        boxEl.className = 'war-dashboard-chain-box' +
            (!trackOn ? ' war-dashboard-chain-box-off' : '') +
            (trackOn && isActive ? ' war-dashboard-chain-box-active' : '') +
            (trackOn && isUrgent ? ' war-dashboard-chain-box-urgent' : '');
        boxEl.setAttribute('aria-hidden', 'false');
        boxEl.style.display = 'block';
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
        if (lastEnemyFactionId) {
            row.style.display = 'grid';
            row.style.gridTemplateColumns = (typeof window !== 'undefined' && window.innerWidth <= 700)
                ? '1fr'
                : 'repeat(2, minmax(0, 1fr))';
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
        if (lastEnemyFactionId) {
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
        if (lastEnemyFactionId) {
            row.classList.add('war-dashboard-chains-row--dual');
            row.classList.remove('war-dashboard-chains-row--solo');
        } else {
            row.classList.add('war-dashboard-chains-row--solo');
            row.classList.remove('war-dashboard-chains-row--dual');
        }
        applyChainsRowVisibleLayout(row);
    }

    /** Placeholder so Our Chain shows at 0 / tracking off when API failed or not loaded — Chain watch stays visible underneath. */
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
        const enemyChainForUi = lastEnemyChain || (lastEnemyFactionId ? ENEMY_CHAIN_PLACEHOLDER : null);
        const enemyDisplayForUi = lastEnemyChain ? enemyChainDisplay : { timeout: 0, cooldown: 0 };
        renderChainBox(
            document.getElementById('war-dashboard-enemy-chain-box'),
            'Enemy Chain',
            enemyChainForUi,
            enemyDisplayForUi,
            'enemy'
        );
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
     * Ensures Chain watch bar exists directly under Our Chain (inside #war-dashboard-chain-column-our).
     */
    function ensureChainWatchBarMounted() {
        const ourCol = document.getElementById('war-dashboard-chain-column-our');
        const ourBox = document.getElementById('war-dashboard-our-chain-box');
        if (!ourCol || !ourBox) return;

        let bar = document.getElementById('war-dashboard-chain-watch-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'war-dashboard-chain-watch-bar';
            bar.className = 'war-dashboard-chain-watch-bar';
            bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;';
            ourCol.insertBefore(bar, ourBox.nextSibling);
        } else if (bar.parentNode !== ourCol || bar.previousElementSibling !== ourBox) {
            ourCol.insertBefore(bar, ourBox.nextSibling);
        }
        if (!document.getElementById('war-dashboard-chain-watch-new')) {
            const hint = document.getElementById('war-dashboard-chain-watch-hint');
            const hintHtml = hint
                ? hint.outerHTML
                : '<span id="war-dashboard-chain-watch-hint" class="war-dashboard-chain-watch-hint" style="color:#888;font-size:12px;"></span>';
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
            alert('Load your faction first (Apply or Use current ranked war).');
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
        showChainWatchCreateModal();
    }

    function updateChainWatchBarVisibility() {
        ensureChainWatchBarMounted();
        const bar = document.getElementById('war-dashboard-chain-watch-bar');
        const hint = document.getElementById('war-dashboard-chain-watch-hint');
        if (!bar) return;
        // Always show the bar on War Dashboard — visibility does not depend on enemy faction (only our faction is needed for API calls).
        bar.style.display = 'flex';
        if (hint) {
            if (!lastOurFactionId) {
                if (!getApiKey()) {
                    hint.textContent = ' Set API key in the sidebar, then load the dashboard.';
                } else {
                    hint.textContent = ' Waiting for your faction (dashboard loading or not in a faction). No enemy faction required for Chain watch.';
                }
            } else {
                const age = chainWatchLastFetchMs ? Math.max(0, Math.floor((Date.now() - chainWatchLastFetchMs) / 1000)) : null;
                hint.textContent = age != null ? ('Schedule data: refreshed ' + (age < 60 ? age + 's' : Math.floor(age / 60) + 'm') + ' ago') : '';
            }
        }
    }

    /** @returns {Promise<object|null>} chainWatchPayload on success, or null (see chainWatchLastError). */
    async function fetchChainWatchData(force) {
        chainWatchLastError = '';
        const fid = lastOurFactionId;
        const apiKey = getApiKey();
        if (!fid) {
            chainWatchLastError = 'No faction loaded yet. Click Apply or Use current ranked war, then open Chain watch again.';
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
            const payload = { apiKey: apiKey, factionId: String(fid) };
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
            html += '<label class="war-dashboard-cw-clear-label" style="display:flex;align-items:flex-start;gap:8px;margin:0;color:#b0b0b0;font-size:12px;line-height:1.4;width:100%;"><input type="checkbox" id="war-dashboard-cw-clear" style="margin-top:2px;flex-shrink:0;"><span>Clear all signups when saving (also when changing start, target, or parallel slots)</span></label>';
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

        let hasCompletedInView = false;
        const slotIndicesToRender = [];
        for (let i = 0; start != null && i < rowCount; i++) {
            const slotEndSec = start + (i + 1) * 3600;
            const hourCompleted = nowSec >= slotEndSec;
            if (hourCompleted) hasCompletedInView = true;
            if (!showCompletedRows && hourCompleted) continue;
            slotIndicesToRender.push(i);
        }

        html += '<div class="war-dashboard-cw-table-block">';
        if ((start != null && hasCompletedInView) || showAddCol) {
            html += '<div class="war-dashboard-cw-table-top-bar">';
            if (start != null && hasCompletedInView) {
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
            hasCompletedInView &&
            !showCompletedRows
        ) {
            html +=
                '<tr><td colspan="' +
                slotTableColCount +
                '" style="color:#888;">All hours in this view are in the past. Use <strong>Show completed rows</strong> above to see them.</td></tr>';
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
            '<p class="war-dashboard-cw-attendance-footnote" style="color:#9e9e9e;font-size:12px;margin:12px 0 0 0;line-height:1.45;">Watch attendance uses <strong>Faction activity tracker</strong> samples (~5 min, online only). Add your faction there for 24/7 history. <strong>Xm</strong> = estimated online minutes in that hour; <strong>✓</strong> seen online at least once; <strong>✗</strong> samples ran but player was not online; <strong>?</strong> no samples that hour; <strong>…</strong> hour still in progress.</p>';

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
                const unix = unixFromUtcDateHour(dateEl && dateEl.value, hourEl && hourEl.value);
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
            alert('Load your faction first (Apply or Use current ranked war).');
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

    function renderEnemy(members, ffMap, bsMap, thresholds) {
        const table = document.getElementById('war-dashboard-enemy-table');
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

        filtered = sortMembers(filtered, enemySortColumn, enemySortDir, ffMap, bsMap);
        updateSortIndicators('war-dashboard-enemy-table', enemySortColumn, enemySortDir);

        const rowHtml = filtered.map(m => {
            const id = m.id;
            const ff = ffMap[String(id)];
            const bs = bsMap[String(id)];
            const status = statusFromMember(m);
            const statusDisplay = formatLocationStatusDisplay(status, nowSec);
            const color = getFFColor(ff, blue, green, orange);
            const statusColor = getStatusColor(status, nowSec);
            const ffText = ff != null ? ff.toFixed(2) : '—';
            const bsText = bs != null ? Number(bs).toLocaleString() : '—';
            const attackUrl = `https://www.torn.com/page.php?sid=attack&user2ID=${id}`;
            const noteValue = escapeHtml(getNote(id));
            const memLabelEnemy = window.toolsFormatMemberDisplayLabel({ name: m.name || id, id }, window.toolsGetShowMemberIdInBrackets());
            return `<tr>
                <td><a href="${attackUrl}" target="_blank" rel="noopener" title="Attack">🎯</a> <a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener" style="color: #FFD700;"${window.toolsMemberLinkAttrs(m.name || id, id)}>${escapeHtml(memLabelEnemy)}</a></td>
                <td>${escapeHtml(m.level != null ? String(m.level) : '—')}</td>
                <td style="background-color: ${color || 'transparent'};">${ffText}</td>
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
            el.textContent = msg || '';
            el.style.display = msg ? 'block' : 'none';
        }
    }

    function loadSettings() {
        const fid = localStorage.getItem(STORAGE_KEYS.enemyFactionId) || '';
        const interval = localStorage.getItem(STORAGE_KEYS.refreshInterval);
        const chainInterval = localStorage.getItem(STORAGE_KEYS.chainRefreshInterval);
        const blue = localStorage.getItem(STORAGE_KEYS.ffBlue);
        const green = localStorage.getItem(STORAGE_KEYS.ffGreen);
        const orange = localStorage.getItem(STORAGE_KEYS.ffOrange);

        const idInput = document.getElementById('war-dashboard-enemy-faction-id');
        if (idInput) idInput.value = fid;
        const intervalInput = document.getElementById('war-dashboard-refresh-interval');
        if (intervalInput && interval != null) intervalInput.value = interval || '15';
        const chainIntervalInput = document.getElementById('war-dashboard-chain-refresh-interval');
        if (chainIntervalInput) chainIntervalInput.value = (chainInterval != null && chainInterval !== '') ? chainInterval : '30';
        const blueInput = document.getElementById('war-dashboard-ff-blue');
        if (blueInput && blue != null) blueInput.value = blue || '2.5';
        const greenInput = document.getElementById('war-dashboard-ff-green');
        if (greenInput && green != null) greenInput.value = green || '3.5';
        const orangeInput = document.getElementById('war-dashboard-ff-orange');
        if (orangeInput && orange != null) orangeInput.value = orange || '4.5';
        updateRecommendedLabel();
    }

    function updateRecommendedLabel() {
        const blue = Number(document.getElementById('war-dashboard-ff-blue')?.value) || 2.5;
        const green = Number(document.getElementById('war-dashboard-ff-green')?.value) || 3.5;
        const el = document.getElementById('war-dashboard-recommended-ff-range');
        if (el) el.textContent = 'FF ' + blue + ' – ' + green;
    }

    function saveSettings() {
        const idInput = document.getElementById('war-dashboard-enemy-faction-id');
        const intervalInput = document.getElementById('war-dashboard-refresh-interval');
        if (idInput) localStorage.setItem(STORAGE_KEYS.enemyFactionId, idInput.value.trim());
        if (intervalInput) localStorage.setItem(STORAGE_KEYS.refreshInterval, intervalInput.value);
        const chainIntervalInput = document.getElementById('war-dashboard-chain-refresh-interval');
        if (chainIntervalInput) localStorage.setItem(STORAGE_KEYS.chainRefreshInterval, chainIntervalInput.value);
        const blue = document.getElementById('war-dashboard-ff-blue')?.value;
        const green = document.getElementById('war-dashboard-ff-green')?.value;
        const orange = document.getElementById('war-dashboard-ff-orange')?.value;
        if (blue != null) localStorage.setItem(STORAGE_KEYS.ffBlue, blue);
        if (green != null) localStorage.setItem(STORAGE_KEYS.ffGreen, green);
        if (orange != null) localStorage.setItem(STORAGE_KEYS.ffOrange, orange);
    }

    async function runDashboard() {
        const apiKey = getApiKey();
        if (!apiKey) {
            showError('Please enter your API key in the sidebar.');
            return;
        }

        saveSettings();
        showError('');
        showLoading(true);

        const idInput = document.getElementById('war-dashboard-enemy-faction-id');
        const enemyFactionId = (idInput?.value || '').trim();
        let enemyName = '';

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

            if (!enemyFactionId) {
                lastEnemyFactionId = null;
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
                lastEnemyMembers = [];
                lastEnemyFF = {};
                lastEnemyBS = {};
                lastEnemyChain = null;
                enemyChainDisplay = { timeout: 0, cooldown: 0 };
                const me = ourMembers.find(m => String(m.id) === String(user.playerId));
                currentUserAbroadCountry = me ? parseAbroadCountry(me) : null;
                renderOurTeam(ourMembers, ourFF, ourBS, null);
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
                showError('Enter an enemy faction ID or click "Use current ranked war" to compare.');
                fetchChainWatchData(false).catch(function () {});
                syncChainWatchFromDashboard();
                showLoading(false);
                return;
            }

            // Try to get enemy name from current war for label (optional)
            const current = await getCurrentWarEnemy(apiKey, ourFactionId).catch(() => null);
            if (current && current.enemyFactionId === enemyFactionId) {
                enemyName = current.enemyName;
            }
            lastEnemyName = enemyName || '';
            const labelText = enemyName ? `Enemy: ${enemyName} (ID: ${enemyFactionId})` : `Enemy Faction ID: ${enemyFactionId}`;
            const labelEl = document.getElementById('war-dashboard-enemy-label');
            if (labelEl) labelEl.textContent = labelText;
            const summaryEl = document.getElementById('war-dashboard-enemy-picker-summary');
            if (summaryEl) summaryEl.textContent = labelText ? ' — ' + labelText : '';

            lastEnemyFactionId = enemyFactionId;
            showWarDashboardChainsRow();
            renderChainBoxes();

            // Fetch our members, enemy members, and both chains in parallel
            const [ourMembers, enemyMembers, ourChainData, enemyChainData] = await Promise.all([
                fetchFactionMembers(apiKey, null),
                fetchFactionMembers(apiKey, enemyFactionId).catch(() => []),
                fetchFactionChain(apiKey, ourFactionId).catch(() => null),
                fetchFactionChain(apiKey, enemyFactionId).catch(() => null)
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

            // FF + battle stats for enemy: same cache rules
            let enemyFF = {};
            let enemyBS = {};
            const enemyIds = enemyMembers.map(m => String(m.id));
            const enemyCached = getFFCache(enemyFactionId);
            if (enemyCached && enemyCached.ff && !shouldRefreshFFToday(enemyFactionId)) {
                enemyFF = enemyCached.ff || {};
                enemyBS = enemyCached.bs || {};
            } else if (enemyIds.length) {
                try {
                    const enemyData = await fetchFFForMembers(apiKey, enemyIds);
                    enemyFF = enemyData.ff || {};
                    enemyBS = enemyData.bs || {};
                    setFFCache(enemyFactionId, { ff: enemyFF, bs: enemyBS });
                } catch (e) { console.warn('War Dashboard enemy FF:', e.message); }
            } else if (enemyCached && enemyCached.ff) {
                enemyFF = enemyCached.ff;
                enemyBS = enemyCached.bs || {};
            }

            lastEnemyMembers = enemyMembers;
            lastEnemyFF = enemyFF;
            lastEnemyBS = enemyBS;
            lastOurMembers = ourMembers;
            lastOurFF = ourFF;
            lastOurBS = ourBS;
            lastOurFactionId = ourFactionId;
            currentUserPlayerId = user.playerId;
            const me = ourMembers.find(m => String(m.id) === String(user.playerId));
            currentUserAbroadCountry = me ? parseAbroadCountry(me) : null;

            lastOurChain = ourChainData;
            lastEnemyChain = enemyChainData;
            if (ourChainData) lastOurChainFetchTime = Date.now();
            if (enemyChainData) lastEnemyChainFetchTime = Date.now();
            ourChainDisplay = lastOurChain ? { timeout: lastOurChain.timeout, cooldown: lastOurChain.cooldown } : { timeout: 0, cooldown: 0 };
            enemyChainDisplay = lastEnemyChain ? { timeout: lastEnemyChain.timeout, cooldown: lastEnemyChain.cooldown } : { timeout: 0, cooldown: 0 };

            renderOurTeam(ourMembers, ourFF, ourBS, null);
            renderEnemy(enemyMembers, enemyFF, enemyBS, null);
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
            showError(err.message || 'Failed to load data.');
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
        const factionId = chainKey === 'our' ? lastOurFactionId : lastEnemyFactionId;
        if (!factionId) return;
        try {
            const data = await fetchFactionChain(apiKey, factionId);
            if (data) {
                if (chainKey === 'our') {
                    lastOurChain = data;
                    ourChainDisplay = { timeout: data.timeout, cooldown: data.cooldown };
                    lastOurChainFetchTime = Date.now();
                } else {
                    lastEnemyChain = data;
                    enemyChainDisplay = { timeout: data.timeout, cooldown: data.cooldown };
                    lastEnemyChainFetchTime = Date.now();
                }
                renderChainBoxes();
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
        if (!lastEnemyFactionId || !lastOurFactionId) {
            showError('Load the dashboard first (Apply or Use current ranked war), then refresh battle stats.');
            return;
        }
        const btn = document.getElementById('war-dashboard-refresh-battle-stats');
        if (btn) btn.disabled = true;
        showLoading(true);
        showError('');
        try {
            const ourIds = lastOurMembers.map(m => String(m.id));
            const enemyIds = lastEnemyMembers.map(m => String(m.id));
            const [ourData, enemyData] = await Promise.all([
                ourIds.length ? fetchFFForMembers(apiKey, ourIds) : Promise.resolve({ ff: {}, bs: {} }),
                enemyIds.length ? fetchFFForMembers(apiKey, enemyIds) : Promise.resolve({ ff: {}, bs: {} })
            ]);
            const ourFF = ourData.ff || {};
            const ourBS = ourData.bs || {};
            const enemyFF = enemyData.ff || {};
            const enemyBS = enemyData.bs || {};
            setFFCache(lastOurFactionId, { ff: ourFF, bs: ourBS });
            setFFCache(lastEnemyFactionId, { ff: enemyFF, bs: enemyBS });
            lastOurFF = ourFF;
            lastOurBS = ourBS;
            lastEnemyFF = enemyFF;
            lastEnemyBS = enemyBS;
            renderOurTeam(lastOurMembers, lastOurFF, lastOurBS, null);
            renderEnemy(lastEnemyMembers, lastEnemyFF, lastEnemyBS, null);
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
        if (!lastEnemyFactionId) return;
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
            const enemyChainPromise = (() => {
                if (!getTrackEnemyChain()) return Promise.resolve(lastEnemyChain);
                if (isChainAtZero(lastEnemyChain) && lastEnemyChainFetchTime && (now - lastEnemyChainFetchTime < CHAIN_AT_ZERO_THROTTLE_MS))
                    return Promise.resolve(lastEnemyChain);
                return fetchFactionChain(apiKey, lastEnemyFactionId).then((data) => { lastEnemyChainFetchTime = Date.now(); return data; }).catch(() => lastEnemyChain);
            })();

            const [enemyMembers, ourChainData, enemyChainData] = await Promise.all([
                fetchFactionMembers(apiKey, lastEnemyFactionId).catch(() => lastEnemyMembers),
                ourChainPromise,
                enemyChainPromise
            ]);
            lastEnemyMembers = enemyMembers;
            if (ourChainData) {
                lastOurChain = ourChainData;
                ourChainDisplay = { timeout: ourChainData.timeout, cooldown: ourChainData.cooldown };
            }
            if (enemyChainData) {
                lastEnemyChain = enemyChainData;
                enemyChainDisplay = { timeout: enemyChainData.timeout, cooldown: enemyChainData.cooldown };
            }
            renderEnemy(lastEnemyMembers, lastEnemyFF, lastEnemyBS, null);
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
        return Math.max(5, Math.min(300, parseInt(document.getElementById('war-dashboard-refresh-interval')?.value || '15', 10)));
    }

    function getChainRefreshIntervalSec() {
        return Math.max(10, Math.min(300, parseInt(document.getElementById('war-dashboard-chain-refresh-interval')?.value || '30', 10)));
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
        const enemyPromise = (() => {
            if (!getTrackEnemyChain() || !lastEnemyFactionId) return Promise.resolve(lastEnemyChain);
            if (isChainAtZero(lastEnemyChain) && lastEnemyChainFetchTime && (now - lastEnemyChainFetchTime < CHAIN_AT_ZERO_THROTTLE_MS))
                return Promise.resolve(lastEnemyChain);
            return fetchFactionChain(apiKey, lastEnemyFactionId).then((data) => { lastEnemyChainFetchTime = Date.now(); return data; }).catch(() => lastEnemyChain);
        })();
        try {
            const [ourChainData, enemyChainData] = await Promise.all([ourPromise, enemyPromise]);
            if (ourChainData) {
                lastOurChain = ourChainData;
                ourChainDisplay = { timeout: ourChainData.timeout, cooldown: ourChainData.cooldown };
            }
            if (enemyChainData) {
                lastEnemyChain = enemyChainData;
                enemyChainDisplay = { timeout: enemyChainData.timeout, cooldown: enemyChainData.cooldown };
            }
            renderChainBoxes();
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

    function updateCountdownDisplay() {
        const el = document.getElementById('war-dashboard-refresh-countdown');
        if (!el) return;
        if (nextRefreshAt == null) {
            el.textContent = 'Next refresh in —s';
            return;
        }
        const secLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
        el.textContent = secLeft > 0 ? `Next refresh in ${secLeft}s` : 'Refreshing…';
    }

    function scheduleNextRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = null;
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        const sec = getRefreshIntervalSec();
        nextRefreshAt = Date.now() + sec * 1000;
        refreshTimer = setTimeout(() => {
            refreshStatusOnly();
            syncActivityTrackerWithCurrentWar().then(() => updateActivityTrackerUI()).catch(() => {});
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
        lastEnemyFactionId = null;
        lastEnemyName = null;
        lastEnemyMembers = [];
        lastEnemyFF = {};
        lastEnemyBS = {};
        lastEnemyChain = null;
        lastEnemyChainFetchTime = 0;
        enemyChainDisplay = { timeout: 0, cooldown: 0 };
        try { localStorage.removeItem(STORAGE_KEYS.enemyFactionId); } catch (e) { /* ignore */ }
        const idInput = document.getElementById('war-dashboard-enemy-faction-id');
        if (idInput) idInput.value = '';
        const labelEl = document.getElementById('war-dashboard-enemy-label');
        if (labelEl) labelEl.textContent = '';
        const summaryEl = document.getElementById('war-dashboard-enemy-picker-summary');
        if (summaryEl) summaryEl.textContent = '';
        renderEnemy([], {}, {}, null);
        renderChainBoxes();
        document.getElementById('war-dashboard-enemy-section').style.display = 'none';
        showError('Enter an enemy faction ID or click "Use current ranked war" to compare.');
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

    /** Run one 5-min tick: for each enabled tracked faction (with lastVisit within 2 days), fetch members and append sample. */
    async function runActivityTrackerTick() {
        nextActivitySampleAt = Date.now() + ACTIVITY_INTERVAL_MS;
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
        const apiKey = getApiKey();
        if (!apiKey) return;
        const config = getActivityConfig();
        const lastVisit = getActivityLastVisit();
        if (lastVisit === 0 || (Date.now() - lastVisit) > TWO_DAYS_MS) return;
        for (const t of config.tracked) {
            if (!t.enabled) continue;
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
        const text = remaining <= 0 ? 'Next sample soon…' : 'Next sample in ' + formatCountdown(remaining);
        document.querySelectorAll('.war-dashboard-activity-next-sample').forEach(el => { el.textContent = text; });
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
        const bsMap = cached ? (cached.bs || {}) : (factionId === lastEnemyFactionId ? lastEnemyBS : {});
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
        const ffMap = cached ? (cached.ff || {}) : (factionId === lastEnemyFactionId ? lastEnemyFF : {});
        const bsMap = cached ? (cached.bs || {}) : (factionId === lastEnemyFactionId ? lastEnemyBS : {});
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
                                <thead><tr><th class="war-dashboard-activity-tracker-sortable" data-column="member" scope="col">${window.toolsMemberColumnHeaderWrap('<span>Member<span class="war-dashboard-activity-tracker-sort-arrow"></span></span>', { align: 'flex-start' })}</th><th class="war-dashboard-activity-tracker-sortable" data-column="level" scope="col">Level<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="stats" scope="col">Est. stats<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="hoursActive" scope="col">Hours active (<span class="war-dashboard-activity-hours-tracked" data-faction-id="${escapeHtml(fid)}">—</span> tracked)<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="activeBetween" scope="col">Peak hours (TCT, top 3)<span class="war-dashboard-activity-tracker-sort-arrow"></span></th></tr></thead>
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
                    await ensureActivityDataLoaded(fid, { force: true });
                    await ensureActivityTrackerBattleStats(fid);
                    updateActivityCloudStatusUI(fid);
                    renderActivityTrackerChart(fid);
                    renderActivityTrackerTable(fid);
                }
            });

            const enabledCb = block.querySelector('.war-dashboard-activity-faction-enabled');
            enabledCb.addEventListener('change', () => {
                t.enabled = enabledCb.checked;
                if (!t.enabled) t.disabledAt = Date.now();
                else t.disabledAt = null;
                setActivityConfig(config);
                if (t.enabled) {
                    syncTrackedFactionToFirestore(fid, 'add').then(function (r) {
                        updateActivityCloudStatusUI(fid);
                        if (!r.ok && r.error) showError('Cloud activity (24/7): ' + r.error);
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
                delete activityDataCloudFetchAt[fid];
                delete activityDataCloudMeta[fid];
                setActivityConfig(config);
                updateActivityTrackerUI();
            });

            const removeBtn = block.querySelector('.war-dashboard-activity-faction-remove');
            removeBtn.addEventListener('click', () => {
                const factionLabel = t.factionName || 'Faction ' + fid;
                if (!confirm('Remove ' + factionLabel + ' from the activity tracker? Its cached data will be cleared. You can add it again later by loading the faction.')) return;
                config.tracked = config.tracked.filter(x => String(x.factionId) !== String(fid));
                try { localStorage.removeItem(ACTIVITY_DATA_PREFIX + fid); } catch (e) { /* ignore */ }
                clearActivityCloudIgnoreBeforeMs(fid);
                delete activityDataCache[fid];
                delete activityDataCloudFetchAt[fid];
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

        Promise.all(config.tracked.map(t => ensureActivityDataLoaded(t.factionId)))
            .then(function () {
                config.tracked.forEach(function (t) {
                    renderActivityTrackerChart(t.factionId);
                    renderActivityTrackerTable(t.factionId);
                    updateActivityCloudStatusUI(t.factionId);
                });
            })
            .catch(function (e) { console.warn('Activity cloud merge batch', e); });

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

    /** Sync activity tracker with current ranked war: auto-add enemy when war is active, auto-disable when war ends. */
    async function syncActivityTrackerWithCurrentWar() {
        const apiKey = getApiKey();
        if (!apiKey) return;
        try {
            const user = await getUserProfile(apiKey);
            const ourFactionId = user.factionId;
            if (!ourFactionId) return;
            const current = await getCurrentWarEnemy(apiKey, ourFactionId).catch(() => null);
            const config = getActivityConfig();
            const storedAutoId = localStorage.getItem(STORAGE_KEYS.activityAutoWarEnemyFactionId);

            if (current) {
                const enemyId = current.enemyFactionId;
                const enemyName = current.enemyName || 'Faction ' + enemyId;
                const existing = config.tracked.find(t => t.factionId === enemyId);
                if (!existing) {
                    config.tracked.push({
                        factionId: enemyId,
                        factionName: enemyName,
                        enabled: true,
                        disabledAt: null,
                        startedAt: Date.now()
                    });
                    setActivityConfig(config);
                    syncTrackedFactionToFirestore(enemyId, 'add');
                    try { localStorage.setItem(STORAGE_KEYS.activityAutoWarEnemyFactionId, enemyId); } catch (e) { /* ignore */ }
                    await runActivityTrackerImmediatePull(enemyId);
                    return;
                }
                existing.enabled = true;
                existing.disabledAt = null;
                if (existing.factionName === 'Faction ' + enemyId) existing.factionName = enemyName;
                setActivityConfig(config);
                try { localStorage.setItem(STORAGE_KEYS.activityAutoWarEnemyFactionId, enemyId); } catch (e) { /* ignore */ }
                updateActivityTrackerUI();
            } else {
                if (storedAutoId) {
                    const t = config.tracked.find(x => x.factionId === storedAutoId);
                    if (t) {
                        t.enabled = false;
                        t.disabledAt = Date.now();
                        setActivityConfig(config);
                        updateActivityTrackerUI();
                    }
                    try { localStorage.removeItem(STORAGE_KEYS.activityAutoWarEnemyFactionId); } catch (e) { /* ignore */ }
                }
            }
        } catch (e) {
            console.warn('Activity tracker sync with current war:', e);
        }
    }

    /** Ensure faction is in tracked list; add with default name if missing. Updates factionName when provided. Returns config. */
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
        config.tracked.push({
            factionId: factionId,
            factionName: factionName || 'Faction ' + factionId,
            enabled: true,
            disabledAt: null,
            startedAt: Date.now()
        });
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
            ensureActivityTrackerFactionInConfig(factionId, factionName || undefined);
            appendActivitySample(factionId, onlineIds, members);
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
            const reg = await syncTrackedFactionToFirestore(factionId, 'add');
            updateActivityCloudStatusUI(factionId);
            if (!reg.ok && reg.error) showError('Cloud activity (24/7): ' + reg.error + ' — this tab will still sample every 5 min while open.');
            await ensureActivityDataLoaded(factionId, { force: true });
            updateActivityCloudStatusUI(factionId);
            updateActivityTrackerUI();
        } catch (e) {
            showError(e.message || 'Failed to load faction.');
        }
    }

    function setActivityTrackerSectionExpanded(expanded) {
        const body = document.getElementById('war-dashboard-activity-tracker-body');
        const btn = document.getElementById('war-dashboard-activity-tracker-toggle');
        const arrow = document.getElementById('war-dashboard-activity-tracker-arrow');
        if (body) body.style.display = expanded ? 'block' : 'none';
        if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (arrow) arrow.textContent = expanded ? '▼' : '▶';
        try {
            localStorage.setItem(STORAGE_KEYS.activityTrackerSectionExpanded, expanded ? '1' : '0');
        } catch (e) { /* ignore */ }
        if (expanded) {
            updateActivityTrackerUI();
            const factionId = getActivityTrackerFactionIdFromInputs();
            if (factionId) runActivityTrackerImmediatePull(factionId);
        }
    }

    function warDashboardInjectMemberColumnHeaders() {
        ['war-dashboard-enemy-table', 'war-dashboard-our-table'].forEach(function (tid) {
            const th = document.querySelector('#' + tid + ' thead th[data-column="member"]');
            if (!th || th.getAttribute('data-tools-member-header') === '1') return;
            th.setAttribute('data-tools-member-header', '1');
            const sortEl = th.querySelector('.war-dashboard-sort');
            const sortHtml = sortEl ? sortEl.outerHTML : '<span class="war-dashboard-sort"></span>';
            th.innerHTML = window.toolsMemberColumnHeaderWrap('<span>Member ' + sortHtml + '</span>', { align: 'flex-start' });
        });
    }

    function initWarDashboard() {
        if (window.logToolUsage) window.logToolUsage('war-dashboard');

        warDashboardInjectMemberColumnHeaders();

        loadSettings();
        Promise.all(getActivityConfig().tracked.map(function (t) {
            return syncTrackedFactionToFirestore(t.factionId, 'add');
        })).then(function () {
            updateAllActivityCloudStatusUI();
        });

        if (localStorage.getItem(STORAGE_KEYS.ffNoticeHidden) === '1') setFFNoticeVisible(false);
        if (localStorage.getItem(STORAGE_KEYS.enemyPickerMinimised) === '1') setEnemyPickerMinimised(true);
        if (localStorage.getItem(STORAGE_KEYS.refreshSectionMinimised) === '1') setRefreshSectionMinimised(true);

        const autoRefreshCb = document.getElementById('war-dashboard-auto-refresh-enabled');
        if (autoRefreshCb) {
            autoRefreshCb.checked = getAutoRefreshEnabled();
            autoRefreshCb.addEventListener('change', () => {
                setAutoRefreshEnabled(autoRefreshCb.checked);
                if (autoRefreshCb.checked) startRefreshTimer();
                else stopRefreshTimer();
            });
        }
        document.getElementById('war-dashboard-auto-refresh-slider-wrap')?.addEventListener('click', (e) => e.stopPropagation());
        if (!getAutoRefreshEnabled()) stopRefreshTimer();

        document.getElementById('war-dashboard-hide-ff-notice')?.addEventListener('click', () => setFFNoticeVisible(false));
        document.getElementById('war-dashboard-enemy-picker-toggle')?.addEventListener('click', () => {
            const currently = localStorage.getItem(STORAGE_KEYS.enemyPickerMinimised) === '1';
            setEnemyPickerMinimised(!currently);
        });
        document.getElementById('war-dashboard-refresh-picker-toggle')?.addEventListener('click', () => {
            const currently = localStorage.getItem(STORAGE_KEYS.refreshSectionMinimised) === '1';
            setRefreshSectionMinimised(!currently);
        });

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

        if (window._warDashboardChainWatchPollId) clearInterval(window._warDashboardChainWatchPollId);
        window._warDashboardChainWatchPollId = setInterval(function () {
            const p = (window.location.hash || '').replace('#', '').split('/')[0];
            if (p !== 'war-dashboard' || !lastOurFactionId) return;
            fetchChainWatchData(false).catch(function () {});
        }, 60 * 1000);

        document.getElementById('war-dashboard-activity-hour-modal-close')?.addEventListener('click', closeActivityHourModal);
        document.getElementById('war-dashboard-activity-hour-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'war-dashboard-activity-hour-modal') closeActivityHourModal();
            else {
                const th = e.target.closest('.war-dashboard-activity-hour-sortable');
                if (th) handleActivityHourModalSort(e.currentTarget, th.getAttribute('data-column'));
            }
        });

        document.getElementById('war-dashboard-apply-enemy')?.addEventListener('click', () => {
            runDashboard();
            startRefreshTimer();
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
                if (idInput) idInput.value = current.enemyFactionId;
                if (btn) {
                    btn.textContent =
                        current.kind === 'upcoming'
                            ? `Use upcoming ranked war (vs ${current.enemyName})`
                            : `Use current ranked war (vs ${current.enemyName})`;
                }
                saveSettings();
                runDashboard();
                startRefreshTimer();
            } catch (e) {
                showError(e.message || 'Failed to load current war.');
            } finally {
                if (btn) btn.disabled = false;
            }
        });

        document.getElementById('war-dashboard-clear-enemy')?.addEventListener('click', () => {
            clearEnemyTracking();
        });

        // Our team collapsible toggle
        document.getElementById('war-dashboard-our-team-toggle')?.addEventListener('click', () => {
            const expanded = isOurTeamExpanded();
            setOurTeamCollapsed(expanded);
        });

        ['war-dashboard-filter-online', 'war-dashboard-filter-offline', 'war-dashboard-filter-idle', 'war-dashboard-filter-okay', 'war-dashboard-filter-hospital', 'war-dashboard-filter-abroad', 'war-dashboard-filter-recommended'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                if (id === 'war-dashboard-filter-recommended') syncRecommendedButton();
                renderEnemy(lastEnemyMembers, lastEnemyFF, lastEnemyBS, null);
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

        document.querySelectorAll('#war-dashboard-enemy-table th.war-dashboard-th-sort').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.getAttribute('data-column');
                if (!col) return;
                enemySortDir = enemySortColumn === col ? (enemySortDir === 'asc' ? 'desc' : 'asc') : 'desc';
                enemySortColumn = col;
                renderEnemy(lastEnemyMembers, lastEnemyFF, lastEnemyBS, null);
            });
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

        document.getElementById('war-dashboard-enemy-table')?.addEventListener('input', (e) => {
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

        // Faction activity tracker
        updateActivityLastVisitAndCleanup();
        const activitySection = document.getElementById('war-dashboard-activity-tracker');
        if (activitySection) activitySection.style.display = 'block';
        setActivityTrackerSectionExpanded(localStorage.getItem(STORAGE_KEYS.activityTrackerSectionExpanded) === '1');
        updateActivityTrackerUI();
        syncActivityTrackerWithCurrentWar().then(() => updateActivityTrackerUI()).catch(() => {});

        document.getElementById('war-dashboard-activity-tracker-toggle')?.addEventListener('click', () => {
            const body = document.getElementById('war-dashboard-activity-tracker-body');
            const expanded = body && body.style.display === 'block';
            setActivityTrackerSectionExpanded(!expanded);
        });

        document.getElementById('war-dashboard-activity-tracker-load')?.addEventListener('click', () => {
            const factionId = getActivityTrackerFactionIdFromInputs();
            if (!factionId) {
                showError('Enter a Faction ID first.');
                return;
            }
            runActivityTrackerImmediatePull(factionId);
        });

        if (activityTrackerIntervalId) clearInterval(activityTrackerIntervalId);
        activityTrackerIntervalId = setInterval(runActivityTrackerTick, ACTIVITY_INTERVAL_MS);
        nextActivitySampleAt = Date.now() + 5000;
        setTimeout(runActivityTrackerTick, 5000);

        if (activityTrackerCountdownIntervalId) clearInterval(activityTrackerCountdownIntervalId);
        activityTrackerCountdownIntervalId = setInterval(updateActivityCountdown, 1000);
        updateActivityCountdown();

        if (window._warDashboardActivityCloudRefreshId) clearInterval(window._warDashboardActivityCloudRefreshId);
        window._warDashboardActivityCloudRefreshId = setInterval(function () {
            const page = (window.location.hash || '').replace('#', '').split('/')[0];
            if (page !== 'war-dashboard') return;
            const cfg = getActivityConfig();
            cfg.tracked.forEach(function (t) {
                if (!t.enabled) return;
                const fid = String(t.factionId);
                ensureActivityDataLoaded(fid, { force: true }).then(function () {
                    if (document.getElementById('war-dashboard-activity-chart-' + fid)) {
                        renderActivityTrackerChart(fid);
                        renderActivityTrackerTable(fid);
                        updateActivityCloudStatusUI(fid);
                    }
                }).catch(function () {});
            });
        }, ACTIVITY_FIRESTORE_REFRESH_MS);

        // Only run timer when on this page; stop when user navigates away
        function onHashChange() {
            const page = (window.location.hash || '').replace('#', '').split('/')[0];
            if (page !== 'war-dashboard') {
                stopRefreshTimer();
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
            } else {
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
                    window._warDashboardActivityCloudRefreshId = setInterval(function () {
                        const p = (window.location.hash || '').replace('#', '').split('/')[0];
                        if (p !== 'war-dashboard') return;
                        getActivityConfig().tracked.forEach(function (t) {
                            if (!t.enabled) return;
                            const fid = String(t.factionId);
                            ensureActivityDataLoaded(fid, { force: true }).then(function () {
                                if (document.getElementById('war-dashboard-activity-chart-' + fid)) {
                                    renderActivityTrackerChart(fid);
                                    renderActivityTrackerTable(fid);
                                    updateActivityCloudStatusUI(fid);
                                }
                            }).catch(function () {});
                        });
                    }, ACTIVITY_FIRESTORE_REFRESH_MS);
                }
                if (!window._warDashboardChainWatchPollId) {
                    window._warDashboardChainWatchPollId = setInterval(function () {
                        const p = (window.location.hash || '').replace('#', '').split('/')[0];
                        if (p !== 'war-dashboard' || !lastOurFactionId) return;
                        fetchChainWatchData(false).catch(function () {});
                    }, 60 * 1000);
                }
            }
        }
        window.removeEventListener('hashchange', window._warDashboardHashChange);
        window._warDashboardHashChange = onHashChange;
        window.addEventListener('hashchange', onHashChange);

        // Show chains row shell so Chain watch (under Our Chain) is visible before runDashboard finishes.
        showWarDashboardChainsRow();
        updateChainWatchBarVisibility();
        runDashboard();
        startRefreshTimer();
        startChainTick();
        startChainRefreshTimer();
    }

    window.initWarDashboard = initWarDashboard;

    if (!window._warDashToolsMemberIdListener) {
        window._warDashToolsMemberIdListener = true;
        window.addEventListener('toolsMemberIdDisplayChanged', function () {
            if (lastOurMembers && lastOurMembers.length) renderOurTeam(lastOurMembers, lastOurFF, lastOurBS, null);
            if (lastEnemyMembers && lastEnemyMembers.length) renderEnemy(lastEnemyMembers, lastEnemyFF, lastEnemyBS, null);
            try {
                getActivityConfig().tracked.forEach(function (t) {
                    renderActivityTrackerTable(t.factionId);
                });
            } catch (e) { /* ignore */ }
        });
    }
})();
