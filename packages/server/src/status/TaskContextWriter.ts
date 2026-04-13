import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, Agent } from '@flightdeck-ai/shared';

/**
 * Writes per-task context files to `.flightdeck/tasks/{taskId}.md`.
 * These give agents quick context about individual tasks.
 */
export class TaskContextWriter {
  /**
   * Write a single task context file.
   */
  static writeTask(projectDir: string, task: Task, agents: Agent[]): void {
    const dir = join(projectDir, '.flightdeck', 'tasks');
    mkdirSync(dir, { recursive: true });
    const md = TaskContextWriter.generateMarkdown(task, agents);
    writeFileSync(join(dir, `${task.id}.md`), md);
  }

  /**
   * Write context files for all provided tasks.
   */
  static writeAll(projectDir: string, tasks: Task[], agents: Agent[]): void {
    if (tasks.length === 0) return;
    const dir = join(projectDir, '.flightdeck', 'tasks');
    mkdirSync(dir, { recursive: true });
    for (const task of tasks) {
      const md = TaskContextWriter.generateMarkdown(task, agents);
      writeFileSync(join(dir, `${task.id}.md`), md);
    }
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

    // Assigned agent
    if (task.assignedAgent) {
      const agent = agents.find(a => a.id === task.assignedAgent);
      lines.push(`**Assigned Agent:** ${task.assignedAgent}`);
      if (agent) {
        lines.push(`- Role: ${agent.role}`);
        lines.push(`- Status: ${agent.status}`);
      }
      lines.push('');
    }

    // Dependencies
    if (task.dependsOn.length > 0) {
      lines.push('## Dependencies');
      for (const dep of task.dependsOn) {
        lines.push(`- ${dep}`);
      }
      lines.push('');
    }

    // Description
    if (task.description) {
      lines.push('## Description');
      lines.push('');
      lines.push(task.description);
      lines.push('');
    }

    return lines.join('\n');
  }
}
