const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const path=require('node:path');
const os=require('node:os');
const https=require('node:https');
const {EventEmitter}=require('node:events');
const {Readable}=require('node:stream');
const {createApp}=require('../server');

function fixture() {
  const headers=['Participant ID','Name','Phone','Email','Checkin Token','Food Token','Goodie Token','Checkin Redeemed','Food Redeemed','Goodie Redeemed','Track','Checked In At','Food Redeemed At','Goodie Redeemed At','College / Institution','Ticket Type','Registration Type'];
  const sheets={Participants:[headers,['P1','Person1','9990000001','one@example.test','P1-CHK','P1-FOD','P1-GDK',false,false,false,'','','','','College','Student','Individual'],['P2','Person2','9990000002','two@example.test','P2-CHK','P2-FOD','P2-GDK',false,false,false,'','','','','','','']],Admins:[['Email','Name','Active'],['admin@example.test','Admin',true]],AuditLog:[['Timestamp','Admin Email','Action','QR Type','Participant ID','Participant Name','Track','Result','Details']]};
  const properties=new Map([['PORTAL_OWNER_EMAIL','owner@example.test']]),cache=new Map();let active='owner@example.test',locked=false;
  function sheet(name) {
    if(!sheets[name])return null;
    return {getLastRow:()=>sheets[name].length,setFrozenRows(){},getRange:(row,col,height=1,width=1)=>({
      getValues:()=>Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>sheets[name][row-1+i]?.[col-1+j]??'')),
      setValue(value){assert.equal(locked,true);sheets[name][row-1]??=[];sheets[name][row-1][col-1]=value;},
      setValues(values){assert.equal(locked,true);values.forEach((r,i)=>{sheets[name][row-1+i]??=[];r.forEach((v,j)=>{sheets[name][row-1+i][col-1+j]=v;});});}
    }),appendRow:r=>sheets[name].push(r)};
  }
  const prop={getProperties:()=>Object.fromEntries(properties),getProperty:k=>properties.get(k)||null,setProperty:(k,v)=>properties.set(k,v),deleteProperty:k=>properties.delete(k)};
  const context=vm.createContext({Date,console,SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:sheet,insertSheet:n=>{sheets[n]=[];return sheet(n);}}),flush(){}},Utilities:{getUuid:()=>crypto.randomUUID(),formatDate:d=>d.toISOString(),DigestAlgorithm:{SHA_256:'sha256',SHA_1:'sha1'},computeDigest:(algorithm,text)=>[...crypto.createHash(algorithm).update(text).digest()],computeHmacSha256Signature:(text,key)=>[...crypto.createHmac('sha256',key).update(text).digest()]},PropertiesService:{getScriptProperties:()=>prop},CacheService:{getScriptCache:()=>({get:k=>cache.get(k),put:(k,v)=>cache.set(k,v)})},LockService:{getScriptLock:()=>({waitLock(){assert.equal(locked,false,'no nested locks');locked=true;},releaseLock(){locked=false;}})},Session:{getActiveUser:()=>({getEmail:()=>active}),getEffectiveUser:()=>({getEmail:()=> 'owner@example.test'}),getScriptTimeZone:()=> 'UTC'},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../Code.gs'),'utf8'),context);
  context.setupSheets();
  return {gas:context,sheets,properties,setActive:email=>{active=email;},cache};
}
function signed(secret,method,args,extra={}) {
  const payload=JSON.stringify({method,args,timestamp:Date.now(),nonce:crypto.randomBytes(16).toString('hex'),...extra});
  return {postData:{contents:JSON.stringify({payload,signature:crypto.createHmac('sha256',secret).update(payload).digest('hex')})}};
}

