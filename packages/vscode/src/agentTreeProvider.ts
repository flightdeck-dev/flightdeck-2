import * as vscode from "vscode";
import { FlightdeckClient, FlightdeckAgent } from "./flightdeckClient";

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  idle: { icon: "person", color: "charts.blue" },
  busy: { icon: "sync~spin", color: "charts.orange" },
  working: { icon: "sync~spin", color: "charts.orange" },
  error: { icon: "error", color: "charts.red" },
  terminated: { icon: "circle-slash", color: "disabledForeground" },
};

const ROLE_ICONS: Record<string, string> = {
  architect: "symbol-structure",
  frontend: "browser",
  backend: "server",
  reviewer: "checklist",
  devops: "gear",
  lead: "megaphone",
  worker: "tools",
};

export class AgentItem extends vscode.TreeItem {
  constructor(public readonly agent: FlightdeckAgent) {
    super(agent.role, vscode.TreeItemCollapsibleState.None);
    this.description = `${agent.model} · ${agent.status}${agent.currentTask ? ` · ${agent.currentTask}` : ""}`;
    this.tooltip = new vscode.MarkdownString(
      `**${agent.role}** (${agent.id})\n\n` +
      `- **Model:** ${agent.model}\n` +
      `- **Status:** ${agent.status}\n` +
      (agent.currentTask ? `- **Task:** ${agent.currentTask}\n` : "")
    );
    const roleIcon = ROLE_ICONS[agent.role] || "person";
    const statusInfo = STATUS_ICONS[agent.status] || STATUS_ICONS["idle"];
    // Use role icon with status color
    this.iconPath = new vscode.ThemeIcon(roleIcon, new vscode.ThemeColor(statusInfo.color));
    this.contextValue = "agent";
  }
}

export class AgentTreeProvider implements vscode.TreeDataProvider<AgentItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private agents: FlightdeckAgent[] = [];

  constructor(private client: FlightdeckClient) {}

  refresh(): void {
    this.client.getAgents().then((agents) => {
      this.agents = agents;
      this._onDidChangeTreeData.fire();
    });
  }

  getTreeItem(el: AgentItem): vscode.TreeItem {
    return el;
  }

  getChildren(): AgentItem[] {
    return this.agents.map((a) => new AgentItem(a));
  }

  getAgentById(id: string): FlightdeckAgent | undefined {
    return this.agents.find((a) => a.id === id);
  }
}
