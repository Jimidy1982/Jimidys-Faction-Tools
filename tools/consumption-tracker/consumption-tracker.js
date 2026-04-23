// Global state for consumption tracker (use window to avoid redeclaration errors when script is reloaded)
if (!window.consumptionTrackerData) {
    window.consumptionTrackerData = {
    fetchedMembers: [],
    sortState: { column: 'xanax', direction: 'desc' }
};
}
// Create local reference for convenience (use var to allow redeclaration on script reload)
var consumptionTrackerData = window.consumptionTrackerData;

/** Parse Y-m-d from flatpickr; returns { y, m (0-11), d } or null */
function consumptionParseYmd(ymd) {
    if (!ymd || typeof ymd !== 'string') return null;
    const p = ymd.split('-').map(Number);
    if (p.length !== 3 || p.some(n => !Number.isFinite(n))) return null;
    return { y: p[0], m: p[1] - 1, d: p[2] };
}

function consumptionClampInt(n, lo, hi, fallback) {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x)) return fallback;
    return Math.max(lo, Math.min(hi, x));
}

/** Exact instant on calendar day ymd at H:M:S, TCT (= UTC). */
function consumptionTctInstantUnix(ymd, hour, minute, second) {
    const parts = consumptionParseYmd(ymd);
    if (!parts) return null;
    const h = consumptionClampInt(hour, 0, 23, 0);
    const m = consumptionClampInt(minute, 0, 59, 0);
    const s = consumptionClampInt(second, 0, 59, 0);
    return Math.floor(Date.UTC(parts.y, parts.m, parts.d, h, m, s) / 1000);
}

