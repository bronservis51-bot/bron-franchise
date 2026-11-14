// Native Deno encryption fixture; synthetic only, module graph has no remote imports.
import {encryptSnapshot,PRIVATE_SNAPSHOT_PROTOCOL} from '../../docs/runbooks/payloads/source-https-reader/encrypt-snapshot.mjs';
const capability=new TextEncoder().encode('a'.repeat(64));
const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',capability));
const hash=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
const value={ok:true,protocol:PRIVATE_SNAPSHOT_PROTOCOL,projectRef:'synthetic-native-only',
 snapshot:{'data:public.synthetic':{count:2,hash:'1'.repeat(64)}},
 authRows:[{private_id:'00000000-0000-4000-8000-000000000001',private_stamp:'2026-11-14 00:00:00.000001+00',
  private_micros:'1794614400000001',private_other:'2'.repeat(64)}],
 unicode:'Ёлка 🔒 café café 東京',decimal:'1.00000000000000000001',bigint:'9007199254740993'};
const envelopes=[await encryptSnapshot(value,capability,hash),await encryptSnapshot(value,capability,hash)];
// Captured only through an anonymous pipe by the Node fixture; never a test log/file.
console.log(JSON.stringify({deno:Deno.version.deno,value,envelopes}));
