import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { useLocale } from '../../platform/locale';
import { DataState } from '../../ui';
import { sections, type SectionNode } from './api';

// Navigation labels only. The sources and operational rules live in protected articles.
const journeys = [
  { id: 'start', title: ['Открываю точку', 'Mağaza açıyorum'], ordered: true, steps: [
    { title: ['Договор и условия', 'Sözleşme ve koşullar'], detail: ['Обязанности сторон и территория', 'Tarafların yükümlülükleri ve bölge'], section: 'dogovor-territoriya' },
    { title: ['Подготовка к открытию', 'Açılışa hazırlık'], detail: ['Помещение, оснащение и план запуска', 'Yer, ekipman ve açılış planı'], section: 'zapusk-podgotovka' },
    { title: ['Команда и обучение', 'Ekip ve eğitim'], detail: ['Найти людей и подготовить к работе', 'Çalışan bulma ve işe hazırlama'], section: 'komanda' },
    { title: ['Материалы и первая закупка', 'Malzemeler ve ilk sipariş'], detail: ['Заказ, доставка и приёмка', 'Sipariş, teslimat ve teslim alma'], section: 'zakupki' },
    { title: ['Доступ в кабинет', 'Panele erişim'], detail: ['Вход и учётные записи', 'Giriş ve hesaplar'], section: 'kabinet-dostupy' },
    { title: ['Первый рабочий день', 'İlk iş günü'], detail: ['Открытие смены и контроль точки', 'Vardiya ve mağaza kontrolü'], section: 'upravlenie-tochkoy' },
  ] },
  { id: 'team', title: ['Нанимаю и обучаю', 'İşe alıyorum ve eğitiyorum'], ordered: true, steps: [
    { title: ['Подготовить вакансию', 'İş ilanı hazırla'], detail: ['Шаблоны пока недоступны', 'Şablonlar henüz hazır değil'], pending: true },
    { title: ['Анкета кандидата', 'Aday formu'], detail: ['Своя Google Форма и ответы у каждого партнёра', 'Her işletmecinin kendi Google Formu ve yanıtları'], query: 'анкета кандидата' },
    { title: ['Провести собеседование', 'Mülakat yap'], detail: ['Вопросы, оценка и следующий шаг', 'Sorular, değerlendirme ve sonraki adım'], query: 'собеседование' },
    { title: ['Адаптировать сотрудника', 'Çalışanı işe hazırla'], detail: ['Обучение и проверка навыков', 'Eğitim ve beceri kontrolü'], section: 'adaptatsiya' },
    { title: ['Проверить готовность к работе', 'İşe hazır olup olmadığını kontrol et'], detail: ['Навыки и допуск к самостоятельной смене', 'Beceriler ve tek başına vardiya yetkisi'], section: 'attestatsiya' },
    { title: ['Организовать работу команды', 'Ekibin çalışmasını düzenle'], detail: ['График и оплата труда', 'Çalışma saatleri ve ücret'], section: 'grafik-oplata' },
  ] },
  { id: 'work', title: ['Управляю точкой', 'Mağazayı yönetiyorum'], ordered: false, steps: [
    { title: ['Открыть и закрыть смену', 'Vardiyayı aç ve kapat'], detail: ['Подготовка и порядок работы', 'Hazırlık ve işin akışı'], section: 'smena' },
    { title: ['Помочь клиенту выбрать', 'Müşterinin seçimine yardımcı ol'], detail: ['Консультация и продажи', 'Danışmanlık ve satış'], section: 'prodazhi' },
    { title: ['Проверить качество', 'Kaliteyi kontrol et'], detail: ['Оклейка, материалы и оборудование', 'Kaplama, malzemeler ve ekipman'], section: 'okleyka' },
    { title: ['Пополнить запас', 'Stok yenile'], detail: ['Заказ и получение материалов', 'Malzeme siparişi ve teslim alma'], section: 'zakupki' },
    { title: ['Разобраться в цифрах', 'Rakamları incele'], detail: ['Выручка, расходы и роялти', 'Ciro, gider ve royalti'], section: 'finansy-royalti' },
    { title: ['Привлечь клиентов', 'Müşteri çek'], detail: ['Продвижение и бренд-материалы', 'Tanıtım ve marka malzemeleri'], section: 'marketing-prodvizhenie' },
  ] },
  { id: 'help', title: ['Решаю проблему', 'Sorun çözüyorum'], ordered: false, steps: [
    { title: ['Клиент недоволен', 'Müşteri memnun değil'], detail: ['Гарантия и работа с обращением', 'Garanti ve müşteri talebi'], section: 'garantii' },
    { title: ['Проблема с поставкой', 'Tedarik sorunu'], detail: ['Брак, недостача или возврат', 'Kusur, eksik teslimat veya iade'], section: 'brak-vozvrat' },
    { title: ['Не работает оборудование', 'Ekipman çalışmıyor'], detail: ['Плоттер, лекала и программы', 'Kesim plotteri, şablonlar ve yazılım'], section: 'oborudovanie' },
    { title: ['Не получается войти', 'Giriş yapılamıyor'], detail: ['Пароль и доступ в приложение', 'Parola ve uygulamaya erişim'], section: 'kabinet-dostupy' },
    { title: ['Нештатная ситуация', 'Beklenmedik durum'], detail: ['Помощь и порядок обращения', 'Destek ve başvuru süreci'], section: 'intsidenty' },
    { title: ['Меняю формат работы', 'Çalışma biçimimi değiştiriyorum'], detail: ['Изменения и завершение сотрудничества', 'İş birliğini değiştirme ve sonlandırma'], section: 'izmeneniya-partnerstva' },
  ] },
] as const;

