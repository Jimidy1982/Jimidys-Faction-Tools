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

// Load saved API key from localStorage
document.addEventListener('DOMContentLoaded', () => {
    const savedApiKey = localStorage.getItem('tornApiKey');
    if (savedApiKey) {
        document.getElementById('apiKey').value = savedApiKey;
    }
});

// Save API key to localStorage
document.getElementById('saveApiKey').addEventListener('click', () => {
    const apiKey = document.getElementById('apiKey').value;
    if (apiKey) {
        localStorage.setItem('tornApiKey', apiKey);
        alert('API key saved successfully!');
    }
});

// Fetch data from Torn API v2 faction/news with pagination
document.getElementById('fetchData').addEventListener('click', async () => {
    let apiKey = document.getElementById('apiKey').value;
    // Use the example key if the box is empty
    if (!apiKey) {
        apiKey = 'e9Tn2r2RAIoaVWWd';
        document.getElementById('apiKey').value = apiKey;
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
    const endEpoch = Math.floor(end.getTime() / 1000) + 86399; // include full end day

    try {
        let allNews = [];
        let url = `https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&cat=armoryAction&timestamp=${endEpoch}&key=${apiKey}`;
        let keepFetching = true;

        while (keepFetching && url) {
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
        console.log('All news entries in range:', allNews);

        // Filter for Xanax usage
        const xanaxLogs = allNews.filter(entry => entry.text && entry.text.toLowerCase().includes('xanax'));
        console.log('Filtered Xanax logs:', xanaxLogs);

        // Aggregate by member
        const memberXanax = {};
        xanaxLogs.forEach(entry => {
            // Extract member name from text string (e.g., "Meliz used one of the faction's Xanax items")
            const match = entry.text.match(/^(.*?) used/i);
            const name = match ? match[1].trim() : 'Unknown';
            if (!memberXanax[name]) memberXanax[name] = 0;
            memberXanax[name]++;
        });
        console.log('Aggregated member Xanax usage:', memberXanax);

        // Prepare members array for display
        const members = Object.entries(memberXanax).map(([name, xanax]) => ({
            name,
            xanax
        }));

        // Sort members by Xanax consumption
        const sortOrder = document.getElementById('sortOrder').value;
        members.sort((a, b) => {
            return sortOrder === 'highToLow' ? b.xanax - a.xanax : a.xanax - b.xanax;
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
    }
});

// Update UI with member data
function updateUI(members) {
    const totalXanax = members.reduce((sum, member) => sum + member.xanax, 0);
    
    // Update summary
    document.querySelector('#totalXanax span').textContent = totalXanax;
    document.querySelector('#totalMembers span').textContent = members.length;

    // Update members table
    const table = document.createElement('table');
    table.innerHTML = `
        <thead>
            <tr>
                <th>Member</th>
                <th>Xanax Consumed</th>
            </tr>
        </thead>
        <tbody>
            ${members.map(member => `
                <tr>
                    <td>${member.name}</td>
                    <td>${member.xanax}</td>
                </tr>
            `).join('')}
        </tbody>
    `;

    const tableContainer = document.getElementById('membersTable');
    tableContainer.innerHTML = '';
    tableContainer.appendChild(table);
}

// Export to CSV
document.getElementById('exportCSV').addEventListener('click', () => {
    const table = document.querySelector('#membersTable table');
    if (!table) {
        alert('No data to export');
        return;
    }

    const rows = Array.from(table.querySelectorAll('tr'));
    const csvContent = rows.map(row => {
        return Array.from(row.cells)
            .map(cell => `"${cell.textContent}"`)
            .join(',');
    }).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', 'xanax_consumption.csv');
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