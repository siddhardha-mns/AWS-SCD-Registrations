const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sb = require('./supabase-store');

const TRACKS = ['Track Devops', 'Track Cloud', 'Track Data and AI'];
const normalizeName = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const ADMIN_LOGIN_MODE = 'email-allowlist-v1';
const ADMIN_SESSION_VERSION = crypto.createHash('sha256').update(ADMIN_LOGIN_MODE).digest('hex');

function phone(value) {
  const text = String(value || '').trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) return '';
  const digits = text.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return '';
}
const newToken = () => 'v4-' + crypto.randomBytes(16).toString('hex');

function renderHtml(template, page) {
  const participant = page !== 'admin';
  let html = template.replace(/<\?\s*if\s*\(\s*page\s*===\s*'participant'\s*\)\s*\{\s*\?>([\s\S]*?)<\?\s*\}\s*else\s*\{\s*\?>([\s\S]*?)<\?\s*\}\s*\?>/g, (_, a, b) => participant ? a : b);
  html = html.replace(/<\?\s*for\s*\([^?]+\)\s*\{\s*\?>\s*<option><\?=\s*tracks\[i\]\s*\?><\/option>\s*<\?\s*\}\s*\?>/g, TRACKS.map(t => `<option>${t}</option>`).join(''));
  html = html.replace(/<\?=\s*page\s*===\s*'admin'\s*\?\s*'Admin Scanner'\s*:\s*'Participant'\s*\?>/g, participant ? 'Participant' : 'Admin Scanner');
  html = html.replace(/<div id="topRight">[\s\S]*?<\/div>/, `<div id="topRight"><a class="corner-link" href="${participant ? '/?page=admin' : '/'}">${participant ? 'Admin' : 'Participant Portal'}</a></div>`);
  return html.replace('</head>', `<script>
    window.NODE_PORTAL = true;
    function runner(success, failure) { return new Proxy({}, {get: (_, key) => {
      if(key === 'withSuccessHandler') return fn => runner(fn, failure);
      if(key === 'withFailureHandler') return fn => runner(success, fn);
      return async (...args) => { try {
        const response = await fetch('/api/rpc', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({method:key,args}), cache:'no-store'});
        const result = await response.json();
        if (!result.ok) throw new Error(result.error || 'Request failed.');
        if(success) success(result.data);
      } catch(error) { if(failure) failure(error); else console.error(error.message); } };
    }}); }
    window.google = {script:{run:runner()}};
  </script></head>`);
}

// ── Stats helper ──────────────────────────────────────────────────────────────
async function stats() {
  const [rows, limits] = await Promise.all([sb.getAllParticipants(), sb.getTrackLimits()]);
  return TRACKS.map(track => {
    const assigned = rows.filter(p => p.track === track);
    const enrolled = assigned.length;
    const checkedIn = assigned.filter(p => p.checkin_redeemed).length;
    const limit = limits[track] || 0;
    return { track, enrolled, reserved: enrolled, checkedIn, limit, available: limit ? Math.max(0, limit - enrolled) : null, full: !!limit && enrolled >= limit };
  });
}

// ── Rate limiter ───────────────────────────────────────────────────────────────
const attempts = new Map();
function throttle(key, max = 10) {
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.start > 60000) attempts.delete(k);
  const entry = attempts.get(key) || { start: now, count: 0 };
  entry.count++; attempts.set(key, entry);
  if (entry.count > max || attempts.size > 10000) throw new Error('Too many requests. Please wait one minute.');
}

// ── Admin role ────────────────────────────────────────────────────────────────
async function getAdminRole(email) {
  const admin = await sb.getAdmin(email);
  if (!admin || !admin.active) return '';
  return admin.role || 'admin';
}

