// Synthetic CRM data for real-component browser QA, never production.
export function createLeadFixture(params:URLSearchParams){
 const initial=params.get('leads')==='filled';
 let rows=initial?[{id:'qa-lead',name:'ВымышленнаяЗаявкаСОченьДлиннымИменемБезПробелов'.repeat(2),phone:'',city:'Вымышленный город',contact_via:'other',status:'lost',tier:'cold',score:0,instagram:null,note:'Длинная заметка для проверки переноса и сохранения истории',budget:null,timing:null,place:null,manage:null,experience:null,comment:null,source:'manual',pipeline_column:'000',created_at:'2026-11-09T09:00:00Z',updated_at:'2026-11-09T09:00:00Z',updated_by_name:'Вымышленный менеджер',deleted_at:null as string|null}]:[];
 if(params.get('scene')==='lead-restore')rows.forEach(r=>r.deleted_at='2026-11-09T10:00:00Z');
 return(name:string,body:Record<string,unknown>)=>{
  if(name==='lead_list')return Response.json(rows.filter(x=>!x.deleted_at));
  if(name==='lead_trash_list')return Response.json(rows.filter(x=>x.deleted_at));
  if(name==='lead_inbox')return Response.json(rows.filter(x=>!x.deleted_at&&x.status==='new').length);
  if(name==='lead_set_deleted'){
   const row=rows.find(x=>x.id===body.p_id)!;row.deleted_at=body.p_deleted?new Date().toISOString():null;row.updated_at=new Date().toISOString();return Response.json(row);
  }
  return null;
 };
}
