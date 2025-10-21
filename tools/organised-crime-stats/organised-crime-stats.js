console.log('[ORGANISED CRIME STATS] organised-crime-stats.js LOADED');

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
    }
};

function initOrganisedCrimeStats() {
    console.log('[ORGANISED CRIME STATS] initOrganisedCrimeStats CALLED');
    
    // Log tool usage
    if (window.logToolUsage) {
        window.logToolUsage('organised-crime-stats');
    }

    const fetchBtn = document.getElementById('fetchOCData');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', handleOCDataFetch);
    }

    const exportBtn = document.getElementById('exportStats');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportOCStatsToCSV);
    }
    
    // Add date filter handlers for both sections
    const difficultyDateFilter = document.getElementById('difficultyDateFilter');
    if (difficultyDateFilter) {
        difficultyDateFilter.addEventListener('change', () => handleDateFilterChange('difficulty'));
    }
    
    const playerDateFilter = document.getElementById('playerDateFilter');
    if (playerDateFilter) {
        playerDateFilter.addEventListener('change', () => handleDateFilterChange('player'));
    }
}

const handleOCDataFetch = async () => {
    const apiKey = localStorage.getItem('tornApiKey');
    if (!apiKey) {
        alert('Please enter your API key in the sidebar first');
        return;
    }
    
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
        if (progressContainer) progressContainer.style.display = 'block';

        console.log('Fetching organised crime data...');
        
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
            console.log(`Fetching page ${pageCount} from offset ${currentOffset}...`);
            
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.error) {
                throw new Error(`API error: ${data.error.error}`);
            }
            
            const crimes = data.crimes || [];
            console.log(`Page ${pageCount}: Found ${crimes.length} crimes`);
            
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
        
        console.log(`Total crimes fetched: ${allCrimes.length}`);
        
        if (progressMessage) progressMessage.textContent = 'Fetching current faction members...';
        if (progressDetails) progressDetails.textContent = 'Loading member list...';
        
        // Fetch current faction members using v2 API
        const membersResponse = await fetch(`https://api.torn.com/v2/faction/members?key=${apiKey}`);
        const membersData = await membersResponse.json();
        
        if (membersData.error) {
            throw new Error(`Could not fetch faction members: ${membersData.error.error}`);
        }
        
        // Build set of current member IDs and their names
        const currentMemberIds = new Set();
        const playerNames = {};
        const membersArray = membersData.members || [];
        
        console.log(`Found ${membersArray.length} current faction members`);
        membersArray.forEach(member => {
            currentMemberIds.add(member.id.toString());
            playerNames[member.id.toString()] = member.name;
        });
        
        if (progressMessage) progressMessage.textContent = 'Processing crime data...';
        if (progressDetails) progressDetails.textContent = 'Analyzing crimes (filtering by current members)...';
        
        // Process the data, filtering by current members only
        const { difficultyStats, playerStats } = processCrimeData(allCrimes, playerNames, currentMemberIds);
        
        // Calculate total crimes from the processed data
        const totalSuccessful = difficultyStats.reduce((sum, stat) => sum + stat.successful, 0);
        const totalFailed = difficultyStats.reduce((sum, stat) => sum + stat.failed, 0);
        const totalCrimes = totalSuccessful + totalFailed;
        
        // Store data globally (preserve sortState)
        ocStatsData.difficultyStats = difficultyStats;
        ocStatsData.playerStats = playerStats;
        ocStatsData.totalCrimes = totalCrimes;
        ocStatsData.allCrimes = allCrimes; // Store raw crime data for filtering
        ocStatsData.currentMemberIds = Array.from(currentMemberIds); // Convert Set to Array for storage
        ocStatsData.playerNames = playerNames; // Store for filtering
        
        // Update UI
        updateOCStatsUI(difficultyStats, playerStats, totalCrimes);
        
        // Show results section
        if (resultsSection) {
            resultsSection.style.display = 'block';
        }
        
        if (progressContainer) progressContainer.style.display = 'none';

    } catch (error) {
        console.error('Error fetching OC data:', error);
        alert('Error fetching crime data: ' + error.message);
    } finally {
        if (loadingSpinner) loadingSpinner.style.display = 'none';
        if (fetchBtn) fetchBtn.disabled = false;
        if (progressContainer) progressContainer.style.display = 'none';
    }
};

