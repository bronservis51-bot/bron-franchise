import { useEffect, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command, from, rows } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { formatDate, formatDateTime, monthStart } from '../../platform/dates';
import { Button, Card, Checkbox, ConfirmDialog, DataState, Field, Input, Select, ActionError, EmptyState, PageHeader, Badge } from '../../ui';
import { Markdown } from '../../ui/markdown';
import { getRevision } from '../knowledge/api';
import { MonthNav } from '../revenue/components';

type Quiz = {prompt:string; choices:string[]; correct:number};
type Config = {version:number; revision_id?:string; enabled?:boolean; for_managers?:boolean; for_sales?:boolean; for_trainees?:boolean; for_franchisees?:boolean; stage?:string; position?:number; pass_percent?:number; quiz_size?:number; questions:Quiz[]};
const audiences = [['for_trainees','Стажёры'],['for_sales','Менеджеры продаж'],['for_managers','Управляющие'],['for_franchisees','Франчайзи']] as const;

function QuestionsEditor({value,onChange}:{value:Quiz[];onChange:(q:Quiz[])=>void}) {
 const patch=(i:number,x:Partial<Quiz>)=>onChange(value.map((q,n)=>n===i?{...q,...x}:q));
 return <div className="stack">{value.map((q,i)=><fieldset key={i} className="quiz-question"><legend>Вопрос {i+1}</legend>
  <Field label="Простой вопрос">{id=><Input id={id} value={q.prompt} onChange={e=>patch(i,{prompt:e.target.value})}/>}</Field>
  {q.choices.map((c,n)=><Field key={n} label={`Ответ ${n+1}`}>{id=><div className="row"><Input id={id} value={c} onChange={e=>patch(i,{choices:q.choices.map((v,k)=>k===n?e.target.value:v)})}/>{q.choices.length>2&&<Button size="sm" aria-label={`Удалить ответ ${n+1}`} onClick={()=>patch(i,{choices:q.choices.filter((_,k)=>k!==n),correct:q.correct===n?0:q.correct>n?q.correct-1:q.correct})}>×</Button>}</div>}</Field>)}
  <Field label="Правильный ответ">{id=><Select id={id} value={q.correct} onChange={e=>patch(i,{correct:Number(e.target.value)})}>{q.choices.map((_,n)=><option key={n} value={n}>Ответ {n+1}</option>)}</Select>}</Field>
  <div className="row"><Button size="sm" disabled={q.choices.length>=6} onClick={()=>patch(i,{choices:[...q.choices,'']})}>Добавить ответ</Button><Button size="sm" onClick={()=>onChange(value.filter((_,n)=>n!==i))}>Удалить вопрос</Button></div>
 </fieldset>)}<Button onClick={()=>onChange([...value,{prompt:'',choices:['',''],correct:0}])}>Добавить вопрос</Button></div>;
}
export function LearningEditor({article,revision}:{article:string;revision:string|null}) {
 return <Card title="Обучение" className="learning-editor"><LessonSettings article={article} revision={revision} partner={null}/></Card>;
}
function LessonSettings({article,revision,partner}:{article:string;revision:string|null;partner:string|null}) {
 const qc=useQueryClient();
 const q=useQuery({queryKey:['learning-config',article,partner],queryFn:()=>command<Config>('learning_lesson_get',{article,partner})});
 const [edit,setEdit]=useState<Config|null>(null);const value=edit??q.data;
 const m=useMutation({mutationFn:()=>command('learning_lesson_save',{article,partner,revision,settings:value,expected_version:value!.version}),onSuccess:async()=>{await qc.invalidateQueries({queryKey:['learning-config',article,partner]});await qc.invalidateQueries({queryKey:['learning']});setEdit(null);}});
 const patch=(x:Partial<Config>)=>setEdit({...value!,...x});
 return <div data-unsaved={edit?'true':undefined}><DataState query={q}>{()=>value&&<div className="stack">
  <p className="faint">{partner?'Ваши вопросы дополняют общую программу только для вашей команды. Текст материала меняет редактор базы знаний.':'Количество вопросов зависит от темы. Для короткой памятки достаточно нескольких, для сложного процесса нужен более полный тест.'}</p>
  {partner&&<Checkbox label="Урок включён для команды" checked={value.enabled??true} onChange={enabled=>patch({enabled})}/>}
  {audiences.filter(([key])=>!partner||key!=='for_franchisees').map(([key,label])=>partner?<Field key={key} label={label}>{id=><Select id={id} value={value[key]===undefined?'inherit':String(value[key])} onChange={e=>patch({[key]:e.target.value==='inherit'?undefined:e.target.value==='true'})}><option value="inherit">По общей программе</option><option value="true">Включить</option><option value="false">Выключить</option></Select>}</Field>:<Checkbox key={key} label={label} checked={value[key]??false} onChange={v=>patch({[key]:v})}/>)}
  {!partner&&<><Field label="Этап адаптации">{id=><Input id={id} value={value.stage??''} onChange={e=>patch({stage:e.target.value})}/>}</Field>
   <div className="grid grid-2"><Field label="Порядок урока">{id=><Input id={id} type="number" min="0" value={value.position??100} onChange={e=>patch({position:Number(e.target.value)})}/>}</Field><Field label="Проходной балл, %">{id=><Input id={id} type="number" min="1" max="100" value={value.pass_percent??80} onChange={e=>patch({pass_percent:Number(e.target.value)})}/>}</Field></div>
   <Field label="Вопросов в одной попытке" hint="0 — весь банк. Другое число — случайная подборка из банка; следующий урок доступен сразу.">{id=><Input id={id} type="number" min="0" value={value.quiz_size??0} onChange={e=>patch({quiz_size:Number(e.target.value)})}/>}</Field></>}
  {revision&&value.revision_id&&revision!==value.revision_id&&<p role="status">Материал обновлён. Проверьте вопросы по новой редакции.</p>}
  <p>{value.questions.length} вопросов {partner?'добавлено вами':'в банке'}</p>
  <QuestionsEditor value={value.questions} onChange={questions=>patch({questions})}/>
  <Button variant="primary" disabled={!revision||!edit} loading={m.isPending} onClick={()=>m.mutate()}>Сохранить обучение</Button><ActionError error={m.error}/>{m.isSuccess&&!edit&&<p role="status">Обучение сохранено</p>}
 </div>}</DataState></div>;
}

