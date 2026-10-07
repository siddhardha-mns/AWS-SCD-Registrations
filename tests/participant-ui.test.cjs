const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {renderHtml}=require('../server');

function fixture(saved={},page='participant') {
  const elements=new Map(),storage=new Map(Object.entries(saved)),requests=[],downloads=[],canvasText=[];
  class Element {
    constructor(tag='div') {
      this.tag=tag;this.children=[];this.textContent='';this.innerHTML='';this.className='';this.value='';this.dataset={};this.listeners={};this.style={};
      const classes=new Set();this.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)};
    }
    addEventListener(event,fn){this.listeners[event]=fn;}
    append(...children){this.children.push(...children);}
    appendChild(child){this.children.push(child);}
    removeChild(child){this.children=this.children.filter(c=>c!==child);}
    replaceChildren(...children){this.children=children;this.textContent='';this.innerHTML='';}
    querySelector(tag){return this.children.find(c=>c.tag===tag)||null;}
    querySelectorAll(){return this.children;}
    focus(){}contains(child){return this.children.includes(child);}
    click(){if(this.tag==='a')downloads.push({name:this.download,href:this.href});else this.listeners.click?.();}
    remove(){}scrollIntoView(){}
    toDataURL(){return 'data:image/png;base64,synthetic';}
    getContext(){return {fillRect(){},fillText(text){canvasText.push(text);},drawImage(){}};}
  }
  const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const document={getElementById:el,addEventListener(){},createElement:tag=>new Element(tag),body:new Element(),hidden:false};
  function runner(success,failure) {return new Proxy({}, {get:(_,key)=>key==='withSuccessHandler'?fn=>runner(fn,failure):key==='withFailureHandler'?fn=>runner(success,fn):(...args)=>requests.push({method:key,args,success,failure})});}
  function QRCode(node){node.children=[new Element('canvas'),Object.assign(new Element('img'),{src:''})];}
  QRCode.CorrectLevel={L:1};
  const context=vm.createContext({document,window:{NODE_PORTAL:true},QRCode,google:{script:{run:runner()}},sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},setInterval(){},setTimeout(){},clearTimeout(){},cancelAnimationFrame(){},navigator:{clipboard:{writeText:()=>Promise.resolve()},mediaDevices:{getUserMedia:()=>Promise.reject(new Error('No test camera'))}},alert(){},console});
  const rendered=renderHtml(fs.readFileSync(path.join(__dirname,'../Index.html'),'utf8'),page);
  const script=[...rendered.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].find(m=>m[1].includes('let currentSessionId'))[1];
  context.confirm=()=>true;
  context.prompt=()=> 'Approved test action';
  new vm.Script(script);vm.runInContext(script,context);
  return {context,el,requests,downloads,canvasText,storage};
}
function data(id='P1',extra={}){return {id,name:'Person '+id,college:'First College',ticketType:'Student',checkin:{token:'v4-'+ '1'.repeat(32),redeemed:false},food:{token:'v4-'+ '2'.repeat(32),redeemed:false},goodie:{token:'v4-'+ '3'.repeat(32),redeemed:false},...extra};}
function authenticate(f,id='session1') {
  f.el('nameSearch').value='Person1';f.el('credential').value='one@example.test';f.context.submitVerification();
  const login=f.requests.findLast(r=>r.method==='verifyParticipant');login.success({ok:true,sessionId:id});
  f.requests.findLast(r=>r.method==='getParticipantDashboard').success(data());
}