function processCrimeData(crimes, playerNames = {}, currentMemberIds = new Set()) {
    console.log('Processing crime data...');
    console.log(`Filtering by ${currentMemberIds.size} current members`);
    
    // Initialize difficulty stats (1-10)
    const difficultyMap = {};
    for (let i = 1; i <= 10; i++) {
        difficultyMap[i] = {
            difficulty: i,
            total: 0,
            successful: 0,
            failed: 0,
            successRate: 0
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
            totalScore: 0,
            successRate: 0,
            difficultyBreakdown: {} // Track stats per difficulty level
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
        
        // Only count this crime if at least one current member participated
        if (hasCurrentMember) {
            // Update difficulty stats
            if (difficultyMap[difficulty]) {
                difficultyMap[difficulty].total++;
                if (status === 'Successful') {
                    difficultyMap[difficulty].successful++;
                } else {
                    difficultyMap[difficulty].failed++;
                }
            }
        }
        
        // Process player participations (only for current members)
        if (crime.slots && Array.isArray(crime.slots)) {
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
                                totalScore: 0,
                                successRate: 0
                            };
                        }
                    
                        // Count participation
                        playerMap[playerId].totalParticipations++;
                        
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
                        
                        // Count outcome
                        if (outcome === 'Successful') {
                            playerMap[playerId].successfulParticipations++;
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
    
    console.log('Difficulty stats:', difficultyStats);
    console.log('Player stats (top 10):', playerStats.slice(0, 10));
    
    return { difficultyStats, playerStats };
}

function updateOCStatsUI(difficultyStats, playerStats, totalCrimes) {
    console.log('Updating OC Stats UI...');
    
    // Calculate summary stats
    const totalSuccessful = difficultyStats.reduce((sum, stat) => sum + stat.successful, 0);
    const totalFailed = difficultyStats.reduce((sum, stat) => sum + stat.failed, 0);
    const overallSuccessRate = totalCrimes > 0 ? Math.round((totalSuccessful / totalCrimes) * 100) : 0;
    const totalPlayers = playerStats.length;
    
    // Update difficulty stats table with summary
    const difficultyTable = document.getElementById('difficultyStatsTable');
    if (difficultyTable) {
        let html = `
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
                </div>
                <p style="text-align: center; color: #888; font-size: 0.9em; margin-top: 10px; margin-bottom: 0;">
                    Only counting crimes where at least one current member participated.
                </p>
            </div>
            <table id="difficultyTable" style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr>
                        <th data-column="difficulty" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Difficulty <span class="sort-indicator"></span></th>
                        <th data-column="total" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Total Crimes <span class="sort-indicator"></span></th>
                        <th data-column="successful" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Successful <span class="sort-indicator"></span></th>
                        <th data-column="failed" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Failed <span class="sort-indicator"></span></th>
                        <th data-column="successRate" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Success Rate <span class="sort-indicator"></span></th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        difficultyStats.forEach(stat => {
            const rateColor = stat.successRate >= 70 ? '#4ecdc4' : 
                             stat.successRate >= 50 ? '#ffd700' : '#ff6b6b';
            html += `
                <tr style="border-bottom: 1px solid var(--border-color);">
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${stat.difficulty}/10</td>
                    <td style="padding: 12px; text-align: center;">${stat.total}</td>
                    <td style="padding: 12px; text-align: center; color: #4ecdc4; font-weight: bold;">${stat.successful}</td>
                    <td style="padding: 12px; text-align: center; color: #ff6b6b; font-weight: bold;">${stat.failed}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; font-size: 1.1em; color: ${rateColor};">${stat.successRate}%</td>
                </tr>
            `;
        });
        
        html += `
                </tbody>
            </table>
        `;
        
        difficultyTable.innerHTML = html;
        
        // Add sort handlers for difficulty table
        const difficultyHeaders = difficultyTable.querySelectorAll('th[data-column]');
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
    const playerTable = document.getElementById('playerStatsTable');
    if (playerTable) {
        // Count how many current members have participated
        const participatingMembers = playerStats.filter(p => p.totalParticipations > 0).length;
        
        let html = `
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
                <p style="text-align: center; color: #888; font-size: 0.9em; margin-top: 10px; margin-bottom: 0;">
                    Showing current faction members only. Stats include crimes where at least one current member participated.
                </p>
            </div>
            <table id="playerTable" style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr>
                        <th data-column="name" style="padding: 12px; text-align: left; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Player Name <span class="sort-indicator"></span></th>
                        <th data-column="totalParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Total Participations <span class="sort-indicator"></span></th>
                        <th data-column="totalScore" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Score = Difficulty × (Participants ÷ 6). Full team (6 people) = 100% of difficulty points. Partial team gets proportional points.">Score <span class="sort-indicator"></span></th>
                        <th data-column="successfulParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Successful <span class="sort-indicator"></span></th>
                        <th data-column="failedParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Failed <span class="sort-indicator"></span></th>
                        <th data-column="successRate" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Success Rate <span class="sort-indicator"></span></th>
                        <th style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color);">Details</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        playerStats.forEach((player, index) => {
            const rateColor = player.successRate >= 70 ? '#4ecdc4' : 
                             player.successRate >= 50 ? '#ffd700' : '#ff6b6b';
            
            // Main player row
            html += `
                <tr style="border-bottom: 1px solid var(--border-color);" data-player-id="${player.id}">
                    <td style="padding: 12px;">
                        <a href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank" class="player-link">
                            ${player.name}
                        </a>
                    </td>
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${player.totalParticipations}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; color: #ffd700;">${player.totalScore}</td>
                    <td style="padding: 12px; text-align: center; color: #4ecdc4; font-weight: bold;">${player.successfulParticipations}</td>
                    <td style="padding: 12px; text-align: center; color: #ff6b6b; font-weight: bold;">${player.failedParticipations}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; font-size: 1.1em; color: ${rateColor};">${player.successRate}%</td>
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
                        <td colspan="7" style="padding: 20px;">
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
                
                // Add rows for each difficulty level that has participation
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
        
        // Add sort handlers for player table
        const playerHeaders = playerTable.querySelectorAll('th[data-column]');
        playerHeaders.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.dataset.column;
                sortPlayerTable(column);
            });
        });
        
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
    
    console.log('UI updated successfully');
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
    
    // Sort the data
    dataToSort.sort((a, b) => {
        let aVal = a[column];
        let bVal = b[column];
        
        if (currentSort.direction === 'asc') {
            return aVal - bVal;
        } else {
            return bVal - aVal;
        }
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
    
    // Sort the data
    dataToSort.sort((a, b) => {
        let aVal = a[column];
        let bVal = b[column];
        
        // Handle text sorting for name
        if (column === 'name') {
            aVal = aVal.toLowerCase();
            bVal = bVal.toLowerCase();
            if (currentSort.direction === 'asc') {
                return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            } else {
                return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
            }
        }
        
        // Numeric sorting
        if (currentSort.direction === 'asc') {
            return aVal - bVal;
        } else {
            return bVal - aVal;
        }
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
    
    const { difficultyStats, playerStats, totalCrimes } = ocStatsData;
    
    let csvContent = 'Organised Crime Statistics\n\n';
    csvContent += `Total Crimes Analyzed: ${totalCrimes}\n\n`;
    
    // Difficulty stats
    csvContent += 'SUCCESS RATES BY DIFFICULTY\n';
    csvContent += 'Difficulty,Total Crimes,Successful,Failed,Success Rate\n';
    difficultyStats.forEach(stat => {
        csvContent += `${stat.difficulty}/10,${stat.total},${stat.successful},${stat.failed},${stat.successRate}%\n`;
    });
    
    csvContent += '\n\nPLAYER PARTICIPATION STATS\n';
    csvContent += 'Player Name,Player ID,Total Participations,Score,Successful,Failed,Success Rate\n';
    playerStats.forEach(player => {
        csvContent += `"${player.name}",${player.id},${player.totalParticipations},${player.totalScore},${player.successfulParticipations},${player.failedParticipations},${player.successRate}%\n`;
    });
    
    csvContent += '\n\nPLAYER DIFFICULTY BREAKDOWN\n';
    csvContent += 'Player Name,Difficulty,Total,Successful,Failed,Success Rate\n';
    playerStats.forEach(player => {
        if (player.totalParticipations > 0) {
            for (let diff = 1; diff <= 10; diff++) {
                const breakdown = player.difficultyBreakdown[diff];
                if (breakdown && breakdown.total > 0) {
                    const diffSuccessRate = Math.round((breakdown.successful / breakdown.total) * 100);
                    csvContent += `"${player.name}",${diff}/10,${breakdown.total},${breakdown.successful},${breakdown.failed},${diffSuccessRate}%\n`;
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

// Date filtering functions
function handleDateFilterChange(section) {
    const filterId = section === 'difficulty' ? 'difficultyDateFilter' : 'playerDateFilter';
    const dateRangeSelect = document.getElementById(filterId);
    const selectedDays = dateRangeSelect.value;
    
    // Store the active filter
    ocStatsData.activeFilters[section] = selectedDays;
    
    if (selectedDays === 'all') {
        // Show all data for this section
        if (section === 'difficulty') {
            updateDifficultyStatsUI(ocStatsData.difficultyStats);
        } else {
            updatePlayerStatsUI(ocStatsData.playerStats);
        }
    } else {
        // Filter by date range
        const days = parseInt(selectedDays);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        
        const filteredData = filterDataByDateRange(cutoffDate);
        
        if (section === 'difficulty') {
            updateDifficultyStatsUI(filteredData.difficultyStats);
        } else {
            updatePlayerStatsUI(filteredData.playerStats);
        }
    }
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
    
    const { difficultyStats, playerStats } = processCrimeData(filteredCrimes, playerNames, currentMemberIds);
    
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
        const days = parseInt(activeFilter);
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
                </div>
                <p style="text-align: center; color: #888; font-size: 0.9em; margin-top: 10px; margin-bottom: 0;">
                    Only counting crimes where at least one current member participated.
                </p>
            </div>
            <table id="difficultyTable" style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr>
                        <th data-column="difficulty" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Difficulty <span class="sort-indicator"></span></th>
                        <th data-column="total" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Total Crimes <span class="sort-indicator"></span></th>
                        <th data-column="successful" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Successful <span class="sort-indicator"></span></th>
                        <th data-column="failed" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Failed <span class="sort-indicator"></span></th>
                        <th data-column="successRate" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Success Rate <span class="sort-indicator"></span></th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        difficultyStats.forEach(stat => {
            const rateColor = stat.successRate >= 70 ? '#4ecdc4' : 
                            stat.successRate >= 50 ? '#ffd700' : '#ff6b6b';
            
            html += `
                <tr style="border-bottom: 1px solid var(--border-color);">
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${stat.difficulty}/10</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${stat.total}</td>
                    <td style="padding: 12px; text-align: center; color: #4ecdc4; font-weight: bold;">${stat.successful}</td>
                    <td style="padding: 12px; text-align: center; color: #ff6b6b; font-weight: bold;">${stat.failed}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; font-size: 1.1em; color: ${rateColor};">${stat.successRate}%</td>
                </tr>
            `;
        });
        
        html += `
                </tbody>
            </table>
        `;
        
        difficultyTable.innerHTML = html;
        
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
        
        let html = `
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
                <p style="text-align: center; color: #888; font-size: 0.9em; margin-top: 10px; margin-bottom: 0;">
                    Showing current faction members only. Stats include crimes where at least one current member participated.
                </p>
            </div>
            <table id="playerTable" style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr>
                        <th data-column="name" style="padding: 12px; text-align: left; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Player Name <span class="sort-indicator"></span></th>
                        <th data-column="totalParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Total Participations <span class="sort-indicator"></span></th>
                        <th data-column="totalScore" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'" title="Score = Difficulty × (Participants ÷ 6). Full team (6 people) = 100% of difficulty points. Partial team gets proportional points.">Score <span class="sort-indicator"></span></th>
                        <th data-column="successfulParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Successful <span class="sort-indicator"></span></th>
                        <th data-column="failedParticipations" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Failed <span class="sort-indicator"></span></th>
                        <th data-column="successRate" style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color); cursor: pointer; user-select: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border-color)'" onmouseout="this.style.backgroundColor='var(--secondary-color)'">Success Rate <span class="sort-indicator"></span></th>
                        <th style="padding: 12px; text-align: center; background-color: var(--secondary-color); color: var(--accent-color); border-bottom: 1px solid var(--border-color);">Details</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        playerStats.forEach((player, index) => {
            const rateColor = player.successRate >= 70 ? '#4ecdc4' : 
                            player.successRate >= 50 ? '#ffd700' : '#ff6b6b';
            
            html += `
                <tr style="border-bottom: 1px solid var(--border-color);" data-player-id="${player.id}">
                    <td style="padding: 12px;">
                        <a href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank" class="player-link">
                            ${player.name}
                        </a>
                    </td>
                    <td style="padding: 12px; text-align: center; font-weight: bold;">${player.totalParticipations}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; color: #ffd700;">${player.totalScore}</td>
                    <td style="padding: 12px; text-align: center; color: #4ecdc4; font-weight: bold;">${player.successfulParticipations}</td>
                    <td style="padding: 12px; text-align: center; color: #ff6b6b; font-weight: bold;">${player.failedParticipations}</td>
                    <td style="padding: 12px; text-align: center; font-weight: bold; font-size: 1.1em; color: ${rateColor};">${player.successRate}%</td>
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
                        <td colspan="7" style="padding: 20px;">
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

