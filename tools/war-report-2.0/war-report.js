console.log('[WAR REPORT 2.0] war-report.js LOADED');
// War Report 2.0 - Full Version
console.log('[WAR REPORT 2.0] Script loaded');

// Helper to sleep for ms milliseconds
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Global state for this module
let warReportData = {
    playerStats: {},
    warInfo: {},
    allAttacks: [],
    sortState: { column: 'warScore', direction: 'desc' },
    payoutSortState: { column: 'totalPayout', direction: 'desc' }
};

let tabsInitialized = false;

function initWarReport2() {
    console.log('[WAR REPORT 2.0] initWarReport2 CALLED');
    console.log('[WAR REPORT 2.0] Initialized');
    
    const fetchWarsBtn = document.getElementById('fetchWarsButton');
    const warSelector = document.getElementById('warSelector');
    const warSelectorContainer = document.getElementById('warSelectorContainer');
    const fetchDataContainer = document.getElementById('fetchDataContainer');
    const fetchDataBtn = document.getElementById('fetchData');
    const factionIdInput = document.getElementById('factionId');
    const exportBtn = document.getElementById('exportCSV');
    const exportPayoutBtn = document.getElementById('exportPayoutCSV');

    console.log('[WAR REPORT 2.0] DOM elements found:', {
        fetchWarsBtn: !!fetchWarsBtn,
        warSelector: !!warSelector,
        warSelectorContainer: !!warSelectorContainer,
        fetchDataContainer: !!fetchDataContainer,
        fetchDataBtn: !!fetchDataBtn,
        factionIdInput: !!factionIdInput,
        exportBtn: !!exportBtn,
        exportPayoutBtn: !!exportPayoutBtn
    });

    // Export button event listeners
    if (exportBtn) {
        exportBtn.addEventListener('click', exportWarReportToCSV);
    }
    if (exportPayoutBtn) {
        exportPayoutBtn.addEventListener('click', exportPayoutToCSV);
    }

    // Fetch Wars button logic
    if (fetchWarsBtn && factionIdInput && warSelector && warSelectorContainer) {
        console.log('[WAR REPORT 2.0] Adding click listener to fetch wars button');
        fetchWarsBtn.addEventListener('click', async () => {
            console.log('[WAR REPORT 2.0] Fetch Wars button clicked.');
            warSelectorContainer.style.display = 'none';
            if (fetchDataContainer) fetchDataContainer.style.display = 'none';
            warSelector.innerHTML = '';
            const factionId = factionIdInput.value.trim();
            if (!factionId) {
                alert('Please enter your Faction ID.');
                return;
            }
            
            // Get API key from global input
            const globalApiKeyInput = document.getElementById('globalApiKey');
            const apiKey = globalApiKeyInput ? globalApiKeyInput.value.trim() : '';
            if (!apiKey) {
                alert('Please enter your API key in the sidebar.');
                return;
            }
            
            try {
                warSelector.innerHTML = '<option>Loading...</option>';
                const url = `https://api.torn.com/v2/faction/${factionId}/rankedwars?key=${apiKey}`;
                console.log('[WAR REPORT 2.0] Fetching wars from:', url);
                const response = await fetch(url);
                const data = await response.json();
                
                if (data.error) {
                    alert('Error fetching wars: ' + data.error.error);
                    warSelector.innerHTML = '';
                    return;
                }
                const wars = data.rankedwars || [];
                if (!wars.length) {
                    alert('No wars found for this faction.');
                    warSelector.innerHTML = '';
                    return;
                }
                warSelector.innerHTML = wars.map(war => {
                    const start = new Date(war.start * 1000).toLocaleDateString();
                    const enemy = war.factions?.find(f => f.id != factionId)?.name || 'Unknown';
                    return `<option value="${war.id}">${enemy} (${start})</option>`;
                }).join('');
                warSelectorContainer.style.display = '';
                // Show Fetch War Data button immediately when wars are loaded
                if (fetchDataContainer) {
                    fetchDataContainer.style.display = '';
                }
                console.log('[WAR REPORT 2.0] Wars loaded and selector shown.');
            } catch (e) {
                alert('Failed to fetch wars: ' + e.message);
                warSelector.innerHTML = '';
            }
        });
    } else {
        console.error('[WAR REPORT 2.0] Missing required DOM elements for fetch wars functionality');
    }

    // Show Fetch War Data button when a war is selected
    if (warSelector && fetchDataContainer) {
        warSelector.addEventListener('change', () => {
            // Only hide the button if the user explicitly clears the selection
            // (i.e., if there are options available but none selected)
            if (warSelector.options.length > 1 && !warSelector.value) {
                fetchDataContainer.style.display = 'none';
            }
        });
    }

    // Fetch war data button event listener
    if (fetchDataBtn) {
        fetchDataBtn.addEventListener('click', handleWarReportFetch);
    }
}

