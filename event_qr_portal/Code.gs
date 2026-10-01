const CONFIG = {
  PARTICIPANTS_SHEET: 'Participants',
  ADMINS_SHEET: 'Admins',
  AUDIT_SHEET: 'AuditLog',
  TRACKS: ['Track A', 'Track B', 'Track C', 'Track D'],
  SESSION_TTL_SECONDS: 600,
  OTP_TTL_SECONDS: 600,
  OTP_RESEND_COOLDOWN_SECONDS: 60,
  OTP_MAX_ATTEMPTS: 5
};

const PARTICIPANT_HEADERS = [
  'Participant ID', 'Name', 'Phone', 'Email',
  'Checkin Token', 'Food Token', 'Goodie Token',
  'Checkin Redeemed', 'Food Redeemed', 'Goodie Redeemed',
  'Track', 'Checked In At', 'Food Redeemed At', 'Goodie Redeemed At'
];

const ADMIN_HEADERS = ['Email', 'Name', 'Active'];
const AUDIT_HEADERS = ['Timestamp', 'Admin Email', 'Action', 'QR Type', 'Participant ID', 'Participant Name', 'Track', 'Result', 'Details'];

function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'participant';
  const template = HtmlService.createTemplateFromFile('Index');
  template.page = page === 'admin' ? 'admin' : 'participant';
  template.tracks = CONFIG.TRACKS;
  return template.evaluate()
    .setTitle('Event Participant Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const p = getOrCreateSheet_(ss, CONFIG.PARTICIPANTS_SHEET, PARTICIPANT_HEADERS);
  const a = getOrCreateSheet_(ss, CONFIG.ADMINS_SHEET, ADMIN_HEADERS);
  const l = getOrCreateSheet_(ss, CONFIG.AUDIT_SHEET, AUDIT_HEADERS);

  ensureParticipantHeaders_(p);
  seedParticipantIdsAndTokens_(p);

  [p, a, l].forEach(s => {
    s.setFrozenRows(1);
    s.autoResizeColumns(1, s.getLastColumn());
  });
  return 'Sheets ready';
}

function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
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
    if (!row[0]) row[0] = 'P-' + Utilities.getUuid().slice(0, 8).toUpperCase();
    if (!row[4]) row[4] = newToken_('CHK');
    if (!row[5]) row[5] = newToken_('FOD');
    if (!row[6]) row[6] = newToken_('GDK');
    updates.push({row: i + 2, values: row});
  }
  updates.forEach(u => sheet.getRange(u.row, 1, 1, PARTICIPANT_HEADERS.length).setValues([u.values]));
}

function newToken_(prefix) {
  return prefix + '-' + Utilities.getUuid().replace(/-/g, '') + '-' + Utilities.getUuid().slice(0, 8);
}

function newOtp_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalize_(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function mask_(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.includes('@')) {
    const parts = s.split('@');
    return (parts[0].slice(0, 2) + '***@' + parts[1]);
  }
  return s.length <= 4 ? '****' : '*'.repeat(Math.max(0, s.length - 4)) + s.slice(-4);
}

function getParticipantNames(search) {
  setupSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PARTICIPANTS_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const query = normalize_(search);
  const names = sheet.getRange(2, 2, lastRow - 1, 1).getValues().flat()
    .map(String)
    .map(s => s.trim())
    .filter(Boolean);

  const unique = [...new Set(names)];
  if (!query) return unique.slice(0, 30);
  return unique.filter(n => normalize_(n).includes(query)).slice(0, 30);
}

/**
 * Step 1 of participant login.
 * The participant selects their registered name. A one-time OTP is sent
 * to the email stored for that participant in the Participants sheet.
 */
