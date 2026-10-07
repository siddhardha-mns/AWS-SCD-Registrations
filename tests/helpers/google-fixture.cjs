const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

module.exports=function googleFixture(){
  const headers=['Participant ID','Name','Phone','Email','Checkin Token','Food Token','Goodie Token','Checkin Redeemed','Food Redeemed','Goodie Redeemed','Track','Checked In At','Food Redeemed At','Goodie Redeemed At','College / Institution','Ticket Type','Registration Type','Registration On Hold'];
  const sheets={Participants:[headers,['P1','Person One','9990000001','one@example.test','','','',false,false,false,'','','','','','','',false],['P2','Person Two','9990000002','two@example.test','','','',false,false,false,'','','','','','','',false]],Admins:[['Email','Name','Active','Role'],['lead@example.test','Lead',true,'admin'],['staff@example.test','Staff',true,'subadmin']],AuditLog:[['Timestamp','Admin Email','Action','QR Type','Participant ID','Participant Name','Track','Result','Details']]};
  const properties=new Map([['PORTAL_OWNER_EMAIL','owner@example.test']]),cache=new Map();let locked=false;
  const prop={getProperties:()=>Object.fromEntries(properties),getProperty:key=>properties.get(key)||null,setProperty:(key,value)=>properties.set(key,value),deleteProperty:key=>properties.delete(key)};
  function sheet(name){
    if(!sheets[name])return null;
    return {getLastRow:()=>sheets[name].length,setFrozenRows(){},appendRow:row=>sheets[name].push(row),getRange:(row,col,height=1,width=1)=>({
      getValues:()=>Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>sheets[name][row-1+i]?.[col-1+j]??'')),
      setValue(value){assert.equal(locked,true);sheets[name][row-1]??=[];sheets[name][row-1][col-1]=value;},
      setValues(values){assert.equal(locked,true);values.forEach((cells,i)=>{sheets[name][row-1+i]??=[];cells.forEach((value,j)=>sheets[name][row-1+i][col-1+j]=value);});}
    })};
  }
  const gas=vm.createContext({Date,console,
    SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:sheet,insertSheet:name=>{sheets[name]=[];return sheet(name);}}),flush(){}},
    Utilities:{getUuid:()=>crypto.randomUUID(),formatDate:date=>date.toISOString(),DigestAlgorithm:{SHA_256:'sha256',SHA_1:'sha1'},computeDigest:(algo,text)=>[...crypto.createHash(algo).update(text).digest()],computeHmacSha256Signature:(text,key)=>[...crypto.createHmac('sha256',key).update(text).digest()]},
    PropertiesService:{getScriptProperties:()=>prop},CacheService:{getScriptCache:()=>({get:key=>cache.get(key),put:(key,value)=>cache.set(key,value)})},
    LockService:{getScriptLock:()=>({waitLock(){assert.equal(locked,false);locked=true;},releaseLock(){locked=false;}})},
    Session:{getActiveUser:()=>({getEmail:()=> 'owner@example.test'}),getScriptTimeZone:()=> 'UTC'},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../Code.gs'),'utf8'),gas);gas.setupSheets();
  return {gas,properties,sheets};
};
