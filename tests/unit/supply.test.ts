import { describe, expect, it } from 'vitest';
// @ts-expect-error shared server-side JS module
import { normalizeProfitRows } from '../../scripts/supply-lib.mjs';
const row = { counterparty:{name:'Партнёр',meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/a1000000-0000-0000-0000-000000000001'}},sellSum:10000,sellCostSum:4000,returnSum:2000,returnCostSum:800,profit:4800 };
describe('MoySklad snapshot normalization',()=>{
  it('subtracts returns from sales and cost, retaining raw kopecks',()=>expect(normalizeProfitRows([row])[0]).toMatchObject({sales_minor:8000,cost_minor:3200,profit_minor:4800}));
  it('refuses partial or inconsistent financial values',()=>{
    expect(()=>normalizeProfitRows([{...row,profit:9999}])).toThrow();
    expect(()=>normalizeProfitRows([{...row,returnSum:undefined}])).toThrow();
    expect(()=>normalizeProfitRows([row,row])).toThrow();
  });
});
