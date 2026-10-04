const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TRACKS = ['Track A', 'Track B', 'Track C', 'Track D'];

const CSV_FILE = path.join(__dirname, 'Untitled spreadsheet - All Participants.csv');
// Persist generated QR tokens across restarts
const TOKEN_STORE_FILE = path.join(__dirname, 'participant_tokens.json');
// Persist track capacity limits (admin-configurable)
const TRACK_LIMITS_FILE = path.join(__dirname, 'track_limits.json');

// ─── Track Limits Store ───────────────────────────────────────────────────────

function loadTrackLimits() {
  try {
    if (fs.existsSync(TRACK_LIMITS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TRACK_LIMITS_FILE, 'utf8'));
      // Ensure every track has an entry
      TRACKS.forEach(t => { if (!(t in data)) data[t] = 0; });
      return data;
    }
  } catch (e) { /* ignore */ }
  // Default: 0 = unlimited for all tracks
  return Object.fromEntries(TRACKS.map(t => [t, 0]));
}

function saveTrackLimits(limits) {
  try {
    fs.writeFileSync(TRACK_LIMITS_FILE, JSON.stringify(limits, null, 2), 'utf8');
  } catch (e) { console.error('Failed to save track limits:', e.message); }
}

// Mutable limits object (mutated by setTrackLimit RPC)
const trackLimits = loadTrackLimits();

// ─── CSV Parsing (zero dependencies) ─────────────────────────────────────────

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsv(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (values[i] || '').trim(); });
    return obj;
  });
}

// ─── Token Store (persisted to disk) ─────────────────────────────────────────

