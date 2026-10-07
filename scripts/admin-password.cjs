const crypto = require('node:crypto');
const readline = require('node:readline');
const rl = readline.createInterface({input:process.stdin,output:process.stdout});
rl.question('Password (use at least 16 characters): ', password => {
  if(password.length<16){console.error('Use at least 16 characters.');process.exitCode=1;}
  else {const salt=crypto.randomBytes(16).toString('hex');console.log('scrypt:'+salt+':'+crypto.scryptSync(password,salt,64).toString('hex'));}
  rl.close();
});
