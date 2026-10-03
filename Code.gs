/**
 * Event QR Portal — Google Apps Script Backend
 * Name + Email/Phone Verification Flow (Zero OTP / No MailApp)
 */

const CONFIG = {
  PARTICIPANTS_SHEET: 'Participants',
  ADMINS_SHEET: 'Admins',
  AUDIT_SHEET: 'AuditLog',
  TRACKS: ['Track A', 'Track B', 'Track C', 'Track D'],
  SESSION_TTL_SECONDS: 3600 // 1 hour session
};

const PARTICIPANT_HEADERS = [
  'Participant ID', 'Name', 'Phone', 'Email',
  'Checkin Token', 'Food Token', 'Goodie Token',
  'Checkin Redeemed', 'Food Redeemed', 'Goodie Redeemed',
  'Track', 'Checked In At', 'Food Redeemed At', 'Goodie Redeemed At'
];

const ADMIN_HEADERS = ['Email', 'Name', 'Active'];
const AUDIT_HEADERS = ['Timestamp', 'Admin Email', 'Action', 'QR Type', 'Participant ID', 'Participant Name', 'Track', 'Result', 'Details'];

/**
 * Web App entry point.
 * Serves participant portal by default, or admin scanner if ?page=admin
 */
function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'participant';
  const template = HtmlService.createTemplateFromFile('Index');
  template.page = page === 'admin' ? 'admin' : 'participant';
  template.tracks = CONFIG.TRACKS;
  return template.evaluate()
    .setTitle(page === 'admin' ? 'Event Admin Scanner' : 'Event Participant Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

/**
 * Initializes sheets, sets headers, and seeds IDs & QR tokens if missing.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const p = getOrCreateSheet_(ss, CONFIG.PARTICIPANTS_SHEET, PARTICIPANT_HEADERS);
  const a = getOrCreateSheet_(ss, CONFIG.ADMINS_SHEET, ADMIN_HEADERS);
  const l = getOrCreateSheet_(ss, CONFIG.AUDIT_SHEET, AUDIT_HEADERS);

  ensureParticipantHeaders_(p);
  seedParticipantIdsAndTokens_(p);

  [p, a, l].forEach(s => {
    s.setFrozenRows(1);
    s.autoResizeColumns(1, Math.min(s.getLastColumn(), 15));
  });
  return 'Sheets initialized successfully';
}

function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function ensureParticipantHeaders_(sheet) {
  const width = Math.max(sheet.getLastColumn(), PARTICIPANT_HEADERS.length);
  const current = sheet.getRange(1, 1, 1, width).getValues()[0];
  PARTICIPANT_HEADERS.forEach((h, i) => {
    if (!current[i]) sheet.getRange(1, i + 1).setValue(h);
  });
}

function seedParticipantIdsAndTokens_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const values = sheet.getRange(2, 1, lastRow - 1, PARTICIPANT_HEADERS.length).getValues();
  const updates = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const name = String(row[1] || '').trim();
    if (!name) continue;

    let modified = false;
    const id = row[0] || ('P-' + Utilities.getUuid().slice(0, 8).toUpperCase());
    if (!row[0]) { row[0] = id; modified = true; }
    if (!row[4] || String(row[4]).indexOf('CHK-') === 0) { row[4] = id + '-CHK'; modified = true; }
    if (!row[5] || String(row[5]).indexOf('FOD-') === 0) { row[5] = id + '-FOD'; modified = true; }
    if (!row[6] || String(row[6]).indexOf('GDK-') === 0) { row[6] = id + '-GDK'; modified = true; }

    if (modified) {
      updates.push({ row: i + 2, values: row });
    }
  }
  updates.forEach(u => sheet.getRange(u.row, 1, 1, PARTICIPANT_HEADERS.length).setValues([u.values]));
}

function newToken_(prefix, id) {
  return (id || 'P') + '-' + prefix;
}

function normalizeName_(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeEmail_(s) {
  return String(s || '').trim().toLowerCase();
}

function normalizeDigits_(s) {
  return String(s || '').replace(/\D/g, '');
}

/**
 * Normalizes phone numbers and checks for equivalence.
 * Supports +91, leading 0, spaces, dashes, parentheses by comparing last 10 digits.
 */
function phonesMatch_(p1, p2) {
  const d1 = normalizeDigits_(p1);
  const d2 = normalizeDigits_(p2);
  if (!d1 || !d2) return false;
  if (d1 === d2) return true;
  if (d1.length >= 10 && d2.length >= 10) {
    return d1.slice(-10) === d2.slice(-10);
  }
  return false;
}

function levenshteinDistance_(s1, s2) {
  const m = s1.length, n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function wordsMatchOrSimilar_(w1, w2) {
  if (w1 === w2) return true;
  if (w1.indexOf(w2) !== -1 || w2.indexOf(w1) !== -1) return true;
  const maxLen = Math.max(w1.length, w2.length);
  if (maxLen <= 3) return w1 === w2;
  const dist = levenshteinDistance_(w1, w2);
  return dist <= (maxLen > 6 ? 2 : 1);
}

function namesAreSimilar_(inputName, registeredName) {
  const n1 = normalizeName_(inputName);
  const n2 = normalizeName_(registeredName);
  if (n1 === n2) return true;
  if (n1.indexOf(n2) !== -1 || n2.indexOf(n1) !== -1) return true;

  const t1 = n1.split(/\s+/).filter(Boolean);
  const t2 = n2.split(/\s+/).filter(Boolean);

  const allT1Matched = t1.length > 0 && t1.every(w1 => t2.some(w2 => wordsMatchOrSimilar_(w1, w2)));
  if (allT1Matched) return true;

  const anyTokenMatch = t1.some(w1 => w1.length >= 3 && t2.some(w2 => wordsMatchOrSimilar_(w1, w2)));
  if (anyTokenMatch) {
    const totalDist = levenshteinDistance_(n1, n2);
    if (totalDist <= Math.max(3, Math.floor(Math.max(n1.length, n2.length) * 0.35))) {
      return true;
    }
  }

  return false;
}

/**
 * Returns list of participant names matching query.
 * Only returns names — zero sensitive information (emails, phones, tokens) is exposed.
 */
function getParticipantNames(search) {
  setupSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PARTICIPANTS_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const query = normalizeName_(search);
  const names = sheet.getRange(2, 2, lastRow - 1, 1).getValues().flat()
    .map(String)
    .map(s => s.trim())
    .filter(Boolean);

  const unique = [...new Set(names)];
  if (!query) return unique.slice(0, 40);

  const directMatches = unique.filter(n => normalizeName_(n).indexOf(query) !== -1);
  const fuzzyMatches = unique.filter(n => directMatches.indexOf(n) === -1 && namesAreSimilar_(query, n));
  return directMatches.concat(fuzzyMatches).slice(0, 40);
}

/**
 * Participant Verification
 * Checks that Selected Name + Entered Email OR Phone match the same participant record.
 * Completely replaces the OTP flow.
 */
function verifyParticipant(name, emailOrPhone) {
  setupSheets();
  const inputName = String(name || '').trim();
  const credential = String(emailOrPhone || '').trim();

  if (!inputName) {
    throw new Error('Please select or search your registered name.');
  }
  if (!credential) {
    throw new Error('Please enter your registered email or phone number.');
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PARTICIPANTS_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('No registered participants found in the database.');
  }

  const rows = sheet.getRange(2, 1, lastRow - 1, PARTICIPANT_HEADERS.length).getValues();

  const isEmailInput = credential.indexOf('@') !== -1;
  const normalizedInputEmail = normalizeEmail_(credential);

  // 1. Search for matching credential in dataset
  const credMatches = rows.filter(r => {
    const rowPhone = r[2];
    const rowEmail = normalizeEmail_(r[3]);
    const emailMatches = isEmailInput && rowEmail && (rowEmail === normalizedInputEmail);
    const phoneMatches = rowPhone && phonesMatch_(credential, rowPhone);
    return emailMatches || phoneMatches;
  });

  let verifiedRow = null;

  if (credMatches.length > 0) {
    verifiedRow = credMatches.find(r => namesAreSimilar_(inputName, r[1]));
    if (!verifiedRow && credMatches.length === 1) {
      const t1 = normalizeName_(inputName).split(/\s+/).filter(Boolean);
      const t2 = normalizeName_(credMatches[0][1]).split(/\s+/).filter(Boolean);
      const hasCommonWord = t1.some(w1 => t2.some(w2 => wordsMatchOrSimilar_(w1, w2)));
      if (hasCommonWord || namesAreSimilar_(inputName, credMatches[0][1])) {
        verifiedRow = credMatches[0];
      }
    }
  }

  // 2. If not found by credential, search by name candidates
  if (!verifiedRow) {
    const nameCandidates = rows.filter(r => namesAreSimilar_(inputName, r[1]));
    if (nameCandidates.length > 0) {
      verifiedRow = nameCandidates.find(r => {
        const rowPhone = r[2];
        const rowEmail = normalizeEmail_(r[3]);
        const emailMatches = isEmailInput && rowEmail && (rowEmail === normalizedInputEmail);
        const phoneMatches = rowPhone && phonesMatch_(credential, rowPhone);
        return emailMatches || phoneMatches;
      });
    }
  }

  if (!verifiedRow) {
    const nameExists = rows.some(r => namesAreSimilar_(inputName, r[1]));
    if (!nameExists) {
      throw new Error('Name not found in the registration list. Please check the spelling and try again.');
    } else {
      throw new Error('Verification failed. The entered email or phone number does not match the registration record for this participant.');
    }
  }

  // Ensure tokens are present
  if (!verifiedRow[4] || !verifiedRow[5] || !verifiedRow[6]) {
    seedParticipantIdsAndTokens_(sheet);
  }

  // Create participant session
  const sessionId = Utilities.getUuid();
  CacheService.getScriptCache().put(
    'SESSION_' + sessionId,
    JSON.stringify({ participantId: verifiedRow[0], name: verifiedRow[1] }),
    CONFIG.SESSION_TTL_SECONDS
  );

  return {
    ok: true,
    sessionId,
    participant: {
      id: verifiedRow[0],
      name: verifiedRow[1]
    }
  };
}

/**
 * Returns dashboard info for authenticated participant session.
 */
function getParticipantDashboard(sessionId) {
  const session = getSession_(sessionId);
  const rowObj = findParticipantRow_(session.participantId);
  if (!rowObj) {
    throw new Error('Participant record could not be found.');
  }
  return participantResponse_(rowObj.values);
}

function getSession_(sessionId) {
  if (!sessionId) throw new Error('Session expired. Please log in again.');
  const raw = CacheService.getScriptCache().get('SESSION_' + sessionId);
  if (!raw) throw new Error('Session expired. Please log in again.');
  return JSON.parse(raw);
}

function findParticipantRow_(participantId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PARTICIPANTS_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  const idx = ids.findIndex(id => String(id) === String(participantId));
  if (idx < 0) return null;
  return {
    sheet,
    rowNumber: idx + 2,
    values: sheet.getRange(idx + 2, 1, 1, PARTICIPANT_HEADERS.length).getValues()[0]
  };
}

function participantResponse_(r) {
  return {
    id: r[0],
    name: r[1],
    track: r[10] || '',
    checkedInAt: formatDate_(r[11]),
    foodRedeemedAt: formatDate_(r[12]),
    goodieRedeemedAt: formatDate_(r[13]),
    checkin: {
      redeemed: !!r[7],
      token: r[4],
      redeemedAt: formatDate_(r[11])
    },
    food: {
      redeemed: !!r[8],
      token: r[5],
      redeemedAt: formatDate_(r[12])
    },
    goodie: {
      redeemed: !!r[9],
      token: r[6],
      redeemedAt: formatDate_(r[13])
    }
  };
}

function formatDate_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone() || 'GMT', 'yyyy-MM-dd HH:mm:ss');
  }
  return String(val);
}

