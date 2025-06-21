document.addEventListener('DOMContentLoaded', () => {
    const appContent = document.getElementById('app-content');

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

        const apiKeyInput = document.getElementById('apiKey');
        if (apiKeyInput) {
            apiKeyInput.value = localStorage.getItem('tornApiKey') || '';
            apiKeyInput.addEventListener('change', (e) => localStorage.setItem('tornApiKey', e.target.value));
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

        const spinner = document.getElementById('loading-spinner');
        const resultsContainer = document.getElementById('battle-stats-results');
        const toolContainer = document.getElementById('battle-stats-tool-container');
        const apiKeyInput = document.getElementById('apiKey');
        const factionIdInput = document.getElementById('factionId');

        if (!apiKeyInput || !factionIdInput || !spinner || !resultsContainer || !toolContainer) {
            console.error("One or more required elements are missing from the page.");
            return;
        }

        const apiKey = apiKeyInput.value.trim();
        const factionID = factionIdInput.value.trim();
        if (!apiKey || !factionID) {
            alert('Please enter your API key and a Faction ID.');
            return;
        }

        console.log(`Using Faction ID: ${factionID}`);

        spinner.style.display = 'block';
        resultsContainer.style.display = 'none';
        // toolContainer.style.display = 'none'; // Keep input fields visible

        try {
            const userUrl = `https://api.torn.com/user/?selections=personalstats&key=${apiKey}`;
            console.log(`Fetching user stats from: ${userUrl}`);
            const userResponse = await fetch(userUrl);
            const userData = await userResponse.json();
            console.log('User stats response:', userData);
            if (userData.error) throw new Error(`Torn API Error (User Stats): ${userData.error.error}`);
            const myTotalStats = userData.personalstats.totalstats;
            console.log(`Successfully fetched user total stats.`);

            const factionUrl = `https://api.torn.com/faction/${factionID}?selections=basic&key=${apiKey}`;
            console.log(`Fetching faction members from: ${factionUrl}`);
            const factionResponse = await fetch(factionUrl);
            const factionData = await factionResponse.json();
            console.log('Faction members response:', factionData);
            if (factionData.error) throw new Error(`Torn API Error (Faction Members): ${factionData.error.error}`);
            
            const memberIDs = Object.keys(factionData.members);
            const membersObject = factionData.members; // Keep the original object for name lookup
            const factionName = factionData.name;
            
            console.log(`Successfully fetched ${memberIDs.length} members.`);

            const ffScouterUrl = `https://ffscouter.com/api/v1/get-stats?key=${apiKey}&targets=`;
            console.log(`Fetching FF Scouter data for ${memberIDs.length} members...`);
            const ffData = await fetchInChunks(ffScouterUrl, memberIDs, 200);

            const ffScores = {};
            ffData.forEach(player => {
                if (player.fair_fight) {
                    ffScores[player.player_id] = player.fair_fight;
                }
            });

            // Hide the form and show the results section
            // toolContainer.style.display = 'none'; // Don't hide the input fields

            let tableHtml = `
                <div style="margin-bottom: 20px;">
                    <button id="exportCsvBtn" class="btn" style="background-color: #FFD700; color: #333; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">
                        Export to CSV
                    </button>
                </div>
                <h2 style="text-align: center; margin-bottom: 20px; color: var(--accent-color);">${factionName}</h2>
                <table id="membersTable">
                    <thead>
                        <tr>
                            <th data-column="member" style="min-width: 200px; cursor: pointer; text-align: left;">Member <span class="sort-indicator"></span></th>
                            <th data-column="ffscore" style="min-width: 100px; cursor: pointer; text-align: left;">FF Score <span class="sort-indicator"></span></th>
                            <th data-column="stats" style="min-width: 150px; cursor: pointer; text-align: left;">Estimated Stats <span class="sort-indicator"></span></th>
                        </tr>
                    </thead>
                    <tbody>`;
            for (const memberID of memberIDs) {
                const member = membersObject[memberID];
                const fairFightScore = ffScores[memberID] || 'Unknown';

                const rawEstimatedStat = (fairFightScore !== 'Unknown' && fairFightScore > 0)
                    ? calculateStat(myTotalStats, fairFightScore)
                    : 'N/A';
                const displayEstimatedStat = (rawEstimatedStat !== 'N/A') ? rawEstimatedStat.toLocaleString() : 'N/A';
                
                tableHtml += `
                    <tr>
                        <td data-column="member"><a href="https://www.torn.com/profiles.php?XID=${memberID}" target="_blank" style="color: #FFD700; text-decoration: none;">${member.name} [${memberID}]</a></td>
                        <td data-column="ffscore" data-value="${fairFightScore === 'Unknown' ? -1 : fairFightScore}">${fairFightScore}</td>
                        <td data-column="stats" data-value="${rawEstimatedStat === 'N/A' ? -1 : rawEstimatedStat}">${displayEstimatedStat}</td>
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
                            if (isNaN(aNum)) aNum = aValue;
                            if (isNaN(bNum)) bNum = bValue;
                            return currentSortDirection === 'desc' ? bNum - aNum : aNum - bNum;
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
    let fetchedMembers = []; // Store globally for sorting

    function initConsumptionTracker() {
        flatpickr("#startDate", { dateFormat: "Y-m-d", maxDate: "today", defaultDate: new Date() });
        flatpickr("#endDate", { dateFormat: "Y-m-d", maxDate: "today", defaultDate: new Date() });
        const apiKeyInput = document.getElementById('apiKey');
        if (apiKeyInput) {
            apiKeyInput.value = localStorage.getItem('tornApiKey') || '';
            apiKeyInput.addEventListener('change', (e) => localStorage.setItem('tornApiKey', e.target.value));
        }
    }

    const handleConsumptionFetch = async () => {
        let apiKey = document.getElementById('apiKey').value;
        if (!apiKey) {
            alert('Please enter your API key');
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

        const loadingBar = document.getElementById('loadingBar');
        loadingBar.style.display = 'block';

        try {
            let allNews = [];
            let url = `https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&cat=armoryAction&timestamp=${endEpoch}&key=${apiKey}`;
            let keepFetching = true;

            while (keepFetching && url) {
                await new Promise(resolve => setTimeout(resolve, 1000));
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
            
            const sortColumn = document.getElementById('sortColumn').value;
            const sortDirection = document.getElementById('sortDirection').value;
            const sortedMembers = sortConsumptionMembers(fetchedMembers, sortColumn, sortDirection);
            updateConsumptionUI(sortedMembers);

        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            loadingBar.style.display = 'none';
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

    function updateConsumptionUI(members) {
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
        tableContainer.appendChild(columnControls);
        tableContainer.appendChild(table);
        toggleColumnVisibility();
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