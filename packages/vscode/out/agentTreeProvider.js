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
exports.AgentTreeProvider = exports.AgentItem = void 0;
const vscode = __importStar(require("vscode"));
const STATUS_ICONS = {
    idle: { icon: "person", color: "charts.blue" },
    busy: { icon: "sync~spin", color: "charts.orange" },
    working: { icon: "sync~spin", color: "charts.orange" },
    error: { icon: "error", color: "charts.red" },
    terminated: { icon: "circle-slash", color: "disabledForeground" },
};
const ROLE_ICONS = {
    architect: "symbol-structure",
    frontend: "browser",
    backend: "server",
    reviewer: "checklist",
    devops: "gear",
    lead: "megaphone",
    worker: "tools",
};
class AgentItem extends vscode.TreeItem {
    agent;
    constructor(agent) {
        super(agent.role, vscode.TreeItemCollapsibleState.None);
        this.agent = agent;
        this.description = `${agent.model} · ${agent.status}${agent.currentTask ? ` · ${agent.currentTask}` : ""}`;
        this.tooltip = new vscode.MarkdownString(`**${agent.role}** (${agent.id})\n\n` +
            `- **Model:** ${agent.model}\n` +
            `- **Status:** ${agent.status}\n` +
            (agent.currentTask ? `- **Task:** ${agent.currentTask}\n` : ""));
        const roleIcon = ROLE_ICONS[agent.role] || "person";
        const statusInfo = STATUS_ICONS[agent.status] || STATUS_ICONS["idle"];
        // Use role icon with status color
        this.iconPath = new vscode.ThemeIcon(roleIcon, new vscode.ThemeColor(statusInfo.color));
        this.contextValue = "agent";
    }
}
exports.AgentItem = AgentItem;
class AgentTreeProvider {
    client;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    agents = [];
    constructor(client) {
        this.client = client;
    }
    refresh() {
        this.client.getAgents().then((agents) => {
            this.agents = agents;
            this._onDidChangeTreeData.fire();
        });
    }
    getTreeItem(el) {
        return el;
    }
    getChildren() {
        return this.agents.map((a) => new AgentItem(a));
    }
    getAgentById(id) {
        return this.agents.find((a) => a.id === id);
    }
}
exports.AgentTreeProvider = AgentTreeProvider;
//# sourceMappingURL=agentTreeProvider.js.map