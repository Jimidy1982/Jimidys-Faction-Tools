// War Report 2.0 - Full Version

// Helper to sleep for ms milliseconds
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to detect chain bonus and get chain milestone
function detectChainBonus(totalRespect) {
    const chainMilestones = {
        10: '10th Chain',
        20: '25th Chain', 
        40: '50th Chain',
        80: '100th Chain',
        160: '250th Chain',
        320: '500th Chain',
        640: '1000th Chain',
        1280: '2500th Chain',
        2560: '5000th Chain',
        5120: '10000th Chain',
        10240: '25000th Chain',
        20480: '50000th Chain',
        40960: '100000th Chain'
    };
    
    if (chainMilestones[totalRespect]) {
        return {
            milestone: chainMilestones[totalRespect],
            points: totalRespect,
            deduction: totalRespect - 10 // Base respect is always 10, so deduction is total - 10
        };
    }
    
    return null;
}

// Helper to calculate base respect from attack data
function calculateBaseRespect(attack, removeModifiers = false, shouldRound = true) {
    const totalRespect = attack.respect_gain || 0;
    const groupBonus = attack.modifiers?.group || 0;
    const chainBonus = attack.modifiers?.chain || 0;
    
    // Check if this is a chain attack (respect_gain is 10, 20, 40, 80, 160, etc.)
    // Chain attacks follow the pattern: 10 * 2^n where n >= 0
    const chainValues = [10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480, 40960];
    if (chainValues.includes(totalRespect)) {
        return shouldRound ? 10 : 10; // Chain attacks are worth exactly 10 base respect points
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
    
    // Return whole integer for base respect only if shouldRound is true
    return shouldRound ? Math.round(baseRespect) : baseRespect;
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

// Global state for linked options group
let chainGroupLinked = true; // All three options are linked together by default
const chainGroupOptions = ['respectPayRetals', 'respectPayOverseas', 'respectRemoveModifiers'];

// Function to show confirmation dialog for opening multiple links
function showOpenLinksConfirmation(linkCount, callback) {
    const rememberChoice = localStorage.getItem('openLinksConfirmation');
    
    if (rememberChoice) {
        // User has already chosen to remember their preference
        if (rememberChoice === 'yes') {
            callback(); // Execute the callback immediately
            return;
        } else {
            // User chose "no" and wants to remember it
            return; // Don't execute callback
        }
    }
    
    // Create confirmation dialog
    const dialog = document.createElement('div');
    dialog.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.7);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
        font-family: Arial, sans-serif;
    `;
    
    const dialogContent = document.createElement('div');
    dialogContent.style.cssText = `
        background-color: #2a2a2a;
        border: 2px solid #ffd700;
        border-radius: 8px;
        padding: 30px;
        max-width: 400px;
        width: 90%;
        text-align: center;
        color: #ffffff;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    `;
    
    dialogContent.innerHTML = `
        <h3 style="color: #ffd700; margin: 0 0 20px 0; font-size: 1.3em;">Open ${linkCount} Payment Links?</h3>
        <p style="margin: 0 0 25px 0; color: #cccccc; line-height: 1.5;">
            This will open ${linkCount} payment links in new tabs. Make sure popups are allowed for this site.
        </p>
        <div style="margin: 20px 0;">
            <label style="display: flex; align-items: center; justify-content: center; color: #ffd700; cursor: pointer;">
                <input type="checkbox" id="rememberChoice" style="margin-right: 8px; accent-color: #ffd700;">
                Remember my choice for next time
            </label>
        </div>
        <div style="display: flex; gap: 15px; justify-content: center; margin-top: 25px;">
            <button id="confirmYes" style="
                background-color: #4CAF50;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 4px;
                cursor: pointer;
                font-weight: bold;
                transition: background-color 0.3s;
            ">Yes, Open Links</button>
            <button id="confirmNo" style="
                background-color: #f44336;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 4px;
                cursor: pointer;
                font-weight: bold;
                transition: background-color 0.3s;
            ">Cancel</button>
        </div>
    `;
    
    dialog.appendChild(dialogContent);
    document.body.appendChild(dialog);
    
    // Add hover effects
    const yesBtn = dialogContent.querySelector('#confirmYes');
    const noBtn = dialogContent.querySelector('#confirmNo');
    
    yesBtn.addEventListener('mouseenter', () => yesBtn.style.backgroundColor = '#45a049');
    yesBtn.addEventListener('mouseleave', () => yesBtn.style.backgroundColor = '#4CAF50');
    noBtn.addEventListener('mouseenter', () => noBtn.style.backgroundColor = '#da190b');
    noBtn.addEventListener('mouseleave', () => noBtn.style.backgroundColor = '#f44336');
    
    // Add event listeners
    yesBtn.addEventListener('click', () => {
        const remember = dialogContent.querySelector('#rememberChoice').checked;
        if (remember) {
            localStorage.setItem('openLinksConfirmation', 'yes');
        }
        document.body.removeChild(dialog);
        callback();
    });
    
    noBtn.addEventListener('click', () => {
        const remember = dialogContent.querySelector('#rememberChoice').checked;
        if (remember) {
            localStorage.setItem('openLinksConfirmation', 'no');
        }
        document.body.removeChild(dialog);
    });
    
    // Close dialog when clicking outside
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            document.body.removeChild(dialog);
        }
    });
}

// Functions to save and load respect payout settings
function saveRespectPayoutSettings() {
    const settings = {
        payAssists: document.getElementById('respectPayAssists')?.checked || false,
        payRetals: document.getElementById('respectPayRetals')?.checked || false,
        payOverseas: document.getElementById('respectPayOverseas')?.checked || false,
        payOtherAttacks: document.getElementById('respectPayOtherAttacks')?.checked || false,
        enableCombinedMin: document.getElementById('respectEnableCombinedMin')?.checked || false,
        combinedMin: document.getElementById('respectCombinedMin')?.value || '20',
        removeModifiers: document.getElementById('respectRemoveModifiers')?.checked || false,
        includeOutsideRespect: document.getElementById('respectIncludeOutside')?.checked || false,
        filterLowFF: document.getElementById('respectFilterLowFF')?.checked || false,
        minFFRating: document.getElementById('respectMinFFRating')?.value || '2.0',
        assistMultiplier: document.getElementById('respectAssistMultiplier')?.value || '0.25',
        retalMultiplier: document.getElementById('respectRetalMultiplier')?.value || '0.5',
        overseasMultiplier: document.getElementById('respectOverseasMultiplier')?.value || '0.25',
        otherAttacksMultiplier: document.getElementById('respectOtherAttacksMultiplier')?.value || '0.1',
        chainGroupLinked: chainGroupLinked,
        enableThresholds: document.getElementById('respectEnableThresholds')?.checked || false,
        minThreshold: document.getElementById('respectMinThreshold')?.value || '100',
        maxThreshold: document.getElementById('respectMaxThreshold')?.value || '300',
        payoutMode: document.querySelector('input[name="respectPayoutMode"]:checked')?.value || 'ratio'
    };
    localStorage.setItem('respectPayoutSettings', JSON.stringify(settings));

}

// Functions to save and load hit payout settings
function saveHitPayoutSettings() {
    const settings = {
        payAssists: document.getElementById('payAssists')?.checked || false,
        payRetals: document.getElementById('payRetals')?.checked || false,
        payOverseas: document.getElementById('payOverseas')?.checked || false,
        payOtherAttacks: document.getElementById('payOtherAttacks')?.checked || false,
        filterLowFF: document.getElementById('filterLowFF')?.checked || false,
        minFFRating: document.getElementById('minFFRating')?.value || '2.0',
        assistMultiplier: document.getElementById('assistMultiplier')?.value || '0.25',
        retalMultiplier: document.getElementById('retalMultiplier')?.value || '0.5',
        overseasMultiplier: document.getElementById('overseasMultiplier')?.value || '0.25',
        otherAttacksMultiplier: document.getElementById('otherAttacksMultiplier')?.value || '0.1',
        enableThresholds: document.getElementById('hitEnableThresholds')?.checked || false,
        minThreshold: document.getElementById('hitMinThreshold')?.value || '20',
        maxThreshold: document.getElementById('hitMaxThreshold')?.value || '50',
        payoutMode: document.querySelector('input[name="hitPayoutMode"]:checked')?.value || 'ratio'
    };
    localStorage.setItem('hitPayoutSettings', JSON.stringify(settings));

}

function loadHitPayoutSettings() {
    const savedSettings = localStorage.getItem('hitPayoutSettings');
    if (savedSettings) {
        try {
            const settings = JSON.parse(savedSettings);
            // Apply settings to elements
            if (settings.payAssists !== undefined) document.getElementById('payAssists').checked = settings.payAssists;
            if (settings.payRetals !== undefined) document.getElementById('payRetals').checked = settings.payRetals;
            if (settings.payOverseas !== undefined) document.getElementById('payOverseas').checked = settings.payOverseas;
            if (settings.payOtherAttacks !== undefined) document.getElementById('payOtherAttacks').checked = settings.payOtherAttacks;
            if (settings.filterLowFF !== undefined) document.getElementById('filterLowFF').checked = settings.filterLowFF;
            if (settings.minFFRating !== undefined) document.getElementById('minFFRating').value = settings.minFFRating;
            if (settings.assistMultiplier !== undefined) document.getElementById('assistMultiplier').value = settings.assistMultiplier;
            if (settings.retalMultiplier !== undefined) document.getElementById('retalMultiplier').value = settings.retalMultiplier;
            if (settings.overseasMultiplier !== undefined) document.getElementById('overseasMultiplier').value = settings.overseasMultiplier;
            if (settings.otherAttacksMultiplier !== undefined) document.getElementById('otherAttacksMultiplier').value = settings.otherAttacksMultiplier;
            if (settings.enableThresholds !== undefined) document.getElementById('hitEnableThresholds').checked = settings.enableThresholds;
            if (settings.minThreshold !== undefined) document.getElementById('hitMinThreshold').value = settings.minThreshold;
            if (settings.maxThreshold !== undefined) document.getElementById('hitMaxThreshold').value = settings.maxThreshold;
            if (settings.payoutMode !== undefined) {
                const payoutModeRadio = document.querySelector(`input[name="hitPayoutMode"][value="${settings.payoutMode}"]`);
                if (payoutModeRadio) payoutModeRadio.checked = true;
            }

        } catch (error) {
            console.error('Error loading hit payout settings:', error);
        }
    }
}

// Function to handle chain group toggle (clicking any chain button toggles all)
function toggleChainGroup() {
    chainGroupLinked = !chainGroupLinked;
    
    // Update all chain buttons to show the same state
    chainGroupOptions.forEach(optionId => {
        updateChainButtonState(optionId);
    });
    
    if (chainGroupLinked) {

    } else {

    }
    
    // Save settings and update table
    saveRespectPayoutSettings();
    updateRespectPayoutTable();
}

// Function to handle checkbox changes when group is linked
function handleLinkedOptionChange(changedCheckboxId) {
    if (chainGroupLinked && chainGroupOptions.includes(changedCheckboxId)) {
        const isChecked = document.getElementById(changedCheckboxId).checked;
        
        // Sync all options in the group
        chainGroupOptions.forEach(optionId => {
            document.getElementById(optionId).checked = isChecked;
        });

    }
}

