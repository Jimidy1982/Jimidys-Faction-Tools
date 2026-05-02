console.log('[ORGANISED CRIME STATS] organised-crime-stats.js LOADED');

const OC_STATS_DATE_FILTERS_LS_KEY = 'organisedCrimeStats_dateFilters';
const OC_STATS_CRIMES_CACHE_KEY = 'organisedCrimeStats_crimesCache_v1';
/** Payload `crimes` array version inside that key (bump when merge keys change — v1 caches break incremental dedup). */
const OC_STATS_CRIMES_CACHE_DATA_VERSION = 2;
const OC_STATS_PULL_META_KEY = 'organisedCrimeStats_apiPullMeta_v1';
const OC_STATS_ALLOWED_PRESETS = new Set(['all', '7', '14', '30', '90', '365', 'custom']);
const OC_STATS_ALLOWED_UNITS = new Set(['days', 'months', 'years']);

/**
 * Localhost: Torn does not allow browser CORS from file:// or :5173; Vite proxies /.torn-api-proxy → api.torn.com.
 * Main app registers window.getTornApiFetchUrl (see app.js, vite.config.js).
 */
function ocStatsTornFetchUrl(url) {
    if (typeof window.getTornApiFetchUrl === 'function') return window.getTornApiFetchUrl(url);
    try {
        if (typeof location === 'undefined') return url;
        const h = String(location.hostname || '').toLowerCase();
        if (h !== 'localhost' && h !== '127.0.0.1') return url;
        const u = new URL(url, location.origin);
        if (u.hostname !== 'api.torn.com') return url;
        return '/.torn-api-proxy' + u.pathname + u.search;
    } catch (e) {
        return url;
    }
}

/**
 * Read the visible date filter for a section from the DOM (source of truth for what the user sees).
 * Falls back to ocStatsData.activeFilters if the select is missing (e.g. before first paint).
 */
function getOcStatsSectionDateFilterFromDom(section) {
    const id = section === 'difficulty' ? 'difficultyDateFilter' : 'playerDateFilter';
    const el = document.getElementById(id);
    const v = el && el.value != null ? String(el.value) : '';
    if (OC_STATS_ALLOWED_PRESETS.has(v)) return v;
    const fb =
        typeof ocStatsData !== 'undefined' && ocStatsData.activeFilters
            ? ocStatsData.activeFilters[section]
            : 'all';
    const s = fb != null ? String(fb) : 'all';
    return OC_STATS_ALLOWED_PRESETS.has(s) ? s : 'all';
}

/** Sync in-memory filters from the live dropdowns (export + getCurrentFilteredData use DOM-first). */
function syncOcStatsActiveFiltersFromDom() {
    if (typeof ocStatsData === 'undefined' || !ocStatsData.activeFilters) return;
    ocStatsData.activeFilters.difficulty = getOcStatsSectionDateFilterFromDom('difficulty');
    ocStatsData.activeFilters.player = getOcStatsSectionDateFilterFromDom('player');
}

/**
 * Human-readable date filter for CSV (matches dropdown labels: "Last 30 days", "All Time", etc.).
 */
function getOcStatsDateFilterHumanLabel(section) {
    const id = section === 'difficulty' ? 'difficultyDateFilter' : 'playerDateFilter';
    const el = document.getElementById(id);
    if (!el || el.value == null || el.value === '') return 'All Time';
    const val = String(el.value);
    if (val === 'custom') {
        const amtId = section === 'difficulty' ? 'difficultyCustomAmount' : 'playerCustomAmount';
        const unitId = section === 'difficulty' ? 'difficultyCustomUnit' : 'playerCustomUnit';
        const amt = Math.max(1, parseInt(document.getElementById(amtId)?.value, 10) || 30);
        const unit = document.getElementById(unitId)?.value || 'days';
        const u =
            unit === 'months'
                ? amt === 1
                    ? 'month'
                    : 'months'
                : unit === 'years'
                  ? amt === 1
                      ? 'year'
                      : 'years'
                  : amt === 1
                    ? 'day'
                    : 'days';
        return `Last ${amt} ${u}`;
    }
    const opt = el.options[el.selectedIndex];
    if (opt && String(opt.text || '').trim()) return String(opt.text).trim();
    const presetLabels = {
        all: 'All Time',
        '7': 'Last 7 days',
        '14': 'Last 14 days',
        '30': 'Last 30 days',
        '90': 'Last 90 days',
        '365': 'Last Year',
    };
    return presetLabels[val] != null ? presetLabels[val] : val;
}

/** Stable fingerprint for the API key (never store the raw key in the crimes cache payload beyond this). */
function ocStatsApiKeyFingerprint(apiKey) {
    const s = String(apiKey || '').trim();
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16);
}

function saveOcStatsApiPullMeta(apiKey, crimePages, crimeCount) {
    try {
        const totalApiCalls = Number(crimePages) + 2;
        localStorage.setItem(
            OC_STATS_PULL_META_KEY,
            JSON.stringify({
                v: 1,
                keyFp: ocStatsApiKeyFingerprint(apiKey),
                savedAt: Date.now(),
                crimePages: Number(crimePages) || 0,
                totalApiCalls,
                crimeCount: Number(crimeCount) || 0
            })
        );
    } catch (e) {
        console.warn('[ORGANISED CRIME STATS] Could not save API pull meta:', e);
    }
}

function readOcStatsApiPullMeta(apiKey) {
    try {
        const raw = localStorage.getItem(OC_STATS_PULL_META_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || o.v !== 1 || o.keyFp !== ocStatsApiKeyFingerprint(apiKey)) return null;
        return o;
    } catch {
        return null;
    }
}

function saveOcStatsCrimesCache(apiKey, allCrimes, crimePages) {
    saveOcStatsApiPullMeta(apiKey, crimePages, allCrimes.length);
    try {
        localStorage.setItem(
            OC_STATS_CRIMES_CACHE_KEY,
            JSON.stringify({
                v: OC_STATS_CRIMES_CACHE_DATA_VERSION,
                keyFp: ocStatsApiKeyFingerprint(apiKey),
                savedAt: Date.now(),
                crimePages: Number(crimePages) || 0,
                crimes: allCrimes
            })
        );
    } catch (e) {
        console.warn('[ORGANISED CRIME STATS] Could not cache crimes JSON (quota or size):', e);
    }
}

function loadOcStatsCrimesFromCache(apiKey) {
    try {
        const raw = localStorage.getItem(OC_STATS_CRIMES_CACHE_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || !Array.isArray(o.crimes) || o.keyFp !== ocStatsApiKeyFingerprint(apiKey)) return null;
        if (o.v !== OC_STATS_CRIMES_CACHE_DATA_VERSION) {
            if (o.v === 1) {
                try {
                    localStorage.removeItem(OC_STATS_CRIMES_CACHE_KEY);
                    console.warn(
                        '[ORGANISED CRIME STATS] Removed legacy v1 crime cache (keys incompatible with incremental merge). Fetch once to rebuild v2 cache.'
                    );
                } catch (e) {
                    /* ignore */
                }
            }
            return null;
        }
        return o.crimes;
    } catch (e) {
        console.warn('[ORGANISED CRIME STATS] Could not read crimes cache:', e);
        return null;
    }
}

/** Torn v2 may return `crimes` as an array or as an object map — normalize to an array (newest first if map). */
function ocStatsNormalizeCrimesArray(raw) {
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') {
        const arr = Object.values(raw);
        arr.sort((a, b) => {
            const ta = a && a.executed_at != null ? Number(a.executed_at) : 0;
            const tb = b && b.executed_at != null ? Number(b.executed_at) : 0;
            return tb - ta;
        });
        return arr;
    }
    return [];
}

function formatOcStatsCacheDate(ts) {
    try {
        return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return '';
    }
}

/** `executed_at` from Torn OC payload is Unix time in seconds. Month + day only (keeps reward breakdown compact). */
function formatOcCrimeExecutedShort(tsSeconds) {
    if (tsSeconds == null || !Number.isFinite(Number(tsSeconds))) return '';
    try {
        return new Date(Number(tsSeconds) * 1000).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric'
        });
    } catch {
        return '';
    }
}

function updateOcStatsCacheHint() {
    const el = document.getElementById('ocStatsCacheHint');
    const btn = document.getElementById('loadOcStatsCache');
    const apiKey = (localStorage.getItem('tornApiKey') || '').trim();
    if (!el) return;
    if (!apiKey) {
        el.textContent = '';
        if (btn) btn.style.display = 'none';
        return;
    }
    const meta = readOcStatsApiPullMeta(apiKey);
    const crimesCached = !!loadOcStatsCrimesFromCache(apiKey);
    if (!meta) {
        el.textContent = '';
        if (btn) btn.style.display = 'none';
        return;
    }
    const when = formatOcStatsCacheDate(meta.savedAt);
    el.textContent =
        `Last run used about ${meta.totalApiCalls} API calls (${meta.crimePages} completed-crime page${meta.crimePages === 1 ? '' : 's'} at 100 per page, plus members + items). ` +
        `${crimesCached ? `Crimes are cached locally (${meta.crimeCount} rows, saved ${when}). "Fetch Crime Data" loads that cache first (like Consumption Tracker), then only pulls API pages until it hits crimes you already have. Progress shows cache → API merge → members/items. "Load from cache" skips completed-crime API calls and only refreshes members, items, and planning/recruiting OCs.` : `Crime list was not cached (too large or first run); the next fetch downloads all completed-crime pages once, then caches them.`}`;
    if (btn) btn.style.display = crimesCached ? 'inline-block' : 'none';
}

/** Update OC stats progress bar (same pattern as consumption tracker / MPR: percentage + fill). */
function ocStatsSetProgress(progressRefs, pct, message, details) {
    if (!progressRefs) return;
    const { progressMessage, progressDetails, progressPercentage, progressFill } = progressRefs;
    if (message != null && progressMessage) progressMessage.textContent = message;
    if (details != null && progressDetails) progressDetails.textContent = details;
    if (pct != null && progressPercentage && progressFill) {
        const p = Math.min(100, Math.max(0, Number(pct)));
        progressPercentage.textContent = `${Math.round(p)}%`;
        progressFill.style.width = `${p}%`;
    }
}

/**
 * After `allCrimes` is available (from API or local cache), fetch members + items and build tables.
 * @returns {Promise<void>}
 */
async function runOcStatsAfterCrimesReady(allCrimes, progressRefs) {
    const {
        progressMessage,
        progressDetails,
        progressPercentage,
        progressFill,
        resultsSection
    } = progressRefs;

    ocStatsSetProgress(progressRefs, 72, 'Fetching current faction members...', 'Loading member list...');

    const apiKey = (localStorage.getItem('tornApiKey') || '').trim();
    const membersResponse = await fetch(ocStatsTornFetchUrl(`https://api.torn.com/v2/faction/members?key=${apiKey}`));
    const membersData = await membersResponse.json();

    if (membersData.error) {
        throw new Error(`Could not fetch faction members: ${membersData.error.error}`);
    }

    const currentMemberIds = new Set();
    const playerNames = {};
    const membersArray = membersData.members || [];

    membersArray.forEach(member => {
        currentMemberIds.add(member.id.toString());
        playerNames[member.id.toString()] = member.name;
    });

    ocStatsSetProgress(
        progressRefs,
        78,
        'Processing crime data...',
        `Analyzing ${allCrimes.length} crimes (filtering by current members)...`
    );

    const factionCutInput = document.getElementById('ocFactionCutPercent');
    const factionCutPercent = factionCutInput ? Math.min(100, Math.max(0, parseFloat(factionCutInput.value) || 20)) : 20;
    const { difficultyStats, playerStats } = processCrimeData(allCrimes, playerNames, currentMemberIds, factionCutPercent);

    ocStatsSetProgress(progressRefs, 84, 'Loading item details...', 'Fetching item names and values...');
    try {
        const itemsResponse = await fetch(ocStatsTornFetchUrl(`https://api.torn.com/torn/?selections=items&key=${apiKey}`));
        const itemsData = await itemsResponse.json();
        ocStatsData.itemsMap = itemsData && itemsData.items ? itemsData.items : {};
    } catch (e) {
        console.warn('[ORGANISED CRIME STATS] Could not fetch Torn items:', e);
        ocStatsData.itemsMap = {};
    }

    ocStatsSetProgress(
        progressRefs,
        90,
        'Checking planning & recruiting OCs…',
        'Missing item requirements on active crimes…'
    );

    let plannedFetchWarnings = [];
    let plannedMissingRows = [];
    try {
        const { crimes: activeCrimes, warnings } = await fetchActiveFactionCrimesForPlannedItemNeeds(
            apiKey,
            progressDetails
        );
        plannedFetchWarnings = warnings || [];
        plannedMissingRows = extractPlannedOcMissingItemRows(activeCrimes, playerNames, ocStatsData.itemsMap);
    } catch (e) {
        console.warn('[ORGANISED CRIME STATS] Planned / recruiting OC fetch failed:', e);
        plannedFetchWarnings = [e && e.message ? e.message : String(e)];
    }

    const totalSuccessful = difficultyStats.reduce((sum, stat) => sum + stat.successful, 0);
    const totalFailed = difficultyStats.reduce((sum, stat) => sum + stat.failed, 0);
    const totalCrimes = totalSuccessful + totalFailed;

    ocStatsData.difficultyStats = difficultyStats;
    ocStatsData.playerStats = playerStats;
    ocStatsData.totalCrimes = totalCrimes;
    ocStatsData.allCrimes = allCrimes;
    ocStatsData.currentMemberIds = Array.from(currentMemberIds);
    ocStatsData.playerNames = playerNames;

    updateOCStatsUI(difficultyStats, playerStats, totalCrimes);
    reapplyOcStatsDateFiltersToTables();
    renderOcPlannedMissingItemsPanel(plannedMissingRows, plannedFetchWarnings);

    ocStatsSetProgress(progressRefs, 100, 'Done', 'Tables updated.');

    if (resultsSection) {
        resultsSection.style.display = 'block';
    }
}

function persistOcStatsDateFilters() {
    try {
        const payload = {
            difficulty: document.getElementById('difficultyDateFilter')?.value ?? 'all',
            player: document.getElementById('playerDateFilter')?.value ?? 'all',
            difficultyCustomAmount: Math.max(1, parseInt(document.getElementById('difficultyCustomAmount')?.value, 10) || 30),
            difficultyCustomUnit: document.getElementById('difficultyCustomUnit')?.value ?? 'days',
            playerCustomAmount: Math.max(1, parseInt(document.getElementById('playerCustomAmount')?.value, 10) || 30),
            playerCustomUnit: document.getElementById('playerCustomUnit')?.value ?? 'days'
        };
        if (!OC_STATS_ALLOWED_PRESETS.has(payload.difficulty)) payload.difficulty = 'all';
        if (!OC_STATS_ALLOWED_PRESETS.has(payload.player)) payload.player = 'all';
        if (!OC_STATS_ALLOWED_UNITS.has(payload.difficultyCustomUnit)) payload.difficultyCustomUnit = 'days';
        if (!OC_STATS_ALLOWED_UNITS.has(payload.playerCustomUnit)) payload.playerCustomUnit = 'days';
        localStorage.setItem(OC_STATS_DATE_FILTERS_LS_KEY, JSON.stringify(payload));
    } catch (e) {
        console.warn('[ORGANISED CRIME STATS] Could not save date filter preferences:', e);
    }
}

function loadOcStatsDateFiltersFromStorage() {
    try {
        const raw = localStorage.getItem(OC_STATS_DATE_FILTERS_LS_KEY);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (!o || typeof o !== 'object') return;

        const preset = (x) => {
            const s = String(x);
            return OC_STATS_ALLOWED_PRESETS.has(s) ? s : 'all';
        };
        const unit = (x) => (OC_STATS_ALLOWED_UNITS.has(x) ? x : 'days');

        const diffSel = document.getElementById('difficultyDateFilter');
        const playSel = document.getElementById('playerDateFilter');
        if (diffSel && o.difficulty != null) diffSel.value = preset(o.difficulty);
        if (playSel && o.player != null) playSel.value = preset(o.player);

        const dAmt = document.getElementById('difficultyCustomAmount');
        const dUnit = document.getElementById('difficultyCustomUnit');
        const pAmt = document.getElementById('playerCustomAmount');
        const pUnit = document.getElementById('playerCustomUnit');
        if (dAmt && o.difficultyCustomAmount != null) dAmt.value = String(Math.max(1, parseInt(o.difficultyCustomAmount, 10) || 30));
        if (dUnit && o.difficultyCustomUnit != null) dUnit.value = unit(o.difficultyCustomUnit);
        if (pAmt && o.playerCustomAmount != null) pAmt.value = String(Math.max(1, parseInt(o.playerCustomAmount, 10) || 30));
        if (pUnit && o.playerCustomUnit != null) pUnit.value = unit(o.playerCustomUnit);

        if (diffSel) ocStatsData.activeFilters.difficulty = diffSel.value;
        if (playSel) ocStatsData.activeFilters.player = playSel.value;

        toggleCustomRangeVisibility('difficulty');
        toggleCustomRangeVisibility('player');
    } catch (e) {
        console.warn('[ORGANISED CRIME STATS] Could not load date filter preferences:', e);
    }
}

