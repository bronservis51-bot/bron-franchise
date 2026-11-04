import { expect,it } from 'vitest';
// @ts-expect-error — shared administrative JS module
import {parseMonthlyRevenue,planRevenueImport} from '../../scripts/revenue-import-lib.mjs';
it('imports explicit zeros, ignores blank reports and count rows, checks the source total',()=>{
 const grid=[['ОКТЯБРЬ 2026'],['Сумма'],[46296,0,46297,100,46298,null],['','','','','','','','','ФАКТ ЗА МЕСЯЦ',null,100],['Кол-во'],[46299,9]];
 expect(parseMonthlyRevenue(grid,2026,10).days).toEqual([{day:'2026-10-01',minor:0},{day:'2026-10-02',minor:10000}]);
 expect(parseMonthlyRevenue(grid,2026,11).found).toBe(false);
 expect(()=>parseMonthlyRevenue([...grid.slice(0,3),['','','','','','','','','ФАКТ ЗА МЕСЯЦ',null,999]],2026,10)).toThrow(/differs/);
});
it('is repeatable and never adds a sheet total on top of a manually entered day',()=>{
 const row={location_id:'location',day:'2026-10-01',minor:10000};
 const old={id:'old',location_id:'location',day:row.day,total_minor:9000,employee_id:null,entered_by:null,comment:'Перенесено из Google-таблицы'};
 expect(planRevenueImport([row],[]).insert).toHaveLength(1);
 expect(planRevenueImport([row],[old]).update).toHaveLength(1);
 expect(planRevenueImport([row],[{...old,total_minor:10000}]).unchanged).toHaveLength(1);
 expect(planRevenueImport([row],[{...old,entered_by:'person'}]).conflicts).toHaveLength(1);
 expect(planRevenueImport([row],[old,{...old,id:'shift',employee_id:'person'}]).conflicts).toHaveLength(1);
});
