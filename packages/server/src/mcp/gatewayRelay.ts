/**
 * Relay agent operations to the gateway HTTP server.
 * Used by MCP subprocess when AgentManager is not available locally.
 */
export class GatewayRelay {
  constructor(private baseUrl: string, private projectName: string) {}

  async spawnAgent(params: { role: string; model?: string; task?: string; cwd?: string }): Promise<unknown> {
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
}
