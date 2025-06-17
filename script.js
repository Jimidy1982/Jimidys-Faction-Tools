// Initialize date pickers
flatpickr("#startDate", {
    dateFormat: "Y-m-d",
    maxDate: "today",
    defaultDate: new Date()
});

flatpickr("#endDate", {
    dateFormat: "Y-m-d",
    maxDate: "today",
    defaultDate: new Date()
});

// Fetch data from Torn API v2 faction/news with pagination
document.getElementById('fetchData').addEventListener('click', async () => {
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

    // Validate dates
    const today = new Date();
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start > today || end > today) {
        alert('Dates cannot be in the future.');
        return;
    }
    if (start > end) {
        alert('Start date cannot be after end date.');
        return;
    }

    // Convert to epoch seconds
    const startEpoch = Math.floor(start.getTime() / 1000);
    const endEpoch = Math.floor(end.getTime() / 1000) + 86399;

    try {
        let allNews = [];
        let url = `https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&cat=armoryAction&timestamp=${endEpoch}&key=${apiKey}`;
        let keepFetching = true;

        // Show loading bar
        const loadingBar = document.getElementById('loadingBar');
        loadingBar.style.display = 'block';

        while (keepFetching && url) {
            // Rate limiting - wait 1 second between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const response = await fetch(url);
            const data = await response.json();
            if (data.error) {
                throw new Error(data.error.error || data.error);
            }
            const news = data.news || [];
            // Stop if no news returned
            if (news.length === 0) break;
            // Filter for news within the date range
            const filtered = news.filter(entry => entry.timestamp >= startEpoch && entry.timestamp <= endEpoch);
            allNews = allNews.concat(filtered);
            // If the oldest entry is still within the range, paginate
            const oldest = news[news.length - 1];
            if (oldest && oldest.timestamp > startEpoch && data._metadata && data._metadata.links && data._metadata.links.prev) {
                url = data._metadata.links.prev + `&key=${apiKey}`;
            } else {
                keepFetching = false;
            }
        }

        // Hide loading bar
        loadingBar.style.display = 'none';

        // Filter for all item usage
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

        // Aggregate by member for all items
        const memberItems = {};
        Object.keys(itemLogs).forEach(item => {
            itemLogs[item].forEach(entry => {
                const match = entry.text.match(/^(.*?) used/i);
                const name = match ? match[1].trim() : 'Unknown';
                if (!memberItems[name]) memberItems[name] = {};
                if (!memberItems[name][item]) memberItems[name][item] = 0;
                memberItems[name][item]++;
            });
        });

        // Prepare members array for display
        const allNames = new Set(Object.keys(memberItems));
        const members = Array.from(allNames).map(name => ({
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

        // Get sort column and direction
        const sortColumn = document.getElementById('sortColumn').value;
        const sortDirection = document.getElementById('sortDirection').value;
        
        // Sort members
        members.sort((a, b) => {
            const aValue = a[sortColumn] || 0;
            const bValue = b[sortColumn] || 0;
            return sortDirection === 'desc' ? bValue - aValue : aValue - bValue;
        });

        // Update UI
        updateUI(members);

    } catch (error) {
        console.error('Error during fetchData:', error);
        let message = error.message;
        if (error && error.response && error.response.error) {
            message = error.response.error;
        }
        alert('Error: ' + message);
        // Hide loading bar on error
        document.getElementById('loadingBar').style.display = 'none';
    }
});

// Function to update loading bar
function updateLoadingBar(completed, total) {
    const percentage = Math.round((completed / total) * 100);
    const loadingProgress = document.querySelector('.loading-progress');
    const progressText = document.querySelector('.progress-text');
    loadingProgress.style.width = `${percentage}%`;
    progressText.textContent = `${percentage}%`;
}

// Update UI with member data
function updateUI(members) {
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

    // Calculate totals
    const totals = {};
    columns.forEach(col => {
        totals[col.id] = members.reduce((sum, member) => sum + (member[col.id] || 0), 0);
    });

    // Create column visibility controls
    const columnControls = document.createElement('div');
    columnControls.className = 'column-controls';
    columnControls.innerHTML = `
        <h3>Visible Columns:</h3>
        <div class="column-toggles">
            ${columns.map(col => `
                <label>
                    <input type="checkbox" class="column-toggle" data-column="${col.id}" checked>
                    ${col.label}
                </label>
            `).join('')}
        </div>
    `;

    // Create table with totals row
    const table = document.createElement('table');
    table.innerHTML = `
        <thead>
            <tr>
                <th>Member</th>
                ${columns.map(col => `
                    <th class="column-${col.id}" data-column="${col.id}">
                        ${col.label}
                        <span class="sort-indicator"></span>
                    </th>
                `).join('')}
            </tr>
            <tr class="totals-row">
                <th>Faction Total</th>
                ${columns.map(col => `
                    <th class="column-${col.id}" data-column="${col.id}">${totals[col.id]}</th>
                `).join('')}
            </tr>
        </thead>
        <tbody>
            ${members.map(member => `
                <tr>
                    <td><a href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(member.name)}" target="_blank">${member.name}</a></td>
                    ${columns.map(col => `
                        <td class="column-${col.id}" data-column="${col.id}">${member[col.id] || 0}</td>
                    `).join('')}
                </tr>
            `).join('')}
        </tbody>
    `;

    const tableContainer = document.getElementById('membersTable');
    tableContainer.innerHTML = '';
    tableContainer.appendChild(columnControls);
    tableContainer.appendChild(table);

    // Add click handlers for column sorting
    table.querySelectorAll('th[data-column]').forEach(th => {
        th.addEventListener('click', () => {
            const column = th.dataset.column;
            const currentDirection = document.getElementById('sortDirection').value;
            const newDirection = currentDirection === 'asc' ? 'desc' : 'asc';
            
            document.getElementById('sortColumn').value = column;
            document.getElementById('sortDirection').value = newDirection;
            
            // Update sort indicators
            table.querySelectorAll('.sort-indicator').forEach(indicator => {
                indicator.textContent = '';
            });
            th.querySelector('.sort-indicator').textContent = newDirection === 'asc' ? ' ↑' : ' ↓';
            
            // Trigger data refresh
            document.getElementById('fetchData').click();
        });
    });

    // Add column visibility toggles
    tableContainer.querySelectorAll('.column-toggle').forEach(toggle => {
        toggle.addEventListener('change', () => {
            const column = toggle.dataset.column;
            const isVisible = toggle.checked;
            
            table.querySelectorAll(`.column-${column}`).forEach(cell => {
                cell.style.display = isVisible ? '' : 'none';
            });
        });
    });
}

// Export to CSV
document.getElementById('exportCSV').addEventListener('click', () => {
    const table = document.querySelector('#membersTable table');
    if (!table) {
        alert('No data to export');
        return;
    }

    const rows = Array.from(table.querySelectorAll('tr'));
    const headers = Array.from(rows[0].querySelectorAll('th')).map(th => th.textContent.trim().replace(' ↑', '').replace(' ↓', ''));
    const csvContent = [
        headers.join(','),
        ...rows.slice(1).map(row => {
            return Array.from(row.cells)
                .map(cell => {
                    const content = cell.textContent.trim();
                    return `"${content}"`;
                })
                .join(',');
        })
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', 'faction_consumption.csv');
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

// Sort order change handler
document.getElementById('sortOrder').addEventListener('change', () => {
    const fetchButton = document.getElementById('fetchData');
    if (fetchButton) {
        fetchButton.click();
    }
}); 