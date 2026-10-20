// Видео в статьях: ссылка отдельной строкой → встроенный плеер только известных площадок; остальное — обычная ссылка.
import { describe, expect, it } from 'vitest';
import { embedVideos, videoEmbed } from '../../src/ui/markdown';

describe('видео в статьях', () => {
  it('распознаёт YouTube, Rutube и VK', () => {
    expect(videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(videoEmbed('https://youtu.be/dQw4w9WgXcQ')?.src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(videoEmbed('https://rutube.ru/video/0123456789abcdef0123456789abcdef/')?.src).toBe('https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef');
    expect(videoEmbed('https://vk.com/video-12345_678')?.src).toBe('https://vk.com/video_ext.php?oid=-12345&id=678&hd=2');
    expect(videoEmbed('https://evil.example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('встраивает только ссылку отдельным абзацем, остальные ссылки не трогает', () => {
    const html = embedVideos('<p><a href="https://youtu.be/dQw4w9WgXcQ" target="_blank">https://youtu.be/dQw4w9WgXcQ</a></p>'
      + '<p>текст <a href="https://youtu.be/dQw4w9WgXcQ">ссылка</a></p><p><a href="https://evil.example.com/v">x</a></p>');
    expect((html.match(/<iframe/g) ?? []).length).toBe(1);
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(html).toContain('href="https://evil.example.com/v"');
    expect(html).not.toContain('evil.example.com/v"></iframe');
  });
});
