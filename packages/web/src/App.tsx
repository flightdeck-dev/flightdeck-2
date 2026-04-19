import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useNavigate, Outlet } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Layout } from './components/Layout.tsx';
import { FlightdeckProviders } from './hooks/FlightdeckProviders.tsx';
import { useProject } from './hooks/useProject.tsx';
import { Rocket } from 'lucide-react';
import { Sidebar } from './components/Sidebar.tsx';

const Dashboard = lazy(() => import('./pages/Dashboard.tsx'));
const Chat = lazy(() => import('./pages/Chat.tsx'));
const Tasks = lazy(() => import('./pages/Tasks.tsx'));
const Agents = lazy(() => import('./pages/Agents.tsx'));
const Specs = lazy(() => import('./pages/Specs.tsx'));
const Decisions = lazy(() => import('./pages/Decisions.tsx'));
const Cron = lazy(() => import('./pages/Cron.tsx'));
const Roles = lazy(() => import('./pages/Roles.tsx'));
const Settings = lazy(() => import('./pages/Settings.tsx'));
const Files = lazy(() => import('./pages/Files.tsx'));

function PageFallback() {
  return <div className="p-8 text-[var(--color-text-secondary)]">Loading...</div>;
}

/** Wrapper that extracts projectName from URL params and provides it to FlightdeckProviders */
function ProjectScope() {
  const { projectName } = useParams();
  return (
    <FlightdeckProviders projectName={projectName ?? null}>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="chat" element={<Chat />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="agents" element={<Agents />} />
            <Route path="specs" element={<Specs />} />
            <Route path="decisions" element={<Decisions />} />
            <Route path="cron" element={<Cron />} />
            <Route path="roles" element={<Roles />} />
            <Route path="files" element={<Files />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </Suspense>
    </FlightdeckProviders>
  );
}

/** Redirect root to first project's dashboard, or show empty state inside Layout */
function RootRedirect() {
  return (
    <FlightdeckProviders projectName={null}>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<RootRedirectInner />} />
          </Route>
        </Routes>
      </Suspense>
    </FlightdeckProviders>
  );
}

/** Empty state shown inside Layout when no projects exist */
function EmptyState() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: 16,
    }}>
      <Rocket size={48} style={{ color: 'var(--color-accent, #6366f1)', opacity: 0.7 }} />
      <h2 style={{ fontSize: 22, fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>Welcome to Flightdeck</h2>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 14, margin: 0, maxWidth: 360, textAlign: 'center' }}>
        Multi-agent orchestration platform. Create your first project to get started.
      </p>
      <p style={{ color: 'var(--color-text-tertiary)', fontSize: 12, margin: '8px 0 0' }}>
        Click <strong>+ New Project</strong> in the sidebar to begin.
      </p>
    </div>
  );
}

function RootRedirectInner() {
  const { projects, loading } = useProject();
  const navigate = useNavigate();

  if (loading) return <PageFallback />;

  // If projects exist, redirect to the first one
  if (projects.length > 0) {
    return <Navigate to={`/${encodeURIComponent(projects[0].name)}`} replace />;
  }

  // No projects: render Layout with sidebar + empty state
  return <EmptyState />;
}


function GlobalSettingsPage() {
  return (
    <FlightdeckProviders projectName={null}>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Settings />} />
          </Route>
        </Routes>
      </Suspense>
    </FlightdeckProviders>
  );
}

export function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <Routes>
        <Route index element={<RootRedirect />} />
        <Route path="settings/*" element={<GlobalSettingsPage />} />
        <Route path=":projectName/*" element={<ProjectScope />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  );
}
