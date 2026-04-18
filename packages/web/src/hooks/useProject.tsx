import { createContext, useContext, useEffect, type ReactNode } from 'react';
import useSWR from 'swr';
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
  const { subscribe, connected } = useWsEventBus();

  const { data: projects = [], mutate: mutateProjects } = useSWR('projects', () => api.getProjects());
  const { data: status = null, isLoading: statusLoading, mutate: mutateStatus } = useSWR(
    projectName ? ['status', projectName] : null,
    () => api.getStatus(projectName!)
  );

  const loading = projectName ? statusLoading : false;

  const fetchProjects = async () => { await mutateProjects(); };
  const refresh = () => { mutateProjects(); mutateStatus(); };

  // Listen for state:update to refetch projects/status
  useEffect(() => {
    return subscribe((event) => {
      if (event.type === 'state:update') {
        mutateProjects();
        mutateStatus();
      }
    });
  }, [subscribe, mutateProjects, mutateStatus]);

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
