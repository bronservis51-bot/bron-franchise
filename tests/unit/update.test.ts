import { expect, it, vi } from 'vitest';
vi.mock('../../src/platform/backend',()=>({commandsInFlight:()=>0}));
vi.mock('../../src/platform/offline',()=>({hasPendingLocalWork:async()=>false}));
import { mayReload } from '../../src/platform/update';
it('only refreshes an idle visible screen without commands, dialogs, editing or local work',()=>{
 const idle={visible:true,commands:0,dialog:false,editing:false,pending:false};
 expect(mayReload(idle)).toBe(true);
 for(const change of [{visible:false},{commands:1},{dialog:true},{editing:true},{pending:true}])expect(mayReload({...idle,...change})).toBe(false);
});
