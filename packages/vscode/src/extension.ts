import * as vscode from "vscode";
import { FlightdeckClient } from "./flightdeckClient";
import { TaskTreeProvider } from "./taskTreeProvider";
import { AgentTreeProvider } from "./agentTreeProvider";
import { StatusBar } from "./statusBar";
import { registerCommands } from "./commands";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Flightdeck");
  const client = new FlightdeckClient(outputChannel);

  // Tree views
  const taskTree = new TaskTreeProvider(client);
  const agentTree = new AgentTreeProvider(client);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("flightdeck.tasks", taskTree),
    vscode.window.registerTreeDataProvider("flightdeck.agents", agentTree)
  );

  // Status bar
  const statusBar = new StatusBar(client);
  statusBar.startPolling(10000);
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  // Commands
  registerCommands(context, client, taskTree, agentTree, outputChannel);

  // Initial data load
  taskTree.refresh();
  agentTree.refresh();

  outputChannel.appendLine("Flightdeck extension activated.");
}

export function deactivate(): void {
  // cleanup handled by disposables
}