// Main function to fetch and process war data
async function handleWarReportFetch() {
    const startTime = performance.now();
    
    const spinner = document.getElementById('loadingSpinner');
    const resultsSection = document.querySelector('.results-section');
    const warSelector = document.getElementById('warSelector');
    const factionIdInput = document.getElementById('factionId');

    if (!warSelector || !factionIdInput || !spinner || !resultsSection) {
        console.error("One or more required elements are missing from the page.");
        return;
    }

    // Get global API key from main input
    const globalApiKeyInput = document.getElementById('globalApiKey');
    const apiKey = globalApiKeyInput ? globalApiKeyInput.value.trim() : '';

    const warId = warSelector.value;
    const factionId = factionIdInput.value.trim();

    if (!apiKey || !warId || !factionId) {
        console.warn('[DEBUG] Required fields check failed:', { apiKey, warId, factionId });
        alert('Please enter all required fields: API Key, select a War, and Faction ID.');
        return;
    }

    console.log(`[WAR REPORT 2.0] Starting war report generation for War ID: ${warId}, Faction ID: ${factionId}`);

    startLoadingDots();
    resultsSection.style.display = 'none';

    try {
        // Step 1: Get ranked war information to determine start/end timestamps
        console.log('[WAR REPORT 2.0] Fetching ranked war information...');
        const warInfoUrl = `https://api.torn.com/v2/faction/${factionId}/rankedwars?key=${apiKey}`;
        const warInfoResponse = await fetch(warInfoUrl);
        const warInfoData = await warInfoResponse.json();

        if (warInfoData.error) {
            throw new Error(`Torn API Error: ${warInfoData.error.error}`);
        }

        // Find the specific war by its ID in the 'rankedwars' array
        const rankedWarsArray = warInfoData.rankedwars || [];
        console.log(`[WAR REPORT 2.0] Available Ranked Wars from API: ${rankedWarsArray.length} wars`);
        
        const targetWar = rankedWarsArray.find(war => war.id == warId);
        
        if (!targetWar) {
            const availableWarIds = rankedWarsArray.map(war => war.id).join(', ');
            const errorMessage = `Ranked War ID ${warId} not found in this faction's recent history. Available recent Ranked War IDs are: ${availableWarIds || 'None'}`;
            throw new Error(errorMessage);
        }

        console.log(`[WAR REPORT 2.0] Found war:`, targetWar);
        const warStartTime = targetWar.start;
        const warEndTime = targetWar.end || Math.floor(Date.now() / 1000);

        // Step 2: Fetch faction attacks during the war period
        console.log('[WAR REPORT 2.0] Fetching faction attacks during war period...');
        let allAttacks = [];
        let batchTo = warEndTime;
        let batchFrom = warStartTime;
        let batchCount = 0;
        let keepFetching = true;
        const maxBatches = 1000; // Arbitrary high limit for safety
        
        while (keepFetching && batchCount < maxBatches) {
            if (batchCount === 50) {
                console.log('[WAR REPORT 2.0] Hit 5000 attacks. Waiting 30 seconds before continuing at 1.5 requests/sec...');
                await sleep(30000);
            } else if (batchCount > 50) {
                await sleep(667); // 1.5 calls per second = 667ms between calls
            }
            
            const attacksUrl = `https://api.torn.com/v2/faction/attacks?limit=100&sort=DESC&to=${batchTo}&from=${batchFrom}&key=${apiKey}`;
            console.log(`[WAR REPORT 2.0] Batch ${batchCount + 1}: ${attacksUrl}`);
            
            const attacksResponse = await fetch(attacksUrl);
            const attacksData = await attacksResponse.json();
            
            if (attacksData.error) {
                throw new Error(`Torn API Error: ${attacksData.error.error}`);
            }

            const attacks = attacksData.attacks || [];
            allAttacks = allAttacks.concat(attacks);
            console.log(`[WAR REPORT 2.0] Fetched ${attacks.length} attacks in batch ${batchCount + 1}`);
            
            if (attacks.length < 100) {
                keepFetching = false; // No more attacks to fetch
            } else {
                // Find the earliest started timestamp in this batch
                const earliest = Math.min(...attacks.map(a => a.started));
                if (isFinite(earliest) && earliest > batchFrom) {
                    batchTo = earliest - 1; // Next batch: up to just before the earliest in this batch
                } else {
                    keepFetching = false;
                }
            }
            batchCount++;
        }
        
        console.log(`[WAR REPORT 2.0] Total attacks fetched: ${allAttacks.length}`);

        // Step 3: Process attacks and create player report
        const playerStats = {};
        const factionIdStr = String(factionId);

        allAttacks.forEach((attack) => {
            // Only include attacks where the attacker is in the user's faction
            if (!attack.attacker || !attack.attacker.faction || String(attack.attacker.faction.id) !== factionIdStr) {
                return;
            }

            const attackerId = String(attack.attacker.id);
            
            // Initialize player if not exists
            if (!playerStats[attackerId]) {
                playerStats[attackerId] = {
                    id: attackerId,
                    name: attack.attacker.name || 'Unknown',
                    level: attack.attacker.level || 0,
                    warHits: 0,
                    warAssists: 0,
                    warRetals: 0,
                    overseasHits: 0,
                    warScore: 0,
                    totalAttacks: 0,
                    totalFairFight: 0,
                    totalDefeatedLevel: 0,
                    successfulAttacks: 0
                };
            }

            // Count total attacks
            playerStats[attackerId].totalAttacks++;
            
            // Check modifiers for different types of hits
            if (attack.modifiers) {
                // War hits (modifiers.war === 2)
                if (attack.modifiers.war === 2) {
                    playerStats[attackerId].warHits++;
                    
                    // Calculate respect for war hits
                    if (attack.attacker && attack.defender && attack.attacker.level && attack.defender.level) {
                        const attackerLevel = attack.attacker.level;
                        const defenderLevel = attack.defender.level;
                        const levelDiff = defenderLevel - attackerLevel;
                        
                        let baseRespect = 0;
                        if (levelDiff >= 0) {
                            baseRespect = Math.max(1, Math.floor(levelDiff * 0.5) + 1);
                        } else {
                            baseRespect = Math.max(1, Math.floor(levelDiff * 0.25) + 1);
                        }
                        const warRespect = baseRespect * 2;
                        playerStats[attackerId].warScore += warRespect;
                    }
                }
                
                // Overseas hits
                if (attack.modifiers.overseas && attack.modifiers.overseas > 1) {
                    playerStats[attackerId].overseasHits++;
                }
                
                // Retaliations
                if (attack.modifiers.retaliation && attack.modifiers.retaliation === 1.5) {
                    playerStats[attackerId].warRetals++;
                }
            }
            
            // Assists
            if (attack.result && attack.result.toLowerCase().includes('assist')) {
                playerStats[attackerId].warAssists++;
            }
            
            // Fair fight and defeated level calculations
            if (attack.modifiers && attack.modifiers.fair_fight) {
                playerStats[attackerId].totalFairFight += attack.modifiers.fair_fight;
            }
            
            if (attack.result && !attack.result.toLowerCase().includes('lost') && !attack.result.toLowerCase().includes('stalemate')) {
                if (attack.defender && attack.defender.level) {
                    playerStats[attackerId].totalDefeatedLevel += attack.defender.level;
                    playerStats[attackerId].successfulAttacks++;
                }
            }
        });

        // Calculate averages
        Object.values(playerStats).forEach(player => {
            player.avgFairFight = player.totalAttacks > 0 ? player.totalFairFight / player.totalAttacks : 0;
            player.avgDefLevel = player.successfulAttacks > 0 ? player.totalDefeatedLevel / player.successfulAttacks : 0;
        });

        // Store data globally for this module
        warReportData.playerStats = playerStats;
        warReportData.warInfo = targetWar;
        warReportData.allAttacks = allAttacks;

        const totalTime = performance.now() - startTime;
        console.log(`[WAR REPORT 2.0] War report generation completed in ${totalTime.toFixed(2)}ms`);

        // Update UI
        updateWarReportUI(playerStats, targetWar, allAttacks, totalTime);

    } catch (error) {
        console.error('Failed to fetch war report:', error);
        resultsSection.innerHTML = `<div class="error">Error: ${error.message}</div>`;
    } finally {
        stopLoadingDots();
    }
}

