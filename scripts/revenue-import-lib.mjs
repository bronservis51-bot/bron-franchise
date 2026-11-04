// Bounded October/other-month grid reader. Empty cells are unknown, explicit zero is a report.
export function parseMonthlyRevenue(matrix, year, month) {
  const russian=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  const turkish=['ocak','şubat','mart','nisan','mayıs','haziran','temmuz','ağustos','eylül','ekim','kasım','aralık'];
  let selected=false, inSum=false, found=false; const days=new Map(); let statedTotal=null;
  const number=value=>{
    if(value===null||value===undefined||String(value).trim()==='')return null;
    const n=typeof value==='number'?value:Number(String(value).replace(/[\s\u00a0]/g,'').replace(',','.'));
    if(!Number.isFinite(n)||n<0||Math.abs(n*100-Math.round(n*100))>1e-6)throw new Error('Invalid revenue value');
    return Math.round(n*100);
  };
  for(let row=0;row<matrix.length;row++){
    const cells=matrix[row]; const label=String(cells[0]??'').trim().toLocaleLowerCase('ru').replace(/i̇/g,'i');
    const marker=russian.findIndex(m=>label===m||label.startsWith(m+' '));
    const tr=turkish.findIndex(m=>label===m||label.startsWith(m+' '));
    if(marker>=0||tr>=0){const m=(marker>=0?marker:tr)+1;const explicitYear=/\b(20\d{2})\b/.exec(label)?.[1]; selected=m===month&&(!explicitYear||Number(explicitYear)===year);inSum=false;if(selected)found=true;continue;}
    if(!selected)continue;
    if(/^сумма|^günlük/.test(label)){inSum=true;continue;}
    if(/^кол-во|^satış/.test(label))inSum=false;
    if(!inSum)continue;
    for(let c=0;c<10;c+=2){
      const raw=cells[c];let day=null;
      if(typeof raw==='number'&&raw>40000){const iso=new Date(Date.UTC(1899,11,30)+raw*86400000).toISOString().slice(0,10);if(iso.startsWith(`${year}-${String(month).padStart(2,'0')}-`))day=iso;}
      else {const d=/^(\d{1,2})\.(\d{2})$/.exec(String(raw??'').trim());if(d&&Number(d[2])===month&&Number(d[1])>=1&&Number(d[1])<=new Date(Date.UTC(year,month,0)).getUTCDate())day=`${year}-${String(month).padStart(2,'0')}-${d[1].padStart(2,'0')}`;}
      if(!day)continue;
      const minor=number(cells[c+1]);if(minor===null)continue;
      if(days.has(day))throw new Error('Duplicate date in revenue grid: '+day);
      days.set(day,minor);
    }
    if(String(cells[8]??'').includes('ФАКТ ЗА МЕСЯЦ'))statedTotal=number(cells[10]);
  }
  const total=[...days.values()].reduce((sum,n)=>sum+n,0);
  if(statedTotal!==null&&statedTotal!==total)throw new Error(`Daily sum ${total} differs from monthly total ${statedTotal}`);
  return {found,days:[...days.entries()].sort().map(([day,minor])=>({day,minor})),total,statedTotal};
}

export function planRevenueImport(source, existing) {
 const grouped=new Map();for(const row of existing){const key=`${row.location_id}:${row.day}`;grouped.set(key,[...(grouped.get(key)??[]),row]);}
 const plan={insert:[],update:[],unchanged:[],conflicts:[]};
 for(const row of source){
  const current=grouped.get(`${row.location_id}:${row.day}`)??[];
  const total=current.reduce((n,r)=>n+Number(r.total_minor),0);
  if(current.length&&total===row.minor){plan.unchanged.push(row);continue;}
  if(!current.length){plan.insert.push(row);continue;}
  if(current.length===1&&!current[0].employee_id&&!current[0].entered_by&&/Google.{0,30}(таблиц|Sheets)/i.test(current[0].comment??'')){
   plan.update.push({...row,previous:current[0]});
  }else plan.conflicts.push({...row,current});
 }
 return plan;
}
