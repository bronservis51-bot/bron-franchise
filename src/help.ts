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
  const r=await fetch('https://api.github.com/repos/bronservis51-bot/bron-franchise/actions/workflows/availability.yml/runs?status=completed&per_page=1',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(12_000)});
  if(!r.ok)throw Error();const response=await r.json();const run=response.workflow_runs?.[0];const at=Date.parse(run?.updated_at);const age=Date.now()-at;
  if(!Number.isFinite(at)||age>30*60_000||age< -60_000){el('external').textContent='Свежего результата нет. Проверяйте соединение с этого устройства и передайте диагностику.';return;}
  el('external').textContent=`${run.conclusion==='success'?'Серверные проверки прошли.':'Внешняя проверка не завершилась успешно. Нужна проверка техническим специалистом.'} Запуск завершён ${new Date(at).toLocaleString('ru-RU')}.`;

 }catch{el('external').textContent='Результат внешней проверки недоступен. Это не доказывает сбой базы. Используйте проверку с этого устройства.';}
 finally{btn.disabled=false;}
};
