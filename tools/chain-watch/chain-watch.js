/**
 * Standalone Chain Watch page — schedule signups (not War Dashboard).
 */
(function () {
    'use strict';

    const CHAIN_WATCH_MAX_HOUR_SLOTS = 50 * 24;
    const CHAIN_WATCH_POLL_MS = 5 * 60 * 1000;
    const CHAIN_WATCH_CACHE_PREFIX = 'chain_watch_page_v2_';

    let factionId = null;
    let chainWatchPayload = null;
    let chainWatchLastFetchMs = 0;
    let chainWatchLastError = '';
    /** When set, UI shows a frozen archived schedule (read-only). */
    let viewingArchiveId = null;
    /** Latest archive list from chainWatchGet (kept while viewing an archive). */
    let lastArchivesList = [];

    function getApiKey() {
        return (localStorage.getItem('tornApiKey') || '').trim();
    }

    function getChainWatchFunctions() {
        try {
            if (typeof firebase !== 'undefined' && firebase.functions) return firebase.functions();
        } catch (e) { /* ignore */ }
        return null;
    }

    function escapeHtml(s) {
        if (s == null) return '';
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    const CHAIN_WATCH_TIP_REWARD =
        'Each hour you sign up for can earn a payout. A player\'s <strong>first</strong> signup on this schedule pays the first amount; every <strong>later</strong> signup by the same player pays the each-after amount. Totals follow signup time — open <strong>Rewards owed</strong> to see balances. Verified no-shows may be excluded when activity tracking shows no online time that hour.';

    const CHAIN_WATCH_TIP_SIGNUP =
        '<strong>Sign up</strong> reserves an empty watcher cell before that TCT hour starts (started hours are greyed out and closed). Use <strong>×</strong> to leave while the hour is still running. If every column in that hour is taken, pick another hour or ask an organiser to add a backup column.';

    const CHAIN_WATCH_TIP_SIGNUP_LIMIT =
        'The most <strong>active</strong> watch slots you can hold at once (rolling 24 hours from signup time). Leaving a slot with <strong>×</strong> frees that spot so you can sign up for another hour. Finished hours no longer count toward this limit.';

    function chainWatchHelpIconHtml(tooltipHtml) {
        return (
            '<span class="chain-watch-help" role="button" tabindex="0" aria-label="Help">' +
            '<span class="chain-watch-help-icon" aria-hidden="true">ⓘ</span>' +
            '<span class="chain-watch-help-tooltip">' +
            tooltipHtml +
            '</span></span>'
        );
    }

    function chainWatchDtWithHelp(label, tooltipHtml) {
        return (
            '<dt class="chain-watch-settings-dt-with-help">' +
            escapeHtml(label) +
            ' ' +
            chainWatchHelpIconHtml(tooltipHtml) +
            '</dt>'
        );
    }

    function chainWatchLabelWithHelp(forId, label, tooltipHtml) {
        return (
            '<label for="' +
            escapeHtml(forId) +
            '">' +
            escapeHtml(label) +
            ' ' +
            chainWatchHelpIconHtml(tooltipHtml) +
            '</label>'
        );
    }

    const CHAIN_WATCH_RULES_HIDE_UNTIL_KEY = 'chain_watch_rules_hidden_until';

    function isChainWatchRulesWarningHidden() {
        try {
            const until = Number(localStorage.getItem(CHAIN_WATCH_RULES_HIDE_UNTIL_KEY));
            return Number.isFinite(until) && Date.now() < until;
        } catch (e) {
            return false;
        }
    }

    function hideChainWatchRulesWarningForWeek() {
        try {
            localStorage.setItem(
                CHAIN_WATCH_RULES_HIDE_UNTIL_KEY,
                String(Date.now() + 7 * 24 * 60 * 60 * 1000)
            );
        } catch (e) { /* ignore */ }
    }

    function chainWatchRulesWarningHtml() {
        if (isChainWatchRulesWarningHidden()) return '';
        return (
            '<div class="chain-watch-rules-warning" role="note" aria-label="Rules for chain watching">' +
            '<div class="chain-watch-rules-warning-head">' +
            '<p class="chain-watch-rules-warning-title">Rules for Chain Watching:</p>' +
            '<button type="button" class="chain-watch-rules-warning-hide" id="chain-watch-rules-hide" title="Hide these rules for 1 week">Hide for 1 week</button>' +
            '</div>' +
            '<ul class="chain-watch-rules-warning-list">' +
            '<li>Show up and be online for the whole time you sign up for</li>' +
            '<li>Make a hit if the timer drops below 1 minute to save the chain.</li>' +
            '<li>Check if the next Chain Watchers are around, before you leave your post — if they aren\'t, ask for a replacement.</li>' +
            '<li>If the Chain dies while you are on watch without organiser permission, you will receive no Chain watching rewards.</li>' +
            '</ul></div>'
        );
    }

    function wireChainWatchRulesDismiss(root) {
        const scope = root && root.querySelector ? root : document;
        const btn = scope.querySelector('#chain-watch-rules-hide');
        if (!btn || btn.dataset.cwRulesHideWired) return;
        btn.dataset.cwRulesHideWired = '1';
        btn.addEventListener('click', function () {
            hideChainWatchRulesWarningForWeek();
            const box = btn.closest('.chain-watch-rules-warning');
            if (box) box.remove();
        });
    }

    function wireChainWatchHelpIcons(root) {
        const scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll('.chain-watch-help:not([data-cw-help-wired])').forEach(function (el) {
            el.dataset.cwHelpWired = '1';
            el.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                const open = el.classList.contains('is-visible');
                document.querySelectorAll('.chain-watch-help.is-visible').forEach(function (other) {
                    if (other !== el) other.classList.remove('is-visible');
                });
                el.classList.toggle('is-visible', !open);
            });
        });
    }

    /** Attendance needs War Dashboard activity tracker; standalone page skips heavy samples. */
    function evaluateWatcherSlotAttendance() {
        return { phase: 'unknown', sampleCount: 0, onlineHits: 0, presentOnce: false, onlineMinutesApprox: 0, verdict: 'no_data' };
    }

    function ensureActivityDataLoaded() {
        return Promise.resolve();
    }

    function chainWatchAttendanceInlineHtml(factionIdArg, w, slotStartSec, slotEndSec) {
        if (!factionIdArg || !w) return '';
        return '';
    }

    function chainWatchHtmlWatcherAttendance() {
        return '';
    }

    function collectChainWatchAttendanceIssues() {
        return { noShows: [], unverified: [] };
    }

    const CHAIN_AT_ZERO_THROTTLE_MS = 60 * 1000;
    const OUR_CHAIN_PLACEHOLDER = { current: 0, max: 0, timeout: 0, cooldown: 0, modifier: 0 };
    /** Same keys as War Dashboard so chain tracking / refresh interval stay in sync. */
    const WD_STORAGE = {
        chainRefreshInterval: 'war_dashboard_chain_refresh_interval',
        trackOurChain: 'war_dashboard_track_our_chain',
    };

    let lastOurChain = null;
    let ourChainDisplay = { timeout: 0, cooldown: 0 };
    let lastOurChainFetchTime = 0;
    let chainTickIntervalId = null;
    let chainRefreshTimer = null;

    function isOnChainWatchPage() {
        return (location.hash || '').replace('#', '').split('/')[0] === 'chain-watch';
    }

    function getTrackOurChain() {
        const v = localStorage.getItem(WD_STORAGE.trackOurChain);
        return v === null || v === 'true';
    }

    function setTrackOurChain(on) {
        try {
            localStorage.setItem(WD_STORAGE.trackOurChain, on ? 'true' : 'false');
        } catch (e) { /* ignore */ }
    }

    /** Match War Dashboard: direct Torn API on production; /.torn-api-proxy on localhost only (app.js). */
    function tornApiFetchUrl(url) {
        if (typeof window.getTornApiFetchUrl === 'function') {
            return window.getTornApiFetchUrl(url);
        }
        return url;
    }

    async function fetchJson(url) {
        const res = await fetch(tornApiFetchUrl(url));
        const data = await res.json();
        if (data.error) throw new Error(String(data.error));
        return data;
    }

    async function fetchFactionChain(apiKey, fid) {
        if (!fid) return null;
        const data = await fetchJson(
            'https://api.torn.com/faction/' + encodeURIComponent(String(fid)) + '?selections=chain&key=' + encodeURIComponent(apiKey)
        );
        const chain = data.chain;
        if (!chain || typeof chain !== 'object') return null;
        return {
            current: chain.current != null ? Number(chain.current) : 0,
            max: chain.max != null ? Number(chain.max) : 0,
            timeout: Math.max(0, Number(chain.timeout) || 0),
            cooldown: Math.max(0, Number(chain.cooldown) || 0),
            modifier: chain.modifier != null ? Number(chain.modifier) : 0,
            start: chain.start,
            end: chain.end,
        };
    }

    function isChainAtZero(chain) {
        return chain && Number(chain.timeout || 0) === 0 && Number(chain.cooldown || 0) === 0;
    }

    function formatMinutesSeconds(sec) {
        const s = Math.max(0, Math.floor(sec));
        const m = Math.floor(s / 60);
        const remainder = s % 60;
        return m + 'm ' + remainder + 's';
    }

    function getChainRefreshIntervalSec() {
        const fromDom = document.getElementById('war-dashboard-chain-refresh-interval');
        const stored = localStorage.getItem(WD_STORAGE.chainRefreshInterval);
        const raw = fromDom && fromDom.value !== '' ? fromDom.value : stored;
        const n = parseInt(raw || '30', 10);
        return Math.max(10, Math.min(300, isNaN(n) ? 30 : n));
    }

    function syncChainWatchFromPage() {
        const apiKey = getApiKey();
        if (!apiKey || !factionId || !lastOurChain) return;
        const fn = getChainWatchFunctions();
        if (!fn) return;
        fn.httpsCallable('chainWatchSyncChain')({
            apiKey: apiKey,
            factionId: String(factionId),
            current: lastOurChain.current != null ? Number(lastOurChain.current) : 0,
            cooldown: lastOurChain.cooldown != null ? Number(lastOurChain.cooldown) : 0,
        }).catch(function () {});
    }

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
            const att = factionId ? chainWatchAttendanceInlineHtml(factionId, w, slotStartSec, slotEndSec) : '';
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

    function renderChainWatchOurChainBox() {
        const boxEl = document.getElementById('chain-watch-our-chain-box');
        if (!boxEl || !factionId) {
            if (boxEl) {
                boxEl.style.display = 'none';
                boxEl.setAttribute('aria-hidden', 'true');
                boxEl.innerHTML = '';
            }
            return;
        }
        const watchRosterHtml = getOurChainWatchRosterHtml();
        if (!getTrackOurChain()) {
            boxEl.className = 'war-dashboard-chain-box chain-watch-our-chain-box war-dashboard-chain-box-off';
            boxEl.setAttribute('aria-hidden', 'false');
            boxEl.style.display = 'block';
            boxEl.innerHTML =
                '<label class="war-dashboard-chain-track-wrap" title="Tracking off: click to turn on (same toggle as War Dashboard).">' +
                '<input type="checkbox" class="war-dashboard-chain-track-input" data-chain-key="our" aria-label="Track this chain" />' +
                '<span class="war-dashboard-chain-track-slider"></span></label>' +
                '<div class="war-dashboard-chain-title">Our Chain</div>' +
                watchRosterHtml +
                '<div class="war-dashboard-chain-off-message">Tracking off</div>';
            wireChainWatchOurChainTrackToggle(boxEl);
            return;
        }
        const chain = lastOurChain || OUR_CHAIN_PLACEHOLDER;
        const display = lastOurChain ? ourChainDisplay : { timeout: 0, cooldown: 0 };
        const timeout = display.timeout != null ? Math.max(0, display.timeout) : 0;
        const cooldown = display.cooldown != null ? Math.max(0, display.cooldown) : 0;
        const current = chain.current != null ? chain.current : 0;
        const max = chain.max != null ? chain.max : 0;
        const modifier = chain.modifier != null ? chain.modifier : 0;
        const isActive = timeout > 0;
        const timerLabel = timeout > 0 ? 'Timeout' : cooldown > 0 ? 'Cooldown' : null;
        const timerText = timerLabel ? timerLabel + ': ' + formatMinutesSeconds(timeout > 0 ? timeout : cooldown) : '—';
        const isUrgent = (timeout > 0 && timeout < 60) || (timeout === 0 && cooldown > 0 && cooldown < 60);
        boxEl.className =
            'war-dashboard-chain-box chain-watch-our-chain-box' +
            (isActive ? ' war-dashboard-chain-box-active' : '') +
            (isUrgent ? ' war-dashboard-chain-box-urgent' : '');
        boxEl.setAttribute('aria-hidden', 'false');
        boxEl.style.display = 'block';
        boxEl.innerHTML =
            '<label class="war-dashboard-chain-track-wrap" title="Tracking on: click to turn off (same toggle as War Dashboard).">' +
            '<input type="checkbox" class="war-dashboard-chain-track-input" data-chain-key="our" checked aria-label="Track this chain" />' +
            '<span class="war-dashboard-chain-track-slider"></span></label>' +
            '<div class="war-dashboard-chain-title">Our Chain</div>' +
            '<div class="war-dashboard-chain-current">' +
            escapeHtml(String(current)) +
            '</div>' +
            '<div class="war-dashboard-chain-timer">' +
            escapeHtml(timerText) +
            '</div>' +
            '<div class="war-dashboard-chain-meta">' +
            '<span class="war-dashboard-chain-modifier">Modifier: ' +
            escapeHtml(String(modifier)) +
            '</span>' +
            '<span class="war-dashboard-chain-max">Next: ' +
            escapeHtml(String(max)) +
            '</span>' +
            '</div>' +
            watchRosterHtml;
        wireChainWatchOurChainTrackToggle(boxEl);
    }

    function wireChainWatchOurChainTrackToggle(boxEl) {
        const input = boxEl && boxEl.querySelector('.war-dashboard-chain-track-input');
        if (!input || input.dataset.cwChainTrackWired) return;
        input.dataset.cwChainTrackWired = '1';
        input.addEventListener('change', function () {
            setTrackOurChain(input.checked);
            renderChainWatchOurChainBox();
            if (input.checked) {
                void refreshOurFactionChain();
            }
        });
    }

    function updateChainWatchChainDisplays() {
        if (!getTrackOurChain() || !lastOurChain) return;
        if (ourChainDisplay.timeout > 0) ourChainDisplay.timeout--;
        else if (ourChainDisplay.cooldown > 0) ourChainDisplay.cooldown--;
    }

    function scheduleNextChainWatchChainRefresh() {
        if (chainRefreshTimer) clearTimeout(chainRefreshTimer);
        chainRefreshTimer = null;
        if (!isOnChainWatchPage()) return;
        const sec = getChainRefreshIntervalSec();
        chainRefreshTimer = setTimeout(function () {
            chainRefreshTimer = null;
            void refreshOurFactionChain();
        }, sec * 1000);
    }

    async function refreshOurFactionChain() {
        if (!isOnChainWatchPage()) return;
        const apiKey = getApiKey();
        if (!apiKey || !factionId) {
            renderChainWatchOurChainBox();
            return;
        }
        if (!getTrackOurChain()) {
            renderChainWatchOurChainBox();
            scheduleNextChainWatchChainRefresh();
            return;
        }
        const now = Date.now();
        if (
            isChainAtZero(lastOurChain) &&
            lastOurChainFetchTime &&
            now - lastOurChainFetchTime < CHAIN_AT_ZERO_THROTTLE_MS
        ) {
            renderChainWatchOurChainBox();
            scheduleNextChainWatchChainRefresh();
            return;
        }
        try {
            const data = await fetchFactionChain(apiKey, factionId);
            if (data) {
                lastOurChain = data;
                lastOurChainFetchTime = Date.now();
                ourChainDisplay = { timeout: data.timeout, cooldown: data.cooldown };
                syncChainWatchFromPage();
            }
        } catch (e) {
            console.warn('Chain watch: faction chain refresh failed', e);
        }
        renderChainWatchOurChainBox();
        scheduleNextChainWatchChainRefresh();
    }

    function startChainWatchChainTick() {
        if (chainTickIntervalId) return;
        chainTickIntervalId = setInterval(function () {
            if (!isOnChainWatchPage()) {
                stopChainWatchChainTick();
                return;
            }
            updateChainWatchChainDisplays();
            renderChainWatchOurChainBox();
        }, 1000);
        renderChainWatchOurChainBox();
    }

    function stopChainWatchChainTick() {
        if (chainTickIntervalId) {
            clearInterval(chainTickIntervalId);
            chainTickIntervalId = null;
        }
        if (chainRefreshTimer) {
            clearTimeout(chainRefreshTimer);
            chainRefreshTimer = null;
        }
    }

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

    function countSignupsInSlots(slots) {
        let n = 0;
        Object.keys(slots || {}).forEach(function (key) {
            n += (slots[key] || []).length;
        });
        return n;
    }

    function chainWatchCanRestoreSchedule(p) {
        const v = (p && p.viewer) || {};
        const pid = v.playerId != null ? String(v.playerId) : '';
        if (v.isOwner === true || v.canManageOrganizers === true) return true;
        const org = Array.isArray(p && p.organizerPlayerIds) ? p.organizerPlayerIds.map(String) : [];
        return pid && org.indexOf(pid) >= 0;
    }

    function formatArchiveSummaryLabel(a) {
        const name = a && a.chainName ? String(a.chainName).trim() : '';
        const label = name || 'Chain watch';
        const when =
            a && a.archivedAt != null
                ? new Date(a.archivedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
                : '';
        const hit =
            a && a.brokeAtHit != null && a.brokeAtHit > 0
                ? String(a.brokeAtHit)
                : a && a.lastCurrent != null
                  ? String(a.lastCurrent)
                  : '?';
        const target = a && a.chainTarget != null ? String(a.chainTarget) : '?';
        return label + (when ? ' · ' + when : '') + ' · ' + hit + ' / ' + target + ' hits';
    }

    function renderArchivesModalHtml(archives, viewingId, canRestore) {
        const list = Array.isArray(archives) ? archives : [];
        let h =
            '<p class="chain-watch-archives-intro">Finished schedules stay here so organisers can review signups and rewards. Archive the current chain when it is over to start a new one.</p>';
        if (canRestore) {
            h +=
                '<p style="margin:0 0 10px 0;color:#b0b0b0;font-size:12px;line-height:1.45;">If signups were lost on the active schedule, open an archive that still lists names and use <strong>Restore</strong> (owner/organiser only).</p>';
        }
        if (!list.length) {
            h += '<p style="margin:0;color:#888;font-size:12px;">No archived chain watches yet.</p>';
        } else {
            h += '<ul class="chain-watch-archives-list">';
            list.forEach(function (a) {
                const id = a.archiveId != null ? String(a.archiveId) : '';
                const active = viewingId && id === String(viewingId);
                h += '<li class="chain-watch-archives-list-item">';
                h +=
                    '<button type="button" class="btn chain-watch-view-archive" data-archive-id="' +
                    escapeHtml(id) +
                    '"' +
                    (active ? ' disabled' : '') +
                    '>' +
                    escapeHtml(formatArchiveSummaryLabel(a)) +
                    (active ? ' (viewing)' : '') +
                    '</button>';
                if (canRestore && id) {
                    h +=
                        ' <button type="button" class="btn chain-watch-restore-archive" data-archive-id="' +
                        escapeHtml(id) +
                        '">Restore</button>';
                }
                h += '</li>';
            });
            h += '</ul>';
        }
        return h;
    }

    async function restoreArchivedChainWatch(archiveId) {
        const apiKey = getApiKey();
        const fn = getChainWatchFunctions();
        if (!apiKey || !fn || !factionId || !archiveId) return;
        if (
            !confirm(
                'Restore this archived chain watch to the active schedule? This replaces the current active signups and settings with the archived copy.'
            )
        ) {
            return;
        }
        const root = document.getElementById('chain-watch-root');
        if (root) root.innerHTML = '<p style="color:#888;">Restoring signups…</p>';
        try {
            const res = await fn.httpsCallable('chainWatchRestoreFromArchive')({
                apiKey: apiKey,
                factionId: String(factionId),
                archiveId: String(archiveId),
            });
            viewingArchiveId = null;
            await fetchChainWatchData(true);
            await renderChainWatchPage();
            const n = res && res.data && res.data.restoredSignupCount != null ? res.data.restoredSignupCount : 0;
            alert('Restored ' + n + ' signup' + (n === 1 ? '' : 's') + ' to the active chain watch.');
        } catch (e) {
            if (root) {
                root.innerHTML =
                    '<p style="color:#f44336;font-size:14px;line-height:1.45;">' +
                    escapeHtml(chainWatchErrorText(e)) +
                    '</p>';
            } else {
                alert(chainWatchErrorText(e));
            }
        }
    }

    async function openArchivedChainWatch(archiveId) {
        const apiKey = getApiKey();
        const fn = getChainWatchFunctions();
        if (!apiKey || !fn || !factionId || !archiveId) return;
        const root = document.getElementById('chain-watch-root');
        if (root) root.innerHTML = '<p style="color:#888;">Loading past chain watch…</p>';
        try {
            const res = await fn.httpsCallable('chainWatchGetArchive')({
                apiKey: apiKey,
                factionId: String(factionId),
                archiveId: String(archiveId),
            });
            viewingArchiveId = String(archiveId);
            chainWatchPayload = res.data;
            updateChainWatchPageChrome();
            await renderChainWatchPage();
        } catch (e) {
            viewingArchiveId = null;
            if (root) {
                root.innerHTML =
                    '<p style="color:#f44336;font-size:14px;line-height:1.45;">' +
                    escapeHtml(chainWatchErrorText(e)) +
                    '</p>';
            }
        }
    }

    async function returnToActiveChainWatch() {
        viewingArchiveId = null;
        await refreshChainWatchPage();
    }

    async function archiveActiveChainWatch() {
        const apiKey = getApiKey();
        const fn = getChainWatchFunctions();
        if (!apiKey || !fn || !factionId) return;
        if (
            !confirm(
                'Archive this chain watch? The schedule moves to Past chain watches (rewards and signups stay readable). You can then start a new chain watch for your faction.'
            )
        ) {
            return;
        }
        const msg = document.getElementById('chain-watch-archive-msg');
        const btn = document.getElementById('chain-watch-archive-btn');
        if (btn) btn.disabled = true;
        if (msg) msg.textContent = 'Archiving…';
        try {
            await fn.httpsCallable('chainWatchArchive')({
                apiKey: apiKey,
                factionId: String(factionId),
            });
            viewingArchiveId = null;
            await fetchChainWatchData(true);
            await renderChainWatchPage();
            if (msg) msg.textContent = 'Archived. Set up a new schedule below or use Add new chain watch on War Dashboard.';
        } catch (e) {
            if (msg) msg.textContent = chainWatchErrorText(e);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function wireChainWatchArchiveUi() {
        const backBtn = document.getElementById('chain-watch-back-active');
        if (backBtn && !backBtn.dataset.cwWired) {
            backBtn.dataset.cwWired = '1';
            backBtn.addEventListener('click', function () {
                closeChainWatchModal('chain-watch-archives-modal');
                void returnToActiveChainWatch();
            });
        }
        const archiveBtn = document.getElementById('chain-watch-archive-btn');
        if (archiveBtn && !archiveBtn.dataset.cwWired) {
            archiveBtn.dataset.cwWired = '1';
            archiveBtn.addEventListener('click', function () {
                void archiveActiveChainWatch();
            });
        }
        const archivesBody = document.getElementById('chain-watch-archives-body');
        if (archivesBody && !archivesBody.dataset.cwWired) {
            archivesBody.dataset.cwWired = '1';
            archivesBody.addEventListener('click', function (e) {
                const restoreBtn = e.target.closest('.chain-watch-restore-archive');
                if (restoreBtn) {
                    const aid = restoreBtn.getAttribute('data-archive-id');
                    if (!aid) return;
                    closeChainWatchModal('chain-watch-archives-modal');
                    void restoreArchivedChainWatch(aid);
                    return;
                }
                const btn = e.target.closest('.chain-watch-view-archive');
                if (!btn || btn.disabled) return;
                const aid = btn.getAttribute('data-archive-id');
                if (!aid) return;
                closeChainWatchModal('chain-watch-archives-modal');
                void openArchivedChainWatch(aid);
            });
        }
    }

    function syncChainWatchHeaderButtons(p) {
        const pastBtn = document.getElementById('chain-watch-past-open');
        const backBtn = document.getElementById('chain-watch-back-active');
        const archives =
            p && Array.isArray(p.archives) && p.archives.length ? p.archives : lastArchivesList;
        if (pastBtn) {
            const n = archives.length;
            pastBtn.textContent = n > 0 ? 'Past chain watches (' + n + ')' : 'Past chain watches';
            pastBtn.style.display = viewingArchiveId ? 'none' : '';
        }
        if (backBtn) {
            backBtn.style.display = viewingArchiveId ? '' : 'none';
        }
    }

    function openChainWatchModal(overlayId) {
        const overlay = document.getElementById(overlayId);
        if (!overlay) return;
        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');
    }

    function closeChainWatchModal(overlayId) {
        const overlay = document.getElementById(overlayId);
        if (!overlay) return;
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
    }

    function buildChainWatchSettingsFormHtml(p, organizerIds, ownerLabel, canManageOrganizers) {
        const settings = p.settings || {};
        const start = settings.chainStartUnix != null ? Number(settings.chainStartUnix) : null;
        const targets = Array.isArray(p.chainTargets) ? p.chainTargets : [];
        const docExists = p.exists === true;
        const dh = utcDateHourFromUnix(start);
        const bc = Math.min(3, Math.max(1, Number(settings.backupColumns) || 1));
        let html = '<div class="war-dashboard-cw-setup">';
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
        html += '<div class="war-dashboard-cw-field war-dashboard-cw-field--with-help">';
        html += chainWatchLabelWithHelp('war-dashboard-cw-reward-type', 'Reward type', CHAIN_WATCH_TIP_REWARD);
        html += '<select id="war-dashboard-cw-reward-type">';
        html += '<option value="cash"' + (settings.rewardType !== 'xanax' ? ' selected' : '') + '>Cash</option>';
        html += '<option value="xanax"' + (settings.rewardType === 'xanax' ? ' selected' : '') + '>Xanax</option>';
        html += '</select></div>';
        html += '<div class="war-dashboard-cw-field"><label for="war-dashboard-cw-r1">First signup</label>';
        html += '<input type="number" id="war-dashboard-cw-r1" min="0" step="1" value="' + escapeHtml(String(settings.rewardFirst != null ? settings.rewardFirst : 0)) + '"></div>';
        html += '<div class="war-dashboard-cw-field"><label for="war-dashboard-cw-r2">Each after</label>';
        html += '<input type="number" id="war-dashboard-cw-r2" min="0" step="1" value="' + escapeHtml(String(settings.rewardSubsequent != null ? settings.rewardSubsequent : 0)) + '"></div>';
        html += '<div class="war-dashboard-cw-field war-dashboard-cw-field--with-help">';
        html += chainWatchLabelWithHelp('war-dashboard-cw-max24', 'Max signups / 24h', CHAIN_WATCH_TIP_SIGNUP_LIMIT);
        html += '<input type="number" id="war-dashboard-cw-max24" min="1" max="999" value="' + escapeHtml(String(settings.maxSignupsPer24h != null ? settings.maxSignupsPer24h : 10)) + '"></div>';
        html += '</div>';
        html += '<input type="hidden" id="war-dashboard-cw-backup" value="' + bc + '">';
        html +=
            '<input type="hidden" id="war-dashboard-cw-visible-days" value="' +
            Math.max(1, Math.floor(Number(settings.visibleTctDays) || 1)) +
            '">';
        html +=
            '<p class="war-dashboard-cw-backup-hint" style="margin:0 0 12px 0;">Use <strong>+</strong> above the schedule table to add backup watcher columns (max 3). Use <strong>−</strong> on <strong>Backup 1</strong> or <strong>Backup 2</strong> headers to remove a column. The schedule lists from chain start until <strong>midnight TCT</strong> first; use <strong>Add next day</strong> below the table for more.</p>';
        html += '<div class="war-dashboard-cw-save-row">';
        html +=
            '<label class="war-dashboard-cw-clear-label" style="display:flex;align-items:flex-start;gap:8px;margin:0;color:#b0b0b0;font-size:12px;line-height:1.4;width:100%;"><input type="checkbox" id="war-dashboard-cw-clear" style="margin-top:2px;flex-shrink:0;"><span>Clear all signups when saving (only if this box is checked)</span></label>';
        html += '<button type="button" class="btn" id="war-dashboard-cw-save">Save schedule</button>';
        html += '<p id="war-dashboard-cw-save-msg" style="font-size:12px;color:#888;margin:0;width:100%;"></p>';
        if (docExists) {
            html += '<div class="war-dashboard-cw-archive-row" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-color,#444);width:100%;">';
            html +=
                '<p style="margin:0 0 8px 0;color:#9e9e9e;font-size:12px;line-height:1.45;">When the chain has finished, archive this schedule to start a new chain watch.</p>';
            html +=
                '<button type="button" class="btn chain-watch-archive-btn" id="chain-watch-archive-btn">Archive / finish chain watch</button>';
            html += '<p id="chain-watch-archive-msg" style="font-size:12px;color:#888;margin:8px 0 0 0;"></p>';
            html += '</div>';
        }
        if (canManageOrganizers) {
            html +=
                '<div class="war-dashboard-cw-organizers" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-color,#444);width:100%;">';
            html += '<div style="font-weight:bold;font-size:13px;margin-bottom:8px;color:var(--accent-color,#ffd700);">Chain organisers</div>';
            html +=
                '<p style="margin:0 0 10px 0;color:#b0b0b0;font-size:12px;line-height:1.45;">Organisers can edit schedule settings. Only you (owner) can change this list.</p>';
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
            html += '<p style="margin-top:12px;font-size:12px;color:#9e9e9e;">Owner: <strong>' + ownerLabel + '</strong></p>';
        }
        html += '</div>';
        return html;
    }

    function wireChainWatchSettingsForm(docExists, canEdit, canManageOrganizers) {
        if (!canEdit) return;
        const saveBtn = document.getElementById('war-dashboard-cw-save');
        if (saveBtn && !saveBtn.dataset.cwWired) {
            saveBtn.dataset.cwWired = '1';
            saveBtn.addEventListener('click', async function () {
                const msg = document.getElementById('war-dashboard-cw-save-msg');
                const apiKey = getApiKey();
                const fn = getChainWatchFunctions();
                if (!apiKey || !fn || !factionId) return;
                const dateEl = document.getElementById('war-dashboard-cw-start-date');
                const hourEl = document.getElementById('war-dashboard-cw-start-hour');
                let unix = unixFromUtcDateHour(dateEl && dateEl.value, hourEl && hourEl.value);
                const curSettings = chainWatchPayload && chainWatchPayload.settings;
                if (unix == null && curSettings && curSettings.chainStartUnix != null) {
                    unix = Number(curSettings.chainStartUnix);
                }
                const payload = {
                    apiKey: apiKey,
                    factionId: String(factionId),
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
                    closeChainWatchModal('chain-watch-settings-modal');
                    await renderChainWatchPage();
                    if (msg) msg.textContent = 'Saved.';
                } catch (e) {
                    if (msg) msg.textContent = (e && e.message) ? String(e.message) : 'Save failed';
                } finally {
                    saveBtn.disabled = false;
                }
            });
        }
        if (canManageOrganizers) wireChainWatchOrganizers();
    }

    function refreshChainWatchModals(p, canEdit, organizerIds, ownerLabel, canManageOrganizers) {
        const archivesBody = document.getElementById('chain-watch-archives-body');
        if (archivesBody) {
            const archives =
                p && Array.isArray(p.archives) && p.archives.length ? p.archives : lastArchivesList;
            archivesBody.innerHTML = renderArchivesModalHtml(
                archives,
                viewingArchiveId || p.archiveId,
                chainWatchCanRestoreSchedule(p)
            );
        }
        const settingsBody = document.getElementById('chain-watch-settings-body');
        if (settingsBody && canEdit) {
            settingsBody.innerHTML = buildChainWatchSettingsFormHtml(
                p,
                organizerIds,
                ownerLabel,
                canManageOrganizers
            );
            wireChainWatchHelpIcons(settingsBody);
        }
        syncChainWatchHeaderButtons(p);
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

    /** VIP: increment visible TCT days (+24h of slots after first partial day). */
    function wireChainWatchAddDayButton() {
        const btn = document.getElementById('war-dashboard-cw-add-day');
        if (!btn) return;
        btn.addEventListener('click', async function () {
            const apiKey = getApiKey();
            const fn = getChainWatchFunctions();
            if (!apiKey || !fn || !factionId || !chainWatchPayload) return;
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
                    factionId: String(factionId),
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
                await renderChainWatchPage();
            } catch (e) {
                alert((e && e.message) ? e.message : 'Could not add day');
            } finally {
                btn.disabled = false;
            }
        });
    }

    /** VIP: Backup 1 / Backup 2 header − removes that watcher column (calls save). */
    function wireChainWatchRemoveColumnButtons() {
        const root = document.getElementById('chain-watch-root');
        if (!root) return;
        root.querySelectorAll('.war-dashboard-cw-remove-col').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                const apiKey = getApiKey();
                const fn = getChainWatchFunctions();
                if (!apiKey || !fn || !factionId || !chainWatchPayload) return;
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
                    await renderChainWatchPage();

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
                        factionId: String(factionId),
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
                    await renderChainWatchPage();
                    alert((e && e.message) ? e.message : 'Could not remove column');
                    btn.disabled = false;
                    return;
                }
                try {
                    await fetchChainWatchData(true);
                } catch (e) {
                    console.warn('chainWatchGet after remove column', e);
                }
                await renderChainWatchPage();
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
            const fn = getChainWatchFunctions();
            if (!apiKey || !fn || !factionId || !chainWatchPayload) return;
            const p = chainWatchPayload;
            const s = p.settings || {};
            const bc = Math.min(3, Math.max(1, Number(s.backupColumns) || 1));
            if (bc >= 3) return;
            btn.disabled = true;
            const prevBackupColumns = bc;
            try {
                // Optimistic UI: add column instantly, then sync to backend.
                s.backupColumns = Math.min(3, prevBackupColumns + 1);
                await renderChainWatchPage();

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
                    factionId: String(factionId),
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
                await renderChainWatchPage();
            } catch (e) {
                s.backupColumns = prevBackupColumns;
                await fetchChainWatchData(true).catch(function () {});
                await renderChainWatchPage();
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
                const fn = getChainWatchFunctions();
                if (!apiKey || !fn || !factionId) return;
                saveBtn.disabled = true;
                if (msg) msg.textContent = 'Saving…';
                try {
                    const res = await fn.httpsCallable('chainWatchSetOrganizers')({
                        apiKey: apiKey,
                        factionId: String(factionId),
                        organizerPlayerIds: readIdsFromHidden()
                    });
                    await fetchChainWatchData(true);
                    await renderChainWatchPage();
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

    async function fetchChainWatchData(force) {
        chainWatchLastError = '';
        const fid = factionId;
        const apiKey = getApiKey();
        if (!fid) {
            chainWatchLastError = 'Could not determine your faction. Use a share link with faction ID or set your API key in the sidebar.';
            return null;
        }
        if (!apiKey) {
            chainWatchLastError = 'Set your Torn API key in the sidebar first.';
            return null;
        }
        const fn = getChainWatchFunctions();
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
                try {
                    await ensureActivityDataLoaded(fid);
                } catch (e) { /* ignore */ }
                renderChainWatchOurChainBox();
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
                viewingArchiveId = null;
                if (Array.isArray(data.archives)) lastArchivesList = data.archives;
                chainWatchPayload = data;
                chainWatchLastFetchMs = Date.now();
                writeChainWatchSessionCache(fid, data);
                try {
                    await ensureActivityDataLoaded(fid);
                } catch (e) { /* ignore */ }
                renderChainWatchOurChainBox();
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

    /** Compact settings strip for the chain watch page header. */
    function chainWatchHeaderSummaryHtml(settings, start, docExists) {
        if (!docExists) {
            return (
                '<p class="chain-watch-header-summary-empty">No schedule saved yet. Use <strong>Settings</strong> to configure this chain watch.</p>'
            );
        }
        const rt = settings.rewardType === 'xanax' ? 'Xanax' : 'Cash';
        const target = settings.chainTarget != null ? String(settings.chainTarget) : '—';
        const r1 = settings.rewardFirst != null ? String(settings.rewardFirst) : '0';
        const r2 = settings.rewardSubsequent != null ? String(settings.rewardSubsequent) : '0';
        const max24 = settings.maxSignupsPer24h != null ? String(settings.maxSignupsPer24h) : '10';
        let startVal;
        if (start == null) {
            startVal = '<span class="chain-watch-meta-missing">Not set</span>';
        } else {
            const d = new Date(start * 1000);
            startVal =
                escapeHtml(formatTctDayHeading(start) + ', ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC');
        }
        return (
            '<dl class="chain-watch-settings-dl">' +
            '<dt>Chain start</dt><dd>' +
            startVal +
            '</dd>' +
            '<dt>Target</dt><dd>' +
            escapeHtml(target) +
            ' hits</dd>' +
            chainWatchDtWithHelp('Reward', CHAIN_WATCH_TIP_REWARD) +
            '<dd>' +
            escapeHtml(rt) +
            ' · ' +
            escapeHtml(r1) +
            '/' +
            escapeHtml(r2) +
            '</dd>' +
            chainWatchDtWithHelp('Max / 24h', CHAIN_WATCH_TIP_SIGNUP_LIMIT) +
            '<dd>' +
            escapeHtml(max24) +
            '</dd>' +
            '</dl>'
        );
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
        const body = document.getElementById('chain-watch-rewards-body');
        if (!body || !chainWatchPayload) return;
        if (factionId) {
            // Do not block modal paint on activity fetch; refresh will merge in background.
            ensureActivityDataLoaded(factionId).catch(function () {});
        }
        const p = chainWatchPayload;
        const comp = computeRewardsOwed(chainWatchPayload, factionId);
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

    async function renderChainWatchPage() {
        const body = document.getElementById('chain-watch-root');
        if (!body || !chainWatchPayload) return;
        if (factionId) {
            // Keep interactions snappy; hydrate attendance data in background.
            ensureActivityDataLoaded(factionId).catch(function () {});
        }
        const p = chainWatchPayload;
        const settings = p.settings || {};
        const slots = p.slots || {};
        const viewer = p.viewer || {};
        const readOnlyArchive =
            viewer.readOnlyArchive === true || viewingArchiveId != null || p.archived === true;
        const canEdit = viewer.canEdit === true && !readOnlyArchive;
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
        if (readOnlyArchive) {
            const archivedWhen =
                p.archivedAt != null
                    ? new Date(p.archivedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                    : '';
            const archiveSignupCount = countSignupsInSlots(slots);
            html +=
                '<div style="margin:0 0 12px 0;padding:10px 12px;border-radius:6px;border:1px solid rgba(100,181,246,0.35);background:rgba(33,150,243,0.12);font-size:13px;line-height:1.5;color:#e3f2fd;">Viewing an <strong>archived</strong> chain watch (read-only)' +
                (archivedWhen ? ' from ' + escapeHtml(archivedWhen) : '') +
                '. Use <strong>Current chain watch</strong> in the header to return.';
            if (chainWatchCanRestoreSchedule(p) && viewingArchiveId && archiveSignupCount > 0) {
                html +=
                    '<div style="margin-top:10px;"><button type="button" class="btn chain-watch-restore-archive-banner" data-archive-id="' +
                    escapeAttr(String(viewingArchiveId)) +
                    '">Restore signups to active schedule</button></div>';
            }
            html += '</div>';
        }

        if (brokeAtHit != null && brokeAtHit > 0) {
            html += '<p class="war-dashboard-chain-watch-break-banner" style="margin:0 0 12px 0;padding:8px 10px;border-radius:6px;background:rgba(244,67,54,0.2);color:#ffcdd2;font-size:13px;">Chain broke at hit <strong>' + escapeHtml(String(brokeAtHit)) + '</strong>' +
                (brokeAtUnix ? ' (around ' + escapeHtml(formatTctRange(brokeAtUnix, brokeAtUnix + 60)) + ')' : '') + '</p>';
        }

        if (!docExists) {
            html += '<div style="margin:0 0 14px 0;padding:12px 14px;border-radius:8px;border:1px solid var(--border-color,#444);background:rgba(255,215,0,0.06);font-size:13px;line-height:1.5;color:#e0e0e0;">';
            html += '<p style="margin:0;"><strong>No chain watch schedule saved yet</strong> for your faction. Use <strong>Settings</strong> in the header to set chain start, target, and rewards — you become the <strong>owner</strong> and can add organisers.</p>';
            html += '</div>';
        } else if (!canEdit) {
            html += '<p style="color:#b0b0b0;font-size:12px;margin:0 0 12px 0;line-height:1.45;">You can sign up for watch slots below. Only the owner' +
                (ownerLabel ? ' (<strong>' + ownerLabel + '</strong>)' : '') +
                (organizerIds.length ? ' and designated organisers' : '') +
                ' can change the schedule.</p>';
        } else if (docExists && canEdit && !p.ownerPlayerId) {
            html += '<p style="color:#e0c080;font-size:12px;margin:0 0 12px 0;line-height:1.45;">This schedule has no owner yet. Open <strong>Settings</strong> and save to claim ownership.</p>';
        } else if (canEdit && !isOwner && organizerIds.indexOf(String(viewer.playerId || '')) >= 0) {
            html += '<p style="color:#b0b0b0;font-size:12px;margin:0 0 12px 0;line-height:1.45;">You are a <strong>chain organiser</strong> and can edit settings. Owner: <strong>' + (ownerLabel || '—') + '</strong>.</p>';
        }

        if (!canEdit) {
            html +=
                '<p class="war-dashboard-cw-viewer-hint" style="color:#b0b0b0;font-size:13px;margin:0 0 12px 0;line-height:1.45;">Use <strong>Sign up</strong> in an empty watcher cell for that hour, or leave your slot (×) while the hour is still active. ' +
                chainWatchHelpIconHtml(CHAIN_WATCH_TIP_SIGNUP) +
                ' Only the owner and designated organisers can change the schedule.</p>';
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

        html += chainWatchRulesWarningHtml();
        html += '<p class="chain-watch-schedule-scroll-hint">Swipe sideways to see who is signed up in each watcher column.</p>';
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
                    if (isMe && !hourCompleted && !readOnlyArchive) {
                        html +=
                            '<button type="button" class="war-dashboard-cw-leave war-dashboard-cw-leave-icon" data-slot="' +
                            i +
                            '" title="Leave this slot" aria-label="Leave this slot">×</button>';
                    }
                    html += '</div>';
                    if (factionId) {
                        html += chainWatchHtmlWatcherAttendance(factionId, w, slotStart, slotEnd);
                    }
                    html += '</td>';
                } else {
                    html += '<td class="war-dashboard-cw-slot-cell war-dashboard-cw-slot-cell--empty">';
                    if (
                        c === firstFreeCol &&
                        start != null &&
                        !mine &&
                        hasFreeWatcherSlot &&
                        !hourStarted &&
                        !readOnlyArchive
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
            '<p class="war-dashboard-cw-attendance-footnote" style="color:#9e9e9e;font-size:12px;margin:12px 0 0 0;line-height:1.45;">Watch attendance uses <strong>Faction activity tracker</strong> samples (~5 min, online only). Add your faction there for 24/7 history. <strong>Xm</strong> = estimated online minutes in that hour; <strong>✓</strong> seen online at least once; <strong>✗</strong> samples ran but player was not online; <strong>?</strong> no samples that hour; <strong>…</strong> hour still in progress.</p>';

        if (canEdit && factionId) {
            const issues = collectChainWatchAttendanceIssues(factionId, p);
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

        updateChainWatchPageChrome();
        wireChainWatchHelpIcons(body);
        wireChainWatchRulesDismiss(body);
        body.querySelectorAll('.chain-watch-restore-archive-banner').forEach(function (btn) {
            if (btn.dataset.cwRestoreWired) return;
            btn.dataset.cwRestoreWired = '1';
            btn.addEventListener('click', function () {
                void restoreArchivedChainWatch(btn.getAttribute('data-archive-id'));
            });
        });
        refreshChainWatchModals(p, canEdit, organizerIds, ownerLabel, canManageOrganizers);
        wireChainWatchSettingsForm(docExists, canEdit, canManageOrganizers);
        wireChainWatchArchiveUi();

        const toggleCompletedBtn = document.getElementById('war-dashboard-cw-toggle-completed');
        if (toggleCompletedBtn) {
            toggleCompletedBtn.addEventListener('click', function () {
                try {
                    localStorage.setItem(
                        'war_dashboard_cw_show_completed',
                        toggleCompletedBtn.getAttribute('data-set-completed') === '1' ? '1' : '0'
                    );
                } catch (e) { /* ignore */ }
                void renderChainWatchPage().catch(function (err) {
                    console.error('renderChainWatchPage', err);
                });
            });
        }

        if (canEdit) {
            wireChainWatchAddColumnButton();
            wireChainWatchRemoveColumnButtons();
            wireChainWatchAddDayButton();
        }

        body.querySelectorAll('.war-dashboard-cw-join').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                const si = parseInt(btn.getAttribute('data-slot'), 10);
                const apiKey = getApiKey();
                const fn = getChainWatchFunctions();
                if (!apiKey || !fn || !factionId || !chainWatchPayload) return;
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
                            await renderChainWatchPage();
                        }
                    }

                    await fn.httpsCallable('chainWatchSignup')({ apiKey: apiKey, factionId: String(factionId), slotIndex: si });
                } catch (e) {
                    p.slots[key] = before;
                    await fetchChainWatchData(true).catch(function () {});
                    await renderChainWatchPage();
                    alert((e && e.message) ? e.message : 'Could not sign up');
                    btn.disabled = false;
                    return;
                }
                try {
                    await fetchChainWatchData(true);
                } catch (e) {
                    console.warn('chainWatchGet after signup', e);
                }
                await renderChainWatchPage();
                btn.disabled = false;
            });
        });
        body.querySelectorAll('.war-dashboard-cw-leave').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                const si = parseInt(btn.getAttribute('data-slot'), 10);
                const apiKey = getApiKey();
                const fn = getChainWatchFunctions();
                if (!apiKey || !fn || !factionId || !chainWatchPayload) return;
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
                        await renderChainWatchPage();
                    }

                    await fn.httpsCallable('chainWatchRemoveSelf')({ apiKey: apiKey, factionId: String(factionId), slotIndex: si });
                } catch (e) {
                    p.slots[key] = before;
                    await fetchChainWatchData(true).catch(function () {});
                    await renderChainWatchPage();
                    alert((e && e.message) ? e.message : 'Could not leave slot');
                    btn.disabled = false;
                    return;
                }
                try {
                    await fetchChainWatchData(true);
                } catch (e) {
                    console.warn('chainWatchGet after leave', e);
                }
                await renderChainWatchPage();
                btn.disabled = false;
            });
        });

    }

    function chainWatchShareUrl(fid) {
        const base = location.origin + location.pathname;
        return base + '#chain-watch/' + encodeURIComponent(String(fid));
    }

    async function resolveFactionIdFromHash() {
        const parts = (location.hash || '').replace(/^#/, '').split('/').filter(Boolean);
        if (parts[0] !== 'chain-watch') return null;
        if (parts[1]) return String(parts[1]).trim();
        const apiKey = getApiKey();
        if (!apiKey || apiKey.length !== 16) return null;
        const data = await fetchJson(
            'https://api.torn.com/user/?selections=profile&key=' + encodeURIComponent(apiKey)
        );
        const fac = data.faction && typeof data.faction === 'object' ? data.faction : null;
        const raw =
            data.faction_id != null
                ? data.faction_id
                : fac && fac.faction_id != null
                  ? fac.faction_id
                  : fac && fac.id != null
                    ? fac.id
                    : null;
        return raw != null ? String(raw) : null;
    }

    function updateChainWatchPageChrome() {
        const titleEl = document.getElementById('chain-watch-page-title');
        const subEl = document.getElementById('chain-watch-page-subtitle');
        const linkIn = document.getElementById('chain-watch-share-link');
        const summaryEl = document.getElementById('chain-watch-header-summary');
        const settingsBtn = document.getElementById('chain-watch-settings-open');
        if (!factionId) return;
        const share = chainWatchShareUrl(factionId);
        if (linkIn) linkIn.value = share;
        const p = chainWatchPayload;
        const settings = (p && p.settings) || {};
        const start = settings.chainStartUnix != null ? Number(settings.chainStartUnix) : null;
        const viewer = (p && p.viewer) || {};
        const canEdit = viewer.canEdit === true && !viewingArchiveId;
        const name =
            p && p.settings && p.settings.chainName
                ? String(p.settings.chainName)
                : p && p.exists
                  ? 'Chain watch'
                  : 'New chain watch';
        if (titleEl) titleEl.textContent = name;
        if (subEl) {
            if (viewingArchiveId) {
                subEl.textContent = 'Archived chain watch · Faction ' + factionId;
            } else {
                subEl.textContent =
                    'Faction ' + factionId + (p && p.viewer && p.viewer.isOwner ? ' · You are the owner' : '');
            }
        }
        if (titleEl && viewingArchiveId) {
            titleEl.textContent = name + ' (archived)';
        }
        if (summaryEl) {
            summaryEl.innerHTML = p
                ? chainWatchHeaderSummaryHtml(settings, start, p.exists === true)
                : '';
        }
        if (settingsBtn) {
            settingsBtn.hidden = !canEdit;
        }
        syncChainWatchHeaderButtons(p);
        renderChainWatchOurChainBox();
        wireChainWatchHelpIcons(document.getElementById('chain-watch-header-summary'));
    }

    async function refreshChainWatchPage() {
        const root = document.getElementById('chain-watch-root');
        if (!root) return;
        root.innerHTML = '<p style="color:#888;">Loading…</p>';
        if (!getApiKey()) {
            root.innerHTML =
                '<p style="color:#e0c080;">Set your <strong>Torn API key</strong> in the sidebar, then reload this page.</p>';
            return;
        }
        if (!factionId) {
            root.innerHTML = '<p style="color:#f44336;">Could not determine faction. Use a share link with faction ID or set your API key.</p>';
            return;
        }
        await fetchChainWatchData(true);
        if (!chainWatchPayload) {
            root.innerHTML =
                '<p style="color:#f44336;font-size:14px;line-height:1.45;">' +
                escapeHtml(friendlyChainWatchLoadError(chainWatchLastError)) +
                '</p>';
            return;
        }
        updateChainWatchPageChrome();
        await renderChainWatchPage();
    }

    function wireChainWatchPageChrome() {
        document.getElementById('chain-watch-copy-link')?.addEventListener('click', function () {
            const input = document.getElementById('chain-watch-share-link');
            const url = input ? input.value : chainWatchShareUrl(factionId);
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(function () {
                    const msg = document.getElementById('chain-watch-copy-msg');
                    if (msg) {
                        msg.textContent = 'Link copied!';
                        setTimeout(function () {
                            msg.textContent = '';
                        }, 2000);
                    }
                });
            } else if (input) {
                input.select();
            }
        });
        document.getElementById('chain-watch-rewards-open')?.addEventListener('click', function () {
            const overlay = document.getElementById('chain-watch-rewards-modal');
            if (overlay) {
                overlay.style.display = 'flex';
                overlay.setAttribute('aria-hidden', 'false');
            }
            const body = document.getElementById('chain-watch-rewards-body');
            if (body) body.innerHTML = '<p style="color:#888;">Loading…</p>';
            const loadRewards = viewingArchiveId
                ? Promise.resolve(chainWatchPayload)
                : fetchChainWatchData(true).then(function () {
                      return chainWatchPayload;
                  });
            loadRewards
                .then(function () {
                    if (!chainWatchPayload) return;
                    return renderChainWatchRewardsModal();
                })
                .catch(function (e) {
                    if (body) body.textContent = e && e.message ? e.message : 'Error';
                });
        });
        document.getElementById('chain-watch-rewards-close')?.addEventListener('click', function () {
            const overlay = document.getElementById('chain-watch-rewards-modal');
            if (overlay) {
                overlay.style.display = 'none';
                overlay.setAttribute('aria-hidden', 'true');
            }
        });
        document.getElementById('chain-watch-rewards-modal')?.addEventListener('click', function (e) {
            if (e.target.id === 'chain-watch-rewards-modal') {
                e.target.style.display = 'none';
                e.target.setAttribute('aria-hidden', 'true');
            }
        });

        document.getElementById('chain-watch-past-open')?.addEventListener('click', function () {
            if (chainWatchPayload) {
                const v = chainWatchPayload.viewer || {};
                refreshChainWatchModals(
                    chainWatchPayload,
                    v.canEdit === true && !viewingArchiveId,
                    (chainWatchPayload.organizerPlayerIds || []).map(String),
                    chainWatchOwnerLabel(chainWatchPayload),
                    v.canManageOrganizers === true
                );
            }
            openChainWatchModal('chain-watch-archives-modal');
        });
        document.getElementById('chain-watch-archives-close')?.addEventListener('click', function () {
            closeChainWatchModal('chain-watch-archives-modal');
        });
        document.getElementById('chain-watch-archives-modal')?.addEventListener('click', function (e) {
            if (e.target.id === 'chain-watch-archives-modal') closeChainWatchModal('chain-watch-archives-modal');
        });
        document.getElementById('chain-watch-settings-close')?.addEventListener('click', function () {
            closeChainWatchModal('chain-watch-settings-modal');
        });
        document.getElementById('chain-watch-settings-modal')?.addEventListener('click', function (e) {
            if (e.target.id === 'chain-watch-settings-modal') closeChainWatchModal('chain-watch-settings-modal');
        });
        document.getElementById('chain-watch-settings-open')?.addEventListener('click', function () {
            openChainWatchModal('chain-watch-settings-modal');
            const v = (chainWatchPayload && chainWatchPayload.viewer) || {};
            wireChainWatchSettingsForm(
                chainWatchPayload && chainWatchPayload.exists === true,
                v.canEdit === true,
                v.canManageOrganizers === true
            );
            wireChainWatchHelpIcons(document.getElementById('chain-watch-settings-body'));
        });
    }

    window.initChainWatchPage = async function initChainWatchPage() {
        wireChainWatchPageChrome();
        wireChainWatchArchiveUi();
        if (!window._chainWatchHelpDocClose) {
            window._chainWatchHelpDocClose = true;
            document.addEventListener('click', function (e) {
                if (e.target.closest('.chain-watch-help')) return;
                document.querySelectorAll('.chain-watch-help.is-visible').forEach(function (el) {
                    el.classList.remove('is-visible');
                });
            });
        }
        startChainWatchChainTick();
        try {
            factionId = await resolveFactionIdFromHash();
        } catch (e) {
            const root = document.getElementById('chain-watch-root');
            if (root) root.innerHTML = '<p style="color:#f44336;">' + escapeHtml(e.message || 'Could not load profile') + '</p>';
            return;
        }
        void refreshOurFactionChain();
        await refreshChainWatchPage();
        if (!window._chainWatchPagePollId) {
            window._chainWatchPagePollId = setInterval(function () {
                if ((location.hash || '').replace('#', '').split('/')[0] !== 'chain-watch') return;
                if (viewingArchiveId) return;
                fetchChainWatchData(false).then(function () {
                    if (chainWatchPayload) renderChainWatchPage().catch(function () {});
                }).catch(function () {});
            }, 60000);
        }
    };
})();
