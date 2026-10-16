import { lazy, Suspense, type ComponentType } from 'react';
import { createHashRouter, Navigate, RouterProvider, useRouteError } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isConfigured } from '../platform/config';
import { SessionProvider, useSession } from '../platform/session';
import { toAppError } from '../platform/backend';
import { ToastProvider } from '../ui/toast';
import { ErrorState, Skeleton } from '../ui';
import { Shell } from './Shell';
import { LoginPage, SetupPage } from './LoginPage';
import { TodayPage } from '../modules/today/TodayPage';

// Модули загружаются по требованию: первый экран не тянет код роялти, редактора статей и т. п. (NFR-01, LCP)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;
function page<M extends Record<string, unknown>>(loader: () => Promise<M>, name: keyof M & string) {
  const C = lazy(() => loader().then((m) => ({ default: m[name] as AnyComponent })));
  return function LazyPage(props: Record<string, unknown>) {
    return <Suspense fallback={<Skeleton lines={5} />}><C {...props} /></Suspense>;
  };
}
const tasks = () => import('../modules/tasks/TasksPages');
const org = () => import('../modules/org/OrgPages');
const roy = () => import('../modules/royalties/RoyaltyPages');
const kb = () => import('../modules/knowledge/KnowledgePages');
const TasksPage = page(tasks, 'TasksPage');
const TaskPage = page(tasks, 'TaskPage');
const PartnersPage = page(org, 'PartnersPage');
const PartnerPage = page(org, 'PartnerPage');
const RoyaltiesPage = page(roy, 'RoyaltiesPage');
const ReportPage = page(roy, 'ReportPage');
const AccrualPage = page(roy, 'AccrualPage');
const PaymentPage = page(roy, 'PaymentPage');
const KbHomePage = page(kb, 'KbHomePage');
const ArticlePage = page(kb, 'ArticlePage');
const ArticleEditPage = page(kb, 'ArticleEditPage');
const ArticleReviewPage = page(kb, 'ArticleReviewPage');
const LearningPage = page(kb, 'LearningPage');
const SalesPage = page(() => import('../modules/sales/SalesPages'), 'SalesPage');
const NetworkSalesPage = page(() => import('../modules/sales/NetworkSalesPage'), 'NetworkSalesPage');
const MyRolePage = page(() => import('../modules/knowledge/MyRolePage'), 'MyRolePage');
const posMod = () => import('../modules/pos/PosPages');
const PosPage = page(posMod, 'PosPage');
const ClientPage = page(posMod, 'ClientPage');
const ControlPage = page(() => import('../modules/sales/ControlPage'), 'ControlPage');
const OverviewPage = page(() => import('../modules/metrics/OverviewPage'), 'OverviewPage');
const SettingsPage = page(() => import('../modules/settings/SettingsPage'), 'SettingsPage');
const NotificationsPage = page(() => import('../modules/notifications/NotificationsPage'), 'NotificationsPage');

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
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
  {
    path: '/',
    element: <Guard />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <TodayPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'tasks/:id', element: <TaskPage /> },
      { path: 'partners', element: <PartnersPage /> },
      { path: 'partners/:id', element: <PartnerPage /> },
      { path: 'sales', element: <SalesPage /> },
      { path: 'control', element: <ControlPage /> },
      { path: 'pos', element: <PosPage /> },
      { path: 'my-role', element: <MyRolePage /> },
      { path: 'pos/clients/:id', element: <ClientPage /> },
      { path: 'network-sales', element: <NetworkSalesPage /> },
      { path: 'royalties', element: <RoyaltiesPage /> },
      { path: 'royalties/reports/:id', element: <ReportPage /> },
      { path: 'royalties/accruals', element: <RoyaltiesPage initialTab="accruals" /> },
      { path: 'royalties/accruals/:id', element: <AccrualPage /> },
      { path: 'royalties/payments/:id', element: <PaymentPage /> },
      { path: 'kb', element: <KbHomePage /> },
      { path: 'kb/articles/:id', element: <ArticlePage /> },
      { path: 'kb/articles/:id/edit', element: <ArticleEditPage /> },
      { path: 'kb/articles/:id/review', element: <ArticleReviewPage /> },
      { path: 'learning', element: <LearningPage /> },
      { path: 'overview', element: <OverviewPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/:tab', element: <SettingsPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

function BootScreen() {
  return (
    <div className="boot-screen" role="status" aria-label="Загрузка">
      <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" />
      <div className="boot-bar"><span /></div>
    </div>
  );
}

function Guard() {
  const { status } = useSession();
  if (status === 'loading') return <BootScreen />;
  if (status === 'signed-out') return <Navigate to="/login" replace />;
  return <Shell />;
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
