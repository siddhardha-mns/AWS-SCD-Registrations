const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const https=require('node:https');
const {Readable}=require('node:stream');
const {EventEmitter}=require('node:events');
const handler=require('../server');
const googleFixture=require('./helpers/google-fixture.cjs');
const secret='shared test bridge secret at least 32 chars';
function response(){return {headers:{},setHeader(key,value){this.headers[key]=value;},writeHead(status,headers={}){this.status=status;Object.assign(this.headers,headers);},end(body=''){this.body=body;this.writableEnded=true;}};}
function bridge(t){
  const fixture=googleFixture();fixture.properties.set('BRIDGE_SECRET',secret);
  t.mock.method(https,'request',(url,options,callback)=>{
    const request=new EventEmitter();request.end=body=>{const output=fixture.gas.doPost({postData:{contents:body}});const res=Readable.from([output.text]);res.statusCode=200;res.headers={};callback(res);};return request;
  });
  const config={SERVERLESS:true,PARTICIPANTS_URL:'https://example.test/exec',BRIDGE_SECRET:secret};
  return {...fixture,config};
}
test('Vercel default export is a function and public pages require no writable disk or environment setup',async t=>{
  assert.equal(typeof handler,'function');assert.equal(typeof handler.createApp,'function');
  t.mock.method(fs,'mkdirSync',()=>{throw new Error('Read-only filesystem');});
  for(const url of ['/','/?page=admin']){const res=response();await handler({method:'GET',url},res);assert.equal(res.status,200);assert.match(res.body,/window.NODE_PORTAL = true/);}
  const res=response();await handler({method:'GET',url:'/favicon.ico'},res);assert.equal(res.status,204);
});
test('missing Vercel configuration is returned as a clear RPC error instead of a process crash',async t=>{
  const previous=process.env.PARTICIPANTS_URL;delete process.env.PARTICIPANTS_URL;
  t.after(()=>{if(previous===undefined)delete process.env.PARTICIPANTS_URL;else process.env.PARTICIPANTS_URL=previous;});
  const res=response();
  await handler({method:'POST',url:'/api/rpc'},res);
  assert.equal(res.status,503);assert.match(JSON.parse(res.body).error,/PARTICIPANTS_URL.*Vercel/);
  await assert.rejects(()=>handler.createApp({SERVERLESS:true,PARTICIPANTS_FILE:'ignored.csv'}),/PARTICIPANTS_URL/);
});
test('shared admin sessions survive independent Vercel instances and logout revokes all of them',async t=>{
  const {config}=bridge(t);t.mock.method(fs,'mkdirSync',()=>{throw new Error('Must not create disk state');});
  const first=await handler.createApp(config),second=await handler.createApp(config);t.after(()=>{first.close();second.close();});
  const staff=await first.rpc('adminStatus',['staff@example.test']);
  assert.equal((await second.rpc('getAdminDashboard',[staff.sessionId])).accessRole,'subadmin');
  await second.rpc('manageParticipant',['P1',staff.sessionId,'track','Track A','Desk assignment',true]);
  const login=await first.rpc('verifyParticipant',['Person One','one@example.test']);
  assert.equal((await second.rpc('getParticipantDashboard',[login.sessionId])).track,'Track A');
  await first.rpc('manualCheckin',['P1',staff.sessionId,'Track A',true]);
  assert.equal((await second.rpc('getAdminDashboard',[staff.sessionId])).checkedIn,1);
  assert.equal((await second.rpc('manualCheckin',['P1',staff.sessionId,'Track A',true])).alreadyRedeemed,true);
  await second.rpc('logoutAdmin',[staff.sessionId]);
  await assert.rejects(()=>first.rpc('getAdminDashboard',[staff.sessionId]),/Session expired/);
});
test('email-only serverless gateway enforces current sheet roles, rejects forged sessions, and revokes inactive staff',async t=>{
  const {config,sheets}=bridge(t);const app=await handler.createApp(config);t.after(()=>app.close());
  const staff=await app.rpc('adminStatus',['staff@example.test']),lead=await app.rpc('adminStatus',['lead@example.test']);
  await assert.rejects(()=>app.rpc('manageParticipant',['P1',staff.sessionId,'hold','','Test',true]),/Only lead admins/);
  await assert.rejects(()=>app.rpc('manageParticipant',['P1',lead.sessionId,'track','Track A','Test',true]),/Only sub-admins/);
  await assert.rejects(()=>app.rpc('getAdminDashboard',['a'.repeat(72)]),/Session expired/);
  sheets.Admins[2][3]='admin';
  await assert.rejects(()=>app.rpc('manageParticipant',['P1',staff.sessionId,'track','Track A','Test',true]),/Only sub-admins/);
  sheets.Admins[1][2]=false;await assert.rejects(()=>app.rpc('getAdminDashboard',[lead.sessionId]),/Session expired/);
});

