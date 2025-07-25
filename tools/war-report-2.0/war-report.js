console.log('[WAR REPORT 2.0] war-report.js LOADED');
// War Report 2.0 - Full Version
console.log('[WAR REPORT 2.0] Script loaded');

// Helper to sleep for ms milliseconds
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to calculate base respect from attack data
function calculateBaseRespect(attack, removeModifiers = false) {
    const totalRespect = attack.respect_gain || 0;
    const groupBonus = attack.modifiers?.group || 0;
    const chainBonus = attack.modifiers?.chain || 0;
    
    // Check if this is a chain attack (respect_gain is 10, 20, 40, 80, 160, etc.)
    // Chain attacks follow the pattern: 10 * 2^n where n >= 0
    const chainValues = [10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120];
    if (chainValues.includes(totalRespect)) {
        return 10; // Chain attacks are worth exactly 10 base respect points
    }
    
    // For non-chain attacks, calculate base respect
    let baseRespect = totalRespect;
    
    if (removeModifiers) {
        // Remove chain modifier (values between 1.1 and 3.0)
        if (chainBonus >= 1.1 && chainBonus <= 3.0) {
            baseRespect = baseRespect / chainBonus;
        }
        
        // Remove group modifier (values between 1.25 and 1.5)
        if (groupBonus >= 1.25 && groupBonus <= 1.5) {
            baseRespect = baseRespect / groupBonus;
        }
    } else {
        // Original logic: only remove group bonus
        if (groupBonus > 0) {
            baseRespect = baseRespect / groupBonus;
        }
    }
    
    // Return whole integer for base respect
    return Math.round(baseRespect);
}

