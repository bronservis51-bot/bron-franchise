import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, X } from 'lucide-react';

interface ToastAction { label: string; onClick: () => void }
interface Toast { id: number; text: string; tone: 'success' | 'danger' | 'info'; action?: ToastAction }
type Push = (text: string, tone?: Toast['tone'], action?: ToastAction) => void;
const Ctx = createContext<Push>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const drop = (id: number) => setItems((xs) => xs.filter((x) => x.id !== id));
  const push = useCallback<Push>((text, tone = 'success', action) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, tone, action }]);
    // с кнопкой «Отменить» уведомление держится дольше
    setTimeout(() => drop(id), action ? 12000 : 6000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {items.map((t) => (
          <div key={t.id} className="toast">
            {t.tone === 'danger' ? <AlertTriangle size={18} color="var(--danger)" aria-hidden /> : <CheckCircle2 size={18} color="var(--success)" aria-hidden />}
            <div style={{ flex: 1 }}>{t.text}</div>
            {t.action && <button type="button" className="btn btn-sm" onClick={() => { t.action!.onClick(); drop(t.id); }}>{t.action.label}</button>}
            <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Закрыть" onClick={() => drop(t.id)}><X size={16} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
