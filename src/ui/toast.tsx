import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, X } from 'lucide-react';

interface Toast { id: number; text: string; tone: 'success' | 'danger' | 'info' }
const Ctx = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {items.map((t) => (
          <div key={t.id} className="toast">
            {t.tone === 'danger' ? <AlertTriangle size={18} color="var(--danger)" aria-hidden /> : <CheckCircle2 size={18} color="var(--success)" aria-hidden />}
            <div style={{ flex: 1 }}>{t.text}</div>
            <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Закрыть" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}><X size={16} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
