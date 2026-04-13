import * as vscode from "vscode";
import { FlightdeckClient } from "./flightdeckClient";
import { TaskTreeProvider } from "./taskTreeProvider";
import { AgentTreeProvider } from "./agentTreeProvider";
import { StatusBar } from "./statusBar";
import { registerCommands } from "./commands";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Flightdeck");
  const client = new FlightdeckClient(outputChannel);

  // Auto-detect project from .flightdeck.json in workspace
  autoDetectProject(client);

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

  // Refresh on project change
  context.subscriptions.push(
    client.onProjectChanged(() => {
      taskTree.refresh();
      agentTree.refresh();
    })
  );

  // Initial data load
  if (client.project) {
    taskTree.refresh();
    agentTree.refresh();
  }

  outputChannel.appendLine("Flightdeck extension activated.");
}

async function autoDetectProject(client: FlightdeckClient): Promise<void> {
  if (client.project) { return; }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) { return; }
  for (const folder of folders) {
    const configUri = vscode.Uri.joinPath(folder.uri, ".flightdeck.json");
    try {
      const data = await vscode.workspace.fs.readFile(configUri);
      const config = JSON.parse(Buffer.from(data).toString("utf-8")) as { project?: string };
      if (config.project) {
        client.setProject(config.project);
        return;
      }
    } catch {
      // No config file, skip
    }
  }
}

export function deactivate(): void {
  // cleanup handled by disposables
}
