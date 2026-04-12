import { useState, useEffect } from 'react';
import { api } from '../lib/api.ts';
import type { Task, Agent, Decision, Spec, Activity, ProjectInfo } from '../lib/types.ts';

export function useFlightdeck() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);

  useEffect(() => {
    Promise.all([
      api.getProject(),
      api.getTasks(),
      api.getAgents(),
      api.getDecisions(),
      api.getSpecs(),
      api.getActivities(),
    ]).then(([p, t, a, d, s, act]) => {
      setProject(p);
      setTasks(t);
      setAgents(a);
      setDecisions(d);
      setSpecs(s);
      setActivities(act);
    });
  }, []);

  return { project, tasks, agents, decisions, specs, activities };
}