// Global state for this module
let warReportData = {
    playerStats: {},
    warInfo: {},
    allAttacks: [],
    sortState: { column: 'warScore', direction: 'desc' },
    payoutSortState: { column: 'totalPayout', direction: 'desc' },
    respectPayoutSortState: { column: 'totalPayout', direction: 'desc' }
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

        // Debug: Log the exact timestamps we're using
        console.log(`🔍 [TIMESTAMP DEBUG] War start: ${warStartTime} (${new Date(warStartTime * 1000).toISOString()})`);
        console.log(`🔍 [TIMESTAMP DEBUG] War end: ${warEndTime} (${new Date(warEndTime * 1000).toISOString()})`);
        
        // Ensure war end time is after war start time
        if (warEndTime <= warStartTime) {
            console.log(`🔍 [TIMESTAMP DEBUG] War end time (${warEndTime}) is before or equal to start time (${warStartTime}), using current time`);
            const currentTime = Math.floor(Date.now() / 1000);
            console.log(`🔍 [TIMESTAMP DEBUG] Using current time: ${currentTime} (${new Date(currentTime * 1000).toISOString()})`);
        }
        
        // Debug: Log all wars to see if we have the right one
        console.log(`🔍 [WAR DEBUG] All wars found:`, rankedWarsArray.map(w => ({
            id: w.id,
            start: w.start,
            start_readable: new Date(w.start * 1000).toISOString(),
            end: w.end,
            end_readable: w.end ? new Date(w.end * 1000).toISOString() : 'ongoing',
            opponent: w.opponent
        })));

        // Step 2: Fetch faction attacks during the war period
        console.log('[WAR REPORT 2.0] Fetching faction attacks during war period...');
        let allAttacks = [];
        
        // Ensure we have a valid end time that's after the start time
        let batchTo = warEndTime;
        if (warEndTime <= warStartTime) {
            batchTo = Math.floor(Date.now() / 1000);
        }
        
        // Add 1-hour buffer to start time to catch attacks initiated just before war start
        let batchFrom = warStartTime - 3600;
        console.log(`🔍 [TIMESTAMP DEBUG] Fetching attacks from: ${batchFrom} (${new Date(batchFrom * 1000).toISOString()}) to: ${batchTo} (${new Date(batchTo * 1000).toISOString()})`);
        
        // Debug: Log the raw API response structure
        console.log(`🔍 [API DEBUG] Faction ID being used: ${factionId}`);
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
            
            // Debug: Log the first attack structure
            if (batchCount === 0 && attacks.length > 0) {
                console.log('🔍 [API DEBUG] First attack from faction attacks API:', attacks[0]);
                console.log('🔍 [API DEBUG] Attack keys:', Object.keys(attacks[0]));
            }
            
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

        console.log(`[WAR REPORT 2.0] Processing ${allAttacks.length} attacks for faction ${factionIdStr}`);
        console.log(`[DEBUG TEST] Debug logging is working`);
        
        allAttacks.forEach((attack) => {
            // Only include attacks where the attacker is in the user's faction
            if (!attack.attacker || !attack.attacker.faction || String(attack.attacker.faction.id) !== factionIdStr) {
                // Debug: Log attacks that are being filtered out
                if (attack.attacker && ['Jimidy', 'Plebian', 'kokokok', 'Joe21'].includes(attack.attacker.name)) {
                    console.log(`🔍 [FILTERED OUT] ${attack.attacker.name} attack filtered:`, {
                        attacker_faction: attack.attacker.faction?.id,
                        expected_faction: factionIdStr,
                        id: attack.id,
                        started: attack.started,
                        started_readable: attack.started ? new Date(attack.started * 1000).toISOString() : 'undefined'
                    });
                }
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
            
            // Debug: Log attacks that might be missing for specific players
            const playerName = attack.attacker.name;
            if (['Jimidy', 'Plebian', 'kokokok', 'Joe21'].includes(playerName)) {
                console.log(`🔍 [ATTACK DEBUG] ${playerName} attack:`, {
                    id: attack.id,
                    started: attack.started,
                    started_readable: attack.started ? new Date(attack.started * 1000).toISOString() : 'undefined',
                    is_ranked_war: attack.is_ranked_war,
                    is_interrupted: attack.is_interrupted,
                    result: attack.result,
                    respect_gain: attack.respect_gain,
                    modifiers_war: attack.modifiers?.war,
                    started: attack.started,
                    id: attack.id
                });
            }
            
            // Check for war hits using the original criteria
            const isWarHit = (
                !attack.is_interrupted && 
                (
                    attack.is_ranked_war === true || 
                    (attack.modifiers && attack.modifiers.war && attack.modifiers.war === 2)
                )
            );
            
            if (isWarHit) {
                playerStats[attackerId].warHits++;
                playerStats[attackerId].warScore += attack.respect_gain || 0;
                if (['Jimidy', 'Plebian', 'kokokok', 'Joe21'].includes(playerName)) {
                    console.log(`✅ [WAR HIT COUNTED] ${playerName} attack counted as war hit:`, {
                        id: attack.id,
                        is_ranked_war: attack.is_ranked_war,
                        modifiers_war: attack.modifiers?.war,
                        respect_gain: attack.respect_gain
                    });
                }
            } else if (['Jimidy', 'Plebian', 'kokokok', 'Joe21'].includes(playerName)) {
                // Log why this attack wasn't counted as a war hit
                console.log(`❌ [WAR HIT MISSED] ${playerName} attack NOT counted as war hit:`, {
                    id: attack.id,
                    is_ranked_war: attack.is_ranked_war,
                    is_interrupted: attack.is_interrupted,
                    modifiers_war: attack.modifiers?.war,
                    respect_gain: attack.respect_gain,
                    score: attack.score,
                    reason: attack.is_interrupted ? 'interrupted' : 'not_war_attack'
                });
            }
            
            // Overseas hits
            if (attack.modifiers.overseas && attack.modifiers.overseas > 1) {
                playerStats[attackerId].overseasHits++;
            }
            
            // Retaliations
            if (attack.modifiers.retaliation && attack.modifiers.retaliation === 1.5) {
                playerStats[attackerId].warRetals++;
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

            // Count assists (result === 'Assist' and modifiers.war)
            if (
                attack.modifiers &&
                attack.modifiers.war &&
                !attack.is_interrupted &&
                attack.result &&
                attack.result.toLowerCase() === "assist"
            ) {
                playerStats[attackerId].warAssists++;
            }


        });

        // Debug: Overall attack counting
        const totalWarHits = Object.values(playerStats).reduce((sum, player) => sum + player.warHits, 0);
        const totalAttacks = allAttacks.length;
        const warHitsWithModifiers = allAttacks.filter(attack => 
            attack.modifiers && attack.modifiers.war && attack.modifiers.war > 0
        ).length;
        const rankedWarHits = allAttacks.filter(attack => attack.is_ranked_war === true).length;
        
        console.log(`🔍 [OVERALL STATS] Total attacks: ${totalAttacks}, War hits counted: ${totalWarHits}, Attacks with war modifiers: ${warHitsWithModifiers}, Ranked war hits: ${rankedWarHits}`);

        // Calculate averages
        Object.values(playerStats).forEach(player => {
            player.avgFairFight = player.totalAttacks > 0 ? player.totalFairFight / player.totalAttacks : 0;
            player.avgDefLevel = player.successfulAttacks > 0 ? player.totalDefeatedLevel / player.successfulAttacks : 0;
        });

        // Debug: Log final counts for specific players
        ['Jimidy', 'Plebian', 'kokokok', 'Joe21'].forEach(name => {
            const player = Object.values(playerStats).find(p => p.name === name);
            if (player) {
                console.log(`🔍 [FINAL COUNTS] ${name}:`, {
                    totalAttacks: player.totalAttacks,
                    warHits: player.warHits,
                    warAssists: player.warAssists,
                    warRetals: player.warRetals
                });
                
                // Count attacks manually for verification
                const playerAttacks = allAttacks.filter(attack => {
                    const attackerName = attack.attacker?.name || attack.attacker_name;
                    return attackerName === name;
                });
                
                const warHitsManual = playerAttacks.filter(attack => {
                    const isWarHit = !attack.is_interrupted && 
                        (
                            attack.is_ranked_war === true || 
                            (attack.modifiers && attack.modifiers.war && attack.modifiers.war === 2)
                        );
                    return isWarHit;
                });
                
                console.log(`🔍 [MANUAL VERIFICATION] ${name}:`, {
                    totalAttacksFound: playerAttacks.length,
                    warHitsFound: warHitsManual.length,
                    attackIds: playerAttacks.map(a => a.id).slice(0, 10) // First 10 IDs for reference
                });
                
                // Special detailed logging for kokokok
                if (name === 'kokokok') {
                    console.log(`🔍 [KOKOKOK DETAILED ANALYSIS] Total attacks found: ${playerAttacks.length}`);
                    
                    // Log the first attack's raw structure to understand the data format
                    if (playerAttacks.length > 0) {
                        console.log(`🔍 [KOKOKOK RAW DATA SAMPLE] First attack raw structure:`, playerAttacks[0]);
                        console.log(`🔍 [KOKOKOK RAW DATA SAMPLE] All available keys:`, Object.keys(playerAttacks[0]));
                    } else {
                        console.log(`🔍 [KOKOKOK RAW DATA SAMPLE] No attacks found for kokokok!`);
                    }
                    
                    // Log ALL of kokokok's attacks with full details
                    playerAttacks.forEach((attack, index) => {
                        const isWarHit = !attack.is_interrupted && 
                            (
                                attack.is_ranked_war === true || 
                                (attack.modifiers && attack.modifiers.war && attack.modifiers.war === 2)
                            );
                        
                        console.log(`🔍 [KOKOKOK ATTACK ${index + 1}] ID: ${attack.id}, War Hit: ${isWarHit}, Defender: ${attack.defender?.name || attack.defender_name}, Details:`, {
                            id: attack.id,
                            started: attack.started,
                            started_readable: attack.started ? new Date(attack.started * 1000).toISOString() : 'undefined',
                            defender: attack.defender?.name || attack.defender_name,
                            is_ranked_war: attack.is_ranked_war,
                            is_interrupted: attack.is_interrupted,
                            modifiers_war: attack.modifiers?.war,
                            respect_gain: attack.respect_gain,
                            score: attack.score,
                            result: attack.result
                        });
                    });
                    
                    // Count by different criteria
                    const rankedWarHits = playerAttacks.filter(a => a.is_ranked_war === true).length;
                    const warModifier2Hits = playerAttacks.filter(a => a.modifiers?.war === 2).length;
                    const warModifier1Hits = playerAttacks.filter(a => a.modifiers?.war === 1).length;
                    const interruptedHits = playerAttacks.filter(a => a.is_interrupted).length;
                    const nonInterruptedHits = playerAttacks.filter(a => !a.is_interrupted).length;
                    
                    console.log(`🔍 [KOKOKOK BREAKDOWN] Ranked war: ${rankedWarHits}, War mod 2: ${warModifier2Hits}, War mod 1: ${warModifier1Hits}, Interrupted: ${interruptedHits}, Non-interrupted: ${nonInterruptedHits}`);
                }
            }
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
                            <td><a class="player-link" href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank">${player.name}</a></td>
                            <td>${player.level}</td>
                            <td>${Math.round(player.warScore || 0)}</td>
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
                    <td><strong>${Math.round(sorted.reduce((sum, p) => sum + (p.warScore || 0), 0))}</strong></td>
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
        return;
    }
    input.addEventListener('input', function(e) {
        let raw = input.value.replace(/[^\d]/g, '');
        if (raw === '') raw = '0';
        input.value = Number(raw).toLocaleString();
        input.dataset.raw = raw;
    });
    input.addEventListener('blur', function(e) {
        let raw = input.value.replace(/[^\d]/g, '');
        if (raw === '') raw = '0';
        input.value = Number(raw).toLocaleString();
        input.dataset.raw = raw;
    });
    // Initialize
    let raw = input.value.replace(/[^\d]/g, '');
    if (raw === '') raw = '0';
    input.value = Number(raw).toLocaleString();
    input.dataset.raw = raw;
}

// --- Patch initializeTabs to add input formatting ---
function initializeTabs() {
    if (tabsInitialized) {
        console.log('[WAR REPORT 2.0] Tab event listener already attached.');
        return;
    }
    
    const tabButtons = document.querySelectorAll('[data-tab]');
    const tabPanes = document.querySelectorAll('.tab-pane');
    
    if (tabButtons.length === 0 || tabPanes.length === 0) {
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
                // If switching to respect payout tab and we have data, render respect payout table
                else if (tabId === 'respect-payout-tab' && warReportData.playerStats && Object.keys(warReportData.playerStats).length > 0) {
                    console.log('[WAR REPORT 2.0] Rendering respect payout table...');
                    renderRespectPayoutTable();
                } else if (tabId === 'respect-payout-tab') {
                    console.log('[WAR REPORT 2.0] No player stats available for respect payout table');
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
                addThousandSeparatorInput(input);
                input.addEventListener('input', updatePayoutTable);
                input.addEventListener('blur', () => {
                    addThousandSeparatorInput(input); // re-apply formatting on blur
                });
            }
        });
        cacheSalesInput.addEventListener('input', updatePayoutTable);
        payPerHitInput.addEventListener('input', updatePayoutTable);
        
        // Add event listeners for combined minimum settings
        const enableCombinedMinCheckbox = document.getElementById('enableCombinedMin');
        const combinedMinInput = document.getElementById('combinedMin');
        
        if (enableCombinedMinCheckbox) {
            enableCombinedMinCheckbox.addEventListener('change', updatePayoutTable);
        }
        
        if (combinedMinInput) {
            combinedMinInput.addEventListener('input', (e) => {
                updatePayoutTable();
            });
        }
        
        // Add event listeners for Advanced Payout Options checkboxes and multipliers
        const advancedPayoutOptions = [
            { checkboxId: 'payAssists', multiplierId: 'assistMultiplier' },
            { checkboxId: 'payRetals', multiplierId: 'retalMultiplier' },
            { checkboxId: 'payOverseas', multiplierId: 'overseasMultiplier' },
            { checkboxId: 'payOtherAttacks', multiplierId: 'otherAttacksMultiplier' }
        ];
        
        advancedPayoutOptions.forEach(option => {
            const checkbox = document.getElementById(option.checkboxId);
            const multiplier = document.getElementById(option.multiplierId);
            
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    updatePayoutTable();
                });
            }
            
            if (multiplier) {
                multiplier.addEventListener('input', (e) => {
                    updatePayoutTable();
                });
            }
        });

        // Initialize respect payout input listeners and formatting
        const respectCacheSalesInput = document.getElementById('respectCacheSales');
        const respectPayPerHitInput = document.getElementById('respectPayPerHit');
        
        if (respectCacheSalesInput && respectPayPerHitInput) {
            console.log('[WAR REPORT 2.0] Adding respect payout input listeners');
            addThousandSeparatorInput(respectCacheSalesInput);
            // respectPayPerHitInput is readonly, so no need to add formatting
            
            // Define updateRespectPayoutTable before using it
            const updateRespectPayoutTable = () => {
                if (warReportData.playerStats && Object.keys(warReportData.playerStats).length > 0) {
                    console.log('[WAR REPORT 2.0] Updating respect payout table due to input change');
                    renderRespectPayoutTable();
                }
            };
            
            // Apply to Respect Other Costs boxes as well
            const respectOtherCostsInputs = [
                document.getElementById('respectOtherConsumables'),
                document.getElementById('respectOtherSpies'),
                document.getElementById('respectOtherBounties'),
                document.getElementById('respectOtherTerms'),
                document.getElementById('respectOtherOther')
            ];
            respectOtherCostsInputs.forEach(input => {
                if (input) {
                    addThousandSeparatorInput(input);
                    input.addEventListener('input', updateRespectPayoutTable);
                    input.addEventListener('blur', () => {
                        addThousandSeparatorInput(input); // re-apply formatting on blur
                    });
                }
            });
            respectCacheSalesInput.addEventListener('input', updateRespectPayoutTable);
            
            // Add event listeners for respect combined minimum settings
            const respectEnableCombinedMinCheckbox = document.getElementById('respectEnableCombinedMin');
            const respectCombinedMinInput = document.getElementById('respectCombinedMin');
            
            if (respectEnableCombinedMinCheckbox) {
                respectEnableCombinedMinCheckbox.addEventListener('change', updateRespectPayoutTable);
            }
            
            if (respectCombinedMinInput) {
                respectCombinedMinInput.addEventListener('input', (e) => {
                    updateRespectPayoutTable();
                });
            }
            
            // Add event listeners for Respect Advanced Payout Options checkboxes and multipliers
            const respectAdvancedPayoutOptions = [
                { checkboxId: 'respectPayAssists', multiplierId: 'respectAssistMultiplier' },
                { checkboxId: 'respectPayRetals', multiplierId: 'respectRetalMultiplier' },
                { checkboxId: 'respectPayOverseas', multiplierId: 'respectOverseasMultiplier' },
                { checkboxId: 'respectPayOtherAttacks', multiplierId: 'respectOtherAttacksMultiplier' }
            ];
            
            respectAdvancedPayoutOptions.forEach(option => {
                const checkbox = document.getElementById(option.checkboxId);
                const multiplier = document.getElementById(option.multiplierId);
                
                if (checkbox) {
                    checkbox.addEventListener('change', (e) => {
                        updateRespectPayoutTable();
                    });
                }
                
                if (multiplier) {
                    multiplier.addEventListener('input', (e) => {
                        updateRespectPayoutTable();
                    });
                }
            });
            
            // Add event listener for remaining percentage input (only once)
            const remainingPercentageInput = document.getElementById('respectRemainingPercentage');
            if (remainingPercentageInput && !remainingPercentageInput.hasAttribute('data-listener-added')) {
                remainingPercentageInput.addEventListener('input', function() {
                    // Trigger recalculation when percentage changes
                    renderRespectPayoutTable();
                });
                remainingPercentageInput.setAttribute('data-listener-added', 'true');
            }
            
            // Add event listener for remove modifiers checkbox (only once)
            const removeModifiersCheckbox = document.getElementById('respectRemoveModifiers');
            if (removeModifiersCheckbox && !removeModifiersCheckbox.hasAttribute('data-listener-added')) {
                removeModifiersCheckbox.addEventListener('change', function() {
                    // Trigger recalculation when checkbox changes
                    renderRespectPayoutTable();
                });
                removeModifiersCheckbox.setAttribute('data-listener-added', 'true');
            }
        }
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


    const playersWithPayouts = Object.values(playerStats).map(player => {
        let warHitPayout = (player.warHits || 0) * payPerHit;
        let retalPayout = payRetals ? (player.warRetals || 0) * payPerHit * retalMultiplier : 0;
        let assistPayout = payAssists ? (player.warAssists || 0) * payPerHit * assistMultiplier : 0;
        let overseasPayout = payOverseas ? (player.overseasHits || 0) * payPerHit * overseasMultiplier : 0;
        let otherAttacksPayout = payOtherAttacks ? ((player.totalAttacks - (player.warHits || 0) - (player.warAssists || 0)) * payPerHit * otherAttacksMultiplier) : 0;

        const combinedCount = (player.warHits || 0) + (player.warAssists || 0);
        if (enableCombinedMin && combinedCount < combinedMin) {
            warHitPayout = 0;
            assistPayout = 0;
            retalPayout = 0;
            overseasPayout = 0;
            otherAttacksPayout = 0;
        }
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
                            <td><a class="player-link" href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank">${player.name}</a></td>
                            <td>${player.level}</td>
                            <td>${player.warHits || 0}</td>
                            <td>${player.warRetals || 0}</td>
                            <td>${player.warAssists || 0}</td>
                            <td>${player.overseasHits || 0}</td>
                            <td>${otherAttacks}</td>
                            <td><strong>$${Math.round(player.totalPayout).toLocaleString()}</strong></td>
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
                renderPayoutTable();
            });
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

