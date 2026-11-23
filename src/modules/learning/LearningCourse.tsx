import { ArrowRight, BookOpen, Check, ChevronRight, CircleCheck, RotateCcw } from 'lucide-react';
import { Link } from 'react-router';
import { formatDate } from '../../platform/dates';
import './learning-course.css';

export type Lesson = {
  article_id: string; revision_id: string; title: string; stage: string; questions: number;
  due: string | null; percent: number | null; completed: boolean; active: boolean;
};
export type Overview = { day: string; audience: string; items: Lesson[] };

function availableToRepeat(lesson: Lesson, day: string) {
  return lesson.due !== null && lesson.due <= day;
}

function purpose(lesson: Lesson) {
  if (lesson.active) return 'Продолжить';
  if (lesson.completed || lesson.percent !== null) return 'Повторить';
  return 'Начать';
}

function LessonRow({ lesson, day }: { lesson: Lesson; day: string }) {
  const repeat = availableToRepeat(lesson, day);
  const status = lesson.active ? 'В процессе' : repeat ? 'Пора повторить' : lesson.completed ? 'Пройден' : 'Ещё не пройден';
  const Icon = lesson.active ? BookOpen : repeat ? RotateCcw : lesson.completed ? CircleCheck : BookOpen;
  return <li>
    <Link className="course-row" to={`/learning/lesson/${lesson.article_id}`}>
      <Icon aria-hidden size={18} className={lesson.completed && !repeat ? 'course-done-icon' : undefined} />
      <span className="course-row-copy">
        <strong>{lesson.title}</strong>
        <span>{status}{lesson.percent !== null && ` · ${lesson.percent}%`}
          {lesson.due && <> · Повторение <time dateTime={lesson.due}>{formatDate(lesson.due)}</time></>}</span>
      </span>
      <ChevronRight size={16} aria-hidden />
      <span className="sr-only">{purpose(lesson)} урок</span>
    </Link>
  </li>;
}

export function LearningCourse({ course }: { course: Overview }) {
  const { items, day } = course;
  const passed = items.filter(lesson => lesson.completed).length;
  const next = items.find(lesson => lesson.active) ?? items.find(lesson => !lesson.completed || availableToRepeat(lesson, day));
  const nextReview = next ? undefined : items.map(lesson => lesson.due).filter(due => due !== null).sort()[0];
  const groups = new Map<string, Lesson[]>();
  for (const lesson of items) {
    if (lesson.article_id === next?.article_id) continue;
    const stage = lesson.stage.trim() || 'Уроки';
    const group = groups.get(stage);
    if (group) group.push(lesson);
    else groups.set(stage, [lesson]);
  }
  const action = next && purpose(next);
  return <div className="learning-course">
    <div className="course-progress">
      <div><span>Пройдено уроков</span><strong>{passed} из {items.length}</strong></div>
      <progress value={passed} max={items.length} aria-label="Пройдено уроков" aria-valuetext={`${passed} из ${items.length}`} />
    </div>
    <section className="learning-next" aria-labelledby="course-next-title">
      {next ? <>
        <p className="course-action-label"><BookOpen size={17} aria-hidden />
          {next.active ? 'Продолжить урок' : availableToRepeat(next, day) || next.percent !== null ? 'Пора повторить' : 'Следующий урок'}
        </p>
        <h2 id="course-next-title">{next.title}</h2>
        {(next.stage || next.percent !== null || next.due) && <p className="course-next-meta">
          {[next.stage, next.percent !== null ? `Последний результат ${next.percent}%` : '',
            next.due ? `Повторение ${formatDate(next.due)}` : ''].filter(Boolean).join(' · ')}
        </p>}
        <Link className="btn btn-primary course-open" to={`/learning/lesson/${next.article_id}`}
          aria-label={`${action} урок «${next.title}»`} data-tour-target="first-lesson">
          {action}{action === 'Начать' && ' урок'}<ArrowRight size={17} aria-hidden />
        </Link>
      </> : <>
        <h2 id="course-next-title"><Check aria-hidden size={20} />Все назначенные уроки пройдены</h2>
        {nextReview && <p className="course-next-meta">Ближайшее повторение {formatDate(nextReview)}.</p>}
      </>}
    </section>
    {groups.size > 0 && <section className="learning-program" aria-labelledby="course-program-title">
      <h2 id="course-program-title">Программа обучения</h2>
      {Array.from(groups, ([stage, lessons]) => <div key={stage} className="course-stage">
        <h3>{stage}</h3>
        <ul>{lessons.map(lesson => <LessonRow key={lesson.article_id} lesson={lesson} day={day} />)}</ul>
      </div>)}
    </section>}
  </div>;
}
