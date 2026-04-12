import { describe, it, expect } from 'vitest';
import { generateAgentConfigs } from '../../src/agents/AgentConfigs.js';

describe('AgentConfigs', () => {
  it('generates worker AGENTS.md with correct role', () => {
    const configs = generateAgentConfigs('worker');
    expect(configs.agentsMd).toContain('Worker Agent');
    expect(configs.agentsMd).toContain('flightdeck_task_submit');
    expect(configs.agentsMd).not.toContain('You coordinate');
  });

  it('generates lead AGENTS.md that forbids coding', () => {
    const configs = generateAgentConfigs('lead');
    expect(configs.agentsMd).toContain('Lead Agent');
    expect(configs.agentsMd).toContain('Never write code');
    expect(configs.agentsMd).not.toContain('flightdeck_task_submit');
  });

  it('generates reviewer AGENTS.md focused on claim verification', () => {
    const configs = generateAgentConfigs('reviewer');
    expect(configs.agentsMd).toContain('Reviewer Agent');
    expect(configs.agentsMd).toContain('claim');
    expect(configs.agentsMd).toContain('flightdeck_task_approve');
  });

  it('generates planner AGENTS.md focused on planning', () => {
    const configs = generateAgentConfigs('planner');
    expect(configs.agentsMd).toContain('Planner Agent');
    expect(configs.agentsMd).toContain('flightdeck_task_add');
    expect(configs.agentsMd).not.toContain('flightdeck_task_submit');
  });

  it('generates valid .mcp.json', () => {
    const configs = generateAgentConfigs('worker');
    const parsed = JSON.parse(configs.mcpJson);
    expect(parsed.mcpServers.flightdeck.command).toBe('npx');
    expect(parsed.mcpServers.flightdeck.args).toContain('flightdeck-mcp');
  });

  it('generates codex config snippet', () => {
    const configs = generateAgentConfigs('worker');
    expect(configs.codexConfig).toContain('[mcp_servers.flightdeck]');
  });

  it('produces different content per role', () => {
    const worker = generateAgentConfigs('worker');
    const lead = generateAgentConfigs('lead');
    const reviewer = generateAgentConfigs('reviewer');
    const planner = generateAgentConfigs('planner');
    const set = new Set([worker.agentsMd, lead.agentsMd, reviewer.agentsMd, planner.agentsMd]);
    expect(set.size).toBe(4);
  });
});
