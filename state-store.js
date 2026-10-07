const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A local state directory has exactly one writer. Sheets mode shares its lock
// remotely; each Node frontend needs its own local admin-session directory.
class StateStore {
  constructor(directory) {
    fs.mkdirSync(directory, {recursive:true,mode:0o700});
    this.file=path.join(directory,'state.json');
    this.marker=path.join(directory,'initialized');
    this.lock=path.join(directory,'writer.lock');
    this.lockFd=fs.openSync(this.lock,'wx',0o600);
    try {
      fs.writeFileSync(this.lockFd,JSON.stringify({pid:process.pid}));
      if(!fs.existsSync(this.file)&&fs.existsSync(this.marker))throw new Error('Redemption state is missing. Restore its backup; do not reset live passes.');
      this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:3,participants:{},sessions:{},limits:{},audit:[]};
      if(this.data.version!==3||!this.data.participants||!this.data.sessions||!this.data.limits||!Array.isArray(this.data.audit))throw new Error('Invalid redemption state. Restore its backup.');
      this.write(this.data);
      if(!fs.existsSync(this.marker))fs.writeFileSync(this.marker,'3',{flag:'wx',mode:0o600});
    } catch(error){this.close();throw error;}
  }
  write(data) {
    const temporary=this.file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
    let fd;
    try {
      fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      fs.renameSync(temporary,this.file);
    } finally {
      if(fd!==undefined)fs.closeSync(fd);
      if(fs.existsSync(temporary))fs.unlinkSync(temporary);
    }
  }
  transaction(change) {
    const next=structuredClone(this.data);change(next);this.write(next);this.data=next;
  }
  close() {
    if(this.lockFd!==undefined){fs.closeSync(this.lockFd);this.lockFd=undefined;fs.unlinkSync(this.lock);}
  }
}
module.exports={StateStore};
