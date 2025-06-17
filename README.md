# Torn Faction Xanax Consumption Tracker

A web-based tool to track Xanax consumption within your Torn faction.

## Features

- Track Xanax consumption for all faction members
- Sort members by consumption (highest to lowest or lowest to highest)
- Export data to CSV
- Save API key locally for convenience
- Date range selection with calendar picker
- Dark theme matching Torn's style

## How to Use

1. Open `index.html` in your web browser
2. Enter your Torn API key (you can get this from your Torn account settings)
3. Click "Save API Key" to store it locally (optional)
4. Select a date range using the date pickers
5. Click "Fetch Data" to retrieve the consumption data
6. Use the sort dropdown to change the order of members
7. Click "Export to CSV" to download the data

## API Key Security

- Your API key is stored locally in your browser's localStorage
- It is never sent to any server other than Torn's API
- You can clear the saved API key by clearing your browser's localStorage

## Requirements

- Modern web browser with JavaScript enabled
- Valid Torn API key with appropriate permissions
- Internet connection to access Torn's API

## Note

This tool uses Torn's public API. Please respect Torn's API usage guidelines and rate limits. 