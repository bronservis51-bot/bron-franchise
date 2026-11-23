import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import './HelpTip.css';

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!open || !anchor || !tip) return;

    const viewport = window.visualViewport;
    const place = () => {
      const padding = 12;
      const gap = 6;
      const left = (viewport?.offsetLeft ?? 0) + padding;
      const top = (viewport?.offsetTop ?? 0) + padding;
      const right = left + (viewport?.width ?? window.innerWidth) - padding * 2;
      const bottom = top + (viewport?.height ?? window.innerHeight) - padding * 2;
      const anchorRect = anchor.getBoundingClientRect();
      if (anchorRect.bottom < top || anchorRect.top > bottom) { setOpen(false); return; }
      const above = anchorRect.top - gap - top;
      const below = bottom - anchorRect.bottom - gap;
      tip.style.maxWidth = `${Math.min(320, right - left)}px`;
      tip.style.maxHeight = `${Math.max(0, above, below)}px`;
      const { width, height } = tip.getBoundingClientRect();
      tip.style.left = `${Math.max(left, Math.min(anchorRect.left, right - width))}px`;
      tip.style.top = `${height <= below || below >= above ? anchorRect.bottom + gap : anchorRect.top - gap - height}px`;
    };
    tip.showPopover?.();
    place();

    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !anchor.contains(event.target) && !tip.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      anchor.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      tip.hidePopover?.();
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [open]);

  return (
    <span className="help-tip">
      <button type="button" ref={anchorRef} className="icon-btn help-tip-trigger" aria-label={label}
        aria-expanded={open} aria-controls={id} aria-describedby={id} onClick={() => setOpen(value => !value)}>
        <CircleHelp size={16} aria-hidden />
      </button>
      <span ref={tipRef} id={id} className="help-tip-popover" role="tooltip" popover="manual" hidden={!open}>{children}</span>
    </span>
  );
}