/**
 * Validates admin status against Admins sheet.
 */
function adminStatus(clientEmail) {
  setupSheets();
  const activeUser = Session.getActiveUser();
  const email = (clientEmail || (activeUser && activeUser.getEmail()) || '').trim();
  const authorized = isAdmin_(email);
  return {
    authorized,
    email: email || ''
  };
}

function isAdmin_(email) {
  if (!email) return false;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.ADMINS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return false;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const target = normalizeEmail_(email);
  return rows.some(r => {
    const adminEmail = normalizeEmail_(r[0]);
    const active = String(r[2]).trim().toLowerCase();
    return adminEmail === target && (active === 'true' || active === 'yes' || active === '1');
  });
}

/**
 * QR Redemption Endpoint
 * Handles:
 * 1. CHECKIN (inspect -> assign track -> redeem)
 * 2. FOOD (inspect -> confirm -> redeem)
 * 3. GOODIE (inspect -> confirm -> redeem)
 * Uses LockService to prevent double-redemptions.
 */
function redeemQR(token, adminEmail, track, confirmAction) {
  setupSheets();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
      throw new Error('No QR token received.');
    }

    const authorizedAdmin = isAdmin_(adminEmail);
    if (!authorizedAdmin) {
      appendAudit_(adminEmail, 'UNAUTHORIZED_ATTEMPT', 'UNKNOWN', '', '', '', 'FAILED', 'Unauthorized admin email: ' + adminEmail);
      throw new Error('You are not authorized as an admin.');
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PARTICIPANTS_SHEET);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No participants registered.');

    const rows = sheet.getRange(2, 1, lastRow - 1, PARTICIPANT_HEADERS.length).getValues();
    let index = -1;
    let type = '';

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (String(r[4]) === cleanToken) { index = i; type = 'CHECKIN'; break; }
      if (String(r[5]) === cleanToken) { index = i; type = 'FOOD'; break; }
      if (String(r[6]) === cleanToken) { index = i; type = 'GOODIE'; break; }
    }

    if (index < 0) {
      appendAudit_(adminEmail, 'INVALID_QR', 'UNKNOWN', '', '', '', 'FAILED', 'Unrecognized token: ' + cleanToken);
      throw new Error('Invalid QR code. Token was not found in the registration system.');
    }

    const r = rows[index];
    const rowNumber = index + 2;
    const participantId = String(r[0]);
    const participantName = String(r[1]);
    const participantPhone = String(r[2] || '');
    const participantEmail = String(r[3] || '');

    const participantInfo = {
      id: participantId,
      name: participantName,
      email: participantEmail,
      phone: participantPhone
    };

    // CHECK-IN QR
    if (type === 'CHECKIN') {
      if (r[7]) {
        const checkedInAt = formatDate_(r[11]) || 'earlier';
        appendAudit_(adminEmail, 'ALREADY_REDEEMED', type, participantId, participantName, r[10] || '', 'REJECTED', 'Check-in already completed at ' + checkedInAt);
        return {
          ok: false,
          alreadyRedeemed: true,
          type: 'Event Check-in',
          participant: participantInfo,
          participantName,
          participantId,
          track: r[10] || '',
          redeemedAt: checkedInAt,
          message: 'Already Checked In at ' + checkedInAt + (r[10] ? ' (Track: ' + r[10] + ')' : '')
        };
      }

      // Check-in requires track assignment
      if (!track || CONFIG.TRACKS.indexOf(track) === -1) {
        return {
          ok: true,
          needsTrack: true,
          type: 'Event Check-in',
          participant: participantInfo,
          tracks: CONFIG.TRACKS
        };
      }

      const now = new Date();
      sheet.getRange(rowNumber, 8).setValue(now); // Checkin Redeemed
      sheet.getRange(rowNumber, 11).setValue(track); // Track
      sheet.getRange(rowNumber, 12).setValue(now); // Checked In At

      appendAudit_(adminEmail, 'CHECKIN', type, participantId, participantName, track, 'SUCCESS', 'Checked in with track ' + track);
      return {
        ok: true,
        type: 'Event Check-in',
        participant: participantInfo,
        participantId,
        participantName,
        track,
        message: 'Participant successfully checked in and assigned to ' + track + '.'
      };
    }

    // FOOD QR
    if (type === 'FOOD') {
      if (r[8]) {
        const redeemedAt = formatDate_(r[12]) || 'earlier';
        appendAudit_(adminEmail, 'ALREADY_REDEEMED', type, participantId, participantName, r[10] || '', 'REJECTED', 'Food already redeemed at ' + redeemedAt);
        return {
          ok: false,
          alreadyRedeemed: true,
          type: 'Lunch & Meals',
          participant: participantInfo,
          participantName,
          participantId,
          redeemedAt,
          message: 'Food was already redeemed at ' + redeemedAt
        };
      }

      // Prompt confirmation if not confirmed yet
      if (!confirmAction) {
        return {
          ok: true,
          needsConfirmation: true,
          type: 'Lunch & Meals',
          participant: participantInfo,
          status: 'Available'
        };
      }

      const now = new Date();
      sheet.getRange(rowNumber, 9).setValue(now); // Food Redeemed
      sheet.getRange(rowNumber, 13).setValue(now); // Food Redeemed At

      appendAudit_(adminEmail, 'FOOD_REDEEM', type, participantId, participantName, r[10] || '', 'SUCCESS', 'Food voucher redeemed');
      return {
        ok: true,
        type: 'Lunch & Meals',
        participant: participantInfo,
        participantId,
        participantName,
        message: 'Food voucher successfully redeemed.'
      };
    }

    // GOODIE QR
    if (type === 'GOODIE') {
      if (r[9]) {
        const redeemedAt = formatDate_(r[13]) || 'earlier';
        appendAudit_(adminEmail, 'ALREADY_REDEEMED', type, participantId, participantName, r[10] || '', 'REJECTED', 'Goodie Kit already redeemed at ' + redeemedAt);
        return {
          ok: false,
          alreadyRedeemed: true,
          type: 'Swag & Goodie Kit',
          participant: participantInfo,
          participantName,
          participantId,
          redeemedAt,
          message: 'Goodie Kit was already redeemed at ' + redeemedAt
        };
      }

      if (!confirmAction) {
        return {
          ok: true,
          needsConfirmation: true,
          type: 'Swag & Goodie Kit',
          participant: participantInfo,
          status: 'Available'
        };
      }

      const now = new Date();
      sheet.getRange(rowNumber, 10).setValue(now); // Goodie Redeemed
      sheet.getRange(rowNumber, 14).setValue(now); // Goodie Redeemed At

      appendAudit_(adminEmail, 'GOODIE_REDEEM', type, participantId, participantName, r[10] || '', 'SUCCESS', 'Goodie kit redeemed');
      return {
        ok: true,
        type: 'Swag & Goodie Kit',
        participant: participantInfo,
        participantId,
        participantName,
        message: 'Goodie kit successfully redeemed.'
      };
    }

    // GOODIE KIT QR
    if (type === 'GOODIE') {
      if (r[9]) {
        const redeemedAt = formatDate_(r[13]) || 'earlier';
        appendAudit_(adminEmail, 'ALREADY_REDEEMED', type, participantId, participantName, r[10] || '', 'REJECTED', 'Goodie kit already redeemed at ' + redeemedAt);
        return {
          ok: false,
          alreadyRedeemed: true,
          type: 'Goodie Kit',
          participantName,
          participantId,
          redeemedAt,
          message: 'Goodie Kit was already redeemed at ' + redeemedAt
        };
      }

      // Prompt confirmation if not confirmed yet
      if (!confirmAction) {
        return {
          ok: true,
          needsConfirmation: true,
          type: 'Goodie Kit',
          participant: { id: participantId, name: participantName },
          status: 'Available'
        };
      }

      const now = new Date();
      sheet.getRange(rowNumber, 10).setValue(now); // Goodie Redeemed
      sheet.getRange(rowNumber, 14).setValue(now); // Goodie Redeemed At

      appendAudit_(adminEmail, 'GOODIE_REDEEM', type, participantId, participantName, r[10] || '', 'SUCCESS', 'Goodie kit redeemed');
      return {
        ok: true,
        type: 'Goodie Kit',
        participantId,
        participantName,
        message: 'Goodie kit successfully redeemed.'
      };
    }

    throw new Error('Unknown QR type.');
  } finally {
    lock.releaseLock();
  }
}

function appendAudit_(adminEmail, action, type, participantId, name, track, result, details) {
  try {
    const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.AUDIT_SHEET);
    if (s) {
      s.appendRow([new Date(), adminEmail || '', action, type, participantId, name, track, result, details]);
    }
  } catch (e) {
    console.error('Failed to write audit log: ' + e.message);
  }
}