// Function to update chain button visual state
function updateChainButtonState(optionId) {
    const button = document.querySelector(`[data-option="${optionId}"]`);
    if (!button) return;
    
    if (chainGroupLinked) {
        button.innerHTML = '🔗';
        button.title = 'Click to unlink all options';
        button.style.color = '#ffd700';
    } else {
        button.innerHTML = '🔓';
        button.title = 'Click to link all options';
        button.style.color = '#ff6b6b';
    }
}

function loadRespectPayoutSettings() {
    const savedSettings = localStorage.getItem('respectPayoutSettings');
    if (savedSettings) {
        try {
            const settings = JSON.parse(savedSettings);
            
            // Apply saved settings to form elements
            if (settings.payAssists !== undefined) document.getElementById('respectPayAssists').checked = settings.payAssists;
            if (settings.payRetals !== undefined) document.getElementById('respectPayRetals').checked = settings.payRetals;
            if (settings.payOverseas !== undefined) document.getElementById('respectPayOverseas').checked = settings.payOverseas;
            if (settings.payOtherAttacks !== undefined) document.getElementById('respectPayOtherAttacks').checked = settings.payOtherAttacks;
            if (settings.enableCombinedMin !== undefined) document.getElementById('respectEnableCombinedMin').checked = settings.enableCombinedMin;
            if (settings.combinedMin !== undefined) document.getElementById('respectCombinedMin').value = settings.combinedMin;
            if (settings.removeModifiers !== undefined) document.getElementById('respectRemoveModifiers').checked = settings.removeModifiers;
            if (settings.includeOutsideRespect !== undefined) document.getElementById('respectIncludeOutside').checked = settings.includeOutsideRespect;
            if (settings.filterLowFF !== undefined) document.getElementById('respectFilterLowFF').checked = settings.filterLowFF;
            if (settings.minFFRating !== undefined) document.getElementById('respectMinFFRating').value = settings.minFFRating;
            if (settings.assistMultiplier !== undefined) document.getElementById('respectAssistMultiplier').value = settings.assistMultiplier;
            if (settings.retalMultiplier !== undefined) document.getElementById('respectRetalMultiplier').value = settings.retalMultiplier;
            if (settings.overseasMultiplier !== undefined) document.getElementById('respectOverseasMultiplier').value = settings.overseasMultiplier;
            if (settings.otherAttacksMultiplier !== undefined) document.getElementById('respectOtherAttacksMultiplier').value = settings.otherAttacksMultiplier;
            if (settings.enableThresholds !== undefined) document.getElementById('respectEnableThresholds').checked = settings.enableThresholds;
            if (settings.minThreshold !== undefined) document.getElementById('respectMinThreshold').value = settings.minThreshold;
            if (settings.maxThreshold !== undefined) document.getElementById('respectMaxThreshold').value = settings.maxThreshold;
            if (settings.payoutMode !== undefined) {
                const payoutModeRadio = document.querySelector(`input[name="respectPayoutMode"][value="${settings.payoutMode}"]`);
                if (payoutModeRadio) payoutModeRadio.checked = true;
            }
            
            // Load chain group linked state
            if (settings.chainGroupLinked !== undefined) {
                chainGroupLinked = settings.chainGroupLinked;
                // Update all chain button states
                chainGroupOptions.forEach(optionId => {
                    updateChainButtonState(optionId);
                });
            }

        } catch (error) {
            console.error('Error loading respect payout settings:', error);
        }
    }
}

let tabsInitialized = false;

function initWarReport2() {
    // Load saved respect payout settings
    loadRespectPayoutSettings();
    
    // Load saved hit payout settings
    loadHitPayoutSettings();
    
    // Log tool usage
    if (window.logToolUsage) {
        window.logToolUsage('war-report-2.0');
    }
    
    // Function to get API key from localStorage (like the main app does)
    const getApiKeyFromStorage = () => {
        return localStorage.getItem('tornApiKey');
    };
    
    // Auto-fetch wars if API key is already present
    setTimeout(() => {
        const apiKey = getApiKeyFromStorage();
        if (apiKey) {
            autoFetchFactionAndWars(apiKey);
        }
    }, 500);
    
    const warListContainer = document.getElementById('warListContainer');
    const warList = document.getElementById('warList');
    const loadMoreBtn = document.getElementById('loadMoreWars');
    const factionIdInput = document.getElementById('factionId');
    const exportBtn = document.getElementById('exportCSV');
    const exportPayoutBtn = document.getElementById('exportPayoutCSV');

    // Global state for war list management
    let allWars = [];
    let displayedWarCount = 0;
    const INITIAL_WAR_COUNT = 5;
    const LOAD_MORE_COUNT = 10;
    
    // Global state for chain data
    let allChains = [];
    let warChainMatches = new Map(); // Maps war ID to matching chain data
    
    // Make warChainMatches globally accessible
    window.warChainMatches = warChainMatches;

    // Export button event listeners
    if (exportBtn) {
        exportBtn.addEventListener('click', exportWarReportToCSV);
    }
    if (exportPayoutBtn) {
        exportPayoutBtn.addEventListener('click', exportPayoutToCSV);
    }

    // Get message elements early
    const apiKeyInstructionMessage = document.getElementById('apiKeyInstructionMessage');
    const apiKeyErrorMessage = document.getElementById('apiKeyErrorMessage');
    
    // Function to show API key error
    const showApiKeyError = (errorText) => {
        if (apiKeyInstructionMessage) {
            apiKeyInstructionMessage.style.display = 'none';
        }
        if (apiKeyErrorMessage) {
            apiKeyErrorMessage.style.display = 'block';

        }
    };
    
    // Function to hide API key error
    const hideApiKeyError = () => {
        if (apiKeyErrorMessage) {
            apiKeyErrorMessage.style.display = 'none';
        }
    };

    // Auto-fetch faction ID and wars when API key is available
    const autoFetchFactionAndWars = async () => {
            const globalApiKeyInput = document.getElementById('globalApiKey');
            const apiKey = globalApiKeyInput ? globalApiKeyInput.value.trim() : '';
        
        if (apiKey && factionIdInput) {
            try {
                const response = await fetch(`https://api.torn.com/user/?selections=profile&key=${apiKey}`);
                const data = await response.json();
                
                if (data.error) {
                    console.error('API Error fetching user data:', data.error);
                    showApiKeyError(data.error.error || 'Unknown error');
                return;
            }
            
                // Extract faction ID from nested faction object
                const factionId = data.faction?.faction_id || data.faction_id;
                if (factionId) {
                    factionIdInput.value = factionId;
                    
                    // Hide error message on successful fetch
                    hideApiKeyError();
                    
                    // Now auto-fetch the wars
                    await autoFetchWars(factionId, apiKey);
                }
            } catch (error) {
                console.error('Error auto-fetching faction ID:', error);
            }
        }
    };

    // Helper function to format war dates
    const formatWarDate = (timestamp) => {
        const date = new Date(timestamp * 1000);
        return date.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    // Helper function to determine war status
    const getWarStatus = (war) => {
        const now = Date.now() / 1000;
        if (now < war.start) return 'Upcoming';
        if (now > war.end) return 'Ended';
        return 'Ongoing';
    };

    // Function to create a war card element
    const createWarCard = (war, factionId) => {
        const enemy = war.factions?.find(f => String(f.id) !== String(factionId));
        const enemyName = enemy?.name || 'Unknown';
        const status = getWarStatus(war);
        const startDate = formatWarDate(war.start);
        const endDate = formatWarDate(war.end);
        
        const statusColor = status === 'Ongoing' ? '#4CAF50' : status === 'Ended' ? '#999' : '#ffd700';
        
        // Check if this war has a matching chain
        const matchingChain = warChainMatches.get(war.id);
        
        const card = document.createElement('div');
        card.style.cssText = `
            padding: 15px;
            background-color: #2a2a2a;
            border-left: 4px solid ${statusColor};
            border-radius: 4px;
            display: grid;
            grid-template-columns: 1fr 250px auto;
            align-items: center;
            gap: 15px;
            transition: background-color 0.2s;
        `;
        card.onmouseover = () => card.style.backgroundColor = '#333';
        card.onmouseout = () => card.style.backgroundColor = '#2a2a2a';
        
        // Check if war is ended (only ended wars can be fetched)
        const isWarEnded = status === 'Ended';
        const buttonDisabled = !isWarEnded;
        const buttonClass = isWarEnded ? 'btn btn-success' : 'btn btn-secondary';
        const buttonText = isWarEnded ? 'Fetch War Data' : `${status} War`;
        const buttonStyle = isWarEnded ? 'white-space: nowrap;' : 'white-space: nowrap; cursor: not-allowed; opacity: 0.6;';
        
        card.innerHTML = `
            <div>
                <div style="color: #ffd700; font-size: 17px; font-weight: bold; margin-bottom: 8px;">
                    vs ${enemyName}
                </div>
                <div style="color: #b0b0b0; font-size: 14px;">
                    <strong>Start:</strong> ${startDate} | <strong>End:</strong> ${endDate} | <span style="color: ${statusColor}; font-weight: bold;">${status}</span>
                </div>
            </div>
            ${matchingChain && isWarEnded ? `
                <div style="display: flex; align-items: center; justify-content: flex-start; text-align: left;">
                    <label style="display: flex; align-items: center; color: #ffd700; font-size: 16px; cursor: pointer; white-space: nowrap;">
                        <input type="checkbox" class="chain-checkbox" data-war-id="${war.id}" style="accent-color: #ffd700; margin-right: 8px; transform: scale(1.2);">
                        Include ${matchingChain.chain} Chain
                    </label>
                </div>
            ` : '<div></div>'}
            <button class="${buttonClass} fetch-war-btn" data-war-id="${war.id}" type="button" style="${buttonStyle}" ${buttonDisabled ? 'disabled' : ''}>
                ${buttonText}
            </button>
        `;
        
        return card;
    };

    // Function to render wars to the list
    const renderWars = (startIndex, count) => {
        const warsToShow = allWars.slice(startIndex, startIndex + count);
        const factionId = factionIdInput.value;
        
        warsToShow.forEach(war => {
            const card = createWarCard(war, factionId);
            warList.appendChild(card);
        });
        
        displayedWarCount = startIndex + warsToShow.length;
        
        // Show/hide "Load More" button
        if (displayedWarCount < allWars.length) {
            loadMoreBtn.style.display = 'block';
        } else {
            loadMoreBtn.style.display = 'none';
        }
        
    };

    // Function to fetch chain data
    const fetchChainData = async (factionId, apiKey) => {
        try {
            const url = `https://api.torn.com/faction/?selections=chains&key=${apiKey}`;
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.error) {
                console.error('API Error fetching chains:', data.error);
                return [];
            }
            
            // Convert chains object to array
            const chains = Object.values(data.chains || {});
            return chains;
        } catch (error) {
            console.error('Error fetching chain data:', error);
            return [];
        }
    };

    // Function to match chains to wars
    const matchChainsToWars = (wars, chains) => {
        const matches = new Map();
        
        wars.forEach(war => {
            const warStart = war.start;
            const warEnd = war.end || Math.floor(Date.now() / 1000);
            
            // Find chains that:
            // 1. Started during the war (chain.start >= war.start && chain.start <= war.end)
            // 2. Ended after the war (chain.end > war.end)
            const matchingChains = chains.filter(chain => {
                return chain.start >= warStart && 
                       chain.start <= warEnd && 
                       chain.end > warEnd;
            });
            
            if (matchingChains.length > 0) {
                // If multiple chains match, pick the longest one
                const longestChain = matchingChains.reduce((longest, current) => 
                    current.chain > longest.chain ? current : longest
                );
                const extension = longestChain.end - warEnd;
                matches.set(war.id, {
                    chain: longestChain.chain,
                    start: longestChain.start,
                    end: longestChain.end,
                    extension: extension
                });
            }
        });
        
        return matches;
    };

    // Auto-fetch wars when faction ID is available
    const autoFetchWars = async (factionId, apiKey) => {
        try {

            warList.innerHTML = '<div style="padding: 15px; color: #b0b0b0;">Loading wars and chains...</div>';
            warListContainer.style.display = 'block';
            
            // Fetch both wars and chains in parallel
            const [warsResponse, chainsData] = await Promise.all([
                fetch(`https://api.torn.com/v2/faction/${factionId}/rankedwars?key=${apiKey}`),
                fetchChainData(factionId, apiKey)
            ]);
            
            const warsData = await warsResponse.json();
            
            if (warsData.error) {
                console.error('API Error fetching wars:', warsData.error);
                warList.innerHTML = '<div style="padding: 15px; color: #f44336;">Error loading wars</div>';
                return;
            }
            
            const wars = warsData.rankedwars || [];
            if (wars.length === 0) {
                warList.innerHTML = '<div style="padding: 15px; color: #b0b0b0;">No wars found</div>';
                return;
            }
            
            // Sort wars by start date (most recent first)
            allWars = wars.sort((a, b) => b.start - a.start);
            allChains = chainsData;
            
            // Match chains to wars
            warChainMatches = matchChainsToWars(allWars, allChains);
            window.warChainMatches = warChainMatches; // Update global reference
            
            // Clear the list and render initial wars
            warList.innerHTML = '';
            displayedWarCount = 0;
            renderWars(0, INITIAL_WAR_COUNT);

        } catch (error) {
            console.error('Error auto-fetching wars:', error);
            warList.innerHTML = '<div style="padding: 15px; color: #f44336;">Error loading wars</div>';
        }
    };

    // Auto-fetch when API key changes (with debouncing)
    let autoFetchTimeout;
    
    // Function to check API key and toggle message
    const checkApiKeyAndToggleMessage = () => {
        const apiKey = getApiKeyFromStorage();
        if (apiKeyInstructionMessage) {
            if (apiKey) {
                apiKeyInstructionMessage.style.display = 'none';
    } else {
                apiKeyInstructionMessage.style.display = 'block';
                hideApiKeyError(); // Hide error when no key present
            }
        }
    };
    
    // Check on page load
    checkApiKeyAndToggleMessage();
    
    // Listen for API key updates from the main app (with debouncing)
    // Only attach event listener once to prevent duplicates
    if (!window._warReportApiKeyListenerAttached) {
        let typingTimeout;
        window.addEventListener('apiKeyUpdated', (event) => {

            // Clear any existing timeout
            clearTimeout(typingTimeout);
            
            // Wait 1 second after user stops typing before checking
            typingTimeout = setTimeout(() => {
                const apiKey = event.detail.apiKey.trim();
                if (apiKey) {
                    
                    // Hide welcome message and fetch wars
                    checkApiKeyAndToggleMessage();
                    autoFetchFactionAndWars(apiKey);
                }
            }, 1000);
        });
        
        window._warReportApiKeyListenerAttached = true;

    }

    // Load More Wars button event listener
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => {

            renderWars(displayedWarCount, LOAD_MORE_COUNT);
        });
    }

    // Event delegation for Fetch War Data buttons on war cards
    if (warList) {
        warList.addEventListener('click', (event) => {
            const fetchBtn = event.target.closest('.fetch-war-btn');
            if (fetchBtn) {
                const warId = parseInt(fetchBtn.dataset.warId, 10); // Convert to number!

                // Check if chain extension is selected
                const chainCheckbox = document.querySelector(`.chain-checkbox[data-war-id="${warId}"]`);
                const includeChain = chainCheckbox ? chainCheckbox.checked : false;

                handleWarReportFetch(warId, includeChain);
            }
        });
    }
}

