console.log('[ORGANISED CRIME STATS] organised-crime-stats.js LOADED');

const OC_STATS_DATE_FILTERS_LS_KEY = 'organisedCrimeStats_dateFilters';
const OC_STATS_CRIMES_CACHE_KEY = 'organisedCrimeStats_crimesCache_v1';
const OC_STATS_PULL_META_KEY = 'organisedCrimeStats_apiPullMeta_v1';
const OC_STATS_ALLOWED_PRESETS = new Set(['all', '7', '14', '30', '90', '365', 'custom']);
const OC_STATS_ALLOWED_UNITS = new Set(['days', 'months', 'years']);

/** Stable fingerprint for the API key (never store the raw key in the crimes cache payload beyond this). */
function ocStatsApiKeyFingerprint(apiKey) {
    const s = String(apiKey || '');
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
                v: 1,
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
        if (!o || o.v !== 1 || o.keyFp !== ocStatsApiKeyFingerprint(apiKey) || !Array.isArray(o.crimes)) return null;
        return o.crimes;
    } catch (e) {
        console.warn('[ORGANISED CRIME STATS] Could not read crimes cache:', e);
        return null;
    }
}

function formatOcStatsCacheDate(ts) {
    try {
        return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return '';
    }
}

function updateOcStatsCacheHint() {
    const el = document.getElementById('ocStatsCacheHint');
    const btn = document.getElementById('loadOcStatsCache');
    const apiKey = localStorage.getItem('tornApiKey');
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
        `Last full fetch used about ${meta.totalApiCalls} API calls (${meta.crimePages} crime page${meta.crimePages === 1 ? '' : 's'} at 100 crimes each + faction members + item prices). ` +
        `${crimesCached ? `Crimes are cached locally (${meta.crimeCount} rows, saved ${when}). "Load from cache" uses 2 calls (members + items) only.` : `Crime list was not cached (too large or first run); next fetch will re-pull all crime pages.`}`;
    if (btn) btn.style.display = crimesCached ? 'inline-block' : 'none';
}

/**
 * After `allCrimes` is available (from API or local cache), fetch members + items and build tables.
 * @returns {Promise<void>}
 */
