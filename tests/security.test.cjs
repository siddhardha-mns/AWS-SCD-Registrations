const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {createApp,prepareRows,parseCsv,phone}=require('../server');
const rows=[{ID:'TEST1',Name:'Person1',Email:'one@example.test',Phone:'9990000001',College:'First College','Ticket Type':'Student'},{ID:'TEST2',Name:'Person2',Email:'two@example.test',Phone:'9990000002'}];
const salt='00000000000000000000000000000001',password='a long test password';
const credential='scrypt:'+salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
async function fixture(t, input=rows, extra={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'participant-security-'));
  const file=path.join(directory,'participants.json');fs.writeFileSync(file,JSON.stringify(input));
  const config={PARTICIPANTS_FILE:file,STATE_DIR:path.join(directory,'state'),LEGACY_STATE_FILE:path.join(directory,'legacy.json'),LEGACY_LIMITS_FILE:path.join(directory,'limits.json'),ADMIN_CREDENTIALS:{'admin@example.test':credential},...extra};
  const app=await createApp(config);
  const apps=[app];
  const reopen=async()=>{const next=await createApp(config);apps.push(next);return next;};
  t.after(()=>{for(const running of apps)running.close();if(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('participant-security-'))fs.rmSync(directory,{recursive:true,force:true});});
  return {app,config,file,directory,reopen};
}
async function login(app,name='Person1',contact='one@example.test'){return app.rpc('verifyParticipant',[name,contact]);}
async function admin(app){return (await app.rpc('adminStatus',['admin@example.test',password])).sessionId;}
async function dashboard(app){return app.rpc('getParticipantDashboard',[(await login(app)).sessionId]);}

