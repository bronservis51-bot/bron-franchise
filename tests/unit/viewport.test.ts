import { afterEach,expect,it,vi } from 'vitest';
import { startViewport } from '../../src/platform/viewport';
afterEach(()=>vi.unstubAllGlobals());
it('recognizes a keyboard when Safari shrinks innerHeight as well and keeps panning on the dialog only',()=>{
 const events:Record<string,()=>void>={};const props:Record<string,string>={};const classes:Record<string,boolean>={};let input=false;
 const vv={height:800,offsetTop:0,addEventListener:(n:string,fn:()=>void)=>events[n]=fn,removeEventListener:vi.fn()};
 const win={innerHeight:800,innerWidth:390,visualViewport:vv,matchMedia:()=>({matches:true}),addEventListener:vi.fn(),removeEventListener:vi.fn()};
 vi.stubGlobal('window',win);vi.stubGlobal('document',{documentElement:{style:{setProperty:(k:string,v:string)=>props[k]=v},classList:{toggle:(k:string,v:boolean)=>classes[k]=v}},get activeElement(){return {matches:()=>input};},addEventListener:vi.fn(),removeEventListener:vi.fn()});
 vi.stubGlobal('requestAnimationFrame',(fn:()=>void)=>{fn();return 1;});vi.stubGlobal('cancelAnimationFrame',vi.fn());
 const stop=startViewport();expect(props['--app-height']).toBe('800px');
 input=true;win.innerHeight=480;vv.height=480;vv.offsetTop=150;events.resize();
 expect(classes['keyboard-open']).toBe(true);expect(props['--visual-top']).toBe('150px');expect(props).not.toHaveProperty('--app-top');
 input=false;win.innerHeight=800;vv.height=800;vv.offsetTop=0;events.resize();expect(classes['keyboard-open']).toBe(false);stop();
});
