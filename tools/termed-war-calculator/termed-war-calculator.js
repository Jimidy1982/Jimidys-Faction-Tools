console.log('[TERMED WAR CALCULATOR] termed-war-calculator.js LOADED');

// Global state for termed war calculator
let termedWarData = {
    warStartTime: null,
    requiredFinishTime: null,
    requiredLead: 0,
    losingScore: 2000,
    winningScore: 0,
    calculatedResults: null
};

// Global state for cache swapping
let cacheSwapData = {
    warId: null,
    warData: null,
    cacheValues: {},
    factionACaches: {},
    factionBCaches: {},
    factionAPercentage: 50,
    factionBPercentage: 50
};

function initTermedWarCalculator() {
    console.log('[TERMED WAR CALCULATOR] initTermedWarCalculator CALLED');
    
    // Log tool usage
    if (window.logToolUsage) {
        window.logToolUsage('termed-war-calculator');
    }

    // Set up auto-calculation on any input change
    const warStartDaySelect = document.getElementById('warStartDay');
    const warStartHourSelect = document.getElementById('warStartHour');
    const warFinishDaySelect = document.getElementById('warFinishDay');
    const warFinishHourSelect = document.getElementById('warFinishHour');
    const startingLeadInput = document.getElementById('startingLeadRequirement');
    const winningScoreInput = document.getElementById('winningScore');
    const losingScoreInput = document.getElementById('losingScore');


    // Add event listeners for auto-calculation
    if (warStartDaySelect) warStartDaySelect.addEventListener('change', handleAutoCalculation);
    if (warStartHourSelect) warStartHourSelect.addEventListener('change', handleAutoCalculation);
    if (warFinishDaySelect) warFinishDaySelect.addEventListener('change', handleAutoCalculation);
    if (warFinishHourSelect) warFinishHourSelect.addEventListener('change', handleAutoCalculation);
    if (startingLeadInput) startingLeadInput.addEventListener('input', handleAutoCalculation);

    // Add event listeners for score updates
    if (winningScoreInput) winningScoreInput.addEventListener('input', handleWinningScoreChange);
    if (losingScoreInput) losingScoreInput.addEventListener('input', handleLosingScoreChange);

    // Initialize cache swapping functionality
    initCacheSwapping();

    // Initialize tab functionality
    initTabs();

    // Initial calculation
    setTimeout(handleAutoCalculation, 100);
}

const handleAutoCalculation = () => {
    console.log('[TERMED WAR CALCULATOR] Auto-calculating...');

    const warStartDaySelect = document.getElementById('warStartDay');
    const warStartHourSelect = document.getElementById('warStartHour');
    const warFinishDaySelect = document.getElementById('warFinishDay');
    const warFinishHourSelect = document.getElementById('warFinishHour');
    const startingLeadInput = document.getElementById('startingLeadRequirement');

    if (!warStartDaySelect || !warStartHourSelect || !warFinishDaySelect || !warFinishHourSelect) {
        return; // Elements not ready yet
    }

    try {
        // Get input values
        const warStartDay = warStartDaySelect.value;
        const warStartHour = parseInt(warStartHourSelect.value);
        const warFinishDay = warFinishDaySelect.value;
        const warFinishHour = parseInt(warFinishHourSelect.value);
        const startingLead = parseInt(startingLeadInput?.value || 1000);

        // Calculate war start time based on next occurrence of selected day
        const warStartTime = getNextWarDay(warStartDay, warStartHour);
        
        // Calculate finish time - ensure it's after the start time
        let requiredFinishTime = getNextWarDay(warFinishDay, warFinishHour, warStartTime);
        
        // If the finish time is before or equal to start time, add a week
        if (requiredFinishTime <= warStartTime) {
            const finishDate = new Date(warStartTime);
            const daysOfWeek = {
                'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
                'thursday': 4, 'friday': 5, 'saturday': 6
            };
            const targetDay = daysOfWeek[warFinishDay];
            const currentDay = finishDate.getDay();
            const daysToAdd = (targetDay - currentDay + 7) % 7;
            finishDate.setDate(finishDate.getDate() + (daysToAdd === 0 ? 7 : daysToAdd));
            finishDate.setHours(warFinishHour, 0, 0, 0);
            requiredFinishTime = finishDate;
        }

        // Validate that finish time is after start time and within 123 hours
        const timeDifferenceMs = requiredFinishTime.getTime() - warStartTime.getTime();
        const timeDifferenceHours = timeDifferenceMs / (1000 * 60 * 60);

        if (timeDifferenceHours <= 0) {
            console.log('Finish time must be after start time');
            return;
        }

        if (timeDifferenceHours > 123) {
            console.log('War duration cannot exceed 123 hours');
            return;
        }

        // Calculate war decay based on time
        const results = calculateWarDecay(warStartTime, requiredFinishTime, startingLead);

        // Store results globally
        termedWarData = {
            warStartTime: warStartTime,
            requiredFinishTime: requiredFinishTime,
            startingLead: startingLead,
            calculatedResults: results
        };

        // Update the lead requirement display (this will be used for score calculations)
        // Don't update lead requirement display here - it will be updated when scores change

        // Update scores based on current losing score and FINAL lead requirement (after decay)
        const currentLosingScore = parseInt(document.getElementById('losingScore')?.value || 2000);
        const finalLeadRequirement = results.finalLeadRequirement; // This is the decayed lead requirement
        
        // Update the losing score input with current value and calculate winning score
        const losingScoreInput = document.getElementById('losingScore');
        const winningScoreInput = document.getElementById('winningScore');
        
        if (losingScoreInput && winningScoreInput) {
            const winningScore = currentLosingScore + finalLeadRequirement;
            losingScoreInput.value = currentLosingScore;
            winningScoreInput.value = winningScore;
            
            termedWarData.losingScore = currentLosingScore;
            termedWarData.winningScore = winningScore;
            
            // Update lead requirement display to show the actual difference
            const actualLead = winningScore - currentLosingScore;
            updateLeadRequirementDisplay(actualLead);
        }

    } catch (error) {
        console.error('Error in auto-calculation:', error);
    }
};

