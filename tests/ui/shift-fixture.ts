// UI fixture: fictional shifts only. Every RPC stays inside the fixture.
const day='2026-11-09';
const shiftId='00000000-0000-4000-8000-000000000045';
export function createShiftFixture(params:URLSearchParams,location:{id:string;name:string;currency:string},partner:{id:string;name:string},policy:unknown){
 let shift:any=params.get('shift')==='open'||params.get('shift')==='stale'?{id:shiftId,revision:0,employee_id:'qa-worker',location_id:location.id,partner_id:partner.id,location_name:location.name,currency:'RUB',day:params.get('shift')==='stale'?'2026-10-21':day,status:'open',opened_at:'2026-11-09T07:00:00Z',closed_at:null,cash_minor:0,card_minor:0,total_minor:0,pay_policy:policy,earned_minor:null,comment:null}:null;
 const closed=()=>shift?.status==='closed';
 const trainee=params.get('employee')==='trainee';
 const awaitingOpening=params.get('point-opening')==='awaiting';
 return (name:string|undefined,args:any):Response|null=>{
  if(name==='staff_home')return Response.json({month:'2026-11-01',today:day,currency:'RUB',partner_name:partner.name,rate_bp:0,shift_fee_minor:0,pay_policy:policy,use_partner_motivation:true,
   employee_kind:trainee?'trainee':'employee',...(trainee?{internship_from:'2026-11-01',internship_until:'2026-11-30',internship_floor_minor:50000}:{}),
   open_shift:closed()?null:shift,locations:[{location_id:location.id,location_name:location.name,currency:'RUB',today:day,my_today:closed()?shift:null,
    awaiting_opening_date:awaitingOpening,...(params.has('gaps') && !awaitingOpening ? {missing_count:5,missing_periods:[{from:'2026-11-01',until:'2026-11-01'},{from:'2026-11-04',until:'2026-11-06'},{from:'2026-11-08',until:'2026-11-08'}]} : {})}],
   month_earned_minor:closed()?shift.earned_minor:0,month_revenue_minor:closed()?shift.total_minor:0,month_shifts:closed()?1:0,shifts:closed()?[shift]:[]});
  if(name==='shift_open'){shift={id:shiftId,revision:0,employee_id:'qa-worker',location_id:location.id,partner_id:partner.id,location_name:location.name,currency:'RUB',day,status:'open',opened_at:new Date().toISOString(),closed_at:null,cash_minor:0,card_minor:0,total_minor:0,pay_policy:policy,earned_minor:null,comment:null};return Response.json(shift);}
  if(name==='shift_cancel'){
   if(params.get('cancel')==='error')return Response.json({message:'version-conflict',details:'Смена уже изменена. Обновите данные.'},{status:409});
   shift=null;return Response.json(null);
  }
  if(name==='shift_close_versioned'){shift={...shift,status:'closed',revision:shift.revision+1,closed_at:shift.closed_at??new Date().toISOString(),cash_minor:Number(args.p_cash),card_minor:Number(args.p_card),total_minor:Number(args.p_cash)+Number(args.p_card),earned_minor:100000};return Response.json({shift,month_earned_minor:100000,month_shifts:1,currency:'RUB'});}
  if(name==='shift_record_with_return'){
    shift={...shift,status:'closed',revision:shift.revision+2,closed_at:shift.closed_at??new Date().toISOString(),cash_minor:Number(args.p_cash),
      card_minor:Number(args.p_card),total_minor:Number(args.p_cash)+Number(args.p_card),return_minor:Number(args.p_return),earned_minor:100000};
    return Response.json({shift,month_earned_minor:100000,month_shifts:1,currency:'RUB'});
  }
  if(name==='staff_open_shifts')return Response.json([{id:'qa-forgotten',revision:0,employee_id:'qa-other',location_id:location.id,partner_id:partner.id,location_name:location.name,user_name:'Вымышленный сотрудник',currency:'RUB',day:'2026-11-08',today:day,status:'open',opened_at:'2026-11-08T07:00:00Z',closed_at:null,cash_minor:0,card_minor:0,total_minor:0,can_resolve:true,can_close:true}]);
  if(name==='staff_shift_resolve')return Response.json({ok:true});
  return null;
 };
}