// --- Respect Based Payout Table Rendering ---
function renderRespectPayoutTable() {
    console.log('🔍 === RESPECT PAYOUT FUNCTION CALLED ===');
    const playerStats = warReportData.playerStats;
    const warInfo = warReportData.warInfo;
    const allAttacks = warReportData.allAttacks;
    if (!playerStats || Object.keys(playerStats).length === 0) {
        console.log('[WAR REPORT 2.0] No player stats available for respect payout table');
        return;
    }
    
    console.log('[RESPECT DEBUG] Starting renderRespectPayoutTable');
    console.log('[RESPECT DEBUG] allAttacks length:', allAttacks.length);
    
    // Get respect payout settings (use raw value for calculations)
    const respectCacheSalesInput = document.getElementById('respectCacheSales');
    const respectPayPerHitInput = document.getElementById('respectPayPerHit');
    const cacheSales = parseInt(respectCacheSalesInput?.dataset.raw || respectCacheSalesInput?.value.replace(/[^\d]/g, '') || '1000000000');
    
    // Get advanced options early
    const removeModifiers = document.getElementById('respectRemoveModifiers')?.checked;
    
    // OPTIMIZATION: Process all attacks ONCE and cache player respect data
    const factionId = parseInt(document.getElementById('factionId').value);
    const playerRespectData = {};
    let totalBaseRespect = 0;
    let totalWarHits = 0;
    
    // Initialize player respect data
    Object.keys(playerStats).forEach(playerId => {
        playerRespectData[playerId] = {
            baseRespect: 0,
            warHits: 0
        };
    });
    
    // Process all attacks once to calculate both total and per-player respect
    console.log('[RESPECT DEBUG] Processing attacks for respect calculation...');
    allAttacks.forEach((attack, index) => {
        const attackerFactionId = attack.attacker?.faction?.id;
        const defenderFactionId = attack.defender?.faction?.id;
        const isAttackerFaction = attackerFactionId === factionId;
        const isNotDefenderFaction = defenderFactionId !== factionId;
        
        if (isAttackerFaction && isNotDefenderFaction) {
            totalWarHits++;
            const baseRespect = calculateBaseRespect(attack, removeModifiers);
            totalBaseRespect += baseRespect;
            
            // Add to player's respect data
            const attackerId = String(attack.attacker?.id);
            if (playerRespectData[attackerId]) {
                playerRespectData[attackerId].baseRespect += baseRespect;
                playerRespectData[attackerId].warHits++;
            }
            
            // Debug logging for first 5 attacks
            if (totalWarHits <= 5) {
                console.log('[RESPECT DEBUG] Processing war hit:', {
                    respect_gain: attack.respect_gain,
                    modifiers: attack.modifiers,
                    baseRespect: baseRespect,
                    attacker: attack.attacker?.name
                });
            }
        }
    });
    console.log('[RESPECT DEBUG] Total war hits found:', totalWarHits);
    console.log('[RESPECT DEBUG] Total base respect calculated:', totalBaseRespect);
    
    // Get Other Costs (calculate this before pay per hit calculation)
    const otherCosts = [
        { label: 'Consumables', id: 'respectOtherConsumables' },
        { label: 'Spies', id: 'respectOtherSpies' },
        { label: 'Bounties', id: 'respectOtherBounties' },
        { label: 'Terms', id: 'respectOtherTerms' },
        { label: 'Other', id: 'respectOtherOther' }
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
    
    // Auto-calculate pay per hit: (Cache Sales - All Other Costs - Remaining) / Total War Hits
    const remainingPercentageSlider = document.getElementById('respectRemainingPercentage');
    const remainingPercentage = remainingPercentageSlider ? parseFloat(remainingPercentageSlider.value) / 100 : 0.3;
    const remaining = cacheSales * remainingPercentage;
    const availablePayout = cacheSales - remaining - totalCosts;
    const payPerHit = totalWarHits > 0 ? availablePayout / totalWarHits : 0;
    
    // Update the readonly input field
    if (respectPayPerHitInput) {
        respectPayPerHitInput.value = payPerHit.toLocaleString();
        respectPayPerHitInput.dataset.raw = payPerHit.toString();
    }

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

    // Advanced payout options
    const payAssists = document.getElementById('respectPayAssists')?.checked;
    const assistMultiplier = parseFloat(document.getElementById('respectAssistMultiplier')?.value || '0.25');
    const payRetals = document.getElementById('respectPayRetals')?.checked;
    const retalMultiplier = parseFloat(document.getElementById('respectRetalMultiplier')?.value || '0.5');
    const payOverseas = document.getElementById('respectPayOverseas')?.checked;
    const overseasMultiplier = parseFloat(document.getElementById('respectOverseasMultiplier')?.value || '0.25');
    const payOtherAttacks = document.getElementById('respectPayOtherAttacks')?.checked;
    const otherAttacksMultiplier = parseFloat(document.getElementById('respectOtherAttacksMultiplier')?.value || '0.1');
    const enableCombinedMin = document.getElementById('respectEnableCombinedMin')?.checked;
    const combinedMin = parseInt(document.getElementById('respectCombinedMin')?.value || '0');

    // Calculate respect-based payouts for each player
    const playersWithRespectPayouts = Object.values(playerStats).map(player => {
        // Use cached player respect data instead of processing all attacks again
        const playerIdStr = String(player.id);
        const playerData = playerRespectData[playerIdStr] || { baseRespect: 0, warHits: 0 };
        const playerBaseRespect = playerData.baseRespect;
        const playerWarHits = playerData.warHits;
        
        // Debug first few players
        if (player.name === 'iNico' || player.name === 'Jimidy' || player.name === 'Joe21') {
            console.log('[RESPECT DEBUG] Player calculation:', {
                name: player.name,
                id: player.id,
                playerWarHits: playerWarHits,
                playerBaseRespect: playerBaseRespect
            });
        }
        
        // Calculate additional payouts first (retaliations, assists, overseas, other attacks)
        let retalPayout = payRetals ? (player.warRetals || 0) * payPerHit * retalMultiplier : 0;
        let assistPayout = payAssists ? (player.warAssists || 0) * payPerHit * assistMultiplier : 0;
        let overseasPayout = payOverseas ? (player.overseasHits || 0) * payPerHit * overseasMultiplier : 0;
        let otherAttacksPayout = payOtherAttacks ? ((player.totalAttacks - (player.warHits || 0) - (player.warAssists || 0)) * payPerHit * otherAttacksMultiplier) : 0;

        // Check combined minimum requirement
        const combinedCount = (player.warHits || 0) + (player.warAssists || 0);
        if (enableCombinedMin && combinedCount < combinedMin) {
            retalPayout = 0;
            assistPayout = 0;
            overseasPayout = 0;
            otherAttacksPayout = 0;
        }
        
        // Calculate respect ratio for this player
        const respectRatio = totalBaseRespect > 0 ? playerBaseRespect / totalBaseRespect : 0;
        
        // Initialize war hit payout (will be calculated in next step)
        let warHitPayout = 0;
        
        return {
            ...player,
            playerBaseRespect,
            respectRatio: respectRatio.toFixed(4),
            warHitPayout,
            retalPayout,
            assistPayout,
            overseasPayout,
            otherAttacksPayout,
            totalPayout: warHitPayout + retalPayout + assistPayout + overseasPayout + otherAttacksPayout
        };
    });

    // Calculate total additional payouts (retals, assists, overseas, other attacks)
    const totalAdditionalPayouts = playersWithRespectPayouts.reduce((sum, p) => 
        sum + p.retalPayout + p.assistPayout + p.overseasPayout + p.otherAttacksPayout, 0);
    
    // Calculate remaining money for respect-based distribution
    const respectDistributionPool = availablePayout - totalAdditionalPayouts;
    
    // Filter players who qualify for respect-based distribution (meet combined minimum)
    const qualifyingPlayers = playersWithRespectPayouts.filter(player => {
        if (enableCombinedMin) {
            const combinedCount = (player.warHits || 0) + (player.warAssists || 0);
            return combinedCount >= combinedMin;
        }
        return true; // If no combined minimum, all players qualify
    });
    
    // Calculate total respect of qualifying players
    const totalQualifyingRespect = qualifyingPlayers.reduce((sum, p) => sum + p.playerBaseRespect, 0);
    
    // Distribute remaining money proportionally based on respect
    qualifyingPlayers.forEach(player => {
        if (totalQualifyingRespect > 0) {
            const respectShare = player.playerBaseRespect / totalQualifyingRespect;
            player.warHitPayout = respectShare * respectDistributionPool;
        } else {
            player.warHitPayout = 0;
        }
        
        // Update total payout
        player.totalPayout = player.warHitPayout + player.retalPayout + player.assistPayout + player.overseasPayout + player.otherAttacksPayout;
    });
    
    // Calculate final total payout
    let totalPayout = playersWithRespectPayouts.reduce((sum, p) => sum + p.totalPayout, 0);
    
    // Sort by respect payout sort state (AFTER all calculations are complete)
    const { column: sortColumn, direction: sortDirection } = warReportData.respectPayoutSortState;
    playersWithRespectPayouts.sort((a, b) => {
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
    
    // Use the same remaining calculation for summary
    const remainingPercentageSlider2 = document.getElementById('respectRemainingPercentage');
    const remainingPercentage2 = remainingPercentageSlider2 ? parseFloat(remainingPercentageSlider2.value) / 100 : 0.3;
    const remaining2 = cacheSales * remainingPercentage2;
    const remainingPercent = cacheSales !== 0 ? ((remaining2 / cacheSales) * 100).toFixed(2) : '0.00';
    
    const respectPayoutTableDiv = document.getElementById('respectPayoutTable');
    if (!respectPayoutTableDiv) return;
    
    const tableHtml = `
        <div class="summary-box" style="margin-bottom: 20px;">
            <h3><strong>Respect Based War Payout Summary</strong>${warName ? ' <span style=\"font-weight:normal;color:#ccc;font-size:0.95em;\">' + warName + '</span>' : ''}</h3>
            <p><strong>Cache Sales:</strong> $${cacheSales.toLocaleString()}</p>
            <p><strong>Total Costs:</strong> $${totalCosts.toLocaleString()}</p>
            <p><strong>Total Base Respect:</strong> ${totalBaseRespect.toLocaleString()}</p>
            <p><strong>Total War Hits:</strong> ${totalWarHits.toLocaleString()}</p>
            <p><strong>Pay Per Hit (Auto-calculated):</strong> $${Math.round(payPerHit).toLocaleString()}</p>
            <p><strong>Total Payout:</strong> $${totalPayout.toLocaleString()}</p>
            <p><strong>Remaining:</strong> $${remaining2.toLocaleString()} <span style=\"color:#ffd700;font-weight:normal;\">(${remainingPercent}% of cache sales)</span></p>
            <button id="exportRespectPayoutCSV" class="btn btn-secondary">Export to CSV</button>
        </div>
        <div class="table-container">
        <div class="table-header" style="display: flex; align-items: flex-end; justify-content: space-between;">
            <h3>Payout Table (respect based)</h3>
            <button id="openAllRespectPayLinks" class="btn btn-primary" style="margin-bottom: 4px;">Open All Links</button>
        </div>
        <div style="margin-bottom: 10px; font-size: 12px; color: #666; font-style: italic;">
            💡 <strong>Note:</strong> If links don't open, please allow popups for this site in your browser settings.
        </div>
        <table id="respectPayoutTable" style="width:100%;border-collapse:collapse;margin-top:20px;">
            <thead>
                <tr>
                    <th data-column="name" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Member <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'name' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="level" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Level <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'level' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warHits" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">War Hits <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'warHits' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="playerBaseRespect" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Base Respect <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'playerBaseRespect' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="respectRatio" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Respect % <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'respectRatio' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warRetals" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Retaliations <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'warRetals' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warAssists" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Assists <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'warAssists' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="overseasHits" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Overseas <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'overseasHits' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="otherAttacks" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Other Attacks <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'otherAttacks' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="totalPayout" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>Total Payout</strong> <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'totalPayout' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th style="background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Pay link</th>
                </tr>
            </thead>
            <tbody>
                ${playersWithRespectPayouts.map(player => {
                    const otherAttacks = (player.totalAttacks || 0) - (player.warHits || 0) - (player.warAssists || 0);
                    const payLink = `https://www.torn.com/factions.php?step=your#/tab=controls&option=give-to-user&addMoneyTo=${player.id}&money=${player.totalPayout}`;
                    return `
                        <tr>
                            <td style="padding: 10px; text-align: left; border-bottom: 1px solid #404040;"><a class="player-link" href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank">${player.name}</a></td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${player.level}</td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${player.warHits || 0}</td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${player.playerBaseRespect}</td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${(parseFloat(player.respectRatio) * 100).toFixed(2)}%</td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${player.warRetals || 0}</td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${player.warAssists || 0}</td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${player.overseasHits || 0}</td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${otherAttacks}</td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>$${Math.round(player.totalPayout).toLocaleString()}</strong></td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${player.totalPayout > 0 ? `<a href="${payLink}" target="_blank" rel="noopener noreferrer" title="Pay in Torn">💰</a>` : ''}</td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
            <tfoot>
                <tr class="totals-row" style="background-color: #1a1a1a;">
                    <td style="padding: 10px; text-align: left; border-bottom: 1px solid #404040;"><strong>TOTALS</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>${totalWarHits}</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>${totalBaseRespect}</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>100.00%</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>${playersWithRespectPayouts.reduce((sum, p) => sum + (p.warRetals || 0), 0)}</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>${playersWithRespectPayouts.reduce((sum, p) => sum + (p.warAssists || 0), 0)}</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>${playersWithRespectPayouts.reduce((sum, p) => sum + (p.overseasHits || 0), 0)}</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>${playersWithRespectPayouts.reduce((sum, p) => sum + ((p.totalAttacks || 0) - (p.warHits || 0) - (p.warAssists || 0)), 0)}</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>$${totalPayout.toLocaleString()}</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"></td>
                </tr>
            </tfoot>
        </table>
        </div>
    `;
    respectPayoutTableDiv.innerHTML = tableHtml;
    
    // Add click event listeners for respect payout table sorting
    const respectTable = document.getElementById('respectPayoutTable');
    console.log('[WAR REPORT 2.0] Respect payout table found:', !!respectTable);
    if (respectTable) {
        const headers = respectTable.querySelectorAll('th[data-column]');
        console.log('[WAR REPORT 2.0] Found respect payout table headers:', headers.length);
        headers.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.getAttribute('data-column');
                console.log('[WAR REPORT 2.0] Respect payout header clicked:', column);
                console.log('[WAR REPORT 2.0] Current respect payout sort state:', warReportData.respectPayoutSortState);
                
                if (warReportData.respectPayoutSortState.column === column) {
                    warReportData.respectPayoutSortState.direction = warReportData.respectPayoutSortState.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    warReportData.respectPayoutSortState.column = column;
                    warReportData.respectPayoutSortState.direction = column === 'name' ? 'asc' : 'desc';
                }
                
                console.log('[WAR REPORT 2.0] New respect payout sort state:', warReportData.respectPayoutSortState);
                renderRespectPayoutTable();
            });
        });
    }
    
    // Add click event listener for "Open All Respect Links" button
    const openAllRespectPayLinksBtn = document.getElementById('openAllRespectPayLinks');
    if (openAllRespectPayLinksBtn) {
        openAllRespectPayLinksBtn.addEventListener('click', () => {
            const payLinks = document.querySelectorAll('#respectPayoutTable a[href*="factions.php?step=your"]');
            if (payLinks.length === 0) {
                alert('No payment links found. Please ensure the respect payout table is loaded.');
                return;
            }
            
            // Check if popup blocker might be active
            const testWindow = window.open('', '_blank');
            if (!testWindow || testWindow.closed || typeof testWindow.closed === 'undefined') {
                alert('⚠️ Popup blocker detected! Please allow popups for this site to use "Open All Links".');
                return;
            }
            testWindow.close();
            
            // Open all payment links
            payLinks.forEach(link => {
                window.open(link.href, '_blank');
            });
            
            alert(`Opened ${payLinks.length} payment links in new tabs.`);
        });
    }
    
    // Add click event listener for respect export button
    const exportRespectPayoutBtn = document.getElementById('exportRespectPayoutCSV');
    if (exportRespectPayoutBtn) {
        exportRespectPayoutBtn.addEventListener('click', exportRespectPayoutToCSV);
    }
    
}

