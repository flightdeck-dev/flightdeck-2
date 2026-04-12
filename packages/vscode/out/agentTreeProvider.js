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
exports.AgentTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
class AgentItem extends vscode.TreeItem {
    agent;
    constructor(agent) {
        super(agent.role, vscode.TreeItemCollapsibleState.None);
        this.agent = agent;
        this.description = `${agent.model} · ${agent.status}`;
        this.tooltip = `ID: ${agent.id}\nRole: ${agent.role}\nModel: ${agent.model}\nStatus: ${agent.status}`;
        this.iconPath = new vscode.ThemeIcon(agent.status === "working"
            ? "sync~spin"
            : agent.status === "error"
                ? "error"
                : "person");
        this.contextValue = "agent";
    }
}
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