// Handle winning score changes
const handleWinningScoreChange = (event) => {
    const winningScore = parseInt(event.target.value) || 0;
    const finalLeadRequirement = termedWarData.calculatedResults?.finalLeadRequirement || 1000;
    const losingScore = Math.max(0, winningScore - finalLeadRequirement);
    
    // Update losing score without triggering its change event
    const losingScoreInput = document.getElementById('losingScore');
    if (losingScoreInput) {
        losingScoreInput.value = losingScore;
    }
    
    termedWarData.winningScore = winningScore;
    termedWarData.losingScore = losingScore;
    
    // Update lead requirement display to show the actual difference
    const actualLead = winningScore - losingScore;
    updateLeadRequirementDisplay(actualLead);
    
    console.log(`Winning score changed to ${winningScore}, losing score updated to ${losingScore} (using final lead requirement: ${finalLeadRequirement})`);
};

// Handle losing score changes
const handleLosingScoreChange = (event) => {
    const losingScore = parseInt(event.target.value) || 0;
    updateScoreFromLosing(losingScore);
};

// Update winning score based on losing score
const updateScoreFromLosing = (losingScore) => {
    const finalLeadRequirement = termedWarData.calculatedResults?.finalLeadRequirement || 1000;
    const winningScore = losingScore + finalLeadRequirement;
    
    // Update winning score without triggering its change event
    const winningScoreInput = document.getElementById('winningScore');
    if (winningScoreInput) {
        winningScoreInput.value = winningScore;
    }
    
    termedWarData.losingScore = losingScore;
    termedWarData.winningScore = winningScore;
    
    // Update lead requirement display to show the actual difference
    const actualLead = winningScore - losingScore;
    updateLeadRequirementDisplay(actualLead);
    
    console.log(`Losing score changed to ${losingScore}, winning score updated to ${winningScore} (using final lead requirement: ${finalLeadRequirement})`);
};

// Update lead requirement display
const updateLeadRequirementDisplay = (leadRequirement) => {
    const displayElement = document.getElementById('leadRequirementDisplay');
    if (displayElement) {
        displayElement.textContent = leadRequirement.toLocaleString();
    }
};

// Helper function to get the next occurrence of a war day
function getNextWarDay(dayName, hour, referenceDate = null) {
    // If no reference date provided, use today
    const baseDate = referenceDate || new Date();
    const daysOfWeek = {
        'sunday': 0,
        'monday': 1,
        'tuesday': 2,
        'wednesday': 3,
        'thursday': 4,
        'friday': 5,
        'saturday': 6
    };
    
    const targetDay = daysOfWeek[dayName];
    const nextDate = new Date(baseDate);
    
    // Find the next occurrence of the target day
    const daysUntilTarget = (targetDay - baseDate.getDay() + 7) % 7;
    
    // If it's 0 (same day) and current time is before the target hour, use today
    if (daysUntilTarget === 0 && baseDate.getHours() < hour) {
        nextDate.setHours(hour, 0, 0, 0);
    } else {
        // Otherwise, go to the next occurrence
        nextDate.setDate(baseDate.getDate() + (daysUntilTarget === 0 ? 7 : daysUntilTarget));
        nextDate.setHours(hour, 0, 0, 0);
    }
    
    return nextDate;
}


function calculateWarDecay(warStartTime, requiredFinishTime, startingLeadRequirement) {
    console.log('[TERMED WAR CALCULATOR] Calculating war decay...');
    console.log('War start time:', warStartTime);
    console.log('Required finish time:', requiredFinishTime);
    console.log('Starting lead requirement:', startingLeadRequirement);

    // Calculate total war duration (in hours)
    const totalDurationMs = requiredFinishTime.getTime() - warStartTime.getTime();
    const totalDurationHours = totalDurationMs / (1000 * 60 * 60);
    
    console.log('Total war duration (hours):', totalDurationHours);

    // According to the wiki:
    // - Lead requirement decreases by 1% of original value per hour after 24 hours
    // - Maximum theoretical duration is 123 hours
    
    const maxDurationHours = 123;
    const gracePeriodHours = 24; // No decay for first 24 hours
    
    // Validate duration
    if (totalDurationHours > maxDurationHours) {
        throw new Error(`War duration cannot exceed ${maxDurationHours} hours (maximum theoretical duration)`);
    }

    // Calculate what the lead requirement will be at the finish time
    let finalLeadRequirement = startingLeadRequirement;
    
    if (totalDurationHours >= gracePeriodHours) {
        // Calculate decay: 1% of original per hour starting AT 24 hours
        const decayHours = Math.max(0, totalDurationHours - gracePeriodHours + 1); // +1 because decay starts at 24h mark
        const totalDecay = startingLeadRequirement * (decayHours * 1) / 100; // 1% per hour
        finalLeadRequirement = Math.max(1, startingLeadRequirement - totalDecay);
    }

    // Calculate intermediate values for display
    const timeInGracePeriod = totalDurationHours < gracePeriodHours;
    const decayHours = Math.max(0, totalDurationHours - gracePeriodHours + 1); // +1 because decay starts at 24h mark
    const totalDecayAmount = startingLeadRequirement * (decayHours * 1) / 100;

    const results = {
        startingLeadRequirement: startingLeadRequirement,
        finalLeadRequirement: Math.round(finalLeadRequirement),
        totalDurationHours: Math.round(totalDurationHours * 100) / 100,
        gracePeriodHours: gracePeriodHours,
        decayHours: Math.round(decayHours * 100) / 100,
        maxDurationHours: maxDurationHours,
        timeInGracePeriod: timeInGracePeriod,
        totalDecayAmount: Math.round(totalDecayAmount),
        warStartTime: warStartTime,
        requiredFinishTime: requiredFinishTime
    };

    console.log('[TERMED WAR CALCULATOR] Calculation results:', results);
    return results;
}

