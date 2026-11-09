// Synthetic interactive fixture only; no production requests or accounts.
const lessons=['Начало работы: правила и доступ','Обслуживание клиента и качество'].map((title,i)=>({article_id:i?'qa-article-1':'qa-article',revision_id:'qa-revision',title,stage:i?'Клиенты':'Первый день',position:i+1,questions:i?2:4,due:null as string|null,percent:null as number|null,completed:false,active:false,ready:true,local_current:true,local_questions:1,for_sales:true,for_managers:true,for_trainees:true,for_franchisees:true}));
const question={prompt:'Как поступить, если ответ пока неизвестен?',choices:['Уточнить у наставника','Придумать ответ'],correct:0};
const configs=new Map<string,any>();let attempt:any=null;
export function learningFixture(name:string|undefined,a:Record<string,any>,params:URLSearchParams):Response|null{
 if(!name?.startsWith('learning_'))return null;
 if(name==='learning_notice')return Response.json({new_day:true});
 if(name==='learning_visit')return Response.json(null);
 if(name==='learning_overview')return Response.json({day:'2026-11-09',audience:'sales',items:params.get('learning')==='empty'?[]:lessons});
 if(name==='learning_catalog')return Response.json(lessons);
 if(name==='learning_lesson_get')return Response.json(configs.get(a.p_article+':'+a.p_partner)??{version:0,enabled:true,for_sales:true,for_trainees:true,for_managers:true,for_franchisees:false,stage:'Первый день',position:1,pass_percent:80,quiz_size:0,questions:Array.from({length:4},()=>({...question}))});
 if(name==='learning_lesson_save'){configs.set(a.p_article+':'+a.p_partner,{...a.p_settings,version:a.p_expected_version+1});return Response.json(null);}
 if(name==='learning_policy_get')return Response.json({version:0,policy:{enabled:true,perfect:[3,7,14,30],passed:[1,3,7,14]}});
 if(name==='learning_policy_save')return Response.json(null);
 if(name==='learning_report')return Response.json([{user_id:'qa-worker',user_name:'Вымышленный сотрудник',day:'2026-11-09',article_id:'qa-article',article_title:lessons[0].title,read_at:'2026-11-09T10:00:00Z',completed_at:'2026-11-09T10:05:00Z',score:4,total:4,next_due:'2026-11-12'}]);
 if(name==='learning_start'){
  if(!attempt||attempt.article_id!==a.p_article||attempt.completed_at){const l=lessons.find(l=>l.article_id===a.p_article)??lessons[0];attempt={id:crypto.randomUUID(),...l,pass_percent:80,read_at:null,completed_at:null,questions:Array.from({length:l.questions},()=>({prompt:question.prompt,choices:question.choices})),result:null};}return Response.json(attempt);
 }
 if(name==='learning_attempt_read'){attempt.read_at=new Date().toISOString();return Response.json(null);}
 if(name==='learning_attempt_submit'){
  const score=a.p_answers.filter((x:number)=>x===0).length,total=attempt.questions.length,percent=Math.floor(100*score/total),passed=percent>=80;
  const result={score,total,percent,passed,interval_days:passed?3:0,next_due:passed?'2026-11-12':'2026-11-09',feedback:attempt.questions.map((q:any,i:number)=>({...q,correct:'0',chosen:a.p_answers[i]}))};
  attempt.result=result;attempt.completed_at=new Date().toISOString();Object.assign(lessons.find(l=>l.article_id===attempt.article_id)!,{completed:passed,percent,due:result.next_due});return Response.json(result);
 }
 return null;
}
