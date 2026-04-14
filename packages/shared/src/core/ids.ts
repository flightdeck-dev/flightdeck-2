import { createHash } from 'node:crypto';
import type { TaskId, SpecId, AgentId, ProjectId, DecisionId, MessageId } from './types.js';

function hashId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256')
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 6);
  return `${prefix}-${hash}`;
}

export function taskId(...parts: string[]): TaskId {
  return hashId('task', ...parts) as TaskId;
}

export function specId(...parts: string[]): SpecId {
  return hashId('spec', ...parts) as SpecId;
}

export function agentId(role: string, ...parts: string[]): AgentId {
  return hashId(role, ...parts) as AgentId;
}

export function projectId(...parts: string[]): ProjectId {
  return hashId('proj', ...parts) as ProjectId;
}

export function decisionId(...parts: string[]): DecisionId {
  return hashId('dec', ...parts) as DecisionId;
}

export function messageId(...parts: string[]): MessageId {
  return hashId('msg', ...parts) as MessageId;
}
