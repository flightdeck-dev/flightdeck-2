import * as vscode from 'vscode';
import http from 'node:http';

// ─── API Client ──────────────────────────────────────────────────────────────

function getServerUrl(): string {
  return vscode.workspace.getConfiguration('flightdeck').get<string>('serverUrl') || 'http://localhost:4600';
}

function getPollInterval(): number {
  return (vscode.workspace.getConfiguration('flightdeck').get<number>('pollInterval') || 30) * 1000;
}

function apiRequest(method: string, path: string, body?: any): Promise<any> {
  const url = new URL(path, getServerUrl());
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from server: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const api = {
  status: () => apiRequest('GET', '/api/status'),
  specs: () => apiRequest('GET', '/api/specs'),
  specDetail: (id: string) => apiRequest('GET', `/api/specs/${id}`),
  tasks: (specId?: string) => apiRequest('GET', specId ? `/api/tasks?spec=${specId}` : '/api/tasks'),
  createSpec: (title: string, content: string) => apiRequest('POST', '/api/specs', { title, content }),
  createTask: (data: any) => apiRequest('POST', '/api/tasks', data),
  patchTask: (id: string, action: string, extra?: any) => apiRequest('PATCH', `/api/tasks/${id}`, { action, ...extra }),
  agents: () => apiRequest('GET', '/api/agents'),
};

// ─── Tree Data Providers ─────────────────────────────────────────────────────

interface FlightdeckStatus {
  project: string;
  specs: number;
  tasks: { total: number; done: number; in_progress: number; blocked: number; ready: number; pending: number };
  agents: number;
}

class OverviewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private status: FlightdeckStatus | null = null;
  private error: string | null = null;

  refresh(): void { this._onDidChangeTreeData.fire(); }

  async fetchAndRefresh(): Promise<void> {
    try {
      this.status = await api.status();
      this.error = null;
    } catch (e: any) {
      this.error = e.message;
      this.status = null;
    }
    this.refresh();
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    if (this.error) {
      const item = new vscode.TreeItem(`⚠️ ${this.error}`);
      item.tooltip = 'Could not connect to Flightdeck server';
      return [item];
    }
    if (!this.status) {
      await this.fetchAndRefresh();
      if (!this.status) return [new vscode.TreeItem('Loading...')];
    }
    const s = this.status;
    const t = s.tasks;
    return [
      new vscode.TreeItem(`📋 Project: ${s.project}`),
      new vscode.TreeItem(`✅ Done: ${t.done}/${t.total}`),
      new vscode.TreeItem(`🔄 In Progress: ${t.in_progress}`),
      new vscode.TreeItem(`⏳ Ready: ${t.ready}`),
      new vscode.TreeItem(`🚫 Blocked: ${t.blocked}`),
      new vscode.TreeItem(`📑 Specs: ${s.specs}`),
      new vscode.TreeItem(`🤖 Agents: ${s.agents}`),
    ];
  }
}

interface SpecData { id: string; title: string; state: string; tasks?: TaskData[]; }
interface TaskData { id: string; title: string; state: string; role?: string; specId?: string; assignedAgent?: string; description?: string; claim?: string; reviewerFeedback?: string; }

class SpecItem extends vscode.TreeItem {
  constructor(public readonly spec: SpecData) {
    super(spec.title, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'spec';
    this.description = spec.state;
    this.iconPath = new vscode.ThemeIcon(spec.state === 'done' ? 'pass' : spec.state === 'active' ? 'play' : 'circle-outline');
  }
}

class TaskItem extends vscode.TreeItem {
  constructor(public readonly task: TaskData) {
    super(task.title, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'task';
    this.description = `${task.state}${task.role ? ` (${task.role})` : ''}`;
    const iconMap: Record<string, string> = {
      done: 'pass', in_progress: 'play', ready: 'circle-outline',
      blocked: 'error', submitted: 'eye', failed: 'close', pending: 'circle-outline',
    };
    this.iconPath = new vscode.ThemeIcon(iconMap[task.state] || 'question');
    this.command = { command: 'flightdeck.openTask', title: 'Open Task', arguments: [task] };
  }
}

class SpecsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private specs: SpecData[] = [];

  refresh(): void { this._onDidChangeTreeData.fire(); }

