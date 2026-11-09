import { useEffect,useState } from 'react';
import { Link } from 'react-router';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { command } from '../../platform/backend';
import { formatDate,formatDateTime } from '../../platform/dates';
import { Button,Card,Checkbox,DataState,Field,Input,Select,ActionError,EmptyState } from '../../ui';
import { Markdown } from '../../ui/markdown';
import { getRevision } from '../knowledge/api';

type Quiz={prompt:string;choices:string[];correct:number};
type Config={for_managers:boolean;for_sales:boolean;questions:Quiz[];version:number;revision_id?:string};
export function LearningEditor({article,revision}:{article:string;revision:string|null}){
 const qc=useQueryClient();const q=useQuery({queryKey:['learning-config',article],queryFn:()=>command<Config>('learning_config_get',{article})});
 const [value,setValue]=useState<Config|null>(null);useEffect(()=>{if(q.data&&!value)setValue(q.data);},[q.data,value]);
 const m=useMutation({mutationFn:()=>command('learning_config_set',{article,for_managers:value!.for_managers,for_sales:value!.for_sales,questions:value!.questions,revision,expected_version:value!.version}),onSuccess:async()=>{await qc.invalidateQueries({queryKey:['learning-config',article]});setValue(null);}});
 const patch=(i:number,x:Partial<Quiz>)=>setValue(v=>v&&({...v,questions:v.questions.map((q,n)=>n===i?{...q,...x}:q)}));
 const dirty=!!value&&!!q.data&&JSON.stringify(value)!==JSON.stringify(q.data);
 return <div data-unsaved={dirty?'true':undefined}><Card title="Ежедневное обучение сотрудников" className="learning-editor"><p className="faint">Опционально. Один материал в день по роли, затем квиз. Отмеченные материалы участвуют после публикации и сохранения вопросов по текущей редакции.</p>
 <DataState query={q}>{()=>value&&<><Checkbox label="Для управляющего" checked={value.for_managers} onChange={v=>setValue({...value,for_managers:v})}/><Checkbox label="Для менеджеров продаж" checked={value.for_sales} onChange={v=>setValue({...value,for_sales:v})}/>
 {revision&&value.revision_id&&revision!==value.revision_id&&<p role="status">Статья обновлена. Проверьте вопросы и сохраните обучение для новой редакции.</p>}
 {value.questions.map((x,i)=><fieldset key={i} className="quiz-question"><legend>Вопрос {i+1}</legend><Field label="Вопрос">{id=><Input id={id} value={x.prompt} onChange={e=>patch(i,{prompt:e.target.value})}/>}</Field>{x.choices.map((c,n)=><Field key={n} label={`Вариант ${n+1}`}>{id=><Input id={id} value={c} onChange={e=>patch(i,{choices:x.choices.map((a,k)=>k===n?e.target.value:a)})}/>}</Field>)}<Field label="Правильный ответ">{id=><Select id={id} value={x.correct} onChange={e=>patch(i,{correct:Number(e.target.value)})}>{x.choices.map((_,n)=><option key={n} value={n}>Вариант {n+1}</option>)}</Select>}</Field><div className="row"><Button size="sm" disabled={x.choices.length>=6} onClick={()=>patch(i,{choices:[...x.choices,'']})}>Добавить вариант</Button><Button size="sm" onClick={()=>setValue({...value,questions:value.questions.filter((_,n)=>n!==i)})}>Удалить вопрос</Button></div></fieldset>)}
 <div className="row"><Button disabled={value.questions.length>=10} onClick={()=>setValue({...value,questions:[...value.questions,{prompt:'',choices:['',''],correct:0}]})}>Добавить вопрос</Button><Button variant="primary" loading={m.isPending} disabled={!revision} onClick={()=>m.mutate()}>Сохранить обучение</Button></div>{!revision&&<p className="faint">Сначала опубликуйте статью.</p>}<ActionError error={m.error}/>{m.isSuccess&&<p role="status">Обучение сохранено</p>}</>}</DataState></Card></div>;
}
type Task={id:string;article_id:string;revision_id:string;title:string;read_at:string|null;completed_at:string|null;score:number|null;total:number;questions:{prompt:string;choices:string[]}[]};
export function DailyLearning(){
 const q=useQuery({queryKey:['learning','today'],queryFn:()=>command<{day:string;items:Task[]}>('learning_today'),refetchOnMount:'always'});
 return <Card title="Обучение на сегодня"><DataState query={q}>{d=><><p className="faint">{formatDate(d.day)}</p>{d.items.length?d.items.map(t=><DailyTask key={t.id} task={t}/>):<p className="faint">Материалы для вашей роли пока не назначены. Обучение появится, когда редактор включит материал и добавит вопросы.</p>}</>}</DataState></Card>;
}
function DailyTask({task}:{task:Task}){
 const qc=useQueryClient();const [reading,setReading]=useState(false);const [answers,setAnswers]=useState<Record<number,number>>({});
 const rev=useQuery({queryKey:['learning','revision',task.revision_id],enabled:reading,queryFn:()=>getRevision(task.revision_id)});
 const read=useMutation({mutationFn:()=>command('learning_read',{task:task.id}),onSuccess:()=>void qc.invalidateQueries({queryKey:['learning','today']})});
 const submit=useMutation({mutationFn:()=>command('learning_submit',{task:task.id,answers:task.questions.map((_,i)=>answers[i])}),onSuccess:()=>void qc.invalidateQueries({queryKey:['learning','today']})});
 return <div data-unsaved={!task.completed_at&&Object.keys(answers).length?'true':undefined}><h3>{task.title}</h3>{task.completed_at?<p role="status">Квиз завершён: {task.score} из {task.total} · {formatDateTime(task.completed_at)}</p>:<><Button onClick={()=>setReading(v=>!v)}>{reading?'Свернуть материал':'Изучить материал'}</Button>{reading&&<DataState query={rev}>{r=><div className="learning-material"><Markdown source={r?.body ?? ''}/><Button loading={read.isPending} disabled={!!task.read_at} onClick={()=>read.mutate()}>{task.read_at?'Изучение отмечено':'Материал изучен — перейти к квизу'}</Button></div>}</DataState>}
 {task.read_at&&<div>{task.questions.map((x,i)=><fieldset className="quiz-question" key={i}><legend>{i+1}. {x.prompt}</legend>{x.choices.map((c,n)=><label className="quiz-choice" key={n}><input type="radio" name={`quiz-${task.id}-${i}`} checked={answers[i]===n} onChange={()=>setAnswers({...answers,[i]:n})}/><span>{c}</span></label>)}</fieldset>)}<Button variant="primary" disabled={Object.keys(answers).length!==task.questions.length} loading={submit.isPending} onClick={()=>submit.mutate()}>Отправить ответы</Button></div>}<ActionError error={read.error??submit.error}/></>}
 </div>;
}
type Report={user_id:string;user_name:string;day:string;article_id:string;article_title:string;read_at:string|null;completed_at:string|null;score:number|null;total:number};
export function LearningReport({partner,month}:{partner:string;month:string}){
 const q=useQuery({queryKey:['learning-report',partner,month],queryFn:()=>command<Report[]>('learning_report',{partner,month})});
 return <details className="team-accounts"><summary>Обучение сотрудников по дням</summary><DataState query={q} empty={d=>d.length?null:<EmptyState title="В этом месяце занятий пока нет" text="Здесь появятся даты, материалы и результаты каждого сотрудника. Обучение добровольное."/>}>{list=><div className="stack">{list.map((x,i)=><div key={i} className="access-row"><strong>{x.user_name} · {formatDate(x.day)}</strong><div><Link to={`/kb/articles/${x.article_id}`}>{x.article_title}</Link></div><span className="faint">{x.completed_at?`Квиз: ${x.score} из ${x.total} · ${formatDateTime(x.completed_at)}`:x.read_at?'Материал изучен, квиз не завершён':'Задание открыто, изучение не отмечено'}</span></div>)}</div>}</DataState></details>;
}
