// Вложения: сервер проверяет право и тип, выдаёт путь; файл загружается в закрытый bucket; выдача — короткой ссылкой (SEC-05).
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Image as ImageIcon, Paperclip } from 'lucide-react';
import { command, storage } from '../platform/backend';
import { Button, ActionError } from './index';

export interface FileRow { id: string; name: string; mime: string; size_bytes: number; path: string; visibility: string; created_at: string }

const MAX_IMAGE_SIDE = 2000;

/** Сжатие фото перед загрузкой (PWA-07); EXIF и геолокация не сохраняются при перекодировании. */
export async function compressImage(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export async function sha256(blob: Blob): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function FileAttach({ prepare, entityType, entityId, label = 'Приложить файл', accept = 'image/*,application/pdf,video/mp4', onDone }: {
  prepare: (f: { name: string; mime: string; size: number; checksum: string }) => Promise<{ file_id: string; path: string }>;
  entityType: string; entityId: string; label?: string; accept?: string; onDone?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        setProgress(`Загрузка: ${f.name}`);
        const blob = await compressImage(f);
        const mime = blob === f ? f.type : 'image/jpeg';
        const name = blob === f ? f.name : f.name.replace(/\.\w+$/, '.jpg');
        const prep = await prepare({ name, mime, size: blob.size, checksum: await sha256(blob) });
        await storage.upload(prep.path, new File([blob], name, { type: mime }));
        await command('file_confirm', { file: prep.file_id });
      }
      await qc.invalidateQueries({ queryKey: ['files', entityType, entityId] });
      onDone?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div>
      <input ref={input} type="file" accept={accept} multiple hidden onChange={(e) => void upload(e.target.files)} />
      <Button size="sm" loading={busy} onClick={() => input.current?.click()}><Paperclip size={15} aria-hidden />{label}</Button>
      {progress && <span className="faint" style={{ marginLeft: 8 }} role="status">{progress}</span>}
      <ActionError error={error} />
    </div>
  );
}

export function FileList({ entityType, entityId }: { entityType: string; entityId: string }) {
  const q = useQuery({
    queryKey: ['files', entityType, entityId],
    queryFn: () => command<FileRow[]>('files_for', { entity_type: entityType, entity_id: entityId }),
  });
  const [err, setErr] = useState<unknown>(null);
  if (!q.data?.length) return q.isLoading ? null : <div className="faint">Файлов нет</div>;
  async function open(f: FileRow) {
    setErr(null);
    try {
      window.open(await storage.signedUrl(f.path), '_blank', 'noopener');
    } catch (e) {
      setErr(e);
    }
  }
  return (
    <div>
      <ul className="list">
        {q.data.map((f) => (
          <li key={f.id} className="row" style={{ padding: '6px 0' }}>
            {f.mime.startsWith('image/') ? <ImageIcon size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
            <button className="btn btn-ghost btn-sm" onClick={() => void open(f)}>{f.name}</button>
            <span className="faint">{Math.ceil(f.size_bytes / 1024)} КБ{f.visibility === 'staff' ? ' · только сотрудники' : ''}</span>
          </li>
        ))}
      </ul>
      <ActionError error={err} />
    </div>
  );
}
