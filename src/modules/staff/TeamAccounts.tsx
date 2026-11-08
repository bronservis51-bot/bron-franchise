import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { Button, ConfirmDialog, DataState, Field, Input, PageHeader } from '../../ui';
import { OrderCard } from '../orders/OrderLink';
import { formatPhone, randomPassword, userSetPassword } from './api';

type Team = {user_id:string; full_name:string; phone:string; active:boolean};
export function TeamHome() {
  const { me } = useSession();
  return <div className="home"><PageHeader title={me?.user.full_name ?? 'Главная'} /><OrderCard />
    <div className="stack"><Link className="read-card" to="/staff">Сотрудники</Link><Link className="read-card" to="/kb">База знаний</Link></div></div>;
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
  const access=action!=='new'&&action.type==='active';
  const m=useMutation({mutationFn:async()=>{
    if(action==='new') await command('team_create',{partner,full_name:name.trim(),phone,password});
    else if(action.type==='active') await command('team_set_active',{partner,user:action.user.user_id,active:!action.user.active});
    else await userSetPassword(action.user.user_id,password);
  },onSuccess:()=>access?onClose():setDone(true)});
  if(done) return <ConfirmDialog open title="Доступ готов" confirmLabel="Готово" onConfirm={onClose} onClose={onClose}>
    <p>Передайте управляющему данные для входа. Пароль повторно не показывается.</p>
    <div className="login-card-data"><div>Телефон: <strong>{formatPhone(action==='new'?phone:action.user.phone)}</strong></div><div>Пароль: <strong className="mono">{password}</strong></div></div>
  </ConfirmDialog>;
  return <ConfirmDialog open title={action==='new'?'Новый управляющий':access?(action.user.active?'Закрыть доступ?':'Вернуть доступ?'):'Новый пароль'}
    confirmLabel={access?'Подтвердить':'Сохранить'} onConfirm={()=>m.mutate()} onClose={onClose} busy={m.isPending} error={m.error}
    disabled={!access && (password.length<6 || action==='new'&&(!name.trim()||phone.replace(/\D/g,'').length<10))}>
    {access ? <p>История сохранится. Для следующего входа понадобится заново ввести логин и пароль.</p> : <>
      {action==='new'&&<><Field label="Имя" required>{id=><Input id={id} value={name} onChange={e=>setName(e.target.value)}/>}</Field>
        <Field label="Телефон для входа" required>{id=><Input id={id} type="tel" value={phone} onChange={e=>setPhone(e.target.value)}/>}</Field></>}
      <Field label="Пароль" required>{id=><Input id={id} value={password} onChange={e=>setPassword(e.target.value)}/>}</Field>
    </>}
  </ConfirmDialog>;
}