test('demo cleanup removes only inactive named practice directories, preserving live and unrelated data',t=>{
  const {clearInactivePracticeData}=require('../scripts/demo.cjs');
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'demo-cleanup-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const old=path.join(base,'practice-old123'),active=path.join(base,'practice-live123'),unrelated=path.join(base,'real-data');
  fs.mkdirSync(old);fs.writeFileSync(path.join(old,'participants.json'),'[]');
  fs.mkdirSync(path.join(active,'state'),{recursive:true});fs.writeFileSync(path.join(active,'state','writer.lock'),JSON.stringify({pid:process.pid}));
  fs.mkdirSync(unrelated);clearInactivePracticeData(base);
  assert.equal(fs.existsSync(old),false);assert.equal(fs.existsSync(active),true);assert.equal(fs.existsSync(unrelated),true);
});
test('similar and unrelated mixed identities are rejected for both contacts',async t=>{
  const {app}=await fixture(t);
  for(const contact of ['two@example.test','9990000002','nonsense9990000001@example.test','text9990000001'])await assert.rejects(()=>login(app,'Person1',contact),/Verification failed/);
  assert.equal((await login(app,' person1 ','ONE@EXAMPLE.TEST')).participant.id,'TEST1');
  assert.equal((await login(app,'Person1','+91 99900 00001')).participant.id,'TEST1');
});
test('shared email IDs remain distinct, while duplicate and ambiguous records fail closed',async t=>{
  const shared=[{Name:'Alice Green',Email:'shared@example.test',Phone:'9990000011'},{Name:'Robert Blue',Email:'shared@example.test',Phone:'9990000022'}];
  assert.notEqual(prepareRows(shared)[0].id,prepareRows(shared)[1].id);
  const {app}=await fixture(t,shared);
  const auth=await login(app,'Robert Blue','9990000022');
  assert.equal((await app.rpc('getParticipantDashboard',[auth.sessionId])).name,'Robert Blue');
  assert.throws(()=>prepareRows([{...rows[0]},{...rows[1],ID:'TEST1'}]),/Duplicate/);
  const ambiguous=await fixture(t,[rows[0],{...rows[0],ID:'TEST3'}]);
  await assert.rejects(()=>login(ambiguous.app),/Verification failed/);
});
test('sessions persist, expire, revoke and cannot cross roles',async t=>{
  const {app,reopen}=await fixture(t);const auth=await login(app);const id=await admin(app);
  await assert.rejects(()=>app.rpc('getParticipantDashboard',[id]),/Session expired/);
  await assert.rejects(()=>app.rpc('redeemQR',['TEST1',auth.sessionId,'Track A',true]),/Session expired/);
  app.close();const restarted=await reopen();
  assert.equal((await restarted.rpc('getParticipantDashboard',[auth.sessionId])).id,'TEST1');
  await restarted.rpc('logoutParticipant',[auth.sessionId]);
  await assert.rejects(()=>restarted.rpc('getParticipantDashboard',[auth.sessionId]),/Session expired/);
  await restarted.rpc('logoutAdmin',[id]);await assert.rejects(()=>restarted.rpc('getTrackStats',[id]),/Session expired/);
  const fresh=await login(restarted);restarted.store.transaction(data=>{data.sessions[fresh.sessionId].expiresAt=Date.now()-1;});
  await assert.rejects(()=>restarted.rpc('getParticipantDashboard',[fresh.sessionId]),/Session expired/);
  assert.equal(Object.hasOwn(restarted.store.data.sessions,fresh.sessionId),false);
});
test('admin impersonation and unauthenticated mutations are blocked',async t=>{
  const {app}=await fixture(t);
  await assert.rejects(()=>app.rpc('adminStatus',['admin@example.test','wrong']),/authentication/);
  for(const [method,args] of [['getTrackStats',[]],['setTrackLimit',['Track A',1]],['redeemQR',['TEST1','admin@example.test','Track A',true]]])await assert.rejects(()=>app.rpc(method,args),/Session expired/);
  const id=await admin(app);assert.equal((await app.rpc('getTrackStats',[id])).length,4);
});
test('random exact QR tokens are the only accepted redemption codes',async t=>{
  const {app}=await fixture(t);const d=await dashboard(app);const id=await admin(app);
  for(const p of [d.checkin,d.food,d.goodie])assert.match(p.token,/^v4-[a-f0-9]{32}$/);
  assert.equal(new Set([d.checkin.token,d.food.token,d.goodie.token]).size,3);
  for(const token of ['TEST1','TEST1-CHK','TEST1:CHK',d.checkin.token.toUpperCase()])await assert.rejects(()=>app.rpc('redeemQR',[token,id,'Track A',true]),/Invalid QR/);
  await assert.rejects(()=>app.rpc('redeemQR',[d.food.token,id,'',true]),/check-in/);
});
test('capacity, one-time redemption and concurrent attempts survive restart',async t=>{
  const {app,reopen}=await fixture(t);const d=await dashboard(app);const id=await admin(app);
  await app.rpc('setTrackLimit',['Track A',1,id]);
  assert.equal((await app.rpc('redeemQR',[d.checkin.token,id,'',false])).needsTrack,true);
  assert.equal((await app.rpc('redeemQR',[d.checkin.token,id,'Track A',true])).ok,true);
  const second=await app.rpc('getParticipantDashboard',[(await login(app,'Person2','two@example.test')).sessionId]);
  assert.equal((await app.rpc('redeemQR',[second.checkin.token,id,'Track A',true])).trackFull,true);
  for(const pass of [d.food,d.goodie]) {
    assert.equal((await app.rpc('redeemQR',[pass.token,id,'',false])).needsConfirmation,true);
    const results=await Promise.all(Array.from({length:20},()=>app.rpc('redeemQR',[pass.token,id,'',true])));
    assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.alreadyRedeemed).length,19);
  }
  app.close();const restarted=await reopen();
  assert.equal((await restarted.rpc('redeemQR',[d.food.token,id,'',true])).alreadyRedeemed,true);
});
test('a second writer is refused and save failures do not acknowledge redemption',async t=>{
  const {app,config}=await fixture(t);await assert.rejects(()=>createApp(config),/EEXIST/);
  const id=await admin(app),d=await dashboard(app);
  const original=app.store.write;app.store.write=()=>{throw Error('disk full');};
  await assert.rejects(()=>app.rpc('redeemQR',[d.checkin.token,id,'Track A',true]),/disk full/);
  assert.equal(app.store.data.participants.TEST1.checkinRedeemed,false);app.store.write=original;
  assert.equal((await app.rpc('redeemQR',[d.checkin.token,id,'Track A',true])).ok,true);
});
test('legacy flags and imported flags are preserved while old tokens are rotated',async t=>{
  const {app,config,reopen}=await fixture(t,[{...rows[0],'Food Redeemed':true}]);
  assert.equal((await dashboard(app)).food.redeemed,true);
  app.close();fs.writeFileSync(config.LEGACY_STATE_FILE,JSON.stringify({TEST2:{checkinToken:'TEST2-CHK',foodToken:'TEST2-FOD',goodieToken:'TEST2-GDK',checkinRedeemed:true,track:'Track B'}}));
  fs.writeFileSync(config.PARTICIPANTS_FILE,JSON.stringify(rows));
  const restarted=await reopen();
  const second=await restarted.rpc('getParticipantDashboard',[(await login(restarted,'Person2','two@example.test')).sessionId]);
  // This record is introduced after migration, so the legacy flag is imported.
  assert.equal(second.checkin.redeemed,true);assert.match(second.checkin.token,/^v4-/);
});
test('missing or corrupt initialized state fails closed',async t=>{
  const {app,config}=await fixture(t);const state=app.store.file;app.close();fs.unlinkSync(state);
  await assert.rejects(()=>createApp(config),/state is missing/);
  fs.writeFileSync(state,'broken json');await assert.rejects(()=>createApp(config),/JSON/);
});
test('source changes refresh without restart and invalidate changed participant identity',async t=>{
  const {app,file}=await fixture(t);const auth=await login(app);
  fs.writeFileSync(file,JSON.stringify([{...rows[0],Email:'new@example.test'},rows[1],{ID:'TEST3',Name:'New Person',Email:'newperson@example.test'}]));
  await app.refresh(true);
  await assert.rejects(()=>app.rpc('getParticipantDashboard',[auth.sessionId]),/Session expired/);
  assert.equal((await login(app,'New Person','newperson@example.test')).participant.id,'TEST3');
});
test('login requests are throttled and CSV supports quoted multiline fields',async t=>{
  const {app}=await fixture(t);
  for(let i=0;i<10;i++)await assert.rejects(()=>login(app,'Wrong Name','wrong@example.test'),/Verification failed/);
  await assert.rejects(()=>login(app,'Wrong Name','wrong@example.test'),/Too many/);
  assert.equal(parseCsv('Name,Email\r\n"O\'Neil\nPerson",one@example.test')[0].Name,"O'Neil\nPerson");
  assert.equal(phone('abc9990000001'),'');
});
test('HTTP rejects cross-origin, inherited RPC names and non-JSON requests',async t=>{
  const {app}=await fixture(t);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+app.server.address().port;
  const page=await fetch(url);assert.equal(page.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(url+'/api/rpc',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/rpc',{method:'POST',body:'{}'})).status,415);
  const result=await (await fetch(url+'/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'constructor',args:[]})})).json();assert.equal(result.ok,false);
});
test('attendance totals update after manual check-in, and duplicate check-ins do not increment them',async t=>{
  const {app}=await fixture(t);const id=await admin(app);
  const before=await app.rpc('getAdminDashboard',[id]);assert.equal(before.total,2);assert.equal(before.checkedIn,0);assert.equal(before.notCheckedIn,2);
  const inspect=await app.rpc('manualCheckin',['TEST1',id,'',false]);assert.equal(inspect.needsTrack,true);assert.equal(inspect.manualCheckin,true);
  assert.equal((await app.rpc('getAdminDashboard',[id])).checkedIn,0);
  assert.equal((await app.rpc('manualCheckin',['TEST1',id,'Track A',true])).ok,true);
  assert.equal((await app.rpc('manualCheckin',['TEST1',id,'Track B',true])).alreadyRedeemed,true);
  const after=await app.rpc('getAdminDashboard',[id]);assert.equal(after.checkedIn,1);assert.equal(after.notCheckedIn,1);assert.equal(after.tracks.find(t=>t.track==='Track A').enrolled,1);
  assert.equal(app.store.data.audit.at(-1).action,'manual-checkin');
});
test('subadmins can find and check in participants but cannot set limits or redeem benefits',async t=>{
  const {app,config}=await fixture(t);config.ADMIN_CREDENTIALS['staff@example.test']=credential;config.ADMIN_ROLES={'staff@example.test':'subadmin'};
  const auth=await app.rpc('adminStatus',['staff@example.test',password]);assert.equal(auth.accessRole,'subadmin');
  const results=await app.rpc('searchAdminParticipants',['Person',auth.sessionId]);assert.equal(results.length,2);assert.equal(results[0].email,undefined);assert.equal(results[0].checkinToken,undefined);
  const byId=await app.rpc('searchAdminParticipants',['TEST1',auth.sessionId]);assert.equal(byId.length,1);
  await assert.rejects(()=>app.rpc('setTrackLimit',['Track A',5,auth.sessionId]),/Only lead admins/);
  await assert.rejects(()=>app.rpc('manualCheckin',['TEST1','staff@example.test','Track A',true]),/Session expired/);
  assert.equal((await app.rpc('manualCheckin',['TEST1',auth.sessionId,'Track A',true])).ok,true);
  const d=await dashboard(app);
  await assert.rejects(()=>app.rpc('redeemQR',[d.food.token,auth.sessionId,'',true]),/only redeem event check-in/);
  const second=await app.rpc('getParticipantDashboard',[(await login(app,'Person2','two@example.test')).sessionId]);
  assert.equal((await app.rpc('redeemQR',[second.checkin.token,auth.sessionId,'Track B',true])).ok,true);
  assert.equal((await app.rpc('getAdminDashboard',[auth.sessionId])).checkedIn,2);
});
test('track limits apply to manual check-in and cannot drop below occupied seats',async t=>{
  const {app}=await fixture(t);const id=await admin(app);
  await app.rpc('setTrackLimit',['Track A',1,id]);await app.rpc('manualCheckin',['TEST1',id,'Track A',true]);
  const blocked=await app.rpc('manualCheckin',['TEST2',id,'Track A',true]);assert.equal(blocked.trackFull,true);
  assert.equal((await app.rpc('getAdminDashboard',[id])).checkedIn,1);
  await app.rpc('manualCheckin',['TEST2',id,'Track B',true]);await app.rpc('setTrackLimit',['Track B',2,id]);
  await app.rpc('setTrackLimit',['Track A',0,id]);await app.rpc('setTrackLimit',['Track A',1,id]);
  await assert.rejects(()=>app.rpc('setTrackLimit',['Track B',0.5,id]),/Invalid track/);
  // A separate event with two occupied seats proves an undersized positive limit fails.
  const second=await fixture(t);const lead=await admin(second.app);
  await second.app.rpc('manualCheckin',['TEST1',lead,'Track C',true]);await second.app.rpc('manualCheckin',['TEST2',lead,'Track C',true]);
  await assert.rejects(()=>second.app.rpc('setTrackLimit',['Track C',1,lead]),/below the number/);
});
test('manual and scanned check-in attempts share one redemption flag and attendance counter',async t=>{
  const {app}=await fixture(t);const id=await admin(app),d=await dashboard(app);
  const attempts=await Promise.all([app.rpc('manualCheckin',['TEST1',id,'Track A',true]),app.rpc('redeemQR',[d.checkin.token,id,'Track A',true])]);
  assert.equal(attempts.filter(r=>r.ok).length,1);assert.equal(attempts.filter(r=>r.alreadyRedeemed).length,1);
  assert.equal((await app.rpc('getAdminDashboard',[id])).checkedIn,1);assert.equal(app.store.data.audit.length,1);
});
const bookingConfig={TRACK_BOOKING_OPEN:true,TRACK_CATALOG:[{id:'Track A',title:'Workshop A',capacity:1,sessions:[{title:'Demo session',speaker:'Test Speaker',time:'10:00'}]},{id:'Track B',title:'Workshop B',capacity:1},{id:'Track C',title:'Workshop C',capacity:1}],COMMON_SESSIONS:[{title:'Welcome',speaker:'Test Host'}]};

test('lead hold retains seats and history, blocks all passes and revokes sessions across restart',async t=>{
  const {app,reopen}=await fixture(t,rows,bookingConfig);const user=await login(app),lead=await admin(app);
  await app.rpc('selectParticipantTrack',[user.sessionId,'Track A',true]);const passes=await app.rpc('getParticipantDashboard',[user.sessionId]);
  await app.rpc('redeemQR',[passes.checkin.token,lead,'Track A',true]);
  await app.rpc('manageParticipant',['TEST1',lead,'hold','','Identity review',true]);
  await assert.rejects(()=>login(app),/on hold/);
  await assert.rejects(()=>app.rpc('getParticipantDashboard',[user.sessionId]),/Session expired/);
  for(const kind of ['checkin','food','goodie'])await assert.rejects(()=>app.rpc('redeemQR',[passes[kind].token,lead,'Track A',true]),/on hold/);
  assert.equal((await app.rpc('getTrackStats',[lead]))[0].enrolled,1);
  assert.equal(app.store.data.participants.TEST1.checkinRedeemed,true);
  app.close();const restarted=await reopen();await assert.rejects(()=>login(restarted),/on hold/);
  const newLead=await admin(restarted);await restarted.rpc('manageParticipant',['TEST1',newLead,'restore','','Review completed',true]);
  await assert.rejects(()=>restarted.rpc('getParticipantDashboard',[user.sessionId]),/Session expired/);
  const restored=await dashboard(restarted);assert.equal(restored.track,'Track A');assert.equal(restored.checkin.redeemed,true);
  assert.equal(restarted.store.data.audit.at(-1).action,'lead-restore');
});

test('lead track overrides respect capacity and subadmins cannot manage registrations',async t=>{
  const config={...bookingConfig,ADMIN_CREDENTIALS:{'admin@example.test':credential,'staff@example.test':credential},ADMIN_ROLES:{'staff@example.test':'subadmin'}};
  const {app}=await fixture(t,rows,config);const lead=await admin(app),staff=(await app.rpc('adminStatus',['staff@example.test',password])).sessionId;
  for(const action of ['hold','restore','track'])await assert.rejects(()=>app.rpc('manageParticipant',['TEST1',staff,action,'Track A','Test',true]),/Only lead admins/);
  await assert.rejects(()=>app.rpc('manageParticipant',['TEST1',lead,'hold','','',true]),/reason/);
  await app.rpc('manageParticipant',['TEST1',lead,'track','Track A','Approved assignment',true]);
  await app.rpc('manageParticipant',['TEST2',lead,'track','Track B','Approved assignment',true]);
  await assert.rejects(()=>app.rpc('manageParticipant',['TEST1',lead,'track','Track B','Move',true]),/full/);
  assert.equal(app.store.data.participants.TEST1.track,'Track A');
  await app.rpc('manageParticipant',['TEST1',lead,'track','Track C','Approved correction',true]);
  const stats=await app.rpc('getTrackStats',[lead]);assert.equal(stats[0].enrolled,0);assert.equal(stats[2].enrolled,1);
  assert.deepEqual(app.store.data.audit.at(-1).before,{track:'Track A',onHold:false});
});

test('concurrent lead overrides cannot take the same final seat',async t=>{
  const {app}=await fixture(t,rows,bookingConfig);const lead=await admin(app);
  const results=await Promise.allSettled(['TEST1','TEST2'].map(id=>app.rpc('manageParticipant',[id,lead,'track','Track A','Approved',true])));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await app.rpc('getTrackStats',[lead]))[0].enrolled,1);
});
test('simultaneous participant bookings cannot oversell the last seat',async t=>{
  const {app}=await fixture(t,rows,bookingConfig);
  const first=await login(app),second=await login(app,'Person2','two@example.test');
  const results=await Promise.allSettled([app.rpc('selectParticipantTrack',[first.sessionId,'Track A',true]),app.rpc('selectParticipantTrack',[second.sessionId,'Track A',true])]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/full/);
  const dashboard=await app.rpc('getAdminDashboard',[await admin(app)]);assert.equal(dashboard.checkedIn,0);assert.equal(dashboard.tracks[0].reserved,1);assert.equal(dashboard.tracks[0].available,0);
});
test('participant choices are immutable, survive restart, and reserved-seat check-in works at full capacity',async t=>{
  const {app,reopen}=await fixture(t,rows,bookingConfig);const user=await login(app),lead=await admin(app);
  await assert.rejects(()=>app.rpc('selectParticipantTrack',[user.sessionId,'Track A',false]),/Confirm/);
  await app.rpc('selectParticipantTrack',[user.sessionId,'Track A',true]);await app.rpc('selectParticipantTrack',[user.sessionId,'Track A',true]);
  await assert.rejects(()=>app.rpc('selectParticipantTrack',[user.sessionId,'Track B',true]),/cannot be changed/);
  await assert.rejects(()=>app.rpc('manualCheckin',['TEST1',lead,'Track B',true]),/cannot be changed/);
  const inspection=await app.rpc('manualCheckin',['TEST1',lead,'',false]);assert.equal(inspection.needsTrack,undefined);assert.equal(inspection.needsConfirmation,true);assert.equal(inspection.track,'Track A');
  assert.equal((await app.rpc('manualCheckin',['TEST1',lead,'Track A',true])).ok,true);
  assert.equal((await app.rpc('getAdminDashboard',[lead])).tracks[0].reserved,1);
  app.close();const restarted=await reopen();const d=await restarted.rpc('getParticipantDashboard',[user.sessionId]);assert.equal(d.track,'Track A');assert.equal(d.trackOptions.length,3);assert.equal(d.commonSessions[0].title,'Welcome');
});
test('participant selection racing staff fallback consumes only one last seat',async t=>{
  const {app}=await fixture(t,rows,bookingConfig);const participant=await login(app),lead=await admin(app);
  const results=await Promise.allSettled([app.rpc('selectParticipantTrack',[participant.sessionId,'Track A',true]),app.rpc('manualCheckin',['TEST2',lead,'Track A',true])]);
  const accepted=results.filter(r=>r.status==='fulfilled'&&r.value.ok).length;assert.equal(accepted,1);
  const stats=await app.rpc('getAdminDashboard',[lead]);assert.equal(stats.tracks[0].reserved,1);
});
test('booking is closed until configured and capacity cannot undercut existing reservations',async t=>{
  const {app}=await fixture(t);const id=(await login(app)).sessionId;await assert.rejects(()=>app.rpc('selectParticipantTrack',[id,'Track A',true]),/not open/);
  const configured=await fixture(t,rows,{...bookingConfig,TRACK_CATALOG:[{id:'Track A',capacity:2}]});const lead=await admin(configured.app);
  await configured.app.rpc('selectParticipantTrack',[(await login(configured.app)).sessionId,'Track A',true]);
  await configured.app.rpc('selectParticipantTrack',[(await login(configured.app,'Person2','two@example.test')).sessionId,'Track A',true]);
  await assert.rejects(()=>configured.app.rpc('setTrackLimit',['Track A',1,lead]),/below the number/);
});
