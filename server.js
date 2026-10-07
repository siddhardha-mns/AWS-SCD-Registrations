const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StateStore } = require('./state-store');

const TRACKS = ['Track A', 'Track B', 'Track C', 'Track D'];
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
const redeemed = value => value === true || value instanceof Date || /^(true|yes|1)$/i.test(String(value)) || /^\d{4}-\d{2}-\d{2}/.test(String(value));
function field(row, ...names) {
  for (const name of names) {
    const key = Object.keys(row).find(k => k.trim().toLowerCase() === name.toLowerCase());
    if (key !== undefined && row[key] !== null && row[key] !== undefined && String(row[key]).trim()) return String(row[key]).trim();
  }
  return '';
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(v => v.trim())) rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() || []).map(h => h.replace(/^\uFEFF/, '').trim());
  return rows.map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] || ''])));
}
function extractRows(payload) {
  if (payload && payload.ok === false) throw new Error('Participant source rejected the request.');
  const rows = Array.isArray(payload) ? payload : payload && (payload.participants || payload.rows || payload.data || payload.values);
  if (!Array.isArray(rows)) throw new Error('Invalid participant source.');
  if (Array.isArray(rows[0])) return rows.slice(1).map(r => Object.fromEntries(rows[0].map((h, i) => [h, r[i]])));
  return rows;
}
function prepareRows(rows) {
  const ids = new Set();
  return rows.filter(r => r && field(r, 'Participant Name', 'Name')).map(r => {
    const name = field(r, 'Participant Name', 'Name');
    const email = field(r, 'Email', 'Email Address');
    const mobile = field(r, 'Mobile Number (WhatsApp)', 'Mobile Number', 'Phone Number', 'Phone', 'Mobile');
    const explicitId = field(r, 'Registration ID', 'Participant ID', 'ID');
    const id = explicitId || 'P-' + crypto.createHash('sha256').update(JSON.stringify([normalizeName(name), normalizeEmail(email), phone(mobile)])).digest('hex').slice(0, 32);
    const legacyId = explicitId || 'P-' + crypto.createHash('sha1').update(normalizeEmail(email || name)).digest('hex').slice(0, 8).toUpperCase();
    if (ids.has(id) || ['__proto__','constructor','prototype'].includes(id)) throw new Error('Duplicate or invalid participant ID: fix the source before serving tickets.');
    ids.add(id);
    return { id, legacyId, name, email, phone: mobile, college: field(r, 'College / Institution', 'College', 'Institution'), ticketType: field(r, 'Ticket Type'), registrationType: field(r, 'Registration Type'), source: r };
  });
}
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
function bridgeRequest(url, key, method, args) {
  const payload = JSON.stringify({method, args, timestamp: Date.now(), nonce: crypto.randomBytes(16).toString('hex')});
  const signature = crypto.createHmac('sha256', key).update(payload).digest('hex');
  const body = JSON.stringify({payload, signature});
  return new Promise((resolve, reject) => {
    const address = new URL(url);
    if (address.protocol !== 'https:') return reject(new Error('Bridge requires HTTPS.'));
    const request = https.request(address, {method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}, timeout:20000}, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); return readRedirect(new URL(response.headers.location, address), 5, resolve, reject);
      }
      collect(response, resolve, reject);
    });
    request.on('timeout', () => request.destroy(new Error('Bridge timed out.')));
    request.on('error', reject); request.end(body);
  });
}
function collect(response, resolve, reject) {
  if (response.statusCode !== 200) { response.resume(); return reject(new Error('Bridge request failed.')); }
  let text = ''; response.setEncoding('utf8');
  response.on('data', chunk => { text += chunk; if (text.length > 2_000_000) response.destroy(new Error('Bridge response too large.')); });
  response.on('error', reject);
  response.on('end', () => { try { const result = JSON.parse(text); if (!result.ok) throw new Error(result.error || 'Bridge rejected request.'); resolve(result.data); } catch (error) { reject(error); } });
}
function readRedirect(url, remaining, resolve, reject) {
  if (url.protocol !== 'https:' || remaining < 0) return reject(new Error('Invalid bridge redirect.'));
  const request = https.get(url, {timeout:20000}, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) { response.resume(); return readRedirect(new URL(response.headers.location, url), remaining - 1, resolve, reject); }
    collect(response, resolve, reject);
  });
  request.on('timeout', () => request.destroy(new Error('Bridge timed out.'))); request.on('error', reject);
}

