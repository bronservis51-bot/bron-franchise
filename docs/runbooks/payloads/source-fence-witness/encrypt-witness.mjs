// WebCrypto only; protocol-specific HKDF separates this technical reader from T37.
export const SOURCE_FENCE_WITNESS_PROTOCOL='BRON_SOURCE_FENCE_WITNESS_V1';
const encoder=new TextEncoder();
const base64=bytes=>{
 let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(text);
};
export async function encryptWitness(value,capability,capabilitySha256){
 if(!(capability instanceof Uint8Array)||capability.length!==64||
  !capability.every(b=>b>=48&&b<=57||b>=97&&b<=102)||!/^[a-f0-9]{64}$/.test(capabilitySha256))
  throw Error('encryption-input');
 const plaintext=encoder.encode(JSON.stringify(value));
 if(plaintext.length>65536)throw Error('metadata-response-bound');
 const input=await crypto.subtle.importKey('raw',capability,'HKDF',false,['deriveKey']);
 const key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(capabilitySha256),
  info:encoder.encode(SOURCE_FENCE_WITNESS_PROTOCOL)},input,{name:'AES-GCM',length:256},false,['encrypt']);
 const nonce=crypto.getRandomValues(new Uint8Array(12));
 const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,tagLength:128},key,plaintext));
 const envelope={protocol:SOURCE_FENCE_WITNESS_PROTOCOL,nonce:base64(nonce),ciphertext:base64(ciphertext)};
 if(encoder.encode(JSON.stringify(envelope)).length>131072)throw Error('metadata-response-bound');
 return envelope;
}
