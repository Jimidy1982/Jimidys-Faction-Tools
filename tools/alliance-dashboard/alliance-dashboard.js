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
    /** Vault table column sort: key matches `data-vault-sort` on header buttons; empty = Firestore order. */
    let vaultTableSortKey = '';
    let vaultTableSortDir = 'asc';
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
    /** Owned-by combobox: faction id -> [{ id, name }] from v2 `faction/{id}/members` (not part of intel pulls). */
    let purchaserMembersByFactionId = Object.create(null);

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

    /** Split a single Torn-style bonus string (e.g. "21% Wither") into type + value. */
    function splitTornBonusLine(line) {
        const t = String(line || '')
            .trim()
            .replace(/\s+/g, ' ');
        if (!t) return { type: '', value: '' };
        const pctFirst = t.match(/^([\d.]+%?)\s+(.+)$/);
        if (pctFirst) return { value: pctFirst[1].trim(), type: pctFirst[2].trim() };
        const pctLast = t.match(/^(.+?)\s+([\d.]+%?)$/);
        if (pctLast) return { type: pctLast[1].trim(), value: pctLast[2].trim() };
        return { type: t, value: '' };
    }

    /** Normalized bonus slots from a vault doc (prefers bonus1Type/Value; migrates legacy bonus1 string). */
    function vaultRowBonusesFromDoc(d) {
        const data = d || {};
        let b1t = String(data.bonus1Type || '').trim();
        let b1v = String(data.bonus1Value || '').trim();
        let b2t = String(data.bonus2Type || '').trim();
        let b2v = String(data.bonus2Value || '').trim();
        if (!b1t && !b1v && data.bonus1) {
            const s1 = splitTornBonusLine(data.bonus1);
            b1t = s1.type;
            b1v = s1.value;
        }
        if (!b2t && !b2v && data.bonus2) {
            const s2 = splitTornBonusLine(data.bonus2);
            b2t = s2.type;
            b2v = s2.value;
        }
        return { b1t: b1t, b1v: b1v, b2t: b2t, b2v: b2v };
    }

    /** Strip trailing Yellow/Orange/Red from a quality string; return clean quality + rarity. */
    function splitQualityAndRarityString(s) {
        const t = String(s || '').trim();
        if (!t) return { quality: '', rarity: '' };
        const m = t.match(/^(.+?)\s+(yellow|orange|red)\s*$/i);
        if (m) return { quality: m[1].trim(), rarity: m[2].toLowerCase() };
        return { quality: t, rarity: '' };
    }

    /** Parse pasted Torn item text into vault form fields (best-effort). */
    function extractVaultFromTornPaste(text) {
        const out = {
            label: '',
            bonus1Type: '',
            bonus1Value: '',
            bonus2Type: '',
            bonus2Value: '',
            accuracy: '',
            damage: '',
            quality: '',
            weaponRarity: '',
        };
        const raw = String(text || '').replace(/\r/g, '');
        const dmgM = raw.match(/^\s*Damage:\s*([\d.]+)\s*$/im);
        if (dmgM) out.damage = dmgM[1].trim();
        const acM = raw.match(/^\s*Accuracy:\s*([\d.]+)\s*$/im);
        if (acM) out.accuracy = acM[1].trim();

        const bonusMatches = [];
        raw.replace(/^\s*Bonus:\s*(.+)$/gim, function (_, b) {
            bonusMatches.push(String(b).trim().replace(/\s+/g, ' '));
        });
        if (bonusMatches[0]) {
            const s1 = splitTornBonusLine(bonusMatches[0]);
            out.bonus1Type = s1.type;
            out.bonus1Value = s1.value;
        }
        if (bonusMatches[1]) {
            const s2 = splitTornBonusLine(bonusMatches[1]);
            out.bonus2Type = s2.type;
            out.bonus2Value = s2.value;
        }

        const lines = raw.split('\n').map(function (l) {
            return l.trim();
        });

        let qual = '';
        const qSame = raw.match(/^\s*Quality:\s*([\d.]+%?)(?:\s+(yellow|orange|red))?\s*$/im);
        if (qSame && qSame[1]) {
            qual = qSame[1].trim();
            if (qSame[2]) qual = qual + ' ' + qSame[2];
        } else {
            for (let i = 0; i < lines.length; i++) {
                const ln = lines[i];
                if (/^Quality:\s*$/i.test(ln)) {
                    const nextL = lines[i + 1] || '';
                    const qNext = nextL.match(/^(\d+\.\d+\s*%?)(?:\s+(yellow|orange|red))?\s*$/i);
                    if (qNext) {
                        qual = String(qNext[1]).replace(/\s+/g, '');
                        if (qNext[2]) qual = qual + ' ' + qNext[2];
                        let j = i + 2;
                        const parts = [];
                        while (j < lines.length && lines[j].length > 0 && lines[j].length <= 14) {
                            if (/^(Buy|Sell|Damage|Accuracy|Bonus|Rate|Stealth|Caliber|Ammo|Value|Circ|Item)\b/i.test(lines[j])) break;
                            if (qNext[2] && /^(yellow|orange|red)$/i.test(lines[j])) {
                                j++;
                                continue;
                            }
                            parts.push(lines[j]);
                            j++;
                            if (parts.join('').length > 28) break;
                        }
                        if (parts.length) qual = (qual ? qual + ' ' : '') + parts.join(' ');
                        break;
                    }
                }
                const qInline = ln.match(/^Quality:\s*(.+)$/i);
                if (qInline && qInline[1] && qInline[1].trim()) {
                    const cap = qInline[1].trim();
                    if (/^\d+\.\d+\s*%?$/.test(cap) && lines[i + 1] && /^(yellow|orange|red)$/i.test(lines[i + 1])) {
                        qual = cap.replace(/\s+/g, '') + ' ' + lines[i + 1];
                    } else {
                        qual = cap;
                    }
                    break;
                }
            }
        }
        const qr = splitQualityAndRarityString(qual);
        if (qr.quality) out.quality = qr.quality;
        if (qr.rarity) out.weaponRarity = qr.rarity;

        const nonempty = lines.filter(Boolean);
        if (nonempty.length) {
            const tokens = nonempty[0].split(/\s+/);
            let found = -1;
            for (let t = 0; t < tokens.length - 1; t++) {
                if (/^\d+\.\d+$/.test(tokens[t]) && /^\d+\.\d+$/.test(tokens[t + 1])) {
                    found = t;
                    break;
                }
            }
            if (found >= 0) {
                const name = tokens.slice(0, found).join(' ').trim();
                if (name && !/^Damage:$/i.test(name)) {
                    if (!out.label) out.label = name;
                    if (!out.damage) out.damage = tokens[found];
                    if (!out.accuracy) out.accuracy = tokens[found + 1];
                }
            } else if (!/^Damage:|Accuracy:|Buy:|Sell:|This\s+/i.test(nonempty[0])) {
                if (!out.label) out.label = nonempty[0];
            }
        }

        const thisM = raw.match(/This\s+(.+?)\s+is\s+a\s+/im);
        if (thisM && thisM[1]) {
            const t = thisM[1].trim();
            if (!out.label) out.label = t;
        }

        if (!out.weaponRarity) {
            const afterPct = raw.match(/\d+\.\d+%(?:\s*|\s*\r?\n\s*|\s+)(yellow|orange|red)\b/i);
            if (afterPct) out.weaponRarity = afterPct[1].toLowerCase();
        }
        if (!out.weaponRarity) {
            const nearQ = raw.match(/quality:\s*[\s\S]{0,160}?\b(yellow|orange|red)\b/i);
            if (nearQ) out.weaponRarity = nearQ[1].toLowerCase();
        }

        return out;
    }

    /** Torn global items map (id -> item); loaded on demand via `torn/?selections=items`. */
    let vaultTornItemsMap = null;
    let vaultTornItemsLoadPromise = null;

    function ensureVaultTornItemsMapLoaded() {
        const apiKey = getApiKey();
        if (!apiKey || apiKey.length !== 16) {
            return Promise.reject(new Error('Set your API key in the sidebar.'));
        }
        if (vaultTornItemsMap) return Promise.resolve(vaultTornItemsMap);
        if (vaultTornItemsLoadPromise) return vaultTornItemsLoadPromise;
        vaultTornItemsLoadPromise = fetchJson(
            'https://api.torn.com/torn/?selections=items&key=' + encodeURIComponent(apiKey)
        )
            .then(function (data) {
                vaultTornItemsMap = data && data.items && typeof data.items === 'object' ? data.items : {};
                vaultTornItemsLoadPromise = null;
                return vaultTornItemsMap;
            })
            .catch(function (e) {
                vaultTornItemsLoadPromise = null;
                vaultTornItemsMap = null;
                throw e;
            });
        return vaultTornItemsLoadPromise;
    }

    function normVaultItemLabel(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** True if Torn `torn/?selections=items` row looks like a weapon (v1 uses top-level `type` = Primary etc. or `weapon_type`). */
    function tornItemLooksLikeWeapon(it) {
        if (!it || typeof it !== 'object') return false;
        if (it.weapon_type != null && String(it.weapon_type).trim() !== '') return true;
        const t = String(it.type || '').trim().toLowerCase();
        if (t === 'weapon') return true;
        return t === 'melee' || t === 'primary' || t === 'secondary' || t === 'temporary';
    }

    /** Best weapon row from Torn items catalog for a pasted / typed label. */
    function findBestTornWeaponItemMatch(label, itemsMap) {
        const q = normVaultItemLabel(label);
        if (!q || !itemsMap) return null;
        const rows = Object.keys(itemsMap).map(function (id) {
            return { id: id, it: itemsMap[id] };
        });
        const weapons = rows.filter(function (x) {
            return x.it && tornItemLooksLikeWeapon(x.it);
        });
        const pool = weapons.length ? weapons : rows;
        var i;
        var x;
        var nm;
        for (i = 0; i < pool.length; i++) {
            x = pool[i];
            nm = normVaultItemLabel(x.it && x.it.name);
            if (nm && nm === q) return x;
        }
        var poolSorted = pool.slice().sort(function (a, b) {
            return normVaultItemLabel(a.it.name).length - normVaultItemLabel(b.it.name).length;
        });
        for (i = 0; i < poolSorted.length; i++) {
            x = poolSorted[i];
            nm = normVaultItemLabel(x.it && x.it.name);
            if (nm && (nm.indexOf(q) === 0 || q.indexOf(nm) === 0)) return x;
        }
        for (i = 0; i < poolSorted.length; i++) {
            x = poolSorted[i];
            nm = normVaultItemLabel(x.it && x.it.name);
            if (nm && (nm.indexOf(q) >= 0 || q.indexOf(nm) >= 0)) return x;
        }
        return null;
    }

    /** Stored Firestore value for weapon equip slot (lowercase). */
    function vaultNormalizeWeaponSlotStored(raw) {
        if (raw == null || raw === '') return '';
        const s = String(raw).trim().toLowerCase();
        if (s === 'melee' || s === 'primary' || s === 'secondary' || s === 'temporary') return s;
        return '';
    }

    /**
     * Equip slot key from Torn items row: top-level `type` is Primary / Melee / Secondary / Temporary (v1 catalog).
     * Falls back to `details.category` if present (alternate shapes).
     */
    function vaultWeaponSlotCategoryKeyFromTornItem(it) {
        if (!it || typeof it !== 'object') return '';
        var raw = it.type != null ? String(it.type).trim().toLowerCase() : '';
        if (raw === 'melee' || raw === 'primary' || raw === 'secondary' || raw === 'temporary') return raw;
        const det = it.details;
        if (det && typeof det === 'object' && det.category != null) {
            raw = String(det.category).trim().toLowerCase();
            if (raw === 'melee' || raw === 'primary' || raw === 'secondary' || raw === 'temporary') return raw;
        }
        return '';
    }

    /** Display label from catalog item (Melee, Primary, …). */
    function vaultWeaponSlotLabelFromTornItem(it) {
        const k = vaultWeaponSlotCategoryKeyFromTornItem(it);
        return k ? k.charAt(0).toUpperCase() + k.slice(1) : '';
    }

    /** Table / search: prefer saved `weaponSlot`, else Torn item catalog. */
    function vaultWeaponSlotLabelForDoc(d) {
        const st = vaultNormalizeWeaponSlotStored(d && d.weaponSlot);
        if (st) return st.charAt(0).toUpperCase() + st.slice(1);
        const tid = String(d && d.tornItemId != null ? d.tornItemId : '').trim();
        if (!tid || !vaultTornItemsMap) return '';
        return vaultWeaponSlotLabelFromTornItem(vaultTornItemsMap[tid]) || '';
    }

    function syncVaultModalWeaponSlotFromTornItem(it) {
        const slotSel = document.getElementById('alliance-dash-vault-weapon-slot');
        if (!slotSel || !it) return;
        const k = vaultWeaponSlotCategoryKeyFromTornItem(it);
        slotSel.value = k || '';
    }

    function updateVaultModalItemPreview() {
        const wrap = document.getElementById('alliance-dash-vault-item-preview');
        const idEl = document.getElementById('alliance-dash-vault-torn-item-id');
        const rarityEl = document.getElementById('alliance-dash-vault-weapon-rarity');
        if (!wrap) return;
        const tid = idEl && idEl.value ? String(idEl.value).trim() : '';
        var rw = rarityEl && rarityEl.value ? String(rarityEl.value).trim().toLowerCase() : '';
        if (rw !== 'yellow' && rw !== 'orange' && rw !== 'red') rw = 'yellow';
        wrap.className = 'alliance-dash-vault-item-preview alliance-dash-vault-item-preview--' + rw;
        wrap.innerHTML = '';
        var it = tid && vaultTornItemsMap ? vaultTornItemsMap[tid] : null;
        var imgUrl = it && it.image ? String(it.image).trim() : '';
        if (imgUrl) {
            var im = document.createElement('img');
            im.src = imgUrl;
            im.alt = '';
            im.loading = 'lazy';
            wrap.appendChild(im);
        }
    }

    function setVaultTornMatchStatus(text, isError) {
        setStatus(document.getElementById('alliance-dash-vault-torn-match-status'), text, isError);
    }

    /**
     * Match vault label to Torn global items; set hidden item id + slot from catalog `type` / `details.category`.
     * @returns {Promise<boolean>} true if a catalog row was matched
     */
    function runVaultTornMatchForLabel() {
        const labelEl = document.getElementById('alliance-dash-vault-label');
        const idEl = document.getElementById('alliance-dash-vault-torn-item-id');
        if (!labelEl || !idEl) return Promise.resolve(false);
        const label = labelEl.value.trim();
        if (!label) {
            idEl.value = '';
            const slotSel = document.getElementById('alliance-dash-vault-weapon-slot');
            if (slotSel) slotSel.value = '';
            updateVaultModalItemPreview();
            setVaultTornMatchStatus('', false);
            return Promise.resolve(false);
        }
        setVaultTornMatchStatus('Loading Torn item catalog…', false);
        return ensureVaultTornItemsMapLoaded()
            .then(function (map) {
                const hit = findBestTornWeaponItemMatch(label, map);
                if (hit) {
                    idEl.value = String(hit.id);
                    labelEl.value = String(hit.it.name || label).trim();
                    syncVaultModalWeaponSlotFromTornItem(hit.it);
                    setVaultTornMatchStatus('Matched: ' + (hit.it.name || hit.id) + ' (id ' + hit.id + ').', false);
                    updateVaultModalItemPreview();
                    return true;
                }
                idEl.value = '';
                const slotSel = document.getElementById('alliance-dash-vault-weapon-slot');
                if (slotSel) slotSel.value = '';
                setVaultTornMatchStatus('No weapon match in catalog — try a shorter name.', true);
                updateVaultModalItemPreview();
                return false;
            })
            .catch(function (err) {
                idEl.value = '';
                const slotSel = document.getElementById('alliance-dash-vault-weapon-slot');
                if (slotSel) slotSel.value = '';
                updateVaultModalItemPreview();
                setVaultTornMatchStatus(err.message || String(err), true);
                return false;
            });
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
        if (snap && snap.source === 'manual') {
            return '';
        }
        if (snap && snap.summary) {
            return '';
        }
        if (snap && Array.isArray(snap.manualTileCodes) && snap.manualTileCodes.length) {
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
            'Territory: not in alliance cache yet — ask that faction’s leader to use <strong>Refresh territory</strong> on this panel.' +
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
                    return (
                        '<tr><td>' +
                        escapeHtml(facMeta.name) +
                        '</td><td><code>' +
                        escapeHtml(fid) +
                        '</code></td><td class="alliance-dash-actions">' +
                        removeCell +
                        '</td></tr>'
                    );
                })
                .join('');
        }
        updateRepairDirectoryUi();
        updateTerritoryRefreshButtonUi();
    }

    function updateMyAlliancesShowHiddenControl() {
        const wrap = document.getElementById('alliance-dash-show-hidden-wrap');
        const cb = document.getElementById('alliance-dash-show-hidden');
        if (!wrap || !cb) return;
        const hidden = getHiddenAllianceIdsSet(cachedPlayerId);
        var nHidden = 0;
        for (var i = 0; i < lastMyAlliances.length; i++) {
            var a = lastMyAlliances[i];
            if (!a || a.allianceId == null) continue;
            var aid = String(a.allianceId);
            if (hidden.has(aid)) nHidden++;
        }
        if (nHidden < 1) {
            wrap.hidden = true;
            showHiddenAlliances = false;
            cb.checked = false;
        } else {
            wrap.hidden = false;
        }
    }

    function renderMyAlliances() {
        const el = document.getElementById('alliance-dash-my-list');
        if (!el) return;
        const hidden = getHiddenAllianceIdsSet(cachedPlayerId);
        if (!lastMyAlliances.length) {
            el.innerHTML =
                '<p class="alliance-dash-empty">No alliances linked to your faction yet — or your rank is not Leader / Co-leader (try Refresh list).</p>';
            updateMyAlliancesShowHiddenControl();
            return;
        }
        const rows = lastMyAlliances.filter(function (a) {
            return showHiddenAlliances || !hidden.has(String(a.allianceId));
        });
        if (!rows.length) {
            el.innerHTML =
                '<p class="alliance-dash-empty">All alliances are hidden. Turn on <strong>Show hidden</strong> to see them again.</p>';
            updateMyAlliancesShowHiddenControl();
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
                    '<div class="alliance-dash-my-card-head">' +
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
                    '</div></div></article>'
                );
            })
            .join('');
        updateActiveAllianceCardHighlight();
        updateMyAlliancesShowHiddenControl();
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

    /**
     * After allianceListMine: keep last-saved ID if still listed; else open the sole alliance;
     * clear subscription if stored/current ID is no longer accessible.
     * @param {string} [storedAllianceHint] — value read at page init before reconcile may clear storage
     */
    function reconcileAllianceAutoLoad(storedAllianceHint) {
        var hint = storedAllianceHint;
        if (hint === undefined || hint === null) {
            try {
                hint = localStorage.getItem(STORAGE_ALLIANCE_ID) || '';
            } catch (e) {
                hint = '';
            }
        }
        var stored = String(hint || '').trim();
        var byId = Object.create(null);
        lastMyAlliances.forEach(function (a) {
            if (a && a.allianceId != null) byId[String(a.allianceId)] = true;
        });

        if (stored && !byId[stored]) {
            try {
                localStorage.removeItem(STORAGE_ALLIANCE_ID);
            } catch (e) {
                /* ignore */
            }
        }

        if (!lastMyAlliances.length) {
            if (currentAllianceId && !byId[currentAllianceId]) {
                subscribeAlliance('');
            }
            return;
        }

        var want = '';
        if (stored && byId[stored]) {
            want = stored;
        } else if (lastMyAlliances.length === 1 && lastMyAlliances[0].allianceId != null) {
            want = String(lastMyAlliances[0].allianceId);
        }

        if (!want) {
            if (currentAllianceId && !byId[currentAllianceId]) {
                subscribeAlliance('');
            }
            return;
        }

        if (currentAllianceId !== want) {
            subscribeAlliance(want);
        }
    }

    function refreshMyAllianceList(storedAllianceHint) {
        const apiKey = getApiKey();
        const st = document.getElementById('alliance-dash-my-status');
        if (!apiKey || apiKey.length !== 16) {
            setStatus(st, 'Set API key to discover alliances.', true);
            lastMyAlliances = [];
            renderMyAlliances();
            reconcileAllianceAutoLoad(storedAllianceHint);
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
                reconcileAllianceAutoLoad(storedAllianceHint);
            })
            .catch(function (err) {
                lastMyAlliances = [];
                renderMyAlliances();
                setStatus(st, err.message || String(err), true);
                reconcileAllianceAutoLoad(storedAllianceHint);
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

    /** Fill vault modal faction select from `lastAllianceDoc`; pick `preferredFid` if on roster, else user faction, else first. */
    function populateVaultFactionSelect(preferredFid) {
        const sel = document.getElementById('alliance-dash-vault-faction');
        if (!sel) return;
        sel.innerHTML = '';
        const doc = lastAllianceDoc;
        const rawIds = doc ? factionIdsFromDoc(doc) : [];
        const fids = rawIds.map(function (x) {
            return String(x);
        });
        const preferred = String(preferredFid || '').trim();
        const defaultFid = String(cachedUserFactionId || '').trim();

        if (!fids.length) {
            const o = document.createElement('option');
            o.value = '';
            o.textContent = 'No factions in roster';
            o.disabled = true;
            sel.appendChild(o);
            sel.disabled = true;
            return;
        }
        sel.disabled = false;
        const sorted = fids.slice().sort(function (a, b) {
            const na = getFactionMeta(doc, a).name.toLowerCase();
            const nb = getFactionMeta(doc, b).name.toLowerCase();
            if (na !== nb) return na < nb ? -1 : 1;
            return a.localeCompare(b);
        });
        sorted.forEach(function (fid) {
            const o = document.createElement('option');
            o.value = fid;
            const meta = getFactionMeta(doc, fid);
            o.textContent = meta.name + ' (' + fid + ')';
            sel.appendChild(o);
        });
        let pick = '';
        if (preferred && fids.indexOf(preferred) >= 0) pick = preferred;
        else if (defaultFid && fids.indexOf(defaultFid) >= 0) pick = defaultFid;
        else pick = sorted[0];
        sel.value = pick;
    }

    function clearPurchaserMembersCache() {
        purchaserMembersByFactionId = Object.create(null);
    }

    /**
     * Normalise Torn faction members payload (v2 array or v1 id->object map) to [{ id, name }].
     */
    function normalizeFactionMembersList(data) {
        const d = data && typeof data === 'object' ? data : {};
        var m = d.members;
        if (m == null && d.faction && typeof d.faction === 'object') m = d.faction.members;
        if (m == null) return [];
        if (Array.isArray(m)) {
            const out = [];
            m.forEach(function (row) {
                if (!row || typeof row !== 'object') return;
                const id =
                    row.id != null
                        ? String(row.id)
                        : row.player_id != null
                          ? String(row.player_id)
                          : '';
                let name = row.name != null ? String(row.name) : '';
                name = name.replace(/<[^>]+>/g, '').trim();
                if (!id || !name) return;
                out.push({ id: id, name: name });
            });
            out.sort(function (a, b) {
                return a.name.localeCompare(b.name);
            });
            return out;
        }
        if (typeof m === 'object') {
            const out = [];
            Object.keys(m).forEach(function (pid) {
                const o = m[pid];
                if (!o || typeof o !== 'object') return;
                const name = o.name != null ? String(o.name).replace(/<[^>]+>/g, '').trim() : '';
                if (!name) return;
                out.push({ id: String(pid), name: name });
            });
            out.sort(function (a, b) {
                return a.name.localeCompare(b.name);
            });
            return out;
        }
        return [];
    }

    /** One v2 members call per roster faction not yet cached; staggered. Separate from intel pulls. */
    async function loadPurchaserFactionMembersIfNeeded() {
        const apiKey = getApiKey();
        if (!apiKey || apiKey.length !== 16 || !lastAllianceDoc) return;
        const fids = factionIdsFromDoc(lastAllianceDoc);
        for (let i = 0; i < fids.length; i++) {
            const fid = String(fids[i]);
            if (Object.prototype.hasOwnProperty.call(purchaserMembersByFactionId, fid)) continue;
            try {
                const data = await fetchJson(
                    'https://api.torn.com/v2/faction/' +
                        encodeURIComponent(fid) +
                        '/members?striptags=true&key=' +
                        encodeURIComponent(apiKey)
                );
                purchaserMembersByFactionId[fid] = normalizeFactionMembersList(data);
            } catch (e) {
                purchaserMembersByFactionId[fid] = [];
            }
            await new Promise(function (r) {
                setTimeout(r, 130);
            });
        }
    }

    function buildPurchaserStaticSuggestions() {
        const out = [];
        const doc = lastAllianceDoc;
        if (!doc) return out;
        const an = String(doc.name || '').trim();
        if (an) {
            out.push({ tier: 0, value: an, label: an, sub: 'Alliance' });
        }
        if (!an || an.toLowerCase() !== 'alliance') {
            out.push({ tier: 0, value: 'Alliance', label: 'Alliance', sub: 'Alliance (generic)' });
        }
        const fids = factionIdsFromDoc(doc);
        fids.forEach(function (fid) {
            const sFid = String(fid);
            const meta = getFactionMeta(doc, sFid);
            const nm = String(meta.name || 'Faction ' + sFid).trim();
            out.push({ tier: 1, value: nm, label: nm + ' (' + sFid + ')', sub: 'Faction' });
        });
        return out;
    }

    function gatherPurchaserSuggestionsFiltered(query) {
        const ql = String(query || '')
            .trim()
            .toLowerCase();
        const staticRows = buildPurchaserStaticSuggestions();
        var staticPick = staticRows;
        if (ql) {
            staticPick = staticRows.filter(function (r) {
                return (
                    r.label.toLowerCase().indexOf(ql) >= 0 ||
                    r.value.toLowerCase().indexOf(ql) >= 0 ||
                    (r.sub && r.sub.toLowerCase().indexOf(ql) >= 0)
                );
            });
        }
        const out = staticPick.slice(0, ql ? 10 : 14);
        const used = Object.create(null);
        out.forEach(function (r) {
            used['s:' + r.value] = true;
        });
        const doc = lastAllianceDoc;
        const fids = doc ? factionIdsFromDoc(doc) : [];
        const fidsSorted = fids.slice().sort(function (a, b) {
            const na = (getFactionMeta(doc, String(a)).name || '').toLowerCase();
            const nb = (getFactionMeta(doc, String(b)).name || '').toLowerCase();
            if (na !== nb) return na < nb ? -1 : na > nb ? 1 : 0;
            return String(a).localeCompare(String(b));
        });
        if (ql.length >= 1 && doc) {
            var nPlayers = 0;
            const maxPlayers = 28;
            for (var fi = 0; fi < fidsSorted.length && nPlayers < maxPlayers; fi++) {
                var fid = String(fidsSorted[fi]);
                var facName = (getFactionMeta(doc, fid).name || 'Faction').trim();
                var arr = purchaserMembersByFactionId[fid];
                if (!arr || !arr.length) continue;
                for (var j = 0; j < arr.length && nPlayers < maxPlayers; j++) {
                    var p = arr[j];
                    var blob = (p.name + ' ' + p.id + ' ' + facName).toLowerCase();
                    if (blob.indexOf(ql) < 0) continue;
                    var key = 'p:' + fid + ':' + p.id;
                    if (used[key]) continue;
                    used[key] = true;
                    out.push({
                        tier: 2,
                        value: p.name,
                        label: p.name,
                        facName: facName,
                        sub: ''
                    });
                    nPlayers++;
                }
            }
        }
        return out.slice(0, 32);
    }

    function getVaultOwnerComboboxEl() {
        const input = document.getElementById('alliance-dash-vault-owner');
        return input ? input.closest('.alliance-dash-vault-combobox') : null;
    }

    /**
     * While open, keep the suggest list under document.body so position:fixed uses the viewport.
     * (The vault dialog uses transform:centering, which makes fixed descendants use wrong coords
     * and the dialog overflow:hidden clips the list.)
     */
    function attachVaultOwnerSuggestToBody() {
        const list = document.getElementById('alliance-dash-vault-owner-suggest');
        if (list && list.parentElement !== document.body) {
            document.body.appendChild(list);
        }
    }

    function restoreVaultOwnerSuggestToCombobox() {
        const list = document.getElementById('alliance-dash-vault-owner-suggest');
        const box = getVaultOwnerComboboxEl();
        if (list && box && list.parentElement !== box) {
            box.appendChild(list);
        }
    }

    /** Fixed to viewport; list must be on document.body while visible (see attachVaultOwnerSuggestToBody). */
    function positionVaultOwnerSuggestList() {
        const input = document.getElementById('alliance-dash-vault-owner');
        const list = document.getElementById('alliance-dash-vault-owner-suggest');
        if (!input || !list || list.hidden) return;
        attachVaultOwnerSuggestToBody();
        const r = input.getBoundingClientRect();
        const pad = 8;
        const spaceBelow = window.innerHeight - r.bottom - pad;
        const spaceAbove = r.top - pad;
        const preferBelow = spaceBelow >= 96 || spaceBelow >= spaceAbove;
        var topPx;
        var maxH;
        if (preferBelow) {
            topPx = r.bottom + 2;
            maxH = Math.min(260, Math.max(72, spaceBelow));
        } else {
            maxH = Math.min(260, Math.max(72, spaceAbove));
            topPx = Math.max(pad, r.top - maxH - 2);
        }
        list.style.position = 'fixed';
        list.style.left = r.left + 'px';
        list.style.width = r.width + 'px';
        list.style.top = topPx + 'px';
        list.style.right = 'auto';
        list.style.bottom = 'auto';
        list.style.maxHeight = maxH + 'px';
        list.style.zIndex = '10060';
        list.style.boxSizing = 'border-box';
    }

    function hidePurchaserBySuggest() {
        const list = document.getElementById('alliance-dash-vault-owner-suggest');
        const input = document.getElementById('alliance-dash-vault-owner');
        if (list) {
            list.removeAttribute('style');
            list.innerHTML = '';
            list.hidden = true;
            restoreVaultOwnerSuggestToCombobox();
        }
        if (input) input.removeAttribute('aria-activedescendant');
    }

    function bindPurchaserByCombobox() {
        const input = document.getElementById('alliance-dash-vault-owner');
        const list = document.getElementById('alliance-dash-vault-owner-suggest');
        if (!input || !list || input._purchaserSuggestBound) return;
        input._purchaserSuggestBound = true;
        var blurTimer = null;
        var activeIdx = -1;
        var inputDebounce = null;

        function renderList(rows) {
            list.innerHTML = '';
            if (!rows.length) {
                list.removeAttribute('style');
                list.hidden = true;
                restoreVaultOwnerSuggestToCombobox();
                return;
            }
            rows.forEach(function (row, idx) {
                const li = document.createElement('li');
                li.setAttribute('role', 'presentation');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'alliance-dash-vault-suggest__item';
                btn.setAttribute('role', 'option');
                btn.id = 'alliance-dash-vault-owner-suggest-' + idx;
                var inner;
                if (row.tier === 2 && row.facName) {
                    inner =
                        '<span class="alliance-dash-vault-suggest__main alliance-dash-vault-suggest__main--player-row">' +
                        '<span class="alliance-dash-vault-suggest__player">' +
                        escapeHtml(row.label) +
                        '</span>' +
                        '<span class="alliance-dash-vault-suggest__fac-tag">' +
                        escapeHtml(row.facName) +
                        '</span>' +
                        '</span>';
                } else {
                    inner = '<span class="alliance-dash-vault-suggest__main">' + escapeHtml(row.label) + '</span>';
                }
                if (row.sub) {
                    inner += '<span class="alliance-dash-vault-suggest__sub">' + escapeHtml(row.sub) + '</span>';
                }
                btn.innerHTML = inner;
                btn.addEventListener('mousedown', function (ev) {
                    ev.preventDefault();
                    input.value = row.value;
                    hidePurchaserBySuggest();
                    activeIdx = -1;
                });
                li.appendChild(btn);
                list.appendChild(li);
            });
            list.hidden = false;
            activeIdx = -1;
            positionVaultOwnerSuggestList();
        }

        function syncActive() {
            const items = list.querySelectorAll('.alliance-dash-vault-suggest__item');
            items.forEach(function (el, i) {
                el.classList.toggle('alliance-dash-vault-suggest__item--active', i === activeIdx);
                el.setAttribute('aria-selected', i === activeIdx ? 'true' : 'false');
            });
            if (activeIdx >= 0 && items[activeIdx]) {
                input.setAttribute('aria-activedescendant', items[activeIdx].id);
            } else {
                input.removeAttribute('aria-activedescendant');
            }
        }

        function openListFromInput() {
            const rows = gatherPurchaserSuggestionsFiltered(input.value);
            renderList(rows);
        }

        function refreshSuggestAfterLoad() {
            loadPurchaserFactionMembersIfNeeded()
                .then(function () {
                    openListFromInput();
                })
                .catch(function () {
                    openListFromInput();
                });
        }

        input.addEventListener('focus', function () {
            if (blurTimer) {
                clearTimeout(blurTimer);
                blurTimer = null;
            }
            openListFromInput();
            refreshSuggestAfterLoad();
        });

        input.addEventListener('input', function () {
            if (inputDebounce) clearTimeout(inputDebounce);
            inputDebounce = setTimeout(function () {
                refreshSuggestAfterLoad();
            }, 60);
        });

        input.addEventListener('blur', function () {
            blurTimer = setTimeout(function () {
                hidePurchaserBySuggest();
                activeIdx = -1;
            }, 180);
        });

        input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                if (!list.hidden) {
                    e.preventDefault();
                    hidePurchaserBySuggest();
                    activeIdx = -1;
                }
                return;
            }
            var items = list.querySelectorAll('.alliance-dash-vault-suggest__item');
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (list.hidden || !items.length) {
                    openListFromInput();
                    refreshSuggestAfterLoad();
                    items = list.querySelectorAll('.alliance-dash-vault-suggest__item');
                }
                if (!items.length) return;
                e.preventDefault();
                if (e.key === 'ArrowDown') {
                    activeIdx = activeIdx < 0 ? 0 : Math.min(items.length - 1, activeIdx + 1);
                } else {
                    activeIdx = activeIdx <= 0 ? items.length - 1 : activeIdx - 1;
                }
                syncActive();
                if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
                positionVaultOwnerSuggestList();
                return;
            }
            if (e.key === 'Enter') {
                items = list.querySelectorAll('.alliance-dash-vault-suggest__item');
                if (!list.hidden && activeIdx >= 0 && items[activeIdx]) {
                    e.preventDefault();
                    items[activeIdx].click();
                }
            }
        });

        function repositionVaultSuggestIfOpen() {
            if (!list.hidden && list.querySelector('.alliance-dash-vault-suggest__item')) {
                positionVaultOwnerSuggestList();
            }
        }

        const vaultModalScroll = document.querySelector('#alliance-dash-vault-modal .alliance-dash-vault-modal-scroll');
        if (vaultModalScroll) {
            vaultModalScroll.addEventListener('scroll', repositionVaultSuggestIfOpen, { passive: true });
        }
        window.addEventListener('resize', repositionVaultSuggestIfOpen);
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
            if (stEl && skipLoading) stEl.textContent = '';
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

    function vaultTableCell(val) {
        const s = val != null && String(val).trim() !== '' ? String(val).trim() : '';
        return s ? escapeHtml(s) : '<span class="alliance-dash-muted">—</span>';
    }

    /**
     * One vault table segment: type with value in brackets, e.g. Wither (21%). Empty slots omitted.
     */
    function vaultBonusTableSegment(bType, bVal) {
        const t = bType != null ? String(bType).trim() : '';
        const v = bVal != null ? String(bVal).trim() : '';
        if (!t && !v) return '';
        const tH = t ? escapeHtml(t) : '';
        const vH = v ? escapeHtml(v) : '';
        if (t && v) return tH + ' <span class="alliance-dash-vault-bonus-table-paren">(' + vH + ')</span>';
        if (t) return tH;
        return '<span class="alliance-dash-vault-bonus-table-paren">(' + vH + ')</span>';
    }

    /** Rarity tier for filters: legacy / empty counts as yellow (same as vault defaults). */
    function vaultDocWeaponRarityTier(d) {
        const wr = String(d && d.weaponRarity != null ? d.weaponRarity : '')
            .trim()
            .toLowerCase();
        if (wr === 'orange' || wr === 'red' || wr === 'yellow') return wr;
        return 'yellow';
    }

    function populateVaultTableFactionFilter() {
        const sel = document.getElementById('alliance-dash-vault-filter-faction');
        if (!sel) return;
        const cur = sel.value;
        var html = '<option value="">All factions</option>';
        if (lastAllianceDoc) {
            const ids = factionIdsFromDoc(lastAllianceDoc);
            for (var i = 0; i < ids.length; i++) {
                const fid = String(ids[i]);
                const meta = getFactionMeta(lastAllianceDoc, fid);
                const nm = meta && meta.name ? String(meta.name) : fid;
                html += '<option value="' + escapeHtml(fid) + '">' + escapeHtml(nm) + '</option>';
            }
        }
        sel.innerHTML = html;
        if (cur) {
            for (var j = 0; j < sel.options.length; j++) {
                if (sel.options[j].value === cur) {
                    sel.value = cur;
                    break;
                }
            }
        }
    }

    function vaultRowSearchBlob(row) {
        const d = row.data || {};
        const bn = vaultRowBonusesFromDoc(d);
        const facId = d.holderFactionId || '';
        const meta =
            lastAllianceDoc && facId ? getFactionMeta(lastAllianceDoc, String(facId)) : { name: String(facId || '') };
        const parts = [
            d.label,
            d.owner,
            d.location,
            d.accuracy,
            d.damage,
            d.quality,
            bn.b1t,
            bn.b1v,
            bn.b2t,
            bn.b2v,
            meta.name,
            facId,
            vaultWeaponSlotLabelForDoc(d),
            vaultNormalizeWeaponSlotStored(d.weaponSlot),
        ];
        return parts
            .map(function (x) {
                return x != null ? String(x).toLowerCase() : '';
            })
            .join(' ');
    }

    function getVaultTableFilterSearchNorm() {
        const el = document.getElementById('alliance-dash-vault-filter-search');
        return el && el.value ? String(el.value).trim().toLowerCase() : '';
    }

    function getVaultTableFilterFactionId() {
        const el = document.getElementById('alliance-dash-vault-filter-faction');
        return el && el.value ? String(el.value).trim() : '';
    }

    function getVaultTableFilterRarity() {
        const el = document.getElementById('alliance-dash-vault-filter-rarity');
        const v = el && el.value ? String(el.value).trim().toLowerCase() : '';
        return v === 'yellow' || v === 'orange' || v === 'red' ? v : '';
    }

    /** Parse vault stat text (e.g. accuracy / damage); null if empty or not a finite number. */
    function parseVaultDocStatNumber(val) {
        if (val == null) return null;
        const s = String(val).trim().replace(/,/g, '');
        if (!s) return null;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
    }

    /** Min threshold from filter input; null means no filter (empty or invalid). */
    function getVaultTableFilterMinStat(elId) {
        const el = document.getElementById(elId);
        if (!el || String(el.value || '').trim() === '') return null;
        const n = parseFloat(String(el.value).trim().replace(/,/g, ''));
        return Number.isFinite(n) ? n : null;
    }

    function vaultNumericSortValueForCompare(val) {
        const n = parseVaultDocStatNumber(val);
        if (n == null || !Number.isFinite(n)) return null;
        return n;
    }

    function vaultCompareNumeric(va, vb, desc) {
        const na = vaultNumericSortValueForCompare(va);
        const nb = vaultNumericSortValueForCompare(vb);
        if (na == null && nb == null) return 0;
        if (na == null) return 1;
        if (nb == null) return -1;
        const diff = na - nb;
        if (diff !== 0) return desc ? -diff : diff;
        return 0;
    }

    function vaultCompareStrings(a, b, desc) {
        const c = a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
        if (c !== 0) return desc ? -c : c;
        return 0;
    }

    function vaultRowSortLabelLower(d) {
        return String((d && d.label) || '').trim().toLowerCase();
    }

    function vaultRowSortOwnerLower(d) {
        return String((d && d.owner) || '').trim().toLowerCase();
    }

    function vaultRowSortBonusesLower(d) {
        const bn = vaultRowBonusesFromDoc(d);
        return [bn.b1t, bn.b1v, bn.b2t, bn.b2v]
            .map(function (x) {
                return String(x || '').trim().toLowerCase();
            })
            .join('\u0001');
    }

    function vaultRowSortSlotLower(d) {
        const st = vaultNormalizeWeaponSlotStored(d && d.weaponSlot);
        if (st) return st;
        return vaultWeaponSlotLabelForDoc(d).trim().toLowerCase();
    }

    function vaultRowSortFactionLower(row) {
        const d = row.data || {};
        const facId = String(d.holderFactionId || '').trim();
        const meta = lastAllianceDoc && facId ? getFactionMeta(lastAllianceDoc, facId) : null;
        const facName = meta && meta.name ? String(meta.name) : facId;
        return (facName + '\u0000' + String(d.location || '').trim()).toLowerCase();
    }

    function vaultCompareRows(rowA, rowB) {
        const key = vaultTableSortKey;
        const desc = vaultTableSortDir === 'desc';
        const da = rowA.data || {};
        const db = rowB.data || {};
        var cmp = 0;
        if (key === 'label') {
            cmp = vaultCompareStrings(vaultRowSortLabelLower(da), vaultRowSortLabelLower(db), desc);
        } else if (key === 'slot') {
            cmp = vaultCompareStrings(vaultRowSortSlotLower(da), vaultRowSortSlotLower(db), desc);
        } else if (key === 'bonuses') {
            cmp = vaultCompareStrings(vaultRowSortBonusesLower(da), vaultRowSortBonusesLower(db), desc);
        } else if (key === 'accuracy') {
            cmp = vaultCompareNumeric(da.accuracy, db.accuracy, desc);
        } else if (key === 'damage') {
            cmp = vaultCompareNumeric(da.damage, db.damage, desc);
        } else if (key === 'quality') {
            cmp = vaultCompareNumeric(da.quality, db.quality, desc);
        } else if (key === 'faction') {
            cmp = vaultCompareStrings(vaultRowSortFactionLower(rowA), vaultRowSortFactionLower(rowB), desc);
        } else if (key === 'owner') {
            cmp = vaultCompareStrings(vaultRowSortOwnerLower(da), vaultRowSortOwnerLower(db), desc);
        }
        if (cmp !== 0) return cmp;
        return String(rowA.id || '').localeCompare(String(rowB.id || ''));
    }

    function sortVaultTableRows(rows) {
        if (!vaultTableSortKey) return rows;
        const out = rows.slice();
        out.sort(vaultCompareRows);
        return out;
    }

    function syncVaultTableSortHeaderUi() {
        const table = document.getElementById('alliance-dash-vault-table');
        if (!table) return;
        const head = table.querySelector('thead');
        if (!head) return;
        const btns = head.querySelectorAll('[data-vault-sort]');
        for (var i = 0; i < btns.length; i++) {
            const btn = btns[i];
            const key = btn.getAttribute('data-vault-sort');
            const th = btn.closest('th');
            const ind = btn.querySelector('.alliance-dash-vault-sort-ind');
            if (key === vaultTableSortKey && vaultTableSortKey) {
                btn.classList.add('alliance-dash-vault-th-sort--active');
                if (th) th.setAttribute('aria-sort', vaultTableSortDir === 'asc' ? 'ascending' : 'descending');
                if (ind) ind.textContent = vaultTableSortDir === 'asc' ? '\u00a0\u25B2' : '\u00a0\u25BC';
            } else {
                btn.classList.remove('alliance-dash-vault-th-sort--active');
                if (th) th.removeAttribute('aria-sort');
                if (ind) ind.textContent = '';
            }
        }
    }

    function onVaultTableSortHeaderClick(e) {
        const btn = e.target && e.target.closest && e.target.closest('[data-vault-sort]');
        if (!btn) return;
        e.preventDefault();
        const key = btn.getAttribute('data-vault-sort');
        if (!key) return;
        if (vaultTableSortKey === key) {
            vaultTableSortDir = vaultTableSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            vaultTableSortKey = key;
            vaultTableSortDir = 'asc';
        }
        renderVaultTable();
    }

    function bindVaultTableHeaderSort() {
        const table = document.getElementById('alliance-dash-vault-table');
        if (!table || table._vaultHeaderSortBound) return;
        table._vaultHeaderSortBound = true;
        const thead = table.querySelector('thead');
        if (thead) thead.addEventListener('click', onVaultTableSortHeaderClick);
    }

    function filterVaultRowsForTable(rows) {
        const q = getVaultTableFilterSearchNorm();
        const fid = getVaultTableFilterFactionId();
        const rwF = getVaultTableFilterRarity();
        const minAcc = getVaultTableFilterMinStat('alliance-dash-vault-filter-min-accuracy');
        const minDmg = getVaultTableFilterMinStat('alliance-dash-vault-filter-min-damage');
        return rows.filter(function (row) {
            const d = row.data || {};
            if (fid && String(d.holderFactionId || '').trim() !== fid) return false;
            if (rwF && vaultDocWeaponRarityTier(d) !== rwF) return false;
            if (q && vaultRowSearchBlob(row).indexOf(q) < 0) return false;
            if (minAcc != null) {
                const acc = parseVaultDocStatNumber(d.accuracy);
                if (acc == null || acc < minAcc) return false;
            }
            if (minDmg != null) {
                const dmg = parseVaultDocStatNumber(d.damage);
                if (dmg == null || dmg < minDmg) return false;
            }
            return true;
        });
    }

    function updateVaultTableFilterCount(shown, total) {
        const p = document.getElementById('alliance-dash-vault-filter-count');
        if (!p) return;
        if (!total) {
            p.textContent = '';
            return;
        }
        if (shown === total) {
            p.textContent = String(total) + ' ' + (total === 1 ? 'entry' : 'entries');
        } else {
            p.textContent = 'Showing ' + shown + ' of ' + total + ' entries';
        }
    }

    function renderVaultTable() {
        const tbody = document.getElementById('alliance-dash-vault-tbody');
        if (!tbody) {
            syncVaultTableSortHeaderUi();
            return;
        }
        populateVaultTableFactionFilter();
        const allRows = lastVaultRows;
        if (!allRows.length) {
            const msg = currentAllianceId
                ? 'No vault entries yet — use Add new item.'
                : 'Load an alliance to see the vault.';
            tbody.innerHTML =
                '<tr><td colspan="9" class="alliance-dash-empty">' + escapeHtml(msg) + '</td></tr>';
            updateVaultTableFilterCount(0, 0);
            syncVaultTableSortHeaderUi();
            return;
        }
        const filtered = filterVaultRowsForTable(allRows);
        updateVaultTableFilterCount(filtered.length, allRows.length);
        if (!filtered.length) {
            tbody.innerHTML = '<tr><td colspan="9" class="alliance-dash-empty">No entries match your filters.</td></tr>';
            syncVaultTableSortHeaderUi();
            return;
        }
        const rows = sortVaultTableRows(filtered);
        const apiKey = getApiKey();
        tbody.innerHTML = rows
            .map(function (row) {
                const id = row.id;
                const d = row.data || {};
                const facId = d.holderFactionId || '';
                const meta = lastAllianceDoc && facId ? getFactionMeta(lastAllianceDoc, String(facId)) : { name: facId || '—' };
                const bn = vaultRowBonusesFromDoc(d);
                const seg1 = vaultBonusTableSegment(bn.b1t, bn.b1v);
                const seg2 = vaultBonusTableSegment(bn.b2t, bn.b2v);
                var bonusCombinedHtml;
                if (seg1 && seg2) {
                    bonusCombinedHtml =
                        seg1 +
                        ' <span class="alliance-dash-vault-bonus-table-sep" aria-hidden="true">|</span> ' +
                        seg2;
                } else if (seg1) {
                    bonusCombinedHtml = seg1;
                } else if (seg2) {
                    bonusCombinedHtml = seg2;
                } else {
                    bonusCombinedHtml = '<span class="alliance-dash-muted">—</span>';
                }
                const loc = (d.location || '').trim();
                const facLine = escapeHtml(meta.name);
                const locPart = loc ? escapeHtml(loc) : '';
                const facSmall = '<span class="alliance-dash-tiny">' + facLine + '</span>';
                let locFacHtml;
                if (locPart && facId) locFacHtml = locPart + '<br>' + facSmall;
                else if (locPart) locFacHtml = locPart;
                else if (facId) locFacHtml = facSmall;
                else locFacHtml = '<span class="alliance-dash-muted">—</span>';
                const tornId = String(d.tornItemId || '').trim();
                var rwClass = String(d.weaponRarity || '')
                    .trim()
                    .toLowerCase();
                if (rwClass !== 'yellow' && rwClass !== 'orange' && rwClass !== 'red') rwClass = 'none';
                var itRow = tornId && vaultTornItemsMap ? vaultTornItemsMap[tornId] : null;
                var slotLabel = vaultWeaponSlotLabelForDoc(d);
                var slotCell = slotLabel
                    ? escapeHtml(slotLabel)
                    : '<span class="alliance-dash-muted">—</span>';
                var imgU = itRow && itRow.image ? String(itRow.image).trim() : '';
                var thumbHtml = '';
                if (imgU) {
                    thumbHtml =
                        '<span class="alliance-dash-vault-item-thumb alliance-dash-vault-item-thumb--' +
                        escapeHtml(rwClass) +
                        '"><img src="' +
                        escapeHtml(imgU) +
                        '" alt="" loading="lazy"></span>';
                } else if (rwClass !== 'none') {
                    thumbHtml =
                        '<span class="alliance-dash-vault-item-thumb alliance-dash-vault-item-thumb--' +
                        escapeHtml(rwClass) +
                        '" title="' +
                        escapeHtml(rwClass) +
                        '"></span>';
                }
                return (
                    '<tr data-vault-id="' +
                    escapeHtml(id) +
                    '">' +
                    '<td class="alliance-dash-vault-item-cell">' +
                    thumbHtml +
                    '<span class="alliance-dash-vault-item-name">' +
                    escapeHtml(d.label || '') +
                    '</span></td>' +
                    '<td class="alliance-dash-vault-slot-cell">' +
                    slotCell +
                    '</td>' +
                    '<td class="alliance-dash-vault-bonuses-cell">' +
                    bonusCombinedHtml +
                    '</td>' +
                    '<td>' +
                    vaultTableCell(d.accuracy) +
                    '</td>' +
                    '<td>' +
                    vaultTableCell(d.damage) +
                    '</td>' +
                    '<td>' +
                    vaultTableCell(d.quality) +
                    '</td>' +
                    '<td>' +
                    locFacHtml +
                    '</td>' +
                    '<td>' +
                    vaultTableCell(d.owner) +
                    '</td>' +
                    '<td class="alliance-dash-actions alliance-dash-vault-actions">' +
                    '<button type="button" class="alliance-dash-vault-icon-btn alliance-dash-vault-icon-btn--edit alliance-dash-edit-vault" data-id="' +
                    escapeHtml(id) +
                    '" aria-label="Edit item" title="Edit">' +
                    '<svg class="alliance-dash-vault-icon-btn__svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>' +
                    '</button>' +
                    '<button type="button" class="alliance-dash-vault-icon-btn alliance-dash-vault-icon-btn--delete alliance-dash-del-vault" data-id="' +
                    escapeHtml(id) +
                    '"' +
                    (apiKey ? '' : ' disabled title="API key required"') +
                    ' aria-label="Delete item" title="Delete">' +
                    '<svg class="alliance-dash-vault-icon-btn__svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>' +
                    '</button>' +
                    '</td>' +
                    '</tr>'
                );
            })
            .join('');
        syncVaultTableSortHeaderUi();
    }

    function bindVaultTableFilters() {
        const wrap = document.getElementById('alliance-dash-vault-filters');
        if (!wrap || wrap._vaultFiltersBound) return;
        wrap._vaultFiltersBound = true;
        var debounceId = null;
        function scheduleRenderVaultTable() {
            if (debounceId) clearTimeout(debounceId);
            debounceId = setTimeout(function () {
                debounceId = null;
                renderVaultTable();
            }, 200);
        }
        const search = document.getElementById('alliance-dash-vault-filter-search');
        if (search) {
            search.addEventListener('input', scheduleRenderVaultTable);
            search.addEventListener('search', function () {
                if (debounceId) {
                    clearTimeout(debounceId);
                    debounceId = null;
                }
                renderVaultTable();
            });
        }
        const facSel = document.getElementById('alliance-dash-vault-filter-faction');
        if (facSel) facSel.addEventListener('change', renderVaultTable);
        const rarSel = document.getElementById('alliance-dash-vault-filter-rarity');
        if (rarSel) rarSel.addEventListener('change', renderVaultTable);
        const minAccEl = document.getElementById('alliance-dash-vault-filter-min-accuracy');
        if (minAccEl) minAccEl.addEventListener('input', scheduleRenderVaultTable);
        const minDmgEl = document.getElementById('alliance-dash-vault-filter-min-damage');
        if (minDmgEl) minDmgEl.addEventListener('input', scheduleRenderVaultTable);
        const clr = document.getElementById('alliance-dash-vault-filter-clear');
        if (clr) {
            clr.addEventListener('click', function () {
                if (search) search.value = '';
                if (facSel) facSel.value = '';
                if (rarSel) rarSel.value = '';
                if (minAccEl) minAccEl.value = '';
                if (minDmgEl) minDmgEl.value = '';
                renderVaultTable();
            });
        }
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
                openVaultModalEdit(row);
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
        const vault = document.getElementById('alliance-dash-vault-modal');
        const cOpen = create && create.getAttribute('aria-hidden') === 'false';
        const sOpen = settings && settings.getAttribute('aria-hidden') === 'false';
        const vOpen = vault && vault.getAttribute('aria-hidden') === 'false';
        if (cOpen || sOpen || vOpen) document.body.classList.add('alliance-dash-modal-open');
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

    function closeVaultModal() {
        hidePurchaserBySuggest();
        const m = document.getElementById('alliance-dash-vault-modal');
        if (m) m.setAttribute('aria-hidden', 'true');
        refreshBodyModalOpenClass();
    }

    function openVaultModal() {
        const m = document.getElementById('alliance-dash-vault-modal');
        if (!m) return;
        m.setAttribute('aria-hidden', 'false');
        refreshBodyModalOpenClass();
        loadPurchaserFactionMembersIfNeeded().catch(function () {
            /* ignore */
        });
        ensureVaultTornItemsMapLoaded().catch(function () {
            /* ignore */
        });
        const label = document.getElementById('alliance-dash-vault-label');
        setTimeout(function () {
            try {
                if (label) label.focus();
            } catch (e) {
                /* ignore */
            }
        }, 30);
    }

    function resetVaultModalForm() {
        const form = document.getElementById('alliance-dash-vault-form');
        if (form && form.reset) form.reset();
        const hid = document.getElementById('alliance-dash-vault-edit-id');
        if (hid) hid.value = '';
        const paste = document.getElementById('alliance-dash-vault-paste');
        if (paste) paste.value = '';
        const st = document.getElementById('alliance-dash-vault-extract-status');
        setStatus(st, '', false);
        const sub = document.getElementById('alliance-dash-vault-submit');
        if (sub) sub.textContent = 'Save to vault';
        const title = document.getElementById('alliance-dash-vault-modal-title');
        if (title) title.textContent = 'Vault item';
        hidePurchaserBySuggest();
        const tid = document.getElementById('alliance-dash-vault-torn-item-id');
        if (tid) tid.value = '';
        const rwEl = document.getElementById('alliance-dash-vault-weapon-rarity');
        if (rwEl) rwEl.value = 'yellow';
        updateVaultModalItemPreview();
        setVaultTornMatchStatus('', false);
    }

    function openVaultModalNew() {
        resetVaultModalForm();
        populateVaultFactionSelect('');
        const title = document.getElementById('alliance-dash-vault-modal-title');
        if (title) title.textContent = 'Add vault item';
        const lead = document.getElementById('alliance-dash-vault-modal-lead');
        if (lead) lead.textContent = 'Fill in manually or paste from Torn and extract.';
        openVaultModal();
    }

    function openVaultModalEdit(row) {
        if (!row || !row.data) return;
        resetVaultModalForm();
        const d = row.data;
        const hid = document.getElementById('alliance-dash-vault-edit-id');
        if (hid) hid.value = row.id;
        const setv = function (id, v) {
            const el = document.getElementById(id);
            if (el) el.value = v != null ? String(v) : '';
        };
        setv('alliance-dash-vault-label', d.label || '');
        const bn = vaultRowBonusesFromDoc(d);
        setv('alliance-dash-vault-bonus1-type', bn.b1t);
        setv('alliance-dash-vault-bonus1-value', bn.b1v);
        setv('alliance-dash-vault-bonus2-type', bn.b2t);
        setv('alliance-dash-vault-bonus2-value', bn.b2v);
        setv('alliance-dash-vault-accuracy', d.accuracy || '');
        setv('alliance-dash-vault-damage', d.damage || '');
        setv('alliance-dash-vault-quality', d.quality || '');
        setv('alliance-dash-vault-owner', d.owner || '');
        setv('alliance-dash-vault-torn-item-id', d.tornItemId || '');
        var rw0 = String(d.weaponRarity || '')
            .trim()
            .toLowerCase();
        var rwEl0 = document.getElementById('alliance-dash-vault-weapon-rarity');
        if (rwEl0) rwEl0.value = ['yellow', 'orange', 'red'].indexOf(rw0) >= 0 ? rw0 : 'yellow';
        var slotEl0 = document.getElementById('alliance-dash-vault-weapon-slot');
        if (slotEl0) {
            var sk0 = vaultNormalizeWeaponSlotStored(d.weaponSlot);
            slotEl0.value = sk0 || '';
        }
        populateVaultFactionSelect(d.holderFactionId || '');
        setVaultTornMatchStatus('', false);
        ensureVaultTornItemsMapLoaded()
            .then(function () {
                updateVaultModalItemPreview();
                if (slotEl0 && !vaultNormalizeWeaponSlotStored(slotEl0.value) && d.tornItemId) {
                    var it0 = vaultTornItemsMap && vaultTornItemsMap[String(d.tornItemId).trim()];
                    syncVaultModalWeaponSlotFromTornItem(it0);
                }
            })
            .catch(function () {
                updateVaultModalItemPreview();
            });
        const sub = document.getElementById('alliance-dash-vault-submit');
        if (sub) sub.textContent = 'Update entry';
        const title = document.getElementById('alliance-dash-vault-modal-title');
        if (title) title.textContent = 'Edit vault item';
        openVaultModal();
    }

    function applyVaultExtractToForm() {
        const ta = document.getElementById('alliance-dash-vault-paste');
        const st = document.getElementById('alliance-dash-vault-extract-status');
        const raw = ta && ta.value ? ta.value : '';
        const ext = extractVaultFromTornPaste(raw);
        const pairs = [
            ['label', 'alliance-dash-vault-label'],
            ['bonus1Type', 'alliance-dash-vault-bonus1-type'],
            ['bonus1Value', 'alliance-dash-vault-bonus1-value'],
            ['bonus2Type', 'alliance-dash-vault-bonus2-type'],
            ['bonus2Value', 'alliance-dash-vault-bonus2-value'],
            ['accuracy', 'alliance-dash-vault-accuracy'],
            ['damage', 'alliance-dash-vault-damage'],
            ['quality', 'alliance-dash-vault-quality'],
        ];
        let n = 0;
        for (let i = 0; i < pairs.length; i++) {
            const val = ext[pairs[i][0]];
            if (val) {
                const el = document.getElementById(pairs[i][1]);
                if (el) {
                    el.value = val;
                    n++;
                }
            }
        }
        const rwEl = document.getElementById('alliance-dash-vault-weapon-rarity');
        if (rwEl) {
            const picked =
                ext.weaponRarity && ['yellow', 'orange', 'red'].indexOf(String(ext.weaponRarity).toLowerCase()) >= 0
                    ? String(ext.weaponRarity).toLowerCase()
                    : 'yellow';
            rwEl.value = picked;
            if (ext.weaponRarity) n++;
        }
        const tidEl = document.getElementById('alliance-dash-vault-torn-item-id');
        if (tidEl) tidEl.value = '';
        updateVaultModalItemPreview();
        const apiKey = getApiKey();
        if (apiKey && apiKey.length === 16) {
            runVaultTornMatchForLabel().then(function (matched) {
                var bits = [];
                if (n) bits.push('Filled ' + n + ' field(s) from paste');
                if (matched) bits.push('item + slot from catalog');
                var ok = n > 0 || matched;
                setStatus(st, ok ? bits.join('; ') + '.' : 'No recognized stats in paste — check format.', !ok);
            });
        } else {
            setStatus(
                st,
                n
                    ? 'Filled ' + n + ' field(s) from paste. Set your API key to match item and slot from the catalog.'
                    : 'No recognized stats in paste — check format.',
                !n
            );
        }
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
                const vaultM = document.getElementById('alliance-dash-vault-modal');
                if (vaultM && vaultM.getAttribute('aria-hidden') === 'false') {
                    closeVaultModal();
                    resetVaultModalForm();
                    return;
                }
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
        const previousAllianceId = currentAllianceId;
        stopListeners();
        stopIntelAutoRefresh();
        currentAllianceId = String(allianceId || '').trim();
        if (previousAllianceId !== currentAllianceId) {
            clearPurchaserMembersCache();
        }
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
                    try {
                        localStorage.removeItem(STORAGE_ALLIANCE_ID);
                    } catch (e) {
                        /* ignore */
                    }
                    if (pendingOpenSettingsAllianceId === currentAllianceId) pendingOpenSettingsAllianceId = '';
                    updateIntelHeadingAllianceName('');
                    updateLoadedAllianceStatus('No alliance document for this ID.', true);
                    updateActiveAllianceCardHighlight();
                    stopIntelAutoRefresh();
                    refreshIntel();
                    renderVaultTable();
                    return;
                }
                lastAllianceDoc = snap.data();
                const name = lastAllianceDoc.name || 'Alliance';
                const n = factionIdsFromDoc(lastAllianceDoc).length;
                updateLoadedAllianceStatus(
                    'Active alliance: ' + name + ' · ' + n + ' faction' + (n === 1 ? '' : 's') + ' · ID ' + currentAllianceId,
                    false
                );
                loadPurchaserFactionMembersIfNeeded().catch(function () {
                    /* roster hints for Owned by; failures are silent */
                });
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
                renderVaultTable();
            },
            function (err) {
                lastAllianceDoc = null;
                if (pendingOpenSettingsAllianceId === currentAllianceId) pendingOpenSettingsAllianceId = '';
                updateIntelHeadingAllianceName('');
                updateLoadedAllianceStatus(err.message || String(err), true);
                updateActiveAllianceCardHighlight();
                stopIntelAutoRefresh();
                refreshIntel();
                renderVaultTable();
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
                    ensureVaultTornItemsMapLoaded()
                        .then(function () {
                            renderVaultTable();
                        })
                        .catch(function () {
                            /* ignore */
                        });
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

        const vaultBackdrop = document.getElementById('alliance-dash-vault-modal-backdrop');
        const vaultClose = document.getElementById('alliance-dash-vault-modal-close');
        if (vaultBackdrop)
            vaultBackdrop.addEventListener('click', function () {
                closeVaultModal();
                resetVaultModalForm();
            });
        if (vaultClose)
            vaultClose.addEventListener('click', function () {
                closeVaultModal();
                resetVaultModalForm();
            });

        document.getElementById('alliance-dash-vault-open-add') &&
            document.getElementById('alliance-dash-vault-open-add').addEventListener('click', function () {
                if (!currentAllianceId) {
                    alert('Load an alliance first.');
                    return;
                }
                openVaultModalNew();
            });

        document.getElementById('alliance-dash-vault-extract') &&
            document.getElementById('alliance-dash-vault-extract').addEventListener('click', function () {
                applyVaultExtractToForm();
            });

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
                const factionSel = document.getElementById('alliance-dash-vault-faction');
                const holder = factionSel && !factionSel.disabled ? String(factionSel.value || '').trim() : '';
                if (!holder) {
                    alert('Choose a faction from the list.');
                    return;
                }
                const bonus1Type = document.getElementById('alliance-dash-vault-bonus1-type')
                    ? document.getElementById('alliance-dash-vault-bonus1-type').value.trim()
                    : '';
                const bonus1Value = document.getElementById('alliance-dash-vault-bonus1-value')
                    ? document.getElementById('alliance-dash-vault-bonus1-value').value.trim()
                    : '';
                const bonus2Type = document.getElementById('alliance-dash-vault-bonus2-type')
                    ? document.getElementById('alliance-dash-vault-bonus2-type').value.trim()
                    : '';
                const bonus2Value = document.getElementById('alliance-dash-vault-bonus2-value')
                    ? document.getElementById('alliance-dash-vault-bonus2-value').value.trim()
                    : '';
                const accuracy = document.getElementById('alliance-dash-vault-accuracy')
                    ? document.getElementById('alliance-dash-vault-accuracy').value.trim()
                    : '';
                const damage = document.getElementById('alliance-dash-vault-damage')
                    ? document.getElementById('alliance-dash-vault-damage').value.trim()
                    : '';
                const quality = document.getElementById('alliance-dash-vault-quality')
                    ? document.getElementById('alliance-dash-vault-quality').value.trim()
                    : '';
                const owner = document.getElementById('alliance-dash-vault-owner')
                    ? document.getElementById('alliance-dash-vault-owner').value.trim()
                    : '';
                const tornItemId = document.getElementById('alliance-dash-vault-torn-item-id')
                    ? document.getElementById('alliance-dash-vault-torn-item-id').value.trim()
                    : '';
                var weaponRarity = document.getElementById('alliance-dash-vault-weapon-rarity')
                    ? document.getElementById('alliance-dash-vault-weapon-rarity').value.trim().toLowerCase()
                    : '';
                if (weaponRarity !== 'yellow' && weaponRarity !== 'orange' && weaponRarity !== 'red') weaponRarity = 'yellow';
                var weaponSlot = document.getElementById('alliance-dash-vault-weapon-slot')
                    ? String(document.getElementById('alliance-dash-vault-weapon-slot').value || '')
                          .trim()
                          .toLowerCase()
                    : '';
                if (!['melee', 'primary', 'secondary', 'temporary'].includes(weaponSlot)) weaponSlot = '';
                const payload = {
                    apiKey: apiKey,
                    allianceId: currentAllianceId,
                    label: label,
                    location: '',
                    holderFactionId: holder,
                    bonus1Type: bonus1Type,
                    bonus1Value: bonus1Value,
                    bonus2Type: bonus2Type,
                    bonus2Value: bonus2Value,
                    accuracy: accuracy,
                    damage: damage,
                    quality: quality,
                    owner: owner,
                    tornItemId: tornItemId,
                    weaponRarity: weaponRarity,
                    weaponSlot: weaponSlot,
                    itemId: editId || undefined,
                };
                callHttps('allianceVaultUpsert', payload)
                    .then(function () {
                        closeVaultModal();
                        resetVaultModalForm();
                    })
                    .catch(function (err) {
                        alert(err.message || String(err));
                    });
            });
        }

        const cancel = document.getElementById('alliance-dash-vault-cancel-edit');
        if (cancel) {
            cancel.addEventListener('click', function () {
                closeVaultModal();
                resetVaultModalForm();
            });
        }

        bindVaultTableFilters();
        bindVaultTableHeaderSort();
        bindVaultTableActions();
        bindPurchaserByCombobox();

        (function bindVaultLabelAutoMatch() {
            var t = null;
            const lab = document.getElementById('alliance-dash-vault-label');
            if (!lab) return;
            lab.addEventListener('input', function () {
                if (t) clearTimeout(t);
                t = setTimeout(function () {
                    t = null;
                    runVaultTornMatchForLabel();
                }, 450);
            });
        })();

        const vaultRaritySel = document.getElementById('alliance-dash-vault-weapon-rarity');
        if (vaultRaritySel) {
            vaultRaritySel.addEventListener('change', function () {
                updateVaultModalItemPreview();
            });
        }

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
        refreshMyAllianceList(initial);
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