// Update the UI with war report data
function updateWarReportUI(playerStats, warInfo, allAttacks, totalTime) {
    console.log('[WAR REPORT 2.0] Updating UI with data');
    console.log('[WAR REPORT 2.0] Player stats count:', Object.keys(playerStats).length);
    // Store data in global state
    warReportData.playerStats = playerStats;
    warReportData.warInfo = warInfo;
    warReportData.allAttacks = allAttacks;
    const spinner = document.getElementById('loadingSpinner');
    const resultsSection = document.querySelector('.results-section');
    console.log('[WAR REPORT 2.0] Found elements:', {
        spinner: !!spinner,
        resultsSection: !!resultsSection
    });
    if (spinner) spinner.style.display = 'none';
    if (resultsSection) {
        resultsSection.style.display = 'block';
        console.log('[WAR REPORT 2.0] Results section shown, re-initializing tabs');
        // Defer tab initialization until DOM is updated
        setTimeout(() => {
            console.log('[WAR REPORT 2.0] Calling initializeTabs after DOM update');
            initializeTabs();
        }, 0);
    } else {
        console.error('[WAR REPORT 2.0] Results section not found!');
    }
    // Update war summary
    const warSummaryDiv = document.getElementById('warSummary');
    if (warSummaryDiv) {
        const startDate = new Date(warInfo.start * 1000).toLocaleDateString();
        const endDate = new Date(warInfo.end * 1000).toLocaleDateString();
        // Calculate duration in seconds
        const durationSeconds = warInfo.end - warInfo.start;
        // Format duration as days, hours, minutes
        let durationStr = '';
        const days = Math.floor(durationSeconds / 86400);
        const hours = Math.floor((durationSeconds % 86400) / 3600);
        const minutes = Math.floor((durationSeconds % 3600) / 60);
        if (days > 0) durationStr += days + ' day' + (days > 1 ? 's' : '');
        if (hours > 0) durationStr += (durationStr ? ' ' : '') + hours + ' hour' + (hours > 1 ? 's' : '');
        if (minutes > 0) durationStr += (durationStr ? ' ' : '') + minutes + ' minute' + (minutes > 1 ? 's' : '');
        if (!durationStr) durationStr = '0 minutes';
        let warName = '';
        if (warInfo && warInfo.factions && Array.isArray(warInfo.factions)) {
            // Use factionId from input to determine enemy
            const factionIdInput = document.getElementById('factionId');
            const factionId = factionIdInput ? factionIdInput.value.trim() : '';
            const enemy = warInfo.factions.find(f => String(f.id) !== String(factionId));
            warName = enemy ? `vs ${enemy.name} (${startDate} - ${endDate})` : `(${startDate} - ${endDate})`;
        }
        // Convert processing time to seconds
        const totalTimeSeconds = (totalTime / 1000).toFixed(2);
        warSummaryDiv.innerHTML = `
            <div style="margin-bottom:8px;"><strong>War Report Summary ${warName}</strong></div>
            <p><strong>War Duration:</strong> ${durationStr}</p>
            <p><strong>Total Attacks:</strong> ${allAttacks.length.toLocaleString()}</p>
            <p><strong>Processing Time:</strong> ${totalTimeSeconds} seconds</p>
        `;
    }
    // Render the war report table
    console.log('[WAR REPORT 2.0] Calling renderWarReportTable');
    renderWarReportTable();
}