test('sheet-only login needs no configured hashes and rejects missing, inactive, duplicate, and invalid-role emails',async t=>{
  const {config,sheets}=bridge(t),app=await handler.createApp(config);t.after(()=>app.close());
  const login=await app.rpc('adminStatus',['  STAFF@EXAMPLE.TEST  ']);
  assert.equal(login.email,'staff@example.test');assert.equal(login.accessRole,'subadmin');
  await assert.rejects(()=>app.rpc('adminStatus',['not-an-email'],{ip:'invalid'}),/valid admin email/);
  await assert.rejects(()=>app.rpc('adminStatus',['unknown@example.test'],{ip:'unknown'}),/Admin authentication required/);
  sheets.Admins[2][2]=false;
  await assert.rejects(()=>app.rpc('adminStatus',['staff@example.test'],{ip:'inactive'}),/Admin authentication required/);
  sheets.Admins[2][2]=true;sheets.Admins.push([...sheets.Admins[2]]);
  await assert.rejects(()=>app.rpc('adminStatus',['staff@example.test'],{ip:'duplicate'}),/Admin authentication required/);
  sheets.Admins.pop();sheets.Admins[2][3]='owner';
  await assert.rejects(()=>app.rpc('adminStatus',['staff@example.test'],{ip:'role'}),/Admin authentication required/);
});

test('direct Apps Script email login does not require Google identity and rechecks role, active flag, and logout',()=>{
  const {gas,sheets}=googleFixture();
  assert.throws(()=>gas.adminStatus(),/valid admin email/);
  assert.throws(()=>gas.adminStatus('unknown@example.test'),/Access denied/);
  const login=gas.adminStatus(' STAFF@EXAMPLE.TEST ');
  assert.equal(login.accessRole,'subadmin');assert.equal(gas.getAdminDashboard(login.sessionId).accessRole,'subadmin');
  assert.throws(()=>gas.manageParticipant('P1',login.sessionId,'hold','','Test',true),/Only lead admins/);
  gas.manageParticipant('P1',login.sessionId,'track','Track A','Desk assignment',true);
  sheets.Admins[2][2]=false;assert.throws(()=>gas.getAdminDashboard(login.sessionId),/Admin authentication required/);
  sheets.Admins[2][2]=true;gas.logoutAdmin(login.sessionId);
  assert.throws(()=>gas.getAdminDashboard(login.sessionId),/Session expired/);
});

test('local demo uses a role email allowlist with no password and revokes a removed email',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'portal-email-login-'));
  let app;t.after(()=>{app?.close();fs.rmSync(directory,{recursive:true,force:true});});
  const file=path.join(directory,'participants.json');fs.writeFileSync(file,JSON.stringify([{ID:'P1',Name:'Person One',Email:'one@example.test',Phone:'9990000001'}]));
  const roles={'lead@example.test':'admin','staff@example.test':'subadmin'};
  app=await handler.createApp({PARTICIPANTS_FILE:file,STATE_DIR:path.join(directory,'state'),LEGACY_STATE_FILE:path.join(directory,'absent.json'),LEGACY_LIMITS_FILE:path.join(directory,'absent-limits.json'),ADMIN_ROLES:roles});
  const login=await app.rpc('adminStatus',['staff@example.test']);assert.equal(login.accessRole,'subadmin');
  await assert.rejects(()=>app.rpc('adminStatus',['unknown@example.test']),/Access denied/);
  await assert.rejects(()=>app.rpc('manageParticipant',['P1',login.sessionId,'hold','','Test',true]),/Only lead admins/);
  delete roles['staff@example.test'];await assert.rejects(()=>app.rpc('getAdminDashboard',[login.sessionId]),/Admin authentication required/);
});
test('Vercel parsed JSON and raw Node request bodies both reach the RPC handler',async t=>{
  const {config}=bridge(t),app=await handler.createApp(config);t.after(()=>app.close());
  const login=await app.rpc('verifyParticipant',['Person One','one@example.test']);
  const input={method:'getParticipantDashboard',args:[login.sessionId]};
  const headers={'content-type':'application/json',host:'localhost'};
  const parsed=response();await app.handler({method:'POST',url:'/api/rpc',headers,body:input},parsed);
  assert.equal(parsed.status,200);assert.equal(JSON.parse(parsed.body).data.id,'P1');
  const raw=Object.assign(Readable.from([JSON.stringify(input)]),{method:'POST',url:'/api/rpc',headers}),res=response();await app.handler(raw,res);
  assert.equal(res.status,200);assert.equal(JSON.parse(res.body).data.id,'P1');
});
