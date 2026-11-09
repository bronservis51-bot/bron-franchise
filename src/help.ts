import '@fontsource-variable/montserrat';
import {config} from './platform/config';
import {checkConnection,connectionSummary,diagnosticText,type Connection} from './platform/connection';
const el=(id:string)=>document.getElementById(id)!;
let last:Connection|null=null;
const version=import.meta.env.VITE_BUILD_TIME ?? 'неизвестна';
el('version').textContent=`Сборка: ${version}`;
el('check').onclick=async()=>{
 const btn=el('check') as HTMLButtonElement; btn.disabled=true; el('local').textContent='Проверяем сервер входа и базу данных…';
 try {last=await checkConnection(config.supabaseUrl,config.supabaseKey); el('local').textContent=connectionSummary(last); el('diagnostic').textContent=diagnosticText(last,navigator.onLine,version);}
 finally{btn.disabled=false;}
};
el('copy').onclick=async()=>{const value=diagnosticText(last,navigator.onLine,version);el('diagnostic').textContent=value;
 try{await navigator.clipboard.writeText(value);el('copy-state').textContent='Диагностика скопирована. В ней нет пароля и данных заявок.';}
 catch{el('copy-state').textContent='Копирование недоступно. Выделите и скопируйте текст диагностики ниже.';}
};
el('external-check').onclick=async()=>{
 const btn=el('external-check') as HTMLButtonElement;btn.disabled=true;
 try{
  const r=await fetch('https://raw.githubusercontent.com/bronservis51-bot/bron-franchise/ops-status/status.json',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(12_000)});
  if(!r.ok)throw Error();const s=await r.json();const at=Date.parse(s.checked_at);const age=Date.now()-at;
  if(!Number.isFinite(at)||age>30*60_000||age< -60_000){el('external').textContent='Свежего результата нет. Проверяйте соединение с этого устройства и передайте диагностику.';return;}
  const checks=s.checks as Record<string,{ok:boolean}>;const good=['frontend','auth','data','landing'].every(k=>checks?.[k]?.ok===true);
  el('external').textContent=`${good?'Серверные проверки прошли.':'Внешняя проверка обнаружила сбой.'} Проверено ${new Date(at).toLocaleString('ru-RU')}.`;
 }catch{el('external').textContent='Результат внешней проверки недоступен. Это не доказывает сбой базы. Используйте проверку с этого устройства.';}
 finally{btn.disabled=false;}
};
