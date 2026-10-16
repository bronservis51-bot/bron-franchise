// Изображения товаров без загрузки картинок: макет задней панели телефона с узором плёнки (по полю visual из каталога),
// ноутбук, рулон для плоттера и инструменты. Рисуется SVG, поэтому каталог работает офлайн и не тянет файлы.
import { useId, type ReactNode } from 'react';

export interface Visual { kind?: string; colors?: string[]; tool?: string }

const W = 120;
const H = 240;

function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 10000) / 10000;
  };
}

/** Заливка задней панели по виду плёнки. */
function Finish({ v, id, seed }: { v: Visual; id: string; seed: string }): ReactNode {
  const c = v.colors ?? [];
  const rnd = seeded(seed);
  switch (v.kind) {
    case 'matte':
      return <rect width={W} height={H} fill="#d7d8db" />;
    case 'privacy':
      return <>
        <rect width={W} height={H} fill="#2b2c31" />
        {Array.from({ length: 30 }).map((_, i) => <rect key={i} x={i * 4} y={0} width={1.4} height={H} fill="#1b1c20" />)}
      </>;
    case 'radial':
      return <>
        <rect width={W} height={H} fill={c[0]} />
        {Array.from({ length: 24 }).map((_, i) => {
          const a = (i / 24) * Math.PI * 2;
          return <path key={i} d={`M60 120 Q ${60 + Math.cos(a + 0.5) * 30} ${120 + Math.sin(a + 0.5) * 30} ${60 + Math.cos(a) * 52} ${120 + Math.sin(a) * 52}`}
            stroke={i % 3 ? c[1] : c[2]} strokeWidth={i % 2 ? 2.2 : 1.2} fill="none" strokeLinecap="round" />;
        })}
        <circle cx={60} cy={120} r={9} fill="none" stroke={c[1]} strokeWidth={2} />
      </>;
    case 'brush':
      return <>
        <rect width={W} height={H} fill={c[0]} />
        {Array.from({ length: 9 }).map((_, i) => {
          const y = 30 + i * 22 + rnd() * 8;
          return <path key={i} d={`M${-10 + rnd() * 20} ${y} C 30 ${y - 18 - rnd() * 10}, 80 ${y + 22}, ${130 - rnd() * 20} ${y - 6}`}
            stroke={i % 3 === 0 ? c[1] : c[2]} strokeWidth={2 + rnd() * 5} fill="none" strokeLinecap="round" opacity={0.9} />;
        })}
      </>;
    case 'carbon':
      return <>
        <defs>
          <pattern id={`${id}p`} width={8} height={8} patternUnits="userSpaceOnUse">
            <rect width={8} height={8} fill={c[0]} />
            <rect width={4} height={4} fill={c[1]} /><rect x={4} y={4} width={4} height={4} fill={c[1]} />
          </pattern>
        </defs>
        <rect width={W} height={H} fill={`url(#${id}p)`} />
      </>;
    case 'marble':
      return <>
        <rect width={W} height={H} fill={c[0]} />
        {Array.from({ length: 7 }).map((_, i) => {
          const x = rnd() * W;
          return <path key={i} d={`M${x} -5 C ${x + 30 * (rnd() - 0.5)} 60, ${x + 50 * (rnd() - 0.5)} 140, ${x + 40 * (rnd() - 0.5)} 250`}
            stroke={c[1]} strokeWidth={0.6 + rnd() * 1.6} fill="none" opacity={0.7} />;
        })}
      </>;
    case 'leather':
      return <>
        <rect width={W} height={H} fill={c[0]} />
        {Array.from({ length: 140 }).map((_, i) => <circle key={i} cx={rnd() * W} cy={rnd() * H} r={0.6 + rnd() * 1.2} fill={c[1]} opacity={0.6} />)}
        <rect x={6} y={6} width={W - 12} height={H - 12} rx={14} fill="none" stroke="#c9a27a" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
      </>;
    case 'camo':
      return <>
        <rect width={W} height={H} fill={c[0]} />
        {Array.from({ length: 34 }).map((_, i) => {
          const x = rnd() * W; const y = rnd() * H; const r = 8 + rnd() * 16;
          return <path key={i} d={`M${x} ${y - r} C ${x + r} ${y - r}, ${x + r * 1.2} ${y + r * 0.6}, ${x} ${y + r * 0.8} S ${x - r * 1.3} ${y - r * 0.2}, ${x} ${y - r} Z`}
            fill={c[1 + (i % 3)]} />;
        })}
      </>;
    case 'ornament':
      return <>
        <defs>
          <pattern id={`${id}p`} width={30} height={30} patternUnits="userSpaceOnUse">
            <rect width={30} height={30} fill={c[0]} />
            <path d="M15 2 L28 15 L15 28 L2 15 Z" fill="none" stroke={c[1]} strokeWidth={1.4} />
            <circle cx={15} cy={15} r={4} fill="none" stroke={c[1]} strokeWidth={1.2} />
            <circle cx={0} cy={0} r={2} fill={c[1]} /><circle cx={30} cy={30} r={2} fill={c[1]} />
          </pattern>
        </defs>
        <rect width={W} height={H} fill={`url(#${id}p)`} />
      </>;
    case 'stripes':
      return <>
        <rect width={W} height={H} fill={c[0]} />
        <rect x={42} width={14} height={H} fill={c[1]} /><rect x={64} width={14} height={H} fill={c[1]} />
        <rect x={58} width={4} height={H} fill={c[2]} />
      </>;
    case 'stars':
      return <>
        <defs>
          <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c[0]} /><stop offset="1" stopColor={c[1]} /></linearGradient>
        </defs>
        <rect width={W} height={H} fill={`url(#${id}g)`} />
        {Array.from({ length: 60 }).map((_, i) => <circle key={i} cx={rnd() * W} cy={rnd() * H} r={0.4 + rnd() * 1.4} fill={c[2]} opacity={0.5 + rnd() * 0.5} />)}
        <circle cx={84} cy={180} r={14} fill="#e8a33d" /><ellipse cx={84} cy={180} rx={24} ry={5} fill="none" stroke="#f3d39a" strokeWidth={2} />
      </>;
    default: // glossy и прочее: прозрачная глянцевая плёнка поверх чёрного корпуса
      return <>
        <defs>
          <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3a3b41" /><stop offset="0.55" stopColor="#141417" /><stop offset="1" stopColor="#26272c" /></linearGradient>
        </defs>
        <rect width={W} height={H} fill={`url(#${id}g)`} />
        <path d="M0 40 L120 0 L120 30 L0 90 Z" fill="#fff" opacity={0.08} />
      </>;
  }
}

