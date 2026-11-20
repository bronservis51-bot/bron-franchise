import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { command, toAppError } from '../../platform/backend';
import { ActionError, Button, Card, Checkbox, DataState, PageHeader } from '../../ui';
import { PARTNER_PREPARATION } from '../../ui/status';
import { sections } from '../knowledge/api';

const tasks = {
  location_requirements: { title: 'Уточнить требования к локации', description: 'Сверьте критерии подбора с менеджером по франшизе.' },
  location_options: { title: 'Собрать варианты локаций', description: 'Подготовьте названия или адреса площадок для обсуждения.' },
  location_review: { title: 'Обсудить варианты с менеджером', description: 'Передайте варианты и уточните, какой из них проверить дальше.' },
  island_brief: { title: 'Собрать данные для проекта островка', description: 'Передайте проектировщику известные параметры площадки.' },
  island_design: { title: 'Подготовить проект островка', description: 'Обсудите макет и внесите согласованные правки.' },
  purchase_list: { title: 'Составить список для закупки', description: 'Сверьте плёнки, расходные материалы для оклейки и оборудование. Уточните состав заказа у менеджера.' },
  launch_learning: { title: 'Изучить материалы по открытию', description: 'Откройте материалы по запуску в базе знаний.' },
};

type TaskId = keyof typeof tasks;
type Stage = 'contract_signed' | 'location_search' | 'opening_preparation';
type Launch = { stage: Stage; completed_task_ids: TaskId[] };

const searchTasks: TaskId[] = ['location_requirements', 'location_options', 'location_review', 'launch_learning'];
const openingTasks: TaskId[] = ['island_brief', 'island_design', 'purchase_list', 'launch_learning'];
const tasksForStage = (stage: Stage) => stage === 'opening_preparation' ? openingTasks : searchTasks;
const launchQueryKey = (partner?: string | null) => ['partner-launch', partner] as const;
const kbSearch = (query: string) => `/kb?q=${encodeURIComponent(query)}`;
const materialLinkStyle = { display: 'flex', alignItems: 'center', minHeight: 'var(--touch)' };

export function usePartnerLaunch(partner?: string | null) {
  return useQuery({ queryKey: launchQueryKey(partner), enabled: Boolean(partner), staleTime: 0,
    queryFn: () => command<Launch | null>('partner_launch_get', { partner }) });
}

function TaskList({ ids, completed, disabled, onChange }: {
  ids: TaskId[]; completed: Set<TaskId>; disabled?: boolean; onChange?: (task: TaskId, completed: boolean) => void;
}) {
  return <fieldset aria-label="Задачи этапа" disabled={disabled || !onChange} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}>
    {ids.map(id => <Checkbox key={id} label={<span style={{ overflowWrap: 'anywhere' }}>{tasks[id].title}</span>}
      checked={completed.has(id)} onChange={checked => onChange?.(id, checked)} />)}
  </fieldset>;
}

export function LaunchChecklist({ partner, launch }: { partner: string; launch: Launch }) {
  const client = useQueryClient();
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const ids = tasksForStage(launch.stage);
  const completed = new Set(launch.completed_task_ids);
  const done = ids.filter(id => completed.has(id)).length;
  const nextId = ids.find(id => !completed.has(id));
  const kbSections = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections, enabled: materialsOpen || nextId === 'launch_learning' });
  const sectionLink = (slug: string, fallback: string) => {
    const section = kbSections.data?.find(item => item.slug === slug);
    return section ? `/kb/s/${section.id}` : fallback;
  };
  const launchMaterials = sectionLink('zapusk-podgotovka', '/kb?path=start');
  const purchaseMaterials = sectionLink('zakupki', kbSearch('заказ материалов'));
  const change = useMutation({
    networkMode: 'always',
    mutationFn: ({ task, completed }: { task: TaskId; completed: boolean }) =>
      command<Launch | null>('partner_launch_task_set', { partner, task, completed }),
    onSuccess: async data => {
      await client.cancelQueries({ queryKey: launchQueryKey(partner) });
      client.setQueryData(launchQueryKey(partner), data);
    },
    onError: error => {
      const { code } = toAppError(error);
      if (code === 'validation' || code === 'unauthenticated' || code === 'forbidden' || code === 'not-found') {
        void client.invalidateQueries({ queryKey: launchQueryKey(partner) });
      }
    },
  });
  const opening = launch.stage === 'opening_preparation';

  return <div className="home">
    <PageHeader title={PARTNER_PREPARATION[launch.stage][0]} />
    <div className="stack">
      <div aria-live="polite">
        {nextId ? <Card title={tasks[nextId].title}>
          <p>{tasks[nextId].description}</p>
          <div className="row" style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="primary" disabled={change.isPending} loading={change.isPending && change.variables?.task === nextId}
              onClick={() => change.mutate({ task: nextId, completed: true })}>Отметить выполненным</Button>
            {nextId === 'launch_learning' && <Link className="btn" to={launchMaterials}>Открыть материалы</Link>}
          </div>
        </Card> : <Card title="Все задачи этапа отмечены">
          <p>Уточните следующий этап у менеджера по франшизе.</p>
          <div className="row" style={{ marginTop: 'var(--space-3)' }}>
            <Link className="btn" to="/kb/questions">Мои вопросы</Link>
          </div>
        </Card>}
      </div>
      <ActionError error={change.error} />
      <Card><details>
        <summary>Чек-лист этапа <span className="faint">({done} из {ids.length})</span></summary>
        <TaskList ids={ids} completed={completed} disabled={change.isPending}
          onChange={(task, completed) => change.mutate({ task, completed })} />
      </details></Card>
      <Card><details onToggle={e => setMaterialsOpen(e.currentTarget.open)}>
        <summary>Материалы и обучение</summary>
        <ul className="list" style={{ marginTop: 'var(--space-3)' }}>
          {!opening && <li><Link style={materialLinkStyle} to={kbSearch('локация')}>Материалы по выбору локации</Link></li>}
          <li><Link style={materialLinkStyle} to={launchMaterials}>Материалы по открытию</Link></li>
          {opening && <>
            <li><Link style={materialLinkStyle} to={purchaseMaterials}>Материалы по первой закупке</Link>
              {nextId !== 'purchase_list' && <p className="faint">{tasks.purchase_list.description}</p>}
            </li>
            <li><Link style={materialLinkStyle} to="/order">Каталог и заказ</Link></li>
          </>}
          <li><Link style={materialLinkStyle} to={`/learning/manage?partner=${partner}`}>Обучение сотрудников</Link></li>
          {nextId && <li><Link style={materialLinkStyle} to="/kb/questions">Мои вопросы</Link></li>}
        </ul>
      </details></Card>
    </div>
  </div>;
}

export function PartnerLaunchPreview({ partner }: { partner: string }) {
  const query = usePartnerLaunch(partner);
  if (query.isLoading || query.data === null) return null;
  return <Card className="partner-launch-preview">
    <details>
      <summary>Чек-лист подготовки</summary>
      <DataState query={query}>{launch => {
        if (!launch) return null;
        const ids = tasksForStage(launch.stage);
        const completed = new Set(launch.completed_task_ids);
        return <TaskList ids={ids} completed={completed} />;
      }}</DataState>
    </details>
  </Card>;
}
