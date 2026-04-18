import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const { subscribe } = useWsEventBus();
  const { projectName } = useProject();

  const fetchTasks = useCallback(async () => {
    if (!projectName) return;
    try {
      const [t, d] = await Promise.all([
        api.getTasks(projectName).catch(() => []),
        api.getDecisions(projectName).catch(() => []),
      ]);
      setTasks(t);
      setDecisions(d);
    } catch { /* ignore */ }
  }, [projectName]);

  useEffect(() => {
    setTasks([]);
    setDecisions([]);
    fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === 'state:update') {
        fetchTasks();
      }
    });
  }, [subscribe, fetchTasks]);

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
