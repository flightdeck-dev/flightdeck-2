import * as vscode from "vscode";
import { FlightdeckClient } from "./flightdeckClient";

export class StatusBar {
  private item: vscode.StatusBarItem;
  private client: FlightdeckClient;
  private timer?: ReturnType<typeof setInterval>;
  private disposables: vscode.Disposable[] = [];

  constructor(client: FlightdeckClient) {
    this.client = client;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "flightdeck.statusBarClick";
    this.item.text = "$(rocket) Flightdeck";
    this.item.tooltip = "Flightdeck — click for options";
    this.item.show();

    // Update when project changes
    this.disposables.push(
      client.onProjectChanged(() => this.update())
    );
  }

  startPolling(intervalMs = 10000): void {
    this.update();
    this.timer = setInterval(() => this.update(), intervalMs);
  }

  private async update(): Promise<void> {
    const project = this.client.project;
    if (!project) {
      this.item.text = "$(rocket) Flightdeck: no project";
      this.item.tooltip = "Click to select a project";
      return;
    }
    try {
      const status = await this.client.getStatus();
      const tasks = status.tasks || [];
      const agents = status.agents || [];
      const done = tasks.filter((t) => t.state === "done").length;
      const running = tasks.filter((t) => t.state === "running").length;
      const total = tasks.length;
      const activeAgents = agents.filter((a) => a.status === "busy" || a.status === "idle").length;
      this.item.text = `$(rocket) ${project}: ${done}/${total} tasks ${running > 0 ? `(${running} running)` : ""} · ${activeAgents} agents`;
      this.item.tooltip = `Project: ${project}\nTasks: ${done} done, ${running} running, ${total} total\nAgents: ${activeAgents} active`;
    } catch {
      this.item.text = `$(rocket) ${project} (offline)`;
      this.item.tooltip = "Gateway not reachable";
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
