// Keep the phone shell in the visible viewport. Content, not the page canvas, scrolls.
export function startViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  let frame = 0;
  let unfocusedHeight = window.innerHeight;
  let width = window.innerWidth;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const mobile = window.matchMedia('(max-width: 960px)').matches;
      const height = vv?.height ?? window.innerHeight;
      root.style.setProperty('--app-height', `${height}px`);
      root.style.setProperty('--visual-top', `${vv?.offsetTop ?? 0}px`);
      const input = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
      if (Math.abs(window.innerWidth-width)>80) { width=window.innerWidth; unfocusedHeight=window.innerHeight; }
      if (!input) unfocusedHeight=Math.max(window.innerHeight,height);
      root.classList.toggle('keyboard-open', mobile && !!input && Math.max(unfocusedHeight,window.innerHeight)-height > 100);
    });
  };
  const noGesture = (e: Event) => { if (window.matchMedia('(max-width: 960px)').matches) e.preventDefault(); };
  const noPinch = (e: TouchEvent) => { if (e.touches.length > 1) noGesture(e); };
  vv?.addEventListener('resize', update); vv?.addEventListener('scroll', update);
  window.addEventListener('resize', update); document.addEventListener('focusin', update); document.addEventListener('focusout', update);
  document.addEventListener('gesturestart', noGesture, {passive:false});
  document.addEventListener('gesturechange', noGesture, {passive:false});
  document.addEventListener('touchmove', noPinch, {passive:false});
  update();
  return () => {
    cancelAnimationFrame(frame); vv?.removeEventListener('resize', update); vv?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update); document.removeEventListener('focusin', update); document.removeEventListener('focusout', update);
    document.removeEventListener('gesturestart', noGesture); document.removeEventListener('gesturechange', noGesture); document.removeEventListener('touchmove', noPinch);
  };
}
