import {useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {command} from '../../platform/backend';
import {operationKey} from '../../platform/operation';
import {dayLabel} from '../../platform/dates';
import {useSession} from '../../platform/session';
import {Button,Card,Checkbox,ConfirmDialog,DataState,Field,Input,MoneyInput,Select} from '../../ui';
import type {Shift} from './api';

type OpenShift=Shift&{user_name:string;location_name:string;currency:string;today:string;can_resolve:boolean;can_close:boolean};
/** Deliberate supervisor recovery; never auto-closes forgotten shifts or invents totals. */
export function ShiftReview({partner}:{partner:string}){
 const qc=useQueryClient();const [selected,setSelected]=useState<OpenShift|null>(null);
 const q=useQuery({queryKey:['staff','open-shifts',partner],queryFn:()=>command<OpenShift[]>('staff_open_shifts',{partner})});
 return <><DataState query={q}>{list=>list.length>0&&<Card title="Незакрытые смены"><div className="stack">{list.map(s=><div className="access-row row between" key={s.id}><div><strong>{s.user_name} · {dayLabel(s.day)}</strong><p className="faint">{s.location_name}{s.day<s.today?' · прошлая дата — нужна проверка':''}</p></div>{s.can_resolve&&<Button onClick={()=>setSelected(s)}>Разобрать</Button>}</div>)}</div></Card>}</DataState>
 {selected&&<Resolve shift={selected} onClose={()=>setSelected(null)} onDone={()=>{setSelected(null);void qc.invalidateQueries({queryKey:['staff']});void qc.invalidateQueries({queryKey:['staff-list']});void qc.invalidateQueries({queryKey:['revenue']});void qc.invalidateQueries({queryKey:['finance']});}}/>}
 </>;
}
function Resolve({shift:s,onClose,onDone}:{shift:OpenShift;onClose:()=>void;onDone:()=>void}){
 const {me}=useSession();const [action,setAction]=useState(s.can_close?'close':'cancel');const [reason,setReason]=useState('');const [cash,setCash]=useState('');const [card,setCard]=useState('');const [validCash,setValidCash]=useState(true);const [validCard,setValidCard]=useState(true);const [zero,setZero]=useState(false);
 const m=useMutation({mutationFn:async()=>{const args={shift:s.id,action,cash:action==='close'?cash:null,card:action==='close'?card:null,expected_revision:s.revision,reason:reason.trim()};const op=await operationKey(me!.user.id,'staff_shift_resolve',args);await command('staff_shift_resolve',{...args,operation:op.id});op.complete();},onSuccess:onDone});
 const bad=reason.trim().length<3||(action==='close'&&(cash===''||card===''||!validCash||!validCard||Number(cash)+Number(card)===0&&!zero));
 return <ConfirmDialog open title="Разобрать незакрытую смену" confirmLabel="Сохранить решение" busy={m.isPending} error={m.error} disabled={bad} onClose={onClose} onConfirm={()=>m.mutate()}><p><strong>{s.user_name}</strong> · {s.location_name} · {dayLabel(s.day)}</p>
 <Field label="Что произошло">{id=><Select id={id} value={action} onChange={e=>setAction(e.target.value)}><option value="close" disabled={!s.can_close}>Забыли закрыть — внести фактический итог</option><option value="cancel">Ошибочное открытие — отменить пустую смену</option></Select>}</Field>
 {action==='close'&&<><div className="grid grid-2"><Field label="Наличные">{id=><MoneyInput id={id} value={cash} onChange={setCash} requireExplicitValue onValidityChange={setValidCash} currency={s.currency}/>}</Field><Field label="Картой">{id=><MoneyInput id={id} value={card} onChange={setCard} requireExplicitValue onValidityChange={setValidCard} currency={s.currency}/>}</Field></div>{Number(cash)+Number(card)===0&&<Checkbox label="Сверили: продаж за смену не было" checked={zero} onChange={setZero}/>}<p className="faint">Итог записывается за указанную дату по сохранённым условиям смены. Укажите фактические суммы, согласованные с сотрудником. Закрытый период исправляет менеджер сети.</p></>}
 <Field label="Причина и что проверили" required>{id=><Input id={id} value={reason} onChange={e=>setReason(e.target.value)} maxLength={1000}/>}</Field><p className="faint">Решение и предыдущее состояние сохраняются в журнале.</p>
 </ConfirmDialog>;
}
