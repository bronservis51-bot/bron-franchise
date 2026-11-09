import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { command } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { Button,ConfirmDialog,DataState,Field,Input } from '../../ui';
import { randomPassword } from './api';
type Account={user_id:string;full_name:string;login:string;active:boolean};
export function SupportAccounts(){
 const {isManager}=useSession();const qc=useQueryClient();const [open,setOpen]=useState(false);const [name,setName]=useState('');const [login,setLogin]=useState('');const [password,setPassword]=useState(randomPassword);const [created,setCreated]=useState(false);
 const q=useQuery({queryKey:['support-accounts'],enabled:isManager,queryFn:()=>command<Account[]>('support_accounts')});
 const m=useMutation({mutationFn:()=>command('support_account_create',{full_name:name,login,password}),onSuccess:()=>{setCreated(true);void qc.invalidateQueries({queryKey:['support-accounts']});}});
 const active=useMutation({mutationFn:(a:Account)=>command('support_set_active',{user:a.user_id,active:!a.active}),onSuccess:()=>void qc.invalidateQueries({queryKey:['support-accounts']})});
 if(!isManager)return null;
 return <details className="team-accounts"><summary>Технические специалисты</summary><p className="faint">Технические вопросы и редактор базы знаний. Финансы, сотрудники и документы партнёров им недоступны.</p><Button size="sm" onClick={()=>{setCreated(false);setName('');setLogin('');setPassword(randomPassword());setOpen(true);}}>Добавить специалиста</Button>
 <DataState query={q}>{list=><div>{list.map(a=><div className="row between access-row" key={a.user_id}><span>{a.full_name} · {a.login} · {a.active?'доступ открыт':'доступ закрыт'}</span><Button loading={active.isPending} size="sm" onClick={()=>active.mutate(a)}>{a.active?'Закрыть доступ':'Вернуть доступ'}</Button></div>)}</div>}</DataState>
 {open&&<ConfirmDialog open title={created?'Доступ создан':'Технический специалист'} confirmLabel={created?'Готово':'Создать'} onClose={()=>setOpen(false)} onConfirm={()=>created?setOpen(false):m.mutate()} busy={m.isPending} error={m.error} disabled={!created&&(!name.trim()||!/^[a-z][a-z0-9._-]{1,39}$/.test(login))}>
 {created?<div className="login-card-data"><p>Передайте лично. Сохраните пароль сейчас.</p><div>Логин: <strong>{login}</strong></div><div>Пароль: <strong>{password}</strong></div></div>:<><Field label="Имя">{id=><Input id={id} value={name} onChange={e=>setName(e.target.value)}/>}</Field><Field label="Логин" hint="Латинские буквы, цифры, точка, _ или -">{id=><Input id={id} value={login} onChange={e=>setLogin(e.target.value.toLowerCase())}/>}</Field><Field label="Пароль">{id=><Input id={id} value={password} readOnly/>}</Field></>}
 </ConfirmDialog>}</details>;
}
