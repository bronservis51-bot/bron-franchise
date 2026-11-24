import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
import './HelpTip.css';

const nativePopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [fallbackHost, setFallbackHost] = useState<HTMLElement | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const fallbackDialog = fallbackHost?.tagName === 'DIALOG' ? fallbackHost : null;

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!open || !anchor || !tip) return;

    const viewport = window.visualViewport;
    const scroller = anchor.closest('.dialog-body');
    let frame = 0;
    const place = () => {
      const padding = 10;
      const gap = 6;
      const viewLeft = viewport?.offsetLeft ?? 0;
      const viewTop = viewport?.offsetTop ?? 0;
      const viewRight = viewLeft + (viewport?.width ?? window.innerWidth);
      const viewBottom = viewTop + (viewport?.height ?? window.innerHeight);
      const local = fallbackDialog?.getBoundingClientRect();
      const left = Math.max(viewLeft, local?.left ?? viewLeft) + padding;
      const top = Math.max(viewTop, local?.top ?? viewTop) + padding;
      const right = Math.min(viewRight, local?.right ?? viewRight) - padding;
      const bottom = Math.min(viewBottom, local?.bottom ?? viewBottom) - padding;
      const anchorRect = anchor.getBoundingClientRect();
      const clipHost = scroller && getComputedStyle(scroller).overflowY !== 'visible' ? scroller : anchor.closest('.dialog-frame');
      const clip = clipHost?.getBoundingClientRect();
      if (anchorRect.bottom < Math.max(top, clip?.top ?? top) || anchorRect.top > Math.min(bottom, clip?.bottom ?? bottom)
        || anchorRect.right < left || anchorRect.left > right) {
        setOpen(false);
        return;
      }
      const above = anchorRect.top - gap - top;
      const below = bottom - anchorRect.bottom - gap;
      const available = Math.max(0, above, below);
      tip.style.maxWidth = Math.max(0, Math.min(320, right - left)) + 'px';
      tip.style.maxHeight = (available < 44 ? Math.max(0, bottom - top) : available) + 'px';
      const { width, height } = tip.getBoundingClientRect();
      const x = Math.max(left, Math.min(anchorRect.left, right - width));
      const adjacent = height <= below || below >= above ? anchorRect.bottom + gap : anchorRect.top - gap - height;
      const y = Math.max(top, Math.min(adjacent, bottom - height));
      tip.style.left = x - (local && fallbackDialog ? local.left + fallbackDialog.clientLeft : 0) + 'px';
      tip.style.top = y - (local && fallbackDialog ? local.top + fallbackDialog.clientTop : 0) + 'px';
    };
    const reposition = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    if (nativePopover) tip.showPopover();
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
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    viewport?.addEventListener('resize', reposition);
    viewport?.addEventListener('scroll', reposition);
    return () => {
      cancelAnimationFrame(frame);
      if (nativePopover && tip.matches(':popover-open')) tip.hidePopover();
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      viewport?.removeEventListener('resize', reposition);
      viewport?.removeEventListener('scroll', reposition);
    };
  }, [open, fallbackDialog]);

  const tip = (
    <span ref={tipRef} id={id} className="help-tip-popover" role="tooltip" hidden={!open}
      popover={nativePopover ? 'manual' : undefined} data-dialog-fallback={fallbackDialog ? '' : undefined}>{children}</span>
  );
  return (
    <span className="help-tip">
      <button type="button" ref={anchorRef} className="icon-btn help-tip-trigger" aria-label={label}
        aria-expanded={open} aria-controls={id} aria-describedby={id} onClick={event => {
          if (!nativePopover && !fallbackHost) setFallbackHost(event.currentTarget.closest('dialog') ?? document.body);
          setOpen(value => !value);
        }}>
        <CircleHelp size={16} aria-hidden />
      </button>
      {fallbackHost ? createPortal(tip, fallbackHost) : tip}
    </span>
  );
}
