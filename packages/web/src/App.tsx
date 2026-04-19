import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useNavigate } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Layout } from './components/Layout.tsx';
import { FlightdeckProviders } from './hooks/FlightdeckProviders.tsx';
import { useProject } from './hooks/useProject.tsx';
import { Plus, FolderOpen, Rocket, ArrowRight } from 'lucide-react';

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
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  if (loading) return <PageFallback />;

  const nameRegex = /^[a-zA-Z0-9_-]+$/;

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Project name is required'); return; }
    if (!nameRegex.test(trimmed)) { setError('Only letters, numbers, dashes, and underscores'); return; }
    setError('');
    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `Failed (${res.status})`);
      }
      navigate(`/${encodeURIComponent(trimmed)}`);
    } catch (e: any) {
      setError(e.message ?? 'Failed to create project');
      setCreating(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--color-bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: '12vh',
    }}>
      {/* Branding */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 8 }}>
          <Rocket size={32} style={{ color: 'var(--color-accent, #6366f1)' }} />
          <h1 style={{ fontSize: 32, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>Flightdeck</h1>
        </div>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 14, margin: 0 }}>Multi-agent orchestration platform</p>
      </div>

      {/* Create project card */}
      <div style={{
        background: 'var(--color-bg-secondary, var(--color-bg-elevated, #1a1a2e))',
        border: '1px solid var(--color-border, #333)',
        borderRadius: 12,
        padding: 28,
        width: 420,
        maxWidth: '90vw',
        marginBottom: 32,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Plus size={18} style={{ color: 'var(--color-accent, #6366f1)' }} />
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>Create New Project</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="my-project"
            value={name}
            onChange={e => { setName(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--color-border, #333)',
              background: 'var(--color-bg, #0d0d1a)',
              color: 'var(--color-text-primary)',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <button
            onClick={handleCreate}
            disabled={creating}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--color-accent, #6366f1)',
              color: '#fff',
              fontWeight: 600,
              fontSize: 14,
              cursor: creating ? 'wait' : 'pointer',
              opacity: creating ? 0.6 : 1,
            }}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
        {error && <p style={{ color: 'var(--color-error, #ef4444)', fontSize: 13, marginTop: 8, marginBottom: 0 }}>{error}</p>}
      </div>

      {/* Existing projects */}
      {projects.length > 0 && (
        <div style={{
          background: 'var(--color-bg-secondary, var(--color-bg-elevated, #1a1a2e))',
          border: '1px solid var(--color-border, #333)',
          borderRadius: 12,
          padding: 28,
          width: 420,
          maxWidth: '90vw',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <FolderOpen size={18} style={{ color: 'var(--color-text-secondary)' }} />
            <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>Recent Projects</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {projects.map(p => (
              <a
                key={p.name}
                href={`/${encodeURIComponent(p.name)}`}
                onClick={e => { e.preventDefault(); navigate(`/${encodeURIComponent(p.name)}`); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: 8,
                  color: 'var(--color-text-primary)',
                  textDecoration: 'none',
                  fontSize: 14,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-bg-hover, rgba(255,255,255,0.05))')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span>{p.name}</span>
                <ArrowRight size={14} style={{ color: 'var(--color-text-secondary)' }} />
              </a>
            ))}
          </div>
        </div>
      )}
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
