"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCommands = registerCommands;
const vscode = __importStar(require("vscode"));
const chatPanel_1 = require("./chatPanel");
function registerCommands(context, client, taskTree, agentTree, outputChannel) {
    const refreshAll = () => {
        taskTree.refresh();
        agentTree.refresh();
    };
    context.subscriptions.push(
    // ── Set Project ──
    vscode.commands.registerCommand("flightdeck.setProject", async () => {
        try {
            const projects = await client.listProjects();
            const names = projects.map((p) => p.name);
            if (names.length === 0) {
                const name = await vscode.window.showInputBox({
                    prompt: "No projects found. Enter a name to create one:",
                    placeHolder: "my-project",
                    validateInput: (v) => /^[a-zA-Z0-9_-]+$/.test(v) ? null : "Alphanumeric, dashes, underscores only",
                });
                if (!name) {
                    return;
                }
                await client.createProject(name);
                client.setProject(name);
                vscode.window.showInformationMessage(`Created and selected project: ${name}`);
            }
            else {
                const picked = await vscode.window.showQuickPick(names, {
                    placeHolder: "Select a project",
                });
                if (!picked) {
                    return;
                }
                client.setProject(picked);
                vscode.window.showInformationMessage(`Switched to project: ${picked}`);
            }
            refreshAll();
        }
        catch (e) {
            vscode.window.showErrorMessage(`Failed to list projects: ${e instanceof Error ? e.message : String(e)}`);
        }
    }), 
    // ── Create Task ──
    vscode.commands.registerCommand("flightdeck.createTask", async () => {
        const title = await vscode.window.showInputBox({
            prompt: "Task title",
            placeHolder: "Implement feature X",
        });
        if (!title) {
            return;
        }
        const description = await vscode.window.showInputBox({
            prompt: "Description (optional)",
            placeHolder: "Details...",
        });
        try {
            const task = await client.createTask(title, { description: description || undefined });
            vscode.window.showInformationMessage(`Created task: ${task.title}`);
            taskTree.refresh();
        }
        catch (e) {
            vscode.window.showErrorMessage(`Failed to create task: ${e instanceof Error ? e.message : String(e)}`);
        }
    }), 
    // ── Chat With Lead ──
    vscode.commands.registerCommand("flightdeck.chatWithLead", () => {
        if (!client.project) {
            vscode.window.showWarningMessage("Select a project first (Flightdeck: Set Project)");
            return;
        }
        chatPanel_1.ChatPanel.createOrShow(client);
    }), 
    // ── View Dashboard ──
    vscode.commands.registerCommand("flightdeck.viewDashboard", () => {
        const cfg = vscode.workspace.getConfiguration("flightdeck");
        const baseUrl = cfg.get("gatewayUrl") || "http://localhost:18800";
        const project = client.project;
        const url = project ? `${baseUrl}/projects/${project}` : baseUrl;
        vscode.env.openExternal(vscode.Uri.parse(url));
    }), 
    // ── Refresh All ──
    vscode.commands.registerCommand("flightdeck.refreshAll", () => {
        refreshAll();
        vscode.window.showInformationMessage("Flightdeck views refreshed");
    }), 
    // ── Start Gateway ──
    vscode.commands.registerCommand("flightdeck.startGateway", () => {
        const terminal = vscode.window.createTerminal("Flightdeck Gateway");
        terminal.show();
        terminal.sendText("npx flightdeck gateway start");
    }), 
    // ── Task Detail ──
    vscode.commands.registerCommand("flightdeck.taskDetail", (task) => {
        const panel = vscode.window.createWebviewPanel("flightdeckTask", `Task: ${task.title}`, vscode.ViewColumn.One, {});
        const stateEmoji = {
            ready: "🔵", running: "🟠", in_review: "👁", done: "✅", failed: "🔴", cancelled: "⚫", assigned: "🔷",
        };
        panel.webview.html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; line-height: 1.6; }
  h1 { font-size: 1.4em; margin-bottom: 16px; }
  .field { margin-bottom: 8px; }
  .label { font-weight: bold; opacity: 0.8; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; white-space: pre-wrap; margin-top: 12px; }
</style>
</head><body>
<h1>${stateEmoji[task.state] || "⬜"} ${escapeHtml(task.title)}</h1>
<div class="field"><span class="label">ID:</span> <code>${task.id}</code></div>
<div class="field"><span class="label">State:</span> <span class="badge">${task.state}</span></div>
<div class="field"><span class="label">Role:</span> ${task.role}</div>
<div class="field"><span class="label">Agent:</span> ${task.assignedAgent ?? "<em>unassigned</em>"}</div>
${task.description ? `<pre>${escapeHtml(task.description)}</pre>` : ""}
</body></html>`;
    }), 
    // ── Status Bar Click → Quick Pick ──
    vscode.commands.registerCommand("flightdeck.statusBarClick", async () => {
        const items = [
            { label: "$(project) Switch Project", description: "flightdeck.setProject" },
            { label: "$(refresh) Refresh All", description: "flightdeck.refreshAll" },
            { label: "$(comment-discussion) Chat with Lead", description: "flightdeck.chatWithLead" },
            { label: "$(add) Create Task", description: "flightdeck.createTask" },
            { label: "$(globe) Open Dashboard", description: "flightdeck.viewDashboard" },
            { label: "$(play) Start Gateway", description: "flightdeck.startGateway" },
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: "Flightdeck" });
        if (picked?.description) {
            vscode.commands.executeCommand(picked.description);
        }
    }), 
    // ── Agent context menu ──
    vscode.commands.registerCommand("flightdeck.agentTerminate", async (item) => {
        const id = item?.agent?.id;
        if (!id) {
            return;
        }
        const confirm = await vscode.window.showWarningMessage(`Terminate agent ${id}?`, "Yes", "No");
        if (confirm !== "Yes") {
            return;
        }
        outputChannel.appendLine(`Terminating agent ${id}...`);
        agentTree.refresh();
    }), vscode.commands.registerCommand("flightdeck.agentRestart", async (item) => {
        const id = item?.agent?.id;
        if (!id) {
            return;
        }
        outputChannel.appendLine(`Restarting agent ${id}...`);
        agentTree.refresh();
    }), vscode.commands.registerCommand("flightdeck.agentSendMessage", async (item) => {
        const id = item?.agent?.id;
        if (!id) {
            return;
        }
        const msg = await vscode.window.showInputBox({ prompt: `Message to agent ${id}` });
        if (!msg) {
            return;
        }
        outputChannel.appendLine(`Sending message to agent ${id}: ${msg}`);
    }), 
    // ── Status (output channel) ──
    vscode.commands.registerCommand("flightdeck.status", async () => {
        try {
            const status = await client.getStatus();
            outputChannel.clear();
            outputChannel.appendLine(JSON.stringify(status, null, 2));
            outputChannel.show();
        }
        catch (e) {
            vscode.window.showErrorMessage(`Status failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }));
}
function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
//# sourceMappingURL=commands.js.map