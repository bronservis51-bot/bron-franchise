import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createHashRouter, Navigate, RouterProvider, useRouteError } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isConfigured } from '../platform/config';
import { SessionProvider, useSession } from '../platform/session';
import { toAppError } from '../platform/backend';
import { ToastProvider } from '../ui/toast';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '../ui';
import { Shell } from './Shell';
import { ownedTeamPartner, TeamAccessPage, TeamHome } from '../modules/staff/TeamAccounts';
import { LoginPage, SetupPage } from './LoginPage';
import { workspaceAccess, workspaceRole } from './nav';
import { franchiseePartnerCards } from '../modules/revenue/partnerLifecycle';

// Экраны менеджера и редактор статей загружаются по требованию: франчайзи их код не скачивает
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;
function page<M extends Record<string, unknown>>(loader: () => Promise<M>, name: keyof M & string) {
  const C = lazy(() => loader().then((m) => ({ default: m[name] as AnyComponent })));
  return function LazyPage(props: Record<string, unknown>) {
    return <Suspense fallback={<Skeleton lines={5} />}><C {...props} /></Suspense>;
  };
}
const FranchiseeHome = page(() => import('../modules/revenue/FranchiseeHome'), 'FranchiseeHome');
const kb = () => import('../modules/knowledge/KnowledgePages');
const kbView = () => import('../modules/knowledge/KbBrowse');
const KbHomePage = page(kbView, 'KbHomePage');
const ArticlePage = page(kbView, 'ArticlePage');
const SectionPage = page(kbView, 'SectionPage');
const KbManagePage = page(kbView, 'KbManagePage');
const ArticleEditPage = page(kb, 'ArticleEditPage');
const SupplyFinancePage = page(() => import('../modules/manager/SupplyFinancePage'), 'SupplyFinancePage');
const OrderPage = page(() => import('../modules/orders/OrderLink'), 'OrderPage');
const NetworkPage = page(() => import('../modules/manager/NetworkPage'), 'NetworkPage');
const PartnerPage = page(() => import('../modules/manager/PartnerPage'), 'PartnerPage');
const RoyaltyPartnerPage = page(() => import('../modules/manager/RoyaltyPartnerPage'), 'RoyaltyPartnerPage');
const StaffHome = page(() => import('../modules/staff/StaffHome'), 'StaffHome');
const StaffPage = page(() => import('../modules/staff/StaffPage'), 'StaffPage');
const FinancePage = page(() => import('../modules/finance/FinancePage'), 'FinancePage');
const QuestionsPage = page(kb, 'QuestionsPage');
const LearningPage = page(() => import('../modules/learning/Learning'), 'LearningPage');
const LearningManagePage = page(() => import('../modules/learning/Learning'), 'LearningManagePage');
const LearningLessonPage = page(() => import('../modules/learning/Learning'), 'LearningLessonPage');
const LeadsPage = page(() => import('../modules/leads/LeadsPage'), 'LeadsPage');
const recovery = () => import('./ManagerRecoveryPage');
const RecoveryRequest = page(recovery, 'ManagerRecoveryRequestPage');
const RecoveryLink = page(recovery, 'ManagerRecoveryLinkPage');
const RecoveryDone = page(recovery, 'ManagerRecoveryDonePage');

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      retry: (count, e) => count < 2 && !['forbidden', 'not-found', 'unauthenticated', 'validation'].includes(toAppError(e).code),
      refetchOnWindowFocus: true,
    },
  },
});

function RouteError() {
  const err = useRouteError();
  return <div className="content"><ErrorState error={err} onRetry={() => window.location.reload()} /></div>;
}

function NotFound() {
  return <ErrorState error={{ message: 'not-found', details: 'Страница не найдена' }} />;
}