async function createApp(config = {}) {
  const remote = config.PARTICIPANTS_URL;
  const serverless = config.SERVERLESS === true;
  if(serverless&&!remote)throw new Error('Set PARTICIPANTS_URL in Vercel Environment Variables to your Apps Script /exec URL.');
  const catalog = config.TRACK_CATALOG || [];
  const tracks = catalog.length ? catalog.map(t=>t.id) : TRACKS;
  if (new Set(tracks).size !== tracks.length || tracks.some(id=>typeof id!=='string'||!id.trim()||['__proto__','constructor','prototype'].includes(id))) throw new Error('Invalid track catalog.');
  if (remote && (!config.BRIDGE_SECRET || config.BRIDGE_SECRET.length < 32)) throw new Error('A BRIDGE_SECRET of at least 32 characters is required for Google Sheets mode. Redeploy Code.gs first.');
  const store = serverless ? {data:{sessions:{}},close(){}} : new StateStore(config.STATE_DIR || path.join(__dirname, '.runtime'));
  const attempts = new Map();
  let people = [], lastRefresh = 0, refreshing;
  function throttle(key, max = 10) {
    const now = Date.now();
    for (const [k, value] of attempts) if (now - value.start > 60000) attempts.delete(k);
    const entry = attempts.get(key) || {start:now, count:0};
    entry.count++; attempts.set(key, entry);
    if (entry.count > max || attempts.size > 10000) throw new Error('Too many requests. Please wait one minute.');
  }
  function session(id, role) {
    if(remote&&role==='admin'){
      if(typeof id!=='string'||!/^[-a-zA-Z0-9]{64,100}$/.test(id))throw new Error('Session expired. Please log in again.');
      return {bridgeSessionId:id}; // Every privileged action validates this in the shared backend.
    }
    const value = Object.hasOwn(store.data.sessions,id) ? store.data.sessions[id] : null;
    if (!value || value.expiresAt <= Date.now()) {
      if (value) store.transaction(data => { delete data.sessions[id]; });
      throw new Error('Session expired. Please log in again.');
    }
    if (value.role !== role) throw new Error('Session expired. Please log in again.');
    if (role === 'admin' && value.loginMode !== ADMIN_LOGIN_MODE) throw new Error('Session expired. Please log in again.');
    if (role === 'admin') value.accessRole = localAdminRole(value.email);
    if (role === 'admin' && !['admin','subadmin'].includes(value.accessRole)) throw new Error('Admin authentication required.');
    return value;
  }
  function localAdminRole(email){
    if(Object.hasOwn(config.ADMIN_ROLES||{},email))return config.ADMIN_ROLES[email];
    return Object.hasOwn(config.ADMIN_CREDENTIALS||{},email)?'admin':'';
  }
  function newSession(role, identity) {
    const id = crypto.randomBytes(32).toString('hex');
    store.transaction(data => {
      for (const [key, value] of Object.entries(data.sessions)) if (value.expiresAt <= Date.now()) delete data.sessions[key];
      data.sessions[id] = {role, ...identity, expiresAt:Date.now() + 3600000};
    });
    return id;
  }
  async function refresh(force = false) {
    if (remote || (!force && Date.now() - lastRefresh < 30000)) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const filename = path.resolve(config.PARTICIPANTS_FILE || path.join(__dirname, 'participants.csv'));
      if (!fs.existsSync(filename)) throw new Error('Configure PARTICIPANTS_FILE before starting the local portal.');
      const text = fs.readFileSync(filename, 'utf8');
      const next = prepareRows(filename.endsWith('.json') ? extractRows(JSON.parse(text)) : parseCsv(text));
      const legacyPath = config.LEGACY_STATE_FILE || path.join(__dirname, 'participant_tokens.json');
      const legacy = fs.existsSync(legacyPath) ? JSON.parse(fs.readFileSync(legacyPath, 'utf8')) : {};
      const legacyLimitsPath = config.LEGACY_LIMITS_FILE || path.join(__dirname, 'track_limits.json');
      const legacyLimits = fs.existsSync(legacyLimitsPath) ? JSON.parse(fs.readFileSync(legacyLimitsPath,'utf8')) : {};
      store.transaction(data => {
        for (const track of tracks) if (!Object.hasOwn(data.limits,track)) {
          const configured=catalog.find(t=>t.id===track)?.capacity;
          const limit=Number.isSafeInteger(configured)?configured:legacyLimits[track];
          if(Number.isSafeInteger(limit)&&limit>=0)data.limits[track]=limit;
        }
        for (const p of next) {
          let state = Object.hasOwn(data.participants,p.id) ? data.participants[p.id] : null;
          if (!state) {
            if (legacy[p.legacyId] && next.filter(other=>other.legacyId===p.legacyId).length > 1) throw new Error('Legacy participants shared an ID. Assign unique IDs and reconcile redemption flags before migration.');
            state = data.participants[p.id] = {...legacy[p.id] || legacy[p.legacyId], checkinToken:newToken(), foodToken:newToken(), goodieToken:newToken()};
          }
          for(const kind of ['checkin','food','goodie'])if(!/^v4-[a-f0-9]{32}$/.test(state[kind+'Token']||''))state[kind+'Token']=newToken();
          for (const [kind, header] of [['checkin','Checkin'],['food','Food'],['goodie','Goodie']]) {
            state[kind + 'Redeemed'] = redeemed(state[kind + 'Redeemed']) || redeemed(field(p.source, header + ' Redeemed'));
            const timeKey = kind === 'checkin' ? 'checkedInAt' : kind + 'RedeemedAt';
            state[timeKey] = state[timeKey] || field(p.source, kind === 'checkin' ? 'Checked In At' : header + ' Redeemed At');
          }
          state.track = state.track || field(p.source, 'Track');
        }
      });
      people = next; lastRefresh = Date.now();
    })();
    try { await refreshing; } finally { refreshing = null; }
  }
  function stats(data = store.data) {
    return tracks.map(track => {
      const assigned = people.filter(p => data.participants[p.id].track === track);
      const enrolled = assigned.length;
      const checkedIn = assigned.filter(p=>data.participants[p.id].checkinRedeemed).length;
      const limit = data.limits[track] || 0;
      return {track, enrolled, reserved:enrolled,checkedIn, limit, available:limit ? Math.max(0,limit-enrolled) : null, full:!!limit && enrolled >= limit};
    });
  }
  const forward = (method, args) => bridgeRequest(remote, config.BRIDGE_SECRET, method, args);
  const forwardAdmin = (auth, method, args) => forward('bridgeAdminRpc',[auth.bridgeSessionId,ADMIN_SESSION_VERSION,method,args]);
  async function importRemoteLegacy() {
    if (!remote || serverless) return;
    const file = config.LEGACY_STATE_FILE || path.join(__dirname,'participant_tokens.json');
    const legacy = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
    const records = Object.entries(legacy).filter(([,p])=>['checkin','food','goodie'].some(k=>redeemed(p[k+'Redeemed']))).map(([id,p])=>({id,checkinRedeemed:redeemed(p.checkinRedeemed),foodRedeemed:redeemed(p.foodRedeemed),goodieRedeemed:redeemed(p.goodieRedeemed),track:p.track||'',checkedInAt:p.checkedInAt||'',foodRedeemedAt:p.foodRedeemedAt||'',goodieRedeemedAt:p.goodieRedeemedAt||''}));
    for (let i=0;i<records.length;i+=10) await forward('bridgeImportLegacyState',[records.slice(i,i+10)]);
    const limitFile=config.LEGACY_LIMITS_FILE || path.join(__dirname,'track_limits.json');
    if(fs.existsSync(limitFile))await forward('bridgeImportLegacyLimits',[JSON.parse(fs.readFileSync(limitFile,'utf8'))]);
  }
  const handlers = {
    async getParticipantNames([search], context) {
      throttle('search:' + context.ip, 60);
      if (remote) return forward('getParticipantNames', [search]);
      const query = normalizeName(search);
      if (query.length < 2) return [];
      return [...new Set(people.map(p => p.name))].filter(n => normalizeName(n).includes(query)).slice(0,40);
    },
    async verifyParticipant([name, credential], context) {
      throttle('login:' + context.ip); throttle('identity:' + normalizeName(name));
      if (remote) return forward('verifyParticipant', [name, credential]);
      const isEmail = String(credential || '').includes('@');
      const matches = people.filter(p => normalizeName(name) && normalizeName(name) === normalizeName(p.name) && (isEmail ? normalizeEmail(credential) === normalizeEmail(p.email) : phone(credential) && phone(credential) === phone(p.phone)));
      if (matches.length !== 1) throw new Error('Verification failed. Check your registered name and contact details.');
      const p = matches[0];
      if(store.data.participants[p.id].onHold)throw new Error('Registration on hold. Contact the organizer.');
      return {ok:true,sessionId:newSession('participant', {participantId:p.id,identity:JSON.stringify([normalizeName(p.name),normalizeEmail(p.email),phone(p.phone)])}),participant:{id:p.id,name:p.name}};
    },
    async getParticipantDashboard([id]) {
      if (remote) return forward('getParticipantDashboard', [id]);
      const auth = session(id, 'participant');
      const p = people.find(p => p.id === auth.participantId);
      if (!p || auth.identity !== JSON.stringify([normalizeName(p.name),normalizeEmail(p.email),phone(p.phone)])) throw new Error('Session expired. Please log in again.');
      const state = store.data.participants[p.id];
      if(state.onHold)throw new Error('Registration on hold. Contact the organizer.');
      const result = {id:p.id,name:p.name,college:p.college,ticketType:p.ticketType,registrationType:p.registrationType,track:state.track || '',checkedInAt:state.checkedInAt};
      for (const kind of ['checkin','food','goodie']) result[kind] = {token:state[kind+'Token'],redeemed:!!state[kind+'Redeemed'],redeemedAt:state[kind==='checkin'?'checkedInAt':kind+'RedeemedAt']};
      return result;
    },
    async logoutParticipant([id]) {
      if (remote) return forward('logoutParticipant', [id]);
      store.transaction(data => { if (data.sessions[id]?.role === 'participant') delete data.sessions[id]; }); return {ok:true};
    },
    async adminStatus([email], context) {
      throttle('admin:' + context.ip, 5);
      const normalized=normalizeEmail(email);
      if(normalized.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))throw new Error('Enter a valid admin email address.');
      const remoteIdentity = remote ? await forward('bridgeCreateAdminSession',[normalized,ADMIN_SESSION_VERSION]) : null;
      const accessRole = remoteIdentity ? remoteIdentity.accessRole : localAdminRole(normalized);
      if (!['admin','subadmin'].includes(accessRole)) throw new Error('Access denied. The email is not listed or not active in the Admins sheet.');
      return {authorized:true,email:normalized,accessRole,sessionId:remote?remoteIdentity.sessionId:newSession('admin',{email:normalized,loginMode:ADMIN_LOGIN_MODE,accessRole})};
    },
    async logoutAdmin([id]) { if(remote){session(id,'admin');return forward('bridgeLogoutAdminSession',[id,ADMIN_SESSION_VERSION]);}store.transaction(data => { if (data.sessions[id]?.role === 'admin') delete data.sessions[id]; }); return {ok:true}; },
    async getTrackStats([id]) { const auth=session(id,'admin'); if(remote) return forwardAdmin(auth,'bridgeGetTrackStats',[auth.email]); return stats(); },
    async getAdminDashboard([id]) {
      const auth=session(id,'admin');
      if(remote)return forwardAdmin(auth,'bridgeGetAdminDashboard',[auth.email]);
      const checkedIn=people.filter(p=>store.data.participants[p.id].checkinRedeemed).length;
      const onHold=people.filter(p=>store.data.participants[p.id].onHold).length;
      const reserved=people.filter(p=>store.data.participants[p.id].track).length;
      return {total:people.length,checkedIn,notCheckedIn:people.length-checkedIn,onHold,reserved,tracks:stats(),accessRole:auth.accessRole};
    },
    async searchAdminParticipants([search,id],context) {
      const auth=session(id,'admin');throttle('staff-search:'+context.ip,60);
      const query=normalizeName(search);if(query.length<2)return [];
      if(remote)return forwardAdmin(auth,'bridgeSearchParticipants',[search,auth.email]);
      return people.filter(p=>p.id.toLowerCase()===query||normalizeName(p.name).includes(query)).slice(0,30).map(p=>({id:p.id,name:p.name,college:p.college,ticketType:p.ticketType,onHold:!!store.data.participants[p.id].onHold,checkedIn:store.data.participants[p.id].checkinRedeemed,track:store.data.participants[p.id].track||''}));
    },
    async manageParticipant([participantId,id,action,value,reason,confirmed]) {
      const auth=session(id,'admin');
      if(remote)return forwardAdmin(auth,'bridgeManageParticipant',[participantId,auth.email,action,value,reason,confirmed]);
      const role=auth.accessRole;
      if((action==='track'&&role!=='subadmin')||((action==='hold'||action==='restore')&&role!=='admin'))throw new Error(action==='track'?'Only sub-admins can assign tracks.':'Only lead admins can put registrations on hold or restore them.');
      if(confirmed!==true||typeof reason!=='string'||!reason.trim()||reason.length>500)throw new Error('Confirmation and a reason (1–500 characters) are required.');
      if(!people.some(p=>p.id===participantId))throw new Error('Participant not found.');
      const state=store.data.participants[participantId];
      if(!['hold','restore','track'].includes(action))throw new Error('Invalid management action.');
      if(action==='track'){
        if(state.onHold)throw new Error('Restore the registration before changing its track.');
        if(!tracks.includes(value))throw new Error('Invalid track.');
        if(state.track!==value&&stats().find(s=>s.track===value).full)throw new Error('This track is full.');
      }
      store.transaction(data=>{
        const target=data.participants[participantId],before={track:target.track||'',onHold:!!target.onHold};
        if(action==='track')target.track=value;else target.onHold=action==='hold';
        if(action==='hold')for(const [key,s] of Object.entries(data.sessions))if(s.role==='participant'&&s.participantId===participantId)delete data.sessions[key];
        data.audit.push({at:new Date().toISOString(),admin:auth.email,participantId,action:role+'-'+action,reason:reason.trim(),before,after:{track:target.track||'',onHold:!!target.onHold}});
      });
      return {ok:true};
    },
    async manualCheckin([participantId,id,track,confirmed]) {
      const auth=session(id,'admin');
      if(remote)return forwardAdmin(auth,'bridgeManualCheckin',[participantId,auth.email,track,confirmed]);
      const person=people.find(p=>p.id===participantId);if(!person)throw new Error('Participant not found.');
      const result=await handlers.redeemQR([store.data.participants[person.id].checkinToken,id,track,confirmed],null,true);
      return {...result,manualCheckin:true};
    },
    async setTrackLimit([track, limit, id]) {
      const auth=session(id,'admin');
      if(remote) return forwardAdmin(auth,'bridgeSetTrackLimit',[track,limit,auth.email]);
      if(!remote&&auth.accessRole!=='admin')throw new Error('Only lead admins can change track capacities.');
      if (!tracks.includes(track) || !Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid track capacity.');
      if(limit>0&&limit<stats().find(s=>s.track===track).enrolled)throw new Error('Capacity cannot be below the number of seats already reserved or checked in.');
      store.transaction(data=>{data.limits[track]=limit;}); return {ok:true,stats:stats()};
    },
    async redeemQR([token, id, track, confirmed],context,manual=false) {
      const auth=session(id,'admin');
      if(remote) return forwardAdmin(auth,'bridgeRedeemQR',[token,auth.email,track,confirmed]);
      let found, kind;
      for(const p of people) for(const type of ['checkin','food','goodie']) if(store.data.participants[p.id][type+'Token']===token){found=p;kind=type;}
      if(!found) throw new Error('Invalid QR pass.');
      if(auth.accessRole==='subadmin'&&kind!=='checkin')throw new Error('Sub-admins can only redeem event check-in passes.');
      const state=store.data.participants[found.id];
      if(state.onHold)throw new Error('Registration on hold. Only a lead admin can restore it.');
      const info={id:found.id,name:found.name,college:found.college,ticketType:found.ticketType,registrationType:found.registrationType};
      const type={checkin:'Event Check-in',food:'Lunch & Meals',goodie:'Swag & Goodie Kit'}[kind];
      const base={type,participant:info,participantId:found.id,participantName:found.name};
      if(state[kind+'Redeemed']) return {...base,ok:false,alreadyRedeemed:true,redeemedAt:state[kind==='checkin'?'checkedInAt':kind+'RedeemedAt'],track:state.track,message:'This pass was already redeemed.'};
      if(kind!=='checkin'&&!state.checkinRedeemed) throw new Error('Complete event check-in before collecting food or goodies.');
      if(kind==='checkin'&&state.track) {
        if(confirmed!==true)return {...base,ok:true,needsConfirmation:true,track:state.track,status:'Track already reserved'};
        if(track&&track!==state.track)throw new Error('The participant has already selected a track. It cannot be changed.');
        track=state.track;
      } else if(kind==='checkin') {
        if(!tracks.includes(track)||confirmed!==true)return {...base,ok:true,needsTrack:true,canAssignTrack:auth.accessRole==='subadmin',tracks,trackStats:stats()};
        if(auth.accessRole!=='subadmin')throw new Error('Only sub-admins can assign tracks. Ask a sub-admin to assign the participant first.');
        const chosen=stats().find(s=>s.track===track);if(chosen.full)return {...base,ok:false,trackFull:true,track,limit:chosen.limit,enrolled:chosen.enrolled,message:'This track is full.'};
      }
      if(kind!=='checkin'&&confirmed!==true) return {...base,ok:true,needsConfirmation:true,status:'Available'};
      store.transaction(data=>{
        const p=data.participants[found.id]; p[kind+'Redeemed']=true; p[kind==='checkin'?'checkedInAt':kind+'RedeemedAt']=new Date().toISOString();
        if(kind==='checkin')p.track=track;
        data.audit.push({at:new Date().toISOString(),admin:auth.email,participantId:found.id,action:manual?'manual-checkin':kind});
      });
      return {...base,ok:true,track:kind==='checkin'?track:state.track,message:'Pass successfully redeemed.'};
    }
  };
  async function rpc(method,args=[],context={ip:'local'}) {
    if(!Object.hasOwn(handlers,method)||!Array.isArray(args))throw new Error('Unknown request.');
    await refresh(); return handlers[method](args,context);
  }
  try {await refresh(true);await importRemoteLegacy();} catch(error){store.close();throw error;}
  const handler=async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(renderHtml(fs.readFileSync(path.join(__dirname,'Index.html'),'utf8'),url.searchParams.get('page')));
    }
    if(req.method!=='POST'||url.pathname!=='/api/rpc'){res.writeHead(404);return res.end();}
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){res.writeHead(415);return res.end();}
    if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host){res.writeHead(403);return res.end();}}catch{res.writeHead(403);return res.end();}}
    try {
      let input;
      if(req.body!==undefined){
        const raw=typeof req.body==='string'||Buffer.isBuffer(req.body)?req.body:JSON.stringify(req.body);
        if(Buffer.byteLength(raw)>16384){res.writeHead(413);return res.end();}
        input=typeof req.body==='string'||Buffer.isBuffer(req.body)?JSON.parse(String(req.body)):req.body;
      }else{
        const chunks=[];let bytes=0;
        for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>16384){res.writeHead(413);return res.end();}chunks.push(Buffer.from(chunk));}
        input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      if(!input||typeof input!=='object')throw new Error('Invalid request.');
      const data=await rpc(input.method,input.args,{ip:req.socket?.remoteAddress||'unknown'});
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,data}));
    }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));}
  };
  const server=http.createServer(handler);
  return {server,handler,rpc,close:()=>{server.close();store.close();},store,refresh};
}
function loadConfig(serverless=false){
  const filename=path.join(__dirname,'config.json');
  const config=!serverless&&fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  for(const key of ['PARTICIPANTS_URL','PARTICIPANTS_FILE','BRIDGE_SECRET','STATE_DIR'])if(process.env[key])config[key]=process.env[key];
  for(const key of ['ADMIN_CREDENTIALS','ADMIN_ROLES','TRACK_CATALOG','COMMON_SESSIONS'])if(process.env[key]){
    if(serverless&&key==='ADMIN_CREDENTIALS')continue;
    try{config[key]=JSON.parse(process.env[key]);}catch{throw new Error('Invalid JSON in '+key+' environment variable.');}
  }
  if(serverless)config.SERVERLESS=true;
  return config;
}
let hostedApp;
async function vercelHandler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  const url=new URL(req.url,'http://localhost');
  // Serve the public UI without disk state or a network call during startup.
  if(req.method==='GET'&&url.pathname==='/'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(renderHtml(fs.readFileSync(path.join(__dirname,'Index.html'),'utf8'),url.searchParams.get('page')));
  }
  if(req.method==='GET'&&url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  if(req.method!=='POST'||url.pathname!=='/api/rpc'){res.writeHead(404);return res.end();}
  try{
    if(!hostedApp)hostedApp=createApp(loadConfig(true)).catch(error=>{hostedApp=undefined;throw error;});
    const app=await hostedApp;return await app.handler(req,res);
  }catch(error){
    console.error('Portal configuration error: '+error.message);
    res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));
  }
}
async function main() {
  const app=await createApp(loadConfig());
  app.server.on('error',error=>{console.error(error.message);app.close();process.exitCode=1;});
  app.server.listen(Number(process.env.PORT||3000),()=>console.log('Portal listening on port '+(process.env.PORT||3000)));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{app.close();process.exit();});
}
if(require.main===module&&!process.env.VERCEL)main().catch(error=>{console.error('Startup failed: '+error.message);process.exitCode=1;});
module.exports=Object.assign(vercelHandler,{createApp,prepareRows,parseCsv,renderHtml,phone,loadConfig});
