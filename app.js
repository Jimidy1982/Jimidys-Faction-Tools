document.addEventListener('DOMContentLoaded', () => {
    const appContent = document.getElementById('app-content');

    // --- API BATCHING UTILITIES ---
    
    // Parallel batching with rate limiting
    const fetchInParallelChunks = async (url, items, chunkSize, maxConcurrent = 3, delayMs = 1000) => {
        const chunks = [];
        for (let i = 0; i < items.length; i += chunkSize) {
            chunks.push(items.slice(i, i + chunkSize));
        }
        
        const results = [];
        const semaphore = new Semaphore(maxConcurrent);
        
        const chunkPromises = chunks.map(async (chunk, index) => {
            await semaphore.acquire();
            try {
                // Add delay between batches to respect rate limits
                if (index > 0) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
                
                const chunkUrl = `${url}${chunk.join(',')}`;
                const response = await fetch(chunkUrl);
                const data = await response.json();
                
                if (!response.ok) {
                    if (data.code === 6) throw new Error('FF Scouter API Error: Your key is not registered. Please register your API key at ffscouter.com.');
                    throw new Error(`FF Scouter API Error: ${data.error || 'Unknown error'}`);
                }
                
                return data;
            } finally {
                semaphore.release();
            }
        });
        
        const chunkResults = await Promise.all(chunkPromises);
        return chunkResults.flat();
    };
    
    // Semaphore for controlling concurrent requests
    class Semaphore {
        constructor(max) {
            this.max = max;
            this.current = 0;
            this.queue = [];
        }
        
        async acquire() {
            if (this.current < this.max) {
                this.current++;
                return Promise.resolve();
            }
            
            return new Promise(resolve => {
                this.queue.push(resolve);
            });
        }
        
        release() {
            this.current--;
            if (this.queue.length > 0) {
                this.current++;
                const next = this.queue.shift();
                next();
            }
        }
    }
    
    // Smart caching with TTL (Time To Live)
    const apiCache = new Map();
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    let cacheHits = 0;
    let cacheMisses = 0;
    
    const getCachedData = (key) => {
        const cached = apiCache.get(key);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            cacheHits++;
            console.log(`✅ Cache HIT for: ${key}`);
            return cached.data;
        }
        cacheMisses++;
        console.log(`❌ Cache MISS for: ${key}`);
        return null;
    };
    
    const setCachedData = (key, data) => {
        apiCache.set(key, {
            data,
            timestamp: Date.now()
        });
        console.log(`💾 Cached data for: ${key}`);
    };
    
    const getCacheStats = () => {
        const total = cacheHits + cacheMisses;
        const hitRate = total > 0 ? ((cacheHits / total) * 100).toFixed(1) : 0;
        return { hits: cacheHits, misses: cacheMisses, total, hitRate };
    };
    
    // Batch multiple Torn API calls
    const batchTornApiCalls = async (apiKey, requests) => {
        const results = {};
        const batchSize = 5; // Torn API can handle multiple requests
        const delayMs = 667; // ~3 calls every 2 seconds
        
        for (let i = 0; i < requests.length; i += batchSize) {
            const batch = requests.slice(i, i + batchSize);
            
            // Make parallel requests for this batch
            const batchPromises = batch.map(async (request) => {
                const cacheKey = `${request.url}?${request.params}`; // Use '?' for clarity
                const cached = getCachedData(cacheKey);
                if (cached) {
                    console.log(`Using cached data for: ${request.name}`);
                    return { name: request.name, data: cached };
                }
                
                let fullUrl = request.url;
                if (request.params) {
                    fullUrl += `?${request.params}`;
                }
                fullUrl += `${request.params ? '&' : '?'}key=${apiKey}`;

                const response = await fetch(fullUrl);
                const data = await response.json();
                
                if (data.error) {
                    throw new Error(`Torn API Error (${request.name}): ${data.error.error}`);
                }
                
                setCachedData(cacheKey, data);
                return { name: request.name, data };
            });
            
            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(result => {
                results[result.name] = result.data;
            });
            
            // Rate limiting delay between batches
            if (i + batchSize < requests.length) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        
        return results;
    };

    // --- GLOBAL API KEY HANDLING ---
    const globalApiKeyInput = document.getElementById('globalApiKey');
    if (globalApiKeyInput) {
        // Load saved API key from localStorage
        const savedApiKey = localStorage.getItem('tornApiKey');
        if (savedApiKey) {
            globalApiKeyInput.value = savedApiKey;
        }

        // Save API key to localStorage on input change
        globalApiKeyInput.addEventListener('input', () => {
            localStorage.setItem('tornApiKey', globalApiKeyInput.value);
            console.log('API Key updated in localStorage.');
        });
    }

    // --- ROUTER & PAGE LOADING ---
    const loadPage = async (page) => {
        try {
            const response = await fetch(page);
            if (!response.ok) throw new Error(`Page not found: ${page}`);
            appContent.innerHTML = await response.text();
            console.log('[APP] Loaded page:', page);

            // After loading, initialize any scripts needed for that page
            if (page.includes('consumption-tracker')) {
                // Remove any previous script for this tool
                const oldScript = document.getElementById('consumption-tracker-script');
                if (oldScript) oldScript.remove();
                // Dynamically load the script
                const script = document.createElement('script');
                script.src = 'tools/consumption-tracker/consumption-tracker.js';
                script.id = 'consumption-tracker-script';
                script.onload = () => {
                    console.log('[APP] consumption-tracker/consumption-tracker.js loaded, calling initConsumptionTracker');
                    if (typeof initConsumptionTracker === 'function') {
                        initConsumptionTracker();
                    } else if (window.initConsumptionTracker) {
                        window.initConsumptionTracker();
                    }
                };
                document.head.appendChild(script);
            } else if (page.includes('faction-battle-stats')) {
                initBattleStats();
            } else if (page.includes('war-chain-reporter')) {
                initWarChainReporter();
            } else if (page.includes('war-report-2.0')) {
                // Remove any previous script for this tool
                const oldScript = document.getElementById('war-report-2.0-script');
                if (oldScript) oldScript.remove();
                // Dynamically load the script
                const script = document.createElement('script');
                script.src = 'tools/war-report-2.0/war-report.js';
                script.id = 'war-report-2.0-script';
                script.onload = () => {
                    console.log('[APP] war-report-2.0/war-report.js loaded, calling initWarReport2');
                    if (typeof initWarReport2 === 'function') {
                        initWarReport2();
                    } else if (window.initWarReport2) {
                        window.initWarReport2();
                    } else {
                        console.error('[APP] initWarReport2 is still not available after script load!');
                    }
                };
                document.body.appendChild(script);
            }
        } catch (error) {
            console.error('Failed to load page:', error);
            appContent.innerHTML = `<div class="container"><h2>Error</h2><p>Failed to load page content. Please check the console for details.</p></div>`;
        }
    };

    const router = () => {
        const hash = window.location.hash.substring(1) || 'home';
        const pageName = `${hash.split('/')[0]}`;
        const pagePath = `pages/${pageName}.html`;
        loadPage(pagePath);
    };

    window.addEventListener('hashchange', router);
    router(); // Initial load

    // --- EVENT DELEGATION ---
    // Listen for clicks on the whole app container
    document.addEventListener('click', (event) => {
        const target = event.target;
        if (target) {
            // Only handle fetchData for consumption tracker page, not war-report-2.0
            if (target.id === 'fetchData' && !window.location.pathname.includes('war-report-2.0') && !window.location.hash.includes('consumption-tracker')) {
                handleConsumptionFetchOld();
            } else if (target.id === 'fetchFactionStats') {
                handleBattleStatsFetch();
            } else if (target.id === 'fetchWarReports') {
                handleWarReportFetch();
            } else if (target.id === 'exportCSV') {
                exportToCSV();
            } else if (target.classList.contains('column-toggle')) {
                toggleColumnVisibility();
            }
        }
    });

    // --- BATTLE STATS TOOL ---
    function initBattleStats() {
        const fetchBtn = document.getElementById('fetchBattleStatsBtn');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', handleBattleStatsFetch);
        }
    }

    const calculateStat = (myTotalStats, fairFightScore) => {
        if (fairFightScore < 1 || !myTotalStats) return 0;
        const base = Math.sqrt(myTotalStats) * ((fairFightScore - 1) / (8 / 3));
        return Math.round(Math.pow(base, 2));
    };

    const fetchInChunks = async (url, items, chunkSize) => {
        let results = [];
        for (let i = 0; i < items.length; i += chunkSize) {
            const chunk = items.slice(i, i + chunkSize);
            const chunkUrl = `${url}${chunk.join(',')}`;
            await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit
            const response = await fetch(chunkUrl);
            const data = await response.json();
            if (!response.ok) {
                if (data.code === 6) throw new Error('FF Scouter API Error: Your key is not registered. Please register your API key at ffscouter.com.');
                throw new Error(`FF Scouter API Error: ${data.error || 'Unknown error'}`);
            }
            results = results.concat(data);
        }
        return results;
    };

    const handleBattleStatsFetch = async () => {
        console.log("--- Starting Faction Battle Stats Fetch ---");
        const startTime = performance.now();

        const spinner = document.getElementById('loading-spinner');
        const resultsContainer = document.getElementById('battle-stats-results');
        const toolContainer = document.getElementById('battle-stats-tool-container');
        const factionIdInput = document.getElementById('factionId');

        if (!factionIdInput || !spinner || !resultsContainer || !toolContainer) {
            console.error("One or more required elements are missing from the page.");
            return;
        }

        const apiKey = localStorage.getItem('tornApiKey');
        const factionID = factionIdInput.value.trim();
        if (!apiKey || !factionID) {
            alert('Please enter your API key in the sidebar and a Faction ID.');
            return;
        }

        console.log(`Using Faction ID: ${factionID}`);

        spinner.style.display = 'block';
        resultsContainer.style.display = 'none';

        try {
            // Use batched API calls for better performance
            const tornStartTime = performance.now();
            const apiRequests = [
                {
                    name: 'userStats',
                    url: 'https://api.torn.com/user/',
                    params: 'selections=personalstats'
                },
                {
                    name: 'factionInfo',
                    url: `https://api.torn.com/v2/faction/${factionID}`,
                    params: ''
                },
                {
                    name: 'factionMembers',
                    url: `https://api.torn.com/v2/faction/${factionID}/members`,
                    params: 'striptags=true'
                }
            ];

            console.log('Fetching Torn API data using batched requests...');
            const tornData = await batchTornApiCalls(apiKey, apiRequests);
            const tornEndTime = performance.now();
            console.log(`Torn API calls completed in ${(tornEndTime - tornStartTime).toFixed(2)}ms`);
            
            const myTotalStats = tornData.userStats.personalstats.totalstats;
            console.log('Faction info object:', tornData.factionInfo);
            let factionName = tornData.factionInfo?.basic?.name;
            if (!factionName && tornData.factionInfo?.name) {
                factionName = tornData.factionInfo.name;
            }
            if (!factionName && tornData.factionInfo?.faction_name) {
                factionName = tornData.factionInfo.faction_name;
            }
            if (!factionName) {
                factionName = `[Name not available] (ID: ${factionID})`;
            }
            const membersArray = tornData.factionMembers?.members || [];
            const memberIDs = membersArray.map(member => member.id.toString());
            const membersObject = {};
            membersArray.forEach(member => {
                membersObject[member.id] = { 
                    name: member.name,
                    level: member.level || 'Unknown'
                };
            });
            
            console.log(`Successfully fetched ${memberIDs.length} members.`);

            // Use parallel batching for FF Scouter API
            const ffStartTime = performance.now();
            const ffScouterUrl = `https://ffscouter.com/api/v1/get-stats?key=${apiKey}&targets=`;
            console.log(`Fetching FF Scouter data for ${memberIDs.length} members using parallel batching...`);
            const ffData = await fetchInParallelChunks(ffScouterUrl, memberIDs, 200, 3, 1000);
            const ffEndTime = performance.now();
            console.log(`FF Scouter API calls completed in ${(ffEndTime - ffStartTime).toFixed(2)}ms`);

            const ffScores = {};
            const lastUpdated = {};
            ffData.forEach(player => {
                if (player.fair_fight) {
                    ffScores[player.player_id] = player.fair_fight;
                    lastUpdated[player.player_id] = player.last_updated;
                }
            });

            const totalTime = performance.now() - startTime;
            const cacheStats = getCacheStats();
            console.log(`🎉 Total fetch time: ${totalTime.toFixed(2)}ms (${(totalTime / 1000).toFixed(2)}s)`);
            console.log(`📊 Performance breakdown:`);
            console.log(`   - Torn API: ${(tornEndTime - tornStartTime).toFixed(2)}ms`);
            console.log(`   - FF Scouter: ${(ffEndTime - ffStartTime).toFixed(2)}ms`);
            console.log(`   - Processing: ${(totalTime - (ffEndTime - ffStartTime) - (tornEndTime - tornStartTime)).toFixed(2)}ms`);
            console.log(`💾 Cache stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.hitRate}% hit rate)`);

            // Hide the form and show the results section
            // toolContainer.style.display = 'none'; // Don't hide the input fields

            let tableHtml = `
                <div style="margin-bottom: 20px;">
                    <button id="exportCsvBtn" class="btn" style="background-color: #FFD700; color: #333; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">
                        Export to CSV
                    </button>
                    <button id="collectDetailedStatsBtn" class="btn" style="background-color: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: 10px;">
                        Collect Detailed Stats
                    </button>
                </div>
                <div style="text-align: center; margin-bottom: 10px; color: #00ff00; font-size: 0.9em;">
                    ⚡ Fetched in ${totalTime.toFixed(0)}ms using optimized batching
                    <br>
                    💾 Cache: ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.hitRate}% hit rate)
                </div>
                <h2 style="text-align: center; margin-bottom: 20px; color: var(--accent-color);">${factionName}</h2>
                <table id="membersTable">
                    <thead>
                        <tr>
                            <th data-column="member" style="min-width: 200px; cursor: pointer; text-align: left;">Member <span class="sort-indicator"></span></th>
                            <th data-column="level" style="min-width: 80px; cursor: pointer; text-align: left;">Level <span class="sort-indicator"></span></th>
                            <th data-column="ffscore" style="min-width: 100px; cursor: pointer; text-align: left;">FF Score <span class="sort-indicator"></span></th>
                            <th data-column="stats" style="min-width: 150px; cursor: pointer; text-align: left;">Estimated Stats <span class="sort-indicator"></span></th>
                            <th data-column="lastupdated" style="min-width: 150px; cursor: pointer; text-align: left;">Last Updated <span class="sort-indicator"></span></th>
                        </tr>
                    </thead>
                    <tbody>`;
            for (const memberID of memberIDs) {
                const member = membersObject[memberID];
                const fairFightScore = ffScores[memberID] || 'Unknown';
                const lastUpdatedTimestamp = lastUpdated[memberID];

                const rawEstimatedStat = (fairFightScore !== 'Unknown' && fairFightScore > 0)
                    ? calculateStat(myTotalStats, fairFightScore)
                    : 'N/A';
                const displayEstimatedStat = (rawEstimatedStat !== 'N/A') ? rawEstimatedStat.toLocaleString() : 'N/A';
                
                const lastUpdatedDate = lastUpdatedTimestamp 
                    ? formatRelativeTime(lastUpdatedTimestamp * 1000) 
                    : 'N/A';

                tableHtml += `
                    <tr>
                        <td data-column="member"><a href="https://www.torn.com/profiles.php?XID=${memberID}" target="_blank" style="color: #FFD700; text-decoration: none;">${member.name} [${memberID}]</a></td>
                        <td data-column="level" data-value="${member.level === 'Unknown' ? -1 : member.level}">${member.level}</td>
                        <td data-column="ffscore" data-value="${fairFightScore === 'Unknown' ? -1 : fairFightScore}">${fairFightScore}</td>
                        <td data-column="stats" data-value="${rawEstimatedStat === 'N/A' ? -1 : rawEstimatedStat}">${displayEstimatedStat}</td>
                        <td data-column="lastupdated" data-value="${lastUpdatedTimestamp || 0}">${lastUpdatedDate}</td>
                    </tr>`;
            }
            tableHtml += `</tbody></table>`;
            resultsContainer.innerHTML = tableHtml;
            resultsContainer.style.display = 'block';

            // Add sorting functionality (matching consumption tracker style)
            const table = document.getElementById('membersTable');
            const headers = table.querySelectorAll('th[data-column]');
            let currentSortColumn = 'stats'; // Default sort column
            let currentSortDirection = 'desc'; // Default sort direction (biggest first)
            
            // Function to sort the table
            const sortTable = (column, direction) => {
                const tbody = table.querySelector('tbody');
                const rows = Array.from(tbody.querySelectorAll('tr'));
                
                // Update sort indicators
                headers.forEach(h => {
                    const indicator = h.querySelector('.sort-indicator');
                    const hColumn = h.getAttribute('data-column');
                    if (hColumn === column) {
                        indicator.textContent = direction === 'asc' ? ' ↑' : ' ↓';
                    } else {
                        indicator.textContent = '';
                    }
                });
                
                // Sort rows
                rows.sort((a, b) => {
                    const aCell = a.querySelector(`td[data-column="${column}"]`);
                    const bCell = b.querySelector(`td[data-column="${column}"]`);
                    
                    let aValue = aCell.getAttribute('data-value') || aCell.textContent;
                    let bValue = bCell.getAttribute('data-value') || bCell.textContent;
                    
                    if (column === 'member') {
                        aValue = aValue.toLowerCase();
                        bValue = bValue.toLowerCase();
                        if (aValue < bValue) return direction === 'asc' ? -1 : 1;
                        if (aValue > bValue) return direction === 'asc' ? 1 : -1;
                        return 0;
                    } else {
                        let aNum = parseFloat(aValue);
                        let bNum = parseFloat(bValue);
                        if (isNaN(aNum)) aNum = -1; // Treat non-numeric/N/A as lowest value
                        if (isNaN(bNum)) bNum = -1;

                        if (direction === 'desc') {
                            return bNum - aNum;
                        } else {
                            return aNum - bNum;
                        }
                    }
                });
                
                // Reorder rows
                rows.forEach(row => tbody.appendChild(row));
            };
            
            // Apply default sort (estimated stats, biggest first)
            sortTable(currentSortColumn, currentSortDirection);
            
            headers.forEach(header => {
                header.addEventListener('click', () => {
                    const column = header.getAttribute('data-column');
                    
                    // Update sort direction
                    if (currentSortColumn === column) {
                        currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
                    } else {
                        currentSortColumn = column;
                        currentSortDirection = 'asc';
                    }
                    
                    // Sort the table
                    sortTable(currentSortColumn, currentSortDirection);
                });
            });

            // Add CSV export functionality
            document.getElementById('exportCsvBtn').addEventListener('click', () => {
                // 1. Create a list of members with all their data
                const memberExportData = memberIDs.map(memberID => {
                    const member = membersObject[memberID];
                    const fairFightScore = ffScores[memberID] || 'Unknown';
                    const rawEstimatedStat = (fairFightScore !== 'Unknown' && fairFightScore > 0)
                        ? calculateStat(myTotalStats, fairFightScore)
                        : 'N/A';
                    
                    return {
                        memberID,
                        name: member.name,
                        fairFightScore,
                        rawEstimatedStat
                    };
                });

                // 2. Sort the list by estimated stats, descending.
                memberExportData.sort((a, b) => {
                    const statA = a.rawEstimatedStat === 'N/A' ? -1 : a.rawEstimatedStat;
                    const statB = b.rawEstimatedStat === 'N/A' ? -1 : b.rawEstimatedStat;
                    return statB - statA;
                });

                const csvData = [
                    [`Faction: ${factionName}`],
                    [], // Blank row for spacing
                    ['Member', 'Estimated Stats']
                ];
                
                memberExportData.forEach(data => {
                    const displayEstimatedStat = (data.rawEstimatedStat !== 'N/A') ? data.rawEstimatedStat.toLocaleString() : 'N/A';
                    const escapedMemberName = data.name.replace(/"/g, '""');
                    const memberLinkFormula = `=HYPERLINK("https://www.torn.com/profiles.php?XID=${data.memberID}", "${escapedMemberName} [${data.memberID}]")`;

                    csvData.push([
                        memberLinkFormula,
                        displayEstimatedStat
                    ]);
                });
                
                const csvContent = csvData.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `faction_battle_stats_${factionID}_${new Date().toISOString().split('T')[0]}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            });

            // Add detailed stats collection functionality
            document.getElementById('collectDetailedStatsBtn').addEventListener('click', () => {
                handleDetailedStatsCollection(memberIDs, membersObject, ffScores, myTotalStats, factionName, factionID);
            });
        } catch (error) {
            console.error("An error occurred:", error.message);
            const resultsContainer = document.getElementById('battle-stats-results');
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-message';
            errorDiv.innerHTML = `Error: ${error.message}`;
            if (resultsContainer) {
                resultsContainer.innerHTML = '';
                resultsContainer.appendChild(errorDiv);
                resultsContainer.style.display = 'block';
            }
        } finally {
            spinner.style.display = 'none';
        }
    };

    // --- DETAILED STATS COLLECTION ---
    // Global cache for detailed stats to persist across view switches
    let detailedStatsCache = {};
    let detailedStatsCacheTimestamp = 0;
    const DETAILED_STATS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

    const handleDetailedStatsCollection = async (memberIDs, membersObject, ffScores, myTotalStats, factionName, factionID) => {
        console.log("--- Starting Detailed Stats Collection ---");
        const startTime = performance.now();

        const apiKey = localStorage.getItem('tornApiKey');
        if (!apiKey) {
            alert('Please enter your API key in the sidebar first.');
            return;
        }

        // Show loading state with progress bar
        const resultsContainer = document.getElementById('battle-stats-results');
        const originalContent = resultsContainer.innerHTML;
        resultsContainer.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div class="loading-spinner"></div>
                <div style="margin-top: 10px; color: #FFD700;">
                    Collecting detailed stats for ${memberIDs.length} players...
                    <br>
                    <small>This may take a few minutes due to API rate limits.</small>
                </div>
                <div class="progress-container" style="margin-top: 20px; padding: 15px; background-color: var(--secondary-color); border-radius: 8px;">
                    <div class="progress-info" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; color: var(--text-color);">
                        <span>Progress</span>
                        <span id="detailed-progress-text">0 / ${memberIDs.length}</span>
                    </div>
                    <div class="progress-bar" style="width: 100%; height: 20px; background-color: var(--primary-color); border-radius: 10px; overflow: hidden; border: 1px solid var(--accent-color);">
                        <div id="detailed-progress-fill" class="progress-fill" style="height: 100%; background: linear-gradient(90deg, var(--accent-color), #ffd700); width: 0%; transition: width 0.3s ease; border-radius: 10px;"></div>
                    </div>
                    <div class="progress-details" style="margin-top: 8px; font-size: 0.9em; color: var(--text-color); opacity: 0.8;">
                        Processing players...
                    </div>
                </div>
            </div>
        `;

        try {
            // Check if we have cached detailed stats for this faction
            const cacheKey = `detailed_stats_${factionID}`;
            const now = Date.now();
            
            if (detailedStatsCache[cacheKey] && (now - detailedStatsCacheTimestamp) < DETAILED_STATS_CACHE_TTL) {
                console.log(`Using cached detailed stats for faction ${factionID}`);
                displayDetailedStatsTable(detailedStatsCache[cacheKey], memberIDs, membersObject, ffScores, myTotalStats, factionName, factionID, 0, true);
                return;
            }

            const detailedStats = {};
            const totalMembers = memberIDs.length;
            let processedCount = 0;
            
            // Progress tracking function
            const updateProgress = (count, total, message = 'Processing players...') => {
                processedCount = count;
                const percentage = (count / total) * 100;
                const progressText = document.getElementById('detailed-progress-text');
                const progressFill = document.getElementById('detailed-progress-fill');
                const progressDetails = document.querySelector('.progress-details');
                
                if (progressText) progressText.textContent = `${count} / ${total}`;
                if (progressFill) progressFill.style.width = `${percentage}%`;
                if (progressDetails) progressDetails.textContent = message;
            };
            
            // Process in batches: first 90 immediately, then wait 1 minute for remaining
            const firstBatchSize = Math.min(90, totalMembers);
            const firstBatch = memberIDs.slice(0, firstBatchSize);
            const remainingBatch = memberIDs.slice(firstBatchSize);

            console.log(`Processing first batch of ${firstBatch.length} members immediately...`);
            updateProgress(0, totalMembers, 'Starting first batch...');
            
            // Process first batch
            for (let i = 0; i < firstBatch.length; i += 5) { // Process 5 at a time
                const batch = firstBatch.slice(i, i + 5);
                const batchPromises = batch.map(async (memberID) => {
                    const cacheKey = `personalstats_${memberID}`;
                    const cached = getCachedData(cacheKey);
                    if (cached) {
                        console.log(`Using cached data for member ${memberID}`);
                        return { memberID, data: cached };
                    }

                    const url = `https://api.torn.com/user/${memberID}?selections=personalstats&key=${apiKey}`;
                    const response = await fetch(url);
                    const data = await response.json();
                    
                    if (data.error) {
                        console.error(`Error fetching stats for ${memberID}:`, data.error);
                        return { memberID, data: null };
                    }
                    
                    setCachedData(cacheKey, data);
                    return { memberID, data };
                });

                const batchResults = await Promise.all(batchPromises);
                batchResults.forEach(result => {
                    if (result.data) {
                        detailedStats[result.memberID] = result.data;
                    }
                });

                // Update progress
                processedCount += batch.length;
                updateProgress(processedCount, totalMembers, `Processed ${processedCount} of ${totalMembers} players...`);

                // Rate limiting delay between batches
                if (i + 5 < firstBatch.length) {
                    await new Promise(resolve => setTimeout(resolve, 667)); // ~3 calls every 2 seconds
                }
            }

            // Process remaining batch after 1 minute delay if needed
            if (remainingBatch.length > 0) {
                console.log(`Waiting 60 seconds before processing remaining ${remainingBatch.length} members...`);
                updateProgress(processedCount, totalMembers, `First batch completed. Waiting 60 seconds before processing remaining ${remainingBatch.length} members...`);
                
                // Update the loading message
                const progressDetails = document.querySelector('.progress-details');
                if (progressDetails) {
                    progressDetails.innerHTML = `
                        First batch completed. Waiting 60 seconds before processing remaining ${remainingBatch.length} members...
                        <br>
                        <small>This is required to respect Torn API rate limits.</small>
                    `;
                }

                await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 60 seconds

                console.log(`Processing remaining batch of ${remainingBatch.length} members...`);
                updateProgress(processedCount, totalMembers, `Processing remaining ${remainingBatch.length} members...`);

                for (let i = 0; i < remainingBatch.length; i += 5) {
                    const batch = remainingBatch.slice(i, i + 5);
                    const batchPromises = batch.map(async (memberID) => {
                        const cacheKey = `personalstats_${memberID}`;
                        const cached = getCachedData(cacheKey);
                        if (cached) {
                            console.log(`Using cached data for member ${memberID}`);
                            return { memberID, data: cached };
                        }

                        const url = `https://api.torn.com/user/${memberID}?selections=personalstats&key=${apiKey}`;
                        const response = await fetch(url);
                        const data = await response.json();
                        
                        if (data.error) {
                            console.error(`Error fetching stats for ${memberID}:`, data.error);
                            return { memberID, data: null };
                        }
                        
                        setCachedData(cacheKey, data);
                        return { memberID, data };
                    });

                    const batchResults = await Promise.all(batchPromises);
                    batchResults.forEach(result => {
                        if (result.data) {
                            detailedStats[result.memberID] = result.data;
                        }
                    });

                    // Update progress
                    processedCount += batch.length;
                    updateProgress(processedCount, totalMembers, `Processed ${processedCount} of ${totalMembers} players...`);

                    // Rate limiting delay between batches
                    if (i + 5 < remainingBatch.length) {
                        await new Promise(resolve => setTimeout(resolve, 667));
                    }
                }
            }

            const totalTime = performance.now() - startTime;
            console.log(`Detailed stats collection completed in ${totalTime.toFixed(2)}ms`);

            // Cache the detailed stats
            detailedStatsCache[cacheKey] = detailedStats;
            detailedStatsCacheTimestamp = now;

            // Display the detailed stats table
            displayDetailedStatsTable(detailedStats, memberIDs, membersObject, ffScores, myTotalStats, factionName, factionID, totalTime, false);

        } catch (error) {
            console.error("Error collecting detailed stats:", error);
            resultsContainer.innerHTML = `
                <div style="text-align: center; padding: 20px; color: #ff6b6b;">
                    Error collecting detailed stats: ${error.message}
                    <br><br>
                    <button onclick="location.reload()" class="btn" style="background-color: #FFD700; color: #333; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">
                        Try Again
                    </button>
                </div>
            `;
        }
    };

    const displayDetailedStatsTable = (detailedStats, memberIDs, membersObject, ffScores, myTotalStats, factionName, factionID, totalTime, wasCached = false) => {
        const resultsContainer = document.getElementById('battle-stats-results');
        
        // Create table data
        const tableData = memberIDs.map(memberID => {
            const member = membersObject[memberID];
            const fairFightScore = ffScores[memberID] || 'Unknown';
            const rawEstimatedStat = (fairFightScore !== 'Unknown' && fairFightScore > 0)
                ? calculateStat(myTotalStats, fairFightScore)
                : 'N/A';
            
            const personalStats = detailedStats[memberID]?.personalstats;
            const stats = {
                memberID,
                name: member.name,
                level: member.level || 'Unknown',
                estimatedStats: rawEstimatedStat,
                warHits: personalStats?.rankedwarhits || 0,
                cansUsed: personalStats?.energydrinkused || 0,
                xanaxUsed: personalStats?.xantaken || 0,
                networth: personalStats?.networth || 0,
                biggestHit: personalStats?.bestdamage || 0,
                refills: personalStats?.refills || 0
            };
            
            return stats;
        });

        // Sort by estimated stats (descending)
        tableData.sort((a, b) => {
            const statA = a.estimatedStats === 'N/A' ? -1 : a.estimatedStats;
            const statB = b.estimatedStats === 'N/A' ? -1 : b.estimatedStats;
            return statB - statA;
        });

        let tableHtml = `
            <div style="margin-bottom: 20px;">
                <button id="exportDetailedCsvBtn" class="btn" style="background-color: #FFD700; color: #333; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">
                    Export Detailed Stats to CSV
                </button>
                <button id="backToOriginalBtn" class="btn" style="background-color: #6c757d; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: 10px;">
                    Back to Original View
                </button>
            </div>
            <div style="text-align: center; margin-bottom: 10px; color: #00ff00; font-size: 0.9em;">
                ${wasCached ? '💾' : '⚡'} ${wasCached ? 'Using cached detailed stats' : `Detailed stats collected in ${totalTime.toFixed(0)}ms`}
                <br>
                📊 Showing ${tableData.length} members with personal stats
            </div>
            <h2 style="text-align: center; margin-bottom: 20px; color: var(--accent-color);">${factionName} - Detailed Stats</h2>
            <table id="detailedStatsTable" style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr>
                        <th data-column="member" style="min-width: 220px; cursor: pointer; text-align: left; padding: 10px; text-align: center; position: relative; padding-right: 25px; background-color: var(--secondary-color); color: var(--accent-color);">Member <span class="sort-indicator"></span></th>
                        <th data-column="level" style="min-width: 80px; cursor: pointer; text-align: left; padding: 10px; text-align: center; position: relative; padding-right: 25px; background-color: var(--secondary-color); color: var(--accent-color);">Level <span class="sort-indicator"></span></th>
                        <th data-column="estimatedStats" style="min-width: 140px; cursor: pointer; text-align: left; padding: 10px; text-align: center; position: relative; padding-right: 25px; background-color: var(--secondary-color); color: var(--accent-color);">Estimated Stats <span class="sort-indicator">↓</span></th>
                        <th data-column="warHits" style="min-width: 110px; cursor: pointer; text-align: left; padding: 10px; text-align: center; position: relative; padding-right: 25px; background-color: var(--secondary-color); color: var(--accent-color);">War Hits <span class="sort-indicator"></span></th>
                        <th data-column="cansUsed" style="min-width: 110px; cursor: pointer; text-align: left; padding: 10px; text-align: center; position: relative; padding-right: 25px; background-color: var(--secondary-color); color: var(--accent-color);">Cans Used <span class="sort-indicator"></span></th>
                        <th data-column="xanaxUsed" style="min-width: 110px; cursor: pointer; text-align: left; padding: 10px; text-align: center; position: relative; padding-right: 25px; background-color: var(--secondary-color); color: var(--accent-color);">Xanax Used <span class="sort-indicator"></span></th>
                        <th data-column="networth" style="min-width: 140px; cursor: pointer; text-align: left; padding: 10px; text-align: center; position: relative; padding-right: 25px; background-color: var(--secondary-color); color: var(--accent-color);">Networth <span class="sort-indicator"></span></th>
                        <th data-column="biggestHit" style="min-width: 120px; cursor: pointer; text-align: left; padding: 10px; text-align: center; position: relative; padding-right: 25px; background-color: var(--secondary-color); color: var(--accent-color);">Biggest Hit <span class="sort-indicator"></span></th>
                        <th data-column="refills" style="min-width: 90px; cursor: pointer; text-align: left; padding: 10px; text-align: center; position: relative; padding-right: 25px; background-color: var(--secondary-color); color: var(--accent-color);">Refills <span class="sort-indicator"></span></th>
                    </tr>
                </thead>
                <tbody>`;

        tableData.forEach(stats => {
            const displayEstimatedStat = (stats.estimatedStats !== 'N/A') ? stats.estimatedStats.toLocaleString() : 'N/A';
            const displayNetworth = stats.networth.toLocaleString();
            const displayBiggestHit = stats.biggestHit.toLocaleString();

            tableHtml += `
                <tr>
                    <td data-column="member" style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);"><a href="https://www.torn.com/profiles.php?XID=${stats.memberID}" target="_blank" style="color: #FFD700; text-decoration: none;">${stats.name} [${stats.memberID}]</a></td>
                    <td data-column="level" data-value="${stats.level === 'Unknown' ? -1 : stats.level}" style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);">${stats.level}</td>
                    <td data-column="estimatedStats" data-value="${stats.estimatedStats === 'N/A' ? -1 : stats.estimatedStats}" style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);">${displayEstimatedStat}</td>
                    <td data-column="warHits" data-value="${stats.warHits}" style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);">${stats.warHits.toLocaleString()}</td>
                    <td data-column="cansUsed" data-value="${stats.cansUsed}" style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);">${stats.cansUsed.toLocaleString()}</td>
                    <td data-column="xanaxUsed" data-value="${stats.xanaxUsed}" style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);">${stats.xanaxUsed.toLocaleString()}</td>
                    <td data-column="networth" data-value="${stats.networth}" style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);">$${displayNetworth}</td>
                    <td data-column="biggestHit" data-value="${stats.biggestHit}" style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);">${displayBiggestHit}</td>
                    <td data-column="refills" data-value="${stats.refills}" style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);">${stats.refills.toLocaleString()}</td>
                </tr>`;
        });

        tableHtml += `</tbody></table>`;

        resultsContainer.innerHTML = tableHtml;

        // Add sorting functionality
        const table = document.getElementById('detailedStatsTable');
        const headers = table.querySelectorAll('th[data-column]');
        let currentSortColumn = 'estimatedStats';
        let currentSortDirection = 'desc';
        
        const sortDetailedTable = (column, direction) => {
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            
            // Update sort indicators
            headers.forEach(h => {
                const indicator = h.querySelector('.sort-indicator');
                const hColumn = h.getAttribute('data-column');
                if (hColumn === column) {
                    indicator.textContent = direction === 'asc' ? ' ↑' : ' ↓';
                } else {
                    indicator.textContent = '';
                }
            });
            
            // Sort rows
            rows.sort((a, b) => {
                const aCell = a.querySelector(`td[data-column="${column}"]`);
                const bCell = b.querySelector(`td[data-column="${column}"]`);
                
                let aValue = aCell.getAttribute('data-value') || aCell.textContent;
                let bValue = bCell.getAttribute('data-value') || bCell.textContent;
                
                if (column === 'member') {
                    aValue = aValue.toLowerCase();
                    bValue = bValue.toLowerCase();
                    if (aValue < bValue) return direction === 'asc' ? -1 : 1;
                    if (aValue > bValue) return direction === 'asc' ? 1 : -1;
                    return 0;
                } else {
                    let aNum = parseFloat(aValue);
                    let bNum = parseFloat(bValue);
                    if (isNaN(aNum)) aNum = -1;
                    if (isNaN(bNum)) bNum = -1;

                    if (direction === 'desc') {
                        return bNum - aNum;
                    } else {
                        return aNum - bNum;
                    }
                }
            });
            
            // Reorder rows
            rows.forEach(row => tbody.appendChild(row));
        };
        
        // Apply default sort
        sortDetailedTable(currentSortColumn, currentSortDirection);
        
        headers.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.getAttribute('data-column');
                
                if (currentSortColumn === column) {
                    currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSortColumn = column;
                    currentSortDirection = 'asc';
                }
                
                sortDetailedTable(currentSortColumn, currentSortDirection);
            });
        });

        // Add CSV export functionality for detailed stats
        document.getElementById('exportDetailedCsvBtn').addEventListener('click', () => {
            const csvData = [
                [`Faction: ${factionName} - Detailed Stats`],
                [],
                ['Member', 'Level', 'Estimated Stats', 'War Hits', 'Cans Used', 'Xanax Used', 'Networth', 'Biggest Hit', 'Refills']
            ];
            
            tableData.forEach(stats => {
                const displayEstimatedStat = (stats.estimatedStats !== 'N/A') ? stats.estimatedStats.toLocaleString() : 'N/A';
                const escapedMemberName = stats.name.replace(/"/g, '""');
                const memberLinkFormula = `=HYPERLINK("https://www.torn.com/profiles.php?XID=${stats.memberID}", "${escapedMemberName} [${stats.memberID}]")`;

                csvData.push([
                    memberLinkFormula,
                    stats.level,
                    displayEstimatedStat,
                    stats.warHits.toLocaleString(),
                    stats.cansUsed.toLocaleString(),
                    stats.xanaxUsed.toLocaleString(),
                    `$${stats.networth.toLocaleString()}`,
                    stats.biggestHit.toLocaleString(),
                    stats.refills.toLocaleString()
                ]);
            });
            
            const csvContent = csvData.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `faction_detailed_stats_${factionID}_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        });

        // Add back button functionality
        document.getElementById('backToOriginalBtn').addEventListener('click', () => {
            // Re-run the original battle stats fetch to restore the original view
            handleBattleStatsFetch();
        });
    };

    // --- CONSUMPTION TRACKER TOOL (OLD - KEPT FOR OTHER TOOLS) ---
    let fetchedMembers = []; // Store fetched members data globally for sorting

    function initConsumptionTrackerOld() {
        // Add specific listener for this tool's table sorting
        const tableContainer = document.getElementById('membersTable');
        if(tableContainer) {
            tableContainer.addEventListener('click', (event) => {
                const header = event.target.closest('th[data-column]');
                if (!header) return;

                const column = header.dataset.column;
                const sortColumnInput = document.getElementById('sortColumn');
                const sortDirectionInput = document.getElementById('sortDirection');
                
                if (sortColumnInput && sortDirectionInput) {
                    const currentDirection = sortDirectionInput.value;
                    const newDirection = currentDirection === 'asc' ? 'desc' : 'asc';
                    
                    sortColumnInput.value = column;
                    sortDirectionInput.value = newDirection;
                    
                    const sortedMembers = sortConsumptionMembersOld(fetchedMembers, column, newDirection);
                    updateConsumptionUIOld(sortedMembers);
                }
            });
        }

        const fetchBtn = document.getElementById('fetchData');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', handleConsumptionFetchOld);
        }
        const startDateInput = document.getElementById('startDate');
        const endDateInput = document.getElementById('endDate');

        if (startDateInput && endDateInput) {
            const startDatePicker = flatpickr(startDateInput, {
                dateFormat: "Y-m-d",
            });
            flatpickr(endDateInput, {
                dateFormat: "Y-m-d",
                defaultDate: "today",
            });
        }
        
        // Initialize with empty table and no performance stats
        updateConsumptionUIOld([], null, null, false);
        // Hide the empty results section initially
        const resultsSection = document.querySelector('.results-section');
        if (resultsSection) {
            resultsSection.style.display = 'none';
        }
    }

    const handleConsumptionFetchOld = async () => {
        const startTime = performance.now();
        let wasCached = false;

        let apiKey = localStorage.getItem('tornApiKey');
        if (!apiKey) {
            alert('Please enter your API key in the sidebar first');
            return;
        }
        const startDateInput = document.getElementById('startDate');
        const endDateInput = document.getElementById('endDate');

        // if (!startDateInput || !endDateInput) {
        //     alert('Please fill in all fields');
        //     return;
        // }

        // Handle date range - use earliest war as start date if not provided
        let startDate = startDateInput.value;
        let endDate = endDateInput.value;
        
        // If no end date provided, default to today
        if (!endDate) {
            endDate = new Date().toISOString().split('T')[0];
            console.log(`No end date provided, using default: ${endDate}`);
        }

        // Convert end date to timestamp
        const toTimestamp = Math.floor(new Date(endDate + 'T23:59:59Z').getTime() / 1000);
        
        // If no start date provided, we'll set it after fetching ranked wars
        let fromTimestamp = null;
        if (startDate) {
            fromTimestamp = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000);
            console.log(`Using provided start date: ${startDate} (${fromTimestamp})`);
        } else {
            console.log('No start date provided, will set to earliest war after fetching ranked wars');
        }
        
        console.log(`End date: ${endDate} (${toTimestamp})`);
        console.log(`Final date range: ${fromTimestamp} to ${toTimestamp}`);
        console.log(`Final date range (human readable): ${new Date(fromTimestamp * 1000).toLocaleDateString()} to ${new Date(toTimestamp * 1000).toLocaleDateString()}`);

        try {
            loadingSpinner.style.display = 'inline-block';
            fetchBtn.disabled = true;
            resultsSection.innerHTML = '<div class="loading-bar"><div class="loading-text">Fetching data...<div class="loading-dots"></div></div></div>';

            // Initialize member stats
            const memberStats = {};
            console.log('Fetching current member list...');
            
            const memberRequest = {
                name: 'members',
                url: `https://api.torn.com/v2/faction/${factionID}/members`,
                params: 'striptags=true'
            };

            const memberData = await batchTornApiCalls(apiKey, [memberRequest]);
            const members = memberData.members || {};
            
            console.log('Raw member data:', memberData);
            console.log('Members object keys:', Object.keys(members));
            if (Object.keys(members).length > 0) {
                console.log('First member data:', Object.values(members)[0]);
            }

            // Initialize stats for all current members
            // The members data is nested under a 'members' key as an array
            const membersArray = members.members || [];
            console.log(`Found ${membersArray.length} members in array`);
            
            // Track current members for UI styling
            const currentMembers = new Set();
            
            membersArray.forEach(member => {
                memberStats[member.id] = {
                    name: member.name,
                    chains: { total: 0, assists: 0, retaliations: 0, overseas: 0, war: 0 },
                    wars: { total: 0, points: 0 },
                    warParticipation: 0 // Track how many wars they participated in
                };
                currentMembers.add(member.id.toString());
            });

            console.log(`Initialized stats for ${Object.keys(memberStats).length} members.`);
            console.log(`Current members set:`, Array.from(currentMembers));

            // Step 1: Fetch ranked war list first to determine start date if needed
            console.log('Fetching ranked war list...');
            const warListRequest = {
                name: 'rankedwars',
                url: `https://api.torn.com/v2/faction/${factionID}/rankedwars`,
                params: ''
            };

            const warListData = await batchTornApiCalls(apiKey, [warListRequest]);
            const warsResponse = warListData.rankedwars || {};
            
            // The API returns wars in a "rankedwars" array, not as individual keys
            const allWarsArray = warsResponse.rankedwars || [];
            console.log(`Found ${allWarsArray.length} total ranked wars in the array.`);

            // Slice the array to only include the number of wars requested
            const warsToAnalyze = allWarsArray.slice(0, warCount);
            console.log(`Analyzing the ${warsToAnalyze.length} most recent wars.`);

            // If no start date was provided, set it to the earliest war *from the analyzed slice*
            if (!fromTimestamp && warsToAnalyze.length > 0) {
                const earliestWar = warsToAnalyze.reduce((earliest, current) => 
                    (current.start < earliest.start) ? current : earliest
                );
                console.log('Earliest war found:', earliestWar);
                fromTimestamp = earliestWar.start;
                const earliestDate = new Date(earliestWar.start * 1000).toISOString().split('T')[0];
                console.log(`No start date provided, using earliest war: ${earliestDate} (${fromTimestamp})`);
                
                // Update the start date input field
                if (startDateInput && startDateInput._flatpickr) {
                    startDateInput._flatpickr.setDate(new Date(earliestWar.start * 1000), false);
                    console.log(`Updated start date input field to: ${new Date(earliestWar.start * 1000).toLocaleDateString()}`);
                } else {
                    console.log('Could not update start date input field - flatpickr not found');
                }
            } else if (!fromTimestamp) {
                // No wars found and no start date provided, use a reasonable default
                fromTimestamp = Math.floor((Date.now() - (30 * 24 * 60 * 60 * 1000)) / 1000); // 30 days ago
                console.log(`No start date provided and no wars found, using 30 days ago: ${fromTimestamp}`);
            }

            console.log(`Final date range: ${fromTimestamp} to ${toTimestamp}`);
            console.log(`Final date range (human readable): ${new Date(fromTimestamp * 1000).toLocaleDateString()} to ${new Date(toTimestamp * 1000).toLocaleDateString()}`);

            // Step 2: Fetch chains within date range
            console.log('Fetching recent chains...');
            const chainListRequest = {
                name: 'chains',
                url: `https://api.torn.com/v2/faction/${factionID}/chains`,
                params: `limit=100&sort=DESC&to=${toTimestamp}&from=${fromTimestamp}&timestamp=${Math.floor(Date.now() / 1000)}`
            };
            
            console.log(`Chain API call URL: ${chainListRequest.url}?${chainListRequest.params}`);
            console.log(`Chain API call from timestamp: ${fromTimestamp} (${new Date(fromTimestamp * 1000).toLocaleDateString()})`);
            console.log(`Chain API call to timestamp: ${toTimestamp} (${new Date(toTimestamp * 1000).toLocaleDateString()})`);

            const chainListData = await batchTornApiCalls(apiKey, [chainListRequest]);
            const chainsResponse = chainListData.chains || {};
            
            // The API returns chains in a "chains" array, not as individual keys
            const chainsArray = chainsResponse.chains || [];
            console.log(`Found ${chainsArray.length} chains in the array.`);

            // Step 3: Fetch chain reports
            if (chainsArray.length > 0) {
                console.log(`Preparing to fetch reports for ${chainsArray.length} chains...`);
                
                // Debug: Log the structure of the first chain to understand the data format
                if (chainsArray.length > 0) {
                    console.log('First chain data structure:', chainsArray[0]);
                }
                
                const chainReportRequests = chainsArray.map((chainData, index) => {
                    // Each chain object should contain the faction ID that started the chain
                    const factionIdForChain = chainData.faction || chainData.faction_id || chainData.id;
                    console.log(`Chain ${index} -> Faction ID: ${factionIdForChain}`);
                    
                    return {
                        name: `chain_${index}`,
                        url: `https://api.torn.com/v2/faction/${factionIdForChain}/chainreport`,
                        params: ''
                    };
                });

                const chainReportData = await fetchTornApiInChunks(apiKey, chainReportRequests);
                processChainReports(chainReportData, memberStats);
            }

            // Step 4: Fetch ranked war reports
            if (warsToAnalyze.length > 0) {
                console.log(`Preparing to fetch reports for the latest ${warsToAnalyze.length} wars...`);
                
                // Debug: Log the structure of the first war to understand the data format
                if (warsToAnalyze.length > 0) {
                    console.log('First war data structure:', warsToAnalyze[0]);
                }
                
                const warReportRequests = warsToAnalyze.map((warData, index) => {
                    // Each war object should contain the war ID
                    const warId = warData.id || warData.war_id;
                    console.log(`War ${index} -> War ID: ${warId}`);
                    
                    return {
                        name: `war_${index}`,
                        url: `https://api.torn.com/v2/faction/${warId}/rankedwarreport`,
                        params: ''
                    };
                });

                const warReportData = await fetchTornApiInChunks(apiKey, warReportRequests);
                processRankedWarReports(warReportData, memberStats, factionID, currentMembers);
            }

            console.log('Calling updateWarReportUI...');
            updateWarReportUI(memberStats, startTime);

        } catch (error) {
            console.error('Failed to fetch war reports:', error);
            resultsSection.innerHTML = `<div class="error">Error: ${error.message}</div>`;
        } finally {
            loadingSpinner.style.display = 'none';
            fetchBtn.disabled = false;
        }
    };

    function sortConsumptionMembersOld(members, sortColumn, sortDirection) {
        return [...members].sort((a, b) => {
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

    function updateConsumptionUIOld(members, totalTime, cacheStats, wasCached) {
        const columns = [
            { id: 'xanax', label: 'Xanax' },
            { id: 'bloodbags', label: 'Blood Bags' },
            { id: 'firstAidKit', label: 'First Aid Kit' },
            { id: 'smallFirstAidKit', label: 'Small First Aid Kit' },
            { id: 'morphine', label: 'Morphine' },
            { id: 'ipecacSyrup', label: 'Ipecac Syrup' },
            { id: 'beer', label: 'Beer' },
            { id: 'lollipop', label: 'Lollipop' },
            { id: 'energyCans', label: 'Energy Cans' }
        ];

        const totals = {};
        columns.forEach(col => {
            totals[col.id] = members.reduce((sum, member) => sum + (member[col.id] || 0), 0);
        });

        const columnControls = document.createElement('div');
        columnControls.className = 'column-controls';
        columnControls.innerHTML = `<h3>Visible Columns:</h3><div class="column-toggles">${columns.map(col => `<label><input type="checkbox" class="column-toggle" data-column="${col.id}" checked> ${col.label}</label>`).join('')}</div>`;

        const table = document.createElement('table');
        const currentSortColumn = document.getElementById('sortColumn').value;
        const currentSortDirection = document.getElementById('sortDirection').value;
        
        const consumptionTitle = document.getElementById('consumptionTitle');
        const startDate = document.getElementById('startDate').value;
        const endDate = document.getElementById('endDate').value;
        consumptionTitle.textContent = `Member Consumption (${startDate} to ${endDate})`;

        const performanceDiv = document.createElement('div');
        performanceDiv.style.textAlign = 'center';
        performanceDiv.style.marginBottom = '15px';
        performanceDiv.style.fontSize = '0.9em';

        if (wasCached) {
            performanceDiv.style.color = '#00ff00';
            performanceDiv.innerHTML = `
                ⚡ Fetched from cache in ${totalTime.toFixed(0)}ms
                <br>
                💾 Cache: ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.hitRate}% hit rate)
            `;
        } else if (totalTime) {
            performanceDiv.style.color = '#ffd700';
             performanceDiv.innerHTML = `
                ⚡ Fetched in ${(totalTime / 1000).toFixed(2)}s
            `;
        }

        table.innerHTML = `
            <thead>
                <tr>
                    <th rowspan="3">Member</th>
                    <th colspan="5" class="chain-header">
                        Chain Activity
                        <div class="date-range-label">${chainDateRangeLabel}</div>
                    </th>
                    <th colspan="2" class="war-header" style="border-left: 2px solid var(--accent-color);">
                        War Activity
                        <div class="date-range-label">${warDateRangeLabel}</div>
                    </th>
                </tr>
                <tr>
                    <th data-column="chains.total" data-table-id="summary">Total Hits <span class="sort-indicator">
                        ${summarySort.column === 'chains.total' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                    </span></th>
                    <th data-column="chains.assists" data-table-id="summary">Assists <span class="sort-indicator">
                        ${summarySort.column === 'chains.assists' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                    </span></th>
                    <th data-column="chains.retaliations" data-table-id="summary">Retals <span class="sort-indicator">
                        ${summarySort.column === 'chains.retaliations' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                    </span></th>
                    <th data-column="chains.overseas" data-table-id="summary">Overseas <span class="sort-indicator">
                        ${summarySort.column === 'chains.overseas' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                    </span></th>
                    <th data-column="chains.war" data-table-id="summary">War Hits <span class="sort-indicator">
                        ${summarySort.column === 'chains.war' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                    </span></th>
                    <th data-column="wars.total" data-table-id="summary" style="border-left: 2px solid var(--accent-color);">Total Hits <span class="sort-indicator">
                        ${summarySort.column === 'wars.total' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                    </span></th>
                    <th data-column="wars.points" data-table-id="summary">Points Scored <span class="sort-indicator">
                        ${summarySort.column === 'wars.points' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                    </span></th>
                </tr>
            </thead>
            <tbody>
                ${members.map(member => `<tr>
                    <td><a href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(member.name)}" target="_blank">${member.name}</a></td>
                    ${columns.map(col => `<td class="column-${col.id}" data-column="${col.id}">${member[col.id] || 0}</td>`).join('')}</tr>`).join('')}
            </tbody>`;

        const tableContainer = document.getElementById('membersTable');
        tableContainer.innerHTML = '';
        tableContainer.appendChild(performanceDiv);
        tableContainer.appendChild(columnControls);
        tableContainer.appendChild(table);
        toggleColumnVisibility();
        
        // Show the results section
        document.querySelector('.results-section').style.display = 'block';
    }

    function toggleColumnVisibility() {
        const checkboxes = document.querySelectorAll('.column-toggle');
        checkboxes.forEach(checkbox => {
            const column = checkbox.dataset.column;
            const cells = document.querySelectorAll(`.column-${column}`);
            cells.forEach(cell => {
                cell.style.display = checkbox.checked ? '' : 'none';
            });
        });
    }

    function exportToCSV() {
        let csvContent = "data:text/csv;charset=utf-8,";
        const headers = ['Member', ...Array.from(document.querySelectorAll('#membersTable th[data-column]:not(.column-name)'))
            .filter(th => th.offsetParent !== null)
            .map(th => th.dataset.column)];
        csvContent += headers.join(",") + "\r\n";

        fetchedMembers.forEach(member => {
            const row = headers.map(header => {
                if (header === 'Member') return `"${member.name}"`;
                return member[header.toLowerCase().replace(/ /g, '')] || 0;
            });
            csvContent += row.join(",") + "\r\n";
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", "faction_consumption.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // --- WAR & CHAIN REPORTER ---
    let warReportSortState = {
        summary: { column: 'wars.total', direction: 'desc' }
    };

    function getNestedValue(obj, path) {
        if (!path) return obj;
        return path.split('.').reduce((acc, part) => acc && acc[part], obj);
    }

    function initWarChainReporter() {
        const fetchBtn = document.getElementById('fetchWarReports');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', handleWarReportFetch);
        }

        // Initialize date pickers for war chain reporter
        const startDateInput = document.getElementById('startDate');
        const endDateInput = document.getElementById('endDate');

        if (startDateInput && endDateInput) {
            // Initialize flatpickr instances
            const startDatePicker = flatpickr(startDateInput, {
                dateFormat: "Y-m-d",
                locale: {
                    firstDayOfWeek: 1
                }
            });
            const endDatePicker = flatpickr(endDateInput, {
                dateFormat: "Y-m-d",
                defaultDate: "today",
                locale: {
                    firstDayOfWeek: 1
                }
            });
        }
    }

    async function fetchTornApiInChunks(apiKey, requests, chunkSize = 10, delay = 6000) {
        const allData = {};
        const firstBurstCount = 50;
        const throttleDelay = 667; // ms between chunks after burst
        const burstChunkSize = chunkSize; // use same chunk size for burst
        
        // Split requests
        const burstRequests = requests.slice(0, firstBurstCount);
        const throttledRequests = requests.slice(firstBurstCount);

        // --- Burst phase ---
        if (burstRequests.length > 0) {
            const burstChunks = Math.ceil(burstRequests.length / burstChunkSize);
            console.log(`Burst phase: Fetching first ${burstRequests.length} requests in ${burstChunks} chunks as fast as possible...`);
            for (let i = 0; i < burstRequests.length; i += burstChunkSize) {
                const chunk = burstRequests.slice(i, i + burstChunkSize);
                const chunkData = await batchTornApiCalls(apiKey, chunk, burstChunkSize);
                Object.assign(allData, chunkData);
            }
        }

        // --- Wait 30 seconds if there are more requests ---
        if (throttledRequests.length > 0) {
            console.log('Waiting 30 seconds after burst to respect API rate limits...');
            await new Promise(resolve => setTimeout(resolve, 30000));
        }

        // --- Throttled phase ---
        if (throttledRequests.length > 0) {
            const throttleChunks = Math.ceil(throttledRequests.length / chunkSize);
            console.log(`Throttled phase: Fetching remaining ${throttledRequests.length} requests in ${throttleChunks} chunks with ${throttleDelay}ms delay between chunks...`);
            for (let i = 0; i < throttledRequests.length; i += chunkSize) {
                const chunk = throttledRequests.slice(i, i + chunkSize);
                const chunkData = await batchTornApiCalls(apiKey, chunk, chunkSize);
                Object.assign(allData, chunkData);
                if (i + chunkSize < throttledRequests.length) {
                    await new Promise(resolve => setTimeout(resolve, throttleDelay));
                }
            }
        }
        console.log('All chunks fetched.');
        return allData;
    }

    function processChainReports(chainReportData, memberStats) {
        console.log('Processing chain reports...');
        for (const [reportKey, report] of Object.entries(chainReportData)) {
            if (report.chainreport && report.chainreport.attackers) {
                report.chainreport.attackers.forEach(attacker => {
                    const memberId = attacker.id.toString();

                    // Ensure member exists. If not, create them with a placeholder name.
                    if (!memberStats[memberId]) {
                        memberStats[memberId] = {
                            name: `User [${memberId}]`, // Placeholder, as name is not in this report
                            chains: { total: 0, assists: 0, retaliations: 0, overseas: 0, war: 0 },
                            wars: { total: 0, points: 0 }
                        };
                    }
                    
                    // Aggregate chain stats
                    const member = memberStats[memberId];
                    member.chains.total += attacker.attacks.total || 0;
                    member.chains.assists += attacker.attacks.assists || 0;
                    member.chains.retaliations += attacker.attacks.retaliations || 0;
                    member.chains.overseas += attacker.attacks.overseas || 0;
                    member.chains.war += attacker.attacks.war || 0;
                });
            }
        }
    }

    function processRankedWarReports(warReportData, memberStats, ownFactionId, currentMembers) {
        console.log('Processing ranked war reports for faction:', ownFactionId);
        window.individualWarsData = [];

        for (const [reportKey, report] of Object.entries(warReportData)) {
            if (report.rankedwarreport) {
                const warData = {
                    id: report.rankedwarreport.id,
                    timestamp: report.rankedwarreport.start,
                    factions: {},
                    memberStats: {},
                    enemyFaction: { id: null, name: 'Unknown' }
                };

                if (report.rankedwarreport.factions) {
                    for (const factionData of Object.values(report.rankedwarreport.factions)) {
                        if (factionData.id.toString() !== ownFactionId) {
                            warData.enemyFaction = { id: factionData.id, name: factionData.name };
                        }
                        
                        warData.factions[factionData.id] = { name: factionData.name, score: factionData.score };

                        if (Array.isArray(factionData.members)) {
                            for (const memberData of factionData.members) {
                                const memberId = memberData.id.toString();
                                if (!memberId) continue;

                                const attacks = memberData.attacks || 0;
                                const points = memberData.points || memberData.score || 0;

                                // This section is only for our faction's members
                                if (factionData.id.toString() === ownFactionId) {
                                    // Ensure member exists in the main stats object. If not, create them.
                                    if (!memberStats[memberId]) {
                                        memberStats[memberId] = {
                                            name: memberData.name,
                                            chains: { total: 0, assists: 0, retaliations: 0, overseas: 0, war: 0 },
                                            wars: { total: 0, points: 0 },
                                            warParticipation: 0
                                        };
                                    } else {
                                        // If member exists (e.g., from a chain report), ensure their name is updated from the war report.
                                        memberStats[memberId].name = memberData.name;
                                    }
                                    // Always increment warParticipation for any member who appears in a war
                                    if (typeof memberStats[memberId].warParticipation !== 'number') memberStats[memberId].warParticipation = 0;
                                    memberStats[memberId].warParticipation += 1;
                                    // Aggregate stats for the "Total Summary" tab
                                    memberStats[memberId].wars.total += attacks;
                                    memberStats[memberId].wars.points += points;
                                    // Populate stats for the individual war tab
                                    warData.memberStats[memberId] = {
                                        name: memberData.name,
                                        level: memberData.level,
                                        attacks: attacks,
                                        points: points
                                    };
                                }
                            }
                        }
                    }
                }
                window.individualWarsData.push(warData);
            }
        }
        console.log('Final individual wars data:', window.individualWarsData);
    }

    // Helper to format date as YYYY-MM-DD
    function formatDate(ts) {
        if (!ts) return '';
        const d = new Date(ts * 1000);
        return d.toLocaleDateString();
    }

    // Helper to format date as MM/DD/YYYY HH:mm
    function formatDateTime(ts, isEnd = false) {
        if (!ts) return '';
        const d = new Date(ts * 1000);
        const date = d.toLocaleDateString();
        const time = isEnd ? '23:59' : '00:00';
        return `${date} ${time}`;
    }

    // Helper to format date as HH:mm:ss - DD/MM/YY (in UTC, but no label)
    function formatDateTime(ts, isEnd = false) {
        if (!ts) return '';
        const d = new Date(ts * 1000);
        const pad = n => n.toString().padStart(2, '0');
        const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        const date = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear().toString().slice(-2)}`;
        return `${time} - ${date}`;
    }

    // Helper to format timestamp as relative time (days only)
    function formatRelativeTime(timestamp) {
        if (!timestamp) return 'N/A';
        
        const now = Date.now();
        const diff = now - timestamp;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));

        if (days === 0) {
            return 'Today';
        } else if (days === 1) {
            return '1 day ago';
        } else {
            return `${days} days ago`;
        }
    }

    async function handleWarReportFetch() {
        console.log("--- Starting War & Chain Report Fetch ---");
        const startTime = performance.now();

        const loadingSpinner = document.getElementById('loadingSpinner');
        const resultsSection = document.querySelector('.results-section');
        const fetchBtn = document.getElementById('fetchWarReports');
        const factionIdInput = document.getElementById('factionId');
        const warCountInput = document.getElementById('warCount');
        const startDateInput = document.getElementById('startDate');
        const endDateInput = document.getElementById('endDate');

        // Check if all required elements exist
        if (!factionIdInput || !warCountInput || !startDateInput || !endDateInput) {
            alert('Error: Some form elements are missing. Please refresh the page and try again.');
            return;
        }

        const apiKey = localStorage.getItem('tornApiKey');
        const factionID = factionIdInput.value.trim();
        const warCount = parseInt(warCountInput.value) || 5;

        if (!apiKey || !factionID) {
            alert('Please enter your API key in the sidebar and a Faction ID.');
            return;
        }

        // Handle date range - use earliest war as start date if not provided
        let startDate = startDateInput.value;
        let endDate = endDateInput.value;
        
        // If no end date provided, default to today
        if (!endDate) {
            endDate = new Date().toISOString().split('T')[0];
            console.log(`No end date provided, using default: ${endDate}`);
        }

        // Convert end date to timestamp
        const toTimestamp = Math.floor(new Date(endDate + 'T23:59:59Z').getTime() / 1000);
        
        // If no start date provided, we'll set it after fetching ranked wars
        let fromTimestamp = null;
        if (startDate) {
            fromTimestamp = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000);
            console.log(`Using provided start date: ${startDate} (${fromTimestamp})`);
        } else {
            console.log('No start date provided, will set to earliest war after fetching ranked wars');
        }
        
        console.log(`End date: ${endDate} (${toTimestamp})`);
        console.log(`Final date range: ${fromTimestamp} to ${toTimestamp}`);
        console.log(`Final date range (human readable): ${new Date(fromTimestamp * 1000).toLocaleDateString()} to ${new Date(toTimestamp * 1000).toLocaleDateString()}`);

        try {
            loadingSpinner.style.display = 'inline-block';
            fetchBtn.disabled = true;
            resultsSection.innerHTML = '<div class="loading-bar"><div class="loading-text">Fetching data...<div class="loading-dots"></div></div></div>';

            // Initialize member stats
            const memberStats = {};
            console.log('Fetching current member list...');
            
            const memberRequest = {
                name: 'members',
                url: `https://api.torn.com/v2/faction/${factionID}/members`,
                params: 'striptags=true'
            };

            const memberData = await batchTornApiCalls(apiKey, [memberRequest]);
            const members = memberData.members || {};
            
            console.log('Raw member data:', memberData);
            console.log('Members object keys:', Object.keys(members));
            if (Object.keys(members).length > 0) {
                console.log('First member data:', Object.values(members)[0]);
            }

            // Initialize stats for all current members
            // The members data is nested under a 'members' key as an array
            const membersArray = members.members || [];
            console.log(`Found ${membersArray.length} members in array`);
            
            // Track current members for UI styling
            const currentMembers = new Set();
            
            membersArray.forEach(member => {
                memberStats[member.id] = {
                    name: member.name,
                    chains: { total: 0, assists: 0, retaliations: 0, overseas: 0, war: 0 },
                    wars: { total: 0, points: 0 },
                    warParticipation: 0 // Track how many wars they participated in
                };
                currentMembers.add(member.id.toString());
            });

            console.log(`Initialized stats for ${Object.keys(memberStats).length} members.`);
            console.log(`Current members set:`, Array.from(currentMembers));

            // Step 1: Fetch ranked war list first to determine start date if needed
            console.log('Fetching ranked war list...');
            const warListRequest = {
                name: 'rankedwars',
                url: `https://api.torn.com/v2/faction/${factionID}/rankedwars`,
                params: ''
            };

            const warListData = await batchTornApiCalls(apiKey, [warListRequest]);
            const warsResponse = warListData.rankedwars || {};
            
            // The API returns wars in a "rankedwars" array, not as individual keys
            const allWarsArray = warsResponse.rankedwars || [];
            console.log(`Found ${allWarsArray.length} total ranked wars in the array.`);

            // Slice the array to only include the number of wars requested
            const warsToAnalyze = allWarsArray.slice(0, warCount);
            console.log(`Analyzing the ${warsToAnalyze.length} most recent wars.`);

            // If no start date was provided, set it to the earliest war *from the analyzed slice*
            if (!fromTimestamp && warsToAnalyze.length > 0) {
                const earliestWar = warsToAnalyze.reduce((earliest, current) => 
                    (current.start < earliest.start) ? current : earliest
                );
                console.log('Earliest war found:', earliestWar);
                fromTimestamp = earliestWar.start;
                const earliestDate = new Date(earliestWar.start * 1000).toISOString().split('T')[0];
                console.log(`No start date provided, using earliest war: ${earliestDate} (${fromTimestamp})`);
                
                // Update the start date input field
                if (startDateInput && startDateInput._flatpickr) {
                    startDateInput._flatpickr.setDate(new Date(earliestWar.start * 1000), false);
                    console.log(`Updated start date input field to: ${new Date(earliestWar.start * 1000).toLocaleDateString()}`);
                } else {
                    console.log('Could not update start date input field - flatpickr not found');
                }
            } else if (!fromTimestamp) {
                // No wars found and no start date provided, use a reasonable default
                fromTimestamp = Math.floor((Date.now() - (30 * 24 * 60 * 60 * 1000)) / 1000); // 30 days ago
                console.log(`No start date provided and no wars found, using 30 days ago: ${fromTimestamp}`);
            }

            console.log(`Final date range: ${fromTimestamp} to ${toTimestamp}`);
            console.log(`Final date range (human readable): ${new Date(fromTimestamp * 1000).toLocaleDateString()} to ${new Date(toTimestamp * 1000).toLocaleDateString()}`);

            // Step 2: Fetch chains within date range
            console.log('Fetching recent chains...');
            const chainListRequest = {
                name: 'chains',
                url: `https://api.torn.com/v2/faction/${factionID}/chains`,
                params: `limit=100&sort=DESC&to=${toTimestamp}&from=${fromTimestamp}&timestamp=${Math.floor(Date.now() / 1000)}`
            };
            
            console.log(`Chain API call URL: ${chainListRequest.url}?${chainListRequest.params}`);
            console.log(`Chain API call from timestamp: ${fromTimestamp} (${new Date(fromTimestamp * 1000).toLocaleDateString()})`);
            console.log(`Chain API call to timestamp: ${toTimestamp} (${new Date(toTimestamp * 1000).toLocaleDateString()})`);

            const chainListData = await batchTornApiCalls(apiKey, [chainListRequest]);
            const chainsResponse = chainListData.chains || {};
            
            // The API returns chains in a "chains" array, not as individual keys
            const chainsArray = chainsResponse.chains || [];
            console.log(`Found ${chainsArray.length} chains in the array.`);

            // Step 3: Fetch chain reports
            if (chainsArray.length > 0) {
                console.log(`Preparing to fetch reports for ${chainsArray.length} chains...`);
                
                // Debug: Log the structure of the first chain to understand the data format
                if (chainsArray.length > 0) {
                    console.log('First chain data structure:', chainsArray[0]);
                }
                
                const chainReportRequests = chainsArray.map((chainData, index) => {
                    // Each chain object should contain the faction ID that started the chain
                    const factionIdForChain = chainData.faction || chainData.faction_id || chainData.id;
                    console.log(`Chain ${index} -> Faction ID: ${factionIdForChain}`);
                    
                    return {
                        name: `chain_${index}`,
                        url: `https://api.torn.com/v2/faction/${factionIdForChain}/chainreport`,
                        params: ''
                    };
                });

                const chainReportData = await fetchTornApiInChunks(apiKey, chainReportRequests);
                processChainReports(chainReportData, memberStats);
            }

            // Step 4: Fetch ranked war reports
            if (warsToAnalyze.length > 0) {
                console.log(`Preparing to fetch reports for the latest ${warsToAnalyze.length} wars...`);
                
                // Debug: Log the structure of the first war to understand the data format
                if (warsToAnalyze.length > 0) {
                    console.log('First war data structure:', warsToAnalyze[0]);
                }
                
                const warReportRequests = warsToAnalyze.map((warData, index) => {
                    // Each war object should contain the war ID
                    const warId = warData.id || warData.war_id;
                    console.log(`War ${index} -> War ID: ${warId}`);
                    
                    return {
                        name: `war_${index}`,
                        url: `https://api.torn.com/v2/faction/${warId}/rankedwarreport`,
                        params: ''
                    };
                });

                const warReportData = await fetchTornApiInChunks(apiKey, warReportRequests);
                processRankedWarReports(warReportData, memberStats, factionID, currentMembers);
            }

            console.log('Calling updateWarReportUI...');
            // After final date range is determined and before calling updateWarReportUI:
            // Use the actual earliest war start timestamp for the range
            let actualStartTimestamp = fromTimestamp;
            if (!startDate && warsToAnalyze.length > 0) {
                actualStartTimestamp = warsToAnalyze.reduce((earliest, current) =>
                    (current.start < earliest.start) ? current : earliest
                ).start;
            }
            const chainDateRangeLabel = `(${formatDateTime(actualStartTimestamp)} to ${formatDateTime(toTimestamp, true)})`;
            const warDateRangeLabel = `(${formatDateTime(actualStartTimestamp)} to ${formatDateTime(toTimestamp, true)})`;
            updateWarReportUI(memberStats, startTime, 'total-summary', chainDateRangeLabel, warDateRangeLabel, currentMembers, warsToAnalyze.length);

        } catch (error) {
            console.error('Failed to fetch war reports:', error);
            resultsSection.innerHTML = `<div class="error">Error: ${error.message}</div>`;
        } finally {
            loadingSpinner.style.display = 'none';
            fetchBtn.disabled = false;
        }
    }

    function updateWarReportUI(memberStats, startTime, activeTabId = 'total-summary', chainDateRangeLabel = '', warDateRangeLabel = '', currentMembers = new Set(), totalWars = 0) {
        console.log('Starting updateWarReportUI...');
        
        const resultsSection = document.querySelector('.results-section');
        const totalTime = performance.now() - startTime;
        const individualWars = window.individualWarsData || [];

        // Convert memberStats object to array for sorting
        const membersArray = Object.entries(memberStats).map(([id, stats]) => ({
            id,
            name: stats.name,
            ...stats
        }));

        // Sort the summary data
        const summarySort = warReportSortState.summary;
        membersArray.sort((a, b) => {
            const aValue = getNestedValue(a, summarySort.column);
            const bValue = getNestedValue(b, summarySort.column);
            if (typeof aValue === 'string') {
                return summarySort.direction === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
            }
            return summarySort.direction === 'asc' ? (aValue || 0) - (bValue || 0) : (bValue || 0) - (aValue || 0);
        });

        console.log('Members array:', membersArray);
        console.log('Members array length:', membersArray.length);

        // Calculate totals
        const totals = {
            chains: { total: 0, assists: 0, retaliations: 0, overseas: 0, war: 0 },
            wars: { total: 0, points: 0 }
        };
        
        membersArray.forEach(member => {
            totals.chains.total += member.chains.total;
            totals.chains.assists += member.chains.assists;
            totals.chains.retaliations += member.chains.retaliations;
            totals.chains.overseas += member.chains.overseas;
            totals.chains.war += member.chains.war;
            totals.wars.total += member.wars.total;
            totals.wars.points += member.wars.points;
        });

        let html = `
            <div class="summary-box">
                <h3>War & Chain Report Summary</h3>
                <p>Generated in ${(totalTime / 1000).toFixed(2)} seconds</p>
                <p>Members analyzed: ${membersArray.length}</p>
                <p>Wars analyzed: ${individualWars.length}</p>
            </div>
        `;

        // Only show tabs if there are individual wars
        if (individualWars.length > 0) {
            html += `
                <div class="war-tabs">
                    <div class="tab-buttons">
                        <button class="tab-button" data-tab="total-summary">Total Summary</button>
                        ${individualWars.map(war => `<button class="tab-button" data-tab="war-${war.id}">War vs. ${war.enemyFaction.name}</button>`).join('')}
                    </div>
                    <div class="tab-content">
                        <div class="tab-pane" id="total-summary">
                            <table id="membersTable">
                                <thead>
                                    <tr>
                                        <th rowspan="3">Member</th>
                                        <th colspan="5" class="chain-header">
                                            Chain Activity
                                            <div class="date-range-label">${chainDateRangeLabel}</div>
                                        </th>
                                        <th colspan="2" class="war-header" style="border-left: 2px solid var(--accent-color);">
                                            War Activity
                                            <div class="date-range-label">${warDateRangeLabel}</div>
                                        </th>
                                    </tr>
                                    <tr>
                                        <th data-column="chains.total" data-table-id="summary">Total Hits <span class="sort-indicator">
                                            ${summarySort.column === 'chains.total' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                                        </span></th>
                                        <th data-column="chains.assists" data-table-id="summary">Assists <span class="sort-indicator">
                                            ${summarySort.column === 'chains.assists' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                                        </span></th>
                                        <th data-column="chains.retaliations" data-table-id="summary">Retals <span class="sort-indicator">
                                            ${summarySort.column === 'chains.retaliations' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                                        </span></th>
                                        <th data-column="chains.overseas" data-table-id="summary">Overseas <span class="sort-indicator">
                                            ${summarySort.column === 'chains.overseas' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                                        </span></th>
                                        <th data-column="chains.war" data-table-id="summary">War Hits <span class="sort-indicator">
                                            ${summarySort.column === 'chains.war' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                                        </span></th>
                                        <th data-column="wars.total" data-table-id="summary" style="border-left: 2px solid var(--accent-color);">Total Hits <span class="sort-indicator">
                                            ${summarySort.column === 'wars.total' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                                        </span></th>
                                        <th data-column="wars.points" data-table-id="summary">Points Scored <span class="sort-indicator">
                                            ${summarySort.column === 'wars.points' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                                        </span></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${membersArray.map(m => {
                                        const isCurrentMember = currentMembers.has(m.id.toString());
                                        const participation = typeof m.warParticipation === 'number' && !isNaN(m.warParticipation) ? m.warParticipation : 0;
                                        const warsTotal = (typeof totalWars === 'number' && totalWars > 0) ? totalWars : 1;
                                        const participationRatio = `(${participation}/${warsTotal})`;
                                        const memberClass = isCurrentMember ? '' : 'former-member';
                                        return `
                                        <tr>
                                            <td><a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" class="${memberClass}">${m.name} ${participationRatio}</a></td>
                                            <td>${m.chains.total}</td><td>${m.chains.assists}</td><td>${m.chains.retaliations}</td><td>${m.chains.overseas}</td><td>${m.chains.war}</td>
                                            <td style="border-left: 2px solid var(--accent-color);">${m.wars.total}</td><td>${Math.round(m.wars.points)}</td>
                                        </tr>
                                    `}).join('')}
                                </tbody>
                                <tfoot>
                                    <tr class="totals-row">
                                        <td><strong>TOTALS</strong></td>
                                        <td><strong>${totals.chains.total}</strong></td><td><strong>${totals.chains.assists}</strong></td><td><strong>${totals.chains.retaliations}</strong></td><td><strong>${totals.chains.overseas}</strong></td><td><strong>${totals.chains.war}</strong></td>
                                        <td style="border-left: 2px solid var(--accent-color);"><strong>${totals.wars.total}</strong></td><td><strong>${Math.round(totals.wars.points)}</strong></td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                        ${individualWars.map(war => {
                            const tableId = `war-${war.id}`;
                            // Initialize sort state for this war tab if it doesn't exist
                            if (!warReportSortState[tableId]) {
                                warReportSortState[tableId] = { column: 'points', direction: 'desc' };
                            }
                            const warSort = warReportSortState[tableId];
                            const sortedMembers = Object.entries(war.memberStats || {}).sort(([,a],[,b]) => {
                                const aValue = getNestedValue(a, warSort.column);
                                const bValue = getNestedValue(b, warSort.column);
                                if (typeof aValue === 'string') {
                                    return warSort.direction === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
                                }
                                return warSort.direction === 'asc' ? (aValue || 0) - (bValue || 0) : (bValue || 0) - (aValue || 0);
                            });

                            return `
                            <div class="tab-pane" id="${tableId}">
                                <div class="war-info">
                                    <h4>War vs. ${war.enemyFaction.name}</h4>
                                    <p>Date: ${new Date(war.timestamp * 1000).toLocaleString()}</p>
                                    ${Object.values(war.factions || {}).map(f => `<p>${f.name}: ${f.score} points</p>`).join('')}
                                </div>
                                <table class="war-table">
                                    <thead>
                                        <tr>
                                            <th data-column="name" data-table-id="${tableId}">Member <span class="sort-indicator">${warSort.column === 'name' ? (warSort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                                            <th data-column="level" data-table-id="${tableId}">Level <span class="sort-indicator">${warSort.column === 'level' ? (warSort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                                            <th data-column="points" data-table-id="${tableId}">Points Scored <span class="sort-indicator">${warSort.column === 'points' ? (warSort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                                            <th data-column="attacks" data-table-id="${tableId}">Attacks <span class="sort-indicator">${warSort.column === 'attacks' ? (warSort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${sortedMembers.map(([id, m]) => {
                                            const isCurrentMember = currentMembers.has(id.toString());
                                            const memberClass = isCurrentMember ? '' : 'former-member';
                                            return `
                                                <tr>
                                                    <td><a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" class="${memberClass}">${m.name}</a></td>
                                                    <td>${m.level || 'N/A'}</td>
                                                    <td>${Math.round(m.points || 0)}</td>
                                                    <td>${m.attacks || 0}</td>
                                                </tr>
                                            `;
                                        }).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}).join('')}
                    </div>
                </div>
            `;
        } else {
            // Fallback to single table if no individual wars
            html += `
                <table id="membersTable">
                    <thead>
                        <tr>
                            <th rowspan="3">Member</th>
                            <th colspan="5" class="chain-header">
                                Chain Activity
                                <div class="date-range-label">${chainDateRangeLabel}</div>
                            </th>
                            <th colspan="2" class="war-header" style="border-left: 2px solid var(--accent-color);">
                                War Activity
                                <div class="date-range-label">${warDateRangeLabel}</div>
                            </th>
                        </tr>
                        <tr>
                            <th data-column="chains.total" data-table-id="summary">Total Hits <span class="sort-indicator">
                                ${summarySort.column === 'chains.total' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                            </span></th>
                            <th data-column="chains.assists" data-table-id="summary">Assists <span class="sort-indicator">
                                ${summarySort.column === 'chains.assists' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                            </span></th>
                            <th data-column="chains.retaliations" data-table-id="summary">Retals <span class="sort-indicator">
                                ${summarySort.column === 'chains.retaliations' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                            </span></th>
                            <th data-column="chains.overseas" data-table-id="summary">Overseas <span class="sort-indicator">
                                ${summarySort.column === 'chains.overseas' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                            </span></th>
                            <th data-column="chains.war" data-table-id="summary">War Hits <span class="sort-indicator">
                                ${summarySort.column === 'chains.war' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                            </span></th>
                            <th data-column="wars.total" data-table-id="summary" style="border-left: 2px solid var(--accent-color);">Total Hits <span class="sort-indicator">
                                ${summarySort.column === 'wars.total' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                            </span></th>
                            <th data-column="wars.points" data-table-id="summary">Points Scored <span class="sort-indicator">
                                ${summarySort.column === 'wars.points' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}
                            </span></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${membersArray.map(m => {
                            const isCurrentMember = currentMembers.has(m.id.toString());
                            const participation = typeof m.warParticipation === 'number' && !isNaN(m.warParticipation) ? m.warParticipation : 0;
                            const warsTotal = (typeof totalWars === 'number' && totalWars > 0) ? totalWars : 1;
                            const participationRatio = `(${participation}/${warsTotal})`;
                            const memberClass = isCurrentMember ? '' : 'former-member';
                            return `
                            <tr>
                                <td><a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" class="${memberClass}">${m.name} ${participationRatio}</a></td>
                                <td>${m.chains.total}</td><td>${m.chains.assists}</td><td>${m.chains.retaliations}</td><td>${m.chains.overseas}</td><td>${m.chains.war}</td>
                                <td style="border-left: 2px solid var(--accent-color);">${m.wars.total}</td><td>${Math.round(m.wars.points)}</td>
                            </tr>
                        `}).join('')}
                    </tbody>
                    <tfoot>
                        <tr class="totals-row">
                            <td><strong>TOTALS</strong></td>
                            <td><strong>${totals.chains.total}</strong></td><td><strong>${totals.chains.assists}</strong></td><td><strong>${totals.chains.retaliations}</strong></td><td><strong>${totals.chains.overseas}</strong></td><td><strong>${totals.chains.war}</strong></td>
                            <td style="border-left: 2px solid var(--accent-color);"><strong>${totals.wars.total}</strong></td><td><strong>${Math.round(totals.wars.points)}</strong></td>
                        </tr>
                    </tfoot>
                </table>
            `;
        }

        console.log('Generated HTML length:', html.length);
        console.log('Results section element:', resultsSection);
        console.log('Setting innerHTML...');
        resultsSection.innerHTML = html;
        resultsSection.style.display = 'block';
        
        // Restore active tab after re-render
        document.querySelector(`.tab-button[data-tab="${activeTabId}"]`)?.classList.add('active');
        document.querySelector(`.tab-pane#${activeTabId}`)?.classList.add('active');

        // Add tab functionality
        document.querySelectorAll('.tab-button').forEach(button => {
            button.addEventListener('click', () => {
                const currentActive = document.querySelector('.tab-button.active');
                if (currentActive) currentActive.classList.remove('active');
                document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
                
                button.classList.add('active');
                const targetTab = document.getElementById(button.dataset.tab);
                if (targetTab) targetTab.classList.add('active');
            });
        });

        // Add universal click listener for sorting
        resultsSection.querySelectorAll('th[data-column]').forEach(header => {
            header.addEventListener('click', () => {
                const tableId = header.dataset.tableId;
                const newSortColumn = header.dataset.column;
                
                if (!warReportSortState[tableId]) {
                    warReportSortState[tableId] = { column: 'points', direction: 'desc' };
                }

                const currentSort = warReportSortState[tableId];

                if (currentSort.column === newSortColumn) {
                    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSort.column = newSortColumn;
                    currentSort.direction = 'desc';
                }
                
                // Determine the active tab directly from the sorted table's ID
                const activeTabId = tableId === 'summary' ? 'total-summary' : tableId;
                updateWarReportUI(memberStats, startTime, activeTabId, chainDateRangeLabel, warDateRangeLabel, currentMembers, totalWars);
            });
        });
        
        console.log('updateWarReportUI completed');
    }
});