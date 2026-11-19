import { expect, it, vi } from 'vitest';
vi.mock('../../src/platform/backend',()=>({commandsInFlight:()=>0}));
vi.mock('../../src/platform/offline',()=>({hasPendingLocalWork:vi.fn(async()=>false)}));
import { mayReload } from '../../src/platform/update';
it('only refreshes an idle visible screen without commands, dialogs, editing or local work',()=>{
 const idle={visible:true,commands:0,dialog:false,editing:false,pending:false};
 expect(mayReload(idle)).toBe(true);
 for(const change of [{visible:false},{commands:1},{dialog:true},{editing:true},{pending:true}])expect(mayReload({...idle,...change})).toBe(false);
});

it('shares one upgrade attempt and reports newly pending work before reloading', async () => {
 vi.useFakeTimers();
 let pending = true;
 const pendingUpdates: (() => void)[] = [];
 const update = vi.fn(() => new Promise<void>(resolve => { pendingUpdates.push(resolve); }));
 const finishUpdates = () => { pendingUpdates.splice(0).forEach(resolve => resolve()); };
 const reload = vi.fn();
 const document = {
   activeElement: null,
   visibilityState: 'visible',
   querySelector: () => null,
   querySelectorAll: () => [],
   addEventListener: vi.fn(),
 };
 vi.stubGlobal('document', document);
 vi.stubGlobal('window', { addEventListener: vi.fn() });
 vi.stubGlobal('navigator', { onLine: true, serviceWorker: { register: async () => ({ update }) } });
 vi.stubGlobal('location', { reload });
 vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() });
 vi.stubGlobal('fetch', async () => Response.json({ build: 'test-new-release' }));
 const { hasPendingLocalWork } = await import('../../src/platform/offline');
 const checkPending = vi.mocked(hasPendingLocalWork);
 checkPending.mockImplementation(async () => pending);
 const { onAvailableUpdate, startAppUpdates } = await import('../../src/platform/update');
 let apply: (() => Promise<void>) | null = null;
 const stop = onAvailableUpdate(value => { apply = value; });
 try {
   startAppUpdates();
   await vi.advanceTimersByTimeAsync(0);
   expect(apply).toBeTypeOf('function');
   expect(update).not.toHaveBeenCalled();

   pending = false;
   const first = apply!();
   const repeat = apply!();
   await vi.advanceTimersByTimeAsync(0);
   pending = true;
   finishUpdates();

   const result = await Promise.allSettled([first, repeat]);
   expect(update).toHaveBeenCalledOnce();
   expect(result).toEqual([
     { status: 'rejected', reason: expect.objectContaining({ message: 'Завершите ввод и отправку записей перед обновлением.' }) },
     { status: 'rejected', reason: expect.objectContaining({ message: 'Завершите ввод и отправку записей перед обновлением.' }) },
   ]);
   expect(reload).not.toHaveBeenCalled();

   pending = false;
   const retry = apply!();
   await vi.advanceTimersByTimeAsync(0);
   finishUpdates();
   await retry;
   expect(update).toHaveBeenCalledTimes(2);
   expect(reload).toHaveBeenCalledOnce();
 } finally {
   stop();
   checkPending.mockReset();
   vi.unstubAllGlobals();
   vi.useRealTimers();
 }
});
