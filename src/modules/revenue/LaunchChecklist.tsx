import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useLocale } from '../../platform/locale';
import { command, toAppError } from '../../platform/backend';
import { ActionError, Button, Card, Checkbox, DataState, PageHeader } from '../../ui';
import { PARTNER_PREPARATION } from '../../ui/status';
import { sections } from '../knowledge/api';

const tasks = {
  location_requirements: { title: ['Уточнить требования к локации', 'Mağaza yeri gerekliliklerini öğren'] as const, description: ['Сверьте критерии подбора с менеджером по франшизе.', 'Seçim ölçütlerini franchise yöneticinizle teyit edin.'] as const },
  location_options: { title: 'Собрать варианты локаций', description: ['Подготовьте названия или адреса площадок для обсуждения.', 'Görüşmek için yerlerin adlarını veya adreslerini hazırlayın.'] as const },
  location_review: { title: ['Обсудить варианты с менеджером', 'Seçenekleri yöneticiyle görüş'] as const, description: ['Передайте варианты и уточните, какой из них проверить дальше.', 'Seçenekleri iletin ve hangisinin önce inceleneceğini sorun.'] as const },
  island_brief: { title: ['Собрать данные для проекта островка', 'Stand projesi için bilgi topla'] as const, description: ['Передайте проектировщику известные параметры площадки.', 'Yerin bilinen ölçülerini tasarımcıya bildirin.'] as const },
  island_design: { title: ['Подготовить проект островка', 'Stand projesini hazırla'] as const, description: ['Обсудите макет и внесите согласованные правки.', 'Çizimi görüşün ve kararlaştırılan değişiklikleri uygulayın.'] as const },
  purchase_list: { title: ['Составить список для закупки', 'Alışveriş listesi hazırla'] as const, description: ['Сверьте плёнки, расходные материалы для оклейки и оборудование. Уточните состав заказа у менеджера.', 'Film, kaplama sarf malzemesi ve ekipmanı kontrol edin. Sipariş içeriğini yöneticinizle teyit edin.'] as const },
  launch_learning: { title: ['Изучить материалы по открытию', 'Açılış içeriklerini incele'] as const, description: ['Откройте материалы по запуску в базе знаний.', 'Bilgi bankasında açılış içeriklerini açın.'] as const },
};

type TaskId = keyof typeof tasks;
type Stage = 'contract_signed' | 'location_search' | 'opening_preparation';
type Launch = { stage: Stage; completed_task_ids: TaskId[]; cycle?: number };

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
  const { t } = useLocale();
  return <fieldset aria-label={t('Задачи этапа', 'Aşama görevleri')} disabled={disabled || !onChange} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}>
    {ids.map(id => <Checkbox key={id} label={<span style={{ overflowWrap: 'anywhere' }}>{t(tasks[id].title[0], tasks[id].title[1])}</span>}
      checked={completed.has(id)} onChange={checked => onChange?.(id, checked)} />)}
  </fieldset>;
}

