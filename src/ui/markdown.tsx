// Рендер статей формата md-v1 (ADR-0007): CommonMark + таблицы, сырой HTML запрещён, результат дополнительно очищается.
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { useMemo } from 'react';

const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });

// Ссылки наружу открываются в новой вкладке без доступа к opener; ссылки app: ведут на сущности приложения.
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet('href') ?? '');
  if (href.startsWith('app:')) {
    tokens[idx].attrSet('href', `#/${href.slice(4)}`);
  } else if (/^https?:/i.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLink(tokens, idx, options, env, self);
};

/** Ссылка на видео → адрес встроенного плеера. Только известные площадки, id проверяется по формату. */
export function videoEmbed(url: string): { src: string; title: string } | null {
  let m = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i.exec(url);
  if (m) return { src: `https://www.youtube-nocookie.com/embed/${m[1]}`, title: 'Видео YouTube' };
  m = /^https?:\/\/(?:www\.)?rutube\.ru\/(?:video|play\/embed|shorts)\/([0-9a-f]{32})/i.exec(url);
  if (m) return { src: `https://rutube.ru/play/embed/${m[1]}`, title: 'Видео Rutube' };
  m = /^https?:\/\/(?:www\.)?(?:vk\.com|vkvideo\.ru)\/(?:.*[?&]z=)?video(-?\d+)_(\d+)/i.exec(url);
  if (m) return { src: `https://vk.com/video_ext.php?oid=${m[1]}&id=${m[2]}&hd=2`, title: 'VK Видео' };
  return null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Абзац из одной ссылки на видео → встроенный плеер (iframe строим сами после очистки, адрес — только из videoEmbed). */
export function embedVideos(html: string): string {
  return html.replace(/<p><a href="([^"]+)"[^>]*>[^<]*<\/a><\/p>/g, (all, href: string) => {
    const v = videoEmbed(href.replace(/&amp;/g, '&'));
    if (!v) return all;
    return `<div class="video"><iframe src="${esc(v.src)}" title="${v.title}" loading="lazy" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`
      + `<p class="video-link"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">Не открывается? Смотреть на сайте</a></p>`;
  });
}

export function renderMarkdown(source: string): string {
  return embedVideos(DOMPurify.sanitize(md.render(source ?? ''), {
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#\/)/i,
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'script'],
  }));
}

/** Оглавление по заголовкам h2/h3. */
export function headings(source: string): { level: number; text: string; id: string }[] {
  return (source ?? '').split('\n').flatMap((line, i) => {
    const m = /^(#{2,3})\s+(.+)$/.exec(line.trim());
    return m ? [{ level: m[1].length, text: m[2].replace(/[*_`]/g, ''), id: `h-${i}` }] : [];
  });
}

export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    let i = 0;
    const lines = (source ?? '').split('\n');
    const ids = lines.map((l, n) => (/^#{2,3}\s/.test(l.trim()) ? `h-${n}` : null));
    // id заголовков для оглавления: подставляем после рендера по порядку
    const rendered = renderMarkdown(source);
    const order = ids.filter(Boolean) as string[];
    return rendered.replace(/<h([23])>/g, (_m, lvl) => `<h${lvl} id="${order[i++] ?? ''}" tabindex="-1">`);
  }, [source]);
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