function requestOtp(name) {
  setupSheets();
  const n = normalize_(name);
  if (!n) throw new Error('Please select your registered name.');

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PARTICIPANTS_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No participants found.');

  const rows = sheet.getRange(2, 1, lastRow - 1, PARTICIPANT_HEADERS.length).getValues();
  const matches = rows.filter(r => normalize_(r[1]) === n);

  if (!matches.length) throw new Error('Participant name not found. Please select your registered name.');
  if (matches.length > 1) {
    throw new Error('More than one participant has this name. Please contact the registration desk for assistance.');
  }

  const participant = matches[0];
  const email = String(participant[3] || '').trim();
  if (!email || !email.includes('@')) {
    throw new Error('No valid email address is registered for this participant. Please contact the registration desk.');
  }

  const participantId = String(participant[0]);
  const cooldownKey = 'OTP_COOLDOWN_' + participantId;
  if (CacheService.getScriptCache().get(cooldownKey)) {
    return {
      ok: true,
      cooldown: true,
      maskedEmail: mask_(email),
      message: 'An OTP was already sent recently. Please wait before requesting another one.'
    };
  }

  const otp = newOtp_();
  const cache = CacheService.getScriptCache();
  const otpKey = 'OTP_' + participantId;
  const payload = {
    participantId,
    name: participant[1],
    otp,
    attempts: 0,
    createdAt: Date.now()
  };

  cache.put(otpKey, JSON.stringify(payload), CONFIG.OTP_TTL_SECONDS);
  cache.put(cooldownKey, '1', CONFIG.OTP_RESEND_COOLDOWN_SECONDS);

  const subject = 'Your Event Portal OTP';
  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111827">
      <h2 style="margin-bottom:8px">Event Portal Verification</h2>
      <p>Hello <b>${escapeHtml_(participant[1])}</b>,</p>
      <p>Use the following one-time password to access your event QR codes:</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f3f4f6;padding:18px;text-align:center;border-radius:12px">${otp}</div>
      <p style="margin-top:20px">This OTP expires in 10 minutes and can be used only once.</p>
      <p style="color:#667085;font-size:13px">If you did not request this code, you can ignore this email.</p>
    </div>`;

  MailApp.sendEmail({
    to: email,
    subject: subject,
    htmlBody: htmlBody,
    body: `Your Event Portal OTP is ${otp}. It expires in 10 minutes and can be used only once.`
  });

  return {
    ok: true,
    maskedEmail: mask_(email),
    message: 'OTP sent successfully.'
  };
}

/** Step 2 of participant login. */
function verifyOtp(name, otp) {
  setupSheets();
  const n = normalize_(name);
  const code = String(otp || '').trim();
  if (!n || !/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit OTP sent to your email.');

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PARTICIPANTS_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No participants found.');

  const rows = sheet.getRange(2, 1, lastRow - 1, PARTICIPANT_HEADERS.length).getValues();
  const matches = rows.filter(r => normalize_(r[1]) === n);
  if (matches.length !== 1) throw new Error('Participant could not be verified. Please start again.');

  const participant = matches[0];
  const participantId = String(participant[0]);
  const cache = CacheService.getScriptCache();
  const otpKey = 'OTP_' + participantId;
  const raw = cache.get(otpKey);
  if (!raw) throw new Error('OTP expired. Please request a new OTP.');

  const data = JSON.parse(raw);
  if (data.attempts >= CONFIG.OTP_MAX_ATTEMPTS) {
    cache.remove(otpKey);
    throw new Error('Too many incorrect attempts. Please request a new OTP.');
  }

  if (data.otp !== code) {
    data.attempts = Number(data.attempts || 0) + 1;
    cache.put(otpKey, JSON.stringify(data), CONFIG.OTP_TTL_SECONDS);
    const remaining = Math.max(0, CONFIG.OTP_MAX_ATTEMPTS - data.attempts);
    throw new Error('Incorrect OTP. ' + remaining + ' attempt(s) remaining.');
  }

  cache.remove(otpKey);
  cache.remove('OTP_COOLDOWN_' + participantId);

  const sessionId = Utilities.getUuid();
  cache.put(
    'SESSION_' + sessionId,
    JSON.stringify({participantId: participant[0], name: participant[1]}),
    CONFIG.SESSION_TTL_SECONDS
  );

  return {
    ok: true,
    sessionId,
    participant: {
      id: participant[0],
      name: participant[1],
      checkinRedeemed: !!participant[7],
      foodRedeemed: !!participant[8],
      goodieRedeemed: !!participant[9],
      track: participant[10] || ''
    }
  };
}

function escapeHtml_(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

function getParticipantDashboard(sessionId) {
  const session = getSession_(sessionId);
  const row = findParticipantRow_(session.participantId);
  if (!row) throw new Error('Participant not found.');
  return participantResponse_(row);
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
  return {sheet, rowNumber: idx + 2, values: sheet.getRange(idx + 2, 1, 1, PARTICIPANT_HEADERS.length).getValues()[0]};
}

function participantResponse_(obj) {
  const r = obj.values;
  return {
    id: r[0], name: r[1], email: mask_(r[3]),
    track: r[10] || '',
    checkin: {redeemed: !!r[7], token: r[4]},
    food: {redeemed: !!r[8], token: r[5]},
    goodie: {redeemed: !!r[9], token: r[6]}
  };
}

function redeemQR(token, adminEmail, track) {
  setupSheets();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const admin = isAdmin_(adminEmail);
    if (!admin) throw new Error('You are not authorized as an admin.');

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PARTICIPANTS_SHEET);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No participants found.');

    const rows = sheet.getRange(2, 1, lastRow - 1, PARTICIPANT_HEADERS.length).getValues();
    let index = -1;
    let type = '';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (String(r[4]) === String(token)) { index = i; type = 'CHECKIN'; break; }
      if (String(r[5]) === String(token)) { index = i; type = 'FOOD'; break; }
      if (String(r[6]) === String(token)) { index = i; type = 'GOODIE'; break; }
    }
    if (index < 0) throw new Error('Invalid QR code.');

    const r = rows[index];
    const rowNumber = index + 2;
    let result;

    if (type === 'CHECKIN') {
      if (r[7]) throw new Error('Check-in QR has already been redeemed.');
      if (!track || CONFIG.TRACKS.indexOf(track) === -1) {
        return {ok: true, needsTrack: true, type, participant: {id:r[0], name:r[1]}, tracks: CONFIG.TRACKS};
      }
      sheet.getRange(rowNumber, 8).setValue(new Date());
      sheet.getRange(rowNumber, 11).setValue(track);
      result = {ok:true, type, participantId:r[0], participantName:r[1], track, message:'Check-in completed and track assigned.'};
    } else if (type === 'FOOD') {
      if (r[8]) throw new Error('Food QR has already been redeemed.');
      sheet.getRange(rowNumber, 9).setValue(new Date());
      result = {ok:true, type, participantId:r[0], participantName:r[1], track:r[10] || '', message:'Food redeemed successfully.'};
    } else {
      if (r[9]) throw new Error('Goodie-kit QR has already been redeemed.');
      sheet.getRange(rowNumber, 10).setValue(new Date());
      result = {ok:true, type, participantId:r[0], participantName:r[1], track:r[10] || '', message:'Goodie kit redeemed successfully.'};
    }

    appendAudit_(adminEmail, 'REDEEM', type, r[0], r[1], result.track || r[10] || '', 'SUCCESS', result.message);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function isAdmin_(email) {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.ADMINS_SHEET);
  if (!s || s.getLastRow() < 2) return false;
  const rows = s.getRange(2, 1, s.getLastRow() - 1, 3).getValues();
  const target = normalize_(email);
  return rows.some(r => normalize_(r[0]) === target && String(r[2]).toLowerCase() !== 'false' && String(r[2]).toLowerCase() !== 'no');
}

function adminStatus(email) {
  return {authorized: isAdmin_(email), email: email || ''};
}

function appendAudit_(adminEmail, action, type, participantId, name, track, result, details) {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.AUDIT_SHEET);
  s.appendRow([new Date(), adminEmail, action, type, participantId, name, track, result, details]);
}

function resetParticipant(participantId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const obj = findParticipantRow_(participantId);
    if (!obj) throw new Error('Participant not found.');
    const r = obj.values;
    r[4] = newToken_('CHK');
    r[5] = newToken_('FOD');
    r[6] = newToken_('GDK');
    r[7] = '';
    r[8] = '';
    r[9] = '';
    r[10] = '';
    r[11] = '';
    r[12] = '';
    r[13] = '';
    obj.sheet.getRange(obj.rowNumber, 1, 1, PARTICIPANT_HEADERS.length).setValues([r]);
    return true;
  } finally {
    lock.releaseLock();
  }
}