test('Sheets lead holds are reversible, preserve seats, and block direct and signed subadmin overrides',()=>{
  const {gas,properties,setActive,sheets}=fixture();const secret='test bridge secret with at least 32 characters';properties.set('BRIDGE_SECRET',secret);
  sheets.Admins.push(['staff@example.test','Staff',true,'subadmin']);
  const user=gas.verifyParticipant('Person1','one@example.test').sessionId,passes=gas.getParticipantDashboard(user);
  setActive('admin@example.test');const lead=gas.adminStatus().sessionId;
  gas.setTrackLimit('Track A',1,lead);gas.setTrackLimit('Track B',1,lead);
  gas.manageParticipant('P1',lead,'track','Track A','Approved',true);
  gas.manageParticipant('P2',lead,'track','Track B','Approved',true);
  assert.throws(()=>gas.manageParticipant('P1',lead,'track','Track B','Move',true),/full/);
  gas.manageParticipant('P1',lead,'hold','','Review',true);
  assert.throws(()=>gas.verifyParticipant('Person1','one@example.test'),/on hold/);
  assert.throws(()=>gas.getParticipantDashboard(user),/Session expired/);
  for(const kind of ['checkin','food','goodie'])assert.throws(()=>gas.redeemQR(passes[kind].token,lead,'Track A',true),/on hold/);
  assert.equal(gas.getTrackStats(lead)[0].enrolled,1);
  setActive('staff@example.test');const staff=gas.adminStatus().sessionId;
  for(const action of ['hold','restore','track']){
    assert.throws(()=>gas.manageParticipant('P1',staff,action,'Track C','Test',true),/Only lead admins/);
    assert.equal(JSON.parse(gas.doPost(signed(secret,'bridgeManageParticipant',['P1','staff@example.test',action,'Track C','Test',true])).text).ok,false);
  }
  setActive('admin@example.test');gas.manageParticipant('P1',lead,'restore','','Reviewed',true);
  assert.throws(()=>gas.getParticipantDashboard(user),/Session expired/);
  assert.equal(gas.getParticipantDashboard(gas.verifyParticipant('Person1','one@example.test').sessionId).track,'Track A');
  gas.manageParticipant('P1',lead,'track','Track C','Correction',true);
  assert.equal(sheets.Participants[1][10],'Track C');assert.equal(sheets.Participants[1][17],false);
  assert.match(sheets.AuditLog.at(-1)[8],/Correction/);
});

test('participant reservations and staff check-ins share capacity and final choices in Sheets',()=>{
  const {gas,properties,setActive}=fixture();
  properties.set('TRACK_CATALOG',JSON.stringify(['Track A','Track B','Track C'].map(id=>({id,capacity:1,sessions:[{title:'Workshop',speaker:'Speaker'}]}))));
  properties.set('TRACK_BOOKING_OPEN','true');
  const first=gas.verifyParticipant('Person1','one@example.test').sessionId;
  const second=gas.verifyParticipant('Person2','two@example.test').sessionId;
  assert.throws(()=>gas.selectParticipantTrack(first,'Track A',false),/Confirm/);
  assert.equal(gas.selectParticipantTrack(first,'Track A',true).ok,true);
  assert.equal(gas.selectParticipantTrack(first,'Track A',true).ok,true);
  assert.throws(()=>gas.selectParticipantTrack(first,'Track B',true),/cannot be changed/);
  assert.throws(()=>gas.selectParticipantTrack(second,'Track A',true),/full/);
  setActive('admin@example.test');const staff=gas.adminStatus().sessionId;
  const stats=gas.getTrackStats(staff)[0];assert.equal(stats.enrolled,1);assert.equal(stats.checkedIn,0);
  assert.equal(gas.manualCheckin('P2',staff,'Track A',true).trackFull,true);
  assert.throws(()=>gas.manualCheckin('P1',staff,'Track B',true),/cannot be changed/);
  assert.equal(gas.manualCheckin('P1',staff,'',false).needsConfirmation,true);
  assert.equal(gas.manualCheckin('P1',staff,'Track A',true).ok,true);
  assert.equal(gas.getTrackStats(staff)[0].enrolled,1);
  assert.equal(gas.getTrackStats(staff)[0].checkedIn,1);
});