/** After fetch, re-apply both section filters so tables match saved dropdowns (not always "all"). */
function reapplyOcStatsDateFiltersToTables() {
    const d = document.getElementById('difficultyDateFilter');
    const p = document.getElementById('playerDateFilter');
    if (d) ocStatsData.activeFilters.difficulty = d.value;
    if (p) ocStatsData.activeFilters.player = p.value;
    toggleCustomRangeVisibility('difficulty');
    toggleCustomRangeVisibility('player');
    handleDateFilterChange('difficulty');
    handleDateFilterChange('player');
}

// Global state for OC stats
let ocStatsData = {
    difficultyStats: [],
    playerStats: [],
    totalCrimes: 0,
    sortState: {
        difficulty: { column: 'difficulty', direction: 'asc' },
        player: { column: 'totalScore', direction: 'desc' }
    },
    activeFilters: {
        difficulty: 'all',
        player: 'all'
    },
    isFetching: false // Guard to prevent multiple simultaneous fetches
};

let ocStatsDifficultyTableClickDelegated = false;

/** One listener on #difficultyStatsTable: survives innerHTML rebuilds; avoids stacked handlers from updateOCStatsUI / updateDifficultyStatsUI. */
function handleDifficultyStatsTableDelegatedClick(e) {
    const container = document.getElementById('difficultyStatsTable');
    if (!container || !container.contains(e.target)) return;

    const toggle = e.target.closest('.difficulty-expand-toggle');
    if (toggle && container.contains(toggle)) {
        e.preventDefault();
        e.stopPropagation();
        const d = toggle.getAttribute('data-difficulty');
        const expanded = toggle.getAttribute('data-expanded') === '1';
        const rows = container.querySelectorAll(`tr.crime-type-row[data-difficulty="${d}"]`);
        rows.forEach(r => {
            r.style.display = expanded ? 'none' : 'table-row';
        });
        toggle.setAttribute('data-expanded', expanded ? '0' : '1');
        toggle.textContent = expanded ? '▶' : '▼';
        toggle.setAttribute('title', expanded ? 'Show subtypes' : 'Hide subtypes');
        return;
    }

    const th = e.target.closest('th[data-column]');
    if (!th || !container.contains(th)) return;
    const table = th.closest('table');
    if (!table || table.id !== 'difficultyTable') return;
    const column = th.dataset.column;
    if (column) sortDifficultyTable(column);
}

function ensureOcStatsDifficultyTableDelegation() {
    const el = document.getElementById('difficultyStatsTable');
    if (!el || ocStatsDifficultyTableClickDelegated) return;
    ocStatsDifficultyTableClickDelegated = true;
    el.addEventListener('click', handleDifficultyStatsTableDelegatedClick);
}

function initOrganisedCrimeStats() {
    console.log('[ORGANISED CRIME STATS] initOrganisedCrimeStats CALLED');
    
    // Log tool usage
    if (window.logToolUsage) {
        window.logToolUsage('organised-crime-stats');
    }

    // Remove any existing event listeners by cloning and replacing elements
    const fetchBtn = document.getElementById('fetchOCData');
    if (fetchBtn) {
        const newFetchBtn = fetchBtn.cloneNode(true);
        fetchBtn.parentNode.replaceChild(newFetchBtn, fetchBtn);
        newFetchBtn.addEventListener('click', () => {
            console.log('[ORGANISED CRIME STATS] Fetch button clicked by user');
            handleOCDataFetch();
        });
    }

    const loadCacheBtn = document.getElementById('loadOcStatsCache');
    if (loadCacheBtn) {
        const btn = loadCacheBtn.cloneNode(true);
        loadCacheBtn.parentNode.replaceChild(btn, loadCacheBtn);
        btn.addEventListener('click', () => handleOCDataLoadFromCache());
    }
    updateOcStatsCacheHint();

    const exportBtn = document.getElementById('exportStats');
    if (exportBtn) {
        const newExportBtn = exportBtn.cloneNode(true);
        exportBtn.parentNode.replaceChild(newExportBtn, exportBtn);
        newExportBtn.addEventListener('click', () => {
            console.log('[ORGANISED CRIME STATS] Export button clicked');
            exportOCStatsToCSV();
        });
    }
    
    // Add date filter handlers for both sections
    const difficultyDateFilter = document.getElementById('difficultyDateFilter');
    if (difficultyDateFilter) {
        const newDifficultyFilter = difficultyDateFilter.cloneNode(true);
        difficultyDateFilter.parentNode.replaceChild(newDifficultyFilter, difficultyDateFilter);
        newDifficultyFilter.addEventListener('change', () => {
            console.log('[ORGANISED CRIME STATS] Difficulty filter changed to:', newDifficultyFilter.value);
            handleDateFilterChange('difficulty');
        });
    }
    
    const playerDateFilter = document.getElementById('playerDateFilter');
    if (playerDateFilter) {
        const newPlayerFilter = playerDateFilter.cloneNode(true);
        playerDateFilter.parentNode.replaceChild(newPlayerFilter, playerDateFilter);
        newPlayerFilter.addEventListener('change', () => {
            console.log('[ORGANISED CRIME STATS] Player filter changed to:', newPlayerFilter.value);
            handleDateFilterChange('player');
        });
    }
    
    // Custom timeframe: when amount or unit changes, re-apply filter if Custom is selected
    const difficultyCustomAmount = document.getElementById('difficultyCustomAmount');
    const difficultyCustomUnit = document.getElementById('difficultyCustomUnit');
    if (difficultyCustomAmount) difficultyCustomAmount.addEventListener('change', () => {
        persistOcStatsDateFilters();
        if (document.getElementById('difficultyDateFilter')?.value === 'custom') handleDateFilterChange('difficulty');
    });
    if (difficultyCustomUnit) difficultyCustomUnit.addEventListener('change', () => {
        persistOcStatsDateFilters();
        if (document.getElementById('difficultyDateFilter')?.value === 'custom') handleDateFilterChange('difficulty');
    });
    const playerCustomAmount = document.getElementById('playerCustomAmount');
    const playerCustomUnit = document.getElementById('playerCustomUnit');
    if (playerCustomAmount) playerCustomAmount.addEventListener('change', () => {
        persistOcStatsDateFilters();
        if (document.getElementById('playerDateFilter')?.value === 'custom') handleDateFilterChange('player');
    });
    if (playerCustomUnit) playerCustomUnit.addEventListener('change', () => {
        persistOcStatsDateFilters();
        if (document.getElementById('playerDateFilter')?.value === 'custom') handleDateFilterChange('player');
    });
    
    const factionCutInput = document.getElementById('ocFactionCutPercent');
    if (factionCutInput) {
        factionCutInput.addEventListener('change', () => {
            if (ocStatsData.allCrimes && ocStatsData.allCrimes.length > 0) {
                handleDateFilterChange('player');
            }
        });
    }

    // Apply saved time filters AFTER selects are cloned — cloneNode can drop programmatic .value
    loadOcStatsDateFiltersFromStorage();

    ensureOcStatsDifficultyTableDelegation();
    
    console.log('[ORGANISED CRIME STATS] Initialization complete - waiting for user interaction');
}

const handleOCDataFetch = async () => {
    console.log('[ORGANISED CRIME STATS] handleOCDataFetch called');
    console.trace('[ORGANISED CRIME STATS] Call stack:');
    
    // Guard against multiple simultaneous fetches
    if (ocStatsData.isFetching) {
        console.warn('[ORGANISED CRIME STATS] Fetch already in progress, ignoring duplicate call');
        return;
    }
    
    const apiKey = (localStorage.getItem('tornApiKey') || '').trim();
    if (!apiKey) {
        alert('Please enter your API key in the sidebar first');
        return;
    }
    
    ocStatsData.isFetching = true; // Set guard flag
    
    const loadingSpinner = document.getElementById('loadingSpinner');
    const fetchBtn = document.getElementById('fetchOCData');
    const resultsSection = document.querySelector('.results-section');
    const progressContainer = document.getElementById('progressContainer');
    const progressMessage = document.getElementById('progressMessage');
    const progressPercentage = document.getElementById('progressPercentage');
    const progressFill = document.getElementById('progressFill');
    const progressDetails = document.getElementById('progressDetails');

    try {
        if (loadingSpinner) loadingSpinner.style.display = 'inline-block';
        if (fetchBtn) fetchBtn.disabled = true;
        const loadCacheBtnStart = document.getElementById('loadOcStatsCache');
        if (loadCacheBtnStart) loadCacheBtnStart.disabled = true;
        if (progressContainer) progressContainer.style.display = 'block';

        console.log('[ORGANISED CRIME STATS] Fetching organised crime data...');

        const progressRefs = {
            progressMessage,
            progressDetails,
            progressPercentage,
            progressFill,
            resultsSection
        };

        const cachedCrimes = loadOcStatsCrimesFromCache(apiKey);
        const { mergedCrimes: allCrimes, pageCount, newCrimesAdded, hadCache } =
            await ocStatsFetchCompletedCrimesMerged(apiKey, cachedCrimes, progressRefs);

        if (hadCache) {
            console.log(
                `[ORGANISED CRIME STATS] Merge complete: ${allCrimes.length} total crimes (+${newCrimesAdded} new, ${pageCount} page(s) fetched)`
            );
        } else {
            console.log(`[ORGANISED CRIME STATS] Total crimes fetched: ${allCrimes.length}`);
        }

        await runOcStatsAfterCrimesReady(allCrimes, progressRefs);

        saveOcStatsCrimesCache(apiKey, allCrimes, pageCount);
        updateOcStatsCacheHint();

        if (progressContainer) progressContainer.style.display = 'none';

    } catch (error) {
        console.error('[ORGANISED CRIME STATS] Error fetching OC data:', error);
        
        // Check if it's an access level error
        if (error.message && error.message.includes('Access level of this key is not high enough')) {
            alert('⚠️ Insufficient API Key Permissions\n\n' +
                  'Your API key doesn\'t have the required access level.\n\n' +
                  'This tool requires a Limited or Full access API key to access faction crime data.\n\n' +
                  'To fix this:\n' +
                  '1. Go to Torn Preferences → API\n' +
                  '2. Create a new API key or edit your existing key\n' +
                  '3. Set the access level to Limited or Full\n' +
                  '4. Copy the new key and enter it in the API Key field');
        } else {
            alert('Error fetching crime data: ' + error.message);
        }
    } finally {
        if (loadingSpinner) loadingSpinner.style.display = 'none';
        if (fetchBtn) fetchBtn.disabled = false;
        const loadB = document.getElementById('loadOcStatsCache');
        if (loadB) loadB.disabled = false;
        if (progressContainer) progressContainer.style.display = 'none';
        ocStatsData.isFetching = false; // Reset guard flag
        console.log('[ORGANISED CRIME STATS] Fetch complete');
    }
};

/** Rebuild stats from locally cached crimes (2 API calls: members + items only). */
const handleOCDataLoadFromCache = async () => {
    if (ocStatsData.isFetching) {
        console.warn('[ORGANISED CRIME STATS] Load already in progress');
        return;
    }
    const apiKey = (localStorage.getItem('tornApiKey') || '').trim();
    if (!apiKey) {
        alert('Please enter your API key in the sidebar first');
        return;
    }
    const crimes = loadOcStatsCrimesFromCache(apiKey);
    if (!crimes || crimes.length === 0) {
        alert('No cached crime list for this API key. Run "Fetch Crime Data" once to build the cache.');
        return;
    }

    ocStatsData.isFetching = true;
    const loadingSpinner = document.getElementById('loadingSpinner');
    const fetchBtn = document.getElementById('fetchOCData');
    const loadCacheBtn = document.getElementById('loadOcStatsCache');
    const resultsSection = document.querySelector('.results-section');
    const progressContainer = document.getElementById('progressContainer');
    const progressMessage = document.getElementById('progressMessage');
    const progressPercentage = document.getElementById('progressPercentage');
    const progressFill = document.getElementById('progressFill');
    const progressDetails = document.getElementById('progressDetails');

    try {
        if (loadingSpinner) loadingSpinner.style.display = 'inline-block';
        if (fetchBtn) fetchBtn.disabled = true;
        if (loadCacheBtn) loadCacheBtn.disabled = true;
        if (progressContainer) progressContainer.style.display = 'block';

        const progressRefs = {
            progressMessage,
            progressDetails,
            progressPercentage,
            progressFill,
            resultsSection
        };
        ocStatsSetProgress(
            progressRefs,
            18,
            'Loading from local cache…',
            `${crimes.length} completed crimes from localStorage — fetching live members, items, planning/recruiting OCs…`
        );

        await runOcStatsAfterCrimesReady(crimes, progressRefs);

        updateOcStatsCacheHint();
        if (progressContainer) progressContainer.style.display = 'none';
    } catch (error) {
        console.error('[ORGANISED CRIME STATS] Error loading from cache:', error);
        alert('Error loading from cache: ' + error.message);
    } finally {
        if (loadingSpinner) loadingSpinner.style.display = 'none';
        if (fetchBtn) fetchBtn.disabled = false;
        if (loadCacheBtn) loadCacheBtn.disabled = false;
        if (progressContainer) progressContainer.style.display = 'none';
        ocStatsData.isFetching = false;
    }
};

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** v2 /faction/crimes categories for in-flight OCs (Torn UI: Planning / Recruiting). */
const OC_STATS_ACTIVE_CRIME_CATS = ['planning', 'recruiting'];

/**
 * Stable key for deduping crimes across sessions (localStorage cache ↔ API).
 * Prefer API occurrence id; otherwise executed_at + difficulty + name slug.
 */
function ocStatsCrimeStableId(crime) {
    if (!crime || typeof crime !== 'object') return '';
    const nestedCrimeId =
        crime.crime && typeof crime.crime === 'object' && crime.crime.id != null ? crime.crime.id : null;
    const rawId =
        crime.id ??
        nestedCrimeId ??
        crime.crime_log_id ??
        crime.log_id ??
        crime.crime_instance_id ??
        crime.instance_id;
    if (rawId != null && String(rawId).trim() !== '') return String(rawId);
    const ex = crime.executed_at != null ? Number(crime.executed_at) : NaN;
    const d = crime.difficulty != null ? String(crime.difficulty) : '';
    const nm = String(crime.crime_name ?? crime.name ?? crime.title ?? '').trim().toLowerCase();
    const nmSlug = nm.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 96);
    if (Number.isFinite(ex) && nmSlug) return `__oc_${ex}_${d}_${nmSlug}`;
    if (crime.crime_id != null && Number.isFinite(ex)) return `cid_${crime.crime_id}_t_${ex}`;
    if (crime.crime_id != null) return `cid_${crime.crime_id}`;
    return '';
}

/**
 * Completed crimes are immutable; cache stays valid. API returns newest first (sort=DESC).
 * Merge: walk pages until an entire page is already in cache, then stop (older pages unchanged).
 */