function loadTokenStore() {
  try {
    if (fs.existsSync(TOKEN_STORE_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_STORE_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveTokenStore(store) {
  try {
    fs.writeFileSync(TOKEN_STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) { console.error('Failed to save token store:', e.message); }
}

function newToken(prefix, id) {
  return `${id}-${prefix}`;
}

// ─── Load Participants from CSV ───────────────────────────────────────────────

function loadParticipants() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌ CSV not found: ${CSV_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(CSV_FILE, 'utf8');
  const rows = parseCsv(content);

  // Load persisted QR tokens
  const tokenStore = loadTokenStore();
  let tokenStoreModified = false;

  const participants = rows
    .filter(r => r['Name'] && r['Name'].trim())
    .map(r => {
      const id = (r['Registration ID'] || '').trim();
      const name = r['Name'].trim();
      const email = (r['Email'] || '').trim();
      const phone = (r['Mobile Number'] || '').trim();

      const defaultCheckin = `${id}-CHK`;
      const defaultFood = `${id}-FOD`;
      const defaultGoodie = `${id}-GDK`;

      if (!tokenStore[id]) {
        tokenStore[id] = {
          checkinToken: defaultCheckin,
          foodToken: defaultFood,
          goodieToken: defaultGoodie,
          checkinRedeemed: false,
          foodRedeemed: false,
          goodieRedeemed: false,
          track: '',
          checkedInAt: '',
          foodRedeemedAt: '',
          goodieRedeemedAt: ''
        };
        tokenStoreModified = true;
      } else {
        // Upgrade legacy long hex tokens to clean readable codes
        if (!tokenStore[id].checkinToken || tokenStore[id].checkinToken.startsWith('CHK-')) {
          tokenStore[id].checkinToken = defaultCheckin;
          tokenStore[id].foodToken = defaultFood;
          tokenStore[id].goodieToken = defaultGoodie;
          tokenStoreModified = true;
        }
      }

      return {
        id,
        name,
        email,
        phone,
        college: (r['College / Institution'] || '').trim(),
        registrationType: (r['Registration Type'] || '').trim(),
        ticketType: (r['Ticket Type'] || '').trim(),
        ...tokenStore[id],
        // Keep a reference so mutations are reflected in tokenStore
        _storeRef: tokenStore[id]
      };
    });

  if (tokenStoreModified) {
    saveTokenStore(tokenStore);
    console.log(`📝 Updated QR pass codes for participants in ${TOKEN_STORE_FILE}`);
  }

  console.log(`✅ Loaded ${participants.length} participants from CSV`);
  return { participants, tokenStore };
}

const { participants, tokenStore } = loadParticipants();

// Helper: flush state mutation to disk
function persistParticipant(participant) {
  const ref = participant._storeRef;
  if (!ref) return;
  ref.checkinRedeemed = participant.checkinRedeemed;
  ref.foodRedeemed = participant.foodRedeemed;
  ref.goodieRedeemed = participant.goodieRedeemed;
  ref.track = participant.track;
  ref.checkedInAt = participant.checkedInAt;
  ref.foodRedeemedAt = participant.foodRedeemedAt;
  ref.goodieRedeemedAt = participant.goodieRedeemedAt;
  saveTokenStore(tokenStore);
}

// ─── Admin List ───────────────────────────────────────────────────────────────

const admins = [
  { email: 'admin@example.com', name: 'Lead Admin', active: true },
  { email: 'scanner@example.com', name: 'Scanner Desk', active: true }
];

const activeSessions = new Map();

// ─── Normalization Helpers ────────────────────────────────────────────────────

function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}
function normalizeDigits(s) {
  return String(s || '').replace(/\D/g, '');
}
function phonesMatch(p1, p2) {
  const d1 = normalizeDigits(p1);
  const d2 = normalizeDigits(p2);
  if (!d1 || !d2) return false;
  if (d1 === d2) return true;
  if (d1.length >= 10 && d2.length >= 10) {
    return d1.slice(-10) === d2.slice(-10);
  }
  return false;
}
function formatNow() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function levenshteinDistance(s1, s2) {
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

function wordsMatchOrSimilar(w1, w2) {
  if (w1 === w2) return true;
  if (w1.includes(w2) || w2.includes(w1)) return true;
  const maxLen = Math.max(w1.length, w2.length);
  if (maxLen <= 3) return w1 === w2;
  const dist = levenshteinDistance(w1, w2);
  return dist <= (maxLen > 6 ? 2 : 1);
}

function namesAreSimilar(inputName, registeredName) {
  const n1 = normalizeName(inputName);
  const n2 = normalizeName(registeredName);
  if (n1 === n2) return true;
  if (n1.includes(n2) || n2.includes(n1)) return true;

  const t1 = n1.split(/\s+/).filter(Boolean);
  const t2 = n2.split(/\s+/).filter(Boolean);

  const allT1Matched = t1.length > 0 && t1.every(w1 => t2.some(w2 => wordsMatchOrSimilar(w1, w2)));
  if (allT1Matched) return true;

  const anyTokenMatch = t1.some(w1 => w1.length >= 3 && t2.some(w2 => wordsMatchOrSimilar(w1, w2)));
  if (anyTokenMatch) {
    const totalDist = levenshteinDistance(n1, n2);
    if (totalDist <= Math.max(3, Math.floor(Math.max(n1.length, n2.length) * 0.35))) {
      return true;
    }
  }

  return false;
}

function namesMatchForLogin(inputName, registeredName) {
  const n1 = normalizeName(inputName);
  const n2 = normalizeName(registeredName);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;
  const t1 = n1.split(/\s+/).filter(Boolean);
  const t2 = n2.split(/\s+/).filter(Boolean);
  const forward = t1.every(w1 => t2.some(w2 => wordsMatchOrSimilar(w1, w2)));
  const backward = t2.every(w2 => t1.some(w1 => wordsMatchOrSimilar(w1, w2)));
  return forward && backward;
}

// ─── Track Stats Helper ──────────────────────────────────────────────────────

function computeTrackStats() {
  const counts = Object.fromEntries(TRACKS.map(t => [t, 0]));
  for (const p of participants) {
    if (p.checkinRedeemed && p.track && counts[p.track] !== undefined) {
      counts[p.track]++;
    }
  }
  return TRACKS.map(t => ({
    track: t,
    enrolled: counts[t],
    limit: trackLimits[t] || 0,          // 0 = unlimited
    available: trackLimits[t] > 0
      ? Math.max(0, trackLimits[t] - counts[t])
      : null,                             // null = unlimited
    full: trackLimits[t] > 0 && counts[t] >= trackLimits[t]
  }));
}

// ─── RPC Handlers ─────────────────────────────────────────────────────────────

const rpcHandlers = {

  getParticipantNames: async ([search]) => {
    const q = normalizeName(search);
    const names = participants.map(p => p.name.trim());
    const unique = [...new Set(names)];
    if (!q) return unique.slice(0, 50);

    const directMatches = unique.filter(n => normalizeName(n).includes(q));
    const fuzzyMatches = unique.filter(n => !directMatches.includes(n) && namesAreSimilar(q, n));
    return [...directMatches, ...fuzzyMatches].slice(0, 50);
  },

  verifyParticipant: async ([name, credential]) => {
    const inputName = String(name || '').trim();
    const cred = String(credential || '').trim();

    if (!inputName) throw new Error('Please select or search your registered name.');
    if (!cred) throw new Error('Please enter your registered email or phone number.');

    const isEmailInput = cred.includes('@');
    const normalizedInputEmail = normalizeEmail(cred);

    const credentialMatches = p => {
      const emailMatches = isEmailInput && normalizeEmail(p.email) === normalizedInputEmail;
      const phoneMatches = phonesMatch(cred, p.phone);
      return emailMatches || phoneMatches;
    };

    const matched = participants.find(p => credentialMatches(p) && namesMatchForLogin(inputName, p.name));

    if (!matched) {
      const nameExists = participants.some(p => namesAreSimilar(inputName, p.name));
      if (!nameExists) {
        throw new Error('Name not found in the registration list. Please check the spelling and try again.');
      }
      throw new Error('Verification failed. Please check that the selected name matches the entered email or phone number.');
    }

    const sessionId = crypto.randomUUID();
    activeSessions.set(sessionId, {
      participantId: matched.id,
      name: matched.name,
      expiresAt: Date.now() + 3600_000 // 1 hour
    });

    return {
      ok: true,
      sessionId,
      participant: { id: matched.id, name: matched.name }
    };
  },

  getParticipantDashboard: async ([sessionId]) => {
    const session = activeSessions.get(sessionId);
    if (!session || Date.now() > session.expiresAt) {
      throw new Error('Session expired. Please log in again.');
    }

    const p = participants.find(pt => pt.id === session.participantId);
    if (!p) throw new Error('Participant record not found.');

    return {
      id: p.id,
      name: p.name,
      college: p.college,
      registrationType: p.registrationType,
      ticketType: p.ticketType,
      track: p.track || '',
      checkedInAt: p.checkedInAt,
      checkin: { redeemed: p.checkinRedeemed, token: p.checkinToken, redeemedAt: p.checkedInAt },
      food:   { redeemed: p.foodRedeemed,    token: p.foodToken,    redeemedAt: p.foodRedeemedAt },
      goodie: { redeemed: p.goodieRedeemed,  token: p.goodieToken,  redeemedAt: p.goodieRedeemedAt }
    };
  },

  adminStatus: async ([email]) => {
    const inputEmail = normalizeEmail(email || '');
    const admin = admins.find(a => normalizeEmail(a.email) === inputEmail && a.active);
    return { authorized: !!admin, email: inputEmail };
  },

  // Returns live track stats: enrolled count, limit, available spots
  getTrackStats: async () => {
    return computeTrackStats();
  },

  // Admin sets capacity limit for a track (0 = unlimited)
  setTrackLimit: async ([track, limit]) => {
    if (!TRACKS.includes(track)) throw new Error(`Unknown track: ${track}`);
    const cap = parseInt(limit, 10);
    if (isNaN(cap) || cap < 0) throw new Error('Limit must be a non-negative integer (0 = unlimited).');
    trackLimits[track] = cap;
    saveTrackLimits(trackLimits);
    return { ok: true, track, limit: cap, stats: computeTrackStats() };
  },

  redeemQR: async ([token, adminEmail, track, confirmAction]) => {
    const raw = String(token || '').trim();
    if (!raw) throw new Error('No QR token received.');

    const cleanToken = raw.toUpperCase();
    let found = null;
    let type = '';

    for (const p of participants) {
      const pId = p.id.toUpperCase();
      const pChk = p.checkinToken.toUpperCase();
      const pFod = p.foodToken.toUpperCase();
      const pGdk = p.goodieToken.toUpperCase();

      if (cleanToken === pChk || cleanToken === `${pId}-CHK` || cleanToken === `${pId}:CHK`) {
        found = p; type = 'CHECKIN'; break;
      }
      if (cleanToken === pFod || cleanToken === `${pId}-FOD` || cleanToken === `${pId}:FOD`) {
        found = p; type = 'FOOD'; break;
      }
      if (cleanToken === pGdk || cleanToken === `${pId}-GDK` || cleanToken === `${pId}:GDK`) {
        found = p; type = 'GOODIE'; break;
      }
      // If direct registration ID was passed
      if (cleanToken === pId) {
        found = p; type = 'CHECKIN'; break;
      }
    }

    if (!found) {
      throw new Error(`Invalid Pass Code (${token}). Not found in registration list.`);
    }

    const participantInfo = {
      id: found.id,
      name: found.name,
      college: found.college,
      ticketType: found.ticketType,
      registrationType: found.registrationType,
      email: found.email,
      phone: found.phone
    };

    if (type === 'CHECKIN') {
      if (found.checkinRedeemed) {
        return {
          ok: false,
          alreadyRedeemed: true,
          type: 'Event Check-in',
          participant: participantInfo,
          participantName: found.name,
          participantId: found.id,
          redeemedAt: found.checkedInAt || 'earlier',
          track: found.track || '',
          message: `Already Checked In at ${found.checkedInAt || 'earlier'}${found.track ? ' · Track: ' + found.track : ''}`
        };
      }
      if (!track || !TRACKS.includes(track)) {
        return {
          ok: true,
          needsTrack: true,
          type: 'Event Check-in',
          participant: participantInfo,
          tracks: TRACKS,
          trackStats: computeTrackStats()  // include live counts + limits
        };
      }
      // Enforce track capacity limit
      const stats = computeTrackStats();
      const chosen = stats.find(s => s.track === track);
      if (chosen && chosen.full) {
        return {
          ok: false,
          trackFull: true,
          type: 'Event Check-in',
          participant: participantInfo,
          track,
          limit: chosen.limit,
          enrolled: chosen.enrolled,
          message: `${track} is at full capacity (${chosen.enrolled}/${chosen.limit}). Please assign a different track.`
        };
      }
      const ts = formatNow();
      found.checkinRedeemed = true;
      found.track = track;
      found.checkedInAt = ts;
      persistParticipant(found);
      return {
        ok: true,
        type: 'Event Check-in',
        participant: participantInfo,
        participantId: found.id,
        participantName: found.name,
        track,
        message: `Successfully checked in and assigned to ${track}.`
      };
    }

    if (type === 'FOOD') {
      if (found.foodRedeemed) {
        return {
          ok: false,
          alreadyRedeemed: true,
          type: 'Lunch & Meals',
          participant: participantInfo,
          participantName: found.name,
          participantId: found.id,
          redeemedAt: found.foodRedeemedAt || 'earlier',
          message: `Meal was already redeemed at ${found.foodRedeemedAt || 'earlier'}`
        };
      }
      if (!confirmAction) {
        return {
          ok: true,
          needsConfirmation: true,
          type: 'Lunch & Meals',
          participant: participantInfo,
          status: 'Available'
        };
      }
      const ts = formatNow();
      found.foodRedeemed = true;
      found.foodRedeemedAt = ts;
      persistParticipant(found);
      return {
        ok: true,
        type: 'Lunch & Meals',
        participant: participantInfo,
        participantId: found.id,
        participantName: found.name,
        message: 'Lunch voucher successfully redeemed.'
      };
    }

    if (type === 'GOODIE') {
      if (found.goodieRedeemed) {
        return {
          ok: false,
          alreadyRedeemed: true,
          type: 'Swag & Goodie Kit',
          participant: participantInfo,
          participantName: found.name,
          participantId: found.id,
          redeemedAt: found.goodieRedeemedAt || 'earlier',
          message: `Goodie Kit was already redeemed at ${found.goodieRedeemedAt || 'earlier'}`
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
      const ts = formatNow();
      found.goodieRedeemed = true;
      found.goodieRedeemedAt = ts;
      persistParticipant(found);
      return {
        ok: true,
        type: 'Swag & Goodie Kit',
        participant: participantInfo,
        participantId: found.id,
        participantName: found.name,
        message: 'Goodie kit successfully redeemed.'
      };
    }

    throw new Error('Unknown QR type.');
  }
};

// ─── HTML Template Renderer ───────────────────────────────────────────────────

function renderHtml(templateHtml, page) {
  const isParticipant = page !== 'admin';
  let rendered = templateHtml;

  // Process <? if (page === 'participant') { ?> ... <? } else { ?> ... <? } ?>
  const conditionalRegex = /<\?\s*if\s*\(\s*page\s*===\s*'participant'\s*\)\s*\{\s*\?>([\s\S]*?)<\?\s*\}\s*else\s*\{\s*\?>([\s\S]*?)<\?\s*\}\s*\?>/g;
  rendered = rendered.replace(conditionalRegex, (_, participantBlock, adminBlock) =>
    isParticipant ? participantBlock : adminBlock
  );

  // Process track loops
  const trackLoopRegex = /<\?\s*for\s*\([^?]+\)\s*\{\s*\?>\s*<option><\?=\s*tracks\[i\]\s*\?><\/option>\s*<\?\s*\}\s*\?>/g;
  rendered = rendered.replace(trackLoopRegex, () =>
    TRACKS.map(t => `<option>${t}</option>`).join('')
  );

  // Process page badge <?= page === 'admin' ? 'Admin Scanner' : 'Participant' ?>
  rendered = rendered.replace(/<\?=\s*page\s*===\s*'admin'\s*\?\s*'Admin Scanner'\s*:\s*'Participant'\s*\?>/g,
    isParticipant ? 'Participant' : 'Admin Scanner'
  );

  // Small top-right corner link (admin de-emphasized, participant portal centric)
  const navHtml = isParticipant
    ? `<a href="/?page=admin" class="corner-link" title="Admin scanner">Admin</a>`
    : `<a href="/" class="corner-link" title="Back to participant portal">&larr; Participant Portal</a>`;

  // google.script.run polyfill
  const polyfillScript = `
  <script>
    (function() {
      function createRunner(successHandler, failureHandler) {
        return new Proxy({}, {
          get(target, prop) {
            if (prop === 'withSuccessHandler') return (fn) => createRunner(fn, failureHandler);
            if (prop === 'withFailureHandler') return (fn) => createRunner(successHandler, fn);
            return async (...args) => {
              try {
                const res = await fetch('/api/rpc', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ method: prop, args })
                });
                const json = await res.json();
                if (json.ok) { if (successHandler) successHandler(json.data); }
                else { if (failureHandler) failureHandler(new Error(json.error || 'Server error')); else console.error(json.error); }
              } catch (err) {
                if (failureHandler) failureHandler(err); else console.error(err);
              }
            };
          }
        });
      }
      window.google = window.google || {};
      window.google.script = window.google.script || {};
      window.google.script.run = createRunner();
    })();
  </script>`;

  rendered = rendered.replace('</head>', polyfillScript + '\n</head>');
  rendered = rendered.replace(/<div id="topRight">[\s\S]*?<\/div>/, `<div id="topRight">${navHtml}</div>`);
  return rendered;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/rpc' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { method, args = [] } = JSON.parse(body || '{}');
        const handler = rpcHandlers[method];
        if (!handler) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Unknown RPC method: ${method}` }));
          return;
        }
        const data = await handler(args);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message || 'Operation failed' }));
      }
    });
    return;
  }

  if (pathname === '/') {
    const page = parsedUrl.searchParams.get('page') || 'participant';
    try {
      const template = fs.readFileSync(path.join(__dirname, 'Index.html'), 'utf8');
      const html = renderHtml(template, page);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading Index.html: ' + err.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

function startServer(port) {
  server.listen(port, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Event QR Portal — Real Data (${participants.length} participants)`);
    console.log(`🔗 Participant View: http://localhost:${port}`);
    console.log(`🔗 Admin Scanner:    http://localhost:${port}/?page=admin`);
    console.log(`==================================================\n`);
  });
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    const next = PORT === 3000 ? 8080 : PORT + 1;
    console.log(`Port ${PORT} busy. Trying ${next}...`);
    startServer(next);
  } else { console.error(err); }
});

startServer(PORT);
