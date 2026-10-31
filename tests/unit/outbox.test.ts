import { afterEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(()=>vi.fn());
const add = vi.hoisted(()=>vi.fn());
vi.mock('../../src/platform/backend',()=>({command:rpc, toAppError:(e:unknown)=>e, AppError:class extends Error{constructor(public code:string,public detail:string){super(detail);}}}));
vi.mock('../../src/platform/offline',()=>({opQueue:{add,list:vi.fn().mockResolvedValue([]),remove:vi.fn()}}));
import { sendOrQueue } from '../../src/platform/outbox';
afterEach(()=>vi.clearAllMocks());
describe('offline storage truthfulness',()=>{
  it('never returns queued success after the device rejects the write',async()=>{
    rpc.mockRejectedValue({code:'offline'});add.mockRejectedValue(new Error('QuotaExceededError'));
    await expect(sendOrQueue('user','revenue_save_checked',{operation:'opaque-id'})).rejects.toThrow('QuotaExceededError');
  });
  it('preserves the same operation key in the durable queue',async()=>{
    rpc.mockRejectedValue({code:'offline'});add.mockResolvedValue(undefined);
    await expect(sendOrQueue('user','revenue_save_checked',{operation:'opaque-id'})).resolves.toEqual({queued:true});
    expect(add).toHaveBeenCalledWith(expect.objectContaining({clientOpId:'opaque-id',payload:{operation:'opaque-id'}}));
  });
});
