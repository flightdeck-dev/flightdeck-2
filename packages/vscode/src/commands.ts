import * as vscode from "vscode";
import { FlightdeckClient, FlightdeckTask } from "./flightdeckClient";
import { TaskTreeProvider } from "./taskTreeProvider";
import { AgentTreeProvider } from "./agentTreeProvider";
import { DISPLAY_PRESETS, type DisplayPreset } from "@flightdeck-ai/shared/display";

const ROLES = ["architect", "frontend", "backend", "reviewer", "devops"];
const MODELS = [
  "claude-sonnet-4-20250514",
  "gpt-4o",
  "gemini-2.5-pro",
  "o3",
];

export function registerCommands(
  context: vscode.ExtensionContext,
  client: FlightdeckClient,
  taskTree: TaskTreeProvider,
  agentTree: AgentTreeProvider,
  outputChannel: vscode.OutputChannel
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("flightdeck.init", async () => {
      try {
        await client.init();
        vscode.window.showInformationMessage("Flightdeck project initialized.");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Init failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("flightdeck.status", async () => {
      try {
        const status = await client.getStatus();
        outputChannel.clear();
        outputChannel.appendLine(JSON.stringify(status, null, 2));
        outputChannel.show();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Status failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("flightdeck.taskList", () => {
      taskTree.refresh();
    }),

    vscode.commands.registerCommand(
      "flightdeck.taskDetail",
      (task: FlightdeckTask) => {
        const panel = vscode.window.createWebviewPanel(
          "flightdeckTask",
          `Task: ${task.title}`,
          vscode.ViewColumn.One,
          {}
        );
        panel.webview.html = `<!DOCTYPE html>
<html><body>
<h1>${task.title}</h1>
<p><strong>ID:</strong> ${task.id}</p>
<p><strong>Role:</strong> ${task.role}</p>
<p><strong>Agent:</strong> ${task.assignedAgent ?? "unassigned"}</p>
<p><strong>State:</strong> ${task.state}</p>
</body></html>`;
      }
    ),

    vscode.commands.registerCommand("flightdeck.agentSpawn", async () => {
      const role = await vscode.window.showQuickPick(ROLES, {
        placeHolder: "Select agent role",
      });
      if (!role) return;
      const model = await vscode.window.showQuickPick(MODELS, {
        placeHolder: "Select model",
      });
      if (!model) return;
      try {
        await client.spawnAgent(role, model);
        vscode.window.showInformationMessage(
          `Spawned ${role} agent with ${model}`
        );
        agentTree.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Spawn failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("flightdeck.start", async () => {
      try {
        await client.start();
        vscode.window.showInformationMessage("Flightdeck orchestrator started.");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Start failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("flightdeck.stop", async () => {
      try {
        await client.stop();
        vscode.window.showInformationMessage("Flightdeck orchestrator stopped.");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Stop failed: ${e.message}`);
      }
    }),

    // Agent context menu commands
    vscode.commands.registerCommand(
      "flightdeck.agentTerminate",
      async (item: any) => {
        const id = item?.agent?.id;
        if (!id) return;
        await client.terminateAgent(id);
        agentTree.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "flightdeck.agentInterrupt",
      async (item: any) => {
        const id = item?.agent?.id;
        if (!id) return;
        await client.interruptAgent(id);
        agentTree.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "flightdeck.agentRestart",
      async (item: any) => {
        const id = item?.agent?.id;
        if (!id) return;
        await client.restartAgent(id);
        agentTree.refresh();
      }
    ),

    vscode.commands.registerCommand("flightdeck.displayPreset", async () => {
      const presets = ["minimal", "summary", "detail", "debug"];
      const descriptions: Record<string, string> = {
        minimal: "Final answers only",
        summary: "Tool names + brief results",
        detail: "Thinking + full tool details",
        debug: "Everything visible",
      };
      const picked = await vscode.window.showQuickPick(
        presets.map(p => ({ label: p, description: descriptions[p] })),
        { placeHolder: "Select display preset" }
      );
      if (!picked) return;
      const config = vscode.workspace.getConfiguration("flightdeck.display");
      const preset = DISPLAY_PRESETS[picked.label as DisplayPreset];
      await config.update("thinking", preset.thinking, true);
      await config.update("toolCalls", preset.toolCalls, true);
      await config.update("flightdeckTools", preset.flightdeckTools, true);
      await config.update("preset", picked.label, true);
      vscode.window.showInformationMessage(`Display preset: ${picked.label}`);
    })
  );
}