  async fetchAndRefresh(): Promise<void> {
    try { this.specs = await api.specs(); } catch { this.specs = []; }
    this.refresh();
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!el) {
      if (this.specs.length === 0) await this.fetchAndRefresh();
      if (this.specs.length === 0) return [new vscode.TreeItem('No specs')];
      return this.specs.map(s => new SpecItem(s));
    }
    if (el instanceof SpecItem) {
      try {
        const detail = await api.specDetail(el.spec.id);
        return (detail.tasks || []).map((t: TaskData) => new TaskItem(t));
      } catch {
        return [new vscode.TreeItem('Failed to load tasks')];
      }
    }
    return [];
  }
}

class AgentItem extends vscode.TreeItem {
  constructor(agent: { id: string; name: string; role: string; status: string }) {
    super(agent.name || agent.id, vscode.TreeItemCollapsibleState.None);
    this.description = `${agent.role} · ${agent.status}`;
    const iconMap: Record<string, string> = {
      idle: 'circle-outline', busy: 'play', offline: 'close', error: 'error',
    };
    this.iconPath = new vscode.ThemeIcon(iconMap[agent.status] || 'circle-outline');
  }
}

class AgentsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    try {
      const agents = await api.agents();
      if (agents.length === 0) return [new vscode.TreeItem('No agents')];
      return agents.map((a: any) => new AgentItem(a));
    } catch {
      return [new vscode.TreeItem('⚠️ Cannot reach server')];
    }
  }
}

// ─── Task Detail Webview ─────────────────────────────────────────────────────