async function ocStatsFetchCompletedCrimesMerged(apiKey, cachedCrimes, progressRefs) {
    const limit = 100;
    const mergedById = new Map();
    const hadCache = Array.isArray(cachedCrimes) && cachedCrimes.length > 0;

    ocStatsSetProgress(
        progressRefs,
        5,
        'Fetching organised crime data…',
        hadCache ? 'Loading crimes from local cache…' : 'No local cache — will download full completed-crime history…'
    );

    let skippedCachedNoKey = 0;
    if (hadCache) {
        for (const c of cachedCrimes) {
            const id = ocStatsCrimeStableId(c);
            if (id) mergedById.set(id, c);
            else skippedCachedNoKey++;
        }
        if (skippedCachedNoKey > 0) {
            console.warn(
                `[ORGANISED CRIME STATS] ${skippedCachedNoKey} cached crime(s) lacked a stable id (re-fetch may re-add them)`
            );
        }
        ocStatsSetProgress(
            progressRefs,
            12,
            'Fetching organised crime data…',
            `${mergedById.size} crime(s) from local cache — fetching only new completions from API…`
        );
    } else {
        ocStatsSetProgress(progressRefs, 8, 'Fetching organised crime data…', 'Downloading completed crimes from API…');
    }

    let newCrimesAdded = 0;
    let pageCount = 0;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        pageCount++;
        const pct = hadCache
            ? Math.min(64, 16 + pageCount * 18)
            : Math.min(64, 10 + pageCount * 6);
        const detail = hadCache
            ? `API page ${pageCount} — ${mergedById.size} total, +${newCrimesAdded} new (stops when a full page matches cache)`
            : `Downloading page ${pageCount}…`;
        ocStatsSetProgress(progressRefs, pct, 'Fetching organised crime data…', detail);

        const url = `https://api.torn.com/v2/faction/crimes?cat=completed&offset=${offset}&limit=${limit}&sort=DESC&key=${apiKey}`;
        const response = await fetch(ocStatsTornFetchUrl(url));
        const data = await response.json();

        if (data.error) {
            throw new Error(`API error: ${data.error.error}`);
        }

        const crimes = ocStatsNormalizeCrimesArray(data.crimes);

        if (crimes.length === 0) {
            hasMore = false;
            break;
        }

        let allSeenBefore = true;
        for (let i = 0; i < crimes.length; i++) {
            const crime = crimes[i];
            const id = ocStatsCrimeStableId(crime);
            if (!id) {
                console.warn('[ORGANISED CRIME STATS] Skipping API crime without stable id', crime);
                allSeenBefore = false;
                continue;
            }
            if (!mergedById.has(id)) {
                mergedById.set(id, crime);
                newCrimesAdded++;
                allSeenBefore = false;
            }
        }

        if (hadCache && allSeenBefore) {
            hasMore = false;
        } else if (!data._metadata?.links?.next) {
            hasMore = false;
        } else if (pageCount >= 50) {
            console.warn('[ORGANISED CRIME STATS] Reached safety limit of 50 crime pages');
            hasMore = false;
        } else {
            offset += limit;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    ocStatsSetProgress(
        progressRefs,
        66,
        'Fetching organised crime data…',
        hadCache
            ? `Crimes ready: ${mergedById.size} total (${newCrimesAdded} new from API, ${pageCount} page(s))`
            : `Crimes ready: ${mergedById.size} from API (${pageCount} page(s))`
    );

    return {
        mergedCrimes: Array.from(mergedById.values()),
        pageCount,
        newCrimesAdded,
        hadCache
    };
}

async function ocStatsFetchFactionCrimesPage(apiKey, cat, offset, limit, sort) {
    const catQ = cat ? `cat=${encodeURIComponent(cat)}&` : '';
    const url = `https://api.torn.com/v2/faction/crimes?${catQ}offset=${offset}&limit=${limit}&sort=${sort}&key=${apiKey}`;
    const response = await fetch(ocStatsTornFetchUrl(url));
    return response.json();
}

async function ocStatsFetchAllPagesForCat(apiKey, cat, progressDetails, label) {
    let all = [];
    let offset = 0;
    const limit = 100;
    const sort = 'ASC';
    let page = 0;
    let errObj = null;
    while (page < 25) {
        page++;
        if (progressDetails) progressDetails.textContent = `${label} (page ${page})…`;
        const data = await ocStatsFetchFactionCrimesPage(apiKey, cat, offset, limit, sort);
        if (data.error) {
            errObj = data.error;
            break;
        }
        const crimes = ocStatsNormalizeCrimesArray(data.crimes);
        all = all.concat(crimes);
        if (!data._metadata?.links?.next || crimes.length === 0) break;
        offset += limit;
        await new Promise((r) => setTimeout(r, 100));
    }
    return { crimes: all, error: errObj };
}

/**
 * Pull planning + recruiting organised crimes (deduped) for item-requirement overview.
 * @returns {Promise<{ crimes: object[], warnings: string[] }>}
 */
async function fetchActiveFactionCrimesForPlannedItemNeeds(apiKey, progressDetails) {
    const merged = [];
    const warnings = [];
    for (const cat of OC_STATS_ACTIVE_CRIME_CATS) {
        const { crimes, error } = await ocStatsFetchAllPagesForCat(
            apiKey,
            cat,
            progressDetails,
            `Fetching ${cat} OCs`
        );
        if (error) {
            if (error.code !== 21) {
                warnings.push(`${cat}: ${error.error || JSON.stringify(error)}`);
            }
            await new Promise((r) => setTimeout(r, 80));
            continue;
        }
        merged.push(...crimes);
        await new Promise((r) => setTimeout(r, 80));
    }
    const byId = new Map();
    merged.forEach((c) => {
        const sid = ocStatsCrimeStableId(c);
        if (!sid) return;
        if (!byId.has(sid)) byId.set(sid, c);
    });
    return { crimes: [...byId.values()], warnings };
}

function ocStatsItemRequirementIsMissing(req) {
    if (!req || typeof req !== 'object') return false;
    return req.is_available === false || req.is_available === 0;
}

function extractPlannedOcMissingItemRows(crimes, playerNames, itemsMap) {
    const names = playerNames || {};
    const items = itemsMap || {};
    const rows = [];
    const seen = new Set();
    if (!Array.isArray(crimes)) return rows;
    crimes.forEach((crime) => {
        const crimeName = crime.crime_name ?? crime.name ?? crime.title ?? 'Unknown OC';
        const slots = crime.slots;
        if (!Array.isArray(slots)) return;
        slots.forEach((slot) => {
            const req = slot && slot.item_requirement;
            if (!ocStatsItemRequirementIsMissing(req)) return;
            const itemId = req.id;
            if (itemId == null) return;
            const uid = slot.user && slot.user.id != null ? String(slot.user.id) : '';
            if (!uid) return;
            const itemRec = items[String(itemId)] || items[itemId];
            const itemName = itemRec && itemRec.name ? itemRec.name : `Item #${itemId}`;
            const playerName = names[uid] || `Player ${uid}`;
            const position = slot.position || (slot.position_info && slot.position_info.label) || '—';
            const dedupeKey = `${crimeName}\0${uid}\0${itemId}\0${position}`;
            if (seen.has(dedupeKey)) return;
            seen.add(dedupeKey);
            rows.push({
                playerId: uid,
                playerName,
                itemId: String(itemId),
                itemName,
                crimeName,
                position
            });
        });
    });
    rows.sort((a, b) => {
        const n = a.playerName.localeCompare(b.playerName);
        if (n !== 0) return n;
        const c = a.crimeName.localeCompare(b.crimeName);
        if (c !== 0) return c;
        return a.itemName.localeCompare(b.itemName);
    });
    return rows;
}

function renderOcPlannedMissingItemsPanel(rows, fetchWarnings) {
    const el = document.getElementById('ocPlannedMissingItems');
    if (!el) return;
    const warn =
        fetchWarnings && fetchWarnings.length
            ? `<p class="oc-planned-missing-warn">${escapeHtml(fetchWarnings.join(' · '))}</p>`
            : '';
    const count = rows.length;
    const summaryText =
        count === 0
            ? 'Planned / recruiting OCs — missing items (none right now)'
            : `Planned / recruiting OCs — missing items (${count})`;

    const linkExtra =
        typeof window.toolsMemberLinkAttrs === 'function' ? window.toolsMemberLinkAttrs : () => '';
    const playerCellLabel = (r) => {
        if (typeof window.toolsFormatMemberDisplayLabel === 'function') {
            const showId =
                typeof window.toolsGetShowMemberIdInBrackets === 'function'
                    ? window.toolsGetShowMemberIdInBrackets()
                    : false;
            return escapeHtml(
                window.toolsFormatMemberDisplayLabel({ id: r.playerId, name: r.playerName }, showId)
            );
        }
        return escapeHtml(r.playerName);
    };

    if (count === 0) {
        el.innerHTML = `
            <details class="summary-section oc-planned-missing-panel">
                <summary class="oc-planned-missing-summary">${escapeHtml(summaryText)}</summary>
                <p class="oc-planned-missing-note">No slots currently report a missing item (<code>item_requirement.is_available</code> is false), or there are no planning/recruiting crimes in the API response.</p>
                ${warn}
            </details>`;
        return;
    }

    const thead = `<thead><tr>
        <th>Player</th>
        <th>Item</th>
        <th>Crime</th>
        <th>Slot</th>
    </tr></thead>`;
    const tbodyRows = rows
        .map((r) => {
            const attrs = linkExtra(r.playerName, r.playerId);
            return `<tr>
                <td><a class="player-link" href="https://www.torn.com/profiles.php?XID=${escapeHtml(r.playerId)}" target="_blank" rel="noopener noreferrer"${attrs}>${playerCellLabel(r)}</a></td>
                <td>${escapeHtml(r.itemName)}</td>
                <td>${escapeHtml(r.crimeName)}</td>
                <td>${escapeHtml(r.position)}</td>
            </tr>`;
        })
        .join('');
    el.innerHTML = `
        <details class="summary-section oc-planned-missing-panel">
            <summary class="oc-planned-missing-summary">${escapeHtml(summaryText)}</summary>
            <div class="table-scroll-wrapper oc-planned-missing-table-wrap">
                <table class="oc-planned-missing-table" id="ocPlannedMissingTable">${thead}<tbody>${tbodyRows}</tbody></table>
            </div>
            ${warn}
        </details>`;
}

// Parse crime.rewards (money, items, and respect from API rewards object)
function parseCrimeRewards(rewards) {
    if (!rewards) return { money: 0, itemCount: 0, items: [], respect: 0 };
    if (typeof rewards === 'number') return { money: rewards, itemCount: 0, items: [], respect: 0 };
    const money = typeof rewards.money === 'number' ? rewards.money : 0;
    const respectRaw = rewards.respect;
    const respect =
        typeof respectRaw === 'number' && !Number.isNaN(respectRaw)
            ? respectRaw
            : typeof respectRaw === 'string' && respectRaw.trim() !== '' && !Number.isNaN(Number(respectRaw))
              ? Number(respectRaw)
              : 0;
    const rawItems = Array.isArray(rewards.items) ? rewards.items : [];
    let itemCount = 0;
    const items = rawItems.map(it => {
        const qty = typeof it.quantity === 'number' ? it.quantity : 1;
        itemCount += qty;
        const id = it.id != null ? it.id : it.name || '?';
        const name = it.name || it.label || `Item #${id}`;
        return { id, name, quantity: qty };
    });
    return { money, itemCount, items, respect };
}

/**
 * Turn API "items" that may be an array, a keyed object { "385": { quantity: 2 } }, or a single object into rows.
 */
function flattenCostItemContainer(val) {
    if (val == null) return [];
    if (Array.isArray(val)) return val.filter((x) => x != null);
    if (typeof val !== 'object') return [];
    // Single item row object (not a map of id → qty)
    if (
        val.id != null ||
        val.item_id != null ||
        val.item != null ||
        val.name != null ||
        val.item_name != null
    ) {
        return [val];
    }
    const keys = Object.keys(val);
    if (keys.length === 0) return [];
    return keys.map((k) => {
        const inner = val[k];
        const keyAsId = /^\d+$/.test(String(k)) ? Number(k) : k;
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            const id = inner.id ?? inner.item_id ?? inner.item?.id ?? keyAsId;
            const qty =
                typeof inner.quantity === 'number'
                    ? inner.quantity
                    : (typeof inner.qty === 'number'
                        ? inner.qty
                        : (typeof inner.amount === 'number'
                            ? inner.amount
                            : (typeof inner.count === 'number' ? inner.count : 1)));
            return { ...inner, id, quantity: qty };
        }
        const qty = typeof inner === 'number' ? inner : 1;
        return { id: keyAsId, quantity: qty };
    });
}

/**
 * Parse running costs from a completed crime (v2 faction crimes).
 * Money: common field names. Items: consumed vs used-but-returned — only consumed items count toward $ cost
 * (market value); returned/loan/reusable are listed separately in the UI.
 */
