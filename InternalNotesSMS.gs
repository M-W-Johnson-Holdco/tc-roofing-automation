// ============================================================
// TC Roofing — Internal Notes Nightly SMS
// Reads the "Scheduler Log" sheet, finds tomorrow's appointments
// that have internal notes and haven't been texted yet, and
// sends them via RingCentral to all numbers in the StaffContacts tab.
//
// SETUP:
// 1. Open the TC Roofing Google Sheet
// 2. Extensions → Apps Script → paste this file
// 3. Extensions → Apps Script → Project Settings → Script Properties
//    Add these properties:
//      RC_CLIENT_ID      → your RingCentral client ID
//      RC_CLIENT_SECRET  → your RingCentral client secret
//      RC_JWT            → your RingCentral JWT token
//      RC_FROM           → sending number e.g. +12141234567
//
// 4. Triggers → Add Trigger:
//      Function: sendInternalNotesSMS
//      Event source: Time-driven
//      Type: Day timer
//      Time: 5pm–6pm
//      Timezone: America/Chicago (Central Time)
//
// 5. Make sure the spreadsheet has a "StaffContacts" sheet with
//    Column A: Email, Column B: Phone (e.g. +12145551234)
// ============================================================

function sendInternalNotesSMS() {
  var props          = PropertiesService.getScriptProperties();
  var rcClientId     = props.getProperty('RC_CLIENT_ID');
  var rcClientSecret = props.getProperty('RC_CLIENT_SECRET');
  var rcJwt          = props.getProperty('RC_JWT');
  var rcFrom         = props.getProperty('RC_FROM');

  if (!rcClientId || !rcClientSecret || !rcJwt || !rcFrom) {
    Logger.log('ERROR: Missing Script Properties — check RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT, RC_FROM.');
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Read staff phone numbers from StaffContacts tab (column B)
  var staffSheet = ss.getSheetByName('StaffContacts');
  if (!staffSheet) { Logger.log('ERROR: "StaffContacts" sheet not found.'); return; }
  var staffData = staffSheet.getRange('B:B').getValues();
  var staffNums = staffData.map(function(r){ return String(r[0]||'').trim(); })
                            .filter(function(p){ return /^\+?[0-9]{10,15}$/.test(p); });
  if (!staffNums.length) { Logger.log('ERROR: No valid phone numbers in StaffContacts column B.'); return; }
  Logger.log('Staff numbers: ' + staffNums.join(', '));

  // Get tomorrow's date in Central Time
  var tomorrowStr = getTomorrowCT();
  Logger.log('Checking for appointments on: ' + tomorrowStr);

  var schedSheet = ss.getSheetByName('Scheduler Log');
  if (!schedSheet) { Logger.log('ERROR: "Scheduler Log" sheet not found.'); return; }

  var data = schedSheet.getDataRange().getValues();
  if (data.length < 1) { Logger.log('No rows in Scheduler Log.'); return; }

  var rcToken = getRCToken(rcClientId, rcClientSecret, rcJwt);
  if (!rcToken) { Logger.log('ERROR: Failed to get RingCentral token.'); return; }

  var sent = 0, skipped = 0;

  for (var i = 0; i < data.length; i++) {
    var row           = data[i];
    var rowDate       = String(row[4]  || '').trim();  // E: date (YYYY-MM-DD)
    var internalNotes = String(row[9]  || '').trim();  // J: internalNotes
    var internalSent  = String(row[12] || '').trim();  // M: internalNotesSent

    if (rowDate !== tomorrowStr) continue;
    if (!internalNotes)          continue;
    if (internalSent)            { skipped++; continue; } // already sent

    var name     = String(row[2]  || '').trim();  // C: name
    var apptType = String(row[3]  || '').trim();  // D: apptType
    var start    = String(row[5]  || '').trim();  // F: start HH:MM
    var schedBy  = String(row[10] || '').trim();  // K: scheduledBy

    var msg = '[Staff Note] ' + apptType + ' — ' + name + '\n' +
              formatDate(tomorrowStr) + ' at ' + formatTime(start) + '\n' +
              internalNotes + '\nScheduled by: ' + (schedBy || 'Unknown');

    var ok = sendRCSMS(rcToken, rcFrom, staffNums, msg);
    if (ok) {
      schedSheet.getRange(i + 1, 13).setValue('GAS_SENT');
      sent++;
      Logger.log('Sent: ' + name + ' — ' + apptType);
    } else {
      Logger.log('FAILED: ' + name + ' — ' + apptType);
    }
    Utilities.sleep(1200);
  }

  Logger.log('Done. Sent: ' + sent + ', Already sent (skipped): ' + skipped);
}

function getTomorrowCT() {
  var nowCT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  nowCT.setDate(nowCT.getDate() + 1);
  var y = nowCT.getFullYear();
  var m = String(nowCT.getMonth() + 1).padStart(2, '0');
  var d = String(nowCT.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function getRCToken(clientId, clientSecret, jwt) {
  var creds = Utilities.base64Encode(clientId + ':' + clientSecret);
  var resp = UrlFetchApp.fetch('https://platform.ringcentral.com/restapi/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText());
  if (!data.access_token) { Logger.log('RC auth error: ' + resp.getContentText()); return null; }
  return data.access_token;
}

function sendRCSMS(token, from, toNumbers, text) {
  var resp = UrlFetchApp.fetch('https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      from: { phoneNumber: from },
      to: toNumbers.map(function(n){ return { phoneNumber: n }; }),
      text: text
    }),
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText());
  if (data.errorCode) { Logger.log('SMS error: ' + resp.getContentText()); return false; }
  return true;
}

function formatTime(hhmm) {
  if (!hhmm || hhmm.indexOf(':') === -1) return hhmm;
  var parts = hhmm.split(':');
  var h = parseInt(parts[0], 10);
  var m = parts[1];
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ampm;
}

function formatDate(yyyyMmDd) {
  var p = yyyyMmDd.split('-');
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + ', ' + p[0];
}