export function KbJourneys({ nodes, onAsk }: { nodes: SectionNode[]; onAsk: (question: string) => void }) {
  const { t } = useLocale();
  const [params, setParams] = useSearchParams();
  const selected = journeys.find(j => j.id === params.get('path')) ?? journeys[0];
  const StepList = selected.ordered ? 'ol' : 'ul';
  const secs = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections, staleTime: 60_000 });
  return <section className="kb-journeys" aria-labelledby="kb-journeys-title">
    <div className="kb-section-label"><h2 id="kb-journeys-title">{t('Что нужно сделать?', 'Ne yapmak istiyorsunuz?')}</h2></div>
    <div className="kb-journey-tabs" role="group" aria-label={t('Рабочая задача', 'İş görevi')}>
      {journeys.map(j => <button key={j.id} type="button" aria-pressed={selected.id === j.id} onClick={() => {
        const next = new URLSearchParams(params); next.set('path', j.id); setParams(next, { replace: true });
      }}>{t(j.title[0], j.title[1])}</button>)}
    </div>
    <div className="kb-journey-body">
      <DataState query={secs} skeleton={3}>{(list) => <StepList className="kb-journey-steps" role="list">
        {selected.steps.map((step, index) => {
          const section = 'section' in step ? list.find(s => s.slug === step.section) : undefined;
          const count = section ? nodes.find(s => s.id === section.id)?.count : undefined;
          const pending = 'pending' in step;
          const query = 'query' in step ? step.query : undefined;
          const content = <>{selected.ordered && <span className="kb-step-number" aria-hidden>{index + 1}</span>}<span className="kb-step-copy"><strong>{t(step.title[0], step.title[1])}</strong><span>{t(step.detail[0], step.detail[1])}</span>{count === 0 && <small>{t('Пока нет материалов', 'Henüz içerik yok')}</small>}</span>{!pending && <ChevronRight size={16} aria-hidden />}</>;
          return <li key={step.title[0]}>{pending ? <div className="kb-step kb-step-pending">{content}</div> : section ? <Link className="kb-step" to={`/kb/s/${section.id}`}>{content}</Link> : query ? <Link className="kb-step" to={`/kb?q=${encodeURIComponent(query)}&path=${selected.id}`}>{content}</Link> : <button className="kb-step" type="button" onClick={() => onAsk(`${t(step.title[0], step.title[1])}: `)}>{content}</button>}</li>;
        })}
      </StepList>}</DataState>
    </div>
  </section>;
}
