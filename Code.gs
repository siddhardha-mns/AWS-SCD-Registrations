/** Deploy this file with Index.html. Node connects to this same deployment. */
const CONFIG = {PARTICIPANTS_SHEET:'Participants', ADMINS_SHEET:'Admins', AUDIT_SHEET:'AuditLog', TRACKS:['Track A','Track B','Track C','Track D'], SESSION_TTL_SECONDS:3600};
const PARTICIPANT_HEADERS = ['Participant ID','Name','Phone','Email','Checkin Token','Food Token','Goodie Token','Checkin Redeemed','Food Redeemed','Goodie Redeemed','Track','Checked In At','Food Redeemed At','Goodie Redeemed At','College / Institution','Ticket Type','Registration Type','Registration On Hold'];
const ADMIN_HEADERS = ['Email','Name','Active','Role'];
const AUDIT_HEADERS = ['Timestamp','Admin Email','Action','QR Type','Participant ID','Participant Name','Track','Result','Details'];

function doGet(e) {
  const page = e && e.parameter && e.parameter.page === 'admin' ? 'admin' : 'participant';
  const template = HtmlService.createTemplateFromFile('Index');
  template.page=page; template.tracks=trackIds_();
  return template.evaluate().setTitle('AWS Community Day — Event Portal').addMetaTag('viewport','width=device-width, initial-scale=1');
}
function withLock_(action) {
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try{return action();}finally{lock.releaseLock();}
}
function owner_() {
  const active=normalizeEmail_(Session.getActiveUser().getEmail());
  const owner=normalizeEmail_(PropertiesService.getScriptProperties().getProperty('PORTAL_OWNER_EMAIL'));
  if(!active||active!==owner)throw new Error('Run this maintenance operation as the script owner.');
}
function setupSheets() {
  owner_();
  return withLock_(()=>{
    const ss=SpreadsheetApp.getActiveSpreadsheet();
    for(const [name,headers] of [[CONFIG.PARTICIPANTS_SHEET,PARTICIPANT_HEADERS],[CONFIG.ADMINS_SHEET,ADMIN_HEADERS],[CONFIG.AUDIT_SHEET,AUDIT_HEADERS]]) {
      const sheet=ss.getSheetByName(name)||ss.insertSheet(name);
      if(!sheet.getLastRow())sheet.getRange(1,1,1,headers.length).setValues([headers]);
      else {
        const current=sheet.getRange(1,1,1,headers.length).getValues()[0];
        for(let i=0;i<headers.length;i++){if(current[i]&&current[i]!==headers[i])throw new Error('Unexpected sheet headers. Map the registration export to the documented schema first.');if(!current[i])sheet.getRange(1,i+1).setValue(headers[i]);}
      }
      sheet.setFrozenRows(1);
    }
    const sheet=participantsSheet_();
    seedTokens_(sheet,false);
    PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION','3');
    SpreadsheetApp.flush();return 'Sheets ready; old pass codes were replaced. Redemption flags preserved.';
  });
}
function rotatePassTokens() {
  owner_();return withLock_(()=>{seedTokens_(participantsSheet_(),true);SpreadsheetApp.flush();return 'All QR passes rotated. Existing downloaded passes are invalid.';});
}
function randomToken_() {return 'v4-'+Utilities.getUuid().replace(/-/g,'');}
function seedTokens_(sheet,force) {
  if(sheet.getLastRow()<2)return;
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,PARTICIPANT_HEADERS.length).getValues();
  const ids=new Set(),tokens=new Set();
  for(const row of rows) {
    if(!String(row[1]||'').trim())continue;
    row[0]=String(row[0]||'P-'+Utilities.getUuid());
    if(ids.has(row[0]))throw new Error('Duplicate participant ID. Correct the sheet before opening the portal.');
    ids.add(row[0]);
    for(const column of [4,5,6]) {
      if(force||!/^v4-[a-f0-9]{32}$/.test(String(row[column])))row[column]=randomToken_();
      if(tokens.has(row[column]))throw new Error('Duplicate QR token. Rotate passes before opening the portal.');
      tokens.add(row[column]);
    }
  }
  sheet.getRange(2,1,rows.length,PARTICIPANT_HEADERS.length).setValues(rows);
}
function participantsSheet_() {
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PARTICIPANTS_SHEET);
  if(!sheet)throw new Error('The owner must run setupSheets first.');
  return sheet;
}
function rows_() {
  const sheet=participantsSheet_();
  let rows=sheet.getLastRow()<2?[]:sheet.getRange(2,1,sheet.getLastRow()-1,PARTICIPANT_HEADERS.length).getValues();
  if(rows.some(r=>String(r[1]||'').trim()&&(!r[0]||!r[4]||!r[5]||!r[6]))) {
    seedTokens_(sheet,false);SpreadsheetApp.flush();
    rows=sheet.getRange(2,1,sheet.getLastRow()-1,PARTICIPANT_HEADERS.length).getValues();
  }
  const ids=new Set(),tokens=new Set();
  for(const r of rows) {
    if(!String(r[1]||'').trim())continue;
    if(!r[0]||ids.has(String(r[0])))throw new Error('Invalid participant IDs. Contact the organizer.');
    ids.add(String(r[0]));
    for(const col of [4,5,6]){if(!/^v4-[a-f0-9]{32}$/.test(String(r[col]))||tokens.has(String(r[col])))throw new Error('Pass setup required. Contact the organizer.');tokens.add(String(r[col]));}
  }
  return rows;
}
function normalizeName_(value){return String(value||'').trim().toLowerCase().replace(/\s+/g,' ');}
function normalizeEmail_(value){return String(value||'').trim().toLowerCase();}
function phone_(value) {
  const text=String(value||'').trim();if(!/^\+?[\d\s().-]+$/.test(text))return '';
  const n=text.replace(/\D/g,'');if(n.length===10)return n;if(n.length===12&&n.indexOf('91')===0)return n.slice(2);if(n.length===11&&n[0]==='0')return n.slice(1);return '';
}
function redeemed_(value){return value===true||value instanceof Date||/^(true|yes|1)$/i.test(String(value))||/^\d{4}-\d{2}-\d{2}/.test(String(value));}
function hex_(bytes){return bytes.map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');}
function throttle_(identity,max) {
  const cache=CacheService.getScriptCache();
  const key='RATE_'+hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,identity));
  const count=Number(cache.get(key)||0)+1;cache.put(key,String(count),60);
  if(count>max)throw new Error('Too many requests. Please wait one minute.');
}
function getParticipantNames(search) {
  return withLock_(()=>{
    const q=normalizeName_(search);if(q.length<2)return [];
    throttle_('search:'+q,60);
    return [...new Set(rows_().map(r=>String(r[1]||'').trim()).filter(Boolean))].filter(n=>normalizeName_(n).indexOf(q)!==-1).slice(0,40);
  });
}
function saveSession_(role,identity) {
  const properties=PropertiesService.getScriptProperties();
  const all=properties.getProperties();
  for(const key of Object.keys(all))if(key.indexOf('SESSION_')===0&&JSON.parse(all[key]).expiresAt<=Date.now())properties.deleteProperty(key);
    const id=Utilities.getUuid()+Utilities.getUuid();
  properties.setProperty('SESSION_'+id,JSON.stringify(Object.assign({role,expiresAt:Date.now()+3600000},identity)));
  return id;
}
function getSession_(id,role) {
  if(typeof id!=='string'||id.length>100)throw new Error('Session expired. Please log in again.');
  const properties=PropertiesService.getScriptProperties(),raw=properties.getProperty('SESSION_'+id);
  const session=raw?JSON.parse(raw):null;
  if(!session||session.expiresAt<=Date.now()){if(session)properties.deleteProperty('SESSION_'+id);throw new Error('Session expired. Please log in again.');}
  if(session.role!==role)throw new Error('Session expired. Please log in again.');
  return session;
}
function verifyParticipant(name,credential) {
  return withLock_(()=>{
    throttle_('login:'+normalizeName_(name),10);
    const email=String(credential||'').indexOf('@')!==-1;
    const matches=rows_().filter(r=>normalizeName_(name)&&normalizeName_(name)===normalizeName_(r[1])&&(email?normalizeEmail_(credential)===normalizeEmail_(r[3]):phone_(credential)&&phone_(credential)===phone_(r[2])));
    if(matches.length!==1)throw new Error('Verification failed. Check your registered name and contact details.');
    const row=matches[0];if(redeemed_(row[17]))throw new Error('Registration on hold. Contact the organizer.');
    const id=saveSession_('participant',{participantId:String(row[0]),identity:JSON.stringify([normalizeName_(row[1]),normalizeEmail_(row[3]),phone_(row[2])])});
    return {ok:true,sessionId:id,participant:{id:String(row[0]),name:row[1]}};
  });
}
function getParticipantDashboard(id) {
  return withLock_(()=>{
  const auth=getSession_(id,'participant');const row=rows_().find(r=>String(r[0])===auth.participantId);
  if(!row||auth.identity!==JSON.stringify([normalizeName_(row[1]),normalizeEmail_(row[3]),phone_(row[2])]))throw new Error('Session expired. Please log in again.');
  return participantResponse_(row);
  });
}
function participantResponse_(r) {
  if(redeemed_(r[17]))throw new Error('Registration on hold. Contact the organizer.');
  return {id:String(r[0]),name:r[1],college:r[14]||'',ticketType:r[15]||'',registrationType:r[16]||'',track:r[10]||'',checkedInAt:formatDate_(r[11]),checkin:{redeemed:redeemed_(r[7]),token:r[4],redeemedAt:formatDate_(r[11])},food:{redeemed:redeemed_(r[8]),token:r[5],redeemedAt:formatDate_(r[12])},goodie:{redeemed:redeemed_(r[9]),token:r[6],redeemedAt:formatDate_(r[13])}};
}
function formatDate_(v){return v instanceof Date?Utilities.formatDate(v,Session.getScriptTimeZone()||'GMT','yyyy-MM-dd HH:mm:ss'):String(v||'');}
function logoutParticipant(id){return withLock_(()=>{const properties=PropertiesService.getScriptProperties();const raw=properties.getProperty('SESSION_'+id);if(raw&&JSON.parse(raw).role==='participant')properties.deleteProperty('SESSION_'+id);return {ok:true};});}
function isAdmin_(email) {
  return !!adminRole_(email);
}
function adminRole_(email) {
  if(!email)return '';
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.ADMINS_SHEET);
  if(!sheet||sheet.getLastRow()<2)return '';
  const matches=sheet.getRange(2,1,sheet.getLastRow()-1,4).getValues().filter(r=>normalizeEmail_(r[0])===normalizeEmail_(email)&&/^(true|yes|1)$/i.test(String(r[2])));
  if(matches.length!==1)return '';
  const role=String(matches[0][3]||'admin').trim().toLowerCase();return ['admin','subadmin'].includes(role)?role:'';
}
function adminStatus() {
  return withLock_(()=>{
    const email=normalizeEmail_(Session.getActiveUser().getEmail());
    if(!isAdmin_(email))throw new Error('Sign in with an authorized Google account. If Google identity is unavailable, use the Node portal with an admin password.');
    return {authorized:true,email,accessRole:adminRole_(email),sessionId:saveSession_('admin',{email})};
  });
}
function adminAuth_(id) {
  const auth=getSession_(id,'admin');
  if(normalizeEmail_(Session.getActiveUser().getEmail())!==auth.email||!isAdmin_(auth.email))throw new Error('Admin authentication required.');
  return auth.email;
}
function logoutAdmin(id){return withLock_(()=>{const properties=PropertiesService.getScriptProperties();const raw=properties.getProperty('SESSION_'+id);if(raw&&JSON.parse(raw).role==='admin')properties.deleteProperty('SESSION_'+id);return {ok:true};});}
function trackCatalog_() {
  const catalog=JSON.parse(PropertiesService.getScriptProperties().getProperty('TRACK_CATALOG')||'[]');
  if(!Array.isArray(catalog)||new Set(catalog.map(t=>t.id)).size!==catalog.length||catalog.some(t=>typeof t.id!=='string'||!t.id.trim()))throw new Error('Invalid track catalog.');
  return catalog;
}
function trackIds_(){const catalog=trackCatalog_();return catalog.length?catalog.map(t=>t.id):CONFIG.TRACKS;}
function trackStats_(rows) {
  const limits=JSON.parse(PropertiesService.getScriptProperties().getProperty('TRACK_LIMITS')||'{}');
  const catalog=trackCatalog_();
  return trackIds_().map(track=>{const assigned=rows.filter(r=>r[10]===track),enrolled=assigned.length,checkedIn=assigned.filter(r=>redeemed_(r[7])).length;const configured=catalog.find(t=>t.id===track)?.capacity;const limit=Object.prototype.hasOwnProperty.call(limits,track)?limits[track]:(Number.isSafeInteger(configured)&&configured>0?configured:0);return {track,enrolled,reserved:enrolled,checkedIn,limit,available:limit?Math.max(0,limit-enrolled):null,full:!!limit&&enrolled>=limit};});
}
function getTrackStats(id){return withLock_(()=>{adminAuth_(id);return trackStats_(rows_());});}
function adminDashboard_(email) {
  const accessRole=adminRole_(email);if(!accessRole)throw new Error('Admin authentication required.');
  const rows=rows_().filter(r=>String(r[1]||'').trim()),checkedIn=rows.filter(r=>redeemed_(r[7])).length;
  const onHold=rows.filter(r=>redeemed_(r[17])).length,reserved=rows.filter(r=>String(r[10]||'').trim()).length;
  return {total:rows.length,checkedIn,notCheckedIn:rows.length-checkedIn,onHold,reserved,tracks:trackStats_(rows),accessRole};
}
function getAdminDashboard(id){return withLock_(()=>adminDashboard_(adminAuth_(id)));}
function searchParticipants_(search,email) {
  if(!adminRole_(email))throw new Error('Admin authentication required.');
  const query=normalizeName_(search);if(query.length<2)return [];
  return rows_().filter(r=>String(r[1]||'').trim()&&(String(r[0]).toLowerCase()===query||normalizeName_(r[1]).indexOf(query)!==-1)).slice(0,30).map(r=>({id:String(r[0]),name:r[1],college:r[14]||'',ticketType:r[15]||'',onHold:redeemed_(r[17]),checkedIn:redeemed_(r[7]),track:r[10]||''}));
}
function manageParticipant(participantId,id,action,value,reason,confirmed){return withLock_(()=>manageParticipant_(participantId,adminAuth_(id),action,value,reason,confirmed));}
function manageParticipant_(participantId,email,action,value,reason,confirmed){
  const role=adminRole_(email);
  if((action==='track'&&role!=='subadmin')||((action==='hold'||action==='restore')&&role!=='admin'))throw new Error(action==='track'?'Only sub-admins can assign tracks.':'Only lead admins can put registrations on hold or restore them.');
  if(confirmed!==true||typeof reason!=='string'||!reason.trim()||reason.length>500)throw new Error('Confirmation and a reason (1–500 characters) are required.');
  if(!['hold','restore','track'].includes(action))throw new Error('Invalid management action.');
  const rows=rows_(),index=rows.findIndex(r=>String(r[0])===participantId),row=rows[index];
  if(!row)throw new Error('Participant not found.');
  const before={track:row[10]||'',onHold:redeemed_(row[17])};
  if(action==='track'){
    if(before.onHold)throw new Error('Restore the registration before changing its track.');
    if(trackIds_().indexOf(value)===-1)throw new Error('Invalid track.');
    if(row[10]!==value&&trackStats_(rows).find(s=>s.track===value).full)throw new Error('This track is full.');
    row[10]=value;
  }else row[17]=action==='hold';
  // Revoke sessions before saving a hold: even if the write fails, access fails safe.
  if(action==='hold'){
    const properties=PropertiesService.getScriptProperties();
    for(const [key,raw] of Object.entries(properties.getProperties()))if(key.indexOf('SESSION_')===0){const s=JSON.parse(raw);if(s.role==='participant'&&s.participantId===participantId)properties.deleteProperty(key);}
  }
  participantsSheet_().getRange(index+2,1,1,PARTICIPANT_HEADERS.length).setValues([row]);SpreadsheetApp.flush();
  const audit=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.AUDIT_SHEET);
  if(audit)audit.appendRow([new Date(),email,role.toUpperCase()+'_'+action.toUpperCase(),'REGISTRATION',row[0],row[1],row[10],'SUCCESS',JSON.stringify({reason:reason.trim(),before,after:{track:row[10]||'',onHold:redeemed_(row[17])}})]);
  return {ok:true};
}
function searchAdminParticipants(search,id){return withLock_(()=>searchParticipants_(search,adminAuth_(id)));}
function manualCheckin_(participantId,email,track,confirmed) {
  if(!adminRole_(email))throw new Error('Admin authentication required.');
  const row=rows_().find(r=>String(r[0])===participantId);if(!row)throw new Error('Participant not found.');
  return Object.assign(redeemQR_(row[4],email,track,confirmed,true),{manualCheckin:true});
}
function manualCheckin(participantId,id,track,confirmed){return withLock_(()=>manualCheckin_(participantId,adminAuth_(id),track,confirmed));}
function leadAdmin_(email){if(adminRole_(email)!=='admin')throw new Error('Only lead admins can change track capacities.');}
function setTrackLimit(track,limit,id){return withLock_(()=>{leadAdmin_(adminAuth_(id));return setTrackLimit_(track,limit);});}
function setTrackLimit_(track,limit) {
  if(trackIds_().indexOf(track)===-1||!Number.isSafeInteger(limit)||limit<0)throw new Error('Invalid track capacity.');
  if(limit>0&&limit<trackStats_(rows_()).find(s=>s.track===track).enrolled)throw new Error('Capacity cannot be below the number of seats already reserved or checked in.');
  const p=PropertiesService.getScriptProperties(),limits=JSON.parse(p.getProperty('TRACK_LIMITS')||'{}');limits[track]=limit;p.setProperty('TRACK_LIMITS',JSON.stringify(limits));return {ok:true,stats:trackStats_(rows_())};
}
function importLegacyState_(records) {
  if(!Array.isArray(records)||records.length>10)throw new Error('Invalid legacy migration batch.');
  const rows=rows_();
  const updates=[];
  for(const record of records) {
    const matches=rows.map((r,i)=>({r,i})).filter(({r})=>String(r[0])===record.id||'P-'+hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1,normalizeEmail_(r[3]||r[1]))).slice(0,8).toUpperCase()===record.id);
    if(matches.length!==1)throw new Error('Legacy redeemed IDs could not be uniquely matched. Reconcile the sheet and local history before serving passes.');
    const {r,i}=matches[0];
    for(const [kind,flag,time] of [['checkin',7,11],['food',8,12],['goodie',9,13]])if(record[kind+'Redeemed']===true){r[flag]=true;if(!r[time])r[time]=String(record[kind==='checkin'?'checkedInAt':kind+'RedeemedAt']||'');}
    if(!r[10]&&trackIds_().indexOf(record.track)!==-1)r[10]=record.track;
    updates.push({row:i+2,values:r});
  }
  for(const update of updates)participantsSheet_().getRange(update.row,1,1,PARTICIPANT_HEADERS.length).setValues([update.values]);
  SpreadsheetApp.flush();return {ok:true,imported:updates.length};
}
function importLegacyLimits_(legacy) {
  const properties=PropertiesService.getScriptProperties(),limits=JSON.parse(properties.getProperty('TRACK_LIMITS')||'{}');
  for(const track of trackIds_())if(!Object.prototype.hasOwnProperty.call(limits,track)&&Number.isSafeInteger(legacy[track])&&legacy[track]>=0)limits[track]=legacy[track];
  properties.setProperty('TRACK_LIMITS',JSON.stringify(limits));return {ok:true};
}
function redeemQR(token,id,track,confirmed){return withLock_(()=>redeemQR_(token,adminAuth_(id),track,confirmed));}
function redeemQR_(token,admin,track,confirmed,manual) {
  if(!isAdmin_(admin))throw new Error('Admin authentication required.');
  if(typeof token!=='string'||!/^v4-[a-f0-9]{32}$/.test(token))throw new Error('Invalid QR pass.');
  const rows=rows_();let index=-1,column=-1;
  rows.forEach((r,i)=>{for(const c of [4,5,6])if(r[c]===token){index=i;column=c;}});
  if(index<0)throw new Error('Invalid QR pass.');
  const row=rows[index],kind=['checkin','food','goodie'][column-4];
  if(redeemed_(row[17]))throw new Error('Registration on hold. Only a lead admin can restore it.');
  if(adminRole_(admin)==='subadmin'&&kind!=='checkin')throw new Error('Sub-admins can only redeem event check-in passes.');
  const type=['Event Check-in','Lunch & Meals','Swag & Goodie Kit'][column-4];
  const base={type,participant:{id:String(row[0]),name:row[1],college:row[14]||'',ticketType:row[15]||'',registrationType:row[16]||''},participantId:String(row[0]),participantName:row[1]};
  if(redeemed_(row[column+3]))return Object.assign(base,{ok:false,alreadyRedeemed:true,redeemedAt:formatDate_(row[column+7]),track:row[10],message:'This pass was already redeemed.'});
  if(kind!=='checkin'&&!redeemed_(row[7]))throw new Error('Complete event check-in before collecting food or goodies.');
  if(kind==='checkin'&&row[10]) {
    if(confirmed!==true)return Object.assign(base,{ok:true,needsConfirmation:true,track:row[10],status:'Track already reserved'});
    if(track&&track!==row[10])throw new Error('The participant has already selected a track. It cannot be changed.');
    track=row[10];
  } else if(kind==='checkin') {
    if(trackIds_().indexOf(track)===-1||confirmed!==true)return Object.assign(base,{ok:true,needsTrack:true,canAssignTrack:adminRole_(admin)==='subadmin',tracks:trackIds_(),trackStats:trackStats_(rows)});
    if(adminRole_(admin)!=='subadmin')throw new Error('Only sub-admins can assign tracks. Ask a sub-admin to assign the participant first.');
    const chosen=trackStats_(rows).find(s=>s.track===track);if(chosen.full)return Object.assign(base,{ok:false,trackFull:true,track,limit:chosen.limit,enrolled:chosen.enrolled,message:'This track is full.'});
  }
  if(kind!=='checkin'&&confirmed!==true)return Object.assign(base,{ok:true,needsConfirmation:true,status:'Available'});
  const now=new Date();row[column+3]=true;row[column+7]=now;if(kind==='checkin')row[10]=track;
  participantsSheet_().getRange(index+2,1,1,PARTICIPANT_HEADERS.length).setValues([row]);
  SpreadsheetApp.flush();
  const audit=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.AUDIT_SHEET);
  if(audit)audit.appendRow([now,admin,manual?'MANUAL_CHECKIN':'REDEEM',kind,row[0],row[1],row[10],'SUCCESS','Pass redeemed']);
  return Object.assign(base,{ok:true,track:row[10],message:'Pass successfully redeemed.'});
}

