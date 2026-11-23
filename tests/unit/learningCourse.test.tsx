import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { LearningCourse, type Lesson } from '../../src/modules/learning/LearningCourse';

function lesson(id: string, fields: Partial<Lesson> = {}): Lesson {
  return { article_id: id, title: id, revision_id: 'revision', stage: 'Начало работы', questions: 3,
    due: null, percent: null, completed: false, active: false, ...fields };
}

function view(...items: Lesson[]) {
  return renderToStaticMarkup(<MemoryRouter><LearningCourse course={{ items, day: '2026-11-09', audience: 'sales' }} /></MemoryRouter>);
}

describe('7.4 — личная программа обучения', () => {
  it('выбирает активную попытку прежде повтора, включая уже зачтённый урок, и показывает каждую ссылку один раз', () => {
    const html = view(lesson('due', { completed: true, percent: 100, due: '2026-11-09' }),
      lesson('active', { active: true, completed: true }), lesson('new'));
    expect(html).toContain('aria-valuetext="2 из 3"');
    expect(html).toContain('aria-label="Продолжить урок «active»"');
    for (const id of ['due', 'active', 'new']) expect(html.split(`href="/learning/lesson/${id}"`)).toHaveLength(2);
    expect(html.match(/<h3>/g)).toHaveLength(1);
  });

  it('предлагает повтор сразу после нулевого результата и сохраняет нулевой прогресс', () => {
    const html = view(lesson('retry', { percent: 0, due: '2026-11-09' }));
    expect(html).toContain('aria-label="Повторить урок «retry»"');
    expect(html).toContain('Последний результат 0%');
    expect(html).toContain('aria-valuetext="0 из 1"');
    expect(html).not.toContain('course-program-title');
  });

  it('после всех зачётов показывает ближайшую дату повтора и позволяет открыть любой материал', () => {
    const html = view(lesson('late', { completed: true, percent: 85, due: '2026-11-23' }),
      lesson('early', { completed: true, percent: 100, due: '2026-11-12', stage: 'Продажи' }));
    expect(html).toContain('Ближайшее повторение 12.11.2026');
    expect(html).not.toContain('data-tour-target="first-lesson"');
    expect(html).toContain('href="/learning/lesson/late"');
    expect(html).toContain('href="/learning/lesson/early"');
    expect(html).toContain('Пройден · 85%');
    expect(html.match(/<h3>/g)).toHaveLength(2);
  });
});
