// Sheet names
const TOOL_USAGE_SHEET_NAME = 'Tool Usage'; // Rename your "Sheet1" tab to "Tool Usage" or change this to match your tab name
const VIP_BALANCES_SHEET_NAME = 'VIP Balances';
const VIP_TRANSACTIONS_SHEET_NAME = 'VIP Transactions';

function doPost(e) {
  try {
    let data = {};
    let action = null;
    
    // Try to parse JSON body
    if (e.postData && e.postData.contents) {
      try {
        data = JSON.parse(e.postData.contents);
        action = data.action;
      } catch (parseError) {
        // If JSON parsing fails, data might be in form format
        data = e.parameter;
        action = data.action;
      }
    } else {
      // No postData, try parameters
      data = e.parameter;
      action = data.action;
    }
    
    // Check for VIP-specific fields to identify VIP requests
    // VIP balance updates have: totalXanaxSent, currentBalance, vipLevel
    // VIP transactions have: transactionType, balanceAfter
    const hasVipBalanceFields = (data.totalXanaxSent !== undefined && data.totalXanaxSent !== null) || 
                                  (data.currentBalance !== undefined && data.currentBalance !== null) || 
                                  (data.vipLevel !== undefined && data.vipLevel !== null) ||
                                  (typeof data.totalXanaxSent === 'number') ||
                                  (typeof data.currentBalance === 'number') ||
                                  (typeof data.vipLevel === 'number');
    
    const hasVipTransactionFields = (data.transactionType !== undefined && data.transactionType !== null) || 
                                     (data.balanceAfter !== undefined && data.balanceAfter !== null) ||
                                     (data.transactionType === 'Sent' || data.transactionType === 'Deduction') ||
                                     (typeof data.balanceAfter === 'number');
    
    // Handle VIP balance updates FIRST (before tool usage)
    if (action === 'updateVipBalance') {
      return updateVipBalance(data);
    }
    
    // Handle VIP transaction logging
    if (action === 'logVipTransaction') {
      return logVipTransaction(data);
    }
    
    // Fallback: Check for VIP fields if action wasn't set
    if (hasVipBalanceFields) {
      return updateVipBalance(data);
    }
    
    if (hasVipTransactionFields) {
      return logVipTransaction(data);
    }
    
    // Handle tool usage logging (existing functionality)
    // ONLY route here if it's NOT a VIP action
    const hasToolUsageFields = (data.tool !== undefined && data.tool !== null) || 
                                (data.userName !== undefined && data.userName !== null);
    
    // Only route to tool usage if it's NOT a VIP action
    if (hasToolUsageFields && action !== 'updateVipBalance' && action !== 'logVipTransaction') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(TOOL_USAGE_SHEET_NAME);
      
      // If sheet doesn't exist, use active sheet (backward compatibility)
      if (!sheet) {
        sheet = SpreadsheetApp.getActiveSheet();
      }
      
      // Add the new row
      sheet.appendRow([
        data.timestamp,
        data.userName,
        data.playerId,
        data.profileUrl,
        data.factionName,
        data.factionId,
        data.tool,
        data.apiKey
      ]);
      
      // Return success response
      return ContentService
        .createTextOutput(JSON.stringify({success: true}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Unknown action or data format
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'Unknown action or data format. Action: ' + (action || 'none')}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    // Return error response
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    
    // Test function to verify sheets
    if (action === 'testSheets') {
      return testSheets();
    }
    
    // Handle VIP balance lookup
    if (action === 'getVipBalance') {
      const playerId = e.parameter.playerId;
      const playerName = e.parameter.playerName;
      if (playerId) {
        return getVipBalance(playerId);
      } else if (playerName) {
        return getVipBalanceByName(playerName);
      }
    }
    
    // Default: Handle tool usage logs retrieval (existing functionality)
    // Only if no action specified or action is explicitly for tool usage
    if (!action || action === 'getToolUsage' || action === 'toolUsage') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(TOOL_USAGE_SHEET_NAME);
      
      // If sheet doesn't exist, use active sheet (backward compatibility)
      if (!sheet) {
        sheet = SpreadsheetApp.getActiveSheet();
      }
      
      // Check if sheet has data (more than just headers)
      if (sheet.getLastRow() <= 1) {
        // No data rows, return empty array
        return ContentService
          .createTextOutput(JSON.stringify([]))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
      // Get all data (excluding header row)
      const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues();
      
      // Convert to JSON format
      const logs = data.map(row => ({
        timestamp: row[0],
        userName: row[1],
        playerId: row[2],
        profileUrl: row[3],
        factionName: row[4],
        factionId: row[5],
        tool: row[6],
        apiKey: row[7]
      }));
      
      // Return the data
      return ContentService
        .createTextOutput(JSON.stringify(logs))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Unknown action
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: 'Unknown action: ' + action}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// VIP Tracking Functions

function getVipBalance(playerId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(VIP_BALANCES_SHEET_NAME);
    
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({error: 'VIP Balances sheet not found'}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const data = sheet.getDataRange().getValues();
    
    // Check if sheet is empty (only headers)
    if (data.length <= 1) {
      return ContentService.createTextOutput(JSON.stringify(null))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const headers = data[0];
    
    // Find player ID column
    const playerIdCol = headers.indexOf('Player ID');
    if (playerIdCol === -1) {
      return ContentService.createTextOutput(JSON.stringify({error: 'Player ID column not found'}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Search for player by ID
    for (let i = 1; i < data.length; i++) {
      if (data[i][playerIdCol] == playerId) {
        const result = {
          playerId: data[i][headers.indexOf('Player ID')],
          playerName: data[i][headers.indexOf('Player Name')],
          totalXanaxSent: data[i][headers.indexOf('Total Xanax Sent')] || 0,
          currentBalance: data[i][headers.indexOf('Current Balance')] || 0,
          lastDeductionDate: data[i][headers.indexOf('Last Deduction Date')] || null,
          vipLevel: data[i][headers.indexOf('VIP Level')] || 0,
          lastLoginDate: data[i][headers.indexOf('Last Login Date')] || null
        };
        return ContentService.createTextOutput(JSON.stringify(result))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    
    // Player not found
    return ContentService.createTextOutput(JSON.stringify(null))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({error: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getVipBalanceByName(playerName) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(VIP_BALANCES_SHEET_NAME);
    
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({error: 'VIP Balances sheet not found'}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const data = sheet.getDataRange().getValues();
    
    // Check if sheet is empty (only headers)
    if (data.length <= 1) {
      return ContentService.createTextOutput(JSON.stringify(null))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const headers = data[0];
    
    // Find player Name column
    const playerNameCol = headers.indexOf('Player Name');
    if (playerNameCol === -1) {
      return ContentService.createTextOutput(JSON.stringify({error: 'Player Name column not found'}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Search for player by name (prefer entries with playerId = 0 for backfilled data)
    let foundEntry = null;
    for (let i = 1; i < data.length; i++) {
      if (data[i][playerNameCol] == playerName) {
        const playerId = data[i][headers.indexOf('Player ID')];
        // Prefer entries with playerId = 0 (backfilled) or take the first match
        if (playerId == 0 || playerId === '' || !foundEntry) {
          foundEntry = {
            playerId: data[i][headers.indexOf('Player ID')],
            playerName: data[i][headers.indexOf('Player Name')],
            totalXanaxSent: data[i][headers.indexOf('Total Xanax Sent')] || 0,
            currentBalance: data[i][headers.indexOf('Current Balance')] || 0,
            lastDeductionDate: data[i][headers.indexOf('Last Deduction Date')] || null,
            vipLevel: data[i][headers.indexOf('VIP Level')] || 0,
            lastLoginDate: data[i][headers.indexOf('Last Login Date')] || null
          };
          // If we found one with playerId = 0, use it (backfilled entry)
          if (playerId == 0 || playerId === '') {
            break;
          }
        }
      }
    }
    
    if (foundEntry) {
      return ContentService.createTextOutput(JSON.stringify(foundEntry))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Player not found
    return ContentService.createTextOutput(JSON.stringify(null))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({error: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function updateVipBalance(data) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // Try to get the sheet - if not found, try creating it
    let sheet = ss.getSheetByName(VIP_BALANCES_SHEET_NAME);
    
    if (!sheet) {
      try {
        sheet = ss.insertSheet(VIP_BALANCES_SHEET_NAME);
        // Add headers
        sheet.appendRow(['Player ID', 'Player Name', 'Total Xanax Sent', 'Current Balance', 'Last Deduction Date', 'VIP Level', 'Last Login Date']);
      } catch (createError) {
        const allSheets = ss.getSheets().map(s => s.getName());
        const errorMsg = 'VIP Balances sheet not found and could not be created! Available sheets: ' + allSheets.join(', ');
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: errorMsg
        }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const playerIdCol = headers.indexOf('Player ID');
    
    if (playerIdCol === -1) {
      return ContentService.createTextOutput(JSON.stringify({error: 'Player ID column not found in VIP Balances sheet'}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Find existing row by Player ID
    let rowIndex = -1;
    const allData = sheet.getDataRange().getValues();
    for (let i = 1; i < allData.length; i++) {
      if (allData[i][playerIdCol] == data.playerId) {
        rowIndex = i + 1; // +1 because sheet rows are 1-indexed
        break;
      }
    }
    
    // Prepare row data matching the header order
    const rowData = [
      data.playerId,
      data.playerName,
      data.totalXanaxSent,
      data.currentBalance,
      data.lastDeductionDate || '',
      data.vipLevel,
      data.lastLoginDate || ''
    ];
    
    if (rowIndex === -1) {
      // New player - append row
      sheet.appendRow(rowData);
    } else {
      // Update existing row
      const range = sheet.getRange(rowIndex, 1, 1, rowData.length);
      range.setValues([rowData]);
    }
    
    return ContentService.createTextOutput(JSON.stringify({success: true}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({error: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function logVipTransaction(data) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // Try to get the sheet - if not found, try creating it
    let sheet = ss.getSheetByName(VIP_TRANSACTIONS_SHEET_NAME);
    
    if (!sheet) {
      try {
        sheet = ss.insertSheet(VIP_TRANSACTIONS_SHEET_NAME);
        // Add headers
        sheet.appendRow(['Timestamp', 'Player ID', 'Player Name', 'Amount', 'Transaction Type', 'Balance After']);
      } catch (createError) {
        const allSheets = ss.getSheets().map(s => s.getName());
        const errorMsg = 'VIP Transactions sheet not found and could not be created! Available sheets: ' + allSheets.join(', ');
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: errorMsg
        }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    
    // Append transaction
    const rowData = [
      data.timestamp,
      data.playerId,
      data.playerName,
      data.amount,
      data.transactionType,
      data.balanceAfter
    ];
    
    sheet.appendRow(rowData);
    
    return ContentService.createTextOutput(JSON.stringify({success: true}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({error: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Test function to verify sheets exist and can be written to
function testSheets() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const allSheets = ss.getSheets().map(s => s.getName());
    
    const toolUsageSheet = ss.getSheetByName(TOOL_USAGE_SHEET_NAME);
    const vipBalancesSheet = ss.getSheetByName(VIP_BALANCES_SHEET_NAME);
    const vipTransactionsSheet = ss.getSheetByName(VIP_TRANSACTIONS_SHEET_NAME);
    
    const result = {
      allSheets: allSheets,
      toolUsageSheet: toolUsageSheet ? 'Found' : 'NOT FOUND',
      vipBalancesSheet: vipBalancesSheet ? 'Found' : 'NOT FOUND',
      vipTransactionsSheet: vipTransactionsSheet ? 'Found' : 'NOT FOUND',
      expectedNames: {
        toolUsage: TOOL_USAGE_SHEET_NAME,
        vipBalances: VIP_BALANCES_SHEET_NAME,
        vipTransactions: VIP_TRANSACTIONS_SHEET_NAME
      }
    };
    
    // Try to write a test row to VIP Balances
    if (vipBalancesSheet) {
      vipBalancesSheet.appendRow(['TEST', 'TEST PLAYER', 0, 0, '', 0, '']);
      result.testWrite = 'Successfully wrote test row to VIP Balances';
    } else {
      result.testWrite = 'Cannot write - VIP Balances sheet not found';
    }
    
    return ContentService.createTextOutput(JSON.stringify(result, null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({error: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