export function LaunchChecklist({ partner, launch, onHistory }: { partner: string; launch: Launch; onHistory?: () => void }) {
  const { t } = useLocale();
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
      command<Launch | null>('partner_launch_task_set_checked', { partner, task, completed, cycle: launch.cycle ?? 0 }),
    onSuccess: data => {
      client.setQueryData<Launch | null>(launchQueryKey(partner), current =>
        current?.stage === launch.stage && (current.cycle ?? 0) === (launch.cycle ?? 0) ? data : current);
      void client.invalidateQueries({ queryKey: launchQueryKey(partner) });
    },
    onError: error => {
      const { code } = toAppError(error);
      if (code === 'validation' || code === 'version-conflict' || code === 'unauthenticated' || code === 'forbidden' || code === 'not-found') {
        void client.invalidateQueries({ queryKey: launchQueryKey(partner) });
      }
    },
  });
  const opening = launch.stage === 'opening_preparation';

  return <div className="home">
    <PageHeader title={t(PARTNER_PREPARATION[launch.stage][0], { contract_signed: 'Sözleşme imzalandı', location_search: 'Mağaza yeri arama', opening_preparation: 'Açılışa hazırlık' }[launch.stage])}
      actions={onHistory && <Button onClick={onHistory}>{t('История выручки', 'Ciro geçmişi')}</Button>} />
    <div className="stack">
      <div aria-live="polite">
        {nextId ? <Card title={t(tasks[nextId].title[0], tasks[nextId].title[1])}>
          <p>{t(tasks[nextId].description[0], tasks[nextId].description[1])}</p>
          <div className="row" style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="primary" disabled={change.isPending} loading={change.isPending && change.variables?.task === nextId}
              onClick={() => change.mutate({ task: nextId, completed: true })}>{t('Отметить выполненным', 'Tamamlandı olarak işaretle')}</Button>
            {nextId === 'launch_learning' && <Link className="btn" to={launchMaterials}>{t('Открыть материалы', 'İçerikleri aç')}</Link>}
          </div>
        </Card> : <Card title={t('Все задачи этапа отмечены', 'Bu aşamanın görevleri tamamlandı')}>
          <p>{t('Уточните следующий этап у менеджера по франшизе.', 'Bir sonraki aşamayı franchise yöneticinizle görüşün.')}</p>
          <div className="row" style={{ marginTop: 'var(--space-3)' }}>
            <Link className="btn" to="/kb/questions">{t('Мои вопросы', 'Sorularım')}</Link>
          </div>
        </Card>}
      </div>
      <ActionError error={change.error} />
      <Card><details>
        <summary>{t('Чек-лист этапа', 'Aşama kontrol listesi')} <span className="faint">{t(`(${done} из ${ids.length})`, `(${done}/${ids.length})`)}</span></summary>
        <TaskList ids={ids} completed={completed} disabled={change.isPending}
          onChange={(task, completed) => change.mutate({ task, completed })} />
      </details></Card>
      <Card><details onToggle={e => setMaterialsOpen(e.currentTarget.open)}>
        <summary>{t('Материалы и обучение', 'İçerikler ve eğitim')}</summary>
        <ul className="list" style={{ marginTop: 'var(--space-3)' }}>
          {!opening && <li><Link style={materialLinkStyle} to={kbSearch('локация')}>{t('Материалы по выбору локации', 'Mağaza yeri seçimi içerikleri')}</Link></li>}
          <li><Link style={materialLinkStyle} to={launchMaterials}>{t('Материалы по открытию', 'Açılış içerikleri')}</Link></li>
          {opening && <>
            <li><Link style={materialLinkStyle} to={purchaseMaterials}>{t('Материалы по первой закупке', 'İlk sipariş içerikleri')}</Link>
              {nextId !== 'purchase_list' && <p className="faint">{t(tasks.purchase_list.description[0], tasks.purchase_list.description[1])}</p>}
            </li>
            <li><Link style={materialLinkStyle} to="/order">{t('Каталог и заказ', 'Katalog ve sipariş')}</Link></li>
          </>}
          <li><Link style={materialLinkStyle} to={`/learning/manage?partner=${partner}`}>{t('Обучение сотрудников', 'Çalışan eğitimi')}</Link></li>
          {nextId && <li><Link style={materialLinkStyle} to="/kb/questions">{t('Мои вопросы', 'Sorularım')}</Link></li>}
        </ul>
      </details></Card>
    </div>
  </div>;
}

export function PartnerLaunchPreview({ partner }: { partner: string }) {
  const { t } = useLocale();
  const query = usePartnerLaunch(partner);
  if (query.isLoading || query.data === null) return null;
  return <Card className="partner-launch-preview">
    <details>
      <summary>{t('Чек-лист подготовки', 'Hazırlık kontrol listesi')}</summary>
      <DataState query={query}>{launch => {
        if (!launch) return null;
        const ids = tasksForStage(launch.stage);
        const completed = new Set(launch.completed_task_ids);
        return <TaskList ids={ids} completed={completed} />;
      }}</DataState>
    </details>
  </Card>;
}
