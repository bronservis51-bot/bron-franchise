// Фирменные элементы по брендбуку «Бронь Сервис»: логотип (только белый или чёрный, без градиентов и искажений)
// и фирменный паттерн «щит — крест — круг» (защита, окружность, поломка).
import markSvg from './brand/logo-mark.svg?raw';
import fullSvg from './brand/logo-full.svg?raw';

function Svg({ svg, height, className, title }: { svg: string; height: number; className?: string; title?: string }) {
  return (
    <span
      className={['brand-logo', className].filter(Boolean).join(' ')}
      style={{ height, display: 'inline-flex' }}
      role="img"
      aria-label={title ?? 'Бронь Сервис'}
      // Статичные файлы логотипа из репозитория (не пользовательский ввод)
      dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', `<svg height="${height}" aria-hidden="true" `) }}
    />
  );
}

/** Знак: щит с окружностью и галочкой. Цвет наследуется (currentColor): белый на тёмном, чёрный на светлом. */
export const LogoMark = ({ height = 32, className }: { height?: number; className?: string }) => <Svg svg={markSvg} height={height} className={className} />;

/** Полный логотип: знак + «БРОНЬ СЕРВИС». */
export const LogoFull = ({ height = 36, className }: { height?: number; className?: string }) => <Svg svg={fullSvg} height={height} className={className} />;

/** Фирменный паттерн: сетка символов щита, креста и круга (фон декоративных блоков). */
export function BrandPattern({ className, rows = 5, cols = 6 }: { className?: string; rows?: number; cols?: number }) {
  const seq = ['s', 'x', 'o', 's', 'x', 'o', 'o', 's', 'x', 'o', 'x', 's', 's', 'x', 's', 'o', 'o', 'x', 'x', 's', 'x', 'o', 'x', 's', 's', 'x', 's', 'o', 'o', 'x'];
  const step = 24;
  return (
    <svg className={['brand-pattern', className].filter(Boolean).join(' ')} width={cols * step} height={rows * step} viewBox={`0 0 ${cols * step} ${rows * step}`} aria-hidden="true">
      {Array.from({ length: rows * cols }).map((_, i) => {
        const x = (i % cols) * step + step / 2;
        const y = Math.floor(i / cols) * step + step / 2;
        const k = seq[i % seq.length];
        if (k === 'o') return <circle key={i} cx={x} cy={y} r={4.2} fill="none" stroke="currentColor" strokeWidth={1.5} />;
        if (k === 'x') return <path key={i} d={`M${x - 3.6} ${y - 3.6}L${x + 3.6} ${y + 3.6}M${x + 3.6} ${y - 3.6}L${x - 3.6} ${y + 3.6}`} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />;
        return <path key={i} d={`M${x - 4} ${y - 3.2}L${x} ${y - 5}L${x + 4} ${y - 3.2}V${y + 0.4}C${x + 4} ${y + 2.8} ${x + 2.2} ${y + 4.4} ${x} ${y + 5.2}C${x - 2.2} ${y + 4.4} ${x - 4} ${y + 2.8} ${x - 4} ${y + 0.4}Z`} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />;
      })}
    </svg>
  );
}