// ── RPC Handlers ──────────────────────────────────────────────────────────────
const handlers = {
  async getParticipantNames([search], context) {
    throttle('search:' + context.ip, 60);
    const query = normalizeName(search);
    if (query.length < 2) return [];
    const rows = await sb.getAllParticipants();
    return [...new Set(rows.map(p => p.name))].filter(n => normalizeName(n).includes(query)).slice(0, 40);
  },

  async verifyParticipant([name, credential], context) {
    throttle('login:' + context.ip);
    throttle('identity:' + normalizeName(name));
    const isEmail = String(credential || '').includes('@');
    const rows = await sb.getAllParticipants();
    const matches = rows.filter(p =>
      normalizeName(name) && normalizeName(name) === normalizeName(p.name) &&
      (isEmail ? normalizeEmail(credential) === normalizeEmail(p.email) : phone(credential) && phone(credential) === phone(p.phone))
    );
    if (matches.length !== 1) throw new Error('Verification failed. Check your registered name and contact details.');
    const p = matches[0];
    if (p.registration_on_hold) throw new Error('Registration on hold. Contact the organizer.');
    const identity = JSON.stringify([normalizeName(p.name), normalizeEmail(p.email), phone(p.phone)]);
    const sessionId = sb.createSession('participant', { participantId: p.id, identity });
    return { ok: true, sessionId, participant: { id: p.id, name: p.name } };
  },

  async getParticipantDashboard([id]) {
    const auth = sb.getSession(id, 'participant');
    const p = await sb.getParticipant(auth.participantId);
    if (!p) throw new Error('Session expired. Please log in again.');
    const identity = JSON.stringify([normalizeName(p.name), normalizeEmail(p.email), phone(p.phone)]);
    if (auth.identity !== identity) throw new Error('Session expired. Please log in again.');
    if (p.registration_on_hold) throw new Error('Registration on hold. Contact the organizer.');
    return {
      id: p.id, name: p.name, college: p.college, ticketType: p.ticket_type, registrationType: p.registration_type, track: p.track || '', checkedInAt: p.checked_in_at,
      checkin: { token: p.checkin_token, redeemed: !!p.checkin_redeemed, redeemedAt: p.checked_in_at },
      food: { token: p.food_token, redeemed: !!p.food_redeemed, redeemedAt: p.food_redeemed_at },
      goodie: { token: p.goodie_token, redeemed: !!p.goodie_redeemed, redeemedAt: p.goodie_redeemed_at },
    };
  },

  async logoutParticipant([id]) {
    sb.deleteSession(id, 'participant');
    return { ok: true };
  },

  async adminStatus([email], context) {
    throttle('admin:' + context.ip, 5);
    const normalized = normalizeEmail(email);
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Enter a valid admin email address.');
    const accessRole = await getAdminRole(normalized);
    if (!['admin', 'subadmin'].includes(accessRole)) throw new Error('Access denied. The email is not listed or not active in the Admins sheet.');
    const sessionId = sb.createSession('admin', { email: normalized, loginMode: ADMIN_LOGIN_MODE, accessRole });
    return { authorized: true, email: normalized, accessRole, sessionId };
  },

  async logoutAdmin([id]) {
    sb.deleteSession(id, 'admin');
    return { ok: true };
  },

  async getTrackStats([id]) {
    sb.getSession(id, 'admin');
    return stats();
  },

  async getAdminDashboard([id]) {
    const auth = sb.getSession(id, 'admin');
    const rows = await sb.getAllParticipants();
    const checkedIn = rows.filter(p => p.checkin_redeemed).length;
    const onHold = rows.filter(p => p.registration_on_hold).length;
    const reserved = rows.filter(p => p.track).length;
    const trackStats = await stats();
    return { total: rows.length, checkedIn, notCheckedIn: rows.length - checkedIn, onHold, reserved, tracks: trackStats, accessRole: auth.accessRole };
  },

  async searchAdminParticipants([search, id], context) {
    const auth = sb.getSession(id, 'admin');
    throttle('staff-search:' + context.ip, 60);
    const query = normalizeName(search);
    if (query.length < 2) return [];
    const rows = await sb.getAllParticipants();
    return rows
      .filter(p => p.id.toLowerCase() === query || normalizeName(p.name).includes(query))
      .slice(0, 30)
      .map(p => ({ id: p.id, name: p.name, college: p.college, ticketType: p.ticket_type, onHold: !!p.registration_on_hold, checkedIn: !!p.checkin_redeemed, track: p.track || '' }));
  },

  async manageParticipant([participantId, id, action, value, reason, confirmed]) {
    const auth = sb.getSession(id, 'admin');
    const role = auth.accessRole;
    if ((action === 'track' && role !== 'subadmin') || ((action === 'hold' || action === 'restore') && role !== 'admin'))
      throw new Error(action === 'track' ? 'Only sub-admins can assign tracks.' : 'Only lead admins can put registrations on hold or restore them.');
    if (confirmed !== true || typeof reason !== 'string' || !reason.trim() || reason.length > 500)
      throw new Error('Confirmation and a reason (1–500 characters) are required.');
    const p = await sb.getParticipant(participantId);
    if (!p) throw new Error('Participant not found.');
    if (!['hold', 'restore', 'track'].includes(action)) throw new Error('Invalid management action.');
    const before = { track: p.track || '', onHold: !!p.registration_on_hold };
    const updates = {};
    if (action === 'track') {
      if (p.registration_on_hold) throw new Error('Restore the registration before changing its track.');
      if (!TRACKS.includes(value)) throw new Error('Invalid track.');
      const trackStats = await stats();
      if (p.track !== value && trackStats.find(s => s.track === value).full) throw new Error('This track is full.');
      updates.track = value;
    } else {
      updates.registration_on_hold = action === 'hold';
      if (action === 'hold') sb.deleteParticipantSessions(participantId);
    }
    await sb.updateParticipant(participantId, updates);
    await sb.appendAudit({
      created_at: new Date().toISOString(), admin_email: auth.email, participant_id: participantId,
      action: role + '-' + action, reason: reason.trim(),
      before: JSON.stringify(before), after: JSON.stringify({ track: updates.track || p.track || '', onHold: !!updates.registration_on_hold })
    });
    return { ok: true };
  },

  async manualCheckin([participantId, id, track, confirmed]) {
    sb.getSession(id, 'admin');
    const p = await sb.getParticipant(participantId);
    if (!p) throw new Error('Participant not found.');
    const result = await handlers.redeemQR([p.checkin_token, id, track, confirmed], null, true);
    return { ...result, manualCheckin: true };
  },

  async setTrackLimit([track, limit, id]) {
    const auth = sb.getSession(id, 'admin');
    if (auth.accessRole !== 'admin') throw new Error('Only lead admins can change track capacities.');
    if (!TRACKS.includes(track) || !Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid track capacity.');
    const trackStats = await stats();
    if (limit > 0 && limit < trackStats.find(s => s.track === track).enrolled) throw new Error('Capacity cannot be below the number of seats already reserved or checked in.');
    await sb.setTrackLimit(track, limit);
    return { ok: true, stats: await stats() };
  },

  async redeemQR([token, id, track, confirmed], context, manual = false) {
    const auth = sb.getSession(id, 'admin');
    const rows = await sb.getAllParticipants();
    let found = null, kind = null;
    outer: for (const p of rows) {
      for (const type of ['checkin', 'food', 'goodie']) {
        if (p[type + '_token'] === token) { found = p; kind = type; break outer; }
      }
    }
    if (!found) throw new Error('Invalid QR pass.');
    if (auth.accessRole === 'subadmin' && kind !== 'checkin') throw new Error('Sub-admins can only redeem event check-in passes.');
    if (found.registration_on_hold) throw new Error('Registration on hold. Only a lead admin can restore it.');
    const info = { id: found.id, name: found.name, college: found.college, ticketType: found.ticket_type, registrationType: found.registration_type };
    const type = { checkin: 'Event Check-in', food: 'Lunch & Meals', goodie: 'Swag & Goodie Kit' }[kind];
    const base = { type, participant: info, participantId: found.id, participantName: found.name };
    const redeemedKey = kind + '_redeemed';
    const redeemedAtKey = kind === 'checkin' ? 'checked_in_at' : kind + '_redeemed_at';
    if (found[redeemedKey]) return { ...base, ok: false, alreadyRedeemed: true, redeemedAt: found[redeemedAtKey], track: found.track, message: 'This pass was already redeemed.' };
    if (kind !== 'checkin' && !found.checkin_redeemed) throw new Error('Complete event check-in before collecting food or goodies.');
    if (kind === 'checkin' && found.track) {
      if (confirmed !== true) return { ...base, ok: true, needsConfirmation: true, track: found.track, status: 'Track already reserved' };
      if (track && track !== found.track) throw new Error('The participant has already selected a track. It cannot be changed.');
      track = found.track;
    } else if (kind === 'checkin') {
      if (!TRACKS.includes(track) || confirmed !== true) return { ...base, ok: true, needsTrack: true, canAssignTrack: auth.accessRole === 'subadmin', tracks: TRACKS, trackStats: await stats() };
      if (auth.accessRole !== 'subadmin') throw new Error('Only sub-admins can assign tracks. Ask a sub-admin to assign the participant first.');
      const chosen = (await stats()).find(s => s.track === track);
      if (chosen.full) return { ...base, ok: false, trackFull: true, track, limit: chosen.limit, enrolled: chosen.enrolled, message: 'This track is full.' };
    }
    if (kind !== 'checkin' && confirmed !== true) return { ...base, ok: true, needsConfirmation: true, status: 'Available' };
    const now = new Date().toISOString();
    const updates = { [redeemedKey]: true, [redeemedAtKey]: now };
    if (kind === 'checkin') updates.track = track;
    await sb.updateParticipant(found.id, updates);
    await sb.appendAudit({ created_at: now, admin_email: auth.email, participant_id: found.id, action: manual ? 'manual-checkin' : kind });
    return { ...base, ok: true, track: kind === 'checkin' ? track : found.track, message: 'Pass successfully redeemed.' };
  }
};

// ── HTTP server ───────────────────────────────────────────────────────────────
async function rpc(method, args = [], context = { ip: 'local' }) {
  if (!Object.hasOwn(handlers, method) || !Array.isArray(args)) throw new Error('Unknown request.');
  return handlers[method](args, context);
}

const httpHandler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderHtml(fs.readFileSync(path.join(__dirname, 'Index.html'), 'utf8'), url.searchParams.get('page')));
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST' || url.pathname !== '/api/rpc') { res.writeHead(404); return res.end(); }
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) { res.writeHead(403); return res.end(); } }
    catch { res.writeHead(403); return res.end(); }
  }
  try {
    let input;
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 16384) { res.writeHead(413); return res.end(); } chunks.push(Buffer.from(chunk)); }
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object') throw new Error('Invalid request.');
    const data = await rpc(input.method, input.args, { ip: req.socket?.remoteAddress || 'unknown' });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data }));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message }));
  }
};

// ── Vercel serverless entry ───────────────────────────────────────────────────
async function vercelHandler(req, res) {
  return httpHandler(req, res);
}

// ── Local dev entry ───────────────────────────────────────────────────────────
async function main() {
  // Test Supabase connection on startup
  try {
    await sb.getAllParticipants();
    console.log('✅ Supabase connected successfully.');
  } catch (e) {
    console.error('❌ Supabase connection failed:', e.message);
    process.exitCode = 1; return;
  }
  const server = http.createServer(httpHandler);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(Number(process.env.PORT || 3000), () => console.log('Portal listening on port ' + (process.env.PORT || 3000)));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); process.exit(); });
}

if (require.main === module && !process.env.VERCEL) main().catch(error => { console.error('Startup failed: ' + error.message); process.exitCode = 1; });
module.exports = Object.assign(vercelHandler, { rpc, renderHtml });
