import * as vscode from "vscode";
import { FlightdeckClient } from "./flightdeckClient";

export class StatusBar {
  private item: vscode.StatusBarItem;
  private client: FlightdeckClient;
  private timer?: ReturnType<typeof setInterval>;

  constructor(client: FlightdeckClient) {
    this.client = client;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = "workbench.action.quickOpen";
    this.item.text = "$(rocket) Flightdeck";
    this.item.tooltip = "Click to open Flightdeck commands";
    this.item.show();
  }

  startPolling(intervalMs = 5000): void {
    this.update();
    this.timer = setInterval(() => this.update(), intervalMs);
  }

  private async update(): Promise<void> {
    try {
      const status = await this.client.getStatus();
      const done = status.tasks.filter((t) => t.state === "done").length;
      const total = status.tasks.length;
      const agents = status.agents.length;
      this.item.text = `$(rocket) ${status.project}: ${done}/${total} tasks · ${agents} agents`;
    } catch {
      this.item.text = "$(rocket) Flightdeck";
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.item.dispose();
  }
}
