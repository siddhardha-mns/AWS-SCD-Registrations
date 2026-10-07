const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server');

function clearInactivePracticeData(base) {
  const root=fs.realpathSync(base);
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    if(!entry.isDirectory()||!/^practice-[A-Za-z0-9]+$/.test(entry.name))continue;
    const candidate=path.resolve(root,entry.name);
    if(path.dirname(candidate)!==root||fs.realpathSync(candidate)!==candidate)continue;
    const lock=path.join(candidate,'state','writer.lock');
    if(fs.existsSync(lock)){
      try{
        const {pid}=JSON.parse(fs.readFileSync(lock,'utf8'));
        if(!Number.isSafeInteger(pid)||pid<=0)continue;
        try{process.kill(pid,0);continue;}catch(error){if(error.code!=='ESRCH')continue;}
      }catch{continue;}
    }
    fs.rmSync(candidate,{recursive:true,force:true});
  }
}

async function main() {
  const base = path.join(__dirname, '..', '.runtime', 'demo');
  fs.mkdirSync(base, { recursive: true });
  // Fresh fake attendees only; old inactive demo data is cleared once listening.
  // Active demos and all real registration files/configuration are preserved.
  const directory = fs.mkdtempSync(path.join(base, 'practice-'));
  const filename = path.join(directory, 'participants.json');
  fs.writeFileSync(filename, JSON.stringify([
    { ID: 'DEMO1', Name: 'Person One', Email: 'one@example.test', Phone: '9990000001', College: 'Demo College', 'Ticket Type': 'Practice Ticket' },
    { ID: 'DEMO2', Name: 'Person Two', Email: 'two@example.test', Phone: '9990000002', College: 'Demo College', 'Ticket Type': 'Practice Ticket' }
  ]));
  const password = crypto.randomBytes(12).toString('base64url');
  function hash() {
    const salt = crypto.randomBytes(16).toString('hex');
    return 'scrypt:' + salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
  }
  const app = await createApp({
    PARTICIPANTS_FILE: filename,
    STATE_DIR: path.join(directory, 'state'),
    LEGACY_STATE_FILE: path.join(directory, 'no-legacy.json'),
    LEGACY_LIMITS_FILE: path.join(directory, 'no-limits.json'),
    ADMIN_CREDENTIALS: { 'lead@example.test': hash(), 'staff@example.test': hash() },
    ADMIN_ROLES: { 'lead@example.test': 'admin', 'staff@example.test': 'subadmin' },
    TRACK_BOOKING_OPEN: false,
    TRACK_CATALOG: ['Dummy Event 1','Dummy Event 2'].map(id=>({id,title:id,capacity:1,description:'Demo only — the actual event details will be added later.',sessions:[{title:'Practice workshop',speaker:'Demo Speaker',time:'Demo schedule'}]})),
    COMMON_SESSIONS: [{title:'Practice welcome session',speaker:'Demo Host',time:'Before parallel workshops'}]
  });
  app.server.on('error', error => {
    app.close();
    console.error(error.code === 'EADDRINUSE' ? 'Port 3000 is busy. Stop the other server with Ctrl+C, then run npm run demo again.' : error.message);
    process.exitCode = 1;
  });
  app.server.listen(3000, '127.0.0.1', () => {
    try{clearInactivePracticeData(base);}catch(error){console.warn('Old practice data cleanup skipped: '+error.message);}
    console.log('\nPractice version is ready. Fake participants only.\n');
    console.log('Open: http://localhost:3000/?page=admin');
    console.log('Admin email: lead@example.test');
    console.log('Password: ' + password);
    console.log('\nSub-admin email: staff@example.test (same password)');
    console.log('Participant page: http://localhost:3000');
    console.log('Participant: Person One / one@example.test');
    console.log('\nKeep this terminal open. Press Ctrl+C to stop.\n');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close(); process.exit(); });
}
if(require.main===module)main().catch(error => { console.error('Practice startup failed: ' + error.message); process.exitCode = 1; });
module.exports={clearInactivePracticeData};