function parseCrimeCosts(crime) {
    let moneyCost = 0;
    const consumed = [];
    const usedNotConsumed = [];

    const addMoney = (v) => {
        if (typeof v === 'number' && !isNaN(v) && v > 0) moneyCost += v;
    };

    addMoney(crime.cost);
    addMoney(crime.money_cost);
    addMoney(crime.money_spent);
    addMoney(crime.total_cost);
    addMoney(crime.money_expense);
    addMoney(crime.spent);

    if (crime.cost && typeof crime.cost === 'object' && !Array.isArray(crime.cost)) {
        addMoney(crime.cost.money);
        addMoney(crime.cost.total);
        addMoney(crime.cost.amount);
    }

    if (crime.expenses && typeof crime.expenses === 'object' && !Array.isArray(crime.expenses)) {
        addMoney(crime.expenses.money);
        addMoney(crime.expenses.total);
        addMoney(crime.expenses.amount);
    }
    if (Array.isArray(crime.expenses)) {
        crime.expenses.forEach((ex) => {
            if (typeof ex === 'number') addMoney(ex);
            else if (ex && typeof ex === 'object') {
                addMoney(ex.money);
                addMoney(ex.amount);
                addMoney(ex.cost);
            }
        });
    }

    if (crime.planning && typeof crime.planning === 'object') {
        addMoney(crime.planning.cost);
        addMoney(crime.planning.money_cost);
        if (crime.planning.expenses && typeof crime.planning.expenses === 'object') {
            addMoney(crime.planning.expenses.money);
            addMoney(crime.planning.expenses.total);
        }
    }

    function classify(entry, defaultConsumed) {
        if (entry == null) return;
        if (typeof entry !== 'object') return;
        const id = entry.id ?? entry.item_id ?? entry.item?.id;
        const name = entry.name ?? entry.item?.name ?? entry.item_name ?? entry.label;
        const qtyRaw =
            typeof entry.quantity === 'number'
                ? entry.quantity
                : (typeof entry.qty === 'number'
                    ? entry.qty
                    : (typeof entry.amount === 'number'
                        ? entry.amount
                        : (typeof entry.count === 'number' ? entry.count : 1)));
        const qty = typeof qtyRaw === 'number' && !isNaN(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
        if (id == null && name == null) return;
        const row = { id: id != null ? id : String(name), name: name || `Item #${id}`, quantity: qty };
        const explicitConsumed = entry.consumed === true || entry.is_consumed === true;
        const explicitNotConsumed =
            entry.returned === true ||
            entry.loaned === true ||
            entry.consumed === false ||
            entry.is_consumed === false ||
            (entry.is_reusable === true && !explicitConsumed) ||
            (entry.reusable === true && !explicitConsumed);
        if (explicitConsumed) {
            consumed.push(row);
        } else if (explicitNotConsumed) {
            usedNotConsumed.push(row);
        } else if (defaultConsumed) {
            consumed.push(row);
        } else {
            usedNotConsumed.push(row);
        }
    }

    const itemRowSources = [];

    [
        crime.items,
        crime.requirements,
        crime.consumables,
        crime.cost_items,
        crime.items_used,
        crime.items_consumed,
        crime.expense_items,
        crime.expenses && typeof crime.expenses === 'object' && !Array.isArray(crime.expenses) ? crime.expenses.items : null,
        crime.cost && typeof crime.cost === 'object' ? crime.cost.items : null,
        crime.planning && typeof crime.planning === 'object' ? crime.planning.items : null
    ].forEach((c) => {
        itemRowSources.push(...flattenCostItemContainer(c));
    });

    itemRowSources.forEach((p) => classify(p, true));

    if (Array.isArray(crime.slots)) {
        crime.slots.forEach((slot) => {
            if (!slot || typeof slot !== 'object') return;
            // v2 faction/crimes: each slot may have item_requirement { id, is_reusable, is_available, ... }
            const req = slot.item_requirement;
            if (req && typeof req === 'object' && req.id != null) {
                const qtyRaw =
                    typeof req.quantity === 'number'
                        ? req.quantity
                        : (typeof req.qty === 'number' ? req.qty : 1);
                const qty = typeof qtyRaw === 'number' && !isNaN(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
                const row = { id: req.id, name: `Item #${req.id}`, quantity: qty };
                if (req.is_reusable === true || req.reusable === true) {
                    usedNotConsumed.push(row);
                } else {
                    consumed.push(row);
                }
            }
            const packs = [
                ...flattenCostItemContainer(slot.items),
                ...flattenCostItemContainer(slot.item),
                ...flattenCostItemContainer(slot.equipment),
                ...flattenCostItemContainer(slot.required_item),
                ...flattenCostItemContainer(slot.consumables),
                ...flattenCostItemContainer(slot.requirements),
                ...flattenCostItemContainer(slot.requirement),
                ...flattenCostItemContainer(slot.consumed_items),
                ...flattenCostItemContainer(slot.items_consumed)
            ];
            if (slot.cost && typeof slot.cost === 'object' && !Array.isArray(slot.cost)) {
                addMoney(slot.cost.money);
                addMoney(slot.cost.total);
                packs.push(...flattenCostItemContainer(slot.cost.items));
            }
            if (slot.expenses && typeof slot.expenses === 'object' && !Array.isArray(slot.expenses)) {
                addMoney(slot.expenses.money);
                addMoney(slot.expenses.total);
                packs.push(...flattenCostItemContainer(slot.expenses.items));
            }
            packs.forEach((p) => classify(p, true));
        });
    }

    return { moneyCost, consumed, usedNotConsumed };
}

function applyCostToStat(stat, costParsed) {
    if (!stat || !costParsed) return;
    stat.totalCostMoney = (stat.totalCostMoney || 0) + costParsed.moneyCost;
    mergeItemBreakdown(stat.costItemsBreakdown, costParsed.consumed);
    mergeItemBreakdown(stat.usedNotConsumedBreakdown, costParsed.usedNotConsumed);
}

// Merge parsed items into a breakdown object keyed by item id: { [id]: { name, quantity } }
function mergeItemBreakdown(breakdown, items) {
    (items || []).forEach(it => {
        const key = String(it.id != null ? it.id : (it.name || it.label || '?'));
        const name = it.name || it.label || `Item #${key}`;
        const qty = it.quantity || 1;
        if (!breakdown[key]) breakdown[key] = { name, quantity: 0 };
        breakdown[key].quantity += qty;
        if (name && !breakdown[key].name) breakdown[key].name = name;
    });
}

// Compute total item value from breakdown using itemsMap (current market value)
function getTotalItemsValue(breakdown, itemsMap) {
    if (!breakdown || !itemsMap) return 0;
    let total = 0;
    Object.entries(breakdown).forEach(([id, v]) => {
        if (!v || !v.quantity) return;
        const item = itemsMap[id] || itemsMap[String(id)];
        const marketVal = (item && item.market_value != null) ? item.market_value : 0;
        total += (v.quantity || 0) * marketVal;
    });
    return total;
}

// Sum total reward value (cash + items) across difficulty stats for the summary
function getTotalRewardValue(difficultyStats) {
    const itemsMap = ocStatsData.itemsMap || {};
    return (difficultyStats || []).reduce((sum, stat) => {
        const cash = stat.totalRewardMoney || 0;
        const itemsVal = getTotalItemsValue(stat.rewardItemsBreakdown, itemsMap);
        return sum + cash + itemsVal;
    }, 0);
}

function getTotalCostValue(difficultyStats) {
    const itemsMap = ocStatsData.itemsMap || {};
    return (difficultyStats || []).reduce((sum, stat) => {
        const cash = stat.totalCostMoney || 0;
        const itemsVal = getTotalItemsValue(stat.costItemsBreakdown, itemsMap);
        return sum + cash + itemsVal;
    }, 0);
}

/** Sum `rewards.respect` from successful crimes (per difficulty stat rows). */
function getTotalRespectValue(difficultyStats) {
    return (difficultyStats || []).reduce((sum, stat) => sum + (Number(stat.totalRewardRespect) || 0), 0);
}

function formatRespect(n) {
    const x = Math.round(Number(n) || 0);
    return x.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function getDifficultyStatRewardValue(stat) {
    const itemsMap = ocStatsData.itemsMap || {};
    return (stat.totalRewardMoney || 0) + getTotalItemsValue(stat.rewardItemsBreakdown, itemsMap);
}

function getDifficultyStatCostValue(stat) {
    const itemsMap = ocStatsData.itemsMap || {};
    return (stat.totalCostMoney || 0) + getTotalItemsValue(stat.costItemsBreakdown, itemsMap);
}

function getDifficultyStatNetValue(stat) {
    return getDifficultyStatRewardValue(stat) - getDifficultyStatCostValue(stat);
}

/** Numeric value for table sort / CSV (Rewards column sorts by cash + items, not cash alone). */
function getDifficultySortValue(stat, column) {
    switch (column) {
        case 'rewardValue':
            return getDifficultyStatRewardValue(stat);
        case 'costValue':
            return getDifficultyStatCostValue(stat);
        case 'netValue':
            return getDifficultyStatNetValue(stat);
        default:
            return stat[column];
    }
}

function ocStatsFactionCutPercentActive() {
    const factionCutInput = document.getElementById('ocFactionCutPercent');
    return factionCutInput ? Math.min(100, Math.max(0, parseFloat(factionCutInput.value) || 0)) : 20;
}

/** Cash + item-dollar share for one logged participation row (matches Rewards column split logic). */
function ocStatsPlayerParticipationRowEarnings(row, itemsMap, factionCutPct) {
    const cash = Number(row && row.cashShare) || 0;
    const cut = Math.min(100, Math.max(0, Number(factionCutPct)));
    const afterCut = 1 - cut / 100;
    const crimeItemsValue = getTotalItemsValue(row && row.itemsBreakdown, itemsMap);
    const participants = (row && row.participantsInCrime) || 1;
    return cash + (crimeItemsValue * afterCut) / participants;
}

// Player's total reward value: their share of cash (already stored) + their share of item value per crime (faction cut and split)
function getPlayerTotalRewardValue(player) {
    const cashShare = player.totalRewardMoney || 0;
    const itemsMap = ocStatsData.itemsMap || {};
    const factionCutPct = ocStatsFactionCutPercentActive();
    const afterCutMultiplier = 1 - factionCutPct / 100;
    let itemsShare = 0;
    (player.rewardParticipations || []).forEach(part => {
        const crimeItemsValue = getTotalItemsValue(part.itemsBreakdown, itemsMap);
        const participants = part.participantsInCrime || 1;
        itemsShare += crimeItemsValue * afterCutMultiplier / participants;
    });
    return cashShare + itemsShare;
}

/** HTML for the expandable player section: one table row per OC slot participation. */
function ocStatsRenderPlayerCrimeParticipationsTableHtml(player, itemsMap, factionCutPct) {
    const rows = player.playerCrimeParticipations || [];
    if (!rows.length) {
        return '<p style="color:#888;margin:0;">No crime rows recorded.</p>';
    }
    const map = itemsMap || {};
    let tbody = '';
    rows.forEach(row => {
        const dateStr =
            row.executedAt != null && Number.isFinite(Number(row.executedAt))
                ? formatOcCrimeExecutedShort(row.executedAt) || '—'
                : '—';
        const earn = ocStatsPlayerParticipationRowEarnings(row, map, factionCutPct);
        const earnCell =
            earn > 0
                ? `<span style="color: var(--accent-color); font-weight: bold;">${formatDollars(earn)}</span>`
                : '—';
        const outcomeHtml = row.slotSuccessful
            ? '<span style="color: #4ecdc4; font-weight: bold;">Success</span>'
            : '<span style="color: #ff6b6b; font-weight: bold;">Failed</span>';
        tbody += `
                            <tr style="border-bottom: 1px solid var(--border-color);">
                                <td style="padding: 8px; text-align: center; color: #ddd;">${escapeHtml(dateStr)}</td>
                                <td style="padding: 8px; text-align: center; font-weight: bold;">${Number(row.difficulty) || 0}/10</td>
                                <td style="padding: 8px; text-align: left;">${escapeHtml(row.crimeName || 'Unknown crime')}</td>
                                <td style="padding: 8px; text-align: center;">${outcomeHtml}</td>
                                <td style="padding: 8px; text-align: center; white-space: nowrap;">${earnCell}</td>
                            </tr>`;
    });
    return `
                                <h4 style="margin: 0 0 15px 0; color: var(--accent-color);">Crimes for ${escapeHtml(player.name)}</h4>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <thead>
                                        <tr>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Date</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Difficulty</th>
                                            <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Crime</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Your outcome</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);" title="Your estimated share when this crime paid out (cash + priced items), after faction cut %">Earnings</th>
                                        </tr>
                                    </thead>
                                    <tbody>${tbody}
                                    </tbody>
                                </table>`;
}

/** Sort key for player rows — must match Rewards column (cash + item share), not totalRewardMoney alone. */
function getPlayerSortValue(player, column) {
    if (column === 'totalRewardMoney') {
        return getPlayerTotalRewardValue(player);
    }
    if (column === 'highestDifficultySucceeded') {
        return Number(player.highestDifficultySucceeded) || 0;
    }
    const v = player[column];
    return typeof v === 'number' ? v : Number(v) || 0;
}

// Format amount as whole dollars (no decimals)
function formatDollars(n) {
    return '$' + Math.round(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0, minimumFractionDigits: 0 });
}

/** HTML lines for one reward item breakdown (matches Rewards column styling). */
function formatOcRewardItemsBreakdownHtml(breakdown, itemsMap) {
    if (!breakdown || !itemsMap) return '';
    const entries = Object.entries(breakdown).filter(([, v]) => v && v.quantity > 0);
    return entries
        .map(([id, v]) => {
            const item = itemsMap[id] || itemsMap[String(id)];
            const name = (item && item.name) ? item.name : (v.name || `Item #${id}`);
            const qty = v.quantity || 1;
            const marketVal = item && item.market_value != null ? item.market_value : null;
            const totalVal = marketVal != null && marketVal > 0 ? marketVal * qty : null;
            const imgSrc = item && item.image ? String(item.image).replace(/"/g, '&quot;') : '';
            const img = imgSrc
                ? `<img src="${imgSrc}" alt="" class="reward-item-img" style="width:20px;height:20px;vertical-align:middle;margin-right:4px;">`
                : '';
            const valueStr =
                totalVal != null ? ` <span style="color: var(--accent-color);">(${formatDollars(totalVal)})</span>` : '';
            return img + `${qty}× ${escapeHtml(name)}` + valueStr;
        })
        .join('<br>');
}

function ocStatsPayoutHasRewardItems(p) {
    const b = p && p.rewardItemsBreakdown;
    if (!b || typeof b !== 'object') return false;
    return Object.values(b).some(v => v && v.quantity > 0);
}

// Format reward summary text (money + item count) — used for CSV export
function formatRewardsSummary(record) {
    const money = record.totalRewardMoney || 0;
    const itemCount = record.totalRewardItemCount || 0;
    const lines = [];
    if (money > 0) lines.push(formatDollars(money));
    if (itemCount > 0) lines.push(itemCount + ' item' + (itemCount !== 1 ? 's' : ''));
    return lines.length ? lines.join(' · ') : '—';
}

// Build rewards cell: for difficulty stats show total + Details (Cash + items). For players show only total value (their share after faction cut and split).
function formatRewardsCell(record) {
    // Player: only ever receive a monetary value — show their share of total crime value (cash + items) after faction cut and participant split
    if (Array.isArray(record.rewardParticipations)) {
        const totalValue = getPlayerTotalRewardValue(record);
        return totalValue > 0 ? formatDollars(totalValue) : '—';
    }

    // Difficulty stat: total value with Details (Cash + item breakdown)
    const cash = record.totalRewardMoney || 0;
    const breakdown = record.rewardItemsBreakdown || {};
    const itemsMap = ocStatsData.itemsMap || {};
    const itemsValue = getTotalItemsValue(breakdown, itemsMap);
    const totalValue = cash + itemsValue;

    const totalDisplay = totalValue > 0 ? formatDollars(totalValue) : '—';
    const entries = Object.entries(breakdown).filter(([, v]) => v && v.quantity > 0);
    const hasDetails = cash > 0 || entries.length > 0;

    if (!hasDetails) return totalDisplay;

    const cashPayouts = Array.isArray(record.successfulCashPayouts) ? record.successfulCashPayouts : null;
    const usePerCrimeRewards =
        cashPayouts &&
        cashPayouts.length > 0 &&
        (cash > 0 || entries.length > 0 || cashPayouts.some(ocStatsPayoutHasRewardItems));

    let cashBlock = '';
    if (usePerCrimeRewards) {
        const sorted = [...cashPayouts].sort(
            (a, b) => (Number(a.executedAt) || 0) - (Number(b.executedAt) || 0)
        );
        const lines = sorted
            .map((p, i) => {
                const dateStr = formatOcCrimeExecutedShort(p.executedAt);
                const perItems = p.rewardItemsBreakdown || {};
                const hasPerItems = ocStatsPayoutHasRewardItems(p);
                const cashAmt =
                    (p.cash || 0) > 0
                        ? `<span style="color: var(--accent-color);">${formatDollars(p.cash)}</span>`
                        : hasPerItems
                          ? ''
                          : '<span style="color:#888;">$0</span>';
                const headBits = [`${i + 1}.`];
                if (p.crimeName) {
                    headBits.push(`<span style="color:#ddd;">${escapeHtml(String(p.crimeName))}</span>`);
                }
                if (dateStr) {
                    headBits.push(`<span style="color:#aaa;">${escapeHtml(dateStr)}</span>`);
                }
                if (cashAmt) headBits.push(cashAmt);
                const lineMain = headBits.join(' · ');
                const itemsSub = hasPerItems
                    ? `<div style="margin:4px 0 8px 14px;font-size:0.92em;line-height:1.35;"><span style="color:#bbb;">Items:</span><br>${formatOcRewardItemsBreakdownHtml(perItems, itemsMap)}</div>`
                    : '';
                return `<div style="text-align:left;">${lineMain}</div>${itemsSub}`;
            })
            .join('');
        cashBlock = `<div style="margin-bottom:6px;"><strong style="color:#bbb;font-size:0.9em;">Rewards per successful crime</strong>${lines}</div>`;
    } else if (cash > 0) {
        cashBlock = `<div>Cash: <span style="color: var(--accent-color);">(${formatDollars(cash)})</span></div>`;
    }

    const listHtml = entries.map(([id, v]) => {
        const item = itemsMap[id] || itemsMap[String(id)];
        const name = (item && item.name) ? item.name : (v.name || `Item #${id}`);
        const qty = v.quantity || 1;
        const marketVal = (item && item.market_value != null) ? item.market_value : null;
        const totalVal = (marketVal != null && marketVal > 0) ? marketVal * qty : null;
        const imgSrc = (item && item.image) ? String(item.image).replace(/"/g, '&quot;') : '';
        const img = imgSrc ? `<img src="${imgSrc}" alt="" class="reward-item-img" style="width:20px;height:20px;vertical-align:middle;margin-right:4px;">` : '';
        const valueStr = totalVal != null ? ` <span style="color: var(--accent-color);">(${formatDollars(totalVal)})</span>` : '';
        return img + `${qty}× ${name}` + valueStr;
    }).join('<br>');
    const itemsBlock = listHtml ? (cashBlock ? '<br>' : '') + listHtml : '';

    const scrollExtra =
        usePerCrimeRewards && cashPayouts.length > 8 ? 'max-height:260px;overflow-y:auto;' : '';
    const detailsContent = `<div style="margin-top: 4px; padding: 6px 8px; background: var(--secondary-color); border-radius: 4px; font-size: 0.85em; max-width: 380px; ${scrollExtra}">${cashBlock}${itemsBlock}</div>`;
    return totalDisplay + ' <details class="reward-details" style="display: inline; margin-left: 6px;"><summary style="cursor: pointer; color: var(--accent-color); font-size: 0.85em;">Details</summary>' + detailsContent + '</details>';
}

/** Running cost cell: money + consumed items (market value); Details lists consumed vs used-not-consumed. */
function formatCostCell(record) {
    const cash = record.totalCostMoney || 0;
    const breakdown = record.costItemsBreakdown || {};
    const usedBreakdown = record.usedNotConsumedBreakdown || {};
    const itemsMap = ocStatsData.itemsMap || {};
    const itemsValue = getTotalItemsValue(breakdown, itemsMap);
    const totalValue = cash + itemsValue;
    const costSummaryColor = '#ffab91';
    const totalDisplayHtml =
        totalValue > 0
            ? `<span style="color: ${costSummaryColor};">${formatDollars(totalValue)}</span>`
            : '<span style="color: #888;">—</span>';

    const entries = Object.entries(breakdown).filter(([, v]) => v && v.quantity > 0);
    const usedEntries = Object.entries(usedBreakdown).filter(([, v]) => v && v.quantity > 0);
    const hasDetails = cash > 0 || entries.length > 0 || usedEntries.length > 0;
    if (!hasDetails) return totalDisplayHtml;

    const cashLine = cash > 0 ? `<div>Money: <span style="color: #ffab91;">${formatDollars(cash)}</span></div>` : '';
    const listHtml = entries.map(([id, v]) => {
        const item = itemsMap[id] || itemsMap[String(id)];
        const name = (item && item.name) ? item.name : (v.name || `Item #${id}`);
        const qty = v.quantity || 1;
        const marketVal = (item && item.market_value != null) ? item.market_value : null;
        const totalVal = (marketVal != null && marketVal > 0) ? marketVal * qty : null;
        const imgSrc = (item && item.image) ? String(item.image).replace(/"/g, '&quot;') : '';
        const img = imgSrc ? `<img src="${imgSrc}" alt="" class="reward-item-img" style="width:20px;height:20px;vertical-align:middle;margin-right:4px;">` : '';
        const valueStr = totalVal != null ? ` <span style="color: #ffab91;">(${formatDollars(totalVal)})</span>` : '';
        return img + `${qty}× ${escapeHtml(name)} <span style="color:#aaa;">(consumed)</span>` + valueStr;
    }).join('<br>');

    const usedHtml = usedEntries.map(([id, v]) => {
        const item = itemsMap[id] || itemsMap[String(id)];
        const name = (item && item.name) ? item.name : (v.name || `Item #${id}`);
        const qty = v.quantity || 1;
        const imgSrc = (item && item.image) ? String(item.image).replace(/"/g, '&quot;') : '';
        const img = imgSrc ? `<img src="${imgSrc}" alt="" class="reward-item-img" style="width:20px;height:20px;vertical-align:middle;margin-right:4px;">` : '';
        return img + `${qty}× ${escapeHtml(name)} <span style="color:#888;">(used, not consumed)</span>`;
    }).join('<br>');

    const consumedInner = `${cashLine}${listHtml ? (cashLine ? '<br>' : '') + listHtml : ''}`;
    const consumedBlock =
        (cashLine || listHtml)
            ? `<div style="margin-bottom:8px;"><strong style="color:#bbb;font-size:0.9em;">Counted toward cost</strong><br>${consumedInner}</div>`
            : '';
    const usedBlock = usedHtml
        ? `<div><strong style="color:#bbb;font-size:0.9em;">Used but not consumed</strong><br>${usedHtml}</div>`
        : '';
    const detailsContent = `<div style="margin-top: 4px; padding: 6px 8px; background: var(--secondary-color); border-radius: 4px; font-size: 0.85em; max-width: 360px;">${consumedBlock || ''}${usedBlock}</div>`;
    return totalDisplayHtml + ' <details class="cost-details" style="display: inline; margin-left: 6px;"><summary style="cursor: pointer; color: var(--accent-color); font-size: 0.85em;">Details</summary>' + detailsContent + '</details>';
}

function ocStatsMergeDifficultyBreakdown(difficultyStats, field) {
    const out = {};
    (difficultyStats || []).forEach(stat => {
        const b = stat[field];
        if (!b || typeof b !== 'object') return;
        Object.entries(b).forEach(([id, v]) => {
            if (!v || !v.quantity) return;
            const q = Number(v.quantity) || 0;
            if (!out[id]) out[id] = { name: v.name, quantity: 0 };
            out[id].quantity += q;
            if (v.name && !out[id].name) out[id].name = v.name;
        });
    });
    return out;
}

function ocStatsSummaryTotalRewardCash(difficultyStats) {
    return (difficultyStats || []).reduce((s, st) => s + (Number(st.totalRewardMoney) || 0), 0);
}

function ocStatsSummaryTotalCostCash(difficultyStats) {
    return (difficultyStats || []).reduce((s, st) => s + (Number(st.totalCostMoney) || 0), 0);
}

function formatOcSummaryRewardsDetailsBody(difficultyStats) {
    const itemsMap = ocStatsData.itemsMap || {};
    const cash = ocStatsSummaryTotalRewardCash(difficultyStats);
    const merged = ocStatsMergeDifficultyBreakdown(difficultyStats, 'rewardItemsBreakdown');
    const itemsVal = getTotalItemsValue(merged, itemsMap);
    const itemsListHtml = formatOcRewardItemsBreakdownHtml(merged, itemsMap);
    if (cash <= 0 && !itemsListHtml) return '';

    const cashLine =
        cash > 0
            ? `<div>Cash: <span style="color: var(--accent-color);">${formatDollars(cash)}</span></div>`
            : '';
    const itemsSection = itemsListHtml
        ? `<div style="margin-top:${cashLine ? '10px' : '0'};"><strong style="color:#bbb;font-size:0.95em;">Items</strong><br>${itemsListHtml}<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border-color);">Combined item value: <span style="color:var(--accent-color);">${formatDollars(itemsVal)}</span></div></div>`
        : '';
    return `<div style="margin-top: 4px; padding: 8px 10px; background: var(--secondary-color); border-radius: 4px; font-size: 0.88em; max-width: min(420px, 92vw); max-height: 300px; overflow-y: auto;">${cashLine}${itemsSection}</div>`;
}

function formatOcSummaryCostDetailsBody(difficultyStats) {
    const itemsMap = ocStatsData.itemsMap || {};
    const cash = ocStatsSummaryTotalCostCash(difficultyStats);
    const breakdown = ocStatsMergeDifficultyBreakdown(difficultyStats, 'costItemsBreakdown');
    const usedBreakdown = ocStatsMergeDifficultyBreakdown(difficultyStats, 'usedNotConsumedBreakdown');
    const consumedVal = getTotalItemsValue(breakdown, itemsMap);
    const entries = Object.entries(breakdown).filter(([, v]) => v && v.quantity > 0);
    const usedEntries = Object.entries(usedBreakdown).filter(([, v]) => v && v.quantity > 0);
    if (cash <= 0 && entries.length === 0 && usedEntries.length === 0) return '';

    const cashLine = cash > 0 ? `<div>Money: <span style="color: #ffab91;">${formatDollars(cash)}</span></div>` : '';
    const listHtml = entries
        .map(([id, v]) => {
            const item = itemsMap[id] || itemsMap[String(id)];
            const name = (item && item.name) ? item.name : (v.name || `Item #${id}`);
            const qty = v.quantity || 1;
            const marketVal = item && item.market_value != null ? item.market_value : null;
            const totalVal = marketVal != null && marketVal > 0 ? marketVal * qty : null;
            const imgSrc = item && item.image ? String(item.image).replace(/"/g, '&quot;') : '';
            const img = imgSrc
                ? `<img src="${imgSrc}" alt="" class="reward-item-img" style="width:20px;height:20px;vertical-align:middle;margin-right:4px;">`
                : '';
            const valueStr = totalVal != null ? ` <span style="color: #ffab91;">(${formatDollars(totalVal)})</span>` : '';
            return img + `${qty}× ${escapeHtml(name)} <span style="color:#aaa;">(consumed)</span>` + valueStr;
        })
        .join('<br>');

    const usedHtml = usedEntries
        .map(([id, v]) => {
            const item = itemsMap[id] || itemsMap[String(id)];
            const name = (item && item.name) ? item.name : (v.name || `Item #${id}`);
            const qty = v.quantity || 1;
            const imgSrc = item && item.image ? String(item.image).replace(/"/g, '&quot;') : '';
            const img = imgSrc
                ? `<img src="${imgSrc}" alt="" class="reward-item-img" style="width:20px;height:20px;vertical-align:middle;margin-right:4px;">`
                : '';
            return img + `${qty}× ${escapeHtml(name)} <span style="color:#888;">(used, not consumed)</span>`;
        })
        .join('<br>');

    const consumedItemsFooter =
        listHtml && consumedVal > 0
            ? `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border-color);">Consumed items value: <span style="color:#ffab91;">${formatDollars(consumedVal)}</span></div>`
            : '';

    const consumedInner = `${cashLine}${listHtml ? (cashLine ? '<br>' : '') + listHtml : ''}${consumedItemsFooter}`;
    const consumedBlock =
        cashLine || listHtml
            ? `<div style="margin-bottom:10px;"><strong style="color:#bbb;font-size:0.95em;">Counted toward cost</strong><br>${consumedInner}</div>`
            : '';
    const usedBlock = usedHtml
        ? `<div><strong style="color:#bbb;font-size:0.95em;">Used but not consumed</strong><br>${usedHtml}</div>`
        : '';

    return `<div style="margin-top: 4px; padding: 8px 10px; background: var(--secondary-color); border-radius: 4px; font-size: 0.88em; max-width: min(420px, 92vw); max-height: 300px; overflow-y: auto;">${consumedBlock}${usedBlock}</div>`;
}

function formatOcSummaryRewardValueWithDetails(difficultyStats, totalValue) {
    const body = formatOcSummaryRewardsDetailsBody(difficultyStats);
    const main = `<span style="color: var(--accent-color);">${formatDollars(totalValue)}</span>`;
    if (!body) return main;
    return `<div style="display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:flex-start;gap:6px;max-width:100%;"><span>${main}</span><details class="oc-summary-totals-details"><summary style="cursor:pointer;color:var(--accent-color);font-size:1em;line-height:1;user-select:none;" title="Cash &amp; items breakdown">▼</summary>${body}</details></div>`;
}

function formatOcSummaryCostValueWithDetails(difficultyStats, totalCostValue) {
    const body = formatOcSummaryCostDetailsBody(difficultyStats);
    const main = `<span style="color: #ffab91;">${formatDollars(totalCostValue)}</span>`;
    if (!body) return main;
    return `<div style="display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:flex-start;gap:6px;max-width:100%;"><span>${main}</span><details class="oc-summary-totals-details"><summary style="cursor:pointer;color:var(--accent-color);font-size:1em;line-height:1;user-select:none;" title="Money &amp; items breakdown">▼</summary>${body}</details></div>`;
}

function formatNetCell(stat) {
    const n = getDifficultyStatNetValue(stat);
    const color = n >= 0 ? '#4ecdc4' : '#ff6b6b';
    return `<span style="color: ${color}; font-weight: bold;">${formatDollars(n)}</span>`;
}

function processCrimeData(crimes, playerNames = {}, currentMemberIds = new Set(), factionCutPercent = 20) {
    console.log('[ORGANISED CRIME STATS] Processing crime data...');
    console.log(`[ORGANISED CRIME STATS] Filtering by ${currentMemberIds.size} current members`);
    
    // Initialize difficulty stats (1-10)
    const difficultyMap = {};
    for (let i = 1; i <= 10; i++) {
        difficultyMap[i] = {
            difficulty: i,
            total: 0,
            successful: 0,
            failed: 0,
            successRate: 0,
            totalRewardMoney: 0,
            totalRewardItemCount: 0,
            totalRewardRespect: 0,
            rewardItemsBreakdown: {},
            successfulCashPayouts: [],
            totalCostMoney: 0,
            costItemsBreakdown: {},
            usedNotConsumedBreakdown: {},
            crimeTypes: {} // { [key]: { ..., rewardItemsBreakdown, successfulCashPayouts[] per success } }
        };
    }
    
    // Initialize player stats for ALL current members
    const playerMap = {};
    currentMemberIds.forEach(memberId => {
        playerMap[memberId] = {
            id: memberId,
            name: playerNames[memberId] || `Player ${memberId}`,
            totalParticipations: 0,
            successfulParticipations: 0,
            failedParticipations: 0,
            highestDifficultySucceeded: 0,
            totalScore: 0,
            successRate: 0,
            totalRewardMoney: 0,
            totalRewardItemCount: 0,
            rewardItemsBreakdown: {},
            rewardParticipations: [], // Per-crime: { itemsBreakdown, participantsInCrime } for computing player share of total value
            difficultyBreakdown: {},
            difficultyCrimeTypeBreakdown: {}, // { [difficulty]: { [crimeTypeKey]: { crimeName, total, successful, failed } } }
            playerCrimeParticipations: [] // One row per slot: details table + CSV crime log
        };
        
        // Initialize difficulty breakdown
        for (let i = 1; i <= 10; i++) {
            playerMap[memberId].difficultyBreakdown[i] = {
                successful: 0,
                failed: 0,
                total: 0
            };
        }
    });
    
    // Process each crime
    crimes.forEach(crime => {
        const difficulty = crime.difficulty;
        const status = crime.status;
        
        // Check if any participant in this crime is a current member
        let hasCurrentMember = false;
        if (crime.slots && Array.isArray(crime.slots)) {
            hasCurrentMember = crime.slots.some(slot => 
                slot.user && slot.user.id && currentMemberIds.has(slot.user.id.toString())
            );
        }
        
        // Rewards only for successful crimes
        const rewardParsed =
            status === 'Successful' && crime.rewards
                ? parseCrimeRewards(crime.rewards)
                : { money: 0, itemCount: 0, items: [], respect: 0 };
        
        // All filled slots split the crime reward in-game (includes members who left the faction).
        // Using only current roster count inflated each tracked member's share (e.g. 6 real slots / 4 current = ~1.5×).
        let participantsInCrime = 0;
        if (crime.slots && Array.isArray(crime.slots)) {
            participantsInCrime = crime.slots.filter(slot => slot.user && slot.user.id).length;
        }
        
        // Group by subtype name (used for both difficulty stats and player breakdown)
        const crimeName = crime.crime_name ?? crime.name ?? crime.title ?? ('Crime #' + (crime.crime_id ?? crime.type ?? 'unknown'));
        const crimeTypeKey = String(crimeName).trim().toLowerCase();
        
        // Only count this crime if at least one current member participated
        if (hasCurrentMember) {
            // Update difficulty stats
            if (difficultyMap[difficulty]) {
                difficultyMap[difficulty].total++;
                if (status === 'Successful') {
                    difficultyMap[difficulty].successful++;
                    difficultyMap[difficulty].totalRewardMoney += rewardParsed.money;
                    difficultyMap[difficulty].totalRewardItemCount += rewardParsed.itemCount;
                    difficultyMap[difficulty].totalRewardRespect += rewardParsed.respect || 0;
                    mergeItemBreakdown(difficultyMap[difficulty].rewardItemsBreakdown, rewardParsed.items);
                    const payoutRewardItems = {};
                    mergeItemBreakdown(payoutRewardItems, rewardParsed.items);
                    difficultyMap[difficulty].successfulCashPayouts.push({
                        cash: rewardParsed.money || 0,
                        executedAt: crime.executed_at != null ? Number(crime.executed_at) : null,
                        crimeName,
                        rewardItemsBreakdown: payoutRewardItems
                    });
                } else {
                    difficultyMap[difficulty].failed++;
                }
                // Per–crime-type stats under this difficulty
                if (!difficultyMap[difficulty].crimeTypes[crimeTypeKey]) {
                    difficultyMap[difficulty].crimeTypes[crimeTypeKey] = {
                        crimeId: crimeTypeKey,
                        crimeName,
                        total: 0,
                        successful: 0,
                        failed: 0,
                        totalRewardMoney: 0,
                        totalRewardItemCount: 0,
                        totalRewardRespect: 0,
                        rewardItemsBreakdown: {},
                        successfulCashPayouts: [],
                        totalCostMoney: 0,
                        costItemsBreakdown: {},
                        usedNotConsumedBreakdown: {}
                    };
                }
                const ct = difficultyMap[difficulty].crimeTypes[crimeTypeKey];
                ct.total++;
                if (status === 'Successful') {
                    ct.successful++;
                    ct.totalRewardMoney += rewardParsed.money;
                    ct.totalRewardItemCount += rewardParsed.itemCount;
                    ct.totalRewardRespect += rewardParsed.respect || 0;
                    mergeItemBreakdown(ct.rewardItemsBreakdown, rewardParsed.items);
                    const ctPayoutItems = {};
                    mergeItemBreakdown(ctPayoutItems, rewardParsed.items);
                    ct.successfulCashPayouts.push({
                        cash: rewardParsed.money || 0,
                        executedAt: crime.executed_at != null ? Number(crime.executed_at) : null,
                        rewardItemsBreakdown: ctPayoutItems
                    });
                } else {
                    ct.failed++;
                }
                const costParsed = parseCrimeCosts(crime);
                applyCostToStat(difficultyMap[difficulty], costParsed);
                applyCostToStat(ct, costParsed);
            }
        }
        
        // Process player participations (only for current members)
        if (crime.slots && Array.isArray(crime.slots)) {
            const playerShareMultiplier = participantsInCrime > 0 ? (1 - Math.min(100, Math.max(0, factionCutPercent)) / 100) / participantsInCrime : 0;
            crime.slots.forEach(slot => {
                if (slot.user && slot.user.id) {
                    const playerId = slot.user.id.toString();
                    const outcome = slot.user.outcome;
                    
                    // Only track if this player is a current member
                    if (currentMemberIds.has(playerId)) {
                        // Player should already be initialized, but double-check
                        if (!playerMap[playerId]) {
                            playerMap[playerId] = {
                                id: playerId,
                                name: playerNames[playerId] || `Player ${playerId}`,
                                totalParticipations: 0,
                                successfulParticipations: 0,
                                failedParticipations: 0,
                                highestDifficultySucceeded: 0,
                                totalScore: 0,
                                successRate: 0,
                                totalRewardMoney: 0,
                                totalRewardItemCount: 0,
                                rewardItemsBreakdown: {},
                                rewardParticipations: [],
                                difficultyBreakdown: {},
                                difficultyCrimeTypeBreakdown: {},
                                playerCrimeParticipations: []
                            };
                            for (let i = 1; i <= 10; i++) playerMap[playerId].difficultyBreakdown[i] = { successful: 0, failed: 0, total: 0 };
                        }
                    
                        // Count participation
                        playerMap[playerId].totalParticipations++;
                        
                        const difficulty = crime.difficulty;
                        
                        if (!playerMap[playerId].difficultyCrimeTypeBreakdown[difficulty]) {
                            playerMap[playerId].difficultyCrimeTypeBreakdown[difficulty] = {};
                        }
                        const pct = playerMap[playerId].difficultyCrimeTypeBreakdown[difficulty];
                        if (!pct[crimeTypeKey]) {
                            pct[crimeTypeKey] = {
                                crimeTypeKey,
                                crimeName,
                                total: 0,
                                successful: 0,
                                failed: 0,
                                successfulEarningsMoney: 0
                            };
                        }
                        
                        // Credit this player with their share only if their slot succeeded (crime can succeed while one member is left behind / fails).
                        const ocOut = outcome == null ? '' : String(outcome).toLowerCase();
                        const slotGetsPaid =
                            !ocOut || ocOut === 'successful' || ocOut === 'success';
                        const execAt = crime.executed_at != null ? Number(crime.executed_at) : null;
                        let paidCashShare = 0;
                        const paidItemsBreakdown = {};
                        if (
                            status === 'Successful' &&
                            slotGetsPaid &&
                            (rewardParsed.money > 0 || rewardParsed.items.length > 0)
                        ) {
                            paidCashShare = rewardParsed.money * playerShareMultiplier;
                            playerMap[playerId].totalRewardMoney += paidCashShare;
                            playerMap[playerId].totalRewardItemCount += rewardParsed.itemCount;
                            pct[crimeTypeKey].successfulEarningsMoney += paidCashShare;
                            mergeItemBreakdown(paidItemsBreakdown, rewardParsed.items);
                            playerMap[playerId].rewardParticipations.push({
                                crimeTypeKey,
                                itemsBreakdown: paidItemsBreakdown,
                                participantsInCrime
                            });
                        }
                        playerMap[playerId].playerCrimeParticipations.push({
                            executedAt: execAt,
                            difficulty,
                            crimeName,
                            crimeTypeKey,
                            slotSuccessful: outcome === 'Successful',
                            cashShare: paidCashShare,
                            itemsBreakdown: paidItemsBreakdown,
                            participantsInCrime: participantsInCrime || 1
                        });
                        
                        const totalParticipants = crime.slots ? crime.slots.length : 0;
                        const participationRatio = totalParticipants / 6;
                        const participationScore = Math.round(difficulty * participationRatio);
                        playerMap[playerId].totalScore += participationScore;
                        
                        if (playerMap[playerId].difficultyBreakdown[difficulty]) {
                            playerMap[playerId].difficultyBreakdown[difficulty].total++;
                            if (outcome === 'Successful') {
                                playerMap[playerId].difficultyBreakdown[difficulty].successful++;
                            } else {
                                playerMap[playerId].difficultyBreakdown[difficulty].failed++;
                            }
                        }
                        pct[crimeTypeKey].total++;
                        if (outcome === 'Successful') pct[crimeTypeKey].successful++; else pct[crimeTypeKey].failed++;
                        
                        // Count outcome
                        if (outcome === 'Successful') {
                            playerMap[playerId].successfulParticipations++;
                            const diffNum = parseInt(String(difficulty), 10);
                            if (diffNum >= 1 && diffNum <= 10) {
                                const prev = playerMap[playerId].highestDifficultySucceeded || 0;
                                if (diffNum > prev) playerMap[playerId].highestDifficultySucceeded = diffNum;
                            }
                        } else {
                            playerMap[playerId].failedParticipations++;
                        }
                    }
                }
            });
        }
    });
    
    // Calculate success rates for difficulty stats
    Object.values(difficultyMap).forEach(stat => {
        if (stat.total > 0) {
            stat.successRate = Math.round((stat.successful / stat.total) * 100);
        }
    });
    
    // Calculate success rates for player stats
    Object.values(playerMap).forEach(player => {
        if (player.totalParticipations > 0) {
            player.successRate = Math.round((player.successfulParticipations / player.totalParticipations) * 100);
        }
    });

    Object.values(playerMap).forEach(player => {
        const rows = player.playerCrimeParticipations;
        if (!Array.isArray(rows) || rows.length < 2) return;
        rows.sort((a, b) => {
            const ta = Number(a.executedAt) || 0;
            const tb = Number(b.executedAt) || 0;
            if (tb !== ta) return tb - ta;
            const da = Number(a.difficulty) || 0;
            const db = Number(b.difficulty) || 0;
            if (db !== da) return db - da;
            return String(b.crimeName || '').localeCompare(String(a.crimeName || ''));
        });
    });
    
    // Convert to arrays and sort
    const difficultyStats = Object.values(difficultyMap).filter(stat => stat.total > 0);
    const playerStats = Object.values(playerMap).sort((a, b) => b.totalScore - a.totalScore); // Sort by highest score first
    
    console.log('[ORGANISED CRIME STATS] Difficulty stats:', difficultyStats);
    console.log('[ORGANISED CRIME STATS] Player stats (top 10):', playerStats.slice(0, 10));
    
    return { difficultyStats, playerStats };
}

function updateOCStatsUI(difficultyStats, playerStats, totalCrimes) {
    console.log('[ORGANISED CRIME STATS] Updating OC Stats UI...');
    
    // Calculate summary stats
    const totalSuccessful = difficultyStats.reduce((sum, stat) => sum + stat.successful, 0);
    const totalFailed = difficultyStats.reduce((sum, stat) => sum + stat.failed, 0);
    const overallSuccessRate = totalCrimes > 0 ? Math.round((totalSuccessful / totalCrimes) * 100) : 0;
    const totalPlayers = playerStats.length;
    const totalValue = getTotalRewardValue(difficultyStats);
    const totalCostValue = getTotalCostValue(difficultyStats);
    const netProfitValue = totalValue - totalCostValue;
    const totalRespect = getTotalRespectValue(difficultyStats);
    const factionCutVal = (document.getElementById('ocFactionCutPercent') && document.getElementById('ocFactionCutPercent').value !== '') ? document.getElementById('ocFactionCutPercent').value : '20';
    
    // Update difficulty stats table with summary
    const difficultyTableContainer = document.getElementById('difficultyStatsTable');
    if (difficultyTableContainer) {
        let html = `
            <!-- Summary Section (NOT scrollable) -->
            <div class="summary-section" style="margin-bottom: 20px;">
                <div class="summary-grid">
                    <div class="summary-item">
                        <span class="summary-label">Total Crimes:</span>
                        <span class="summary-value">${totalCrimes}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Overall Success Rate:</span>
                        <span class="summary-value" style="color: ${overallSuccessRate >= 70 ? '#4ecdc4' : overallSuccessRate >= 50 ? '#ffd700' : '#ff6b6b'};">${overallSuccessRate}%</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Successful:</span>
                        <span class="summary-value" style="color: #4ecdc4;">${totalSuccessful}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Failed:</span>
                        <span class="summary-value" style="color: #ff6b6b;">${totalFailed}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total rewards:</span>
                        <span class="summary-value">${formatOcSummaryRewardValueWithDetails(difficultyStats, totalValue)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total respect (from rewards):</span>
                        <span class="summary-value" style="color: #c8a882;" title="Sum of rewards.respect on successful crimes (API values).">${formatRespect(totalRespect)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total cost:</span>
                        <span class="summary-value">${formatOcSummaryCostValueWithDetails(difficultyStats, totalCostValue)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Net profit:</span>
                        <span class="summary-value" style="color: ${netProfitValue >= 0 ? '#4ecdc4' : '#ff6b6b'};">${formatDollars(netProfitValue)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Faction cut %:</span>
                        <input type="number" id="ocFactionCutPercent" value="${factionCutVal}" min="0" max="100" step="1" style="width: 56px; padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 4px; background-color: var(--primary-color); color: var(--text-color); font-size: 0.9em;" title="Faction takes this %; remainder is split between participating players. Change to update player rewards.">
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Faction share:</span>
                        <span class="summary-value" id="ocFactionShareAmount" style="color: var(--accent-color);">${formatDollars(totalValue * (Math.min(100, Math.max(0, parseFloat(factionCutVal) || 0)) / 100))}</span>
                    </div>
                </div>
                <div style="text-align: center; color: #888; font-size: 0.9em; margin-top: 10px; margin-bottom: 0;">
                    <div style="display: block; margin-bottom: 4px;">Please note:</div>
                    <ul style="margin: 0; padding-left: 20px; text-align: left; display: inline-block;">
                        <li>Showing current faction members only; stats include crimes where at least one current member participated.</li>
                        <li>Reward and consumed-item values use current market value, not the value at the time of the crime.</li>
                        <li>Cost = Current Market Value of consumed items</li>
                    </ul>
                </div>
            </div>
            
            <!-- Table Wrapper (SCROLLABLE) -->
            <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                <table id="difficultyTable" style="width: 100%; min-width: 500px; border-collapse: collapse;">
                    <thead>
                        <tr>
                            <th data-column="difficulty" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Difficulty <span class="sort-indicator"></span></th>
                            <th data-column="total" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Total Crimes <span class="sort-indicator"></span></th>
                            <th data-column="successful" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Successful <span class="sort-indicator"></span></th>
                            <th data-column="failed" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Failed <span class="sort-indicator"></span></th>
                            <th data-column="successRate" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Success Rate <span class="sort-indicator"></span></th>
                            <th data-column="rewardValue" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Rewards from successful crimes (cash + items at market value)">Rewards <span class="sort-indicator"></span></th>
                            <th data-column="costValue" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Cost to run (money + consumed items)">Cost <span class="sort-indicator"></span></th>
                            <th data-column="netValue" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Rewards − cost">Net <span class="sort-indicator"></span></th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        difficultyStats.forEach(stat => {
            const rateColor = stat.successRate >= 70 ? '#4ecdc4' : 
                             stat.successRate >= 50 ? '#ffd700' : '#ff6b6b';
            const hasSubtypes = Object.keys(stat.crimeTypes || {}).length > 0;
            const arrow = hasSubtypes ? `<span class="difficulty-expand-toggle" data-difficulty="${stat.difficulty}" data-expanded="0" style="cursor:pointer;margin-left:6px;user-select:none;font-size:0.75em;color:#ffd700;" title="Show subtypes">▶</span>` : '';
            html += `
                <tr class="difficulty-main-row" data-difficulty="${stat.difficulty}" style="border-bottom: 1px solid var(--border-color);">
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${stat.difficulty}/10 ${arrow}</td>
                    <td style="padding: 12px; text-align: center;">${stat.total}</td>
                    <td style="padding: 12px; text-align: center; color: #4ecdc4; font-weight: bold;">${stat.successful}</td>
                    <td style="padding: 12px; text-align: center; color: #ff6b6b; font-weight: bold;">${stat.failed}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; font-size: 1.1em; color: ${rateColor};">${stat.successRate}%</td>
                    <td style="padding: 12px; text-align: center; white-space: nowrap;">${formatRewardsCell(stat)}</td>
                    <td style="padding: 12px; text-align: center; white-space: nowrap;">${formatCostCell(stat)}</td>
                    <td style="padding: 12px; text-align: center; white-space: nowrap;">${formatNetCell(stat)}</td>
                </tr>
            `;
            (Object.values(stat.crimeTypes || {})).forEach(ct => {
                const ctTotal = ct.total || 0;
                const ctRate = ctTotal > 0 ? Math.round(((ct.successful || 0) / ctTotal) * 100) : 0;
                const ctRateColor = ctRate >= 70 ? '#4ecdc4' : ctRate >= 50 ? '#ffd700' : '#ff6b6b';
                const ctDisplay = { ...ct, successRate: ctRate };
                html += `
                <tr class="crime-type-row" data-difficulty="${stat.difficulty}" style="display: none; border-bottom: 1px solid var(--border-color); background: rgba(255,255,255,0.03);">
                    <td style="padding: 8px 12px 8px 24px; font-size: 0.9em; color: var(--text-color);">${escapeHtml(ct.crimeName || 'Unknown crime')}</td>
                    <td style="padding: 8px 12px; text-align: center;">${ctTotal}</td>
                    <td style="padding: 8px 12px; text-align: center; color: #4ecdc4;">${ct.successful || 0}</td>
                    <td style="padding: 8px 12px; text-align: center; color: #ff6b6b;">${ct.failed || 0}</td>
                    <td style="padding: 8px 12px; text-align: center; color: ${ctRateColor};">${ctRate}%</td>
                    <td style="padding: 8px 12px; text-align: center; white-space: nowrap;">${formatRewardsCell(ctDisplay)}</td>
                    <td style="padding: 8px 12px; text-align: center; white-space: nowrap;">${formatCostCell(ct)}</td>
                    <td style="padding: 8px 12px; text-align: center; white-space: nowrap;">${formatNetCell(ct)}</td>
                </tr>
            `;
            });
        });
        
        html += `
                    </tbody>
                </table>
            </div>
        `;
        
        difficultyTableContainer.innerHTML = html;

        ensureOcStatsDifficultyTableDelegation();
        
        attachFactionCutListener();
        
        // Update sort indicators
        updateDifficultySortIndicators();
    }
    
    // Update player stats table
    const playerTableContainer = document.getElementById('playerStatsTable');
    if (playerTableContainer) {
        // Count how many current members have participated
        const participatingMembers = playerStats.filter(p => p.totalParticipations > 0).length;
        
        // Build complete HTML with summary and table wrapper
        let html = `
            <!-- Summary Section (NOT scrollable) -->
            <div class="summary-section" style="margin-bottom: 20px;">
                <div class="summary-grid">
                    <div class="summary-item">
                        <span class="summary-label">Current Members:</span>
                        <span class="summary-value">${totalPlayers}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Participated in OCs:</span>
                        <span class="summary-value">${participatingMembers}</span>
                    </div>
                </div>
            </div>
            
            <!-- Table Wrapper (SCROLLABLE) -->
            <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                <table id="playerTable" style="width: 100%; min-width: 820px; border-collapse: collapse;">
                    <thead>
                        <tr>
                            <th data-column="name" style="padding: 12px; text-align: left; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">${window.toolsMemberColumnHeaderWrap('<span>Player Name <span class="sort-indicator"></span></span>', { align: 'flex-start' })}</th>
                            <th data-column="totalParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Total Participations <span class="sort-indicator"></span></th>
                            <th data-column="totalScore" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Score = Difficulty × (Participants ÷ 6). Full team (6 people) = 100% of difficulty points. Partial team gets proportional points.">Score <span class="sort-indicator"></span></th>
                            <th data-column="successfulParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Successful <span class="sort-indicator"></span></th>
                            <th data-column="failedParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Failed <span class="sort-indicator"></span></th>
                            <th data-column="successRate" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Success Rate <span class="sort-indicator"></span></th>
                            <th data-column="highestDifficultySucceeded" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Highest OC difficulty (1–10) where this player had a successful slot outcome in the filtered period.">Highest D. <span class="sort-indicator"></span></th>
                            <th data-column="totalRewardMoney" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Rewards from successful crimes this player participated in">Rewards <span class="sort-indicator"></span></th>
                            <th style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color);">Details</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        const ocDetailItemsMap = ocStatsData.itemsMap || {};
        const ocDetailCutPct = ocStatsFactionCutPercentActive();
        
        playerStats.forEach((player, index) => {
            const rateColor = player.successRate >= 70 ? '#4ecdc4' : 
                             player.successRate >= 50 ? '#ffd700' : '#ff6b6b';
            const hiD = Number(player.highestDifficultySucceeded) || 0;
            const hiDCell = hiD >= 1
                ? `<span style="font-weight: bold; color: #ffd700;">${hiD}/10</span>`
                : '<span style="color: #666;">—</span>';
            
            // Main player row
            html += `
                <tr style="border-bottom: 1px solid var(--border-color);" data-player-id="${player.id}">
                    <td style="padding: 12px;">
                        <a href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank" class="player-link"${window.toolsMemberLinkAttrs(player.name, player.id)}>
                            ${window.toolsFormatMemberDisplayLabel(player, window.toolsGetShowMemberIdInBrackets())}
                        </a>
                    </td>
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${player.totalParticipations}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; color: #ffd700;">${player.totalScore}</td>
                    <td style="padding: 12px; text-align: center; color: #4ecdc4; font-weight: bold;">${player.successfulParticipations}</td>
                    <td style="padding: 12px; text-align: center; color: #ff6b6b; font-weight: bold;">${player.failedParticipations}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; font-size: 1.1em; color: ${rateColor};">${player.successRate}%</td>
                    <td style="padding: 12px; text-align: center;">${hiDCell}</td>
                    <td style="padding: 12px; text-align: center; white-space: nowrap;">${formatRewardsCell(player)}</td>
                    <td style="padding: 12px; text-align: center;">
                        ${player.totalParticipations > 0 ? `
                            <button class="details-toggle" data-player-id="${player.id}" style="background-color: var(--accent-color); color: var(--primary-color); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.9em; font-weight: bold;">
                                ▼ Details
                            </button>
                        ` : '<span style="color: #666;">N/A</span>'}
                    </td>
                </tr>
            `;
            
            // Expandable details row (hidden by default)
            if (player.totalParticipations > 0) {
                html += `
                    <tr class="details-row" data-player-id="${player.id}" style="display: none; background-color: rgba(255, 215, 0, 0.05);">
                        <td colspan="9" style="padding: 20px;">
                            <div style="background-color: var(--secondary-color); padding: 15px; border-radius: 8px; border-left: 3px solid var(--accent-color);">
                                ${ocStatsRenderPlayerCrimeParticipationsTableHtml(player, ocDetailItemsMap, ocDetailCutPct)}
                            </div>
                        </td>
                    </tr>
                `;
            }
        });
        
        html += `
                    </tbody>
                </table>
            </div>
        `;
        
        playerTableContainer.innerHTML = html;
        
        // Add sort handlers for player table
        const playerHeaders = playerTableContainer.querySelectorAll('th[data-column]');
        playerHeaders.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.dataset.column;
                sortPlayerTable(column);
            });
        });
        
        // Update sort indicators
        updatePlayerSortIndicators();
        
        // Add click handlers for detail toggle buttons
        const detailButtons = playerTableContainer.querySelectorAll('.details-toggle');
        detailButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                const playerId = button.dataset.playerId;
                const detailsRow = playerTableContainer.querySelector(`.details-row[data-player-id="${playerId}"]`);
                
                if (detailsRow) {
                    const isExpanded = detailsRow.style.display !== 'none';
                    if (isExpanded) {
                        detailsRow.style.display = 'none';
                        button.innerHTML = '▼ Details';
                    } else {
                        detailsRow.style.display = 'table-row';
                        button.innerHTML = '▲ Hide';
                    }
                }
            });
        });
    }
    
    console.log('[ORGANISED CRIME STATS] UI updated successfully');
}

