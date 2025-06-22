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
                const cacheKey = `${request.url}_${request.params}`;
                const cached = getCachedData(cacheKey);
                if (cached) {
                    console.log(`Using cached data for: ${request.name}`);
                    return { name: request.name, data: cached };
                }
                
                const fullUrl = `${request.url}?${request.params}&key=${apiKey}`;
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

            // After loading, initialize any scripts needed for that page
            if (page.includes('consumption-tracker')) {
                initConsumptionTracker();
            } else if (page.includes('faction-battle-stats')) {
                initBattleStats();
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
            if (target.id === 'fetchData') {
                handleConsumptionFetch();
            } else if (target.id === 'fetchFactionStats') {
                handleBattleStatsFetch();
            } else if (target.closest('th[data-column]')) {
                // Handle table sorting for consumption tracker
                const header = target.closest('th[data-column]');
                const column = header.dataset.column;
                const currentDirection = document.getElementById('sortDirection').value;
                const newDirection = currentDirection === 'asc' ? 'desc' : 'asc';
                
                document.getElementById('sortColumn').value = column;
                document.getElementById('sortDirection').value = newDirection;
                
                const sortedMembers = sortConsumptionMembers(fetchedMembers, column, newDirection);
                updateConsumptionUI(sortedMembers);
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
                    name: 'factionData',
                    url: `https://api.torn.com/faction/${factionID}`,
                    params: 'selections=basic'
                }
            ];

            console.log('Fetching Torn API data using batched requests...');
            const tornData = await batchTornApiCalls(apiKey, apiRequests);
            const tornEndTime = performance.now();
            console.log(`Torn API calls completed in ${(tornEndTime - tornStartTime).toFixed(2)}ms`);
            
            const myTotalStats = tornData.userStats.personalstats.totalstats;
            const factionData = tornData.factionData;
            
            const memberIDs = Object.keys(factionData.members);
            const membersObject = factionData.members;
            const factionName = factionData.name;
            
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
                    ? new Date(lastUpdatedTimestamp * 1000).toLocaleDateString() 
                    : 'N/A';

                tableHtml += `
                    <tr>
                        <td data-column="member"><a href="https://www.torn.com/profiles.php?XID=${memberID}" target="_blank" style="color: #FFD700; text-decoration: none;">${member.name} [${memberID}]</a></td>
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
            let currentSortColumn = null;
            let currentSortDirection = 'asc';
            
            headers.forEach(header => {
                header.addEventListener('click', () => {
                    const column = header.getAttribute('data-column');
                    const tbody = table.querySelector('tbody');
                    const rows = Array.from(tbody.querySelectorAll('tr'));
                    
                    // Update sort direction
                    if (currentSortColumn === column) {
                        currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
                    } else {
                        currentSortColumn = column;
                        currentSortDirection = 'asc';
                    }
                    
                    // Update sort indicators
                    headers.forEach(h => {
                        const indicator = h.querySelector('.sort-indicator');
                        const hColumn = h.getAttribute('data-column');
                        if (hColumn === currentSortColumn) {
                            indicator.textContent = currentSortDirection === 'asc' ? ' ↑' : ' ↓';
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
                            if (aValue < bValue) return currentSortDirection === 'asc' ? -1 : 1;
                            if (aValue > bValue) return currentSortDirection === 'asc' ? 1 : -1;
                            return 0;
                        } else {
                            let aNum = parseFloat(aValue);
                            let bNum = parseFloat(bValue);
                            if (isNaN(aNum)) aNum = -1; // Treat non-numeric/N/A as lowest value
                            if (isNaN(bNum)) bNum = -1;

                            if (currentSortDirection === 'desc') {
                                return bNum - aNum;
                            } else {
                                return aNum - bNum;
                            }
                        }
                    });
                    
                    // Reorder rows
                    rows.forEach(row => tbody.appendChild(row));
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

    // --- CONSUMPTION TRACKER TOOL ---
    let fetchedMembers = []; // Store fetched members data globally for sorting

    function initConsumptionTracker() {
        const fetchBtn = document.getElementById('fetchData');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', handleConsumptionFetch);
        }
        const startDateInput = document.getElementById('startDate');
        const endDateInput = document.getElementById('endDate');

        if (startDateInput && endDateInput) {
            flatpickr(startDateInput, {
                dateFormat: "Y-m-d",
            });
            flatpickr(endDateInput, {
                dateFormat: "Y-m-d",
            });
        }
        
        // Initialize with empty table and no performance stats
        updateConsumptionUI([], null, null, false);
        // Hide the empty results section initially
        const resultsSection = document.querySelector('.results-section');
        if (resultsSection) {
            resultsSection.style.display = 'none';
        }
    }

    const handleConsumptionFetch = async () => {
        const startTime = performance.now();
        let wasCached = false;

        let apiKey = localStorage.getItem('tornApiKey');
        if (!apiKey) {
            alert('Please enter your API key in the sidebar first');
            return;
        }
        const startDate = document.getElementById('startDate').value;
        const endDate = document.getElementById('endDate').value;

        if (!startDate || !endDate) {
            alert('Please fill in all fields');
            return;
        }

        const startEpoch = Math.floor(new Date(startDate).getTime() / 1000);
        const endEpoch = Math.floor(new Date(endDate).getTime() / 1000) + 86399;

        const loadingSpinner = document.getElementById('loadingSpinner');
        loadingSpinner.style.display = 'inline-block';
        document.getElementById('fetchData').disabled = true;

        try {
            const cacheKey = `consumption_${apiKey.slice(0, 6)}_${startEpoch}_${endEpoch}`;
            const cachedData = getCachedData(cacheKey);

            if (cachedData) {
                console.log('Using cached consumption data.');
                fetchedMembers = cachedData;
                wasCached = true;
            } else {
                let allNews = [];
                let url = `https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&cat=armoryAction&timestamp=${endEpoch}&key=${apiKey}`;
                let keepFetching = true;

                while (keepFetching && url) {
                    await new Promise(resolve => setTimeout(resolve, 667)); // ~3 calls every 2 seconds
                    const response = await fetch(url);
                    const data = await response.json();
                    if (data.error) throw new Error(data.error.error || data.error);
                    const news = data.news || [];
                    if (news.length === 0) break;

                    const filtered = news.filter(entry => entry.timestamp >= startEpoch && entry.timestamp <= endEpoch);
                    allNews = allNews.concat(filtered);

                    const oldest = news[news.length - 1];
                    if (oldest && oldest.timestamp > startEpoch && data._metadata && data._metadata.links && data._metadata.links.prev) {
                        url = data._metadata.links.prev + `&key=${apiKey}`;
                    } else {
                        keepFetching = false;
                    }
                }

                const itemLogs = {
                    xanax: allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('xanax')),
                    bloodBag: allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('blood bag')),
                    firstAidKit: allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('first aid kit')),
                    smallFirstAidKit: allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('small first aid kit')),
                    morphine: allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('morphine')),
                    ipecacSyrup: allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('ipecac syrup')),
                    beer: allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('bottle of beer')),
                    lollipop: allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('lollipop')),
                    energyCans: allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('energy can'))
                };

                const memberItems = {};
                Object.keys(itemLogs).forEach(item => {
                    itemLogs[item].forEach(entry => {
                        const match = entry.text.match(/^(.*?) used/i);
                        if (match) {
                            let name = match[1].trim();
                            if (name.includes('[')) name = name.substring(0, name.lastIndexOf('[')).trim();
                            if (!memberItems[name]) memberItems[name] = {};
                            if (!memberItems[name][item]) memberItems[name][item] = 0;
                            memberItems[name][item]++;
                        }
                    });
                });

                const allNames = new Set(Object.keys(memberItems));
                fetchedMembers = Array.from(allNames).map(name => ({
                    name,
                    xanax: memberItems[name].xanax || 0,
                    bloodbags: memberItems[name].bloodBag || 0,
                    firstAidKit: memberItems[name].firstAidKit || 0,
                    smallFirstAidKit: memberItems[name].smallFirstAidKit || 0,
                    morphine: memberItems[name].morphine || 0,
                    ipecacSyrup: memberItems[name].ipecacSyrup || 0,
                    beer: memberItems[name].beer || 0,
                    lollipop: memberItems[name].lollipop || 0,
                    energyCans: memberItems[name].energyCans || 0
                }));
                
                setCachedData(cacheKey, fetchedMembers);
            }
            
            const totalTime = performance.now() - startTime;
            const cacheStats = getCacheStats();

            const sortColumn = document.getElementById('sortColumn').value;
            const sortDirection = document.getElementById('sortDirection').value;
            const sortedMembers = sortConsumptionMembers(fetchedMembers, sortColumn, sortDirection);
            updateConsumptionUI(sortedMembers, totalTime, cacheStats, wasCached);

        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            loadingSpinner.style.display = 'none';
            document.getElementById('fetchData').disabled = false;
        }
    };

    function sortConsumptionMembers(members, sortColumn, sortDirection) {
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

    function updateConsumptionUI(members, totalTime, cacheStats, wasCached) {
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
                    <th data-column="name">Member <span class="sort-indicator">${'name' === currentSortColumn ? (currentSortDirection === 'asc' ? '↑' : '↓') : ''}</span></th>
                    ${columns.map(col => `<th class="column-${col.id}" data-column="${col.id}">${col.label} <span class="sort-indicator">${col.id === currentSortColumn ? (currentSortDirection === 'asc' ? '↑' : '↓') : ''}</span></th>`).join('')}
                </tr>
                <tr class="totals-row">
                    <th>Faction Total</th>
                    ${columns.map(col => `<th class="column-${col.id}" data-column="${col.id}">${totals[col.id]}</th>`).join('')}
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
}); 