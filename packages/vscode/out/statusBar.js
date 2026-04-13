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
exports.StatusBar = void 0;
const vscode = __importStar(require("vscode"));
class StatusBar {
    item;
    client;
    timer;
    disposables = [];
    constructor(client) {
        this.client = client;
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.command = "flightdeck.statusBarClick";
        this.item.text = "$(rocket) Flightdeck";
        this.item.tooltip = "Flightdeck — click for options";
        this.item.show();
        // Update when project changes
        this.disposables.push(client.onProjectChanged(() => this.update()));
    }
    startPolling(intervalMs = 10000) {
        this.update();
        this.timer = setInterval(() => this.update(), intervalMs);
    }
    async update() {
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
            const activeAgents = agents.filter((a) => a.status === "busy" || a.status === "working" || a.status === "idle").length;
            this.item.text = `$(rocket) ${project}: ${done}/${total} tasks ${running > 0 ? `(${running} running)` : ""} · ${activeAgents} agents`;
            this.item.tooltip = `Project: ${project}\nTasks: ${done} done, ${running} running, ${total} total\nAgents: ${activeAgents} active`;
        }
        catch {
            this.item.text = `$(rocket) ${project} (offline)`;
            this.item.tooltip = "Gateway not reachable";
        }
    }
    dispose() {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.item.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
exports.StatusBar = StatusBar;
//# sourceMappingURL=statusBar.js.map