test('lead controls appear only for leads and require confirmation and a reason',()=>{
  const f=fixture({},'admin');vm.runInContext("currentAdminSessionId='admin-session';currentAdminRole='admin';cachedTrackStats=[{track:'Track A'}];",f.context);
  f.el('manualParticipantSearch').value='Person';f.context.searchManualParticipants();
  f.requests.findLast(r=>r.method==='searchAdminParticipants').success([{id:'P1',name:'Person1',onHold:false,track:'Track A'}]);
  const row=f.el('manualParticipantResults').children[0];assert.equal(row.children[2].textContent,'Put On Hold');assert.equal(row.children[4].textContent,'Change Track');
  f.context.prompt=()=>null;row.children[2].click();assert.equal(f.requests.some(r=>r.method==='manageParticipant'),false);
  f.context.prompt=()=> 'Review needed';row.children[2].click();assert.deepEqual(Array.from(f.requests.findLast(r=>r.method==='manageParticipant').args),['P1','admin-session','hold','','Review needed',true]);
  vm.runInContext("currentAdminRole='subadmin';",f.context);f.context.searchManualParticipants();
  f.requests.findLast(r=>r.method==='searchAdminParticipants').success([{id:'P1',name:'Person1',onHold:true}]);
  const sub=f.el('manualParticipantResults').children[0];assert.equal(sub.children.length,2);assert.equal(sub.children[1].disabled,true);
  assert.match(sub.children[0].textContent,/On Hold/);
});

test('track cards show speakers and require confirmation before locking the final selection',()=>{
  const f=fixture();authenticate(f);
  const options=['Track A','Track B','Track C'].map(track=>({track,title:track,description:'Parallel workshop',limit:1,available:1,bookingEnabled:true,sessions:[{title:'Hands-on',speaker:'Workshop Host',time:'10:00'}]}));
  f.context.renderDashboard(data('P1',{trackOptions:options,commonSessions:[{title:'Welcome',speaker:'Common Host'}]}));
  assert.match(f.el('commonSessions').children[1].textContent,/Welcome.*Common Host/);
  const card=f.el('participantTrackOptions').children[0];assert.match(card.children[3].textContent,/Hands-on.*Workshop Host.*10:00/);
  f.context.confirm=()=>false;card.children.at(-1).click();assert.equal(f.requests.some(r=>r.method==='selectParticipantTrack'),false);
  let warning='';f.context.confirm=text=>{warning=text;return true;};card.children.at(-1).click();
  assert.match(warning,/CANNOT be changed/);
  const pending=f.requests.findLast(r=>r.method==='selectParticipantTrack');assert.deepEqual(Array.from(pending.args),['session1','Track A',true]);
  pending.success({ok:true,track:'Track A'});
  assert.ok(f.el('participantTrackOptions').children.every(c=>c.children.at(-1).disabled));
  assert.match(f.el('trackSelectionStatus').textContent,/selection is final/);
  f.context.selectTrack('Track B','Track B');assert.equal(f.requests.filter(r=>r.method==='selectParticipantTrack').length,1);
});

