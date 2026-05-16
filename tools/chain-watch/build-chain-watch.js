/**
 * One-off extractor: copies chain-watch logic from war-dashboard.js into chain-watch.js
 * Run: node tools/chain-watch/build-chain-watch.js
 */
const fs = require('fs');
const path = require('path');

const warPath = path.join(__dirname, '../war-dashboard/war-dashboard.js');
const outPath = path.join(__dirname, 'chain-watch.js');
const lines = fs.readFileSync(warPath, 'utf8').split(/\r?\n/);

function slice(start1, end1) {
  return lines.slice(start1 - 1, end1).join('\n');
}

const chunks = [
  slice(101, 172),
  slice(340, 681),
  slice(1558, 1572),
  slice(1619, 1692),
  slice(1708, 1900),
  slice(1902, 1944),
  slice(1946, 2460),
];

let body = chunks.join('\n\n');

const replacements = [
  [/lastOurFactionId/g, 'factionId'],
  [/getWarDashboardFunctions/g, 'getChainWatchFunctions'],
  [/CHAIN_WATCH_CACHE_PREFIX = 'war_dashboard_chain_watch_v1_'/g, "CHAIN_WATCH_CACHE_PREFIX = 'chain_watch_page_v1_'"],
  [/getElementById\('war-dashboard-chain-watch-modal-body'\)/g, "getElementById('chain-watch-root')"],
  [/getElementById\("war-dashboard-chain-watch-modal-body"\)/g, 'getElementById("chain-watch-root")'],
  [/getElementById\('war-dashboard-chain-watch-rewards-body'\)/g, "getElementById('chain-watch-rewards-body')"],
  [/async function renderChainWatchScheduleModal/g, 'async function renderChainWatchPage'],
  [/renderChainWatchScheduleModal/g, 'renderChainWatchPage'],
  [/war-dashboard-chain-watch-rewards-body/g, 'chain-watch-rewards-body'],
  [
    /No faction loaded yet\. Click Apply or Use current ranked war, then open Chain watch again\./g,
    'Could not determine your faction. Use a share link with faction ID or set your API key in the sidebar.'
  ],
];

for (const [re, rep] of replacements) {
  body = body.replace(re, rep);
}

const header = `/**
 * Standalone Chain Watch page — schedule signups (not War Dashboard).
 */
(function () {
    'use strict';

    const CHAIN_WATCH_MAX_HOUR_SLOTS = 50 * 24;
    const CHAIN_WATCH_POLL_MS = 5 * 60 * 1000;
    const CHAIN_WATCH_CACHE_PREFIX = 'chain_watch_page_v1_';

    let factionId = null;
    let chainWatchPayload = null;
    let chainWatchLastFetchMs = 0;
    let chainWatchLastError = '';

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

    /** Attendance needs War Dashboard activity tracker; standalone page skips heavy samples. */
    function evaluateWatcherSlotAttendance() {
        return { phase: 'unknown', sampleCount: 0, onlineHits: 0, presentOnce: false, onlineMinutesApprox: 0, verdict: 'no_data' };
    }

    function ensureActivityDataLoaded() {
        return Promise.resolve();
    }

    function chainWatchAttendanceInlineHtml() {
        return '';
    }

    function chainWatchHtmlWatcherAttendance() {
        return '';
    }

    function collectChainWatchAttendanceIssues() {
        return { noShows: [], unverified: [] };
    }

    function updateChainWatchBarVisibility() { /* standalone page: no-op */ }
    function renderChainBoxes() { /* standalone page: no-op */ }

`;

const headerFixed = header;

const footer = `

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
        const url = '/.torn-api-proxy/user/?selections=profile&key=' + encodeURIComponent(apiKey);
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) throw new Error(String(data.error));
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
        if (!factionId) return;
        const share = chainWatchShareUrl(factionId);
        if (linkIn) linkIn.value = share;
        const p = chainWatchPayload;
        const name =
            p && p.settings && p.settings.chainName
                ? String(p.settings.chainName)
                : p && p.exists
                  ? 'Chain watch'
                  : 'New chain watch';
        if (titleEl) titleEl.textContent = name;
        if (subEl) {
            subEl.textContent = 'Faction ' + factionId + (p && p.viewer && p.viewer.isOwner ? ' · You are the owner' : '');
        }
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
            fetchChainWatchData(true)
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
    }

    window.initChainWatchPage = async function initChainWatchPage() {
        wireChainWatchPageChrome();
        try {
            factionId = await resolveFactionIdFromHash();
        } catch (e) {
            const root = document.getElementById('chain-watch-root');
            if (root) root.innerHTML = '<p style="color:#f44336;">' + escapeHtml(e.message || 'Could not load profile') + '</p>';
            return;
        }
        await refreshChainWatchPage();
        if (!window._chainWatchPagePollId) {
            window._chainWatchPagePollId = setInterval(function () {
                if ((location.hash || '').replace('#', '').split('/')[0] !== 'chain-watch') return;
                fetchChainWatchData(false).then(function () {
                    if (chainWatchPayload) renderChainWatchPage().catch(function () {});
                }).catch(function () {});
            }, 60000);
        }
    };
})();
`;

const out = headerFixed + body + footer;
fs.writeFileSync(outPath, out);
console.log('Wrote', outPath, '(' + out.length + ' bytes)');