// Sorting functions for difficulty table
function sortDifficultyTable(column) {
    const currentSort = ocStatsData.sortState.difficulty;
    
    // Toggle direction if same column, otherwise default to descending (or ascending for difficulty)
    if (currentSort.column === column) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.column = column;
        currentSort.direction = column === 'difficulty' ? 'asc' : 'desc';
    }
    
    // Get the currently filtered data
    const dataToSort = getCurrentFilteredData('difficulty');
    
    // Sort the data (rewardValue / costValue / netValue use full $ totals, not raw stat fields)
    dataToSort.sort((a, b) => {
        const aVal = getDifficultySortValue(a, column);
        const bVal = getDifficultySortValue(b, column);
        if (currentSort.direction === 'asc') {
            return aVal - bVal;
        }
        return bVal - aVal;
    });
    
    // Update UI with sorted, filtered data
    updateDifficultyStatsUI(dataToSort);
    updateDifficultySortIndicators();
}

function updateDifficultySortIndicators() {
    const difficultyTable = document.getElementById('difficultyStatsTable');
    if (!difficultyTable) return;
    
    const currentSort = ocStatsData.sortState.difficulty;
    const headers = difficultyTable.querySelectorAll('th[data-column]');
    
    headers.forEach(header => {
        const indicator = header.querySelector('.sort-indicator');
        if (indicator) {
            if (header.dataset.column === currentSort.column) {
                indicator.textContent = currentSort.direction === 'asc' ? ' ▲' : ' ▼';
                indicator.style.color = 'var(--accent-color)';
            } else {
                indicator.textContent = '';
            }
        }
    });
}