function updateWarResultsUI(results) {
    console.log('[TERMED WAR CALCULATOR] Updating UI with results...');

    const warResultsDiv = document.getElementById('warResults');

    if (!warResultsDiv) {
        console.error('War results div not found');
        return;
    }

    // Format dates for display
    const formatDateTime = (date) => {
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    };

    // Format duration for display
    const formatDuration = (hours) => {
        const days = Math.floor(hours / 24);
        const remainingHours = Math.floor(hours % 24);
        const minutes = Math.floor((hours % 1) * 60);
        
        if (days > 0) {
            return `${days}d ${remainingHours}h ${minutes}m`;
        } else if (remainingHours > 0) {
            return `${remainingHours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    };

    // Determine war status
    let warStatus, statusColor;
    if (results.timeInGracePeriod) {
        warStatus = "Grace Period (No Decay)";
        statusColor = "#4ecdc4";
    } else {
        warStatus = "Decay Phase Active";
        statusColor = "#ffd700";
    }

          // Create results HTML
          const resultsHTML = `
              <div class="summary-section">
                  <div class="summary-grid">
                      <div class="summary-item">
                          <span class="summary-label">War Status:</span>
                          <span class="summary-value" style="color: ${statusColor}; font-weight: bold;">${warStatus}</span>
                      </div>
                      <div class="summary-item">
                          <span class="summary-label">Starting Lead Requirement:</span>
                          <span class="summary-value">${results.startingLeadRequirement.toLocaleString()}</span>
                      </div>
                      <div class="summary-item">
                          <span class="summary-label">Final Lead Requirement:</span>
                          <span class="summary-value">${results.finalLeadRequirement.toLocaleString()}</span>
                      </div>
                      <div class="summary-item">
                          <span class="summary-label">Total War Duration:</span>
                          <span class="summary-value">${formatDuration(results.totalDurationHours)}</span>
                      </div>
                  </div>
              </div>

        <div class="summary-section" style="margin-top: 20px;">
            <div class="summary-grid">
                <div class="summary-item">
                    <span class="summary-label">War Start Time:</span>
                    <span class="summary-value">${formatDateTime(results.warStartTime)}</span>
                </div>
                <div class="summary-item">
                    <span class="summary-label">Required Finish Time:</span>
                    <span class="summary-value">${formatDateTime(results.requiredFinishTime)}</span>
                </div>
                      <div class="summary-item">
                          <span class="summary-label">Grace Period Duration:</span>
                          <span class="summary-value">${formatDuration(results.gracePeriodHours)}</span>
                      </div>
                      <div class="summary-item">
                          <span class="summary-label">Decay Duration:</span>
                          <span class="summary-value">${formatDuration(results.decayHours)}</span>
                      </div>
                      <div class="summary-item">
                          <span class="summary-label">Total Decay Amount:</span>
                          <span class="summary-value">${results.totalDecayAmount.toLocaleString()}</span>
                      </div>
            </div>
        </div>

        <div class="summary-section" style="margin-top: 20px; border-left: 4px solid var(--accent-color);">
            <h4 style="color: var(--accent-color); margin: 0 0 10px 0;">📊 How It Works</h4>
            <div style="color: var(--text-color); font-size: 0.9em; line-height: 1.5;">
                <p style="margin: 5px 0;"><strong>Starting Lead Requirement:</strong> The lead requirement the game gives you (e.g., 8000)</p>
                <p style="margin: 5px 0;"><strong>Grace Period:</strong> First 24 hours - no decay, must meet full requirement</p>
                <p style="margin: 5px 0;"><strong>Decay Phase:</strong> After 24 hours - requirement decreases by 1% of original per hour</p>
                <p style="margin: 5px 0;"><strong>Final Lead Requirement:</strong> What the requirement will be at your chosen finish time</p>
                <p style="margin: 5px 0;"><strong>Editable Scores:</strong> Edit either score to see the other automatically update based on your Starting Lead Requirement</p>
            </div>
        </div>
    `;

    warResultsDiv.innerHTML = resultsHTML;

    console.log('[TERMED WAR CALCULATOR] UI updated successfully');
}

// Tab Functions
function initTabs() {
    console.log('[TERMED WAR CALCULATOR] Initializing tabs...');
    
    const tabButtons = document.querySelectorAll('.tab-button');
    
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.getAttribute('data-tab');
            switchTab(targetTab);
        });
    });
    
    // Add click handler for tab links within help tips (with a small delay to ensure DOM is ready)
    setTimeout(() => {
        const tabLinks = document.querySelectorAll('.tab-link');
        console.log(`[TERMED WAR CALCULATOR] Found ${tabLinks.length} tab links`);
        tabLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const targetTab = link.getAttribute('data-tab');
                console.log(`[TERMED WAR CALCULATOR] Tab link clicked, switching to: ${targetTab}`);
                switchTab(targetTab);
            });
        });
    }, 100);
}

function switchTab(tabId) {
    console.log(`[TERMED WAR CALCULATOR] Switching to tab: ${tabId}`);
    console.trace('switchTab called from:');
    
    // Remove active class from all tabs and buttons
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(content => content.classList.remove('active'));
    
    // Add active class to selected tab and button
    const selectedButton = document.querySelector(`[data-tab="${tabId}"]`);
    const selectedContent = document.getElementById(tabId);
    
    if (selectedButton) selectedButton.classList.add('active');
    if (selectedContent) selectedContent.classList.add('active');
}

// Cache Swapping Functions
function initCacheSwapping() {
    console.log('[TERMED WAR CALCULATOR] Initializing cache swapping...');
    
    const fetchButton = document.getElementById('fetchWarData');
    const warIdInput = document.getElementById('warIdInput');
    const factionAPercentage = document.getElementById('factionAPercentage');
    const factionBPercentage = document.getElementById('factionBPercentage');
    
    if (fetchButton) {
        fetchButton.addEventListener('click', handleFetchWarData);
    }
    
    if (warIdInput) {
        warIdInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleFetchWarData();
            }
        });
    }
    
    if (factionAPercentage) {
        factionAPercentage.addEventListener('input', handlePercentageChange);
    }
    
    if (factionBPercentage) {
        factionBPercentage.addEventListener('input', handlePercentageChange);
    }
}

async function handleFetchWarData() {
    const warIdInput = document.getElementById('warIdInput');
    const fetchButton = document.getElementById('fetchWarData');
    
    if (!warIdInput || !warIdInput.value) {
        alert('Please enter a war ID');
        return;
    }
    
    const warId = warIdInput.value;
    fetchButton.disabled = true;
    fetchButton.textContent = 'Fetching...';
    
    try {
        // Fetch war data and cache values
        await Promise.all([
            fetchWarData(warId),
            fetchCacheValues()
        ]);
        
        displayWarData();
        document.getElementById('warDataDisplay').style.display = 'block';
        document.getElementById('cacheDistributionSection').style.display = 'block';
        
        // Update percentage labels with real faction names
        updatePercentageLabels();
        
        // Show swap results automatically with default 50/50 split
        calculateCacheSwaps();
        
    } catch (error) {
        console.error('Error fetching war data:', error);
        
        // Check if it's an access level error
        if (error.message && error.message.includes('Access level of this key is not high enough')) {
            alert('⚠️ Insufficient API Key Permissions\n\n' +
                  'Your API key doesn\'t have the required access level.\n\n' +
                  'This tool requires a Limited or Full access API key to access faction war data.\n\n' +
                  'To fix this:\n' +
                  '1. Go to Torn Preferences → API\n' +
                  '2. Create a new API key or edit your existing key\n' +
                  '3. Set the access level to Limited or Full\n' +
                  '4. Copy the new key and enter it in the API Key field');
        } else {
            alert('Error fetching war data: ' + error.message);
        }
    } finally {
        fetchButton.disabled = false;
        fetchButton.textContent = 'Fetch War Data';
    }
}

async function fetchWarData(warId) {
    console.log(`[CACHE SWAP] Fetching war data for ID: ${warId}`);
    
    // Get API key from localStorage (same as consumption tracker)
    let apiKey = localStorage.getItem('tornApiKey');
    if (!apiKey) {
        throw new Error('Please enter your API key in the sidebar first');
    }
    
    // Fetch war data from Torn API
    const response = await fetch(`https://api.torn.com/torn/${warId}?selections=rankedwarreport&key=${apiKey}`);
    const warData = await response.json();
    
    if (warData.error) {
        throw new Error(`API Error: ${warData.error.error}`);
    }
    
    if (!warData.rankedwarreport || !warData.rankedwarreport.factions) {
        throw new Error('No war data found for this ID');
    }
    
    // Extract faction data
    const factions = warData.rankedwarreport.factions;
    const factionIds = Object.keys(factions);
    
    if (factionIds.length < 2) {
        throw new Error('Invalid war data - need at least 2 factions');
    }
    
    const factionA = factions[factionIds[0]];
    const factionB = factions[factionIds[1]];
    
    // Map item IDs to cache names and extract quantities
    const itemIdToCache = {
        '1118': 'Armor Cache',
        '1119': 'Melee Cache', 
        '1120': 'Small Arms Cache',
        '1121': 'Medium Arms Cache',
        '1122': 'Heavy Arms Cache'
    };
    
    // Initialize cache counts
    const factionACaches = {};
    const factionBCaches = {};
    
    // Initialize all cache types to 0
    Object.values(itemIdToCache).forEach(cacheType => {
        factionACaches[cacheType] = 0;
        factionBCaches[cacheType] = 0;
    });
    
    // Extract cache quantities from faction A rewards
    if (factionA.rewards && factionA.rewards.items) {
        Object.entries(factionA.rewards.items).forEach(([itemId, itemData]) => {
            const cacheType = itemIdToCache[itemId];
            if (cacheType) {
                factionACaches[cacheType] = itemData.quantity || 0;
            }
        });
    }
    
    // Extract cache quantities from faction B rewards
    if (factionB.rewards && factionB.rewards.items) {
        Object.entries(factionB.rewards.items).forEach(([itemId, itemData]) => {
            const cacheType = itemIdToCache[itemId];
            if (cacheType) {
                factionBCaches[cacheType] = itemData.quantity || 0;
            }
        });
    }
    
    const processedWarData = {
        war_id: warId,
        faction_a: {
            name: factionA.name,
            caches: factionACaches
        },
        faction_b: {
            name: factionB.name,
            caches: factionBCaches
        }
    };
    
    cacheSwapData.warId = warId;
    cacheSwapData.warData = processedWarData;
    cacheSwapData.factionACaches = factionACaches;
    cacheSwapData.factionBCaches = factionBCaches;
}

async function fetchCacheValues() {
    console.log('[CACHE SWAP] Fetching cache market values...');
    
    // Get API key from localStorage
    let apiKey = localStorage.getItem('tornApiKey');
    if (!apiKey) {
        throw new Error('Please enter your API key in the sidebar first');
    }
    
    // Fetch items data from Torn API
    const response = await fetch(`https://api.torn.com/torn/?selections=items&key=${apiKey}`);
    const itemsData = await response.json();
    
    if (itemsData.error) {
        throw new Error(`API Error: ${itemsData.error.error}`);
    }
    
    // Map item IDs to cache names and get market values
    const itemIdToCache = {
        '1118': 'Armor Cache',
        '1119': 'Melee Cache', 
        '1120': 'Small Arms Cache',
        '1121': 'Medium Arms Cache',
        '1122': 'Heavy Arms Cache'
    };
    
    const cacheValues = {};
    
    // Extract market values for each cache type
    Object.entries(itemIdToCache).forEach(([itemId, cacheType]) => {
        const item = itemsData.items[itemId];
        if (item && item.market_value !== undefined) {
            cacheValues[cacheType] = item.market_value;
            console.log(`[CACHE SWAP] ${cacheType} (ID: ${itemId}) - Market Value: $${item.market_value.toLocaleString()}`);
        } else {
            console.warn(`[CACHE SWAP] Could not find market value for ${cacheType} (ID: ${itemId})`);
            cacheValues[cacheType] = 0; // Default to 0 if not found
        }
    });
    
    cacheSwapData.cacheValues = cacheValues;
}

function displayWarData() {
    console.log('[CACHE SWAP] Displaying war data...');
    
    // Update faction names
    const factionAName = document.getElementById('factionAName');
    const factionBName = document.getElementById('factionBName');
    
    if (factionAName && cacheSwapData.warData) {
        factionAName.textContent = cacheSwapData.warData.faction_a.name;
    }
    if (factionBName && cacheSwapData.warData) {
        factionBName.textContent = cacheSwapData.warData.faction_b.name;
    }
    
    const factionACachesDiv = document.getElementById('factionACaches');
    const factionBCachesDiv = document.getElementById('factionBCaches');
    
    if (factionACachesDiv) {
        factionACachesDiv.innerHTML = '';
        let factionATotal = 0;
        
        Object.entries(cacheSwapData.factionACaches).forEach(([cacheType, quantity]) => {
            const value = quantity * (cacheSwapData.cacheValues[cacheType] || 0);
            factionATotal += value;
            const cacheItem = document.createElement('div');
            cacheItem.className = 'cache-item';
            cacheItem.innerHTML = `
                <span class="cache-name">${cacheType}</span>
                <span class="cache-quantity">${quantity}</span>
                <span class="cache-value">$${value.toLocaleString()}</span>
            `;
            factionACachesDiv.appendChild(cacheItem);
        });
        
        // Add total row for faction A
        const totalRowA = document.createElement('div');
        totalRowA.className = 'cache-item';
        totalRowA.style.borderTop = '2px solid var(--accent-color)';
        totalRowA.style.marginTop = '10px';
        totalRowA.style.paddingTop = '10px';
        totalRowA.innerHTML = `
            <span class="cache-name" style="font-weight: bold; color: var(--accent-color);">TOTAL</span>
            <span class="cache-quantity" style="font-weight: bold; color: var(--accent-color);">-</span>
            <span class="cache-value" style="font-weight: bold; color: var(--accent-color); font-size: 1.1em;">$${factionATotal.toLocaleString()}</span>
        `;
        factionACachesDiv.appendChild(totalRowA);
    }
    
    if (factionBCachesDiv) {
        factionBCachesDiv.innerHTML = '';
        let factionBTotal = 0;
        
        Object.entries(cacheSwapData.factionBCaches).forEach(([cacheType, quantity]) => {
            const value = quantity * (cacheSwapData.cacheValues[cacheType] || 0);
            factionBTotal += value;
            const cacheItem = document.createElement('div');
            cacheItem.className = 'cache-item';
            cacheItem.innerHTML = `
                <span class="cache-name">${cacheType}</span>
                <span class="cache-quantity">${quantity}</span>
                <span class="cache-value">$${value.toLocaleString()}</span>
            `;
            factionBCachesDiv.appendChild(cacheItem);
        });
        
        // Add total row for faction B
        const totalRowB = document.createElement('div');
        totalRowB.className = 'cache-item';
        totalRowB.style.borderTop = '2px solid var(--accent-color)';
        totalRowB.style.marginTop = '10px';
        totalRowB.style.paddingTop = '10px';
        totalRowB.innerHTML = `
            <span class="cache-name" style="font-weight: bold; color: var(--accent-color);">TOTAL</span>
            <span class="cache-quantity" style="font-weight: bold; color: var(--accent-color);">-</span>
            <span class="cache-value" style="font-weight: bold; color: var(--accent-color); font-size: 1.1em;">$${factionBTotal.toLocaleString()}</span>
        `;
        factionBCachesDiv.appendChild(totalRowB);
    }
}

function handlePercentageChange(event) {
    const factionAPercentage = document.getElementById('factionAPercentage');
    const factionBPercentage = document.getElementById('factionBPercentage');
    
    if (factionAPercentage && factionBPercentage) {
        let aValue, bValue;
        
        // Determine which slider was moved and update both accordingly
        if (event.target.id === 'factionAPercentage') {
            aValue = parseInt(factionAPercentage.value);
            bValue = 100 - aValue;
        } else if (event.target.id === 'factionBPercentage') {
            bValue = parseInt(factionBPercentage.value);
            aValue = 100 - bValue;
        } else {
            // Fallback - use A slider value
            aValue = parseInt(factionAPercentage.value);
            bValue = 100 - aValue;
        }
        
        // Update both sliders
        factionAPercentage.value = aValue;
        factionBPercentage.value = bValue;
        
        // Update cache data
        cacheSwapData.factionAPercentage = aValue;
        cacheSwapData.factionBPercentage = bValue;
        
        // Update percentage labels with new values
        updatePercentageLabels();
        
        // Recalculate swaps
        calculateCacheSwaps();
    }
}

// Function to update percentage labels with real faction names
function updatePercentageLabels() {
    if (!cacheSwapData.warData) return;
    
    const factionAName = cacheSwapData.warData.faction_a.name;
    const factionBName = cacheSwapData.warData.faction_b.name;
    
    // Find labels by their 'for' attribute
    const factionALabel = document.querySelector('label[for="factionAPercentage"]');
    const factionBLabel = document.querySelector('label[for="factionBPercentage"]');
    
    if (factionALabel) {
        factionALabel.textContent = `${factionAName}: ${cacheSwapData.factionAPercentage}%`;
        factionALabel.style.fontSize = '1.1em';
        factionALabel.style.fontWeight = 'bold';
    }
    if (factionBLabel) {
        factionBLabel.textContent = `${factionBName}: ${cacheSwapData.factionBPercentage}%`;
        factionBLabel.style.fontSize = '1.1em';
        factionBLabel.style.fontWeight = 'bold';
    }
}

function calculateCacheSwaps() {
    console.log('[CACHE SWAP] Calculating cache swaps...');
    
    if (!cacheSwapData.warData) return;
    
    // Calculate total caches by type
    const totalCaches = {};
    Object.keys(cacheSwapData.cacheValues).forEach(cacheType => {
        totalCaches[cacheType] = (cacheSwapData.factionACaches[cacheType] || 0) + 
                                (cacheSwapData.factionBCaches[cacheType] || 0);
    });
    
    // Calculate total value of all caches
    let totalValue = 0;
    Object.entries(totalCaches).forEach(([cacheType, total]) => {
        totalValue += total * cacheSwapData.cacheValues[cacheType];
    });
    
    // Calculate target values for each faction (these will be exactly equal for 50/50)
    const factionATargetValue = totalValue * cacheSwapData.factionAPercentage / 100;
    const factionBTargetValue = totalValue * cacheSwapData.factionBPercentage / 100;
    
    // Distribute caches using value-based distribution to achieve exact target values
    const targetA = {};
    const targetB = {};
    
    // First, try to distribute caches proportionally by count
    Object.entries(totalCaches).forEach(([cacheType, total]) => {
        if (total === 0) {
            targetA[cacheType] = 0;
            targetB[cacheType] = 0;
        } else {
            // Calculate proportional distribution
            const proportionalA = Math.round(total * cacheSwapData.factionAPercentage / 100);
            targetA[cacheType] = Math.max(0, Math.min(total, proportionalA)); // Ensure within bounds
            targetB[cacheType] = total - targetA[cacheType];
        }
    });
    
    // Use the target values directly for display (these are mathematically correct)
    const factionATotalValue = factionATargetValue;
    const factionBTotalValue = factionBTargetValue;
    
    // Update total value displays
    const factionATotalValueEl = document.getElementById('factionATotalValue');
    const factionBTotalValueEl = document.getElementById('factionBTotalValue');
    
    if (factionATotalValueEl) {
        factionATotalValueEl.textContent = `$${Math.round(factionATotalValue).toLocaleString()}`;
    }
    if (factionBTotalValueEl) {
        factionBTotalValueEl.textContent = `$${Math.round(factionBTotalValue).toLocaleString()}`;
    }
    
    // Calculate what needs to be transferred based on current vs target values
    const transfers = [];
    
    // Calculate current values for each faction
    let currentAValue = 0;
    let currentBValue = 0;
    
    Object.keys(cacheSwapData.cacheValues).forEach(cacheType => {
        const factionAQty = cacheSwapData.factionACaches[cacheType] || 0;
        const factionBQty = cacheSwapData.factionBCaches[cacheType] || 0;
        const cacheValue = cacheSwapData.cacheValues[cacheType];
        
        currentAValue += factionAQty * cacheValue;
        currentBValue += factionBQty * cacheValue;
    });
    
    console.log('[DEBUG] Current A value:', currentAValue);
    console.log('[DEBUG] Current B value:', currentBValue);
    console.log('[DEBUG] Target A value:', factionATargetValue);
    console.log('[DEBUG] Target B value:', factionBTargetValue);
    
    // Calculate how much value needs to be transferred
    const valueNeededByA = factionATargetValue - currentAValue;
    const valueNeededByB = factionBTargetValue - currentBValue;
    
    console.log('[DEBUG] Value needed by A:', valueNeededByA);
    console.log('[DEBUG] Value needed by B:', valueNeededByB);
    
    // Determine which faction should send caches (the one that needs to give up value)
    let sendingFaction, receivingFaction, senderName, receiverName;
    let valueToTransfer = 0;
    
    if (valueNeededByA > 0) {
        // Faction A needs more value, so B sends to A
        sendingFaction = 'Faction B';
        receivingFaction = 'Faction A';
        senderName = cacheSwapData.warData ? cacheSwapData.warData.faction_b.name : 'Faction B';
        receiverName = cacheSwapData.warData ? cacheSwapData.warData.faction_a.name : 'Faction A';
        valueToTransfer = valueNeededByA;
    } else if (valueNeededByB > 0) {
        // Faction B needs more value, so A sends to B
        sendingFaction = 'Faction A';
        receivingFaction = 'Faction B';
        senderName = cacheSwapData.warData ? cacheSwapData.warData.faction_a.name : 'Faction A';
        receiverName = cacheSwapData.warData ? cacheSwapData.warData.faction_b.name : 'Faction B';
        valueToTransfer = valueNeededByB;
    }
    
    // If transfers are needed, calculate which caches to send
    if (valueToTransfer > 0) {
        // Get available caches from sending faction
        const availableCaches = {};
        Object.keys(cacheSwapData.cacheValues).forEach(cacheType => {
            const senderCaches = sendingFaction === 'Faction A' ? 
                cacheSwapData.factionACaches[cacheType] || 0 : 
                cacheSwapData.factionBCaches[cacheType] || 0;
            
            if (senderCaches > 0) {
                availableCaches[cacheType] = {
                    quantity: senderCaches,
                    value: cacheSwapData.cacheValues[cacheType]
                };
            }
        });
        
        // Try ALL possible combinations and find the one with minimum cash needed
        let bestCombination = null;
        let minCashNeeded = valueToTransfer;
        
        // Generate all possible combinations
        const cacheTypes = Object.keys(availableCaches);
        
        function tryCombination(combination, cacheIndex) {
            if (cacheIndex >= cacheTypes.length) {
                // Calculate total value and cash needed for this combination
                let totalValue = 0;
                Object.entries(combination).forEach(([cacheType, quantity]) => {
                    totalValue += quantity * availableCaches[cacheType].value;
                });
                
                const cashNeeded = valueToTransfer - totalValue;
                
                // If this combination is better (less cash needed and doesn't exceed target)
                if (totalValue <= valueToTransfer && cashNeeded < minCashNeeded) {
                    bestCombination = { ...combination };
                    minCashNeeded = cashNeeded;
                }
                return;
            }
            
            const cacheType = cacheTypes[cacheIndex];
            const maxQuantity = availableCaches[cacheType].quantity;
            
            // Try 0 to maxQuantity of this cache type
            for (let qty = 0; qty <= maxQuantity; qty++) {
                combination[cacheType] = qty;
                tryCombination(combination, cacheIndex + 1);
            }
        }
        
        tryCombination({}, 0);
        
        // Add the best combination to transfers
        if (bestCombination) {
            Object.entries(bestCombination).forEach(([cacheType, quantity]) => {
                if (quantity > 0) {
                    const cacheValue = availableCaches[cacheType].value;
                    transfers.push({
                        from: sendingFaction,
                        to: receivingFaction,
                        cacheType: cacheType,
                        quantity: quantity,
                        value: quantity * cacheValue
                    });
                }
            });
        }
    }
    
    // Calculate cash compensation needed
    const totalCacheValueTransferred = transfers.reduce((sum, t) => sum + t.value, 0);
    const cashTransfer = Math.round(valueToTransfer - totalCacheValueTransferred);
    
    console.log('[DEBUG] Total cache value transferred:', totalCacheValueTransferred);
    console.log('[DEBUG] Cash transfer needed:', cashTransfer);
    
    displaySwapResults(transfers, cashTransfer);
}

function displaySwapResults(transfers, cashTransfer) {
    const swapResults = document.getElementById('swapResults');
    const swapDetails = document.getElementById('swapDetails');
    
    if (!swapResults || !swapDetails) return;
    
    swapDetails.innerHTML = '';
    
    if (transfers.length === 0 && cashTransfer === 0) {
        swapDetails.innerHTML = '<p style="text-align: center; color: var(--accent-color);">No transfers needed - caches are already distributed correctly!</p>';
    } else {
        // Get faction names
        const factionAName = cacheSwapData.warData ? cacheSwapData.warData.faction_a.name : 'Faction A';
        const factionBName = cacheSwapData.warData ? cacheSwapData.warData.faction_b.name : 'Faction B';
        
        // Group transfers by sender
        const transfersBySender = {
            [factionAName]: [],
            [factionBName]: []
        };
        
        transfers.forEach(transfer => {
            const senderName = transfer.from === 'Faction A' ? factionAName : factionBName;
            const receiverName = transfer.to === 'Faction A' ? factionAName : factionBName;
            
            transfersBySender[senderName].push({
                ...transfer,
                from: senderName,
                to: receiverName
            });
        });
        
        // Display transfers organized by sender
        Object.entries(transfersBySender).forEach(([senderName, senderTransfers]) => {
            if (senderTransfers.length > 0) {
                const senderDiv = document.createElement('div');
                senderDiv.className = 'swap-detail';
                
                let transfersHTML = `<h5 style="color: var(--accent-color); margin: 0 0 10px 0;">${senderName} sends:</h5>`;
                let totalCacheValue = 0;
                
                senderTransfers.forEach(transfer => {
                    transfersHTML += `
                        <div style="margin: 5px 0; padding-left: 15px;">
                            <strong>${transfer.quantity} ${transfer.cacheType}</strong> to <strong>${transfer.to}</strong>
                            <span style="color: #4ecdc4; margin-left: 10px;">($${transfer.value.toLocaleString()})</span>
                        </div>
                    `;
                    totalCacheValue += transfer.value;
                });
                
                transfersHTML += `<div style="margin-top: 8px; font-weight: bold; color: #4ecdc4;">Total Cache Value: $${totalCacheValue.toLocaleString()}</div>`;
                
                // If no cash transfer, add total summary here
                if (cashTransfer === 0) {
                    transfersHTML += `
                        <div style="margin-top: 12px; padding-top: 8px; border-top: 2px solid var(--accent-color); font-weight: bold; color: var(--accent-color); font-size: 1.1em;">
                            Total Value to Send: $${totalCacheValue.toLocaleString()}
                        </div>
                    `;
                }
                
                senderDiv.innerHTML = transfersHTML;
                swapDetails.appendChild(senderDiv);
            }
        });
        
        // Add cash transfer to the sending faction's section (if cash is needed)
        if (cashTransfer !== 0) {
            // Recalculate current values to determine correct sender/receiver
            let currentAValue = 0;
            let currentBValue = 0;
            
            Object.keys(cacheSwapData.cacheValues).forEach(cacheType => {
                const factionAQty = cacheSwapData.factionACaches[cacheType] || 0;
                const factionBQty = cacheSwapData.factionBCaches[cacheType] || 0;
                const cacheValue = cacheSwapData.cacheValues[cacheType];
                
                currentAValue += factionAQty * cacheValue;
                currentBValue += factionBQty * cacheValue;
            });
            
            // Calculate target values
            const totalValue = currentAValue + currentBValue;
            const factionATargetValue = totalValue * cacheSwapData.factionAPercentage / 100;
            const factionBTargetValue = totalValue * cacheSwapData.factionBPercentage / 100;
            
            // Determine sender/receiver based on who needs to give up value
            const valueNeededByA = factionATargetValue - currentAValue;
            const valueNeededByB = factionBTargetValue - currentBValue;
            
            let sendingFaction, receivingFaction;
            if (valueNeededByA > 0) {
                // Faction A needs value, so B sends to A
                sendingFaction = 'Faction B';
                receivingFaction = 'Faction A';
            } else {
                // Faction B needs value, so A sends to B
                sendingFaction = 'Faction A';
                receivingFaction = 'Faction B';
            }
            
            const senderName = sendingFaction === 'Faction A' ? factionAName : factionBName;
            const receiverName = receivingFaction === 'Faction A' ? factionAName : factionBName;
            const amount = Math.abs(cashTransfer);
            
            // Find the sender's section and add cash transfer to it
            const existingSections = document.querySelectorAll('.swap-detail');
            let sectionFound = false;
            
            existingSections.forEach(section => {
                const heading = section.querySelector('h5');
                if (heading && heading.textContent.includes(senderName)) {
                    sectionFound = true;
                    // Calculate total value being sent (caches + cash)
                    const cacheValueElements = section.querySelectorAll('span[style*="color: #4ecdc4"]');
                    let totalCacheValue = 0;
                    cacheValueElements.forEach(el => {
                        const valueText = el.textContent.match(/\$([\d,]+)/);
                        if (valueText) {
                            totalCacheValue += parseInt(valueText[1].replace(/,/g, ''));
                        }
                    });
                    
                    const totalValueSent = totalCacheValue + amount;
                    
                    // Add cash transfer to existing section
                    const cashHTML = `
                        <div style="margin: 8px 0; padding-left: 15px; border-top: 1px solid var(--border-color); padding-top: 8px;">
                            <strong>Cash payment</strong> to <strong>${receiverName}</strong>
                            <span style="color: #ff6b6b; margin-left: 10px; font-weight: bold;">$${amount.toLocaleString()}</span>
                        </div>
                        <div style="margin-top: 12px; padding-top: 8px; border-top: 2px solid var(--accent-color); font-weight: bold; color: var(--accent-color); font-size: 1.1em;">
                            Total Value to Send: $${totalValueSent.toLocaleString()}
                        </div>
                    `;
                    section.innerHTML += cashHTML;
                }
            });
            
            // If no existing section found (cash-only transfer), create a new one
            if (!sectionFound) {
                const cashDiv = document.createElement('div');
                cashDiv.className = 'swap-detail';
                cashDiv.innerHTML = `
                    <h5 style="color: var(--accent-color); margin: 0 0 10px 0;">${senderName} sends:</h5>
                    <div style="margin: 5px 0; padding-left: 15px;">
                        <strong>Cash payment</strong> to <strong>${receiverName}</strong>
                        <span style="color: #ff6b6b; margin-left: 10px; font-weight: bold;">$${amount.toLocaleString()}</span>
                    </div>
                    <div style="margin-top: 12px; padding-top: 8px; border-top: 2px solid var(--accent-color); font-weight: bold; color: var(--accent-color); font-size: 1.1em;">
                        Total Value to Send: $${amount.toLocaleString()}
                    </div>
                `;
                swapDetails.appendChild(cashDiv);
            }
        }
    }
    
    swapResults.style.display = 'block';
}

console.log('[TERMED WAR CALCULATOR] Script loaded');
