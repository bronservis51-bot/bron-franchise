import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createHashRouter, Navigate, RouterProvider, useRouteError } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isConfigured } from '../platform/config';
import { SessionProvider, useSession } from '../platform/session';
import { toAppError } from '../platform/backend';
import { ToastProvider } from '../ui/toast';
import { ErrorState, Skeleton } from '../ui';
import { Shell } from './Shell';
import { LoginPage, SetupPage } from './LoginPage';
import { FranchiseeHome } from '../modules/revenue/FranchiseeHome';

// Экраны менеджера и редактор статей загружаются по требованию: франчайзи их код не скачивает
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;
function page<M extends Record<string, unknown>>(loader: () => Promise<M>, name: keyof M & string) {
  const C = lazy(() => loader().then((m) => ({ default: m[name] as AnyComponent })));
  return function LazyPage(props: Record<string, unknown>) {
    return <Suspense fallback={<Skeleton lines={5} />}><C {...props} /></Suspense>;
  };
}
const kb = () => import('../modules/knowledge/KnowledgePages');
const kbView = () => import('../modules/knowledge/KbBrowse');
const KbHomePage = page(kbView, 'KbHomePage');
const ArticlePage = page(kbView, 'ArticlePage');
const SectionPage = page(kbView, 'SectionPage');
const KbManagePage = page(kbView, 'KbManagePage');
const ArticleEditPage = page(kb, 'ArticleEditPage');
const SupplyFinancePage = page(() => import('../modules/manager/SupplyFinancePage'), 'SupplyFinancePage');
const NetworkPage = page(() => import('../modules/manager/NetworkPage'), 'NetworkPage');
const PartnerPage = page(() => import('../modules/manager/PartnerPage'), 'PartnerPage');
const RoyaltyPage = page(() => import('../modules/manager/RoyaltyPage'), 'RoyaltyPage');
const RoyaltyPartnerPage = page(() => import('../modules/manager/RoyaltyPartnerPage'), 'RoyaltyPartnerPage');
const StaffHome = page(() => import('../modules/staff/StaffHome'), 'StaffHome');
const StaffPage = page(() => import('../modules/staff/StaffPage'), 'StaffPage');
const RatingPage = page(() => import('../modules/rating/RatingPage'), 'RatingPage');
const FinancePage = page(() => import('../modules/finance/FinancePage'), 'FinancePage');
const QuestionsPage = page(kb, 'QuestionsPage');
const LeadsPage = page(() => import('../modules/leads/LeadsPage'), 'LeadsPage');

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
      { index: true, element: <Home /> },
      { path: 'partners/:id', element: <ManagerOnly><PartnerPage /></ManagerOnly> },
      { path: 'leads', element: <ManagerOnly><LeadsPage /></ManagerOnly> },
      { path: 'royalty', element: <ByRole manager={<RoyaltyPage />} franchisee={<Navigate to="/finance" replace />} /> },
      { path: 'finance', element: <ByRole manager={<SupplyFinancePage />} franchisee={<FinancePage />} /> },
      { path: 'staff', element: <ByRole franchisee={<StaffPage />} /> },
      { path: 'rating', element: <ByRole manager={<RatingPage />} franchisee={<RatingOnly><RatingPage /></RatingOnly>} /> },
      { path: 'kb/questions', element: <QuestionsPage /> },
      { path: 'kb/s/:id', element: <SectionPage /> },
      { path: 'kb/manage', element: <KbManagePage /> },
      { path: 'royalty/:id', element: <ManagerOnly><RoyaltyPartnerPage /></ManagerOnly> },
      { path: 'kb', element: <KbHomePage /> },
      { path: 'kb/articles/:id', element: <ArticlePage /> },
      { path: 'kb/articles/:id/edit', element: <ArticleEditPage /> },
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

function Home() {
  const { isManager, isStaff } = useSession();
  return isManager ? <NetworkPage /> : isStaff ? <StaffHome /> : <FranchiseeHome />;
}

/** Один адрес — разные экраны по роли; сотруднику недоступные разделы не открываются. */
function ByRole({ manager, franchisee }: { manager?: ReactNode; franchisee?: ReactNode }) {
  const { isManager, isStaff } = useSession();
  const el = isManager ? manager : isStaff ? null : franchisee;
  return el ? <>{el}</> : <Navigate to="/" replace />;
}

/** Рейтинг — только франчайзи в России (у иностранных нет разрешения rating.read). */
function RatingOnly({ children }: { children: ReactNode }) {
  const { can } = useSession();
  return can('rating.read') ? <>{children}</> : <Navigate to="/" replace />;
}

function ManagerOnly({ children }: { children: ReactNode }) {
  const { isManager } = useSession();
  return isManager ? <>{children}</> : <Navigate to="/" replace />;
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
