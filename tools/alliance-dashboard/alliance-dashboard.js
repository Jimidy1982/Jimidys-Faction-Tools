/**
 * Alliance Dashboard: Firestore live alliance roster + shared vault; Torn intel per faction;
 * cached territory snapshots (per faction) via Cloud Functions.
 */
(function () {
    'use strict';

    const STORAGE_ALLIANCE_ID = 'alliance_dashboard_alliance_id';
    const STORAGE_INTEL_AUTO = 'alliance_dashboard_intel_auto';
    const STORAGE_INTEL_INTERVAL_MS = 'alliance_dashboard_intel_interval_ms';

    let unsubAlliance = null;
    let unsubVault = null;
    let unsubTerritory = null;
    let currentAllianceId = '';
    let lastAllianceDoc = null;
    let lastVaultRows = [];
    let intelAbort = null;
    let intelAutoRefreshTickId = null;
    /** Wall-clock target for next auto refresh (ms since epoch). */
    let intelAutoRefreshNextAt = 0;
    let intelRefreshBusy = false;

    /** From Torn profile (sidebar key); used for creator-only repair UI + hidden-alliance storage key. */
    let cachedPlayerId = '';
    /** Faction ID from the same profile fetch (sidebar key owner). */
    let cachedUserFactionId = '';
    let tornProfileLoaded = false;
    /** Latest intel map for re-rendering cards when territory cache updates. */
    let lastIntelMap = null;
    /** allianceId -> { factionId -> Firestore doc data } */
    let lastFactionTerritory = Object.create(null);
    /** Latest `torn?selections=territorywars` map (territory code -> war object), from last intel refresh. */
    let lastTerritoryWars = null;
    let lastMyAlliances = [];
    let showHiddenAlliances = false;
    /** When set, open alliance settings modal after Firestore delivers this alliance id. */
    let pendingOpenSettingsAllianceId = '';
    /** Successful v2 faction `basic.tag` lookups (faction id -> tag). */
    let factionIntelTagCache = Object.create(null);

    function getApiKey() {
        return (localStorage.getItem('tornApiKey') || '').trim();
    }

    function tornUrl(u) {
        return typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(u) : u;
    }

    function escapeHtml(s) {
        if (s == null) return '';
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function callHttps(name, data) {
        if (typeof firebase === 'undefined' || !firebase.apps || !firebase.apps.length) {
            return Promise.reject(new Error('Firebase not loaded'));
        }
        const fn = firebase.functions();
        return fn.httpsCallable(name)(data).then(function (res) {
            return res && res.data !== undefined ? res.data : res;
        });
    }

    function setStatus(el, text, isError) {
        if (!el) return;
        el.textContent = text || '';
        el.style.color = isError ? '#ff6b6b' : '';
    }

    function hiddenStorageKey(playerId) {
        return 'alliance_dashboard_hidden_' + String(playerId || 'unknown');
    }

    function getHiddenAllianceIdsSet(playerId) {
        if (!playerId) return new Set();
        try {
            const raw = localStorage.getItem(hiddenStorageKey(playerId));
            const a = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(a) ? a.map(String) : []);
        } catch (e) {
            return new Set();
        }
    }

    function saveHiddenAllianceIds(playerId, set) {
        if (!playerId) return;
        try {
            localStorage.setItem(hiddenStorageKey(playerId), JSON.stringify([...set]));
        } catch (e) {
            /* ignore */
        }
    }

    async function ensurePlayerIdFromTorn() {
        if (tornProfileLoaded) {
            updateTerritoryRefreshButtonUi();
            return;
        }
        const apiKey = getApiKey();
        if (!apiKey || apiKey.length !== 16) {
            tornProfileLoaded = true;
            updateTerritoryRefreshButtonUi();
            return;
        }
        try {
            const d = await fetchJson('https://api.torn.com/user/?selections=profile&key=' + encodeURIComponent(apiKey));
            if (d.player_id != null) cachedPlayerId = String(d.player_id);
            const fac = d.faction && typeof d.faction === 'object' ? d.faction : null;
            const rawFid =
                d.faction_id != null
                    ? d.faction_id
                    : fac && fac.faction_id != null
                      ? fac.faction_id
                      : fac && fac.id != null
                        ? fac.id
                        : null;
            cachedUserFactionId = rawFid != null ? String(rawFid) : '';
        } catch (e) {
            /* ignore */
        }
        tornProfileLoaded = true;
        updateTerritoryRefreshButtonUi();
    }

    function canManualAllianceTerritory() {
        if (!lastAllianceDoc) return false;
        if (isAllianceCreator()) return true;
        if (!cachedUserFactionId) return false;
        return !!lastAllianceDoc.factions[cachedUserFactionId];
    }

    function formatTerritoryUpdated(ts) {
        if (!ts || typeof ts.toDate !== 'function') return '';
        try {
            return ts.toDate().toLocaleString();
        } catch (e) {
            return '';
        }
    }

    /** Normalize cached Torn territory payload (unwrap nested `territory` if present). */
    function unwrapTerritoryPayload(payload) {
        if (payload == null) return payload;
        if (typeof payload !== 'object' || Array.isArray(payload)) return payload;
        var inner = payload.territory;
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
        return payload;
    }

    /**
     * Territory codes this faction holds, derived from Firestore `payload` (Torn faction territory shape).
     * Keys like RYD / OXG, or array entries with id/code fields.
     */
    function extractOwnedTerritoryCodes(payload) {
        var p = unwrapTerritoryPayload(payload);
        if (p == null) return [];
        if (typeof p === 'string') {
            try {
                return extractOwnedTerritoryCodes(JSON.parse(p));
            } catch (e) {
                return [];
            }
        }
        if (Array.isArray(p)) {
            var out = [];
            p.forEach(function (item) {
                if (item == null || typeof item !== 'object') return;
                var id =
                    item.id != null
                        ? String(item.id)
                        : item.code != null
                          ? String(item.code)
                          : item.territory != null
                            ? String(item.territory)
                            : '';
                id = id.toUpperCase();
                if (id && /^[A-Z]{2,4}$/.test(id)) out.push(id);
            });
            return out;
        }
        if (typeof p === 'object') {
            var keys = Object.keys(p);
            var codeKeys = keys.filter(function (k) {
                var ku = String(k).toUpperCase();
                return /^[A-Z]{2,4}$/.test(ku) && p[k] != null && typeof p[k] === 'object';
            });
            if (codeKeys.length) return codeKeys.map(function (k) {
                return String(k).toUpperCase();
            });
        }
        return [];
    }

    function normalizeTileCodeListClient(arr) {
        if (!Array.isArray(arr)) return [];
        var seen = Object.create(null);
        var out = [];
        arr.forEach(function (x) {
            var c = String(x || '')
                .trim()
                .toUpperCase()
                .replace(/[^A-Z]/g, '');
            if (c.length < 2 || c.length > 4) return;
            if (seen[c]) return;
            seen[c] = true;
            out.push(c);
        });
        return out;
    }

    function normalizeSingleTerritoryCodeInput(val) {
        var a = normalizeTileCodeListClient([val]);
        return a.length ? a[0] : '';
    }

    function mergeTerritoryCodesFromSnap(snap) {
        var payload = snap && snap.payload != null ? snap.payload : null;
        var fromPayload = extractOwnedTerritoryCodes(payload);
        var fromManual = normalizeTileCodeListClient(snap && snap.manualTileCodes);
        var manualRemoveSet = Object.create(null);
        fromManual.forEach(function (c) {
            manualRemoveSet[c] = true;
        });
        var seen = Object.create(null);
        var codes = [];
        fromPayload.forEach(function (c) {
            if (seen[c]) return;
            seen[c] = true;
            codes.push(c);
        });
        fromManual.forEach(function (c) {
            if (seen[c]) return;
            seen[c] = true;
            codes.push(c);
        });
        return { codes: codes, manualRemoveSet: manualRemoveSet };
    }

    function territoryTileAtWarForFaction(warsMap, code, fidS) {
        if (!warsMap || typeof warsMap !== 'object') return false;
        var war = warsMap[code];
        if (!war || typeof war !== 'object') return false;
        var af = String(war.assaulting_faction != null ? war.assaulting_faction : '');
        var df = String(war.defending_faction != null ? war.defending_faction : '');
        return af === fidS || df === fidS;
    }

    /**
     * Simple tile letters + Safe / At War (from `territorywars` + Torn payload + optional manualTileCodes).
     * At-war tiles always show above the dropdown; full list is inside <details>.
     */
    function buildTerritoryWarsForFactionHtml(fid) {
        var snap = lastFactionTerritory[String(fid)] || null;
        var merged = mergeTerritoryCodesFromSnap(snap);
        var codes = merged.codes;
        var manualRemoveSet = merged.manualRemoveSet;
        var canEditTiles = canManualAllianceTerritory();
        if (!codes.length && !canEditTiles) return '';
        var fidS = String(fid);
        var warsMap = lastTerritoryWars && typeof lastTerritoryWars === 'object' ? lastTerritoryWars : null;

        var atWarCodes = [];
        var rows = [];
        codes.forEach(function (code) {
            var atWar = warsMap ? territoryTileAtWarForFaction(warsMap, code, fidS) : false;
            if (atWar) atWarCodes.push(code);
            var statusLabel = warsMap ? (atWar ? 'At War' : 'Safe') : '…';
            var statusClass = atWar
                ? 'alliance-dash-terr-st alliance-dash-terr-st--war'
                : warsMap
                  ? 'alliance-dash-terr-st alliance-dash-terr-st--safe'
                  : 'alliance-dash-terr-st alliance-dash-terr-st--na';
            var rmHtml =
                canEditTiles && manualRemoveSet[code]
                ? '<button type="button" class="alliance-dash-terr-manual-rm" data-fid="' +
                  escapeHtml(fidS) +
                  '" data-code="' +
                  escapeHtml(code) +
                  '" title="Remove manual tile" aria-label="Remove tile ' +
                  escapeHtml(code) +
                  '">×</button>'
                : '';
            rows.push(
                '<li class="alliance-dash-terr-dd-li">' +
                '<span class="alliance-dash-terr-dd-code">' +
                escapeHtml(code) +
                '</span>' +
                '<span class="' +
                statusClass +
                '">' +
                escapeHtml(statusLabel) +
                '</span>' +
                rmHtml +
                '</li>'
            );
        });

        var bannerHtml = '';
        if (atWarCodes.length) {
            bannerHtml =
                '<div class="alliance-dash-terr-atwar-banner" role="status">' +
                '<span class="alliance-dash-terr-atwar-banner__label">At War</span> ' +
                '<span class="alliance-dash-terr-atwar-banner__codes">' +
                atWarCodes
                    .map(function (c) {
                        return (
                            '<span class="alliance-dash-terr-pill alliance-dash-terr-pill--war">' +
                            escapeHtml(c) +
                            '</span>'
                        );
                    })
                    .join('') +
                '</span></div>';
        }

        var summaryBits = ['Territories (' + codes.length + ')'];
        if (warsMap && codes.length && atWarCodes.length === 0) summaryBits.push('all safe');
        var hintInside = warsMap
            ? ''
            : '<p class="alliance-dash-terr-dd-hint">Use <strong>Refresh intel</strong> to load Safe / At War from Torn.</p>';

        var footHtml = '';
        if (canEditTiles) {
            footHtml =
                '<div class="alliance-dash-terr-manual-foot" data-fid="' +
                escapeHtml(fidS) +
                '">' +
                '<p class="alliance-dash-terr-manual-foot-note">Manual tiles here are cleared when this faction uses <strong>Refresh territory</strong> on the intel panel (Torn API).</p>' +
                '<div class="alliance-dash-terr-manual-addrow">' +
                '<input type="text" class="alliance-dash-terr-manual-inp" maxlength="4" placeholder="e.g. RYD" aria-label="Territory code" autocomplete="off" />' +
                '<button type="button" class="btn alliance-dash-terr-manual-add">Add</button>' +
                '</div>' +
                '<p class="alliance-dash-terr-manual-err" hidden></p>' +
                '</div>';
        }

        return (
            '<div class="alliance-dash-terr-status-wrap">' +
            bannerHtml +
            '<details class="alliance-dash-terr-details">' +
            '<summary class="alliance-dash-terr-details__summary">' +
            escapeHtml(summaryBits.join(' · ')) +
            '</summary>' +
            hintInside +
            '<ul class="alliance-dash-terr-details__list">' +
            (rows.length ? rows.join('') : '<li class="alliance-dash-terr-dd-li alliance-dash-terr-dd-li--empty">No tiles yet — add codes below.</li>') +
            '</ul>' +
            footHtml +
            '</details>' +
            '</div>'
        );
    }

    function buildIntelTerritoryHtml(fid, r) {
        if (r && r.error) return '';
        var snap = lastFactionTerritory[String(fid)] || null;
        /** Torn API cache: tile list + Safe/At War live in the dropdown only (no raw JSON on the card). */
        if (snap && snap.source === 'api') {
            return '';
        }
        if (snap && snap.payload != null && snap.source !== 'manual') {
            return '';
        }
        if (snap && snap.summary && snap.source === 'manual') {
            var when = formatTerritoryUpdated(snap.updatedAt);
            var whenHtml = when ? ' <span class="alliance-dash-intel-terr-when">· ' + escapeHtml(when) + '</span>' : '';
            return (
                '<p class="alliance-dash-intel-terr">' +
                '<span>Territory (manual)</span> ' +
                escapeHtml(String(snap.summary)) +
                whenHtml +
                '</p>'
            );
        }
        if (snap && snap.summary) {
            return '';
        }
        if (
            snap &&
            Array.isArray(snap.manualTileCodes) &&
            snap.manualTileCodes.length &&
            !(snap.source === 'manual' && snap.summary)
        ) {
            return '';
        }
        if (r && r.territory) {
            return (
                '<p class="alliance-dash-intel-terr alliance-dash-intel-terr--war">' +
                '<span>War snapshot</span> ' +
                escapeHtml(String(r.territory)) +
                '</p>'
            );
        }
        return (
            '<p class="alliance-dash-intel-muted">' +
            'Territory: not in alliance cache yet — ask that faction’s leader to use <strong>Refresh territory</strong> on this panel, or use <strong>Edit</strong> next to their faction in <strong>Alliance settings</strong> for a text note.' +
            '</p>'
        );
    }

    function syncMyTerritoryToAllianceIfEligible() {
        var apiKey = getApiKey();
        if (!apiKey || apiKey.length !== 16 || !currentAllianceId) return;
        if (!cachedUserFactionId) return;
        if (!lastAllianceDoc || !lastAllianceDoc.factions || !lastAllianceDoc.factions[cachedUserFactionId]) return;
        callHttps('allianceTerritorySyncFromApi', { apiKey: apiKey, allianceId: currentAllianceId }).catch(function (err) {
            console.warn('[Alliance] territory sync', err);
        });
    }

    function updateRepairDirectoryUi() {
        const wrap = document.getElementById('alliance-dash-repair-wrap');
        const btn = document.getElementById('alliance-dash-repair-index');
        if (!wrap || !btn) return;
        if (!lastAllianceDoc || !cachedPlayerId) {
            wrap.style.display = 'none';
            btn.style.display = 'none';
            return;
        }
        const isCreator = String(lastAllianceDoc.createdByPlayerId || '') === String(cachedPlayerId);
        wrap.style.display = isCreator ? 'block' : 'none';
        btn.style.display = isCreator ? 'inline-block' : 'none';
    }

    function isSettingsModalVisible() {
        const s = document.getElementById('alliance-dash-settings-modal');
        return !!(s && s.getAttribute('aria-hidden') === 'false');
    }

    function isAllianceCreator() {
        return !!(
            lastAllianceDoc &&
            cachedPlayerId &&
            String(lastAllianceDoc.createdByPlayerId || '') === String(cachedPlayerId)
        );
    }

    /** Show intel-toolbar “Refresh territory” when sidebar key’s faction is on the loaded alliance roster. */
    function updateTerritoryRefreshButtonUi() {
        var btn = document.getElementById('alliance-dash-refresh-territory');
        if (!btn) return;
        var show = !!(
            lastAllianceDoc &&
            currentAllianceId &&
            getApiKey().length === 16 &&
            cachedUserFactionId &&
            lastAllianceDoc.factions &&
            lastAllianceDoc.factions[cachedUserFactionId]
        );
        btn.style.display = show ? 'inline-block' : 'none';
    }

    function renderAllianceSettingsPanel() {
        const idDisplay = document.getElementById('alliance-dash-settings-id-display');
        const tbody = document.getElementById('alliance-dash-settings-factions-tbody');
        const nameInput = document.getElementById('alliance-dash-settings-name');
        const creatorBlock = document.getElementById('alliance-dash-settings-creator-block');
        const note = document.getElementById('alliance-dash-settings-readonly-note');
        const meta = document.getElementById('alliance-dash-settings-meta');
        const createdEl = document.getElementById('alliance-dash-settings-created');
        const lead = document.getElementById('alliance-dash-settings-lead');
        if (!lastAllianceDoc || !currentAllianceId) {
            if (idDisplay) idDisplay.textContent = '';
            if (tbody) tbody.innerHTML = '';
            var mwClear = document.getElementById('alliance-dash-terr-manual-wrap');
            if (mwClear) mwClear.style.display = 'none';
            if (lead) lead.textContent = 'Load an alliance to use this panel.';
            updateTerritoryRefreshButtonUi();
            return;
        }
        const displayName = lastAllianceDoc.name || 'Alliance';
        if (lead) lead.textContent = displayName + ' — copy the alliance ID, view the roster, and manage options you have permission for.';
        if (idDisplay) idDisplay.textContent = currentAllianceId;
        if (nameInput) nameInput.value = String(lastAllianceDoc.name || '');
        const creator = isAllianceCreator();
        if (creatorBlock) creatorBlock.style.display = creator ? 'block' : 'none';
        if (note) note.style.display = creator ? 'none' : 'block';
        const ca = lastAllianceDoc.createdAt;
        if (meta && createdEl) {
            if (ca != null && ca !== '') {
                meta.style.display = 'block';
                createdEl.textContent = 'Created: ' + new Date(Number(ca)).toLocaleString() + '.';
            } else {
                meta.style.display = 'none';
            }
        }
        if (tbody) {
            const fids = factionIdsFromDoc(lastAllianceDoc);
            fids.sort(function (a, b) {
                return (Number(a) || 0) - (Number(b) || 0) || String(a).localeCompare(String(b));
            });
            const canRemoveAny = fids.length > 1;
            var canMan = canManualAllianceTerritory();
            tbody.innerHTML = fids
                .map(function (fid) {
                    const facMeta = getFactionMeta(lastAllianceDoc, fid);
                    var removeCell;
                    if (creator && canRemoveAny) {
                        removeCell =
                            '<button type="button" class="btn alliance-dash-mini-btn alliance-dash-remove-faction" data-fid="' +
                            escapeHtml(fid) +
                            '">Remove</button>';
                    } else if (creator && !canRemoveAny) {
                        removeCell = '<span class="alliance-dash-muted" title="Cannot remove the last faction">—</span>';
                    } else {
                        removeCell = '<span class="alliance-dash-muted">—</span>';
                    }
                    var terrNoteCell = canMan
                        ? '<button type="button" class="btn alliance-dash-mini-btn alliance-dash-terr-edit" data-fid="' +
                          escapeHtml(fid) +
                          '">Edit</button>'
                        : '<span class="alliance-dash-muted">—</span>';
                    return (
                        '<tr><td>' +
                        escapeHtml(facMeta.name) +
                        '</td><td><code>' +
                        escapeHtml(fid) +
                        '</code></td><td class="alliance-dash-actions">' +
                        terrNoteCell +
                        '</td><td class="alliance-dash-actions">' +
                        removeCell +
                        '</td></tr>'
                    );
                })
                .join('');
        }
        var manualWrap = document.getElementById('alliance-dash-terr-manual-wrap');
        if (manualWrap) manualWrap.style.display = 'none';
        updateRepairDirectoryUi();
        updateTerritoryRefreshButtonUi();
    }

    function renderMyAlliances() {
        const el = document.getElementById('alliance-dash-my-list');
        if (!el) return;
        const hidden = getHiddenAllianceIdsSet(cachedPlayerId);
        if (!lastMyAlliances.length) {
            el.innerHTML =
                '<p class="alliance-dash-empty">No alliances linked to your faction yet — or your rank is not Leader / Co-leader (try Refresh list).</p>';
            return;
        }
        const rows = lastMyAlliances.filter(function (a) {
            return showHiddenAlliances || !hidden.has(String(a.allianceId));
        });
        if (!rows.length) {
            el.innerHTML =
                '<p class="alliance-dash-empty">All alliances are hidden. Turn on <strong>Show hidden</strong> to see them again.</p>';
            return;
        }
        el.innerHTML = rows
            .map(function (a) {
                const aid = String(a.allianceId);
                const isH = hidden.has(aid);
                const hidCls = isH ? ' alliance-dash-my-card--hidden' : '';
                const fc = a.factionCount != null ? a.factionCount : 0;
                return (
                    '<article class="alliance-dash-my-card' + hidCls + '" data-aid="' +
                    escapeHtml(aid) +
                    '">' +
                    '<div class="alliance-dash-my-card-main">' +
                    '<div class="alliance-dash-my-card-title">' +
                    escapeHtml(a.name || 'Alliance') +
                    '</div>' +
                    '<div class="alliance-dash-my-card-meta">' +
                    '<span class="alliance-dash-my-card-pill">' +
                    escapeHtml(String(fc)) +
                    ' faction' +
                    (fc === 1 ? '' : 's') +
                    '</span></div>' +
                    '</div>' +
                    '<div class="alliance-dash-my-card-actions">' +
                    '<button type="button" class="btn alliance-dash-btn-primary alliance-dash-open-alliance" data-aid="' +
                    escapeHtml(aid) +
                    '">Open</button>' +
                    '<button type="button" class="btn alliance-dash-card-settings" data-aid="' +
                    escapeHtml(aid) +
                    '">Settings</button>' +
                    '<button type="button" class="btn alliance-dash-hide-alliance" data-aid="' +
                    escapeHtml(aid) +
                    '">' +
                    (isH ? 'Unhide' : 'Hide') +
                    '</button>' +
                    '</div></article>'
                );
            })
            .join('');
        updateActiveAllianceCardHighlight();
    }

    function updateActiveAllianceCardHighlight() {
        document.querySelectorAll('.alliance-dash-my-card').forEach(function (card) {
            var aid = card.getAttribute('data-aid');
            if (aid && aid === currentAllianceId && lastAllianceDoc) card.classList.add('alliance-dash-my-card--active');
            else card.classList.remove('alliance-dash-my-card--active');
        });
    }

    function updateLoadedAllianceStatus(text, isError) {
        var el = document.getElementById('alliance-dash-loaded-status');
        if (!el) return;
        if (!text) {
            el.textContent = '';
            el.style.display = 'none';
            el.style.color = '';
            return;
        }
        el.textContent = text;
        el.style.display = '';
        el.style.color = isError ? '#ff6b6b' : '';
    }

    function updateIntelHeadingAllianceName(displayName) {
        var el = document.getElementById('alliance-dash-intel-alliance-name');
        if (!el) return;
        var t = String(displayName || '').trim();
        if (!t) {
            el.textContent = '';
            el.hidden = true;
            return;
        }
        el.textContent = ' \u00b7 ' + t;
        el.hidden = false;
    }

    function refreshMyAllianceList() {
        const apiKey = getApiKey();
        const st = document.getElementById('alliance-dash-my-status');
        if (!apiKey || apiKey.length !== 16) {
            setStatus(st, 'Set API key to discover alliances.', true);
            lastMyAlliances = [];
            renderMyAlliances();
            return;
        }
        setStatus(st, 'Loading…', false);
        callHttps('allianceListMine', { apiKey: apiKey })
            .then(function (res) {
                if (res && res.playerId) cachedPlayerId = String(res.playerId);
                lastMyAlliances = Array.isArray(res.alliances) ? res.alliances : [];
                setStatus(st, lastMyAlliances.length ? lastMyAlliances.length + ' alliance(s).' : 'No alliances found for your faction.', false);
                renderMyAlliances();
                updateRepairDirectoryUi();
                updateActiveAllianceCardHighlight();
                if (isSettingsModalVisible()) renderAllianceSettingsPanel();
            })
            .catch(function (err) {
                lastMyAlliances = [];
                renderMyAlliances();
                setStatus(st, err.message || String(err), true);
            });
    }

    function factionIdsFromDoc(data) {
        const f = data && data.factions;
        if (!f || typeof f !== 'object') return [];
        return Object.keys(f);
    }

    function getFactionMeta(data, fid) {
        const f = data && data.factions;
        if (!f || !f[fid]) return { name: 'Faction ' + fid };
        return { name: f[fid].name || 'Faction ' + fid };
    }

    async function fetchJson(url) {
        const res = await fetch(tornUrl(url));
        const data = await res.json();
        if (data.error) throw new Error(typeof data.error === 'object' ? data.error.error : String(data.error));
        return data;
    }

    function parseRankedWarsList(data) {
        var raw = data && data.rankedwars;
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.rankedwars) {
            raw = raw.rankedwars;
        }
        raw = raw || [];
        return Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
    }

    function warParticipantId(p) {
        if (!p || typeof p !== 'object') return '';
        var v = p.id != null ? p.id : p.faction_id;
        return String(v != null ? v : '');
    }

    function findOngoingWar(list, factionId, nowSec) {
        const fid = String(factionId);
        for (let i = 0; i < list.length; i++) {
            const w = list[i];
            if (!w || !w.factions || w.factions.length < 2) continue;
            const start = Number(w.start) || 0;
            // Match War Dashboard: treat missing/falsy end as ongoing; end >= now still active.
            if (start <= nowSec && (!w.end || w.end >= nowSec)) {
                const inWar = w.factions.some(function (x) {
                    return warParticipantId(x) === fid;
                });
                if (inWar) return w;
            }
        }
        return null;
    }

    function territoryFromRankedWar(war) {
        if (!war) return '';
        if (war.territories != null) return JSON.stringify(war.territories).slice(0, 120);
        if (war.territory != null) return String(war.territory);
        return '';
    }

    function participantWarScore(p) {
        if (!p || typeof p !== 'object') return 0;
        return parseFloat(p.score != null ? p.score : p.chain || 0) || 0;
    }

    /** Positive number from ranked-war payload (Torn v2 uses `target` as win margin for many wars). */
    function warLeadRequirementValue(war) {
        if (!war || typeof war !== 'object') return null;
        var keys = ['target', 'lead_target', 'required_lead', 'win_margin', 'score_target', 'margin'];
        for (var i = 0; i < keys.length; i++) {
            var v = war[keys[i]];
            if (v == null || v === '') continue;
            var n = parseFloat(v);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return null;
    }

    /** Up to ~5 chars (Torn-style short tag); initials from words when no API tag. */
    function acronymFromFactionName(name) {
        var s = String(name || '').trim();
        if (!s) return '';
        var parts = s
            .replace(/[^a-zA-Z0-9*]+/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        if (parts.length >= 2) {
            return parts
                .map(function (p) {
                    return p.charAt(0);
                })
                .join('')
                .toUpperCase()
                .slice(0, 5);
        }
        if (parts.length === 1) {
            var p = parts[0].replace(/[^a-zA-Z0-9*]/g, '');
            if (p.length <= 5) return p.toUpperCase();
            return p.toUpperCase().slice(0, 5);
        }
        return '';
    }

    function isFactionInAllianceRoster(factionId) {
        if (!lastAllianceDoc || factionId == null || String(factionId) === '') return false;
        var f = lastAllianceDoc.factions;
        return !!(f && f[String(factionId)]);
    }

    async function fetchFactionTagFromV2(apiKey, factionId) {
        var id = String(factionId || '').trim();
        if (!apiKey || apiKey.length !== 16 || !id) return '';
        if (Object.prototype.hasOwnProperty.call(factionIntelTagCache, id)) {
            return factionIntelTagCache[id];
        }
        try {
            var data = await fetchJson(
                'https://api.torn.com/v2/faction/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(apiKey)
            );
            var tag = '';
            if (data && data.basic && data.basic.tag != null) tag = String(data.basic.tag).trim();
            if (!tag && data && data.tag != null) tag = String(data.tag).trim();
            if (tag) {
                tag = tag.length > 6 ? tag.slice(0, 6) : tag;
                factionIntelTagCache[id] = tag;
                return tag;
            }
            factionIntelTagCache[id] = '';
            return '';
        } catch (e) {
            /* ignore */
        }
        return '';
    }

    async function ensureWarRowTagFromV2(apiKey, row) {
        if (!row || !row.factionId) return;
        if (isFactionInAllianceRoster(row.factionId)) return;
        var t = await fetchFactionTagFromV2(apiKey, row.factionId);
        if (t) row.tag = t;
    }

    /** Short label for a ranked-war participant (API tag, roster name prefix, or acronym). */
    function factionTagFromWarParticipant(f) {
        var fo = f && typeof f === 'object' ? f : {};
        var id = warParticipantId(fo);
        var raw = '';
        if (fo.basic && typeof fo.basic === 'object' && fo.basic.tag != null) raw = String(fo.basic.tag).trim();
        if (!raw && fo.tag != null) raw = String(fo.tag).trim();
        if (!raw && fo.faction_tag != null) raw = String(fo.faction_tag).trim();
        if (!raw && fo.abbreviation != null) raw = String(fo.abbreviation).trim();
        if (!raw && fo.short != null) raw = String(fo.short).trim();
        if (raw) return raw.length > 6 ? raw.slice(0, 6) : raw;
        if (lastAllianceDoc && id) {
            var meta = getFactionMeta(lastAllianceDoc, id);
            var nm = meta && meta.name ? String(meta.name).trim() : '';
            var generic = nm === 'Faction ' + id;
            if (nm && !generic) {
                var colon = nm.indexOf(':');
                if (colon > 0 && colon <= 12) return nm.slice(0, colon).trim().slice(0, 6);
                if (nm.length <= 10) return nm;
                return nm.slice(0, 8) + '…';
            }
        }
        var name = (fo.name || '').trim();
        var ac = acronymFromFactionName(name);
        if (ac) return ac;
        if (name.length <= 5) return name || id || '—';
        return name.slice(0, 5).toUpperCase();
    }

    /**
     * @returns {{ kind: 'none'|'ambiguous'|'scores', singleLine?: string, territory: string, vsOpponentName?: string, ourFactionName?: string, theirFactionName?: string, leadRequired?: number|null, leadCurrent?: number|null, rows?: { tag: string, scoreStr: string, factionId?: string }[] }}
     */
    function warSummaryForFaction(war, factionId) {
        var territory = territoryFromRankedWar(war);
        if (!war || !war.factions) {
            return { kind: 'none', singleLine: 'No ongoing ranked war', territory: territory };
        }
        var fid = String(factionId);
        var us = war.factions.find(function (x) {
            return warParticipantId(x) === fid;
        });
        var them = war.factions.find(function (x) {
            return warParticipantId(x) !== fid;
        });
        if (!us || !them) {
            return { kind: 'ambiguous', singleLine: 'Ranked war (participants unclear)', territory: territory };
        }
        var ourScore = participantWarScore(us);
        var theirScore = participantWarScore(them);
        var ourNm = (us.name && String(us.name).trim()) || 'Faction ' + warParticipantId(us);
        var theirNm = (them.name && String(them.name).trim()) || 'Faction ' + warParticipantId(them);
        var leadReq = warLeadRequirementValue(war);
        var leadCur = ourScore - theirScore;
        return {
            kind: 'scores',
            territory: territory,
            vsOpponentName: theirNm,
            ourFactionName: ourNm,
            theirFactionName: theirNm,
            leadRequired: leadReq,
            leadCurrent: leadCur,
            rows: [
                {
                    tag: factionTagFromWarParticipant(us),
                    scoreStr: ourScore.toLocaleString(),
                    factionId: warParticipantId(us)
                },
                {
                    tag: factionTagFromWarParticipant(them),
                    scoreStr: theirScore.toLocaleString(),
                    factionId: warParticipantId(them)
                }
            ]
        };
    }

    function buildIntelWarStatHtml(r) {
        if (r.error) {
            return '<span class="alliance-dash-intel-stat-value alliance-dash-intel-stat-value--solo">—</span>';
        }
        var wb = r.warBlock;
        if (!wb || wb.kind === 'none' || wb.kind === 'ambiguous') {
            return (
                '<span class="alliance-dash-intel-stat-value alliance-dash-intel-stat-value--solo">' +
                escapeHtml((wb && wb.singleLine) || '—') +
                '</span>'
            );
        }
        if (wb.kind !== 'scores' || !wb.rows || wb.rows.length < 1) {
            return '<span class="alliance-dash-intel-stat-value alliance-dash-intel-stat-value--solo">—</span>';
        }
        var vsName = wb.vsOpponentName ? escapeHtml(wb.vsOpponentName) : '';
        if (wb.rows.length === 2) {
            var a = wb.rows[0];
            var b = wb.rows[1];
            var nmLeft = escapeHtml(wb.ourFactionName || '');
            var nmRight = escapeHtml(wb.theirFactionName || '');
            var leadHtml = '';
            if (wb.leadRequired != null && wb.leadRequired > 0) {
                var curN = wb.leadCurrent != null ? wb.leadCurrent : 0;
                var reqStr = Math.round(wb.leadRequired).toLocaleString();
                var curStr =
                    curN === 0 ? '0' : (curN > 0 ? '+' : '') + Math.round(curN).toLocaleString();
                leadHtml =
                    '<div class="alliance-dash-intel-war-lead" title="Required score margin vs your current margin (from ranked war API).">' +
                    '<span class="alliance-dash-intel-war-lead-line"><span class="alliance-dash-intel-war-lead-k">Lead Required</span> ' +
                    '<span class="alliance-dash-intel-war-lead-v">' +
                    escapeHtml(reqStr) +
                    '</span></span>' +
                    '<span class="alliance-dash-intel-war-lead-sep">·</span>' +
                    '<span class="alliance-dash-intel-war-lead-line"><span class="alliance-dash-intel-war-lead-k">Now</span> ' +
                    '<span class="alliance-dash-intel-war-lead-v">' +
                    escapeHtml(curStr) +
                    '</span></span></div>';
            }
            return (
                '<div class="alliance-dash-intel-war-grid alliance-dash-intel-war-grid--names">' +
                '<div class="alliance-dash-intel-war-grid__left">' +
                '<span class="alliance-dash-intel-war-fac-name">' +
                nmLeft +
                '</span></div>' +
                '<div class="alliance-dash-intel-war-grid__mid">' +
                '<span class="alliance-dash-intel-war-vs">VS</span></div>' +
                '<div class="alliance-dash-intel-war-grid__right">' +
                '<span class="alliance-dash-intel-war-fac-name">' +
                nmRight +
                '</span></div></div>' +
                '<div class="alliance-dash-intel-war-grid alliance-dash-intel-war-grid--scores">' +
                '<div class="alliance-dash-intel-war-grid__left alliance-dash-intel-war-grid__left--scores">' +
                '<span class="alliance-dash-intel-fac-tag">' +
                escapeHtml(a.tag) +
                '</span>' +
                '<span class="alliance-dash-intel-fac-score">' +
                escapeHtml(a.scoreStr) +
                '</span></div>' +
                '<div class="alliance-dash-intel-war-grid__mid">' +
                '<span class="alliance-dash-intel-war-vs">VS</span></div>' +
                '<div class="alliance-dash-intel-war-grid__right alliance-dash-intel-war-grid__right--scores">' +
                '<span class="alliance-dash-intel-fac-score">' +
                escapeHtml(b.scoreStr) +
                '</span>' +
                '<span class="alliance-dash-intel-fac-tag">' +
                escapeHtml(b.tag) +
                '</span></div></div>' +
                leadHtml
            );
        }
        var lines = wb.rows
            .map(function (row) {
                return (
                    '<div class="alliance-dash-intel-war-line">' +
                    '<span class="alliance-dash-intel-fac-tag">' +
                    escapeHtml(row.tag) +
                    '</span>' +
                    '<span class="alliance-dash-intel-fac-score">' +
                    escapeHtml(row.scoreStr) +
                    '</span></div>'
                );
            })
            .join('');
        return (
            (vsName ? '<p class="alliance-dash-intel-stat-vs-target">' + vsName + '</p>' : '') +
            '<div class="alliance-dash-intel-war-lines alliance-dash-intel-war-lines--center">' +
            lines +
            '</div>'
        );
    }

    /** Torn chain timeout/cooldown are in whole seconds; show minutes + seconds when ≥ 1 min. */
    function formatDurationMinSec(sec) {
        var s = Math.max(0, Math.floor(Number(sec) || 0));
        var m = Math.floor(s / 60);
        var r = s % 60;
        if (m === 0) return String(r) + 's';
        return m + 'm ' + r + 's';
    }

    async function fetchFactionIntel(apiKey, factionId) {
        const key = encodeURIComponent(apiKey);
        const fid = encodeURIComponent(String(factionId));
        const [warsData, chainData] = await Promise.all([
            fetchJson('https://api.torn.com/v2/faction/' + fid + '/rankedwars?key=' + key),
            fetchJson('https://api.torn.com/faction/' + fid + '?selections=chain&key=' + key)
        ]);
        const now = Math.floor(Date.now() / 1000);
        const list = parseRankedWarsList(warsData);
        const ongoing = findOngoingWar(list, factionId, now);
        const warBits = warSummaryForFaction(ongoing, factionId);
        if (warBits.kind === 'scores' && warBits.rows && warBits.rows.length) {
            await Promise.all(warBits.rows.map(function (row) {
                return ensureWarRowTagFromV2(apiKey, row);
            }));
        }
        const ch = chainData.chain || {};
        const chainLine =
            (ch.current != null ? Number(ch.current) : 0) + ' / ' + (ch.max != null ? Number(ch.max) : 0) + ' hits';
        const chainExtra = [];
        if (ch.timeout != null && Number(ch.timeout) > 0) chainExtra.push('timeout ' + formatDurationMinSec(ch.timeout));
        if (ch.cooldown != null && Number(ch.cooldown) > 0) chainExtra.push('cd ' + formatDurationMinSec(ch.cooldown));
        return {
            warTitle: ongoing ? 'Ongoing ranked war' : 'Ranked war',
            warBlock: warBits,
            warTerritory: warBits.territory || '',
            chainLine: chainLine + (chainExtra.length ? ' · ' + chainExtra.join(', ') : '')
        };
    }

    function renderIntelLoading(fids) {
        const grid = document.getElementById('alliance-dash-intel-grid');
        if (!grid) return;
        grid.innerHTML = fids
            .map(function (fid) {
                return (
                    '<article class="alliance-dash-intel-card" data-fid="' +
                    escapeHtml(fid) +
                    '">' +
                    '<header class="alliance-dash-intel-card-head"><a class="alliance-dash-intel-name" href="https://www.torn.com/factions.php?step=profile&ID=' +
                    encodeURIComponent(fid) +
                    '" target="_blank" rel="noopener" title="Faction profile on Torn">Faction ' +
                    escapeHtml(fid) +
                    '</a></header>' +
                    '<p class="alliance-dash-intel-muted">Loading…</p>' +
                    '</article>'
                );
            })
            .join('');
    }

    function renderIntelResults(map) {
        const grid = document.getElementById('alliance-dash-intel-grid');
        if (!grid) return;
        const cards = grid.querySelectorAll('.alliance-dash-intel-card');
        cards.forEach(function (card) {
            const fid = card.getAttribute('data-fid');
            const r = map[fid];
            if (!r) return;
            const meta = lastAllianceDoc ? getFactionMeta(lastAllianceDoc, fid) : { name: 'Faction ' + fid };
            const err = r.error ? '<p class="alliance-dash-intel-err">' + escapeHtml(r.error) + '</p>' : '';
            const terr = buildIntelTerritoryHtml(fid, r) + buildTerritoryWarsForFactionHtml(fid);
            card.innerHTML =
                '<header class="alliance-dash-intel-card-head">' +
                '<a class="alliance-dash-intel-name" href="https://www.torn.com/factions.php?step=profile&ID=' +
                encodeURIComponent(fid) +
                '" target="_blank" rel="noopener" title="Faction profile on Torn">' +
                escapeHtml(meta.name) +
                '</a>' +
                '</header>' +
                '<div class="alliance-dash-intel-stats">' +
                '<div class="alliance-dash-intel-stat alliance-dash-intel-stat--war">' +
                buildIntelWarStatHtml(r) +
                '</div>' +
                '<div class="alliance-dash-intel-stat alliance-dash-intel-stat--chain">' +
                '<span class="alliance-dash-intel-stat-label">Chain</span>' +
                '<span class="alliance-dash-intel-stat-value">' +
                escapeHtml(r.chainLine || '—') +
                '</span></div></div>' +
                terr +
                err;
        });
        updateTerritoryRefreshButtonUi();
    }

    async function refreshIntel(opts) {
        opts = opts || {};
        var skipLoading = !!opts.skipLoading;
        updateTerritoryRefreshButtonUi();
        const apiKey = getApiKey();
        const grid = document.getElementById('alliance-dash-intel-grid');
        if (!apiKey || apiKey.length !== 16) {
            if (grid) grid.innerHTML = '<p class="alliance-dash-empty">Set a valid API key in the sidebar to load intel.</p>';
            return;
        }
        if (!lastAllianceDoc) {
            if (grid) grid.innerHTML = '<p class="alliance-dash-empty">Load an alliance first.</p>';
            return;
        }
        const fids = factionIdsFromDoc(lastAllianceDoc);
        if (!fids.length) {
            if (grid) grid.innerHTML = '<p class="alliance-dash-empty">No factions in this alliance yet.</p>';
            return;
        }
        if (intelAbort) intelAbort.abort();
        intelAbort = new AbortController();
        const signal = intelAbort.signal;
        const warsPromise = fetchJson(
            'https://api.torn.com/torn/?selections=territorywars&key=' + encodeURIComponent(apiKey)
        ).catch(function () {
            return null;
        });
        var hasCards = !!(grid && grid.querySelector && grid.querySelector('.alliance-dash-intel-card'));
        if (!skipLoading || !hasCards) {
            renderIntelLoading(fids);
        } else {
            var autoSt = document.getElementById('alliance-dash-intel-auto-status');
            if (autoSt) autoSt.textContent = 'Updating…';
        }
        const out = {};
        for (let i = 0; i < fids.length; i++) {
            if (signal.aborted) return;
            const fid = fids[i];
            try {
                const intel = await fetchFactionIntel(apiKey, fid);
                out[fid] = {
                    warBlock: intel.warBlock,
                    chainLine: intel.chainLine,
                    territory: intel.warTerritory
                };
            } catch (e) {
                out[fid] = { error: e.message || String(e) };
            }
            await new Promise(function (r) {
                setTimeout(r, 120);
            });
        }
        if (!signal.aborted) {
            var wd = await warsPromise;
            if (wd && typeof wd === 'object' && wd.territorywars != null && typeof wd.territorywars === 'object') {
                lastTerritoryWars = wd.territorywars;
            }
            lastIntelMap = out;
            renderIntelResults(out);
            var stEl = document.getElementById('alliance-dash-intel-auto-status');
            if (stEl && skipLoading) stEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
            ensurePlayerIdFromTorn().then(function () {
                syncMyTerritoryToAllianceIfEligible();
            });
        }
    }

    function formatIntelCountdown(totalSec) {
        var s = Math.max(0, Math.floor(totalSec));
        var m = Math.floor(s / 60);
        var r = s % 60;
        return m + ':' + (r < 10 ? '0' : '') + r;
    }

    function clearIntelAutoCountdownDisplay() {
        var el = document.getElementById('alliance-dash-intel-auto-countdown');
        if (!el) return;
        el.textContent = '';
        el.hidden = true;
    }

    function updateIntelAutoCountdownUi() {
        var el = document.getElementById('alliance-dash-intel-auto-countdown');
        var cb = document.getElementById('alliance-dash-intel-auto');
        if (!el) return;
        if (!cb || !cb.checked || intelAutoRefreshTickId == null || !lastAllianceDoc) {
            el.textContent = '';
            el.hidden = true;
            return;
        }
        var sec = Math.max(0, Math.ceil((intelAutoRefreshNextAt - Date.now()) / 1000));
        el.textContent = formatIntelCountdown(sec);
        el.hidden = false;
    }

    function stopIntelAutoRefresh() {
        if (intelAutoRefreshTickId != null) {
            clearInterval(intelAutoRefreshTickId);
            intelAutoRefreshTickId = null;
        }
        intelAutoRefreshNextAt = 0;
        clearIntelAutoCountdownDisplay();
    }

    function getIntelAutoRefreshIntervalMs() {
        var sel = document.getElementById('alliance-dash-intel-interval');
        var v = sel ? parseInt(sel.value, 10) : 60000;
        if (!Number.isFinite(v) || v < 30000) v = 30000;
        if (v > 600000) v = 600000;
        return v;
    }

    function clampIntelIntervalToSelectValue(ms) {
        var allowed = [30000, 60000, 120000, 180000, 300000, 600000];
        if (!Number.isFinite(ms)) return 60000;
        if (allowed.indexOf(ms) >= 0) return ms;
        return 60000;
    }

    function persistIntelAutoPrefs() {
        try {
            var cb = document.getElementById('alliance-dash-intel-auto');
            var sel = document.getElementById('alliance-dash-intel-interval');
            if (cb) localStorage.setItem(STORAGE_INTEL_AUTO, cb.checked ? '1' : '0');
            if (sel) localStorage.setItem(STORAGE_INTEL_INTERVAL_MS, String(getIntelAutoRefreshIntervalMs()));
        } catch (e) {
            /* ignore */
        }
    }

    function updateIntelAutoRefreshControlsVisibility() {
        var cb = document.getElementById('alliance-dash-intel-auto');
        var wrap = document.getElementById('alliance-dash-intel-interval-wrap');
        if (!wrap) return;
        wrap.style.display = cb && cb.checked ? 'inline-flex' : 'none';
    }

    function scheduleIntelAutoRefresh() {
        stopIntelAutoRefresh();
        var cb = document.getElementById('alliance-dash-intel-auto');
        if (!cb || !cb.checked) return;
        if (!lastAllianceDoc) return;
        var ms = getIntelAutoRefreshIntervalMs();
        intelAutoRefreshNextAt = Date.now() + ms;
        intelAutoRefreshTickId = setInterval(function () {
            var cb2 = document.getElementById('alliance-dash-intel-auto');
            if (!cb2 || !cb2.checked || !lastAllianceDoc) {
                stopIntelAutoRefresh();
                return;
            }
            if (!intelRefreshBusy && Date.now() >= intelAutoRefreshNextAt) {
                intelRefreshBusy = true;
                intelAutoRefreshNextAt = Date.now() + getIntelAutoRefreshIntervalMs();
                Promise.resolve(refreshIntel({ skipLoading: true }))
                    .catch(function () {
                        /* errors surfaced in cards */
                    })
                    .finally(function () {
                        intelRefreshBusy = false;
                    });
            }
            updateIntelAutoCountdownUi();
        }, 1000);
        updateIntelAutoCountdownUi();
    }

    function applyIntelAutoRefreshPrefs() {
        var cb = document.getElementById('alliance-dash-intel-auto');
        var sel = document.getElementById('alliance-dash-intel-interval');
        if (!cb || !sel) return;
        try {
            var auto = localStorage.getItem(STORAGE_INTEL_AUTO) === '1';
            var ms = clampIntelIntervalToSelectValue(parseInt(localStorage.getItem(STORAGE_INTEL_INTERVAL_MS) || '60000', 10));
            cb.checked = auto;
            sel.value = String(ms);
        } catch (e) {
            /* ignore */
        }
        updateIntelAutoRefreshControlsVisibility();
        var stApply = document.getElementById('alliance-dash-intel-auto-status');
        if (stApply && !cb.checked) stApply.textContent = '';
        scheduleIntelAutoRefresh();
    }

    function renderVaultTable() {
        const tbody = document.getElementById('alliance-dash-vault-tbody');
        if (!tbody) return;
        if (!lastVaultRows.length) {
            tbody.innerHTML =
                '<tr><td colspan="5" class="alliance-dash-empty">No vault entries yet — add weapons or shared gear above.</td></tr>';
            return;
        }
        const apiKey = getApiKey();
        tbody.innerHTML = lastVaultRows
            .map(function (row) {
                const id = row.id;
                const d = row.data || {};
                const facId = d.holderFactionId || '';
                const meta = lastAllianceDoc && facId ? getFactionMeta(lastAllianceDoc, String(facId)) : { name: facId || '—' };
                const when = d.updatedAt ? new Date(Number(d.updatedAt)).toLocaleString() : '—';
                const by = d.updatedByPlayerName ? escapeHtml(d.updatedByPlayerName) : '';
                return (
                    '<tr data-vault-id="' +
                    escapeHtml(id) +
                    '">' +
                    '<td>' +
                    escapeHtml(d.label || '') +
                    '</td>' +
                    '<td>' +
                    escapeHtml(d.location || '') +
                    '</td>' +
                    '<td>' +
                    escapeHtml(meta.name) +
                    (facId ? ' <span class="alliance-dash-muted">(' + escapeHtml(String(facId)) + ')</span>' : '') +
                    '</td>' +
                    '<td class="alliance-dash-muted">' +
                    escapeHtml(when) +
                    (by ? '<br><span class="alliance-dash-tiny">by ' + by + '</span>' : '') +
                    '</td>' +
                    '<td class="alliance-dash-actions">' +
                    '<button type="button" class="btn alliance-dash-mini-btn alliance-dash-edit-vault" data-id="' +
                    escapeHtml(id) +
                    '">Edit</button> ' +
                    '<button type="button" class="btn alliance-dash-mini-btn alliance-dash-del-vault" data-id="' +
                    escapeHtml(id) +
                    '"' +
                    (apiKey ? '' : ' disabled title="API key required"') +
                    '>Delete</button>' +
                    '</td>' +
                    '</tr>'
                );
            })
            .join('');
    }

    function bindVaultTableActions() {
        const tbody = document.getElementById('alliance-dash-vault-tbody');
        if (!tbody || tbody._allianceVaultBound) return;
        tbody._allianceVaultBound = true;
        tbody.addEventListener('click', function (e) {
            const del = e.target && e.target.closest && e.target.closest('.alliance-dash-del-vault');
            const ed = e.target && e.target.closest && e.target.closest('.alliance-dash-edit-vault');
            if (del) {
                const id = del.getAttribute('data-id');
                if (!id || !currentAllianceId) return;
                if (!confirm('Delete this vault entry?')) return;
                const apiKey = getApiKey();
                if (!apiKey) return;
                callHttps('allianceVaultDelete', { apiKey: apiKey, allianceId: currentAllianceId, itemId: id }).catch(function (err) {
                    alert(err.message || String(err));
                });
                return;
            }
            if (ed) {
                const id = ed.getAttribute('data-id');
                const row = lastVaultRows.find(function (r) {
                    return r.id === id;
                });
                if (!row || !row.data) return;
                document.getElementById('alliance-dash-vault-edit-id').value = id;
                document.getElementById('alliance-dash-vault-label').value = row.data.label || '';
                document.getElementById('alliance-dash-vault-location').value = row.data.location || '';
                document.getElementById('alliance-dash-vault-holder').value = row.data.holderFactionId || '';
                document.getElementById('alliance-dash-vault-notes').value = row.data.notes || '';
                const cancel = document.getElementById('alliance-dash-vault-cancel-edit');
                if (cancel) cancel.style.display = '';
                const sub = document.getElementById('alliance-dash-vault-submit');
                if (sub) sub.textContent = 'Update entry';
            }
        });
    }

    function stopListeners() {
        if (unsubAlliance) {
            unsubAlliance();
            unsubAlliance = null;
        }
        if (unsubVault) {
            unsubVault();
            unsubVault = null;
        }
        if (unsubTerritory) {
            unsubTerritory();
            unsubTerritory = null;
        }
    }

    let allianceModalEscapeBound = false;

    function refreshBodyModalOpenClass() {
        const create = document.getElementById('alliance-dash-modal');
        const settings = document.getElementById('alliance-dash-settings-modal');
        const cOpen = create && create.getAttribute('aria-hidden') === 'false';
        const sOpen = settings && settings.getAttribute('aria-hidden') === 'false';
        if (cOpen || sOpen) document.body.classList.add('alliance-dash-modal-open');
        else document.body.classList.remove('alliance-dash-modal-open');
    }

    function closeAllianceModal() {
        const m = document.getElementById('alliance-dash-modal');
        if (m) m.setAttribute('aria-hidden', 'true');
        refreshBodyModalOpenClass();
    }

    function closeAllianceSettingsModal() {
        const m = document.getElementById('alliance-dash-settings-modal');
        if (m) m.setAttribute('aria-hidden', 'true');
        refreshBodyModalOpenClass();
    }

    function openSettingsForAlliance(aid) {
        var id = String(aid || '').trim();
        if (!id) return;
        pendingOpenSettingsAllianceId = id;
        ensurePlayerIdFromTorn().then(function () {
            if (currentAllianceId === id && lastAllianceDoc) {
                pendingOpenSettingsAllianceId = '';
                renderAllianceSettingsPanel();
                openAllianceSettingsModal();
                return;
            }
            subscribeAlliance(id);
            var idInput = document.getElementById('alliance-dash-id-input');
            if (idInput) idInput.value = id;
            closeAllianceModal();
        });
    }

    function openAllianceSettingsModal() {
        const m = document.getElementById('alliance-dash-settings-modal');
        if (!m) return;
        setStatus(document.getElementById('alliance-dash-settings-status'), '', false);
        m.setAttribute('aria-hidden', 'false');
        refreshBodyModalOpenClass();
    }

    function openAllianceModal() {
        const m = document.getElementById('alliance-dash-modal');
        if (!m) return;
        m.setAttribute('aria-hidden', 'false');
        refreshBodyModalOpenClass();
        const idInput = document.getElementById('alliance-dash-id-input');
        if (idInput) {
            setTimeout(function () {
                try {
                    idInput.focus();
                } catch (e) {
                    /* ignore */
                }
            }, 30);
        }
        if (!allianceModalEscapeBound) {
            allianceModalEscapeBound = true;
            document.addEventListener('keydown', function (e) {
                if (e.key !== 'Escape') return;
                const settings = document.getElementById('alliance-dash-settings-modal');
                if (settings && settings.getAttribute('aria-hidden') === 'false') {
                    closeAllianceSettingsModal();
                    return;
                }
                const modal = document.getElementById('alliance-dash-modal');
                if (modal && modal.getAttribute('aria-hidden') === 'false') closeAllianceModal();
            });
        }
    }

    function subscribeAlliance(allianceId) {
        stopListeners();
        stopIntelAutoRefresh();
        currentAllianceId = String(allianceId || '').trim();
        try {
            if (currentAllianceId) localStorage.setItem(STORAGE_ALLIANCE_ID, currentAllianceId);
            else localStorage.removeItem(STORAGE_ALLIANCE_ID);
        } catch (e) {
            /* ignore */
        }
        const idInput = document.getElementById('alliance-dash-id-input');
        if (idInput) idInput.value = currentAllianceId;

        if (!currentAllianceId || typeof firebase === 'undefined' || !firebase.firestore) {
            if (pendingOpenSettingsAllianceId) pendingOpenSettingsAllianceId = '';
            lastAllianceDoc = null;
            lastVaultRows = [];
            lastIntelMap = null;
            lastFactionTerritory = Object.create(null);
            lastTerritoryWars = null;
            renderVaultTable();
            updateIntelHeadingAllianceName('');
            if (!currentAllianceId) {
                updateLoadedAllianceStatus('No alliance loaded — use Open on a card or Create or join.', false);
            } else {
                updateLoadedAllianceStatus('Firebase is not available; alliance data cannot load here.', true);
            }
            updateActiveAllianceCardHighlight();
            updateTerritoryRefreshButtonUi();
            return;
        }

        lastAllianceDoc = null;
        lastVaultRows = [];
        lastIntelMap = null;
        lastFactionTerritory = Object.create(null);
        lastTerritoryWars = null;
        renderVaultTable();
        updateIntelHeadingAllianceName('');
        updateTerritoryRefreshButtonUi();

        updateLoadedAllianceStatus('Loading alliance…', false);

        const db = firebase.firestore();
        const ref = db.collection('alliances').doc(currentAllianceId);

        unsubTerritory = ref.collection('factionTerritory').onSnapshot(
            function (q) {
                var next = Object.create(null);
                q.docs.forEach(function (doc) {
                    next[doc.id] = doc.data();
                });
                lastFactionTerritory = next;
                if (lastIntelMap) renderIntelResults(lastIntelMap);
                if (isSettingsModalVisible()) renderAllianceSettingsPanel();
            },
            function (err) {
                console.warn('[Alliance] territory listener', err);
            }
        );

        unsubAlliance = ref.onSnapshot(
            function (snap) {
                if (!snap.exists) {
                    lastAllianceDoc = null;
                    lastFactionTerritory = Object.create(null);
                    lastIntelMap = null;
                    lastTerritoryWars = null;
                    if (pendingOpenSettingsAllianceId === currentAllianceId) pendingOpenSettingsAllianceId = '';
                    updateIntelHeadingAllianceName('');
                    updateLoadedAllianceStatus('No alliance document for this ID.', true);
                    updateActiveAllianceCardHighlight();
                    stopIntelAutoRefresh();
                    refreshIntel();
                    return;
                }
                lastAllianceDoc = snap.data();
                const name = lastAllianceDoc.name || 'Alliance';
                const n = factionIdsFromDoc(lastAllianceDoc).length;
                updateLoadedAllianceStatus(
                    'Active alliance: ' + name + ' · ' + n + ' faction' + (n === 1 ? '' : 's') + ' · ID ' + currentAllianceId,
                    false
                );
                ensurePlayerIdFromTorn().then(function () {
                    updateRepairDirectoryUi();
                    updateTerritoryRefreshButtonUi();
                    if (isSettingsModalVisible()) renderAllianceSettingsPanel();
                });
                if (pendingOpenSettingsAllianceId && pendingOpenSettingsAllianceId === currentAllianceId) {
                    pendingOpenSettingsAllianceId = '';
                    ensurePlayerIdFromTorn().then(function () {
                        renderAllianceSettingsPanel();
                        openAllianceSettingsModal();
                    });
                }
                updateActiveAllianceCardHighlight();
                refreshIntel();
                scheduleIntelAutoRefresh();
            },
            function (err) {
                lastAllianceDoc = null;
                if (pendingOpenSettingsAllianceId === currentAllianceId) pendingOpenSettingsAllianceId = '';
                updateIntelHeadingAllianceName('');
                updateLoadedAllianceStatus(err.message || String(err), true);
                updateActiveAllianceCardHighlight();
                stopIntelAutoRefresh();
                refreshIntel();
            }
        );

        unsubVault = ref
            .collection('vaultItems')
            .orderBy('updatedAt', 'desc')
            .onSnapshot(
                function (q) {
                    lastVaultRows = q.docs.map(function (d) {
                        return { id: d.id, data: d.data() };
                    });
                    renderVaultTable();
                },
                function (err) {
                    console.warn('[Alliance] vault listener', err);
                }
            );
    }

    function wireDom() {
        document.querySelectorAll('.alliance-dash-open-modal').forEach(function (btn) {
            btn.addEventListener('click', function () {
                openAllianceModal();
            });
        });

        const backdrop = document.getElementById('alliance-dash-modal-backdrop');
        const closeBtn = document.getElementById('alliance-dash-modal-close');
        if (backdrop) backdrop.addEventListener('click', closeAllianceModal);
        if (closeBtn) closeBtn.addEventListener('click', closeAllianceModal);

        const settingsBackdrop = document.getElementById('alliance-dash-settings-modal-backdrop');
        const settingsClose = document.getElementById('alliance-dash-settings-modal-close');
        if (settingsBackdrop) settingsBackdrop.addEventListener('click', closeAllianceSettingsModal);
        if (settingsClose) settingsClose.addEventListener('click', closeAllianceSettingsModal);

        document.getElementById('alliance-dash-copy-id') &&
            document.getElementById('alliance-dash-copy-id').addEventListener('click', function () {
                const id = currentAllianceId || (document.getElementById('alliance-dash-settings-id-display') || {}).textContent || '';
                const t = String(id).trim();
                if (!t) return;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(t).then(
                        function () {
                            setStatus(document.getElementById('alliance-dash-settings-status'), 'Copied alliance ID.', false);
                        },
                        function () {
                            window.prompt('Alliance ID (copy manually):', t);
                        }
                    );
                } else {
                    window.prompt('Alliance ID (copy manually):', t);
                }
            });

        document.getElementById('alliance-dash-rename-save') &&
            document.getElementById('alliance-dash-rename-save').addEventListener('click', function () {
                const apiKey = getApiKey();
                const nameEl = document.getElementById('alliance-dash-settings-name');
                const newName = nameEl ? nameEl.value : '';
                const st = document.getElementById('alliance-dash-settings-status');
                if (!currentAllianceId) {
                    setStatus(st, 'No alliance loaded.', true);
                    return;
                }
                if (!apiKey || apiKey.length !== 16) {
                    setStatus(st, 'API key required.', true);
                    return;
                }
                if (!String(newName || '').trim()) {
                    setStatus(st, 'Enter a display name.', true);
                    return;
                }
                setStatus(st, 'Saving…', false);
                callHttps('allianceRename', { apiKey: apiKey, allianceId: currentAllianceId, newName: newName })
                    .then(function () {
                        setStatus(st, 'Name updated.', false);
                        refreshMyAllianceList();
                    })
                    .catch(function (err) {
                        setStatus(st, err.message || String(err), true);
                    });
            });

        const settingsDialog = document.querySelector('#alliance-dash-settings-modal .alliance-dash-modal-dialog');
        if (settingsDialog && !settingsDialog._allianceSettingsFactionClicks) {
            settingsDialog._allianceSettingsFactionClicks = true;
            settingsDialog.addEventListener('click', function (e) {
                const rm = e.target && e.target.closest && e.target.closest('.alliance-dash-remove-faction');
                if (!rm) return;
                const fid = rm.getAttribute('data-fid');
                if (!fid || !currentAllianceId) return;
                if (
                    !confirm(
                        'Remove faction ' +
                            fid +
                            ' from this alliance? Shared vault entries held by this faction will be deleted.'
                    )
                ) {
                    return;
                }
                const apiKey = getApiKey();
                const st = document.getElementById('alliance-dash-settings-status');
                if (!apiKey || apiKey.length !== 16) {
                    setStatus(st, 'API key required.', true);
                    return;
                }
                setStatus(st, 'Removing…', false);
                callHttps('allianceRemoveFaction', {
                    apiKey: apiKey,
                    allianceId: currentAllianceId,
                    factionIdToRemove: fid
                })
                    .then(function () {
                        setStatus(st, 'Faction removed.', false);
                        refreshMyAllianceList();
                    })
                    .catch(function (err) {
                        setStatus(st, err.message || String(err), true);
                    });
            });
        }

        const loadBtn = document.getElementById('alliance-dash-load-btn');
        const idInput = document.getElementById('alliance-dash-id-input');
        if (loadBtn && idInput) {
            loadBtn.addEventListener('click', function () {
                const raw = (idInput.value || '').trim();
                if (!raw) {
                    alert('Paste an alliance ID first.');
                    return;
                }
                subscribeAlliance(raw);
                closeAllianceModal();
            });
        }

        document.getElementById('alliance-dash-create-btn') &&
            document.getElementById('alliance-dash-create-btn').addEventListener('click', function () {
                const apiKey = getApiKey();
                const nameEl = document.getElementById('alliance-dash-create-name');
                const name = nameEl ? nameEl.value : '';
                if (!apiKey || apiKey.length !== 16) {
                    updateLoadedAllianceStatus('Set a 16-character API key in the sidebar.', true);
                    return;
                }
                updateLoadedAllianceStatus('Creating alliance…', false);
                callHttps('allianceCreate', { apiKey: apiKey, allianceName: name })
                    .then(function (res) {
                        if (res && res.allianceId) {
                            if (idInput) idInput.value = res.allianceId;
                            subscribeAlliance(res.allianceId);
                            updateLoadedAllianceStatus('Created. Alliance ID: ' + res.allianceId + ' — use Settings on the card to manage.', false);
                            refreshMyAllianceList();
                            if (nameEl) nameEl.value = '';
                            closeAllianceModal();
                        }
                    })
                    .catch(function (err) {
                        updateLoadedAllianceStatus(err.message || String(err), true);
                    });
            });

        document.getElementById('alliance-dash-add-btn') &&
            document.getElementById('alliance-dash-add-btn').addEventListener('click', function () {
                const apiKey = getApiKey();
                const fidEl = document.getElementById('alliance-dash-add-fid');
                const fid = fidEl ? fidEl.value.trim() : '';
                const st = document.getElementById('alliance-dash-settings-status');
                if (!currentAllianceId) {
                    setStatus(st, 'Load an alliance first (My alliances or Create or join).', true);
                    return;
                }
                if (!apiKey || apiKey.length !== 16) {
                    setStatus(st, 'API key required.', true);
                    return;
                }
                if (!fid) {
                    setStatus(st, 'Enter a faction ID.', true);
                    return;
                }
                setStatus(st, 'Adding faction…', false);
                callHttps('allianceAddFaction', {
                    apiKey: apiKey,
                    allianceId: currentAllianceId,
                    factionIdToAdd: fid
                })
                    .then(function () {
                        setStatus(st, 'Faction added.', false);
                        if (fidEl) fidEl.value = '';
                        refreshMyAllianceList();
                    })
                    .catch(function (err) {
                        setStatus(st, err.message || String(err), true);
                    });
            });

        document.getElementById('alliance-dash-refresh-intel') &&
            document.getElementById('alliance-dash-refresh-intel').addEventListener('click', function () {
                var autoCb = document.getElementById('alliance-dash-intel-auto');
                if (autoCb && autoCb.checked && intelAutoRefreshTickId != null) {
                    intelAutoRefreshNextAt = Date.now() + getIntelAutoRefreshIntervalMs();
                    updateIntelAutoCountdownUi();
                }
                refreshIntel();
            });

        var terrRefBtn = document.getElementById('alliance-dash-refresh-territory');
        if (terrRefBtn && !terrRefBtn._allianceTerrRefBound) {
            terrRefBtn._allianceTerrRefBound = true;
            terrRefBtn.addEventListener('click', function () {
                var apiKeyT = getApiKey();
                var stT = document.getElementById('alliance-dash-territory-sync-status');
                if (!currentAllianceId || !apiKeyT || apiKeyT.length !== 16) {
                    if (stT) {
                        stT.textContent = 'Alliance and API key required.';
                        stT.style.color = '#ff6b6b';
                    }
                    return;
                }
                if (stT) {
                    stT.textContent = 'Syncing territory from Torn…';
                    stT.style.color = '';
                }
                callHttps('allianceTerritorySyncFromApi', { apiKey: apiKeyT, allianceId: currentAllianceId })
                    .then(function () {
                        if (stT) {
                            stT.textContent = 'Territory updated for your faction.';
                            stT.style.color = '#8fbc8f';
                        }
                    })
                    .catch(function (err) {
                        if (stT) {
                            stT.textContent = err.message || String(err);
                            stT.style.color = '#ff6b6b';
                        }
                    });
            });
        }

        var intelSliderWrap = document.getElementById('alliance-dash-intel-auto-slider-wrap');
        if (intelSliderWrap) {
            intelSliderWrap.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        }

        var intelAutoCb = document.getElementById('alliance-dash-intel-auto');
        var intelIntervalSel = document.getElementById('alliance-dash-intel-interval');
        if (intelAutoCb && !intelAutoCb._allianceIntelAutoBound) {
            intelAutoCb._allianceIntelAutoBound = true;
            intelAutoCb.addEventListener('change', function () {
                if (!intelAutoCb.checked) {
                    var stClear = document.getElementById('alliance-dash-intel-auto-status');
                    if (stClear) stClear.textContent = '';
                }
                persistIntelAutoPrefs();
                updateIntelAutoRefreshControlsVisibility();
                scheduleIntelAutoRefresh();
            });
        }
        if (intelIntervalSel && !intelIntervalSel._allianceIntelIntervalBound) {
            intelIntervalSel._allianceIntelIntervalBound = true;
            intelIntervalSel.addEventListener('change', function () {
                persistIntelAutoPrefs();
                scheduleIntelAutoRefresh();
            });
        }

        const form = document.getElementById('alliance-dash-vault-form');
        if (form) {
            form.addEventListener('submit', function (e) {
                e.preventDefault();
                const apiKey = getApiKey();
                if (!currentAllianceId) {
                    alert('Load an alliance first.');
                    return;
                }
                if (!apiKey || apiKey.length !== 16) {
                    alert('Set your API key in the sidebar.');
                    return;
                }
                const editId = document.getElementById('alliance-dash-vault-edit-id').value.trim();
                const label = document.getElementById('alliance-dash-vault-label').value.trim();
                const location = document.getElementById('alliance-dash-vault-location').value.trim();
                const holder = document.getElementById('alliance-dash-vault-holder').value.trim();
                const notes = document.getElementById('alliance-dash-vault-notes').value.trim();
                const payload = {
                    apiKey: apiKey,
                    allianceId: currentAllianceId,
                    label: label,
                    location: location,
                    notes: notes,
                    holderFactionId: holder || undefined,
                    itemId: editId || undefined
                };
                callHttps('allianceVaultUpsert', payload)
                    .then(function () {
                        form.reset();
                        document.getElementById('alliance-dash-vault-edit-id').value = '';
                        const cancel = document.getElementById('alliance-dash-vault-cancel-edit');
                        if (cancel) cancel.style.display = 'none';
                        const sub = document.getElementById('alliance-dash-vault-submit');
                        if (sub) sub.textContent = 'Save to vault';
                    })
                    .catch(function (err) {
                        alert(err.message || String(err));
                    });
            });
        }

        const cancel = document.getElementById('alliance-dash-vault-cancel-edit');
        if (cancel) {
            cancel.addEventListener('click', function () {
                const vf = document.getElementById('alliance-dash-vault-form');
                if (vf && vf.reset) vf.reset();
                const hid = document.getElementById('alliance-dash-vault-edit-id');
                if (hid) hid.value = '';
                cancel.style.display = 'none';
                const sub = document.getElementById('alliance-dash-vault-submit');
                if (sub) sub.textContent = 'Save to vault';
            });
        }

        bindVaultTableActions();

        document.getElementById('alliance-dash-refresh-mine') &&
            document.getElementById('alliance-dash-refresh-mine').addEventListener('click', function () {
                refreshMyAllianceList();
            });

        const showHiddenEl = document.getElementById('alliance-dash-show-hidden');
        if (showHiddenEl) {
            showHiddenEl.addEventListener('change', function () {
                showHiddenAlliances = !!showHiddenEl.checked;
                renderMyAlliances();
            });
        }

        document.getElementById('alliance-dash-repair-index') &&
            document.getElementById('alliance-dash-repair-index').addEventListener('click', function () {
                const apiKey = getApiKey();
                const st = document.getElementById('alliance-dash-settings-status');
                if (!currentAllianceId || !apiKey) return;
                setStatus(st, 'Repairing directory…', false);
                callHttps('allianceBackfillMembershipIndex', { apiKey: apiKey, allianceId: currentAllianceId })
                    .then(function (res) {
                        setStatus(st, 'Directory updated (' + (res.count || 0) + ' factions).', false);
                        refreshMyAllianceList();
                    })
                    .catch(function (err) {
                        setStatus(st, err.message || String(err), true);
                    });
            });

        const myList = document.getElementById('alliance-dash-my-list');
        if (myList && !myList._allianceMyBound) {
            myList._allianceMyBound = true;
            myList.addEventListener('click', function (e) {
                const openB = e.target && e.target.closest && e.target.closest('.alliance-dash-open-alliance');
                const setB = e.target && e.target.closest && e.target.closest('.alliance-dash-card-settings');
                const hideB = e.target && e.target.closest && e.target.closest('.alliance-dash-hide-alliance');
                if (openB) {
                    const aid = openB.getAttribute('data-aid');
                    if (aid) {
                        subscribeAlliance(aid);
                        const idInput = document.getElementById('alliance-dash-id-input');
                        if (idInput) idInput.value = aid;
                        closeAllianceModal();
                    }
                    return;
                }
                if (setB) {
                    const aid = setB.getAttribute('data-aid');
                    if (aid) openSettingsForAlliance(aid);
                    return;
                }
                if (hideB) {
                    const aid = hideB.getAttribute('data-aid');
                    if (!aid || !cachedPlayerId) return;
                    const hidden = getHiddenAllianceIdsSet(cachedPlayerId);
                    if (hidden.has(aid)) {
                        hidden.delete(aid);
                    } else {
                        hidden.add(aid);
                    }
                    saveHiddenAllianceIds(cachedPlayerId, hidden);
                    renderMyAlliances();
                }
            });
        }

        var settingsRoot = document.getElementById('alliance-dash-settings-modal');
        if (settingsRoot && !settingsRoot._allianceTerritoryUiBound) {
            settingsRoot._allianceTerritoryUiBound = true;
            settingsRoot.addEventListener('click', function (e) {
                var ed = e.target && e.target.closest && e.target.closest('.alliance-dash-terr-edit');
                if (ed) {
                    e.preventDefault();
                    var fidEd = ed.getAttribute('data-fid');
                    var mw = document.getElementById('alliance-dash-terr-manual-wrap');
                    var ta = document.getElementById('alliance-dash-terr-manual-ta');
                    var hid = document.getElementById('alliance-dash-terr-manual-fid');
                    if (!mw || !ta || !hid || !fidEd) return;
                    hid.value = fidEd;
                    var existing = lastFactionTerritory[fidEd];
                    ta.value = existing && existing.summary ? String(existing.summary) : '';
                    mw.style.display = 'block';
                }
            });
        }

        var terrManSave = document.getElementById('alliance-dash-terr-manual-save');
        if (terrManSave && !terrManSave._allianceTerrManualSaveBound) {
            terrManSave._allianceTerrManualSaveBound = true;
            terrManSave.addEventListener('click', function () {
                var apiKeyM = getApiKey();
                var stM = document.getElementById('alliance-dash-settings-status');
                var fidM = (document.getElementById('alliance-dash-terr-manual-fid') || {}).value;
                var taM = document.getElementById('alliance-dash-terr-manual-ta');
                var txtM = taM ? taM.value.trim() : '';
                if (!currentAllianceId || !apiKeyM || apiKeyM.length !== 16 || !fidM) {
                    setStatus(stM, 'Missing alliance, key, or faction.', true);
                    return;
                }
                if (!txtM) {
                    setStatus(stM, 'Enter territory text.', true);
                    return;
                }
                setStatus(stM, 'Saving…', false);
                callHttps('allianceTerritorySetManual', {
                    apiKey: apiKeyM,
                    allianceId: currentAllianceId,
                    factionId: fidM,
                    summary: txtM
                })
                    .then(function () {
                        setStatus(stM, 'Territory note saved.', false);
                        var mw2 = document.getElementById('alliance-dash-terr-manual-wrap');
                        if (mw2) mw2.style.display = 'none';
                    })
                    .catch(function (err) {
                        setStatus(stM, err.message || String(err), true);
                    });
            });
        }

        var terrManCancel = document.getElementById('alliance-dash-terr-manual-cancel');
        if (terrManCancel && !terrManCancel._allianceTerrManualCancelBound) {
            terrManCancel._allianceTerrManualCancelBound = true;
            terrManCancel.addEventListener('click', function () {
                var mw3 = document.getElementById('alliance-dash-terr-manual-wrap');
                if (mw3) mw3.style.display = 'none';
            });
        }

        var intelGrid = document.getElementById('alliance-dash-intel-grid');
        if (intelGrid && !intelGrid._allianceTerrTileClicks) {
            intelGrid._allianceTerrTileClicks = true;
            intelGrid.addEventListener('click', function (e) {
                var addBtn = e.target && e.target.closest && e.target.closest('.alliance-dash-terr-manual-add');
                var rmBtn = e.target && e.target.closest && e.target.closest('.alliance-dash-terr-manual-rm');
                function showTerrTileErr(foot, msg) {
                    var err = foot && foot.querySelector('.alliance-dash-terr-manual-err');
                    if (!err) return;
                    if (msg) {
                        err.textContent = msg;
                        err.hidden = false;
                    } else {
                        err.textContent = '';
                        err.hidden = true;
                    }
                }
                if (addBtn) {
                    var footA = addBtn.closest('.alliance-dash-terr-manual-foot');
                    if (!footA) return;
                    var fidA = footA.getAttribute('data-fid');
                    var inpA = footA.querySelector('.alliance-dash-terr-manual-inp');
                    var apiKeyA = getApiKey();
                    if (!currentAllianceId || !fidA) return;
                    if (!apiKeyA || apiKeyA.length !== 16) {
                        showTerrTileErr(footA, 'Set a valid API key in the sidebar.');
                        return;
                    }
                    var raw = inpA ? inpA.value : '';
                    var norm = normalizeSingleTerritoryCodeInput(raw);
                    if (!norm) {
                        showTerrTileErr(footA, 'Enter a 2–4 letter territory code.');
                        return;
                    }
                    var snapA = lastFactionTerritory[String(fidA)] || null;
                    var mergedA = mergeTerritoryCodesFromSnap(snapA);
                    if (mergedA.codes.indexOf(norm) !== -1) {
                        showTerrTileErr(footA, 'That code is already listed.');
                        return;
                    }
                    var curA = normalizeTileCodeListClient(snapA && snapA.manualTileCodes);
                    curA.push(norm);
                    showTerrTileErr(footA, '');
                    callHttps('allianceTerritorySetManualTileCodes', {
                        apiKey: apiKeyA,
                        allianceId: currentAllianceId,
                        factionId: fidA,
                        tileCodes: curA
                    }).catch(function (err) {
                        showTerrTileErr(footA, err.message || String(err));
                    });
                    if (inpA) inpA.value = '';
                    return;
                }
                if (rmBtn) {
                    var fidR = rmBtn.getAttribute('data-fid');
                    var codeR = rmBtn.getAttribute('data-code');
                    var footR = rmBtn.closest('.alliance-dash-terr-manual-foot');
                    var apiKeyR = getApiKey();
                    if (!currentAllianceId || !fidR || !codeR) return;
                    if (!apiKeyR || apiKeyR.length !== 16) {
                        if (footR) showTerrTileErr(footR, 'Set a valid API key in the sidebar.');
                        return;
                    }
                    var snapR = lastFactionTerritory[String(fidR)] || null;
                    var curR = normalizeTileCodeListClient(snapR && snapR.manualTileCodes);
                    var nextR = curR.filter(function (c) {
                        return c !== codeR;
                    });
                    if (footR) showTerrTileErr(footR, '');
                    callHttps('allianceTerritorySetManualTileCodes', {
                        apiKey: apiKeyR,
                        allianceId: currentAllianceId,
                        factionId: fidR,
                        tileCodes: nextR
                    }).catch(function (err) {
                        if (footR) showTerrTileErr(footR, err.message || String(err));
                    });
                }
            });
        }
    }

    window.initAllianceDashboard = function () {
        wireDom();
        applyIntelAutoRefreshPrefs();
        let initial = '';
        try {
            initial = localStorage.getItem(STORAGE_ALLIANCE_ID) || '';
        } catch (e) {
            /* ignore */
        }
        const idInput = document.getElementById('alliance-dash-id-input');
        if (idInput && initial) idInput.value = initial;
        if (initial) subscribeAlliance(initial);
        else {
            lastAllianceDoc = null;
            currentAllianceId = '';
            lastVaultRows = [];
            lastIntelMap = null;
            lastFactionTerritory = Object.create(null);
            lastTerritoryWars = null;
            renderVaultTable();
            updateIntelHeadingAllianceName('');
            updateLoadedAllianceStatus('No alliance loaded — use Open on a card or Create or join.', false);
            const grid = document.getElementById('alliance-dash-intel-grid');
            if (grid) grid.innerHTML = '<p class="alliance-dash-empty">Create or load an alliance to see faction cards.</p>';
            updateTerritoryRefreshButtonUi();
        }
        refreshMyAllianceList();
    };

    window.addEventListener('hashchange', function () {
        const h = (window.location.hash || '').replace('#', '').split('/')[0];
        if (h !== 'alliance-dashboard') {
            closeAllianceModal();
            closeAllianceSettingsModal();
            stopIntelAutoRefresh();
            stopListeners();
        }
    });
})();