function Phone({ v, seed, size }: { v: Visual; seed: string; size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="mockup" viewBox={`-4 -4 ${W + 8} ${H + 8}`} width={size} aria-hidden="true">
      <defs><clipPath id={`${id}c`}><rect width={W} height={H} rx={20} /></clipPath></defs>
      <rect x={-2} y={-2} width={W + 4} height={H + 4} rx={22} fill="#9c9da3" />
      <g clipPath={`url(#${id}c)`}><Finish v={v} id={id} seed={seed} /></g>
      {/* Блок камер (вырез в плёнке) */}
      <rect x={8} y={8} width={46} height={50} rx={13} fill="#0f0f11" opacity={0.92} />
      <circle cx={21} cy={21} r={8} fill="#1d1e22" stroke="#4a4b51" strokeWidth={2} />
      <circle cx={21} cy={45} r={8} fill="#1d1e22" stroke="#4a4b51" strokeWidth={2} />
      <circle cx={42} cy={33} r={8} fill="#1d1e22" stroke="#4a4b51" strokeWidth={2} />
      <circle cx={43} cy={16} r={2.4} fill="#e9e1c9" />
      {v.kind === 'matte' && <rect width={W} height={H} rx={20} fill="#fff" opacity={0.06} />}
    </svg>
  );
}

function Laptop({ v, size }: { v: Visual; size?: number }) {
  return (
    <svg className="mockup" viewBox="0 0 200 150" width={size} aria-hidden="true">
      <rect x={20} y={10} width={160} height={104} rx={8} fill={v.colors?.[0] ?? '#d9dadc'} stroke="#9c9da3" strokeWidth={2} />
      <path d="M100 48 l12 5 v10 c0 8-6 13-12 15 c-6-2-12-7-12-15 v-10 z" fill="none" stroke="#9c9da3" strokeWidth={2} />
      <path d="M6 118 h188 l-10 16 h-168 z" fill="#b9babf" />
    </svg>
  );
}

function Roll({ size }: { size?: number }) {
  return (
    <svg className="mockup" viewBox="0 0 200 150" width={size} aria-hidden="true">
      <defs><linearGradient id="roll-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f2f2f4" /><stop offset="0.5" stopColor="#c8c9cd" /><stop offset="1" stopColor="#8f9095" /></linearGradient></defs>
      <rect x={30} y={40} width={140} height={70} fill="url(#roll-g)" />
      <ellipse cx={170} cy={75} rx={14} ry={35} fill="#d8d9dc" stroke="#8f9095" />
      <ellipse cx={170} cy={75} rx={6} ry={14} fill="#55565b" />
      <ellipse cx={30} cy={75} rx={14} ry={35} fill="#b9babf" />
      <path d="M40 110 L60 136 L180 136 L170 110 Z" fill="#e7e8ea" opacity={0.9} />
    </svg>
  );
}

function Tool({ tool, size }: { tool?: string; size?: number }) {
  return (
    <svg className="mockup" viewBox="0 0 200 150" width={size} aria-hidden="true">
      {tool === 'blade' && <>
        <rect x={30} y={66} width={120} height={22} rx={6} fill="#0f0f11" />
        <path d="M150 66 L188 72 L150 88 Z" fill="#c1c2c4" />
        <rect x={40} y={70} width={30} height={14} rx={3} fill="#e5383b" />
      </>}
      {tool === 'kit' && <>
        <rect x={30} y={40} width={140} height={84} rx={12} fill="#c1c2c4" />
        <rect x={42} y={52} width={36} height={60} rx={6} fill="#fefefe" />
        <rect x={86} y={52} width={72} height={26} rx={6} fill="#0f0f11" />
        <rect x={86} y={86} width={72} height={26} rx={6} fill="#fefefe" />
      </>}
      {(!tool || tool === 'squeegee') && <>
        <path d="M40 50 h120 a10 10 0 0 1 10 10 v20 h-140 v-20 a10 10 0 0 1 10 -10 z" fill="#0f0f11" />
        <rect x={30} y={80} width={140} height={22} rx={4} fill="#c1c2c4" />
        <path d="M86 62 l14 -6 l14 6 v8 c0 6-6 10-14 12 c-8-2-14-6-14-12 z" fill="none" stroke="#fefefe" strokeWidth={2} />
      </>}
    </svg>
  );
}

export function ProductMockup({ visual, seed, size }: { visual: Visual | null | undefined; seed: string; size?: number }) {
  const v = visual ?? {};
  if (v.kind === 'laptop') return <Laptop v={v} size={size} />;
  if (v.kind === 'roll') return <Roll size={size} />;
  if (v.kind === 'tool') return <Tool tool={v.tool} size={size} />;
  return <Phone v={v} seed={seed} size={size} />;
}