function openTaskWebview(context: vscode.ExtensionContext, task: TaskData): void {
  const panel = vscode.window.createWebviewPanel('flightdeck.task', `Task: ${task.title}`, vscode.ViewColumn.One, { enableScripts: true });

  function render(t: TaskData): string {
    const stateColors: Record<string, string> = {
      done: '#4caf50', in_progress: '#2196f3', ready: '#ff9800',
      blocked: '#f44336', submitted: '#9c27b0', failed: '#f44336', pending: '#757575',
    };
    const color = stateColors[t.state] || '#757575';

    return `<!DOCTYPE html>
<html><head><style>
  body { font-family: var(--vscode-font-family, -apple-system, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.85em; font-weight: 600; color: #fff; background: ${color}; }
  .field { margin: 12px 0; }
  .field label { font-weight: 600; display: block; margin-bottom: 2px; opacity: 0.8; font-size: 0.9em; }
  .field p { margin: 0; white-space: pre-wrap; }
  .actions { margin-top: 20px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { padding: 6px 16px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; font-size: 0.9em; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style></head><body>
  <h1>${escapeHtml(t.title)}</h1>
  <span class="badge">${t.state}</span>
  ${t.role ? `<div class="field"><label>Role</label><p>${escapeHtml(t.role)}</p></div>` : ''}
  ${t.description ? `<div class="field"><label>Description</label><p>${escapeHtml(t.description)}</p></div>` : ''}
  ${t.assignedAgent ? `<div class="field"><label>Assigned Agent</label><p>${escapeHtml(t.assignedAgent)}</p></div>` : ''}
  ${t.claim ? `<div class="field"><label>Claim</label><p>${escapeHtml(t.claim)}</p></div>` : ''}
  ${t.reviewerFeedback ? `<div class="field"><label>Reviewer Feedback</label><p>${escapeHtml(t.reviewerFeedback)}</p></div>` : ''}
  <div class="actions">
    ${t.state === 'ready' ? '<button onclick="act(\'claim\')">Claim</button>' : ''}
    ${t.state === 'in_progress' ? '<button onclick="act(\'submit\')">Submit</button><button class="secondary" onclick="act(\'fail\')">Fail</button>' : ''}
    ${['ready', 'in_progress', 'blocked'].includes(t.state) ? '<button class="secondary" onclick="act(\'escalate\')">Escalate</button>' : ''}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function act(action) { vscode.postMessage({ action, taskId: '${t.id}' }); }
  </script>
</body></html>`;
  }

  panel.webview.html = render(task);

  panel.webview.onDidReceiveMessage(async (msg: { action: string; taskId: string }) => {
    try {
      if (msg.action === 'escalate') {
        vscode.window.showInformationMessage(`Task ${msg.taskId} escalated (not yet implemented in API)`);
        return;
      }
      const extra: any = {};
      if (msg.action === 'submit') {
        const claim = await vscode.window.showInputBox({ prompt: 'What did you accomplish?', placeHolder: 'Describe what was done...' });
        if (!claim) return;
        extra.claim = claim;
      }
      const updated = await api.patchTask(msg.taskId, msg.action, extra);
      panel.webview.html = render(updated);
      vscode.window.showInformationMessage(`Task ${msg.action} successful`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Action failed: ${e.message}`);
    }
  }, undefined, context.subscriptions);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Extension Activation ────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const overviewProvider = new OverviewProvider();
  const specsProvider = new SpecsProvider();
  const agentsProvider = new AgentsProvider();

  vscode.window.registerTreeDataProvider('flightdeck.overview', overviewProvider);
  vscode.window.registerTreeDataProvider('flightdeck.specs', specsProvider);
  vscode.window.registerTreeDataProvider('flightdeck.agents', agentsProvider);

  // Status bar
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = 'workbench.view.extension.flightdeck';
  statusBarItem.text = '✈️ Flightdeck';
  statusBarItem.tooltip = 'Open Flightdeck panel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  async function updateStatusBar(): Promise<void> {
    try {
      const s = await api.status();
      statusBarItem.text = `✈️ Flightdeck: ${s.tasks.done}/${s.tasks.total} tasks done`;
    } catch {
      statusBarItem.text = '✈️ Flightdeck (offline)';
    }
  }

  // Refresh all
  async function refreshAll(): Promise<void> {
    await Promise.all([
      overviewProvider.fetchAndRefresh(),
      specsProvider.fetchAndRefresh(),
      agentsProvider.refresh(),
      updateStatusBar(),
    ]);
  }

  // Poll
  const interval = setInterval(refreshAll, getPollInterval());
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
  refreshAll();

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('flightdeck.refresh', refreshAll),

    vscode.commands.registerCommand('flightdeck.createSpec', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'Spec title', placeHolder: 'e.g., Add OAuth2 to the API' });
      if (!title) return;
      const content = await vscode.window.showInputBox({ prompt: 'Description (optional)', placeHolder: 'Brief description...' }) || '';
      try {
        await api.createSpec(title, content);
        vscode.window.showInformationMessage(`Spec "${title}" created`);
        refreshAll();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('flightdeck.createTask', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'Task title', placeHolder: 'e.g., Implement login endpoint' });
      if (!title) return;
      const role = await vscode.window.showInputBox({ prompt: 'Role (optional)', placeHolder: 'e.g., developer, reviewer' }) || undefined;
      try {
        await api.createTask({ title, role });
        vscode.window.showInformationMessage(`Task "${title}" created`);
        refreshAll();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('flightdeck.showStatus', async () => {
      const channel = vscode.window.createOutputChannel('Flightdeck');
      channel.show();
      try {
        const s = await api.status();
        channel.appendLine(`✈️ Flightdeck Status`);
        channel.appendLine(`───────────────────`);
        channel.appendLine(`Project: ${s.project}`);
        channel.appendLine(`Specs:   ${s.specs}`);
        channel.appendLine(`Agents:  ${s.agents}`);
        channel.appendLine(`Tasks:   ${s.tasks.done}/${s.tasks.total} done`);
        channel.appendLine(`  In Progress: ${s.tasks.in_progress}`);
        channel.appendLine(`  Ready:       ${s.tasks.ready}`);
        channel.appendLine(`  Blocked:     ${s.tasks.blocked}`);
        channel.appendLine(`  Pending:     ${s.tasks.pending}`);
      } catch (e: any) {
        channel.appendLine(`⚠️ Cannot reach server: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('flightdeck.openDashboard', () => {
      vscode.env.openExternal(vscode.Uri.parse(getServerUrl()));
    }),

    vscode.commands.registerCommand('flightdeck.initProject', () => {
      const terminal = vscode.window.createTerminal('Flightdeck Init');
      terminal.show();
      terminal.sendText('npx flightdeck init');
    }),

    vscode.commands.registerCommand('flightdeck.openTask', (task: TaskData) => {
      openTaskWebview(context, task);
    }),
  );
}

export function deactivate(): void {}
