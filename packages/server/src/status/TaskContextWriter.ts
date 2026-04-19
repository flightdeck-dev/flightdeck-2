import type { Task, Agent } from '@flightdeck-ai/shared';

/**
 * TaskContextWriter is now a no-op.
 * Task context is served via the `task_context` MCP tool instead of files.
 * Kept as a stub for API compatibility.
 */
export class TaskContextWriter {
  static writeTask(_projectDir: string, _task: Task, _agents: Agent[]): void {
    // no-op: task context is now served via MCP tool
  }

  static writeAll(_projectDir: string, _tasks: Task[], _agents: Agent[]): void {
    // no-op: task context is now served via MCP tool
  }

  static generateMarkdown(task: Task, agents: Agent[]): string {
    const lines: string[] = [];

    lines.push(`# ${task.title}`);
    lines.push('');
    lines.push(`**ID:** ${task.id}`);
    lines.push(`**State:** ${task.state}`);
    lines.push(`**Role:** ${task.role}`);
    lines.push(`**Priority:** ${task.priority}`);
    if (task.specId) lines.push(`**Spec:** ${task.specId}`);
    lines.push(`**Source:** ${task.source}`);
    lines.push(`**Created:** ${task.createdAt}`);
    lines.push(`**Updated:** ${task.updatedAt}`);
    lines.push('');

    if (task.assignedAgent) {
      const agent = agents.find(a => a.id === task.assignedAgent);
      lines.push(`**Assigned Agent:** ${task.assignedAgent}`);
      if (agent) {
        lines.push(`- Role: ${agent.role}`);
        lines.push(`- Status: ${agent.status}`);
      }
      lines.push('');
    }

    if (task.dependsOn.length > 0) {
      lines.push('## Dependencies');
      for (const dep of task.dependsOn) {
        lines.push(`- ${dep}`);
      }
      lines.push('');
    }

    if (task.description) {
      lines.push('## Description');
      lines.push('');
      lines.push(task.description);
      lines.push('');
    }

    return lines.join('\n');
  }
}
