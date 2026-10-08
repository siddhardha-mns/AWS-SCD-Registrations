const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const envText = fs.readFileSync('.env', 'utf8');
const supabaseUrl = envText.match(/SUPABASE_URL=(.*)/)[1].trim();
const supabaseKey = envText.match(/SUPABASE_SERVICE_KEY=(.*)/)[1].trim();

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

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

async function migrate() {
  console.log("Starting migration to Supabase...");
  try {
    const adminText = fs.readFileSync('Final Registrations - Admins.csv', 'utf8');
    const admins = parseCsv(adminText).map(row => ({
      email: row['Email'],
      name: row['Name'],
      active: row['Active'] === 'TRUE' || row['Active'] === 'true',
      role: row['Role']
    }));
    if (admins.length > 0) {
      const { error } = await supabase.from('admins').upsert(admins);
      if (error) throw error;
      console.log(`✅ Migrated ${admins.length} admins.`);
    }
  } catch (e) { console.log("⚠️ Could not migrate admins:", e.message); }

  try {
    const participantText = fs.readFileSync('Final Registrations - Participants.csv', 'utf8');
    const crypto = require('crypto');
    const participants = parseCsv(participantText).map(row => {
      const name = row['Participant Name'] || row['Name'] || '';
      const email = row['Email'] || row['Email Address'] || '';
      const mobile = row['Mobile Number (WhatsApp)'] || row['Phone'] || '';
      const id = row['Registration ID'] || 'P-' + crypto.createHash('sha256').update(JSON.stringify([name.toLowerCase().trim(), email.toLowerCase().trim(), mobile.replace(/\D/g, '')])).digest('hex').slice(0, 32);
      const newToken = () => 'v4-' + crypto.randomBytes(16).toString('hex');
      return {
        id, name, phone: mobile, email, checkin_token: newToken(), food_token: newToken(), goodie_token: newToken(),
        college: row['College / Institution'] || '', registration_type: row['Registration Type'] || ''
      };
    });
    if (participants.length > 0) {
      for (let i = 0; i < participants.length; i += 100) {
        const { error } = await supabase.from('participants').upsert(participants.slice(i, i + 100));
        if (error) throw error;
      }
      console.log(`✅ Migrated ${participants.length} participants.`);
    }
  } catch (e) { console.log("⚠️ Could not migrate participants:", e.message); }
  console.log("🎉 Migration complete!");
}
migrate();
