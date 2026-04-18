import { createContext, useContext, useEffect, type ReactNode } from 'react';
import useSWR from 'swr';
import { api } from '../lib/api.ts';
import { useWsEventBus } from './useWsEventBus.tsx';
import { useProject } from './useProject.tsx';
import type { Task, Decision } from '../lib/types.ts';

export interface TaskContextValue {
  tasks: Task[];
  decisions: Decision[];
}

const TaskCtx = createContext<TaskContextValue | null>(null);

export function TaskProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useWsEventBus();
  const { projectName } = useProject();

  const { data: tasks = [], mutate: mutateTasks } = useSWR(
    projectName ? ['tasks', projectName] : null,
    () => api.getTasks(projectName!).catch(() => [] as Task[])
  );

  const { data: decisions = [], mutate: mutateDecisions } = useSWR(
    projectName ? ['decisions', projectName] : null,
    () => api.getDecisions(projectName!).catch(() => [] as Decision[])
  );

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === 'state:update') {
        mutateTasks();
        mutateDecisions();
      }
    });
  }, [subscribe, mutateTasks, mutateDecisions]);

  return (
    <TaskCtx.Provider value={{ tasks, decisions }}>
      {children}
    </TaskCtx.Provider>
  );
}

export function useTasks(): TaskContextValue {
  const ctx = useContext(TaskCtx);
  if (!ctx) throw new Error('useTasks must be inside TaskProvider');
  return ctx;
}