test('signed participant booking immediately blocks direct staff from taking the last seat',()=>{
  const {gas,properties,setActive}=fixture();const secret='test bridge secret with at least 32 characters';
  properties.set('BRIDGE_SECRET',secret);properties.set('TRACK_BOOKING_OPEN','true');
  properties.set('TRACK_CATALOG',JSON.stringify([{id:'DevOps',capacity:1}]));
  const participant=gas.verifyParticipant('Person1','one@example.test').sessionId;
  const booking=JSON.parse(gas.doPost(signed(secret,'selectParticipantTrack',[participant,'DevOps',true])).text);
  assert.equal(booking.ok,true);
  setActive('admin@example.test');const staff=gas.adminStatus().sessionId;
  assert.equal(gas.manualCheckin('P2',staff,'DevOps',true).trackFull,true);
  assert.equal(gas.getParticipantDashboard(participant).track,'DevOps');
});
test('Apps Script exact identity rejects mixed-person login and malformed phones',()=>{
  const {gas}=fixture();
  for(const contact of ['two@example.test','9990000002','fake9990000001@example.test','bad9990000001'])assert.throws(()=>gas.verifyParticipant('Person1',contact),/Verification failed/);
  const login=gas.verifyParticipant(' person1 ','ONE@EXAMPLE.TEST');
  assert.equal(gas.getParticipantDashboard(login.sessionId).id,'P1');
  gas.logoutParticipant(login.sessionId);assert.throws(()=>gas.getParticipantDashboard(login.sessionId),/Session expired/);
});
test('Google identity, admin sessions and role isolation are enforced',()=>{
  const {gas,setActive}=fixture();setActive('');
  assert.throws(()=>gas.adminStatus('admin@example.test'),/Google account/);
  assert.throws(()=>gas.redeemQR('P1-CHK','admin@example.test','Track A',true),/Session expired/);
  setActive('admin@example.test');const auth=gas.adminStatus();
  assert.throws(()=>gas.getParticipantDashboard(auth.sessionId),/Session expired/);
  assert.equal(gas.getTrackStats(auth.sessionId).length,4);
  setActive('other@example.test');assert.throws(()=>gas.getTrackStats(auth.sessionId),/authentication/);
  setActive('admin@example.test');gas.logoutAdmin(auth.sessionId);assert.throws(()=>gas.getTrackStats(auth.sessionId),/Session expired/);
});
test('Apps Script random tokens, prerequisites, one-time use and capacity are enforced',()=>{
  const {gas,setActive,sheets}=fixture();setActive('admin@example.test');const id=gas.adminStatus().sessionId;
  const d=gas.getParticipantDashboard(gas.verifyParticipant('Person1','one@example.test').sessionId);
  assert.match(d.checkin.token,/^v4-[a-f0-9]{32}$/);
  assert.throws(()=>gas.redeemQR('P1-CHK',id,'Track A',true),/Invalid QR/);
  assert.throws(()=>gas.redeemQR(d.food.token,id,'',true),/check-in/);
  gas.setTrackLimit('Track A',1,id);gas.redeemQR(d.checkin.token,id,'Track A',true);
  const second=gas.getParticipantDashboard(gas.verifyParticipant('Person2','two@example.test').sessionId);
  assert.equal(gas.redeemQR(second.checkin.token,id,'Track A',true).trackFull,true);
  for(const p of [d.checkin,d.food,d.goodie]){
    if(p!==d.checkin)assert.equal(gas.redeemQR(p.token,id,'',true).ok,true);
    assert.equal(gas.redeemQR(p.token,id,'Track A',true).alreadyRedeemed,true);
  }
  assert.equal(sheets.AuditLog.length,4);
});
test('token rotation preserves flags and prevents anonymous maintenance',()=>{
  const {gas,sheets,setActive}=fixture();const old=sheets.Participants[1][4];sheets.Participants[1][7]=true;
  setActive('');assert.throws(()=>gas.rotatePassTokens(),/owner/);
  setActive('owner@example.test');gas.rotatePassTokens();assert.notEqual(sheets.Participants[1][4],old);assert.equal(sheets.Participants[1][7],true);
});
test('bridge rejects missing signatures, expired requests, replay and export methods',()=>{
  const {gas,properties}=fixture();const secret='test bridge secret with at least 32 characters';properties.set('BRIDGE_SECRET',secret);
  const invoke=request=>JSON.parse(gas.doPost(request).text);
  assert.equal(invoke({postData:{contents:JSON.stringify({payload:'{}',signature:''})}}).ok,false);
  assert.equal(invoke(signed(secret,'getParticipantNames',['Per'],{timestamp:0})).ok,false);
  const request=signed(secret,'getParticipantNames',['Per']);assert.equal(invoke(request).ok,true);assert.equal(invoke(request).ok,false);
  assert.equal(invoke(signed(secret,'readParticipants_',[])).ok,false);
  assert.equal(invoke(signed(secret,'bridgeAdminStatus',['not-admin@example.test'])).ok,false);
});
test('legacy export returns no attendee data',()=>{
  const context=vm.createContext({ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../ParticipantsApi.gs'),'utf8'),context);
  const result=JSON.parse(context.doGet().text);assert.equal(result.ok,false);assert.equal(result.participants,undefined);
});
test('legacy migration is monotonic, preserves tokens and rejects unmatched redeemed IDs',()=>{
  const {gas,properties,sheets}=fixture();const secret='test bridge secret with at least 32 characters';properties.set('BRIDGE_SECRET',secret);
  const token=sheets.Participants[1][4];
  const invoke=records=>JSON.parse(gas.doPost(signed(secret,'bridgeImportLegacyState',[records])).text);
  assert.equal(invoke([{id:'P1',checkinRedeemed:true,foodRedeemed:true,track:'Track B',checkedInAt:'2026-10-01'}]).ok,true);
  assert.equal(sheets.Participants[1][7],true);assert.equal(sheets.Participants[1][8],true);assert.equal(sheets.Participants[1][4],token);
  assert.equal(invoke([{id:'P1',checkinRedeemed:false,foodRedeemed:false}]).ok,true);assert.equal(sheets.Participants[1][8],true);
  assert.equal(invoke([{id:'MISSING',foodRedeemed:true}]).ok,false);
});
test('newly added sheet registrations receive unique passes without restarting the portal',()=>{
  const {gas,sheets}=fixture();sheets.Participants.push(['','New Person','9990000003','new@example.test']);
  const auth=gas.verifyParticipant('New Person','new@example.test');const d=gas.getParticipantDashboard(auth.sessionId);
  assert.match(d.checkin.token,/^v4-[a-f0-9]{32}$/);assert.notEqual(d.id,'P1');
});
test('Node bridge and direct Apps Script share the same redemption state',async t=>{
  const {gas,properties,setActive}=fixture();const secret='test bridge secret with at least 32 characters';properties.set('BRIDGE_SECRET',secret);
  t.mock.method(https,'request',(url,options,callback)=>{
    const request=new EventEmitter();request.end=body=>{
      const output=gas.doPost({postData:{contents:body}});
      const response=Readable.from([output.text]);response.statusCode=200;response.headers={};callback(response);
    };return request;
  });
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'participant-bridge-'));
  const salt='00000000000000000000000000000001',password='a long test password';
  const encoded='scrypt:'+salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
  const node=await createApp({PARTICIPANTS_URL:'https://example.test/exec',BRIDGE_SECRET:secret,STATE_DIR:directory,LEGACY_STATE_FILE:path.join(directory,'legacy.json'),LEGACY_LIMITS_FILE:path.join(directory,'limits.json'),ADMIN_CREDENTIALS:{'admin@example.test':encoded,'staff@example.test':encoded}});
  t.after(()=>{node.close();if(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('participant-bridge-'))fs.rmSync(directory,{recursive:true,force:true});});
  await assert.rejects(()=>node.rpc('verifyParticipant',['Person1','two@example.test']),/Verification failed/);
  const auth=await node.rpc('verifyParticipant',['Person1','one@example.test']);
  const d=await node.rpc('getParticipantDashboard',[auth.sessionId]);
  const id=(await node.rpc('adminStatus',['admin@example.test',password])).sessionId;
  await node.rpc('redeemQR',[d.checkin.token,id,'Track B',true]);
  setActive('admin@example.test');const direct=gas.adminStatus().sessionId;
  assert.equal(gas.redeemQR(d.checkin.token,direct,'Track B',true).alreadyRedeemed,true);
  gas.redeemQR(d.food.token,direct,'',true);
  assert.equal((await node.rpc('redeemQR',[d.food.token,id,'',true])).alreadyRedeemed,true);
  await node.rpc('logoutParticipant',[auth.sessionId]);assert.throws(()=>gas.getParticipantDashboard(auth.sessionId),/Session expired/);
  // The role must come from the shared sheet, including for Node staff logins.
  const sheet=gas.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Admins');sheet.appendRow(['staff@example.test','Staff',true,'subadmin']);
  const staff=await node.rpc('adminStatus',['staff@example.test',password]);assert.equal(staff.accessRole,'subadmin');
  await assert.rejects(()=>node.rpc('setTrackLimit',['Track C',1,staff.sessionId]),/Only lead admins/);
  assert.equal((await node.rpc('searchAdminParticipants',['Person2',staff.sessionId]))[0].id,'P2');
  assert.equal((await node.rpc('manualCheckin',['P2',staff.sessionId,'Track C',true])).ok,true);
  assert.equal((await node.rpc('getAdminDashboard',[staff.sessionId])).checkedIn,2);
});
test('Apps Script subadmins have check-in-only access and attendance totals stay consistent',()=>{
  const {gas,setActive,sheets}=fixture();sheets.Admins.push(['staff@example.test','Staff',true,'subadmin']);setActive('staff@example.test');
  const staff=gas.adminStatus();assert.equal(staff.accessRole,'subadmin');
  const before=gas.getAdminDashboard(staff.sessionId);assert.equal(before.total,2);assert.equal(before.checkedIn,0);assert.equal(before.notCheckedIn,2);
  const results=gas.searchAdminParticipants('Person',staff.sessionId);assert.equal(results.length,2);assert.equal(results[0].email,undefined);assert.equal(results[0].checkinToken,undefined);
  assert.throws(()=>gas.setTrackLimit('Track A',5,staff.sessionId),/Only lead admins/);
  const inspection=gas.manualCheckin('P1',staff.sessionId,'',false);assert.equal(inspection.manualCheckin,true);assert.equal(inspection.needsTrack,true);
  gas.manualCheckin('P1',staff.sessionId,'Track A',true);assert.equal(gas.manualCheckin('P1',staff.sessionId,'Track A',true).alreadyRedeemed,true);
  const after=gas.getAdminDashboard(staff.sessionId);assert.equal(after.checkedIn,1);assert.equal(after.notCheckedIn,1);
  const d=gas.getParticipantDashboard(gas.verifyParticipant('Person1','one@example.test').sessionId);
  assert.throws(()=>gas.redeemQR(d.food.token,staff.sessionId,'',true),/only redeem event check-in/);
  assert.equal(sheets.AuditLog.at(-1)[2],'MANUAL_CHECKIN');
});
test('signed bridge cannot give subadmins lead privileges and manual check-ins share the same limits',()=>{
  const {gas,properties,sheets}=fixture();const secret='test bridge secret with at least 32 characters';properties.set('BRIDGE_SECRET',secret);sheets.Admins.push(['staff@example.test','Staff',true,'subadmin']);
  const call=(method,args)=>JSON.parse(gas.doPost(signed(secret,method,args)).text);
  assert.equal(call('bridgeAdminStatus',['staff@example.test']).data.accessRole,'subadmin');
  assert.equal(call('bridgeSetTrackLimit',['Track A',1,'staff@example.test']).ok,false);
  assert.equal(call('bridgeSetTrackLimit',['Track A',1,'admin@example.test']).ok,true);
  assert.equal(call('bridgeManualCheckin',['P1','staff@example.test','Track A',true]).data.ok,true);
  assert.equal(call('bridgeManualCheckin',['P2','staff@example.test','Track A',true]).data.trackFull,true);
  const dashboard=call('bridgeGetAdminDashboard',['staff@example.test']).data;assert.equal(dashboard.checkedIn,1);assert.equal(dashboard.notCheckedIn,1);
  assert.equal(call('bridgeRedeemQR',[sheets.Participants[1][5],'staff@example.test','',true]).ok,false);
});