// Sorting functions for player table
function sortPlayerTable(column) {
    const currentSort = ocStatsData.sortState.player;
    
    // Toggle direction if same column, otherwise default to descending
    if (currentSort.column === column) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.column = column;
        currentSort.direction = column === 'name' ? 'asc' : 'desc';
    }
    
    // Get the currently filtered data
    const dataToSort = getCurrentFilteredData('player');
    
    // Sort the data (Rewards uses full value via getPlayerSortValue, not cash-only totalRewardMoney)
    dataToSort.sort((a, b) => {
        if (column === 'name') {
            let aVal = (a.name || '').toLowerCase();
            let bVal = (b.name || '').toLowerCase();
            if (currentSort.direction === 'asc') {
                return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            }
            return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
        }
        const aVal = getPlayerSortValue(a, column);
        const bVal = getPlayerSortValue(b, column);
        if (currentSort.direction === 'asc') {
            return aVal - bVal;
        }
        return bVal - aVal;
    });
    
    // Update UI with sorted, filtered data
    updatePlayerStatsUI(dataToSort);
    updatePlayerSortIndicators();
}

function updatePlayerSortIndicators() {
    const playerTable = document.getElementById('playerStatsTable');
    if (!playerTable) return;
    
    const currentSort = ocStatsData.sortState.player;
    const headers = playerTable.querySelectorAll('th[data-column]');
    
    headers.forEach(header => {
        const indicator = header.querySelector('.sort-indicator');
        if (indicator) {
            if (header.dataset.column === currentSort.column) {
                indicator.textContent = currentSort.direction === 'asc' ? ' ▲' : ' ▼';
                indicator.style.color = 'var(--accent-color)';
            } else {
                indicator.textContent = '';
            }
        }
    });
}

