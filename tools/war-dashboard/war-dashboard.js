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
    const ACTIVITY_INTERVAL_MS = 5 * 60 * 1000;
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const ACTIVITY_DATA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    /** Firestore collection: one doc per 5-min tick; doc has { t: number, factions: { [factionId]: { onlineIds: number[] } } }. 7-day retention. */
    const ACTIVITY_SAMPLES_COLLECTION = 'activitySamples';
    /** In-memory cache of merged Firestore + localStorage activity data per faction (so getActivityData stays sync). */
    let activityDataCache = {};

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

    /** Get active ranked war for our faction; returns { war, enemyFactionId, enemyName } or null */
    async function getCurrentWarEnemy(apiKey, ourFactionId) {
        const data = await fetchJson(`https://api.torn.com/v2/faction/${ourFactionId}/rankedwars?key=${apiKey}`);
        const raw = data.rankedwars || [];
        const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
        const now = Math.floor(Date.now() / 1000);
        const active = list.find(w => w.start <= now && (!w.end || w.end >= now));
        if (!active || !active.factions || active.factions.length < 2) return null;
        const enemy = active.factions.find(f => String(f.id) !== String(ourFactionId));
        return enemy ? { war: active, enemyFactionId: String(enemy.id), enemyName: enemy.name || `Faction ${enemy.id}` } : null;
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

    /** Get activity data from localStorage only (7-day trim). Used for merge and fallback. */
    function getActivityDataFromStorage(factionId) {
        try {
            const raw = localStorage.getItem(ACTIVITY_DATA_PREFIX + factionId);
            if (!raw) return { samples: [], members: [] };
            const obj = JSON.parse(raw);
            const samples = Array.isArray(obj.samples) ? obj.samples : [];
            const members = Array.isArray(obj.members) ? obj.members : [];
            const cutoff = Date.now() - ACTIVITY_DATA_RETENTION_MS;
            const trimmed = samples.filter(s => s.t >= cutoff);
            return { samples: trimmed, members };
        } catch (e) { return { samples: [], members: [] }; }
    }

    /** Sync: return cached merged data if present, else localStorage (7-day). */
    function getActivityData(factionId) {
        if (activityDataCache[factionId]) return activityDataCache[factionId];
        return getActivityDataFromStorage(factionId);
    }

    /** Load activity samples from Firestore (batched ticks, 7-day retention), merge with local, store in cache. Resolves when done or when Firestore unavailable. */
    async function ensureActivityDataLoaded(factionId) {
        if (activityDataCache[factionId]) return;
        var db = null;
        try {
            if (typeof firebase !== 'undefined' && firebase.firestore) db = firebase.firestore();
        } catch (e) { /* ignore */ }
        if (!db) return;
        const cutoff = Date.now() - ACTIVITY_DATA_RETENTION_MS;
        var firestoreSamples = [];
        try {
            // Firestore may require a composite index on (t). Create it when the console prompts.
            const snap = await db.collection(ACTIVITY_SAMPLES_COLLECTION)
                .where('t', '>=', cutoff)
                .orderBy('t')
                .get();
            const fid = String(factionId);
            snap.docs.forEach(function (doc) {
                const d = doc.data();
                const factions = d.factions || {};
                const factionData = factions[fid];
                if (factionData && Array.isArray(factionData.onlineIds)) {
                    firestoreSamples.push({ t: d.t, onlineIds: factionData.onlineIds });
                }
            });
        } catch (e) {
            console.warn('Activity Firestore read failed for faction', factionId, e);
            return;
        }
        const local = getActivityDataFromStorage(factionId);
        const byT = {};
        (local.samples || []).forEach(function (s) { byT[s.t] = s; });
        firestoreSamples.forEach(function (s) { byT[s.t] = s; });
        const merged = Object.keys(byT).map(function (k) { return byT[k]; }).filter(function (s) { return s.t >= cutoff; }).sort(function (a, b) { return a.t - b.t; });
        activityDataCache[factionId] = { samples: merged, members: local.members || [] };
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

    /** Tell the backend to add/remove this faction for 24/7 sampling. Uses your API key (add) and a persistent userId. */
    function syncTrackedFactionToFirestore(factionId, action) {
        var functions = null;
        try {
            if (typeof firebase !== 'undefined' && firebase.functions) functions = firebase.functions();
        } catch (e) { return; }
        if (!functions) return;
        var fid = String(factionId);
        var uid = getOrCreateActivityUserId();
        if (action === 'add') {
            var apiKey = (getApiKey() || '').trim();
            if (!apiKey) return;
            functions.httpsCallable('addTrackedFaction')({ factionId: fid, apiKey: apiKey, userId: uid }).catch(function () {});
        } else if (action === 'remove') {
            functions.httpsCallable('removeTrackedFaction')({ factionId: fid, userId: uid }).catch(function () {});
        }
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
        const locationDisplay = expired ? 'Okay' : (status.description || status.state || '');
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
            const expired = status.until != null && nowSec >= status.until;
            const statusDisplay = expired ? 'Okay' : (status.description || status.state || '—');
            const color = getFFColor(ff, blue, green, orange);
            const statusColor = getStatusColor(status, nowSec);
            const locationColor = getLocationStateColor(status, nowSec);
            const ffText = ff != null ? ff.toFixed(2) : '—';
            const bsText = bs != null ? Number(bs).toLocaleString() : '—';
            return `<tr>
                <td><a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener" style="color: #FFD700;">${escapeHtml(m.name || id)}</a></td>
                <td>${escapeHtml(m.level != null ? String(m.level) : '—')}</td>
                <td style="background-color: ${color || 'transparent'};">${ffText}</td>
                <td>${bsText}</td>
                <td${statusColor ? ' style="color: ' + statusColor + ';"' : ''}>${escapeHtml(status.actionStatus)}</td>
                <td style="color: ${locationColor};">${escapeHtml(statusDisplay)}</td>
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

    function renderChainBoxes() {
        renderChainBox(
            document.getElementById('war-dashboard-our-chain-box'),
            'Our Chain',
            lastOurChain,
            ourChainDisplay,
            'our'
        );
        renderChainBox(
            document.getElementById('war-dashboard-enemy-chain-box'),
            'Enemy Chain',
            lastEnemyChain,
            enemyChainDisplay,
            'enemy'
        );
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
            const expired = status.until != null && nowSec >= status.until;
            const statusDisplay = expired ? 'Okay' : (status.description || status.state || '—');
            const color = getFFColor(ff, blue, green, orange);
            const statusColor = getStatusColor(status, nowSec);
            const locationColor = getLocationStateColor(status, nowSec);
            const ffText = ff != null ? ff.toFixed(2) : '—';
            const bsText = bs != null ? Number(bs).toLocaleString() : '—';
            const attackUrl = `https://www.torn.com/loader.php?sid=attack&user2ID=${id}`;
            const noteValue = escapeHtml(getNote(id));
            return `<tr>
                <td><a href="${attackUrl}" target="_blank" rel="noopener" title="Attack">🎯</a> <a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener" style="color: #FFD700;">${escapeHtml(m.name || id)}</a></td>
                <td>${escapeHtml(m.level != null ? String(m.level) : '—')}</td>
                <td style="background-color: ${color || 'transparent'};">${ffText}</td>
                <td>${bsText}</td>
                <td${statusColor ? ' style="color: ' + statusColor + ';"' : ''}>${escapeHtml(status.actionStatus)}</td>
                <td style="color: ${locationColor};">${escapeHtml(statusDisplay)}</td>
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
                lastEnemyFactionId = null;
                lastEnemyMembers = [];
                lastEnemyFF = {};
                lastEnemyBS = {};
                lastEnemyChain = null;
                enemyChainDisplay = { timeout: 0, cooldown: 0 };
                const me = ourMembers.find(m => String(m.id) === String(user.playerId));
                currentUserAbroadCountry = me ? parseAbroadCountry(me) : null;
                renderOurTeam(ourMembers, ourFF, ourBS, null);
                renderChainBoxes();
                document.getElementById('war-dashboard-chains-row').style.display = 'block';
                document.getElementById('war-dashboard-our-team').style.display = 'block';
                document.getElementById('war-dashboard-enemy-section').style.display = 'none';
                const activitySection = document.getElementById('war-dashboard-activity-tracker');
                if (activitySection) activitySection.style.display = 'block';
                updateActivityTrackerUI();
                setOurTeamCollapsed(true);
                showError('Enter an enemy faction ID or click "Use current ranked war" to compare.');
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
            lastEnemyFactionId = enemyFactionId;
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

            document.getElementById('war-dashboard-chains-row').style.display = 'block';
            document.getElementById('war-dashboard-enemy-section').style.display = 'block';
            document.getElementById('war-dashboard-our-team').style.display = 'block';
            const activitySection = document.getElementById('war-dashboard-activity-tracker');
            if (activitySection) activitySection.style.display = 'block';
            updateActivityTrackerUI();
            setOurTeamCollapsed(true);
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
                        return a === 'online' || a === 'idle';
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
                    label: 'Avg. online (per sample)',
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
        tbody.innerHTML = rows.map(row =>
            '<tr><td><a href="https://www.torn.com/profiles.php?XID=' + row.id + '" target="_blank" rel="noopener" style="color: #FFD700;">' + escapeHtml(row.name) + ' [' + escapeHtml(row.id) + ']</a></td><td>' + escapeHtml(String(row.statsDisplay)) + '</td><td>' + row.minutesActive + ' min</td></tr>'
        ).join('');
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

    /** Compute per-player active range in TCT (UTC). Returns { playerId: { first, last } in ms }. */
    function getPlayerActiveRanges(factionId) {
        const data = getActivityData(factionId);
        const byPlayer = {};
        for (const s of data.samples) {
            if (!s.onlineIds) continue;
            for (const id of s.onlineIds) {
                if (!byPlayer[id]) byPlayer[id] = { first: s.t, last: s.t };
                else {
                    if (s.t < byPlayer[id].first) byPlayer[id].first = s.t;
                    if (s.t > byPlayer[id].last) byPlayer[id].last = s.t;
                }
            }
        }
        return byPlayer;
    }

    function formatTctTime(ms) {
        const d = new Date(ms);
        return d.getUTCHours().toString().padStart(2, '0') + ':' + d.getUTCMinutes().toString().padStart(2, '0');
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

    function formatActiveBetween(factionId, playerId) {
        const ranges = getPlayerActiveRanges(factionId);
        const r = ranges[playerId];
        if (!r) return '—';
        return formatTctTime(r.first) + ' – ' + formatTctTime(r.last);
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

    function sortActivityTrackerMembers(members, factionId, by, dir, bsMap, sampleCounts, activeRanges) {
        const sampleHours = 5 / 60;
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
                const tA = activeRanges[idA]?.first ?? 0;
                const tB = activeRanges[idB]?.first ?? 0;
                cmp = tA - tB;
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
        const activeRanges = getPlayerActiveRanges(factionId);
        const sorted = sortActivityTrackerMembers(members, factionId, sort.by, sort.dir, bsMap, sampleCounts, activeRanges);
        const sampleHours = 5 / 60;
        tbody.innerHTML = sorted.map(m => {
            const id = String(m.id);
            const bs = bsMap[id];
            const bsText = bs != null ? Number(bs).toLocaleString() : '—';
            const activeBetween = formatActiveBetween(factionId, id);
            const count = sampleCounts[id] || 0;
            const hoursActive = count > 0 ? formatHoursMinutes(count * sampleHours) : '—';
            return `<tr>
                <td><a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener" style="color: #FFD700;">${escapeHtml(m.name || id)}</a></td>
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
                                <thead><tr><th class="war-dashboard-activity-tracker-sortable" data-column="member" scope="col">Member<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="level" scope="col">Level<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="stats" scope="col">Est. stats<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="hoursActive" scope="col">Hours active (<span class="war-dashboard-activity-hours-tracked" data-faction-id="${escapeHtml(fid)}">—</span> tracked)<span class="war-dashboard-activity-tracker-sort-arrow"></span></th><th class="war-dashboard-activity-tracker-sortable" data-column="activeBetween" scope="col">Active between (TCT)<span class="war-dashboard-activity-tracker-sort-arrow"></span></th></tr></thead>
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
                    await ensureActivityDataLoaded(fid);
                    await ensureActivityTrackerBattleStats(fid);
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
            });

            const clearBtn = block.querySelector('.war-dashboard-activity-faction-clear');
            clearBtn.addEventListener('click', () => {
                const factionLabel = t.factionName || 'Faction ' + fid;
                if (!confirm('Clear all activity data for ' + factionLabel + '? This will remove the activity history and cannot be undone.')) return;
                try { localStorage.removeItem(ACTIVITY_DATA_PREFIX + fid); } catch (e) { /* ignore */ }
                delete activityDataCache[fid];
                t.enabled = false;
                t.disabledAt = Date.now();
                setActivityConfig(config);
                updateActivityTrackerUI();
            });

            const removeBtn = block.querySelector('.war-dashboard-activity-faction-remove');
            removeBtn.addEventListener('click', () => {
                const factionLabel = t.factionName || 'Faction ' + fid;
                if (!confirm('Remove ' + factionLabel + ' from the activity tracker? Its cached data will be cleared. You can add it again later by loading the faction.')) return;
                config.tracked = config.tracked.filter(x => String(x.factionId) !== String(fid));
                try { localStorage.removeItem(ACTIVITY_DATA_PREFIX + fid); } catch (e) { /* ignore */ }
                delete activityDataCache[fid];
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
        });

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
        syncTrackedFactionToFirestore(factionId, 'add');
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
                    return a === 'online' || a === 'idle';
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

    function initWarDashboard() {
        if (window.logToolUsage) window.logToolUsage('war-dashboard');

        loadSettings();
        getActivityConfig().tracked.forEach(function (t) { syncTrackedFactionToFirestore(t.factionId, 'add'); });

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
                    showError('No active ranked war found.');
                    return;
                }
                const idInput = document.getElementById('war-dashboard-enemy-faction-id');
                if (idInput) idInput.value = current.enemyFactionId;
                if (btn) {
                    btn.textContent = `Use current ranked war (vs ${current.enemyName})`;
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
            }
        }
        window.removeEventListener('hashchange', window._warDashboardHashChange);
        window._warDashboardHashChange = onHashChange;
        window.addEventListener('hashchange', onHashChange);

        runDashboard();
        startRefreshTimer();
        startChainTick();
        startChainRefreshTimer();
    }

    window.initWarDashboard = initWarDashboard;
})();