function consumptionFormatTctUtc(ts) {
    return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function consumptionUtcYmd() {
    const t = new Date();
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function consumptionFillHmsSelect(sel, isHour) {
    if (!sel) return;
    sel.innerHTML = '';
    const max = isHour ? 23 : 59;
    for (let i = 0; i <= max; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = String(i).padStart(2, '0');
        sel.appendChild(opt);
    }
}

function consumptionPopulateTctTimeSelects() {
    const root = document.getElementById('consumptionTctTimesRoot');
    if (root && root.dataset.tctPopulated === '2') {
        return;
    }

    const startH = document.getElementById('consumptionStartHourTCT');
    const startM = document.getElementById('consumptionStartMinTCT');
    const startS = document.getElementById('consumptionStartSecTCT');
    const endH = document.getElementById('consumptionEndHourTCT');
    const endM = document.getElementById('consumptionEndMinTCT');
    const endS = document.getElementById('consumptionEndSecTCT');
    if (!startH || !startM || !startS || !endH || !endM || !endS) return;

    consumptionFillHmsSelect(startH, true);
    consumptionFillHmsSelect(startM, false);
    consumptionFillHmsSelect(startS, false);
    consumptionFillHmsSelect(endH, true);
    consumptionFillHmsSelect(endM, false);
    consumptionFillHmsSelect(endS, false);

    startH.value = '0';
    startM.value = '0';
    startS.value = '0';
    endH.value = '23';
    endM.value = '59';
    endS.value = '59';

    if (root) root.dataset.tctPopulated = '2';
}

function consumptionTornFetchUrl(url) {
    return typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(url) : url;
}

function consumptionUnixToYmdHms(ts) {
    const d = new Date(ts * 1000);
    return {
        ymd: d.toISOString().slice(0, 10),
        h: d.getUTCHours(),
        m: d.getUTCMinutes(),
        s: d.getUTCSeconds()
    };
}

function consumptionSetFlatpickrYmd(inputId, ymd) {
    const el = document.getElementById(inputId);
    if (!el) return;
    if (el._flatpickr) el._flatpickr.setDate(ymd, false);
    else el.value = ymd;
}

function consumptionSetSelectByInt(id, num, maxVal) {
    const el = document.getElementById(id);
    if (!el) return;
    const hi = maxVal != null ? maxVal : 59;
    const v = String(consumptionClampInt(num, 0, hi, 0));
    if ([...el.options].some(o => o.value === v)) el.value = v;
}

var CONSUMPTION_EXACT_WAR_TIMES_VIP_REQUIRED = 1;

const CONSUMPTION_XANAX_HITS_SORT_KEY = 'consumptionXanaxHitsSort';

const CONSUMPTION_XANAX_FLAG_LOW_KEY = 'consumptionXanaxFlagLowHits';
const CONSUMPTION_XANAX_FLAG_USE_MIN_HITS_KEY = 'consumptionXanaxFlagUseMinHits';
const CONSUMPTION_XANAX_FLAG_USE_PER_XANAX_KEY = 'consumptionXanaxFlagUsePerXanax';
const CONSUMPTION_XANAX_FLAG_MIN_HITS_KEY = 'consumptionXanaxFlagMinHits';
const CONSUMPTION_XANAX_FLAG_PER_XANAX_KEY = 'consumptionXanaxFlagPerXanax';
const CONSUMPTION_XANAX_FLAG_COMBINE_KEY = 'consumptionXanaxFlagCombineMode';

/** @returns {'or'|'and'} — default AND (strict: fail either threshold → flag) when unset. */
function consumptionGetXanaxFlagCombineMode() {
    const v = (localStorage.getItem(CONSUMPTION_XANAX_FLAG_COMBINE_KEY) || 'and').toLowerCase();
    return v === 'and' ? 'and' : 'or';
}

function consumptionSetXanaxFlagCombineMode(mode) {
    localStorage.setItem(CONSUMPTION_XANAX_FLAG_COMBINE_KEY, mode === 'and' ? 'and' : 'or');
}

/** One-time: split legacy single "Flag" toggle into two independent rule toggles. */
function consumptionMigrateXanaxFlagRuleKeysOnce() {
    if (window._consumptionXanaxFlagRuleKeysMigrated) return;
    window._consumptionXanaxFlagRuleKeysMigrated = true;
    const legacy = localStorage.getItem(CONSUMPTION_XANAX_FLAG_LOW_KEY);
    if (legacy === null || legacy === '') return;
    const on = legacy === '1' || legacy === 'true';
    const vMin = localStorage.getItem(CONSUMPTION_XANAX_FLAG_USE_MIN_HITS_KEY);
    const vPer = localStorage.getItem(CONSUMPTION_XANAX_FLAG_USE_PER_XANAX_KEY);
    if (vMin === null || vMin === '') {
        localStorage.setItem(CONSUMPTION_XANAX_FLAG_USE_MIN_HITS_KEY, on ? '1' : '0');
    }
    if (vPer === null || vPer === '') {
        localStorage.setItem(CONSUMPTION_XANAX_FLAG_USE_PER_XANAX_KEY, on ? '1' : '0');
    }
    localStorage.removeItem(CONSUMPTION_XANAX_FLAG_LOW_KEY);
}

function consumptionGetXanaxFlagUseMinHits() {
    const v = localStorage.getItem(CONSUMPTION_XANAX_FLAG_USE_MIN_HITS_KEY);
    if (v === null || v === '') return true;
    return v === '1' || v === 'true';
}

function consumptionSetXanaxFlagUseMinHits(on) {
    localStorage.setItem(CONSUMPTION_XANAX_FLAG_USE_MIN_HITS_KEY, on ? '1' : '0');
}

function consumptionGetXanaxFlagUsePerXanax() {
    const v = localStorage.getItem(CONSUMPTION_XANAX_FLAG_USE_PER_XANAX_KEY);
    if (v === null || v === '') return true;
    return v === '1' || v === 'true';
}

function consumptionSetXanaxFlagUsePerXanax(on) {
    localStorage.setItem(CONSUMPTION_XANAX_FLAG_USE_PER_XANAX_KEY, on ? '1' : '0');
}

function consumptionGetXanaxFlagMinHits() {
    const raw = localStorage.getItem(CONSUMPTION_XANAX_FLAG_MIN_HITS_KEY);
    if (raw === null || raw === '') return 35;
    return consumptionClampInt(parseInt(raw, 10), 0, 999999, 35);
}

function consumptionSetXanaxFlagMinHits(value) {
    const n = consumptionClampInt(parseInt(String(value).trim(), 10), 0, 999999, 35);
    localStorage.setItem(CONSUMPTION_XANAX_FLAG_MIN_HITS_KEY, String(n));
}

function consumptionGetXanaxFlagPerXanax() {
    const raw = localStorage.getItem(CONSUMPTION_XANAX_FLAG_PER_XANAX_KEY);
    if (raw === null || raw === '') return 10;
    return consumptionClampInt(parseInt(raw, 10), 0, 500, 10);
}

function consumptionSetXanaxFlagPerXanax(value) {
    const n = consumptionClampInt(parseInt(String(value).trim(), 10), 0, 500, 10);
    localStorage.setItem(CONSUMPTION_XANAX_FLAG_PER_XANAX_KEY, String(n));
}

/**
 * True if total attacks are flagged (low activity).
 * When only one rule checkbox is on: flag if that rule fails (threshold > 0 and attacks below it).
 * When both checkboxes are on and both thresholds apply: OR = lenient (meeting either rule clears the flag → flag only if BOTH fail). AND = strict (must meet both → flag if EITHER fails).
 * qty must be > 0.
 */
function consumptionXanaxIsLowFlagged(totalHits, xanaxQty) {
    if (xanaxQty <= 0) return false;
    const minH = consumptionGetXanaxFlagMinHits();
    const fac = consumptionGetXanaxFlagPerXanax();
    const th = Number(totalHits) || 0;
    const useMin = consumptionGetXanaxFlagUseMinHits();
    const usePer = consumptionGetXanaxFlagUsePerXanax();
    const minFail = useMin && minH > 0 && th < minH;
    const ratioFail = usePer && fac > 0 && th < fac * xanaxQty;
    const activeMin = useMin && minH > 0;
    const activePer = usePer && fac > 0;
    if (!activeMin && !activePer) return false;

    if (!useMin || !usePer) {
        return minFail || ratioFail;
    }

    if (!activeMin) return ratioFail;
    if (!activePer) return minFail;

    if (consumptionGetXanaxFlagCombineMode() === 'or') {
        return minFail && ratioFail;
    }
    return minFail || ratioFail;
}

function consumptionRefreshConsumptionUiFromCache() {
    const d = window.consumptionTrackerData;
    if (!d || !Array.isArray(d.members) || !d.members.length) return;
    updateConsumptionUI(
        d.members,
        d.totalTime,
        d.cacheStats,
        d.wasCached,
        d.itemValues || {},
        d.fromTimestamp,
        d.toTimestamp,
        d.itemTypes || {}
    );
}

function consumptionGetXanaxHitsSort() {
    try {
        const raw = localStorage.getItem(CONSUMPTION_XANAX_HITS_SORT_KEY);
        if (raw) {
            const o = JSON.parse(raw);
            const allowed = new Set(['name', 'war', 'outside', 'total', 'xanax', 'value']);
            if (o && allowed.has(o.column) && (o.direction === 'asc' || o.direction === 'desc')) {
                return { column: o.column, direction: o.direction };
            }
        }
    } catch (_) {
        /* ignore */
    }
    return { column: 'xanax', direction: 'desc' };
}

function consumptionSetXanaxHitsSort(column, direction) {
    localStorage.setItem(CONSUMPTION_XANAX_HITS_SORT_KEY, JSON.stringify({ column, direction }));
}

function consumptionToggleXanaxHitsSort(column) {
    const cur = consumptionGetXanaxHitsSort();
    if (cur.column === column) {
        consumptionSetXanaxHitsSort(column, cur.direction === 'asc' ? 'desc' : 'asc');
    } else {
        consumptionSetXanaxHitsSort(column, column === 'name' ? 'asc' : 'desc');
    }
}

/** Sort Xanax + hits player rows (wc ok uses hit fields; otherwise those sort as 0). */
function consumptionSortXanaxHitsPlayers(players, sortColumn, sortDirection, xanaxUnitPrice, wcOk) {
    const dir = sortDirection === 'asc' ? 1 : -1;
    const num = (p, key) => {
        if (!wcOk) return 0;
        const v = p[key];
        return v != null && !isNaN(Number(v)) ? Number(v) : 0;
    };
    const copy = players.slice();
    copy.sort((a, b) => {
        if (sortColumn === 'name') {
            const an = (a.name || '').toLowerCase();
            const bn = (b.name || '').toLowerCase();
            if (an < bn) return sortDirection === 'asc' ? -1 : 1;
            if (an > bn) return sortDirection === 'asc' ? 1 : -1;
            return 0;
        }
        if (sortColumn === 'war') return dir * (num(a, 'warHits') - num(b, 'warHits'));
        if (sortColumn === 'outside') return dir * (num(a, 'outsideHits') - num(b, 'outsideHits'));
        if (sortColumn === 'total') return dir * (num(a, 'totalAttacksHits') - num(b, 'totalAttacksHits'));
        if (sortColumn === 'xanax') {
            const ax = a.xanax || 0;
            const bx = b.xanax || 0;
            return dir * (ax - bx);
        }
        if (sortColumn === 'value') {
            const av = (a.xanax || 0) * (xanaxUnitPrice || 0);
            const bv = (b.xanax || 0) * (xanaxUnitPrice || 0);
            return dir * (av - bv);
        }
        return 0;
    });
    return copy;
}

function consumptionXanaxHitsSortIndicator(column) {
    const s = consumptionGetXanaxHitsSort();
    if (s.column !== column) return '<span class="sort-indicator"></span>';
    return `<span class="sort-indicator">${s.direction === 'asc' ? '↑' : '↓'}</span>`;
}

/**
 * VIP 1+ unlocks “exact war & chain times” for the war→war preset (same pattern as War Report custom end).
 */
async function consumptionResolveExactWarTimesVipAccess(apiKey) {
    window.consumptionExactWarTimesVipUnlocked = false;
    const key = (apiKey || '').trim();
    if (!key) return false;

    if (window.vipLevelKnown === true && typeof window.currentVipLevel === 'number') {
        window.consumptionExactWarTimesVipUnlocked = window.currentVipLevel >= CONSUMPTION_EXACT_WAR_TIMES_VIP_REQUIRED;
        return window.consumptionExactWarTimesVipUnlocked;
    }

    try {
        if (typeof firebase === 'undefined' || !firebase.functions) {
            return false;
        }
        const userRes = await fetch(consumptionTornFetchUrl(`https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(key)}`));
        const userData = await userRes.json();
        if (userData.error || userData.player_id == null) return false;
        const fn = firebase.functions().httpsCallable('getVipBalance');
        const res = await fn({ playerId: String(userData.player_id) });
        const d = res && res.data;
        const lvl = d && typeof d.vipLevel === 'number' ? d.vipLevel : 0;
        window.consumptionExactWarTimesVipUnlocked = lvl >= CONSUMPTION_EXACT_WAR_TIMES_VIP_REQUIRED;
        return window.consumptionExactWarTimesVipUnlocked;
    } catch (e) {
        console.warn('[CONSUMPTION] VIP check for exact war times:', e);
        window.consumptionExactWarTimesVipUnlocked = false;
        return false;
    }
}

function consumptionSyncHmsSectionVisibility() {
    const wrap = document.getElementById('consumptionExactTimesDetail');
    const warPanel = document.getElementById('consumptionWarPresetPanel');
    const desired = consumptionUseExactWarTimesDesired();

    if (wrap) {
        if (desired) {
            wrap.removeAttribute('hidden');
            consumptionPopulateTctTimeSelects();
        } else {
            wrap.setAttribute('hidden', 'hidden');
        }
    }

    if (warPanel) {
        if (desired) {
            warPanel.removeAttribute('hidden');
        } else {
            warPanel.setAttribute('hidden', 'hidden');
            const chainCb = document.getElementById('consumptionWarRangeIncludeChains');
            if (chainCb) chainCb.checked = false;
            if (consumptionWarPreviewDebounceId) {
                clearTimeout(consumptionWarPreviewDebounceId);
                consumptionWarPreviewDebounceId = null;
            }
            consumptionHideWarToWarPreview();
            const statusEl = document.getElementById('consumptionWarRangeStatus');
            if (statusEl) statusEl.textContent = '';
        }
    }
}

function consumptionUpdateExactWarTimesVipUI() {
    const en = document.getElementById('consumptionWarExactTimesEnabled');
    const lo = document.getElementById('consumptionWarExactTimesLocked');
    const cb = document.getElementById('consumptionWarExactTimes');
    if (!en || !lo) return;
    const ok = !!window.consumptionExactWarTimesVipUnlocked;
    en.style.display = ok ? 'block' : 'none';
    lo.style.display = ok ? 'none' : 'flex';
    if (cb) {
        if (!ok) {
            cb.checked = false;
            cb.disabled = true;
        } else {
            cb.disabled = false;
        }
    }
    consumptionSyncHmsSectionVisibility();
}

function consumptionUseExactWarTimesDesired() {
    const cb = document.getElementById('consumptionWarExactTimes');
    return !!(cb && cb.checked && window.consumptionExactWarTimesVipUnlocked);
}

/** When useExact is false, expand range to full TCT days (00:00 first day → 23:59:59 last day). */
function consumptionAdjustWarRangePrecision(result, useExact) {
    if (!result || !result.ok) return result;
    if (useExact) return result;
    const a = consumptionUnixToYmdHms(result.fromTs);
    const b = consumptionUnixToYmdHms(result.toTs);
    const fromTs = consumptionTctInstantUnix(a.ymd, 0, 0, 0);
    const toTs = consumptionTctInstantUnix(b.ymd, 23, 59, 59);
    if (fromTs == null || toTs == null) return result;
    return { ...result, fromTs, toTs };
}

/** Match post-war chains to ranked wars. */
function consumptionMatchChainsToWars(wars, chains) {
    const matches = new Map();
    wars.forEach(war => {
        const warStart = war.start;
        const warEnd = war.end || Math.floor(Date.now() / 1000);
        const matchingChains = chains.filter(chain =>
            chain.start >= warStart &&
            chain.start <= warEnd &&
            chain.end > warEnd
        );
        if (matchingChains.length > 0) {
            const longestChain = matchingChains.reduce((longest, current) =>
                current.chain > longest.chain ? current : longest
            );
            matches.set(war.id, {
                chain: longestChain.chain,
                start: longestChain.start,
                end: longestChain.end
            });
        }
    });
    return matches;
}

function consumptionEffectiveRankedWarEnd(war, chainMatches) {
    const official = war.end;
    if (!official || official <= 0) return null;
    if (!chainMatches || !chainMatches.has(war.id)) return official;
    const c = chainMatches.get(war.id);
    return c && c.end > official ? c.end : official;
}

/** Enemy faction name for a ranked war row (same as War Report 2.0 war cards). */
function consumptionRankedWarEnemyName(war, ourFactionId) {
    if (!war || ourFactionId == null || ourFactionId === '') return 'Unknown';
    const factions = war.factions;
    if (!factions || !Array.isArray(factions)) return 'Unknown';
    const enemy = factions.find(f => String(f.id) !== String(ourFactionId));
    return (enemy && enemy.name) ? String(enemy.name) : 'Unknown';
}

async function consumptionFetchChainsForWarPreset(apiKey) {
    const url = consumptionTornFetchUrl(`https://api.torn.com/faction/?selections=chains&key=${encodeURIComponent(apiKey)}`);
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error.error || 'Chains API error');
    return Object.values(data.chains || {});
}

/**
 * Compute war-to-war range (same logic as Apply). Returns { ok: true, fromTs, toTs, previous, recent, includeChains } or { ok: false, message }.
 */
async function consumptionComputeWarToWarRange(apiKey, includeChains) {
    const key = (apiKey || '').trim();
    if (!key) return { ok: false, message: 'Enter an API key in the sidebar first.' };

    // Match War Report 2.0 / app welcome: profile (not basic) — basic often omits faction for limited keys.
    const userUrl = consumptionTornFetchUrl(`https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(key)}`);
    const userRes = await fetch(userUrl);
    const userData = await userRes.json();
    if (userData.error) return { ok: false, message: userData.error.error || 'User API error' };

    const factionId =
        userData.faction_id ||
        userData.faction?.faction_id ||
        (userData.faction && userData.faction.id != null ? userData.faction.id : null);
    if (!factionId) {
        return {
            ok: false,
            message: 'No faction on your profile (not in a faction, or key cannot read profile). War Payout uses the same profile call — try a Limited Access key with faction permissions.'
        };
    }

    const warsUrl = consumptionTornFetchUrl(`https://api.torn.com/v2/faction/${factionId}/rankedwars?key=${encodeURIComponent(key)}`);
    const warsRes = await fetch(warsUrl);
    const warsData = await warsRes.json();
    if (warsData.error) return { ok: false, message: warsData.error.error || 'Ranked wars API error' };

    const rawRanked = warsData.rankedwars || [];
    const rawWars = Array.isArray(rawRanked)
        ? rawRanked
        : rawRanked && typeof rawRanked === 'object'
          ? Object.values(rawRanked)
          : [];
    const completed = rawWars.filter(w => w && w.end > 0).sort((a, b) => b.start - a.start);
    if (completed.length < 2) {
        return { ok: false, message: 'Need at least two completed ranked wars in recent history.' };
    }

    const recent = completed[0];
    const previous = completed[1];

    let chainMatches = new Map();
    if (includeChains) {
        try {
            const chains = await consumptionFetchChainsForWarPreset(key);
            chainMatches = consumptionMatchChainsToWars(rawWars, chains);
        } catch (e) {
            return { ok: false, message: e.message || 'Chains API error' };
        }
    }

    const fromTs = consumptionEffectiveRankedWarEnd(previous, chainMatches);
    const toTs = consumptionEffectiveRankedWarEnd(recent, chainMatches);
    if (fromTs == null || toTs == null) return { ok: false, message: 'Invalid war end times.' };
    if (fromTs > toTs) return { ok: false, message: 'Previous war ends after the latest war (unexpected). Check war list.' };

    const previousEnemyName = consumptionRankedWarEnemyName(previous, factionId);
    const recentEnemyName = consumptionRankedWarEnemyName(recent, factionId);

    let previousChainDetail = null;
    let recentChainDetail = null;
    if (includeChains) {
        if (chainMatches.has(previous.id)) {
            const c = chainMatches.get(previous.id);
            previousChainDetail = { hits: c.chain, endUnix: c.end };
        }
        if (chainMatches.has(recent.id)) {
            const c = chainMatches.get(recent.id);
            recentChainDetail = { hits: c.chain, endUnix: c.end };
        }
    }

    return {
        ok: true,
        fromTs,
        toTs,
        previous,
        recent,
        includeChains,
        factionId,
        previousEnemyName,
        recentEnemyName,
        previousOfficialEndUnix: previous.end,
        recentOfficialEndUnix: recent.end,
        previousChainDetail,
        recentChainDetail
    };
}

function consumptionEscapeHtml(str) {
    if (str == null) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

function consumptionHideWarToWarPreview() {
    const el = document.getElementById('consumptionWarRangePreview');
    if (!el) return;
    el.hidden = true;
    el.innerHTML = '';
}

function consumptionPreviewChainLine(warLabel, enemyName, chainDetail, officialEndUnix, boundTs) {
    const enemy = consumptionEscapeHtml(enemyName || 'Unknown');
    if (chainDetail && chainDetail.hits != null) {
        const hits = consumptionEscapeHtml(String(chainDetail.hits));
        const through = consumptionEscapeHtml(consumptionFormatTctUtc(boundTs));
        return (
            `<li><span class="consumption-war-preset-preview-chain-war">${consumptionEscapeHtml(warLabel)} vs ${enemy}:</span> ` +
            `<span class="consumption-war-preset-preview-chain-include">Include ${hits} Chain</span> ` +
            `<span class="consumption-war-preset-preview-chain-through">(through ${through})</span></li>`
        );
    }
    const official = consumptionEscapeHtml(consumptionFormatTctUtc(officialEndUnix));
    return (
        `<li><span class="consumption-war-preset-preview-chain-war">${consumptionEscapeHtml(warLabel)} vs ${enemy}:</span> ` +
        `<span class="consumption-war-preset-preview-chain-none">No matching post-war chain</span> ` +
        `<span class="consumption-war-preset-preview-chain-through">(official end ${official})</span></li>`
    );
}

function consumptionRenderWarToWarPreviewFromOk(r, useExact) {
    const el = document.getElementById('consumptionWarRangePreview');
    const cb = document.getElementById('consumptionWarRangeIncludeChains');
    if (!el || !r || r.fromTs == null || r.toTs == null) return;
    if (!cb || !cb.checked) {
        consumptionHideWarToWarPreview();
        return;
    }
    const prevEnemy = r.previousEnemyName || 'Unknown';
    const latestEnemy = r.recentEnemyName || 'Unknown';
    const chainLines =
        '<div class="consumption-war-preset-preview-chains-head">Chains included per war (same “Include N Chain” rule as on each war card)</div>' +
        '<ul class="consumption-war-preset-preview-chains">' +
        consumptionPreviewChainLine(
            'Previous war',
            prevEnemy,
            r.previousChainDetail,
            r.previousOfficialEndUnix,
            r.fromTs
        ) +
        consumptionPreviewChainLine(
            'Latest war',
            latestEnemy,
            r.recentChainDetail,
            r.recentOfficialEndUnix,
            r.toTs
        ) +
        '</ul>';
    const precisionNote = useExact
        ? '<div class="consumption-war-preset-preview-precision">Time precision: <strong>exact</strong> war/chain timestamps to the second (VIP).</div>'
        : '<div class="consumption-war-preset-preview-precision">Time precision: <strong>full TCT calendar days</strong> (00:00:00 on the first day through 23:59:59 on the last day). Enable <strong>Exact war &amp; chain times</strong> with VIP 1+ for second-level bounds.</div>';
    el.hidden = false;
    el.innerHTML =
        '<div class="consumption-war-preset-preview-title">Apply would use this range (TCT / UTC)</div>' +
        '<div class="consumption-war-preset-preview-times">' +
        '<span class="consumption-war-preset-preview-k">From</span> ' +
        consumptionEscapeHtml(consumptionFormatTctUtc(r.fromTs)) +
        ' <span class="consumption-war-preset-preview-arrow">→</span> ' +
        '<span class="consumption-war-preset-preview-k">To</span> ' +
        consumptionEscapeHtml(consumptionFormatTctUtc(r.toTs)) +
        '</div>' +
        '<div class="consumption-war-preset-preview-meta">' +
        consumptionEscapeHtml(`Previous war vs ${prevEnemy} → Latest war vs ${latestEnemy}.`) +
        '</div>' +
        chainLines +
        precisionNote;
}

let consumptionWarPreviewDebounceId = null;

async function consumptionRefreshWarToWarPreview() {
    const el = document.getElementById('consumptionWarRangePreview');
    const cb = document.getElementById('consumptionWarRangeIncludeChains');
    if (!el) return;

    if (!cb || !cb.checked) {
        consumptionHideWarToWarPreview();
        return;
    }

    const apiKey = (localStorage.getItem('tornApiKey') || '').trim();
    if (!apiKey) {
        consumptionHideWarToWarPreview();
        return;
    }

    el.hidden = false;
    el.innerHTML = '<div class="consumption-war-preset-preview-loading">Loading preview…</div>';

    const includeChains = true;
    const r = await consumptionComputeWarToWarRange(apiKey, includeChains);
    if (!cb.checked) {
        consumptionHideWarToWarPreview();
        return;
    }
    if (!r.ok) {
        el.innerHTML = '<div class="consumption-war-preset-preview-error">' + consumptionEscapeHtml(r.message) + '</div>';
        return;
    }
    const useExact = consumptionUseExactWarTimesDesired();
    const rAdj = consumptionAdjustWarRangePrecision(r, useExact);
    consumptionRenderWarToWarPreviewFromOk(rAdj, useExact);
}

function consumptionScheduleWarToWarPreview() {
    if (consumptionWarPreviewDebounceId) clearTimeout(consumptionWarPreviewDebounceId);
    consumptionWarPreviewDebounceId = setTimeout(() => {
        consumptionWarPreviewDebounceId = null;
        consumptionRefreshWarToWarPreview();
    }, 300);
}

async function consumptionApplyWarToWarPreset() {
    const statusEl = document.getElementById('consumptionWarRangeStatus');
    const btn = document.getElementById('consumptionWarToWarPresetBtn');
    const includeChains = !!(document.getElementById('consumptionWarRangeIncludeChains') || {}).checked;

    const setStatus = (msg, isErr) => {
        if (statusEl) {
            statusEl.textContent = msg;
            statusEl.style.color = isErr ? '#f44336' : '#8bc34a';
        }
    };

    const apiKey = (localStorage.getItem('tornApiKey') || '').trim();
    if (!apiKey) {
        alert('Please enter your API key in the sidebar first.');
        return;
    }

    if (btn) btn.disabled = true;
    setStatus('Loading…', false);

    try {
        await consumptionResolveExactWarTimesVipAccess(apiKey);
        consumptionUpdateExactWarTimesVipUI();

        const r0 = await consumptionComputeWarToWarRange(apiKey, includeChains);
        if (!r0.ok) throw new Error(r0.message);

        const useExact = consumptionUseExactWarTimesDesired();
        const r = consumptionAdjustWarRangePrecision(r0, useExact);

        const a = consumptionUnixToYmdHms(r.fromTs);
        const b = consumptionUnixToYmdHms(r.toTs);
        consumptionPopulateTctTimeSelects();
        consumptionSetFlatpickrYmd('startDate', a.ymd);
        consumptionSetFlatpickrYmd('endDate', b.ymd);
        consumptionSetSelectByInt('consumptionStartHourTCT', a.h, 23);
        consumptionSetSelectByInt('consumptionStartMinTCT', a.m, 59);
        consumptionSetSelectByInt('consumptionStartSecTCT', a.s, 59);
        consumptionSetSelectByInt('consumptionEndHourTCT', b.h, 23);
        consumptionSetSelectByInt('consumptionEndMinTCT', b.m, 59);
        consumptionSetSelectByInt('consumptionEndSecTCT', b.s, 59);

        if (includeChains) {
            consumptionRenderWarToWarPreviewFromOk(r, useExact);
        } else {
            consumptionHideWarToWarPreview();
        }

        const prevLabel = r.previousEnemyName && r.previousEnemyName !== 'Unknown' ? `vs ${r.previousEnemyName}` : `war #${r.previous.id}`;
        const latestLabel = r.recentEnemyName && r.recentEnemyName !== 'Unknown' ? `vs ${r.recentEnemyName}` : `war #${r.recent.id}`;
        const prec = useExact ? ', exact times' : ', full calendar days';
        setStatus(
            `Applied (${prevLabel} → ${latestLabel}${includeChains ? ', chains' : ''}${prec}).`,
            false
        );
    } catch (e) {
        console.error('[CONSUMPTION] War preset:', e);
        setStatus(e.message || 'Failed', true);
        alert(e.message || 'Could not apply war range.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// --- Local cache for faction news (reduces API reads across different date ranges) ---
const CONSUMPTION_CACHE_KEY = 'consumption_news_cache';
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getConsumptionCache() {
    try {
        const raw = localStorage.getItem(CONSUMPTION_CACHE_KEY);
        if (!raw) return { segments: [] };
        const data = JSON.parse(raw);
        const now = Date.now();
        const segments = (data.segments || []).filter(s => s.cachedAt && (now - s.cachedAt) < CACHE_MAX_AGE_MS);
        return { segments };
    } catch (e) {
        console.warn('[CONSUMPTION CACHE] Failed to read cache:', e);
        return { segments: [] };
    }
}

function saveConsumptionCache(segments) {
    try {
        const toSave = segments.filter(s => s.fromTs != null && s.toTs != null && Array.isArray(s.entries));
        localStorage.setItem(CONSUMPTION_CACHE_KEY, JSON.stringify({ segments: toSave }));
    } catch (e) {
        console.warn('[CONSUMPTION CACHE] Failed to save cache:', e);
    }
}

/** Get all cached entries that fall within [rangeFrom, rangeTo]. Deduped by entry.id. */
function getCachedEntriesForRange(segments, rangeFrom, rangeTo) {
    const byId = new Map();
    for (const seg of segments) {
        if (seg.toTs < rangeFrom || seg.fromTs > rangeTo) continue;
        for (const entry of seg.entries || []) {
            const ts = entry.timestamp;
            if (ts >= rangeFrom && ts <= rangeTo && !byId.has(entry.id)) byId.set(entry.id, entry);
        }
    }
    return Array.from(byId.values());
}

/** Compute gaps in [rangeFrom, rangeTo] not covered by segments. Returns [{ fromTs, toTs }]. */
function getGapsForRange(segments, rangeFrom, rangeTo) {
    const overlapping = segments
        .filter(s => s.toTs >= rangeFrom && s.fromTs <= rangeTo)
        .map(s => ({ from: Math.max(s.fromTs, rangeFrom), to: Math.min(s.toTs, rangeTo) }))
        .sort((a, b) => a.from - b.from);
    if (overlapping.length === 0) return [{ fromTs: rangeFrom, toTs: rangeTo }];
    const gaps = [];
    let cur = rangeFrom;
    for (const seg of overlapping) {
        if (seg.from > cur) gaps.push({ fromTs: cur, toTs: seg.from - 1 });
        cur = Math.max(cur, seg.to + 1);
    }
    if (cur <= rangeTo) gaps.push({ fromTs: cur, toTs: rangeTo });
    return gaps;
}


/** Fetch all armory news for a single date range from the API. Returns array of entries.
 *  progressCallback(page, count, rangeProgressFraction) — fraction is 0–1 for how much of this range is covered.
 */
async function fetchNewsForRange(fromTimestamp, toTimestamp, apiKey, delayBetweenCalls, progressCallback) {
    const allNews = [];
    const seenEntryIds = new Set();
    let lastTimestamp = toTimestamp;
    let currentPage = 0;
    let hasMorePages = true;
    const rangeSpan = toTimestamp - fromTimestamp;

    while (hasMorePages) {
        currentPage++;
        if (currentPage > 100) break;

        const newsResponse = await fetch(`https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&to=${lastTimestamp}&from=${fromTimestamp}&cat=armoryAction&key=${apiKey}`);
        const newsData = await newsResponse.json();

        if (newsData.error) throw new Error(`Faction news API error: ${newsData.error.error}`);

        const news = newsData.news || [];
        if (news.length === 0) {
            hasMorePages = false;
            if (progressCallback) progressCallback(currentPage, allNews.length, 1);
        } else {
            const newEntries = news.filter(entry => {
                const isInRange = entry.timestamp >= fromTimestamp && entry.timestamp <= toTimestamp;
                const isDuplicate = seenEntryIds.has(entry.id);
                if (isInRange && !isDuplicate) {
                    seenEntryIds.add(entry.id);
                    return true;
                }
                return false;
            });
            if (newEntries.length === 0) hasMorePages = false;
            else {
                allNews.push(...newEntries);
                const oldestTimestamp = Math.min(...news.map(e => e.timestamp));
                lastTimestamp = oldestTimestamp - 1;
                const fraction = rangeSpan > 0 ? Math.min(1, (toTimestamp - lastTimestamp) / rangeSpan) : 1;
                if (progressCallback) progressCallback(currentPage, allNews.length, fraction);
                if (oldestTimestamp < fromTimestamp) hasMorePages = false;
                else await new Promise(r => setTimeout(r, delayBetweenCalls));
            }
        }
    }
    if (progressCallback) progressCallback(currentPage, allNews.length, 1);
    return allNews;
}

function initConsumptionTracker() {
    // Log tool usage
    if (window.logToolUsage) {
        window.logToolUsage('consumption-tracker');
    }

    const fetchBtn = document.getElementById('fetchData');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', handleConsumptionFetch);
    }

    if (!window._consumptionXanaxHitsSortClick) {
        window._consumptionXanaxHitsSortClick = true;
        document.addEventListener('click', e => {
            const el = e.target && e.target.closest && e.target.closest('[data-xanax-sort]');
            if (!el || !el.dataset || !el.dataset.xanaxSort) return;
            e.preventDefault();
            consumptionToggleXanaxHitsSort(el.dataset.xanaxSort);
            consumptionRefreshConsumptionUiFromCache();
        });
    }

    consumptionMigrateXanaxFlagRuleKeysOnce();
    if (!window._consumptionXanaxFlagLowListener) {
        window._consumptionXanaxFlagLowListener = true;
        document.addEventListener('change', e => {
            const t = e.target;
            if (!t) return;
            if (t.name === 'consumptionXanaxFlagCombine') {
                consumptionSetXanaxFlagCombineMode(t.value === 'and' ? 'and' : 'or');
                consumptionRefreshConsumptionUiFromCache();
                return;
            }
            if (!t.id) return;
            if (t.id === 'consumptionXanaxFlagUseMinHits') {
                consumptionSetXanaxFlagUseMinHits(!!t.checked);
                consumptionRefreshConsumptionUiFromCache();
                return;
            }
            if (t.id === 'consumptionXanaxFlagUsePerXanax') {
                consumptionSetXanaxFlagUsePerXanax(!!t.checked);
                consumptionRefreshConsumptionUiFromCache();
                return;
            }
            if (t.id === 'consumptionXanaxFlagMinHits') {
                consumptionSetXanaxFlagMinHits(t.value);
                consumptionRefreshConsumptionUiFromCache();
                return;
            }
            if (t.id === 'consumptionXanaxFlagPerXanax') {
                consumptionSetXanaxFlagPerXanax(t.value);
                consumptionRefreshConsumptionUiFromCache();
            }
        });
    }
    
    // Initialize date pickers using global function (same as War & Chain Reporter)
    setTimeout(() => {
        consumptionPopulateTctTimeSelects();
        window.consumptionExactWarTimesVipUnlocked = false;
        consumptionUpdateExactWarTimesVipUI();
        const apiKeyInit = (localStorage.getItem('tornApiKey') || '').trim();
        consumptionResolveExactWarTimesVipAccess(apiKeyInit).then(() => consumptionUpdateExactWarTimesVipUI());

        const warBtn = document.getElementById('consumptionWarToWarPresetBtn');
        if (warBtn && !warBtn.dataset.wired) {
            warBtn.dataset.wired = '1';
            warBtn.addEventListener('click', () => consumptionApplyWarToWarPreset());
        }
        const chainCb = document.getElementById('consumptionWarRangeIncludeChains');
        if (chainCb && !chainCb.dataset.previewWired) {
            chainCb.dataset.previewWired = '1';
            chainCb.addEventListener('change', () => {
                if (!chainCb.checked) {
                    if (consumptionWarPreviewDebounceId) clearTimeout(consumptionWarPreviewDebounceId);
                    consumptionWarPreviewDebounceId = null;
                    consumptionHideWarToWarPreview();
                } else {
                    consumptionScheduleWarToWarPreview();
                }
            });
        }
        const exactCb = document.getElementById('consumptionWarExactTimes');
        if (exactCb && !exactCb.dataset.previewWired) {
            exactCb.dataset.previewWired = '1';
            exactCb.addEventListener('change', () => {
                consumptionSyncHmsSectionVisibility();
                const c = document.getElementById('consumptionWarRangeIncludeChains');
                if (c && c.checked) consumptionScheduleWarToWarPreview();
            });
        }
        if (!window._consumptionWarPreviewKeyListener) {
            window._consumptionWarPreviewKeyListener = true;
            window.addEventListener('apiKeyUpdated', async (ev) => {
                const k = ev.detail && ev.detail.apiKey != null
                    ? String(ev.detail.apiKey).trim()
                    : (localStorage.getItem('tornApiKey') || '').trim();
                await consumptionResolveExactWarTimesVipAccess(k);
                consumptionUpdateExactWarTimesVipUI();
                const c = document.getElementById('consumptionWarRangeIncludeChains');
                if (c && c.checked) consumptionScheduleWarToWarPreview();
                else consumptionHideWarToWarPreview();
            });
        }
        consumptionRefreshWarToWarPreview();
        if (window.initDatePickers) {
            window.initDatePickers('startDate', 'endDate', {
                startDefaultDate: "today",
                endDefaultDate: "today"
            });
        } else {
            console.error('[CONSUMPTION TRACKER] window.initDatePickers is not available!');
        }
    }, 100);
}

const handleConsumptionFetch = async () => {
    const startTime = performance.now();
    let wasCached = false;

    let apiKey = localStorage.getItem('tornApiKey');
    if (!apiKey) {
        alert('Please enter your API key in the sidebar first');
        return;
    }
    
    const factionIdInput = document.getElementById('factionId');
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');
    const loadingSpinner = document.getElementById('loadingSpinner');
    const fetchBtn = document.getElementById('fetchData');
    const resultsSection = document.querySelector('.results-section');

    // No faction ID needed - the API key determines the faction

    consumptionPopulateTctTimeSelects();
    const useExactTimes = consumptionUseExactWarTimesDesired();
    const startHourEl = document.getElementById('consumptionStartHourTCT');
    const startMinEl = document.getElementById('consumptionStartMinTCT');
    const startSecEl = document.getElementById('consumptionStartSecTCT');
    const endHourEl = document.getElementById('consumptionEndHourTCT');
    const endMinEl = document.getElementById('consumptionEndMinTCT');
    const endSecEl = document.getElementById('consumptionEndSecTCT');

    let startHour;
    let startMin;
    let startSec;
    let endHour;
    let endMin;
    let endSec;
    if (useExactTimes) {
        startHour = startHourEl ? consumptionClampInt(startHourEl.value, 0, 23, 0) : 0;
        startMin = startMinEl ? consumptionClampInt(startMinEl.value, 0, 59, 0) : 0;
        startSec = startSecEl ? consumptionClampInt(startSecEl.value, 0, 59, 0) : 0;
        endHour = endHourEl ? consumptionClampInt(endHourEl.value, 0, 23, 23) : 23;
        endMin = endMinEl ? consumptionClampInt(endMinEl.value, 0, 59, 59) : 59;
        endSec = endSecEl ? consumptionClampInt(endSecEl.value, 0, 59, 59) : 59;
    } else {
        startHour = 0;
        startMin = 0;
        startSec = 0;
        endHour = 23;
        endMin = 59;
        endSec = 59;
    }

    // Handle date range (calendar dates from flatpickr + TCT/UTC time)
    let startDate = startDateInput.value.trim();
    let endDate = endDateInput.value.trim();

    if (!endDate) {
        endDate = consumptionUtcYmd();
        console.log(`No end date provided, using today (UTC): ${endDate}`);
    }

    const toTimestamp = consumptionTctInstantUnix(endDate, endHour, endMin, endSec);
    if (toTimestamp == null) {
        alert('Invalid end date. Use YYYY-MM-DD from the date picker.');
        return;
    }

    let fromTimestamp = null;
    if (startDate) {
        fromTimestamp = consumptionTctInstantUnix(startDate, startHour, startMin, startSec);
        if (fromTimestamp == null) {
            alert('Invalid start date. Use YYYY-MM-DD from the date picker.');
            return;
        }
        console.log(`Start (TCT/UTC): ${consumptionFormatTctUtc(fromTimestamp)}`);
    } else {
        const t = new Date();
        const midnightUtc = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, 0, 0);
        fromTimestamp = Math.floor(midnightUtc / 1000) - 30 * 24 * 60 * 60;
        console.log('No start date: using 30 days before today’s UTC midnight');
    }

    if (fromTimestamp > toTimestamp) {
        alert('Start date and time must be before end date and time (TCT / UTC).');
        return;
    }

    console.log(`Final range (TCT/UTC): ${consumptionFormatTctUtc(fromTimestamp)} → ${consumptionFormatTctUtc(toTimestamp)}`);

    try {
        if (loadingSpinner) loadingSpinner.style.display = 'inline-block';
        if (fetchBtn) fetchBtn.disabled = true;

        console.log('Fetching consumption data for faction (from API key)');
        console.log('Date range (TCT/UTC):', consumptionFormatTctUtc(fromTimestamp), 'to', consumptionFormatTctUtc(toTimestamp));
        
        // Get API key from localStorage
        const apiKey = localStorage.getItem('tornApiKey');
        if (!apiKey) {
            throw new Error('API key not found. Please set your Torn API key in the main page.');
        }
        
        // Step 0: Fetch item market values from Torn API
        console.log('Fetching item market values...');
        const itemsResponse = await fetch(`https://api.torn.com/torn/?selections=items&key=${apiKey}`);
        const itemsData = await itemsResponse.json();
        
        if (itemsData.error) {
            throw new Error(`Items API error: ${itemsData.error.error}`);
        }
        
        // Create item value and type mapping
        const itemValues = {};
        const itemTypes = {};
        const consumableItems = {};
        
        // Filter for consumable items and get their market values and types
        Object.values(itemsData.items).forEach(item => {
            // Only include consumable items (exclude weapons, armor, etc.)
            if (item.type && item.type !== 'Weapon' && item.type !== 'Armor' && item.type !== 'Temporary' && item.type !== 'Special') {
                consumableItems[item.name] = {
                    name: item.name,
                    type: item.type,
                    market_value: item.market_value || 0
                };
                
                                       // Map common item names to their API names
                       const itemNameMapping = {
                           'Xanax': 'Xanax',
                           'Vicodin': 'Vicodin',
                           'Ketamine': 'Ketamine',
                           'Speed': 'Speed',
                           'Shrooms': 'Shrooms',
                           'Cannabis': 'Cannabis',
                           'PCP': 'PCP',
                           'Opium': 'Opium',
                           'Ecstasy': 'Ecstasy',
                           'LSD': 'LSD',
                           'Love Juice': 'Love Juice',
                           'Blood Bag': 'Blood Bag', // This will be calculated as average of all blood bag types
                           'First Aid Kit': 'First Aid Kit',
                           'Small First Aid Kit': 'Small First Aid Kit',
                           'Morphine': 'Morphine',
                           'Ipecac Syrup': 'Ipecac Syrup',
                           'Bottle of Beer': 'Bottle of Beer',
                           'Lollipop': 'Lollipop',
                           'Box of Sweet Hearts': 'Box of Sweet Hearts',
                           // Energy Cans
                           'Can of Goose Juice': 'Can of Goose Juice',
                           'Can of Damp Valley': 'Can of Damp Valley',
                           'Can of Crocozade': 'Can of Crocozade',
                           'Can of Santa Shooters': 'Can of Santa Shooters',
                           'Can of Munster': 'Can of Munster',
                           'Can of Red Cow': 'Can of Red Cow',
                           'Can of Rockstar Rudolph': 'Can of Rockstar Rudolph',
                           'Can of Taurine Elite': 'Can of Taurine Elite',
                           'Can of X-MASS': 'Can of X-MASS'
                       };
                
                if (itemNameMapping[item.name]) {
                    itemValues[itemNameMapping[item.name]] = item.market_value || 0;
                    itemTypes[itemNameMapping[item.name]] = item.type;
                    console.log(`Found item: ${item.name} - Type: ${item.type} - Market Value: ${item.market_value}`);
                }
            }
        });
        
        // Calculate average blood bag value from all blood bag types
        const bloodBagItems = Object.values(itemsData.items).filter(item => 
            item.name.includes('Blood Bag') && item.market_value > 0 && item.type && item.type !== 'Weapon' && item.type !== 'Armor'
        );
        
        if (bloodBagItems.length > 0) {
            const totalBloodBagValue = bloodBagItems.reduce((sum, item) => sum + item.market_value, 0);
            const averageBloodBagValue = Math.round(totalBloodBagValue / bloodBagItems.length);
            itemValues['Blood Bag'] = averageBloodBagValue;
            itemTypes['Blood Bag'] = bloodBagItems[0].type; // Use the type from the first blood bag
            console.log(`Found ${bloodBagItems.length} blood bag types, average value: ${averageBloodBagValue}, type: ${bloodBagItems[0].type}`);
            bloodBagItems.forEach(item => {
                console.log(`  - ${item.name}: ${item.market_value} (${item.type})`);
            });
        } else {
            console.warn('No blood bag items found in the API response');
        }
        
                       // Log any missing items
               const itemNameMapping = {
                   'Xanax': 'Xanax',
                   'Blood Bag': 'Blood Bag', // Special handling - calculated as average of all blood bag types
                   'First Aid Kit': 'First Aid Kit',
                   'Small First Aid Kit': 'Small First Aid Kit',
                   'Morphine': 'Morphine',
                   'Ipecac Syrup': 'Ipecac Syrup',
                   'Bottle of Beer': 'Bottle of Beer',
                   'Lollipop': 'Lollipop',
                   'Box of Sweet Hearts': 'Box of Sweet Hearts',
                   // Energy Cans
                   'Can of Goose Juice': 'Can of Goose Juice',
                   'Can of Damp Valley': 'Can of Damp Valley',
                   'Can of Crocozade': 'Can of Crocozade',
                   'Can of Santa Shooters': 'Can of Santa Shooters',
                   'Can of Munster': 'Can of Munster',
                   'Can of Red Cow': 'Can of Red Cow',
                   'Can of Rockstar Rudolph': 'Can of Rockstar Rudolph',
                   'Can of Taurine Elite': 'Can of Taurine Elite',
                   'Can of X-MASS': 'Can of X-MASS'
               };
        
        Object.keys(itemNameMapping).forEach(itemName => {
            if (!itemValues[itemName]) {
                console.warn(`Warning: Could not find market value for ${itemName}`);
            }
        });
        
        console.log('Item types mapping:', itemTypes);
        console.log('Consumable items found:', Object.keys(consumableItems).length);
        
        console.log('Item values mapping:', itemValues);
        
        // Fetch points market to get current market value for points
        console.log('Fetching points market data...');
        try {
            const pointsMarketResponse = await fetch(`https://api.torn.com/market/?selections=pointsmarket&key=${apiKey}`);
            const pointsMarketData = await pointsMarketResponse.json();
            
            if (pointsMarketData.error) {
                console.warn('Points market API error:', pointsMarketData.error.error);
                console.warn('Points will be tracked without market value');
            } else if (pointsMarketData.pointsmarket) {
                // Get all listings and sort by cost (ascending)
                const listings = Object.values(pointsMarketData.pointsmarket);
                const sortedListings = listings.sort((a, b) => a.cost - b.cost);
                
                // Get the 5th lowest priced listing (index 4)
                if (sortedListings.length >= 5) {
                    const fifthLowest = sortedListings[4];
                    const pointsMarketValue = fifthLowest.cost;
                    itemValues['Points'] = pointsMarketValue;
                    itemTypes['Points'] = 'Points';
                    console.log(`Points market value (5th lowest): $${pointsMarketValue.toLocaleString()} per point`);
                    console.log(`Listing details: ${fifthLowest.quantity} points at $${fifthLowest.cost.toLocaleString()} each (total: $${fifthLowest.total_cost.toLocaleString()})`);
                } else {
                    console.warn(`Not enough points market listings (found ${sortedListings.length}, need at least 5). Using lowest available.`);
                    if (sortedListings.length > 0) {
                        const lowest = sortedListings[0];
                        const pointsMarketValue = lowest.cost;
                        itemValues['Points'] = pointsMarketValue;
                        itemTypes['Points'] = 'Points';
                        console.log(`Points market value (lowest available): $${pointsMarketValue.toLocaleString()} per point`);
                    }
                }
            }
        } catch (error) {
            console.warn('Error fetching points market:', error);
            console.warn('Points will be tracked without market value');
        }
        
        // Use global rate limit setting (from welcome message area)
        // The global rate limit is managed by app.js and stored in localStorage
        // We'll use the dynamic interval that's already calculated
        const delayBetweenCalls = window.CALL_INTERVAL_MS || 667; // Default to 667ms if not set
        
        console.log(`Using global rate limit: ${delayBetweenCalls}ms between calls`);
        
        // Step 1: Fetch faction news — use local cache, then fetch only gaps
        const progressContainer = document.getElementById('progressContainer');
        const progressMessage = document.getElementById('progressMessage');
        const progressPercentage = document.getElementById('progressPercentage');
        const progressFill = document.getElementById('progressFill');
        const progressDetails = document.getElementById('progressDetails');
        const daysDiff = Math.ceil((toTimestamp - fromTimestamp) / (24 * 60 * 60));
        
        if (progressContainer) {
            progressContainer.style.display = 'block';
            progressMessage.textContent = daysDiff > 30 ? `Fetching consumption data for ${daysDiff} days (this may take a while)...` : daysDiff > 7 ? `Fetching consumption data for ${daysDiff} days...` : 'Fetching consumption data...';
            progressDetails.textContent = 'Checking cache...';
        }

        const cache = getConsumptionCache();
        let cachedEntries = getCachedEntriesForRange(cache.segments, fromTimestamp, toTimestamp);
        const gaps = getGapsForRange(cache.segments, fromTimestamp, toTimestamp);

        let allNews = cachedEntries;
        const newSegments = [];

        const totalGaps = gaps.length;
        for (let g = 0; g < totalGaps; g++) {
            const gap = gaps[g];
            if (progressContainer) {
                const pct = totalGaps > 0 ? Math.round((g / totalGaps) * 100) : 0;
                progressPercentage.textContent = `${pct}%`;
                progressFill.style.width = `${pct}%`;
                progressDetails.textContent = totalGaps > 1 ? `Fetching date range ${g + 1} of ${totalGaps}...` : 'Fetching from API...';
            }
            const gapEntries = await fetchNewsForRange(gap.fromTs, gap.toTs, apiKey, delayBetweenCalls, (page, count, rangeFraction) => {
                if (progressContainer) {
                    const frac = typeof rangeFraction === 'number' ? rangeFraction : 0;
                    const overall = totalGaps > 0 ? ((g + frac) / totalGaps) * 100 : 100;
                    progressPercentage.textContent = `${Math.round(overall)}%`;
                    progressFill.style.width = `${overall}%`;
                    progressDetails.textContent = totalGaps > 1 ? `Fetching date range ${g + 1} of ${totalGaps} (page ${page}, ${count} entries)...` : `Fetching data... (page ${page}, ${count} entries)`;
                }
            });
            if (gapEntries.length > 0) {
                newSegments.push({
                    fromTs: gap.fromTs,
                    toTs: gap.toTs,
                    entries: gapEntries,
                    cachedAt: Date.now()
                });
            }
            const byId = new Map(allNews.map(e => [e.id, e]));
            gapEntries.forEach(e => { if (!byId.has(e.id)) byId.set(e.id, e); });
            allNews = Array.from(byId.values());
        }

        allNews.sort((a, b) => a.timestamp - b.timestamp);

        if (newSegments.length > 0) {
            const now = Date.now();
            const kept = cache.segments.filter(s => s.cachedAt && (now - s.cachedAt) < CACHE_MAX_AGE_MS);
            saveConsumptionCache(kept.concat(newSegments));
        }
        if (cachedEntries.length > 0 && gaps.length === 0) wasCached = true;

        if (progressContainer) {
            progressMessage.textContent = 'Processing consumption data...';
            progressPercentage.textContent = '100%';
            progressFill.style.width = '100%';
            progressDetails.textContent = `Processing ${allNews.length} entries...`;
        }
        
        // Step 2: Filter and process consumption events
        console.log('Processing consumption events...');
        const playerConsumption = {};
        let processedCount = 0;
        
        for (const newsEntry of allNews) {
            processedCount++;
            if (processedCount % 10 === 0 && progressContainer) {
                    progressDetails.textContent = `Processing ${processedCount}/${allNews.length} entries...`;
            }
            
            const logText = newsEntry.text || '';
            const timestamp = newsEntry.timestamp;
            
            // Extract player name and ID from the log text (handles HTML tags)
            // Format: "<a href="http://www.torn.com/profiles.php?XID=1234567">PlayerName</a> used one of the faction's ItemName items"
            const playerMatch = logText.match(/<a href[^>]*XID=(\d+)[^>]*>([^<]+)<\/a>/);
            if (!playerMatch) continue;
            
            const playerId = playerMatch[1];
            const playerName = playerMatch[2];
            
            // Initialize player consumption object if not exists
            if (!playerConsumption[playerName]) {
                playerConsumption[playerName] = {
                    name: playerName,
                    id: playerId,
                    xanax: 0,
                    vicodin: 0,
                    ketamine: 0,
                    speed: 0,
                    shrooms: 0,
                    cannabis: 0,
                    pcp: 0,
                    opium: 0,
                    ecstasy: 0,
                    lsd: 0,
                    loveJuice: 0,
                    bloodbags: 0,
                    firstAidKit: 0,
                    smallFirstAidKit: 0,
                    morphine: 0,
                    ipecacSyrup: 0,
                    beer: 0,
                    lollipop: 0,
                    sweetHearts: 0,
                    // Energy Cans
                    gooseJuice: 0,
                    dampValley: 0,
                    crocozade: 0,
                    santaShooters: 0,
                    munster: 0,
                    redCow: 0,
                    rockstarRudolph: 0,
                    taurineElite: 0,
                    xmass: 0,
                    points: 0
                };
            }
            
            // Count consumption by item type based on the API response format
            // Only count "used" events, not "gave" events
            if (logText.includes('used one of the faction\'s Xanax items')) {
                playerConsumption[playerName].xanax++;
            } else if (logText.includes('used one of the faction\'s Vicodin items')) {
                playerConsumption[playerName].vicodin++;
            } else if (logText.includes('used one of the faction\'s Ketamine items')) {
                playerConsumption[playerName].ketamine++;
            } else if (logText.includes('used one of the faction\'s Speed items')) {
                playerConsumption[playerName].speed++;
            } else if (logText.includes('used one of the faction\'s Shrooms items')) {
                playerConsumption[playerName].shrooms++;
            } else if (logText.includes('used one of the faction\'s Cannabis items')) {
                playerConsumption[playerName].cannabis++;
            } else if (logText.includes('used one of the faction\'s PCP items')) {
                playerConsumption[playerName].pcp++;
            } else if (logText.includes('used one of the faction\'s Opium items')) {
                playerConsumption[playerName].opium++;
            } else if (logText.includes('used one of the faction\'s Ecstasy items')) {
                playerConsumption[playerName].ecstasy++;
            } else if (logText.includes('used one of the faction\'s LSD items')) {
                playerConsumption[playerName].lsd++;
            } else if (logText.includes('used one of the faction\'s Love Juice items')) {
                playerConsumption[playerName].loveJuice++;
            } else if (logText.includes('used one of the faction\'s Blood Bag') || 
                       logText.includes('used one of the faction\'s Blood Bag : A+') ||
                       logText.includes('used one of the faction\'s Blood Bag : A-') ||
                       logText.includes('used one of the faction\'s Blood Bag : AB+') ||
                       logText.includes('used one of the faction\'s Blood Bag : AB-') ||
                       logText.includes('used one of the faction\'s Blood Bag : B+') ||
                       logText.includes('used one of the faction\'s Blood Bag : B-') ||
                       logText.includes('used one of the faction\'s Blood Bag : O+') ||
                       logText.includes('used one of the faction\'s Blood Bag : O-') ||
                       logText.includes('used one of the faction\'s Empty Blood Bag')) {
                playerConsumption[playerName].bloodbags++;
            } else if (logText.includes('used one of the faction\'s First Aid Kit items') && !logText.includes('Small')) {
                playerConsumption[playerName].firstAidKit++;
            } else if (logText.includes('used one of the faction\'s Small First Aid Kit items')) {
                playerConsumption[playerName].smallFirstAidKit++;
            } else if (logText.includes('used one of the faction\'s Morphine items')) {
                playerConsumption[playerName].morphine++;
            } else if (logText.includes('used one of the faction\'s Ipecac Syrup items')) {
                playerConsumption[playerName].ipecacSyrup++;
            } else if (logText.includes('used one of the faction\'s Bottle of Beer items')) {
                playerConsumption[playerName].beer++;
            } else if (logText.includes('used one of the faction\'s Lollipop items')) {
                playerConsumption[playerName].lollipop++;
            } else if (logText.includes('used one of the faction\'s Box of Sweet Hearts items')) {
                playerConsumption[playerName].sweetHearts++;
            }
            // Energy Cans
            else if (logText.includes('used one of the faction\'s Can of Goose Juice items')) {
                playerConsumption[playerName].gooseJuice++;
            } else if (logText.includes('used one of the faction\'s Can of Damp Valley items')) {
                playerConsumption[playerName].dampValley++;
            } else if (logText.includes('used one of the faction\'s Can of Crocozade items')) {
                playerConsumption[playerName].crocozade++;
            } else if (logText.includes('used one of the faction\'s Can of Santa Shooters items')) {
                playerConsumption[playerName].santaShooters++;
            } else if (logText.includes('used one of the faction\'s Can of Munster items')) {
                playerConsumption[playerName].munster++;
            } else if (logText.includes('used one of the faction\'s Can of Red Cow items')) {
                playerConsumption[playerName].redCow++;
            } else if (logText.includes('used one of the faction\'s Can of Rockstar Rudolph items')) {
                playerConsumption[playerName].rockstarRudolph++;
            } else if (logText.includes('used one of the faction\'s Can of Taurine Elite items')) {
                playerConsumption[playerName].taurineElite++;
            } else if (logText.includes('used one of the faction\'s Can of X-MASS items')) {
                playerConsumption[playerName].xmass++;
            }
            // Points consumption - extract the number of points used
            else if (logText.includes('used') && logText.includes('of the faction\'s points')) {
                const pointsMatch = logText.match(/used\s+(\d+)\s+of\s+the\s+faction's\s+points/);
                if (pointsMatch) {
                    const pointsAmount = parseInt(pointsMatch[1], 10);
                    playerConsumption[playerName].points += pointsAmount;
                }
            }
        }
        
        const consumptionMembers = Object.values(playerConsumption);
        
        // Store the fetched data
        consumptionTrackerData.fetchedMembers = consumptionMembers;
        
        const totalTime = performance.now() - startTime;
        
        // Store item values for UI
        consumptionTrackerData.itemValues = itemValues;

        // War / chain hits live in Member Performance (`mpr-war-chain-hits.js`), not this tool.
        
        // Hide progress bar
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
        
        // Update UI with the data
        updateConsumptionUI(consumptionMembers, totalTime, null, wasCached, itemValues, fromTimestamp, toTimestamp, itemTypes);
        
        // Show results section
        if (resultsSection) {
            resultsSection.style.display = 'block';
        }

    } catch (error) {
        console.error('Error fetching consumption data:', error);
        
        // Check if it's an access level error
        if (error.message && error.message.includes('Access level of this key is not high enough')) {
            alert('⚠️ Insufficient API Key Permissions\n\n' +
                  'Your API key doesn\'t have the required access level.\n\n' +
                  'This tool requires a Limited or Full access API key to access personal data.\n\n' +
                  'To fix this:\n' +
                  '1. Go to Torn Preferences → API\n' +
                  '2. Create a new API key or edit your existing key\n' +
                  '3. Set the access level to Limited or Full\n' +
                  '4. Copy the new key and enter it in the API Key field');
        } else {
        alert('Error fetching consumption data: ' + error.message);
        }
    } finally {
        if (loadingSpinner) loadingSpinner.style.display = 'none';
        if (fetchBtn) fetchBtn.disabled = false;
    }
};

function sortConsumptionMembers(members, sortColumn, sortDirection) {
    return members.sort((a, b) => {
        if (sortColumn === 'name') {
            const aValue = a.name.toLowerCase();
            const bValue = b.name.toLowerCase();
            if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
            if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
            return 0;
        } else {
            const aValue = a[sortColumn] || 0;
            const bValue = b[sortColumn] || 0;
            return sortDirection === 'desc' ? bValue - aValue : aValue - bValue;
        }
    });
}

function updateConsumptionUI(members, totalTime, cacheStats, wasCached, itemValues = {}, fromTimestamp = null, toTimestamp = null, itemTypes = {}) {
    consumptionMigrateXanaxFlagRuleKeysOnce();
    // Store data globally for CSV export
    consumptionTrackerData = {
        members: members,
        fetchedMembers: members,
        totalTime: totalTime,
        cacheStats: cacheStats,
        wasCached: wasCached,
        itemValues: itemValues,
        fromTimestamp: fromTimestamp,
        toTimestamp: toTimestamp,
        itemTypes: itemTypes
    };
    window.consumptionTrackerData = consumptionTrackerData;
    
    const resultsSection = document.querySelector('.results-section');
    const tableContainer = document.getElementById('membersTable');
    
    if (!resultsSection || !tableContainer) {
        console.error('Required elements not found:', {
            resultsSection: !!resultsSection,
            tableContainer: !!tableContainer
        });
        return;
    }
    
    /** Preserve open "Players" lists across UI rebuild (e.g. Xanax flag toggles refresh the table). */
    const expandedPlayerListItems = new Set();
    tableContainer.querySelectorAll('.players-list[data-item]').forEach(el => {
        const id = el.getAttribute('data-item');
        if (!id) return;
        if (el.style.display === 'block') expandedPlayerListItems.add(id);
    });
    
               // Define columns for the table
           const columns = [
               { id: 'xanax', label: 'Xanax', itemName: 'Xanax' },
               { id: 'vicodin', label: 'Vicodin', itemName: 'Vicodin' },
               { id: 'ketamine', label: 'Ketamine', itemName: 'Ketamine' },
               { id: 'speed', label: 'Speed', itemName: 'Speed' },
               { id: 'shrooms', label: 'Shrooms', itemName: 'Shrooms' },
               { id: 'cannabis', label: 'Cannabis', itemName: 'Cannabis' },
               { id: 'pcp', label: 'PCP', itemName: 'PCP' },
               { id: 'opium', label: 'Opium', itemName: 'Opium' },
               { id: 'ecstasy', label: 'Ecstasy', itemName: 'Ecstasy' },
               { id: 'lsd', label: 'LSD', itemName: 'LSD' },
               { id: 'loveJuice', label: 'Love Juice', itemName: 'Love Juice' },
               { id: 'bloodbags', label: 'Blood Bags', itemName: 'Blood Bag' },
               { id: 'firstAidKit', label: 'First Aid Kit', itemName: 'First Aid Kit' },
               { id: 'smallFirstAidKit', label: 'Small First Aid Kit', itemName: 'Small First Aid Kit' },
               { id: 'morphine', label: 'Morphine', itemName: 'Morphine' },
               { id: 'ipecacSyrup', label: 'Ipecac Syrup', itemName: 'Ipecac Syrup' },
               { id: 'beer', label: 'Bottle of Beer', itemName: 'Bottle of Beer' },
               { id: 'lollipop', label: 'Lollipop', itemName: 'Lollipop' },
               { id: 'sweetHearts', label: 'Box of Sweet Hearts', itemName: 'Box of Sweet Hearts' },
               // Energy Cans
               { id: 'gooseJuice', label: 'Can of Goose Juice', itemName: 'Can of Goose Juice' },
               { id: 'dampValley', label: 'Can of Damp Valley', itemName: 'Can of Damp Valley' },
               { id: 'crocozade', label: 'Can of Crocozade', itemName: 'Can of Crocozade' },
               { id: 'santaShooters', label: 'Can of Santa Shooters', itemName: 'Can of Santa Shooters' },
               { id: 'munster', label: 'Can of Munster', itemName: 'Can of Munster' },
               { id: 'redCow', label: 'Can of Red Cow', itemName: 'Can of Red Cow' },
               { id: 'rockstarRudolph', label: 'Can of Rockstar Rudolph', itemName: 'Can of Rockstar Rudolph' },
               { id: 'taurineElite', label: 'Can of Taurine Elite', itemName: 'Can of Taurine Elite' },
               { id: 'xmass', label: 'Can of X-MASS', itemName: 'Can of X-MASS' },
               { id: 'points', label: 'Points', itemName: 'Points', isPoints: true }
           ];
    
    // Group items by type
    const groupedItems = {};
    columns.forEach(col => {
        // Points don't have a market value, so give them their own category
        const itemType = col.isPoints ? 'Points' : (itemTypes[col.itemName] || 'Unknown');
        if (!groupedItems[itemType]) {
            groupedItems[itemType] = [];
        }
        groupedItems[itemType].push(col);
    });
    
    // Calculate totals and costs
    const totals = {};
    const totalValues = {};
    columns.forEach(col => {
        totals[col.id] = members.reduce((sum, member) => sum + (member[col.id] || 0), 0);
        // Points use market value from points market API if available
        const itemValue = col.isPoints ? (itemValues['Points'] || 0) : (itemValues[col.itemName] || 0);
        totalValues[col.id] = totals[col.id] * itemValue;
    });
    
               // Calculate group totals (only for items with usage)
           const groupTotals = {};
           const groupValues = {};
           const groupItemsWithUsage = {};
           Object.keys(groupedItems).forEach(groupType => {
               groupTotals[groupType] = 0;
               groupValues[groupType] = 0;
               groupItemsWithUsage[groupType] = [];
               groupedItems[groupType].forEach(col => {
                   if (totals[col.id] > 0) {
                       groupTotals[groupType] += totals[col.id];
                       groupValues[groupType] += totalValues[col.id];
                       groupItemsWithUsage[groupType].push(col);
                   }
               });
           });
    
    // Create summary section with group totals
    const summarySection = document.createElement('div');
    summarySection.className = 'summary-section';
    
    const rangeLabel =
        fromTimestamp != null && toTimestamp != null
            ? `${consumptionFormatTctUtc(fromTimestamp)} → ${consumptionFormatTctUtc(toTimestamp)}`
            : '—';
    
    // Calculate total value
    const totalValue = Object.values(totalValues).reduce((sum, cost) => sum + cost, 0);
    
    // Create summary grid with group totals
    let summaryHTML = `
        <div class="summary-grid">
            <div class="summary-item">
                <span class="summary-label">Time range (TCT / UTC):</span>
                <span class="summary-value" style="font-size:0.95em;">${rangeLabel}</span>
            </div>
            <div class="summary-item">
                <span class="summary-label">Total Value:</span>
                <span class="summary-value">$${totalValue.toLocaleString()}</span>
            </div>
        </div>
        <div class="group-summary">
            <h4>Group Totals:</h4>
            <div class="group-summary-grid">
    `;
    
               Object.keys(groupedItems).forEach(groupType => {
               // Only show groups that have items with usage
               if (groupItemsWithUsage[groupType].length > 0) {
                   summaryHTML += `
                       <div class="group-summary-item">
                           <span class="group-summary-label">${groupType}:</span>
                           <span class="group-summary-value">$${groupValues[groupType].toLocaleString()}</span>
                       </div>
                   `;
               }
           });
    
    summaryHTML += `
            </div>
        </div>
        <div class="consumption-summary-options" style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,215,0,0.15);display:flex;align-items:center;flex-wrap:wrap;gap:12px;">
            <label class="tools-member-id-cb-label" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:#ccc;font-size:13px;">
                <input type="checkbox" class="tools-show-member-id-cb" ${window.toolsGetShowMemberIdInBrackets() ? 'checked' : ''} style="accent-color:#ffd700;" />
                Show player <strong>Name [ID]</strong> in lists (like Torn)
            </label>
        </div>
    `;
    
    summarySection.innerHTML = summaryHTML;
    
    // Create grouped interface
    const groupedContainer = document.createElement('div');
    groupedContainer.className = 'grouped-container';
    
               Object.keys(groupedItems).forEach(groupType => {
               // Only create groups that have items with usage
               if (groupItemsWithUsage[groupType].length === 0) {
                   return;
               }
               
               const groupSection = document.createElement('div');
               groupSection.className = 'group-section';
               groupSection.dataset.groupType = groupType;
               
               // Create group header (collapsible)
               const groupHeader = document.createElement('div');
               groupHeader.className = 'group-header';
               groupHeader.innerHTML = `
                   <div class="group-header-content">
                       <span class="group-toggle">▼</span>
                       <h3 class="group-title">${groupType}</h3>
                       <span class="group-total">$${groupValues[groupType].toLocaleString()}</span>
                   </div>
               `;
               
               // Create group content (initially collapsed)
               const groupContent = document.createElement('div');
               groupContent.className = 'group-content';
               groupContent.style.display = 'none';
               
               // Add items in this group (only if they have usage)
               groupedItems[groupType].forEach(col => {
                   const itemTotal = totals[col.id];
                   
                   // Skip items with zero usage
                   if (itemTotal === 0) {
                       return;
                   }
                   
                   const itemSection = document.createElement('div');
                   itemSection.className = 'item-section';
                   
                   const itemValue = totalValues[col.id];
                   const itemPrice = col.isPoints ? (itemValues['Points'] || 0) : (itemValues[col.itemName] || 0);
                   
                   // Find players who used this item and sort by quantity (descending)
                   const playersWhoUsed = members
                       .filter(member => member[col.id] > 0)
                       .sort((a, b) => b[col.id] - a[col.id]); // Sort by quantity descending
                   
                   // For points, show price/value if market value is available
                   let statsHTML = col.isPoints && itemPrice > 0
                       ? `<span class="item-total">Total: ${itemTotal} points</span>
                          <span class="item-value">Value: $${itemValue.toLocaleString()}</span>
                          <span class="item-price">Price: $${itemPrice.toLocaleString()} per point</span>`
                       : col.isPoints
                       ? `<span class="item-total">Total: ${itemTotal} points</span>`
                       : `<span class="item-total">Total: ${itemTotal}</span>
                          <span class="item-value">Value: $${itemValue.toLocaleString()}</span>
                          <span class="item-price">Price: $${itemPrice.toLocaleString()}</span>`;
                   
                   const showWarChain = false;
                   const useMinRule = consumptionGetXanaxFlagUseMinHits();
                   const usePerRule = consumptionGetXanaxFlagUsePerXanax();
                   const combineMode = consumptionGetXanaxFlagCombineMode();
                   const xanaxCombineBlock =
                       useMinRule && usePerRule
                           ? `<div class="consumption-xanax-hits-toolbar-combine" role="radiogroup" aria-label="Combine the two flag rules">
                                <span class="consumption-xanax-hits-toolbar-combine-hint" title="AND: both rules must pass (attacks high enough for each) to avoid a flag — failing either rule flags the row. OR: passing either rule is enough to avoid a flag — only failing both rules flags the row.">Combine</span>
                                <label class="consumption-xanax-hits-toolbar-radio"><input type="radio" id="consumptionXanaxFlagCombineOr" name="consumptionXanaxFlagCombine" value="or" ${combineMode === 'or' ? 'checked' : ''} />OR</label>
                                <label class="consumption-xanax-hits-toolbar-radio"><input type="radio" id="consumptionXanaxFlagCombineAnd" name="consumptionXanaxFlagCombine" value="and" ${combineMode === 'and' ? 'checked' : ''} />AND</label>
                              </div>`
                           : '';
                   const xanaxHitsToolbar = showWarChain
                       ? `<div class="consumption-xanax-hits-toolbar">
                            <label class="consumption-xanax-hits-toolbar-line" title="When enabled, highlights rows if total attacks are below the number. Use 0 to skip this threshold. Saved in this browser.">
                                <input type="checkbox" id="consumptionXanaxFlagUseMinHits" ${useMinRule ? 'checked' : ''} />
                                <span class="consumption-xanax-hits-toolbar-line-label">Minimum Flagged Hits</span>
                                <input type="number" id="consumptionXanaxFlagMinHits" class="consumption-xanax-hits-toolbar-in" min="0" max="999999" step="1" value="${consumptionGetXanaxFlagMinHits()}" ${useMinRule ? '' : 'disabled'} />
                            </label>
                            ${xanaxCombineBlock}
                            <label class="consumption-xanax-hits-toolbar-line" title="When enabled, highlights rows if total attacks are below (factor × Xanax quantity). Use 0 to skip this threshold.">
                                <input type="checkbox" id="consumptionXanaxFlagUsePerXanax" ${usePerRule ? 'checked' : ''} />
                                <span class="consumption-xanax-hits-toolbar-line-label">Minimum Hits Per Xanax</span>
                                <input type="number" id="consumptionXanaxFlagPerXanax" class="consumption-xanax-hits-toolbar-in" min="0" max="500" step="1" value="${consumptionGetXanaxFlagPerXanax()}" ${usePerRule ? '' : 'disabled'} />
                            </label>
                          </div>`
                       : '';
                   const warChainListHead = showWarChain
                       ? `<div class="consumption-players-list-head">
                               <span class="consumption-players-list-head-name consumption-xanax-hits-sort-h consumption-xanax-hits-sort-h--player" data-xanax-sort="name" title="Sort by player name">Player${consumptionXanaxHitsSortIndicator('name')}</span>
                               <span class="consumption-players-list-head-metric consumption-xanax-hits-sort-h" data-xanax-sort="war" title="Sort by ranked war hits">War${consumptionXanaxHitsSortIndicator('war')}</span>
                               <span class="consumption-players-list-head-metric consumption-xanax-hits-sort-h" data-xanax-sort="outside" title="Sort by outside (chain) hits">OUTSIDE${consumptionXanaxHitsSortIndicator('outside')}</span>
                               <span class="consumption-players-list-head-metric consumption-xanax-hits-sort-h" data-xanax-sort="total" title="Sort by total attacks (war + outside)">Total${consumptionXanaxHitsSortIndicator('total')}</span>
                               <span class="consumption-players-list-head-metric consumption-xanax-hits-sort-h" data-xanax-sort="xanax" title="Sort by Xanax quantity">XAN QTY${consumptionXanaxHitsSortIndicator('xanax')}</span>
                               <span class="consumption-players-list-head-value consumption-xanax-hits-sort-h" data-xanax-sort="value" title="Sort by Xanax value ($)">Value${consumptionXanaxHitsSortIndicator('value')}</span>
                          </div>`
                       : '';

                   const xanaxHitsSortedPlayers =
                       col.id === 'xanax'
                           ? (() => {
                                 const xs = consumptionGetXanaxHitsSort();
                                 return consumptionSortXanaxHitsPlayers(
                                     playersWhoUsed,
                                     xs.column,
                                     xs.direction,
                                     itemPrice,
                                     false
                                 );
                             })()
                           : playersWhoUsed;

                   const itemTitleHtml = col.id === 'xanax' ? 'Xanax' : col.label;
                   itemSection.innerHTML = `
                       <div class="item-header">
                           <div class="item-info">
                               <h4 class="item-name">${itemTitleHtml}</h4>
                               <div class="item-stats">
                                   ${statsHTML}
                               </div>
                           </div>
                           <div class="item-players">
                               <button class="players-toggle" data-item="${col.id}">
                                   ${expandedPlayerListItems.has(col.id) ? 'Players ▲' : 'Players ▼'} (${playersWhoUsed.length})
                               </button>
                           </div>
                       </div>
                       <div class="players-list${showWarChain ? ' players-list--xanax-hits' : ''}" data-item="${col.id}" style="display: ${expandedPlayerListItems.has(col.id) ? 'block' : 'none'};">
                           ${xanaxHitsToolbar}
                           ${warChainListHead}
                           ${xanaxHitsSortedPlayers.map(player => {
                               const quantity = player[col.id];
                               const costHTML = col.isPoints && itemPrice > 0
                                   ? `<span class="player-cost">$${(quantity * itemPrice).toLocaleString()}</span>`
                                   : col.isPoints
                                   ? `<span class="player-cost">${quantity} points</span>`
                                   : `<span class="player-cost">$${(quantity * itemPrice).toLocaleString()}</span>`;
                               const warChainCells = '';
                               const totalHits = 0;
                               const useMinHits = consumptionGetXanaxFlagUseMinHits();
                               const usePerXanax = consumptionGetXanaxFlagUsePerXanax();
                               const minH = consumptionGetXanaxFlagMinHits();
                               const fac = consumptionGetXanaxFlagPerXanax();
                               const lowHitRatio = false;
                               const rowClass = showWarChain
                                   ? `player-item player-item--war-chain${lowHitRatio ? ' player-item--low-xanax-hit-ratio' : ''}`
                                   : 'player-item';
                               const rowTitle = lowHitRatio
                                   ? (() => {
                                       const parts = [];
                                       if (useMinHits && minH > 0 && totalHits < minH) {
                                           parts.push(`attacks ${totalHits} < min ${minH}`);
                                       }
                                       if (usePerXanax && fac > 0 && quantity > 0 && totalHits < fac * quantity) {
                                           parts.push(`attacks ${totalHits} < ${fac} x Xanax (${quantity}) = ${fac * quantity}`);
                                       }
                                       return parts.length ? `Low activity: ${parts.join('; ')}.` : '';
                                   })()
                                   : '';
                               const rowTitleAttr = rowTitle
                                   ? rowTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
                                   : '';
                               return `
                               <div class="${rowClass}"${rowTitleAttr ? ` title="${rowTitleAttr}"` : ''}>
                                   <a href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank" class="player-link"${window.toolsMemberLinkAttrs(player.name, player.id)}>
                                       ${window.toolsFormatMemberDisplayLabel(player, window.toolsGetShowMemberIdInBrackets())}
                                   </a>
                                   ${warChainCells}
                                   <span class="player-quantity${showWarChain ? ' player-quantity--xanax' : ''}">${quantity}</span>
                                   ${costHTML}
                               </div>
                           `;
                           }).join('')}
                       </div>
                   `;
                   
                   groupContent.appendChild(itemSection);
               });
               
               groupSection.appendChild(groupHeader);
               groupSection.appendChild(groupContent);
               groupedContainer.appendChild(groupSection);
           });
    
               if (tableContainer) {
               tableContainer.innerHTML = '';
               tableContainer.appendChild(summarySection);
               tableContainer.appendChild(groupedContainer);
           } else {
               console.error('Table container not found!');
           }
    
               // Show results section
           resultsSection.style.display = 'block';
           
                          // Add export buttons to the top controls section
               const controlsSection = document.querySelector('.controls');
               if (controlsSection) {
                   // Remove all existing export buttons
                   const existingExportBtns = controlsSection.querySelectorAll('button[onclick*="export"]');
                   existingExportBtns.forEach(btn => btn.remove());
                   
                   // Add the new export buttons with the same styling
                   controlsSection.innerHTML += `
                       <button onclick="exportGroupedToCSV()">Export Grouped CSV</button>
                       <button onclick="exportPlayersToCSV()">Export Players CSV</button>
                   `;
               }
           
           // Add collapsible functionality
           addCollapsibleFunctionality();
}

// Add collapsible functionality for groups and player lists
function addCollapsibleFunctionality() {
    // Group toggle functionality
    const groupHeaders = document.querySelectorAll('.group-header');
    groupHeaders.forEach(header => {
        header.addEventListener('click', (e) => {
            e.stopPropagation();
            const groupSection = header.closest('.group-section');
            const groupContent = groupSection.querySelector('.group-content');
            const groupToggle = groupSection.querySelector('.group-toggle');
            const isExpanded = groupContent.style.display !== 'none';
            
            if (isExpanded) {
                groupContent.style.display = 'none';
                groupToggle.textContent = '▼';
                // Store collapsed state
                localStorage.setItem(`group-${groupSection.dataset.groupType}`, 'collapsed');
            } else {
                groupContent.style.display = 'block';
                groupToggle.textContent = '▲';
                // Store expanded state
                localStorage.setItem(`group-${groupSection.dataset.groupType}`, 'expanded');
            }
        });
        
        // Restore state from localStorage
        const groupSection = header.closest('.group-section');
        const groupContent = groupSection.querySelector('.group-content');
        const groupToggle = groupSection.querySelector('.group-toggle');
        const savedState = localStorage.getItem(`group-${groupSection.dataset.groupType}`);
        
        if (savedState === 'expanded') {
            groupContent.style.display = 'block';
            groupToggle.textContent = '▲';
        } else {
            groupContent.style.display = 'none';
            groupToggle.textContent = '▼';
        }
    });
    
    // Player list toggle functionality
    const playerToggles = document.querySelectorAll('.players-toggle');
    playerToggles.forEach(toggle => {
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const itemId = toggle.dataset.item;
            const playersList = document.querySelector(`.players-list[data-item="${itemId}"]`);
            const isExpanded = playersList.style.display !== 'none';
            
            if (isExpanded) {
                playersList.style.display = 'none';
                toggle.textContent = toggle.textContent.replace('▲', '▼');
            } else {
                playersList.style.display = 'block';
                toggle.textContent = toggle.textContent.replace('▼', '▲');
            }
        });
    });
}

/**
 * Plain integer string for CSV money/count columns — no thousands separators.
 * Values like $5,275 break Excel (comma → extra columns or decimal in EU locales).
 */
function csvPlainInt(n) {
    return String(Math.round(Number(n) || 0));
}

// Export functions for CSV
function exportConsumptionToCSV() {
    const columns = [
        { id: 'xanax', label: 'Xanax', itemName: 'Xanax' },
        { id: 'vicodin', label: 'Vicodin', itemName: 'Vicodin' },
        { id: 'ketamine', label: 'Ketamine', itemName: 'Ketamine' },
        { id: 'speed', label: 'Speed', itemName: 'Speed' },
        { id: 'shrooms', label: 'Shrooms', itemName: 'Shrooms' },
        { id: 'cannabis', label: 'Cannabis', itemName: 'Cannabis' },
        { id: 'pcp', label: 'PCP', itemName: 'PCP' },
        { id: 'opium', label: 'Opium', itemName: 'Opium' },
        { id: 'ecstasy', label: 'Ecstasy', itemName: 'Ecstasy' },
        { id: 'lsd', label: 'LSD', itemName: 'LSD' },
        { id: 'loveJuice', label: 'Love Juice', itemName: 'Love Juice' },
        { id: 'bloodbags', label: 'Blood Bags', itemName: 'Blood Bag' },
        { id: 'firstAidKit', label: 'First Aid Kit', itemName: 'First Aid Kit' },
        { id: 'smallFirstAidKit', label: 'Small First Aid Kit', itemName: 'Small First Aid Kit' },
        { id: 'morphine', label: 'Morphine', itemName: 'Morphine' },
        { id: 'ipecacSyrup', label: 'Ipecac Syrup', itemName: 'Ipecac Syrup' },
        { id: 'beer', label: 'Bottle of Beer', itemName: 'Bottle of Beer' },
        { id: 'lollipop', label: 'Lollipop', itemName: 'Lollipop' },
        { id: 'sweetHearts', label: 'Box of Sweet Hearts', itemName: 'Box of Sweet Hearts' },
        // Energy Cans
        { id: 'gooseJuice', label: 'Can of Goose Juice', itemName: 'Can of Goose Juice' },
        { id: 'dampValley', label: 'Can of Damp Valley', itemName: 'Can of Damp Valley' },
        { id: 'crocozade', label: 'Can of Crocozade', itemName: 'Can of Crocozade' },
        { id: 'santaShooters', label: 'Can of Santa Shooters', itemName: 'Can of Santa Shooters' },
        { id: 'munster', label: 'Can of Munster', itemName: 'Can of Munster' },
        { id: 'redCow', label: 'Can of Red Cow', itemName: 'Can of Red Cow' },
        { id: 'rockstarRudolph', label: 'Can of Rockstar Rudolph', itemName: 'Can of Rockstar Rudolph' },
        { id: 'taurineElite', label: 'Can of Taurine Elite', itemName: 'Can of Taurine Elite' },
        { id: 'xmass', label: 'Can of X-MASS', itemName: 'Can of X-MASS' },
        { id: 'points', label: 'Points', itemName: 'Points', isPoints: true }
    ];

    const members = consumptionTrackerData.members || consumptionTrackerData.fetchedMembers;
    if (!members || members.length === 0) {
        alert('No data to export');
        return;
    }

    // Get item values for cost calculations
    const itemValues = consumptionTrackerData.itemValues || {};
    
    // Calculate totals and costs
    const totals = {};
    const totalValues = {};
    columns.forEach(col => {
        totals[col.id] = members.reduce((sum, member) => sum + (member[col.id] || 0), 0);
        const itemValue = col.isPoints ? (itemValues['Points'] || 0) : (itemValues[col.itemName] || 0);
        totalValues[col.id] = totals[col.id] * itemValue;
    });
    
    const grandTotal = Object.values(totalValues).reduce((sum, cost) => sum + cost, 0);
    
    // Create CSV content with cost data
    const headers = ['Member Name', ...columns.map(col => col.label)];
    const costHeaders = ['', ...columns.map(col => {
        if (col.isPoints) {
            const pointsPrice = itemValues['Points'] || 0;
            return pointsPrice > 0 ? csvPlainInt(pointsPrice) : 'N/A';
        }
        return csvPlainInt(itemValues[col.itemName] || 0);
    })];
    const totalsRow = ['TOTALS', ...columns.map(col => totals[col.id])];
    const costRow = ['TOTAL COST', ...columns.map(col => csvPlainInt(totalValues[col.id]))];
    const grandTotalRow = ['GRAND TOTAL', ...Array(columns.length - 1).fill(''), csvPlainInt(grandTotal)];
    
    const csvContent = [
        headers.join(','),
        costHeaders.join(','),
        ...members.map(member => [
            window.toolsCsvMemberCell({ name: member.name, id: member.id }),
            ...columns.map(col => member[col.id] || 0)
        ].join(',')),
        totalsRow.join(','),
        costRow.join(','),
        grandTotalRow.join(',')
    ].join('\n');

    // Download CSV file
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'consumption-tracker-export.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// Export grouped items to CSV
function exportGroupedToCSV() {
    if (!consumptionTrackerData) {
        alert('No data to export. Please fetch data first.');
        return;
    }
    
    const { members, itemValues, itemTypes, fromTimestamp, toTimestamp } = consumptionTrackerData;
    
    // Same column set as UI / other exports (was missing drugs + used wrong energy-can ids)
    const columns = [
        { id: 'xanax', label: 'Xanax', itemName: 'Xanax' },
        { id: 'vicodin', label: 'Vicodin', itemName: 'Vicodin' },
        { id: 'ketamine', label: 'Ketamine', itemName: 'Ketamine' },
        { id: 'speed', label: 'Speed', itemName: 'Speed' },
        { id: 'shrooms', label: 'Shrooms', itemName: 'Shrooms' },
        { id: 'cannabis', label: 'Cannabis', itemName: 'Cannabis' },
        { id: 'pcp', label: 'PCP', itemName: 'PCP' },
        { id: 'opium', label: 'Opium', itemName: 'Opium' },
        { id: 'ecstasy', label: 'Ecstasy', itemName: 'Ecstasy' },
        { id: 'lsd', label: 'LSD', itemName: 'LSD' },
        { id: 'loveJuice', label: 'Love Juice', itemName: 'Love Juice' },
        { id: 'bloodbags', label: 'Blood Bags', itemName: 'Blood Bag' },
        { id: 'firstAidKit', label: 'First Aid Kit', itemName: 'First Aid Kit' },
        { id: 'smallFirstAidKit', label: 'Small First Aid Kit', itemName: 'Small First Aid Kit' },
        { id: 'morphine', label: 'Morphine', itemName: 'Morphine' },
        { id: 'ipecacSyrup', label: 'Ipecac Syrup', itemName: 'Ipecac Syrup' },
        { id: 'beer', label: 'Bottle of Beer', itemName: 'Bottle of Beer' },
        { id: 'lollipop', label: 'Lollipop', itemName: 'Lollipop' },
        { id: 'sweetHearts', label: 'Box of Sweet Hearts', itemName: 'Box of Sweet Hearts' },
        { id: 'gooseJuice', label: 'Can of Goose Juice', itemName: 'Can of Goose Juice' },
        { id: 'dampValley', label: 'Can of Damp Valley', itemName: 'Can of Damp Valley' },
        { id: 'crocozade', label: 'Can of Crocozade', itemName: 'Can of Crocozade' },
        { id: 'santaShooters', label: 'Can of Santa Shooters', itemName: 'Can of Santa Shooters' },
        { id: 'munster', label: 'Can of Munster', itemName: 'Can of Munster' },
        { id: 'redCow', label: 'Can of Red Cow', itemName: 'Can of Red Cow' },
        { id: 'rockstarRudolph', label: 'Can of Rockstar Rudolph', itemName: 'Can of Rockstar Rudolph' },
        { id: 'taurineElite', label: 'Can of Taurine Elite', itemName: 'Can of Taurine Elite' },
        { id: 'xmass', label: 'Can of X-MASS', itemName: 'Can of X-MASS' },
        { id: 'points', label: 'Points', itemName: 'Points', isPoints: true }
    ];
    
    // Group items by type
    const groupedItems = {};
    columns.forEach(col => {
        const itemType = col.isPoints ? 'Points' : (itemTypes[col.itemName] || 'Unknown');
        if (!groupedItems[itemType]) {
            groupedItems[itemType] = [];
        }
        groupedItems[itemType].push(col);
    });
    
    // Calculate totals
    const totals = {};
    const totalValues = {};
    columns.forEach(col => {
        totals[col.id] = members.reduce((sum, member) => sum + (member[col.id] || 0), 0);
        const itemValue = col.isPoints ? (itemValues['Points'] || 0) : (itemValues[col.itemName] || 0);
        totalValues[col.id] = totals[col.id] * itemValue;
    });
    
    const rangeCsv = `Time Range (TCT / UTC): ${consumptionFormatTctUtc(fromTimestamp)} to ${consumptionFormatTctUtc(toTimestamp)}`;
    const fileStamp = `${new Date(fromTimestamp * 1000).toISOString().slice(0, 10)}_${new Date(toTimestamp * 1000).toISOString().slice(0, 10)}`;
    
    let csvContent = `Consumption Tracker - Grouped Items\n`;
    csvContent += `${rangeCsv}\n\n`;
    
    Object.keys(groupedItems).forEach(groupType => {
        csvContent += `${groupType}\n`;
        // For points, show price/value if market value is available
        const pointsPrice = itemValues['Points'] || 0;
        const headerRow = (groupType === 'Points' && pointsPrice === 0)
            ? `Item,Total Usage\n`
            : `Item,Total Usage,Unit Price ($),Total Value ($)\n`;
        csvContent += headerRow;
        
        let groupTotal = 0;
        groupedItems[groupType].forEach(col => {
            const total = totals[col.id];
            
            // Skip items with zero usage
            if (total === 0) {
                return;
            }
            
            if (col.isPoints) {
                const price = itemValues['Points'] || 0;
                const value = totalValues[col.id];
                if (price > 0) {
                    groupTotal += value;
                    csvContent += `"${col.label}",${total},${csvPlainInt(price)},${csvPlainInt(value)}\n`;
                } else {
                    csvContent += `"${col.label}",${total}\n`;
                }
            } else {
            const price = itemValues[col.itemName] || 0;
            const value = totalValues[col.id];
            groupTotal += value;
            csvContent += `"${col.label}",${total},${csvPlainInt(price)},${csvPlainInt(value)}\n`;
            }
        });
        
        if (groupType === 'Points' && pointsPrice === 0) {
            csvContent += `\n`;
        } else {
        csvContent += `Group Total,,,${csvPlainInt(groupTotal)}\n\n`;
        }
    });
    
    // Create and download the CSV file
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `consumption-grouped-${fileStamp}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// Export players data to CSV
function exportPlayersToCSV() {
    consumptionMigrateXanaxFlagRuleKeysOnce();
    if (!consumptionTrackerData) {
        alert('No data to export. Please fetch data first.');
        return;
    }
    
    const { members, itemValues, fromTimestamp, toTimestamp } = consumptionTrackerData;
    
               // Define columns
           const columns = [
               { id: 'xanax', label: 'Xanax', itemName: 'Xanax' },
               { id: 'vicodin', label: 'Vicodin', itemName: 'Vicodin' },
               { id: 'ketamine', label: 'Ketamine', itemName: 'Ketamine' },
               { id: 'speed', label: 'Speed', itemName: 'Speed' },
               { id: 'shrooms', label: 'Shrooms', itemName: 'Shrooms' },
               { id: 'cannabis', label: 'Cannabis', itemName: 'Cannabis' },
               { id: 'pcp', label: 'PCP', itemName: 'PCP' },
               { id: 'opium', label: 'Opium', itemName: 'Opium' },
               { id: 'ecstasy', label: 'Ecstasy', itemName: 'Ecstasy' },
               { id: 'lsd', label: 'LSD', itemName: 'LSD' },
               { id: 'loveJuice', label: 'Love Juice', itemName: 'Love Juice' },
               { id: 'bloodbags', label: 'Blood Bags', itemName: 'Blood Bag' },
               { id: 'firstAidKit', label: 'First Aid Kit', itemName: 'First Aid Kit' },
               { id: 'smallFirstAidKit', label: 'Small First Aid Kit', itemName: 'Small First Aid Kit' },
               { id: 'morphine', label: 'Morphine', itemName: 'Morphine' },
               { id: 'ipecacSyrup', label: 'Ipecac Syrup', itemName: 'Ipecac Syrup' },
               { id: 'beer', label: 'Bottle of Beer', itemName: 'Bottle of Beer' },
               { id: 'lollipop', label: 'Lollipop', itemName: 'Lollipop' },
               { id: 'sweetHearts', label: 'Box of Sweet Hearts', itemName: 'Box of Sweet Hearts' },
               // Energy Cans
               { id: 'gooseJuice', label: 'Can of Goose Juice', itemName: 'Can of Goose Juice' },
               { id: 'dampValley', label: 'Can of Damp Valley', itemName: 'Can of Damp Valley' },
               { id: 'crocozade', label: 'Can of Crocozade', itemName: 'Can of Crocozade' },
               { id: 'santaShooters', label: 'Can of Santa Shooters', itemName: 'Can of Santa Shooters' },
               { id: 'munster', label: 'Can of Munster', itemName: 'Can of Munster' },
               { id: 'redCow', label: 'Can of Red Cow', itemName: 'Can of Red Cow' },
               { id: 'rockstarRudolph', label: 'Can of Rockstar Rudolph', itemName: 'Can of Rockstar Rudolph' },
               { id: 'taurineElite', label: 'Can of Taurine Elite', itemName: 'Can of Taurine Elite' },
               { id: 'xmass', label: 'Can of X-MASS', itemName: 'Can of X-MASS' },
               { id: 'points', label: 'Points', itemName: 'Points', isPoints: true }
           ];
    
    const rangeCsv = `Time Range (TCT / UTC): ${consumptionFormatTctUtc(fromTimestamp)} to ${consumptionFormatTctUtc(toTimestamp)}`;
    const fileStamp = `${new Date(fromTimestamp * 1000).toISOString().slice(0, 10)}_${new Date(toTimestamp * 1000).toISOString().slice(0, 10)}`;
    
    let csvContent = `Consumption Tracker - Player Details\n`;
    csvContent += `${rangeCsv}\n\n`;
    
    // Calculate which items have usage across all players
    const itemsWithUsage = {};
    columns.forEach(col => {
        const totalUsage = members.reduce((sum, member) => sum + (member[col.id] || 0), 0);
        if (totalUsage > 0) {
            itemsWithUsage[col.id] = col;
        }
    });
    
    // Header row (only for items with usage)
    const pointsPrice = itemValues['Points'] || 0;
    csvContent += `Player Name,`;
    Object.values(itemsWithUsage).forEach(col => {
        if (col.isPoints && pointsPrice === 0) {
            csvContent += `${col.label} (Qty),`;
        } else {
            csvContent += `${col.label} (Qty),${col.label} Cost ($),`;
        }
    });
    csvContent += `Total Value ($)\n`;
    
    // Player rows
    members.forEach(member => {
        csvContent += `${window.toolsCsvMemberCell({ name: member.name, id: member.id })},`;
        let playerTotal = 0;
        
        Object.values(itemsWithUsage).forEach(col => {
            const quantity = member[col.id] || 0;
            if (col.isPoints) {
                const price = itemValues['Points'] || 0;
                if (price > 0) {
                    const cost = quantity * price;
                    playerTotal += cost;
                    csvContent += `${quantity},${csvPlainInt(cost)},`;
                } else {
                    csvContent += `${quantity},`;
                }
            } else {
            const price = itemValues[col.itemName] || 0;
            const cost = quantity * price;
            playerTotal += cost;
            csvContent += `${quantity},${csvPlainInt(cost)},`;
            }
        });
        
        csvContent += `${csvPlainInt(playerTotal)}\n`;
    });
    
    // Totals row
    const totals = {};
    const totalValues = {};
    columns.forEach(col => {
        totals[col.id] = members.reduce((sum, member) => sum + (member[col.id] || 0), 0);
        const itemValue = col.isPoints ? (itemValues['Points'] || 0) : (itemValues[col.itemName] || 0);
        totalValues[col.id] = totals[col.id] * itemValue;
    });
    
    const grandTotal = Object.values(totalValues).reduce((sum, cost) => sum + cost, 0);
    
    csvContent += 'TOTALS,';
    Object.values(itemsWithUsage).forEach(col => {
        if (col.isPoints) {
            const price = itemValues['Points'] || 0;
            if (price > 0) {
        csvContent += `${totals[col.id]},${csvPlainInt(totalValues[col.id])},`;
            } else {
                csvContent += `${totals[col.id]},`;
            }
        } else {
            csvContent += `${totals[col.id]},${csvPlainInt(totalValues[col.id])},`;
        }
    });
    csvContent += `${csvPlainInt(grandTotal)}\n`;
    
    // Create and download the CSV file
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `consumption-players-${fileStamp}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

window.exportConsumptionToCSV = exportConsumptionToCSV;
window.exportGroupedToCSV = exportGroupedToCSV;
window.exportPlayersToCSV = exportPlayersToCSV;

if (!window._consumptionToolsMemberIdListener) {
    window._consumptionToolsMemberIdListener = true;
    window.addEventListener('toolsMemberIdDisplayChanged', () => {
        consumptionRefreshConsumptionUiFromCache();
    });
}