const router = createHashRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/recover', element: <RecoveryRequest /> },
  { path: '/recover/:kind/:token', element: <RecoveryLink /> },
  { path: '/recover/done', element: <RecoveryDone /> },
  { path: '/rating', element: <Navigate to="/" replace /> },
  {
    path: '/',
    element: <Guard />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Home /> },
      { path: 'learning', element: <LearningEntry /> },
      { path: 'learning/manage', element: <WorkspaceRoute feature="learningManage"><LearningManagePage /></WorkspaceRoute> },
      { path: 'learning/lesson/:id', element: <WorkspaceRoute feature="learning"><LearningLessonPage /></WorkspaceRoute> },
      { path: 'order', element: <WorkspaceRoute feature="order"><OrderPage /></WorkspaceRoute> },
      { path: 'partners/:id', element: <WorkspaceRoute feature="network"><PartnerPage /></WorkspaceRoute> },
      { path: 'leads', element: <WorkspaceRoute feature="network"><LeadsPage /></WorkspaceRoute> },
      { path: 'royalty', element: <Navigate to="/finance" replace /> },
      { path: 'finance', element: <WorkspaceRoute feature="finance"><FinanceEntry /></WorkspaceRoute> },
      { path: 'staff', element: <WorkspaceRoute feature="staffDirectory"><StaffPage /></WorkspaceRoute> },
      { path: 'team-access', element: <TeamAccessEntry /> },
      { path: 'kb/questions', element: <QuestionsPage /> },
      { path: 'kb/s/:id', element: <SectionPage /> },
      { path: 'kb/manage', element: <WorkspaceRoute feature="knowledgeEdit"><KbManagePage /></WorkspaceRoute> },
      { path: 'royalty/:id', element: <WorkspaceRoute feature="royalty"><RoyaltyPartnerPage /></WorkspaceRoute> },
      { path: 'kb', element: <KbHomePage /> },
      { path: 'kb/articles/:id', element: <ArticlePage /> },
      { path: 'kb/articles/:id/edit', element: <WorkspaceRoute feature="knowledgeEdit"><ArticleEditPage /></WorkspaceRoute> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

function BootScreen() {
  return (
    <div className="boot-screen" role="status" aria-label="Загрузка">
      <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" />
      <div className="boot-bar"><span /></div>
      <a href={`${import.meta.env.BASE_URL}help.html`} style={{color:'#8798cf',fontSize:14}}>Помощь при сбое</a>
    </div>
  );
}

function Home() {
  const session = useSession();
  const role = workspaceRole(session);
  const network = workspaceAccess(role, session.can).network;
  const pages = { manager: network ? <NetworkPage /> : <>
    <PageHeader title="Главная" />
    <EmptyState title="Откройте нужный раздел" text="В меню показаны доступные вам разделы кабинета." />
  </>, support: <QuestionsPage home />, staff: <StaffHome />,
    team: <TeamHome />, franchisee: <FranchiseeHome />, pending: null };
  return pages[role];
}

function UnavailableRoute() {
  return <Navigate to="/" replace state={{ missingAccess: true }} />;
}

function WorkspaceRoute({ feature, children }: { feature: keyof ReturnType<typeof workspaceAccess>; children: ReactNode }) {
  const session = useSession();
  return workspaceAccess(workspaceRole(session), session.can)[feature] ? children : <UnavailableRoute />;
}

function LearningEntry() {
  const session = useSession();
  const access = workspaceAccess(workspaceRole(session), session.can);
  if (access.learning) return <LearningPage />;
  return access.learningManage ? <Navigate to="/learning/manage" replace /> : <UnavailableRoute />;
}

function FinanceEntry() {
  return workspaceRole(useSession()) === 'manager' ? <SupplyFinancePage /> : <FinancePage />;
}

function TeamAccessEntry() {
  const session = useSession();
  const owner = workspaceRole(session) === 'franchisee';
  return owner && (ownedTeamPartner(session.me) || franchiseePartnerCards(session.me).length > 1)
    ? <TeamAccessPage /> : <UnavailableRoute />;
}

function Guard() {
  const { status, me } = useSession();
  if (status === 'loading') return <BootScreen />;
  if (status === 'signed-out') return <Navigate to="/login" replace />;
  return <Shell key={me?.user.id} />;
}

export function App() {
  if (!isConfigured) return <SetupPage />;
  return (
    <QueryClientProvider client={qc}>
      <SessionProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
