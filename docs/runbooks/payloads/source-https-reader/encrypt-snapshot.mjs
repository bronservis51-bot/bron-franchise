// Import-only WebCrypto envelope shared by native Deno and Node interoperability tests.
export const PRIVATE_SNAPSHOT_PROTOCOL='BRON_PRIVATE_SNAPSHOT_V1';
const encoder=new TextEncoder();
const base64=bytes=>{
 let binary='';
 for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(binary);
};
export async function encryptSnapshot(value,capability,capabilitySha256){
 if(!(capability instanceof Uint8Array)||capability.length!==64||
   !capability.every(b=>b>=48&&b<=57||b>=97&&b<=102)||
   !/^[a-f0-9]{64}$/.test(capabilitySha256))throw Error('encryption-input');
 const plaintext=encoder.encode(JSON.stringify(value));
 if(plaintext.length>700000)throw Error('response-bound');
 const input=await crypto.subtle.importKey('raw',capability,'HKDF',false,['deriveKey']);
 const key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',
   salt:encoder.encode(capabilitySha256),info:encoder.encode(PRIVATE_SNAPSHOT_PROTOCOL)},input,
   {name:'AES-GCM',length:256},false,['encrypt']);
 const nonce=crypto.getRandomValues(new Uint8Array(12));
 const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,tagLength:128},key,plaintext));
 const envelope={protocol:PRIVATE_SNAPSHOT_PROTOCOL,nonce:base64(nonce),ciphertext:base64(ciphertext)};
 if(encoder.encode(JSON.stringify(envelope)).length>1048576)throw Error('response-bound');
 return envelope;
}
