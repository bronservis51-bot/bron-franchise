import { expect,it } from 'vitest';
import { calculatePay,type PayPolicy } from '../../src/modules/staff/Motivation';
const p:PayPolicy={floor_minor:100000,tiers:[{from_minor:0,rate_bp:1700,bonus_minor:0},{from_minor:500000,rate_bp:1800,bonus_minor:0},{from_minor:600000,rate_bp:1900,bonus_minor:0},{from_minor:800000,rate_bp:2000,bonus_minor:0},{from_minor:1000000,rate_bp:2200,bonus_minor:20000},{from_minor:1300000,rate_bp:2300,bonus_minor:20000},{from_minor:1800000,rate_bp:2500,bonus_minor:30000}]};
it('shows the guaranteed floor or percentage plus the tier bonus at exact boundaries',()=>{
 for(const [cash,result] of [[0,100000],[499999,100000],[500000,100000],[599999,108000],[600000,114000],[799999,152000],[800000,160000],[999999,200000],[1000000,240000],[1299999,306000],[1300000,319000],[1799999,434000],[1800000,480000]])expect(calculatePay(BigInt(cash),0,0,p)).toBe(BigInt(result));
});
it('preserves individual historic rates and uses the snapshot instead of new settings',()=>{
 expect(calculatePay(1000000n,1000,50000,null)).toBe(150000n);
 expect(calculatePay(1000000n,2500,0,{mode:'legacy',rate_bp:1000,fee_minor:50000})).toBe(150000n);
});