type Lesson = {article_id:string;revision_id:string;title:string;stage:string;questions:number;due:string|null;percent:number|null;completed:boolean;active:boolean};
type Overview = {day:string;audience:string;items:Lesson[]};
type Catalog = Lesson & {position:number;ready:boolean;local_current:boolean;local_questions:number;for_sales:boolean;for_trainees:boolean;for_managers:boolean;for_franchisees:boolean};
export function LearningPage() {
 const {me,isManager,isTechnical,can}=useSession();
 const [tab,setTab]=useState<'lessons'|'program'|'report'|'settings'>(isManager||isTechnical?'program':'lessons');
 const [partner,setPartner]=useState<string|null>(me?.assignments.find(a=>a.scope_type==='partner')?.scope_id??null);
 const partners=useQuery({queryKey:['learning','partners'],enabled:isManager,queryFn:()=>rows<{id:string;name:string}>(from('partner').select('id,name').eq('status','active').order('name'))});
 const [month,setMonth]=useState(monthStart());
 const global=(isManager||isTechnical)&&!partner;
 const editable=global?can('kb.edit'):can('team.manage');
 const report=can('staff.manage');
 return <><PageHeader title="Обучение"/>
  <div className="row learning-tabs" role="group" aria-label="Разделы обучения">
   {!isManager&&!isTechnical&&<Button variant={tab==='lessons'?'primary':'ghost'} onClick={()=>setTab('lessons')}>Мои уроки</Button>}
   {(can('kb.edit')||report)&&<Button variant={tab==='program'?'primary':'ghost'} onClick={()=>setTab('program')}>Программа и вопросы</Button>}
   {report&&<Button variant={tab==='report'?'primary':'ghost'} onClick={()=>setTab('report')}>Занятия команды</Button>}
   {(isManager||can('team.manage'))&&<Button variant={tab==='settings'?'primary':'ghost'} onClick={()=>setTab('settings')}>Настройки</Button>}
  </div>
  {isManager&&tab!=='lessons'&&<Field label="Программа">{id=><Select id={id} value={partner??''} onChange={e=>setPartner(e.target.value||null)}><option value="">Общая программа сети</option>{partners.data?.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</Select>}</Field>}
  {tab==='lessons'&&<MyLessons/>}
  {tab==='program'&&<Program key={partner??'global'} partner={partner} editable={editable}/>}
  {tab==='settings'&&<Policy key={partner??'global'} partner={partner}/>}
  {tab==='report'&&(partner?<><MonthNav month={month} onChange={setMonth} max={monthStart()}/><LearningReport partner={partner} month={month}/></>:<EmptyState title="Выберите франчайзи" text="Занятия и результаты доступны отдельно по каждой команде."/>)}
 </>;
}
function MyLessons(){
 const qc=useQueryClient();
 const q=useQuery({queryKey:['learning','overview'],queryFn:()=>command<Overview>('learning_overview')});
 useEffect(()=>{void command('learning_visit').then(()=>qc.invalidateQueries({queryKey:['learning','notice']}));},[qc]);
 return <DataState query={q} empty={d=>d.items.length?null:<EmptyState title="Уроки пока не назначены" text="Франчайзи и менеджер франшизы настраивают программу для вашей роли."/>}>{d=>{
  const next=d.items.find(l=>l.active)||d.items.find(l=>!l.completed||!l.due||l.due<=d.day)||d.items[0];
  return <div className="stack"><Card title={next.active?'Продолжить урок':next.due&&next.due<=d.day?'Пора повторить':'Следующий урок'} className="learning-next"><span className="faint">{next.stage}</span><h2>{next.title}</h2><p>{next.questions} вопросов · После теста можно сразу перейти дальше</p><Link className="btn btn-primary" to={`/learning/lesson/${next.article_id}`}>{next.active?'Продолжить':'Начать'}</Link></Card>
   <h2>Программа</h2>{d.items.map(l=><Card key={l.article_id}><div className="row between"><div className="grow"><span className="faint">{l.stage}</span><h3>{l.title}</h3><span className="faint">{l.percent!==null?`Последний результат: ${l.percent}% · повтор ${formatDate(l.due!)}`:'Ещё не пройден'}</span></div><Link className="btn" to={`/learning/lesson/${l.article_id}`}>{l.active?'Продолжить':l.completed?'Повторить':'Начать'}</Link></div></Card>)}
  </div>;
 }}</DataState>;
}
function Program({partner,editable}:{partner:string|null;editable:boolean}) {
 const q=useQuery({queryKey:['learning','catalog',partner],queryFn:()=>command<Catalog[]>('learning_catalog',{partner})});
 const [selected,setSelected]=useState<Catalog|null>(null);const [search,setSearch]=useState('');
 return <><Field label="Найти тему">{id=><Input id={id} value={search} onChange={e=>setSearch(e.target.value)}/>}</Field>
 <DataState query={q}>{list=><div className="stack"><p className="faint">Готово к обучению: {list.filter(l=>l.ready).length} из {list.length}. Материалы без проверенных вопросов остаются в базе знаний.</p>
 {list.filter(l=>l.title.toLowerCase().includes(search.toLowerCase())).map(l=><Card key={l.article_id}><div className="row between"><div className="grow"><h3>{l.title}</h3><span className="faint">{l.stage} · {l.questions} общих{partner?` + ${l.local_questions} ваших`:''} вопросов</span><div>{l.ready?<Badge tone="success">Вопросы проверены</Badge>:<Badge tone="warning">Нужна проверка и вопросы</Badge>}</div><span className="faint">{audiences.filter(([k])=>l[k]).map(([,label])=>label).join(' · ')||'Аудитории не назначены'}</span></div>{editable&&<Button onClick={()=>setSelected(l)}>{partner?'Мои вопросы':'Настроить'}</Button>}</div></Card>)}
 </div>}</DataState>
 {selected&&<LessonDialog lesson={selected} partner={partner} onClose={()=>setSelected(null)}/>}
 </>;
}
function LessonDialog({lesson,partner,onClose}:{lesson:Catalog;partner:string|null;onClose:()=>void}) {
 const [confirm,setConfirm]=useState(false);
 const close=()=>{if(document.querySelector('.learning-settings-dialog [data-unsaved="true"]'))setConfirm(true);else onClose();};
 return <><ConfirmDialog open title={lesson.title} confirmLabel="Закрыть" cancelLabel="Закрыть" onClose={close} onConfirm={close}><div className="learning-settings-dialog"><Link to={`/kb/articles/${lesson.article_id}`} target="_blank">Открыть материал</Link><LessonSettings article={lesson.article_id} revision={lesson.revision_id} partner={partner}/></div></ConfirmDialog>
 {confirm&&<ConfirmDialog open title="Закрыть без сохранения?" confirmLabel="Закрыть" cancelLabel="Продолжить редактирование" onClose={()=>setConfirm(false)} onConfirm={onClose}><p>Изменения вопросов ещё не сохранены.</p></ConfirmDialog>}</>;
}
function Policy({partner}:{partner:string|null}) {
 const qc=useQueryClient();const q=useQuery({queryKey:['learning','policy',partner],queryFn:()=>command<{version:number;policy:{enabled:boolean;perfect:number[];passed:number[]}}>('learning_policy_get',{partner})});
 const [enabled,setEnabled]=useState<boolean|null>(null);const [perfect,setPerfect]=useState<string|null>(null);const [passed,setPassed]=useState<string|null>(null);
 const m=useMutation({mutationFn:()=>{const settings={enabled:enabled??q.data!.policy.enabled,perfect:(perfect??q.data!.policy.perfect.join(', ')).split(',').map(x=>Number(x.trim())),passed:(passed??q.data!.policy.passed.join(', ')).split(',').map(x=>Number(x.trim()))};return command('learning_policy_save',{partner,expected_version:q.data!.version,settings});},onSuccess:async()=>{await qc.invalidateQueries({queryKey:['learning']});setEnabled(null);setPerfect(null);setPassed(null);}});
 return <Card title="Режим обучения"><DataState query={q}>{d=><div data-unsaved={enabled!==null||perfect!==null||passed!==null?'true':undefined}><Checkbox label="Обучение включено" checked={enabled??d.policy.enabled} onChange={setEnabled}/>
 <Field label="Повтор при результате 100% — дни через запятую">{id=><Input id={id} value={perfect??d.policy.perfect.join(', ')} onChange={e=>setPerfect(e.target.value)}/>}</Field>
 <Field label="Повтор при зачёте с ошибками — дни через запятую">{id=><Input id={id} value={passed??d.policy.passed.join(', ')} onChange={e=>setPassed(e.target.value)}/>}</Field>
 <p className="faint">Первое число — после первого зачёта, следующие — после успешных повторов. Последний интервал повторяется. Незачёт сбрасывает последовательность и предлагает перечитать материал сразу. Новые уроки доступны без ожидания. Результат теста не заменяет практическую проверку навыков.</p>
 <Button variant="primary" loading={m.isPending} onClick={()=>m.mutate()}>Сохранить настройки</Button><ActionError error={m.error}/>{m.isSuccess&&<p role="status">Настройки сохранены</p>}</div>}</DataState></Card>;
}

type Result={score:number;total:number;percent:number;passed:boolean;interval_days:number;next_due:string;feedback:{prompt:string;correct:string;chosen:number;choices:string[]}[]};
type Attempt={id:string;article_id:string;revision_id:string;title:string;pass_percent:number;read_at:string|null;completed_at:string|null;questions:Omit<Quiz,'correct'>[];result:Result|null};
export function LearningLessonPage(){
 const {id}=useParams();const qc=useQueryClient();
 const q=useQuery({queryKey:['learning-attempt',id],queryFn:()=>command<Attempt>('learning_start',{article:id}),staleTime:Infinity,gcTime:0,retry:false});
 return <DataState query={q}>{t=><Study key={t.id} attempt={t} onFinish={()=>{void qc.invalidateQueries({queryKey:['learning']});}}/>}</DataState>;
}
function Study({attempt:t,onFinish}:{attempt:Attempt;onFinish:()=>void}) {
 const [quiz,setQuiz]=useState(false);const [result,setResult]=useState<Result|null>(t.result);
 const [answers,setAnswers]=useState<Record<number,number>>(()=>{try{return JSON.parse(sessionStorage.getItem(`bron.lesson.${t.id}`)??'{}');}catch{return {};}});
 const rev=useQuery({queryKey:['learning','revision',t.revision_id],queryFn:()=>getRevision(t.revision_id)});
 const blocked=useBlocker(({currentLocation,nextLocation})=>!result&&(currentLocation.pathname!==nextLocation.pathname||currentLocation.search!==nextLocation.search));
 useEffect(()=>{if(result)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[result]);
 const read=useMutation({mutationFn:()=>command('learning_attempt_read',{attempt:t.id}),onSuccess:()=>setQuiz(true)});
 const submit=useMutation({mutationFn:()=>command<Result>('learning_attempt_submit',{attempt:t.id,answers:t.questions.map((_,i)=>answers[i])}),onSuccess:r=>{setResult(r);try{sessionStorage.removeItem(`bron.lesson.${t.id}`);}catch{/* optional draft */}onFinish();}});
 const choose=(i:number,n:number)=>{const a={...answers,[i]:n};setAnswers(a);try{sessionStorage.setItem(`bron.lesson.${t.id}`,JSON.stringify(a));}catch{/* current attempt remains available */}};
 return <div className="learning-study" data-unsaved={!result?'true':undefined}>
 <PageHeader title={t.title} back={{to:'/learning',label:'Обучение'}}/>
 {result?<Card title={result.passed?'Урок пройден':'Нужно повторить'}><h2>{result.percent}% · {result.score} из {result.total}</h2><p>{result.passed?`Повторение: ${formatDate(result.next_due)}. Следующий урок можно начать сейчас.`:'Перечитайте материал и попробуйте ещё раз. Ждать следующего дня не нужно.'}</p>
 <details><summary>Разобрать ответы</summary>{result.feedback?.map((x,i)=><div className="quiz-question" key={i}><strong>{x.prompt}</strong><p>Ваш ответ: {x.choices[x.chosen]}</p>{String(x.chosen)!==x.correct&&<p>Верно: {x.choices[Number(x.correct)]}</p>}</div>)}</details>
 <Link className="btn btn-primary" to="/learning">{result.passed?'Следующий урок':'Вернуться к урокам'}</Link></Card>:!quiz?<DataState query={rev}>{r=><Card className="learning-material"><Markdown source={r?.body??''}/><Button variant="primary" loading={read.isPending} onClick={()=>read.mutate()}>Пройти тест</Button><p className="faint">Для зачёта нужно {t.pass_percent}%. Если что-то не получится, можно повторить.</p><ActionError error={read.error}/></Card>}</DataState>:<Card title="Тест"><Button variant="ghost" onClick={()=>setQuiz(false)}>Перечитать материал</Button>{t.questions.map((x,i)=><fieldset className="quiz-question" key={i}><legend>{i+1}. {x.prompt}</legend>{x.choices.map((c,n)=><label className="quiz-choice" key={n}><input type="radio" name={`quiz-${t.id}-${i}`} checked={answers[i]===n} onChange={()=>choose(i,n)}/><span>{c}</span></label>)}</fieldset>)}<Button variant="primary" disabled={t.questions.some((_,i)=>answers[i]===undefined)} loading={submit.isPending} onClick={()=>submit.mutate()}>Проверить ответы</Button><ActionError error={submit.error}/></Card>}
 {blocked.state==='blocked'&&<ConfirmDialog open title="Выйти без завершения теста?" confirmLabel="Выйти" cancelLabel="Продолжить урок" onClose={()=>blocked.reset()} onConfirm={()=>blocked.proceed()}><p>Урок ещё не пройден. Вы сможете вернуться к этой попытке, но зачёт появится только после теста.</p></ConfirmDialog>}
 </div>;
}

type Report={user_id:string;user_name:string;day:string;article_id:string;article_title:string;read_at:string|null;completed_at:string|null;score:number|null;total:number;next_due?:string};
export function LearningReport({partner,month}:{partner:string;month:string}) {
 const q=useQuery({queryKey:['learning','report',partner,month],queryFn:()=>command<Report[]>('learning_report',{partner,month})});
 return <DataState query={q} empty={d=>d.length?null:<EmptyState title="В этом месяце занятий пока нет" text="Здесь появятся даты, материалы и результаты каждого сотрудника."/>}>{list=><div className="stack">{list.map((x,i)=><Card key={i}><strong>{x.user_name} · {formatDate(x.day)}</strong><div><Link to={`/kb/articles/${x.article_id}`}>{x.article_title}</Link></div><p className="faint">{x.completed_at&&x.score!==null?`Тест: ${x.score} из ${x.total} · ${formatDateTime(x.completed_at)}`:x.read_at?'Материал изучен, тест не завершён':'Урок начат, изучение не подтверждено'}{x.next_due?` · повтор ${formatDate(x.next_due)}`:''}</p></Card>)}</div>}</DataState>;
}
