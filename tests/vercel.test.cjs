const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const https=require('node:https');
const {Readable}=require('node:stream');
const {EventEmitter}=require('node:events');
const handler=require('../server');
const googleFixture=require('./helpers/google-fixture.cjs');
const secret='shared test bridge secret at least 32 chars',password='a long test admin password',salt='0'.repeat(32);
const credential='scrypt:'+salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
function response(){return {headers:{},setHeader(key,value){this.headers[key]=value;},writeHead(status,headers={}){this.status=status;Object.assign(this.headers,headers);},end(body=''){this.body=body;this.writableEnded=true;}};}
function bridge(t){
  const fixture=googleFixture();fixture.properties.set('BRIDGE_SECRET',secret);
  t.mock.method(https,'request',(url,options,callback)=>{
    const request=new EventEmitter();request.end=body=>{const output=fixture.gas.doPost({postData:{contents:body}});const res=Readable.from([output.text]);res.statusCode=200;res.headers={};callback(res);};return request;
  });
  const config={SERVERLESS:true,PARTICIPANTS_URL:'https://example.test/exec',BRIDGE_SECRET:secret,ADMIN_CREDENTIALS:{'lead@example.test':credential,'staff@example.test':credential}};
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
  const staff=await first.rpc('adminStatus',['staff@example.test',password]);
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
test('serverless gateway enforces shared roles, rejects forged sessions, and invalidates changed password configurations',async t=>{
  const {config,sheets}=bridge(t);const app=await handler.createApp(config);t.after(()=>app.close());
  const staff=await app.rpc('adminStatus',['staff@example.test',password]),lead=await app.rpc('adminStatus',['lead@example.test',password]);
  await assert.rejects(()=>app.rpc('manageParticipant',['P1',staff.sessionId,'hold','','Test',true]),/Only lead admins/);
  await assert.rejects(()=>app.rpc('manageParticipant',['P1',lead.sessionId,'track','Track A','Test',true]),/Only sub-admins/);
  await assert.rejects(()=>app.rpc('getAdminDashboard',['a'.repeat(72)]),/Session expired/);
  sheets.Admins[2][3]='admin';
  await assert.rejects(()=>app.rpc('manageParticipant',['P1',staff.sessionId,'track','Track A','Test',true]),/Only sub-admins/);
  const changed=await handler.createApp({...config,ADMIN_CREDENTIALS:{...config.ADMIN_CREDENTIALS,'staff@example.test':credential+'changed'}});t.after(()=>changed.close());
  await assert.rejects(()=>changed.rpc('getAdminDashboard',[staff.sessionId]),/Session expired/);
  sheets.Admins[1][2]=false;await assert.rejects(()=>app.rpc('getAdminDashboard',[lead.sessionId]),/Session expired/);
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
