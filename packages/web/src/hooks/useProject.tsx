import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { useWsEventBus } from './useWsEventBus.tsx';
import type { ProjectStatus, ProjectSummary } from '../lib/types.ts';

export interface ProjectContextValue {
  projects: ProjectSummary[];
  projectName: string | null;
  status: ProjectStatus | null;
  connected: boolean;
  loading: boolean;
  fetchProjects: () => Promise<void>;
  refresh: () => void;
}

const ProjectCtx = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ projectName, children }: { projectName: string | null; children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const { subscribe, connected } = useWsEventBus();

  const fetchProjects = useCallback(async () => {
    try {
      const p = await api.getProjects();
      setProjects(p);
    } catch { /* ignore */ }
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!projectName) return;
    try {
      const s = await api.getStatus(projectName);
      if (s) setStatus(s);
    } catch { /* ignore */ }
  }, [projectName]);

  const refresh = useCallback(() => {
    fetchProjects();
    fetchStatus();
  }, [fetchProjects, fetchStatus]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  useEffect(() => {
    setLoading(true);
    setStatus(null);
    if (!projectName) { setLoading(false); return; }
    fetchStatus().then(() => setLoading(false));
  }, [projectName, fetchStatus]);

  // Listen for state:update to refetch projects/status
  useEffect(() => {
    return subscribe((event) => {
      if (event.type === 'state:update') {
        fetchProjects();
        fetchStatus();
      }
    });
  }, [subscribe, fetchProjects, fetchStatus]);

  return (
    <ProjectCtx.Provider value={{ projects, projectName, status, connected, loading, fetchProjects, refresh }}>
      {children}
    </ProjectCtx.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectCtx);
  if (!ctx) throw new Error('useProject must be inside ProjectProvider');
  return ctx;
}