// Main function to fetch and process war data
async function handleWarReportFetch(warId = null, includeChain = false) {
    const startTime = performance.now();
    
    const spinner = document.getElementById('loadingSpinner');
    const resultsSection = document.querySelector('.results-section');
    const warListContainer = document.getElementById('warListContainer');
    const factionIdInput = document.getElementById('factionId');

    if (!factionIdInput || !spinner || !resultsSection) {
        console.error("One or more required elements are missing from the page.");
        return;
    }

    // Get global API key from main input
    const globalApiKeyInput = document.getElementById('globalApiKey');
    const apiKey = globalApiKeyInput ? globalApiKeyInput.value.trim() : '';

    const factionId = factionIdInput.value.trim();

    if (!apiKey || !warId || !factionId) {
        alert('Please enter all required fields: API Key, select a War, and Faction ID.');
        return;
    }

    // Hide the war list when fetching a specific war
    if (warListContainer) {
        warListContainer.style.display = 'none';
    }

    // Show progress bar
    const progressContainer = document.getElementById('progressContainer');
    const progressMessage = document.getElementById('progressMessage');
    const progressPercentage = document.getElementById('progressPercentage');
    const progressFill = document.getElementById('progressFill');
    const progressDetails = document.getElementById('progressDetails');
    
            if (progressContainer) {
            progressContainer.style.display = 'block';
            progressMessage.textContent = 'Fetching war information...';
            progressPercentage.textContent = '0%';
            progressFill.style.width = '0%';
            progressDetails.textContent = 'Initializing...';
        }

    startLoadingDots();
    resultsSection.style.display = 'none';

    try {
        // Step 1: Get ranked war information to determine start/end timestamps

        if (progressContainer) {
            progressMessage.textContent = 'Fetching war information...';
            progressPercentage.textContent = '0%';
            progressFill.style.width = '0%';
            progressDetails.textContent = 'Getting war details...';
        }
        
        const warInfoUrl = `https://api.torn.com/v2/faction/${factionId}/rankedwars?key=${apiKey}`;
        const warInfoResponse = await fetch(warInfoUrl);
        const warInfoData = await warInfoResponse.json();

        if (warInfoData.error) {
            throw new Error(`Torn API Error: ${warInfoData.error.error}`);
        }

        // Find the specific war by its ID in the 'rankedwars' array
        const rankedWarsArray = warInfoData.rankedwars || [];

        const targetWar = rankedWarsArray.find(war => war.id == warId);
        
        if (!targetWar) {
            const availableWarIds = rankedWarsArray.map(war => war.id).join(', ');
            const errorMessage = `Ranked War ID ${warId} not found in this faction's recent history. Available recent Ranked War IDs are: ${availableWarIds || 'None'}`;
            throw new Error(errorMessage);
        }

        let warStartTime = targetWar.start;
        let warEndTime = targetWar.end || Math.floor(Date.now() / 1000);
        
        // Check if chain extension is requested
        if (includeChain && window.warChainMatches && window.warChainMatches.has(warId)) {
            const chainData = window.warChainMatches.get(warId);
            warEndTime = chainData.end;

        }
        
        // Calculate war duration and show appropriate message
        const warDuration = warEndTime - warStartTime;
        const warDurationHours = warDuration / 3600;
        
        if (progressContainer) {
            if (warDurationHours > 48) {
                progressMessage.textContent = 'Fetching war attacks (large war detected)...';
                progressDetails.textContent = `This war lasted ${Math.round(warDurationHours)} hours - this may take a while`;
            } else if (warDurationHours > 24) {
                progressMessage.textContent = 'Fetching war attacks...';
                progressDetails.textContent = `This war lasted ${Math.round(warDurationHours)} hours`;
            } else {
                progressMessage.textContent = 'Fetching war attacks...';
                progressDetails.textContent = 'Collecting attack data...';
            }
        }
        
        // Ensure war end time is after war start time
        if (warEndTime <= warStartTime) {
            const currentTime = Math.floor(Date.now() / 1000);
        }
        

        // Step 2: Fetch faction attacks during the war period

        if (progressContainer) {
            progressMessage.textContent = 'Fetching war attacks...';
            progressPercentage.textContent = '0%';
            progressFill.style.width = '0%';
            progressDetails.textContent = 'Starting attack data collection...';
        }
        
        let allAttacks = [];
        
        // Ensure we have a valid end time that's after the start time
        let batchTo = warEndTime;
        if (warEndTime <= warStartTime) {
            batchTo = Math.floor(Date.now() / 1000);
        }
        
        // Add 1-hour buffer to start time to catch attacks initiated just before war start
        let batchFrom = warStartTime - 3600;
        
        // Debug: Log the raw API response structure

        let batchCount = 0;
        let keepFetching = true;
        const maxBatches = 1000; // Arbitrary high limit for safety
        
        // Use v2 API with Omanpx's approach: only 'from' timestamp, stop at war end time
        
        // Start from war start time
        let currentBatchFrom = warStartTime;
        
        const attackIds = new Set(); // Track unique attack IDs to avoid duplicates
        
        while (keepFetching && batchCount < maxBatches) {
            // Update progress based on timestamp progress (0-100% for attack fetching)
            if (progressContainer) {
                const timeProgress = Math.max(0, Math.min(100, ((currentBatchFrom - warStartTime) / (warEndTime - warStartTime)) * 100));
                progressPercentage.textContent = `${Math.round(timeProgress)}%`;
                progressFill.style.width = `${timeProgress}%`;
                progressDetails.textContent = `Processing batch ${batchCount + 1}... (${allAttacks.length} attacks found)`;
            }
            
            if (batchCount === 50) {

                // Show countdown for API limit wait
                if (progressContainer) {
                    progressMessage.textContent = 'Waiting for API Limit...';
                    progressDetails.textContent = 'API rate limit reached, waiting 30 seconds...';
                }
                
                // Countdown from 30 to 0
                for (let i = 30; i > 0; i--) {
                    if (progressContainer) {
                        progressDetails.textContent = `API rate limit reached, waiting ${i} seconds...`;
                    }
                    await sleep(1000);
                }
                
                if (progressContainer) {
                    progressMessage.textContent = 'Fetching war attacks...';
                    progressDetails.textContent = 'Resuming data collection...';
                }
            } else if (batchCount > 50) {
                await sleep(667); // 1.5 calls per second = 667ms between calls
            }
            
            // Use v2 API endpoint with ASCENDING sort to get oldest attacks first
            const attacksUrl = `https://api.torn.com/v2/faction/attacks?limit=100&sort=ASC&from=${currentBatchFrom}&key=${apiKey}`;

            const attacksResponse = await fetch(attacksUrl);
            const attacksData = await attacksResponse.json();
            
            if (attacksData.error) {
                throw new Error(`Torn API Error: ${attacksData.error.error}`);
            }

            const attacks = attacksData.attacks || [];
            
            // Filter out duplicates and attacks after war end time
            const validAttacks = attacks.filter(attack => {
                // Skip if we've seen this attack ID before
                if (attackIds.has(attack.id)) {
                    return false;
                }
                attackIds.add(attack.id);
                
                // Skip if attack started after war end time
                if (attack.started > warEndTime) {
                    return false;
                }
                
                return true;
            });
            
            allAttacks = allAttacks.concat(validAttacks);
            

            
            // Check if we found any post-war attacks (indicating we've gone past the war period)
            const postWarAttacks = attacks.filter(attack => attack.started > warEndTime);
            if (postWarAttacks.length > 0) {
                keepFetching = false;
            } else if (attacks.length < 100) {
                keepFetching = false; // No more attacks to fetch
            } else {
                // Find the latest started timestamp in this batch to use as next starting point (ASC order)
                const timestamps = validAttacks.map(a => a.started).filter(t => t && t > 0);
                if (timestamps.length > 0) {
                    const latest = Math.max(...timestamps);
                    if (latest > currentBatchFrom) {
                        currentBatchFrom = latest; // Start from the latest attack
                    } else {
                        keepFetching = false;
                    }
                } else {
                    keepFetching = false;
                }
            }
            batchCount++;
        }

        // Processing phase - no progress update needed since we're already at 100%

        // Final duplicate check and removal
        const finalAttackIds = new Set();
        const finalAttacks = allAttacks.filter(attack => {
            if (finalAttackIds.has(attack.id)) {
                return false;
            }
            finalAttackIds.add(attack.id);
            return true;
        });
        
        allAttacks = finalAttacks;

        // Step 3: Process attacks and create player report
        const playerStats = {};
        const factionIdStr = String(factionId);

        let processedCount = 0;
        allAttacks.forEach((attack) => {
            processedCount++;
            
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
                    lowFFHits: 0,
                    warScore: 0,
                    totalAttacks: 0,
                    totalFairFight: 0,
                    totalDefeatedLevel: 0,
                    successfulAttacks: 0
                };
            }

            // Count total attacks
            playerStats[attackerId].totalAttacks++;
            
            const playerName = attack.attacker.name;
            
            // Check for war hits - only count attacks with war modifier = 2 (actual war hits)
            const isWarHit = (
                !attack.is_interrupted && 
                attack.modifiers && 
                attack.modifiers.war === 2
            );
            

            
            if (isWarHit) {
                playerStats[attackerId].warHits++;
                playerStats[attackerId].warScore += attack.respect_gain || 0;
            }
            
            // Track low Fair Fight hits (will be processed in payout calculations)
            if (isWarHit && attack.modifiers && attack.modifiers.fair_fight !== undefined) {
                // This will be used in payout calculations to filter out low FF hits
                // The actual filtering and counting will be done in the payout logic
            }
            
            // Overseas hits (only count as overseas if it's also a war hit)
            if (attack.modifiers.overseas && attack.modifiers.overseas > 1 && isWarHit) {
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

        // Hide progress bar
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }

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

    // Store data in global state
    warReportData.playerStats = playerStats;
    warReportData.warInfo = warInfo;
    warReportData.allAttacks = allAttacks;
    const spinner = document.getElementById('loadingSpinner');
    const resultsSection = document.querySelector('.results-section');

    if (spinner) spinner.style.display = 'none';
    if (resultsSection) {
        resultsSection.style.display = 'block';

        // Defer tab initialization until DOM is updated
        setTimeout(() => {

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

    renderWarReportTable();
}

// Render the war report table with sorting
function renderWarReportTable() {

    const playerStats = warReportData.playerStats;
    const warInfo = warReportData.warInfo;
    const allAttacks = warReportData.allAttacks;
    const sortState = warReportData.sortState;

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

// --- Add input formatting for thousand separators with shortcuts ---
function addThousandSeparatorInput(input) {
    if (!input) {
        return;
    }
    
    const processInput = function(e) {
        let value = input.value.toLowerCase();
        
        // Check if user typed a letter (k, m, b) - if so, format immediately
        const hasLetter = value.includes('k') || value.includes('m') || value.includes('b');
        
        // If it's an input event (not blur) and no letter shortcuts
        if (e.type === 'input' && !hasLetter) {
            // Still update dataset.raw so calculations use the current value
            let raw = value.replace(/[^\d.]/g, '');
            if (raw === '') {
                input.value = '';
                input.dataset.raw = '0';
                return;
            }
            
            // Format with commas as they type (but don't round decimals yet)
            let numericValue = parseFloat(raw);
            input.dataset.raw = Math.round(numericValue * 100) / 100; // Preserve 2 decimal places
            
            // Format with thousand separators but preserve decimals while typing
            const parts = raw.split('.');
            const integerPart = parseInt(parts[0] || '0').toLocaleString();
            const decimalPart = parts[1] !== undefined ? '.' + parts[1] : '';
            input.value = integerPart + decimalPart;
            return;
        }
        
        // Handle shortcuts (k, m, b)
        let multiplier = 1;
        if (value.includes('k')) {
            multiplier = 1000;
            value = value.replace('k', '');
        } else if (value.includes('m')) {
            multiplier = 1000000;
            value = value.replace('m', '');
        } else if (value.includes('b')) {
            multiplier = 1000000000;
            value = value.replace('b', '');
        }
        
        // Extract numbers and decimals
        let raw = value.replace(/[^\d.]/g, '');
        if (raw === '') raw = '0';
        
        // Apply multiplier
        let numericValue = parseFloat(raw) * multiplier;
        
        // Format with thousand separators (round for display but preserve precision)
        let roundedValue = Math.round(numericValue * 100) / 100; // Preserve 2 decimal places
        input.value = Math.round(roundedValue).toLocaleString();
        input.dataset.raw = Math.round(roundedValue).toString();
    };
    
    input.addEventListener('input', processInput);
    input.addEventListener('blur', processInput);
    
    // Initialize
    let raw = input.value.replace(/[^\d.]/g, '');
    if (raw === '') raw = '0';
    input.value = Number(raw).toLocaleString();
    input.dataset.raw = raw;
}

// --- Patch initializeTabs to add input formatting ---
function initializeTabs() {
    if (tabsInitialized) {

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
        // Remove any existing event listeners and re-attach
    const newTabButtonsContainer = tabButtonsContainer.cloneNode(true);
    tabButtonsContainer.parentNode.replaceChild(newTabButtonsContainer, tabButtonsContainer);
    
    newTabButtonsContainer.addEventListener('click', function(e) {
        const btn = e.target.closest('.tab-button');
        if (!btn) return;
        
        // Get fresh references to all tab buttons and panes
        const allTabButtons = document.querySelectorAll('.tab-button');
        const allTabPanes = document.querySelectorAll('.tab-pane');
        
        // Remove active class from all buttons and panes
        allTabButtons.forEach(b => {
            b.classList.remove('active');

        });
        allTabPanes.forEach(p => {
            p.classList.remove('active');
            p.style.display = 'none';

        });
        
        // Add active class to clicked button
        btn.classList.add('active');

        // Show the corresponding pane
        const tabId = btn.getAttribute('data-tab');
        const pane = document.getElementById(tabId);

        if (pane) {
            pane.classList.add('active');
            pane.style.display = 'block';

            // If switching to payout tab and we have data, render payout table
            if (tabId === 'payout-tab' && warReportData.playerStats && Object.keys(warReportData.playerStats).length > 0) {

                renderPayoutTable();
            } else if (tabId === 'payout-tab') {

            }
            // If switching to respect payout tab and we have data, render respect payout table
            else if (tabId === 'respect-payout-tab' && warReportData.playerStats && Object.keys(warReportData.playerStats).length > 0) {

                renderRespectPayoutTable();
            } else if (tabId === 'respect-payout-tab') {

            }
        } else {
            console.error('[WAR REPORT 2.0] Pane not found for tab ID:', tabId);
        }
    });

    // Initialize payout input listeners and formatting
    const cacheSalesInput = document.getElementById('cacheSales');
    const payPerHitInput = document.getElementById('payPerHit');
    
    if (cacheSalesInput && payPerHitInput) {

        addThousandSeparatorInput(cacheSalesInput);
        addThousandSeparatorInput(payPerHitInput);
        // Define updatePayoutTable before using it
        const updatePayoutTable = () => {
            if (warReportData.playerStats && Object.keys(warReportData.playerStats).length > 0) {

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
                    // Formatting is already handled by the input's own blur listener
                });
            }
        });
        cacheSalesInput.addEventListener('input', updatePayoutTable);
        payPerHitInput.addEventListener('input', updatePayoutTable);
        
        
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
                    saveHitPayoutSettings();
                });
            }
            
            if (multiplier) {
                multiplier.addEventListener('input', (e) => {
                    updatePayoutTable();
                    saveHitPayoutSettings();
                });
            }
        });

        // Add event listeners for Fair Fight Filter options
        const filterLowFFCheckbox = document.getElementById('filterLowFF');
        const minFFRatingInput = document.getElementById('minFFRating');
        
        if (filterLowFFCheckbox) {
            filterLowFFCheckbox.addEventListener('change', (e) => {
                updatePayoutTable();
                saveHitPayoutSettings();
            });
        }
        
        if (minFFRatingInput) {
            minFFRatingInput.addEventListener('input', (e) => {
                updatePayoutTable();
                saveHitPayoutSettings();
            });
        }
        
        // Add event listeners for hit threshold controls (only once)
        setTimeout(() => {
            const hitEnableThresholdsCheckbox = document.getElementById('hitEnableThresholds');
            const hitMinThresholdInput = document.getElementById('hitMinThreshold');
            const hitMaxThresholdInput = document.getElementById('hitMaxThreshold');
            const hitPayoutModeRadios = document.querySelectorAll('input[name="hitPayoutMode"]');

            if (hitEnableThresholdsCheckbox && !hitEnableThresholdsCheckbox.hasAttribute('data-listener-added')) {

                hitEnableThresholdsCheckbox.addEventListener('change', (e) => {


                    updatePayoutTable();

                    saveHitPayoutSettings();

                });
                hitEnableThresholdsCheckbox.setAttribute('data-listener-added', 'true');
            }
            
            if (hitMinThresholdInput && !hitMinThresholdInput.hasAttribute('data-listener-added')) {

                hitMinThresholdInput.addEventListener('input', (e) => {


                    updatePayoutTable();

                    saveHitPayoutSettings();

                });
                hitMinThresholdInput.setAttribute('data-listener-added', 'true');
            }
            
            if (hitMaxThresholdInput && !hitMaxThresholdInput.hasAttribute('data-listener-added')) {

                hitMaxThresholdInput.addEventListener('input', (e) => {


                    updatePayoutTable();

                    saveHitPayoutSettings();

                });
                hitMaxThresholdInput.setAttribute('data-listener-added', 'true');
            }
            
            hitPayoutModeRadios.forEach(radio => {
                if (!radio.hasAttribute('data-listener-added')) {

                    radio.addEventListener('change', (e) => {

                        
                        // Enable/disable max threshold input based on payout mode
                        const maxThresholdInput = document.getElementById('hitMaxThreshold');
                        const maxThresholdLabel = document.getElementById('hitMaxThresholdLabel');
                        if (maxThresholdInput) {
                            if (e.target.value === 'equal') {
                                maxThresholdInput.disabled = true;
                                maxThresholdInput.style.backgroundColor = '#1a1a1a';
                                maxThresholdInput.style.color = '#666';
                                maxThresholdInput.style.cursor = 'not-allowed';
                                if (maxThresholdLabel) {
                                    maxThresholdLabel.style.color = '#666';
                                }

                            } else {
                                maxThresholdInput.disabled = false;
                                maxThresholdInput.style.backgroundColor = '#2a2a2a';
                                maxThresholdInput.style.color = '#fff';
                                maxThresholdInput.style.cursor = 'text';
                                if (maxThresholdLabel) {
                                    maxThresholdLabel.style.color = '#ccc';
                                }

                            }
                        }

                        updatePayoutTable();

                        saveHitPayoutSettings();

                    });
                    radio.setAttribute('data-listener-added', 'true');
                }
            });
        }, 100);
        
        // Initialize max threshold input state based on current payout mode
        setTimeout(() => {
            const maxThresholdInput = document.getElementById('hitMaxThreshold');
            const maxThresholdLabel = document.getElementById('hitMaxThresholdLabel');
            const currentPayoutMode = document.querySelector('input[name="hitPayoutMode"]:checked')?.value;
            if (maxThresholdInput && currentPayoutMode === 'equal') {
                maxThresholdInput.disabled = true;
                maxThresholdInput.style.backgroundColor = '#1a1a1a';
                maxThresholdInput.style.color = '#666';
                maxThresholdInput.style.cursor = 'not-allowed';
                if (maxThresholdLabel) {
                    maxThresholdLabel.style.color = '#666';
                }
            }
        }, 150);

        // Initialize respect payout input listeners and formatting
        const respectCacheSalesInput = document.getElementById('respectCacheSales');
        const respectPayPerHitInput = document.getElementById('respectPayPerHit');
        
        if (respectCacheSalesInput && respectPayPerHitInput) {

            addThousandSeparatorInput(respectCacheSalesInput);
            // respectPayPerHitInput is readonly, so no need to add formatting
            
            // Define updateRespectPayoutTable before using it
            const updateRespectPayoutTable = () => {

                
                if (warReportData.playerStats && Object.keys(warReportData.playerStats).length > 0) {

                    renderRespectPayoutTable();

                } else {

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
                        // Formatting is already handled by the input's own blur listener
                    });
                }
            });
            respectCacheSalesInput.addEventListener('input', updateRespectPayoutTable);
            
            // Add event listeners for respect combined minimum settings
            const respectEnableCombinedMinCheckbox = document.getElementById('respectEnableCombinedMin');
            const respectCombinedMinInput = document.getElementById('respectCombinedMin');
            
            if (respectEnableCombinedMinCheckbox) {
                respectEnableCombinedMinCheckbox.addEventListener('change', (e) => {
                    updateRespectPayoutTable();
                    // Save settings
                    saveRespectPayoutSettings();
                });
            }
            
            if (respectCombinedMinInput) {
                respectCombinedMinInput.addEventListener('input', (e) => {
                    updateRespectPayoutTable();
                    // Save settings
                    saveRespectPayoutSettings();
                });
            }
            
            // Add event listeners for Respect Advanced Payout Options checkboxes and multipliers
            const respectAdvancedPayoutOptions = [
                { checkboxId: 'respectPayAssists', multiplierId: 'respectAssistMultiplier' },
                { checkboxId: 'respectPayRetals', multiplierId: 'respectRetalMultiplier' },
                { checkboxId: 'respectPayOverseas', multiplierId: 'respectOverseasMultiplier' },
                { checkboxId: 'respectPayOtherAttacks', multiplierId: 'respectOtherAttacksMultiplier' }
            ];
            
            // Add event listeners for chain buttons (all work together as a group)
            const chainButtons = document.querySelectorAll('.chain-link-btn');
            chainButtons.forEach(button => {
                if (!button.hasAttribute('data-listener-added')) {
                    button.addEventListener('click', (e) => {
                        toggleChainGroup();
                    });
                    button.setAttribute('data-listener-added', 'true');
                }
            });
            
            respectAdvancedPayoutOptions.forEach(option => {
                const checkbox = document.getElementById(option.checkboxId);
                const multiplier = document.getElementById(option.multiplierId);
                
                if (checkbox) {
                    checkbox.addEventListener('change', (e) => {
                        // Handle linked group options
                        if (chainGroupOptions.includes(option.checkboxId)) {
                            handleLinkedOptionChange(option.checkboxId);
                        }
                        
                        updateRespectPayoutTable();
                        // Save settings
                        saveRespectPayoutSettings();
                    });
                }
                
                if (multiplier) {
                    multiplier.addEventListener('input', (e) => {
                        updateRespectPayoutTable();
                        // Save settings
                        saveRespectPayoutSettings();
                    });
                }
            });

            // Add event listeners for Respect Fair Fight Filter options
            const respectFilterLowFFCheckbox = document.getElementById('respectFilterLowFF');
            const respectMinFFRatingInput = document.getElementById('respectMinFFRating');
            
            if (respectFilterLowFFCheckbox) {
                respectFilterLowFFCheckbox.addEventListener('change', (e) => {
                    updateRespectPayoutTable();
                    // Save settings
                    saveRespectPayoutSettings();
                });
            }
            
            if (respectMinFFRatingInput) {
                respectMinFFRatingInput.addEventListener('input', (e) => {
                    updateRespectPayoutTable();
                    // Save settings
                    saveRespectPayoutSettings();
                });
            }
            
            // Add event listeners for respect threshold controls (only once)
            setTimeout(() => {
                const respectEnableThresholdsCheckbox = document.getElementById('respectEnableThresholds');
                const respectMinThresholdInput = document.getElementById('respectMinThreshold');
                const respectMaxThresholdInput = document.getElementById('respectMaxThreshold');
                const respectPayoutModeRadios = document.querySelectorAll('input[name="respectPayoutMode"]');

                if (respectEnableThresholdsCheckbox && !respectEnableThresholdsCheckbox.hasAttribute('data-listener-added')) {

                    respectEnableThresholdsCheckbox.addEventListener('change', (e) => {


                        updateRespectPayoutTable();

                        saveRespectPayoutSettings();

                    });
                    respectEnableThresholdsCheckbox.setAttribute('data-listener-added', 'true');
                }
                
                if (respectMinThresholdInput && !respectMinThresholdInput.hasAttribute('data-listener-added')) {

                    respectMinThresholdInput.addEventListener('input', (e) => {


                        updateRespectPayoutTable();

                        saveRespectPayoutSettings();

                    });
                    respectMinThresholdInput.setAttribute('data-listener-added', 'true');
                }
                
                if (respectMaxThresholdInput && !respectMaxThresholdInput.hasAttribute('data-listener-added')) {

                    respectMaxThresholdInput.addEventListener('input', (e) => {


                        updateRespectPayoutTable();

                        saveRespectPayoutSettings();

                    });
                    respectMaxThresholdInput.setAttribute('data-listener-added', 'true');
                }
                
                respectPayoutModeRadios.forEach(radio => {
                    if (!radio.hasAttribute('data-listener-added')) {

                        radio.addEventListener('change', (e) => {


                            updateRespectPayoutTable();

                            saveRespectPayoutSettings();

                        });
                        radio.setAttribute('data-listener-added', 'true');
                    }
                });
            }, 100);
            
            // Add event listener for remaining percentage input (only once)
            const remainingPercentageInput = document.getElementById('respectRemainingPercentage');
            if (remainingPercentageInput && !remainingPercentageInput.hasAttribute('data-listener-added')) {
                remainingPercentageInput.addEventListener('input', function() {
                    // Trigger recalculation when percentage changes
                    renderRespectPayoutTable();
                    // Save settings
                    saveRespectPayoutSettings();
                });
                remainingPercentageInput.setAttribute('data-listener-added', 'true');
            }
            
            // Add event listener for remove modifiers checkbox (only once)
            const removeModifiersCheckbox = document.getElementById('respectRemoveModifiers');
            if (removeModifiersCheckbox && !removeModifiersCheckbox.hasAttribute('data-listener-added')) {
                removeModifiersCheckbox.addEventListener('change', function() {
                    // Trigger recalculation when checkbox changes
                    renderRespectPayoutTable();
                    // Save settings
                    saveRespectPayoutSettings();
                });
                removeModifiersCheckbox.setAttribute('data-listener-added', 'true');
            }
            
            // Add event listener for include outside respect checkbox (only once)
            const includeOutsideRespectCheckbox = document.getElementById('respectIncludeOutside');
            if (includeOutsideRespectCheckbox && !includeOutsideRespectCheckbox.hasAttribute('data-listener-added')) {
                includeOutsideRespectCheckbox.addEventListener('change', function() {
                    // Trigger recalculation when checkbox changes
                    renderRespectPayoutTable();
                    // Save settings
                    saveRespectPayoutSettings();
                });
                includeOutsideRespectCheckbox.setAttribute('data-listener-added', 'true');
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

        return;
    }
    // Get payout settings (use raw value for calculations)
    const cacheSalesInput = document.getElementById('cacheSales');
    const payPerHitInput = document.getElementById('payPerHit');
    const cacheSales = parseInt(cacheSalesInput?.dataset.raw || cacheSalesInput?.value.replace(/[^\d.]/g, '') || '1000000000');
    const payPerHit = parseInt(payPerHitInput?.dataset.raw || payPerHitInput?.value.replace(/[^\d.]/g, '') || '1000000');

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
            value = parseInt(input.value.replace(/[^\d.]/g, '') || '0', 10);
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
    const filterLowFF = document.getElementById('filterLowFF')?.checked;
    const minFFRating = parseFloat(document.getElementById('minFFRating')?.value || '2.0');

    // Process attacks to count low FF hits and calculate filtered payouts
    const playersWithPayouts = Object.values(playerStats).map(player => {
        // Count low FF hits for this player
        let lowFFHits = 0;
        let qualifiedWarHits = player.warHits || 0;
        
        if (filterLowFF) {
            // Find all war hits for this player and check FF ratings
            const playerAttacks = warReportData.allAttacks.filter(attack => 
                String(attack.attacker?.id) === String(player.id) &&
                attack.modifiers?.war === 2 &&
                !attack.is_interrupted
            );
            
            lowFFHits = playerAttacks.filter(attack => 
                attack.modifiers?.fair_fight !== undefined && 
                attack.modifiers.fair_fight < minFFRating &&
                // Don't count retaliation hits (1.5) as low FF - they're good hits
                !(attack.modifiers?.retaliation && attack.modifiers.retaliation === 1.5)
            ).length;
            
            qualifiedWarHits = (player.warHits || 0) - lowFFHits;
        }
        
        let warHitPayout = Math.round(qualifiedWarHits * payPerHit);
        let retalPayout = payRetals ? Math.round((player.warRetals || 0) * payPerHit * retalMultiplier) : 0;
        let assistPayout = payAssists ? Math.round((player.warAssists || 0) * payPerHit * assistMultiplier) : 0;
        let overseasPayout = payOverseas ? Math.round((player.overseasHits || 0) * payPerHit * overseasMultiplier) : 0;
        let otherAttacksPayout = payOtherAttacks ? Math.round(((player.totalAttacks - (player.warHits || 0) - (player.warAssists || 0)) * payPerHit * otherAttacksMultiplier)) : 0;
        
        // Add low FF hits payout at "Other Attacks" rate
        let lowFFPayout = 0;
        if (filterLowFF && lowFFHits > 0) {
            lowFFPayout = Math.round(lowFFHits * payPerHit * otherAttacksMultiplier);
        }

        return {
            ...player,
            lowFFHits,
            qualifiedWarHits,
            warHitPayout,
            retalPayout,
            assistPayout,
            overseasPayout,
            otherAttacksPayout,
            lowFFPayout,
            totalPayout: Math.round(warHitPayout + retalPayout + assistPayout + overseasPayout + otherAttacksPayout + lowFFPayout)
        };
    });

    // Apply threshold-based payout adjustments if thresholds are enabled
    const enableThresholds = document.getElementById('hitEnableThresholds')?.checked || false;
    const minThreshold = parseFloat(document.getElementById('hitMinThreshold')?.value || '20');
    const maxThreshold = parseFloat(document.getElementById('hitMaxThreshold')?.value || '50');
    const payoutMode = document.querySelector('input[name="hitPayoutMode"]:checked')?.value || 'ratio';

    if (enableThresholds) {

        // Find qualifying players (above minimum threshold)
        const qualifyingPlayers = playersWithPayouts.filter(player => {
            const combinedHits = (player.warHits || 0) + (player.warAssists || 0);
            return combinedHits >= minThreshold;
        });

        // Apply threshold logic to each player
        playersWithPayouts.forEach(player => {
            const combinedHits = (player.warHits || 0) + (player.warAssists || 0);
            
            if (combinedHits < minThreshold) {
                // Below minimum threshold - no war hit payout, but cap other modifiers at minimum threshold payout
                player.warHitPayout = 0;
                
                // Calculate what a player at minimum threshold would earn (for capping purposes)
                let minThresholdPlayerPayout;
                if (payoutMode === 'equal') {
                    // Equal mode: treat minimum threshold as the qualifying amount
                    minThresholdPlayerPayout = minThreshold * payPerHit;
                } else {
                    // Ratio mode: use adjusted hits calculation
                    const adjustedMinHits = Math.min(minThreshold, maxThreshold);
                    minThresholdPlayerPayout = adjustedMinHits * payPerHit;
                }
                
                // Calculate total other modifiers payout
                const otherModifiersTotal = (player.retalPayout || 0) + (player.assistPayout || 0) + (player.overseasPayout || 0) + (player.otherAttacksPayout || 0) + (player.lowFFPayout || 0);
                
                // Cap other modifiers payout at minimum threshold amount
                if (otherModifiersTotal > minThresholdPlayerPayout) {
                    // Scale down all other modifiers proportionally to fit within the cap
                    const scaleFactor = minThresholdPlayerPayout / otherModifiersTotal;
                    player.retalPayout = Math.round((player.retalPayout || 0) * scaleFactor);
                    player.assistPayout = Math.round((player.assistPayout || 0) * scaleFactor);
                    player.overseasPayout = Math.round((player.overseasPayout || 0) * scaleFactor);
                    player.otherAttacksPayout = Math.round((player.otherAttacksPayout || 0) * scaleFactor);
                    player.lowFFPayout = Math.round((player.lowFFPayout || 0) * scaleFactor);

                } else {

                }
            } else {
                // Above minimum threshold - apply threshold logic using Pay Per War Hit
                if (payoutMode === 'equal') {
                    // Equal mode: treat all qualifying players as having minimum threshold hits
                    player.warHitPayout = minThreshold * payPerHit;

                } else {
                    // Ratio mode: use adjusted hits (capped at max threshold) with Pay Per War Hit
                    const adjustedHits = Math.min(combinedHits, maxThreshold);
                    player.warHitPayout = adjustedHits * payPerHit;

                }
                
                // When player reaches minimum threshold, ignore all other modifiers (assists, retals, overseas, etc.)
                player.retalPayout = 0;
                player.assistPayout = 0;
                player.overseasPayout = 0;
                player.otherAttacksPayout = 0;
                player.lowFFPayout = 0;

            }
            
            // Recalculate total payout
            player.totalPayout = player.warHitPayout + (player.retalPayout || 0) + (player.assistPayout || 0) + (player.overseasPayout || 0) + (player.otherAttacksPayout || 0) + (player.lowFFPayout || 0);
        });
    } else {

    }

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
                    <th data-column="lowFFHits" style="cursor: pointer; color: #ff6b6b;">Low FF Hits <span class="sort-indicator">${warReportData.payoutSortState.column === 'lowFFHits' ? (warReportData.payoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
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
                            <td style="color: #ff6b6b;">${player.lowFFHits || 0}</td>
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
                    <td><strong style="color: #ff6b6b;">${playersWithPayouts.reduce((sum, p) => sum + (p.lowFFHits || 0), 0)}</strong></td>
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

    if (table) {
        const headers = table.querySelectorAll('th[data-column]');

        headers.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.getAttribute('data-column');

                if (warReportData.payoutSortState.column === column) {
                    warReportData.payoutSortState.direction = warReportData.payoutSortState.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    warReportData.payoutSortState.column = column;
                    warReportData.payoutSortState.direction = column === 'name' ? 'asc' : 'desc';
                }

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
            
            // Show confirmation dialog
            showOpenLinksConfirmation(playersWithPayouts.length, async () => {
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
            });
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
    const payPerHit = parseInt(payPerHitInput?.dataset.raw || payPerHitInput?.value.replace(/[^\d.]/g, '') || '1000000');
    const headers = [
        'Member',
        'Level',
        'War Hits',
        'Low FF Hits',
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
            player.lowFFHits || 0,
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

    const playerStats = warReportData.playerStats;
    const warInfo = warReportData.warInfo;
    const allAttacks = warReportData.allAttacks;
    if (!playerStats || Object.keys(playerStats).length === 0) {

        return;
    }

    // Get respect payout settings (use raw value for calculations)
    const respectCacheSalesInput = document.getElementById('respectCacheSales');
    const respectPayPerHitInput = document.getElementById('respectPayPerHit');
    const cacheSales = parseInt(respectCacheSalesInput?.dataset.raw || respectCacheSalesInput?.value.replace(/[^\d.]/g, '') || '1000000000');

    // Get advanced options early
    const removeModifiers = document.getElementById('respectRemoveModifiers')?.checked;
    const includeOutsideRespect = document.getElementById('respectIncludeOutside')?.checked;

    // OPTIMIZATION: Process all attacks ONCE and cache player respect data
    const factionId = parseInt(document.getElementById('factionId').value);
    const playerRespectData = {};
    let totalBaseRespect = 0;
    let totalWarHits = 0;
    
    // Debug counters for chain bonus detection
    let debugChainBonuses = [];
    let debugRespectHits = 0;
    let debugWarHitsWithRespect = 0;
    
    // Initialize player respect data
    Object.keys(playerStats).forEach(playerId => {
        playerRespectData[playerId] = {
            warRespect: 0, // Raw values for accurate totals
            outsideRespect: 0,
            warHits: 0,
            outsideHits: 0,
            chainBonuses: [] // Track chain bonuses for this player
        };
    });
    
    // Process all attacks once to calculate both total and per-player respect

    let totalOutsideHits = 0;
    let totalOutsideRespect = 0;
    
    allAttacks.forEach((attack, index) => {
        const attackerFactionId = attack.attacker?.faction?.id;
        const isAttackerFaction = attackerFactionId === factionId;
        
        if (isAttackerFaction) {
            const baseRespect = calculateBaseRespect(attack, removeModifiers, false); // Don't round individual calculations
            const attackerId = String(attack.attacker?.id);
            
            // Debug: Count all respect-gaining hits
            if (attack.respect_gain && attack.respect_gain > 0) {
                debugRespectHits++;
            }
            
            // Check war modifier to determine if this is a war hit or outside hit
            const warModifier = attack.modifiers?.war;
            
            // Check for chain bonus regardless of war modifier (chain hits can be war or outside)
            const chainBonus = detectChainBonus(attack.respect_gain);
            if (chainBonus) {
                // Debug: Track all chain bonuses found
                debugChainBonuses.push({
                    ...chainBonus,
                    attackerName: attack.attacker?.name,
                    respect_gain: attack.respect_gain,
                    timestamp: attack.timestamp || 0,
                    warModifier: warModifier,
                    hitType: warModifier === 2 ? 'War Hit' : warModifier === 1 ? 'Outside Hit' : 'Other Hit'
                });
            }
            
            if (warModifier === 2) {
                // This is a war hit (war modifier = 2)
            totalWarHits++;
            totalBaseRespect += baseRespect;
            
            // Debug: Count war hits with respect
            if (attack.respect_gain && attack.respect_gain > 0) {
                debugWarHitsWithRespect++;
            }
            
                // Add to player's war respect data
            if (playerRespectData[attackerId]) {
                    playerRespectData[attackerId].warRespect += baseRespect;
                playerRespectData[attackerId].warHits++;
                    
                    // Add chain bonus to player data (if it exists)
                    if (chainBonus) {
                        playerRespectData[attackerId].chainBonuses.push({
                            ...chainBonus,
                            attackerName: attack.attacker?.name,
                            deduction: chainBonus.points, // Add deduction property for display
                            hitType: 'War Hit' // Mark as war hit
                        });
                    }
                }
                
            } else if (warModifier === 1 && baseRespect > 0) {
                // This is an outside hit (war modifier = 1 and gains respect)
                totalOutsideHits++;
                totalOutsideRespect += baseRespect;
                
                // Add to player's outside respect data
                if (playerRespectData[attackerId]) {
                    playerRespectData[attackerId].outsideRespect += baseRespect;
                    playerRespectData[attackerId].outsideHits++;
                    
                    // Add chain bonus to player data (if it exists) for outside hits too
                    if (chainBonus) {
                        playerRespectData[attackerId].chainBonuses.push({
                            ...chainBonus,
                            attackerName: attack.attacker?.name,
                            deduction: chainBonus.points, // Add deduction property for display
                            hitType: 'Outside Hit' // Mark as outside hit
                        });
                    }
                }
                
            }
        }
    });

    
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
            value = parseInt(input.value.replace(/[^\d.]/g, '') || '0', 10);
        }
        totalCosts += value;
    });
    
    // Auto-calculate pay per hit: (Cache Sales - All Other Costs - Remaining) / Total War Hits
    const remainingPercentageSlider = document.getElementById('respectRemainingPercentage');
    const remainingPercentage = remainingPercentageSlider ? parseFloat(remainingPercentageSlider.value) / 100 : 0.3;
    const remaining = cacheSales * remainingPercentage;
    const availablePayout = cacheSales - remaining - totalCosts;
    const payPerWarHit = totalWarHits > 0 ? Math.round(availablePayout / totalWarHits) : 0;
    
    // Update the readonly input field
    if (respectPayPerHitInput) {
        respectPayPerHitInput.value = payPerWarHit.toLocaleString();
        respectPayPerHitInput.dataset.raw = payPerWarHit.toString();
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
    const filterLowFF = document.getElementById('respectFilterLowFF')?.checked;
    const minFFRating = parseFloat(document.getElementById('respectMinFFRating')?.value || '2.0');


    // Calculate respect-based payouts for each player
    const playersWithRespectPayouts = Object.values(playerStats).map(player => {

        // Use cached player respect data instead of processing all attacks again
        const playerIdStr = String(player.id);
        const playerData = playerRespectData[playerIdStr] || { warRespect: 0, outsideRespect: 0, warHits: 0, outsideHits: 0 };
        let playerWarRespect = playerData.warRespect;
        let playerOutsideRespect = playerData.outsideRespect;
        let playerWarHits = playerData.warHits;

        // Count low FF hits and adjust base respect if filtering is enabled
        let lowFFHits = 0;
        if (filterLowFF) {
            // Find all war hits for this player and check FF ratings
            const playerAttacks = warReportData.allAttacks.filter(attack => 
                String(attack.attacker?.id) === String(player.id) &&
                attack.modifiers?.war === 2 &&
                !attack.is_interrupted
            );
            
            lowFFHits = playerAttacks.filter(attack => 
                attack.modifiers?.fair_fight !== undefined && 
                attack.modifiers.fair_fight < minFFRating &&
                // Don't count retaliation hits (1.5) as low FF - they're good hits
                !(attack.modifiers?.retaliation && attack.modifiers.retaliation === 1.5)
            ).length;
            
            // Recalculate base respect excluding low FF hits
            if (lowFFHits > 0) {
                const lowFFAttacks = playerAttacks.filter(attack => 
                    attack.modifiers?.fair_fight !== undefined && 
                    attack.modifiers.fair_fight < minFFRating &&
                    // Don't count retaliation hits (1.5) as low FF - they're good hits
                    !(attack.modifiers?.retaliation && attack.modifiers.retaliation === 1.5)
                );
                
                let lowFFRespect = 0;
                lowFFAttacks.forEach(attack => {
                    const removeModifiers = document.getElementById('respectRemoveModifiers')?.checked;
                    lowFFRespect += calculateBaseRespect(attack, removeModifiers);
                });
                
                playerWarRespect -= lowFFRespect;
                playerWarHits -= lowFFHits;
            }
        }
        
        // Debug first few players
        if (player.name === 'iNico' || player.name === 'Jimidy' || player.name === 'Joe21') {

        }
        
        // Calculate additional payouts first (retaliations, assists, other attacks)
        // Note: Overseas hits with war modifier = 2 are already counted as war hits and get respect-based payouts
        // Overseas payouts are only for hit-based calculator, not respect-based
        let retalPayout = payRetals ? Math.round((player.warRetals || 0) * payPerWarHit * retalMultiplier) : 0;
        let assistPayout = payAssists ? Math.round((player.warAssists || 0) * payPerWarHit * assistMultiplier) : 0;
        let overseasPayout = 0; // Overseas hits are already counted in respect-based war hit payouts
        let otherAttacksPayout = payOtherAttacks ? Math.round(((player.totalAttacks - (player.warHits || 0) - (player.warAssists || 0)) * payPerWarHit * otherAttacksMultiplier)) : 0;
        
        // Add low FF hits payout at "Other Attacks" rate
        let lowFFPayout = 0;
        if (filterLowFF && lowFFHits > 0) {
            lowFFPayout = Math.round(lowFFHits * payPerWarHit * otherAttacksMultiplier);
        }

        // Check combined minimum requirement
        const combinedCount = (player.warHits || 0) + (player.warAssists || 0);
        if (enableCombinedMin && combinedCount < combinedMin) {
            retalPayout = 0;
            assistPayout = 0;
            overseasPayout = 0;
            otherAttacksPayout = 0;
            lowFFPayout = 0;
        }
        
        // Calculate respect ratio for this player (conditionally include outside respect)
        const totalPlayerRespect = includeOutsideRespect ? (playerWarRespect + playerOutsideRespect) : playerWarRespect;
        const totalRespect = includeOutsideRespect ? (totalBaseRespect + totalOutsideRespect) : totalBaseRespect;
        const respectRatio = totalRespect > 0 ? totalPlayerRespect / totalRespect : 0;
        
        // Initialize war hit payout (will be calculated in next step)
        let warHitPayout = 0;
        
        return {
            ...player,
            lowFFHits,
            playerWarRespect: Math.round(playerWarRespect), // Round for display
            playerOutsideRespect: Math.round(playerOutsideRespect), // Round for display
            respectRatio: respectRatio.toFixed(4),
            warHitPayout,
            retalPayout,
            assistPayout,
            overseasPayout,
            otherAttacksPayout,
            lowFFPayout,
            totalPayout: Math.round(warHitPayout + retalPayout + assistPayout + overseasPayout + otherAttacksPayout + lowFFPayout)
        };
    });

    // Calculate total additional payouts (retals, assists, overseas, other attacks, low FF hits)
    const totalAdditionalPayouts = playersWithRespectPayouts.reduce((sum, p) => 
        sum + p.retalPayout + p.assistPayout + p.overseasPayout + p.otherAttacksPayout + p.lowFFPayout, 0);
    
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
    
    // Calculate total respect of qualifying players (conditionally include outside respect)
    const totalQualifyingRespect = qualifyingPlayers.reduce((sum, p) => {
        const playerTotalRespect = includeOutsideRespect ? (p.playerWarRespect + p.playerOutsideRespect) : p.playerWarRespect;
        return sum + playerTotalRespect;
    }, 0);
    
    // Distribute remaining money proportionally based on respect
    qualifyingPlayers.forEach(player => {
        if (totalQualifyingRespect > 0) {
            const playerTotalRespect = includeOutsideRespect ? (player.playerWarRespect + player.playerOutsideRespect) : player.playerWarRespect;
            const respectShare = playerTotalRespect / totalQualifyingRespect;
            player.warHitPayout = Math.round(respectShare * respectDistributionPool);
        } else {
            player.warHitPayout = 0;
        }
        
        // Update total payout
        player.totalPayout = Math.round(player.warHitPayout + player.retalPayout + player.assistPayout + player.overseasPayout + player.otherAttacksPayout + player.lowFFPayout);
    });
    
    // Apply threshold-based payout adjustments if thresholds are enabled
    const enableThresholds = document.getElementById('respectEnableThresholds')?.checked || false;
    const minThreshold = parseFloat(document.getElementById('respectMinThreshold')?.value || '100');
    const maxThreshold = parseFloat(document.getElementById('respectMaxThreshold')?.value || '300');
    const payoutMode = document.querySelector('input[name="respectPayoutMode"]:checked')?.value || 'ratio';

    if (enableThresholds) {

        // Reset global variable for total adjusted respect calculation
        window._totalAdjustedRespect = null;
        
        // Calculate available payout
        const remainingPercentageSlider = document.getElementById('respectRemainingPercentage');
        const remainingPercentage = remainingPercentageSlider ? parseFloat(remainingPercentageSlider.value) / 100 : 0.3;
        const remaining = cacheSales * remainingPercentage;
        const availablePayout = cacheSales - remaining - totalCosts;
        
        // Find qualifying players (above minimum threshold)
        const qualifyingPlayers = playersWithRespectPayouts.filter(player => {
            const playerIdStr = String(player.id);
            const playerData = playerRespectData[playerIdStr] || { warRespect: 0, outsideRespect: 0 };
            const playerWarRespect = playerData.warRespect;
            const playerOutsideRespect = playerData.outsideRespect;
            const totalPlayerRespect = includeOutsideRespect ? (playerWarRespect + playerOutsideRespect) : playerWarRespect;
            
            return totalPlayerRespect >= minThreshold;
        });

        // Apply threshold logic to each player
        playersWithRespectPayouts.forEach(player => {
            const playerIdStr = String(player.id);
            const playerData = playerRespectData[playerIdStr] || { warRespect: 0, outsideRespect: 0 };
            const playerWarRespect = playerData.warRespect;
            const playerOutsideRespect = playerData.outsideRespect;
            const totalPlayerRespect = includeOutsideRespect ? (playerWarRespect + playerOutsideRespect) : playerWarRespect;
            
            if (totalPlayerRespect < minThreshold) {
                // Below minimum threshold - no war hit payout, but cap other modifiers at minimum threshold payout
                player.warHitPayout = 0;
                
                // Calculate what a player at minimum threshold would earn (for capping purposes)
                const minThresholdPlayerPayout = qualifyingPlayers.length > 0 ? 
                    (payoutMode === 'equal' ? 
                        Math.round(availablePayout / qualifyingPlayers.length) : 
                        Math.round((minThreshold / (window._totalAdjustedRespect || 1)) * availablePayout)
                    ) : 0;
                
                // Calculate total other modifiers payout
                const otherModifiersTotal = (player.retalPayout || 0) + (player.assistPayout || 0) + (player.overseasPayout || 0) + (player.otherAttacksPayout || 0) + (player.lowFFPayout || 0);
                
                // Cap other modifiers payout at minimum threshold amount
                if (otherModifiersTotal > minThresholdPlayerPayout) {
                    // Scale down all other modifiers proportionally to fit within the cap
                    const scaleFactor = minThresholdPlayerPayout / otherModifiersTotal;
                    player.retalPayout = Math.round((player.retalPayout || 0) * scaleFactor);
                    player.assistPayout = Math.round((player.assistPayout || 0) * scaleFactor);
                    player.overseasPayout = Math.round((player.overseasPayout || 0) * scaleFactor);
                    player.otherAttacksPayout = Math.round((player.otherAttacksPayout || 0) * scaleFactor);
                    player.lowFFPayout = Math.round((player.lowFFPayout || 0) * scaleFactor);

                } else {

                }
            } else {
                // Above minimum threshold - apply threshold logic and ignore other modifiers
                const adjustedRespect = Math.min(totalPlayerRespect, maxThreshold);
                
                // When player reaches minimum threshold, ignore all other modifiers (assists, retals, overseas, etc.)
                player.retalPayout = 0;
                player.assistPayout = 0;
                player.overseasPayout = 0;
                player.otherAttacksPayout = 0;
                player.lowFFPayout = 0;
                
                if (payoutMode === 'equal') {
                    // Equal payout: all qualifying players get the same amount
                    player.warHitPayout = qualifyingPlayers.length > 0 ? Math.round(availablePayout / qualifyingPlayers.length) : 0;

                } else {
                    // Ratio payout: proportional to adjusted respect within the threshold range
                    // Calculate total adjusted respect for all qualifying players ONCE (outside the loop)
                    if (!window._totalAdjustedRespect) {
                        window._totalAdjustedRespect = qualifyingPlayers.reduce((sum, p) => {
                            const pIdStr = String(p.id);
                            const pData = playerRespectData[pIdStr] || { warRespect: 0, outsideRespect: 0 };
                            const pWarRespect = pData.warRespect;
                            const pOutsideRespect = pData.outsideRespect;
                            const pTotalRespect = includeOutsideRespect ? (pWarRespect + pOutsideRespect) : pWarRespect;
                            return sum + Math.min(pTotalRespect, maxThreshold);
                        }, 0);

                    }
                    
                    const respectRatio = window._totalAdjustedRespect > 0 ? adjustedRespect / window._totalAdjustedRespect : 0;
                    player.warHitPayout = Math.round(respectRatio * availablePayout);

                }
            }
            
            // Recalculate total payout
            player.totalPayout = player.warHitPayout + (player.retalPayout || 0) + (player.assistPayout || 0) + (player.overseasPayout || 0) + (player.otherAttacksPayout || 0);
        });
    } else {

    }
    
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
            <p><strong>Total War ${removeModifiers ? 'Base' : 'Full'} Respect:</strong> ${Math.round(totalBaseRespect).toLocaleString()}</p>
            <p><strong>Total Outside ${removeModifiers ? 'Base' : 'Full'} Respect:</strong> ${Math.round(totalOutsideRespect).toLocaleString()} ${includeOutsideRespect ? '(Included)' : '(Excluded)'}</p>
            <p><strong>Total War Hits:</strong> ${totalWarHits.toLocaleString()}</p>
            <p><strong>Pay Per War Hit (Auto-calculated):</strong> $${Math.round(payPerWarHit).toLocaleString()}</p>
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
                    <th data-column="playerWarRespect" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">War ${removeModifiers ? 'Base' : 'Full'} Respect <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'playerWarRespect' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="playerOutsideRespect" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Outside ${removeModifiers ? 'Base' : 'Full'} Respect <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'playerOutsideRespect' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="respectRatio" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Respect % <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'respectRatio' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warRetals" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Retals <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'warRetals' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="warAssists" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Assists <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'warAssists' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                    <th data-column="overseasHits" style="cursor: pointer; background-color: #2d2d2d; color: #ffd700; padding: 10px; text-align: center; border-bottom: 1px solid #404040;">Abroad <span class="sort-indicator">${warReportData.respectPayoutSortState.column === 'overseasHits' ? (warReportData.respectPayoutSortState.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
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
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${player.playerWarRespect || 0}</td>
                            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;">${player.playerOutsideRespect || 0}</td>
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
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>${Math.round(totalBaseRespect)}</strong></td>
                    <td style="padding: 10px; text-align: center; border-bottom: 1px solid #404040;"><strong>${Math.round(totalOutsideRespect)}</strong></td>
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
        
        <!-- Chain Bonus Section -->
        ${(() => {
            // Collect all chain bonuses from all players
            const allChainBonuses = [];
            Object.entries(playerRespectData).forEach(([playerId, playerData]) => {
                if (playerData.chainBonuses && playerData.chainBonuses.length > 0) {
                    // Get player name from playerStats
                    const player = Object.values(playerStats).find(p => String(p.id) === playerId);
                    const playerName = player ? player.name : 'Unknown';
                    
                    playerData.chainBonuses.forEach(chainBonus => {
                        allChainBonuses.push({
                            ...chainBonus,
                            playerName: playerName
                        });
                    });
                }
            });
            
            if (allChainBonuses.length === 0) {
                return '';
            }
            
            // Sort by deduction amount (highest first)
            allChainBonuses.sort((a, b) => b.deduction - a.deduction);
            
            const totalDeductions = allChainBonuses.reduce((sum, bonus) => sum + bonus.deduction, 0);
            
            return `
                <div class="chain-bonus-section" style="margin-top: 20px; padding: 15px; background-color: #2a2a2a; border-radius: 8px; border: 1px solid #404040; border-left: 4px solid #ffd700;">
                    <h4 style="color: #ffd700; margin: 0 0 10px 0; font-size: 16px;">🔗 Chain Bonus Deductions</h4>
                    <p style="color: #ccc; margin: 0 0 10px 0; font-size: 14px;">
                        <strong>Total Deductions from Full Respect:</strong> <span style="color: #ff6b6b;">${totalDeductions.toLocaleString()}</span> points
                    </p>
                    <table style="width: auto; border-collapse: collapse; margin: 0;">
                        <tbody>
                            ${allChainBonuses.map(bonus => `
                                <tr>
                                    <td style="padding: 6px 12px 6px 0; color: #fff; font-weight: bold; white-space: nowrap;">${bonus.playerName}</td>
                                    <td style="padding: 6px 12px 6px 0; color: #ccc; font-size: 12px; white-space: nowrap;">${bonus.milestone} Hit (${bonus.points} points total)</td>
                                    <td style="padding: 6px 12px 6px 0; color: #ff6b6b; font-weight: bold; text-align: right; white-space: nowrap;">-${bonus.deduction}</td>
                                    <td style="padding: 6px 0; color: #999; font-size: 12px; white-space: nowrap;">${bonus.hitType || 'War Hit'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    <div style="margin-top: 10px; padding: 8px; background-color: #1a1a1a; border-radius: 4px; font-size: 12px; color: #999;">
                        💡 <strong>Note:</strong> Chain bonuses are deducted from Full Respect scores to show Base Respect. 
                        The deduction represents the extra respect gained beyond the base 10 points.
                    </div>
        </div>
            `;
        })()}
    `;
    respectPayoutTableDiv.innerHTML = tableHtml;
    
    // Add click event listeners for respect payout table sorting
    const respectTable = document.getElementById('respectPayoutTable');

    if (respectTable) {
        const headers = respectTable.querySelectorAll('th[data-column]');

        headers.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.getAttribute('data-column');

                if (warReportData.respectPayoutSortState.column === column) {
                    warReportData.respectPayoutSortState.direction = warReportData.respectPayoutSortState.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    warReportData.respectPayoutSortState.column = column;
                    warReportData.respectPayoutSortState.direction = column === 'name' ? 'asc' : 'desc';
                }

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
            
            // Show confirmation dialog
            showOpenLinksConfirmation(payLinks.length, () => {
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
            
                // Show completion message
                openAllRespectPayLinksBtn.textContent = `Opened ${payLinks.length} links!`;
                setTimeout(() => {
                    openAllRespectPayLinksBtn.textContent = 'Open All Links';
                }, 2000);
            });
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
    const cacheSales = parseInt(respectCacheSalesInput?.dataset.raw || respectCacheSalesInput?.value.replace(/[^\d.]/g, '') || '1000000000');
    const includeOutsideRespect = document.getElementById('respectIncludeOutside')?.checked;
    
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
    
    // Auto-calculate pay per war hit (based on war hits only)
    const payPerWarHit = totalWarHits > 0 ? Math.round((cacheSales * 0.7) / totalWarHits) : 0;
    
    const headers = [
        'Member',
        'Level',
        'War Hits',
        `War ${removeModifiers ? 'Base' : 'Full'} Respect`,
        `Outside ${removeModifiers ? 'Base' : 'Full'} Respect`,
        'Respect %',
        'Retals',
        'Assists',
        'Abroad',
        'Other Attacks',
        'Total Payout',
        'Pay link'
    ];
    let csvContent = headers.join(',') + '\r\n';
    
    // Calculate respect-based payouts and sort by total payout
    const playersWithRespectPayouts = Object.values(playerStats).map(player => {
        // Use cached player respect data instead of recalculating
        const playerIdStr = String(player.id);
        const playerData = playerRespectData[playerIdStr] || { warRespect: 0, outsideRespect: 0, warHits: 0, outsideHits: 0 };
        const playerWarRespect = playerData.warRespect;
        const playerOutsideRespect = playerData.outsideRespect;
        
        // Calculate proportional payout based on respect ratio (conditionally include outside)
        const totalPlayerRespect = includeOutsideRespect ? (playerWarRespect + playerOutsideRespect) : playerWarRespect;
        const totalRespect = includeOutsideRespect ? (totalBaseRespect + totalOutsideRespect) : totalBaseRespect;
        
        // Calculate basic respect ratio payout (will be adjusted later if thresholds are enabled)
        const respectRatio = totalRespect > 0 ? totalPlayerRespect / totalRespect : 0;
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
        
        // When thresholds are enabled and payout mode is equal, cap additional payouts at the minimum threshold payout
        let additionalPayoutCap = null;
        if (enableThresholds && payoutMode === 'equal' && adjustedTotalRespect > 0) {
            const qualifyingPlayers = playersWithRespectPayouts.filter(p => {
                const playerData = playerRespectData[p.id];
                const playerWarRespect = playerData?.warRespect || 0;
                const playerOutsideRespect = playerData?.outsideRespect || 0;
                const playerTotalRespect = includeOutsideRespect ? (playerWarRespect + playerOutsideRespect) : playerWarRespect;
                return playerTotalRespect >= minThreshold;
            });
            
            const remainingPercentageSlider = document.getElementById('respectRemainingPercentage');
            const remainingPercentage = remainingPercentageSlider ? parseFloat(remainingPercentageSlider.value) / 100 : 0.3;
            const remaining = cacheSales * remainingPercentage;
            const availablePayout = cacheSales - remaining - totalCosts;
            const qualifyingCount = qualifyingPlayers.length;
            additionalPayoutCap = qualifyingCount > 0 ? Math.round(availablePayout / qualifyingCount) : 0;
        } else if (enableThresholds && payoutMode === 'ratio') {
            // For ratio mode, cap additional payouts at the minimum threshold respect payout
            const minThresholdPayout = minThreshold / adjustedTotalRespect * (cacheSales - remaining - totalCosts);
            additionalPayoutCap = Math.round(minThresholdPayout);
        }
        
        let retalPayout = payRetals ? (player.warRetals || 0) * payPerWarHit * retalMultiplier : 0;
        let assistPayout = payAssists ? (player.warAssists || 0) * payPerWarHit * assistMultiplier : 0;
        let overseasPayout = payOverseas ? (player.overseasHits || 0) * payPerWarHit * overseasMultiplier : 0;
        let otherAttacksPayout = payOtherAttacks ? ((player.totalAttacks - (player.warHits || 0) - (player.warAssists || 0)) * payPerWarHit * otherAttacksMultiplier) : 0;
        
        // Apply cap to additional payouts when thresholds are enabled
        if (additionalPayoutCap !== null) {
            const totalAdditionalPayout = retalPayout + assistPayout + overseasPayout + otherAttacksPayout;
            const totalPayout = warHitPayout + totalAdditionalPayout;
            
            if (totalPayout > additionalPayoutCap) {
                // Cap the total payout, but maintain relative proportions of additional payouts
                const additionalPayoutRatio = totalAdditionalPayout > 0 ? additionalPayoutCap / totalAdditionalPayout : 1;
                retalPayout = Math.round(retalPayout * additionalPayoutRatio);
                assistPayout = Math.round(assistPayout * additionalPayoutRatio);
                overseasPayout = Math.round(overseasPayout * additionalPayoutRatio);
                otherAttacksPayout = Math.round(otherAttacksPayout * additionalPayoutRatio);
            }
        }
        
        const totalPayout = warHitPayout + retalPayout + assistPayout + overseasPayout + otherAttacksPayout;
        
        return {
            ...player,
            playerWarRespect: Math.round(playerWarRespect),
            playerOutsideRespect: Math.round(playerOutsideRespect),
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
            player.playerWarRespect || 0,
            player.playerOutsideRespect || 0,
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