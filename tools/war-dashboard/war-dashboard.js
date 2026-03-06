/**
 * War Dashboard: enemy selection (current war or custom ID), our team + enemy tables,
 * status/location from v2 faction members, FF from FF Scouter, attack links, filters, auto-refresh.
 */
(function () {
    'use strict';

    const STORAGE_KEYS = {
        enemyFactionId: 'war_dashboard_enemy_faction_id',
        refreshInterval: 'war_dashboard_refresh_interval',
        ffBlue: 'war_dashboard_ff_blue',
        ffGreen: 'war_dashboard_ff_green',
        ffOrange: 'war_dashboard_ff_orange',
        ffNoticeHidden: 'war_dashboard_ff_notice_hidden',
        enemyPickerMinimised: 'war_dashboard_enemy_picker_minimised',
        refreshSectionMinimised: 'war_dashboard_refresh_section_minimised',
        ffSectionMinimised: 'war_dashboard_ff_section_minimised',
        trackOurChain: 'war_dashboard_track_our_chain',
        trackEnemyChain: 'war_dashboard_track_enemy_chain'
    };

    const CHAIN_AT_ZERO_THROTTLE_MS = 60 * 1000; // when chain at 0, only refetch once per minute
    let lastOurChainFetchTime = 0;
    let lastEnemyChainFetchTime = 0;

    const FF_CACHE_PREFIX = 'war_dashboard_ff_';
    const FF_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
    const FF_REFRESH_DAY_KEY = 'war_dashboard_ff_last_refresh_date_'; // + factionId
    const NOTE_PREFIX = 'war_dashboard_note_'; // + player ID, persisted until user clears cache

    let refreshTimer = null;
    let countdownTick = null;
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
    let lastOurFactionId = null;
    let currentUserPlayerId = null;
    let currentUserAbroadCountry = null;
    /** Chain data from API: { current, max, timeout, cooldown, modifier, start, end }. Display state ticks down. */
    let lastOurChain = null;
    let lastEnemyChain = null;
    /** Mutable display state: { timeout, cooldown } ticked every second */
    let ourChainDisplay = { timeout: 0, cooldown: 0 };
    let enemyChainDisplay = { timeout: 0, cooldown: 0 };

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
            const ffText = ff != null ? ff.toFixed(2) : '—';
            const bsText = bs != null ? Number(bs).toLocaleString() : '—';
            return `<tr>
                <td><a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener" style="color: #FFD700;">${escapeHtml(m.name || id)}</a></td>
                <td>${escapeHtml(m.level != null ? String(m.level) : '—')}</td>
                <td style="background-color: ${color || 'transparent'};">${ffText}</td>
                <td>${bsText}</td>
                <td>${escapeHtml(status.actionStatus)}</td>
                <td>${escapeHtml(statusDisplay)}</td>
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
                <label class="war-dashboard-chain-track-wrap" title="Tracking off (reduces API calls): click to turn on. Frequency changed by your auto refresh settings.">
                    <input type="checkbox" class="war-dashboard-chain-track-input" data-chain-key="${escapeHtml(chainKey)}" aria-label="Track this chain" />
                    <span class="war-dashboard-chain-track-slider"></span>
                </label>
                <div class="war-dashboard-chain-title">${escapeHtml(title)}</div>
                <div class="war-dashboard-chain-off-message">Tracking off</div>
            `;
        } else {
            boxEl.innerHTML = `
                <label class="war-dashboard-chain-track-wrap" title="Tracking on (increases API calls): click to turn off. Frequency changed by your auto refresh settings.">
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
                if (on) refreshChainWhenTurningOn(chainKey);
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
            const ffText = ff != null ? ff.toFixed(2) : '—';
            const bsText = bs != null ? Number(bs).toLocaleString() : '—';
            const attackUrl = `https://www.torn.com/loader.php?sid=attack&user2ID=${id}`;
            const noteValue = escapeHtml(getNote(id));
            return `<tr>
                <td><a href="${attackUrl}" target="_blank" rel="noopener" title="Attack">🎯</a> <a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener" style="color: #FFD700;">${escapeHtml(m.name || id)}</a></td>
                <td>${escapeHtml(m.level != null ? String(m.level) : '—')}</td>
                <td style="background-color: ${color || 'transparent'};">${ffText}</td>
                <td>${bsText}</td>
                <td>${escapeHtml(status.actionStatus)}</td>
                <td>${escapeHtml(statusDisplay)}</td>
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
        const blue = localStorage.getItem(STORAGE_KEYS.ffBlue);
        const green = localStorage.getItem(STORAGE_KEYS.ffGreen);
        const orange = localStorage.getItem(STORAGE_KEYS.ffOrange);

        const idInput = document.getElementById('war-dashboard-enemy-faction-id');
        if (idInput) idInput.value = fid;
        const intervalInput = document.getElementById('war-dashboard-refresh-interval');
        if (intervalInput && interval != null) intervalInput.value = interval || '15';
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

            if (!enemyFactionId) {
                showError('Enter an enemy faction ID, or click "Use current ranked war".');
                showLoading(false);
                return;
            }

            // Try to get enemy name from current war for label (optional)
            const current = await getCurrentWarEnemy(apiKey, ourFactionId).catch(() => null);
            if (current && current.enemyFactionId === enemyFactionId) {
                enemyName = current.enemyName;
            }
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

            document.getElementById('war-dashboard-enemy-section').style.display = 'block';
            document.getElementById('war-dashboard-our-team').style.display = 'block';
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
            scheduleNextRefresh();
        }, sec * 1000);
        if (!countdownTick) {
            countdownTick = setInterval(() => {
                if ((window.location.hash || '').replace('#', '').split('/')[0] !== 'war-dashboard') return;
                updateCountdownDisplay();
                updateChainDisplays();
                renderChainBoxes();
                /* Do not re-render enemy/our tables here: it replaces the tbody and recreates note inputs, so the cursor would jump. Only chain boxes and refresh countdown need to tick. */
            }, 1000);
        }
        updateCountdownDisplay();
    }

    function startRefreshTimer() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = null;
        nextRefreshAt = null;
        const page = (window.location.hash || '').replace('#', '').split('/')[0];
        if (page !== 'war-dashboard') return;
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

    function initWarDashboard() {
        if (window.logToolUsage) window.logToolUsage('war-dashboard');

        loadSettings();

        if (localStorage.getItem(STORAGE_KEYS.ffNoticeHidden) === '1') setFFNoticeVisible(false);
        if (localStorage.getItem(STORAGE_KEYS.enemyPickerMinimised) === '1') setEnemyPickerMinimised(true);
        if (localStorage.getItem(STORAGE_KEYS.refreshSectionMinimised) === '1') setRefreshSectionMinimised(true);
        if (localStorage.getItem(STORAGE_KEYS.ffSectionMinimised) === '1') setFFSectionMinimised(true);

        document.getElementById('war-dashboard-hide-ff-notice')?.addEventListener('click', () => setFFNoticeVisible(false));
        document.getElementById('war-dashboard-enemy-picker-toggle')?.addEventListener('click', () => {
            const currently = localStorage.getItem(STORAGE_KEYS.enemyPickerMinimised) === '1';
            setEnemyPickerMinimised(!currently);
        });
        document.getElementById('war-dashboard-refresh-picker-toggle')?.addEventListener('click', () => {
            const currently = localStorage.getItem(STORAGE_KEYS.refreshSectionMinimised) === '1';
            setRefreshSectionMinimised(!currently);
        });
        document.getElementById('war-dashboard-ff-picker-toggle')?.addEventListener('click', () => {
            const currently = localStorage.getItem(STORAGE_KEYS.ffSectionMinimised) === '1';
            setFFSectionMinimised(!currently);
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

        // Only run timer when on this page; stop when user navigates away
        function onHashChange() {
            const page = (window.location.hash || '').replace('#', '').split('/')[0];
            if (page !== 'war-dashboard') stopRefreshTimer();
            else startRefreshTimer();
        }
        window.removeEventListener('hashchange', window._warDashboardHashChange);
        window._warDashboardHashChange = onHashChange;
        window.addEventListener('hashchange', onHashChange);

        runDashboard();
        startRefreshTimer();
    }

    window.initWarDashboard = initWarDashboard;
})();
