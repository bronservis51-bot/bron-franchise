import { useEffect,useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { command } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { formatMoneyShort } from '../../platform/money';
import { ActionError,Button,DataState,Field,Input,MoneyInput } from '../../ui';
export type PayPolicy={floor_minor:number;tiers:{from_minor:number;rate_bp:number;bonus_minor:number}[]};
export type ShiftPolicy=PayPolicy|{mode:'legacy';rate_bp:number;fee_minor:number};
export function calculatePay(total:bigint,rate:number,fee:number,policy?:ShiftPolicy|null):bigint{
 if(!policy)return BigInt(fee)+(total*BigInt(rate)+5000n)/10000n;
 if('mode' in policy)return BigInt(policy.fee_minor)+(total*BigInt(policy.rate_bp)+5000n)/10000n;
 const tier=[...policy.tiers].reverse().find(t=>BigInt(t.from_minor)<=total);
 if(!tier)return 0n;
 const percentage=(total*BigInt(tier.rate_bp)+5000n)/10000n;
 return (percentage>BigInt(policy.floor_minor)?percentage:BigInt(policy.floor_minor))+BigInt(tier.bonus_minor);
}
export function MotivationPanel({partner}:{partner:string}){
 const {can}=useSession();const qc=useQueryClient();const [edit,setEdit]=useState(false);
 const q=useQuery({queryKey:['motivation',partner],queryFn:()=>command<{version:number;policy:PayPolicy;currency:string}>('motivation_get',{partner})});
 const [policy,setPolicy]=useState<PayPolicy|null>(null);useEffect(()=>{if(q.data&&!policy)setPolicy(q.data.policy);},[q.data,policy]);
 const m=useMutation({mutationFn:()=>command('motivation_set',{partner,policy,expected_version:q.data!.version}),onSuccess:async()=>{await qc.invalidateQueries({queryKey:['motivation',partner]});setEdit(false);setPolicy(null);}});
 return <details className="team-accounts" data-unsaved={edit?'true':undefined}><summary>Мотивация сотрудников</summary><DataState query={q}>{d=>policy&&<><p>Заработок = максимум (фикс за выход, касса смены × процент ступени) + премия.</p><p className="faint">Граница включается в следующую ступень: ровно 5000 — уже 18%. Открытая смена сохраняет условия на момент её открытия; закрытые смены не пересчитываются. Суммы указаны в {d.currency}.</p>
 {edit?<><Field label="Минимум за смену">{id=><MoneyInput id={id} value={String(policy.floor_minor)} currency={d.currency} onChange={v=>setPolicy({...policy,floor_minor:Number(v)})}/>}</Field>{policy.tiers.map((t,i)=><div className="grid grid-3 quiz-question" key={i}><Field label="Касса от">{id=><MoneyInput id={id} currency={d.currency} value={String(t.from_minor)} onChange={v=>i!==0&&setPolicy({...policy,tiers:policy.tiers.map((x,n)=>n===i?{...x,from_minor:Number(v)}:x)})}/>}</Field><Field label="Процент">{id=><Input id={id} inputMode="decimal" value={t.rate_bp/100} onChange={e=>setPolicy({...policy,tiers:policy.tiers.map((x,n)=>n===i?{...x,rate_bp:Math.round(Number(e.target.value.replace(',','.'))*100)}:x)})}/>}</Field><Field label="Премия">{id=><MoneyInput id={id} currency={d.currency} value={String(t.bonus_minor)} onChange={v=>setPolicy({...policy,tiers:policy.tiers.map((x,n)=>n===i?{...x,bonus_minor:Number(v)}:x)})}/>}</Field></div>)}<div className="row"><Button onClick={()=>{setEdit(false);setPolicy(d.policy);}}>Отмена</Button><Button loading={m.isPending} variant="primary" onClick={()=>m.mutate()}>Сохранить мотивацию</Button></div></>:<><p>Минимум за смену: <strong>{formatMoneyShort(policy.floor_minor,d.currency)}</strong></p><div className="table-wrap"><table className="table"><thead><tr><th>Касса от</th><th>%</th><th>Премия</th></tr></thead><tbody>{policy.tiers.map(t=><tr key={t.from_minor}><td>{formatMoneyShort(t.from_minor,d.currency)}</td><td>{t.rate_bp/100}%</td><td>{formatMoneyShort(t.bonus_minor,d.currency)}</td></tr>)}</tbody></table></div>{can('team.manage')&&<Button onClick={()=>setEdit(true)}>Изменить условия</Button>}</>}<ActionError error={m.error}/></>}</DataState></details>;
}
