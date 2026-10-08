/**
 * supabase-store.js
 * Supabase-backed data layer replacing the local state-store / state.json approach.
 * All reads/writes go directly to the Supabase PostgreSQL database.
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

let _supabase;
function getSupabase() {
  if (_supabase) return _supabase;
  // Read env from file to avoid dotenv injection issues
  let url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_SERVICE_KEY;
  if ((!url || !key) && fs.existsSync('.env')) {
    const envText = fs.readFileSync('.env', 'utf8');
    const urlMatch = envText.match(/SUPABASE_URL=(.*)/);
    const keyMatch = envText.match(/SUPABASE_SERVICE_KEY=(.*)/);
    if (urlMatch) url = urlMatch[1].trim();
    if (keyMatch) key = keyMatch[1].trim();
  }
  if (!url || !url.startsWith('http')) throw new Error('SUPABASE_URL is missing or invalid. Set it in your .env file.');
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is missing. Set it in your .env file.');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

// ── Participants ──────────────────────────────────────────────────────────────

async function getParticipant(id) {
  const { data, error } = await getSupabase().from('participants').select('*').eq('id', id).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function getAllParticipants() {
  const { data, error } = await getSupabase().from('participants').select('*');
  if (error) throw error;
  return data || [];
}

async function updateParticipant(id, updates) {
  const { data, error } = await getSupabase().from('participants').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ── Admins ────────────────────────────────────────────────────────────────────

async function getAdmin(email) {
  const { data, error } = await getSupabase().from('admins').select('*').eq('email', email.toLowerCase()).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

// ── Sessions (in-memory, cleared on restart — same as before for local) ───────

const _sessions = {};

function createSession(role, identity) {
  const crypto = require('crypto');
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  // cleanup expired
  for (const [k, v] of Object.entries(_sessions)) if (v.expiresAt <= now) delete _sessions[k];
  _sessions[id] = { role, ...identity, expiresAt: now + 3600000 };
  return id;
}

function getSession(id, role) {
  const value = _sessions[id] || null;
  if (!value || value.expiresAt <= Date.now()) {
    delete _sessions[id];
    throw new Error('Session expired. Please log in again.');
  }
  if (value.role !== role) throw new Error('Session expired. Please log in again.');
  return value;
}

function deleteSession(id, role) {
  if (_sessions[id]?.role === role) delete _sessions[id];
}

function deleteParticipantSessions(participantId) {
  for (const [k, v] of Object.entries(_sessions)) if (v.role === 'participant' && v.participantId === participantId) delete _sessions[k];
}

// ── Track limits (stored in Supabase track_limits table) ─────────────────────

async function getTrackLimits() {
  const { data, error } = await getSupabase().from('track_limits').select('*');
  if (error && error.code !== '42P01') throw error; // ignore table not found
  if (!data) return {};
  return Object.fromEntries((data || []).map(r => [r.track, r.limit_count]));
}

async function setTrackLimit(track, limit) {
  const { error } = await getSupabase().from('track_limits').upsert({ track, limit_count: limit });
  if (error) throw error;
}

// ── Audit log ─────────────────────────────────────────────────────────────────

async function appendAudit(entry) {
  const { created_at, ...rest } = entry; // let Supabase auto-set created_at
  const { error } = await getSupabase().from('audit_log').insert(rest);
  if (error) console.error('Audit log error:', error.message);
}

module.exports = {
  getSupabase,
  getParticipant,
  getAllParticipants,
  updateParticipant,
  getAdmin,
  createSession,
  getSession,
  deleteSession,
  deleteParticipantSessions,
  getTrackLimits,
  setTrackLimit,
  appendAudit,
};
