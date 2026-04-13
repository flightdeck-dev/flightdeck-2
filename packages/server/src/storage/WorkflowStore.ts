/**
 * WorkflowStore — reads/writes workflow.json from the project directory.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { AgentRole } from '@flightdeck-ai/shared';

export interface PipelineStep {
  step: string;
  role?: AgentRole;
  run?: string;
  type?: 'discussion';
  participants?: string[];
  on_fail?: 'return_to_worker' | 'reject' | 'warn' | 'skip';
  require_different_agent?: boolean;
  output?: string;
}

export interface WorkflowConfig {
  task_pipeline: PipelineStep[];
  spec_pipeline: PipelineStep[];
  hooks: {
    on_task_submit?: Array<{ run: string; on_fail: string }>;
    on_spec_start?: Array<{ run: string }>;
  };
}

const DEFAULT_WORKFLOW: WorkflowConfig = {
  task_pipeline: [
    { step: 'implement', role: 'worker' },
    { step: 'review', role: 'reviewer' },
    { step: 'done' },
  ],
  spec_pipeline: [
    { step: 'plan', role: 'planner' },
    { step: 'execute' },
  ],
  hooks: {},
};

export class WorkflowStore {
  private filePath: string;
  private yamlPath: string;

  constructor(projectDir: string) {
    this.filePath = join(projectDir, 'workflow.json');
    this.yamlPath = join(projectDir, '.flightdeck', 'workflow.yaml');
  }

  load(): WorkflowConfig {
    // Prefer .flightdeck/workflow.yaml over workflow.json
    if (existsSync(this.yamlPath)) {
      try {
        const raw = readFileSync(this.yamlPath, 'utf-8');
        const parsed = YAML.parse(raw) as Partial<WorkflowConfig>;
        return {
          task_pipeline: parsed.task_pipeline ?? DEFAULT_WORKFLOW.task_pipeline,
          spec_pipeline: parsed.spec_pipeline ?? DEFAULT_WORKFLOW.spec_pipeline,
          hooks: parsed.hooks ?? {},
        };
      } catch {
        return { ...DEFAULT_WORKFLOW };
      }
    }
    if (!existsSync(this.filePath)) {
      return { ...DEFAULT_WORKFLOW };
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as WorkflowConfig;
    } catch {
      return { ...DEFAULT_WORKFLOW };
    }
  }

  save(config: WorkflowConfig): void {
    writeFileSync(this.filePath, JSON.stringify(config, null, 2));
  }

  exists(): boolean {
    return existsSync(this.filePath) || existsSync(this.yamlPath);
  }

  static defaultWorkflow(): WorkflowConfig {
    return { ...DEFAULT_WORKFLOW };
  }
}
