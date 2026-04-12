export type TaskState = 'ready' | 'running' | 'in_review' | 'done' | 'failed' | 'cancelled';
export type DecisionStatus = 'recorded' | 'confirmed' | 'rejected';

export interface Task {
  id: string;
  title: string;
  state: TaskState;
  role: string;
  assignedAgent?: string;
  priority: number;
  source: string;
  description: string;
  claim?: string;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  role: string;
  status: 'idle' | 'working' | 'terminated';
  model: string;
  cost: number;
  sessionStart: string;
  currentTask?: string;
}

export interface Decision {
  id: string;
  title: string;
  category: string;
  status: DecisionStatus;
  rationale: string;
  timestamp: string;
}

export interface Spec {
  id: string;
  name: string;
  path: string;
  content: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  taskId: string;
  taskTitle: string;
  from: TaskState | 'created';
  to: TaskState;
  agent?: string;
  timestamp: string;
}

export interface ProjectInfo {
  name: string;
  governance: string;
  totalCost: number;
}
