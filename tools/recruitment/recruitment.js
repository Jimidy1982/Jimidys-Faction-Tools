/**
 * Recruitment Tool: find potential recruits from recent ranked wars.
 * Uses torn/?selections=rankedwars (game-wide), torndown.eu/facList.csv (rank, leader, respect), and war reports for player lists.
 */
(function () {
    'use strict';

    const TORNDOWN_CACHE_KEY = 'recruitment_torndown_faclist_v4';
    const TORNDOWN_CACHE_HOURS = 6;
    const TORNDOWN_URL = 'https://torndown.eu/facList.csv';

    const STORAGE_KEYS = {
        warCount: 'recruitment_war_count',
        winnerFilter: 'recruitment_winner_filter',
        minScore: 'recruitment_min_score',
        rankSelection: 'recruitment_rank_selection',
        filterLeaderHitsBelow: 'recruitment_filter_leader_hits_below',
        leaderHitsBelowValue: 'recruitment_leader_hits_below_value',
        filterFactionRespect: 'recruitment_filter_faction_respect',
        factionRespectBelow: 'recruitment_faction_respect_below',
        filterMinWarHitsCb: 'recruitment_filter_min_war_hits_cb',
        filterMinWarHits: 'recruitment_filter_min_war_hits',
        filterMinScoreCb: 'recruitment_filter_min_score_cb',
        filterMinScore: 'recruitment_filter_min_score',
        sortKey: 'recruitment_sort_key',
        sortDir: 'recruitment_sort_dir',
        clickedPlayers: 'recruitment_clicked_players'
    };

    function getClickedPlayerIds() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.clickedPlayers);
            const arr = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(arr) ? arr.map(String) : []);
        } catch (e) { return new Set(); }
    }

    function saveClickedPlayerId(id) {
        const set = getClickedPlayerIds();
        set.add(String(id));
        try {
            localStorage.setItem(STORAGE_KEYS.clickedPlayers, JSON.stringify([...set]));
        } catch (e) { /* ignore */ }
    }

    let sortKey = 'warScore';
    let sortDir = -1; // -1 desc, 1 asc

    let rankedWarsList = []; // { warId, factions: { id: { name, score, chain } }, war: { start, end, target, winner } }
    let factionMap = {};     // factionId -> { name, rank, leader, respect }
    let playerList = [];     // { id, name, level, warHits, warScore, factionId, factionName, factionRank, respect, leader, ff, bs }

    function getApiKey() {
        return (localStorage.getItem('tornApiKey') || '').trim();
    }

    /** Parse number from input value (strips thousand separators). */
    function parseNumInput(val) {
        const s = String(val || '').replace(/,/g, '').trim();
        return s === '' ? NaN : parseFloat(s, 10);
    }

    /** Format number for display in input (thousand separators). */
    function formatNumInput(val) {
        const n = parseNumInput(val);
        if (!Number.isFinite(n)) return '';
        return n.toLocaleString(undefined, { maximumFractionDigits: 10 });
    }

    function escapeHtml(str) {
        if (str == null) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /** Simple CSV parse: first line = headers, map rows to objects. Handles quoted fields. */
    function parseCsv(text) {
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) return [];
        const headers = parseCsvLine(lines[0]);
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const values = parseCsvLine(lines[i]);
            const row = {};
            headers.forEach((h, j) => { row[h] = values[j] != null ? values[j] : ''; });
            rows.push(row);
        }
        return rows;
    }

    function parseCsvLine(line) {
        const out = [];
        let i = 0;
        while (i < line.length) {
            if (line[i] === '"') {
                let end = line.indexOf('"', i + 1);
                while (end !== -1 && line[end + 1] === '"') end = line.indexOf('"', end + 2);
                out.push(end === -1 ? line.slice(i + 1) : line.slice(i + 1, end).replace(/""/g, '"'));
                i = end === -1 ? line.length : end + 2;
            } else {
                const comma = line.indexOf(',', i);
                const val = comma === -1 ? line.slice(i) : line.slice(i, comma);
                out.push(val.trim());
                i = comma === -1 ? line.length : comma + 1;
            }
        }
        return out;
    }

    /** Fetch torndown facList.csv; return map factionId -> { name, rank, leader, respect }. Use cache. */
    async function fetchTorndownFacList() {
        try {
            const cached = localStorage.getItem(TORNDOWN_CACHE_KEY);
            if (cached) {
                const { data, at } = JSON.parse(cached);
                if (Date.now() - at < TORNDOWN_CACHE_HOURS * 60 * 60 * 1000) return data;
            }
        } catch (e) { /* ignore */ }

        const res = await fetch(TORNDOWN_URL);
        if (!res.ok) throw new Error('Torndown faction list failed: ' + res.status + ' (try again later)');
        const text = await res.text();
        const rows = parseCsv(text);
        const map = {};
        if (!rows.length) return map;
        const headers = Object.keys(rows[0]);
        const getHeader = (patterns) => headers.find(h => patterns.some(p => new RegExp(p, 'i').test(String(h).trim())));
        // torndown facList.csv: "ID","respect","name","leader","rank","division","leader_name",...
        const idHeader = getHeader(['^id$', 'faction[_\\s]?id', 'factionid']) || headers[0];
        const nameHeader = getHeader(['^name$', 'faction[_\\s]?name']) || 'name';
        const rankHeader = getHeader(['^rank$', 'tier']) || 'rank';
        const divisionHeader = getHeader(['^division$', 'div', 'rank[_\\s]?division', 'tier[_\\s]?div']);
        const leaderHeader = getHeader(['leader_name', 'leader[_\\s]?name']) || getHeader(['leader', 'leader[_\\s]?id', 'leaderid']) || 'leader';
        const respectHeader = getHeader(['respect', '^rep$']) || 'respect';

        rows.forEach(row => {
            const rawId = row[idHeader];
            const id = String(rawId != null ? rawId : '').trim();
            if (!id) return;
            let rankStr = String(row[rankHeader] != null ? row[rankHeader] : '').trim();
            if (divisionHeader) {
                const divStr = String(row[divisionHeader] != null ? row[divisionHeader] : '').trim();
                if (divStr && divStr !== '0') {
                    rankStr = rankStr ? `${rankStr} ${divStr}` : divStr;
                }
            }
            map[id] = {
                name: String(row[nameHeader] != null ? row[nameHeader] : '').trim(),
                rank: rankStr,
                leader: String(row[leaderHeader] != null ? row[leaderHeader] : '').trim(),
                respect: String(row[respectHeader] != null ? row[respectHeader] : '').trim()
            };
        });

        try {
            localStorage.setItem(TORNDOWN_CACHE_KEY, JSON.stringify({ data: map, at: Date.now() }));
        } catch (e) { /* ignore */ }
        return map;
    }

    /** Fetch torn/?selections=rankedwars; return array of wars sorted by end desc. */
    async function fetchTornRankedWars(apiKey) {
        const url = `https://api.torn.com/torn/?selections=rankedwars&key=${apiKey}`;
        const fn = window.fetchWithRateLimit;
        const data = fn ? await fn(url) : await fetch(url).then(r => r.json());
        if (data.error) throw new Error(data.error.error || 'Torn API error');
        const raw = data.rankedwars || {};
        const list = Object.entries(raw).map(([warId, w]) => ({
            warId,
            factions: w.factions || {},
            war: w.war || {}
        })).filter(w => w.war && w.war.end > 0).sort((a, b) => (b.war.end || 0) - (a.war.end || 0));
        return list;
    }

    /** Normalise members to array (API may return object keyed by player id). Preserve id from key when object. */
    function getMembersList(fac) {
        const m = fac.members;
        if (!m) return [];
        if (Array.isArray(m)) return m;
        return Object.entries(m).map(([pid, member]) => {
            const obj = typeof member === 'object' && member !== null ? { ...member } : { name: String(member) };
            if (obj.id == null) obj.id = pid;
            if (obj.user_id == null) obj.user_id = pid;
            return obj;
        });
    }

    /** Fetch single war report torn/{warId}?selections=rankedwarreport (used when not batching). */
    async function fetchWarReport(apiKey, warId, progressOpts) {
        const url = `https://api.torn.com/torn/${warId}?selections=rankedwarreport&key=${apiKey}`;
        const fn = window.fetchWithRateLimit;
        const data = fn
            ? await fn(url, progressOpts)
            : await fetch(url).then(r => r.json());
        if (data.error) throw new Error(data.error.error || 'Torn API error');
        return data.rankedwarreport || null;
    }

    const FETCH_MORE_INCREMENT = 50;

    /** Process one war report into playerMap and leaderWarHits. Mutates both. warId used for rankreport link. */
    function processOneWarReport(report, opts, warId) {
        const { playerMap, leaderWarHits, winnerFilter, selectedRanks } = opts;
        if (!report || !report.factions) return;
        const rankId = warId != null ? String(warId) : '';
        const winnerId = report.war && report.war.winner != null ? String(report.war.winner) : null;
        const factions = report.factions;
        const fids = Object.keys(factions);
        const scoreEntries = fids.map(fid => ({
            fid,
            score: parseFloat(factions[fid].score != null ? factions[fid].score : factions[fid].chain || 0) || 0
        }));
        const winnerEntry = scoreEntries.find(s => s.fid === winnerId);
        const loserEntry = scoreEntries.find(s => s.fid !== winnerId);
        const winnerScore = winnerEntry ? winnerEntry.score : (scoreEntries.length ? Math.max(...scoreEntries.map(s => s.score)) : 0);
        const loserScore = loserEntry ? loserEntry.score : (scoreEntries.length ? Math.min(...scoreEntries.map(s => s.score)) : 0);
        const warResultText = scoreEntries.length ? `${Number(winnerScore).toLocaleString()} - ${Number(loserScore).toLocaleString()}` : '—';

        for (const fid of fids) {
            const fac = factions[fid];
            const facWarScoreRaw = fac.score != null ? fac.score : fac.chain;
            const facWarScore = facWarScoreRaw != null && String(facWarScoreRaw).trim() !== '' ? parseFloat(facWarScoreRaw) : null;
            const facWarScoreNum = Number.isFinite(facWarScore) ? facWarScore : null;
            if (winnerFilter === 'winners' && winnerId !== fid) continue;
            if (winnerFilter === 'losers' && winnerId === fid) continue;
            const facInfo = factionMap[fid];
            if (selectedRanks.length && (!facInfo || !facInfo.rank || !rankMatchesSelected(facInfo.rank, selectedRanks))) continue;
            const members = getMembersList(fac);
            const leaderName = (facInfo && facInfo.leader) ? String(facInfo.leader).trim() : '';
            for (const m of members) {
                const rawId = m.id ?? m.user_id;
                const pid = rawId != null ? String(rawId).trim() : '';
                if (!pid || pid === 'undefined' || !/^\d+$/.test(pid)) continue;
                const score = parseFloat(m.score || m.points || 0) || 0;
                if (score < opts.minScore) continue;
                const attacks = parseInt(m.attacks || 0, 10) || 0;
                const level = parseInt(m.level || 0, 10) || 0;
                const name = (m.name || '').trim() || pid;
                if (leaderName && name === leaderName) {
                    leaderWarHits[fid] = (leaderWarHits[fid] || 0) + attacks;
                }
                if (!playerMap[pid]) {
                    playerMap[pid] = {
                        id: pid,
                        name,
                        level,
                        warHits: 0,
                        warScore: 0,
                        factionId: fid,
                        factionName: (facInfo && facInfo.name) || (fac.name || fid),
                        factionRank: (facInfo && facInfo.rank) || '—',
                        respect: (facInfo && facInfo.respect) || '—',
                        leader: (facInfo && facInfo.leader) || '—',
                        rankId: rankId || null,
                        warResultText: warResultText
                    };
                }
                playerMap[pid].warHits += attacks;
                if (score > playerMap[pid].warScore) {
                    playerMap[pid].warScore = score;
                    if (rankId) playerMap[pid].rankId = rankId;
                    playerMap[pid].warResultText = warResultText;
                }
            }
        }
    }

    /** Process a list of wars and merge into existing playerMap and leaderWarHits. Uses app batching for speed. */
    async function processWarsIntoPlayerMap(apiKey, warsToProcess, opts, progressOpts) {
        const { playerMap, leaderWarHits, winnerFilter, minScore, selectedRanks } = opts;
        const total = warsToProcess.length;
        if (total === 0) return;

        setProgress(true, 'Loading war reports…', `0 / ${total} wars`);

        const batchFn = window.batchApiCallsWithRateLimit;
        if (typeof batchFn !== 'function') {
            for (let i = 0; i < total; i++) {
                setProgress(true, 'Loading war reports…', `${i + 1} / ${total} wars`);
                try {
                    const wid = warsToProcess[i].warId;
                    const report = await fetchWarReport(apiKey, wid, progressOpts);
                    processOneWarReport(report, opts, wid);
                } catch (err) {
                    console.warn('Recruitment: war report failed for ' + warsToProcess[i].warId, err);
                }
            }
            return;
        }

        const requests = warsToProcess.map(w => ({
            url: `https://api.torn.com/torn/${w.warId}?selections=rankedwarreport&key=${apiKey}`,
            warId: w.warId
        }));

        const results = await batchFn(requests, {
            progressMessage: progressOpts.progressMessage || null,
            progressDetails: progressOpts.progressDetails || null
        });

        for (let i = 0; i < (results && results.length) ? results.length : 0; i++) {
            const r = results[i];
            const report = (r && r.success && r.data) ? (r.data.rankedwarreport || null) : null;
            const wid = warsToProcess[i] && warsToProcess[i].warId;
            processOneWarReport(report, opts, wid);
        }
    }

    function setStatus(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text || '';
    }

    function setProgress(show, message, details) {
        const wrap = document.getElementById('recruitment-progress');
        const msg = document.getElementById('recruitment-progress-message');
        const det = document.getElementById('recruitment-progress-details');
        if (wrap) wrap.style.display = show ? 'block' : 'none';
        if (msg) msg.textContent = message || '';
        if (det) det.textContent = details || '';
    }

    function setError(text) {
        const el = document.getElementById('recruitment-error');
        if (el) {
            el.textContent = text || '';
            el.style.display = text ? 'block' : 'none';
        }
    }

    function getSelectedRanks() {
        const checked = document.querySelectorAll('#recruitment-rank-checkboxes input:checked');
        return Array.from(checked).map(cb => cb.value);
    }

    /** Parse respect string (e.g. "1,234,567" or "277640") to number. */
    function parseRespect(str) {
        if (str == null || str === '') return NaN;
        const n = parseFloat(String(str).replace(/,/g, ''), 10);
        return Number.isFinite(n) ? n : NaN;
    }

    /** Get filtered and sorted list for display. Uses result filters and current sort. */
    function getDisplayList() {
        if (!playerList.length) return [];
        let list = playerList.slice();

        const leaderHitsBelowOn = document.getElementById('recruitment-filter-leader-hits-below')?.checked;
        const leaderHitsBelowVal = Math.floor(parseNumInput(document.getElementById('recruitment-leader-hits-below')?.value || '10') || 10);
        if (leaderHitsBelowOn && Number.isFinite(leaderHitsBelowVal) && leaderHitsBelowVal >= 0) {
            const maxLeaderHits = leaderHitsBelowVal;
            list = list.filter(p => p.leaderWarHits == null || p.leaderWarHits < maxLeaderHits);
        }

        const factionRespectOn = document.getElementById('recruitment-filter-faction-respect')?.checked;
        if (factionRespectOn) {
            const respectAboveVal = parseNumInput(document.getElementById('recruitment-faction-respect-below')?.value);
            if (Number.isFinite(respectAboveVal) && respectAboveVal >= 0) {
                list = list.filter(p => {
                    const r = parseRespect(p.respect);
                    return !Number.isFinite(r) || r <= respectAboveVal;
                });
            }
        }

        const minWarHitsOn = document.getElementById('recruitment-filter-min-war-hits-cb')?.checked;
        if (minWarHitsOn) {
            const minHits = Math.floor(parseNumInput(document.getElementById('recruitment-filter-min-war-hits')?.value) || 0);
            if (Number.isFinite(minHits) && minHits > 0) {
                list = list.filter(p => (p.warHits || 0) >= minHits);
            }
        }

        const minScoreOn = document.getElementById('recruitment-filter-min-score-cb')?.checked;
        if (minScoreOn) {
            const minScoreFilter = parseNumInput(document.getElementById('recruitment-filter-min-score')?.value);
            if (Number.isFinite(minScoreFilter) && minScoreFilter > 0) {
                list = list.filter(p => (p.warScore || 0) >= minScoreFilter);
            }
        }

        const key = sortKey || 'warScore';
        const dir = sortDir === 1 ? 1 : -1;
        list.sort((a, b) => {
            let va = a[key];
            let vb = b[key];
            if (key === 'respectNum') {
                va = parseRespect(a.respect);
                vb = parseRespect(b.respect);
            }
            if (key === 'name' || key === 'factionName' || key === 'factionRank' || key === 'leader') {
                va = (va ?? '').toString().toLowerCase();
                vb = (vb ?? '').toString().toLowerCase();
                return dir * (va < vb ? -1 : va > vb ? 1 : 0);
            }
            if (key === 'bs') {
                va = a.bs != null ? Number(a.bs) : -1;
                vb = b.bs != null ? Number(b.bs) : -1;
            } else {
                va = Number(va);
                vb = Number(vb);
                if (!Number.isFinite(va)) va = -Infinity;
                if (!Number.isFinite(vb)) vb = -Infinity;
            }
            return dir * (va - vb);
        });
        return list;
    }

    function loadSelections() {
        const warCountEl = document.getElementById('recruitment-war-count');
        const winnerEl = document.getElementById('recruitment-winner-filter');
        const minScoreEl = document.getElementById('recruitment-min-score');
        if (warCountEl) { const v = localStorage.getItem(STORAGE_KEYS.warCount); if (v !== null) warCountEl.value = v; }
        if (winnerEl) { const v = localStorage.getItem(STORAGE_KEYS.winnerFilter); if (v !== null) winnerEl.value = v; }
        if (minScoreEl) { const v = localStorage.getItem(STORAGE_KEYS.minScore); if (v !== null) minScoreEl.value = v; }
        const leaderHitsBelowEl = document.getElementById('recruitment-filter-leader-hits-below');
        if (leaderHitsBelowEl) { const v = localStorage.getItem(STORAGE_KEYS.filterLeaderHitsBelow); leaderHitsBelowEl.checked = v === '1'; }
        const leaderHitsBelowValEl = document.getElementById('recruitment-leader-hits-below');
        if (leaderHitsBelowValEl) { const v = localStorage.getItem(STORAGE_KEYS.leaderHitsBelowValue); if (v !== null) leaderHitsBelowValEl.value = formatNumInput(v) || v; }
        const factionRespectCb = document.getElementById('recruitment-filter-faction-respect');
        if (factionRespectCb) { const v = localStorage.getItem(STORAGE_KEYS.filterFactionRespect); factionRespectCb.checked = v === '1'; }
        const factionRespectBelowEl = document.getElementById('recruitment-faction-respect-below');
        if (factionRespectBelowEl) { const v = localStorage.getItem(STORAGE_KEYS.factionRespectBelow); if (v !== null) factionRespectBelowEl.value = formatNumInput(v) || v; }
        const minWarHitsCb = document.getElementById('recruitment-filter-min-war-hits-cb');
        if (minWarHitsCb) { const v = localStorage.getItem(STORAGE_KEYS.filterMinWarHitsCb); minWarHitsCb.checked = v === '1'; }
        const minWarHitsEl = document.getElementById('recruitment-filter-min-war-hits');
        if (minWarHitsEl) { const v = localStorage.getItem(STORAGE_KEYS.filterMinWarHits); if (v !== null) minWarHitsEl.value = formatNumInput(v) || v; }
        const minScoreCb = document.getElementById('recruitment-filter-min-score-cb');
        if (minScoreCb) { const v = localStorage.getItem(STORAGE_KEYS.filterMinScoreCb); minScoreCb.checked = v === '1'; }
        const minScoreFilterEl = document.getElementById('recruitment-filter-min-score');
        if (minScoreFilterEl) { const v = localStorage.getItem(STORAGE_KEYS.filterMinScore); if (v !== null) minScoreFilterEl.value = formatNumInput(v) || v; }
        const sk = localStorage.getItem(STORAGE_KEYS.sortKey);
        const sd = localStorage.getItem(STORAGE_KEYS.sortDir);
        if (sk) sortKey = sk;
        if (sd) sortDir = parseInt(sd, 10) === 1 ? 1 : -1;
        restoreRankCheckboxes();
        updateResultFilterVisibility();
    }

    /** Show/hide conditional inputs based on checkbox state. */
    function updateResultFilterVisibility() {
        const leaderWrap = document.getElementById('recruitment-leader-hits-below-wrap');
        if (leaderWrap) leaderWrap.style.display = document.getElementById('recruitment-filter-leader-hits-below')?.checked ? 'inline' : 'none';
        const respectWrap = document.getElementById('recruitment-faction-respect-wrap');
        if (respectWrap) respectWrap.style.display = document.getElementById('recruitment-filter-faction-respect')?.checked ? 'inline' : 'none';
        const minWarHitsWrap = document.getElementById('recruitment-min-war-hits-wrap');
        if (minWarHitsWrap) minWarHitsWrap.style.display = document.getElementById('recruitment-filter-min-war-hits-cb')?.checked ? 'inline' : 'none';
        const minScoreWrap = document.getElementById('recruitment-min-score-wrap');
        if (minScoreWrap) minScoreWrap.style.display = document.getElementById('recruitment-filter-min-score-cb')?.checked ? 'inline' : 'none';
    }

    function saveSelections() {
        const warCountEl = document.getElementById('recruitment-war-count');
        const winnerEl = document.getElementById('recruitment-winner-filter');
        const minScoreEl = document.getElementById('recruitment-min-score');
        if (warCountEl) localStorage.setItem(STORAGE_KEYS.warCount, warCountEl.value);
        if (winnerEl) localStorage.setItem(STORAGE_KEYS.winnerFilter, winnerEl.value);
        if (minScoreEl) localStorage.setItem(STORAGE_KEYS.minScore, minScoreEl.value);
        const leaderHitsBelowEl = document.getElementById('recruitment-filter-leader-hits-below');
        if (leaderHitsBelowEl) localStorage.setItem(STORAGE_KEYS.filterLeaderHitsBelow, leaderHitsBelowEl.checked ? '1' : '0');
        const leaderHitsBelowValEl = document.getElementById('recruitment-leader-hits-below');
        if (leaderHitsBelowValEl) localStorage.setItem(STORAGE_KEYS.leaderHitsBelowValue, String(leaderHitsBelowValEl.value).replace(/,/g, ''));
        const factionRespectCb = document.getElementById('recruitment-filter-faction-respect');
        if (factionRespectCb) localStorage.setItem(STORAGE_KEYS.filterFactionRespect, factionRespectCb.checked ? '1' : '0');
        const factionRespectBelowEl = document.getElementById('recruitment-faction-respect-below');
        if (factionRespectBelowEl) localStorage.setItem(STORAGE_KEYS.factionRespectBelow, String(factionRespectBelowEl.value).replace(/,/g, ''));
        const minWarHitsCb = document.getElementById('recruitment-filter-min-war-hits-cb');
        if (minWarHitsCb) localStorage.setItem(STORAGE_KEYS.filterMinWarHitsCb, minWarHitsCb.checked ? '1' : '0');
        const minWarHitsEl = document.getElementById('recruitment-filter-min-war-hits');
        if (minWarHitsEl) localStorage.setItem(STORAGE_KEYS.filterMinWarHits, String(minWarHitsEl.value).replace(/,/g, ''));
        const minScoreCb = document.getElementById('recruitment-filter-min-score-cb');
        if (minScoreCb) localStorage.setItem(STORAGE_KEYS.filterMinScoreCb, minScoreCb.checked ? '1' : '0');
        const minScoreFilterEl = document.getElementById('recruitment-filter-min-score');
        if (minScoreFilterEl) localStorage.setItem(STORAGE_KEYS.filterMinScore, String(minScoreFilterEl.value).replace(/,/g, ''));
        localStorage.setItem(STORAGE_KEYS.sortKey, sortKey);
        localStorage.setItem(STORAGE_KEYS.sortDir, String(sortDir));
        try {
            localStorage.setItem(STORAGE_KEYS.rankSelection, JSON.stringify(getSelectedRanks()));
        } catch (e) { /* ignore */ }
    }

    function restoreRankCheckboxes() {
        let saved = [];
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.rankSelection);
            if (raw) saved = JSON.parse(raw);
        } catch (e) { /* ignore */ }
        if (!Array.isArray(saved)) saved = [];
        const container = document.getElementById('recruitment-rank-checkboxes');
        if (!container) return;
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = saved.includes(cb.value);
        });
    }

    const RANK_ORDER = ['Diamond', 'Platinum', 'Gold', 'Silver', 'Bronze', 'Unranked'];

    /** Return true if faction rank (e.g. "Gold 2") matches selected base rank (e.g. "Gold"). */
    function rankMatchesSelected(factionRank, selectedRanks) {
        if (!factionRank || !selectedRanks.length) return false;
        const r = String(factionRank).trim();
        return selectedRanks.some(base => r === base || r.startsWith(base + ' '));
    }

    function renderRankCheckboxes() {
        const sorted = RANK_ORDER.slice();
        const container = document.getElementById('recruitment-rank-checkboxes');
        if (!container) return;
        container.innerHTML = sorted.map(r => `<label style="margin-right: 12px;"><input type="checkbox" value="${escapeHtml(r)}"> ${escapeHtml(r)}</label>`).join('') || '<span style="color:#888;">No ranks in faction list</span>';
        restoreRankCheckboxes();
    }

    function initRecruitment() {
        const fetchWarsBtn = document.getElementById('recruitment-fetch-wars');
        const buildListBtn = document.getElementById('recruitment-build-list');
        const battleStatsBtn = document.getElementById('recruitment-fetch-battle-stats');

        fetchWarsBtn?.addEventListener('click', async () => {
            const apiKey = getApiKey();
            if (!apiKey) { setError('Please enter your API key in the sidebar.'); return; }
            setError('');
            setStatus('recruitment-step1-status', 'Fetching…');
            setProgress(true, 'Fetching wars and faction list…', '');

            try {
                const count = Math.max(1, Math.min(500, parseInt(document.getElementById('recruitment-war-count')?.value || '100', 10)));
                const [wars, facList] = await Promise.all([
                    fetchTornRankedWars(apiKey),
                    fetchTorndownFacList()
                ]);
                rankedWarsList = wars.slice(0, count);
                factionMap = facList;
                setStatus('recruitment-step1-status', `Loaded ${rankedWarsList.length} wars and ${Object.keys(factionMap).length} factions (torndown).`);
                setProgress(false);
                renderRankCheckboxes();
            } catch (e) {
                let msg = e.message || 'Failed to fetch.';
                if (msg === 'Failed to fetch' || (e.name && e.name === 'TypeError')) {
                    msg = 'Torn API request failed (often CORS or timeout). Try again in a few minutes; if you\'re on localhost, the browser may block cross-origin requests to api.torn.com.';
                }
                setError(msg);
                setStatus('recruitment-step1-status', '');
                setProgress(false);
            }
        });

        buildListBtn?.addEventListener('click', async () => {
            const apiKey = getApiKey();
            if (!apiKey) { setError('Please enter your API key in the sidebar.'); return; }
            if (!rankedWarsList.length) { setError('Run Step 1 first.'); return; }

            setError('');
            const winnerFilter = document.getElementById('recruitment-winner-filter')?.value || 'both';
            const minScore = Math.max(0, parseFloat(document.getElementById('recruitment-min-score')?.value || '0') || 0);
            const selectedRanks = getSelectedRanks();

            const playerMap = {};
            const leaderWarHits = {};
            const progressMsg = document.getElementById('recruitment-progress-message');
            const progressDet = document.getElementById('recruitment-progress-details');
            const progressOpts = progressMsg && progressDet ? { progressMessage: progressMsg, progressDetails: progressDet } : {};

            await processWarsIntoPlayerMap(apiKey, rankedWarsList, {
                playerMap,
                leaderWarHits,
                winnerFilter,
                minScore,
                selectedRanks
            }, progressOpts);

            playerList = Object.values(playerMap).sort((a, b) => (b.warScore - a.warScore));
            playerList.forEach(p => {
                p.leaderWarHits = leaderWarHits[p.factionId] != null ? leaderWarHits[p.factionId] : null;
            });
            const filterMinScoreEl = document.getElementById('recruitment-filter-min-score');
            const filterMinScoreCb = document.getElementById('recruitment-filter-min-score-cb');
            if (filterMinScoreEl) {
                filterMinScoreEl.value = minScore > 0 ? formatNumInput(minScore) : '';
                if (filterMinScoreCb) {
                    filterMinScoreCb.checked = minScore > 0;
                    updateResultFilterVisibility();
                }
                saveSelections();
            }
            setProgress(false);
            setStatus('recruitment-step2-status', `Found ${playerList.length} players.`);
            renderTable();
            const detailsBtn = document.getElementById('recruitment-fetch-player-details');
            if (battleStatsBtn) battleStatsBtn.disabled = playerList.length === 0;
            if (detailsBtn) detailsBtn.disabled = playerList.length === 0;
            const fetchMoreBtn = document.getElementById('recruitment-fetch-more');
            if (fetchMoreBtn) fetchMoreBtn.disabled = false;
        });

        const fetchMoreBtn = document.getElementById('recruitment-fetch-more');
        fetchMoreBtn?.addEventListener('click', async () => {
            const apiKey = getApiKey();
            if (!apiKey) { setError('Please enter your API key in the sidebar.'); return; }
            if (!rankedWarsList.length) { setError('Run Step 1 first.'); return; }

            setError('');
            const winnerFilter = document.getElementById('recruitment-winner-filter')?.value || 'both';
            const minScore = Math.max(0, parseFloat(document.getElementById('recruitment-min-score')?.value || '0') || 0);
            const selectedRanks = getSelectedRanks();

            setProgress(true, 'Fetching more wars…', '');
            let allWars;
            try {
                allWars = await fetchTornRankedWars(apiKey);
            } catch (e) {
                setError(e.message || 'Failed to fetch wars.');
                setProgress(false);
                return;
            }
            const currentCount = rankedWarsList.length;
            const newCount = Math.min(currentCount + FETCH_MORE_INCREMENT, allWars.length);
            const warsToProcess = allWars.slice(currentCount, newCount);
            if (warsToProcess.length === 0) {
                setProgress(false);
                setStatus('recruitment-step2-status', 'No more wars to add.');
                return;
            }

            const playerMap = {};
            const leaderWarHits = {};
            playerList.forEach(p => {
                playerMap[p.id] = { ...p };
                if (p.leaderWarHits != null) leaderWarHits[p.factionId] = p.leaderWarHits;
            });

            const progressMsg = document.getElementById('recruitment-progress-message');
            const progressDet = document.getElementById('recruitment-progress-details');
            const progressOpts = progressMsg && progressDet ? { progressMessage: progressMsg, progressDetails: progressDet } : {};
            await processWarsIntoPlayerMap(apiKey, warsToProcess, {
                playerMap,
                leaderWarHits,
                winnerFilter,
                minScore,
                selectedRanks
            }, progressOpts);

            rankedWarsList = allWars.slice(0, newCount);
            playerList = Object.values(playerMap).sort((a, b) => (b.warScore - a.warScore));
            playerList.forEach(p => {
                p.leaderWarHits = leaderWarHits[p.factionId] != null ? leaderWarHits[p.factionId] : null;
            });

            const warCountEl = document.getElementById('recruitment-war-count');
            if (warCountEl) warCountEl.value = String(newCount);
            saveSelections();
            setProgress(false);
            setStatus('recruitment-step2-status', `Found ${playerList.length} players (${rankedWarsList.length} wars).`);
            renderTable();
            const detailsBtn = document.getElementById('recruitment-fetch-player-details');
            if (battleStatsBtn) battleStatsBtn.disabled = playerList.length === 0;
            if (detailsBtn) detailsBtn.disabled = playerList.length === 0;
        });

        document.getElementById('recruitment-war-count')?.addEventListener('change', saveSelections);
        document.getElementById('recruitment-war-count')?.addEventListener('input', saveSelections);
        document.getElementById('recruitment-winner-filter')?.addEventListener('change', saveSelections);
        document.getElementById('recruitment-min-score')?.addEventListener('change', saveSelections);
        document.getElementById('recruitment-min-score')?.addEventListener('input', saveSelections);
        document.getElementById('recruitment-rank-checkboxes')?.addEventListener('change', saveSelections);

        function applyResultFiltersAndSave() {
            renderTable();
            saveSelections();
        }
        document.getElementById('recruitment-filter-leader-hits-below')?.addEventListener('change', () => {
            updateResultFilterVisibility();
            applyResultFiltersAndSave();
        });
        function formatInputOnBlur(el) {
            if (!el) return;
            el.addEventListener('blur', () => {
                const formatted = formatNumInput(el.value);
                if (formatted !== '') el.value = formatted;
                applyResultFiltersAndSave();
            });
        }
        formatInputOnBlur(document.getElementById('recruitment-leader-hits-below'));
        formatInputOnBlur(document.getElementById('recruitment-faction-respect-below'));
        formatInputOnBlur(document.getElementById('recruitment-filter-min-war-hits'));
        formatInputOnBlur(document.getElementById('recruitment-filter-min-score'));

        document.getElementById('recruitment-leader-hits-below')?.addEventListener('input', applyResultFiltersAndSave);
        document.getElementById('recruitment-leader-hits-below')?.addEventListener('change', applyResultFiltersAndSave);
        document.getElementById('recruitment-filter-faction-respect')?.addEventListener('change', () => {
            updateResultFilterVisibility();
            applyResultFiltersAndSave();
        });
        document.getElementById('recruitment-faction-respect-below')?.addEventListener('input', applyResultFiltersAndSave);
        document.getElementById('recruitment-faction-respect-below')?.addEventListener('change', applyResultFiltersAndSave);
        document.getElementById('recruitment-filter-min-war-hits-cb')?.addEventListener('change', () => {
            updateResultFilterVisibility();
            applyResultFiltersAndSave();
        });
        document.getElementById('recruitment-filter-min-war-hits')?.addEventListener('input', applyResultFiltersAndSave);
        document.getElementById('recruitment-filter-min-war-hits')?.addEventListener('change', applyResultFiltersAndSave);
        document.getElementById('recruitment-filter-min-score-cb')?.addEventListener('change', () => {
            updateResultFilterVisibility();
            applyResultFiltersAndSave();
        });
        document.getElementById('recruitment-filter-min-score')?.addEventListener('input', applyResultFiltersAndSave);
        document.getElementById('recruitment-filter-min-score')?.addEventListener('change', applyResultFiltersAndSave);

        document.getElementById('recruitment-table')?.addEventListener('click', (e) => {
            const th = e.target.closest('th.recruitment-sort');
            if (th) {
                const k = th.getAttribute('data-sort');
                if (!k) return;
                if (sortKey === k) sortDir = sortDir === 1 ? -1 : 1;
                else { sortKey = k; sortDir = -1; }
                saveSelections();
                renderTable();
                return;
            }
            const link = e.target.closest('a[data-player-id].recruitment-player-link');
            if (link) {
                const id = link.getAttribute('data-player-id');
                if (id) {
                    saveClickedPlayerId(id);
                    const row = link.closest('tr');
                    const cb = row?.querySelector('input.recruitment-contacted-cb');
                    if (cb) cb.checked = true;
                }
            }
        });

        loadSelections();

        battleStatsBtn?.addEventListener('click', async () => {
            const apiKey = getApiKey();
            if (!apiKey || !playerList.length) return;
            const fn = window.getFFAndBattleStatsForMembers;
            if (typeof fn !== 'function') { setError('FF Scouter not available. Load Faction Battle Stats or ensure app is ready.'); return; }

            setError('');
            setProgress(true, 'Fetching battle stats from FF Scouter…', playerList.length + ' players');
            try {
                const ids = playerList.map(p => p.id).filter(id => id != null && String(id).trim() !== '' && /^\d+$/.test(String(id)));
                if (ids.length === 0) { setError('No valid player IDs to look up (IDs must be positive integers).'); setProgress(false); return; }
                const { ff, bs } = await fn(apiKey, ids);
                playerList.forEach(p => {
                    p.ff = ff[p.id] != null ? ff[p.id] : null;
                    p.bs = bs[p.id] != null ? bs[p.id] : null;
                });
                renderTable();
            } catch (e) {
                setError(e.message || 'FF Scouter failed.');
            }
            setProgress(false);
        });

        document.getElementById('recruitment-fetch-player-details')?.addEventListener('click', async () => {
            const apiKey = getApiKey();
            if (!apiKey) { setError('Please enter your API key in the sidebar.'); return; }

            const list = getDisplayList();
            const ids = list.map(p => p.id).filter(id => id != null && String(id).trim() !== '' && /^\d+$/.test(String(id)));
            if (ids.length === 0) {
                setError('No filtered players to fetch. Adjust filters or build the list first.');
                return;
            }

            setError('');
            setProgress(true, 'Fetching player details (personalstats)…', `0 / ${ids.length}`);
            const progressMsg = document.getElementById('recruitment-progress-message');
            const progressDet = document.getElementById('recruitment-progress-details');

            const batchFn = window.batchApiCallsWithRateLimit;
            if (typeof batchFn !== 'function') {
                setError('App batch API not available.');
                setProgress(false);
                return;
            }

            const requests = ids.map(id => ({
                url: `https://api.torn.com/user/${id}?selections=personalstats&key=${apiKey}`
            }));

            let results;
            try {
                results = await batchFn(requests, {
                    progressMessage: progressMsg || undefined,
                    progressDetails: progressDet || undefined
                });
            } catch (e) {
                setError(e.message || 'Failed to fetch player details.');
                setProgress(false);
                return;
            }

            const detailedStats = {};
            const listById = {};
            list.forEach(p => { listById[p.id] = p; });
            for (let i = 0; i < ids.length; i++) {
                const r = results && results[i];
                if (r && r.success && r.data) detailedStats[ids[i]] = r.data;
            }

            const tbody = document.getElementById('recruitment-detailed-table')?.querySelector('tbody');
            const section = document.getElementById('recruitment-detailed-section');
            if (tbody && section) {
                tbody.innerHTML = list.map(p => {
                    const ps = detailedStats[p.id]?.personalstats || {};
                    const warHits = ps.rankedwarhits != null ? ps.rankedwarhits : (p.warHits ?? 0);
                    const estStats = p.bs != null ? Number(p.bs).toLocaleString() : '—';
                    const networth = (ps.networth != null) ? Number(ps.networth).toLocaleString() : '—';
                    const biggestHit = (ps.bestdamage != null) ? Number(ps.bestdamage).toLocaleString() : '—';
                    return `<tr>
                        <td><a href="https://www.torn.com/profiles.php?XID=${escapeHtml(p.id)}" target="_blank" rel="noopener" style="color: var(--accent-color);">${escapeHtml(p.name)} [${escapeHtml(p.id)}]</a></td>
                        <td>${escapeHtml(String(p.level))}</td>
                        <td>${estStats}</td>
                        <td>${Number(warHits).toLocaleString()}</td>
                        <td>${(ps.energydrinkused != null) ? Number(ps.energydrinkused).toLocaleString() : '—'}</td>
                        <td>${(ps.xantaken != null) ? Number(ps.xantaken).toLocaleString() : '—'}</td>
                        <td>$${networth}</td>
                        <td>${biggestHit}</td>
                        <td>${(ps.refills != null) ? Number(ps.refills).toLocaleString() : '—'}</td>
                    </tr>`;
                }).join('');
                section.style.display = 'block';
                section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            setProgress(false);
        });
    }

    function renderTable() {
        const tbody = document.getElementById('recruitment-table')?.querySelector('tbody');
        const summary = document.getElementById('recruitment-results-summary');
        if (!tbody) return;

        const list = getDisplayList();
        const clickedIds = getClickedPlayerIds();
        tbody.innerHTML = list.map(p => {
            const bsText = p.bs != null ? Number(p.bs).toLocaleString() : '—';
            const leaderDisplay = p.leader || '—';
            const leaderText = p.leaderWarHits != null ? `${escapeHtml(leaderDisplay)} (${p.leaderWarHits})` : escapeHtml(leaderDisplay);
            const contacted = clickedIds.has(String(p.id));
            return `<tr>
                <td><input type="checkbox" class="recruitment-contacted-cb" data-player-id="${escapeHtml(p.id)}" disabled title="Checked when you have opened this player's profile" ${contacted ? ' checked' : ''}><a href="https://www.torn.com/profiles.php?XID=${escapeHtml(p.id)}" target="_blank" rel="noopener" class="recruitment-player-link" data-player-id="${escapeHtml(p.id)}" style="color: var(--accent-color); margin-left: 6px;">${escapeHtml(p.name)}</a></td>
                <td>${escapeHtml(String(p.level))}</td>
                <td>${escapeHtml(String(p.warHits))}</td>
                <td>${escapeHtml(String(p.warScore))}</td>
                <td>${p.rankId ? (() => {
                    const url = 'https://www.torn.com/war.php?step=rankreport&rankID=' + escapeHtml(p.rankId);
                    const label = (p.warResultText && p.warResultText !== '—') ? p.warResultText : 'View war';
                    return `<a href="${url}" target="_blank" rel="noopener" style="color: var(--accent-color);">${escapeHtml(label)}</a>`;
                })() : '—'}</td>
                <td>${escapeHtml(p.factionName)}</td>
                <td>${escapeHtml(p.factionRank)}</td>
                <td>${(function () { const r = parseRespect(p.respect); return Number.isFinite(r) ? escapeHtml(r.toLocaleString()) : escapeHtml(p.respect || '—'); })()}</td>
                <td>${leaderText}</td>
                <td>${bsText}</td>
            </tr>`;
        }).join('');

        if (summary) {
            if (list.length === playerList.length) summary.textContent = playerList.length ? `${playerList.length} players` : '';
            else summary.textContent = `${list.length} of ${playerList.length} players`;
        }

        document.querySelectorAll('#recruitment-table thead th.recruitment-sort').forEach(th => {
            const k = th.getAttribute('data-sort');
            th.style.cursor = 'pointer';
            th.title = 'Click to sort';
            th.classList.toggle('recruitment-sort-asc', k === sortKey && sortDir === 1);
            th.classList.toggle('recruitment-sort-desc', k === sortKey && sortDir === -1);
        });
    }

    window.initRecruitment = initRecruitment;
})();
