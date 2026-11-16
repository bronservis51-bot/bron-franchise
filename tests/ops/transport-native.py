"""Cached native PG17 transport preflight, synthetic only, no ports or source."""
import importlib.util,json,shutil,subprocess,sys,tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
if len(sys.argv)!=1:raise RuntimeError("NATIVE_TRANSPORT_NO_ARGUMENTS")
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('native',str(HERE/'restore-native-pg17.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='t26-transport-wire-') as conf:
 f=m.Fixture(shutil.which('docker',path='/usr/local/bin:/usr/bin:/bin'),conf)
 try:
  f.create();f.sql('CREATE ROLE postgres LOGIN NOSUPERUSER;')
  r=subprocess.run([shutil.which('node'),str(HERE/'transport-native.mjs'),f.container,conf,f.docker],env=f.environment,text=True,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35)
  if r.returncode:raise RuntimeError('NATIVE_TRANSPORT_CHILD_FAILED')
  summary=json.loads(r.stdout);assert summary['result']=='PASS'
 finally:f.cleanup()
 summary['ownedContainerRemoved']=True;print(json.dumps(summary))
