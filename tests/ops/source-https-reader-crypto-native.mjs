// Native Deno -> actual Node crypto envelope proof, synthetic data only.
import assert from 'node:assert/strict';
import {createHash,hkdfSync,createDecipheriv} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const protocol='BRON_PRIVATE_SNAPSHOT_V1';
const capability=Buffer.from('a'.repeat(64),'ascii');
const capSha=createHash('sha256').update(capability).digest('hex');
const deno='/tmp/source-https-probe-deno/deno';
const child=spawnSync(deno,['run','--no-config','--cached-only',
 fileURLToPath(new URL('./source-https-reader-crypto-native.ts',import.meta.url))],
 {encoding:'utf8',timeout:15000,maxBuffer:1048576,env:{PATH:'/usr/local/bin:/usr/bin:/bin',DENO_DIR:'/tmp/source-https-probe-deno/cache'},stdio:['ignore','pipe','pipe']});
try{
 assert.equal(child.status,0,'native Deno fixture failed');
 const result=JSON.parse(child.stdout);assert.match(result.deno,/^2\./);
 assert.equal(result.envelopes.length,2);
 const key=Buffer.from(hkdfSync('sha256',capability,Buffer.from(capSha,'utf8'),Buffer.from(protocol,'utf8'),32));
 const decrypt=(envelope,keyBytes)=>{
  assert.equal(envelope.protocol,protocol);
  assert.deepEqual(Object.keys(envelope).sort(),['ciphertext','nonce','protocol']);
  assert.match(envelope.nonce,/^[A-Za-z0-9+/]{16}$/);
  assert.match(envelope.ciphertext,/^[A-Za-z0-9+/]+={0,2}$/);
  const nonce=Buffer.from(envelope.nonce,'base64'),cipher=Buffer.from(envelope.ciphertext,'base64');
  assert.equal(nonce.length,12);assert.ok(cipher.length>16);
  const decipher=createDecipheriv('aes-256-gcm',keyBytes,nonce);
  decipher.setAuthTag(cipher.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(cipher.subarray(0,-16)),decipher.final()]).toString('utf8'));
 };
 for(const envelope of result.envelopes)assert.deepEqual(decrypt(envelope,key),result.value);
 assert.notEqual(result.envelopes[0].nonce,result.envelopes[1].nonce);
 assert.notEqual(result.envelopes[0].ciphertext,result.envelopes[1].ciphertext);
 const wrong=Buffer.from(hkdfSync('sha256',Buffer.from('b'.repeat(64),'ascii'),Buffer.from(capSha,'utf8'),Buffer.from(protocol,'utf8'),32));
 assert.throws(()=>decrypt(result.envelopes[0],wrong));
 const tampered=Buffer.from(result.envelopes[0].ciphertext,'base64');tampered[0]^=1;
 assert.throws(()=>decrypt({...result.envelopes[0],ciphertext:tampered.toString('base64')},key));
 const nonce=Buffer.from(result.envelopes[0].nonce,'base64');nonce[0]^=1;
 assert.throws(()=>decrypt({...result.envelopes[0],nonce:nonce.toString('base64')},key));
 console.log(JSON.stringify({status:'PASS',scope:'SYNTHETIC_DENO_NODE_ENVELOPE',deno:result.deno,node:process.versions.node,
  actualSharedEncryptionModule:true,hkdfSha256:true,aesGcm256:true,nonceBytes:12,tagBytes:16,
  unicodeDecimalMicrosecondBigintStringsExact:true,wrongKeyRejected:true,tamperRejected:true,nonceTamperRejected:true,
  randomizedEnvelopes:true,networkSourceVpsContact:false,noCapabilityOrCiphertextPrinted:true}));
}catch{
 console.error(JSON.stringify({status:'FAIL',scope:'SYNTHETIC_DENO_NODE_ENVELOPE',code:'NATIVE_ENVELOPE_FAILED'}));process.exitCode=1;
}
