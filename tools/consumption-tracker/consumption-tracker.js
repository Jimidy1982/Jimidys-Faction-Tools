console.log('[CONSUMPTION TRACKER] consumption-tracker.js LOADED');

// Global state for consumption tracker
let consumptionTrackerData = {
    fetchedMembers: [],
    sortState: { column: 'xanax', direction: 'desc' }
};

function initConsumptionTracker() {
    console.log('[CONSUMPTION TRACKER] initConsumptionTracker CALLED');
    
    // Log tool usage
    if (window.logToolUsage) {
        window.logToolUsage('consumption-tracker');
    }

    const fetchBtn = document.getElementById('fetchData');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', handleConsumptionFetch);
    }
    
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');

    if (startDateInput && endDateInput) {
        const startDatePicker = flatpickr(startDateInput, {
            dateFormat: "Y-m-d",
            defaultDate: "today",
            locale: {
                firstDayOfWeek: 1
            }
        });
        flatpickr(endDateInput, {
            dateFormat: "Y-m-d",
            defaultDate: "today",
            locale: {
                firstDayOfWeek: 1
            }
        });
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
    
    const factionIdInput = document.getElementById('factionId');
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');
    const loadingSpinner = document.getElementById('loadingSpinner');
    const fetchBtn = document.getElementById('fetchData');
    const resultsSection = document.querySelector('.results-section');

    // No faction ID needed - the API key determines the faction

    // Handle date range
    let startDate = startDateInput.value;
    let endDate = endDateInput.value;
    
    // If no end date provided, default to today
    if (!endDate) {
        endDate = new Date().toISOString().split('T')[0];
        console.log(`No end date provided, using default: ${endDate}`);
    }

    // Convert end date to timestamp (use local time to avoid timezone issues)
    const toTimestamp = Math.floor(new Date(endDate + 'T23:59:59').getTime() / 1000);
    
    // If no start date provided, use a reasonable default
    let fromTimestamp = null;
    if (startDate) {
        fromTimestamp = Math.floor(new Date(startDate + 'T00:00:00').getTime() / 1000);
        console.log(`Using provided start date: ${startDate} (${fromTimestamp})`);
    } else {
        // Default to 30 days ago if no start date provided
        fromTimestamp = Math.floor((Date.now() - (30 * 24 * 60 * 60 * 1000)) / 1000);
        console.log(`No start date provided, using 30 days ago: ${fromTimestamp}`);
    }
    
    console.log(`Final date range: ${fromTimestamp} to ${toTimestamp}`);
    console.log(`Final date range (human readable): ${new Date(fromTimestamp * 1000).toLocaleDateString()} to ${new Date(toTimestamp * 1000).toLocaleDateString()}`);

    try {
        if (loadingSpinner) loadingSpinner.style.display = 'inline-block';
        if (fetchBtn) fetchBtn.disabled = true;

        console.log('Fetching consumption data for faction (from API key)');
        console.log('Date range:', new Date(fromTimestamp * 1000).toLocaleDateString(), 'to', new Date(toTimestamp * 1000).toLocaleDateString());
        
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
        
        // Get rate limit setting
        const rateLimitSelect = document.getElementById('rateLimit');
        const rateLimit = rateLimitSelect ? parseInt(rateLimitSelect.value) : 60;
        const delayBetweenCalls = Math.floor(60000 / rateLimit); // Convert to milliseconds
        
        console.log(`Using rate limit: ${rateLimit} calls per minute (${delayBetweenCalls}ms between calls)`);
        
        // Step 1: Fetch faction news (armory actions) for the date range with proper pagination
        console.log('Fetching faction armory actions...');
        
        // Show progress bar
        const progressContainer = document.getElementById('progressContainer');
        const progressMessage = document.getElementById('progressMessage');
        const progressPercentage = document.getElementById('progressPercentage');
        const progressFill = document.getElementById('progressFill');
        const progressDetails = document.getElementById('progressDetails');
        
        // Calculate date range in days
        const daysDiff = Math.ceil((toTimestamp - fromTimestamp) / (24 * 60 * 60));
        
        if (progressContainer) {
            progressContainer.style.display = 'block';
            if (daysDiff > 30) {
                progressMessage.textContent = `Fetching consumption data for ${daysDiff} days (this may take a while)...`;
            } else if (daysDiff > 7) {
                progressMessage.textContent = `Fetching consumption data for ${daysDiff} days...`;
            } else {
                progressMessage.textContent = 'Fetching consumption data...';
            }
            progressDetails.textContent = 'Initializing...';
        }
        
        let allNews = [];
        let seenEntryIds = new Set(); // Track unique entry IDs to prevent duplicates
        let currentPage = 0;
        let hasMorePages = true;
        let lastTimestamp = toTimestamp; // Start from the end timestamp
        
        while (hasMorePages) { // Continue until no more pages
            currentPage++;
            console.log(`Fetching page ${currentPage}...`);
            
            // Update progress
            if (progressContainer) {
                const timeProgress = Math.max(0, Math.min(100, ((toTimestamp - lastTimestamp) / (toTimestamp - fromTimestamp)) * 100));
                progressPercentage.textContent = `${Math.round(timeProgress)}%`;
                progressFill.style.width = `${timeProgress}%`;
                progressDetails.textContent = `Processing page ${currentPage}... (${allNews.length} entries found)`;
            }
            
            // Safety check to prevent infinite loops (max 100 pages = 10,000 entries)
            if (currentPage > 100) {
                console.warn(`Reached maximum page limit (100), stopping pagination. This might indicate an issue with the API response.`);
                break;
            }
            
            const newsResponse = await fetch(`https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&to=${lastTimestamp}&from=${fromTimestamp}&cat=armoryAction&key=${apiKey}`);
            const newsData = await newsResponse.json();
            
            if (newsData.error) {
                throw new Error(`Faction news API error: ${newsData.error.error}`);
            }
            
            const news = newsData.news || [];
            console.log(`Page ${currentPage}: Found ${news.length} armory action entries`);
            
            if (news.length === 0) {
                console.log(`Page ${currentPage}: No more entries found, stopping pagination`);
                hasMorePages = false;
            } else {
                // Filter out entries we've already seen (older than our date range) and deduplicate
                const newEntries = news.filter(entry => {
                    const entryTimestamp = entry.timestamp;
                    const isInDateRange = entryTimestamp >= fromTimestamp && entryTimestamp <= toTimestamp;
                    
                    // Check if we've already seen this entry ID
                    const isDuplicate = seenEntryIds.has(entry.id);
                    
                    if (isInDateRange && !isDuplicate) {
                        seenEntryIds.add(entry.id);
                        return true;
                    }
                    return false;
                });
                
                console.log(`Page ${currentPage}: ${newEntries.length} unique entries within date range`);
                
                if (newEntries.length === 0) {
                    hasMorePages = false;
                } else {
                    allNews = allNews.concat(newEntries);
                    
                    // Update lastTimestamp to the oldest timestamp in this batch for next page
                    const oldestTimestamp = Math.min(...news.map(entry => entry.timestamp));
                    lastTimestamp = oldestTimestamp - 1; // Go back one second to avoid overlap
                    
                    // Check if we've gone past our date range
                    if (oldestTimestamp < fromTimestamp) {
                        console.log(`Page ${currentPage}: Oldest timestamp ${new Date(oldestTimestamp * 1000).toLocaleString()} is before our date range, stopping pagination`);
                        hasMorePages = false;
                    } else {
                        // Rate limiting: wait based on user's rate limit setting
                        await new Promise(resolve => setTimeout(resolve, delayBetweenCalls));
                    }
                }
            }
        }
        
        console.log(`Total: Found ${allNews.length} unique armory action entries across ${currentPage} pages`);
        console.log(`Unique entry IDs tracked: ${seenEntryIds.size}`);
        console.log(`Date range covered: ${new Date(Math.min(...allNews.map(n => n.timestamp)) * 1000).toLocaleString()} to ${new Date(Math.max(...allNews.map(n => n.timestamp)) * 1000).toLocaleString()}`);
        
        // Update progress for processing phase
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
        
        // Debug tracking for ingine's xanax usage
        const ingineXanaxEntries = [];
        
        for (const newsEntry of allNews) {
            processedCount++;
            if (processedCount % 10 === 0) {
                console.log(`Processed ${processedCount}/${allNews.length} entries...`);
                
                // Update processing progress
                if (progressContainer) {
                    const processingProgress = (processedCount / allNews.length) * 100;
                    progressDetails.textContent = `Processing ${processedCount}/${allNews.length} entries...`;
                }
            }
            
            const logText = newsEntry.text || '';
            const timestamp = newsEntry.timestamp;
            
            // Debug: Log a few entries to see the format
            if (processedCount <= 3) {
                console.log(`Sample entry ${processedCount}:`, logText);
            }
            
            
            // Extract player name and ID from the log text (handles HTML tags)
            // Format: "<a href="http://www.torn.com/profiles.php?XID=1234567">PlayerName</a> used one of the faction's ItemName items"
            const playerMatch = logText.match(/<a href[^>]*XID=(\d+)[^>]*>([^<]+)<\/a>/);
            if (!playerMatch) {
                console.log(`Skipping entry - no player match:`, logText);
                continue;
            }
            
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
                
                // Debug: Track ingine's xanax usage
                if (playerName.toLowerCase() === 'ingine') {
                    ingineXanaxEntries.push({
                        entryId: newsEntry.id,
                        timestamp: newsEntry.timestamp,
                        date: new Date(newsEntry.timestamp * 1000).toLocaleString(),
                        logText: logText,
                        currentCount: playerConsumption[playerName].xanax
                    });
                    console.log(`[INGINE DEBUG] Xanax #${playerConsumption[playerName].xanax}: Entry ID ${newsEntry.id}, Date: ${new Date(newsEntry.timestamp * 1000).toLocaleString()}, Text: "${logText}"`);
                }
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
        
        console.log(`Finished processing ${processedCount} entries. Found ${Object.keys(playerConsumption).length} players with consumption.`);
        
        // Debug: Log some sample consumption data
        const playerNames = Object.keys(playerConsumption);
        if (playerNames.length > 0) {
            console.log('Sample player consumption data:');
            const samplePlayer = playerNames[0];
            console.log(`${samplePlayer}:`, playerConsumption[samplePlayer]);
        }
        
        // Debug: Summary of ingine's xanax usage
        if (ingineXanaxEntries.length > 0) {
            console.log(`\n[INGINE DEBUG SUMMARY] Found ${ingineXanaxEntries.length} xanax entries for ingine:`);
            ingineXanaxEntries.forEach((entry, index) => {
                console.log(`  ${index + 1}. Entry ID: ${entry.entryId}, Date: ${entry.date}, Count: ${entry.currentCount}`);
                console.log(`     Text: "${entry.logText}"`);
            });
            
            // Check for duplicate entry IDs
            const entryIds = ingineXanaxEntries.map(e => e.entryId);
            const uniqueIds = new Set(entryIds);
            if (entryIds.length !== uniqueIds.size) {
                console.log(`[INGINE DEBUG WARNING] Found ${entryIds.length - uniqueIds.size} duplicate entry IDs!`);
                const duplicates = entryIds.filter((id, index) => entryIds.indexOf(id) !== index);
                console.log(`[INGINE DEBUG] Duplicate IDs:`, duplicates);
            } else {
                console.log(`[INGINE DEBUG] All ${entryIds.length} entry IDs are unique.`);
            }
        } else {
            console.log('[INGINE DEBUG] No xanax entries found for ingine.');
        }
        
        const consumptionMembers = Object.values(playerConsumption);
        console.log(`Final consumption members array length: ${consumptionMembers.length}`);
        
        // Store the fetched data
        consumptionTrackerData.fetchedMembers = consumptionMembers;
        
        const totalTime = performance.now() - startTime;
        
        console.log(`About to update UI with ${consumptionMembers.length} members, total time: ${totalTime.toFixed(2)}ms`);
        
        // Store item values for UI
        consumptionTrackerData.itemValues = itemValues;
        
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
    console.log(`updateConsumptionUI called with ${members.length} members`);
    console.log('Sample member data:', members[0]);
    console.log('Item types:', itemTypes);
    
    // Store data globally for CSV export
    consumptionTrackerData = {
        members: members,
        totalTime: totalTime,
        cacheStats: cacheStats,
        wasCached: wasCached,
        itemValues: itemValues,
        fromTimestamp: fromTimestamp,
        toTimestamp: toTimestamp,
        itemTypes: itemTypes
    };
    
    const resultsSection = document.querySelector('.results-section');
    const tableContainer = document.getElementById('membersTable');
    
    if (!resultsSection || !tableContainer) {
        console.error('Required elements not found:', {
            resultsSection: !!resultsSection,
            tableContainer: !!tableContainer
        });
        return;
    }
    
    console.log('Table container found:', !!tableContainer);
    
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
    
    console.log('Grouped items:', groupedItems);
    
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
    
    // Calculate date range
    const startDate = new Date(fromTimestamp * 1000).toLocaleDateString();
    const endDate = new Date(toTimestamp * 1000).toLocaleDateString();
    
    // Calculate total value
    const totalValue = Object.values(totalValues).reduce((sum, cost) => sum + cost, 0);
    
    // Create summary grid with group totals
    let summaryHTML = `
        <div class="summary-grid">
            <div class="summary-item">
                <span class="summary-label">Date Range:</span>
                <span class="summary-value">${startDate} to ${endDate}</span>
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
                   const statsHTML = col.isPoints && itemPrice > 0
                       ? `<span class="item-total">Total: ${itemTotal} points</span>
                          <span class="item-value">Value: $${itemValue.toLocaleString()}</span>
                          <span class="item-price">Price: $${itemPrice.toLocaleString()} per point</span>`
                       : col.isPoints
                       ? `<span class="item-total">Total: ${itemTotal} points</span>`
                       : `<span class="item-total">Total: ${itemTotal}</span>
                          <span class="item-value">Value: $${itemValue.toLocaleString()}</span>
                          <span class="item-price">Price: $${itemPrice.toLocaleString()}</span>`;
                   
                   itemSection.innerHTML = `
                       <div class="item-header">
                           <div class="item-info">
                               <h4 class="item-name">${col.label}</h4>
                               <div class="item-stats">
                                   ${statsHTML}
                               </div>
                           </div>
                           <div class="item-players">
                               <button class="players-toggle" data-item="${col.id}">
                                   Players (${playersWhoUsed.length})
                               </button>
                           </div>
                       </div>
                       <div class="players-list" data-item="${col.id}" style="display: none;">
                           ${playersWhoUsed.map(player => {
                               const quantity = player[col.id];
                               const costHTML = col.isPoints && itemPrice > 0
                                   ? `<span class="player-cost">$${(quantity * itemPrice).toLocaleString()}</span>`
                                   : col.isPoints
                                   ? `<span class="player-cost">${quantity} points</span>`
                                   : `<span class="player-cost">$${(quantity * itemPrice).toLocaleString()}</span>`;
                               return `
                               <div class="player-item">
                                   <a href="https://www.torn.com/profiles.php?XID=${player.id}" target="_blank" class="player-link">
                                       ${player.name}
                                   </a>
                                   <span class="player-quantity">${quantity}</span>
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
               console.log('Table container before clearing:', tableContainer.innerHTML.length, 'characters');
               tableContainer.innerHTML = '';
               tableContainer.appendChild(summarySection);
               tableContainer.appendChild(groupedContainer);
               console.log('Grouped interface added to container successfully');
               console.log('Table container after adding:', tableContainer.innerHTML.length, 'characters');
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

    const members = consumptionTrackerData.fetchedMembers;
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
        const itemValue = col.isPoints ? 0 : (itemValues[col.itemName] || 0);
        totalValues[col.id] = totals[col.id] * itemValue;
    });
    
    const grandTotal = Object.values(totalValues).reduce((sum, cost) => sum + cost, 0);
    
    // Create CSV content with cost data
    const headers = ['Member Name', ...columns.map(col => col.label)];
    const costHeaders = ['', ...columns.map(col => {
        if (col.isPoints) {
            const pointsPrice = itemValues['Points'] || 0;
            return pointsPrice > 0 ? `$${pointsPrice.toLocaleString()}` : 'N/A';
        }
        return `$${itemValues[col.itemName] || 0}`;
    })];
    const totalsRow = ['TOTALS', ...columns.map(col => totals[col.id])];
    const costRow = ['TOTAL COST', ...columns.map(col => `$${totalValues[col.id].toLocaleString()}`)];
    const grandTotalRow = ['GRAND TOTAL', ...Array(columns.length - 1).fill(''), `$${grandTotal.toLocaleString()}`];
    
    const csvContent = [
        headers.join(','),
        costHeaders.join(','),
        ...members.map(member => [
            `"${member.name}"`,
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
    
    // Define columns
    const columns = [
        { id: 'xanax', label: 'Xanax', itemName: 'Xanax' },
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
        { id: 'santaShot', label: 'Can of Santa Shot', itemName: 'Can of Santa Shot' },
        { id: 'munster', label: 'Can of Munster', itemName: 'Can of Munster' },
        { id: 'redCow', label: 'Can of Red Cow', itemName: 'Can of Red Cow' },
        { id: 'rockstar', label: 'Can of Rockstar', itemName: 'Can of Rockstar' },
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
    
    // Create CSV content
    const startDate = new Date(fromTimestamp * 1000).toLocaleDateString();
    const endDate = new Date(toTimestamp * 1000).toLocaleDateString();
    
    let csvContent = `Consumption Tracker - Grouped Items\n`;
    csvContent += `Date Range: ${startDate} to ${endDate}\n\n`;
    
    Object.keys(groupedItems).forEach(groupType => {
        csvContent += `${groupType}\n`;
        // For points, show price/value if market value is available
        const pointsPrice = itemValues['Points'] || 0;
        const headerRow = (groupType === 'Points' && pointsPrice === 0)
            ? `Item,Total Usage\n`
            : `Item,Total Usage,Unit Price,Total Value\n`;
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
                    csvContent += `"${col.label}",${total},$${price.toLocaleString()},$${value.toLocaleString()}\n`;
                } else {
                    csvContent += `"${col.label}",${total}\n`;
                }
            } else {
                const price = itemValues[col.itemName] || 0;
                const value = totalValues[col.id];
                groupTotal += value;
                csvContent += `"${col.label}",${total},$${price.toLocaleString()},$${value.toLocaleString()}\n`;
            }
        });
        
        if (groupType === 'Points' && pointsPrice === 0) {
            csvContent += `\n`;
        } else {
            csvContent += `Group Total,,,$${groupTotal.toLocaleString()}\n\n`;
        }
    });
    
    // Create and download the CSV file
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `consumption-grouped-${startDate}-${endDate}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Export players data to CSV
function exportPlayersToCSV() {
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
    
    // Create CSV content
    const startDate = new Date(fromTimestamp * 1000).toLocaleDateString();
    const endDate = new Date(toTimestamp * 1000).toLocaleDateString();
    
    let csvContent = `Consumption Tracker - Player Details\n`;
    csvContent += `Date Range: ${startDate} to ${endDate}\n\n`;
    
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
            csvContent += `${col.label} (Qty),${col.label} (Cost),`;
        }
    });
    csvContent += `Total Value\n`;
    
    // Player rows
    members.forEach(member => {
        csvContent += `"${member.name}",`;
        let playerTotal = 0;
        
        Object.values(itemsWithUsage).forEach(col => {
            const quantity = member[col.id] || 0;
            if (col.isPoints) {
                const price = itemValues['Points'] || 0;
                if (price > 0) {
                    const cost = quantity * price;
                    playerTotal += cost;
                    csvContent += `${quantity},$${cost.toLocaleString()},`;
                } else {
                    csvContent += `${quantity},`;
                }
            } else {
                const price = itemValues[col.itemName] || 0;
                const cost = quantity * price;
                playerTotal += cost;
                csvContent += `${quantity},$${cost.toLocaleString()},`;
            }
        });
        
        csvContent += `$${playerTotal.toLocaleString()}\n`;
    });
    
    // Totals row
    const totals = {};
    const totalValues = {};
    columns.forEach(col => {
        totals[col.id] = members.reduce((sum, member) => sum + (member[col.id] || 0), 0);
        const itemValue = col.isPoints ? 0 : (itemValues[col.itemName] || 0);
        totalValues[col.id] = totals[col.id] * itemValue;
    });
    
    const grandTotal = Object.values(totalValues).reduce((sum, cost) => sum + cost, 0);
    
    csvContent += `TOTALS,`;
    Object.values(itemsWithUsage).forEach(col => {
        if (col.isPoints) {
            const price = itemValues['Points'] || 0;
            if (price > 0) {
                csvContent += `${totals[col.id]},$${totalValues[col.id].toLocaleString()},`;
            } else {
                csvContent += `${totals[col.id]},`;
            }
        } else {
            csvContent += `${totals[col.id]},$${totalValues[col.id].toLocaleString()},`;
        }
    });
    csvContent += `$${grandTotal.toLocaleString()}\n`;
    
    // Create and download the CSV file
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `consumption-players-${startDate}-${endDate}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

console.log('[CONSUMPTION TRACKER] Script loaded'); 