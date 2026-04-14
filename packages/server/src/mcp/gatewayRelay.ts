/**
 * Relay agent operations to the gateway HTTP server.
 * Used by MCP subprocess when AgentManager is not available locally.
 */
export class GatewayRelay {
  constructor(private baseUrl: string, private projectName: string) {}

  async spawnAgent(params: { role: string; model?: string; runtime?: string; task?: string; cwd?: string }): Promise<unknown> {
    console.log(`[relay] Spawning agent via gateway: role=${params.role}`);
    const res = await fetch(`${this.baseUrl}/api/projects/${this.projectName}/agents/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`Gateway spawn failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async terminateAgent(agentId: string): Promise<void> {
    console.log(`[relay] Terminating agent via gateway: ${agentId}`);
    const res = await fetch(`${this.baseUrl}/api/projects/${this.projectName}/agents/${agentId}/terminate`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`Gateway terminate failed: ${res.status} ${await res.text()}`);
  }

  async restartAgent(agentId: string): Promise<unknown> {
    console.log(`[relay] Restarting agent via gateway: ${agentId}`);
    const res = await fetch(`${this.baseUrl}/api/projects/${this.projectName}/agents/${agentId}/restart`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`Gateway restart failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async interruptAgent(agentId: string, message: string): Promise<void> {
    console.log(`[relay] Interrupting agent via gateway: ${agentId}`);
    const res = await fetch(`${this.baseUrl}/api/projects/${this.projectName}/agents/${agentId}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`Gateway interrupt failed: ${res.status} ${await res.text()}`);
  }

  async sendToAgent(agentId: string, message: string): Promise<void> {
    console.log(`[relay] Sending message to agent via gateway: ${agentId}`);
    const res = await fetch(`${this.baseUrl}/api/projects/${this.projectName}/agents/${agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`Gateway send failed: ${res.status} ${await res.text()}`);
  }

  async hibernateAgent(agentId: string): Promise<void> {
    console.log(`[relay] Hibernating agent via gateway: ${agentId}`);
    const res = await fetch(`${this.baseUrl}/api/projects/${this.projectName}/agents/${agentId}/hibernate`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`Gateway hibernate failed: ${res.status} ${await res.text()}`);
  }

  async wakeAgent(agentId: string): Promise<unknown> {
    console.log(`[relay] Waking agent via gateway: ${agentId}`);
    const res = await fetch(`${this.baseUrl}/api/projects/${this.projectName}/agents/${agentId}/wake`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`Gateway wake failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async retireAgent(agentId: string): Promise<void> {
    console.log(`[relay] Retiring agent via gateway: ${agentId}`);
    const res = await fetch(`${this.baseUrl}/api/projects/${this.projectName}/agents/${agentId}/retire`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`Gateway retire failed: ${res.status} ${await res.text()}`);
  }

  async searchSessions(query: string, limit = 20): Promise<{ count: number; results: unknown[] }> {
    const params = new URLSearchParams({ query, limit: String(limit) });
    const res = await fetch(`${this.baseUrl}/api/projects/${this.projectName}/search/sessions?${params}`);
    if (!res.ok) throw new Error(`Gateway session search failed: ${res.status}`);
    return res.json() as Promise<{ count: number; results: unknown[] }>;
  }
}
