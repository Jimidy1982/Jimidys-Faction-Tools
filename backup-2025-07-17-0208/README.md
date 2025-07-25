# Jimidy's Faction Tools

A comprehensive web-based suite of tools for Torn faction management and analysis, built with modern JavaScript and optimized for performance.

## 🎯 Current Tools

### ✅ **War Payout Calculator (2.0)**
Advanced war payout calculation tool with hit-based calculations and enhanced features.

**Features:**
- **Hit-based payout calculations** with customizable pay-per-hit rates
- **Advanced payout options** with multipliers and bonuses
- **Systematic "Open All Links"** - Opens all payment links in background tabs
- **Popup blocker warnings** for better user experience
- **CSV export** with complete payout data
- **Real-time calculations** that update as you modify settings
- **Thousand separators** for better number readability
- **Accurate enemy faction detection** in all summaries

### ✅ **War Chain Reporter**
Comprehensive war and chain analysis tool for detailed faction performance tracking.

**Features:**
- **War report analysis** with detailed statistics
- **Chain report processing** for attack chain data
- **Member performance tracking** across multiple wars
- **Data export capabilities** for further analysis
- **Real-time API integration** with Torn's war data

### ✅ **Faction Battle Stats**
Statistical analysis tool for faction member performance and battle statistics.

**Features:**
- **Member stat estimation** based on Fair Fight scores
- **Performance analytics** and trend analysis
- **Data visualization** and reporting
- **Export functionality** for external analysis

### ⚠️ **Consumption Tracker** *(Currently Disabled)*
*This tool has been temporarily disabled due to Torn API changes. It will be restored when the API issues are resolved.*

## 🚀 Key Features

### **Modern UI/UX**
- **Dark theme** matching Torn's aesthetic
- **Responsive design** that works on all devices
- **Intuitive navigation** with clear tool organization
- **Real-time feedback** and loading indicators

### **Performance Optimizations**
- **Efficient API calls** with intelligent batching
- **Smart caching** to reduce redundant requests
- **Parallel processing** for faster data retrieval
- **Rate limit handling** to respect Torn's API guidelines

### **Data Management**
- **Local API key storage** for convenience
- **CSV export** for all major tools
- **Real-time calculations** and updates
- **Comprehensive error handling**

## 🛠️ How to Use

### **Getting Started**
1. Open `index.html` in your web browser
2. Enter your Torn API key in the sidebar
3. Select a tool from the navigation menu
4. Configure your parameters and click "Fetch Data"

### **API Key Security**
- Your API key is stored locally in your browser's localStorage
- It is never sent to any server other than Torn's API
- You can clear the saved API key by clearing your browser's localStorage

### **War Payout Calculator**
1. Enter your faction ID and war ID
2. Set your pay-per-hit rate
3. Configure any advanced payout options
4. Click "Fetch War Data" to load the war information
5. Review the payout table and use "Open All Links" to send payments
6. Export to CSV for record keeping

### **War Chain Reporter**
1. Enter your faction ID and war ID
2. Click "Fetch War Data" to load war and chain information
3. Review detailed statistics and performance metrics
4. Export data for further analysis

### **Faction Battle Stats**
1. Enter your faction ID
2. Configure date ranges and parameters
3. Click "Fetch Data" to analyze member statistics
4. Review performance metrics and trends

## 📋 Requirements

- **Modern web browser** with JavaScript enabled
- **Valid Torn API key** with appropriate permissions
- **Internet connection** to access Torn's API
- **Local web server** (recommended for development)

## 🔧 Technical Details

### **Architecture**
- **Vanilla JavaScript** for maximum compatibility
- **Modular design** with separate tool components
- **Responsive CSS** with modern styling
- **Local storage** for user preferences

### **API Integration**
- **Torn API v1** integration for all data sources
- **Rate limiting** to respect API guidelines
- **Error handling** for robust operation
- **Caching strategies** for optimal performance

### **Browser Compatibility**
- **Chrome/Edge** (recommended)
- **Firefox** (fully supported)
- **Safari** (fully supported)
- **Mobile browsers** (responsive design)

## 🐛 Known Issues

- **Consumption Tracker**: Temporarily disabled due to Torn API changes
- **Popup blockers**: May interfere with "Open All Links" functionality (warning provided)

## 📝 Development

### **Local Development**
1. Clone or download the repository
2. Start a local web server (Python: `python -m http.server 8000`)
3. Open `http://localhost:8000` in your browser
4. Make changes and refresh to see updates

### **File Structure**
```
├── index.html              # Main application entry point
├── app.js                  # Core application logic
├── styles/
│   └── styles.css         # Main stylesheet
├── pages/                 # Tool-specific HTML pages
│   ├── home.html
│   ├── war-report-2.0.html
│   ├── war-chain-reporter.html
│   └── faction-battle-stats.html
└── tools/                 # Tool-specific JavaScript
    └── war-report-2.0/
        └── war-report.js  # War Payout Calculator logic
```

## 🤝 Contributing

This is a personal project, but suggestions and feedback are welcome. The tools are designed to be modular and extensible for future enhancements.

## 📄 License

This project is for personal use and Torn faction management. Please respect Torn's terms of service and API usage guidelines.

## 🔗 Links

- **Live Site**: [https://jimidy1982.github.io/Jimidys-Faction-Tools/](https://jimidy1982.github.io/Jimidys-Faction-Tools/)
- **GitHub Repository**: [https://github.com/Jimidy1982/Jimidys-Faction-Tools](https://github.com/Jimidy1982/Jimidys-Faction-Tools)

---

*Built for Torn faction leaders and managers who need powerful, efficient tools for faction administration and analysis.* 