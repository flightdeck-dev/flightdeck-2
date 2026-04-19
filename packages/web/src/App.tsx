import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useNavigate, Outlet } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Layout } from './components/Layout.tsx';
import { FlightdeckProviders } from './hooks/FlightdeckProviders.tsx';
import { useProject } from './hooks/useProject.tsx';
import { Rocket, Plus, AlertTriangle, FolderOpen, ChevronRight } from 'lucide-react';
import { Sidebar, CreateProjectModal } from './components/Sidebar.tsx';
import useSWR from 'swr';
import { api } from './lib/api.ts';
import type { ProjectSummary } from './lib/types.ts';

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
  const [showCreate, setShowCreate] = useState(false);
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
      <button
        onClick={() => setShowCreate(true)}
        style={{
          marginTop: 8,
          padding: '10px 24px',
          fontSize: 14,
          fontWeight: 500,
          color: 'white',
          backgroundColor: 'var(--color-accent, #6366f1)',
          border: 'none',
          borderRadius: 8,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Plus size={16} /> New Project
      </button>
      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} onCreated={() => window.location.reload()} />}
    </div>
  );
}

function RootRedirectInner() {
  const { projects, loading } = useProject();

  if (loading) return <PageFallback />;
  if (projects.length === 0) return <EmptyState />;
  return <GlobalOverview projects={projects} />;
}

function GlobalOverview({ projects }: { projects: ProjectSummary[] }) {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  // Fetch escalations for all projects
  const { data: allEscalations } = useSWR(
    projects.length > 0 ? ['all-escalations', projects.map(p => p.name)] : null,
    async () => {
      const results = await Promise.all(
        projects.map(async (p) => {
          try {
            const escalations = await api.getEscalations(p.name, 'pending');
            return escalations.map((e: any) => ({ ...e, projectName: p.name }));
          } catch {
            return [];
          }
        })
      );
      return results.flat();
    },
    { refreshInterval: 10000 }
  );

  const escalations = allEscalations ?? [];

  const priorityIcon = (priority: string) => {
    switch (priority) {
      case 'critical': return <AlertTriangle size={14} className="text-red-500" />;
      case 'high': return <AlertTriangle size={14} className="text-orange-500" />;
      default: return <AlertTriangle size={14} className="text-yellow-500" />;
    }
  };

  const handleResolve = async (projectName: string, id: number, resolution: string) => {
    try {
      await api.resolveEscalation(projectName, id, resolution);
      const { mutate } = await import('swr');
      mutate((key: unknown) => Array.isArray(key) && key[0] === 'all-escalations');
    } catch {}
  };

  const governanceBadgeColor = (gov: string) => {
    switch (gov) {
      case 'autonomous': return 'bg-green-500/15 text-green-400';
      case 'supervised': return 'bg-yellow-500/15 text-yellow-400';
      case 'collaborative': return 'bg-blue-500/15 text-blue-400';
      default: return 'bg-gray-500/15 text-gray-400';
    }
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      {/* Escalations Section */}
      {escalations.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={18} className="text-red-500" />
            Needs Attention
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>({escalations.length})</span>
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {escalations.map((esc: any) => (
              <div key={`${esc.projectName}-${esc.id}`}
                style={{
                  padding: '12px 16px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border)',
                  backgroundColor: 'var(--color-surface-secondary)',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  {priorityIcon(esc.priority)}
                  <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)' }}>{esc.title}</span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                    — from {esc.agentId} in {esc.projectName}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 'auto' }}>
                    {new Date(esc.createdAt).toLocaleString()}
                  </span>
                </div>
                {esc.description && (
                  <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '4px 0 8px 22px' }}>{esc.description}</p>
                )}
                <div style={{ display: 'flex', gap: 8, marginLeft: 22 }}>
                  <button
                    onClick={() => handleResolve(esc.projectName, esc.id, 'acknowledged')}
                    style={{
                      fontSize: 12, padding: '4px 12px', borderRadius: 6,
                      border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text-secondary)', cursor: 'pointer',
                    }}
                  >Respond</button>
                  <button
                    onClick={() => handleResolve(esc.projectName, esc.id, 'dismissed')}
                    style={{
                      fontSize: 12, padding: '4px 12px', borderRadius: 6,
                      border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text-tertiary)', cursor: 'pointer',
                    }}
                  >Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Projects Section */}
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FolderOpen size={18} style={{ color: 'var(--color-text-tertiary)' }} />
          Projects
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>({projects.length})</span>
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {projects.map((p) => (
            <div
              key={p.name}
              onClick={() => navigate(`/${encodeURIComponent(p.name)}`)}
              style={{
                padding: 16, borderRadius: 10,
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-surface-secondary)',
                cursor: 'pointer',
                transition: 'border-color 0.15s, background-color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-accent, #6366f1)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>{p.name}</span>
                <ChevronRight size={16} style={{ color: 'var(--color-text-tertiary)' }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className={`${governanceBadgeColor(p.governance)} text-xs px-2 py-0.5 rounded-full`}>
                  {p.governance}
                </span>
                <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                  {p.agentCount} agent{p.agentCount !== 1 ? 's' : ''}
                </span>
              </div>
              {p.taskStats && (
                <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  <span>{p.taskStats.ready ?? 0} ready</span>
                  <span>{p.taskStats.running ?? 0} running</span>
                  <span>{p.taskStats.done ?? 0} done</span>
                </div>
              )}
            </div>
          ))}

          {/* New Project Card */}
          <div
            onClick={() => setShowCreate(true)}
            style={{
              padding: 16, borderRadius: 10,
              border: '2px dashed var(--color-border)',
              backgroundColor: 'transparent',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 8, minHeight: 100,
              color: 'var(--color-text-tertiary)',
              transition: 'border-color 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-accent, #6366f1)'; e.currentTarget.style.color = 'var(--color-accent, #6366f1)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
          >
            <Plus size={20} />
            <span style={{ fontSize: 14, fontWeight: 500 }}>New Project</span>
          </div>
        </div>
      </section>

      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} onCreated={() => window.location.reload()} />}
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
