import * as vscode from "vscode";
import { FlightdeckClient, FlightdeckAgent } from "./flightdeckClient";

class AgentItem extends vscode.TreeItem {
  constructor(public readonly agent: FlightdeckAgent) {
    super(agent.role, vscode.TreeItemCollapsibleState.None);
    this.description = `${agent.model} · ${agent.status}`;
    this.tooltip = `ID: ${agent.id}\nRole: ${agent.role}\nModel: ${agent.model}\nStatus: ${agent.status}`;
    this.iconPath = new vscode.ThemeIcon(
      agent.status === "working"
        ? "sync~spin"
        : agent.status === "error"
          ? "error"
          : "person"
    );
    this.contextValue = "agent";
  }
}

export class AgentTreeProvider
  implements vscode.TreeDataProvider<AgentItem>
{
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
