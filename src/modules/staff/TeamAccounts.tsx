import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command,from,rows } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { Button, Checkbox, ConfirmDialog, DataState, Field, Input, PageHeader } from '../../ui';
import { StaffHome } from './StaffHome';
import { DailyLearning } from '../learning/Learning';
import { OrderCard } from '../orders/OrderLink';
import { formatPhone, randomPassword, userSetPassword } from './api';

type Team = {user_id:string; full_name:string; phone:string; active:boolean};
export function TeamHome() {
  const { me,can } = useSession();
  return <div className="home"><PageHeader title={me?.user.full_name ?? 'Главная'} /><OrderCard />
    {can('shift.work') ? <StaffHome /> : <DailyLearning />}<div className="stack"><Link className="read-card" to="/staff">Сотрудники</Link><Link className="read-card" to="/kb">База знаний</Link></div></div>;
}
export function TeamAccounts({partner}:{partner:string}) {
  const {can}=useSession(); const qc=useQueryClient();
  const [action,setAction]=useState<'new'|{type:'password'|'active';user:Team}|null>(null);
  const q=useQuery({queryKey:['team',partner],enabled:can('team.manage'),queryFn:()=>command<Team[]>('team_list',{partner})});
  if(!can('team.manage')) return null;
  return <details className="team-accounts"><summary>Управляющие</summary>
    <p className="faint">Могут заказывать материалы, добавлять и удалять сотрудников. Доступа к управлению всей сетью нет.</p>
    <Button size="sm" onClick={()=>setAction('new')}>Добавить управляющего</Button>
    <DataState query={q}>{list=><ul className="list">{list.map(u=><li key={u.user_id} className="access-row row between">
      <span><strong>{u.full_name}</strong><span className="faint"> · {u.active?'доступ открыт':'доступ закрыт'}</span></span>
      <div className="row">{u.active && <Button size="sm" onClick={()=>setAction({type:'password',user:u})}>Пароль</Button>}
        <Button size="sm" onClick={()=>setAction({type:'active',user:u})}>{u.active?'Закрыть доступ':'Вернуть доступ'}</Button></div>
    </li>)}</ul>}</DataState>
    {action && <TeamDialog partner={partner} action={action} onClose={()=>{setAction(null);void qc.invalidateQueries({queryKey:['team',partner]});}} />}
  </details>;
}
function TeamDialog({partner,action,onClose}:{partner:string;action:'new'|{type:'password'|'active';user:Team};onClose:()=>void}) {
  const [name,setName]=useState(''); const [phone,setPhone]=useState(''); const [password,setPassword]=useState(randomPassword);
  const [done,setDone]=useState(false);
  const [selected,setSelected]=useState<string[]>([]);
  const locations=useQuery({queryKey:['team-locations',partner],enabled:action==='new',queryFn:()=>rows<{id:string;name:string}>(from('location').select('id,name').eq('partner_id',partner).eq('status','active'))});
  const access=action!=='new'&&action.type==='active';
  const m=useMutation({mutationFn:async()=>{
    if(action==='new') await command('staff_account_create',{partner,full_name:name.trim(),login:phone,password,locations:selected,manager:true});
    else if(action.type==='active') await command('team_set_active',{partner,user:action.user.user_id,active:!action.user.active});
    else await userSetPassword(action.user.user_id,password);
  },onSuccess:()=>access?onClose():setDone(true)});
  if(done) return <ConfirmDialog open title="Доступ готов" confirmLabel="Готово" onConfirm={onClose} onClose={onClose}>
    <p>Передайте управляющему данные для входа. Пароль повторно не показывается.</p>
    <div className="login-card-data"><div>Логин: <strong>{formatPhone(action==='new'?phone:action.user.phone)}</strong></div><div>Пароль: <strong className="mono">{password}</strong></div></div>
  </ConfirmDialog>;
  return <ConfirmDialog open title={action==='new'?'Новый управляющий':access?(action.user.active?'Закрыть доступ?':'Вернуть доступ?'):'Новый пароль'}
    confirmLabel={access?'Подтвердить':'Сохранить'} onConfirm={()=>m.mutate()} onClose={onClose} busy={m.isPending} error={m.error}
    disabled={!access && (password.length<6 || action==='new'&&(!name.trim()||!/^[a-z][a-z0-9._-]{1,39}$/.test(phone)||!selected.length))}>
    {access ? <p>История сохранится. Для следующего входа понадобится заново ввести логин и пароль.</p> : <>
      {action==='new'&&<><Field label="Имя" required>{id=><Input id={id} value={name} onChange={e=>setName(e.target.value)}/>}</Field>
        <Field label="Короткий логин" required>{id=><Input id={id} value={phone} onChange={e=>setPhone(e.target.value)}/>}</Field></>}
      {action==='new'&&<Field label="Точки работы" required>{()=>locations.data?.map(l=><Checkbox key={l.id} label={l.name} checked={selected.includes(l.id)} onChange={v=>setSelected(v?[...selected,l.id]:selected.filter(x=>x!==l.id))}/>)}</Field>}
      <Field label="Пароль" required>{id=><Input id={id} value={password} onChange={e=>setPassword(e.target.value)}/>}</Field>
    </>}
  </ConfirmDialog>;
}
