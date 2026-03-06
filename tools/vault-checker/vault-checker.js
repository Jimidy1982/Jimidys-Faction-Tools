/**
 * Vault Checker: faction vault weapons/armor and who has loaned items.
 * Flags when a player has 2+ weapons of the same type (Primary/Secondary/Melee) or 2+ armour in the same slot.
 */
(function () {
    'use strict';

    function getApiKey() {
        return (localStorage.getItem('tornApiKey') || '').trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
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
            factionName: data.faction_name || data.faction?.faction_name || ''
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

    /** Parse loaned_to string "id1,id2,id3" into list of player IDs (one per loaned item). */
    function parseLoanedTo(loanedTo) {
        if (!loanedTo || typeof loanedTo !== 'string') return [];
        return loanedTo.split(',').map(s => s.trim()).filter(Boolean);
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
            const ids = parseLoanedTo(item.loaned_to);
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
            const ids = parseLoanedTo(item.loaned_to);
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
        el.textContent = msg || '';
        el.style.display = msg ? 'block' : 'none';
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
            return `<tr class="${p.flagReason ? 'vault-checker-flagged-row' : ''}">
                <td><a href="https://www.torn.com/profiles.php?XID=${escapeHtml(playerId)}" target="_blank" rel="noopener" style="color: var(--accent-color);">${escapeHtml(displayName)}</a></td>
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
                        <th>Player</th>
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
            const loanedTo = parseLoanedTo(item.loaned_to);
            const byPlayer = {};
            loanedTo.forEach(pid => { byPlayer[pid] = (byPlayer[pid] || 0) + 1; });
            const loanedSummary = Object.entries(byPlayer)
                .map(([pid, n]) => {
                    const displayName = (nameMap && nameMap[pid]) ? nameMap[pid] : pid;
                    return n > 1 ? `<a href="https://www.torn.com/profiles.php?XID=${escapeHtml(pid)}" target="_blank" rel="noopener">${escapeHtml(displayName)}</a> (×${n})` : `<a href="https://www.torn.com/profiles.php?XID=${escapeHtml(pid)}" target="_blank" rel="noopener">${escapeHtml(displayName)}</a>`;
                })
                .join(', ') || '—';
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
                        <th>Loaned to</th>
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

            const [weaponsData, armorData, nameMap] = await Promise.all([
                fetchJson(`https://api.torn.com/faction/${profile.factionId}?selections=weapons&key=${apiKey}`),
                fetchJson(`https://api.torn.com/faction/${profile.factionId}?selections=armor&key=${apiKey}`),
                fetchFactionMembers(apiKey, null).catch(() => ({}))
            ]);

            const weaponsList = toItemList(weaponsData.weapons);
            const armorList = toItemList(armorData.armor);

            const playerStats = buildPlayerStats(weaponsList, armorList);

            renderByPlayer(playerStats, nameMap);
            const panelWeapon = document.getElementById('vault-checker-panel-by-weapon');
            const panelArmour = document.getElementById('vault-checker-panel-by-armour');
            if (panelWeapon) panelWeapon.innerHTML = renderItemsTable(weaponsList, nameMap, true);
            if (panelArmour) panelArmour.innerHTML = renderItemsTable(armorList, nameMap, false);

            const wrap = document.getElementById('vault-checker-tabs-wrap');
            if (wrap) wrap.style.display = 'block';
        } catch (err) {
            showError(err.message || 'Failed to load vault.');
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
})();
