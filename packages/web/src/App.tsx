import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Layout } from './components/Layout.tsx';
import { FlightdeckProviders } from './hooks/FlightdeckProviders.tsx';
import { useProject } from './hooks/useProject.tsx';

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

/** Redirect root to first project's dashboard */
function RootRedirect() {
  return (
    <FlightdeckProviders projectName={null}>
      <RootRedirectInner />
    </FlightdeckProviders>
  );
}

function RootRedirectInner() {
  const { projects, loading } = useProject();
  if (loading) return <PageFallback />;
  if (projects.length > 0) {
    return <Navigate to={`/${encodeURIComponent(projects[0].name)}`} replace />;
  }
  return (
    <div className="h-screen flex items-center justify-center bg-[var(--color-bg)]">
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-semibold text-[var(--color-text-primary)]">Welcome to Flightdeck</h1>
        <p className="text-[var(--color-text-secondary)]">No projects found. Create your first project to get started.</p>
      </div>
    </div>
  );
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