async function runOcStatsAfterCrimesReady(allCrimes, progressRefs) {
    const {
        progressMessage,
        progressDetails,
        resultsSection
    } = progressRefs;

    if (progressMessage) progressMessage.textContent = 'Fetching current faction members...';
    if (progressDetails) progressDetails.textContent = 'Loading member list...';

    const apiKey = localStorage.getItem('tornApiKey');
    const membersResponse = await fetch(`https://api.torn.com/v2/faction/members?key=${apiKey}`);
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

    if (progressMessage) progressMessage.textContent = 'Processing crime data...';
    if (progressDetails) progressDetails.textContent = 'Analyzing crimes (filtering by current members)...';

    const factionCutInput = document.getElementById('ocFactionCutPercent');
    const factionCutPercent = factionCutInput ? Math.min(100, Math.max(0, parseFloat(factionCutInput.value) || 20)) : 20;
    const { difficultyStats, playerStats } = processCrimeData(allCrimes, playerNames, currentMemberIds, factionCutPercent);

    if (progressMessage) progressMessage.textContent = 'Loading item details...';
    if (progressDetails) progressDetails.textContent = 'Fetching item names and values...';
    try {
        const itemsResponse = await fetch(`https://api.torn.com/torn/?selections=items&key=${apiKey}`);
        const itemsData = await itemsResponse.json();
        ocStatsData.itemsMap = itemsData && itemsData.items ? itemsData.items : {};
    } catch (e) {
        console.warn('[ORGANISED CRIME STATS] Could not fetch Torn items:', e);
        ocStatsData.itemsMap = {};
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
    
    const apiKey = localStorage.getItem('tornApiKey');
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
        
        // Fetch completed crimes with pagination
        let allCrimes = [];
        let currentOffset = 0;
        const limit = 100; // API limit per request
        let hasMore = true;
        let pageCount = 0;

        while (hasMore) {
            pageCount++;
            if (progressDetails) progressDetails.textContent = `Fetching page ${pageCount}...`;
            
            const url = `https://api.torn.com/v2/faction/crimes?cat=completed&offset=${currentOffset}&limit=${limit}&sort=DESC&key=${apiKey}`;
            console.log(`[ORGANISED CRIME STATS] Fetching page ${pageCount} from offset ${currentOffset}...`);
            
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.error) {
                throw new Error(`API error: ${data.error.error}`);
            }
            
            const crimes = data.crimes || [];
            console.log(`[ORGANISED CRIME STATS] Page ${pageCount}: Found ${crimes.length} crimes`);
            
            if (crimes.length === 0) {
                hasMore = false;
            } else {
                allCrimes = allCrimes.concat(crimes);
                currentOffset += limit;
                
                // Update progress
                if (progressPercentage) progressPercentage.textContent = `${pageCount} pages`;
                if (progressFill) progressFill.style.width = `${Math.min(100, pageCount * 10)}%`;
                
                // Check if there's a next link in metadata
                if (!data._metadata?.links?.next) {
                    hasMore = false;
                }
                
                // Safety limit to prevent infinite loops
                if (pageCount >= 50) {
                    console.warn('Reached safety limit of 50 pages');
                    hasMore = false;
                }
                
                // Small delay between requests to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        console.log(`[ORGANISED CRIME STATS] Total crimes fetched: ${allCrimes.length}`);

        if (progressFill) progressFill.style.width = '100%';
        if (progressPercentage) progressPercentage.textContent = `${pageCount} pages`;

        await runOcStatsAfterCrimesReady(allCrimes, {
            progressMessage,
            progressDetails,
            resultsSection
        });

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
    const apiKey = localStorage.getItem('tornApiKey');
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
        if (progressMessage) progressMessage.textContent = 'Loading from local cache...';
        if (progressDetails) progressDetails.textContent = `${crimes.length} crimes in cache — 2 live API calls (members + items)`;
        if (progressPercentage) progressPercentage.textContent = '2 calls';
        if (progressFill) progressFill.style.width = '30%';

        await runOcStatsAfterCrimesReady(crimes, {
            progressMessage,
            progressDetails,
            resultsSection
        });

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

// Parse crime.rewards (money and/or items) into { money, itemCount, items }
function parseCrimeRewards(rewards) {
    if (!rewards) return { money: 0, itemCount: 0, items: [] };
    if (typeof rewards === 'number') return { money: rewards, itemCount: 0, items: [] };
    const money = typeof rewards.money === 'number' ? rewards.money : 0;
    const rawItems = Array.isArray(rewards.items) ? rewards.items : [];
    let itemCount = 0;
    const items = rawItems.map(it => {
        const qty = typeof it.quantity === 'number' ? it.quantity : 1;
        itemCount += qty;
        const id = it.id != null ? it.id : it.name || '?';
        const name = it.name || it.label || `Item #${id}`;
        return { id, name, quantity: qty };
    });
    return { money, itemCount, items };
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

// Player's total reward value: their share of cash (already stored) + their share of item value per crime (faction cut and split)
function getPlayerTotalRewardValue(player) {
    const cashShare = player.totalRewardMoney || 0;
    const itemsMap = ocStatsData.itemsMap || {};
    const factionCutInput = document.getElementById('ocFactionCutPercent');
    const factionCutPct = factionCutInput ? Math.min(100, Math.max(0, parseFloat(factionCutInput.value) || 0)) : 0;
    const afterCutMultiplier = 1 - factionCutPct / 100;
    let itemsShare = 0;
    (player.rewardParticipations || []).forEach(part => {
        const crimeItemsValue = getTotalItemsValue(part.itemsBreakdown, itemsMap);
        const participants = part.participantsInCrime || 1;
        itemsShare += crimeItemsValue * afterCutMultiplier / participants;
    });
    return cashShare + itemsShare;
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

    const cashLine = cash > 0 ? `<div>Cash: <span style="color: var(--accent-color);">(${formatDollars(cash)})</span></div>` : '';
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
    const itemsBlock = listHtml ? (cashLine ? '<br>' : '') + listHtml : '';

    const detailsContent = `<div style="margin-top: 4px; padding: 6px 8px; background: var(--secondary-color); border-radius: 4px; font-size: 0.85em; max-width: 320px;">${cashLine}${itemsBlock}</div>`;
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
            rewardItemsBreakdown: {},
            totalCostMoney: 0,
            costItemsBreakdown: {},
            usedNotConsumedBreakdown: {},
            crimeTypes: {} // { [crimeId]: { crimeId, crimeName, total, successful, failed, totalRewardMoney, rewardItemsBreakdown } }
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
            difficultyCrimeTypeBreakdown: {} // { [difficulty]: { [crimeTypeKey]: { crimeName, total, successful, failed } } }
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
        const rewardParsed = (status === 'Successful' && crime.rewards) ? parseCrimeRewards(crime.rewards) : { money: 0, itemCount: 0, items: [] };
        
        // Count current members in this crime (for splitting player share)
        let participantsInCrime = 0;
        if (crime.slots && Array.isArray(crime.slots)) {
            participantsInCrime = crime.slots.filter(slot => slot.user && slot.user.id && currentMemberIds.has(slot.user.id.toString())).length;
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
                    mergeItemBreakdown(difficultyMap[difficulty].rewardItemsBreakdown, rewardParsed.items);
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
                        rewardItemsBreakdown: {},
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
                    mergeItemBreakdown(ct.rewardItemsBreakdown, rewardParsed.items);
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
                                difficultyCrimeTypeBreakdown: {}
                            };
                            for (let i = 1; i <= 10; i++) playerMap[playerId].difficultyBreakdown[i] = { successful: 0, failed: 0, total: 0 };
                        }
                    
                        // Count participation
                        playerMap[playerId].totalParticipations++;
                        
                        // Credit this player with their share of rewards (faction takes cut, rest split between participants)
                        if (status === 'Successful' && (rewardParsed.money > 0 || rewardParsed.items.length > 0)) {
                            playerMap[playerId].totalRewardMoney += rewardParsed.money * playerShareMultiplier;
                            playerMap[playerId].totalRewardItemCount += rewardParsed.itemCount;
                            // Store per-crime item breakdown and participant count so we can compute their share of item value when itemsMap is available
                            const crimeItemsBreakdown = {};
                            mergeItemBreakdown(crimeItemsBreakdown, rewardParsed.items);
                            playerMap[playerId].rewardParticipations.push({
                                itemsBreakdown: crimeItemsBreakdown,
                                participantsInCrime
                            });
                        }
                        
                        // Calculate participation-based score
                        const difficulty = crime.difficulty;
                        const totalParticipants = crime.slots ? crime.slots.length : 0;
                        const participationRatio = totalParticipants / 6; // 6 is 100% participation
                        const participationScore = Math.round(difficulty * participationRatio);
                        playerMap[playerId].totalScore += participationScore;
                        
                        // Track difficulty-specific stats
                        if (playerMap[playerId].difficultyBreakdown[difficulty]) {
                            playerMap[playerId].difficultyBreakdown[difficulty].total++;
                            if (outcome === 'Successful') {
                                playerMap[playerId].difficultyBreakdown[difficulty].successful++;
                            } else {
                                playerMap[playerId].difficultyBreakdown[difficulty].failed++;
                            }
                        }
                        // Track per-difficulty per-crime-type for player details
                        if (!playerMap[playerId].difficultyCrimeTypeBreakdown[difficulty]) {
                            playerMap[playerId].difficultyCrimeTypeBreakdown[difficulty] = {};
                        }
                        const pct = playerMap[playerId].difficultyCrimeTypeBreakdown[difficulty];
                        if (!pct[crimeTypeKey]) pct[crimeTypeKey] = { crimeName, total: 0, successful: 0, failed: 0 };
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
                        <span class="summary-value" style="color: var(--accent-color);">${formatDollars(totalValue)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total cost:</span>
                        <span class="summary-value" style="color: #ffab91;">${formatDollars(totalCostValue)}</span>
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
        
        difficultyTableContainer.addEventListener('click', (e) => {
            const toggle = e.target.closest('.difficulty-expand-toggle');
            if (!toggle) return;
            e.preventDefault();
            e.stopPropagation();
            const d = toggle.getAttribute('data-difficulty');
            const expanded = toggle.getAttribute('data-expanded') === '1';
            const rows = difficultyTableContainer.querySelectorAll(`tr.crime-type-row[data-difficulty="${d}"]`);
            rows.forEach(r => { r.style.display = expanded ? 'none' : 'table-row'; });
            toggle.setAttribute('data-expanded', expanded ? '0' : '1');
            toggle.textContent = expanded ? '▶' : '▼';
            toggle.setAttribute('title', expanded ? 'Show subtypes' : 'Hide subtypes');
        });
        
        attachFactionCutListener();
        
        // Add sort handlers for difficulty table
        const difficultyHeaders = difficultyTableContainer.querySelectorAll('th[data-column]');
        difficultyHeaders.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.dataset.column;
                sortDifficultyTable(column);
            });
        });
        
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
                                <h4 style="margin: 0 0 15px 0; color: var(--accent-color);">Difficulty Breakdown for ${player.name}</h4>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <thead>
                                        <tr>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Difficulty</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Total</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Successful</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Failed</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Success Rate</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                `;
                
                // Add rows for each difficulty level that has participation, then subtype rows
                for (let diff = 1; diff <= 10; diff++) {
                    const breakdown = player.difficultyBreakdown[diff];
                    if (breakdown && breakdown.total > 0) {
                        const diffSuccessRate = Math.round((breakdown.successful / breakdown.total) * 100);
                        const diffRateColor = diffSuccessRate >= 70 ? '#4ecdc4' : 
                                            diffSuccessRate >= 50 ? '#ffd700' : '#ff6b6b';
                        html += `
                            <tr style="border-bottom: 1px solid var(--border-color);">
                                <td style="padding: 8px; text-align: center; font-weight: bold;">${diff}/10</td>
                                <td style="padding: 8px; text-align: center;">${breakdown.total}</td>
                                <td style="padding: 8px; text-align: center; color: #4ecdc4; font-weight: bold;">${breakdown.successful}</td>
                                <td style="padding: 8px; text-align: center; color: #ff6b6b; font-weight: bold;">${breakdown.failed}</td>
                                <td style="padding: 8px; text-align: center; font-weight: bold; color: ${diffRateColor};">${diffSuccessRate}%</td>
                            </tr>
                        `;
                        const crimeTypes = player.difficultyCrimeTypeBreakdown && player.difficultyCrimeTypeBreakdown[diff] ? Object.values(player.difficultyCrimeTypeBreakdown[diff]) : [];
                        crimeTypes.forEach(ct => {
                            const ctTotal = ct.total || 0;
                            const ctRate = ctTotal > 0 ? Math.round(((ct.successful || 0) / ctTotal) * 100) : 0;
                            const ctRateColor = ctRate >= 70 ? '#4ecdc4' : ctRate >= 50 ? '#ffd700' : '#ff6b6b';
                            html += `
                            <tr style="border-bottom: 1px solid var(--border-color); background: rgba(255,255,255,0.03);">
                                <td style="padding: 6px 8px 6px 20px; font-size: 0.9em; color: var(--text-color);">${escapeHtml(ct.crimeName || 'Unknown crime')}</td>
                                <td style="padding: 6px 8px; text-align: center;">${ctTotal}</td>
                                <td style="padding: 6px 8px; text-align: center; color: #4ecdc4;">${ct.successful || 0}</td>
                                <td style="padding: 6px 8px; text-align: center; color: #ff6b6b;">${ct.failed || 0}</td>
                                <td style="padding: 6px 8px; text-align: center; color: ${ctRateColor};">${ctRate}%</td>
                            </tr>
                        `;
                        });
                    }
                }
                
                html += `
                                    </tbody>
                                </table>
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

function exportOCStatsToCSV() {
    if (!ocStatsData || !ocStatsData.difficultyStats || !ocStatsData.playerStats) {
        alert('No data to export. Please fetch data first.');
        return;
    }
    
    // Get filtered data (same as what's displayed in the table)
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
    let csvContent = 'Organised Crime Statistics\n\n';
    csvContent += `Total Crimes Analyzed: ${totalCrimes}\n`;
    csvContent += `Total Rewards (filtered): ${formatDollars(csvRewardTotal)}\n`;
    csvContent += `Total Cost (filtered): ${formatDollars(csvCostTotal)}\n`;
    csvContent += `Net Profit (filtered): ${formatDollars(csvNetTotal)}\n\n`;
    
    // Difficulty stats (using filtered and sorted data)
    csvContent += 'SUCCESS RATES BY DIFFICULTY\n';
    csvContent += 'Difficulty,Total Crimes,Successful,Failed,Success Rate,Rewards ($),Cost ($),Net ($)\n';
    sortedDifficultyStats.forEach(stat => {
        const r = getDifficultyStatRewardValue(stat);
        const c = getDifficultyStatCostValue(stat);
        const n = getDifficultyStatNetValue(stat);
        csvContent += `${stat.difficulty}/10,${stat.total},${stat.successful},${stat.failed},${stat.successRate}%,"${formatDollars(r)}","${formatDollars(c)}","${formatDollars(n)}"\n`;
    });
    
    csvContent += '\n\nPLAYER PARTICIPATION STATS\n';
    csvContent += 'Player Name,Player ID,Total Participations,Score,Successful,Failed,Success Rate,Highest difficulty succeeded (1-10),Rewards\n';
    sortedPlayerStats.forEach(player => {
        const hiD = Number(player.highestDifficultySucceeded) || 0;
        const hiDcsv = hiD >= 1 ? `${hiD}/10` : '';
        csvContent += `${window.toolsCsvMemberCell(player)},${player.id},${player.totalParticipations},${player.totalScore},${player.successfulParticipations},${player.failedParticipations},${player.successRate}%,${hiDcsv},"${Array.isArray(player.rewardParticipations) ? formatDollars(getPlayerTotalRewardValue(player)) : formatRewardsSummary(player)}"\n`;
    });
    
    csvContent += '\n\nPLAYER DIFFICULTY BREAKDOWN\n';
    csvContent += 'Player Name,Difficulty,Total,Successful,Failed,Success Rate\n';
    sortedPlayerStats.forEach(player => {
        if (player.totalParticipations > 0) {
            for (let diff = 1; diff <= 10; diff++) {
                const breakdown = player.difficultyBreakdown[diff];
                if (breakdown && breakdown.total > 0) {
                    const diffSuccessRate = Math.round((breakdown.successful / breakdown.total) * 100);
                    csvContent += `${window.toolsCsvMemberCell(player)},${diff}/10,${breakdown.total},${breakdown.successful},${breakdown.failed},${diffSuccessRate}%\n`;
                }
            }
        }
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
    const activeFilter = ocStatsData.activeFilters[section];
    
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
                        <span class="summary-value" style="color: var(--accent-color);">${formatDollars(totalValue)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total cost:</span>
                        <span class="summary-value" style="color: #ffab91;">${formatDollars(totalCostValue)}</span>
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
        
        difficultyTable.addEventListener('click', (e) => {
            const toggle = e.target.closest('.difficulty-expand-toggle');
            if (!toggle) return;
            e.preventDefault();
            e.stopPropagation();
            const d = toggle.getAttribute('data-difficulty');
            const expanded = toggle.getAttribute('data-expanded') === '1';
            const container = document.getElementById('difficultyStatsTable');
            const rows = container ? container.querySelectorAll(`tr.crime-type-row[data-difficulty="${d}"]`) : [];
            rows.forEach(r => { r.style.display = expanded ? 'none' : 'table-row'; });
            toggle.setAttribute('data-expanded', expanded ? '0' : '1');
            toggle.textContent = expanded ? '▶' : '▼';
            toggle.setAttribute('title', expanded ? 'Show subtypes' : 'Hide subtypes');
        });
        
        attachFactionCutListener();
        
        // Add sorting functionality
        const difficultyTableElement = document.getElementById('difficultyTable');
        if (difficultyTableElement) {
            const headers = difficultyTableElement.querySelectorAll('th[data-column]');
            headers.forEach(header => {
                header.addEventListener('click', () => {
                    const column = header.dataset.column;
                    sortDifficultyTable(column);
                });
            });
        }
        
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
                                <h4 style="margin: 0 0 15px 0; color: var(--accent-color);">Difficulty Breakdown for ${player.name}</h4>
                                <table style="width: 100%; border-collapse: collapse;">
                                    <thead>
                                        <tr>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Difficulty</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Total</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Successful</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Failed</th>
                                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color); color: var(--accent-color);">Success Rate</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                `;
                
                for (let diff = 1; diff <= 10; diff++) {
                    const breakdown = player.difficultyBreakdown[diff];
                    if (breakdown && breakdown.total > 0) {
                        const diffSuccessRate = Math.round((breakdown.successful / breakdown.total) * 100);
                        const diffRateColor = diffSuccessRate >= 70 ? '#4ecdc4' : 
                                            diffSuccessRate >= 50 ? '#ffd700' : '#ff6b6b';
                        html += `
                            <tr style="border-bottom: 1px solid var(--border-color);">
                                <td style="padding: 8px; text-align: center; font-weight: bold;">${diff}/10</td>
                                <td style="padding: 8px; text-align: center;">${breakdown.total}</td>
                                <td style="padding: 8px; text-align: center; color: #4ecdc4; font-weight: bold;">${breakdown.successful}</td>
                                <td style="padding: 8px; text-align: center; color: #ff6b6b; font-weight: bold;">${breakdown.failed}</td>
                                <td style="padding: 8px; text-align: center; font-weight: bold; color: ${diffRateColor};">${diffSuccessRate}%</td>
                            </tr>
                        `;
                        const crimeTypes = player.difficultyCrimeTypeBreakdown && player.difficultyCrimeTypeBreakdown[diff] ? Object.values(player.difficultyCrimeTypeBreakdown[diff]) : [];
                        crimeTypes.forEach(ct => {
                            const ctTotal = ct.total || 0;
                            const ctRate = ctTotal > 0 ? Math.round(((ct.successful || 0) / ctTotal) * 100) : 0;
                            const ctRateColor = ctRate >= 70 ? '#4ecdc4' : ctRate >= 50 ? '#ffd700' : '#ff6b6b';
                            html += `
                            <tr style="border-bottom: 1px solid var(--border-color); background: rgba(255,255,255,0.03);">
                                <td style="padding: 6px 8px 6px 20px; font-size: 0.9em; color: var(--text-color);">${escapeHtml(ct.crimeName || 'Unknown crime')}</td>
                                <td style="padding: 6px 8px; text-align: center;">${ctTotal}</td>
                                <td style="padding: 6px 8px; text-align: center; color: #4ecdc4;">${ct.successful || 0}</td>
                                <td style="padding: 6px 8px; text-align: center; color: #ff6b6b;">${ct.failed || 0}</td>
                                <td style="padding: 6px 8px; text-align: center; color: ${ctRateColor};">${ctRate}%</td>
                            </tr>
                        `;
                        });
                    }
                }
                
                html += `
                                    </tbody>
                                </table>
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

