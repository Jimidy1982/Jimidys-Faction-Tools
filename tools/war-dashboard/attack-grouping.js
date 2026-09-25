/**
 * Attack Grouping panel for the War Dashboard.
 * One faction document, cached locally for the day. Opening the page uses that
 * copy. Refresh groups asks the server again, at most once a minute. Live
 * target status comes from the dashboard's already-loaded war enemy.
 */
(function () {
    'use strict';

    var CACHE_PREFIX = 'war_dashboard_attack_grouping_v1_';
    var VIEW_PREFIX = 'war_dashboard_attack_grouping_view_v1_';
    var GROUP_REFRESH_MS = 60 * 1000;
    var REFRESH_KEY = 'war_dashboard_attack_grouping_refresh_sec_v1';
    var FILTER_KEY = 'war_dashboard_attack_grouping_filters_v1';
    var REFRESH_DEFAULT_SEC = 15;
    var REFRESH_SPEEDS = [0, 30, 15, 10, 5, 2, 1];
    var METHOD_LABELS = {
        equal: 'Equal split',
        statRange: 'Stat range',
        manual: 'Manual pick'
    };

    var AG = {
        host: null,
        wired: false,
        open: false,
        settingsOpen: false,
        sortBy: 'eststats',
        sortDir: 'desc',
        refreshSec: REFRESH_DEFAULT_SEC,
        spyById: {},
        spyKey: '',
        stateSeen: {},
        refreshTimer: null,
        refreshMeter: null,
        refreshBusy: false,
        refreshHolding: false,
        filters: { online: true, offline: true, idle: true, okay: false, hospital: false, abroad: false },
        error: '',
        viewer: null,
        published: null,
        draft: null,
        draftDirty: false,
        generalsDirty: false,
        generalDraft: [],
        generalFilter: '',
        remoteNewer: null,
        lastGroupCheckAt: 0,
        pulling: false,
        saving: false
    };

    function L() {
        return window.AttackGroupingLogic;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function clone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function ctx() {
        return AG.host.getContext();
    }

    function callableError(e) {
        var msg = e && (e.message || e.details) ? (e.message || e.details) : 'Request failed';
        return String(msg).replace(/^FirebaseError:\s*/i, '');
    }

    function todayKey() {
        var d = new Date();
        var month = String(d.getMonth() + 1);
        var day = String(d.getDate());
        if (month.length < 2) month = '0' + month;
        if (day.length < 2) day = '0' + day;
        return d.getFullYear() + '-' + month + '-' + day;
    }

    function readPack(factionId) {
        if (!factionId) return null;
        try {
            var raw = localStorage.getItem(CACHE_PREFIX + factionId);
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (!o || typeof o !== 'object') return null;
            if (!o.grouping && !o.checkedDay && !o.checkedAt) return null;
            return {
                grouping: o.grouping || null,
                viewer: o.viewer || null,
                checkedDay: o.checkedDay || '',
                checkedAt: Number(o.checkedAt) || 0
            };
        } catch (e) {
            return null;
        }
    }

    function writePack(factionId, patch) {
        if (!factionId) return;
        var prev = readPack(factionId) || { grouping: null, viewer: null, checkedDay: '', checkedAt: 0 };
        var next = {
            grouping: patch && Object.prototype.hasOwnProperty.call(patch, 'grouping') ? patch.grouping : prev.grouping,
            viewer: patch && Object.prototype.hasOwnProperty.call(patch, 'viewer') ? patch.viewer : prev.viewer,
            checkedDay: patch && Object.prototype.hasOwnProperty.call(patch, 'checkedDay') ? patch.checkedDay : prev.checkedDay,
            checkedAt: patch && Object.prototype.hasOwnProperty.call(patch, 'checkedAt') ? patch.checkedAt : prev.checkedAt
        };
        try {
            localStorage.setItem(CACHE_PREFIX + factionId, JSON.stringify({
                revision: next.grouping && next.grouping.revision ? next.grouping.revision : 0,
                grouping: next.grouping,
                viewer: next.viewer,
                checkedDay: next.checkedDay,
                checkedAt: next.checkedAt
            }));
        } catch (e) { /* ignore */ }
    }

    function readView(factionId, playerId) {
        try {
            var raw = localStorage.getItem(VIEW_PREFIX + factionId + '_' + playerId);
            var o = raw ? JSON.parse(raw) : null;
            var extra = o && Array.isArray(o.activeExtra) ? o.activeExtra : [];
            return { activeExtra: extra.map(Number).filter(function (n) { return Number.isInteger(n); }) };
        } catch (e) {
            return { activeExtra: [] };
        }
    }

    function writeView(factionId, playerId, view) {
        try {
            localStorage.setItem(VIEW_PREFIX + factionId + '_' + playerId, JSON.stringify({
                activeExtra: view.activeExtra || []
            }));
        } catch (e) { /* ignore */ }
    }

    function emptyDraft(warId) {
        var logic = L();
        var n = logic.DEFAULT_TIERS;
        return {
            revision: 0,
            updatedAt: 0,
            updatedByName: '',
            warEnemyFactionId: warId || '',
            tierCount: n,
            generalPlayerIds: [],
            our: logic.emptySide(n, 'equal'),
            targets: logic.emptySide(n, 'equal')
        };
    }

    function ensureDraft() {
        if (AG.draft) return;
        var c = ctx();
        var warId = c.warEnemy ? c.warEnemy.id : '';
        AG.draft = AG.published ? clone(AG.published) : emptyDraft(warId);
        if (!AG.generalsDirty) AG.generalDraft = (AG.draft.generalPlayerIds || []).slice();
    }

    function nameOf(members, id) {
        var sid = String(id);
        var list = members || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && String(list[i].id) === sid) return list[i].name || sid;
        }
        return 'Player ' + sid;
    }

    function roster(sideKey, c) {
        if (sideKey === 'our') return { members: c.ourMembers || [], bs: c.ourBs || {} };
        var war = c.warEnemy;
        return {
            members: war && war.members ? war.members : [],
            bs: war && war.bs ? war.bs : {}
        };
    }

    function buildSide(sideKey) {
        var logic = L();
        var c = ctx();
        var data = roster(sideKey, c);
        var side = AG.draft[sideKey];
        var n = AG.draft.tierCount;
        if (side.method === 'equal') {
            side.tiers = logic.equalSplit(data.members, data.bs, n);
        } else if (side.method === 'statRange') {
            if (!logic.rangesConfigured(side.ranges)) {
                side.ranges = logic.defaultRanges(data.members, data.bs, n);
            } else {
                side.ranges = logic.resizeSide(side, n).ranges;
            }
            side.tiers = logic.applyRanges(data.members, data.bs, side.ranges).tiers;
        }
        AG.draftDirty = true;
    }

    function unassignedIds(side, members) {
        var placed = {};
        (side.tiers || []).forEach(function (list) {
            (list || []).forEach(function (id) { placed[String(id)] = true; });
        });
        var out = [];
        (members || []).forEach(function (m) {
            if (!m || m.id == null) return;
            var id = String(m.id);
            if (!/^\d+$/.test(id) || placed[id]) return;
            out.push(id);
        });
        return out;
    }

    function peopleForIds(ids, members, bsMap) {
        var logic = L();
        return (ids || []).map(function (id) {
            return {
                id: String(id),
                name: nameOf(members, id),
                stat: logic.statOf(bsMap, id)
            };
        }).sort(logic.compareStatDesc);
    }

    function movePerson(sideKey, id, toTier) {
        var side = AG.draft[sideKey];
        var sid = String(id);
        side.tiers = (side.tiers || []).map(function (list) {
            return (list || []).filter(function (x) { return String(x) !== sid; });
        });
        if (toTier >= 0 && side.tiers[toTier]) side.tiers[toTier].push(sid);
        side.method = 'manual';
        AG.draftDirty = true;
        render();
    }

    function setTierCount(next) {
        var logic = L();
        var n = logic.clampTierCount(next);
        if (!AG.draft || n === AG.draft.tierCount) return;
        AG.draft.tierCount = n;
        AG.draft.our = logic.resizeSide(AG.draft.our, n);
        AG.draft.targets = logic.resizeSide(AG.draft.targets, n);
        if (AG.draft.our.method !== 'manual') buildSide('our');
        if (AG.draft.targets.method !== 'manual') buildSide('targets');
        AG.draftDirty = true;
        render();
    }

    function myTierIndex(grouping, playerId) {
        if (!grouping || !playerId) return -1;
        var tiers = grouping.our && grouping.our.tiers ? grouping.our.tiers : [];
        var sid = String(playerId);
        for (var i = 0; i < tiers.length; i++) {
            var list = tiers[i] || [];
            for (var j = 0; j < list.length; j++) {
                if (String(list[j]) === sid) return i;
            }
        }
        return -1;
    }

    function cardOrder(grouping, playerId, view) {
        var n = grouping.tierCount;
        var mine = myTierIndex(grouping, playerId);
        var active = [];
        var seen = {};
        if (mine >= 0) {
            active.push({ index: mine, mine: true });
            seen[mine] = true;
        }
        (view.activeExtra || []).forEach(function (idx) {
            var i = Number(idx);
            if (!Number.isInteger(i) || i < 0 || i >= n || seen[i]) return;
            active.push({ index: i, mine: false });
            seen[i] = true;
        });
        var idle = [];
        for (var t = 0; t < n; t++) {
            if (!seen[t]) idle.push(t);
        }
        return { active: active, idle: idle, mine: mine };
    }

    function mutateView(fn) {
        var c = ctx();
        if (!c.factionId || !c.playerId) return;
        var view = readView(c.factionId, c.playerId);
        fn(view);
        writeView(c.factionId, c.playerId, view);
        renderBoard();
    }

    function updateButtonSummary() {
        var el = document.getElementById('war-dashboard-attack-grouping-summary');
        var btn = document.getElementById('war-dashboard-attack-grouping-command');
        if (!el || !btn || !AG.host) return;
        var vip = AG.host.hasVip3();
        var onRoute = isAttackGroupingRoute();
        btn.classList.toggle('war-dashboard-command-btn--vip-locked', !vip);
        btn.classList.toggle('war-dashboard-command-btn--current', onRoute && vip);
        btn.setAttribute('aria-disabled', vip ? 'false' : 'true');
        btn.setAttribute('aria-expanded', onRoute ? 'true' : 'false');
        if (vip) btn.setAttribute('href', '#war-dashboard/attack-grouping');
        if (!vip) {
            el.textContent = 'VIP 3 required';
            btn.setAttribute('title', 'Requires VIP 3. Open How VIP works for details.');
            return;
        }
        btn.removeAttribute('title');
        var c = ctx();
        var pack = readPack(c.factionId);
        var grouping = AG.published || (pack && pack.grouping);
        el.textContent = grouping && grouping.tierCount ? (grouping.tierCount + ' tiers') : "This war's tiers";
    }

    function applyServerGrouping(grouping, keepDraft) {
        if (grouping && AG.published && Number(grouping.revision) < Number(AG.published.revision || 0)) return;
        if (!grouping && AG.published && Number(AG.published.revision) > 0) return;
        AG.published = grouping;
        var c = ctx();
        writePack(c.factionId, { grouping: grouping || null });
        if (!keepDraft) {
            AG.draft = grouping ? clone(grouping) : emptyDraft(c.warEnemy ? c.warEnemy.id : '');
            AG.draftDirty = false;
            AG.remoteNewer = null;
        }
        if (!AG.generalsDirty) {
            AG.generalDraft = grouping && grouping.generalPlayerIds ? grouping.generalPlayerIds.slice() : [];
        }
        updateButtonSummary();
    }

    function groupRefreshWaitSec() {
        var at = AG.lastGroupCheckAt || 0;
        if (!at) return 0;
        return Math.max(0, Math.ceil((GROUP_REFRESH_MS - (Date.now() - at)) / 1000));
    }

    function rememberGroupCheck(at) {
        AG.lastGroupCheckAt = at;
        var c = ctx();
        if (c.factionId) writePack(c.factionId, { checkedAt: at });
    }

    function markGroupsCheckedToday() {
        var c = ctx();
        if (!c.factionId) return;
        writePack(c.factionId, {
            viewer: AG.viewer || null,
            checkedDay: todayKey(),
            checkedAt: AG.lastGroupCheckAt || Date.now()
        });
    }

    async function ensureGroupsForToday() {
        if (!AG.host || !AG.open || AG.pulling) return;
        if (!AG.host.hasVip3()) return;
        var c = ctx();
        if (!c.factionId) return;
        var pack = readPack(c.factionId);
        if (pack && pack.checkedDay === todayKey()) return;
        await pullGroups();
    }

    async function pullGroups() {
        if (!AG.host || !AG.open || AG.pulling) return;
        var c = ctx();
        if (!c.factionId) return;
        if (!AG.host.hasVip3()) return;
        var fn = AG.host.getFunctions();
        var apiKey = AG.host.getApiKey();
        if (!fn || !apiKey) {
            AG.error = 'Set your Torn API key in the sidebar first.';
            render();
            return;
        }
        AG.pulling = true;
        rememberGroupCheck(Date.now());
        updateGroupRefreshButtons();
        var pack = readPack(c.factionId);
        var cached = (pack && pack.grouping) || AG.published;
        try {
            var res = await fn.httpsCallable('attackGroupingGet')({
                apiKey: apiKey,
                factionId: c.factionId,
                revision: cached && cached.revision ? cached.revision : 0
            });
            var data = res && res.data ? res.data : {};
            AG.viewer = data.viewer || AG.viewer;
            AG.error = '';
            if (data.unchanged && cached) {
                applyServerGrouping(cached, AG.draftDirty || AG.generalsDirty);
            } else if (data.grouping) {
                if ((AG.draftDirty || AG.generalsDirty) && cached && data.grouping.revision !== cached.revision) {
                    AG.remoteNewer = data.grouping;
                    AG.published = data.grouping;
                    writePack(c.factionId, { grouping: data.grouping });
                } else {
                    applyServerGrouping(data.grouping, false);
                }
            } else {
                applyServerGrouping(null, AG.draftDirty);
            }
            markGroupsCheckedToday();
        } catch (e) {
            AG.error = callableError(e);
        } finally {
            AG.pulling = false;
            seedDraftIfNeeded();
            render();
            if (AG.openAfterLoad) {
                AG.openAfterLoad = false;
                if (AG.viewer && AG.viewer.canEdit) openSettings();
            }
        }
    }

    function seedDraftIfNeeded() {
        if (!AG.viewer || !AG.viewer.canEdit || AG.published || AG.draftDirty) return;
        if (!ctx().warEnemy) return;
        var ourReady = roster('our', ctx()).members.length > 0;
        var targetReady = roster('targets', ctx()).members.length > 0;
        if (!ourReady && !targetReady) return;
        ensureDraft();
        if (ourReady && AG.draft.our.method !== 'manual') buildSide('our');
        if (targetReady && AG.draft.targets.method !== 'manual') buildSide('targets');
    }

    function sidePayload(side) {
        return {
            method: side.method,
            ranges: (side.ranges || []).map(function (r) {
                return { min: r && r.min != null ? r.min : null, max: r && r.max != null ? r.max : null };
            }),
            tiers: (side.tiers || []).map(function (list) { return (list || []).slice(); })
        };
    }

    async function saveGrouping() {
        var c = ctx();
        if (!AG.draft || !c.warEnemy) return;
        var fn = AG.host.getFunctions();
        AG.saving = true;
        AG.error = '';
        render();
        try {
            var res = await fn.httpsCallable('attackGroupingSave')({
                apiKey: AG.host.getApiKey(),
                factionId: c.factionId,
                warEnemyFactionId: c.warEnemy.id,
                tierCount: AG.draft.tierCount,
                our: sidePayload(AG.draft.our),
                targets: sidePayload(AG.draft.targets)
            });
            var data = res && res.data ? res.data : {};
            AG.viewer = data.viewer || AG.viewer;
            if (!data.grouping || !data.grouping.tierCount) {
                AG.error = 'The grouping did not save. Try again.';
                return;
            }
            AG.error = '';
            applyServerGrouping(data.grouping, false);
            closeSettings();
        } catch (e) {
            AG.error = callableError(e);
        } finally {
            AG.saving = false;
            render();
        }
    }

    async function saveGenerals() {
        var c = ctx();
        var fn = AG.host.getFunctions();
        AG.saving = true;
        AG.error = '';
        render();
        try {
            var res = await fn.httpsCallable('attackGroupingSetGenerals')({
                apiKey: AG.host.getApiKey(),
                factionId: c.factionId,
                generalPlayerIds: AG.generalDraft.slice()
            });
            var data = res && res.data ? res.data : {};
            AG.viewer = data.viewer || AG.viewer;
            AG.generalsDirty = false;
            applyServerGrouping(data.grouping, AG.draftDirty);
            if (AG.draft && data.grouping) AG.draft.generalPlayerIds = data.grouping.generalPlayerIds.slice();
        } catch (e) {
            AG.error = callableError(e);
        } finally {
            AG.saving = false;
            render();
        }
    }

    function methodSelect(sideKey, method) {
        return ['equal', 'statRange', 'manual'].map(function (key) {
            return '<option value="' + key + '"' + (method === key ? ' selected' : '') + '>' + METHOD_LABELS[key] + '</option>';
        }).join('');
    }

    function tierOptions(selected) {
        var html = '<option value="-1"' + (selected < 0 ? ' selected' : '') + '>Unassigned</option>';
        var n = AG.draft ? AG.draft.tierCount : 0;
        for (var i = 0; i < n; i++) {
            html += '<option value="' + i + '"' + (selected === i ? ' selected' : '') + '>Tier ' + (i + 1) + '</option>';
        }
        return html;
    }

    function tierIndexOf(side, id) {
        var sid = String(id);
        var tiers = side && side.tiers ? side.tiers : [];
        for (var i = 0; i < tiers.length; i++) {
            var list = tiers[i] || [];
            for (var j = 0; j < list.length; j++) {
                if (String(list[j]) === sid) return i;
            }
        }
        return -1;
    }

    function rangeEditorHtml(sideKey, side) {
        var logic = L();
        if (!side || side.method !== 'statRange') return '';
        var placed = logic.applyRanges(roster(sideKey, ctx()).members, roster(sideKey, ctx()).bs, side.ranges || []);
        var rows = '';
        for (var i = 0; i < AG.draft.tierCount; i++) {
            var r = side.ranges[i] || { min: null, max: null };
            var count = (placed.tiers[i] || []).length;
            rows += '<tr><td>Tier ' + (i + 1) + '</td>' +
                '<td><input id="ag-range-' + sideKey + '-' + i + '-min" data-ag="range" data-side="' + sideKey + '" data-tier="' + i + '" data-bound="min" value="' + esc(logic.formatStatInput(r.min)) + '" placeholder="none" aria-label="Tier ' + (i + 1) + ' minimum"></td>' +
                '<td><input id="ag-range-' + sideKey + '-' + i + '-max" data-ag="range" data-side="' + sideKey + '" data-tier="' + i + '" data-bound="max" value="' + esc(logic.formatStatInput(r.max)) + '" placeholder="none" aria-label="Tier ' + (i + 1) + ' maximum"></td>' +
                '<td class="ag-range-count">' + count + '</td></tr>';
        }
        var leftover = (placed.unassigned || []).length;
        return '<table class="ag-range-table"><thead><tr><th>Tier</th><th>Min</th><th>Max</th><th>Players</th></tr></thead><tbody>' +
            rows + '</tbody></table>' +
            (leftover ? '<p class="ag-help">' + leftover + ' not in a range.</p>' : '') +
            '<p class="ag-help">500m or 2b. Blank means no limit. Tier 1 is checked first.</p>';
    }

    function assignmentTable(sideKey) {
        var logic = L();
        var c = ctx();
        var data = roster(sideKey, c);
        var side = AG.draft[sideKey];
        var manual = side.method === 'manual';
        var people = (data.members || []).map(function (m) {
            if (!m || m.id == null) return null;
            return { id: String(m.id), name: m.name || String(m.id), stat: logic.statOf(data.bs, m.id) };
        }).filter(Boolean).sort(logic.compareStatDesc);
        if (!people.length) return '<p class="ag-empty">No members loaded yet.</p>';
        var rows = people.map(function (p) {
            var tier = tierIndexOf(side, p.id);
            var tierCell = manual
                ? '<select data-ag="move" data-side="' + sideKey + '" data-id="' + esc(p.id) + '" aria-label="Tier for ' + esc(p.name) + '">' + tierOptions(tier) + '</select>'
                : (tier < 0 ? 'Unassigned' : ('Tier ' + (tier + 1)));
            return '<tr><td>' + esc(p.name) + '</td><td>' + esc(logic.formatStat(p.stat)) + '</td><td>' + tierCell + '</td></tr>';
        }).join('');
        return '<div class="table-scroll-wrapper ag-assign-scroll"><table class="war-dashboard-table ag-assign-table"><thead><tr>' +
            '<th>Member</th><th>Est. stats</th><th>Tier</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function settingsSideHtml(sideKey, title) {
        var side = AG.draft[sideKey];
        var rebuild = side.method === 'manual'
            ? ''
            : '<button type="button" class="btn" data-ag="rebuild" data-side="' + sideKey + '">Rebuild</button>';
        return '<section class="ag-settings-side">' +
            '<h3>' + esc(title) + '</h3>' +
            '<div class="ag-side-head">' +
            '<label>Method <select id="ag-method-' + sideKey + '" data-ag="method" data-side="' + sideKey + '">' + methodSelect(sideKey, side.method) + '</select></label>' +
            rebuild +
            '</div>' +
            rangeEditorHtml(sideKey, side) +
            assignmentTable(sideKey) +
            '</section>';
    }

    function generalsHtml() {
        if (!AG.viewer || !AG.viewer.canManageGenerals) {
            return '<p class="ag-help">Generals are chosen by the leader or co-leader.</p>';
        }
        var c = ctx();
        var q = AG.generalFilter.trim().toLowerCase();
        var members = (c.ourMembers || []).slice().sort(function (a, b) {
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
        var items = members.filter(function (m) {
            if (!q) return true;
            return String(m.name || '').toLowerCase().indexOf(q) >= 0 || String(m.id).indexOf(q) >= 0;
        }).map(function (m) {
            var id = String(m.id);
            var on = AG.generalDraft.indexOf(id) >= 0;
            return '<label class="ag-general"><input type="checkbox" data-ag="general" data-id="' + esc(id) + '"' + (on ? ' checked' : '') + '> ' +
                esc(m.name || id) + '</label>';
        }).join('');
        return '<section class="ag-generals">' +
            '<h3>Generals</h3>' +
            '<p id="ag-general-names" class="ag-general-names">' + generalNamesHtml() + '</p>' +
            '<p class="ag-help">Generals can change tiers. They cannot appoint generals.</p>' +
            '<input id="ag-general-filter" data-ag="general-filter" type="search" placeholder="Search members" value="' + esc(AG.generalFilter) + '">' +
            '<div id="ag-general-list" class="ag-general-list">' + (items || '<p class="ag-empty">No members match.</p>') + '</div>' +
            '</section>';
    }

    function generalNamesHtml() {
        var c = ctx();
        if (!AG.generalDraft.length) return 'No generals yet.';
        return AG.generalDraft.map(function (id) { return esc(nameOf(c.ourMembers, id)); }).join(', ');
    }

    function settingsBodyHtml() {
        if (!AG.viewer || !AG.viewer.canEdit) {
            return '<p class="ag-help">Only a leader, co-leader, or general can change the grouping.</p>';
        }
        ensureDraft();
        var c = ctx();
        var err = AG.error ? '<p class="ag-warn">' + esc(AG.error) + '</p>' : '';
        var warName = c.warEnemy ? (c.warEnemy.name || ('Faction ' + c.warEnemy.id)) : '';
        var warNote = c.warEnemy
            ? '<p class="ag-help">Building for <strong>' + esc(warName) + '</strong>. Tier 1 on the left attacks Tier 1 on the right. Save publishes this to the faction.</p>'
            : '<p class="ag-warn">No current ranked war is loaded, so this cannot be saved yet.</p>';
        var mismatch = '';
        if (c.warEnemy && AG.published && AG.published.warEnemyFactionId && AG.published.warEnemyFactionId !== String(c.warEnemy.id)) {
            mismatch = '<p class="ag-warn">The published grouping is for a different war. Rebuild both sides, then save.</p>';
        }
        return err + warNote + mismatch +
            '<div class="ag-tier-count">' +
            '<span>Tiers</span>' +
            '<button type="button" class="btn ag-tier-step" data-ag="tier-dec" aria-label="Fewer tiers">−</button>' +
            '<strong>' + AG.draft.tierCount + '</strong>' +
            '<button type="button" class="btn ag-tier-step" data-ag="tier-inc" aria-label="More tiers">+</button>' +
            '<span class="ag-help">Same number on both sides. Maximum 10.</span>' +
            '</div>' +
            '<div class="ag-tier-row">' +
            settingsSideHtml('our', 'Your faction') +
            settingsSideHtml('targets', 'War enemy') +
            '</div>' +
            generalsHtml();
    }

    function settingsFooterHtml() {
        if (!AG.viewer || !AG.viewer.canEdit) return '';
        var c = ctx();
        var saveLabel = AG.draftDirty ? 'Save grouping' : 'Saved';
        var generalBtn = '';
        if (AG.viewer.canManageGenerals) {
            generalBtn = '<button type="button" class="btn" data-ag="save-generals"' + (AG.saving || !AG.generalsDirty ? ' disabled' : '') + '>' +
                (AG.generalsDirty ? 'Save generals' : 'Generals saved') + '</button>';
        }
        return '<button type="button" class="btn" data-ag="save"' + (AG.saving || !c.warEnemy || !AG.draftDirty ? ' disabled' : '') + '>' +
            saveLabel + '</button>' +
            (AG.draftDirty ? '<span class="ag-help">Members keep the previous grouping until you save.</span>' : '') +
            generalBtn;
    }

    function statusBits(ids, war) {
        var online = 0;
        var hospital = 0;
        var ready = 0;
        (ids || []).forEach(function (id) {
            var member = memberById(war, id);
            if (!member || !AG.host.describeTarget) return;
            var view = AG.host.describeTarget(member, ffOf(war, id), bsOf(war, id));
            if (view.online) online += 1;
            if (view.inHospital) hospital += 1;
            if (view.online && !view.inHospital && !view.abroad) ready += 1;
        });
        return { online: online, hospital: hospital, ready: ready };
    }

    function memberById(war, id) {
        var list = war && war.members ? war.members : [];
        var sid = String(id);
        for (var i = 0; i < list.length; i++) {
            if (list[i] && String(list[i].id) === sid) return list[i];
        }
        return null;
    }

    function ffOf(war, id) {
        if (!war || !war.ff) return null;
        var v = war.ff[String(id)];
        return v == null ? war.ff[id] : v;
    }

    function bsOf(war, id) {
        if (!war || !war.bs) return null;
        var v = war.bs[String(id)];
        return v == null ? war.bs[id] : v;
    }

    function sidePack(c, sideKey) {
        if (sideKey === 'our') {
            return { members: c.ourMembers || [], ff: c.ourFf || {}, bs: c.ourBs || {} };
        }
        var war = c.warEnemy || {};
        return { members: war.members || [], ff: war.ff || {}, bs: war.bs || {} };
    }

    function sortGlyph(column) {
        if (AG.sortBy !== column) return '';
        return AG.sortDir === 'asc' ? '▲' : '▼';
    }

    function tableHeadHtml(attack) {
        function th(column, label) {
            return '<th data-ag="sort" data-column="' + column + '" class="war-dashboard-th-sort">' +
                label + ' <span class="war-dashboard-sort">' + sortGlyph(column) + '</span></th>';
        }
        return '<thead><tr>' +
            (attack ? '<th class="ag-attack-col"></th>' : '') +
            th('member', 'Member') + th('level', 'Level') +
            th('eststats', 'Stats') + th('status', 'Status') + th('location', 'State') +
            '</tr></thead>';
    }

    function passesFilters(view) {
        var f = AG.filters;
        var online = !!view.online;
        var idle = !!view.idle;
        var offline = !online && !idle;
        var anyActivity = f.online || f.offline || f.idle;
        var matchActivity = !anyActivity || (online && f.online) || (offline && f.offline) || (idle && f.idle);
        var anyStatus = f.okay || f.hospital || f.abroad;
        var okay = !view.inHospital && !view.abroad;
        var matchStatus = !anyStatus || (f.hospital && view.inHospital) || (f.abroad && view.abroad) || (f.okay && okay);
        return matchActivity && matchStatus;
    }

    function parseNum(text) {
        if (text == null || text === '—' || text === '-') return null;
        var n = Number(String(text).replace(/,/g, ''));
        return Number.isFinite(n) ? n : null;
    }

    function compareViews(a, b) {
        if (a.missing && b.missing) return 0;
        if (a.missing) return 1;
        if (b.missing) return -1;
        var by = AG.sortBy;
        if (by === 'member' || by === 'status' || by === 'location') {
            var av = by === 'member' ? a.name : (by === 'status' ? a.actionText : a.locationText);
            var bv = by === 'member' ? b.name : (by === 'status' ? b.actionText : b.locationText);
            return String(av || '').localeCompare(String(bv || '')) * (AG.sortDir === 'desc' ? -1 : 1);
        }
        var an = by === 'level' ? parseNum(a.level) : statNumber(a);
        var bn = by === 'level' ? parseNum(b.level) : statNumber(b);
        if (an == null && bn == null) return 0;
        if (an == null) return 1;
        if (bn == null) return -1;
        return (an - bn) * (AG.sortDir === 'asc' ? 1 : -1);
    }

    function mailRows(ids, pack) {
        var rows = [];
        (ids || []).forEach(function (id) {
            var member = memberById(pack, id);
            if (!member) {
                rows.push({ missing: true, id: String(id) });
                return;
            }
            if (!AG.host || !AG.host.describeTarget) return;
            rows.push(AG.host.describeTarget(member, ffOf(pack, id), bsOf(pack, id)));
        });
        rows.sort(compareViews);
        return rows;
    }

    function mailCell(text) {
        return '<td style="padding:4px 8px;border:1px solid #ccc;vertical-align:top;">' + esc(text || '—') + '</td>';
    }

    function mailNameCell(view, linked) {
        if (!view || view.missing) {
            return '<td style="padding:4px 8px;border:1px solid #ccc;">' + esc(view ? ('Player ' + view.id) : '') + '</td>';
        }
        var label = esc(memberLabel(view));
        var inner = linked
            ? '<a href="' + esc(view.profileUrl || ('https://www.torn.com/profiles.php?XID=' + encodeURIComponent(view.id))) + '">' + label + '</a>'
            : '<b>' + label + '</b>';
        return '<td style="padding:4px 8px;border:1px solid #ccc;">' + inner + '</td>';
    }

    function mailPlainPerson(view) {
        if (!view) return ['', '', ''];
        if (view.missing) return ['Player ' + view.id, '', ''];
        return [memberLabel(view), view.level || '—', shortStat(view)];
    }

    function mailGapCell(label) {
        return '<td style="width:88px;min-width:88px;padding:4px 10px;border:none;text-align:center;font-weight:700;">' +
            (label ? esc(label) : '&nbsp;') + '</td>';
    }

    function factionMailPack() {
        var c = ctx();
        var grouping = AG.published;
        if (!grouping || !grouping.tierCount) return null;
        var enemyName = (c.warEnemy && c.warEnemy.name) || 'War enemy';
        var ourPack = sidePack(c, 'our');
        var enemyPack = sidePack(c, 'targets');
        var title = 'Attack grouping vs ' + enemyName;
        var th = ' style="background:#f5f5f5;padding:4px 8px;text-align:left;border:1px solid #ccc;"';
        var html = '<div style="font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;color:#111;">' +
            '<div style="font-size:28px;font-weight:700;margin:0 0 12px 0;">' + esc(title) + '</div>' +
            '<table style="border-collapse:collapse;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;color:#111;" cellpadding="4" cellspacing="0">' +
            '<thead><tr>' +
            '<th colspan="3" style="background:#e8f5e9;padding:4px 8px;text-align:left;border:1px solid #ccc;">Your faction</th>' +
            mailGapCell('___Vs___') +
            '<th colspan="3" style="background:#fff3e0;padding:4px 8px;text-align:left;border:1px solid #ccc;">' + esc(enemyName) + '</th>' +
            '</tr><tr>' +
            '<th' + th + '>Member</th><th' + th + '>Level</th><th' + th + '>Stats</th>' +
            mailGapCell() +
            '<th' + th + '>Target</th><th' + th + '>Level</th><th' + th + '>Stats</th>' +
            '</tr></thead><tbody>';
        var plain = [title, '', ['Member', 'Level', 'Stats', '___Vs___', 'Target', 'Level', 'Stats'].join('\t')];
        var count = grouping.tierCount;
        for (var i = 0; i < count; i++) {
            var ourIds = (grouping.our && grouping.our.tiers && grouping.our.tiers[i]) || [];
            var enemyIds = (grouping.targets && grouping.targets.tiers && grouping.targets.tiers[i]) || [];
            var ours = mailRows(ourIds, ourPack);
            var enemies = mailRows(enemyIds, enemyPack);
            var n = Math.max(ours.length, enemies.length, 1);
            var tierLabel = 'Tier ' + (i + 1);
            html += '<tr><td colspan="7" style="padding:8px;border:1px solid #ccc;background:#fff8dc;font-weight:700;font-size:18px;">' + tierLabel + '</td></tr>';
            plain.push(tierLabel);
            for (var r = 0; r < n; r++) {
                var oursView = ours[r];
                var enemyView = enemies[r];
                html += '<tr>' + mailNameCell(oursView, false) +
                    mailCell(oursView && !oursView.missing ? oursView.level : '') +
                    mailCell(oursView && !oursView.missing ? shortStat(oursView) : '') +
                    mailGapCell() +
                    mailNameCell(enemyView, true) +
                    mailCell(enemyView && !enemyView.missing ? enemyView.level : '') +
                    mailCell(enemyView && !enemyView.missing ? shortStat(enemyView) : '') +
                    '</tr>';
                plain.push(mailPlainPerson(oursView).concat(['']).concat(mailPlainPerson(enemyView)).join('\t'));
            }
        }
        html += '</tbody></table></div>';
        return { html: html, plain: plain.join('\n') };
    }

    function canCopyFactionMail() {
        return !!(AG.viewer && AG.viewer.canEdit && AG.published && AG.published.tierCount);
    }

    function copyFactionMail(button) {
        if (!canCopyFactionMail()) return;
        var pack = factionMailPack();
        if (!pack) return;
        var done = function () {
            if (!button) return;
            var previous = button.textContent;
            button.textContent = 'Copied';
            setTimeout(function () { button.textContent = previous; }, 1600);
        };
        var writeHtml = navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined'
            ? navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([pack.html], { type: 'text/html' }),
                    'text/plain': new Blob([pack.plain], { type: 'text/plain' })
                })
            ])
            : Promise.reject(new Error('no html clipboard'));
        writeHtml.then(done).catch(function () {
            if (!navigator.clipboard || !navigator.clipboard.writeText) return;
            navigator.clipboard.writeText(pack.plain).then(done).catch(function () {});
        });
    }

    function rowsFor(ids, pack) {
        var rows = [];
        (ids || []).forEach(function (id) {
            var member = memberById(pack, id);
            if (!member) {
                rows.push({ missing: true, id: String(id) });
                return;
            }
            if (!AG.host || !AG.host.describeTarget) return;
            var view = AG.host.describeTarget(member, ffOf(pack, id), bsOf(pack, id));
            if (!passesFilters(view)) return;
            rows.push(view);
        });
        rows.sort(compareViews);
        return rows;
    }

    function memberLabel(view) {
        var label = view.name;
        if (window.toolsFormatMemberDisplayLabel) {
            try {
                label = window.toolsFormatMemberDisplayLabel(
                    { name: view.name, id: view.id },
                    window.toolsGetShowMemberIdInBrackets && window.toolsGetShowMemberIdInBrackets()
                );
            } catch (e) { /* keep name */ }
        }
        return label;
    }

    var TORNSTATS_FRESH_SEC = 30 * 24 * 60 * 60;

    function statNumber(view) {
        var spy = view && spyFor(view.id);
        var now = Math.floor(Date.now() / 1000);
        var age = spy && spy.timestamp != null ? now - Number(spy.timestamp) : Infinity;
        if (spy && spy.total != null && Number.isFinite(Number(spy.total)) && age >= 0 && age <= TORNSTATS_FRESH_SEC) {
            return Number(spy.total);
        }
        if (view && view.bsValue != null && Number.isFinite(Number(view.bsValue))) return Number(view.bsValue);
        return view ? parseNum(view.bsText) : null;
    }

    function shortStat(view) {
        var logic = L();
        var n = statNumber(view);
        if (logic && n != null && Number.isFinite(n)) return logic.formatStat(n);
        return (view && view.bsText) || '—';
    }

    function statTitle(view) {
        var parts = [];
        if (view.bsText && view.bsText !== '—') parts.push(view.bsText);
        if (view.ffText && view.ffText !== '—') parts.push('FF ' + view.ffText);
        return parts.join(' · ');
    }

    function spyFor(id) {
        return (AG.spyById && AG.spyById[String(id)]) || null;
    }

    function spyLine(label, value) {
        if (value == null || !Number.isFinite(Number(value))) return '';
        return '<div class="ag-stat-popover-row"><span>' + esc(label) + '</span><span>' + esc(Number(value).toLocaleString()) + '</span></div>';
    }

    function spyTipHtml(spy) {
        if (!spy) return '';
        var rows = spyLine('Strength', spy.strength) + spyLine('Defence', spy.defense) +
            spyLine('Speed', spy.speed) + spyLine('Dexterity', spy.dexterity) +
            spyLine('Total', spy.total);
        var age = '';
        if (spy.timestamp) {
            var when = new Date(Number(spy.timestamp) * 1000);
            if (!isNaN(when.getTime())) age = '<p class="ag-stat-popover-age">Spied ' + esc(when.toLocaleString()) + '</p>';
        }
        return rows + age;
    }

    function hideStatTip() {
        var tip = document.getElementById('ag-stat-popover');
        if (!tip) return;
        tip.hidden = true;
        tip.removeAttribute('data-pin');
    }

    function showStatTip(anchor, pin) {
        var spy = spyFor(anchor.getAttribute('data-id'));
        var html = spyTipHtml(spy);
        if (!html) return;
        var tip = document.getElementById('ag-stat-popover');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'ag-stat-popover';
            tip.className = 'ag-stat-popover';
            tip.setAttribute('role', 'tooltip');
            document.body.appendChild(tip);
        }
        tip.innerHTML = html;
        tip.hidden = false;
        if (pin) tip.setAttribute('data-pin', '1');
        else tip.removeAttribute('data-pin');
        var rect = anchor.getBoundingClientRect();
        var width = 230;
        var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        tip.style.left = left + 'px';
        tip.style.top = (rect.bottom + 6) + 'px';
    }

    function groupedPlayerIds() {
        var grouping = AG.published;
        if (!grouping) return [];
        var ids = [];
        ['our', 'targets'].forEach(function (side) {
            var tiers = grouping[side] && grouping[side].tiers;
            (tiers || []).forEach(function (tier) {
                (tier || []).forEach(function (id) { ids.push(String(id)); });
            });
        });
        return ids;
    }

    function ensureSpies() {
        var ids = groupedPlayerIds();
        var key = ids.slice().sort().join(',');
        if (!ids.length || AG.spyKey === key) return;
        AG.spyKey = key;
        if (typeof window.getCachedTornStatsSpies !== 'function') return;
        window.getCachedTornStatsSpies(ids).then(function (map) {
            if (!AG.open || AG.spyKey !== key) return;
            AG.spyById = map || {};
            renderBoard();
        }).catch(function () {});
    }

    var TRAVEL_SEEN_KEY = 'war_dashboard_attack_grouping_travel_seen_v1';

    function normCountry(name) {
        var s = String(name || '').trim().toLowerCase().replace(/^the\s+/, '');
        if (!s || s === 'torn' || s === 'torn city') return 'torn';
        var aliases = {
            uk: 'united kingdom',
            'u.k.': 'united kingdom',
            uae: 'united arab emirates',
            cayman: 'cayman islands',
            swiss: 'switzerland'
        };
        return aliases[s] || s;
    }

    function parseFlight(view) {
        var desc = String(view && view.description || '').trim();
        var matched = desc.match(/^traveling from (.+) to (.+)$/i);
        if (matched) return { from: normCountry(matched[1]), to: normCountry(matched[2]) };
        matched = desc.match(/^returning to torn from (.+)$/i);
        if (matched) return { from: normCountry(matched[1]), to: 'torn' };
        matched = desc.match(/^traveling to (.+)$/i);
        if (matched) return { from: '', to: normCountry(matched[1]) };
        return null;
    }

    function statusStillRunning(view) {
        if (!view || view.until == null || view.until === '') return true;
        var until = Number(view.until);
        if (!Number.isFinite(until)) return true;
        return until > Math.floor(Date.now() / 1000);
    }

    function flightOf(view) {
        var flight = parseFlight(view);
        if (!flight || !statusStillRunning(view)) return null;
        return flight;
    }

    function countryOf(view) {
        var flight = parseFlight(view);
        if (flight) return statusStillRunning(view) ? '' : (flight.to || 'torn');
        var desc = String(view && view.description || '').trim();
        var state = String(view && view.state || '').toLowerCase();
        var lower = desc.toLowerCase();
        var matched;
        if (state.includes('hospital') || lower.includes('hospital')) {
            matched = desc.match(/\bin\s+(?:an?\s+)?(.+?)\s+hospital\b/i) || desc.match(/hospital(?:ized)?\s+in\s+(.+?)(?:\s+for\b|$)/i);
            return matched ? normCountry(matched[1]) : 'torn';
        }
        if (state.includes('jail') || lower.includes('jail')) {
            matched = desc.match(/\bin\s+(?:an?\s+)?(.+?)\s+jail\b/i);
            return matched ? normCountry(matched[1]) : 'torn';
        }
        if (state.includes('abroad') || /^in\s+/i.test(desc)) {
            var place = desc.replace(/^in\s+/i, '').replace(/^abroad\s*[-–:]?\s*/i, '').trim();
            if (place && !/^okay$/i.test(place)) return normCountry(place);
        }
        return 'torn';
    }

    function readTravelSeen() {
        try {
            var raw = localStorage.getItem(TRAVEL_SEEN_KEY);
            var parsed = raw ? JSON.parse(raw) : null;
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function writeTravelSeen(map) {
        try { localStorage.setItem(TRAVEL_SEEN_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
    }

    function noteStateSeen(view) {
        var id = String(view.id);
        var flight = flightOf(view);
        var map = readTravelSeen();
        if (!flight) {
            if (map[id]) {
                delete map[id];
                writeTravelSeen(map);
            }
            delete AG.stateSeen[id];
            return 0;
        }
        var sig = flight.from + '>' + flight.to;
        var prev = map[id];
        if (!prev || prev.sig !== sig) {
            map[id] = { sig: sig, at: Date.now() };
            writeTravelSeen(map);
        }
        AG.stateSeen[id] = map[id];
        return map[id].at;
    }

    function viewerPlace() {
        var c = ctx();
        var id = String(c.playerId || '');
        if (!id || !AG.host || !AG.host.describeTarget) return null;
        var members = c.ourMembers || [];
        for (var i = 0; i < members.length; i++) {
            if (members[i] && String(members[i].id) === id) return AG.host.describeTarget(members[i], null, null);
        }
        return null;
    }

    function canAttackEnemy(target, viewer) {
        if (!viewer) return false;
        var mine = countryOf(viewer);
        if (!mine) return false;
        var theirs = countryOf(target);
        if (theirs && theirs === mine) return true;
        var flight = flightOf(target);
        return !!(flight && flight.to === mine);
    }

    function formatStateAge(at) {
        var sec = Math.max(0, Math.floor((Date.now() - Number(at)) / 1000));
        if (sec < 5) return 'just now';
        if (sec < 60) return sec + 's';
        var mins = Math.floor(sec / 60);
        if (mins < 60) return mins + 'm';
        var hours = Math.floor(mins / 60);
        var rem = mins % 60;
        if (hours < 48) return rem ? (hours + 'h ' + rem + 'm') : (hours + 'h');
        return Math.floor(hours / 24) + 'd';
    }

    function tickStateAges() {
        if (!AG.open) return;
        var nodes = document.querySelectorAll('#attack-grouping-root .ag-state-age');
        for (var i = 0; i < nodes.length; i++) {
            var label = nodes[i].previousElementSibling ? nodes[i].previousElementSibling.textContent : '';
            if (!/\sto\s|^to\s/i.test(String(label || '').trim())) {
                nodes[i].hidden = true;
                continue;
            }
            nodes[i].hidden = false;
            var at = Number(nodes[i].getAttribute('data-state-at'));
            if (!Number.isFinite(at)) continue;
            nodes[i].textContent = '(' + formatStateAge(at) + ')';
        }
        updateGroupRefreshButtons();
    }

    function groupRefreshLabel(inline) {
        var left = groupRefreshWaitSec();
        var busy = !!AG.pulling;
        if (inline) {
            if (busy) return 'or refreshing…';
            if (left > 0) return 'or try refreshing (' + left + 's)';
            return 'or try refreshing';
        }
        if (busy) return 'Refreshing groups…';
        if (left > 0) return 'Refresh groups · ' + left + 's';
        return 'Refresh groups';
    }

    function groupRefreshButtonHtml() {
        var wait = groupRefreshWaitSec() > 0 || AG.pulling;
        return '<button type="button" class="btn" data-ag="refresh-groups"' + (wait ? ' disabled' : '') +
            ' title="Check for a newer grouping from your leaders. Once a minute. Today’s copy stays on this browser until then.">' +
            esc(groupRefreshLabel(false)) + '</button>';
    }

    function updateGroupRefreshButtons() {
        var buttons = document.querySelectorAll('[data-ag="refresh-groups"]');
        for (var i = 0; i < buttons.length; i++) {
            var inline = buttons[i].classList.contains('ag-inline-link');
            var label = groupRefreshLabel(inline);
            buttons[i].disabled = groupRefreshWaitSec() > 0 || !!AG.pulling;
            if (buttons[i].textContent !== label) buttons[i].textContent = label;
        }
    }

    function memberTable(ids, pack, attack) {
        if (!ids || !ids.length) return '<p class="ag-empty">Nobody in this tier.</p>';
        var c = ctx();
        var rows = rowsFor(ids, pack);
        if (!rows.length) return '<p class="ag-empty">Nobody in this tier matches the filters.</p>';
        var viewer = attack ? viewerPlace() : null;
        var html = rows.map(function (view) {
            if (view.missing) {
                return '<tr class="ag-missing"><td colspan="' + (attack ? '6' : '5') + '">Player ' + esc(view.id) + ' is not in the current ' +
                    (attack ? 'war' : 'faction') + '.</td></tr>';
            }
            var you = String(view.id) === String(c.playerId);
            var linkAttrs = '';
            if (window.toolsMemberLinkAttrs) {
                try { linkAttrs = window.toolsMemberLinkAttrs(view.name, view.id) || ''; } catch (e2) { linkAttrs = ''; }
            }
            var attackCell = '';
            if (attack) {
                var attackIcon = canAttackEnemy(view, viewer)
                    ? '<a href="' + esc(view.attackUrl) + '" target="_blank" rel="noopener" title="Attack">🎯</a>'
                    : '';
                attackCell = '<td class="ag-attack-col">' + attackIcon + '</td>';
            }
            var nameCell = '<a href="' + esc(view.profileUrl) + '" target="_blank" rel="noopener" style="color:#FFD700;"' + linkAttrs + '>' +
                esc(memberLabel(view)) + '</a>';
            var idleAttr = view.idle && view.idleSince ? ' data-idle-since="' + esc(view.idleSince) + '"' : '';
            var locStyle = view.hospital ? '' : ' style="color:' + esc(view.locationColor || '') + ';"';
            var locClass = 'war-dashboard-location-cell' + (view.hospital ? ' war-dashboard-hospital-countdown' : '');
            var locAttrs = view.until
                ? ' data-status-until="' + esc(view.until) + '" data-status-desc="' + esc(view.description || '') + '" data-status-state="' + esc(view.state || '') + '"'
                : '';
            var seenAt = noteStateSeen(view);
            var showAge = seenAt > 0;
            var ageTip = 'How long this browser has shown this state. The clock starts when a refresh here first spots it, or spots a change. It is not Torn\'s own time.';
            var statTip = statTitle(view);
            var spy = spyFor(view.id);
            var statInner = esc(shortStat(view));
            if (spy) {
                statInner = '<button type="button" class="ag-stat-hit" data-ag="stat-tip" data-id="' + esc(view.id) + '" title="Detailed stats">' + statInner + '</button>';
            }
            return '<tr' + (you ? ' class="ag-row-you"' : '') + '>' +
                attackCell +
                '<td>' + nameCell + '</td>' +
                '<td>' + esc(view.level) + '</td>' +
                '<td class="ag-stat"' + (view.ffColor ? ' style="color:' + esc(view.ffColor) + ';"' : '') +
                (!spy && statTip ? ' title="' + esc(statTip) + '"' : '') + '>' + statInner + '</td>' +
                '<td class="war-dashboard-action-status"' + idleAttr + (view.actionColor ? ' style="color:' + esc(view.actionColor) + ';"' : '') + '>' + esc(view.actionText) + '</td>' +
                '<td class="ag-state-cell"><div class="' + locClass + '"' + locStyle + locAttrs + '>' + esc(view.locationText) + '</div>' +
                (showAge
                    ? '<div class="ag-state-age" data-state-at="' + seenAt + '" title="' + esc(ageTip) + '">(' + esc(formatStateAge(seenAt)) + ')</div>'
                    : '') +
                '</td>' +
                '</tr>';
        }).join('');
        return '<div class="table-scroll-wrapper"><table class="war-dashboard-table war-dashboard-enemy-table ag-member-table">' +
            '<colgroup>' + (attack ? '<col class="ag-attack-col" style="width:22px">' : '') +
            '<col style="width:32%"><col style="width:12%"><col style="width:14%"><col style="width:18%"><col style="width:24%"></colgroup>' +
            tableHeadHtml(attack) + '<tbody>' + html + '</tbody></table></div>';
    }

    function tierControls(index, mine, order) {
        if (mine) return '<span class="ag-you-pill">Your tier</span>';
        var extras = (order.active || []).filter(function (card) { return !card.mine; });
        var at = -1;
        for (var i = 0; i < extras.length; i++) {
            if (extras[i].index === index) at = i;
        }
        return '<span class="ag-card-actions">' +
            '<button type="button" class="btn" data-ag="up-tier" data-tier="' + index + '"' + (at <= 0 ? ' disabled' : '') + '>Up</button>' +
            '<button type="button" class="btn" data-ag="down-tier" data-tier="' + index + '"' + (at < 0 || at >= extras.length - 1 ? ' disabled' : '') + '>Down</button>' +
            '<button type="button" class="btn" data-ag="hide-tier" data-tier="' + index + '">Hide</button>' +
            '</span>';
    }

    function activePane(index, mine, grouping, c, sideKey, order) {
        var ids = ((sideKey === 'our' ? grouping.our : grouping.targets).tiers[index] || []).slice();
        var pack = sidePack(c, sideKey);
        var bits = statusBits(ids, pack);
        var controls = sideKey === 'our' ? tierControls(index, mine, order) : '';
        var meta = ids.length + (sideKey === 'our' ? ' members' : ' targets') +
            ' · ' + bits.online + ' online · ' + bits.hospital + ' hospital';
        return '<section class="war-dashboard-enemy-panel ag-tier-pane' + (mine ? ' ag-tier-pane-mine' : '') + '">' +
            '<div class="war-dashboard-enemy-panel-toggle ag-tier-head">' +
            '<span class="war-dashboard-enemy-panel-arrow" aria-hidden="true">▼</span>' +
            '<span>Tier ' + (index + 1) + '</span>' +
            controls +
            '<small>' + meta + '</small>' +
            '</div>' +
            '<div class="war-dashboard-enemy-panel-body">' +
            memberTable(ids, pack, sideKey !== 'our') +
            '</div></section>';
    }

    function idlePane(index, grouping, c, sideKey) {
        var ids = (((sideKey === 'our' ? grouping.our : grouping.targets) || {}).tiers || [])[index] || [];
        var pack = sidePack(c, sideKey);
        var bits = statusBits(ids, pack);
        var meta = ids.length + (sideKey === 'our' ? ' members' : ' targets') +
            ' · ' + bits.online + ' online · ' + bits.hospital + ' hospital';
        return '<button type="button" class="war-dashboard-enemy-panel war-dashboard-enemy-panel-toggle ag-tier-idle" data-ag="show-tier" data-tier="' + index + '">' +
            '<span class="war-dashboard-enemy-panel-arrow" aria-hidden="true">▶</span>' +
            '<span>Tier ' + (index + 1) + '</span>' +
            '<small>' + meta + ' · Show</small>' +
            '</button>';
    }

    function rateLimitPerMin() {
        var n = parseInt(localStorage.getItem('tornApiRateLimit') || '90', 10);
        return Number.isFinite(n) && n >= 10 ? n : 90;
    }

    function rapidKeyCalls() {
        var now = Date.now();
        var merged = (window.apiCallTracker || []).slice();
        var byKey = window.apiCallTrackerByKey || {};
        Object.keys(byKey).forEach(function (key) {
            (byKey[key] || []).forEach(function (t) { merged.push(t); });
        });
        var seen = {};
        return merged.filter(function (t) {
            var n = Number(t);
            if (!(now - n < 60000) || seen[n]) return false;
            seen[n] = true;
            return true;
        });
    }

    function rapidReserve() {
        var limit = rateLimitPerMin();
        return Math.max(5, Math.min(20, Math.round(limit * 0.2)));
    }

    function rapidRoom() {
        var now = Date.now();
        var tracker = rapidKeyCalls().sort(function (a, b) { return a - b; });
        var cap = Math.max(1, rateLimitPerMin() - rapidReserve());
        if (tracker.length < cap) return 0;
        var blocking = tracker[tracker.length - cap];
        return Math.max(1000, blocking + 60000 - now + 250);
    }

    function siteCallsLastMinute() {
        var now = Date.now();
        return (window.apiCallTracker || []).filter(function (t) { return now - Number(t) < 60000; }).length;
    }

    function apiUseText() {
        var n = siteCallsLastMinute();
        return n + ' Torn API call' + (n === 1 ? '' : 's') + ' from this site in the last minute';
    }

    function stopApiMeter() {
        if (AG.refreshMeter) clearInterval(AG.refreshMeter);
        AG.refreshMeter = null;
    }

    function updateApiUseLine() {
        var el = document.getElementById('ag-api-use');
        if (!el) return;
        el.textContent = apiUseText();
    }

    function startApiMeter() {
        stopApiMeter();
        if (!AG.open) return;
        AG.refreshMeter = setInterval(function () {
            if (!AG.open || document.hidden) return;
            updateApiUseLine();
        }, 1000);
    }

    function refreshControlHtml() {
        var options = REFRESH_SPEEDS.map(function (sec) {
            var label = sec ? (sec + 's') : 'Off';
            return '<option value="' + sec + '"' + (AG.refreshSec === sec ? ' selected' : '') + '>' + label + '</option>';
        }).join('');
        var wait = AG.refreshHolding ? '' : ' hidden';
        return '<label class="ag-speed">Refresh <select id="ag-refresh-speed" data-ag="refresh-speed" title="How often to refresh war targets. Off does not add calls. The dashboard still refreshes about every 30s.">' +
            options + '</select></label>' +
            '<span class="ag-toolbar-status" id="ag-refresh-wait"' + wait + '>Waiting for a free API call</span>';
    }

    function stopRefreshTimer() {
        if (AG.refreshTimer) clearTimeout(AG.refreshTimer);
        AG.refreshTimer = null;
    }

    function scheduleRefresh(delay) {
        stopRefreshTimer();
        if (!AG.refreshSec || !AG.open || document.hidden) return;
        var wait = typeof delay === 'number' ? delay : AG.refreshSec * 1000;
        AG.refreshTimer = setTimeout(runRefresh, wait);
    }

    function updateRefreshWait() {
        var note = document.getElementById('ag-refresh-wait');
        if (!note) return;
        note.hidden = !AG.refreshHolding;
    }

    function setRefreshSec(sec) {
        var n = parseInt(sec, 10);
        if (REFRESH_SPEEDS.indexOf(n) < 0) n = REFRESH_DEFAULT_SEC;
        AG.refreshSec = n;
        AG.refreshHolding = false;
        try { localStorage.setItem(REFRESH_KEY, String(n)); } catch (e) { /* ignore */ }
        if (n && AG.open) scheduleRefresh(250);
        else stopRefreshTimer();
        updateRefreshWait();
    }

    async function runRefresh() {
        AG.refreshTimer = null;
        if (!AG.refreshSec || !AG.open || document.hidden) return;
        if (AG.refreshBusy) {
            scheduleRefresh();
            return;
        }
        var waitMs = rapidRoom();
        if (waitMs > 0) {
            AG.refreshHolding = true;
            updateRefreshWait();
            scheduleRefresh(waitMs);
            return;
        }
        AG.refreshBusy = true;
        var result = { ok: false };
        try {
            if (AG.host && AG.host.refreshWarTargets) result = await AG.host.refreshWarTargets();
        } catch (e) {
            result = { ok: false, limited: /too many requests|rate limit/i.test((e && e.message) || '') };
        }
        AG.refreshBusy = false;
        if (!AG.refreshSec || !AG.open) return;
        if (result && result.limited) {
            AG.refreshHolding = true;
            updateRefreshWait();
            scheduleRefresh(Math.max(AG.refreshSec * 1000, 5000));
            return;
        }
        AG.refreshHolding = false;
        updateRefreshWait();
        scheduleRefresh();
    }

    function filterBox(key, label, checked) {
        return '<label><input type="checkbox" data-ag="filter" data-key="' + key + '"' + (checked ? ' checked' : '') + '> ' + label + '</label>';
    }

    function publishedLine() {
        if (!AG.published || !AG.published.updatedAt) return '';
        var when = new Date(AG.published.updatedAt);
        if (isNaN(when.getTime())) return '';
        var text = when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        if (AG.published.updatedByName) text += ' · ' + AG.published.updatedByName;
        return text;
    }

    function boardToolbar(c) {
        var f = AG.filters;
        var generals = '';
        if (AG.published && AG.published.generalPlayerIds && AG.published.generalPlayerIds.length) {
            generals = '<span class="ag-toolbar-meta-item">Generals ' + esc(AG.published.generalPlayerIds.map(function (id) {
                return nameOf(c.ourMembers, id);
            }).join(', ')) + '</span>';
        }
        var published = publishedLine();
        var meta = '<div class="ag-toolbar-meta">' + generals +
            (published ? '<span class="ag-toolbar-meta-item">' + esc(published) + '</span>' : '') +
            '<span class="ag-toolbar-meta-item" id="ag-api-use" title="Torn calls this browser recorded in the last 60 seconds. Other websites are not included.">' + esc(apiUseText()) + '</span>' +
            '</div>';
        var settings = showSettingsButton()
            ? '<button type="button" class="btn" data-ag="open-settings">Settings</button>'
            : '';
        var mail = canCopyFactionMail()
            ? '<button type="button" class="btn" data-ag="copy-mail" title="Copy every tier as a table for faction mail">Copy for faction mail</button>'
            : '';
        return '<div class="ag-toolbar">' +
            '<div class="ag-toolbar-actions">' + refreshControlHtml() + groupRefreshButtonHtml() + settings + mail + '</div>' +
            '<div class="ag-toolbar-filters" aria-label="Show players">' +
            filterBox('online', 'Online', f.online) + filterBox('offline', 'Offline', f.offline) + filterBox('idle', 'Idle', f.idle) +
            '<span class="ag-toolbar-split" aria-hidden="true"></span>' +
            filterBox('okay', 'Okay', f.okay) + filterBox('hospital', 'Hospital', f.hospital) + filterBox('abroad', 'Abroad', f.abroad) +
            '</div>' +
            meta +
            '</div>';
    }

    function showSettingsButton() {
        if (AG.viewer) return !!AG.viewer.canEdit;
        return true;
    }

    function settingsButtonHtml() {
        if (!showSettingsButton()) return '';
        return '<div class="ag-board-actions"><button type="button" class="btn" data-ag="open-settings">Settings</button></div>';
    }

    function noGroupingHtml() {
        var wait = groupRefreshWaitSec() > 0 || AG.pulling;
        return '<p class="ag-help">No grouping has been published yet. Leaders, co-leaders, and generals can build it in Settings, ' +
            '<button type="button" class="ag-inline-link" data-ag="refresh-groups"' + (wait ? ' disabled' : '') + '>' +
            esc(groupRefreshLabel(true)) + '</button>.</p>';
    }

    function boardHtml() {
        var c = ctx();
        var grouping = AG.published;
        var settingsBtn = settingsButtonHtml();
        if (!c.factionId) {
            return '<div id="ag-board">' + settingsBtn + '<p class="ag-warn">Load the War Dashboard with your API key first.</p></div>';
        }
        if (!c.warEnemy) {
            return '<div id="ag-board">' + settingsBtn + '<p class="ag-warn">Attack Grouping follows the current ranked war. There is not one on the dashboard yet.</p></div>';
        }
        if (!grouping || !grouping.tierCount) {
            if (AG.pulling) return '<div id="ag-board"><p class="ag-help">Loading grouping…</p></div>';
            return '<div id="ag-board">' + settingsBtn + noGroupingHtml() + '</div>';
        }
        var stale = grouping.warEnemyFactionId && grouping.warEnemyFactionId !== String(c.warEnemy.id);
        var order = cardOrder(grouping, c.playerId, readView(c.factionId, c.playerId));
        var enemyName = c.warEnemy.name || ('Faction ' + c.warEnemy.id);
        var mineNote = order.mine < 0
            ? '<p class="ag-warn">You are not in a tier. Show one below to bring it up. Up and Down change the order on this browser only.</p>'
            : '';
        var rows = '';
        order.active.forEach(function (card) {
            rows += '<div class="ag-tier-row">' +
                activePane(card.index, card.mine, grouping, c, 'our', order) +
                activePane(card.index, card.mine, grouping, c, 'targets', order) +
                '</div>';
        });
        order.idle.forEach(function (index) {
            rows += '<div class="ag-tier-row">' +
                idlePane(index, grouping, c, 'our') +
                idlePane(index, grouping, c, 'targets') +
                '</div>';
        });
        return '<div id="ag-board">' +
            (stale ? '<p class="ag-warn">This published grouping was built for a different enemy. People who are not in the current war are marked in the table.</p>' : '') +
            mineNote +
            boardToolbar(c) +
            '<div class="ag-columns-head">' +
            '<h3>Your faction</h3>' +
            '<h3>' + esc(enemyName) + '</h3>' +
            '</div>' +
            rows +
            '</div>';
    }

    function ensureSettingsShell() {
        var existing = document.getElementById('ag-settings-overlay');
        if (existing) return existing;
        var overlay = document.createElement('div');
        overlay.id = 'ag-settings-overlay';
        overlay.className = 'war-dashboard-settings-overlay ag-settings-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.style.display = 'none';
        overlay.innerHTML =
            '<div class="war-dashboard-settings-modal ag-settings-modal" role="dialog" aria-labelledby="ag-settings-title">' +
            '<div class="war-dashboard-settings-modal-header">' +
            '<h2 id="ag-settings-title">Attack grouping settings</h2>' +
            '<button type="button" class="war-dashboard-settings-close" data-ag="close-settings" aria-label="Close">×</button>' +
            '</div>' +
            '<div id="ag-settings-body" class="war-dashboard-settings-modal-body"></div>' +
            '<div id="ag-settings-footer" class="ag-settings-footer"></div>' +
            '</div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', onClick);
        overlay.addEventListener('change', onChange);
        overlay.addEventListener('input', onInput);
        return overlay;
    }

    function fillSettings() {
        ensureSettingsShell();
        var body = document.getElementById('ag-settings-body');
        var foot = document.getElementById('ag-settings-footer');
        if (!body) return;
        var scroll = body.scrollTop;
        body.innerHTML = settingsBodyHtml();
        if (foot) foot.innerHTML = settingsFooterHtml();
        body.scrollTop = scroll;
    }

    function openSettings() {
        if (!AG.viewer) {
            AG.openAfterLoad = true;
            pullGroups();
            return;
        }
        if (!AG.viewer.canEdit) return;
        ensureDraft();
        AG.settingsOpen = true;
        var overlay = ensureSettingsShell();
        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');
        fillSettings();
    }

    function closeSettings() {
        AG.settingsOpen = false;
        var overlay = document.getElementById('ag-settings-overlay');
        if (!overlay) return;
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
    }

    function renderBoard() {
        var existing = document.getElementById('ag-board');
        if (!existing) {
            render();
            return;
        }
        var wrap = document.createElement('div');
        wrap.innerHTML = boardHtml();
        existing.replaceWith(wrap.firstChild);
    }

    function render() {
        var root = document.getElementById('attack-grouping-root');
        if (!root || !AG.open) return;
        if (!L()) {
            root.innerHTML = '<p class="ag-warn">Attack Grouping failed to load. Refresh the page.</p>';
            return;
        }
        var remote = AG.remoteNewer
            ? '<p class="ag-warn">A newer grouping was published. <button type="button" class="btn" data-ag="take-remote">Load it</button> This drops unsaved edits.</p>'
            : '';
        var err = AG.error ? '<p class="ag-warn">' + esc(AG.error) + '</p>' : '';
        var waiting = AG.pulling && !AG.viewer ? '<p class="ag-help">Loading grouping…</p>' : '';
        var focus = document.activeElement;
        var settingsEl = document.getElementById('ag-settings-overlay');
        var focusId = '';
        if (focus && focus.id && ((root.contains(focus)) || (settingsEl && settingsEl.contains(focus)))) {
            focusId = focus.id;
        }
        root.innerHTML = err + remote + waiting + boardHtml();
        if (AG.settingsOpen) fillSettings();
        if (focusId) {
            var again = document.getElementById(focusId);
            if (again) again.focus();
        }
        updateButtonSummary();
        ensureSpies();
    }

    function onClick(e) {
        if (e.target && e.target.id === 'ag-settings-overlay') {
            closeSettings();
            return;
        }
        var btn = e.target.closest ? e.target.closest('[data-ag]') : null;
        if (!btn) return;
        var act = btn.getAttribute('data-ag');
        if (act === 'sort') {
            var column = btn.getAttribute('data-column') || 'level';
            if (AG.sortBy === column) AG.sortDir = AG.sortDir === 'asc' ? 'desc' : 'asc';
            else {
                AG.sortBy = column;
                AG.sortDir = (column === 'member' || column === 'status' || column === 'location') ? 'asc' : 'desc';
            }
            renderBoard();
            return;
        }
        if (act === 'open-settings') {
            openSettings();
            return;
        }
        if (act === 'refresh-groups') {
            if (groupRefreshWaitSec() > 0 || AG.pulling) return;
            pullGroups();
            return;
        }
        if (act === 'copy-mail') {
            if (!canCopyFactionMail()) return;
            copyFactionMail(btn);
            return;
        }
        if (act === 'stat-tip') {
            e.preventDefault();
            var open = document.getElementById('ag-stat-popover');
            var same = open && !open.hidden && open.getAttribute('data-pin') === '1' && open.getAttribute('data-for') === btn.getAttribute('data-id');
            if (same) hideStatTip();
            else {
                showStatTip(btn, true);
                if (open || document.getElementById('ag-stat-popover')) {
                    document.getElementById('ag-stat-popover').setAttribute('data-for', btn.getAttribute('data-id'));
                }
            }
            return;
        }
        if (act === 'close-settings') {
            closeSettings();
            return;
        }
        if (act === 'tier-dec') setTierCount((AG.draft ? AG.draft.tierCount : 5) - 1);
        else if (act === 'tier-inc') setTierCount((AG.draft ? AG.draft.tierCount : 5) + 1);
        else if (act === 'rebuild') {
            ensureDraft();
            buildSide(btn.getAttribute('data-side'));
            render();
        } else if (act === 'save') saveGrouping();
        else if (act === 'save-generals') saveGenerals();
        else if (act === 'take-remote' && AG.remoteNewer) {
            AG.draftDirty = false;
            AG.generalsDirty = false;
            applyServerGrouping(AG.remoteNewer, false);
            AG.remoteNewer = null;
            render();
        } else if (act === 'show-tier') {
            var showIdx = Number(btn.getAttribute('data-tier'));
            mutateView(function (view) {
                view.activeExtra = (view.activeExtra || []).filter(function (n) { return n !== showIdx; });
                view.activeExtra.push(showIdx);
            });
        } else if (act === 'hide-tier') {
            var hideIdx = Number(btn.getAttribute('data-tier'));
            mutateView(function (view) {
                view.activeExtra = (view.activeExtra || []).filter(function (n) { return n !== hideIdx; });
            });
        } else if (act === 'up-tier' || act === 'down-tier') {
            var idx = Number(btn.getAttribute('data-tier'));
            var dir = act === 'up-tier' ? -1 : 1;
            mutateView(function (view) {
                var list = (view.activeExtra || []).slice();
                var at = list.indexOf(idx);
                var swap = at + dir;
                if (at < 0 || swap < 0 || swap >= list.length) return;
                var tmp = list[at];
                list[at] = list[swap];
                list[swap] = tmp;
                view.activeExtra = list;
            });
        }
    }

    function onChange(e) {
        var el = e.target;
        if (!el || !el.getAttribute) return;
        var act = el.getAttribute('data-ag');
        if (act === 'refresh-speed') {
            setRefreshSec(el.value);
            return;
        }
        if (act === 'filter') {
            var key = el.getAttribute('data-key');
            if (key && Object.prototype.hasOwnProperty.call(AG.filters, key)) {
                AG.filters[key] = !!el.checked;
                try { localStorage.setItem(FILTER_KEY, JSON.stringify(AG.filters)); } catch (e) { /* ignore */ }
                renderBoard();
            }
            return;
        }
        if (!AG.draft && act !== 'general') return;
        if (act === 'method') {
            var sideKey = el.getAttribute('data-side');
            var side = AG.draft[sideKey];
            side.method = L().normalizeMethod(el.value);
            if (side.method !== 'manual') buildSide(sideKey);
            else AG.draftDirty = true;
            render();
        } else if (act === 'range') {
            var rangeKey = el.getAttribute('data-side');
            var tier = Number(el.getAttribute('data-tier'));
            var bound = el.getAttribute('data-bound');
            var parsed = L().parseStatInput(el.value);
            if (String(el.value || '').trim() && parsed == null) {
                AG.error = 'Could not read that stat. Try 500m or 2b.';
                render();
                return;
            }
            AG.error = '';
            var range = AG.draft[rangeKey].ranges[tier] || { min: null, max: null };
            range[bound] = parsed;
            AG.draft[rangeKey].ranges[tier] = range;
            AG.draft[rangeKey].method = 'statRange';
            buildSide(rangeKey);
            render();
        } else if (act === 'move') {
            movePerson(el.getAttribute('data-side'), el.getAttribute('data-id'), Number(el.value));
        } else if (act === 'general') {
            var id = String(el.getAttribute('data-id'));
            var has = AG.generalDraft.indexOf(id);
            if (el.checked && has < 0) AG.generalDraft.push(id);
            if (!el.checked && has >= 0) AG.generalDraft.splice(has, 1);
            AG.generalsDirty = true;
            var names = document.getElementById('ag-general-names');
            if (names) names.innerHTML = generalNamesHtml();
            var foot = document.getElementById('ag-settings-footer');
            if (foot) foot.innerHTML = settingsFooterHtml();
        }
    }

    function onInput(e) {
        var el = e.target;
        if (!el || el.getAttribute('data-ag') !== 'general-filter') return;
        AG.generalFilter = el.value;
        var list = document.getElementById('ag-general-list');
        if (!list) return;
        var saved = generalsHtml();
        var wrap = document.createElement('div');
        wrap.innerHTML = saved;
        var next = wrap.querySelector('#ag-general-list');
        if (next) list.innerHTML = next.innerHTML;
    }

    function onDragStart(e) {
        if (e.target.closest && e.target.closest('select, input, button')) return;
        var person = e.target.closest ? e.target.closest('.ag-person') : null;
        if (!person || person.getAttribute('draggable') !== 'true') return;
        e.dataTransfer.setData('text/plain', person.getAttribute('data-side') + ':' + person.getAttribute('data-id'));
        e.dataTransfer.effectAllowed = 'move';
    }

    function onDragOver(e) {
        var col = e.target.closest ? e.target.closest('.ag-col-drop') : null;
        if (!col) return;
        e.preventDefault();
    }

    function onDrop(e) {
        var col = e.target.closest ? e.target.closest('.ag-col-drop') : null;
        if (!col) return;
        e.preventDefault();
        var raw = e.dataTransfer.getData('text/plain') || '';
        var parts = raw.split(':');
        if (parts.length < 2 || parts[0] !== col.getAttribute('data-side')) return;
        movePerson(parts[0], parts[1], Number(col.getAttribute('data-tier')));
    }

    function isAttackGroupingRoute() {
        var parts = (window.location.hash || '').replace(/^#/, '').split('/').filter(Boolean);
        return parts[0] === 'war-dashboard' && parts[1] === 'attack-grouping';
    }

    function syncRoute() {
        var section = document.getElementById('war-dashboard-attack-grouping');
        var container = document.getElementById('war-dashboard-tool-container');
        if (!section || !container || !AG.host) return;
        var route = isAttackGroupingRoute();
        if (route && window.vipLevelKnown === true && !AG.host.hasVip3()) {
            AG.host.openVipInfo();
            if (window.location.hash !== '#war-dashboard') window.location.hash = 'war-dashboard';
            return;
        }
        var opening = route && !AG.open;
        container.classList.toggle('war-dashboard-tool-container--grouping', route);
        section.hidden = !route;
        AG.open = route;
        if (!route) {
            closeSettings();
            stopRefreshTimer();
            stopApiMeter();
        }
        updateButtonSummary();
        if (!route) return;
        if (AG.refreshSec && !AG.refreshTimer) scheduleRefresh(250);
        startApiMeter();
        if (opening) window.scrollTo(0, 0);
        if (!opening) return;
        var c = ctx();
        var pack = readPack(c.factionId);
        if (pack) {
            if (pack.viewer) AG.viewer = pack.viewer;
            if (pack.checkedAt) AG.lastGroupCheckAt = pack.checkedAt;
            if (pack.grouping && !AG.published) applyServerGrouping(pack.grouping, false);
        }
        ensureDraft();
        render();
        if (typeof AG.host.ensureBattleStats === 'function') {
            AG.host.ensureBattleStats().then(function () { if (AG.open) renderBoard(); }).catch(function () {});
        }
        ensureGroupsForToday();
    }

    function wire() {
        if (AG.wired) return;
        var section = document.getElementById('war-dashboard-attack-grouping');
        var btn = document.getElementById('war-dashboard-attack-grouping-command');
        if (!section || !btn) return;
        AG.wired = true;
        try {
            var savedRaw = localStorage.getItem(REFRESH_KEY);
            var savedSpeed = savedRaw == null ? NaN : parseInt(savedRaw, 10);
            if (REFRESH_SPEEDS.indexOf(savedSpeed) < 0) {
                savedSpeed = localStorage.getItem('war_dashboard_attack_grouping_rapid_v1') === '1' ? 1 : REFRESH_DEFAULT_SEC;
            }
            AG.refreshSec = savedSpeed;
        } catch (e) { AG.refreshSec = REFRESH_DEFAULT_SEC; }
        try {
            var savedFilters = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null');
            if (savedFilters && typeof savedFilters === 'object') {
                Object.keys(AG.filters).forEach(function (key) {
                    if (typeof savedFilters[key] === 'boolean') AG.filters[key] = savedFilters[key];
                });
            }
        } catch (e2) { /* ignore */ }
        ensureSettingsShell();
        btn.addEventListener('click', function (e) {
            if (!AG.host || !AG.host.hasVip3()) {
                e.preventDefault();
                if (AG.host) AG.host.openVipInfo();
            }
        });
        section.addEventListener('click', onClick);
        section.addEventListener('change', onChange);
        section.addEventListener('input', onInput);
        section.addEventListener('dragstart', onDragStart);
        section.addEventListener('dragover', onDragOver);
        section.addEventListener('drop', onDrop);
        section.addEventListener('mouseover', function (e) {
            var hit = e.target.closest ? e.target.closest('[data-ag="stat-tip"]') : null;
            if (!hit) return;
            var tip = document.getElementById('ag-stat-popover');
            if (tip && tip.getAttribute('data-pin') === '1') return;
            showStatTip(hit, false);
        });
        section.addEventListener('mouseout', function (e) {
            var hit = e.target.closest ? e.target.closest('[data-ag="stat-tip"]') : null;
            if (!hit) return;
            var tip = document.getElementById('ag-stat-popover');
            if (tip && tip.getAttribute('data-pin') === '1') return;
            hideStatTip();
        });
        document.addEventListener('click', function (e) {
            if (e.target.closest && e.target.closest('[data-ag="stat-tip"], #ag-stat-popover')) return;
            hideStatTip();
        });
        window.addEventListener('tornToolsVipChanged', function () {
            updateButtonSummary();
            if (AG.open && AG.host && AG.host.hasVip3() && !AG.viewer) ensureGroupsForToday();
            syncRoute();
        });
        window.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                hideStatTip();
                if (AG.settingsOpen) closeSettings();
            }
        });
        setInterval(tickStateAges, 1000);
        document.addEventListener('visibilitychange', function () {
            if (!AG.refreshSec) return;
            if (document.hidden) stopRefreshTimer();
            else if (AG.open) scheduleRefresh(250);
        });
    }

    window.attackGroupingNotifyTargets = function () {
        if (!AG.open) return;
        renderBoard();
    };

    window.attackGroupingNotifyDashboardData = function () {
        if (!AG.open) return;
        var c = ctx();
        var pack = c.factionId ? readPack(c.factionId) : null;
        if (pack && pack.grouping && !AG.published) applyServerGrouping(pack.grouping, false);
        renderBoard();
        ensureGroupsForToday();
    };

    window.syncWarDashboardRoute = syncRoute;

    window.mountAttackGrouping = function (host) {
        AG.host = host;
        wire();
        syncRoute();
    };
})();
