/**
 * On localhost, the Torn API does not send Access-Control-Allow-Origin, so direct fetch() fails.
 * Vite proxies /.torn-api-proxy → https://api.torn.com (see vite.config.js).
 */
(function registerTornApiDevProxyUrl() {
    window.getTornApiFetchUrl = function (url) {
        if (!url || typeof url !== 'string') return url;
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
    };
})();

document.addEventListener('DOMContentLoaded', () => {
    const appContent = document.getElementById('app-content');

    // Contact link for feedback (Torn profile XID)
    const CONTACT_TORN_PROFILE_ID = 2935825;
    const contactLink = document.getElementById('contactProfileLink');
    if (contactLink) {
        contactLink.href = `https://www.torn.com/profiles.php?XID=${CONTACT_TORN_PROFILE_ID}`;
    }

    /** Format decimal hours as H:MM (e.g. 1.5 -> "1:30"). Returns "-" for null/invalid. */
    function formatHoursMinutes(decimalHours) {
        if (decimalHours == null || typeof decimalHours !== 'number' || isNaN(decimalHours) || decimalHours < 0) return '-';
        let h = Math.floor(decimalHours);
        let m = Math.round((decimalHours - h) * 60);
        if (m >= 60) { m = 0; h += 1; }
        return h + ':' + String(m).padStart(2, '0');
    }

    // API key help tooltip: show on hover (CSS) and toggle on click/tap for mobile
    const apiKeyHelp = document.getElementById('apiKeyHelp');
    if (apiKeyHelp) {
        apiKeyHelp.addEventListener('click', (e) => {
            e.preventDefault();
            apiKeyHelp.classList.toggle('is-visible');
        });
        document.addEventListener('click', (e) => {
            if (apiKeyHelp.classList.contains('is-visible') && !apiKeyHelp.contains(e.target)) {
                apiKeyHelp.classList.remove('is-visible');
            }
        });
    }

    // Admin system
    const ADMIN_USER_IDS = [2935825, 2093859]; // Admin user IDs (Jimidy, Havean)
    const ADMIN_USER_NAMES = ['Jimidy', 'Havean']; // Admin usernames to exclude from results
    const ADMIN_USER_NAME = 'Jimidy'; // Your username to exclude from results (keeping for backward compatibility)
    let userCache = {}; // Cache for API key -> user data
    let showAdminData = false; // Global toggle for showing admin data
    
    // Dynamic rate limiting: Track API call timestamps in rolling 60-second window
    window.apiCallTracker = window.apiCallTracker || [];
    
    // User-configurable rate limit (stored in localStorage, default 90)
    const getRateLimit = () => {
        const stored = localStorage.getItem('tornApiRateLimit');
        return stored ? parseInt(stored, 10) : 90; // Default to 90 (safety margin)
    };
    
    const setRateLimit = (limit) => {
        localStorage.setItem('tornApiRateLimit', limit.toString());
        // Update the interval calculation
        window.CALL_INTERVAL_MS = (60 * 1000) / limit; // Dynamic interval based on rate limit
    };
    
    // Initialize rate limit from storage or default
    setRateLimit(getRateLimit()); // This also sets CALL_INTERVAL_MS
    
    // Function to clean old timestamps (older than 60 seconds)
    const cleanOldCalls = () => {
        const now = Date.now();
        window.apiCallTracker = window.apiCallTracker.filter(timestamp => (now - timestamp) < 60000);
    };
    
    // Function to get calls made in the last 60 seconds
    const getCallsInLastMinute = () => {
        cleanOldCalls();
        return window.apiCallTracker.length;
    };
    
    // Function to calculate how many calls can be made immediately
    const calculateAvailableCalls = () => {
        cleanOldCalls();
        const callsInLastMinute = window.apiCallTracker.length;
        const currentRateLimit = getRateLimit(); // Get current rate limit (may have changed)
        
        if (callsInLastMinute === 0) {
            // No calls in last minute, can make full batch
            return currentRateLimit;
        }
        
        if (window.apiCallTracker.length === 0) {
            return currentRateLimit;
        }
        
        // Find the oldest call in the tracker
        const oldestCall = Math.min(...window.apiCallTracker);
        const timeSinceOldestCall = Date.now() - oldestCall;
        const secondsRemaining = Math.max(0, 60 - (timeSinceOldestCall / 1000));
        
        // Calculate total remaining capacity in the minute window
        const remainingCapacity = currentRateLimit - callsInLastMinute;
        
        if (remainingCapacity <= 0) {
            // Already at or over limit, need to wait
            return 0;
        }
        
        // We can make calls immediately up to the remaining capacity
        // We don't need to reserve gradual capacity - we'll slow down naturally as we approach the limit
        // Be more aggressive: use most of the remaining capacity immediately
        // Reserve only a small buffer (10%) for gradual calls
        const buffer = Math.ceil(remainingCapacity * 0.1); // 10% buffer
        const availableImmediate = Math.max(0, remainingCapacity - buffer);
        
        return availableImmediate;
    };
    
    // Function to record an API call
    const recordApiCall = () => {
        window.apiCallTracker.push(Date.now());
        cleanOldCalls();
    };

    /** Seconds to wait before retrying after Torn rate-limit — uses same rolling window as preemptive limiter (respects user’s calls/min setting). */
    const getRollingWindowRateLimitWaitSeconds = () => {
        cleanOldCalls();
        if (!window.apiCallTracker.length) return 2;
        const oldestCall = Math.min(...window.apiCallTracker);
        const msLeft = 60000 - (Date.now() - oldestCall);
        return Math.min(60, Math.max(1, Math.ceil(msLeft / 1000)));
    };
    
    // ==================== GLOBAL BATCH API CALLS WITH RATE LIMITING ====================
    /**
     * Helper function for single API call with dynamic rate limiting
     * Useful for dynamic loops where the number of requests is unknown upfront
     * 
     * @param {string} url - The URL to fetch
     * @param {Object} options - Configuration options
     * @param {HTMLElement} options.progressMessage - Element to display progress message
     * @param {HTMLElement} options.progressDetails - Element to display detailed progress
     * @param {boolean} options.retryOnRateLimit - Whether to retry on rate limit errors (default: true)
     * @param {number} options.retryDelay - Delay before retry in ms (default: 30000)
     * @returns {Promise<Object>} The JSON response data
     */
    window.fetchWithRateLimit = async (url, options = {}) => {
        const {
            progressMessage,
            progressDetails,
            retryOnRateLimit = true,
            retryDelay = 30000
        } = options;
        
        // Dynamic rate limiting logic
        const currentCallsInLastMinute = getCallsInLastMinute();
        const currentRateLimit = getRateLimit();
        
        if (currentCallsInLastMinute >= currentRateLimit) {
            // We've hit the limit, need to wait
            const oldestCall = Math.min(...window.apiCallTracker);
            const timeSinceOldestCall = Date.now() - oldestCall;
            const waitTime = Math.ceil(60000 - timeSinceOldestCall);
            
            if (progressMessage) {
                progressMessage.textContent = 'Waiting for API Limit...';
            }
            if (progressDetails) {
                progressDetails.textContent = `API rate limit reached, waiting ${Math.ceil(waitTime / 1000)} seconds...`;
            }
            
            // Countdown
            const waitSeconds = Math.ceil(waitTime / 1000);
            for (let j = waitSeconds; j > 0; j--) {
                if (progressDetails) {
                    progressDetails.textContent = `API rate limit reached, waiting ${j} seconds...`;
                }
                await sleep(1000);
            }
            
            if (progressMessage) {
                progressMessage.textContent = 'Fetching data...';
            }
            if (progressDetails) {
                progressDetails.textContent = 'Resuming data collection...';
            }
            } else {
                const availableImmediate = calculateAvailableCalls();
                if (availableImmediate <= 0) {
                    // Need to wait a bit before making the call
                    await sleep(window.CALL_INTERVAL_MS);
                }
            }
        
        // Make the API call (localhost: use Vite /.torn-api-proxy to avoid Torn CORS)
        const tornFetchUrl = typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(url) : url;
        try {
            const response = await fetch(tornFetchUrl);
            const data = await response.json();
            
            if (data.error) {
                // Check for rate limit error
                if ((data.error.error === 'Too many requests' || data.code === 2) && retryOnRateLimit) {
                    if (progressMessage) {
                        progressMessage.textContent = 'Waiting for API Limit...';
                    }
                    const waitSeconds = getRollingWindowRateLimitWaitSeconds();
                    for (let j = waitSeconds; j > 0; j--) {
                        if (progressDetails) {
                            progressDetails.textContent = `API rate limit (server) — resuming in ${j}s…`;
                        }
                        await sleep(1000);
                    }
                    if (progressMessage) {
                        progressMessage.textContent = 'Fetching data...';
                    }
                    if (progressDetails) {
                        progressDetails.textContent = 'Resuming data collection...';
                    }

                    // Retry once
                    const retryResponse = await fetch(tornFetchUrl);
                    const retryData = await retryResponse.json();
                    
                    if (retryData.error) {
                        throw new Error(`API Error after retry: ${retryData.error.error || retryData.error}`);
                    }
                    
                    recordApiCall();
                    return retryData;
                }
                
                throw new Error(`API Error: ${data.error.error || data.error}`);
            }
            
            recordApiCall();
            return data;
        } catch (error) {
            // Re-throw fetch errors
            throw error;
        }
    };
    
    /**
     * Global function for batch API calls with dynamic rate limiting
     * Can be used by any tool that needs to make multiple Torn API calls
     * 
     * @param {Array} requests - Array of request objects or URLs. If objects, should have `url` property. Can also include `id`, `cacheKey`, or other metadata.
     * @param {Object} options - Configuration options
     * @param {Function} options.onProgress - Callback for progress updates: (current, total, successful) => void
     * @param {HTMLElement} options.progressMessage - Element to display progress message
     * @param {HTMLElement} options.progressDetails - Element to display detailed progress
     * @param {HTMLElement} options.progressPercentage - Element to display percentage
     * @param {HTMLElement} options.progressFill - Element for progress bar fill
     * @param {Function} options.onSuccess - Callback for each successful request: (response, request, index) => void
     * @param {Function} options.onError - Callback for errors: (error, request, index) => void
     * @param {boolean} options.retryOnRateLimit - Whether to retry on rate limit errors (default: true)
     * @param {number} options.retryDelay - Delay before retry in ms (default: 30000)
     * @param {boolean} options.useCache - Whether to use caching (default: false). If true, requests should have `cacheKey` property.
     * @param {Function} options.getCache - Optional custom cache getter function: (cacheKey) => cachedData
     * @param {Function} options.setCache - Optional custom cache setter function: (cacheKey, data) => void
     * @returns {Promise<Array>} Array of results in the same order as requests
     */
    window.batchApiCallsWithRateLimit = async (requests, options = {}) => {
        const {
            onProgress,
            progressMessage,
            progressDetails,
            progressPercentage,
            progressFill,
            onSuccess,
            onError,
            retryOnRateLimit = true,
            retryDelay = 30000,
            useCache = false,
            getCache = null,
            setCache = null
        } = options;
        
        // Use provided cache functions or default to global cache
        const cacheGet = getCache || (useCache ? getCachedData : null);
        const cacheSet = setCache || (useCache ? setCachedData : null);
        
        const results = [];
        let successfulCount = 0;
        let immediateBatchSize = calculateAvailableCalls();
        let callsInImmediateBatch = 0;
        
        // Check cache first if caching is enabled
        const uncachedRequests = [];
        const cachedResults = [];
        
        if (useCache && cacheGet) {
            requests.forEach((request, index) => {
                const cacheKey = request.cacheKey || request.url;
                const cached = cacheGet(cacheKey);
                if (cached) {
                    cachedResults[index] = { success: true, data: cached, request };
                    if (onSuccess) onSuccess(cached, request, index);
                } else {
                    uncachedRequests.push({ request, originalIndex: index });
                }
            });
        } else {
            // No caching, process all requests
            requests.forEach((request, index) => {
                uncachedRequests.push({ request, originalIndex: index });
            });
        }
        
        // Process uncached requests
        for (let i = 0; i < uncachedRequests.length; i++) {
            const { request, originalIndex } = uncachedRequests[i];
            const url = typeof request === 'string' ? request : request.url;
            const requestId = request.id || request.playerId || originalIndex;
            
            // Update progress (based on total requests, not just uncached)
            const progress = ((originalIndex + 1) / requests.length) * 100;
            if (progressPercentage) {
                progressPercentage.textContent = `${Math.round(progress)}%`;
            }
            if (progressFill) {
                progressFill.style.width = `${progress}%`;
            }
            if (progressDetails) {
                progressDetails.textContent = `Processing request ${originalIndex + 1}/${requests.length} (${successfulCount + cachedResults.length} successful)`;
            }
            if (onProgress) {
                onProgress(originalIndex + 1, requests.length, successfulCount + cachedResults.length);
            }
            
        // Dynamic rate limiting logic
        const currentCallsInLastMinute = getCallsInLastMinute();
        const currentRateLimit = getRateLimit();
        
        if (currentCallsInLastMinute >= currentRateLimit) {
                // We've hit the limit, need to wait
                const oldestCall = Math.min(...window.apiCallTracker);
                const timeSinceOldestCall = Date.now() - oldestCall;
                const waitTime = Math.ceil(60000 - timeSinceOldestCall);
                
                if (progressMessage) {
                    progressMessage.textContent = 'Waiting for API Limit...';
                }
                if (progressDetails) {
                    progressDetails.textContent = `API rate limit reached, waiting ${Math.ceil(waitTime / 1000)} seconds...`;
                }
                
                // Countdown
                const waitSeconds = Math.ceil(waitTime / 1000);
                for (let j = waitSeconds; j > 0; j--) {
                    if (progressDetails) {
                        progressDetails.textContent = `API rate limit reached, waiting ${j} seconds...`;
                    }
                    await sleep(1000);
                }
                
                // Recalculate after waiting
                immediateBatchSize = calculateAvailableCalls();
                callsInImmediateBatch = 0;
                
                if (progressMessage) {
                    progressMessage.textContent = 'Fetching data...';
                }
                if (progressDetails) {
                    progressDetails.textContent = 'Resuming data collection...';
                }
            } else if (callsInImmediateBatch < immediateBatchSize) {
                // Still in immediate batch, no delay needed
                callsInImmediateBatch++;
            } else {
                // Past immediate batch, add delay between calls
                await sleep(window.CALL_INTERVAL_MS);
            }
            
            // Make the API call (localhost: Vite /.torn-api-proxy → Torn)
            const batchTornUrl = typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(url) : url;
            try {
                const response = await fetch(batchTornUrl);
                const data = await response.json();
                
                if (data.error) {
                    // Check for rate limit error
                    if ((data.error.error === 'Too many requests' || data.code === 2) && retryOnRateLimit) {
                        if (progressMessage) {
                            progressMessage.textContent = 'Waiting for API Limit...';
                        }
                        const waitSeconds = getRollingWindowRateLimitWaitSeconds();
                        for (let j = waitSeconds; j > 0; j--) {
                            if (progressDetails) {
                                progressDetails.textContent = `API rate limit (server) — resuming in ${j}s…`;
                            }
                            await sleep(1000);
                        }
                        if (progressMessage) {
                            progressMessage.textContent = 'Fetching data...';
                        }
                        if (progressDetails) {
                            progressDetails.textContent = 'Resuming data collection...';
                        }

                        // Retry once
                        const retryResponse = await fetch(batchTornUrl);
                        const retryData = await retryResponse.json();
                        
                        if (retryData.error) {
                            const error = new Error(`API Error after retry: ${retryData.error.error || retryData.error}`);
                            results[originalIndex] = { success: false, error, data: null, request };
                            if (onError) onError(error, request, originalIndex);
                            recordApiCall(); // Record retry attempt
                            continue;
                        }
                        
                        // Success on retry
                        const retryResult = { success: true, data: retryData, request };
                        results[originalIndex] = retryResult;
                        successfulCount++;
                        recordApiCall();
                        // Cache the result if caching is enabled
                        if (useCache && cacheSet && request.cacheKey) {
                            cacheSet(request.cacheKey, retryData);
                        }
                        if (onSuccess) onSuccess(retryData, request, originalIndex);
                        continue;
                    }
                    
                    // Non-rate-limit error or retry disabled
                    const error = new Error(`API Error: ${data.error.error || data.error}`);
                    results[originalIndex] = { success: false, error, data: null, request };
                    if (onError) onError(error, request, originalIndex);
                    continue;
                }
                
                // Success
                const result = { success: true, data, request };
                results[originalIndex] = result;
                successfulCount++;
                recordApiCall();
                // Cache the result if caching is enabled
                if (useCache && cacheSet && request.cacheKey) {
                    cacheSet(request.cacheKey, data);
                }
                if (onSuccess) onSuccess(data, request, originalIndex);
                
            } catch (error) {
                results[originalIndex] = { success: false, error, data: null, request };
                if (onError) onError(error, request, originalIndex);
                continue;
            }
        }
        
        // Merge cached results into final results array
        cachedResults.forEach(({ success, data, request }, index) => {
            if (results[index] === undefined) {
                results[index] = { success, data, request };
            }
        });
        
        // Ensure results array has same length as requests array
        while (results.length < requests.length) {
            results.push(null);
        }
        
        return results;
    };

    // Function to get user data from API key
    async function getUserData(apiKey) {
        if (!apiKey) return null;
        
        // Check cache first
        if (userCache[apiKey]) {
            return userCache[apiKey];
        }
        
        try {
            const response = await fetch(`https://api.torn.com/user/?selections=profile&key=${apiKey}`);
            const data = await response.json();
            
            
            if (data.error) {
                console.error('API Error:', data.error);
                return null;
            }
            
            const userData = {
                name: data.name,
                playerId: data.player_id,
                profileUrl: `https://www.torn.com/profiles.php?XID=${data.player_id}`,
                factionName: data.faction_name || data.faction?.faction_name || 'Unknown Faction',
                factionId: data.faction_id || data.faction?.faction_id || null
            };
            
            // Cache the result
            userCache[apiKey] = userData;
            return userData;
        } catch (error) {
            if (error?.message !== 'Failed to fetch' && error?.name !== 'TypeError') {
                console.error('Error fetching user data:', error);
            }
            return null;
        }
    }

    // ==================== VIP TRACKING SYSTEM ====================
    
    // VIP Level thresholds
    const VIP_LEVELS = {
        1: 10,
        2: 50,
        3: 100
    };
    
    // VIP backend: Firebase Callables (getVipBalance, updateVipBalance, logVipTransaction). Fallback URL only for tool-usage log if needed.
    const GOOGLE_SHEETS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx9dnveoMQYIAzjvsBrhzO1Fl9y29SAUsqLlQLG4YSiyIJ0FyAFpbj0idb854_7w87u/exec';

    /** Call Firebase getVipBalance callable with { playerId } or { playerName }. Returns balance object or null. */
    async function fetchVipBalanceFromBackend(opts) {
        try {
            if (typeof firebase === 'undefined' || !firebase.functions) return null;
            const fn = firebase.functions().httpsCallable('getVipBalance');
            const res = await fn(opts);
            const data = res && res.data;
            return data || null;
        } catch (e) {
            console.error('VIP getVipBalance callable error:', e);
            return null;
        }
    }

    // Get admin API key (stored in localStorage with key 'adminApiKey')
    function getAdminApiKey() {
        // Admin API key should be set via admin dashboard or localStorage
        // For security, this should only be accessible to admins
        const adminKey = localStorage.getItem('adminApiKey');
        if (adminKey) {
            return adminKey;
        }
        // Fallback: if current user is admin, use their API key
        const currentKey = localStorage.getItem('tornApiKey');
        if (currentKey) {
            // Check if current user is admin (quick check without API call)
            // This is a fallback - ideally admin key should be set separately
            return null; // Will be handled by checking if user is admin
        }
        return null;
    }
    
    // Parse Xanax sent event from events API
    function parseXanaxEvent(eventText) {
        // Format: "You were sent 11x Xanax from <a href = http://www.torn.com/http://www.torn.com/profiles.php?XID=2181017>Methuzelah</a>"
        const xanaxMatch = eventText.match(/You were sent (\d+)x Xanax from/);
        if (!xanaxMatch) return null;
        
        const amount = parseInt(xanaxMatch[1], 10);
        const playerMatch = eventText.match(/XID=(\d+)[^>]*>([^<]+)<\/a>/);
        if (!playerMatch) return null;
        
        return {
            amount: amount,
            playerId: parseInt(playerMatch[1], 10),
            playerName: playerMatch[2]
        };
    }
    
    const VIP_DEDUCTION_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000; // 48 hours
    // Calculate deductions based on time elapsed (1 xanax per 2 days)
    function calculateDeductions(lastDeductionDate, currentDate) {
        if (!lastDeductionDate) return 0;
        const lastDate = new Date(lastDeductionDate);
        const current = new Date(currentDate);
        return Math.floor((current - lastDate) / VIP_DEDUCTION_INTERVAL_MS);
    }
    
    // Determine VIP level from balance
    function getVipLevel(balance) {
        if (balance >= VIP_LEVELS[3]) return 3;
        if (balance >= VIP_LEVELS[2]) return 2;
        if (balance >= VIP_LEVELS[1]) return 1;
        return 0;
    }

    // Recruitment tool requires VIP 3
    const RECRUITMENT_VIP_REQUIRED = 3;
    window.currentVipLevel = window.currentVipLevel ?? 0;
    /** True only after we've fetched VIP (welcome flow); avoids redirecting on refresh before key is validated. */
    window.vipLevelKnown = window.vipLevelKnown ?? false;

    /** Apply VIP gating to Recruitment: grey out and tooltip if vipLevel < RECRUITMENT_VIP_REQUIRED. */
    function applyVipGating(vipLevel) {
        const level = vipLevel ?? window.currentVipLevel ?? 0;
        window.currentVipLevel = level;
        const hasAccess = level >= RECRUITMENT_VIP_REQUIRED;
        const tooltip = 'Requires VIP 3. Send Xanax to Jimidy to unlock this tool.';
        document.querySelectorAll('#mainNav a[href="#recruitment"]').forEach((a) => {
            if (hasAccess) {
                a.classList.remove('vip-locked');
                a.removeAttribute('title');
            } else {
                a.classList.add('vip-locked');
                a.setAttribute('title', tooltip);
            }
        });
        document.querySelectorAll('a.tool-card[href="#recruitment"], .tool-cards-grid a[href="#recruitment"]').forEach((a) => {
            if (hasAccess) {
                a.classList.remove('vip-locked');
                a.removeAttribute('title');
                const wrap = a.closest('.tool-card-vip-wrap');
                if (wrap && wrap.parentNode) {
                    wrap.parentNode.insertBefore(a, wrap);
                    wrap.remove();
                }
            } else {
                a.classList.add('vip-locked');
                a.setAttribute('title', tooltip);
                if (!a.closest('.tool-card-vip-wrap')) {
                    const wrap = document.createElement('div');
                    wrap.className = 'tool-card-vip-wrap';
                    a.parentNode.insertBefore(wrap, a);
                    wrap.appendChild(a);
                    const badge = document.createElement('span');
                    badge.className = 'tool-card-vip-badge';
                    badge.setAttribute('aria-hidden', 'true');
                    badge.textContent = '\uD83D\uDD12  VIP level 3';
                    wrap.appendChild(badge);
                }
            }
        });
    }

    // Get progress to next VIP level
    function getVipProgress(balance, currentLevel) {
        if (currentLevel >= 3) {
            return { nextLevel: null, current: balance, needed: 0, progress: 100 };
        }
        
        const nextLevel = currentLevel + 1;
        const nextThreshold = VIP_LEVELS[nextLevel];
        const currentThreshold = currentLevel > 0 ? VIP_LEVELS[currentLevel] : 0;
        const progress = ((balance - currentThreshold) / (nextThreshold - currentThreshold)) * 100;
        
        return {
            nextLevel: nextLevel,
            current: balance,
            needed: nextThreshold - balance,
            progress: Math.max(0, Math.min(100, progress))
        };
    }
    
    // Calculate cache expiration time based on VIP status.
    // Returns milliseconds until next refetch. Deductions are still applied when reading from cache (see getVipBalance).
    // - No balance: 0 (no cache). Level 0: 2 days. Otherwise: (xanaxUntilDrop * 2 + 2) days so we refetch before they could drop a level.
    function calculateCacheExpiration(vipData) {
        if (!vipData || vipData.currentBalance === 0) {
            return 0; // No cache for users with no balance
        }
        
        const currentLevel = vipData.vipLevel || 0;
        const currentBalance = vipData.currentBalance || 0;
        
        // If they have no VIP level, cache for 2 days (they could send Xanax anytime)
        if (currentLevel === 0) {
            return 2 * 24 * 60 * 60 * 1000; // 2 days in milliseconds
        }
        
        // Calculate how many Xanax they need to lose before dropping a level
        const thresholdForCurrentLevel = VIP_LEVELS[currentLevel];
        const xanaxUntilDrop = currentBalance - thresholdForCurrentLevel + 1; // +1 to be safe
        
        // If they're already below their current level threshold (shouldn't happen, but safety check)
        if (xanaxUntilDrop <= 0) {
            return 0; // No cache, need to check immediately
        }
        
        // Calculate days until they could drop: Xanax needed * 2 days per Xanax
        // Add 2 days buffer for safety
        const daysUntilDrop = (xanaxUntilDrop * 2) + 2;
        const millisecondsUntilDrop = daysUntilDrop * 24 * 60 * 60 * 1000;
        
        return millisecondsUntilDrop;
    }
    
    // Fetch VIP balance from Google Sheets (with local cache)
    async function getVipBalance(playerId, useCache = true) {
        // Check cache first if enabled
        if (useCache) {
            const cacheKey = `vipBalance_${playerId}`;
            const cacheExpiryKey = `vipBalanceExpiry_${playerId}`;
            
            const cachedData = localStorage.getItem(cacheKey);
            const cacheExpiry = localStorage.getItem(cacheExpiryKey);
            
            if (cachedData && cacheExpiry) {
                const now = Date.now();
                const expiryTime = parseInt(cacheExpiry, 10);
                
                // If cache is still valid, return cached data (but recalculate deductions)
                if (now < expiryTime) {
                    try {
                        const vipData = JSON.parse(cachedData);
                        
                        // Recalculate deductions based on time elapsed since last deduction
                        if (vipData.lastDeductionDate) {
                            const nowISO = new Date().toISOString();
                            const deductions = calculateDeductions(vipData.lastDeductionDate, nowISO);
                            
                            if (deductions > 0) {
                                // Apply deductions to cached balance
                                vipData.currentBalance = Math.max(0, vipData.currentBalance - deductions);
                                vipData.lastDeductionDate = nowISO;
                                
                                // Recalculate VIP level after deductions
                                vipData.vipLevel = getVipLevel(vipData.currentBalance);
                                
                                // Update cache with new balance (but keep same expiration)
                                localStorage.setItem(cacheKey, JSON.stringify(vipData));
                            } else {
                                // No deductions needed, just recalculate VIP level
                                vipData.vipLevel = getVipLevel(vipData.currentBalance);
                            }
                        } else {
                            // No lastDeductionDate, just recalculate VIP level
                            vipData.vipLevel = getVipLevel(vipData.currentBalance);
                        }
                        
                        return vipData;
                    } catch (e) {
                        // If cache is corrupted, clear it and fetch fresh
                        localStorage.removeItem(cacheKey);
                        localStorage.removeItem(cacheExpiryKey);
                    }
                }
            }
        }
        
        // Cache expired or doesn't exist, fetch from Firebase
        try {
            const data = await fetchVipBalanceFromBackend({ playerId: playerId });
            if (data && (data.playerId != null || data.playerName != null)) {
                if (useCache) {
                    const cacheKey = `vipBalance_${playerId}`;
                    const cacheExpiryKey = `vipBalanceExpiry_${playerId}`;
                    const expirationTime = Date.now() + calculateCacheExpiration(data);
                    localStorage.setItem(cacheKey, JSON.stringify(data));
                    localStorage.setItem(cacheExpiryKey, expirationTime.toString());
                }
                return data;
            }
            return null;
        } catch (error) {
            console.error('Error fetching VIP balance:', error);
        }
        return null;
    }
    
    // Clear VIP cache for a player (useful when balance is updated)
    function clearVipCache(playerId) {
        localStorage.removeItem(`vipBalance_${playerId}`);
        localStorage.removeItem(`vipBalanceExpiry_${playerId}`);
    }
    
    // Update VIP balance (Firebase Callable). Optional factionName, factionId to show faction in admin table.
    async function updateVipBalance(playerId, playerName, totalSent, currentBalance, lastDeductionDate, vipLevel, lastLoginDate, factionName, factionId) {
        try {
            if (typeof firebase === 'undefined' || !firebase.functions) return;
            const fn = firebase.functions().httpsCallable('updateVipBalance');
            const payload = {
                playerId: playerId,
                playerName: playerName,
                totalXanaxSent: totalSent,
                currentBalance: currentBalance,
                lastDeductionDate: lastDeductionDate,
                vipLevel: vipLevel,
                lastLoginDate: lastLoginDate
            };
            if (factionName != null && factionName !== '') payload.factionName = factionName;
            if (factionId != null && factionId !== '') payload.factionId = String(factionId);
            await fn(payload);
        } catch (error) {
            console.error('Error updating VIP balance:', error);
        }
    }
    
    // Log VIP transaction (Firebase Callable)
    async function logVipTransaction(playerId, playerName, amount, transactionType, balanceAfter) {
        try {
            if (typeof firebase === 'undefined' || !firebase.functions) return;
            const fn = firebase.functions().httpsCallable('logVipTransaction');
            await fn({
                timestamp: new Date().toISOString(),
                playerId: playerId,
                playerName: playerName,
                amount: amount,
                transactionType: transactionType,
                balanceAfter: balanceAfter
            });
        } catch (error) {
            console.error('Error logging VIP transaction:', error);
        }
    }
    
    // Check for new Xanax events and update balances
    async function checkAndUpdateVipStatus(userApiKey, userData) {
        // Try to get admin API key
        let adminApiKey = getAdminApiKey();
        
        // If no admin key set, check if current user is admin and use their key
        if (!adminApiKey) {
            const isCurrentUserAdmin = await isAdmin();
            if (isCurrentUserAdmin) {
                adminApiKey = userApiKey; // Use admin's own API key
            } else {
                console.log('Admin API key not configured and user is not admin, skipping VIP check');
                return null;
            }
        }
        
        try {
            // Get current VIP balance from Google Sheets by player ID (skip cache for updates)
            let vipData = await getVipBalance(userData.playerId, false);
            
            // If not found by ID, try to find by name (for backfilled data where playerId was 0)
            if (!vipData) {
                try {
                    const data = await fetchVipBalanceFromBackend({ playerName: userData.name });
                    if (data && data.playerName === userData.name) {
                        vipData = data;
                        if (vipData.playerId === 0 || !vipData.playerId) {
                            vipData.playerId = userData.playerId;
                        }
                    }
                } catch (error) {
                    console.error('Error fetching VIP balance by name:', error);
                }
            } else if (vipData.playerId === 0 || !vipData.playerId) {
                // Update player ID if it was 0 (from backfill) or missing
                vipData.playerId = userData.playerId;
            }
            
            // If still no VIP data, create new entry
            if (!vipData) {
                vipData = {
                    playerId: userData.playerId,
                    playerName: userData.name,
                    totalXanaxSent: 0,
                    currentBalance: 0,
                    lastDeductionDate: null,
                    vipLevel: 0,
                    lastLoginDate: null
                };
            }
            
            // Check last 30 days for Xanax events (API limit is 100 events, so we check 30 days)
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const fromTimestamp = Math.floor(thirtyDaysAgo.getTime() / 1000);
            
            // Fetch events from admin's API (checking last 30 days, max 100 events)
            const eventsResponse = await fetch(`https://api.torn.com/user/?selections=events&from=${fromTimestamp}&key=${adminApiKey}`);
            const eventsData = await eventsResponse.json();
            
            if (eventsData.error) {
                console.error('Error fetching events:', eventsData.error);
                return null;
            }
            
            // Parse events for Xanax sent to admin
            const events = eventsData.events || {};
            let newXanaxReceived = 0;
            
            Object.values(events).forEach(event => {
                if (event.event && event.event.includes('You were sent') && event.event.includes('Xanax')) {
                    const parsed = parseXanaxEvent(event.event);
                    if (parsed && parsed.playerId === userData.playerId) {
                        newXanaxReceived += parsed.amount;
                    }
                }
            });
            
            // Update total sent and current balance
            if (newXanaxReceived > 0) {
                vipData.totalXanaxSent += newXanaxReceived;
                vipData.currentBalance += newXanaxReceived;
                
                // Log transaction
                await logVipTransaction(
                    userData.playerId,
                    userData.name,
                    newXanaxReceived,
                    'Sent',
                    vipData.currentBalance
                );
            }
            
            // Calculate deductions
            const now = new Date().toISOString();
            const deductions = calculateDeductions(vipData.lastDeductionDate, now);
            
            if (deductions > 0) {
                vipData.currentBalance = Math.max(0, vipData.currentBalance - deductions);
                vipData.lastDeductionDate = now;
                
                // Log deduction transaction
                await logVipTransaction(
                    userData.playerId,
                    userData.name,
                    deductions,
                    'Deduction',
                    vipData.currentBalance
                );
            } else if (!vipData.lastDeductionDate) {
                // Start deduction clock from now; first deduction in 2 days
                vipData.lastDeductionDate = now;
            }
            
            // Update VIP level
            vipData.vipLevel = getVipLevel(vipData.currentBalance);
            vipData.lastLoginDate = now;
            
            // Update backend (include faction when available so admin table can show it)
            await updateVipBalance(
                vipData.playerId,
                vipData.playerName,
                vipData.totalXanaxSent,
                vipData.currentBalance,
                vipData.lastDeductionDate,
                vipData.vipLevel,
                vipData.lastLoginDate,
                userData.factionName,
                userData.factionId
            );
            
            // Clear cache and update it with new data (since balance changed)
            clearVipCache(vipData.playerId);
            const cacheKey = `vipBalance_${vipData.playerId}`;
            const cacheExpiryKey = `vipBalanceExpiry_${vipData.playerId}`;
            const expirationTime = Date.now() + calculateCacheExpiration(vipData);
            localStorage.setItem(cacheKey, JSON.stringify(vipData));
            localStorage.setItem(cacheExpiryKey, expirationTime.toString());
            
            // Store last login
            localStorage.setItem(`lastLogin_${userData.playerId}`, now);
            
            return vipData;
        } catch (error) {
            console.error('Error checking VIP status:', error);
            return null;
        }
    }
    
    // Simple backfill function for specific Xanax events
    // Usage: backfillVipEventsSimple([{playerName: 'Methuzelah', amount: 11}, ...])
    // This writes directly to Google Sheets - playerId will be 0 until player logs in and matches by name
    async function backfillVipEventsSimple(events) {
        console.log(`Starting VIP backfill for ${events.length} events...`);
        
        // Process each event
        for (const event of events) {
            const { playerName, amount } = event;
            
            // Try to get existing VIP data from Google Sheets by name
            // We'll search by getting all balances and finding by name (since we don't have playerId yet)
            let vipData = null;
            
            // For now, create new entry with playerId = 0 (will be updated when player logs in)
            vipData = {
                playerId: 0, // Temporary - will be updated when player logs in and matches by name
                playerName: playerName,
                totalXanaxSent: amount,
                currentBalance: amount,
                lastDeductionDate: null,
                vipLevel: getVipLevel(amount),
                lastLoginDate: null
            };
            
            // Write directly to Google Sheets
            await updateVipBalance(
                vipData.playerId,
                vipData.playerName,
                vipData.totalXanaxSent,
                vipData.currentBalance,
                vipData.lastDeductionDate,
                vipData.vipLevel,
                vipData.lastLoginDate
            );
            
            // Log transaction
            await logVipTransaction(
                vipData.playerId,
                playerName,
                amount,
                'Sent',
                vipData.currentBalance
            );
            
            console.log(`✓ Backfilled ${playerName}: +${amount} Xanax (Total: ${vipData.totalXanaxSent}, Balance: ${vipData.currentBalance}, VIP: ${vipData.vipLevel})`);
        }
        
        console.log(`Backfill complete! Processed ${events.length} events.`);
        console.log('Note: Player IDs (currently 0) will be updated when players log in and match by name.');
    }
    
    // Helper function to match VIP data by name when player logs in and update with real player ID
    async function matchVipDataByName(playerId, playerName) {
        // We need to check Google Sheets for entries with this name and playerId = 0
        // For now, we'll handle this in checkAndUpdateVipStatus by checking if we need to update an existing entry
        // This is a simplified approach - in a full implementation, you'd query Google Sheets by name
        return null; // Will be handled by the main VIP check function
    }
    
    // Backfill VIP data for existing players (call this manually with list of player IDs)
    async function backfillVipData(playerIds, adminApiKey) {
        if (!adminApiKey) {
            adminApiKey = getAdminApiKey();
            if (!adminApiKey) {
                console.error('Admin API key required for backfill');
                return;
            }
        }
        
        console.log(`Starting VIP backfill for ${playerIds.length} players...`);
        
        // Check events from a reasonable time period (e.g., last 30 days)
        const fromTimestamp = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
        
        try {
            const eventsResponse = await fetch(`https://api.torn.com/user/?selections=events&from=${fromTimestamp}&key=${adminApiKey}`);
            const eventsData = await eventsResponse.json();
            
            if (eventsData.error) {
                console.error('Error fetching events for backfill:', eventsData.error);
                return;
            }
            
            const events = eventsData.events || {};
            const xanaxByPlayer = {};
            
            // Parse all Xanax events
            Object.values(events).forEach(event => {
                if (event.event && event.event.includes('You were sent') && event.event.includes('Xanax')) {
                    const parsed = parseXanaxEvent(event.event);
                    if (parsed && playerIds.includes(parsed.playerId)) {
                        if (!xanaxByPlayer[parsed.playerId]) {
                            xanaxByPlayer[parsed.playerId] = {
                                playerId: parsed.playerId,
                                playerName: parsed.playerName,
                                totalAmount: 0
                            };
                        }
                        xanaxByPlayer[parsed.playerId].totalAmount += parsed.amount;
                    }
                }
            });
            
            // Update balances for each player
            for (const playerId in xanaxByPlayer) {
                const player = xanaxByPlayer[playerId];
                const vipData = {
                    playerId: player.playerId,
                    playerName: player.playerName,
                    totalXanaxSent: player.totalAmount,
                    currentBalance: player.totalAmount, // Start with full amount (deductions will be calculated on next login)
                    lastDeductionDate: null,
                    vipLevel: getVipLevel(player.totalAmount),
                    lastLoginDate: null
                };
                
                await updateVipBalance(
                    vipData.playerId,
                    vipData.playerName,
                    vipData.totalXanaxSent,
                    vipData.currentBalance,
                    vipData.lastDeductionDate,
                    vipData.vipLevel,
                    vipData.lastLoginDate
                );
                
                console.log(`Backfilled ${player.playerName} (ID: ${player.playerId}): ${player.totalAmount} Xanax`);
            }
            
            console.log(`Backfill complete! Processed ${Object.keys(xanaxByPlayer).length} players.`);
        } catch (error) {
            console.error('Error during backfill:', error);
        }
    }
    
    // Display VIP status in welcome message (appends to existing welcome message)
    function displayVipStatus(vipData, playerName) {
        const welcomeMessage = document.getElementById('welcomeMessage');
        if (!welcomeMessage) return;
        if (!vipData) {
            welcomeMessage.classList.remove('welcome-vip-pulse');
            return;
        }

        function applyWelcomeVipPulse() {
            const level0 = (vipData.vipLevel || 0) === 0;
            welcomeMessage.classList.toggle('welcome-vip-pulse', level0);
        }
        
        const vipLevel = vipData.vipLevel;
        const progress = getVipProgress(vipData.currentBalance, vipLevel);
        
        // Check if VIP status is already displayed (to avoid duplicates)
        if (welcomeMessage.innerHTML.includes('VIP') || welcomeMessage.innerHTML.includes('Xanax to VIP')) {
            // VIP status already shown, just update it
            const welcomeText = `<span style="color: var(--accent-color);">Welcome, <strong>${playerName}</strong>!</span>`;
            let vipHtml = '';
            
            if (vipLevel > 0) {
                vipHtml = `
                    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 215, 0, 0.2);">
                        <div style="color: var(--accent-color); font-weight: bold;">⭐ VIP ${vipLevel}</div>
                `;
                
                if (progress.nextLevel) {
                    vipHtml += `
                        <div style="font-size: 0.85em; color: #95a5a6; margin-top: 4px;">
                            ${vipData.currentBalance}/${VIP_LEVELS[progress.nextLevel]} Xanax to VIP ${progress.nextLevel}
                            <div style="background: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; margin-top: 4px; overflow: hidden;">
                                <div style="background: var(--accent-color); height: 100%; width: ${progress.progress}%; transition: width 0.3s;"></div>
                            </div>
                        </div>
                    `;
                } else {
                    vipHtml += `
                        <div style="font-size: 0.85em; color: #95a5a6; margin-top: 4px;">
                            ${vipData.currentBalance}/${VIP_LEVELS[3]} Xanax — Maximum VIP level!
                            <div style="background: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; margin-top: 4px; overflow: hidden;">
                                <div style="background: var(--accent-color); height: 100%; width: 100%; transition: width 0.3s;"></div>
                            </div>
                        </div>
                    `;
                }
                
                vipHtml += `<div style="font-size: 0.75em; color: #7f8c8d; margin-top: 6px; font-style: italic;">💡 Send Xanax to <a href="https://www.torn.com/profiles.php?XID=2935825" target="_blank" style="color: var(--accent-color) !important; text-decoration: underline !important; font-weight: normal !important; padding: 0 !important; display: inline !important;">Jimidy</a> to increase your VIP status</div></div>`;
            } else if (progress.nextLevel) {
                vipHtml = `
                    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 215, 0, 0.2);">
                        <div style="font-size: 0.85em; color: #95a5a6;">
                            ${vipData.currentBalance}/${VIP_LEVELS[progress.nextLevel]} Xanax to VIP ${progress.nextLevel}
                            <div style="background: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; margin-top: 4px; overflow: hidden;">
                                <div style="background: var(--accent-color); height: 100%; width: ${progress.progress}%; transition: width 0.3s;"></div>
                            </div>
                        </div>
                        <div style="font-size: 0.75em; color: #7f8c8d; margin-top: 6px; font-style: italic;">💡 Send Xanax to <a href="https://www.torn.com/profiles.php?XID=2935825" target="_blank" style="color: var(--accent-color) !important; text-decoration: underline !important; font-weight: normal !important; padding: 0 !important; display: inline !important;">Jimidy</a> to increase your VIP status</div></div>`;
            }
            
            welcomeMessage.innerHTML = welcomeText + vipHtml;
            applyWelcomeVipPulse();
            return;
        }
        
        // Get current welcome text (preserve it)
        const currentHtml = welcomeMessage.innerHTML;
        let welcomeText = currentHtml;
        
        // If welcome text isn't there, create it
        if (!currentHtml.includes('Welcome')) {
            welcomeText = `<span style="color: var(--accent-color);">Welcome, <strong>${playerName}</strong>!</span>`;
        }
        
        let vipHtml = '';
        if (vipLevel > 0) {
            vipHtml = `
                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 215, 0, 0.2);">
                    <div style="color: var(--accent-color); font-weight: bold;">⭐ VIP ${vipLevel}</div>
            `;
            
            if (progress.nextLevel) {
                vipHtml += `
                    <div style="font-size: 0.85em; color: #95a5a6; margin-top: 4px;">
                        ${vipData.currentBalance}/${VIP_LEVELS[progress.nextLevel]} Xanax to VIP ${progress.nextLevel}
                        <div style="background: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; margin-top: 4px; overflow: hidden;">
                            <div style="background: var(--accent-color); height: 100%; width: ${progress.progress}%; transition: width 0.3s;"></div>
                        </div>
                    </div>
                `;
            } else {
                vipHtml += `
                    <div style="font-size: 0.85em; color: #95a5a6; margin-top: 4px;">
                        ${vipData.currentBalance}/${VIP_LEVELS[3]} Xanax — Maximum VIP level!
                        <div style="background: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; margin-top: 4px; overflow: hidden;">
                            <div style="background: var(--accent-color); height: 100%; width: 100%; transition: width 0.3s;"></div>
                        </div>
                    </div>
                `;
            }
            
            vipHtml += `<div style="font-size: 0.75em; color: #7f8c8d; margin-top: 6px; font-style: italic;">💡 Send Xanax to <a href="https://www.torn.com/profiles.php?XID=2935825" target="_blank" style="color: var(--accent-color) !important; text-decoration: underline !important; font-weight: normal !important; padding: 0 !important; display: inline !important;">Jimidy</a> to increase your VIP status</div></div>`;
        } else if (progress.nextLevel) {
            vipHtml = `
                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 215, 0, 0.2);">
                    <div style="font-size: 0.85em; color: #95a5a6;">
                        ${vipData.currentBalance}/${VIP_LEVELS[progress.nextLevel]} Xanax to VIP ${progress.nextLevel}
                        <div style="background: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; margin-top: 4px; overflow: hidden;">
                            <div style="background: var(--accent-color); height: 100%; width: ${progress.progress}%; transition: width 0.3s;"></div>
                        </div>
                    </div>
                    <div style="font-size: 0.75em; color: #7f8c8d; margin-top: 6px; font-style: italic;">💡 Send Xanax to <a href="https://www.torn.com/profiles.php?XID=2935825" target="_blank" style="color: var(--accent-color) !important; text-decoration: underline !important; font-weight: normal !important; padding: 0 !important; display: inline !important;">Jimidy</a> to increase your VIP status</div></div>`;
        }
        
        // Append VIP status and rate limit settings to welcome message (don't replace)
        const rateLimitHtml = getRateLimitSettingsHtml();
        welcomeMessage.innerHTML = welcomeText + vipHtml + rateLimitHtml;
        applyWelcomeVipPulse();
    }

    /** Open on-brand modal explaining VIP balance, tiers, decay, and perks (uses VIP_LEVELS thresholds). */
    function openVipProgramInfoModal() {
        const existing = document.getElementById('vip-program-info-overlay');
        if (existing) existing.remove();

        const v1 = VIP_LEVELS[1];
        const v2 = VIP_LEVELS[2];
        const v3 = VIP_LEVELS[3];
        const overlay = document.createElement('div');
        overlay.id = 'vip-program-info-overlay';
        overlay.className = 'app-modal-overlay';
        overlay.setAttribute('role', 'presentation');
        overlay.innerHTML =
            '<div class="app-modal" role="dialog" aria-modal="true" aria-labelledby="vip-program-info-title" style="max-width: 520px;">' +
            '<div class="app-modal-header">' +
            '<h2 id="vip-program-info-title">VIP program</h2>' +
            '<button type="button" class="app-modal-close" id="vip-program-info-close" aria-label="Close">×</button>' +
            '</div>' +
            '<div class="app-modal-body vip-info-modal-body">' +
            '<p>Support the tools by sending <strong>Xanax</strong> to <a href="https://www.torn.com/profiles.php?XID=2935825" target="_blank" rel="noopener">Jimidy</a> in Torn. Your <strong>current balance</strong> (tracked here when you use your API key) sets your VIP tier.</p>' +
            '<h3>Levels (by current balance)</h3>' +
            '<ul>' +
            '<li><strong>VIP 1</strong> — ' + v1 + '+ Xanax balance</li>' +
            '<li><strong>VIP 2</strong> — ' + v2 + '+ Xanax balance</li>' +
            '<li><strong>VIP 3</strong> — ' + v3 + '+ Xanax balance</li>' +
            '</ul>' +
            '<h3>Balance decay</h3>' +
            '<p>Every <strong>48 hours</strong>, <strong>1 Xanax</strong> is subtracted from your balance (while balance is above zero). If your balance falls below a tier threshold, your VIP level will drop until you send more Xanax.</p>' +
            '<h3>What you unlock</h3>' +
            '<h4>VIP 1</h4>' +
            '<ul>' +
            '<li><strong>War Report</strong> — custom payout end (set your own end date/time in TCT).</li>' +
            '<li><strong>Faction Battle Stats</strong> — <strong>Check Activity</strong> (compare member activity over 1 month, 3 months, or a custom number of days).</li>' +
            '</ul>' +
            '<h4>VIP 2</h4>' +
            '<ul>' +
            '<li><strong>War Dashboard</strong> — full access from <strong>April 15th</strong> (currently in beta and free to try until then).</li>' +
            '</ul>' +
            '<h4>VIP 3</h4>' +
            '<ul>' +
            '<li><strong>Recruitment</strong> — full access to the Recruitment tool.</li>' +
            '</ul>' +
            '<p>Other tools may show VIP badges as features are added.</p>' +
            '<p class="vip-info-special-offer"><strong>Special offer:</strong> All Xanax sent before the end of <strong>April</strong> will be <strong>doubled</strong> in your balance.</p>' +
            '<div class="app-modal-actions" style="margin-top: 14px;">' +
            '<button type="button" class="fetch-button" id="vip-program-info-dismiss">Close</button>' +
            '</div></div></div>';

        document.body.appendChild(overlay);

        function closeVipInfoModal() {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
        }
        function onKey(e) {
            if (e.key === 'Escape') closeVipInfoModal();
        }
        document.addEventListener('keydown', onKey);

        overlay.querySelector('#vip-program-info-close').addEventListener('click', closeVipInfoModal);
        overlay.querySelector('#vip-program-info-dismiss').addEventListener('click', closeVipInfoModal);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeVipInfoModal();
        });
    }
    window.openVipProgramInfoModal = openVipProgramInfoModal;
    
    // Function to generate rate limit settings HTML
    function getRateLimitSettingsHtml() {
        const currentRateLimit = getRateLimit();
        return `
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 215, 0, 0.2);">
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <input 
                        type="number" 
                        id="rateLimitInput" 
                        min="50" 
                        max="100" 
                        value="${currentRateLimit}" 
                        style="width: 60px; padding: 3px 6px; background: var(--primary-color); border: 1px solid var(--border-color); color: var(--text-color); border-radius: 4px; font-size: 0.85em;"
                    >
                    <span style="font-size: 0.85em; color: #95a5a6;">API calls/minute</span>
                </div>
                <div style="font-size: 0.75em; color: #7f8c8d; margin-top: 4px;">
                    ${(window.CALL_INTERVAL_MS).toFixed(0)}ms between calls
                </div>
            </div>
        `;
    }
    
    // Function to initialize rate limit settings event listeners
    let rateLimitSaveTimeout = null;
    function initRateLimitSettings() {
        // Use event delegation for input changes (auto-save after user stops typing)
        document.addEventListener('input', (e) => {
            if (e.target && e.target.id === 'rateLimitInput') {
                const input = e.target;
                const newLimit = parseInt(input.value, 10);
                
                // Clear existing timeout
                if (rateLimitSaveTimeout) {
                    clearTimeout(rateLimitSaveTimeout);
                }
                
                // Validate and auto-save after 1 second of no typing
                rateLimitSaveTimeout = setTimeout(() => {
                    if (newLimit >= 50 && newLimit <= 100) {
                        setRateLimit(newLimit);
                        // Update the interval display
                        const intervalDisplay = input.parentElement.nextElementSibling;
                        if (intervalDisplay) {
                            intervalDisplay.textContent = `${(window.CALL_INTERVAL_MS).toFixed(0)}ms between calls`;
                        }
                    } else if (input.value !== '') {
                        // Invalid value, reset to current rate limit
                        input.value = getRateLimit();
                    }
                }, 1000); // Wait 1 second after user stops typing
            }
        });
    }
    
    // Initialize rate limit settings on page load
    initRateLimitSettings();
    
    // ==================== END VIP TRACKING SYSTEM ====================
    
    // Function to log tool usage
    async function logToolUsage(toolName) {
        const apiKey = localStorage.getItem('tornApiKey');
        if (!apiKey) return;
        
        const userData = await getUserData(apiKey);
        if (!userData) return;
        
        // Check and update VIP status when tool is used
        await checkAndUpdateVipStatus(apiKey, userData);
        
        const logEntry = {
            timestamp: new Date().toISOString(),
            userName: userData.name,
            playerId: userData.playerId,
            profileUrl: userData.profileUrl,
            factionName: userData.factionName,
            factionId: userData.factionId,
            tool: toolName,
            apiKey: apiKey.substring(0, 8) + '...' // Only store partial key for privacy
        };
        
        console.log('Tool Usage:', logEntry);
        
        // Send to Google Sheets
        try {
            await fetch('https://script.google.com/macros/s/AKfycbx9dnveoMQYIAzjvsBrhzO1Fl9y29SAUsqLlQLG4YSiyIJ0FyAFpbj0idb854_7w87u/exec', {
                method: 'POST',
                mode: 'no-cors',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(logEntry)
            });
            console.log('Successfully logged to Google Sheets');
        } catch (error) {
            console.error('Failed to log to Google Sheets:', error);
            // Fallback to localStorage if Google Sheets fails
            const logs = JSON.parse(localStorage.getItem('toolUsageLogs') || '[]');
            logs.push(logEntry);
            localStorage.setItem('toolUsageLogs', JSON.stringify(logs));
        }
    }

    // Function to check if current user is admin
    async function isAdmin() {
        const apiKey = localStorage.getItem('tornApiKey');
        if (!apiKey) return false;
        
        try {
            const userData = await getUserData(apiKey);
            return userData && ADMIN_USER_IDS.includes(userData.playerId);
        } catch (error) {
            if (error?.message !== 'Failed to fetch' && error?.name !== 'TypeError') {
                console.error('Error checking admin status:', error);
            }
            return false;
        }
    }

    // Function to add admin menu item if user is admin
    async function checkAndAddAdminMenu() {
        const nav = document.querySelector('nav ul');
        const existingAdminItem = document.querySelector('#admin-menu-item');
        
        if (await isAdmin()) {
            // Add admin menu item if it doesn't exist
            if (nav && !existingAdminItem) {
                const adminItem = document.createElement('li');
                adminItem.id = 'admin-menu-item';
                adminItem.innerHTML = '<a href="#admin-dashboard" class="nav-link">🔧 Admin Dashboard</a>';
                nav.appendChild(adminItem);
            }
        } else {
            // Remove admin menu item if it exists and user is not admin
            if (existingAdminItem) {
                existingAdminItem.remove();
            }
        }
    }

    // Function to calculate unique users and tool usage per day from logs
    function calculateUsagePerDay(logs, daysBack) {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysBack);
        
        // Filter logs to the time period
        const filteredLogs = logs.filter(log => {
            const logDate = new Date(log.timestamp);
            return logDate >= startDate;
        });
        
        // Group by date: unique users and unique users per tool per day
        const dailyData = {};
        const toolUsageData = {}; // { dateKey: { toolName: Set of users } }
        const allTools = new Set();
        
        filteredLogs.forEach(log => {
            const logDate = new Date(log.timestamp);
            const dateKey = logDate.toISOString().split('T')[0]; // YYYY-MM-DD format
            
            // Track unique users per day
            if (!dailyData[dateKey]) {
                dailyData[dateKey] = new Set();
            }
            dailyData[dateKey].add(log.userName);
            
            // Track unique users per tool per day (not total uses)
            if (!toolUsageData[dateKey]) {
                toolUsageData[dateKey] = {};
            }
            if (!toolUsageData[dateKey][log.tool]) {
                toolUsageData[dateKey][log.tool] = new Set();
            }
            toolUsageData[dateKey][log.tool].add(log.userName); // Add user to set (unique per day)
            allTools.add(log.tool);
        });
        
        // Convert to array format for chart
        const dates = [];
        const uniqueUsers = [];
        const toolUsage = {}; // { toolName: [counts per day] }
        
        // Initialize tool usage arrays
        allTools.forEach(tool => {
            toolUsage[tool] = [];
        });
        
        // Fill in all dates in the range (even if no usage)
        for (let i = daysBack - 1; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            const dateKey = date.toISOString().split('T')[0];
            
            dates.push(dateKey);
            uniqueUsers.push(dailyData[dateKey] ? dailyData[dateKey].size : 0);
            
            // Add tool usage for this date (count unique users, not total uses)
            allTools.forEach(tool => {
                const uniqueUsersForTool = toolUsageData[dateKey]?.[tool];
                toolUsage[tool].push(uniqueUsersForTool ? uniqueUsersForTool.size : 0);
            });
        }
        
        return { dates, uniqueUsers, toolUsage, allTools: Array.from(allTools).sort() };
    }
    
    // Color palette for tools (distinct colors)
    const toolColors = [
        '#ffd700', '#4da6ff', '#ff6b6b', '#51cf66', '#ffa94d',
        '#a78bfa', '#f472b6', '#60a5fa', '#34d399', '#fbbf24',
        '#818cf8', '#fb7185', '#4ade80', '#f59e0b', '#ec4899'
    ];
    
    // Function to get color for a tool (with cycling)
    function getToolColor(toolIndex) {
        return toolColors[toolIndex % toolColors.length];
    }
    
    // Function to render the users graph with tool usage
    function renderUsersGraph(logs, daysBack, visibilitySettings = {}) {
        const { dates, uniqueUsers, toolUsage, allTools } = calculateUsagePerDay(logs, daysBack);
        
        const canvas = document.getElementById('usersGraph');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.usersChart) {
            window.usersChart.destroy();
        }
        
        // Format dates for display (MM/DD)
        const displayDates = dates.map(date => {
            const d = new Date(date);
            return `${d.getMonth() + 1}/${d.getDate()}`;
        });
        
        // Build datasets based on visibility settings
        const datasets = [];
        
        // Add "Total Unique Users" dataset if visible
        if (visibilitySettings.totalUsers !== false) {
            datasets.push({
                label: 'Total Unique Users',
                data: uniqueUsers,
                borderColor: '#ffd700',
                backgroundColor: 'rgba(255, 215, 0, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 3,
                pointHoverRadius: 5,
                pointBackgroundColor: '#ffd700',
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                hidden: visibilitySettings.totalUsers === false
            });
        }
        
        // Add tool usage datasets
        allTools.forEach((tool, index) => {
            if (visibilitySettings[tool] !== false) {
                const color = getToolColor(index);
                // Add display name with alias for War Report 2.0
                let displayName = tool;
                if (tool === 'War Report 2.0' || tool === 'war-report-2.0') {
                    displayName = 'War Report 2.0 (Payout Calculator)';
                }
                datasets.push({
                    label: displayName,
                    data: toolUsage[tool],
                    borderColor: color,
                    backgroundColor: color.replace(')', ', 0.1)').replace('rgb', 'rgba'),
                    borderWidth: 2,
                    fill: false,
                    tension: 0.4,
                    pointRadius: 2,
                    pointHoverRadius: 4,
                    pointBackgroundColor: color,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1,
                    hidden: visibilitySettings[tool] === false
                });
            }
        });
        
        window.usersChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: displayDates,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#fff',
                            font: {
                                size: 12,
                                weight: 'bold'
                            },
                            usePointStyle: true,
                            padding: 10
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#ffd700',
                        bodyColor: '#fff',
                        borderColor: '#ffd700',
                        borderWidth: 1,
                        callbacks: {
                            title: function(context) {
                                const index = context[0].dataIndex;
                                return dates[index]; // Show full date in tooltip
                            },
                            label: function(context) {
                                const label = context.dataset.label || '';
                                const value = context.parsed.y;
                                if (label === 'Total Unique Users') {
                                    return `${label}: ${value}`;
                                } else {
                                    return `${label}: ${value} uses`;
                                }
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            color: '#fff',
                            maxRotation: 45,
                            minRotation: 45
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: '#fff',
                            stepSize: 1,
                            precision: 0
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        }
                    }
                }
            }
        });
    }
    
    // Function to initialize admin dashboard
    async function initAdminDashboard() {
        // Show loading indicator
        appContent.innerHTML = `
            <div class="container">
                <h2>🔧 Admin Dashboard</h2>
                <div style="text-align: center; padding: 40px;">
                    <div style="font-size: 24px; margin-bottom: 20px;">⏳</div>
                    <div>Loading usage data...</div>
                </div>
            </div>
        `;
        
        let logs = [];
        
        // Try to fetch from Google Sheets first
        try {
            const response = await fetch('https://script.google.com/macros/s/AKfycbx9dnveoMQYIAzjvsBrhzO1Fl9y29SAUsqLlQLG4YSiyIJ0FyAFpbj0idb854_7w87u/exec');
            if (response.ok) {
                logs = await response.json();
                console.log('Loaded logs from Google Sheets:', logs.length);
            }
        } catch (error) {
            console.error('Failed to fetch from Google Sheets, falling back to localStorage:', error);
            // Fallback to localStorage if Google Sheets fails
            logs = JSON.parse(localStorage.getItem('toolUsageLogs') || '[]');
        }
        
        // Filter out admin usage based on toggle setting
        const filteredLogs = showAdminData ? logs : logs.filter(log => !ADMIN_USER_NAMES.includes(log.userName));
        const allLogs = logs; // Keep original logs for complete view
        
        // Calculate statistics (excluding admin by default)
        const stats = {};
        const userStats = {};
        const factionStats = {}; // Track faction usage
        const recentLogs = filteredLogs.slice(-20).reverse(); // Last 20 logs, most recent first
        
        filteredLogs.forEach(log => {
            // Tool usage stats
            if (!stats[log.tool]) {
                stats[log.tool] = { count: 0, users: new Set() };
            }
            stats[log.tool].count++;
            stats[log.tool].users.add(log.userName);
            
            // User stats
            if (!userStats[log.userName]) {
                userStats[log.userName] = { 
                    count: 0, 
                    tools: new Set(), 
                    profileUrl: log.profileUrl,
                    factionName: log.factionName || 'No Faction',
                    lastUsed: log.timestamp
                };
            }
            userStats[log.userName].count++;
            userStats[log.userName].tools.add(log.tool);
            if (new Date(log.timestamp) > new Date(userStats[log.userName].lastUsed)) {
                userStats[log.userName].lastUsed = log.timestamp;
                // Update faction name to the most recent entry
                userStats[log.userName].factionName = log.factionName || 'No Faction';
            }
            
            // Faction usage stats
            const factionName = log.factionName || 'No Faction';
            if (!factionStats[factionName]) {
                factionStats[factionName] = { 
                    count: 0, 
                    users: new Set(),
                    factionId: log.factionId || null
                };
            }
            factionStats[factionName].count++;
            factionStats[factionName].users.add(log.userName);
        });
        
        // Sort stats
        const sortedToolStats = Object.entries(stats).sort((a, b) => b[1].count - a[1].count);
        const sortedUserStats = Object.entries(userStats).sort((a, b) => b[1].count - a[1].count).slice(0, 10); // Top 10 users
        const sortedFactionStats = Object.entries(factionStats).sort((a, b) => b[1].count - a[1].count).slice(0, 5); // Top 5 factions
        const uniqueFactionsCount = Object.keys(factionStats).length;
        
        // Generate HTML
        let html = `
            <div class="container">
                <h1>🔧 Admin Dashboard</h1>
                
                <div class="admin-tab-bar">
                    <button type="button" class="admin-tab-btn active" data-tab="overview">Overview</button>
                    <button type="button" class="admin-tab-btn" data-tab="usage">Usage</button>
                    <button type="button" class="admin-tab-btn" data-tab="activity">Activity</button>
                    <button type="button" class="admin-tab-btn" data-tab="vip">VIP Balances</button>
                </div>
                
                <div id="admin-tab-overview" class="admin-tab-panel">
                <div style="margin-bottom: 20px; text-align: center;">
                    <button id="toggleAdminFilter" class="fetch-button" style="background-color: var(--accent-color);">
                        ${showAdminData ? '📊 Including Admin Usage' : '📊 Excluding Admin Usage'} (${filteredLogs.length} uses)
                    </button>
                    <p style="margin: 10px 0; color: var(--text-color); font-size: 0.9em;">
                        ${showAdminData ? 
                            `Showing all usage including admin testing (${allLogs.length} total uses)` : 
                            `Excluding admin testing usage. Click to show all usage (${allLogs.length} total)`
                        }
                    </p>
                </div>
                
                <div class="stats-grid">
                    <div class="stat-card">
                        <h3>Tool Uses</h3>
                        <div class="stat-number">${filteredLogs.length}</div>
                        <div style="font-size: 0.8em; color: #888;">${showAdminData ? '(including admin)' : `(${allLogs.length} total)`}</div>
                    </div>
                    <div class="stat-card">
                        <h3>Unique Users</h3>
                        <div class="stat-number">${Object.keys(userStats).length}</div>
                        <div style="font-size: 0.8em; color: #888;">${showAdminData ? '(including admin)' : '(excluding admin)'}</div>
                    </div>
                    <div class="stat-card">
                        <h3>Unique Factions</h3>
                        <div class="stat-number">${uniqueFactionsCount}</div>
                        <div style="font-size: 0.8em; color: #888;">${showAdminData ? '(including admin)' : '(excluding admin)'}</div>
                    </div>
                    <div class="stat-card">
                        <h3>Tools Available</h3>
                        <div class="stat-number">${Object.keys(stats).length}</div>
                    </div>
                </div>
                
                <div class="dashboard-section">
                    <h2>Usage Analytics</h2>
                    <div style="margin-bottom: 15px; display: flex; gap: 10px; flex-wrap: wrap;">
                        <button class="time-period-btn" data-days="7">1 Week</button>
                        <button class="time-period-btn active" data-days="30">1 Month</button>
                        <button class="time-period-btn" data-days="90">3 Months</button>
                        <button class="time-period-btn" data-days="180">6 Months</button>
                        <button class="time-period-btn" data-days="365">1 Year</button>
                    </div>
                    <div style="margin-bottom: 15px; background-color: var(--secondary-color); padding: 15px; border-radius: 8px;">
                        <div style="margin-bottom: 10px; font-weight: bold; color: var(--accent-color);">Show on Graph:</div>
                        <div id="graphVisibilityControls" style="display: flex; flex-wrap: wrap; gap: 15px;">
                            <!-- Checkboxes will be added here -->
                        </div>
                    </div>
                    <div style="position: relative; height: 400px; background-color: var(--primary-color); border-radius: 8px; padding: 20px;">
                        <canvas id="usersGraph"></canvas>
                    </div>
                </div>
                </div>
                
                <div id="admin-tab-usage" class="admin-tab-panel" style="display: none;">
                <div class="dashboard-section">
                    <h2>Most Used Tools</h2>
                    <table class="admin-table">
                        <thead>
                            <tr>
                                <th>Tool</th>
                                <th>Uses</th>
                                <th>Unique Users</th>
                            </tr>
                        </thead>
                        <tbody>
        `;
        
        sortedToolStats.forEach(([tool, data]) => {
            html += `
                <tr>
                    <td><strong>${tool}</strong></td>
                    <td>${data.count}</td>
                    <td>${data.users.size}</td>
                </tr>
            `;
        });
        
        html += `
                        </tbody>
                    </table>
                </div>
                
                <div class="dashboard-section">
                    <h2>Top 5 Most Using Factions</h2>
                    <table class="admin-table">
                        <thead>
                            <tr>
                                <th>Faction</th>
                                <th>Total Uses</th>
                                <th>Unique Users</th>
                            </tr>
                        </thead>
                        <tbody>
        `;
        
        sortedFactionStats.forEach(([factionName, data]) => {
            const factionLink = data.factionId 
                ? `<a href="https://www.torn.com/factions.php?step=profile&ID=${data.factionId}" target="_blank" class="user-link">${factionName}</a>`
                : factionName;
            html += `
                <tr>
                    <td><strong>${factionLink}</strong></td>
                    <td>${data.count}</td>
                    <td>${data.users.size}</td>
                </tr>
            `;
        });
        
        html += `
                        </tbody>
                    </table>
                </div>
                
                <div class="dashboard-section">
                    <h2>Top 10 Most Active Users</h2>
                    <table class="admin-table">
                        <thead>
                            <tr>
                                <th>User</th>
                                <th>Faction</th>
                                <th>Total Uses</th>
                                <th>Tools Used</th>
                                <th>Last Used</th>
                            </tr>
                        </thead>
                        <tbody>
        `;
        
        sortedUserStats.forEach(([userName, data]) => {
            const lastUsed = new Date(data.lastUsed).toLocaleDateString();
            html += `
                <tr>
                    <td><a href="${data.profileUrl}" target="_blank" class="user-link">${userName}</a></td>
                    <td>${data.factionName}</td>
                    <td>${data.count}</td>
                    <td>${Array.from(data.tools).join(', ')}</td>
                    <td>${lastUsed}</td>
                </tr>
            `;
        });
        
        html += `
                        </tbody>
                    </table>
                </div>
                </div>
                
                <div id="admin-tab-activity" class="admin-tab-panel" style="display: none;">
                <div class="dashboard-section">
                    <h2>Recent Activity (Last 20)</h2>
                    <table class="admin-table">
                        <thead>
                            <tr>
                                <th>Timestamp</th>
                                <th>User</th>
                                <th>Faction</th>
                                <th>Tool</th>
                            </tr>
                        </thead>
                        <tbody>
        `;
        
        recentLogs.forEach(log => {
            const timestamp = new Date(log.timestamp).toLocaleString();
            html += `
                <tr>
                    <td>${timestamp}</td>
                    <td><a href="${log.profileUrl}" target="_blank" class="user-link">${log.userName}</a></td>
                    <td>${log.factionName || 'Unknown Faction'}</td>
                    <td><strong>${log.tool}</strong></td>
                </tr>
            `;
        });
        
        html += `
                        </tbody>
                    </table>
                </div>
                
                <div class="dashboard-section">
                    <h2>All Users & Complete Logs</h2>
                    <div style="margin-bottom: 15px;">
                        <button id="showAllUsers" class="fetch-button" style="margin-right: 10px;">Show All Users</button>
                        <button id="showAllLogs" class="fetch-button" style="margin-right: 10px;">Show All Logs</button>
                        <button id="exportLogs" class="fetch-button" style="background-color: var(--accent-color);">Export Logs (JSON)</button>
                    </div>
                    <div id="allUsersSection" style="display: none;">
                        <h3>Complete User List (${Object.keys(userStats).length} users)</h3>
                        <table class="admin-table">
                            <thead>
                                <tr>
                                    <th>User</th>
                                    <th>Faction</th>
                                    <th>Total Uses</th>
                                    <th>Tools Used</th>
                                    <th>First Used</th>
                                    <th>Last Used</th>
                                </tr>
                            </thead>
                            <tbody>
        `;
        
        // Sort users by first appearance (oldest first)
        const sortedAllUsers = Object.entries(userStats).sort((a, b) => 
            new Date(a[1].firstUsed || a[1].lastUsed) - new Date(b[1].firstUsed || b[1].lastUsed)
        );
        
        // Calculate first used date for each user
        sortedAllUsers.forEach(([userName, data]) => {
            const userLogs = logs.filter(log => log.userName === userName);
            const firstUsed = userLogs.length > 0 ? userLogs[userLogs.length - 1].timestamp : data.lastUsed;
            data.firstUsed = firstUsed;
        });
        
        sortedAllUsers.forEach(([userName, data]) => {
            const firstUsed = new Date(data.firstUsed).toLocaleDateString();
            const lastUsed = new Date(data.lastUsed).toLocaleDateString();
            html += `
                <tr>
                    <td><a href="${data.profileUrl}" target="_blank" class="user-link">${userName}</a></td>
                    <td>${data.factionName}</td>
                    <td>${data.count}</td>
                    <td>${Array.from(data.tools).join(', ')}</td>
                    <td>${firstUsed}</td>
                    <td>${lastUsed}</td>
                </tr>
            `;
        });
        
        html += `
                            </tbody>
                        </table>
                    </div>
                    
                    <div id="allLogsSection" style="display: none;">
                        <h3>Complete Activity Log (${logs.length} entries)</h3>
                        <table class="admin-table">
                            <thead>
                                <tr>
                                    <th>Timestamp</th>
                                    <th>User</th>
                                    <th>Faction</th>
                                    <th>Tool</th>
                                    <th>Player ID</th>
                                </tr>
                            </thead>
                            <tbody>
        `;
        
        // Sort all logs by timestamp (newest first)
        const sortedAllLogs = [...logs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        sortedAllLogs.forEach(log => {
            const timestamp = new Date(log.timestamp).toLocaleString();
            html += `
                <tr>
                    <td>${timestamp}</td>
                    <td><a href="${log.profileUrl}" target="_blank" class="user-link">${log.userName}</a></td>
                    <td>${log.factionName || 'Unknown Faction'}</td>
                    <td><strong>${log.tool}</strong></td>
                    <td>${log.playerId}</td>
                </tr>
            `;
        });
        
        html += `
                            </tbody>
                        </table>
                    </div>
                </div>
                </div>
                
                <div id="admin-tab-vip" class="admin-tab-panel" style="display: none;">
                <div class="dashboard-section" id="admin-vip-section">
                    <h2>VIP Balances</h2>
                    <div id="admin-vip-loading" style="padding: 20px; text-align: center;">Loading VIP balances...</div>
                    <div id="admin-vip-content" style="display: none;"></div>
                </div>
                </div>
            </div>
        `;
        
        appContent.innerHTML = html;
        
        // Tab switching
        document.querySelectorAll('.admin-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                document.querySelectorAll('.admin-tab-panel').forEach(panel => {
                    panel.style.display = panel.id === `admin-tab-${tab}` ? 'block' : 'none';
                });
                document.querySelectorAll('.admin-tab-btn').forEach(b => {
                    b.classList.toggle('active', b === btn);
                });
            });
        });
        
        // Load VIP balances (admin-only callable) and render table with edit
        (async function loadAdminVipBalances() {
            const loadingEl = document.getElementById('admin-vip-loading');
            const contentEl = document.getElementById('admin-vip-content');
            if (!loadingEl || !contentEl) return;
            if (window._adminVipCountdownInterval) {
                clearInterval(window._adminVipCountdownInterval);
                window._adminVipCountdownInterval = null;
            }
            const apiKey = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
            if (!apiKey || apiKey.length !== 16) {
                loadingEl.textContent = 'Enter your 16-character API key in the sidebar to load VIP balances.';
                return;
            }
            try {
                if (typeof firebase === 'undefined' || !firebase.functions) {
                    loadingEl.textContent = 'Firebase not loaded.';
                    return;
                }
                (function ensureAdminVipAddPlayerModal() {
                    const existingOverlay = document.getElementById('admin-vip-add-player-modal');
                    if (existingOverlay) {
                        window.__openAdminVipAddPlayerModal = function () {
                            const o = document.getElementById('admin-vip-add-player-modal');
                            const prof = document.getElementById('admin-vip-add-profile-input');
                            const bal = document.getElementById('admin-vip-add-balance-input');
                            const sent = document.getElementById('admin-vip-add-totalsent-input');
                            if (!o || !prof) return;
                            prof.value = '';
                            if (bal) bal.value = '';
                            if (sent) sent.value = '0';
                            o.style.display = 'flex';
                            o.setAttribute('aria-hidden', 'false');
                            prof.focus();
                        };
                        return;
                    }
                    const overlay = document.createElement('div');
                    overlay.id = 'admin-vip-add-player-modal';
                    overlay.className = 'app-modal-overlay';
                    overlay.setAttribute('aria-hidden', 'true');
                    overlay.style.display = 'none';
                    overlay.innerHTML = '<div class="app-modal" role="dialog" style="max-width: 440px;" aria-labelledby="admin-vip-add-player-title">' +
                        '<div class="app-modal-header">' +
                        '<h2 id="admin-vip-add-player-title">Add VIP player</h2>' +
                        '<button type="button" class="app-modal-close" id="admin-vip-add-player-modal-close" aria-label="Close">×</button>' +
                        '</div>' +
                        '<div class="app-modal-body">' +
                        '<p style="font-size:0.9em;color:#95a5a6;margin:0 0 14px 0;">Profile link or player ID. Name and faction load from Torn. Deduction timer starts from now.</p>' +
                        '<div class="app-modal-row"><label class="app-modal-label" for="admin-vip-add-profile-input">Profile link or player ID</label>' +
                        '<input type="text" id="admin-vip-add-profile-input" class="app-modal-input" placeholder="https://www.torn.com/profiles.php?XID=1234567" autocomplete="off"></div>' +
                        '<div class="app-modal-row"><label class="app-modal-label" for="admin-vip-add-balance-input">Current balance (Xanax)</label>' +
                        '<input type="number" id="admin-vip-add-balance-input" class="app-modal-input" min="0" step="1" placeholder="25"></div>' +
                        '<div class="app-modal-row"><label class="app-modal-label" for="admin-vip-add-totalsent-input">Total sent (optional)</label>' +
                        '<input type="number" id="admin-vip-add-totalsent-input" class="app-modal-input" min="0" step="1" value="0">' +
                        '<span style="font-size:0.8em;color:#888;display:block;margin-top:6px;">0 = free trial (gift balance only). Match balance if they actually sent that much.</span></div>' +
                        '<div class="app-modal-actions">' +
                        '<button type="button" class="fetch-button" id="admin-vip-add-player-cancel">Cancel</button>' +
                        '<button type="button" class="fetch-button" id="admin-vip-add-player-save" style="background-color:#15803d;">Add / update</button>' +
                        '</div></div></div>';
                    document.body.appendChild(overlay);
                    function closeAddPlayerModal() {
                        overlay.style.display = 'none';
                        overlay.setAttribute('aria-hidden', 'true');
                    }
                    overlay.querySelector('#admin-vip-add-player-modal-close').addEventListener('click', closeAddPlayerModal);
                    overlay.querySelector('#admin-vip-add-player-cancel').addEventListener('click', closeAddPlayerModal);
                    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeAddPlayerModal(); });
                    function parseTornProfilePlayerId(input) {
                        const s = String(input || '').trim();
                        if (!s) return null;
                        if (/^\d+$/.test(s)) return s;
                        const xid = s.match(/(?:^|[?&#])XID=(\d+)/i);
                        if (xid) return xid[1];
                        const m = s.match(/\/user\/(\d+)/i) || s.match(/torn\.com\/(\d+)(?:\/|[?#]|$)/i);
                        if (m) return m[1];
                        return null;
                    }
                    overlay.querySelector('#admin-vip-add-player-save').addEventListener('click', function() {
                        const apiK = (localStorage.getItem('tornApiKey') || '').trim();
                        const raw = document.getElementById('admin-vip-add-profile-input').value;
                        const pid = parseTornProfilePlayerId(raw);
                        if (!pid) {
                            alert('Could not find a player ID. Paste a profile URL with XID=… or the numeric ID.');
                            return;
                        }
                        const bal = parseInt(document.getElementById('admin-vip-add-balance-input').value, 10);
                        if (isNaN(bal) || bal < 0) {
                            alert('Enter a valid current balance (0 or more).');
                            return;
                        }
                        const sentIn = document.getElementById('admin-vip-add-totalsent-input').value;
                        const sent = sentIn === '' ? 0 : parseInt(sentIn, 10);
                        if (isNaN(sent) || sent < 0) {
                            alert('Total sent must be 0 or a positive number.');
                            return;
                        }
                        const saveBtn = document.getElementById('admin-vip-add-player-save');
                        saveBtn.disabled = true;
                        firebase.functions().httpsCallable('adminAddVipPlayer')({
                            apiKey: apiK.replace(/[^A-Za-z0-9]/g, ''),
                            playerId: pid,
                            currentBalance: bal,
                            totalXanaxSent: sent
                        }).then(function(result) {
                            const name = (result && result.data && result.data.playerName) || pid;
                            closeAddPlayerModal();
                            alert('Saved: ' + name);
                            if (typeof window.initAdminDashboard === 'function') {
                                return window.initAdminDashboard();
                            }
                        }).then(function() {
                            const tab = document.querySelector('.admin-tab-btn[data-tab="vip"]');
                            if (tab) tab.click();
                        }).catch(function(e) {
                            console.error(e);
                            alert((e && e.message) || (e && e.code) || 'Failed to add player');
                        }).finally(function() { saveBtn.disabled = false; });
                    });
                    window.__openAdminVipAddPlayerModal = function() {
                        document.getElementById('admin-vip-add-profile-input').value = '';
                        document.getElementById('admin-vip-add-balance-input').value = '';
                        document.getElementById('admin-vip-add-totalsent-input').value = '0';
                        overlay.style.display = 'flex';
                        overlay.setAttribute('aria-hidden', 'false');
                        document.getElementById('admin-vip-add-profile-input').focus();
                    };
                })();
                const fn = firebase.functions().httpsCallable('getVipBalancesForAdmin');
                const res = await fn({ apiKey: apiKey });
                const balances = (res && res.data && res.data.balances) || [];
                loadingEl.style.display = 'none';
                contentEl.style.display = 'block';
                const toolbarHtml = '<div class="admin-vip-toolbar" style="margin-bottom: 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">' +
                    '<button type="button" class="fetch-button" id="admin-vip-add-player-btn" style="background-color: #15803d;">Add player</button>' +
                    '<button type="button" class="fetch-button" id="admin-vip-refresh-list-btn" title="Fetch latest balances from the server">Refresh list</button>' +
                    '<button type="button" class="fetch-button" id="admin-vip-apply-deductions-btn" style="background-color: var(--accent-color);">Apply deductions now</button>' +
                    '<button type="button" class="fetch-button" id="admin-vip-reset-clock-btn" title="Set everyone\u2019s next deduction to 48 hours from now. Use after restoring balances so old timers don\u2019t wipe them.">Reset deduction clock</button>' +
                    '<span id="admin-vip-apply-status" style="font-size: 0.9em; color: #888;"></span></div>';
                function wireAdminVipToolbarButtons() {
                    var addBtn = document.getElementById('admin-vip-add-player-btn');
                    if (addBtn) addBtn.onclick = function() { window.__openAdminVipAddPlayerModal && window.__openAdminVipAddPlayerModal(); };
                    var refBtn = document.getElementById('admin-vip-refresh-list-btn');
                    if (refBtn) refBtn.onclick = function() {
                        if (typeof window.__adminVipPullBalancesAndRender === 'function') window.__adminVipPullBalancesAndRender();
                    };
                }
                if (balances.length === 0) {
                    contentEl.innerHTML = toolbarHtml + '<p style="color: #888;">No VIP balances yet. Use <strong>Add player</strong> to add someone by profile link.</p>';
                    wireAdminVipToolbarButtons();
                    return;
                }
                const sorted = balances.slice().sort((a, b) => (b.currentBalance || 0) - (a.currentBalance || 0));
                function formatNextDeductionCountdown(ms) {
                    if (ms <= 0) return '0s';
                    const sec = Math.floor(ms / 1000);
                    if (sec < 60) return sec + 's';
                    const d = Math.floor(ms / (24 * 60 * 60 * 1000));
                    const h = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                    const m = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
                    const s = Math.floor((ms % (60 * 1000)) / 1000);
                    if (d > 0) return d + 'd ' + h + 'h';
                    if (h > 0) return h + 'h ' + m + 'm';
                    if (s === 0) return m + 'm';
                    return m + 'm ' + s + 's';
                }
                const ADMIN_VIP_NEXT_DED_MS = 2 * 24 * 60 * 60 * 1000; // 48 hours
                function adminVipNextDeductionCellForRow(row) {
                    const bal = Number(row.currentBalance) || 0;
                    if (bal <= 0) return '<span class="admin-next-deduction-na" style="color:#888;">—</span>';
                    var nextDedMs;
                    if (row.lastDeductionDate) {
                        nextDedMs = new Date(row.lastDeductionDate).getTime() + ADMIN_VIP_NEXT_DED_MS;
                    } else {
                        nextDedMs = Date.now() + ADMIN_VIP_NEXT_DED_MS;
                    }
                    var nextDedDate = new Date(nextDedMs);
                    var countdownMs = Math.max(0, nextDedMs - Date.now());
                    var nextDedTs = String(nextDedMs);
                    return '<span class="admin-next-deduction-date">' + nextDedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + '</span><br><span class="admin-next-deduction-countdown" data-until="' + nextDedTs + '">' + formatNextDeductionCountdown(countdownMs) + '</span>';
                }
                let tableHtml = '<table class="admin-table"><thead><tr><th>Player ID</th><th>Player Name</th><th>Faction</th><th>Total Sent</th><th>Current Balance</th><th>VIP</th><th>Next deduction</th><th>Last Login</th><th>Actions</th></tr></thead><tbody>';
                sorted.forEach(function(row) {
                    var nextDedCell = adminVipNextDeductionCellForRow(row);
                    const lastLog = row.lastLoginDate ? new Date(row.lastLoginDate).toLocaleDateString() : '—';
                    tableHtml += '<tr data-player-id="' + String(row.playerId).replace(/"/g, '&quot;') + '">' +
                        '<td>' + String(row.playerId) + '</td>' +
                        '<td><a href="https://www.torn.com/profiles.php?XID=' + row.playerId + '" target="_blank" class="user-link">' + (row.playerName || '—') + '</a> <button type="button" class="admin-vip-history-btn" data-player-id="' + String(row.playerId).replace(/"/g, '&quot;') + '" data-player-name="' + String(row.playerName || '—').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '" aria-label="Xanax history" title="Xanax history">ⓘ</button></td>' +
                        '<td>' + (row.factionName || (userStats[row.playerName] && userStats[row.playerName].factionName) || '—') + '</td>' +
                        '<td class="admin-vip-total-sent">' + (row.totalXanaxSent ?? 0) + '</td>' +
                        '<td class="admin-vip-balance">' + (row.currentBalance ?? 0) + '</td>' +
                        '<td>VIP ' + (row.vipLevel ?? 0) + '</td>' +
                        '<td class="admin-next-deduction-cell">' + nextDedCell + '</td>' +
                        '<td>' + lastLog + '</td>' +
                        '<td><button type="button" class="fetch-button admin-vip-edit-btn" style="padding: 4px 10px; font-size: 12px;">Edit</button></td></tr>';
                });
                tableHtml += '</tbody></table>';
                contentEl.innerHTML = toolbarHtml + tableHtml;
                // Apply deductions now button (must be a scoped function, not an IIFE name — adminVipPullBalancesAndRender calls this)
                function attachApplyDeductionsListener() {
                    const btn = document.getElementById('admin-vip-apply-deductions-btn');
                    const statusEl = document.getElementById('admin-vip-apply-status');
                    if (!btn) return;
                    btn.onclick = function() {
                        if (btn.disabled) return;
                        btn.disabled = true;
                        if (statusEl) statusEl.textContent = 'Applying…';
                        firebase.functions().httpsCallable('applyVipDeductionsNow')({ apiKey: apiKey })
                            .then(function(result) {
                                const n = (result && result.data && result.data.updated) || 0;
                                if (statusEl) statusEl.textContent = 'Updated ' + n + ' player(s). Refreshing…';
                                return fn({ apiKey: apiKey });
                            })
                            .then(function(res) {
                                const balances2 = (res && res.data && res.data.balances) || [];
                                if (balances2.length === 0) {
                                    contentEl.innerHTML = toolbarHtml + '<p style="color: #888;">No VIP balances yet.</p>';
                                    btn.disabled = false;
                                    if (statusEl) statusEl.textContent = '';
                                    attachApplyDeductionsListener();
                                    attachResetClockListener();
                                    wireAdminVipToolbarButtons();
                                    return;
                                }
                                const sorted2 = balances2.slice().sort((a, b) => (b.currentBalance || 0) - (a.currentBalance || 0));
                                let tableHtml2 = '<table class="admin-table"><thead><tr><th>Player ID</th><th>Player Name</th><th>Faction</th><th>Total Sent</th><th>Current Balance</th><th>VIP</th><th>Next deduction</th><th>Last Login</th><th>Actions</th></tr></thead><tbody>';
                                sorted2.forEach(function(row) {
                                    var nextDedCell = adminVipNextDeductionCellForRow(row);
                                    const lastLog = row.lastLoginDate ? new Date(row.lastLoginDate).toLocaleDateString() : '—';
                                    tableHtml2 += '<tr data-player-id="' + String(row.playerId).replace(/"/g, '&quot;') + '">' +
                                        '<td>' + String(row.playerId) + '</td>' +
                                        '<td><a href="https://www.torn.com/profiles.php?XID=' + row.playerId + '" target="_blank" class="user-link">' + (row.playerName || '—') + '</a> <button type="button" class="admin-vip-history-btn" data-player-id="' + String(row.playerId).replace(/"/g, '&quot;') + '" data-player-name="' + String(row.playerName || '—').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '" aria-label="Xanax history" title="Xanax history">ⓘ</button></td>' +
                                        '<td>' + (row.factionName || (userStats[row.playerName] && userStats[row.playerName].factionName) || '—') + '</td>' +
                                        '<td class="admin-vip-total-sent">' + (row.totalXanaxSent ?? 0) + '</td>' +
                                        '<td class="admin-vip-balance">' + (row.currentBalance ?? 0) + '</td>' +
                                        '<td>VIP ' + (row.vipLevel ?? 0) + '</td>' +
                                        '<td class="admin-next-deduction-cell">' + nextDedCell + '</td>' +
                                        '<td>' + lastLog + '</td>' +
                                        '<td><button type="button" class="fetch-button admin-vip-edit-btn" style="padding: 4px 10px; font-size: 12px;">Edit</button></td></tr>';
                                });
                                tableHtml2 += '</tbody></table>';
                                contentEl.innerHTML = toolbarHtml + tableHtml2;
                                if (statusEl) statusEl.textContent = '';
                                btn.disabled = false;
                                contentEl.querySelectorAll('.admin-vip-edit-btn').forEach(function(editBtn) {
                                    (function bindEdit(btnEl, sortedArr) {
                                        btnEl.addEventListener('click', function() {
                                            const tr = btnEl.closest('tr');
                                            const playerId = tr.getAttribute('data-player-id');
                                            const row = sortedArr.find(function(r) { return String(r.playerId) === playerId; });
                                            if (!row) return;
                                            const totalSentInput = document.getElementById('admin-vip-edit-total-sent');
                                            const balanceInput = document.getElementById('admin-vip-edit-balance');
                                            if (!totalSentInput || !balanceInput) return;
                                            totalSentInput.value = row.totalXanaxSent ?? 0;
                                            balanceInput.value = row.currentBalance ?? 0;
                                            vipEditOverlay.style.display = 'flex';
                                            vipEditOverlay.setAttribute('aria-hidden', 'false');
                                            totalSentInput.focus();
                                            function closeModal() {
                                                vipEditOverlay.style.display = 'none';
                                                vipEditOverlay.setAttribute('aria-hidden', 'true');
                                            }
                                            function doSave() {
                                                const totalSent = parseInt(totalSentInput.value, 10);
                                                const num = parseInt(balanceInput.value, 10);
                                                if (isNaN(totalSent) || totalSent < 0) { alert('Total sent must be a non-negative number.'); return; }
                                                if (isNaN(num) || num < 0) { alert('Current balance must be a non-negative number.'); return; }
                                                const newLevel = num >= 100 ? 3 : num >= 50 ? 2 : num >= 10 ? 1 : 0;
                                                btnEl.disabled = true;
                                                firebase.functions().httpsCallable('updateVipBalance')({
                                                    playerId: row.playerId, playerName: row.playerName, factionName: row.factionName, factionId: row.factionId,
                                                    totalXanaxSent: totalSent, currentBalance: num, lastDeductionDate: new Date().toISOString(), vipLevel: newLevel, lastLoginDate: row.lastLoginDate
                                                }).then(function() {
                                                    tr.querySelector('.admin-vip-total-sent').textContent = totalSent;
                                                    tr.querySelector('.admin-vip-balance').textContent = num;
                                                    tr.querySelector('td:nth-child(6)').textContent = 'VIP ' + newLevel;
                                                    row.totalXanaxSent = totalSent; row.currentBalance = num; row.vipLevel = newLevel;
                                                    closeModal();
                                                    clearVipCache(row.playerId);
                                                    const apiKey2 = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
                                                    if (apiKey2 && apiKey2.length === 16) {
                                                        getUserData(apiKey2).then(function(ud) {
                                                            if (ud && String(ud.playerId) === String(row.playerId)) updateWelcomeMessage();
                                                        });
                                                    }
                                                }).catch(function(e) { console.error(e); alert('Update failed: ' + (e.message || e)); }).finally(function() { btnEl.disabled = false; });
                                            }
                                            vipEditOverlay.querySelector('#admin-vip-edit-save').onclick = doSave;
                                            vipEditOverlay.querySelector('#admin-vip-edit-modal-close').onclick = closeModal;
                                            vipEditOverlay.querySelector('#admin-vip-edit-cancel').onclick = closeModal;
                                        });
                                    })(editBtn, sorted2);
                                });
                                contentEl.querySelectorAll('.admin-vip-history-btn').forEach(function(historyBtn) {
                                    historyBtn.addEventListener('click', function() {
                                        const playerId = historyBtn.getAttribute('data-player-id');
                                        const playerName = historyBtn.getAttribute('data-player-name');
                                        const titleEl = document.getElementById('admin-vip-history-modal-title');
                                        const bodyEl = document.getElementById('admin-vip-history-modal-body');
                                        if (!titleEl || !bodyEl) return;
                                        titleEl.textContent = 'Xanax history — ' + playerName;
                                        bodyEl.innerHTML = '<p style="color: #888;">Loading...</p>';
                                        vipHistoryOverlay.style.display = 'flex';
                                        vipHistoryOverlay.setAttribute('aria-hidden', 'false');
                                        const apiKey2 = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
                                        if (!apiKey2 || apiKey2.length !== 16) {
                                            bodyEl.innerHTML = '<p style="color: #c0392b;">Enter your API key in the sidebar to load history.</p>';
                                            return;
                                        }
                                        firebase.functions().httpsCallable('getVipTransactionsForAdmin')({ apiKey: apiKey2, playerId: playerId })
                                            .then(function(result) {
                                                const transactions = result.data && result.data.transactions ? result.data.transactions : [];
                                                if (transactions.length === 0) { bodyEl.innerHTML = '<p style="color: #888;">No transactions yet.</p>'; return; }
                                                let tableHtml3 = '<table class="admin-table" style="font-size: 0.9rem;"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance after</th></tr></thead><tbody>';
                                                transactions.forEach(function(t) {
                                                    const dateStr = t.timestamp ? new Date(t.timestamp).toLocaleString() : '—';
                                                    tableHtml3 += '<tr><td>' + dateStr + '</td><td>' + (t.transactionType || 'Sent') + '</td><td>' + (t.amount ?? 0) + '</td><td>' + (t.balanceAfter ?? 0) + '</td></tr>';
                                                });
                                                tableHtml3 += '</tbody></table>';
                                                bodyEl.innerHTML = tableHtml3;
                                            })
                                            .catch(function(e) { console.error(e); bodyEl.innerHTML = '<p style="color: #c0392b;">Failed to load history. ' + (e.message || e.code || '') + '</p>'; });
                                    });
                                });
                                attachApplyDeductionsListener();
                                attachResetClockListener();
                                wireAdminVipToolbarButtons();
                            })
                            .catch(function(e) {
                                console.error(e);
                                if (statusEl) statusEl.textContent = 'Failed: ' + (e.message || e.code || '');
                                btn.disabled = false;
                            });
                    };
                }
                attachApplyDeductionsListener();
                function attachResetClockListener() {
                    const resetBtn = document.getElementById('admin-vip-reset-clock-btn');
                    const statusEl = document.getElementById('admin-vip-apply-status');
                    if (!resetBtn) return;
                    resetBtn.onclick = function() {
                        if (resetBtn.disabled) return;
                        resetBtn.disabled = true;
                        if (statusEl) statusEl.textContent = 'Resetting clock…';
                        firebase.functions().httpsCallable('resetVipDeductionClock')({ apiKey: apiKey })
                            .then(function(result) {
                                const n = (result && result.data && result.data.reset) || 0;
                                if (statusEl) statusEl.textContent = 'Reset ' + n + ' player(s). Refreshing…';
                                return fn({ apiKey: apiKey });
                            })
                            .then(function(res) {
                                const balances2 = (res && res.data && res.data.balances) || [];
                                if (balances2.length === 0) {
                                    resetBtn.disabled = false;
                                    if (statusEl) statusEl.textContent = '';
                                    return;
                                }
                                const sorted2 = balances2.slice().sort((a, b) => (b.currentBalance || 0) - (a.currentBalance || 0));
                                let tableHtml2 = '<table class="admin-table"><thead><tr><th>Player ID</th><th>Player Name</th><th>Faction</th><th>Total Sent</th><th>Current Balance</th><th>VIP</th><th>Next deduction</th><th>Last Login</th><th>Actions</th></tr></thead><tbody>';
                                sorted2.forEach(function(row) {
                                    var nextDedCell = adminVipNextDeductionCellForRow(row);
                                    const lastLog = row.lastLoginDate ? new Date(row.lastLoginDate).toLocaleDateString() : '—';
                                    tableHtml2 += '<tr data-player-id="' + String(row.playerId).replace(/"/g, '&quot;') + '">' +
                                        '<td>' + String(row.playerId) + '</td>' +
                                        '<td><a href="https://www.torn.com/profiles.php?XID=' + row.playerId + '" target="_blank" class="user-link">' + (row.playerName || '—') + '</a> <button type="button" class="admin-vip-history-btn" data-player-id="' + String(row.playerId).replace(/"/g, '&quot;') + '" data-player-name="' + String(row.playerName || '—').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '" aria-label="Xanax history" title="Xanax history">ⓘ</button></td>' +
                                        '<td>' + (row.factionName || (userStats[row.playerName] && userStats[row.playerName].factionName) || '—') + '</td>' +
                                        '<td class="admin-vip-total-sent">' + (row.totalXanaxSent ?? 0) + '</td>' +
                                        '<td class="admin-vip-balance">' + (row.currentBalance ?? 0) + '</td>' +
                                        '<td>VIP ' + (row.vipLevel ?? 0) + '</td>' +
                                        '<td class="admin-next-deduction-cell">' + nextDedCell + '</td>' +
                                        '<td>' + lastLog + '</td>' +
                                        '<td><button type="button" class="fetch-button admin-vip-edit-btn" style="padding: 4px 10px; font-size: 12px;">Edit</button></td></tr>';
                                });
                                tableHtml2 += '</tbody></table>';
                                contentEl.innerHTML = toolbarHtml + tableHtml2;
                                if (statusEl) statusEl.textContent = '';
                                resetBtn.disabled = false;
                                contentEl.querySelectorAll('.admin-vip-edit-btn').forEach(function(editBtn) {
                                    (function bindEdit(btnEl, sortedArr) {
                                        btnEl.addEventListener('click', function() {
                                            const tr = btnEl.closest('tr');
                                            const playerId = tr.getAttribute('data-player-id');
                                            const row = sortedArr.find(function(r) { return String(r.playerId) === playerId; });
                                            if (!row) return;
                                            const totalSentInput = document.getElementById('admin-vip-edit-total-sent');
                                            const balanceInput = document.getElementById('admin-vip-edit-balance');
                                            if (!totalSentInput || !balanceInput) return;
                                            totalSentInput.value = row.totalXanaxSent ?? 0;
                                            balanceInput.value = row.currentBalance ?? 0;
                                            vipEditOverlay.style.display = 'flex';
                                            vipEditOverlay.setAttribute('aria-hidden', 'false');
                                            totalSentInput.focus();
                                            function closeModal() {
                                                vipEditOverlay.style.display = 'none';
                                                vipEditOverlay.setAttribute('aria-hidden', 'true');
                                            }
                                            function doSave() {
                                                const totalSent = parseInt(totalSentInput.value, 10);
                                                const num = parseInt(balanceInput.value, 10);
                                                if (isNaN(totalSent) || totalSent < 0) { alert('Total sent must be a non-negative number.'); return; }
                                                if (isNaN(num) || num < 0) { alert('Current balance must be a non-negative number.'); return; }
                                                const newLevel = num >= 100 ? 3 : num >= 50 ? 2 : num >= 10 ? 1 : 0;
                                                btnEl.disabled = true;
                                                firebase.functions().httpsCallable('updateVipBalance')({
                                                    playerId: row.playerId, playerName: row.playerName, factionName: row.factionName, factionId: row.factionId,
                                                    totalXanaxSent: totalSent, currentBalance: num, lastDeductionDate: new Date().toISOString(), vipLevel: newLevel, lastLoginDate: row.lastLoginDate
                                                }).then(function() {
                                                    tr.querySelector('.admin-vip-total-sent').textContent = totalSent;
                                                    tr.querySelector('.admin-vip-balance').textContent = num;
                                                    tr.querySelector('td:nth-child(6)').textContent = 'VIP ' + newLevel;
                                                    row.totalXanaxSent = totalSent; row.currentBalance = num; row.vipLevel = newLevel;
                                                    closeModal();
                                                    clearVipCache(row.playerId);
                                                    const apiKey2 = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
                                                    if (apiKey2 && apiKey2.length === 16) {
                                                        getUserData(apiKey2).then(function(ud) {
                                                            if (ud && String(ud.playerId) === String(row.playerId)) updateWelcomeMessage();
                                                        });
                                                    }
                                                }).catch(function(e) { console.error(e); alert('Update failed: ' + (e.message || e)); }).finally(function() { btnEl.disabled = false; });
                                            }
                                            vipEditOverlay.querySelector('#admin-vip-edit-save').onclick = doSave;
                                            vipEditOverlay.querySelector('#admin-vip-edit-modal-close').onclick = closeModal;
                                            vipEditOverlay.querySelector('#admin-vip-edit-cancel').onclick = closeModal;
                                        });
                                    })(editBtn, sorted2);
                                });
                                contentEl.querySelectorAll('.admin-vip-history-btn').forEach(function(historyBtn) {
                                    historyBtn.addEventListener('click', function() {
                                        const playerId = historyBtn.getAttribute('data-player-id');
                                        const playerName = historyBtn.getAttribute('data-player-name');
                                        const titleEl = document.getElementById('admin-vip-history-modal-title');
                                        const bodyEl = document.getElementById('admin-vip-history-modal-body');
                                        if (!titleEl || !bodyEl) return;
                                        titleEl.textContent = 'Xanax history — ' + playerName;
                                        bodyEl.innerHTML = '<p style="color: #888;">Loading...</p>';
                                        vipHistoryOverlay.style.display = 'flex';
                                        vipHistoryOverlay.setAttribute('aria-hidden', 'false');
                                        const apiKey2 = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
                                        if (!apiKey2 || apiKey2.length !== 16) {
                                            bodyEl.innerHTML = '<p style="color: #c0392b;">Enter your API key in the sidebar to load history.</p>';
                                            return;
                                        }
                                        firebase.functions().httpsCallable('getVipTransactionsForAdmin')({ apiKey: apiKey2, playerId: playerId })
                                            .then(function(result) {
                                                const transactions = result.data && result.data.transactions ? result.data.transactions : [];
                                                if (transactions.length === 0) { bodyEl.innerHTML = '<p style="color: #888;">No transactions yet.</p>'; return; }
                                                let tableHtml3 = '<table class="admin-table" style="font-size: 0.9rem;"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance after</th></tr></thead><tbody>';
                                                transactions.forEach(function(t) {
                                                    const dateStr = t.timestamp ? new Date(t.timestamp).toLocaleString() : '—';
                                                    tableHtml3 += '<tr><td>' + dateStr + '</td><td>' + (t.transactionType || 'Sent') + '</td><td>' + (t.amount ?? 0) + '</td><td>' + (t.balanceAfter ?? 0) + '</td></tr>';
                                                });
                                                tableHtml3 += '</tbody></table>';
                                                bodyEl.innerHTML = tableHtml3;
                                            })
                                            .catch(function(e) { console.error(e); bodyEl.innerHTML = '<p style="color: #c0392b;">Failed to load history. ' + (e.message || e.code || '') + '</p>'; });
                                    });
                                });
                                attachApplyDeductionsListener();
                                attachResetClockListener();
                                wireAdminVipToolbarButtons();
                            })
                            .catch(function(e) {
                                console.error(e);
                                if (statusEl) statusEl.textContent = 'Failed: ' + (e.message || e.code || '');
                                resetBtn.disabled = false;
                            });
                    };
                }
                attachResetClockListener();
                wireAdminVipToolbarButtons();
                window._adminVipCountdownInterval = setInterval(function() {
                    const panel = document.getElementById('admin-tab-vip');
                    if (!panel || panel.style.display === 'none') return;
                    let anyOverdue = false;
                    contentEl.querySelectorAll('.admin-next-deduction-countdown[data-until]').forEach(function(el) {
                        const until = parseInt(el.getAttribute('data-until'), 10);
                        if (isNaN(until)) return;
                        const msLeft = until - Date.now();
                        el.textContent = formatNextDeductionCountdown(Math.max(0, msLeft));
                        if (msLeft <= 0) anyOverdue = true;
                    });
                    if (anyOverdue && typeof window.__adminVipPullBalancesAndRender === 'function') {
                        const t = Date.now();
                        if (!window._adminVipOverduePullAt || t - window._adminVipOverduePullAt >= 60000) {
                            window._adminVipOverduePullAt = t;
                            window.__adminVipPullBalancesAndRender();
                        }
                        // Scheduler often lags; after ~8s overdue run same logic as "Apply deductions now" once
                        if (!window._adminVipOverdueSince) window._adminVipOverdueSince = t;
                        const overdueFor = t - window._adminVipOverdueSince;
                        const adminK = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
                        if (overdueFor >= 8000 && adminK.length === 16 && !window._adminVipAutoDeductionInFlight) {
                            window._adminVipAutoDeductionInFlight = true;
                            var st = document.getElementById('admin-vip-apply-status');
                            if (st) st.textContent = 'Applying deductions (auto)…';
                            firebase.functions().httpsCallable('applyVipDeductionsNow')({ apiKey: adminK })
                                .then(function() {
                                    if (typeof window.__adminVipPullBalancesAndRender === 'function') {
                                        return window.__adminVipPullBalancesAndRender();
                                    }
                                })
                                .catch(function(e) {
                                    console.error('Auto VIP deduction failed', e);
                                    if (st) st.textContent = (e && e.message) || 'Auto apply failed — use button';
                                })
                                .finally(function() {
                                    window._adminVipAutoDeductionInFlight = false;
                                    window._adminVipOverdueSince = Date.now();
                                });
                        }
                    } else {
                        window._adminVipOverduePullAt = 0;
                        window._adminVipOverdueSince = 0;
                    }
                }, 1000);
                var _adminVipPullInFlight = false;
                var _adminVipPullQueued = false;
                // No periodic VIP refetch — balances change on ~48h deductions; use "Refresh list" or actions below.
                function adminVipPullBalancesAndRender() {
                    const panel = document.getElementById('admin-tab-vip');
                    if (!panel || panel.style.display === 'none') return;
                    if (_adminVipPullInFlight) {
                        _adminVipPullQueued = true;
                        return;
                    }
                    _adminVipPullInFlight = true;
                    fn({ apiKey: apiKey }).then(function(res) {
                        const balances2 = (res && res.data && res.data.balances) || [];
                        if (balances2.length === 0) return;
                        const sorted2 = balances2.slice().sort((a, b) => (b.currentBalance || 0) - (a.currentBalance || 0));
                        let tableHtml2 = '<table class="admin-table"><thead><tr><th>Player ID</th><th>Player Name</th><th>Faction</th><th>Total Sent</th><th>Current Balance</th><th>VIP</th><th>Next deduction</th><th>Last Login</th><th>Actions</th></tr></thead><tbody>';
                        sorted2.forEach(function(row) {
                            var nextDedCell = adminVipNextDeductionCellForRow(row);
                            const lastLog = row.lastLoginDate ? new Date(row.lastLoginDate).toLocaleDateString() : '—';
                            tableHtml2 += '<tr data-player-id="' + String(row.playerId).replace(/"/g, '&quot;') + '">' +
                                '<td>' + String(row.playerId) + '</td>' +
                                '<td><a href="https://www.torn.com/profiles.php?XID=' + row.playerId + '" target="_blank" class="user-link">' + (row.playerName || '—') + '</a> <button type="button" class="admin-vip-history-btn" data-player-id="' + String(row.playerId).replace(/"/g, '&quot;') + '" data-player-name="' + String(row.playerName || '—').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '" aria-label="Xanax history" title="Xanax history">ⓘ</button></td>' +
                                '<td>' + (row.factionName || (userStats[row.playerName] && userStats[row.playerName].factionName) || '—') + '</td>' +
                                '<td class="admin-vip-total-sent">' + (row.totalXanaxSent ?? 0) + '</td>' +
                                '<td class="admin-vip-balance">' + (row.currentBalance ?? 0) + '</td>' +
                                '<td>VIP ' + (row.vipLevel ?? 0) + '</td>' +
                                '<td class="admin-next-deduction-cell">' + nextDedCell + '</td>' +
                                '<td>' + lastLog + '</td>' +
                                '<td><button type="button" class="fetch-button admin-vip-edit-btn" style="padding: 4px 10px; font-size: 12px;">Edit</button></td></tr>';
                        });
                        tableHtml2 += '</tbody></table>';
                        contentEl.innerHTML = toolbarHtml + tableHtml2;
                        contentEl.querySelectorAll('.admin-vip-edit-btn').forEach(function(editBtn) {
                            (function bindEdit(btnEl, sortedArr) {
                                btnEl.addEventListener('click', function() {
                                    const tr = btnEl.closest('tr');
                                    const playerId = tr.getAttribute('data-player-id');
                                    const row = sortedArr.find(function(r) { return String(r.playerId) === playerId; });
                                    if (!row) return;
                                    const totalSentInput = document.getElementById('admin-vip-edit-total-sent');
                                    const balanceInput = document.getElementById('admin-vip-edit-balance');
                                    if (!totalSentInput || !balanceInput) return;
                                    totalSentInput.value = row.totalXanaxSent ?? 0;
                                    balanceInput.value = row.currentBalance ?? 0;
                                    vipEditOverlay.style.display = 'flex';
                                    vipEditOverlay.setAttribute('aria-hidden', 'false');
                                    totalSentInput.focus();
                                    function closeModal() {
                                        vipEditOverlay.style.display = 'none';
                                        vipEditOverlay.setAttribute('aria-hidden', 'true');
                                    }
                                    function doSave() {
                                        const totalSent = parseInt(totalSentInput.value, 10);
                                        const num = parseInt(balanceInput.value, 10);
                                        if (isNaN(totalSent) || totalSent < 0) { alert('Total sent must be a non-negative number.'); return; }
                                        if (isNaN(num) || num < 0) { alert('Current balance must be a non-negative number.'); return; }
                                        const newLevel = num >= 100 ? 3 : num >= 50 ? 2 : num >= 10 ? 1 : 0;
                                        btnEl.disabled = true;
                                        firebase.functions().httpsCallable('updateVipBalance')({
                                            playerId: row.playerId, playerName: row.playerName, factionName: row.factionName, factionId: row.factionId,
                                            totalXanaxSent: totalSent, currentBalance: num, lastDeductionDate: new Date().toISOString(), vipLevel: newLevel, lastLoginDate: row.lastLoginDate
                                        }).then(function() {
                                            tr.querySelector('.admin-vip-total-sent').textContent = totalSent;
                                            tr.querySelector('.admin-vip-balance').textContent = num;
                                            tr.querySelector('td:nth-child(6)').textContent = 'VIP ' + newLevel;
                                            row.totalXanaxSent = totalSent; row.currentBalance = num; row.vipLevel = newLevel;
                                            closeModal();
                                            clearVipCache(row.playerId);
                                            const apiKey2 = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
                                            if (apiKey2 && apiKey2.length === 16) {
                                                getUserData(apiKey2).then(function(ud) {
                                                    if (ud && String(ud.playerId) === String(row.playerId)) updateWelcomeMessage();
                                                });
                                            }
                                        }).catch(function(e) { console.error(e); alert('Update failed: ' + (e.message || e)); }).finally(function() { btnEl.disabled = false; });
                                    }
                                    vipEditOverlay.querySelector('#admin-vip-edit-save').onclick = doSave;
                                    vipEditOverlay.querySelector('#admin-vip-edit-modal-close').onclick = closeModal;
                                    vipEditOverlay.querySelector('#admin-vip-edit-cancel').onclick = closeModal;
                                });
                            })(editBtn, sorted2);
                        });
                        contentEl.querySelectorAll('.admin-vip-history-btn').forEach(function(historyBtn) {
                            historyBtn.addEventListener('click', function() {
                                const playerId = historyBtn.getAttribute('data-player-id');
                                const playerName = historyBtn.getAttribute('data-player-name');
                                const titleEl = document.getElementById('admin-vip-history-modal-title');
                                const bodyEl = document.getElementById('admin-vip-history-modal-body');
                                if (!titleEl || !bodyEl) return;
                                titleEl.textContent = 'Xanax history — ' + playerName;
                                bodyEl.innerHTML = '<p style="color: #888;">Loading...</p>';
                                vipHistoryOverlay.style.display = 'flex';
                                vipHistoryOverlay.setAttribute('aria-hidden', 'false');
                                const apiKey2 = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
                                if (!apiKey2 || apiKey2.length !== 16) {
                                    bodyEl.innerHTML = '<p style="color: #c0392b;">Enter your API key in the sidebar to load history.</p>';
                                    return;
                                }
                                firebase.functions().httpsCallable('getVipTransactionsForAdmin')({ apiKey: apiKey2, playerId: playerId })
                                    .then(function(result) {
                                        const transactions = result.data && result.data.transactions ? result.data.transactions : [];
                                        if (transactions.length === 0) { bodyEl.innerHTML = '<p style="color: #888;">No transactions yet.</p>'; return; }
                                        let tableHtml3 = '<table class="admin-table" style="font-size: 0.9rem;"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance after</th></tr></thead><tbody>';
                                        transactions.forEach(function(t) {
                                            const dateStr = t.timestamp ? new Date(t.timestamp).toLocaleString() : '—';
                                            tableHtml3 += '<tr><td>' + dateStr + '</td><td>' + (t.transactionType || 'Sent') + '</td><td>' + (t.amount ?? 0) + '</td><td>' + (t.balanceAfter ?? 0) + '</td></tr>';
                                        });
                                        tableHtml3 += '</tbody></table>';
                                        bodyEl.innerHTML = tableHtml3;
                                    })
                                    .catch(function(e) { console.error(e); bodyEl.innerHTML = '<p style="color: #c0392b;">Failed to load history. ' + (e.message || e.code || '') + '</p>'; });
                            });
                        });
                        attachApplyDeductionsListener();
                        attachResetClockListener();
                        wireAdminVipToolbarButtons();
                        getUserData(apiKey).then(function(ud) {
                            if (ud && ud.playerId) clearVipCache(ud.playerId);
                            updateWelcomeMessage();
                        });
                    }).catch(function(e) {
                        console.error(e);
                    }).finally(function() {
                        _adminVipPullInFlight = false;
                        if (_adminVipPullQueued) {
                            _adminVipPullQueued = false;
                            setTimeout(function() { adminVipPullBalancesAndRender(); }, 150);
                        }
                    });
                }
                window.__adminVipPullBalancesAndRender = adminVipPullBalancesAndRender;
                if (window.adminVipRefreshInterval) {
                    clearInterval(window.adminVipRefreshInterval);
                    window.adminVipRefreshInterval = null;
                }
                // Ensure VIP edit modal exists (one per dashboard load)
                let vipEditOverlay = document.getElementById('admin-vip-edit-modal');
                if (!vipEditOverlay) {
                    vipEditOverlay = document.createElement('div');
                    vipEditOverlay.id = 'admin-vip-edit-modal';
                    vipEditOverlay.className = 'app-modal-overlay';
                    vipEditOverlay.setAttribute('aria-hidden', 'true');
                    vipEditOverlay.style.display = 'none';
                    vipEditOverlay.innerHTML = '<div class="app-modal" role="dialog" aria-labelledby="admin-vip-edit-modal-title">' +
                        '<div class="app-modal-header">' +
                        '<h2 id="admin-vip-edit-modal-title">Edit VIP balance</h2>' +
                        '<button type="button" class="app-modal-close" id="admin-vip-edit-modal-close" aria-label="Close">×</button>' +
                        '</div>' +
                        '<div class="app-modal-body">' +
                        '<div class="app-modal-row"><label class="app-modal-label">Total sent (Xanax)</label><input type="number" id="admin-vip-edit-total-sent" class="app-modal-input" min="0" step="1"></div>' +
                        '<div class="app-modal-row"><label class="app-modal-label">Current balance (Xanax)</label><input type="number" id="admin-vip-edit-balance" class="app-modal-input" min="0" step="1"></div>' +
                        '<div class="app-modal-actions">' +
                        '<button type="button" class="fetch-button" id="admin-vip-edit-cancel">Cancel</button>' +
                        '<button type="button" class="fetch-button" id="admin-vip-edit-save" style="background-color: var(--accent-color);">Save</button>' +
                        '</div></div></div>';
                    document.body.appendChild(vipEditOverlay);
                    function closeVipEditModal() {
                        vipEditOverlay.style.display = 'none';
                        vipEditOverlay.setAttribute('aria-hidden', 'true');
                    }
                    vipEditOverlay.querySelector('#admin-vip-edit-modal-close').addEventListener('click', closeVipEditModal);
                    vipEditOverlay.querySelector('#admin-vip-edit-cancel').addEventListener('click', closeVipEditModal);
                    vipEditOverlay.addEventListener('click', function(e) {
                        if (e.target === vipEditOverlay) closeVipEditModal();
                    });
                }
                // VIP history modal (reuse app-modal style)
                let vipHistoryOverlay = document.getElementById('admin-vip-history-modal');
                if (!vipHistoryOverlay) {
                    vipHistoryOverlay = document.createElement('div');
                    vipHistoryOverlay.id = 'admin-vip-history-modal';
                    vipHistoryOverlay.className = 'app-modal-overlay';
                    vipHistoryOverlay.setAttribute('aria-hidden', 'true');
                    vipHistoryOverlay.style.display = 'none';
                    vipHistoryOverlay.innerHTML = '<div class="app-modal" role="dialog" style="max-width: 480px;" aria-labelledby="admin-vip-history-modal-title">' +
                        '<div class="app-modal-header">' +
                        '<h2 id="admin-vip-history-modal-title">Xanax history</h2>' +
                        '<button type="button" class="app-modal-close" id="admin-vip-history-modal-close" aria-label="Close">×</button>' +
                        '</div>' +
                        '<div class="app-modal-body" id="admin-vip-history-modal-body"><p style="color: #888;">Loading...</p></div></div>';
                    document.body.appendChild(vipHistoryOverlay);
                    function closeVipHistoryModal() {
                        vipHistoryOverlay.style.display = 'none';
                        vipHistoryOverlay.setAttribute('aria-hidden', 'true');
                    }
                    vipHistoryOverlay.querySelector('#admin-vip-history-modal-close').addEventListener('click', closeVipHistoryModal);
                    vipHistoryOverlay.addEventListener('click', function(e) {
                        if (e.target === vipHistoryOverlay) closeVipHistoryModal();
                    });
                }
                contentEl.querySelectorAll('.admin-vip-history-btn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        const playerId = btn.getAttribute('data-player-id');
                        const playerName = btn.getAttribute('data-player-name');
                        const titleEl = document.getElementById('admin-vip-history-modal-title');
                        const bodyEl = document.getElementById('admin-vip-history-modal-body');
                        if (!titleEl || !bodyEl) return;
                        titleEl.textContent = 'Xanax history — ' + playerName;
                        bodyEl.innerHTML = '<p style="color: #888;">Loading...</p>';
                        vipHistoryOverlay.style.display = 'flex';
                        vipHistoryOverlay.setAttribute('aria-hidden', 'false');
                        const apiKey = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
                        if (!apiKey || apiKey.length !== 16) {
                            bodyEl.innerHTML = '<p style="color: #c0392b;">Enter your API key in the sidebar to load history.</p>';
                            return;
                        }
                        firebase.functions().httpsCallable('getVipTransactionsForAdmin')({ apiKey: apiKey, playerId: playerId })
                            .then(function(result) {
                                const transactions = result.data && result.data.transactions ? result.data.transactions : [];
                                if (transactions.length === 0) {
                                    bodyEl.innerHTML = '<p style="color: #888;">No transactions yet.</p>';
                                    return;
                                }
                                let tableHtml = '<table class="admin-table" style="font-size: 0.9rem;"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance after</th></tr></thead><tbody>';
                                transactions.forEach(function(t) {
                                    const dateStr = t.timestamp ? new Date(t.timestamp).toLocaleString() : '—';
                                    tableHtml += '<tr><td>' + dateStr + '</td><td>' + (t.transactionType || 'Sent') + '</td><td>' + (t.amount ?? 0) + '</td><td>' + (t.balanceAfter ?? 0) + '</td></tr>';
                                });
                                tableHtml += '</tbody></table>';
                                bodyEl.innerHTML = tableHtml;
                            })
                            .catch(function(e) {
                                console.error(e);
                                bodyEl.innerHTML = '<p style="color: #c0392b;">Failed to load history. ' + (e.message || e.code || '') + '</p>';
                            });
                    });
                });
                contentEl.querySelectorAll('.admin-vip-edit-btn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        const tr = btn.closest('tr');
                        const playerId = tr.getAttribute('data-player-id');
                        const row = sorted.find(function(r) { return String(r.playerId) === playerId; });
                        if (!row) return;
                        const totalSentInput = document.getElementById('admin-vip-edit-total-sent');
                        const balanceInput = document.getElementById('admin-vip-edit-balance');
                        if (!totalSentInput || !balanceInput) return;
                        totalSentInput.value = row.totalXanaxSent ?? 0;
                        balanceInput.value = row.currentBalance ?? 0;
                        vipEditOverlay.style.display = 'flex';
                        vipEditOverlay.setAttribute('aria-hidden', 'false');
                        totalSentInput.focus();
                        function closeModal() {
                            vipEditOverlay.style.display = 'none';
                            vipEditOverlay.setAttribute('aria-hidden', 'true');
                        }
                        function doSave() {
                            const totalSent = parseInt(totalSentInput.value, 10);
                            const num = parseInt(balanceInput.value, 10);
                            if (isNaN(totalSent) || totalSent < 0) {
                                alert('Total sent must be a non-negative number.');
                                return;
                            }
                            if (isNaN(num) || num < 0) {
                                alert('Current balance must be a non-negative number.');
                                return;
                            }
                            const newLevel = num >= 100 ? 3 : num >= 50 ? 2 : num >= 10 ? 1 : 0;
                            btn.disabled = true;
                            firebase.functions().httpsCallable('updateVipBalance')({
                                playerId: row.playerId,
                                playerName: row.playerName,
                                factionName: row.factionName,
                                factionId: row.factionId,
                                totalXanaxSent: totalSent,
                                currentBalance: num,
                                lastDeductionDate: new Date().toISOString(),
                                vipLevel: newLevel,
                                lastLoginDate: row.lastLoginDate
                            }).then(function() {
                                tr.querySelector('.admin-vip-total-sent').textContent = totalSent;
                                tr.querySelector('.admin-vip-balance').textContent = num;
                                tr.querySelector('td:nth-child(6)').textContent = 'VIP ' + newLevel;
                                row.totalXanaxSent = totalSent;
                                row.currentBalance = num;
                                row.vipLevel = newLevel;
                                closeModal();
                                // Clear VIP cache so next read gets fresh data; if edited player is current user, refresh Welcome section
                                clearVipCache(row.playerId);
                                const apiKey = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
                                if (apiKey && apiKey.length === 16) {
                                    getUserData(apiKey).then(function(ud) {
                                        if (ud && String(ud.playerId) === String(row.playerId)) {
                                            updateWelcomeMessage();
                                        }
                                    });
                                }
                            }).catch(function(e) {
                                console.error(e);
                                alert('Update failed: ' + (e.message || e));
                            }).finally(function() {
                                btn.disabled = false;
                            });
                        }
                        vipEditOverlay.querySelector('#admin-vip-edit-save').onclick = doSave;
                        vipEditOverlay.querySelector('#admin-vip-edit-modal-close').onclick = closeModal;
                        vipEditOverlay.querySelector('#admin-vip-edit-cancel').onclick = closeModal;
                    });
                });
            } catch (e) {
                console.error('VIP balances load failed:', e);
                loadingEl.textContent = 'Failed to load VIP balances. ' + (e.message || e.code || '');
            }
        })();
        
        // Get tools list from stats (already calculated)
        const allTools = Object.keys(stats).sort();
        
        // Generate checkboxes for graph visibility
        const visibilityControls = document.getElementById('graphVisibilityControls');
        if (visibilityControls) {
            // Add "Total Unique Users" checkbox
            const totalCheckbox = document.createElement('label');
            totalCheckbox.className = 'graph-checkbox-label';
            totalCheckbox.innerHTML = `
                <input type="checkbox" class="graph-visibility-checkbox" data-series="totalUsers" checked>
                <span style="color: #ffd700; font-weight: bold;">Total Unique Users</span>
            `;
            visibilityControls.appendChild(totalCheckbox);
            
            // Add checkboxes for each tool
            allTools.forEach((tool, index) => {
                const color = getToolColor(index);
                // Add display name with alias for War Report 2.0
                let displayName = tool;
                if (tool === 'War Report 2.0' || tool === 'war-report-2.0') {
                    displayName = 'War Report 2.0 (Payout Calculator)';
                }
                const checkbox = document.createElement('label');
                checkbox.className = 'graph-checkbox-label';
                checkbox.innerHTML = `
                    <input type="checkbox" class="graph-visibility-checkbox" data-series="${tool}" checked>
                    <span style="color: ${color}; font-weight: bold;">${displayName}</span>
                `;
                visibilityControls.appendChild(checkbox);
            });
        }
        
        // Initialize visibility settings (all enabled by default)
        let visibilitySettings = {
            totalUsers: true
        };
        allTools.forEach(tool => {
            visibilitySettings[tool] = true;
        });
        
        // Function to update graph with current visibility settings
        const updateGraph = () => {
            renderUsersGraph(filteredLogs, currentDaysBack, visibilitySettings);
        };
        
        // Initialize graph with default 30 days
        let currentDaysBack = 30;
        updateGraph();
        
        // Add event listeners for time period buttons
        document.querySelectorAll('.time-period-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                // Update active state
                document.querySelectorAll('.time-period-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                // Update graph
                currentDaysBack = parseInt(btn.dataset.days);
                updateGraph();
            });
        });
        
        // Add event listeners for visibility checkboxes
        document.querySelectorAll('.graph-visibility-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                const series = checkbox.dataset.series;
                visibilitySettings[series] = checkbox.checked;
                updateGraph();
            });
        });
        
        // Add event listeners for the new buttons
        document.getElementById('toggleAdminFilter')?.addEventListener('click', async () => {
            showAdminData = !showAdminData;
            // Reload the dashboard with the new filter setting
            await initAdminDashboard();
        });
        
        document.getElementById('showAllUsers')?.addEventListener('click', () => {
            const section = document.getElementById('allUsersSection');
            const button = document.getElementById('showAllUsers');
            if (section && button) {
                if (section.style.display === 'none') {
                    section.style.display = 'block';
                    button.textContent = 'Hide All Users';
                } else {
                    section.style.display = 'none';
                    button.textContent = 'Show All Users';
                }
            }
        });
        
        document.getElementById('showAllLogs')?.addEventListener('click', () => {
            const section = document.getElementById('allLogsSection');
            const button = document.getElementById('showAllLogs');
            if (section && button) {
                if (section.style.display === 'none') {
                    section.style.display = 'block';
                    button.textContent = 'Hide All Logs';
                } else {
                    section.style.display = 'none';
                    button.textContent = 'Show All Logs';
                }
            }
        });
        
        document.getElementById('exportLogs')?.addEventListener('click', () => {
            const logs = JSON.parse(localStorage.getItem('toolUsageLogs') || '[]');
            const dataStr = JSON.stringify(logs, null, 2);
            const dataBlob = new Blob([dataStr], {type: 'application/json'});
            const url = URL.createObjectURL(dataBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `tool-usage-logs-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        });
    }

    // Make functions globally accessible
    window.logToolUsage = logToolUsage;
    window.isAdmin = isAdmin;
    window.checkAndAddAdminMenu = checkAndAddAdminMenu;
    window.initAdminDashboard = initAdminDashboard;
    window.backfillVipData = backfillVipData; // For backfilling VIP data: window.backfillVipData([playerId1, playerId2, ...], adminApiKey)
    window.backfillVipEventsSimple = backfillVipEventsSimple; // For simple backfill: window.backfillVipEventsSimple([{playerName: 'Name', amount: 10}, ...])
    window.checkAndUpdateVipStatus = checkAndUpdateVipStatus; // For manual VIP checks
    
    // Manual VIP balance update function
    // Usage: window.updateVipBalanceManually('PlayerName', playerId, totalXanax)
    window.updateVipBalanceManually = async function(playerName, playerId, totalXanax) {
        console.log(`Manually updating VIP balance for ${playerName} (ID: ${playerId}): ${totalXanax} Xanax`);
        
        const vipData = {
            playerId: playerId,
            playerName: playerName,
            totalXanaxSent: totalXanax,
            currentBalance: totalXanax, // Start with full amount
            lastDeductionDate: null,
            vipLevel: getVipLevel(totalXanax),
            lastLoginDate: new Date().toISOString()
        };
        
        try {
            // Update VIP balance
            await updateVipBalance(
                vipData.playerId,
                vipData.playerName,
                vipData.totalXanaxSent,
                vipData.currentBalance,
                vipData.lastDeductionDate,
                vipData.vipLevel,
                vipData.lastLoginDate
            );
            
            // Log transaction
            await logVipTransaction(
                vipData.playerId,
                playerName,
                totalXanax,
                'Sent',
                vipData.currentBalance
            );
            
            console.log(`✓ Successfully updated ${playerName}: ${totalXanax} Xanax (VIP Level ${vipData.vipLevel})`);
            return vipData;
        } catch (error) {
            console.error('Error updating VIP balance:', error);
            return null;
        }
    };
    
    // Function to test and verify Google Sheets
    window.testGoogleSheets = async function() {
        console.log('Testing Google Sheets connection and verifying sheet names...');
        console.log('URL:', `${GOOGLE_SHEETS_SCRIPT_URL}?action=testSheets`);
        try {
            const testUrl = `${GOOGLE_SHEETS_SCRIPT_URL}?action=testSheets`;
            console.log('Fetching:', testUrl);
            const response = await fetch(testUrl);
            console.log('Response status:', response.status, response.statusText);
            
            if (response.ok) {
                const text = await response.text();
                console.log('Response text:', text);
                
                let data;
                try {
                    data = JSON.parse(text);
                } catch (parseError) {
                    console.error('Failed to parse JSON:', parseError);
                    console.log('Raw response:', text);
                    return;
                }
                
                console.log('=== Sheet Verification Results ===');
                console.log('All sheets in your spreadsheet:', data.allSheets);
                console.log('');
                console.log('Expected vs Found:');
                if (data.expectedNames) {
                    console.log(`  Tool Usage ("${data.expectedNames.toolUsage}"): ${data.toolUsageSheet}`);
                    console.log(`  VIP Balances ("${data.expectedNames.vipBalances}"): ${data.vipBalancesSheet}`);
                    console.log(`  VIP Transactions ("${data.expectedNames.vipTransactions}"): ${data.vipTransactionsSheet}`);
                } else {
                    console.log('  Tool Usage:', data.toolUsageSheet);
                    console.log('  VIP Balances:', data.vipBalancesSheet);
                    console.log('  VIP Transactions:', data.vipTransactionsSheet);
                }
                console.log('');
                if (data.testWrite) {
                    console.log('Test Write Result:', data.testWrite);
                }
                console.log('');
                if (data.vipBalancesSheet === 'NOT FOUND' || data.vipTransactionsSheet === 'NOT FOUND') {
                    console.error('❌ ERROR: One or more VIP sheets are missing!');
                    console.log('Please create sheets with these EXACT names:');
                    console.log('  - "VIP Balances"');
                    console.log('  - "VIP Transactions"');
                } else {
                    console.log('✓ All VIP sheets found!');
                }
                return data;
            } else {
                const errorText = await response.text();
                console.error('Failed to test sheets:', response.status);
                console.error('Error response:', errorText);
            }
        } catch (error) {
            console.error('Error testing sheets:', error);
            console.error('Full error:', error.message, error.stack);
        }
    };
    
    // Test function to check VIP tracking with real API events
    window.testVipTracking = async function() {
        console.log('Testing VIP tracking - checking YOUR events for Xanax sent TO you...');
        const apiKey = localStorage.getItem('tornApiKey');
        if (!apiKey) {
            console.error('No API key found. Please enter your API key first.');
            return;
        }
        
        try {
            // Get your user data (you're the admin)
            const userData = await getUserData(apiKey);
            if (!userData) {
                console.error('Failed to get user data');
                return;
            }
            
            console.log('Admin:', userData.name, '(ID:', userData.playerId + ')');
            console.log('Fetching your events to find Xanax sent TO you...');
            
            // Fetch events from admin's API (checking last 30 days to find all Xanax events)
            const fromTimestamp = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
            const eventsResponse = await fetch(`https://api.torn.com/user/?selections=events&from=${fromTimestamp}&key=${apiKey}`);
            const eventsData = await eventsResponse.json();
            
            if (eventsData.error) {
                console.error('Error fetching events:', eventsData.error);
                return;
            }
            
            // Parse all Xanax events
            const events = eventsData.events || {};
            const xanaxEvents = [];
            
            Object.values(events).forEach(event => {
                if (event.event && event.event.includes('You were sent') && event.event.includes('Xanax')) {
                    const parsed = parseXanaxEvent(event.event);
                    if (parsed) {
                        xanaxEvents.push({
                            timestamp: event.timestamp,
                            ...parsed
                        });
                    }
                }
            });
            
            console.log(`\nFound ${xanaxEvents.length} Xanax events:`);
            xanaxEvents.forEach(evt => {
                console.log(`  - ${evt.playerName} (ID: ${evt.playerId}) sent you ${evt.amount}x Xanax`);
            });
            
            if (xanaxEvents.length === 0) {
                console.log('\nNo Xanax events found in the last 30 days.');
                console.log('This is normal if no one has sent you Xanax recently.');
                return;
            }
            
            console.log('\nNow testing VIP tracking for each player who sent Xanax...');
            console.log('(This simulates what happens when each player logs in)');
            
            // Test VIP tracking for each player who sent Xanax
            for (const xanaxEvent of xanaxEvents) {
                console.log(`\n--- Testing for ${xanaxEvent.playerName} (ID: ${xanaxEvent.playerId}) ---`);
                
                // Create a mock userData for this player
                const mockUserData = {
                    playerId: xanaxEvent.playerId,
                    name: xanaxEvent.playerName
                };
                
                // Check and update VIP status for this player
                const vipData = await checkAndUpdateVipStatus(apiKey, mockUserData);
                
                if (vipData) {
                    console.log(`✓ VIP Status for ${xanaxEvent.playerName}:`, vipData);
                    console.log(`  - Total Xanax Sent: ${vipData.totalXanaxSent}`);
                    console.log(`  - Current Balance: ${vipData.currentBalance}`);
                    console.log(`  - VIP Level: ${vipData.vipLevel}`);
                } else {
                    console.log(`⚠ No VIP data created for ${xanaxEvent.playerName}`);
                }
            }
            
            console.log('\n✓ Test complete!');
            console.log('Please check your Google Sheets:');
            console.log('  - VIP Balances sheet should have entries for players who sent Xanax');
            console.log('  - VIP Transactions sheet should have transaction logs');
            
        } catch (error) {
            console.error('Error testing VIP tracking:', error);
        }
    };
    
    // Test function to check VIP Firebase connection
    window.testVipConnection = async function() {
        console.log('Testing VIP Firebase connection...');
        try {
            if (typeof firebase === 'undefined' || !firebase.functions) {
                console.error('Firebase not loaded');
                return false;
            }
            const testData = {
                playerId: 999999,
                playerName: 'Test Player',
                totalXanaxSent: 1,
                currentBalance: 1,
                lastDeductionDate: null,
                vipLevel: 0,
                lastLoginDate: null
            };
            const updateFn = firebase.functions().httpsCallable('updateVipBalance');
            await updateFn(testData);
            console.log('✓ Test update sent to Firebase');
            const data = await fetchVipBalanceFromBackend({ playerId: 999999 });
            if (data && (data.playerId === 999999 || data.playerId === '999999')) {
                console.log('✓ Verification successful! Test data in Firestore:', data);
            } else {
                console.log('⚠ Test data not found yet.');
            }
            return true;
        } catch (error) {
            console.error('✗ VIP connection error:', error);
            return false;
        }
    };

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

    /** Used by War Dashboard: same FF Scouter pull as Faction Battle Stats (chunks of 200, 3 concurrent, 1s delay). Returns { ff: { player_id: fair_fight }, bs: { player_id: bs_estimate } }. */
    window.getFFAndBattleStatsForMembers = async function (apiKey, memberIds) {
        if (!memberIds || memberIds.length === 0) return { ff: {}, bs: {} };
        const ffScouterUrl = `https://ffscouter.com/api/v1/get-stats?key=${apiKey}&targets=`;
        const ffData = await fetchInParallelChunks(ffScouterUrl, memberIds, 200, 3, 1000);
        const ff = {};
        const bs = {};
        ffData.forEach(player => {
            if (player.fair_fight) {
                ff[player.player_id] = player.fair_fight;
                bs[player.player_id] = player.bs_estimate;
            }
        });
        return { ff, bs };
    };

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
        
        // Check cache first and separate cached vs uncached requests
        const uncachedRequests = [];
        const cachedResults = {};
        
        requests.forEach(request => {
            const cacheKey = `${request.url}?${request.params}`;
            const cached = getCachedData(cacheKey);
            if (cached) {
                console.log(`Using cached data for: ${request.name}`);
                cachedResults[request.name] = cached;
            } else {
                // Build full URL for uncached request
                let fullUrl = request.url;
                if (request.params) {
                    fullUrl += `?${request.params}`;
                }
                fullUrl += `${request.params ? '&' : '?'}key=${apiKey}`;
                
                uncachedRequests.push({
                    url: fullUrl,
                    name: request.name,
                    cacheKey: cacheKey
                });
            }
        });
        
        // Only make API calls for uncached requests using global batch function
        if (uncachedRequests.length > 0) {
            await window.batchApiCallsWithRateLimit(uncachedRequests, {
                onSuccess: (data, request) => {
                    // Store in cache
                    setCachedData(request.cacheKey, data);
                    // Store result by request name
                    results[request.name] = data;
                },
                onError: (error, request) => {
                    console.error(`Torn API Error (${request.name}):`, error);
                    results[request.name] = { error: error.message };
                }
            });
        }
        
        // Merge cached results into final results
        Object.assign(results, cachedResults);
        
        return results;
    };
    window.batchTornApiCalls = batchTornApiCalls;

    // --- GLOBAL API KEY HANDLING ---
    // Function to update welcome message
    let welcomeMessageTimeout = null;
    const WELCOME_REFRESH_COOLDOWN_MS = 30 * 1000;
    async function updateWelcomeMessage() {
        const welcomeMessage = document.getElementById('welcomeMessage');
        const welcomeRefreshBtn = document.getElementById('welcomeRefreshBtn');
        const vipInfoBtn = document.getElementById('vipInfoBtn');
        if (!welcomeMessage) return;
        
        function setWelcomeVisible(visible) {
            welcomeMessage.style.display = visible ? 'block' : 'none';
            if (welcomeRefreshBtn) welcomeRefreshBtn.style.display = visible ? 'block' : 'none';
            if (vipInfoBtn) vipInfoBtn.style.display = visible ? 'block' : 'none';
        }
        
        const apiKey = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
        if (!apiKey || apiKey.length !== 16) {
            welcomeMessage.classList.remove('welcome-vip-pulse');
            setWelcomeVisible(false);
            // Clear cache for old API key
            if (welcomeMessageTimeout) {
                clearTimeout(welcomeMessageTimeout);
                welcomeMessageTimeout = null;
            }
            return;
        }
        
        // Debounce: wait 500ms after user stops typing
        if (welcomeMessageTimeout) {
            clearTimeout(welcomeMessageTimeout);
        }
        
        welcomeMessageTimeout = setTimeout(async () => {
            // Show loading state
            setWelcomeVisible(true);
            welcomeMessage.classList.remove('welcome-vip-pulse');
            welcomeMessage.innerHTML = '<span style="color: #888;">Loading...</span>';
            
            try {
                // Clear cache for this API key to get fresh data
                delete userCache[apiKey];
                const userData = await getUserData(apiKey);
                if (userData && userData.name) {
                    // Set welcome message first
                    let welcomeHtml = `<span style="color: var(--accent-color);">Welcome, <strong>${userData.name}</strong>!</span>`;
                    
                    // Check VIP status (use cache for display, but still check for updates in background)
                    // First try cached data for fast display
                    let vipData = await getVipBalance(userData.playerId, true);
                    
                    // If we have cached data, display it immediately
                    if (vipData) {
                        window.currentVipLevel = vipData.vipLevel ?? 0;
                        window.vipLevelKnown = true;
                        applyVipGating(vipData.vipLevel);
                        // Temporarily set welcome message so displayVipStatus can append to it
                        welcomeMessage.innerHTML = welcomeHtml;
                        displayVipStatus(vipData, userData.name);
                    } else {
                        window.currentVipLevel = 0;
                        window.vipLevelKnown = true;
                        applyVipGating(0);
                        // No VIP data, just show welcome + rate limit settings
                        const rateLimitHtml = getRateLimitSettingsHtml();
                        welcomeMessage.innerHTML = welcomeHtml + rateLimitHtml;
                    }
                    
                    // Then check for updates in background (this will update cache if needed)
                    // Only do full check if cache is expired or missing
                    const cacheExpiryKey = `vipBalanceExpiry_${userData.playerId}`;
                    const cacheExpiry = localStorage.getItem(cacheExpiryKey);
                    const now = Date.now();
                    
                    if (!cacheExpiry || now >= parseInt(cacheExpiry, 10)) {
                        // Cache expired or missing, do full check
                        const updatedVipData = await checkAndUpdateVipStatus(apiKey, userData);
                        if (updatedVipData) {
                            window.currentVipLevel = updatedVipData.vipLevel ?? 0;
                            window.vipLevelKnown = true;
                            applyVipGating(updatedVipData.vipLevel);
                            // Update display with fresh VIP data (this will also add rate limit settings)
                            welcomeMessage.innerHTML = welcomeHtml;
                            displayVipStatus(updatedVipData, userData.name);
                        } else if (!vipData) {
                            // Still no VIP data after check, ensure rate limit settings are shown
                            const rateLimitHtml = getRateLimitSettingsHtml();
                            welcomeMessage.innerHTML = welcomeHtml + rateLimitHtml;
                            welcomeMessage.classList.add('welcome-vip-pulse');
                        }
                    }
                } else {
                    window.currentVipLevel = 0;
                    window.vipLevelKnown = true;
                    applyVipGating(0);
                    setWelcomeVisible(false);
                }
                if (window.vipLevelKnown && (window.currentVipLevel ?? 0) < RECRUITMENT_VIP_REQUIRED && (window.location.hash || '').replace('#', '').split('/')[0] === 'recruitment') {
                    window.location.hash = 'home';
                }
            } catch (error) {
                console.error('Error updating welcome message:', error);
                window.currentVipLevel = 0;
                window.vipLevelKnown = true;
                applyVipGating(0);
                setWelcomeVisible(false);
                if ((window.location.hash || '').replace('#', '').split('/')[0] === 'recruitment') {
                    window.location.hash = 'home';
                }
            }
            if (window.vipLevelKnown && (window.currentVipLevel ?? 0) < RECRUITMENT_VIP_REQUIRED && (window.location.hash || '').replace('#', '').split('/')[0] === 'recruitment') {
                window.location.hash = 'home';
            }
        }, 500);
    }

    // Apply VIP gating on initial load (no key = locked)
    applyVipGating(0);
    
    const globalApiKeyInput = document.getElementById('globalApiKey');
    if (globalApiKeyInput) {
        // Load saved API key from localStorage (normalize to 16 alphanumeric)
        let savedApiKey = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
        if (savedApiKey) {
            localStorage.setItem('tornApiKey', savedApiKey);
            globalApiKeyInput.value = savedApiKey;
            if (savedApiKey.length === 16) updateWelcomeMessage();
        }

        // Restrict to alphanumeric and max 16 chars; only trigger API/update when length === 16
        globalApiKeyInput.addEventListener('input', () => {
            let raw = globalApiKeyInput.value || '';
            const apiKeyValue = raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
            if (raw !== apiKeyValue) {
                globalApiKeyInput.value = apiKeyValue;
            }
            localStorage.setItem('tornApiKey', apiKeyValue);
            
            if (apiKeyValue.length === 16) {
                updateWelcomeMessage();
                const event = new CustomEvent('apiKeyUpdated', { detail: { apiKey: apiKeyValue } });
                window.dispatchEvent(event);
            } else {
                const welcomeMessage = document.getElementById('welcomeMessage');
                const welcomeRefreshBtn = document.getElementById('welcomeRefreshBtn');
                const vipInfoBtnEl = document.getElementById('vipInfoBtn');
                if (welcomeMessage) {
                    welcomeMessage.style.display = 'none';
                    welcomeMessage.classList.remove('welcome-vip-pulse');
                }
                if (welcomeRefreshBtn) welcomeRefreshBtn.style.display = 'none';
                if (vipInfoBtnEl) vipInfoBtnEl.style.display = 'none';
            }
        });
    }
    
    const vipInfoBtnNav = document.getElementById('vipInfoBtn');
    if (vipInfoBtnNav) {
        vipInfoBtnNav.addEventListener('click', function () {
            if (typeof window.openVipProgramInfoModal === 'function') window.openVipProgramInfoModal();
        });
    }

    // Welcome refresh button: recheck VIP status and new Xanax sent (with cooldown)
    const welcomeRefreshBtn = document.getElementById('welcomeRefreshBtn');
    if (welcomeRefreshBtn) {
        welcomeRefreshBtn.addEventListener('click', async function() {
            if (this.disabled) return;
            const apiKey = (localStorage.getItem('tornApiKey') || '').replace(/[^A-Za-z0-9]/g, '');
            if (!apiKey || apiKey.length !== 16) return;
            const welcomeMessage = document.getElementById('welcomeMessage');
            if (!welcomeMessage) return;
            this.disabled = true;
            this.textContent = '…';
            this.title = 'Checking...';
            try {
                const userData = await getUserData(apiKey);
                if (!userData || !userData.name) {
                    this.textContent = '↻';
                    this.title = 'Recheck VIP status and new Xanax sent';
                    this.disabled = false;
                    return;
                }
                clearVipCache(userData.playerId);
                welcomeMessage.innerHTML = '<span style="color: #888;">Checking...</span>';
                const updatedVipData = await checkAndUpdateVipStatus(apiKey, userData);
                const welcomeHtml = `<span style="color: var(--accent-color);">Welcome, <strong>${userData.name}</strong>!</span>`;
                welcomeMessage.innerHTML = welcomeHtml;
                if (updatedVipData) {
                    window.currentVipLevel = updatedVipData.vipLevel ?? 0;
                    window.vipLevelKnown = true;
                    applyVipGating(updatedVipData.vipLevel);
                    displayVipStatus(updatedVipData, userData.name);
                } else {
                    window.currentVipLevel = 0;
                    window.vipLevelKnown = true;
                    applyVipGating(0);
                    const rateLimitHtml = getRateLimitSettingsHtml();
                    welcomeMessage.innerHTML = welcomeHtml + rateLimitHtml;
                    welcomeMessage.classList.add('welcome-vip-pulse');
                }
                if (!welcomeMessage.innerHTML.includes('API calls/minute')) {
                    welcomeMessage.innerHTML += getRateLimitSettingsHtml();
                }
            } catch (e) {
                console.error('Welcome refresh failed:', e);
                welcomeMessage.innerHTML = '<span style="color: #c0392b;">Refresh failed. Try again.</span>';
                welcomeMessage.classList.remove('welcome-vip-pulse');
            }
            this.textContent = '↻';
            this.title = 'Recheck VIP status and new Xanax sent';
            this.disabled = true;
            setTimeout(function() {
                welcomeRefreshBtn.disabled = false;
            }, WELCOME_REFRESH_COOLDOWN_MS);
        });
    }

    // --- ROUTER & PAGE LOADING ---
    const loadPage = async (page) => {
        try {
            // Handle admin dashboard specially (no file fetch needed)
            if (page === 'admin-dashboard') {
                // Check if user is admin before loading dashboard
                if (!(await isAdmin())) {
                    appContent.innerHTML = `<div class="container"><h2>Access Denied</h2><p>You don't have permission to access this page.</p></div>`;
                    return;
                }
                await initAdminDashboard();
                console.log('[APP] Loaded admin dashboard');
                return;
            }
            
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
                // Use relative path - try without cache-busting first to see if that's the issue
                script.src = './tools/consumption-tracker/consumption-tracker.js';
                script.id = 'consumption-tracker-script';
                script.onload = () => {
                    console.log('[APP] consumption-tracker/consumption-tracker.js loaded, calling initConsumptionTracker');
                    if (typeof initConsumptionTracker === 'function') {
                        initConsumptionTracker();
                    } else if (window.initConsumptionTracker) {
                        window.initConsumptionTracker();
                    }
                };
                script.onerror = (error) => {
                    console.error('[APP] Failed to load consumption-tracker.js:', error);
                    console.error('[APP] Attempted to load from:', script.src);
                };
                document.body.appendChild(script);
            } else if (page.includes('organised-crime-stats')) {
                // Remove any previous script for this tool
                const oldScript = document.getElementById('organised-crime-stats-script');
                if (oldScript) oldScript.remove();
                // Dynamically load the script
                const script = document.createElement('script');
                script.src = 'tools/organised-crime-stats/organised-crime-stats.js';
                script.id = 'organised-crime-stats-script';
                script.onload = () => {
                    console.log('[APP] organised-crime-stats/organised-crime-stats.js loaded, calling initOrganisedCrimeStats');
                    if (typeof initOrganisedCrimeStats === 'function') {
                        initOrganisedCrimeStats();
                    } else if (window.initOrganisedCrimeStats) {
                        window.initOrganisedCrimeStats();
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
            } else if (page.includes('termed-war-calculator')) {
                // Remove any previous script for this tool
                const oldScript = document.getElementById('termed-war-calculator-script');
                if (oldScript) oldScript.remove();
                // Dynamically load the script
                const script = document.createElement('script');
                script.src = 'tools/termed-war-calculator/termed-war-calculator.js';
                script.id = 'termed-war-calculator-script';
                script.onload = () => {
                    console.log('[APP] termed-war-calculator/termed-war-calculator.js loaded, calling initTermedWarCalculator');
                    if (typeof initTermedWarCalculator === 'function') {
                        initTermedWarCalculator();
                    } else if (window.initTermedWarCalculator) {
                        window.initTermedWarCalculator();
                    } else {
                        console.error('[APP] initTermedWarCalculator is still not available after script load!');
                    }
                };
                document.head.appendChild(script);
            } else if (page.includes('war-dashboard')) {
                const oldScript = document.getElementById('war-dashboard-script');
                if (oldScript) oldScript.remove();
                const script = document.createElement('script');
                script.src = 'tools/war-dashboard/war-dashboard.js';
                script.id = 'war-dashboard-script';
                script.onload = () => {
                    if (typeof initWarDashboard === 'function') initWarDashboard();
                    else if (window.initWarDashboard) window.initWarDashboard();
                };
                document.head.appendChild(script);
            } else if (page.includes('vault-checker')) {
                const oldScript = document.getElementById('vault-checker-script');
                if (oldScript) oldScript.remove();
                const script = document.createElement('script');
                script.src = 'tools/vault-checker/vault-checker.js';
                script.id = 'vault-checker-script';
                script.onload = () => {
                    if (typeof initVaultChecker === 'function') initVaultChecker();
                    else if (window.initVaultChecker) window.initVaultChecker();
                };
                document.head.appendChild(script);
            } else if (page.includes('recruitment')) {
                const oldScript = document.getElementById('recruitment-script');
                if (oldScript) oldScript.remove();
                const script = document.createElement('script');
                script.src = 'tools/recruitment/recruitment.js';
                script.id = 'recruitment-script';
                script.onload = () => {
                    if (typeof initRecruitment === 'function') initRecruitment();
                    else if (window.initRecruitment) window.initRecruitment();
                };
                document.head.appendChild(script);
            } else if (page.includes('home.html')) {
                // Log home page visit
                if (window.logToolUsage) {
                    window.logToolUsage('home');
                }
            }
            // Re-apply VIP gating so nav and (if home) tool cards reflect current level
            applyVipGating(window.currentVipLevel ?? 0);
        } catch (error) {
            console.error('Failed to load page:', error);
            appContent.innerHTML = `<div class="container"><h2>Error</h2><p>Failed to load page content. Please check the console for details.</p></div>`;
        }
    };

    function setNavActive() {
        const hash = (window.location.hash || '#').replace('#', '') || 'home';
        const pageName = hash.split('/')[0];
        document.querySelectorAll('#mainNav .nav-link').forEach((a) => {
            const href = (a.getAttribute('href') || '').replace('#', '');
            const isHome = href === '' || href === 'home';
            const active = (pageName === 'home' && isHome) || (pageName !== 'home' && href === pageName);
            a.classList.toggle('nav-link-active', !!active);
        });
    }

    const router = () => {
        setNavActive();
        const hash = window.location.hash.substring(1) || 'home';
        const pageName = `${hash.split('/')[0]}`;
        
        // Handle admin dashboard specially (no HTML file needed)
        if (pageName === 'admin-dashboard') {
            loadPage('admin-dashboard');
            return;
        }

        // Recruitment requires VIP 3 — only redirect when we know they're below VIP 3 (so refresh on #recruitment stays)
        if (pageName === 'recruitment' && window.vipLevelKnown && (window.currentVipLevel ?? 0) < RECRUITMENT_VIP_REQUIRED) {
            window.location.hash = 'home';
            loadPage('pages/home.html');
            return;
        }
        
        const pagePath = `pages/${pageName}.html`;
        loadPage(pagePath);
    };

    window.addEventListener('hashchange', router);
    router(); // Initial load
    
    // Check and add admin menu if user is admin
    checkAndAddAdminMenu();
    
    // Add event listener to API key input for automatic admin menu detection
    const apiKeyInput = document.getElementById('globalApiKey');
    if (apiKeyInput) {
        let adminCheckTimeout;
        
        apiKeyInput.addEventListener('input', () => {
            if (adminCheckTimeout) clearTimeout(adminCheckTimeout);
            const key = (apiKeyInput.value || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
            if (key.length !== 16) return;
            adminCheckTimeout = setTimeout(() => {
                checkAndAddAdminMenu();
            }, 500);
        });
    }

    // --- EVENT DELEGATION ---
    // Prevent navigation when clicking VIP-locked links (tooltip still shows via title)
    document.addEventListener('click', (event) => {
        const locked = event.target.closest('a.vip-locked');
        if (locked) {
            event.preventDefault();
            return;
        }
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
                const h = (window.location.hash || '').replace(/^#/, '').split('/')[0];
                if (h === 'consumption-tracker' && typeof window.exportPlayersToCSV === 'function') {
                    window.exportPlayersToCSV();
                } else if (h === 'consumption-tracker' && typeof window.exportConsumptionToCSV === 'function') {
                    window.exportConsumptionToCSV();
                } else if (h === 'war-report-2.0' || h === 'war-report') {
                    /* War Report wires its own export; skip legacy exportToCSV */
                } else {
                    exportToCSV();
                }
            } else if (target.classList.contains('column-toggle')) {
                toggleColumnVisibility();
            }
        }
    });

    // --- BATTLE STATS TOOL ---
    function initBattleStats() {
        // Log tool usage
        if (window.logToolUsage) {
            window.logToolUsage('faction-battle-stats');
        }

        const fetchBtn = document.getElementById('fetchBattleStatsBtn');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', handleBattleStatsFetch);
        }

        const myFactionBtn = document.getElementById('myFactionBtn');
        const factionIdInput = document.getElementById('factionId');
        if (myFactionBtn && factionIdInput) {
            myFactionBtn.addEventListener('click', async () => {
                const apiKey = localStorage.getItem('tornApiKey');
                if (!apiKey) {
                    alert('Please enter your API key in the sidebar first.');
                    return;
                }
                const userData = await getUserData(apiKey);
                if (!userData || userData.factionId == null || userData.factionId === '') {
                    alert('Could not load your faction (you may not be in a faction).');
                    return;
                }
                factionIdInput.value = String(userData.factionId).trim();
                const label = userData.factionName ? `My Faction [${userData.factionName}]` : 'My Faction';
                myFactionBtn.textContent = label;
                handleBattleStatsFetch();
            });
            const apiKey = localStorage.getItem('tornApiKey');
            if (apiKey) {
                getUserData(apiKey).then(ud => {
                    if (ud && ud.factionId != null && ud.factionId !== '' && myFactionBtn) {
                        myFactionBtn.textContent = ud.factionName ? `My Faction [${ud.factionName}]` : 'My Faction';
                    }
                });
            }
        }
    }

    const calculateStat = (myTotalStats, fairFightScore) => {
        if (fairFightScore < 1 || !myTotalStats) return 0;
        const base = Math.sqrt(myTotalStats) * ((fairFightScore - 1) / (8 / 3));
        return Math.round(Math.pow(base, 2));
    };

    // Local cache for Faction Battle Stats (localStorage, different TTLs)
    const BATTLE_STATS_MAIN_PREFIX = 'battle_stats_main_';
    const BATTLE_STATS_ACTIVITY_PAST_PREFIX = 'battle_stats_activity_past_';
    const BATTLE_STATS_ACTIVITY_NOW_PREFIX = 'battle_stats_activity_now_';
    const BATTLE_STATS_MAIN_TTL_MS = 24 * 60 * 60 * 1000;       // 1 day
    const BATTLE_STATS_ACTIVITY_PAST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
    const BATTLE_STATS_ACTIVITY_NOW_TTL_MS = 24 * 60 * 60 * 1000;       // 1 day
    /** Extra passes after the main batch: re-fetch only snapshots still missing (errors / parse fails / rate limits). */
    const BATTLE_STATS_ACTIVITY_EXTRA_RETRY_ROUNDS = 2;
    const BATTLE_STATS_ACTIVITY_RETRY_BASE_DELAY_MS = 2000;

    function normalizeBattleStatsFactionId(factionID) {
        return String(factionID == null ? '' : factionID).trim();
    }

    function getBattleStatsMainCache(factionID) {
        const fid = normalizeBattleStatsFactionId(factionID);
        try {
            const raw = localStorage.getItem(BATTLE_STATS_MAIN_PREFIX + fid);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj.cachedAt || (Date.now() - obj.cachedAt) > BATTLE_STATS_MAIN_TTL_MS) return null;
            return obj;
        } catch (e) { return null; }
    }
    function setBattleStatsMainCache(factionID, data) {
        const fid = normalizeBattleStatsFactionId(factionID);
        try {
            localStorage.setItem(BATTLE_STATS_MAIN_PREFIX + fid, JSON.stringify({
                cachedAt: Date.now(),
                ...data
            }));
        } catch (e) { /* ignore */ }
    }

    /** Only treat as cache hit when timeplayed is a real number (null/string/undefined = miss). */
    function coerceCachedTimeplayedValue(raw) {
        if (typeof raw === 'number' && !isNaN(raw)) return raw;
        if (typeof raw === 'string' && raw.trim() !== '') {
            const n = parseInt(raw.trim(), 10);
            if (!isNaN(n)) return n;
        }
        return null;
    }

    function hasActivityTimeplayedSnapshot(store, playerId, timestamp) {
        if (!store || timestamp == null || isNaN(Number(timestamp))) return false;
        const id = String(playerId);
        const v = store[id]?.[timestamp];
        return typeof v === 'number' && !isNaN(v);
    }

    function getBattleStatsActivityCache(keyPrefix, keySuffix, ttlMs) {
        try {
            const raw = localStorage.getItem(keyPrefix + keySuffix);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj.cachedAt || (Date.now() - obj.cachedAt) > ttlMs) return null;
            return obj.data || null;
        } catch (e) { return null; }
    }
    function setBattleStatsActivityCache(keyPrefix, keySuffix, data) {
        try {
            localStorage.setItem(keyPrefix + keySuffix, JSON.stringify({ cachedAt: Date.now(), data }));
        } catch (e) {
            console.warn('Activity cache write failed (quota or private mode?):', keyPrefix + keySuffix, e);
        }
    }

    /** Merge new snapshot map into existing TTL cache entry so partial writes don’t wipe data. */
    function mergeBattleStatsActivityCache(keyPrefix, keySuffix, ttlMs, newData) {
        if (!newData || typeof newData !== 'object') return;
        const prev = getBattleStatsActivityCache(keyPrefix, keySuffix, ttlMs);
        const merged = Object.assign({}, prev || {}, newData);
        setBattleStatsActivityCache(keyPrefix, keySuffix, merged);
    }

    /** Parse Torn v2 personalstats (timeplayed) — only return a number when the API clearly returned one. */
    function extractTimeplayedFromPersonalstatsResponse(data) {
        if (!data || data.personalstats == null) return null;
        const ps = data.personalstats;
        if (Array.isArray(ps) && ps.length > 0) {
            const item = ps[0];
            if (item && typeof item.value === 'number' && !isNaN(item.value)) return item.value;
            if (item && typeof item.value === 'string' && item.value !== '') {
                const n = parseInt(item.value, 10);
                return !isNaN(n) ? n : null;
            }
        }
        if (typeof ps === 'object' && !Array.isArray(ps) && ps.timeplayed != null) {
            const v = ps.timeplayed;
            if (typeof v === 'number' && !isNaN(v)) return v;
            if (typeof v === 'string' && v !== '') {
                const n = parseInt(v, 10);
                return !isNaN(n) ? n : null;
            }
        }
        return null;
    }

    /** Activity hours for a member: number (incl. 0) or null if unknown / incomplete fetch. */
    function getActivityHoursForMember(activityHoursMap, memberID) {
        if (memberID == null || memberID === '') return null;
        const idStr = String(memberID);
        const idNum = parseInt(memberID, 10);
        let raw = activityHoursMap[memberID];
        if (raw === undefined) raw = activityHoursMap[idStr];
        if (raw === undefined && !isNaN(idNum)) raw = activityHoursMap[idNum];
        if (raw === undefined || raw === null) return null;
        if (typeof raw === 'number' && !isNaN(raw)) return raw;
        return null;
    }

    function activityHoursSortValue(hours) {
        if (hours == null || typeof hours !== 'number' || isNaN(hours)) return -Infinity;
        return hours;
    }

    /**
     * Best-effort Unix time when the player started on Torn (faction /members payload).
     * Uses signed_up-style fields if present, else `age` in days (Torn often includes this).
     * Do not use faction-join `joined` — that is not account age.
     */
    function getMemberAccountStartTimestamp(member) {
        if (!member || typeof member !== 'object') return null;
        const tryUnix = (val) => {
            if (val == null || val === '') return null;
            const n = typeof val === 'number' ? val : parseInt(String(val).replace(/[^\d]/g, ''), 10);
            if (!isNaN(n) && n > 1e9 && n < 2e10) return Math.floor(n);
            return null;
        };
        const raw = member.signed_up ?? member.sign_up ?? member.user_joined
            ?? member.signedUp ?? member.signUp ?? member.userJoined
            ?? member.signup;
        const fromRaw = tryUnix(raw);
        if (fromRaw != null) return fromRaw;
        const basic = member.basic;
        if (basic && typeof basic === 'object') {
            const b = tryUnix(basic.signed_up ?? basic.sign_up ?? basic.user_joined ?? basic.signup);
            if (b != null) return b;
        }
        const life = member.life;
        if (life && typeof life === 'object') {
            const l = tryUnix(life.created ?? life.created_at ?? life.started);
            if (l != null) return l;
        }
        const age = member.age ?? basic?.age;
        if (age != null && age !== '') {
            const ageDays = parseInt(String(age).replace(/[^\d]/g, '') || '0', 10);
            if (!isNaN(ageDays) && ageDays >= 0 && ageDays < 10000) {
                return Math.floor(Date.now() / 1000) - ageDays * 86400;
            }
        }
        return null;
    }

    /** v1 user/?selections=profile — fills account start when faction /members omits it. */
    function extractAccountStartFromUserProfilePayload(data) {
        if (!data || typeof data !== 'object') return null;
        const profile = data.profile;
        const bag = profile && typeof profile === 'object' ? Object.assign({}, data, profile) : data;
        const tryUnix = (val) => {
            if (val == null || val === '') return null;
            const n = typeof val === 'number' ? val : parseInt(String(val).replace(/[^\d]/g, ''), 10);
            if (!isNaN(n) && n > 1e9 && n < 2e10) return Math.floor(n);
            return null;
        };
        const u = tryUnix(bag.signed_up ?? bag.sign_up ?? bag.user_joined ?? bag.signup);
        if (u != null) return u;
        const age = bag.age;
        if (age != null && age !== '') {
            const ageDays = parseInt(String(age).replace(/[^\d]/g, '') || '0', 10);
            if (!isNaN(ageDays) && ageDays >= 0 && ageDays < 10000) {
                return Math.floor(Date.now() / 1000) - ageDays * 86400;
            }
        }
        return null;
    }

    /**
     * Faction v2 /members often omits signup; fetch v1 profile for members missing accountStartTimestamp
     * so effective past = account creation (players newer than the activity window).
     */
    async function enrichBattleStatsMembersAccountStart(memberIDs, membersObject, apiKey, textProgress = null) {
        const need = memberIDs
            .map(id => String(id))
            .filter(id => {
                const m = membersObject[id];
                return m && (m.accountStartTimestamp == null || m.accountStartTimestamp === '' || isNaN(Number(m.accountStartTimestamp)));
            });
        if (need.length === 0) return;
        // Text-only progress (call counts) — do NOT pass progressPercentage / progressFill so the bar only fills once (activity phase).
        const requests = need.map(id => ({
            playerId: id,
            url: `https://api.torn.com/user/${encodeURIComponent(id)}?selections=profile&key=${encodeURIComponent(apiKey)}`
        }));
        await window.batchApiCallsWithRateLimit(requests, {
            progressMessage: textProgress?.progressMessage,
            progressDetails: textProgress?.progressDetails,
            onSuccess: (data, request) => {
                const id = String(request.playerId);
                const ts = extractAccountStartFromUserProfilePayload(data);
                if (ts == null || !membersObject[id]) return;
                membersObject[id].accountStartTimestamp = ts;
            },
            onError: (err, request) => {
                console.warn('Profile lookup for account start failed:', request?.playerId, err);
            }
        });
        const bs = window.battleStatsData;
        if (bs && Array.isArray(bs.membersArray)) {
            bs.membersArray.forEach(m => {
                const id = String(m.id);
                const ts = membersObject[id]?.accountStartTimestamp;
                if (ts != null && !isNaN(ts)) {
                    m.signed_up = ts;
                }
            });
        }
        // Persist signups on the roster we’re viewing so refresh / next load skips bulk profile calls.
        if (bs && bs.factionID != null && membersObject === bs.membersObject) {
            try {
                setBattleStatsMainCache(bs.factionID, {
                    tornData: bs.tornData,
                    ffData: bs.ffData,
                    factionName: bs.factionName,
                    membersArray: bs.membersArray,
                    memberIDs: bs.memberIDs,
                    membersObject: bs.membersObject,
                    ffScores: bs.ffScores,
                    battleStatsEstimates: bs.battleStatsEstimates,
                    lastUpdated: bs.lastUpdated
                });
            } catch (e) {
                console.warn('Battle stats: could not persist member signups to main cache', e);
            }
        }
    }

    /** Past snapshot time for timeplayed: not before the player existed on Torn. */
    function getEffectiveActivityPastTimestamp(nominalPastTs, member) {
        const n = Math.floor(Number(nominalPastTs));
        if (isNaN(n)) return nominalPastTs;
        const start = member && member.accountStartTimestamp != null ? Number(member.accountStartTimestamp) : null;
        if (start != null && !isNaN(start) && start > n) {
            return Math.floor(start);
        }
        return n;
    }

    /** Read past activity cache entry: supports legacy plain number (nominal past only) or { t, v }. */
    function parsePastCacheEntry(entry, nominalPastTs, effectivePastTs) {
        if (entry == null) return null;
        if (typeof entry === 'number' && !isNaN(entry)) {
            const v = coerceCachedTimeplayedValue(entry);
            if (v == null) return null;
            if (effectivePastTs === nominalPastTs) return { t: nominalPastTs, v };
            return null;
        }
        if (typeof entry === 'object' && entry.t != null && entry.v != null) {
            const t = Math.floor(Number(entry.t));
            const v = coerceCachedTimeplayedValue(entry.v);
            const eff = Math.floor(Number(effectivePastTs));
            if (!isNaN(t) && v != null && !isNaN(eff)) {
                if (t === eff) return { t: eff, v };
                // Nominal "past" unix time moves ~1s/sec with Date.now(); repeat Check Activity seconds apart must still hit cache.
                // Keep slack modest: pastTimestampDay buckets a full UTC day, so huge slack would wrongly reuse snapshots hours apart.
                const PAST_TS_SLACK_SEC = 3600; // 1h — same session / quick repeats; longer gap refetches
                if (Math.abs(t - eff) <= PAST_TS_SLACK_SEC) return { t: eff, v };
            }
        }
        return null;
    }

    /** Map v2 faction /members array to membersObject (includes last_action for Last online — same payload as War Dashboard). */
    function buildBattleStatsMembersObject(membersArray) {
        const obj = {};
        if (!Array.isArray(membersArray)) return obj;
        membersArray.forEach(member => {
            const idStr = String(member.id);
            const la = member.last_action || {};
            const ts = la.timestamp != null ? Number(la.timestamp) : null;
            const accountStart = getMemberAccountStartTimestamp(member);
            obj[idStr] = {
                name: member.name,
                level: member.level != null ? member.level : 'Unknown',
                lastActionRelative: (la.relative != null && String(la.relative).trim()) || '',
                lastActionTimestamp: ts != null && !isNaN(ts) ? ts : null,
                lastActionStatus: (la.status != null && String(la.status).trim()) || '',
                accountStartTimestamp: accountStart != null && !isNaN(accountStart) ? accountStart : null
            };
        });
        return obj;
    }

    /** Build v2 personalstats requests for any member missing a valid numeric timeplayed at now and/or effective past timestamp. */
    function buildMissingTimeplayedRequests(memberIDs, activityStore, nowTimestamp, nominalPastTimestamp, apiKey, membersObject) {
        const out = [];
        memberIDs.forEach(memberID => {
            const id = String(memberID);
            const member = membersObject[id] || membersObject[memberID];
            const pastTs = getEffectiveActivityPastTimestamp(nominalPastTimestamp, member);
            const hasCurrent = hasActivityTimeplayedSnapshot(activityStore, id, nowTimestamp);
            const hasPast = hasActivityTimeplayedSnapshot(activityStore, id, pastTs);
            if (!hasCurrent) {
                out.push({
                    playerId: id,
                    timestamp: nowTimestamp,
                    url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${nowTimestamp}&key=${apiKey}`
                });
            }
            if (!hasPast) {
                out.push({
                    playerId: id,
                    timestamp: pastTs,
                    url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${pastTs}&key=${apiKey}`
                });
            }
        });
        return out;
    }

    /** Activity window: exact day count, stable cache key segment, human-readable chart/title label. */
    function buildBattleStatsActivityPeriodConfig(radioValue, customDaysRaw) {
        const v = String(radioValue || '1').trim();
        if (v === 'custom') {
            const d = Math.min(365, Math.max(1, parseInt(String(customDaysRaw ?? '7').trim(), 10) || 7));
            return { periodDays: d, cacheKeySegment: `d${d}`, labelTitle: `Last ${d} Days` };
        }
        const m = parseInt(v, 10);
        if (m === 1) return { periodDays: 30, cacheKeySegment: '1', labelTitle: 'Last Month' };
        return { periodDays: 90, cacheKeySegment: '3', labelTitle: 'Last 3 Months' };
    }

    function getBattleStatsActivityPeriodConfigFromUI() {
        const radio = document.querySelector('input[name="activityPeriod"]:checked');
        const val = radio ? radio.value : '1';
        const customEl = document.getElementById('activityPeriodCustomDays');
        return buildBattleStatsActivityPeriodConfig(val, customEl ? customEl.value : '7');
    }

    function wireBattleStatsActivityPeriodRadios(container) {
        const root = container || document;
        const customInput = root.querySelector('#activityPeriodCustomDays');
        const sync = () => {
            const customRadio = root.querySelector('input[name="activityPeriod"][value="custom"]');
            const on = customRadio && customRadio.checked;
            if (customInput) {
                customInput.disabled = !on;
                customInput.style.opacity = on ? '1' : '0.55';
            }
        };
        root.querySelectorAll('input[name="activityPeriod"]').forEach(r => {
            r.addEventListener('change', sync);
        });
        sync();
    }

    /** periodConfig for charts/cache from window.currentActivityData (supports legacy periodMonths). */
    function resolvePeriodConfigFromActivityContext(ctx) {
        if (!ctx) return buildBattleStatsActivityPeriodConfig('3');
        if (ctx.periodConfig && ctx.periodConfig.cacheKeySegment && ctx.periodConfig.labelTitle) {
            return ctx.periodConfig;
        }
        const ts = ctx.activityTimestamps;
        if (ts && ts.periodConfig && ts.periodConfig.cacheKeySegment) {
            return ts.periodConfig;
        }
        const pm = ts?.periodMonths ?? ctx.periodMonths;
        if (pm === 1) return buildBattleStatsActivityPeriodConfig('1');
        return buildBattleStatsActivityPeriodConfig('3');
    }

    const BATTLE_STATS_COPY_BTN_STYLE = 'background-color: rgba(42, 42, 42, 0.9); color: #ccc; border: 1px solid #555; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; opacity: 0.7; transition: opacity 0.2s;';

    /**
     * Copy a battle-stats table (current DOM order). Excludes listed data-column keys (default FF Score).
     */
    async function battleStatsCopyTableToClipboard(copyBtn, tableEl, options = {}) {
        const factionTitle = options.factionTitle != null ? String(options.factionTitle) : 'Faction';
        const excludeColumns = options.excludeColumns !== undefined ? options.excludeColumns : ['ffscore'];
        const excludeSet = new Set(excludeColumns);
        if (!tableEl) {
            alert('Table not found');
            return;
        }
        const showCopied = () => {
            const originalText = copyBtn.textContent;
            const originalBgColor = copyBtn.style.backgroundColor;
            copyBtn.textContent = '✓ Copied!';
            copyBtn.style.backgroundColor = 'rgba(76, 175, 80, 0.9)';
            copyBtn.style.opacity = '1';
            setTimeout(() => {
                copyBtn.textContent = originalText;
                copyBtn.style.backgroundColor = originalBgColor;
                copyBtn.style.opacity = '0.7';
            }, 2000);
        };
        try {
            const tableClone = tableEl.cloneNode(true);
            tableClone.querySelectorAll('thead th[data-column], tbody td[data-column]').forEach(cell => {
                const col = cell.getAttribute('data-column');
                if (col && excludeSet.has(col)) cell.remove();
            });
            tableClone.querySelectorAll('thead th').forEach(th => {
                const indicator = th.querySelector('.sort-indicator');
                if (indicator) indicator.remove();
            });
            const htmlTable = `
                            <div>
                                <span style="font-size: 18px;"><strong>${factionTitle}:</strong></span>
                            </div>
                            <div>&nbsp;</div>
                            ${tableClone.outerHTML}
                        `;

            const headerCells = Array.from(tableEl.querySelectorAll('thead th[data-column]'))
                .filter(th => !excludeSet.has(th.getAttribute('data-column')));
            const headers = headerCells.map(th => th.textContent.replace(/[↑↓\s]+$/, '').replace(/\s+/g, ' ').trim());

            const rows = Array.from(tableEl.querySelectorAll('tbody tr'));
            const rowData = rows.map(row => {
                return Array.from(row.querySelectorAll('td[data-column]'))
                    .filter(td => !excludeSet.has(td.getAttribute('data-column')))
                    .map((cell) => {
                        let text = cell.textContent.trim();
                        const link = cell.querySelector('a');
                        if (link) text = link.textContent.trim();
                        return text;
                    });
            });

            let textTable = `${factionTitle}\n\n`;
            textTable += headers.join('\t') + '\n';
            rowData.forEach(row => {
                textTable += row.join('\t') + '\n';
            });

            const clipboardItem = new ClipboardItem({
                'text/html': new Blob([htmlTable], { type: 'text/html' }),
                'text/plain': new Blob([textTable], { type: 'text/plain' })
            });
            await navigator.clipboard.write([clipboardItem]);
            showCopied();
        } catch (error) {
            console.error('Error copying table:', error);
            try {
                const headerCells = Array.from(tableEl.querySelectorAll('thead th[data-column]'))
                    .filter(th => !excludeSet.has(th.getAttribute('data-column')));
                const headers = headerCells.map(th => th.textContent.replace(/[↑↓\s]+$/, '').replace(/\s+/g, ' ').trim());
                const rows = Array.from(tableEl.querySelectorAll('tbody tr'));
                const rowData = rows.map(row => {
                    return Array.from(row.querySelectorAll('td[data-column]'))
                        .filter(td => !excludeSet.has(td.getAttribute('data-column')))
                        .map((cell) => {
                            let text = cell.textContent.trim();
                            const link = cell.querySelector('a');
                            if (link) text = link.textContent.trim();
                            return text;
                        });
                });
                let textTable = `${factionTitle}\n\n`;
                textTable += headers.join('\t') + '\n';
                rowData.forEach(row => {
                    textTable += row.join('\t') + '\n';
                });
                await navigator.clipboard.writeText(textTable);
                showCopied();
            } catch (fallbackError) {
                console.error('Fallback copy also failed:', fallbackError);
                alert('Failed to copy table. Please try again.');
            }
        }
    }

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
            let tornData, factionName, membersArray, memberIDs, membersObject, ffScores, battleStatsEstimates, lastUpdated, hasVipLevel1, ffData;
            const cachedMain = getBattleStatsMainCache(factionID);

            if (cachedMain) {
                tornData = cachedMain.tornData;
                factionName = cachedMain.factionName;
                membersArray = Array.isArray(cachedMain.membersArray) ? cachedMain.membersArray : [];
                memberIDs = Array.isArray(cachedMain.memberIDs) ? cachedMain.memberIDs : [];
                if (membersArray.length) {
                    membersObject = buildBattleStatsMembersObject(membersArray);
                } else if (cachedMain.membersObject && typeof cachedMain.membersObject === 'object' && Object.keys(cachedMain.membersObject).length) {
                    membersObject = { ...cachedMain.membersObject };
                    if (!memberIDs.length) {
                        memberIDs = Object.keys(membersObject);
                    }
                } else {
                    membersObject = {};
                }
                if (!membersArray.length && tornData?.factionMembers?.members?.length) {
                    membersArray = tornData.factionMembers.members;
                    membersObject = buildBattleStatsMembersObject(membersArray);
                    if (!memberIDs.length) {
                        memberIDs = membersArray.map(m => String(m.id));
                    }
                }
                ffScores = cachedMain.ffScores;
                battleStatsEstimates = cachedMain.battleStatsEstimates;
                lastUpdated = cachedMain.lastUpdated;
                ffData = cachedMain.ffData;
                const userData = await getUserData(apiKey);
                const userPlayerId = userData?.playerId;
                hasVipLevel1 = false;
                if (userPlayerId) {
                    const vipData = await getVipBalance(userPlayerId, true);
                    hasVipLevel1 = vipData && vipData.vipLevel >= 1;
                }
            } else {
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
                tornData = await batchTornApiCalls(apiKey, apiRequests);
                const tornEndTime = performance.now();
                console.log(`Torn API calls completed in ${(tornEndTime - tornStartTime).toFixed(2)}ms`);

                const userData = await getUserData(apiKey);
                const userPlayerId = userData?.playerId;

                hasVipLevel1 = false;
                if (userPlayerId) {
                    const vipData = await getVipBalance(userPlayerId, true);
                    hasVipLevel1 = vipData && vipData.vipLevel >= 1;
                }

                console.log('Faction info object:', tornData.factionInfo);
                factionName = tornData.factionInfo?.basic?.name;
                if (!factionName && tornData.factionInfo?.name) {
                    factionName = tornData.factionInfo.name;
                }
                if (!factionName && tornData.factionInfo?.faction_name) {
                    factionName = tornData.factionInfo.faction_name;
                }
                if (!factionName) {
                    factionName = `[Name not available] (ID: ${factionID})`;
                }
                membersArray = tornData.factionMembers?.members || [];
                memberIDs = membersArray.map(member => member.id.toString());
                membersObject = buildBattleStatsMembersObject(membersArray);

                console.log(`Successfully fetched ${memberIDs.length} members.`);

                const ffStartTime = performance.now();
                const ffScouterUrl = `https://ffscouter.com/api/v1/get-stats?key=${apiKey}&targets=`;
                console.log(`Fetching FF Scouter data for ${memberIDs.length} members using parallel batching...`);
                ffData = await fetchInParallelChunks(ffScouterUrl, memberIDs, 200, 3, 1000);
                const ffEndTime = performance.now();
                console.log(`FF Scouter API calls completed in ${(ffEndTime - ffStartTime).toFixed(2)}ms`);

                ffScores = {};
                battleStatsEstimates = {};
                lastUpdated = {};
                ffData.forEach(player => {
                    if (player.fair_fight) {
                        ffScores[player.player_id] = player.fair_fight;
                        battleStatsEstimates[player.player_id] = player.bs_estimate;
                        lastUpdated[player.player_id] = player.last_updated;
                    }
                });

                setBattleStatsMainCache(factionID, {
                    tornData,
                    ffData,
                    factionName,
                    membersArray,
                    memberIDs,
                    membersObject,
                    ffScores,
                    battleStatsEstimates,
                    lastUpdated
                });
            }

            // Normalise IDs for lookups (do not filter the list — that emptied the table when cache was partial)
            memberIDs = (memberIDs || []).map(id => String(id));
            if (memberIDs.length === 0 && Array.isArray(membersArray) && membersArray.length) {
                memberIDs = membersArray.map(m => String(m.id));
            }
            if (membersArray && membersArray.length && (!membersObject || Object.keys(membersObject).length === 0)) {
                membersObject = buildBattleStatsMembersObject(membersArray);
            }

            const myTotalStats = tornData?.userStats?.personalstats?.totalstats;

            const totalTime = performance.now() - startTime;
            const cacheStats = getCacheStats();
            console.log(`🎉 Total fetch time: ${totalTime.toFixed(2)}ms (${(totalTime / 1000).toFixed(2)}s)`);
            if (!cachedMain) {
                console.log(`📊 Performance breakdown:`);
                console.log(`   - Torn API / FF Scouter / Processing`);
                console.log(`💾 Cache stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.hitRate}% hit rate)`);
            } else {
                console.log(`💾 Battle stats loaded from cache (1-day TTL)`);
            }

            // Hide the form and show the results section
            // toolContainer.style.display = 'none'; // Don't hide the input fields

            let tableHtml = `
                <!-- Summary Section (NOT scrollable) -->
                <div style="margin-bottom: 20px;">
                    <button id="exportCsvBtn" class="btn" style="background-color: #FFD700; color: #333; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">
                        Export to CSV
                    </button>
                    <button id="collectDetailedStatsBtn" class="btn" style="background-color: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: 10px;">
                        Collect Detailed Stats
                    </button>
                    <div style="position: relative; display: inline-block; margin-left: 10px;">
                        <button id="compareActivityBtn" class="btn" style="background-color: ${hasVipLevel1 ? '#2196F3' : '#666'}; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: ${hasVipLevel1 ? 'pointer' : 'not-allowed'}; margin-left: 0; white-space: nowrap; opacity: ${hasVipLevel1 ? '1' : '0.6'};" ${hasVipLevel1 ? '' : 'disabled'}>
                            Check Activity
                        </button>
                        ${!hasVipLevel1 ? `
                        <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0, 0, 0, 0.7); border-radius: 5px; display: flex; align-items: center; justify-content: center; cursor: not-allowed; pointer-events: none;">
                            <div style="text-align: center; padding: 5px;">
                                <div style="color: var(--accent-color); font-size: 11px; font-weight: bold; margin-bottom: 2px;">⭐ VIP 1+ Required</div>
                                <div style="color: #fff; font-size: 9px;">Send 10+ Xanax to unlock</div>
                            </div>
                        </div>
                        ` : ''}
                    </div>
                    <div style="display: flex; align-items: center; flex-wrap: wrap; margin-left: 10px; gap: 10px; background-color: var(--secondary-color); padding: 8px 15px; border-radius: 5px; ${!hasVipLevel1 ? 'opacity: 0.6; pointer-events: none;' : ''}">
                        <span style="color: var(--accent-color); font-weight: bold; font-size: 14px; white-space: nowrap;">Activity Period:</span>
                        <label class="activity-period-label" style="color: var(--text-color); display: flex; align-items: center; cursor: pointer; padding: 6px 12px; border-radius: 4px; transition: all 0.2s; white-space: nowrap;" onmouseover="this.style.backgroundColor='rgba(255, 215, 0, 0.1)'" onmouseout="this.style.backgroundColor='transparent'">
                            <input type="radio" name="activityPeriod" value="1" checked style="margin-right: 6px; cursor: pointer; accent-color: var(--accent-color); width: 16px; height: 16px;" ${!hasVipLevel1 ? 'disabled' : ''}>
                            <span style="font-size: 14px;">1 Month</span>
                        </label>
                        <label class="activity-period-label" style="color: var(--text-color); display: flex; align-items: center; cursor: pointer; padding: 6px 12px; border-radius: 4px; transition: all 0.2s; white-space: nowrap;" onmouseover="this.style.backgroundColor='rgba(255, 215, 0, 0.1)'" onmouseout="this.style.backgroundColor='transparent'">
                            <input type="radio" name="activityPeriod" value="3" style="margin-right: 6px; cursor: pointer; accent-color: var(--accent-color); width: 16px; height: 16px;" ${!hasVipLevel1 ? 'disabled' : ''}>
                            <span style="font-size: 14px;">3 Months</span>
                        </label>
                        <label class="activity-period-label" style="color: var(--text-color); display: flex; align-items: center; cursor: pointer; padding: 6px 12px; border-radius: 4px; transition: all 0.2s; flex-wrap: wrap; gap: 6px;" onmouseover="this.style.backgroundColor='rgba(255, 215, 0, 0.1)'" onmouseout="this.style.backgroundColor='transparent'">
                            <span style="display: inline-flex; align-items: center;">
                                <input type="radio" name="activityPeriod" value="custom" style="margin-right: 6px; cursor: pointer; accent-color: var(--accent-color); width: 16px; height: 16px;" ${!hasVipLevel1 ? 'disabled' : ''}>
                                <span style="font-size: 14px;">Custom</span>
                            </span>
                            <span style="display: inline-flex; align-items: center; gap: 6px;">
                                <input type="number" id="activityPeriodCustomDays" min="1" max="365" value="7" title="Number of days to compare (1–365). Select Custom to enable." disabled style="width: 56px; padding: 4px 6px; border-radius: 4px; border: 1px solid #555; background: var(--primary-color); color: var(--text-color); font-size: 13px; opacity: 0.55;">
                                <span style="font-size: 13px; color: var(--text-color);">days</span>
                            </span>
                        </label>
                    </div>
                </div>
                <h2 style="text-align: center; margin-bottom: 20px; color: var(--accent-color);">${factionName}</h2>
                
                <!-- Table Wrapper (SCROLLABLE) -->
                <div style="position: relative; margin-bottom: 5px;">
                    <button type="button" id="copyTableBtn" class="btn" style="${BATTLE_STATS_COPY_BTN_STYLE}" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'" title="Copy table to clipboard">
                        📋 Copy
                    </button>
                </div>
                <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                    <table id="membersTable" style="min-width: 760px; font-size: 13px;">
                        <thead>
                            <tr>
                                <th data-column="member" style="min-width: 200px; cursor: pointer; text-align: left; user-select: text;">Member <span class="sort-indicator"></span></th>
                                <th data-column="level" style="min-width: 80px; cursor: pointer; text-align: left; user-select: text;">Level <span class="sort-indicator"></span></th>
                                <th data-column="stats" style="min-width: 150px; cursor: pointer; text-align: left; user-select: text;">Estimated Stats <span class="sort-indicator"></span></th>
                                <th data-column="ffscore" style="min-width: 100px; cursor: pointer; text-align: left; user-select: text;">FF Score <span class="sort-indicator"></span></th>
                                <th data-column="lastonline" style="min-width: 130px; cursor: pointer; text-align: left; user-select: text;">Last online <span class="sort-indicator"></span></th>
                                <th data-column="lastupdated" style="min-width: 150px; cursor: pointer; text-align: left; user-select: text;">FFS Last Updated <span class="sort-indicator"></span></th>
                            </tr>
                        </thead>
                        <tbody>`;
            for (const memberID of memberIDs) {
                const id = String(memberID);
                const member = membersObject[id] || membersObject[memberID];
                if (!member) {
                    console.warn('Battle stats: skip row, no member object for id', id);
                    continue;
                }
                const fairFightScore = ffScores[id] || ffScores[memberID] || 'Unknown';
                const lastUpdatedTimestamp = lastUpdated[id] ?? lastUpdated[memberID];

                // Use FF Scouter's precise battle stats estimate instead of calculating
                const rawEstimatedStat = battleStatsEstimates[id] ?? battleStatsEstimates[memberID] ?? 'N/A';
                const displayEstimatedStat = (rawEstimatedStat !== 'N/A') ? rawEstimatedStat.toLocaleString() : 'N/A';
                
                const lastUpdatedDate = lastUpdatedTimestamp 
                    ? formatRelativeTime(lastUpdatedTimestamp * 1000) 
                    : 'N/A';
                const lastOnlineDisplay = formatMemberLastOnlineDisplay(member);
                const lastOnlineSort = getMemberLastOnlineSortValue(member);

                tableHtml += `
                    <tr>
                        <td data-column="member"><a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" style="color: #FFD700; text-decoration: none;">${member.name} [${id}]</a></td>
                        <td data-column="level" data-value="${member.level === 'Unknown' ? -1 : member.level}">${member.level}</td>
                        <td data-column="stats" data-value="${rawEstimatedStat === 'N/A' ? -1 : rawEstimatedStat}">${displayEstimatedStat}</td>
                        <td data-column="ffscore" data-value="${fairFightScore === 'Unknown' ? -1 : fairFightScore}">${fairFightScore}</td>
                        <td data-column="lastonline" data-value="${lastOnlineSort}">${lastOnlineDisplay}</td>
                        <td data-column="lastupdated" data-value="${lastUpdatedTimestamp || 0}">${lastUpdatedDate}</td>
                    </tr>`;
            }
            tableHtml += `
                        </tbody>
                    </table>
                </div>`;
            resultsContainer.innerHTML = tableHtml;
            resultsContainer.style.display = 'block';
            wireBattleStatsActivityPeriodRadios(resultsContainer);

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

            // Store data globally for activity comparison + enrich persist (needs full main-cache shape)
            window.battleStatsData = {
                memberIDs,
                membersArray,
                membersObject,
                tornData,
                ffData,
                ffScores,
                battleStatsEstimates,
                lastUpdated,
                factionName,
                factionID,
                myTotalStats
            };
            // Also store myTotalStats globally for easy access
            window.myTotalStats = myTotalStats;

            // Add Compare Activity button functionality (remove old listener first to prevent duplicates)
            const compareActivityBtn = document.getElementById('compareActivityBtn');
            if (compareActivityBtn) {
                // Clone and replace to remove all event listeners
                const newBtn = compareActivityBtn.cloneNode(true);
                compareActivityBtn.parentNode.replaceChild(newBtn, compareActivityBtn);
                
                if (!newBtn.disabled) {
                    // Button is enabled (VIP Level 1+)
                    newBtn.addEventListener('click', async () => {
                        const periodConfig = getBattleStatsActivityPeriodConfigFromUI();
                        await handleActivityComparison(memberIDs, membersObject, apiKey, factionName, factionID, periodConfig);
                    });
                } else {
                    // Button is disabled (needs VIP Level 1+)
                    newBtn.addEventListener('click', () => {
                        alert('This feature requires VIP Level 1 or higher.\n\nSend 10+ Xanax to Jimidy to unlock this feature.\n\nProfile: https://www.torn.com/profiles.php?XID=2935825');
                    });
                }
            }

            // Copy Table button functionality
            const copyTableBtn = document.getElementById('copyTableBtn');
            if (copyTableBtn) {
                copyTableBtn.addEventListener('click', async () => {
                    const table = document.getElementById('membersTable');
                    await battleStatsCopyTableToClipboard(copyTableBtn, table, { factionTitle: factionName, excludeColumns: ['ffscore'] });
                });
            }

            document.getElementById('exportCsvBtn').addEventListener('click', () => {
                // 1. Create a list of members with all their data
                const memberExportData = memberIDs.map(memberID => {
                    const id = String(memberID);
                    const member = membersObject[id] || membersObject[memberID];
                    if (!member) return null;
                    const fairFightScore = ffScores[id] || ffScores[memberID] || 'Unknown';
                    const rawEstimatedStat = battleStatsEstimates[id] ?? battleStatsEstimates[memberID] ?? 'N/A';
                    return {
                        memberID: id,
                        name: member.name,
                        fairFightScore,
                        rawEstimatedStat
                    };
                }).filter(Boolean);

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

            // Add detailed stats collection functionality (remove old listener first to prevent duplicates)
            const collectDetailedStatsBtn = document.getElementById('collectDetailedStatsBtn');
            if (collectDetailedStatsBtn) {
                // Clone and replace to remove all event listeners
                const newBtn = collectDetailedStatsBtn.cloneNode(true);
                collectDetailedStatsBtn.parentNode.replaceChild(newBtn, collectDetailedStatsBtn);
                newBtn.addEventListener('click', () => {
                    handleDetailedStatsCollection(memberIDs, membersObject, ffScores, battleStatsEstimates, myTotalStats, factionName, factionID);
                });
            } else {
                console.error('Collect Detailed Stats button not found!');
            }
            
            // Compare Activity button listener already added above, skip duplicate
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

    // Helper function for rate limiting delays
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    // Function to fetch and compare activity data
    const handleActivityComparison = async (memberIDs, membersObject, apiKey, factionName, factionID, periodConfigIn) => {
        const periodConfig = periodConfigIn && periodConfigIn.periodDays != null && periodConfigIn.cacheKeySegment
            ? periodConfigIn
            : buildBattleStatsActivityPeriodConfig('3');
        // Prevent concurrent execution
        if (window.activityComparisonInProgress) {
            return;
        }
        window.activityComparisonInProgress = true;
        
        const spinner = document.getElementById('loading-spinner');
        const resultsContainer = document.getElementById('battle-stats-results');
        const progressContainer = document.getElementById('progressContainer');
        const progressMessage = document.getElementById('progressMessage');
        const progressPercentage = document.getElementById('progressPercentage');
        const progressFill = document.getElementById('progressFill');
        const progressDetails = document.getElementById('progressDetails');
        
        if (!spinner || !resultsContainer || !progressContainer) {
            console.error("Required elements missing for activity comparison");
            return;
        }

        // Hide results and show progress
        resultsContainer.style.display = 'none';
        spinner.style.display = 'none';
        
        // Show progress bar
        if (progressContainer) {
            progressContainer.style.display = 'block';
            if (progressMessage) progressMessage.textContent = 'Fetching activity data...';
            if (progressPercentage) progressPercentage.textContent = '0%';
            if (progressFill) progressFill.style.width = '0%';
            if (progressDetails) progressDetails.textContent = 'Preparing…';
        }
        
        try {
            // v2 faction /members often omits signup — resolve so "younger than period" uses real account start
            await enrichBattleStatsMembersAccountStart(memberIDs, membersObject, apiKey, {
                progressMessage,
                progressDetails
            });

            // Calculate timestamps based on selected period (exact days for custom)
            const periodDays = periodConfig.periodDays;
            const cacheKeySegment = periodConfig.cacheKeySegment;
            const fid = normalizeBattleStatsFactionId(factionID);
            const nowTimestamp = Math.floor(Date.now() / 1000);
            const pastTimestamp = Math.floor((Date.now() - (periodDays * 24 * 60 * 60 * 1000)) / 1000);
            const pastTimestampDay = Math.floor(pastTimestamp / 86400) * 86400; // same day = same cache key
            const dateKey = new Date().toISOString().split('T')[0]; // YYYY-MM-DD for "now" cache

            // Load from local cache (1 week for past, 1 day for now)
            const pastCache = getBattleStatsActivityCache(
                BATTLE_STATS_ACTIVITY_PAST_PREFIX,
                `${fid}_${cacheKeySegment}_${pastTimestampDay}`,
                BATTLE_STATS_ACTIVITY_PAST_TTL_MS
            );
            const nowCache = getBattleStatsActivityCache(
                BATTLE_STATS_ACTIVITY_NOW_PREFIX,
                `${fid}_${dateKey}`,
                BATTLE_STATS_ACTIVITY_NOW_TTL_MS
            );

            const activityData = {};
            memberIDs.forEach(memberID => {
                const id = String(memberID);
                const member = membersObject[id] || membersObject[memberID];
                const pastEff = getEffectiveActivityPastTimestamp(pastTimestamp, member);
                activityData[id] = {};
                if (pastCache) {
                    const rawPast = pastCache[id] !== undefined ? pastCache[id] : pastCache[memberID];
                    const parsedPast = parsePastCacheEntry(rawPast, pastTimestamp, pastEff);
                    if (parsedPast) {
                        activityData[id][parsedPast.t] = parsedPast.v;
                    }
                }
                const nowVal = coerceCachedTimeplayedValue(nowCache?.[id] ?? nowCache?.[memberID]);
                if (nowVal != null) {
                    activityData[id][nowTimestamp] = nowVal;
                }
            });

            // Only request (playerId, timestamp) pairs we don't have (past uses per-member effective time if account is younger than the period)
            const activityRequests = [];
            memberIDs.forEach(memberID => {
                const id = String(memberID);
                const member = membersObject[id] || membersObject[memberID];
                const pastEff = getEffectiveActivityPastTimestamp(pastTimestamp, member);
                if (!hasActivityTimeplayedSnapshot(activityData, id, nowTimestamp)) {
                    activityRequests.push({
                        playerId: id,
                        timestamp: nowTimestamp,
                        url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${nowTimestamp}&key=${apiKey}`
                    });
                }
                if (!hasActivityTimeplayedSnapshot(activityData, id, pastEff)) {
                    activityRequests.push({
                        playerId: id,
                        timestamp: pastEff,
                        url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${pastEff}&key=${apiKey}`
                    });
                }
            });

            const activityFetchBatchOptions = {
                progressMessage,
                progressDetails,
                progressPercentage,
                progressFill,
                onSuccess: (data, request) => {
                    const timeplayed = extractTimeplayedFromPersonalstatsResponse(data);
                    const pid = String(request.playerId);
                    if (timeplayed === null) {
                        console.warn(`Activity: could not parse timeplayed for player ${pid} at ts ${request.timestamp}`, data);
                        return;
                    }
                    if (!activityData[pid]) {
                        activityData[pid] = {};
                    }
                    activityData[pid][request.timestamp] = timeplayed;
                },
                onError: (error, request) => {
                    console.error(`Error fetching activity for player ${request.playerId} at timestamp ${request.timestamp}:`, error);
                }
            };

            if (activityRequests.length > 0) {
                if (progressDetails) progressDetails.textContent = activityRequests.length < memberIDs.length * 2
                    ? `Fetching activity... (${activityRequests.length} of ${memberIDs.length * 2} from API, rest from cache)`
                    : `Fetching activity data for ${memberIDs.length} members...`;
                await window.batchApiCallsWithRateLimit(activityRequests, activityFetchBatchOptions);
            }

            // Re-fetch only missing snapshots (failed API calls, parse errors, etc.) — a few extra passes with backoff.
            const totalActivityPasses = 1 + BATTLE_STATS_ACTIVITY_EXTRA_RETRY_ROUNDS;
            for (let retryRound = 0; retryRound < BATTLE_STATS_ACTIVITY_EXTRA_RETRY_ROUNDS; retryRound++) {
                const retryRequests = buildMissingTimeplayedRequests(memberIDs, activityData, nowTimestamp, pastTimestamp, apiKey, membersObject);
                if (retryRequests.length === 0) break;
                if (progressDetails) {
                    progressDetails.textContent = `Retrying ${retryRequests.length} missing snapshot(s) (pass ${retryRound + 2} of ${totalActivityPasses})...`;
                }
                await sleep(BATTLE_STATS_ACTIVITY_RETRY_BASE_DELAY_MS + retryRound * 1500);
                await window.batchApiCallsWithRateLimit(retryRequests, activityFetchBatchOptions);
            }

            const stillMissingCount = buildMissingTimeplayedRequests(memberIDs, activityData, nowTimestamp, pastTimestamp, apiKey, membersObject).length;
            if (stillMissingCount > 0) {
                console.warn(`Activity: after ${totalActivityPasses} pass(es), ${stillMissingCount} snapshot(s) still missing — those members show "-" until you run Check Activity again.`);
            }

            // Persist to local cache for next time (past: 1 week, now: 1 day)
            const pastDataToSave = {};
            const nowDataToSave = {};
            memberIDs.forEach(memberID => {
                const id = String(memberID);
                const member = membersObject[id] || membersObject[memberID];
                const pastEff = getEffectiveActivityPastTimestamp(pastTimestamp, member);
                if (hasActivityTimeplayedSnapshot(activityData, id, pastEff)) {
                    pastDataToSave[id] = { t: pastEff, v: activityData[id][pastEff] };
                }
                if (hasActivityTimeplayedSnapshot(activityData, id, nowTimestamp)) {
                    nowDataToSave[id] = activityData[id][nowTimestamp];
                }
            });
            if (Object.keys(pastDataToSave).length > 0) {
                mergeBattleStatsActivityCache(
                    BATTLE_STATS_ACTIVITY_PAST_PREFIX,
                    `${fid}_${cacheKeySegment}_${pastTimestampDay}`,
                    BATTLE_STATS_ACTIVITY_PAST_TTL_MS,
                    pastDataToSave
                );
            }
            if (Object.keys(nowDataToSave).length > 0) {
                mergeBattleStatsActivityCache(
                    BATTLE_STATS_ACTIVITY_NOW_PREFIX,
                    `${fid}_${dateKey}`,
                    BATTLE_STATS_ACTIVITY_NOW_TTL_MS,
                    nowDataToSave
                );
            }

            window.lastActivityFetchTime = Date.now();

            if (activityRequests.length === 0 && progressContainer) {
                if (progressPercentage) progressPercentage.textContent = '100%';
                if (progressFill) progressFill.style.width = '100%';
                if (progressDetails) progressDetails.textContent = 'Activity data loaded from cache.';
            }

            // Hide progress bar
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
            
            // Calculate activity differences (current - X months ago) in hours.
            // If either snapshot is missing, use null — do not treat as 0 (that hid API failures as "0:00").
            const activityHours = {};
            memberIDs.forEach(memberID => {
                const id = String(memberID);
                const member = membersObject[id] || membersObject[memberID];
                const pastEff = getEffectiveActivityPastTimestamp(pastTimestamp, member);
                const currentRaw = activityData[id]?.[nowTimestamp];
                const pastRaw = activityData[id]?.[pastEff];
                const hasCurrent = typeof currentRaw === 'number' && !isNaN(currentRaw);
                const hasPast = typeof pastRaw === 'number' && !isNaN(pastRaw);
                if (!hasCurrent || !hasPast) {
                    activityHours[id] = null;
                    return;
                }
                const differenceSeconds = currentRaw - pastRaw;
                if (differenceSeconds < 0) {
                    console.warn(`Activity: negative delta for member ${id} (current < past); check API/cache.`);
                }
                activityHours[id] = Math.max(0, differenceSeconds) / 3600;
            });
            
            console.log('Activity data calculated:', activityHours);
            
            // Store timestamp of when this fetch completed for rate limit tracking
            window.lastActivityFetchTime = Date.now();
            
            window.battleStatsLastIncompleteActivityCount = memberIDs.filter(mid => activityHours[String(mid)] == null).length;
            
            // Get existing data for the table
            const battleStatsData = window.battleStatsData || {};
            const ffScores = battleStatsData.ffScores || {};
            const battleStatsEstimates = battleStatsData.battleStatsEstimates || {};
            const lastUpdated = battleStatsData.lastUpdated || {};
            
            // Update the table with activity column and create graph
            const activityTimestamps = {
                nowTimestamp,
                pastTimestamp,
                pastTimestampDay,
                dateKey,
                factionID,
                normalizedFactionId: fid,
                periodConfig,
                cacheKeySegment,
                periodDays
            };
            updateTableWithActivity(memberIDs, membersObject, activityHours, ffScores, battleStatsEstimates, lastUpdated, factionName, factionID, apiKey, periodConfig, activityTimestamps);
            
            spinner.style.display = 'none';
            
        } catch (error) {
            console.error('Error comparing activity:', error);
            alert('Error fetching activity data: ' + error.message);
            spinner.style.display = 'none';
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
        } finally {
            // Always clear the in-progress flag
            window.activityComparisonInProgress = false;
        }
    };
    
    // Function to update table with activity data and create graph
    const updateTableWithActivity = (memberIDs, membersObject, activityHours, ffScores, battleStatsEstimates, lastUpdated, factionName, factionID, apiKey, periodConfigIn = null, activityTimestamps = null) => {
        const periodConfig = periodConfigIn && periodConfigIn.periodDays != null && periodConfigIn.labelTitle
            ? periodConfigIn
            : buildBattleStatsActivityPeriodConfig('3');
        const resultsContainer = document.getElementById('battle-stats-results');
        if (!resultsContainer) return;
        
        // Sort members by activity (most active first)
        const sortedMemberIDs = [...memberIDs].sort((a, b) => {
            const idA = String(a);
            const idB = String(b);
            const activityA = activityHoursSortValue(activityHours[idA]);
            const activityB = activityHoursSortValue(activityHours[idB]);
            return activityB - activityA; // Descending (most active first)
        });
        
        const incompleteActivityMembers = window.battleStatsLastIncompleteActivityCount || 0;
        const incompleteActivityNotice = incompleteActivityMembers > 0
            ? `<p id="activity-incomplete-notice" style="text-align:center;color:#ffb74d;font-size:13px;margin:-8px 12px 16px;line-height:1.45;max-width:720px;margin-left:auto;margin-right:auto;">${incompleteActivityMembers} member(s) still show &quot;-&quot; after automatic retries — the API didn&apos;t return full timeplayed data for them. Use the <strong>↻</strong> button next to a dash to retry that member, or run <strong>Check Activity</strong> again.</p>`
            : '';
        
        let tableHtml = `
            <!-- Summary Section (NOT scrollable) -->
            <div style="margin-bottom: 20px;">
                <button id="exportCsvBtn" class="btn" style="background-color: #FFD700; color: #333; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">
                    Export to CSV
                </button>
                <button id="collectDetailedStatsBtn" class="btn" style="background-color: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: 10px;">
                    Collect Detailed Stats
                </button>
                <button id="compareActivityBtn" class="btn" style="background-color: #2196F3; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: 10px; opacity: 0.7;" disabled>
                    Check Activity (Loaded)
                </button>
            </div>
            <h2 style="text-align: center; margin-bottom: 20px; color: var(--accent-color);">${factionName} - Activity Comparison (${periodConfig.labelTitle})</h2>
            ${incompleteActivityNotice}
            
            <!-- Activity Graph -->
            <div style="margin-bottom: 30px; background-color: var(--primary-color); border-radius: 8px; padding: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h3 style="color: var(--accent-color); margin: 0;">Activity Graph (Most Active → Least Active)</h3>
                    <button id="compareOwnFactionBtn" class="btn" style="background-color: #9C27B0; color: white; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer;">
                        Compare to Own Faction
                    </button>
                </div>
                <div style="position: relative; height: 400px;">
                    <canvas id="activityGraph"></canvas>
                </div>
            </div>
            
            <div style="position: relative; margin-bottom: 5px;">
                <button type="button" id="copyTableBtn" class="btn" style="${BATTLE_STATS_COPY_BTN_STYLE}" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'" title="Copy table to clipboard (FF Score omitted)">
                    📋 Copy
                </button>
            </div>
            <!-- Table Wrapper (SCROLLABLE) -->
            <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                <table id="membersTable" style="min-width: 860px; font-size: 13px;">
                    <thead>
                        <tr>
                            <th data-column="member" style="min-width: 200px; cursor: pointer; text-align: left;">Member <span class="sort-indicator"></span></th>
                            <th data-column="level" style="min-width: 80px; cursor: pointer; text-align: left;">Level <span class="sort-indicator"></span></th>
                            <th data-column="stats" style="min-width: 150px; cursor: pointer; text-align: left;">Estimated Stats <span class="sort-indicator"></span></th>
                            <th data-column="ffscore" style="min-width: 100px; cursor: pointer; text-align: left;">FF Score <span class="sort-indicator"></span></th>
                            <th data-column="activity" style="min-width: 120px; cursor: pointer; text-align: left;">Activity (Hours) <span class="sort-indicator">↓</span></th>
                            <th data-column="lastonline" style="min-width: 130px; cursor: pointer; text-align: left;">Last online <span class="sort-indicator"></span></th>
                            <th data-column="lastupdated" style="min-width: 150px; cursor: pointer; text-align: left;">FFS Last Updated <span class="sort-indicator"></span></th>
                        </tr>
                    </thead>
                    <tbody>`;
        
        for (const memberID of sortedMemberIDs) {
            const id = String(memberID);
            const member = membersObject[id] || membersObject[memberID];
            const fairFightScore = ffScores[id] || ffScores[memberID] || 'Unknown';
            const lastUpdatedTimestamp = lastUpdated[id] ?? lastUpdated[memberID];
            const activity = activityHours[id] ?? null;
            
            const rawEstimatedStat = battleStatsEstimates[id] || battleStatsEstimates[memberID] || 'N/A';
            const displayEstimatedStat = (rawEstimatedStat !== 'N/A') ? rawEstimatedStat.toLocaleString() : 'N/A';
            
            const lastUpdatedDate = lastUpdatedTimestamp 
                ? formatRelativeTime(lastUpdatedTimestamp * 1000) 
                : 'N/A';
            const lastOnlineDisplay = formatMemberLastOnlineDisplay(member);
            const lastOnlineSort = getMemberLastOnlineSortValue(member);
            
            const displayActivity = typeof activity === 'number' ? formatHoursMinutes(activity) : '-';
            const activitySortValue = typeof activity === 'number' ? activity : -1e9;
            const activityCellInner = typeof activity === 'number'
                ? displayActivity
                : `<span class="activity-cell-wrap" style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;"><span>-</span><button type="button" class="btn activity-retry-btn" data-player-id="${id}" title="Fetch timeplayed for this member (both snapshots). Use if this row shows a dash after cache or a failed load." aria-label="Retry activity fetch for this member" style="padding:2px 8px;font-size:12px;line-height:1.2;min-width:auto;background:#1976D2;color:#fff;border:none;border-radius:4px;cursor:pointer;">↻</button></span>`;
            
            tableHtml += `
                <tr data-player-id="${id}">
                    <td data-column="member"><a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" style="color: #FFD700; text-decoration: none;">${member.name} [${id}]</a></td>
                    <td data-column="level" data-value="${member.level === 'Unknown' ? -1 : member.level}">${member.level}</td>
                    <td data-column="stats" data-value="${rawEstimatedStat === 'N/A' ? -1 : rawEstimatedStat}">${displayEstimatedStat}</td>
                    <td data-column="ffscore" data-value="${fairFightScore === 'Unknown' ? -1 : fairFightScore}">${fairFightScore}</td>
                    <td data-column="activity" data-value="${activitySortValue}">${activityCellInner}</td>
                    <td data-column="lastonline" data-value="${lastOnlineSort}">${lastOnlineDisplay}</td>
                    <td data-column="lastupdated" data-value="${lastUpdatedTimestamp || 0}">${lastUpdatedDate}</td>
                </tr>`;
        }
        
        tableHtml += `
                    </tbody>
                </table>
            </div>`;
        
        resultsContainer.innerHTML = tableHtml;
        resultsContainer.style.display = 'block';
        
        // Store data for comparison (normalize sorted IDs to strings for consistent lookups)
        const sortedMemberIDsStr = sortedMemberIDs.map(id => String(id));
        window.currentActivityData = {
            sortedMemberIDs: sortedMemberIDsStr,
            membersObject,
            activityHours,
            factionName,
            factionID,
            ffScores,
            battleStatsEstimates,
            lastUpdated,
            periodConfig,
            activityTimestamps: activityTimestamps || window.currentActivityData?.activityTimestamps || null,
            myTotalStats: window.currentActivityData?.myTotalStats || window.battleStatsData?.myTotalStats || window.myTotalStats || 0
        };
        
        // Create activity graph - wait a bit for DOM to update
        setTimeout(() => {
            createActivityGraph(sortedMemberIDsStr, membersObject, activityHours, null, periodConfig.labelTitle);
        }, 100);
        
        // Add compare to own faction button functionality
        document.getElementById('compareOwnFactionBtn').addEventListener('click', async () => {
            await handleCompareToOwnFaction(apiKey, periodConfig);
        });
        
        // Add sorting functionality
        const table = document.getElementById('membersTable');
        const headers = table.querySelectorAll('th[data-column]');
        let currentSortColumn = 'activity'; // Default sort by activity
        let currentSortDirection = 'desc'; // Most active first
        
        const sortTable = (column, direction) => {
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            
            headers.forEach(h => {
                const indicator = h.querySelector('.sort-indicator');
                const hColumn = h.getAttribute('data-column');
                if (hColumn === column) {
                    indicator.textContent = direction === 'asc' ? ' ↑' : ' ↓';
                } else {
                    indicator.textContent = '';
                }
            });
            
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
            
            rows.forEach(row => tbody.appendChild(row));
        };
        
        sortTable(currentSortColumn, currentSortDirection);
        
        headers.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.getAttribute('data-column');
                
                if (currentSortColumn === column) {
                    currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSortColumn = column;
                    currentSortDirection = 'asc';
                }
                
                sortTable(currentSortColumn, currentSortDirection);
            });
        });
        
        // Re-attach event listeners
        document.getElementById('exportCsvBtn').addEventListener('click', () => {
            const headers = ['Member', 'Level', 'Estimated Stats', 'FF Score', 'Activity (Hours)', 'Last online', 'FFS Last Updated'];
            let csvContent = headers.join(',') + '\r\n';
            
            sortedMemberIDsStr.forEach(memberID => {
                const id = String(memberID);
                const member = membersObject[id] || membersObject[memberID];
                const fairFightScore = ffScores[id] || ffScores[memberID] || 'Unknown';
                const rawEstimatedStat = battleStatsEstimates[id] || battleStatsEstimates[memberID] || 'N/A';
                const displayEstimatedStat = (rawEstimatedStat !== 'N/A') ? rawEstimatedStat.toLocaleString() : 'N/A';
                const lastUpdatedTimestamp = lastUpdated[id] ?? lastUpdated[memberID];
                const lastUpdatedDate = lastUpdatedTimestamp 
                    ? new Date(lastUpdatedTimestamp * 1000).toLocaleString() 
                    : 'N/A';
                const act = activityHours[id];
                const activity = typeof act === 'number' ? formatHoursMinutes(act) : '-';
                const lastOnlineCsv = formatMemberLastOnlineDisplay(member);
                
                csvContent += `"${member.name} [${id}]",${member.level},"${displayEstimatedStat}",${fairFightScore},${activity},"${String(lastOnlineCsv).replace(/"/g, '""')}","${lastUpdatedDate}"\r\n`;
            });
            
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `faction_battle_stats_activity_${factionID}_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        });
        
        // Re-attach Collect Detailed Stats button listener
        const collectDetailedStatsBtn = document.getElementById('collectDetailedStatsBtn');
        if (collectDetailedStatsBtn) {
            // Clone and replace to remove all event listeners
            const newBtn = collectDetailedStatsBtn.cloneNode(true);
            collectDetailedStatsBtn.parentNode.replaceChild(newBtn, collectDetailedStatsBtn);
            newBtn.addEventListener('click', () => {
                const data = window.currentActivityData;
                if (data) {
                    handleDetailedStatsCollection(
                        data.sortedMemberIDs, 
                        data.membersObject, 
                        data.ffScores, 
                        data.battleStatsEstimates, 
                        data.myTotalStats || 0, 
                        data.factionName, 
                        data.factionID
                    );
                } else {
                    console.error('Activity data not found');
                }
            });
        }

        const copyTableBtnAct = document.getElementById('copyTableBtn');
        if (copyTableBtnAct) {
            copyTableBtnAct.addEventListener('click', async () => {
                const tbl = document.getElementById('membersTable');
                await battleStatsCopyTableToClipboard(copyTableBtnAct, tbl, {
                    factionTitle: `${factionName} (${periodConfig.labelTitle})`,
                    excludeColumns: ['ffscore']
                });
            });
        }
    };
    
    // Function to compare to own faction
    const handleCompareToOwnFaction = async (apiKey, periodConfigOverride = null) => {
        const compareBtn = document.getElementById('compareOwnFactionBtn');
        const progressContainer = document.getElementById('progressContainer');
        const progressMessage = document.getElementById('progressMessage');
        const progressPercentage = document.getElementById('progressPercentage');
        const progressFill = document.getElementById('progressFill');
        const progressDetails = document.getElementById('progressDetails');
        
        if (!compareBtn || !progressContainer) {
            console.error("Required elements missing for comparison");
            return;
        }
        
        const currentData = window.currentActivityData;
        const periodConfig = (periodConfigOverride && periodConfigOverride.periodDays != null && periodConfigOverride.cacheKeySegment)
            ? periodConfigOverride
            : (currentData && currentData.periodConfig)
            || (currentData && currentData.periodMonths != null
                ? buildBattleStatsActivityPeriodConfig(currentData.periodMonths === 1 ? '1' : '3')
                : buildBattleStatsActivityPeriodConfig('3'));
        const cacheKeySegment = periodConfig.cacheKeySegment;
        const periodDays = periodConfig.periodDays;
        
        // Disable button and show progress
        compareBtn.disabled = true;
        compareBtn.textContent = 'Fetching Own Faction...';
        progressContainer.style.display = 'block';
        if (progressMessage) progressMessage.textContent = 'Fetching your faction data...';
        if (progressPercentage) progressPercentage.textContent = '0%';
        if (progressFill) progressFill.style.width = '0%';
        if (progressDetails) progressDetails.textContent = 'Getting your faction information...';
        
        try {
            // Get user's faction ID
            const userData = await getUserData(apiKey);
            if (!userData || !userData.factionId) {
                alert('Unable to get your faction ID. Please ensure your API key has access to faction information.');
                compareBtn.disabled = false;
                compareBtn.textContent = 'Compare to Own Faction';
                progressContainer.style.display = 'none';
                return;
            }
            
            const ownFactionId = userData.factionId;
            const ownFactionName = userData.factionName || `Faction ${ownFactionId}`;
            
            if (progressDetails) progressDetails.textContent = `Fetching members from ${ownFactionName}...`;
            
            // Fetch own faction members
            const factionMembersUrl = `https://api.torn.com/v2/faction/${ownFactionId}/members?striptags=true&key=${apiKey}`;
            const membersResponse = await fetch(factionMembersUrl);
            const membersData = await membersResponse.json();
            
            if (membersData.error) {
                throw new Error(`Error fetching faction members: ${membersData.error.error}`);
            }
            
            const ownMembersArray = membersData.members || [];
            const ownMemberIDs = ownMembersArray.map(member => member.id.toString());
            const ownMembersObject = buildBattleStatsMembersObject(ownMembersArray);
            
            console.log(`Fetched ${ownMemberIDs.length} members from own faction`);
            
            await enrichBattleStatsMembersAccountStart(ownMemberIDs, ownMembersObject, apiKey, {
                progressMessage,
                progressDetails
            });
            
            // Fetch activity data for own faction (same window + cache key segment as viewed faction)
            const ownFid = normalizeBattleStatsFactionId(ownFactionId);
            const nowTimestamp = Math.floor(Date.now() / 1000);
            const pastTimestamp = Math.floor((Date.now() - (periodDays * 24 * 60 * 60 * 1000)) / 1000);
            const pastTimestampDay = Math.floor(pastTimestamp / 86400) * 86400;
            const dateKey = new Date().toISOString().split('T')[0];

            const pastCache = getBattleStatsActivityCache(
                BATTLE_STATS_ACTIVITY_PAST_PREFIX,
                `${ownFid}_${cacheKeySegment}_${pastTimestampDay}`,
                BATTLE_STATS_ACTIVITY_PAST_TTL_MS
            );
            const nowCache = getBattleStatsActivityCache(
                BATTLE_STATS_ACTIVITY_NOW_PREFIX,
                `${ownFid}_${dateKey}`,
                BATTLE_STATS_ACTIVITY_NOW_TTL_MS
            );

            const ownActivityData = {};
            ownMemberIDs.forEach(memberID => {
                const id = String(memberID);
                const member = ownMembersObject[id] || ownMembersObject[memberID];
                const pastEff = getEffectiveActivityPastTimestamp(pastTimestamp, member);
                ownActivityData[id] = {};
                if (pastCache) {
                    const rawPast = pastCache[id] !== undefined ? pastCache[id] : pastCache[memberID];
                    const parsedPast = parsePastCacheEntry(rawPast, pastTimestamp, pastEff);
                    if (parsedPast) {
                        ownActivityData[id][parsedPast.t] = parsedPast.v;
                    }
                }
                const ownNowVal = coerceCachedTimeplayedValue(nowCache?.[id] ?? nowCache?.[memberID]);
                if (ownNowVal != null) {
                    ownActivityData[id][nowTimestamp] = ownNowVal;
                }
            });

            const ownActivityRequests = [];
            ownMemberIDs.forEach(memberID => {
                const id = String(memberID);
                const member = ownMembersObject[id] || ownMembersObject[memberID];
                const pastEff = getEffectiveActivityPastTimestamp(pastTimestamp, member);
                if (!hasActivityTimeplayedSnapshot(ownActivityData, id, nowTimestamp)) {
                    ownActivityRequests.push({
                        playerId: id,
                        timestamp: nowTimestamp,
                        url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${nowTimestamp}&key=${apiKey}`
                    });
                }
                if (!hasActivityTimeplayedSnapshot(ownActivityData, id, pastEff)) {
                    ownActivityRequests.push({
                        playerId: id,
                        timestamp: pastEff,
                        url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${pastEff}&key=${apiKey}`
                    });
                }
            });

            const ownActivityFetchBatchOptions = {
                progressMessage,
                progressDetails,
                progressPercentage,
                progressFill,
                onSuccess: (data, request) => {
                    const timeplayed = extractTimeplayedFromPersonalstatsResponse(data);
                    const pid = String(request.playerId);
                    if (timeplayed === null) {
                        console.warn(`Activity (own faction): could not parse timeplayed for ${pid} at ts ${request.timestamp}`, data);
                        return;
                    }
                    if (!ownActivityData[pid]) {
                        ownActivityData[pid] = {};
                    }
                    ownActivityData[pid][request.timestamp] = timeplayed;
                },
                onError: (error, request) => {
                    console.error(`Error fetching activity for own faction member ${request.playerId}:`, error);
                }
            };

            if (ownActivityRequests.length > 0) {
                if (progressDetails) progressDetails.textContent = ownActivityRequests.length < ownMemberIDs.length * 2
                    ? `Fetching activity for your faction... (${ownActivityRequests.length} of ${ownMemberIDs.length * 2} from API, rest from cache)`
                    : `Fetching activity data for ${ownMemberIDs.length} members...`;
                await window.batchApiCallsWithRateLimit(ownActivityRequests, ownActivityFetchBatchOptions);
            } else if (progressDetails) {
                progressDetails.textContent = 'Activity data loaded from cache.';
            }

            const totalOwnPasses = 1 + BATTLE_STATS_ACTIVITY_EXTRA_RETRY_ROUNDS;
            for (let retryRound = 0; retryRound < BATTLE_STATS_ACTIVITY_EXTRA_RETRY_ROUNDS; retryRound++) {
                const retryOwn = buildMissingTimeplayedRequests(ownMemberIDs, ownActivityData, nowTimestamp, pastTimestamp, apiKey, ownMembersObject);
                if (retryOwn.length === 0) break;
                if (progressDetails) {
                    progressDetails.textContent = `Retrying ${retryOwn.length} missing snapshot(s) for your faction (pass ${retryRound + 2} of ${totalOwnPasses})...`;
                }
                await sleep(BATTLE_STATS_ACTIVITY_RETRY_BASE_DELAY_MS + retryRound * 1500);
                await window.batchApiCallsWithRateLimit(retryOwn, ownActivityFetchBatchOptions);
            }

            // Persist to cache for next time
            const pastDataToSave = {};
            const nowDataToSave = {};
            ownMemberIDs.forEach(memberID => {
                const id = String(memberID);
                const member = ownMembersObject[id] || ownMembersObject[memberID];
                const pastEff = getEffectiveActivityPastTimestamp(pastTimestamp, member);
                if (hasActivityTimeplayedSnapshot(ownActivityData, id, pastEff)) {
                    pastDataToSave[id] = { t: pastEff, v: ownActivityData[id][pastEff] };
                }
                if (hasActivityTimeplayedSnapshot(ownActivityData, id, nowTimestamp)) {
                    nowDataToSave[id] = ownActivityData[id][nowTimestamp];
                }
            });
            if (Object.keys(pastDataToSave).length > 0) {
                mergeBattleStatsActivityCache(
                    BATTLE_STATS_ACTIVITY_PAST_PREFIX,
                    `${ownFid}_${cacheKeySegment}_${pastTimestampDay}`,
                    BATTLE_STATS_ACTIVITY_PAST_TTL_MS,
                    pastDataToSave
                );
            }
            if (Object.keys(nowDataToSave).length > 0) {
                mergeBattleStatsActivityCache(
                    BATTLE_STATS_ACTIVITY_NOW_PREFIX,
                    `${ownFid}_${dateKey}`,
                    BATTLE_STATS_ACTIVITY_NOW_TTL_MS,
                    nowDataToSave
                );
            }

            // Calculate own faction activity hours (null if either snapshot missing)
            const ownActivityHours = {};
            console.log('Calculating activity hours - nowTimestamp:', nowTimestamp, 'pastTimestamp:', pastTimestamp, 'periodDays:', periodDays, 'cacheKeySegment:', cacheKeySegment);
            ownMemberIDs.forEach(memberID => {
                const id = String(memberID);
                const member = ownMembersObject[id] || ownMembersObject[memberID];
                const pastEff = getEffectiveActivityPastTimestamp(pastTimestamp, member);
                const currentRaw = ownActivityData[id]?.[nowTimestamp];
                const pastRaw = ownActivityData[id]?.[pastEff];
                const hasCurrent = typeof currentRaw === 'number' && !isNaN(currentRaw);
                const hasPast = typeof pastRaw === 'number' && !isNaN(pastRaw);
                if (!hasCurrent || !hasPast) {
                    ownActivityHours[id] = null;
                    return;
                }
                const differenceSeconds = currentRaw - pastRaw;
                ownActivityHours[id] = Math.max(0, differenceSeconds) / 3600;
            });
            
            console.log('Calculated own faction activity hours:', ownActivityHours);
            
            // Sort own faction members by activity (most active first) for FF Scouter fetch
            const ownSortedMemberIDs = [...ownMemberIDs].sort((a, b) => {
                const idA = String(a);
                const idB = String(b);
                const activityA = activityHoursSortValue(ownActivityHours[idA]);
                const activityB = activityHoursSortValue(ownActivityHours[idB]);
                return activityB - activityA;
            });
            
            // Fetch FF Scouter data for own faction members to get estimated stats
            if (progressDetails) progressDetails.textContent = 'Fetching estimated stats for own faction members...';
            const ownFactionMemberIDs = ownSortedMemberIDs.map(id => String(id));
            const ffScouterUrl = `https://ffscouter.com/api/v1/get-stats?key=${apiKey}&targets=`;
            console.log(`Fetching FF Scouter data for ${ownFactionMemberIDs.length} own faction members...`);
            const ownFfData = await fetchInParallelChunks(ffScouterUrl, ownFactionMemberIDs, 200, 3, 1000);
            
            const ownFfScores = {};
            const ownBattleStatsEstimates = {};
            ownFfData.forEach(player => {
                if (player.fair_fight) {
                    ownFfScores[player.player_id] = player.fair_fight;
                    ownBattleStatsEstimates[player.player_id] = player.bs_estimate;
                }
            });
            
            console.log('Fetched estimated stats for own faction:', ownBattleStatsEstimates);
            
            // Get current activity data
            if (!currentData) {
                throw new Error('Current activity data not found');
            }
            
            // Update graph and table with both datasets
            updateGraphWithComparison(currentData, ownMembersObject, ownActivityHours, ownFactionName, apiKey, periodConfig, ownBattleStatsEstimates);
            
            // Hide progress
            progressContainer.style.display = 'none';
            compareBtn.disabled = false;
            compareBtn.textContent = 'Comparison Loaded';
            compareBtn.style.opacity = '0.7';
            
        } catch (error) {
            console.error('Error comparing to own faction:', error);
            alert('Error fetching own faction data: ' + error.message);
            compareBtn.disabled = false;
            compareBtn.textContent = 'Compare to Own Faction';
            progressContainer.style.display = 'none';
        }
    };
    
    // Function to update graph and table with comparison data
    const updateGraphWithComparison = (currentData, ownMembersObject, ownActivityHours, ownFactionName, apiKey, periodConfigIn = null, ownBattleStatsEstimates = {}) => {
        const periodConfig = periodConfigIn && periodConfigIn.labelTitle
            ? periodConfigIn
            : resolvePeriodConfigFromActivityContext(currentData);
        const labelTitle = periodConfig.labelTitle;
        // Graph will be created after table HTML is inserted (in setTimeout below)
        
        // Sort each faction's players separately by activity (most active to least active)
        // Selected faction is already sorted in currentData.sortedMemberIDs
        // Sort own faction's players by activity
        const ownSortedMemberIDs = Object.keys(ownActivityHours).sort((a, b) => {
            const activityA = activityHoursSortValue(ownActivityHours[a]);
            const activityB = activityHoursSortValue(ownActivityHours[b]);
            return activityB - activityA;
        });
        
        // Determine the maximum number of positions (use the larger of the two factions)
        const maxPositions = Math.max(currentData.sortedMemberIDs.length, ownSortedMemberIDs.length);
        
        // Create position-based labels (1st, 2nd, 3rd, etc.)
        const labels = Array.from({ length: maxPositions }, (_, i) => {
            const position = i + 1;
            // Get names for both factions at this position for the label
            const selectedFactionName = currentData.sortedMemberIDs[i] 
                ? (currentData.membersObject[currentData.sortedMemberIDs[i]]?.name || `Player ${currentData.sortedMemberIDs[i]}`)
                : null;
            const ownFactionNameAtPos = ownSortedMemberIDs[i]
                ? (ownMembersObject[ownSortedMemberIDs[i]]?.name || ownMembersObject[parseInt(ownSortedMemberIDs[i])]?.name || `Player ${ownSortedMemberIDs[i]}`)
                : null;
            
            if (selectedFactionName && ownFactionNameAtPos) {
                return `${position} (${selectedFactionName} vs ${ownFactionNameAtPos})`;
            } else if (selectedFactionName) {
                return `${position} (${selectedFactionName})`;
            } else if (ownFactionNameAtPos) {
                return `${position} (${ownFactionNameAtPos})`;
            }
            return `Position ${position}`;
        });
        
        // Create data arrays based on position (1st most active, 2nd most active, etc.)
        const currentFactionData = Array.from({ length: maxPositions }, (_, i) => {
            if (i < currentData.sortedMemberIDs.length) {
                const memberID = currentData.sortedMemberIDs[i];
                const v = getActivityHoursForMember(currentData.activityHours, memberID);
                return v == null ? NaN : v;
            }
            return null;
        });
        
        const ownFactionData = Array.from({ length: maxPositions }, (_, i) => {
            if (i < ownSortedMemberIDs.length) {
                const memberID = ownSortedMemberIDs[i];
                const v = getActivityHoursForMember(ownActivityHours, memberID);
                return v == null ? NaN : v;
            }
            return null;
        });
        
        console.log('Comparison data:', {
            selectedFactionCount: currentData.sortedMemberIDs.length,
            ownFactionCount: ownSortedMemberIDs.length,
            maxPositions: maxPositions,
            labels: labels.length,
            currentFactionDataPoints: currentFactionData.filter(v => v !== null).length,
            ownFactionDataPoints: ownFactionData.filter(v => v !== null).length
        });
        
        // Get existing data for the table
        const battleStatsDataForTable = window.battleStatsData || {};
        const currentFfScores = battleStatsDataForTable.ffScores || {};
        const currentBattleStatsEstimates = battleStatsDataForTable.battleStatsEstimates || {};
        
        // Update the table to show side-by-side comparison (this creates the canvas element)
        // Pass the sorted member IDs from both factions for the table
        updateComparisonTable(currentData.sortedMemberIDs, ownSortedMemberIDs, currentData, ownMembersObject, ownActivityHours, ownFactionName, currentFfScores, currentBattleStatsEstimates, periodConfig, ownBattleStatsEstimates);
        
        // Create line chart with two datasets (similar to admin dashboard) - wait for DOM to update
        setTimeout(() => {
            const canvas = document.getElementById('activityGraph');
            if (!canvas) {
                console.error('Canvas element not found');
                return;
            }
            const ctx = canvas.getContext('2d');
            
            // Destroy existing chart if it exists
            if (window.activityChart) {
                window.activityChart.destroy();
            }
            
            window.activityChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: `${currentData.factionName} (${labelTitle})`,
                            data: currentFactionData,
                            borderColor: '#ffd700', // Yellow to match app styling
                            backgroundColor: 'rgba(255, 215, 0, 0.1)',
                            borderWidth: 2,
                            fill: false,
                            tension: 0.4,
                            pointRadius: 3,
                            pointHoverRadius: 5,
                            pointBackgroundColor: '#ffd700',
                            pointBorderColor: '#fff',
                            pointBorderWidth: 1
                        },
                        {
                            label: `${ownFactionName} (${labelTitle})`,
                            data: ownFactionData,
                            borderColor: '#9C27B0', // Purple
                            backgroundColor: 'rgba(156, 39, 176, 0.1)',
                            borderWidth: 2,
                            fill: false,
                            tension: 0.4,
                            pointRadius: 3,
                            pointHoverRadius: 5,
                            pointBackgroundColor: '#9C27B0',
                            pointBorderColor: '#fff',
                            pointBorderWidth: 1
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top',
                            labels: {
                                color: '#fff',
                                font: {
                                    size: 12,
                                    weight: 'bold'
                                },
                                usePointStyle: true,
                                padding: 10
                            }
                        },
                        tooltip: {
                            backgroundColor: 'rgba(0, 0, 0, 0.8)',
                            titleColor: '#ffd700',
                            bodyColor: '#fff',
                            borderColor: '#ffd700',
                            borderWidth: 1,
                            callbacks: {
                                label: function(context) {
                                    const y = context.parsed.y;
                                    if (y == null || (typeof y === 'number' && isNaN(y))) {
                                        return `${context.dataset.label}: incomplete`;
                                    }
                                    return `${context.dataset.label}: ${formatHoursMinutes(y)}`;
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            title: {
                                display: true,
                                text: 'Players (Most Active → Least Active)',
                                color: '#fff',
                                font: {
                                    size: 14,
                                    weight: 'bold'
                                }
                            },
                            ticks: {
                                color: '#fff',
                                font: {
                                    size: 10
                                },
                                maxRotation: 45,
                                minRotation: 45
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        },
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Activity (Hours)',
                                color: '#fff',
                                font: {
                                    size: 14,
                                    weight: 'bold'
                                }
                            },
                            ticks: {
                                color: '#fff',
                                stepSize: 50
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        }
                    }
                }
            });
        }, 300);
    };
    
    // Function to update table with side-by-side comparison
    const updateComparisonTable = (currentSortedMemberIDs, ownSortedMemberIDs, currentData, ownMembersObject, ownActivityHours, ownFactionName, currentFfScores, currentBattleStatsEstimates, periodConfigIn = null, ownBattleStatsEstimates = {}) => {
        const periodConfig = periodConfigIn && periodConfigIn.labelTitle
            ? periodConfigIn
            : resolvePeriodConfigFromActivityContext(currentData);
        const labelTitle = periodConfig.labelTitle;
        const resultsContainer = document.getElementById('battle-stats-results');
        if (!resultsContainer) return;
        
        // Get the current faction name
        const currentFactionName = currentData.factionName;
        
        // Get the original table HTML to keep it below
        const originalTable = resultsContainer.querySelector('#membersTable')?.closest('.table-scroll-wrapper');
        const originalTableHtml = originalTable ? originalTable.outerHTML : '';
        const patchedOriginalHtml = originalTableHtml
            ? originalTableHtml.replace(/id="membersTable"/, 'id="membersTableActivityDetail"')
            : '';
        
        let tableHtml = `
            <!-- Summary Section (NOT scrollable) -->
            <div style="margin-bottom: 20px;">
                <button id="exportCsvBtn" class="btn" style="background-color: #FFD700; color: #333; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">
                    Export to CSV
                </button>
                <button id="collectDetailedStatsBtn" class="btn" style="background-color: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: 10px;">
                    Collect Detailed Stats
                </button>
                <button id="compareActivityBtn" class="btn" style="background-color: #2196F3; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: 10px; opacity: 0.7;" disabled>
                    Check Activity (Loaded)
                </button>
                <button id="compareOwnFactionBtn" class="btn" style="background-color: #9C27B0; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: 10px; opacity: 0.7;" disabled>
                    Comparison Loaded
                </button>
            </div>
            <h2 style="text-align: center; margin-bottom: 20px; color: var(--accent-color);">Faction Activity Comparison (${labelTitle})</h2>
            
            <!-- Activity Graph -->
            <div style="margin-bottom: 30px; background-color: var(--primary-color); border-radius: 8px; padding: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h3 style="color: var(--accent-color); margin: 0;">Activity Graph (Most Active → Least Active)</h3>
                </div>
                <div style="position: relative; height: 400px;">
                    <canvas id="activityGraph"></canvas>
                </div>
            </div>
            
            <div style="position: relative; margin-bottom: 5px;">
                <button type="button" id="copyComparisonTableBtn" class="btn" style="${BATTLE_STATS_COPY_BTN_STYLE}" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'" title="Copy side-by-side comparison table">
                    📋 Copy
                </button>
            </div>
            <!-- Comparison Table Wrapper (SCROLLABLE) -->
            <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                <table id="membersTable" style="width: 100%; font-size: 13px;">
                    <thead>
                        <tr>
                            <th colspan="4" style="text-align: center; background-color: rgba(255, 215, 0, 0.2); border-right: 2px solid var(--accent-color);">
                                ${currentFactionName}
                            </th>
                            <th colspan="4" style="text-align: center; background-color: rgba(156, 39, 176, 0.2);">
                                ${ownFactionName}
                            </th>
                        </tr>
                        <tr>
                            <th data-column="member1" style="min-width: 120px; cursor: pointer; text-align: left; padding: 8px 6px;">Member <span class="sort-indicator"></span></th>
                            <th data-column="level1" style="min-width: 60px; cursor: pointer; text-align: left; padding: 8px 6px;">Level <span class="sort-indicator"></span></th>
                            <th data-column="stats1" style="min-width: 120px; cursor: pointer; text-align: left; padding: 8px 6px;">Estimated Stats <span class="sort-indicator"></span></th>
                            <th data-column="activity1" style="min-width: 60px; cursor: pointer; text-align: left; border-right: 2px solid var(--accent-color); padding: 8px 6px; white-space: normal; line-height: 1.2;">Activity<br>(Hours) <span class="sort-indicator">↓</span></th>
                            <th data-column="member2" style="min-width: 120px; cursor: pointer; text-align: left; padding: 8px 6px;">Member <span class="sort-indicator"></span></th>
                            <th data-column="level2" style="min-width: 60px; cursor: pointer; text-align: left; padding: 8px 6px;">Level <span class="sort-indicator"></span></th>
                            <th data-column="stats2" style="min-width: 120px; cursor: pointer; text-align: left; padding: 8px 6px;">Estimated Stats <span class="sort-indicator"></span></th>
                            <th data-column="activity2" style="min-width: 60px; cursor: pointer; text-align: left; padding: 8px 6px; white-space: normal; line-height: 1.2;">Activity<br>(Hours) <span class="sort-indicator">↓</span></th>
                        </tr>
                    </thead>
                    <tbody>`;
        
        // Create rows - pair up players from both factions side by side
        const maxRows = Math.max(currentData.sortedMemberIDs.length, ownSortedMemberIDs.length);
        
        for (let i = 0; i < maxRows; i++) {
            // Get player from selected faction (if exists)
            const currentPlayerID = currentData.sortedMemberIDs[i];
            const currentMember = currentPlayerID ? currentData.membersObject[currentPlayerID] : null;
            const currentActivity = currentPlayerID ? getActivityHoursForMember(currentData.activityHours, currentPlayerID) : null;
            const currentLevel = currentMember ? (currentMember.level || 'Unknown') : null;
            const currentName = currentMember ? currentMember.name : null;
            const currentEstimatedStat = currentPlayerID ? (currentBattleStatsEstimates[currentPlayerID] || 'N/A') : null;
            const displayCurrentEstimatedStat = (currentEstimatedStat && currentEstimatedStat !== 'N/A') ? currentEstimatedStat.toLocaleString() : (currentEstimatedStat || '-');
            
            // Get player from own faction (if exists)
            const ownPlayerID = ownSortedMemberIDs[i];
            const ownMember = ownPlayerID ? (ownMembersObject[ownPlayerID] || ownMembersObject[parseInt(ownPlayerID)]) : null;
            const ownActivity = ownPlayerID ? getActivityHoursForMember(ownActivityHours, ownPlayerID) : null;
            const ownLevel = ownMember ? (ownMember.level || 'Unknown') : null;
            const ownName = ownMember ? ownMember.name : null;
            const ownEstimatedStat = ownPlayerID ? (ownBattleStatsEstimates[ownPlayerID] || ownBattleStatsEstimates[parseInt(ownPlayerID)] || 'N/A') : null;
            const displayOwnEstimatedStat = (ownEstimatedStat && ownEstimatedStat !== 'N/A') ? ownEstimatedStat.toLocaleString() : (ownEstimatedStat || '-');
            
            tableHtml += `
                <tr>
                    <td data-column="member1" data-value="${currentName ? currentName.toLowerCase() : ''}">
                        ${currentPlayerID ? `<a href="https://www.torn.com/profiles.php?XID=${currentPlayerID}" target="_blank" style="color: #FFD700; text-decoration: none;">${currentName}</a>` : '-'}
                    </td>
                    <td data-column="level1" data-value="${currentLevel === 'Unknown' || !currentLevel ? -1 : currentLevel}">${currentLevel || '-'}</td>
                    <td data-column="stats1" data-value="${currentEstimatedStat === 'N/A' || !currentEstimatedStat ? -1 : currentEstimatedStat}">${displayCurrentEstimatedStat}</td>
                    <td data-column="activity1" data-value="${typeof currentActivity === 'number' ? currentActivity : -1e9}" style="border-right: 2px solid var(--accent-color); padding-right: 10px;">${typeof currentActivity === 'number' ? formatHoursMinutes(currentActivity) : '-'}</td>
                    <td data-column="member2" data-value="${ownName ? ownName.toLowerCase() : ''}">
                        ${ownPlayerID ? `<a href="https://www.torn.com/profiles.php?XID=${ownPlayerID}" target="_blank" style="color: #9C27B0; text-decoration: none;">${ownName}</a>` : '-'}
                    </td>
                    <td data-column="level2" data-value="${ownLevel === 'Unknown' || !ownLevel ? -1 : ownLevel}">${ownLevel || '-'}</td>
                    <td data-column="stats2" data-value="${ownEstimatedStat === 'N/A' || !ownEstimatedStat ? -1 : ownEstimatedStat}">${displayOwnEstimatedStat}</td>
                    <td data-column="activity2" data-value="${typeof ownActivity === 'number' ? ownActivity : -1e9}" style="padding-right: 10px;">${typeof ownActivity === 'number' ? formatHoursMinutes(ownActivity) : '-'}</td>
                </tr>`;
        }
        
        tableHtml += `
                    </tbody>
                </table>
            </div>
            
            <!-- Original Table (kept below comparison) -->
            ${patchedOriginalHtml ? `<div style="margin-top: 40px;"><h3 style="color: var(--accent-color); margin-bottom: 15px;">${currentFactionName} - Original View</h3><div style="position: relative; margin-bottom: 5px;"><button type="button" id="copyActivityDetailTableBtn" class="btn" style="${BATTLE_STATS_COPY_BTN_STYLE}" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'" title="Copy activity member list below (FF Score omitted)">📋 Copy</button></div>${patchedOriginalHtml}</div>` : ''}`;
        
        resultsContainer.innerHTML = tableHtml;
        resultsContainer.style.display = 'block';
        
        // Re-create the graph after DOM update - wait for canvas to exist
        setTimeout(() => {
            const canvas = document.getElementById('activityGraph');
            if (canvas) {
                // The graph should already be created by updateGraphWithComparison, but verify
                if (!window.activityChart) {
                    console.warn('Graph chart not found, attempting to recreate...');
                    // Recreate with combined data
                    const allPlayerIDs = new Set();
                    currentData.sortedMemberIDs.forEach(id => allPlayerIDs.add(String(id)));
                    Object.keys(ownActivityHours).forEach(id => allPlayerIDs.add(String(id)));
                    const sortedAllPlayerIDsForGraph = Array.from(allPlayerIDs).sort((a, b) => {
                        const activityA = Math.max(
                            activityHoursSortValue(getActivityHoursForMember(currentData.activityHours, a)),
                            activityHoursSortValue(getActivityHoursForMember(ownActivityHours, a))
                        );
                        const activityB = Math.max(
                            activityHoursSortValue(getActivityHoursForMember(currentData.activityHours, b)),
                            activityHoursSortValue(getActivityHoursForMember(ownActivityHours, b))
                        );
                        return activityB - activityA;
                    });
                    const labels = sortedAllPlayerIDsForGraph.map(id => {
                        const member = currentData.membersObject[id] || currentData.membersObject[parseInt(id)] || ownMembersObject[id] || ownMembersObject[parseInt(id)];
                        const isOwnFaction = ownActivityHours[id] !== undefined || ownActivityHours[parseInt(id)] !== undefined;
                        return member ? `${member.name}${isOwnFaction ? ' (Your Faction)' : ''}` : `Player ${id}`;
                    });
                    const currentFactionData = sortedAllPlayerIDsForGraph.map(id => {
                        const v = getActivityHoursForMember(currentData.activityHours, id);
                        return v == null ? NaN : v;
                    });
                    const ownFactionData = sortedAllPlayerIDsForGraph.map(id => {
                        const v = getActivityHoursForMember(ownActivityHours, id);
                        return v == null ? NaN : v;
                    });
                    const ctx = canvas.getContext('2d');
                    window.activityChart = new Chart(ctx, {
                        type: 'line',
                        data: {
                            labels: labels,
                            datasets: [
                                {
                                    label: `${currentData.factionName} (${labelTitle})`,
                                    data: currentFactionData,
                                    borderColor: '#ffd700',
                                    backgroundColor: 'rgba(255, 215, 0, 0.1)',
                                    borderWidth: 2,
                                    fill: false,
                                    tension: 0.4,
                                    pointRadius: 3,
                                    pointHoverRadius: 5,
                                    pointBackgroundColor: '#ffd700',
                                    pointBorderColor: '#fff',
                                    pointBorderWidth: 1
                                },
                                {
                                    label: `${ownFactionName} (${labelTitle})`,
                                    data: ownFactionData,
                                    borderColor: '#9C27B0',
                                    backgroundColor: 'rgba(156, 39, 176, 0.1)',
                                    borderWidth: 2,
                                    fill: false,
                                    tension: 0.4,
                                    pointRadius: 3,
                                    pointHoverRadius: 5,
                                    pointBackgroundColor: '#9C27B0',
                                    pointBorderColor: '#fff',
                                    pointBorderWidth: 1
                                }
                            ]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: {
                                    display: true,
                                    position: 'top',
                                    labels: {
                                        color: '#fff',
                                        font: { size: 12, weight: 'bold' },
                                        usePointStyle: true,
                                        padding: 10
                                    }
                                },
                                tooltip: {
                                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                                    titleColor: '#ffd700',
                                    bodyColor: '#fff',
                                    borderColor: '#ffd700',
                                    borderWidth: 1,
                                    callbacks: {
                                        label: function(context) {
                                            const y = context.parsed.y;
                                            if (y == null || (typeof y === 'number' && isNaN(y))) {
                                                return `${context.dataset.label}: incomplete`;
                                            }
                                            return `${context.dataset.label}: ${formatHoursMinutes(y)}`;
                                        }
                                    }
                                }
                            },
                            scales: {
                                x: {
                                    title: {
                                        display: true,
                                        text: 'Players (Most Active → Least Active)',
                                        color: '#fff',
                                        font: { size: 14, weight: 'bold' }
                                    },
                                    ticks: {
                                        color: '#fff',
                                        font: { size: 10 },
                                        maxRotation: 45,
                                        minRotation: 45
                                    },
                                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                                },
                                y: {
                                    beginAtZero: true,
                                    title: {
                                        display: true,
                                        text: 'Activity (Hours)',
                                        color: '#fff',
                                        font: { size: 14, weight: 'bold' }
                                    },
                                    ticks: {
                                        color: '#fff',
                                        stepSize: 50
                                    },
                                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                                }
                            }
                        }
                    });
                }
            }
        }, 200);
        
        // Add sorting functionality for comparison table
        const table = document.getElementById('membersTable');
        const headers = table.querySelectorAll('th[data-column]');
        let currentSortColumn = 'activity1';
        let currentSortDirection = 'desc';
        
        // Store original data for re-sorting
        const originalCurrentSortedIDs = [...currentData.sortedMemberIDs];
        const originalOwnSortedIDs = [...ownSortedMemberIDs];
        
        const sortAndReRenderTable = (column, direction) => {
            // Determine which column type we're sorting by (remove the 1/2 suffix)
            const baseColumn = column.replace(/[12]$/, '');
            const isColumn1 = column.endsWith('1');
            const isColumn2 = column.endsWith('2');
            
            // Sort both factions independently based on the selected column
            let sortedCurrentIDs = [...currentData.sortedMemberIDs];
            let sortedOwnIDs = [...ownSortedMemberIDs];
            
            // Sort current faction
            sortedCurrentIDs.sort((a, b) => {
                const aMember = currentData.membersObject[a];
                const bMember = currentData.membersObject[b];
                let aValue, bValue;
                
                if (baseColumn === 'member') {
                    aValue = aMember?.name?.toLowerCase() || '';
                    bValue = bMember?.name?.toLowerCase() || '';
                } else if (baseColumn === 'level') {
                    aValue = aMember?.level === 'Unknown' ? -1 : (parseFloat(aMember?.level) || -1);
                    bValue = bMember?.level === 'Unknown' ? -1 : (parseFloat(bMember?.level) || -1);
                } else if (baseColumn === 'stats') {
                    aValue = currentBattleStatsEstimates[a] || -1;
                    bValue = currentBattleStatsEstimates[b] || -1;
                } else if (baseColumn === 'activity') {
                    aValue = activityHoursSortValue(getActivityHoursForMember(currentData.activityHours, a));
                    bValue = activityHoursSortValue(getActivityHoursForMember(currentData.activityHours, b));
                } else {
                    return 0;
                }
                
                if (baseColumn === 'member') {
                    if (aValue < bValue) return direction === 'asc' ? -1 : 1;
                    if (aValue > bValue) return direction === 'asc' ? 1 : -1;
                    return 0;
                } else {
                    if (direction === 'desc') {
                        return bValue - aValue;
                    } else {
                        return aValue - bValue;
                    }
                }
            });
            
            // Sort own faction
            sortedOwnIDs.sort((a, b) => {
                const aMember = ownMembersObject[a] || ownMembersObject[parseInt(a)];
                const bMember = ownMembersObject[b] || ownMembersObject[parseInt(b)];
                let aValue, bValue;
                
                if (baseColumn === 'member') {
                    aValue = aMember?.name?.toLowerCase() || '';
                    bValue = bMember?.name?.toLowerCase() || '';
                } else if (baseColumn === 'level') {
                    aValue = aMember?.level === 'Unknown' ? -1 : (parseFloat(aMember?.level) || -1);
                    bValue = bMember?.level === 'Unknown' ? -1 : (parseFloat(bMember?.level) || -1);
                } else if (baseColumn === 'stats') {
                    aValue = ownBattleStatsEstimates[a] || ownBattleStatsEstimates[parseInt(a)] || -1;
                    bValue = ownBattleStatsEstimates[b] || ownBattleStatsEstimates[parseInt(b)] || -1;
                } else if (baseColumn === 'activity') {
                    aValue = activityHoursSortValue(getActivityHoursForMember(ownActivityHours, a));
                    bValue = activityHoursSortValue(getActivityHoursForMember(ownActivityHours, b));
                } else {
                    return 0;
                }
                
                if (baseColumn === 'member') {
                    if (aValue < bValue) return direction === 'asc' ? -1 : 1;
                    if (aValue > bValue) return direction === 'asc' ? 1 : -1;
                    return 0;
                } else {
                    if (direction === 'desc') {
                        return bValue - aValue;
                    } else {
                        return aValue - bValue;
                    }
                }
            });
            
            // Update sort indicators
            headers.forEach(h => {
                const indicator = h.querySelector('.sort-indicator');
                const hColumn = h.getAttribute('data-column');
                if (hColumn === column || (hColumn.replace(/[12]$/, '') === baseColumn)) {
                    if (hColumn === column) {
                        indicator.textContent = direction === 'asc' ? ' ↑' : ' ↓';
                    } else {
                        indicator.textContent = '';
                    }
                } else {
                    indicator.textContent = '';
                }
            });
            
            // Re-render the table with new sorted order
            const tbody = table.querySelector('tbody');
            tbody.innerHTML = '';
            
            const maxRows = Math.max(sortedCurrentIDs.length, sortedOwnIDs.length);
            
            for (let i = 0; i < maxRows; i++) {
                const currentPlayerID = sortedCurrentIDs[i];
                const currentMember = currentPlayerID ? currentData.membersObject[currentPlayerID] : null;
                const currentActivity = currentPlayerID ? getActivityHoursForMember(currentData.activityHours, currentPlayerID) : null;
                const currentLevel = currentMember ? (currentMember.level || 'Unknown') : null;
                const currentName = currentMember ? currentMember.name : null;
                const currentEstimatedStat = currentPlayerID ? (currentBattleStatsEstimates[currentPlayerID] || 'N/A') : null;
                const displayCurrentEstimatedStat = (currentEstimatedStat && currentEstimatedStat !== 'N/A') ? currentEstimatedStat.toLocaleString() : (currentEstimatedStat || '-');
                
                const ownPlayerID = sortedOwnIDs[i];
                const ownMember = ownPlayerID ? (ownMembersObject[ownPlayerID] || ownMembersObject[parseInt(ownPlayerID)]) : null;
                const ownActivity = ownPlayerID ? getActivityHoursForMember(ownActivityHours, ownPlayerID) : null;
                const ownLevel = ownMember ? (ownMember.level || 'Unknown') : null;
                const ownName = ownMember ? ownMember.name : null;
                const ownEstimatedStat = ownPlayerID ? (ownBattleStatsEstimates[ownPlayerID] || ownBattleStatsEstimates[parseInt(ownPlayerID)] || 'N/A') : null;
                const displayOwnEstimatedStat = (ownEstimatedStat && ownEstimatedStat !== 'N/A') ? ownEstimatedStat.toLocaleString() : (ownEstimatedStat || '-');
                
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td data-column="member1" data-value="${currentName ? currentName.toLowerCase() : ''}" style="padding: 8px 6px;">
                        ${currentPlayerID ? `<a href="https://www.torn.com/profiles.php?XID=${currentPlayerID}" target="_blank" style="color: #FFD700; text-decoration: none;">${currentName}</a>` : '-'}
                    </td>
                    <td data-column="level1" data-value="${currentLevel === 'Unknown' || !currentLevel ? -1 : currentLevel}" style="padding: 8px 6px;">${currentLevel || '-'}</td>
                    <td data-column="stats1" data-value="${currentEstimatedStat === 'N/A' || !currentEstimatedStat ? -1 : currentEstimatedStat}" style="padding: 8px 6px;">${displayCurrentEstimatedStat}</td>
                    <td data-column="activity1" data-value="${typeof currentActivity === 'number' ? currentActivity : -1e9}" style="border-right: 2px solid var(--accent-color); padding: 8px 6px;">${typeof currentActivity === 'number' ? formatHoursMinutes(currentActivity) : '-'}</td>
                    <td data-column="member2" data-value="${ownName ? ownName.toLowerCase() : ''}" style="padding: 8px 6px;">
                        ${ownPlayerID ? `<a href="https://www.torn.com/profiles.php?XID=${ownPlayerID}" target="_blank" style="color: #9C27B0; text-decoration: none;">${ownName}</a>` : '-'}
                    </td>
                    <td data-column="level2" data-value="${ownLevel === 'Unknown' || !ownLevel ? -1 : ownLevel}" style="padding: 8px 6px;">${ownLevel || '-'}</td>
                    <td data-column="stats2" data-value="${ownEstimatedStat === 'N/A' || !ownEstimatedStat ? -1 : ownEstimatedStat}" style="padding: 8px 6px;">${displayOwnEstimatedStat}</td>
                    <td data-column="activity2" data-value="${typeof ownActivity === 'number' ? ownActivity : -1e9}" style="padding: 8px 6px;">${typeof ownActivity === 'number' ? formatHoursMinutes(ownActivity) : '-'}</td>
                `;
                tbody.appendChild(row);
            }
            
            // Update the sorted arrays for CSV export
            currentData.sortedMemberIDs = sortedCurrentIDs;
            ownSortedMemberIDs.length = 0;
            ownSortedMemberIDs.push(...sortedOwnIDs);
        };
        
        sortAndReRenderTable(currentSortColumn, currentSortDirection);
        
        headers.forEach(header => {
            header.addEventListener('click', () => {
                const column = header.getAttribute('data-column');
                
                if (currentSortColumn === column) {
                    currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSortColumn = column;
                    currentSortDirection = 'asc';
                }
                
                sortAndReRenderTable(currentSortColumn, currentSortDirection);
            });
        });
        
        // Add CSV export functionality for comparison table
        document.getElementById('exportCsvBtn').addEventListener('click', () => {
            const headers = [`${currentFactionName} - Member`, `${currentFactionName} - Level`, `${currentFactionName} - Estimated Stats`, `${currentFactionName} - Activity (Hours)`, `${ownFactionName} - Member`, `${ownFactionName} - Level`, `${ownFactionName} - Estimated Stats`, `${ownFactionName} - Activity (Hours)`];
            let csvContent = headers.join(',') + '\r\n';
            
            for (let i = 0; i < maxRows; i++) {
                const currentPlayerID = currentData.sortedMemberIDs[i];
                const currentMember = currentPlayerID ? currentData.membersObject[currentPlayerID] : null;
                const currentActivity = currentPlayerID ? getActivityHoursForMember(currentData.activityHours, currentPlayerID) : null;
                const currentLevel = currentMember ? (currentMember.level || 'Unknown') : null;
                const currentName = currentMember ? currentMember.name : null;
                const currentEstimatedStat = currentPlayerID ? (currentBattleStatsEstimates[currentPlayerID] || 'N/A') : null;
                const displayCurrentEstimatedStat = (currentEstimatedStat && currentEstimatedStat !== 'N/A') ? currentEstimatedStat.toLocaleString() : (currentEstimatedStat || '-');
                
                const ownPlayerID = ownSortedMemberIDs[i];
                const ownMember = ownPlayerID ? (ownMembersObject[ownPlayerID] || ownMembersObject[parseInt(ownPlayerID)]) : null;
                const ownActivity = ownPlayerID ? getActivityHoursForMember(ownActivityHours, ownPlayerID) : null;
                const ownLevel = ownMember ? (ownMember.level || 'Unknown') : null;
                const ownName = ownMember ? ownMember.name : null;
                const ownEstimatedStat = ownPlayerID ? (ownBattleStatsEstimates[ownPlayerID] || ownBattleStatsEstimates[parseInt(ownPlayerID)] || 'N/A') : null;
                const displayOwnEstimatedStat = (ownEstimatedStat && ownEstimatedStat !== 'N/A') ? ownEstimatedStat.toLocaleString() : (ownEstimatedStat || '-');
                
                csvContent += `"${currentName || '-'}",${currentLevel || '-'},"${displayCurrentEstimatedStat}","${typeof currentActivity === 'number' ? formatHoursMinutes(currentActivity) : '-'}","${ownName || '-'}",${ownLevel || '-'},"${displayOwnEstimatedStat}","${typeof ownActivity === 'number' ? formatHoursMinutes(ownActivity) : '-'}"\r\n`;
            }
            
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `faction_activity_comparison_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        });

        const copyComparisonTableBtn = document.getElementById('copyComparisonTableBtn');
        if (copyComparisonTableBtn) {
            copyComparisonTableBtn.addEventListener('click', async () => {
                const tbl = document.getElementById('membersTable');
                await battleStatsCopyTableToClipboard(copyComparisonTableBtn, tbl, {
                    factionTitle: `Faction Activity Comparison (${labelTitle}) — ${currentFactionName} vs ${ownFactionName}`,
                    excludeColumns: []
                });
            });
        }
        const copyActivityDetailTableBtn = document.getElementById('copyActivityDetailTableBtn');
        if (copyActivityDetailTableBtn) {
            copyActivityDetailTableBtn.addEventListener('click', async () => {
                const detailTbl = document.getElementById('membersTableActivityDetail');
                await battleStatsCopyTableToClipboard(copyActivityDetailTableBtn, detailTbl, {
                    factionTitle: `${currentFactionName} — activity list (${labelTitle})`,
                    excludeColumns: ['ffscore']
                });
            });
        }
    };
    
    // Function to create activity graph
    const createActivityGraph = (sortedMemberIDs, membersObject, activityHours, ownFactionData = null, activityPeriodLabel = 'Last 3 Months') => {
        const canvas = document.getElementById('activityGraph');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.activityChart) {
            window.activityChart.destroy();
        }
        
        // Prepare data (already sorted: most active to least active)
        const labels = sortedMemberIDs.map(id => {
            const idStr = String(id);
            const member = membersObject[idStr] || membersObject[id];
            return member ? member.name : `Player ${idStr}`;
        });
        
        const data = sortedMemberIDs.map(id => {
            const idStr = String(id);
            const v = activityHours[idStr] ?? activityHours[id];
            if (v == null || typeof v !== 'number' || isNaN(v)) return NaN;
            return v;
        });
        
        // Create line chart (similar to admin dashboard)
        window.activityChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: `Activity (Hours) - ${activityPeriodLabel}`,
                    data: data,
                    borderColor: '#ffd700', // Yellow to match app styling
                    backgroundColor: 'rgba(255, 215, 0, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: '#ffd700',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#fff',
                            font: {
                                size: 12,
                                weight: 'bold'
                            },
                            usePointStyle: true,
                            padding: 10
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#ffd700',
                        bodyColor: '#fff',
                        borderColor: '#ffd700',
                        borderWidth: 1,
                        callbacks: {
                            label: function(context) {
                                const y = context.parsed.y;
                                if (y == null || (typeof y === 'number' && isNaN(y))) {
                                    return 'Activity: incomplete (re-run Check Activity)';
                                }
                                return `Activity: ${formatHoursMinutes(y)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: 'Players (Most Active → Least Active)',
                            color: '#fff',
                            font: {
                                size: 14,
                                weight: 'bold'
                            }
                        },
                        ticks: {
                            color: '#fff',
                            font: {
                                size: 10
                            },
                            maxRotation: 45,
                            minRotation: 45
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        }
                    },
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Activity (Hours)',
                            color: '#fff',
                            font: {
                                size: 14,
                                weight: 'bold'
                            }
                        },
                        ticks: {
                            color: '#fff',
                            stepSize: 50
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        }
                    }
                }
            }
        });
    };

    /**
     * Re-fetch timeplayed (now + period start) for one member, merge into activity caches, update row + graph.
     * Used when Check Activity left "-" (cache-only or failed snapshots).
     */
    async function retryBattleStatsActivityForPlayer(playerId, buttonEl) {
        const apiKey = localStorage.getItem('tornApiKey');
        if (!apiKey) {
            alert('Please set your API key in the sidebar first.');
            return;
        }
        const ctx = window.currentActivityData;
        if (!ctx || !ctx.sortedMemberIDs) {
            alert('Run Check Activity first, then use retry.');
            return;
        }
        let ts = ctx.activityTimestamps;
        const cfgRetry = resolvePeriodConfigFromActivityContext(ctx);
        if (!ts && ctx.factionID && (ctx.periodConfig || ctx.periodMonths != null)) {
            const periodDays = cfgRetry.periodDays;
            const pastTs = Math.floor((Date.now() - (periodDays * 24 * 60 * 60 * 1000)) / 1000);
            ts = {
                nowTimestamp: Math.floor(Date.now() / 1000),
                pastTimestamp: pastTs,
                pastTimestampDay: Math.floor(pastTs / 86400) * 86400,
                dateKey: new Date().toISOString().split('T')[0],
                factionID: ctx.factionID,
                normalizedFactionId: normalizeBattleStatsFactionId(ctx.factionID),
                periodConfig: cfgRetry,
                cacheKeySegment: cfgRetry.cacheKeySegment,
                periodDays: cfgRetry.periodDays
            };
            ctx.activityTimestamps = ts;
        }
        if (!ts) {
            alert('Activity session expired. Run Check Activity again.');
            return;
        }
        const id = String(playerId);
        const { nowTimestamp, pastTimestamp, pastTimestampDay, dateKey, factionID } = ts;
        const fidRetry = normalizeBattleStatsFactionId(ts.normalizedFactionId ?? factionID);
        const cacheSeg = ts.cacheKeySegment || ts.periodConfig?.cacheKeySegment || String(ts.periodMonths ?? '3');
        const member = ctx.membersObject[id] || ctx.membersObject[playerId];
        const pastEff = getEffectiveActivityPastTimestamp(pastTimestamp, member);

        const requests = [
            {
                playerId: id,
                timestamp: nowTimestamp,
                url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${nowTimestamp}&key=${apiKey}`
            },
            {
                playerId: id,
                timestamp: pastEff,
                url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${pastEff}&key=${apiKey}`
            }
        ];

        const fetched = {};
        const ingest = (data, request) => {
            const timeplayed = extractTimeplayedFromPersonalstatsResponse(data);
            const pid = String(request.playerId);
            if (timeplayed === null) return;
            if (!fetched[pid]) fetched[pid] = {};
            fetched[pid][request.timestamp] = timeplayed;
        };

        const origHtml = buttonEl.innerHTML;
        buttonEl.disabled = true;
        buttonEl.textContent = '…';
        buttonEl.style.opacity = '0.7';

        try {
            await window.batchApiCallsWithRateLimit(requests, {
                onSuccess: (data, req) => ingest(data, req),
                onError: (err, req) => console.error('Activity retry:', req?.playerId, err)
            });

            const nowVal = fetched[id]?.[nowTimestamp];
            const pastVal = fetched[id]?.[pastEff];
            const hasC = typeof nowVal === 'number' && !isNaN(nowVal);
            const hasP = typeof pastVal === 'number' && !isNaN(pastVal);

            if (!hasC || !hasP) {
                buttonEl.disabled = false;
                buttonEl.innerHTML = origHtml;
                buttonEl.style.opacity = '';
                alert('Could not load both timeplayed snapshots for this player. Wait a moment and try again.');
                return;
            }

            const pastKeySuffix = `${fidRetry}_${cacheSeg}_${pastTimestampDay}`;
            const nowKeySuffix = `${fidRetry}_${dateKey}`;
            const pastMerged = { ...(getBattleStatsActivityCache(
                BATTLE_STATS_ACTIVITY_PAST_PREFIX,
                pastKeySuffix,
                BATTLE_STATS_ACTIVITY_PAST_TTL_MS
            ) || {}) };
            pastMerged[id] = { t: pastEff, v: pastVal };
            setBattleStatsActivityCache(BATTLE_STATS_ACTIVITY_PAST_PREFIX, pastKeySuffix, pastMerged);

            const nowMerged = { ...(getBattleStatsActivityCache(
                BATTLE_STATS_ACTIVITY_NOW_PREFIX,
                nowKeySuffix,
                BATTLE_STATS_ACTIVITY_NOW_TTL_MS
            ) || {}) };
            nowMerged[id] = nowVal;
            setBattleStatsActivityCache(BATTLE_STATS_ACTIVITY_NOW_PREFIX, nowKeySuffix, nowMerged);

            const diffSec = nowVal - pastVal;
            const hours = Math.max(0, diffSec) / 3600;
            ctx.activityHours[id] = hours;

            const resultsRoot = document.getElementById('battle-stats-results');
            const row = resultsRoot?.querySelector(`tr[data-player-id="${id}"]`);
            if (row) {
                const td = row.querySelector('td[data-column="activity"]');
                if (td) {
                    td.textContent = formatHoursMinutes(hours);
                    td.setAttribute('data-value', String(hours));
                }
            }

            createActivityGraph(
                ctx.sortedMemberIDs,
                ctx.membersObject,
                ctx.activityHours,
                null,
                resolvePeriodConfigFromActivityContext(ctx).labelTitle
            );

            const incomplete = ctx.sortedMemberIDs.filter(pid => ctx.activityHours[String(pid)] == null).length;
            window.battleStatsLastIncompleteActivityCount = incomplete;
            const notice = document.getElementById('activity-incomplete-notice');
            if (incomplete === 0) {
                notice?.remove();
            } else if (notice) {
                notice.innerHTML = `${incomplete} member(s) still show &quot;-&quot; after automatic retries — the API didn&apos;t return full timeplayed data for them. Use the <strong>↻</strong> button next to a dash to retry that member, or run <strong>Check Activity</strong> again.`;
            }
        } catch (e) {
            console.error('retryBattleStatsActivityForPlayer', e);
            buttonEl.disabled = false;
            buttonEl.innerHTML = origHtml;
            buttonEl.style.opacity = '';
            alert('Retry failed: ' + (e.message || e));
            return;
        }
    }

    if (!window._battleStatsActivityRetryDelegationBound) {
        window._battleStatsActivityRetryDelegationBound = true;
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.activity-retry-btn');
            if (!btn) return;
            const resultsRoot = document.getElementById('battle-stats-results');
            if (!resultsRoot || !resultsRoot.contains(btn)) return;
            e.preventDefault();
            e.stopPropagation();
            const pid = btn.getAttribute('data-player-id');
            if (pid) retryBattleStatsActivityForPlayer(pid, btn);
        });
    }

    // --- DETAILED STATS COLLECTION ---
    // Global cache for detailed stats to persist across view switches
    let detailedStatsCache = {};
    let detailedStatsCacheTimestamp = 0;
    const DETAILED_STATS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

    const handleDetailedStatsCollection = async (memberIDs, membersObject, ffScores, battleStatsEstimates, myTotalStats, factionName, factionID) => {
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
                displayDetailedStatsTable(detailedStatsCache[cacheKey], memberIDs, membersObject, ffScores, battleStatsEstimates, myTotalStats, factionName, factionID, 0, true);
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

            console.log(`Processing first batch of ${firstBatch.length} members immediately (90 instant calls)...`);
            updateProgress(0, totalMembers, 'Fetching first 90 members instantly...');
            
            // Process first batch - ALL AT ONCE (90 calls instantly)
            const firstBatchPromises = firstBatch.map(async (memberID) => {
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

            const firstBatchResults = await Promise.all(firstBatchPromises);
            firstBatchResults.forEach(result => {
                if (result.data) {
                    detailedStats[result.memberID] = result.data;
                }
            });

            processedCount = firstBatch.length;
            updateProgress(processedCount, totalMembers, `First ${firstBatch.length} members fetched!`);

            // Process remaining batch after 1 minute delay if needed
            if (remainingBatch.length > 0) {
                console.log(`Waiting 60 seconds before processing remaining ${remainingBatch.length} members...`);
                updateProgress(processedCount, totalMembers, `First batch completed. Waiting 60 seconds before processing remaining ${remainingBatch.length} members...`);
                
                // Update the loading message with countdown
                const progressDetails = document.querySelector('.progress-details');
                if (progressDetails) {
                    let secondsLeft = 60;
                    progressDetails.innerHTML = `
                        First batch completed. Waiting <span id="countdown">${secondsLeft}</span> seconds before processing remaining ${remainingBatch.length} members...
                        <br>
                        <small>This is required to respect Torn API rate limits.</small>
                    `;
                    
                    // Start countdown
                    const countdownInterval = setInterval(() => {
                        secondsLeft--;
                        const countdownEl = document.getElementById('countdown');
                        if (countdownEl) {
                            countdownEl.textContent = secondsLeft;
                        }
                        if (secondsLeft <= 0) {
                            clearInterval(countdownInterval);
                        }
                    }, 1000);
                }

                await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 60 seconds

                console.log(`Processing remaining batch of ${remainingBatch.length} members (1 per second)...`);
                updateProgress(processedCount, totalMembers, `Processing remaining ${remainingBatch.length} members...`);

                // Process remaining members ONE AT A TIME with 1 second delay
                for (let i = 0; i < remainingBatch.length; i++) {
                    const memberID = remainingBatch[i];
                    const cacheKey = `personalstats_${memberID}`;
                    const cached = getCachedData(cacheKey);
                    
                    if (cached) {
                        console.log(`Using cached data for member ${memberID}`);
                        detailedStats[memberID] = cached;
                    } else {
                        const url = `https://api.torn.com/user/${memberID}?selections=personalstats&key=${apiKey}`;
                        const response = await fetch(url);
                        const data = await response.json();
                        
                        if (data.error) {
                            console.error(`Error fetching stats for ${memberID}:`, data.error);
                        } else {
                            setCachedData(cacheKey, data);
                            detailedStats[memberID] = data;
                        }
                    }

                    // Update progress
                    processedCount++;
                    updateProgress(processedCount, totalMembers, `Processed ${processedCount} of ${totalMembers} players...`);

                    // Wait 1 second before next call (unless it's the last one)
                    if (i < remainingBatch.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }

            const totalTime = performance.now() - startTime;
            console.log(`Detailed stats collection completed in ${totalTime.toFixed(2)}ms`);

            // Cache the detailed stats
            detailedStatsCache[cacheKey] = detailedStats;
            detailedStatsCacheTimestamp = now;

            // Display the detailed stats table
            displayDetailedStatsTable(detailedStats, memberIDs, membersObject, ffScores, battleStatsEstimates, myTotalStats, factionName, factionID, totalTime, false);

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

    const displayDetailedStatsTable = (detailedStats, memberIDs, membersObject, ffScores, battleStatsEstimates, myTotalStats, factionName, factionID, totalTime, wasCached = false) => {
        const resultsContainer = document.getElementById('battle-stats-results');
        
        // Create table data
        const tableData = memberIDs.map(memberID => {
            const member = membersObject[memberID];
            const fairFightScore = ffScores[memberID] || 'Unknown';
            // Use FF Scouter's precise battle stats estimate instead of calculating
            const rawEstimatedStat = battleStatsEstimates[memberID] || 'N/A';
            
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
            <!-- Summary Section (NOT scrollable) -->
            <div style="margin-bottom: 20px;">
                <button id="exportDetailedCsvBtn" class="btn" style="background-color: #FFD700; color: #333; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">
                    Export Detailed Stats to CSV
                </button>
                <button id="backToOriginalBtn" class="btn" style="background-color: #6c757d; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: 10px;">
                    Back to Original View
                </button>
            </div>
            <h2 style="text-align: center; margin-bottom: 20px; color: var(--accent-color);">${factionName} - Detailed Stats</h2>
            
            <!-- Table Wrapper (SCROLLABLE) -->
            <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                <table id="detailedStatsTable" style="min-width: 900px;">
                    <thead>
                        <tr>
                            <th data-column="member" style="min-width: 220px; cursor: pointer; text-align: left;">Member <span class="sort-indicator"></span></th>
                            <th data-column="level" style="min-width: 80px; cursor: pointer; text-align: left;">Level <span class="sort-indicator"></span></th>
                            <th data-column="estimatedStats" style="min-width: 140px; cursor: pointer; text-align: left;">Estimated Stats <span class="sort-indicator">↓</span></th>
                            <th data-column="warHits" style="min-width: 110px; cursor: pointer; text-align: left;">War Hits <span class="sort-indicator"></span></th>
                            <th data-column="cansUsed" style="min-width: 110px; cursor: pointer; text-align: left;">Cans Used <span class="sort-indicator"></span></th>
                            <th data-column="xanaxUsed" style="min-width: 110px; cursor: pointer; text-align: left;">Xanax Used <span class="sort-indicator"></span></th>
                            <th data-column="networth" style="min-width: 140px; cursor: pointer; text-align: left;">Networth <span class="sort-indicator"></span></th>
                            <th data-column="biggestHit" style="min-width: 120px; cursor: pointer; text-align: left;">Biggest Hit <span class="sort-indicator"></span></th>
                            <th data-column="refills" style="min-width: 90px; cursor: pointer; text-align: left;">Refills <span class="sort-indicator"></span></th>
                        </tr>
                    </thead>
                    <tbody>`;

        tableData.forEach(stats => {
            const displayEstimatedStat = (stats.estimatedStats !== 'N/A') ? stats.estimatedStats.toLocaleString() : 'N/A';
            const displayNetworth = stats.networth.toLocaleString();
            const displayBiggestHit = stats.biggestHit.toLocaleString();

            tableHtml += `
                <tr>
                    <td data-column="member"><a href="https://www.torn.com/profiles.php?XID=${stats.memberID}" target="_blank" style="color: #FFD700; text-decoration: none;">${stats.name} [${stats.memberID}]</a></td>
                    <td data-column="level" data-value="${stats.level === 'Unknown' ? -1 : stats.level}">${stats.level}</td>
                    <td data-column="estimatedStats" data-value="${stats.estimatedStats === 'N/A' ? -1 : stats.estimatedStats}">${displayEstimatedStat}</td>
                    <td data-column="warHits" data-value="${stats.warHits}">${stats.warHits.toLocaleString()}</td>
                    <td data-column="cansUsed" data-value="${stats.cansUsed}">${stats.cansUsed.toLocaleString()}</td>
                    <td data-column="xanaxUsed" data-value="${stats.xanaxUsed}">${stats.xanaxUsed.toLocaleString()}</td>
                    <td data-column="networth" data-value="${stats.networth}">$${displayNetworth}</td>
                    <td data-column="biggestHit" data-value="${stats.biggestHit}">${displayBiggestHit}</td>
                    <td data-column="refills" data-value="${stats.refills}">${stats.refills.toLocaleString()}</td>
                </tr>`;
        });

        tableHtml += `
                    </tbody>
                </table>
            </div>`;

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

            // Filter out ongoing wars (end: 0) and slice to only include the number of wars requested
            const completedWars = allWarsArray.filter(war => war.end > 0);
            console.log(`Found ${completedWars.length} completed wars (filtered out ${allWarsArray.length - completedWars.length} ongoing wars).`);
            
            const warsToAnalyze = completedWars.slice(0, warCount);
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
            // Create date range labels for display
            const chainDateRangeLabel = startDate && endDate ? `(${startDate} to ${endDate})` : '';
            const warDateRangeLabel = startDate && endDate ? `(${startDate} to ${endDate})` : '';
            updateWarReportUI(memberStats, startTime, 'total-summary', chainDateRangeLabel, warDateRangeLabel, currentMembers, warsToAnalyze.length);

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

    // Global function to initialize date pickers with flatpickr
    window.initDatePickers = function(startDateId = 'startDate', endDateId = 'endDate', options = {}) {
        const defaultOptions = {
            dateFormat: "Y-m-d",
            locale: {
                firstDayOfWeek: 1
            },
            ...options
        };
        
        const startDateInput = document.getElementById(startDateId);
        const endDateInput = document.getElementById(endDateId);

        if (startDateInput && endDateInput) {
            // Check if flatpickr is available
            if (typeof flatpickr === 'undefined') {
                console.error('[DATE PICKERS] flatpickr is not loaded!');
                return null;
            }
            
            // Destroy existing instances if they exist
            if (startDateInput._flatpickr) {
                startDateInput._flatpickr.destroy();
            }
            if (endDateInput._flatpickr) {
                endDateInput._flatpickr.destroy();
            }
            
            // Change input type to text if it's date (flatpickr works better with text inputs)
            if (startDateInput.type === 'date') {
                startDateInput.type = 'text';
            }
            if (endDateInput.type === 'date') {
                endDateInput.type = 'text';
            }
            
            try {
                const startDatePicker = flatpickr(startDateInput, {
                    ...defaultOptions,
                    defaultDate: options.startDefaultDate || null
                });
                
                const endDatePicker = flatpickr(endDateInput, {
                    ...defaultOptions,
                    defaultDate: options.endDefaultDate || "today"
                });
                
                console.log('[DATE PICKERS] Date pickers initialized successfully');
                return { startDatePicker, endDatePicker };
            } catch (error) {
                console.error('[DATE PICKERS] Error initializing date pickers:', error);
                return null;
            }
        } else {
            console.warn('[DATE PICKERS] Date input elements not found:', {
                startDate: !!startDateInput,
                endDate: !!endDateInput
            });
            return null;
        }
    };
    
    function initWarChainReporter() {
        // Log tool usage
        if (window.logToolUsage) {
            window.logToolUsage('war-chain-reporter');
        }
        
        const fetchBtn = document.getElementById('fetchWarReports');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', handleWarReportFetch);
        }

        // Initialize date pickers using global function
        setTimeout(() => {
            window.initDatePickers('startDate', 'endDate', {
                endDefaultDate: "today"
            });
        }, 100);
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

    /** Unix seconds for sorting Last online (Torn faction members last_action; online/idle without ts → now). */
    function getMemberLastOnlineSortValue(member) {
        if (!member) return 0;
        const ts = member.lastActionTimestamp;
        if (ts != null && !isNaN(Number(ts))) return Number(ts);
        const st = (member.lastActionStatus || '').toLowerCase();
        if (st === 'online' || st === 'idle') return Math.floor(Date.now() / 1000);
        return 0;
    }

    /** Human-readable last online from v2 /faction/.../members last_action (same fields as War Dashboard). */
    function formatMemberLastOnlineDisplay(member) {
        if (!member) return 'N/A';
        const rel = (member.lastActionRelative || '').trim();
        if (rel) return rel;
        const ts = member.lastActionTimestamp;
        if (ts != null && !isNaN(Number(ts))) {
            return formatRelativeTime(Number(ts) * 1000);
        }
        const st = (member.lastActionStatus || '').trim();
        if (st) return st;
        return 'N/A';
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

            // Filter out ongoing wars (end: 0) and slice to only include the number of wars requested
            const completedWars = allWarsArray.filter(war => war.end > 0);
            console.log(`Found ${completedWars.length} completed wars (filtered out ${allWarsArray.length - completedWars.length} ongoing wars).`);
            
            const warsToAnalyze = completedWars.slice(0, warCount);
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

            // Fetch estimated battle stats from FF Scouter (same method as Faction Battle Stats)
            let battleStatsEstimates = {};
            const memberIDs = Object.keys(memberStats);
            if (memberIDs.length > 0) {
                try {
                    const ffScouterUrl = `https://ffscouter.com/api/v1/get-stats?key=${apiKey}&targets=`;
                    const ffData = await fetchInParallelChunks(ffScouterUrl, memberIDs, 200, 3, 1000);
                    ffData.forEach(player => {
                        if (player.bs_estimate != null) {
                            battleStatsEstimates[player.player_id] = player.bs_estimate;
                        }
                    });
                } catch (err) {
                    console.warn('War & Chain Reporter: Could not fetch estimated stats (FF Scouter):', err.message);
                }
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
            window.warReportBattleStatsEstimates = battleStatsEstimates;
            updateWarReportUI(memberStats, startTime, 'total-summary', chainDateRangeLabel, warDateRangeLabel, currentMembers, warsToAnalyze.length, battleStatsEstimates);

        } catch (error) {
            console.error('Failed to fetch war reports:', error);
            resultsSection.innerHTML = `<div class="error">Error: ${error.message}</div>`;
        } finally {
            loadingSpinner.style.display = 'none';
            fetchBtn.disabled = false;
        }
    }

    function updateWarReportUI(memberStats, startTime, activeTabId = 'total-summary', chainDateRangeLabel = '', warDateRangeLabel = '', currentMembers = new Set(), totalWars = 0, battleStatsEstimates = null) {
        console.log('Starting updateWarReportUI...');
        
        const resultsSection = document.querySelector('.results-section');
        const totalTime = performance.now() - startTime;
        const individualWars = window.individualWarsData || [];
        const estimates = battleStatsEstimates ?? window.warReportBattleStatsEstimates ?? {};
        const formatEstStats = (id) => {
            const raw = estimates[id] ?? estimates[String(id)];
            return (raw != null && raw !== '') ? Number(raw).toLocaleString() : 'N/A';
        };
        console.log('Individual wars data:', individualWars);
        console.log('Individual wars length:', individualWars.length);
        console.log('Member stats object:', memberStats);
        console.log('Member stats keys:', Object.keys(memberStats));

        // Convert memberStats object to array for sorting (include estStats for Est. Stats column sort)
        const membersArray = Object.entries(memberStats).map(([id, stats]) => ({
            id,
            name: stats.name,
            estStats: Number(estimates[id] ?? estimates[String(id)]) || -1,
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
        if (membersArray.length > 0) {
            console.log('First member data:', membersArray[0]);
        }

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
            console.log('Generating tabs for', individualWars.length, 'wars');
            const tabButtons = individualWars.map(war => `<button class="tab-button" data-tab="war-${war.id}">War vs. ${war.enemyFaction.name}</button>`).join('');
            console.log('Tab buttons HTML:', tabButtons);
            
            html += `
                <div class="war-tabs">
                    <div class="tab-buttons">
                        <button class="tab-button" data-tab="total-summary">Total Summary</button>
                        ${tabButtons}
                    </div>
                    <div class="tab-content">
                        <div class="tab-pane" id="total-summary">
                            <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                                <table id="membersTable" style="min-width: 900px;">
                                <thead>
                                    <tr>
                                        <th data-column="name" data-table-id="summary" rowspan="3" style="min-width: 140px; cursor: pointer;">Member <span class="sort-indicator">${summarySort.column === 'name' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                                        <th data-column="estStats" data-table-id="summary" rowspan="3" style="min-width: 100px; cursor: pointer;">Est. Stats <span class="sort-indicator">${summarySort.column === 'estStats' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
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
                                            <td>${formatEstStats(m.id)}</td>
                                            <td>${m.chains.total}</td><td>${m.chains.assists}</td><td>${m.chains.retaliations}</td><td>${m.chains.overseas}</td><td>${m.chains.war}</td>
                                            <td style="border-left: 2px solid var(--accent-color);">${m.wars.total}</td><td>${Math.round(m.wars.points)}</td>
                                        </tr>
                                    `}).join('')}
                                </tbody>
                                <tfoot>
                                    <tr class="totals-row">
                                        <td><strong>TOTALS</strong></td>
                                        <td></td>
                                        <td><strong>${totals.chains.total}</strong></td><td><strong>${totals.chains.assists}</strong></td><td><strong>${totals.chains.retaliations}</strong></td><td><strong>${totals.chains.overseas}</strong></td><td><strong>${totals.chains.war}</strong></td>
                                        <td style="border-left: 2px solid var(--accent-color);"><strong>${totals.wars.total}</strong></td><td><strong>${Math.round(totals.wars.points)}</strong></td>
                                    </tr>
                                </tfoot>
                                </table>
                            </div>
                        </div>
                        ${individualWars.map(war => {
                            const tableId = `war-${war.id}`;
                            // Initialize sort state for this war tab if it doesn't exist
                            if (!warReportSortState[tableId]) {
                                warReportSortState[tableId] = { column: 'points', direction: 'desc' };
                            }
                            const warSort = warReportSortState[tableId];
                            const sortedMembers = Object.entries(war.memberStats || {}).sort(([idA, a],[idB, b]) => {
                                let aValue, bValue;
                                if (warSort.column === 'eststats') {
                                    aValue = estimates[idA] ?? estimates[String(idA)] ?? -1;
                                    bValue = estimates[idB] ?? estimates[String(idB)] ?? -1;
                                } else {
                                    aValue = getNestedValue(a, warSort.column);
                                    bValue = getNestedValue(b, warSort.column);
                                }
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
                                <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                                    <table class="war-table" style="min-width: 800px;">
                                    <thead>
                                        <tr>
                                            <th data-column="name" data-table-id="${tableId}" style="min-width: 140px; cursor: pointer;">Member <span class="sort-indicator">${warSort.column === 'name' ? (warSort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                                            <th data-column="eststats" data-table-id="${tableId}" style="min-width: 100px; cursor: pointer;">Est. Stats <span class="sort-indicator">${warSort.column === 'eststats' ? (warSort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
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
                                                    <td>${formatEstStats(id)}</td>
                                                    <td>${m.level || 'N/A'}</td>
                                                    <td>${Math.round(m.points || 0)}</td>
                                                    <td>${m.attacks || 0}</td>
                                                </tr>
                                            `;
                                        }).join('')}
                                    </tbody>
                                    </table>
                                </div>
                            </div>
                        `}).join('')}
                    </div>
                </div>
            `;
        } else {
            // Fallback to single table if no individual wars
            html += `
                <div class="table-scroll-wrapper" style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                    <table id="membersTable" style="min-width: 900px;">
                    <thead>
                        <tr>
                            <th data-column="name" data-table-id="summary" rowspan="3" style="min-width: 140px; cursor: pointer;">Member <span class="sort-indicator">${summarySort.column === 'name' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
                            <th data-column="estStats" data-table-id="summary" rowspan="3" style="min-width: 100px; cursor: pointer;">Est. Stats <span class="sort-indicator">${summarySort.column === 'estStats' ? (summarySort.direction === 'asc' ? '↑' : '↓') : ''}</span></th>
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
                                <td>${formatEstStats(m.id)}</td>
                                <td>${m.chains.total}</td><td>${m.chains.assists}</td><td>${m.chains.retaliations}</td><td>${m.chains.overseas}</td><td>${m.chains.war}</td>
                                <td style="border-left: 2px solid var(--accent-color);">${m.wars.total}</td><td>${Math.round(m.wars.points)}</td>
                            </tr>
                        `}).join('')}
                    </tbody>
                    <tfoot>
                        <tr class="totals-row">
                            <td><strong>TOTALS</strong></td>
                            <td></td>
                            <td><strong>${totals.chains.total}</strong></td><td><strong>${totals.chains.assists}</strong></td><td><strong>${totals.chains.retaliations}</strong></td><td><strong>${totals.chains.overseas}</strong></td><td><strong>${totals.chains.war}</strong></td>
                            <td style="border-left: 2px solid var(--accent-color);"><strong>${totals.wars.total}</strong></td><td><strong>${Math.round(totals.wars.points)}</strong></td>
                        </tr>
                    </tfoot>
                    </table>
                </div>
            `;
        }

        console.log('Generated HTML length:', html.length);
        console.log('Results section element:', resultsSection);
        console.log('Setting innerHTML...');
        resultsSection.innerHTML = html;
        resultsSection.style.display = 'block';
        
        
        // Small delay to ensure DOM is updated before tab activation
        setTimeout(() => {
            console.log('Activating tab:', activeTabId);
            const tabButton = document.querySelector(`.tab-button[data-tab="${activeTabId}"]`);
            const tabPane = document.querySelector(`.tab-pane#${activeTabId}`);
            console.log('Tab button found:', tabButton);
            console.log('Tab pane found:', tabPane);
            
            if (tabButton) tabButton.classList.add('active');
            if (tabPane) tabPane.classList.add('active');
        }, 10);

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
                updateWarReportUI(memberStats, startTime, activeTabId, chainDateRangeLabel, warDateRangeLabel, currentMembers, totalWars, window.warReportBattleStatsEstimates);
            });
        });
        
        console.log('updateWarReportUI completed');
    }
    
    // ==================== MOBILE NAVIGATION TOGGLE ====================
    const mobileNavToggle = document.getElementById('mobileNavToggle');
    const mainNav = document.getElementById('mainNav');
    
    if (mobileNavToggle && mainNav) {
        // Toggle navigation menu
        mobileNavToggle.addEventListener('click', () => {
            mainNav.classList.toggle('mobile-active');
            
            // Update button text
            if (mainNav.classList.contains('mobile-active')) {
                mobileNavToggle.textContent = '✕';
            } else {
                mobileNavToggle.textContent = '☰';
            }
        });
        
        // Close navigation when clicking on a nav link (on mobile)
        const navLinks = mainNav.querySelectorAll('.nav-link');
        navLinks.forEach(link => {
            link.addEventListener('click', () => {
                if (window.innerWidth <= 768) {
                    mainNav.classList.remove('mobile-active');
                    mobileNavToggle.textContent = '☰';
                }
            });
        });
        
        // Close navigation when clicking outside (on mobile)
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 && 
                mainNav.classList.contains('mobile-active') &&
                !mainNav.contains(e.target) && 
                !mobileNavToggle.contains(e.target)) {
                mainNav.classList.remove('mobile-active');
                mobileNavToggle.textContent = '☰';
            }
        });
    }
});