/**
 * OC difficulty label for CSV only. Values like "1/10" are opened as dates in Excel/Sheets; use "N of 10" instead.
 */
function formatOcDifficultyForCsv(n) {
    const d = Number(n);
    if (!Number.isFinite(d) || d < 1) return '';
    return `${Math.round(Math.min(10, Math.max(1, d)))} of 10`;
}

function exportOCStatsToCSV() {
    if (!ocStatsData || !ocStatsData.difficultyStats || !ocStatsData.playerStats) {
        alert('No data to export. Please fetch data first.');
        return;
    }

    syncOcStatsActiveFiltersFromDom();

    // Get filtered data (same as what's displayed in the table — uses DOM filter values)
    const filteredDifficultyStats = getCurrentFilteredData('difficulty');
    const filteredPlayerStats = getCurrentFilteredData('player');
    
    // Apply sorting to difficulty stats (same as table display)
    const difficultySort = ocStatsData.sortState.difficulty;
    const sortedDifficultyStats = [...filteredDifficultyStats].sort((a, b) => {
        const aVal = getDifficultySortValue(a, difficultySort.column);
        const bVal = getDifficultySortValue(b, difficultySort.column);
        if (difficultySort.direction === 'asc') {
            return aVal - bVal;
        }
        return bVal - aVal;
    });
    
    // Apply sorting to player stats (same as table display)
    const playerSort = ocStatsData.sortState.player;
    const sortedPlayerStats = [...filteredPlayerStats].sort((a, b) => {
        if (playerSort.column === 'name') {
            const aVal = (a.name || '').toLowerCase();
            const bVal = (b.name || '').toLowerCase();
            if (playerSort.direction === 'asc') {
                return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            }
            return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
        }
        const aVal = getPlayerSortValue(a, playerSort.column);
        const bVal = getPlayerSortValue(b, playerSort.column);
        if (playerSort.direction === 'asc') {
            return aVal - bVal;
        }
        return bVal - aVal;
    });
    
    // Calculate totals from filtered data
    const totalSuccessful = sortedDifficultyStats.reduce((sum, stat) => sum + stat.successful, 0);
    const totalFailed = sortedDifficultyStats.reduce((sum, stat) => sum + stat.failed, 0);
    const totalCrimes = totalSuccessful + totalFailed;
    
    const csvRewardTotal = getTotalRewardValue(sortedDifficultyStats);
    const csvCostTotal = getTotalCostValue(sortedDifficultyStats);
    const csvNetTotal = csvRewardTotal - csvCostTotal;
    const csvRespectTotal = getTotalRespectValue(sortedDifficultyStats);
    const diffFilterLabel = getOcStatsDateFilterHumanLabel('difficulty');
    const playFilterLabel = getOcStatsDateFilterHumanLabel('player');
    let csvContent = 'Organised Crime Statistics\n\n';
    csvContent += `Difficulty table filter: ${diffFilterLabel}\n`;
    csvContent += `Player table filter: ${playFilterLabel}\n`;
    csvContent += `Total Crimes Analyzed (difficulty section scope): ${totalCrimes}\n`;
    csvContent += `Total Rewards (filtered): ${formatDollars(csvRewardTotal)}\n`;
    csvContent += `Total Cost (filtered): ${formatDollars(csvCostTotal)}\n`;
    csvContent += `Net Profit (filtered): ${formatDollars(csvNetTotal)}\n`;
    csvContent += `Total respect from successful crimes (rewards.respect): ${formatRespect(csvRespectTotal)}\n\n`;
    
    // Difficulty stats (using filtered and sorted data). Difficulty uses "N of 10" so Excel/Sheets do not parse it as a date.
    csvContent += 'SUCCESS RATES BY DIFFICULTY\n';
    csvContent += 'Difficulty (of 10 max),Total Crimes,Successful,Failed,Success Rate,Rewards ($),Cost ($),Net ($)\n';
    sortedDifficultyStats.forEach(stat => {
        const r = getDifficultyStatRewardValue(stat);
        const c = getDifficultyStatCostValue(stat);
        const n = getDifficultyStatNetValue(stat);
        csvContent += `${formatOcDifficultyForCsv(stat.difficulty)},${stat.total},${stat.successful},${stat.failed},${stat.successRate}%,"${formatDollars(r)}","${formatDollars(c)}","${formatDollars(n)}"\n`;
    });
    
    csvContent += '\n\nPLAYER PARTICIPATION STATS\n';
    csvContent += 'Player Name,Player ID,Total Participations,Score,Successful,Failed,Success Rate,Highest difficulty (of 10 max),Rewards\n';
    sortedPlayerStats.forEach(player => {
        const hiD = Number(player.highestDifficultySucceeded) || 0;
        const hiDcsv = hiD >= 1 ? formatOcDifficultyForCsv(hiD) : '';
        csvContent += `${window.toolsCsvMemberCell(player)},${player.id},${player.totalParticipations},${player.totalScore},${player.successfulParticipations},${player.failedParticipations},${player.successRate}%,${hiDcsv},"${Array.isArray(player.rewardParticipations) ? formatDollars(getPlayerTotalRewardValue(player)) : formatRewardsSummary(player)}"\n`;
    });
    
    csvContent += '\n\nPLAYER CRIME LOG (one row per participation)\n';
    csvContent +=
        'Player Name,Player ID,Date completed (month day),Difficulty (of 10 max),Crime,Your outcome,Earnings ($)\n';
    const csvItemsMap = ocStatsData.itemsMap || {};
    const csvCutPct = ocStatsFactionCutPercentActive();
    sortedPlayerStats.forEach(player => {
        if (player.totalParticipations <= 0) return;
        (player.playerCrimeParticipations || []).forEach(row => {
            const dateStr =
                row.executedAt != null && Number.isFinite(Number(row.executedAt))
                    ? formatOcCrimeExecutedShort(row.executedAt) || ''
                    : '';
            const outcomeStr = row.slotSuccessful ? 'Success' : 'Failed';
            const earn = ocStatsPlayerParticipationRowEarnings(row, csvItemsMap, csvCutPct);
            const earnStr = earn > 0 ? formatDollars(earn) : '';
            const diffCsv = formatOcDifficultyForCsv(row.difficulty);
            const crimeCsv = String(row.crimeName || '').replace(/"/g, '""');
            csvContent += `${window.toolsCsvMemberCell(player)},${player.id},"${dateStr}",${diffCsv},"${crimeCsv}",${outcomeStr},"${earnStr}"\n`;
        });
    });
    
    // Create and download the CSV file
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `organised-crime-stats-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Convert custom amount + unit to days (for custom timeframe)
function getCustomDays(section) {
    const amountId = section === 'difficulty' ? 'difficultyCustomAmount' : 'playerCustomAmount';
    const unitId = section === 'difficulty' ? 'difficultyCustomUnit' : 'playerCustomUnit';
    const amountInput = document.getElementById(amountId);
    const unitSelect = document.getElementById(unitId);
    const amount = Math.max(1, parseInt(amountInput?.value, 10) || 1);
    const unit = unitSelect?.value || 'days';
    if (unit === 'months') return Math.round(amount * 30.44);
    if (unit === 'years') return Math.round(amount * 365.25);
    return amount;
}

// Update the "Faction share" amount in the summary (total value × faction cut %)
function updateFactionShareDisplay() {
    const span = document.getElementById('ocFactionShareAmount');
    if (!span) return;
    const difficultyStats = getCurrentFilteredData('difficulty');
    const totalValue = getTotalRewardValue(difficultyStats);
    const cutInput = document.getElementById('ocFactionCutPercent');
    const cutPct = cutInput ? Math.min(100, Math.max(0, parseFloat(cutInput.value) || 0)) : 0;
    span.textContent = formatDollars(totalValue * (cutPct / 100));
}

// Attach faction cut % change listener (element is inside difficulty summary, recreated when table is built)
function attachFactionCutListener() {
    const factionCutInput = document.getElementById('ocFactionCutPercent');
    if (factionCutInput) {
        const newInput = factionCutInput.cloneNode(true);
        factionCutInput.parentNode.replaceChild(newInput, factionCutInput);
        newInput.addEventListener('change', () => {
            if (ocStatsData.allCrimes && ocStatsData.allCrimes.length > 0) {
                updateFactionShareDisplay();
                handleDateFilterChange('player');
            }
        });
    }
}

// Toggle visibility of custom range inputs when filter select changes
function toggleCustomRangeVisibility(section) {
    const rangeId = section === 'difficulty' ? 'difficultyCustomRange' : 'playerCustomRange';
    const filterId = section === 'difficulty' ? 'difficultyDateFilter' : 'playerDateFilter';
    const rangeEl = document.getElementById(rangeId);
    const selectEl = document.getElementById(filterId);
    if (rangeEl && selectEl) rangeEl.style.display = selectEl.value === 'custom' ? 'inline' : 'none';
}

// Date filtering functions
function handleDateFilterChange(section) {
    const filterId = section === 'difficulty' ? 'difficultyDateFilter' : 'playerDateFilter';
    const dateRangeSelect = document.getElementById(filterId);
    const selectedValue = dateRangeSelect.value;
    
    // Store the active filter
    ocStatsData.activeFilters[section] = selectedValue;
    toggleCustomRangeVisibility(section);
    
    if (selectedValue === 'all') {
        if (section === 'difficulty') {
            updateDifficultyStatsUI(ocStatsData.difficultyStats);
        } else {
            updatePlayerStatsUI(ocStatsData.playerStats);
        }
    } else {
        const days = selectedValue === 'custom' ? getCustomDays(section) : parseInt(selectedValue, 10);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        
        const filteredData = filterDataByDateRange(cutoffDate);
        
        if (section === 'difficulty') {
            updateDifficultyStatsUI(filteredData.difficultyStats);
        } else {
            updatePlayerStatsUI(filteredData.playerStats);
        }
    }
    persistOcStatsDateFilters();
}

function filterDataByDateRange(cutoffDate) {
    // Filter crimes by date
    const allCrimes = ocStatsData.allCrimes || [];
    const filteredCrimes = allCrimes.filter(crime => {
        // Use the correct timestamp property name
        const timestamp = crime.executed_at;
        
        if (!timestamp) {
            return false;
        }
        
        // Torn API timestamps are Unix timestamps (seconds since epoch)
        const crimeDate = new Date(timestamp * 1000); // Convert to milliseconds
        return crimeDate >= cutoffDate;
    });
    
    // Re-process the filtered data
    const currentMemberIds = new Set(ocStatsData.currentMemberIds || []);
    const playerNames = ocStatsData.playerNames || {};
    
    const factionCutInput = document.getElementById('ocFactionCutPercent');
    const factionCutPercent = factionCutInput ? Math.min(100, Math.max(0, parseFloat(factionCutInput.value) || 20)) : 20;
    const { difficultyStats, playerStats } = processCrimeData(filteredCrimes, playerNames, currentMemberIds, factionCutPercent);
    
    // Calculate totals
    const totalSuccessful = difficultyStats.reduce((sum, stat) => sum + stat.successful, 0);
    const totalFailed = difficultyStats.reduce((sum, stat) => sum + stat.failed, 0);
    const totalCrimes = totalSuccessful + totalFailed;
    
    return { difficultyStats, playerStats, totalCrimes };
}

// Helper function to get the current filtered data for a section
function getCurrentFilteredData(section) {
    const activeFilter = getOcStatsSectionDateFilterFromDom(section);

    if (activeFilter === 'all') {
        return section === 'difficulty' ? ocStatsData.difficultyStats : ocStatsData.playerStats;
    } else {
        const days = activeFilter === 'custom' ? getCustomDays(section) : parseInt(activeFilter, 10);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        
        const filteredData = filterDataByDateRange(cutoffDate);
        return section === 'difficulty' ? filteredData.difficultyStats : filteredData.playerStats;
    }
}

// Separate UI update functions for each section
function updateDifficultyStatsUI(difficultyStats) {
    const difficultyTable = document.getElementById('difficultyStatsTable');
    if (difficultyTable) {
        // Calculate totals for this filtered data
        const totalSuccessful = difficultyStats.reduce((sum, stat) => sum + stat.successful, 0);
        const totalFailed = difficultyStats.reduce((sum, stat) => sum + stat.failed, 0);
        const totalCrimes = totalSuccessful + totalFailed;
        const overallSuccessRate = totalCrimes > 0 ? Math.round((totalSuccessful / totalCrimes) * 100) : 0;
        const totalValue = getTotalRewardValue(difficultyStats);
        const totalCostValue = getTotalCostValue(difficultyStats);
        const netProfitValue = totalValue - totalCostValue;
        const totalRespect = getTotalRespectValue(difficultyStats);
        const factionCutVal = (document.getElementById('ocFactionCutPercent') && document.getElementById('ocFactionCutPercent').value !== '') ? document.getElementById('ocFactionCutPercent').value : '20';
        
        let html = `
            <div class="summary-section" style="margin-bottom: 20px;">
                <div class="summary-grid">
                    <div class="summary-item">
                        <span class="summary-label">Total Crimes:</span>
                        <span class="summary-value">${totalCrimes}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Overall Success Rate:</span>
                        <span class="summary-value" style="color: ${overallSuccessRate >= 70 ? '#4ecdc4' : overallSuccessRate >= 50 ? '#ffd700' : '#ff6b6b'};">
                            ${overallSuccessRate}%
                        </span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Successful:</span>
                        <span class="summary-value" style="color: #4ecdc4;">${totalSuccessful}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Failed:</span>
                        <span class="summary-value" style="color: #ff6b6b;">${totalFailed}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total rewards:</span>
                        <span class="summary-value">${formatOcSummaryRewardValueWithDetails(difficultyStats, totalValue)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total respect (from rewards):</span>
                        <span class="summary-value" style="color: #c8a882;" title="Sum of rewards.respect on successful crimes (API values).">${formatRespect(totalRespect)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total cost:</span>
                        <span class="summary-value">${formatOcSummaryCostValueWithDetails(difficultyStats, totalCostValue)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Net profit:</span>
                        <span class="summary-value" style="color: ${netProfitValue >= 0 ? '#4ecdc4' : '#ff6b6b'};">${formatDollars(netProfitValue)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Faction cut %:</span>
                        <input type="number" id="ocFactionCutPercent" value="${factionCutVal}" min="0" max="100" step="1" style="width: 56px; padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 4px; background-color: var(--primary-color); color: var(--text-color); font-size: 0.9em;" title="Faction takes this %; remainder is split between participating players. Change to update player rewards.">
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Faction share:</span>
                        <span class="summary-value" id="ocFactionShareAmount" style="color: var(--accent-color);">${formatDollars(totalValue * (Math.min(100, Math.max(0, parseFloat(factionCutVal) || 0)) / 100))}</span>
                    </div>
                </div>
                <div style="text-align: center; color: #888; font-size: 0.9em; margin-top: 10px; margin-bottom: 0;">
                    <div style="display: block; margin-bottom: 4px;">Please note:</div>
                    <ul style="margin: 0; padding-left: 20px; text-align: left; display: inline-block;">
                        <li>Showing current faction members only; stats include crimes where at least one current member participated.</li>
                        <li>Reward and consumed-item values use current market value, not the value at the time of the crime.</li>
                        <li>Cost = Current Market Value of consumed items</li>
                    </ul>
                </div>
            </div>
            <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                <table id="difficultyTable" style="width: 100%; min-width: 500px; border-collapse: collapse;">
                <thead>
                    <tr>
                        <th data-column="difficulty" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Difficulty <span class="sort-indicator"></span></th>
                        <th data-column="total" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Total Crimes <span class="sort-indicator"></span></th>
                        <th data-column="successful" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Successful <span class="sort-indicator"></span></th>
                        <th data-column="failed" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Failed <span class="sort-indicator"></span></th>
                        <th data-column="successRate" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Success Rate <span class="sort-indicator"></span></th>
                        <th data-column="rewardValue" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Rewards from successful crimes (cash + items at market value)">Rewards <span class="sort-indicator"></span></th>
                        <th data-column="costValue" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Cost to run (money + consumed items)">Cost <span class="sort-indicator"></span></th>
                        <th data-column="netValue" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Rewards − cost">Net <span class="sort-indicator"></span></th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        difficultyStats.forEach(stat => {
            const rateColor = stat.successRate >= 70 ? '#4ecdc4' : 
                            stat.successRate >= 50 ? '#ffd700' : '#ff6b6b';
            const hasSubtypes = Object.keys(stat.crimeTypes || {}).length > 0;
            const arrow = hasSubtypes ? `<span class="difficulty-expand-toggle" data-difficulty="${stat.difficulty}" data-expanded="0" style="cursor:pointer;margin-left:6px;user-select:none;font-size:0.75em;color:#ffd700;" title="Show subtypes">▶</span>` : '';
            html += `
                <tr class="difficulty-main-row" data-difficulty="${stat.difficulty}" style="border-bottom: 1px solid var(--border-color);">
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${stat.difficulty}/10 ${arrow}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${stat.total}</td>
                    <td style="padding: 12px; text-align: center; color: #4ecdc4; font-weight: bold;">${stat.successful}</td>
                    <td style="padding: 12px; text-align: center; color: #ff6b6b; font-weight: bold;">${stat.failed}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; font-size: 1.1em; color: ${rateColor};">${stat.successRate}%</td>
                    <td style="padding: 12px; text-align: center; white-space: nowrap;">${formatRewardsCell(stat)}</td>
                    <td style="padding: 12px; text-align: center; white-space: nowrap;">${formatCostCell(stat)}</td>
                    <td style="padding: 12px; text-align: center; white-space: nowrap;">${formatNetCell(stat)}</td>
                </tr>
            `;
            (Object.values(stat.crimeTypes || {})).forEach(ct => {
                const ctTotal = ct.total || 0;
                const ctRate = ctTotal > 0 ? Math.round(((ct.successful || 0) / ctTotal) * 100) : 0;
                const ctRateColor = ctRate >= 70 ? '#4ecdc4' : ctRate >= 50 ? '#ffd700' : '#ff6b6b';
                const ctDisplay = { ...ct, successRate: ctRate };
                html += `
                <tr class="crime-type-row" data-difficulty="${stat.difficulty}" style="display: none; border-bottom: 1px solid var(--border-color); background: rgba(255,255,255,0.03);">
                    <td style="padding: 8px 12px 8px 24px; font-size: 0.9em; color: var(--text-color);">${escapeHtml(ct.crimeName || 'Unknown crime')}</td>
                    <td style="padding: 8px 12px; text-align: center;">${ctTotal}</td>
                    <td style="padding: 8px 12px; text-align: center; color: #4ecdc4;">${ct.successful || 0}</td>
                    <td style="padding: 8px 12px; text-align: center; color: #ff6b6b;">${ct.failed || 0}</td>
                    <td style="padding: 8px 12px; text-align: center; color: ${ctRateColor};">${ctRate}%</td>
                    <td style="padding: 8px 12px; text-align: center; white-space: nowrap;">${formatRewardsCell(ctDisplay)}</td>
                    <td style="padding: 8px 12px; text-align: center; white-space: nowrap;">${formatCostCell(ct)}</td>
                    <td style="padding: 8px 12px; text-align: center; white-space: nowrap;">${formatNetCell(ct)}</td>
                </tr>
            `;
            });
        });
        
        html += `
                </tbody>
            </table>
            </div>
        `;
        
        difficultyTable.innerHTML = html;

        ensureOcStatsDifficultyTableDelegation();
        
        attachFactionCutListener();
        
        // Update sort indicators
        updateDifficultySortIndicators();
    }
}

function updatePlayerStatsUI(playerStats) {
    const playerTable = document.getElementById('playerStatsTable');
    if (playerTable) {
        const participatingMembers = playerStats.filter(p => p.totalParticipations > 0).length;
        const totalPlayers = playerStats.length;
        
        // Insert summary BEFORE the table container
        let summaryDiv = document.getElementById('playerStatsSummary');
        if (!summaryDiv) {
            summaryDiv = document.createElement('div');
            summaryDiv.id = 'playerStatsSummary';
            playerTable.parentNode.insertBefore(summaryDiv, playerTable);
        }
        
        summaryDiv.innerHTML = `
            <div class="summary-section" style="margin-bottom: 20px;">
                <div class="summary-grid">
                    <div class="summary-item">
                        <span class="summary-label">Current Members:</span>
                        <span class="summary-value">${totalPlayers}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Participated in OCs:</span>
                        <span class="summary-value">${participatingMembers}</span>
                    </div>
                </div>
            </div>
        `;
        
        // Now just build the table
        let html = `
            <table id="playerTable" style="width: 100%; min-width: 820px; border-collapse: collapse;">
                <thead>
                    <tr>
                        <th data-column="name" style="padding: 12px; text-align: left; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">${window.toolsMemberColumnHeaderWrap('<span>Player Name <span class="sort-indicator"></span></span>', { align: 'flex-start' })}</th>
                        <th data-column="totalParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Total Participations <span class="sort-indicator"></span></th>
                        <th data-column="totalScore" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Score = Difficulty × (Participants ÷ 6). Full team (6 people) = 100% of difficulty points. Partial team gets proportional points.">Score <span class="sort-indicator"></span></th>
                        <th data-column="successfulParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Successful <span class="sort-indicator"></span></th>
                        <th data-column="failedParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Failed <span class="sort-indicator"></span></th>
                        <th data-column="successRate" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Success Rate <span class="sort-indicator"></span></th>
                        <th data-column="highestDifficultySucceeded" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Highest OC difficulty (1–10) where this player had a successful slot outcome in the filtered period.">Highest D. <span class="sort-indicator"></span></th>
                        <th data-column="totalRewardMoney" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Rewards from successful crimes this player participated in">Rewards <span class="sort-indicator"></span></th>
                        <th style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color);">Details</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        const ocDetailItemsMapRefresh = ocStatsData.itemsMap || {};
        const ocDetailCutPctRefresh = ocStatsFactionCutPercentActive();
        
        playerStats.forEach((player, index) => {
            const rateColor = player.successRate >= 70 ? '#4ecdc4' : 
                            player.successRate >= 50 ? '#ffd700' : '#ff6b6b';
            const hiD = Number(player.highestDifficultySucceeded) || 0;
            const hiDCell = hiD >= 1
                ? `<span style="font-weight: bold; color: #ffd700;">${hiD}/10</span>`
                : '<span style="color: #666;">—</span>';
            
            html += `
                <tr style="border-bottom: 1px solid var(--border-color);" data-player-id="${player.id}">
                    <td style="padding: 12px;">
                        <a href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank" class="player-link"${window.toolsMemberLinkAttrs(player.name, player.id)}>
                            ${window.toolsFormatMemberDisplayLabel(player, window.toolsGetShowMemberIdInBrackets())}
                        </a>
                    </td>
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${player.totalParticipations}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; color: #ffd700;">${player.totalScore}</td>
                    <td style="padding: 12px; text-align: center; color: #4ecdc4; font-weight: bold;">${player.successfulParticipations}</td>
                    <td style="padding: 12px; text-align: center; color: #ff6b6b; font-weight: bold;">${player.failedParticipations}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; font-size: 1.1em; color: ${rateColor};">${player.successRate}%</td>
                    <td style="padding: 12px; text-align: center;">${hiDCell}</td>
                    <td style="padding: 12px; text-align: center; white-space: nowrap;">${formatRewardsCell(player)}</td>
                    <td style="padding: 12px; text-align: center;">
                        ${player.totalParticipations > 0 ? `
                            <button class="details-toggle" data-player-id="${player.id}" style="background-color: var(--accent-color); color: var(--primary-color); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.9em; font-weight: bold;">
                                ▼ Details
                            </button>
                        ` : '<span style="color: #666;">N/A</span>'}
                    </td>
                </tr>
            `;
            
            // Add details row if player has participations
            if (player.totalParticipations > 0) {
                html += `
                    <tr class="details-row" data-player-id="${player.id}" style="display: none; background-color: rgba(255, 215, 0, 0.05);">
                        <td colspan="9" style="padding: 20px;">
                            <div style="background-color: var(--secondary-color); padding: 15px; border-radius: 8px; border-left: 3px solid var(--accent-color);">
                                ${ocStatsRenderPlayerCrimeParticipationsTableHtml(player, ocDetailItemsMapRefresh, ocDetailCutPctRefresh)}
                            </div>
                        </td>
                    </tr>
                `;
            }
        });
        
        html += `
                </tbody>
            </table>
        `;
        
        playerTable.innerHTML = html;
        
        // Add sorting functionality
        const playerTableElement = document.getElementById('playerTable');
        if (playerTableElement) {
            const headers = playerTableElement.querySelectorAll('th[data-column]');
            headers.forEach(header => {
                header.addEventListener('click', () => {
                    const column = header.dataset.column;
                    sortPlayerTable(column);
                });
            });
        }
        
        // Update sort indicators
        updatePlayerSortIndicators();
        
        // Add click handlers for detail toggle buttons
        const detailButtons = playerTable.querySelectorAll('.details-toggle');
        detailButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                const playerId = button.dataset.playerId;
                const detailsRow = playerTable.querySelector(`.details-row[data-player-id="${playerId}"]`);
                
                if (detailsRow) {
                    const isExpanded = detailsRow.style.display !== 'none';
                    if (isExpanded) {
                        detailsRow.style.display = 'none';
                        button.innerHTML = '▼ Details';
                    } else {
                        detailsRow.style.display = 'table-row';
                        button.innerHTML = '▲ Hide';
                    }
                }
            });
        });
    }
}

console.log('[ORGANISED CRIME STATS] Script loaded');

if (!window._ocStatsToolsMemberIdListener) {
    window._ocStatsToolsMemberIdListener = true;
    window.addEventListener('toolsMemberIdDisplayChanged', () => {
        if (typeof ocStatsData !== 'undefined' && ocStatsData.playerStats && ocStatsData.playerStats.length) {
            updatePlayerStatsUI(ocStatsData.playerStats);
        }
    });
}

