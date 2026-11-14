"""Synthetic PG17/real pg8.23.1 only, no source, host network ports or route changes."""
import importlib.util,json,shutil,subprocess,sys,tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
if len(sys.argv)!=1:raise RuntimeError('T31_NATIVE_NO_ARGUMENTS')
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('native',str(HERE/'restore-native-pg17.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='bron-t31-network-native-') as conf:
 f=m.Fixture(shutil.which('docker',path='/usr/local/bin:/usr/bin:/bin'),conf)
 try:
  f.create();f.sql('CREATE ROLE postgres LOGIN NOSUPERUSER;')
  result=subprocess.run([shutil.which('node'),str(HERE/'t31-source-network-native.mjs'),f.container,conf,f.docker],env=f.environment,text=True,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35)
  if result.returncode:raise RuntimeError('T31_NATIVE_CHILD_FAILED')
  summary=json.loads(result.stdout);assert summary['status']=='PASS'
 finally:f.cleanup()
 summary['ownedContainerRemoved']=True;print(json.dumps(summary))