// --- Export Respect Payout to CSV ---
function exportRespectPayoutToCSV() {
    const playerStats = warReportData.playerStats;
    const allAttacks = warReportData.allAttacks;
    if (!playerStats || Object.keys(playerStats).length === 0) {
        alert('No respect payout data to export. Please fetch war data first.');
        return;
    }
    
    // Get respect payout settings
    const respectCacheSalesInput = document.getElementById('respectCacheSales');
    const cacheSales = parseInt(respectCacheSalesInput?.dataset.raw || respectCacheSalesInput?.value.replace(/[^\d]/g, '') || '1000000000');
    
    // Calculate total base respect for all war hits
    let totalBaseRespect = 0;
    let totalWarHits = 0;
    
    // Process all attacks to calculate base respect
    allAttacks.forEach(attack => {
        if (attack.attacker_faction === parseInt(document.getElementById('factionId').value) && 
            attack.defender_faction !== parseInt(document.getElementById('factionId').value)) {
            totalWarHits++;
            totalBaseRespect += calculateBaseRespect(attack);
        }
    });
    
    // Auto-calculate pay per hit
    const payPerHit = totalWarHits > 0 ? Math.round((cacheSales * 0.7) / totalWarHits) : 0;
    
    const headers = [
        'Member',
        'Level',
        'War Hits',
        'Base Respect',
        'Respect %',
        'Retaliations',
        'Assists',
        'Overseas',
        'Other Attacks',
        'Total Payout',
        'Pay link'
    ];
    let csvContent = headers.join(',') + '\r\n';
    
    // Calculate respect-based payouts and sort by total payout
    const playersWithRespectPayouts = Object.values(playerStats).map(player => {
        // Calculate base respect for this player's war hits
        let playerBaseRespect = 0;
        
        // Find all war hits for this player
        allAttacks.forEach(attack => {
            if (attack.attacker_id === player.id && 
                attack.attacker_faction === parseInt(document.getElementById('factionId').value) && 
                attack.defender_faction !== parseInt(document.getElementById('factionId').value)) {
                playerBaseRespect += calculateBaseRespect(attack);
            }
        });
        
        // Calculate proportional payout based on base respect ratio
        const respectRatio = totalBaseRespect > 0 ? playerBaseRespect / totalBaseRespect : 0;
        const remainingPercentageSlider = document.getElementById('respectRemainingPercentage');
        const remainingPercentage = remainingPercentageSlider ? parseFloat(remainingPercentageSlider.value) / 100 : 0.3;
        const remaining = cacheSales * remainingPercentage;
        const availablePayout = cacheSales - remaining - totalCosts;
        let warHitPayout = Math.round(respectRatio * availablePayout);
        
        // Calculate additional payouts using the same multipliers as hit-based
        const payRetals = document.getElementById('respectPayRetals')?.checked;
        const retalMultiplier = parseFloat(document.getElementById('respectRetalMultiplier')?.value || '0.5');
        const payAssists = document.getElementById('respectPayAssists')?.checked;
        const assistMultiplier = parseFloat(document.getElementById('respectAssistMultiplier')?.value || '0.25');
        const payOverseas = document.getElementById('respectPayOverseas')?.checked;
        const overseasMultiplier = parseFloat(document.getElementById('respectOverseasMultiplier')?.value || '0.25');
        const payOtherAttacks = document.getElementById('respectPayOtherAttacks')?.checked;
        const otherAttacksMultiplier = parseFloat(document.getElementById('respectOtherAttacksMultiplier')?.value || '0.1');
        
        let retalPayout = payRetals ? (player.warRetals || 0) * payPerHit * retalMultiplier : 0;
        let assistPayout = payAssists ? (player.warAssists || 0) * payPerHit * assistMultiplier : 0;
        let overseasPayout = payOverseas ? (player.overseasHits || 0) * payPerHit * overseasMultiplier : 0;
        let otherAttacksPayout = payOtherAttacks ? ((player.totalAttacks - (player.warHits || 0) - (player.warAssists || 0)) * payPerHit * otherAttacksMultiplier) : 0;
        
        const totalPayout = warHitPayout + retalPayout + assistPayout + overseasPayout + otherAttacksPayout;
        
        return {
            ...player,
            playerBaseRespect,
            respectRatio: respectRatio.toFixed(4),
            totalPayout
        };
    }).sort((a, b) => b.totalPayout - a.totalPayout);
    
    playersWithRespectPayouts.forEach(player => {
        const otherAttacks = (player.totalAttacks || 0) - (player.warHits || 0) - (player.warAssists || 0);
        const payLink = `https://www.torn.com/factions.php?step=your#/tab=controls&option=give-to-user&addMoneyTo=${player.id}&money=${player.totalPayout}`;
        const row = [
            '"' + ((player.name && typeof player.name === 'string' && player.name.trim().length > 0) ? player.name : 'Unknown') + '"',
            player.level !== undefined && player.level !== null && player.level !== '' ? player.level : 'Unknown',
            player.warHits || 0,
            player.playerBaseRespect,
            (parseFloat(player.respectRatio) * 100).toFixed(2) + '%',
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
    link.setAttribute('download', 'respect_based_war_payout_report.csv');
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
        'otherOther',
        'respectCacheSales',
        'respectOtherConsumables',
        'respectOtherSpies',
        'respectOtherBounties',
        'respectOtherTerms',
        'respectOtherOther'
    ].forEach(id => {
        const input = document.getElementById(id);
        if (input) addThousandSeparatorInput(input);
    });
});

window.initWarReport2 = initWarReport2; 