/** Signed server-to-server RPC. Never place BRIDGE_SECRET in HTML or Git. */
function doPost(e) {
  try {
    const envelope=JSON.parse(e.postData.contents);
    if(typeof envelope.payload!=='string'||envelope.payload.length>16384)throw new Error('Invalid request.');
    const secret=PropertiesService.getScriptProperties().getProperty('BRIDGE_SECRET');
    if(!secret||secret.length<32)throw new Error('Bridge is not configured.');
    const expected=hex_(Utilities.computeHmacSha256Signature(envelope.payload,secret));
    const supplied=String(envelope.signature||'');let diff=expected.length^supplied.length;
    for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^(supplied.charCodeAt(i)||0);
    if(diff)throw new Error('Unauthorized request.');
    const request=JSON.parse(envelope.payload);
    if(!Number.isFinite(request.timestamp)||Math.abs(Date.now()-request.timestamp)>60000||!/^[a-f0-9]{32}$/.test(request.nonce)||!Array.isArray(request.args))throw new Error('Invalid or expired request.');
    withLock_(()=>{
      const properties=PropertiesService.getScriptProperties(),key='NONCE_'+request.nonce;
      if(properties.getProperty(key))throw new Error('Request already processed.');
      for(const [k,v] of Object.entries(properties.getProperties()))if(k.indexOf('NONCE_')===0&&Number(v)<Date.now())properties.deleteProperty(k);
      properties.setProperty(key,String(Date.now()+120000));
    });
    const methods={getParticipantNames,verifyParticipant,getParticipantDashboard,logoutParticipant,
      bridgeAdminStatus:email=>{if(!isAdmin_(email))throw new Error('Admin is not active in the sheet.');return {authorized:true,accessRole:adminRole_(email)};},
      bridgeGetAdminDashboard:email=>withLock_(()=>adminDashboard_(email)),
      bridgeSearchParticipants:(search,email)=>withLock_(()=>searchParticipants_(search,email)),
      bridgeManageParticipant:(id,email,action,value,reason,confirmed)=>withLock_(()=>manageParticipant_(id,email,action,value,reason,confirmed)),
      bridgeManualCheckin:(id,email,track,confirmed)=>withLock_(()=>manualCheckin_(id,email,track,confirmed)),
      bridgeGetTrackStats:email=>withLock_(()=>{if(!isAdmin_(email))throw new Error('Admin authentication required.');return trackStats_(rows_());}),
      bridgeImportLegacyState:records=>withLock_(()=>importLegacyState_(records)),
      bridgeImportLegacyLimits:limits=>withLock_(()=>importLegacyLimits_(limits)),
      bridgeSetTrackLimit:(track,limit,email)=>withLock_(()=>{leadAdmin_(email);return setTrackLimit_(track,limit);}),
      bridgeRedeemQR:(token,email,track,confirmed)=>withLock_(()=>redeemQR_(token,email,track,confirmed))};
    if(!Object.prototype.hasOwnProperty.call(methods,request.method))throw new Error('Unknown request.');
    return json_({ok:true,data:methods[request.method].apply(null,request.args)});
  } catch(error){return json_({ok:false,error:error.message||'Request failed.'});}
}
function json_(value){return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);}
