import os,pathlib,tempfile,subprocess,json,argparse,pexpect
parser=argparse.ArgumentParser(description='Synthetic age1.1.1 encrypted-identity feasibility proof; no real key inputs')
parser.add_argument('--age',required=True);parser.add_argument('--age-keygen',required=True)
args=parser.parse_args();AGE=args.age;GEN=args.age_keygen
phrase='SYNTHETIC-ONLY-OWNER-PASSPHRASE-20261114';stage='version'
def terminal(args,password,confirm=False):
 child=pexpect.spawn(AGE,args,encoding='utf-8',timeout=30,env={'PATH':'/usr/bin:/bin','LANG':'C','TERM':'xterm'})
 try:
  child.expect('Enter passphrase');child.expect(':');child.sendline(password)
  if confirm:child.expect('Confirm passphrase');child.expect(':');child.sendline(password)
  child.expect(pexpect.EOF);child.close();return child.exitstatus
 finally:
  if child.isalive():child.close(force=True)
try:
 assert subprocess.check_output([AGE,'--version'],text=True).strip() in ('1.1.1','v1.1.1')
 with tempfile.TemporaryDirectory(prefix='bron-escrow-native-') as raw:
  d=pathlib.Path(raw);os.chmod(d,0o700);key=d/'identity';wrapped=d/'identity.age';backup=d/'backup.age';out=d/'restored';bad=d/'wrong'
  stage='generate-synthetic';subprocess.run([GEN,'-o',str(key)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  recipient=subprocess.check_output([GEN,'-y',str(key)],text=True).strip()
  body=b'SYNTHETIC_BACKUP_ONLY\n'
  subprocess.run([AGE,'-r',recipient,'-o',str(backup)],input=body,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  stage='seal-synthetic-identity';assert terminal(['-p','-o',str(wrapped),str(key)],phrase,True)==0
  assert wrapped.read_bytes().startswith(b'age-encryption.org/v1\n') and b'-> scrypt ' in wrapped.read_bytes()[:200]
  key.unlink()
  stage='restore-through-encrypted-identity';assert terminal(['-d','-i',str(wrapped),'-o',str(out),str(backup)],phrase)==0
  assert out.read_bytes()==body
  stage='wrong-passphrase';assert terminal(['-d','-i',str(wrapped),'-o',str(bad),str(backup)],'SYNTHETIC-WRONG-PASSPHRASE')!=0
  assert not bad.exists() or bad.stat().st_size==0
  print(json.dumps({'status':'PASS','scope':'SYNTHETIC_CRYPTO_ONLY','age':'1.1.1','passphraseEncryptedIdentity':True,'rawIdentityRemovedBeforeRestore':True,'encryptedIdentityAsIdentityInput':True,'wrongPassphraseRejected':True,'actualVpsKeyRead':False,'S3Tested':False,'noActualSecretsPrinted':True}))
except Exception:
 print(json.dumps({'status':'FAIL','scope':'SYNTHETIC_CRYPTO_ONLY','phase':stage}));raise SystemExit(2)
