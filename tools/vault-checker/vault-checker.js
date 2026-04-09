/**
 * Vault Checker: faction vault weapons/armor and who has loaned items.
 * Flags when a player has 2+ weapons of the same type (Primary/Secondary/Melee) or 2+ armour in the same slot.
 */
(function () {
    'use strict';

    var vaultLastByPlayer = null;
    var vaultLastNameMap = null;
    var vaultLastWeaponsList = null;
    var vaultLastArmorList = null;

    function getApiKey() {
        return (localStorage.getItem('tornApiKey') || '').trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    }

    /** Torn often returns error as a string or as { code, error } — avoid new Error(object) → message "[object Object]". */
    function tornApiErrorToMessage(errField) {
        if (errField == null) return 'Unknown API error';
        if (typeof errField === 'string') return errField;
        if (typeof errField === 'object') {
            if (typeof errField.error === 'string') return errField.error;
            if (typeof errField.message === 'string') return errField.message;
            try {
                return JSON.stringify(errField);
            } catch (e) {
                return String(errField);
            }
        }
        return String(errField);
    }

    async function fetchJson(url) {
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) throw new Error(tornApiErrorToMessage(data.error));
        return data;
    }

    async function getUserProfile(apiKey) {
        const data = await fetchJson(`https://api.torn.com/user/?selections=profile&key=${apiKey}`);
        let playerId = null;
        try {
            const b = await fetchJson(`https://api.torn.com/user/?selections=basic&key=${apiKey}`);
            playerId = b.player_id != null ? String(b.player_id) : (b.id != null ? String(b.id) : null);
        } catch (e) { /* key may lack basic */ }
        return {
            factionId: data.faction_id || data.faction?.faction_id || null,
            factionName: data.faction_name || data.faction?.faction_name || '',
            playerId
        };
    }

    /** Same faction pull as Faction Battle Stats / War Dashboard: v2 faction members, return map of playerId -> name. */
    async function fetchFactionMembers(apiKey, factionId) {
        const base = 'https://api.torn.com/v2/faction';
        const url = factionId
            ? `${base}/${factionId}/members?striptags=true&key=${apiKey}`
            : `${base}/members?striptags=true&key=${apiKey}`;
        const data = await fetchJson(url);
        const members = data.members || [];
        const list = Array.isArray(members) ? members : Object.values(members);
        const nameMap = {};
        list.forEach((m) => {
            if (m && (m.id != null) && m.name) nameMap[String(m.id)] = m.name;
        });
        return nameMap;
    }

    /** Normalise API response to array of items. */
    function toItemList(raw) {
        if (!raw || typeof raw !== 'object') return [];
        return Array.isArray(raw) ? raw : Object.values(raw);
    }

    function normItemName(s) {
        return String(s || '').replace(/<[^>]+>/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    /**
     * Torn often returns loaned_to as a comma string, but also as a single number, array, or id->count map.
     * When several copies are loaned to the same player, API sometimes lists one ID once — expand to match loaned count.
     */
    function rawBorrowerIdsFromItem(item) {
        const loaned = Math.max(0, parseInt(item.loaned, 10) || 0);
        const lt = item.loaned_to != null ? item.loaned_to : item.loanedTo;
        let ids = [];

        if (lt == null || lt === '') {
            /* empty */
        } else if (typeof lt === 'number' && Number.isFinite(lt)) {
            ids = [String(Math.trunc(lt))];
        } else if (typeof lt === 'string') {
            const numeric = lt.split(/[,\s;|]+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
            ids = numeric.length ? numeric : lt.split(',').map(s => s.trim()).filter(Boolean);
        } else if (Array.isArray(lt)) {
            lt.forEach(x => {
                if (x != null && typeof x === 'object' && x.id != null) ids.push(String(x.id));
                else if (Number.isFinite(Number(x))) ids.push(String(Math.trunc(Number(x))));
            });
        } else if (typeof lt === 'object') {
            Object.keys(lt).forEach(k => {
                const pid = parseInt(k, 10);
                if (!Number.isFinite(pid)) return;
                const cnt = parseInt(lt[k], 10);
                const n = Number.isFinite(cnt) && cnt > 0 ? Math.min(cnt, loaned || 999) : 1;
                for (let i = 0; i < n; i++) ids.push(String(pid));
            });
        }

        if (ids.length === 1 && loaned > 1) {
            const one = ids[0];
            while (ids.length < loaned) ids.push(one);
        }

        while (ids.length > loaned && loaned > 0) ids.pop();
        return { ids, loaned };
    }

    /** Pull recent armory loans from v2 news — fills gaps when API omits loaned_to (e.g. "You loaned yourself"). */
    async function fetchArmoryLoanHints(apiKey, keyOwnerId) {
        const hints = [];
        const now = Math.floor(Date.now() / 1000);
        const fromTs = now - 21 * 24 * 3600;
        let toTs = now;
        for (let page = 0; page < 5; page++) {
            const newsUrl = `https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&cat=armoryAction&to=${toTs}&from=${fromTs}&key=${apiKey}`;
            const res = await fetch(newsUrl);
            const data = await res.json();
            if (data.error) break;
            const news = data.news || [];
            if (!news.length) break;

            news.forEach(entry => {
                const html = entry.news || entry.text || '';
                if (!html || /returned\s+.+\s+to\s+the\s+faction\s+armory/i.test(html.replace(/\s+/g, ' '))) return;

                const push = (borrowerId, qty, itemFragment) => {
                    if (!borrowerId || !qty) return;
                    const itemName = normItemName(itemFragment);
                    if (!itemName) return;
                    const ts = entry.timestamp || 0;
                    for (let q = 0; q < qty; q++) hints.push({ borrowerId: String(borrowerId), itemName, ts });
                };

                if (keyOwnerId && /You loaned yourself/i.test(html)) {
                    const m = html.match(/You loaned yourself (\d+)x\s*(.+?)\s+from the faction armory/i);
                    if (m) push(keyOwnerId, parseInt(m[1], 10) || 1, m[2]);
                }

                let re = /profiles\.php\?XID=(\d+)[^>]*>[\s\S]*?<\/a>\s*loaned themselves (\d+)x\s*([\s\S]+?)\s+from the faction armory/gi;
                let mm;
                while ((mm = re.exec(html)) !== null) {
                    push(mm[1], parseInt(mm[2], 10) || 1, mm[3]);
                }

                re = /profiles\.php\?XID=(\d+)[^>]*>[\s\S]*?<\/a>\s+loaned\s+<a[^>]*XID=(\d+)[^>]*>[\s\S]*?<\/a>\s+(\d+)x\s*([\s\S]+?)\s+from the faction armory/gi;
                while ((mm = re.exec(html)) !== null) {
                    push(mm[2], parseInt(mm[3], 10) || 1, mm[4]);
                }
            });

            const oldest = Math.min(...news.map(e => e.timestamp || now));
            if (oldest <= fromTs) break;
            toTs = oldest - 1;
        }

        hints.sort((a, b) => b.ts - a.ts);
        return hints;
    }

    function itemNamesMatch(apiName, hintName) {
        const a = normItemName(apiName);
        const b = normItemName(hintName);
        if (!a || !b) return false;
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;
        return false;
    }

    /** Full borrower list for one vault row (API + news backfill). */
    function resolveBorrowerIdsForItem(item, hints, usedHintIdx) {
        const { ids, loaned } = rawBorrowerIdsFromItem(item);
        const out = ids.slice();
        const name = item.name || item.ID;
        let need = loaned - out.length;
        if (need <= 0) return out;

        for (let i = 0; i < hints.length && need > 0; i++) {
            if (usedHintIdx[i]) continue;
            if (!itemNamesMatch(name, hints[i].itemName)) continue;
            out.push(hints[i].borrowerId);
            usedHintIdx[i] = true;
            need--;
        }
        return out;
    }

    /** Infer armour slot from item name (same-purpose grouping: gloves, boots, helmet, legs, body). */
    function getArmorSlot(name) {
        if (!name || typeof name !== 'string') return 'Other';
        const n = name.toLowerCase();
        if (n.includes('glove')) return 'Gloves';
        if (n.includes('boot') || n.includes('shoe')) return 'Boots';
        if (n.includes('helmet') || n.includes('hat') || n.includes('cap')) return 'Helmet';
        if (n.includes('leg') || n.includes('pant') || n.includes('trouser')) return 'Legs';
        if (n.includes('vest') || n.includes('body') || n.includes('armor') || n.includes('chest') || n.includes('jacket') || n.includes('plate')) return 'Body';
        return 'Other';
    }

    /**
     * Build per-player stats. Weapons grouped by API type (Primary, Secondary, Melee); armour by slot.
     * playerId -> { weaponByType: { Primary: n, ... }, weaponItems: [], armorBySlot: { Gloves: n, ... }, armorItems: [], flagReason: string|null }
     */
    function buildPlayerStats(weaponsList, armorList) {
        const players = {};

        function ensurePlayer(id) {
            if (!players[id]) {
                players[id] = { weaponByType: {}, weaponItems: [], armorBySlot: {}, armorItems: [], flagReason: null };
            }
            return players[id];
        }

        weaponsList.forEach(item => {
            const name = item.name || `ID ${item.ID}`;
            const type = (item.type && String(item.type).trim()) || 'Other';
            const ids = item._borrowerIds || rawBorrowerIdsFromItem(item).ids;
            ids.forEach(pid => {
                const p = ensurePlayer(String(pid));
                p.weaponByType[type] = (p.weaponByType[type] || 0) + 1;
                const ex = p.weaponItems.find(x => x.name === name && x.type === type);
                if (ex) ex.count++; else p.weaponItems.push({ name, type, count: 1 });
            });
        });

        armorList.forEach(item => {
            const name = item.name || `ID ${item.ID}`;
            const slot = getArmorSlot(name);
            const ids = item._borrowerIds || rawBorrowerIdsFromItem(item).ids;
            ids.forEach(pid => {
                const p = ensurePlayer(String(pid));
                p.armorBySlot[slot] = (p.armorBySlot[slot] || 0) + 1;
                const ex = p.armorItems.find(x => x.name === name && x.slot === slot);
                if (ex) ex.count++; else p.armorItems.push({ name, slot, count: 1 });
            });
        });

        Object.values(players).forEach(p => {
            const weaponReasons = Object.entries(p.weaponByType).filter(([, n]) => n >= 2).map(([t]) => `${t} ×${p.weaponByType[t]}`);
            const armorReasons = Object.entries(p.armorBySlot).filter(([, n]) => n >= 2).map(([s]) => `${s} ×${p.armorBySlot[s]}`);
            if (weaponReasons.length || armorReasons.length) {
                p.flagReason = [weaponReasons.join(', '), armorReasons.join(', ')].filter(Boolean).join('; ');
            }
        });

        return players;
    }

    function escapeHtml(s) {
        if (s == null) return '';
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    function showLoading(show) {
        const el = document.getElementById('vault-checker-loading');
        if (el) el.style.display = show ? 'flex' : 'none';
    }

    function showError(msg) {
        const el = document.getElementById('vault-checker-error');
        if (!el) return;
        let text = '';
        if (msg != null && msg !== '') {
            if (typeof msg === 'string') text = msg;
            else if (typeof msg === 'object' && typeof msg.message === 'string') text = msg.message;
            else text = String(msg);
        }
        el.textContent = text;
        el.style.display = text ? 'block' : 'none';
    }

    function slug(s) {
        return (s || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    }

    /** Letter codes for weapon type / armour slot (no icons). Lowercase, italic, not bold. */
    var VAULT_LETTERS = {
        primary: 'p', secondary: 's', melee: 'm', other: '·',
        gloves: 'g', boots: 'b', helmet: 'h', legs: 'l', body: 'v'
    };

    function getWeaponLetter(type) {
        var key = slug(type || '');
        return VAULT_LETTERS[key === 'primary' || key === 'secondary' || key === 'melee' ? key : 'other'] || VAULT_LETTERS.other;
    }
    function getArmourLetter(slot) {
        var key = slug(slot || '');
        return VAULT_LETTERS[key] || VAULT_LETTERS.other;
    }

    function renderByPlayer(playerStats, nameMap) {
        const panel = document.getElementById('vault-checker-panel-by-player');
        if (!panel) return;
        vaultLastByPlayer = playerStats;
        vaultLastNameMap = nameMap;
        const entries = Object.entries(playerStats).sort((a, b) => {
            const aFlag = a[1].flagReason ? 1 : 0;
            const bFlag = b[1].flagReason ? 1 : 0;
            if (bFlag !== aFlag) return bFlag - aFlag;
            const aName = (nameMap && nameMap[a[0]]) || a[0];
            const bName = (nameMap && nameMap[b[0]]) || b[0];
            return aName.localeCompare(bName);
        });
        const rows = entries.map(([playerId, p]) => {
            const displayName = (nameMap && nameMap[playerId]) ? nameMap[playerId] : playerId;
            const weaponSpans = (p.weaponItems || []).map(x => {
                const typeClass = 'vault-wtype-' + slug(x.type || 'other');
                const letter = getWeaponLetter(x.type);
                const label = x.count > 1 ? `${escapeHtml(x.name)} (×${x.count})` : escapeHtml(x.name);
                return `<span class="vault-item-chip ${typeClass}"><span class="vault-item-code" aria-hidden="true">${letter}</span>${label}</span>`;
            });
            const weaponStr = weaponSpans.length ? weaponSpans.join(' ') : '—';
            const armorSpans = (p.armorItems || []).map(x => {
                const slotClass = 'vault-slot-' + slug(x.slot || 'other');
                const letter = getArmourLetter(x.slot);
                const label = x.count > 1 ? `${escapeHtml(x.name)} (×${x.count})` : escapeHtml(x.name);
                return `<span class="vault-item-chip ${slotClass}"><span class="vault-item-code" aria-hidden="true">${letter}</span>${label}</span>`;
            });
            const armorStr = armorSpans.length ? armorSpans.join(' ') : '—';
            const flagCell = p.flagReason ? `<span style="color: #f44;">⚠️ ${escapeHtml(p.flagReason)}</span>` : '—';
            const memLabel = window.toolsFormatMemberDisplayLabel({ name: displayName, id: playerId }, window.toolsGetShowMemberIdInBrackets());
            return `<tr class="${p.flagReason ? 'vault-checker-flagged-row' : ''}">
                <td><a href="https://www.torn.com/profiles.php?XID=${escapeHtml(playerId)}" target="_blank" rel="noopener" style="color: var(--accent-color);"${window.toolsMemberLinkAttrs(displayName, playerId)}>${escapeHtml(memLabel)}</a></td>
                <td class="vault-cell-chips">${weaponStr}</td>
                <td class="vault-cell-chips">${armorStr}</td>
                <td>${flagCell}</td>
            </tr>`;
        }).join('');
        panel.innerHTML = `
            <div class="vault-checker-key" aria-hidden="true">
                <span class="vault-key-group">
                    <strong>Weapons:</strong>
                    <span class="vault-item-chip vault-wtype-primary"><span class="vault-item-code">p</span>Primary</span>
                    <span class="vault-item-chip vault-wtype-secondary"><span class="vault-item-code">s</span>Secondary</span>
                    <span class="vault-item-chip vault-wtype-melee"><span class="vault-item-code">m</span>Melee</span>
                </span>
                <span class="vault-key-group">
                    <strong>Armour:</strong>
                    <span class="vault-item-chip vault-slot-body"><span class="vault-item-code">v</span>Body</span>
                    <span class="vault-item-chip vault-slot-gloves"><span class="vault-item-code">g</span>Gloves</span>
                    <span class="vault-item-chip vault-slot-helmet"><span class="vault-item-code">h</span>Helmet</span>
                    <span class="vault-item-chip vault-slot-boots"><span class="vault-item-code">b</span>Boots</span>
                    <span class="vault-item-chip vault-slot-legs"><span class="vault-item-code">l</span>Legs</span>
                </span>
            </div>
            <table class="vault-checker-table">
                <thead>
                    <tr>
                        <th>${window.toolsMemberColumnHeaderWrap('<span>Player</span>', { align: 'flex-start' })}</th>
                        <th>Weapons</th>
                        <th>Armour</th>
                        <th>Flagged</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    function renderItemsTable(items, nameMap, isWeapon) {
        if (!items.length) return `<p style="color: #888;">No ${isWeapon ? 'weapons' : 'armour'}.</p>`;
        const typeLabel = isWeapon ? 'Type' : 'Slot';
        const rows = items.map(item => {
            const loanedNum = parseInt(item.loaned, 10) || 0;
            const loanedTo = item._borrowerIds || rawBorrowerIdsFromItem(item).ids;
            const unknown = Math.max(0, loanedNum - loanedTo.length);
            const byPlayer = {};
            loanedTo.forEach(pid => { byPlayer[pid] = (byPlayer[pid] || 0) + 1; });
            let loanedSummary = Object.entries(byPlayer)
                .map(([pid, n]) => {
                    const displayName = (nameMap && nameMap[pid]) ? nameMap[pid] : pid;
                    const memLabel = window.toolsFormatMemberDisplayLabel(
                        { name: displayName, id: pid },
                        window.toolsGetShowMemberIdInBrackets()
                    );
                    const link =
                        `<a href="https://www.torn.com/profiles.php?XID=${escapeHtml(pid)}" target="_blank" rel="noopener"${window.toolsMemberLinkAttrs(displayName, pid)}>${escapeHtml(memLabel)}</a>`;
                    return n > 1 ? `${link} (×${n})` : link;
                })
                .join(', ');
            if (unknown > 0) {
                const unk = unknown > 1 ? `Unknown (×${unknown})` : 'Unknown';
                loanedSummary = loanedSummary ? `${loanedSummary}, <span style="color:#888;" title="API did not list borrower; not in recent armory news">${unk}</span>` : `<span style="color:#888;" title="API did not list borrower">${unk}</span>`;
            }
            if (!loanedSummary) loanedSummary = '—';
            const typeOrSlot = isWeapon ? (item.type || '—') : getArmorSlot(item.name);
            return `<tr>
                <td>${escapeHtml(item.name || item.ID)}</td>
                <td>${escapeHtml(String(typeOrSlot))}</td>
                <td>${escapeHtml(String(item.quantity ?? '—'))}</td>
                <td>${escapeHtml(String(item.available ?? '—'))}</td>
                <td>${escapeHtml(String(item.loaned ?? '—'))}</td>
                <td style="font-size: 12px;">${loanedSummary}</td>
            </tr>`;
        }).join('');
        return `
            <table class="vault-checker-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>${escapeHtml(typeLabel)}</th>
                        <th>Quantity</th>
                        <th>Available</th>
                        <th>Loaned</th>
                        <th>${window.toolsMemberColumnHeaderWrap('<span>Loaned to</span>', { align: 'flex-start' })}</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    function switchTab(tabId) {
        document.querySelectorAll('.vault-checker-tab').forEach(t => {
            t.classList.toggle('vault-checker-tab-active', t.getAttribute('data-tab') === tabId);
        });
        document.querySelectorAll('.vault-checker-panel').forEach(p => {
            p.style.display = p.id === 'vault-checker-panel-' + tabId ? 'block' : 'none';
        });
    }

    async function runVaultChecker() {
        const apiKey = getApiKey();
        if (!apiKey) {
            showError('Please enter your API key in the sidebar.');
            return;
        }
        showError('');
        showLoading(true);

        try {
            const profile = await getUserProfile(apiKey);
            if (!profile.factionId) {
                showError('You are not in a faction.');
                showLoading(false);
                return;
            }

            const [weaponsData, armorData, nameMap, loanHints] = await Promise.all([
                fetchJson(`https://api.torn.com/faction/${profile.factionId}?selections=weapons&key=${apiKey}`),
                fetchJson(`https://api.torn.com/faction/${profile.factionId}?selections=armor&key=${apiKey}`),
                fetchFactionMembers(apiKey, null).catch(() => ({})),
                fetchArmoryLoanHints(apiKey, profile.playerId).catch(() => [])
            ]);

            const weaponsList = toItemList(weaponsData.weapons);
            const armorList = toItemList(armorData.armor);
            const usedHintIdx = {};
            weaponsList.forEach(item => {
                item._borrowerIds = resolveBorrowerIdsForItem(item, loanHints, usedHintIdx);
            });
            armorList.forEach(item => {
                item._borrowerIds = resolveBorrowerIdsForItem(item, loanHints, usedHintIdx);
            });

            const playerStats = buildPlayerStats(weaponsList, armorList);

            vaultLastWeaponsList = weaponsList;
            vaultLastArmorList = armorList;

            renderByPlayer(playerStats, nameMap);
            const panelWeapon = document.getElementById('vault-checker-panel-by-weapon');
            const panelArmour = document.getElementById('vault-checker-panel-by-armour');
            if (panelWeapon) panelWeapon.innerHTML = renderItemsTable(weaponsList, nameMap, true);
            if (panelArmour) panelArmour.innerHTML = renderItemsTable(armorList, nameMap, false);

            const wrap = document.getElementById('vault-checker-tabs-wrap');
            if (wrap) wrap.style.display = 'block';
        } catch (err) {
            const fallback = 'Failed to load vault.';
            const msg =
                err && typeof err === 'object' && typeof err.message === 'string' && err.message
                    ? err.message
                    : fallback;
            showError(msg);
            console.error('Vault Checker:', err);
        } finally {
            showLoading(false);
        }
    }

    function initVaultChecker() {
        if (window.logToolUsage) window.logToolUsage('vault-checker');

        document.querySelectorAll('.vault-checker-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                if (tab) switchTab(tab);
            });
        });

        runVaultChecker();
    }

    window.initVaultChecker = initVaultChecker;

    if (!window._vaultToolsMemberIdListener) {
        window._vaultToolsMemberIdListener = true;
        window.addEventListener('toolsMemberIdDisplayChanged', () => {
            if (vaultLastByPlayer) renderByPlayer(vaultLastByPlayer, vaultLastNameMap);
            const panelWeapon = document.getElementById('vault-checker-panel-by-weapon');
            const panelArmour = document.getElementById('vault-checker-panel-by-armour');
            if (vaultLastWeaponsList && panelWeapon) {
                panelWeapon.innerHTML = renderItemsTable(vaultLastWeaponsList, vaultLastNameMap, true);
            }
            if (vaultLastArmorList && panelArmour) {
                panelArmour.innerHTML = renderItemsTable(vaultLastArmorList, vaultLastNameMap, false);
            }
        });
    }
})();
