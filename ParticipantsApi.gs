/**
 * Participants API — Google Apps Script Web App
 *
 * Exposes the Participants sheet as JSON so external apps (e.g. the local
 * Node preview server) can read the registration list.
 *
 * Deploy: Deploy → New deployment → Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Then copy the /exec URL and run the server with:
 *   PARTICIPANTS_URL="https://script.google.com/macros/s/.../exec" npm start
 */

// Leave blank to use the first sheet in the spreadsheet
var PARTICIPANTS_SHEET = 'Participants';

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'participants';

  if (action === 'ping') {
    return json_({ ok: true, action: 'ping' });
  }

  if (action !== 'participants') {
    return json_({ ok: false, error: 'Unknown action: ' + action });
  }

  try {
    var participants = readParticipants_();
    return json_({
      ok: true,
      sheet: PARTICIPANTS_SHEET || '(first sheet)',
      count: participants.length,
      participants: participants
    });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function readParticipants_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = PARTICIPANTS_SHEET ? ss.getSheetByName(PARTICIPANTS_SHEET) : null;
  if (!sheet) sheet = ss.getSheets()[0];
  if (!sheet) throw new Error('No sheet found in this spreadsheet.');

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  var headers = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  var rows = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row.some(function (cell) { return String(cell == null ? '' : cell).trim() !== ''; })) continue;

    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var value = row[c];
      obj[headers[c]] = value instanceof Date ? formatCell_(value) : value;
    }
    if (!String(obj['Participant Name'] || obj['Name'] || '').trim()) continue;
    rows.push(obj);
  }
  return rows;
}

function formatCell_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'GMT', 'yyyy-MM-dd HH:mm:ss');
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