// Render the war report table with sorting
function renderWarReportTable() {
    console.log('[WAR REPORT 2.0] Starting renderWarReportTable');
    
    const playerStats = warReportData.playerStats;
    const warInfo = warReportData.warInfo;
    const allAttacks = warReportData.allAttacks;
    const sortState = warReportData.sortState;
    
    console.log('[WAR REPORT 2.0] Data available:', {
        playerStats: !!playerStats,
        warInfo: !!warInfo,
        allAttacks: !!allAttacks,
        sortState: !!sortState
    });
    
    // Convert to array and sort
    const sorted = Object.values(playerStats).sort((a, b) => {
        let aValue = a[sortState.column];
        let bValue = b[sortState.column];
        if (sortState.column === 'name') {
            aValue = (aValue || '').toLowerCase();
            bValue = (bValue || '').toLowerCase();
            return sortState.direction === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
        }
        aValue = aValue || 0;
        bValue = bValue || 0;
        return sortState.direction === 'asc' ? aValue - bValue : bValue - aValue;
    });

    const membersTableDiv = document.getElementById('membersTable');
    console.log('[WAR REPORT 2.0] Members table div found:', !!membersTableDiv);
    
    if (!membersTableDiv) {
        console.error('[WAR REPORT 2.0] Members table div not found!');
        return;
    }

    const tableHtml = `
        <table id="membersTable" style="width:100%;border-collapse:collapse;margin-top:20px;">
            <thead>
                <tr>
                    <th data-column="name" style="cursor: pointer;">Member <span class="sort-indicator">${sortState.column === 'name' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="level" style="cursor: pointer;">Level <span class="sort-indicator">${sortState.column === 'level' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warScore" style="cursor: pointer;">Score <span class="sort-indicator">${sortState.column === 'warScore' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warHits" style="cursor: pointer;">War Hits <span class="sort-indicator">${sortState.column === 'warHits' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warAssists" style="cursor: pointer;">Assists <span class="sort-indicator">${sortState.column === 'warAssists' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warRetals" style="cursor: pointer;">Retaliations <span class="sort-indicator">${sortState.column === 'warRetals' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="overseasHits" style="cursor: pointer;">Overseas <span class="sort-indicator">${sortState.column === 'overseasHits' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="totalAttacks" style="cursor: pointer;">Total Attacks <span class="sort-indicator">${sortState.column === 'totalAttacks' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="avgFairFight" style="cursor: pointer;">Avg FF <span class="sort-indicator">${sortState.column === 'avgFairFight' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="avgDefLevel" style="cursor: pointer;">Avg Def Level <span class="sort-indicator">${sortState.column === 'avgDefLevel' ? (sortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                </tr>
            </thead>
            <tbody>
                ${sorted.map(player => {
                    const avgFairFight = player.avgFairFight.toFixed(2);
                    const avgDefLevel = player.avgDefLevel.toFixed(1);
                    return `
                        <tr>
                            <td><a href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank">${player.name}</a></td>
                            <td>${player.level}</td>
                            <td>${player.warScore || 0}</td>
                            <td>${player.warHits}</td>
                            <td>${player.warAssists || 0}</td>
                            <td>${player.warRetals || 0}</td>
                            <td>${player.overseasHits || 0}</td>
                            <td>${player.totalAttacks}</td>
                            <td>${avgFairFight}</td>
                            <td>${avgDefLevel}</td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
            <tfoot>
                <tr class="totals-row">
                    <td><strong>TOTALS</strong></td>
                    <td></td>
                    <td><strong>${sorted.reduce((sum, p) => sum + (p.warScore || 0), 0)}</strong></td>
                    <td><strong>${sorted.reduce((sum, p) => sum + (p.warHits || 0), 0)}</strong></td>
                    <td><strong>${sorted.reduce((sum, p) => sum + (p.warAssists || 0), 0)}</strong></td>
                    <td><strong>${sorted.reduce((sum, p) => sum + (p.warRetals || 0), 0)}</strong></td>
                    <td><strong>${sorted.reduce((sum, p) => sum + (p.overseasHits || 0), 0)}</strong></td>
                    <td><strong>${allAttacks.length}</strong></td>
                    <td><strong>${sorted.reduce((sum, p) => sum + (p.avgFairFight || 0), 0) / sorted.length > 0 ? (sorted.reduce((sum, p) => sum + (p.avgFairFight || 0), 0) / sorted.length).toFixed(2) : '0.00'}</strong></td>
                    <td><strong>${sorted.reduce((sum, p) => sum + (p.avgDefLevel || 0), 0) / sorted.length > 0 ? (sorted.reduce((sum, p) => sum + (p.avgDefLevel || 0), 0) / sorted.length).toFixed(1) : '0.0'}</strong></td>
                </tr>
            </tfoot>
        </table>
    `;

    membersTableDiv.innerHTML = tableHtml;

    // Update summary header with war name
    const summaryHeader = document.querySelector('#report-tab .summary-header');
    if (summaryHeader && warInfo) {
        let enemyName = 'Enemy Faction';
        if (warInfo.factions && Array.isArray(warInfo.factions)) {
            // Use factionId from input to determine enemy
            const factionIdInput = document.getElementById('factionId');
            const factionId = factionIdInput ? factionIdInput.value.trim() : '';
            const enemy = warInfo.factions.find(f => String(f.id) !== String(factionId));
            if (enemy && enemy.name) enemyName = enemy.name;
        } else if (warInfo.factions && warInfo.factions.enemy) {
            enemyName = warInfo.factions.enemy;
        }
        // Format dates
        let dateRange = '';
        if (warInfo.start && warInfo.end) {
            const startDate = new Date(warInfo.start * 1000);
            const endDate = new Date(warInfo.end * 1000);
            dateRange = ` (${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()})`;
        }
        summaryHeader.innerHTML = `<strong>War Report Summary vs ${enemyName}${dateRange}</strong>`;
    }

    // Add click event listeners for sorting
    const table = document.getElementById('membersTable');
    if (table) {
        const headers = table.querySelectorAll('th[data-column]');
        headers.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.getAttribute('data-column');
                if (warReportData.sortState.column === column) {
                    warReportData.sortState.direction = warReportData.sortState.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    warReportData.sortState.column = column;
                    warReportData.sortState.direction = column === 'name' ? 'asc' : 'desc';
                }
                renderWarReportTable();
            });
        });
    }
    
    console.log('[WAR REPORT 2.0] renderWarReportTable completed successfully');
}

// Export war report to CSV
function exportWarReportToCSV() {
    const playerStats = warReportData.playerStats;
    if (!playerStats || Object.keys(playerStats).length === 0) {
        alert('No war report data to export. Please fetch war data first.');
        return;
    }

    const headers = [
        'Member',
        'Level',
        'Score',
        'Total Attacks',
        'War Hits',
        'Avg FF',
        'Avg Level Defeated',
        'War Assists',
        'War Retals',
        'Overseas'
    ];

    let csvContent = headers.join(',') + '\r\n';
    Object.values(playerStats).forEach(player => {
        const row = [
            '"' + ((player.name && typeof player.name === 'string' && player.name.trim().length > 0) ? player.name : 'Unknown') + '"',
            player.level !== undefined && player.level !== null && player.level !== '' ? player.level : 'Unknown',
            Math.round(player.warScore || 0),
            player.totalAttacks,
            player.warHits,
            (player.avgFairFight || 0).toFixed(2),
            (player.avgDefLevel || 0).toFixed(1),
            player.warAssists || 0,
            player.warRetals || 0,
            player.overseasHits || 0
        ];
        csvContent += row.join(',') + '\r\n';
    });

    const encodedUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'war_report_2.0.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Calculate payout for a player based on their stats
function calculatePlayerPayout(player, payPerHit) {
    const warHitPayout = (player.warHits || 0) * payPerHit;
    const retalPayout = (player.warRetals || 0) * payPerHit * 0.5;
    const assistPayout = (player.warAssists || 0) * payPerHit * 0.25;
    
    return {
        warHitPayout,
        retalPayout,
        assistPayout,
        totalPayout: warHitPayout + retalPayout + assistPayout
    };
}

// --- Add input formatting for thousand separators ---
function addThousandSeparatorInput(input) {
    if (!input) {
        console.log('[DEBUG] addThousandSeparatorInput: input is null/undefined');
        return;
    }
    console.log('[DEBUG] addThousandSeparatorInput: Attaching to', input.id, 'Initial value:', input.value);
    input.addEventListener('input', function(e) {
        let raw = input.value.replace(/[^\d]/g, '');
        if (raw === '') raw = '0';
        input.value = Number(raw).toLocaleString();
        input.dataset.raw = raw;
        console.log('[DEBUG] input event on', input.id, 'Value now:', input.value);
    });
    input.addEventListener('blur', function(e) {
        let raw = input.value.replace(/[^\d]/g, '');
        if (raw === '') raw = '0';
        input.value = Number(raw).toLocaleString();
        input.dataset.raw = raw;
        console.log('[DEBUG] blur event on', input.id, 'Value now:', input.value);
    });
    // Initialize
    let raw = input.value.replace(/[^\d]/g, '');
    if (raw === '') raw = '0';
    input.value = Number(raw).toLocaleString();
    input.dataset.raw = raw;
    console.log('[DEBUG] Initialized', input.id, 'to', input.value);
}

// --- Patch initializeTabs to add input formatting ---
function initializeTabs() {
    console.log('[DEBUG] initializeTabs() called');
    
    if (tabsInitialized) {
        console.log('[WAR REPORT 2.0] Tab event listener already attached.');
        return;
    }
    
    const tabButtons = document.querySelectorAll('[data-tab]');
    const tabPanes = document.querySelectorAll('.tab-pane');
    
    console.log('[DEBUG] Found tab buttons:', tabButtons.length);
    console.log('[DEBUG] Found tab panes:', tabPanes.length);
    
    if (tabButtons.length === 0 || tabPanes.length === 0) {
        console.log('[DEBUG] No tabs found, returning early');
        return;
    }
    
    const tabButtonsContainer = document.querySelector('.tab-buttons');
    if (!tabButtonsContainer) {
        console.error('[WAR REPORT 2.0] .tab-buttons container not found!');
        return;
    }
    if (!tabsInitialized) {
        tabButtonsContainer.addEventListener('click', function(e) {
            const btn = e.target.closest('.tab-button');
            if (!btn) return;
            console.log('[WAR REPORT 2.0] Tab button clicked (direct):', btn.textContent, 'data-tab:', btn.getAttribute('data-tab'));
            // Remove active class from all buttons and panes
            tabButtons.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => {
                p.classList.remove('active');
                p.style.display = 'none';
            });
            // Add active class to clicked button
            btn.classList.add('active');
            // Show the corresponding pane
            const tabId = btn.getAttribute('data-tab');
            const pane = document.getElementById(tabId);
            console.log('[WAR REPORT 2.0] Looking for pane with ID:', tabId, 'Found:', !!pane);
            if (pane) {
                pane.classList.add('active');
                pane.style.display = 'block';
                console.log('[WAR REPORT 2.0] Pane displayed:', tabId);
                // If switching to payout tab and we have data, render payout table
                if (tabId === 'payout-tab' && warReportData.playerStats && Object.keys(warReportData.playerStats).length > 0) {
                    console.log('[WAR REPORT 2.0] Rendering payout table...');
                    renderPayoutTable();
                } else if (tabId === 'payout-tab') {
                    console.log('[WAR REPORT 2.0] No player stats available for payout table');
                }
            } else {
                console.error('[WAR REPORT 2.0] Pane not found for tab ID:', tabId);
            }
        });
        tabsInitialized = true;
        console.log('[WAR REPORT 2.0] Tab event listener attached.');
    } else {
        console.log('[WAR REPORT 2.0] Tab event listener already attached.');
    }
    // Initialize payout input listeners and formatting
    const cacheSalesInput = document.getElementById('cacheSales');
    const payPerHitInput = document.getElementById('payPerHit');
    
    console.log('[DEBUG] Looking for payout input elements:');
    console.log('[DEBUG] cacheSales element found:', !!cacheSalesInput);
    console.log('[DEBUG] payPerHit element found:', !!payPerHitInput);
    
    // Debug: check if payout tab exists and has content
    const payoutTab = document.getElementById('payout-tab');
    console.log('[DEBUG] payout-tab element found:', !!payoutTab);
    if (payoutTab) {
        console.log('[DEBUG] payout-tab innerHTML length:', payoutTab.innerHTML.length);
        console.log('[DEBUG] payout-tab contains "combined":', payoutTab.innerHTML.includes('combined'));
        console.log('[DEBUG] payout-tab contains "min":', payoutTab.innerHTML.includes('min'));
    }
    
    if (cacheSalesInput && payPerHitInput) {
        console.log('[WAR REPORT 2.0] Adding payout input listeners');
        addThousandSeparatorInput(cacheSalesInput);
        addThousandSeparatorInput(payPerHitInput);
        // Define updatePayoutTable before using it
        const updatePayoutTable = () => {
            if (warReportData.playerStats && Object.keys(warReportData.playerStats).length > 0) {
                console.log('[WAR REPORT 2.0] Updating payout table due to input change');
                renderPayoutTable();
            }
        };
        // Apply to Other Costs boxes as well
        const otherCostsInputs = [
            document.getElementById('otherConsumables'),
            document.getElementById('otherSpies'),
            document.getElementById('otherBounties'),
            document.getElementById('otherTerms'),
            document.getElementById('otherOther')
        ];
        otherCostsInputs.forEach(input => {
            if (input) {
                console.log('[DEBUG] Found Other Costs input:', input.id, 'Value:', input.value);
                addThousandSeparatorInput(input);
                input.addEventListener('input', updatePayoutTable);
                input.addEventListener('blur', () => {
                    addThousandSeparatorInput(input); // re-apply formatting on blur
                });
                console.log('[DEBUG] Attached input/blur listeners to', input.id);
            } else {
                console.log('[DEBUG] Missing Other Costs input');
            }
        });
        cacheSalesInput.addEventListener('input', updatePayoutTable);
        payPerHitInput.addEventListener('input', updatePayoutTable);
        
        // Add event listeners for combined minimum settings
        const enableCombinedMinCheckbox = document.getElementById('enableCombinedMin');
        const combinedMinInput = document.getElementById('combinedMin');
        
        console.log('[DEBUG] Looking for combined min elements:');
        console.log('[DEBUG] enableCombinedMin element found:', !!enableCombinedMinCheckbox);
        console.log('[DEBUG] combinedMin element found:', !!combinedMinInput);
        
        // Debug: search for any elements that might be the combined min inputs
        const allInputs = document.querySelectorAll('input');
        console.log('[DEBUG] All input elements found:', allInputs.length);
        allInputs.forEach((input, index) => {
            if (input.id && (input.id.includes('min') || input.id.includes('combined') || input.id.includes('Min'))) {
                console.log(`[DEBUG] Potential combined min input ${index}:`, input.id, input.type, input.value);
            }
        });
        
        const allCheckboxes = document.querySelectorAll('input[type="checkbox"]');
        console.log('[DEBUG] All checkbox elements found:', allCheckboxes.length);
        allCheckboxes.forEach((checkbox, index) => {
            if (checkbox.id && (checkbox.id.includes('min') || checkbox.id.includes('combined') || checkbox.id.includes('Min'))) {
                console.log(`[DEBUG] Potential combined min checkbox ${index}:`, checkbox.id, checkbox.checked);
            }
        });
        
        if (enableCombinedMinCheckbox) {
            enableCombinedMinCheckbox.addEventListener('change', updatePayoutTable);
            console.log('[DEBUG] Attached change listener to enableCombinedMin checkbox');
        } else {
            console.log('[DEBUG] WARNING: enableCombinedMin checkbox not found!');
        }
        
        if (combinedMinInput) {
            combinedMinInput.addEventListener('input', (e) => {
                console.log('[DEBUG] Combined Min changed to:', e.target.value);
                updatePayoutTable();
            });
            console.log('[DEBUG] Attached input listener to combinedMin input');
        } else {
            console.log('[DEBUG] WARNING: combinedMin input not found!');
        }
        
        // Add event listeners for Advanced Payout Options checkboxes and multipliers
        const advancedPayoutOptions = [
            { checkboxId: 'payAssists', multiplierId: 'assistMultiplier' },
            { checkboxId: 'payRetals', multiplierId: 'retalMultiplier' },
            { checkboxId: 'payOverseas', multiplierId: 'overseasMultiplier' },
            { checkboxId: 'payOtherAttacks', multiplierId: 'otherAttacksMultiplier' }
        ];
        
        console.log('[DEBUG] === ADVANCED PAYOUT OPTIONS DEBUG ===');
        console.log('[DEBUG] updatePayoutTable function exists:', typeof updatePayoutTable);
        
        advancedPayoutOptions.forEach(option => {
            const checkbox = document.getElementById(option.checkboxId);
            const multiplier = document.getElementById(option.multiplierId);
            
            console.log(`[DEBUG] Looking for ${option.checkboxId}:`, !!checkbox);
            if (checkbox) {
                console.log(`[DEBUG] ${option.checkboxId} found - type: ${checkbox.type}, checked: ${checkbox.checked}, value: ${checkbox.value}`);
            }
            console.log(`[DEBUG] Looking for ${option.multiplierId}:`, !!multiplier);
            if (multiplier) {
                console.log(`[DEBUG] ${option.multiplierId} found - type: ${multiplier.type}, value: ${multiplier.value}`);
            }
            
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    console.log(`[DEBUG] ${option.checkboxId} checkbox changed! New value: ${e.target.checked}`);
                    updatePayoutTable();
                });
                console.log(`[DEBUG] ✅ Attached change listener to ${option.checkboxId} checkbox`);
            } else {
                console.log(`[DEBUG] ❌ WARNING: ${option.checkboxId} checkbox not found!`);
            }
            
            if (multiplier) {
                multiplier.addEventListener('input', (e) => {
                    console.log(`[DEBUG] ${option.multiplierId} multiplier changed! New value: ${e.target.value}`);
                    updatePayoutTable();
                });
                console.log(`[DEBUG] ✅ Attached input listener to ${option.multiplierId} input`);
            } else {
                console.log(`[DEBUG] ❌ WARNING: ${option.multiplierId} input not found!`);
            }
        });
        
        console.log('[DEBUG] === END ADVANCED PAYOUT OPTIONS DEBUG ===');
    }
}

// --- Patch renderPayoutTable to match main report style and remove breakdown columns ---
function renderPayoutTable() {
    const playerStats = warReportData.playerStats;
    const warInfo = warReportData.warInfo;
    const allAttacks = warReportData.allAttacks;
    if (!playerStats || Object.keys(playerStats).length === 0) {
        console.log('[WAR REPORT 2.0] No player stats available for payout table');
        return;
    }
    // Get payout settings (use raw value for calculations)
    const cacheSalesInput = document.getElementById('cacheSales');
    const payPerHitInput = document.getElementById('payPerHit');
    const cacheSales = parseInt(cacheSalesInput?.dataset.raw || cacheSalesInput?.value.replace(/[^\d]/g, '') || '1000000000');
    const payPerHit = parseInt(payPerHitInput?.dataset.raw || payPerHitInput?.value.replace(/[^\d]/g, '') || '1000000');

    // Get war name and dates for summary
    let warName = '';
    if (warInfo && warInfo.factions && Array.isArray(warInfo.factions)) {
        // Use factionId from input to determine enemy
        const factionIdInput = document.getElementById('factionId');
        const factionId = factionIdInput ? factionIdInput.value.trim() : '';
        const enemy = warInfo.factions.find(f => String(f.id) !== String(factionId));
        const start = new Date(warInfo.start * 1000).toLocaleDateString();
        const end = new Date(warInfo.end * 1000).toLocaleDateString();
        warName = enemy ? `vs ${enemy.name} (${start} - ${end})` : `(${start} - ${end})`;
    }

    // Get Other Costs
    const otherCosts = [
        { label: 'Consumables', id: 'otherConsumables' },
        { label: 'Spies', id: 'otherSpies' },
        { label: 'Bounties', id: 'otherBounties' },
        { label: 'Terms', id: 'otherTerms' },
        { label: 'Other', id: 'otherOther' }
    ];
    let totalCosts = 0;
    otherCosts.forEach(cost => {
        const input = document.getElementById(cost.id);
        let value = 0;
        if (input) {
            // Always parse cleaned .value (remove all non-digit chars)
            value = parseInt(input.value.replace(/[^\d]/g, '') || '0', 10);
        }
        totalCosts += value;
    });
    // Debug log for other costs
    console.log('[DEBUG] Other Costs values:', otherCosts.map(cost => {
        const input = document.getElementById(cost.id);
        return { id: cost.id, value: input ? input.value : 'N/A' };
    }));
    console.log('[DEBUG] Total Costs calculated:', totalCosts);

    // Advanced payout options
    const payAssists = document.getElementById('payAssists')?.checked;
    const assistMultiplier = parseFloat(document.getElementById('assistMultiplier')?.value || '0.25');
    const payRetals = document.getElementById('payRetals')?.checked;
    const retalMultiplier = parseFloat(document.getElementById('retalMultiplier')?.value || '0.5');
    const payOverseas = document.getElementById('payOverseas')?.checked;
    const overseasMultiplier = parseFloat(document.getElementById('overseasMultiplier')?.value || '0.25');
    const payOtherAttacks = document.getElementById('payOtherAttacks')?.checked;
    const otherAttacksMultiplier = parseFloat(document.getElementById('otherAttacksMultiplier')?.value || '0.1');
    const enableCombinedMin = document.getElementById('enableCombinedMin')?.checked;
    const combinedMin = parseInt(document.getElementById('combinedMin')?.value || '0');

    console.log('[DEBUG] === PAYOUT CALCULATION DEBUG ===');
    console.log('[DEBUG] Advanced Payout Options values:');
    console.log('[DEBUG] payAssists:', payAssists, 'assistMultiplier:', assistMultiplier);
    console.log('[DEBUG] payRetals:', payRetals, 'retalMultiplier:', retalMultiplier);
    console.log('[DEBUG] payOverseas:', payOverseas, 'overseasMultiplier:', overseasMultiplier);
    console.log('[DEBUG] payOtherAttacks:', payOtherAttacks, 'otherAttacksMultiplier:', otherAttacksMultiplier);
    console.log('[DEBUG] enableCombinedMin:', enableCombinedMin, 'combinedMin:', combinedMin);
    console.log('[DEBUG] payPerHit:', payPerHit);
    console.log('[DEBUG] === END PAYOUT CALCULATION DEBUG ===');

    console.log('[DEBUG] Starting payout calculation for all players');
    const playersWithPayouts = Object.values(playerStats).map(player => {
        let warHitPayout = (player.warHits || 0) * payPerHit;
        let retalPayout = payRetals ? (player.warRetals || 0) * payPerHit * retalMultiplier : 0;
        let assistPayout = payAssists ? (player.warAssists || 0) * payPerHit * assistMultiplier : 0;
        let overseasPayout = payOverseas ? (player.overseasHits || 0) * payPerHit * overseasMultiplier : 0;
        let otherAttacksPayout = payOtherAttacks ? ((player.totalAttacks - (player.warHits || 0) - (player.warAssists || 0)) * payPerHit * otherAttacksMultiplier) : 0;

        // Debug: print combined min logic for every player
        const combinedCount = (player.warHits || 0) + (player.warAssists || 0);
        console.log(`[DEBUG] Player: ${player.name}, War Hits: ${player.warHits || 0}, Assists: ${player.warAssists || 0}, Combined: ${combinedCount}, Min Enabled: ${enableCombinedMin}, Min Value: ${combinedMin}`);
        if (enableCombinedMin && combinedCount < combinedMin) {
            warHitPayout = 0;
            assistPayout = 0;
            retalPayout = 0;
            overseasPayout = 0;
            otherAttacksPayout = 0;
            console.log(`[DEBUG] Zeroed payout for ${player.name} (Combined: ${combinedCount} < Min: ${combinedMin})`);
        }
        console.log(`[DEBUG] Returning payout for ${player.name}: $${warHitPayout + retalPayout + assistPayout + overseasPayout + otherAttacksPayout}`);
        return {
            ...player,
            warHitPayout,
            retalPayout,
            assistPayout,
            overseasPayout,
            otherAttacksPayout,
            totalPayout: warHitPayout + retalPayout + assistPayout + overseasPayout + otherAttacksPayout
        };
    });
    console.log('[DEBUG] Finished payout calculation. playersWithPayouts:', playersWithPayouts.length);

    // Sort by payout sort state
    const { column: sortColumn, direction: sortDirection } = warReportData.payoutSortState;
    playersWithPayouts.sort((a, b) => {
        let aValue = a[sortColumn];
        let bValue = b[sortColumn];
        if (typeof aValue === 'string') {
            aValue = aValue.toLowerCase();
            bValue = bValue.toLowerCase();
        }
        if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
        if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });

    // Calculate totals
    const totalPayout = playersWithPayouts.reduce((sum, p) => sum + p.totalPayout, 0);
    const totalWarHits = playersWithPayouts.reduce((sum, p) => sum + (p.warHits || 0), 0);
    const remaining = cacheSales - totalPayout - totalCosts;
    const remainingPercent = cacheSales !== 0 ? ((remaining / cacheSales) * 100).toFixed(2) : '0.00';
    const payoutTableDiv = document.getElementById('payoutTable');
    if (!payoutTableDiv) return;
    const tableHtml = `
        <div class="summary-box" style="margin-bottom: 20px;">
            <h3><strong>War Payout Summary</strong>${warName ? ' <span style=\"font-weight:normal;color:#ccc;font-size:0.95em;\">' + warName + '</span>' : ''}</h3>
            <p><strong>Cache Sales:</strong> $${cacheSales.toLocaleString()}</p>
            <p><strong>Total Costs:</strong> $${totalCosts.toLocaleString()}</p>
            <p><strong>Pay Per Hit:</strong> $${payPerHit.toLocaleString()}</p>
            <p><strong>Total Payout:</strong> $${totalPayout.toLocaleString()}</p>
            <p><strong>Remaining:</strong> $${remaining.toLocaleString()} <span style=\"color:#ffd700;font-weight:normal;\">(${remainingPercent}% of cache sales)</span></p>
            <p><strong>Total War Hits:</strong> ${totalWarHits.toLocaleString()}</p>
            <button id="exportPayoutCSV" class="btn btn-secondary">Export to CSV</button>
        </div>
        <div class="table-container">
        <div class="table-header" style="display: flex; align-items: flex-end; justify-content: space-between;">
            <h3>Payout Table (hit based)</h3>
            <button id="openAllPayLinks" class="btn btn-primary" style="margin-bottom: 4px;">Open All Links</button>
        </div>
        <div style="margin-bottom: 10px; font-size: 12px; color: #666; font-style: italic;">
            💡 <strong>Note:</strong> If links don't open, please allow popups for this site in your browser settings.
        </div>
        <table id="payoutTable" style="width:100%;border-collapse:collapse;margin-top:20px;">
            <thead>
                <tr>
                    <th data-column="name" style="cursor: pointer;">Member <span class="sort-indicator">${warReportData.payoutSortState.column === 'name' ? (warReportData.payoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="level" style="cursor: pointer;">Level <span class="sort-indicator">${warReportData.payoutSortState.column === 'level' ? (warReportData.payoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warHits" style="cursor: pointer;">War Hits <span class="sort-indicator">${warReportData.payoutSortState.column === 'warHits' ? (warReportData.payoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warRetals" style="cursor: pointer;">Retaliations <span class="sort-indicator">${warReportData.payoutSortState.column === 'warRetals' ? (warReportData.payoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warAssists" style="cursor: pointer;">Assists <span class="sort-indicator">${warReportData.payoutSortState.column === 'warAssists' ? (warReportData.payoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="overseasHits" style="cursor: pointer;">Overseas <span class="sort-indicator">${warReportData.payoutSortState.column === 'overseasHits' ? (warReportData.payoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="otherAttacks" style="cursor: pointer;">Other Attacks <span class="sort-indicator">${warReportData.payoutSortState.column === 'otherAttacks' ? (warReportData.payoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="totalPayout" style="cursor: pointer;"><strong>Total Payout</strong> <span class="sort-indicator">${warReportData.payoutSortState.column === 'totalPayout' ? (warReportData.payoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th>Pay link</th>
                </tr>
            </thead>
            <tbody>
                ${playersWithPayouts.map(player => {
                    const otherAttacks = (player.totalAttacks || 0) - (player.warHits || 0) - (player.warAssists || 0);
                    const payLink = `https://www.torn.com/factions.php?step=your#/tab=controls&option=give-to-user&addMoneyTo=${player.id}&money=${player.totalPayout}`;
                    return `
                        <tr>
                            <td><a href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank">${player.name}</a></td>
                            <td>${player.level}</td>
                            <td>${player.warHits || 0}</td>
                            <td>${player.warRetals || 0}</td>
                            <td>${player.warAssists || 0}</td>
                            <td>${player.overseasHits || 0}</td>
                            <td>${otherAttacks}</td>
                            <td><strong>$${player.totalPayout.toLocaleString()}</strong></td>
                            <td>${player.totalPayout > 0 ? `<a href="${payLink}" target="_blank" rel="noopener noreferrer" title="Pay in Torn">💰</a>` : ''}</td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
            <tfoot>
                <tr class="totals-row">
                    <td><strong>TOTALS</strong></td>
                    <td></td>
                    <td><strong>${totalWarHits}</strong></td>
                    <td><strong>${playersWithPayouts.reduce((sum, p) => sum + (p.warRetals || 0), 0)}</strong></td>
                    <td><strong>${playersWithPayouts.reduce((sum, p) => sum + (p.warAssists || 0), 0)}</strong></td>
                    <td><strong>${playersWithPayouts.reduce((sum, p) => sum + (p.overseasHits || 0), 0)}</strong></td>
                    <td><strong>${playersWithPayouts.reduce((sum, p) => sum + ((p.totalAttacks || 0) - (p.warHits || 0) - (p.warAssists || 0)), 0)}</strong></td>
                    <td><strong>$${totalPayout.toLocaleString()}</strong></td>
                    <td></td>
                </tr>
            </tfoot>
        </table>
        </div>
    `;
    console.log('[DEBUG] Payout summary HTML:', tableHtml);
    payoutTableDiv.innerHTML = tableHtml;
    
    // Add click event listeners for sorting
    const table = document.getElementById('payoutTable');
    console.log('[WAR REPORT 2.0] Payout table found:', !!table);
    if (table) {
        const headers = table.querySelectorAll('th[data-column]');
        console.log('[WAR REPORT 2.0] Found payout table headers:', headers.length);
        headers.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.getAttribute('data-column');
                console.log('[WAR REPORT 2.0] Payout header clicked:', column);
                console.log('[WAR REPORT 2.0] Current payout sort state:', warReportData.payoutSortState);
                
                if (warReportData.payoutSortState.column === column) {
                    warReportData.payoutSortState.direction = warReportData.payoutSortState.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    warReportData.payoutSortState.column = column;
                    warReportData.payoutSortState.direction = column === 'name' ? 'asc' : 'desc';
                }
                
                console.log('[WAR REPORT 2.0] New payout sort state:', warReportData.payoutSortState);
                console.log('[WAR REPORT 2.0] Re-rendering payout table...');
                renderPayoutTable();
            });
        });
    } else {
        console.error('[WAR REPORT 2.0] Payout table not found!');
    }
    
    // Attach only the summary box export button
    const exportPayoutBtn = document.getElementById('exportPayoutCSV');
    if (exportPayoutBtn) {
        exportPayoutBtn.addEventListener('click', exportPayoutToCSV);
    }

    // Add Open All Links button functionality
    const openAllBtn = document.getElementById('openAllPayLinks');
    if (openAllBtn) {
        openAllBtn.onclick = async () => {
            const playersWithPayouts = Object.values(playerStats).map(player => {
                const payout = calculatePlayerPayout(player, payPerHit);
                return { ...player, ...payout };
            }).filter(player => player.totalPayout > 0);
            
            if (playersWithPayouts.length === 0) {
                alert('No players have payouts to open links for.');
                return;
            }
            
            // Disable button during opening process
            openAllBtn.disabled = true;
            openAllBtn.textContent = `Opening ${playersWithPayouts.length} links...`;
            
            try {
                for (let i = 0; i < playersWithPayouts.length; i++) {
                    const player = playersWithPayouts[i];
                    const payLink = `https://www.torn.com/factions.php?step=your#/tab=controls&option=give-to-user&addMoneyTo=${player.id}&money=${player.totalPayout}`;
                    
                    // Update button text to show progress
                    openAllBtn.textContent = `Opening ${i + 1}/${playersWithPayouts.length}: ${player.name}`;
                    
                    // Open the link in background without focusing on it
                    const newWindow = window.open(payLink, '_blank');
                    if (newWindow) {
                        // Immediately blur the new window to keep focus on current tab
                        newWindow.blur();
                        // Focus back on the current window
                        window.focus();
                    }
                    
                    // Wait 500ms before opening the next link (allows browser to process)
                    if (i < playersWithPayouts.length - 1) {
                        await sleep(500);
                    }
                }
                
                // Show completion message
                openAllBtn.textContent = `Opened ${playersWithPayouts.length} links!`;
                setTimeout(() => {
                    openAllBtn.textContent = 'Open All Links';
                    openAllBtn.disabled = false;
                }, 2000);
                
            } catch (error) {
                console.error('Error opening pay links:', error);
                openAllBtn.textContent = 'Error opening links';
                setTimeout(() => {
                    openAllBtn.textContent = 'Open All Links';
                    openAllBtn.disabled = false;
                }, 2000);
            }
        };
    }

    // Update summary header with war name
    const payoutSummaryHeader = document.querySelector('#payout-tab .summary-header');
    if (payoutSummaryHeader && warInfo) {
        let enemyName = 'Enemy Faction';
        if (warInfo.factions && Array.isArray(warInfo.factions)) {
            // Use factionId from input to determine enemy
            const factionIdInput = document.getElementById('factionId');
            const factionId = factionIdInput ? factionIdInput.value.trim() : '';
            const enemy = warInfo.factions.find(f => String(f.id) !== String(factionId));
            if (enemy && enemy.name) enemyName = enemy.name;
        } else if (warInfo.factions && warInfo.factions.enemy) {
            enemyName = warInfo.factions.enemy;
        }
        // Format dates
        let dateRange = '';
        if (warInfo.start && warInfo.end) {
            const startDate = new Date(warInfo.start * 1000);
            const endDate = new Date(warInfo.end * 1000);
            dateRange = ` (${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()})`;
        }
        payoutSummaryHeader.innerHTML = `<strong>War Payout Summary vs ${enemyName}${dateRange}</strong>`;
    }

    // After rendering the table, attach event listener to combinedMin input
    setTimeout(() => {
        const combinedMinInput = document.getElementById('combinedMin');
        if (combinedMinInput) {
            combinedMinInput.addEventListener('input', (e) => {
                console.log('[DEBUG] [renderPayoutTable] Combined Min changed to:', e.target.value);
                renderPayoutTable();
            });
            console.log('[DEBUG] [renderPayoutTable] Attached input listener to combinedMin input');
        } else {
            console.log('[DEBUG] [renderPayoutTable] combinedMin input not found!');
        }
    }, 0);
}

// --- Patch exportPayoutToCSV to match new columns ---
function exportPayoutToCSV() {
    const playerStats = warReportData.playerStats;
    if (!playerStats || Object.keys(playerStats).length === 0) {
        alert('No payout data to export. Please fetch war data first.');
        return;
    }
    // Get payout settings
    const cacheSalesInput = document.getElementById('cacheSales');
    const payPerHitInput = document.getElementById('payPerHit');
    const payPerHit = parseInt(payPerHitInput?.dataset.raw || payPerHitInput?.value.replace(/[^\d]/g, '') || '1000000');
    const headers = [
        'Member',
        'Level',
        'War Hits',
        'Retaliations',
        'Assists',
        'Overseas',
        'Other Attacks',
        'Total Payout',
        'Pay link'
    ];
    let csvContent = headers.join(',') + '\r\n';
    // Calculate payouts and sort by total payout
    const playersWithPayouts = Object.values(playerStats).map(player => {
        const payout = calculatePlayerPayout(player, payPerHit);
        return { ...player, ...payout };
    }).sort((a, b) => b.totalPayout - a.totalPayout);
    playersWithPayouts.forEach(player => {
        const otherAttacks = (player.totalAttacks || 0) - (player.warHits || 0) - (player.warAssists || 0);
        const payLink = `https://www.torn.com/factions.php?step=your#/tab=controls&option=give-to-user&addMoneyTo=${player.id}&money=${player.totalPayout}`;
        const row = [
            '"' + ((player.name && typeof player.name === 'string' && player.name.trim().length > 0) ? player.name : 'Unknown') + '"',
            player.level !== undefined && player.level !== null && player.level !== '' ? player.level : 'Unknown',
            player.warHits || 0,
            player.warRetals || 0,
            player.warAssists || 0,
            player.overseasHits || 0,
            otherAttacks,
            player.totalPayout,
            payLink
        ];
        csvContent += row.join(',') + '\r\n';
    });
    const encodedUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'war_payout_report.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// --- Loading Dots Animation ---
let loadingDotsInterval = null;
function startLoadingDots() {
    const loadingText = document.getElementById('loadingWarData');
    const dotsSpan = loadingText ? loadingText.querySelector('.loading-dots') : null;
    if (!loadingText || !dotsSpan) return;
    let count = 0;
    if (loadingDotsInterval) clearInterval(loadingDotsInterval);
    loadingDotsInterval = setInterval(() => {
        count = (count + 1) % 4;
        dotsSpan.textContent = '.'.repeat(count);
    }, 400);
    loadingText.style.display = '';
}
function stopLoadingDots() {
    if (loadingDotsInterval) clearInterval(loadingDotsInterval);
    loadingDotsInterval = null;
    const loadingText = document.getElementById('loadingWarData');
    const dotsSpan = loadingText ? loadingText.querySelector('.loading-dots') : null;
    if (dotsSpan) dotsSpan.textContent = '';
    if (loadingText) loadingText.style.display = 'none';
}

// Auto-initialize when script loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWarReport2);
} else {
    initWarReport2();
}

document.addEventListener('DOMContentLoaded', function() {
    [
        'otherConsumables',
        'otherSpies',
        'otherBounties',
        'otherTerms',
        'otherOther'
    ].forEach(id => {
        const input = document.getElementById(id);
        if (input) addThousandSeparatorInput(input);
    });
});

window.initWarReport2 = initWarReport2; 