test('staff confirmation preserves the reserved track instead of a stale assignment selector',()=>{
  const f=fixture({},'admin');vm.runInContext("currentAdminSessionId='admin-session';",f.context);
  f.el('popupTrackSelect').value='Track B';
  f.context.openRedemptionPopup({ok:true,needsConfirmation:true,track:'Track A',type:'Event Check-in',participant:{id:'P1',name:'Person1'}},'token');
  f.context.executePopupAction();assert.equal(f.requests.findLast(r=>r.method==='redeemQR').args[2],'Track A');
});
test('autocomplete renders malicious and apostrophe names as text with safe click handlers',()=>{
  const f=fixture();const names=["O'Neil","');globalThis.compromised=true;//",'<img src=x onerror=alert(1)>'];
  f.context.renderSuggestions(names,'');
  const items=f.el('autocompleteDropdown').children;assert.equal(items.length,3);
  items.forEach((item,i)=>{assert.equal(item.children[1].textContent,names[i]);assert.equal(item.innerHTML,'');item.click();assert.equal(f.el('nameSearch').value,names[i]);});
  assert.equal(f.context.compromised,undefined);
});
test('logout revokes session and clears passes, and switches clear optional metadata',()=>{
  const f=fixture();authenticate(f);assert.equal(f.storage.get('participantSession'),'session1');
  f.context.logOutParticipant();assert.equal(f.storage.has('participantSession'),false);
  assert.equal(f.requests.findLast(r=>r.method==='logoutParticipant').args[0],'session1');
  for(const id of ['checkinQr','foodQr','goodieQr','checkinCodeText','participantCollege','participantTicketType'])assert.equal(f.el(id).textContent,'');
  f.context.renderDashboard(data('P2',{college:'',ticketType:''}));assert.equal(f.el('participantCollege').textContent,'');assert.equal(f.el('participantTicketType').textContent,'');
});
test('late dashboard callbacks cannot expose the previous participant after logout',()=>{
  const f=fixture();authenticate(f);f.context.loadDashboardData();const pending=f.requests.findLast(r=>r.method==='getParticipantDashboard');
  f.context.logOutParticipant();pending.success(data());
  assert.equal(f.el('participantName').textContent,'');assert.equal(f.el('dashboardSection').classList.contains('hidden'),true);
});
test('refresh restores the session and expiration removes visible passes',()=>{
  const f=fixture({participantSession:'saved-session'});
  const pending=f.requests.findLast(r=>r.method==='getParticipantDashboard');assert.equal(pending.args[0],'saved-session');
  pending.failure(new Error('Session expired. Please log in again.'));
  assert.equal(f.storage.has('participantSession'),false);assert.equal(f.el('dashboardSection').classList.contains('hidden'),true);
});
test('QR and full ticket downloads contain attendee-specific names and use available canvas',()=>{
  const f=fixture();authenticate(f);
  f.context.saveQrImage('checkinQr','Checkin-QR');assert.equal(f.downloads[0].name,'Checkin-QR-P1.png');
  f.context.downloadTicket();f.requests.findLast(r=>r.method==='getParticipantDashboard').success(data());
  assert.equal(f.downloads[1].name,'AWS-Ticket-P1.png');assert.match(f.downloads[1].href,/^data:image\/png/);
  for(const text of ['AWS Community Day','Person P1','Participant ID: P1','Event Check-in','Lunch & Meals','Swag & Goodies'])assert.ok(f.canvasText.includes(text));
});
test('a pending ticket download cannot complete after logout',()=>{
  const f=fixture();authenticate(f);f.context.downloadTicket();const pending=f.requests.findLast(r=>r.method==='getParticipantDashboard');
  f.context.logOutParticipant();pending.success(data());assert.equal(f.downloads.length,0);
});
test('admin track controls are available globally and rejected redemptions are not shown as completed',()=>{
  const f=fixture({},'admin');
  assert.equal(typeof f.context.loadTrackStats,'function');assert.equal(typeof f.context.saveTrackLimit,'function');
  vm.runInContext("currentAdminSessionId='admin-session';currentAdminEmail='admin@example.test';",f.context);
  f.context.loadTrackStats();const stats=f.requests.findLast(r=>r.method==='getAdminDashboard');assert.equal(stats.args[0],'admin-session');
  stats.success({total:2,checkedIn:0,notCheckedIn:2,accessRole:'admin',tracks:[{track:'Track A',limit:1,enrolled:0,available:1,full:false}]});
  assert.match(f.el('trackStatsGrid').innerHTML,/Track A/);
  f.context.openRedemptionPopup({ok:true,needsConfirmation:true,type:'Lunch & Meals',participant:{id:'P1',name:'Person1'}},'token');
  f.context.executePopupAction();const pending=f.requests.findLast(r=>r.method==='redeemQR');
  pending.success({ok:false,alreadyRedeemed:true,type:'Lunch & Meals',participant:{id:'P1',name:'Person1'},message:'Already redeemed'});
  assert.equal(f.el('popupStatusBadge').textContent,'⚠️ Already Redeemed');assert.equal(f.el('scanResultBox').innerHTML,'');
});
test('late scanner callbacks cannot reveal attendee details after admin sign-out',()=>{
  const f=fixture({},'admin');vm.runInContext("currentAdminSessionId='admin-session';",f.context);
  f.context.handleScannedToken('token');const pending=f.requests.findLast(r=>r.method==='redeemQR');
  f.context.logOutAdmin();pending.success({ok:true,needsConfirmation:true,participant:{name:'Person1'}});
  assert.equal(f.el('popupParticipantName').textContent,'');assert.equal(f.el('scanPopupModal').classList.contains('hidden'),true);
});
test('admin attendance counters render and subadmins cannot see capacity editing controls',()=>{
  const f=fixture({},'admin');f.context.renderAdminDashboard({total:184,checkedIn:24,notCheckedIn:160,accessRole:'subadmin',tracks:[{track:'Track A',limit:50,enrolled:24,available:26,full:false}]});
  assert.equal(f.el('totalParticipantCount').textContent,'184');assert.equal(f.el('checkedInCount').textContent,'24');assert.equal(f.el('notCheckedInCount').textContent,'160');
  assert.equal(f.el('adminRoleBadge').textContent,'Check-in Sub-admin');assert.doesNotMatch(f.el('trackStatsGrid').innerHTML,/track-limit-input|saveTrackLimit/);
});
test('manual participant selection performs a confirmed manual check-in without exposing a token',()=>{
  const f=fixture({},'admin');vm.runInContext("currentAdminSessionId='admin-session';currentAdminRole='subadmin';",f.context);
  f.el('manualParticipantSearch').value='Person';f.context.searchManualParticipants();
  const search=f.requests.findLast(r=>r.method==='searchAdminParticipants');assert.equal(search.args[1],'admin-session');
  search.success([{id:'P1',name:"O'Neil <script>",checkedIn:false}]);
  const result=f.el('manualParticipantResults').children[0];assert.match(result.children[0].textContent,/O'Neil <script>/);result.children[1].click();
  const inspect=f.requests.findLast(r=>r.method==='manualCheckin');assert.equal(inspect.args[0],'P1');assert.equal(inspect.args[3],false);
  inspect.success({manualCheckin:true,participantId:'P1',ok:true,needsTrack:true,type:'Event Check-in',participant:{id:'P1',name:'Person1'},trackStats:[{track:'Track A',limit:50,enrolled:0,full:false}]});
  f.context.executePopupAction();const confirm=f.requests.findLast(r=>r.method==='manualCheckin');assert.equal(confirm.args[0],'P1');assert.equal(confirm.args[2],'Track A');assert.equal(confirm.args[3],true);
  confirm.success({ok:true,type:'Event Check-in',participantName:'Person1',message:'Checked in'});
  assert.ok(f.requests.some(r=>r.method==='getAdminDashboard'));
});
test('a pending camera permission result is stopped when the admin signs out',async()=>{
  const f=fixture({},'admin');vm.runInContext("currentAdminSessionId='admin-session';",f.context);
  let resolve,stopped=0;f.context.navigator.mediaDevices.getUserMedia=()=>new Promise(done=>{resolve=done;});
  const pending=f.context.startScanner();f.context.logOutAdmin();resolve({getTracks:()=>[{stop:()=>stopped++}]});await pending;
  assert.equal(stopped,1);assert.equal(f.el('scannerVideo').srcObject,null);assert.equal(f.el('scannerContainer').classList.contains('hidden'),true);
});
test('manual check-in stays available when camera APIs are unavailable',async()=>{
  const f=fixture({},'admin');vm.runInContext("currentAdminSessionId='admin-session';",f.context);f.context.navigator.mediaDevices=undefined;
  await f.context.startScanner();assert.match(f.el('scanStatusAlert').textContent,/manual participant check-in/);
  f.context.inspectManualParticipant('P1');assert.ok(f.requests.some(r=>r.method==='manualCheckin'));
});
