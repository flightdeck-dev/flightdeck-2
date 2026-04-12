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
exports.TaskTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
const STATE_ICONS = {
    ready: "$(circle-outline)",
    running: "$(loading~spin)",
    in_review: "$(eye)",
    done: "$(check)",
};
const STATE_ORDER = ["running", "ready", "in_review", "done"];
class TaskGroupItem extends vscode.TreeItem {
    state;
    count;
    constructor(state, count) {
        super(`${state} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
        this.state = state;
        this.count = count;
        this.iconPath = new vscode.ThemeIcon(state === "done"
            ? "check"
            : state === "running"
                ? "sync~spin"
                : state === "in_review"
                    ? "eye"
                    : "circle-outline");
        this.contextValue = "taskGroup";
    }
}
class TaskItem extends vscode.TreeItem {
    task;
    constructor(task) {
        super(task.title, vscode.TreeItemCollapsibleState.None);
        this.task = task;
        this.description = [task.role, task.assignedAgent]
            .filter(Boolean)
            .join(" · ");
        this.tooltip = `${task.title}\nRole: ${task.role}\nAgent: ${task.assignedAgent ?? "unassigned"}\nState: ${task.state}`;
        this.iconPath = new vscode.ThemeIcon(task.state === "done"
            ? "check"
            : task.state === "running"
                ? "sync~spin"
                : task.state === "in_review"
                    ? "eye"
                    : "circle-outline");
        this.contextValue = "task";
        this.command = {
            command: "flightdeck.taskDetail",
            title: "Show Task Detail",
            arguments: [task],
        };
    }
}
class TaskTreeProvider {
    client;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    tasks = [];
    constructor(client) {
        this.client = client;
    }
    refresh() {
        this.client.getTasks().then((tasks) => {
            this.tasks = tasks;
            this._onDidChangeTreeData.fire();
        });
    }
    getTreeItem(el) {
        return el;
    }
    getChildren(el) {
        if (!el) {
            // Root: return state groups that have tasks
            return STATE_ORDER.map((state) => {
                const count = this.tasks.filter((t) => t.state === state).length;
                return new TaskGroupItem(state, count);
            }).filter((g) => g.count > 0);
        }
        if (el instanceof TaskGroupItem) {
            return this.tasks
                .filter((t) => t.state === el.state)
                .map((t) => new TaskItem(t));
        }
        return [];
    }
}
exports.TaskTreeProvider = TaskTreeProvider;
//# sourceMappingURL=taskTreeProvider.js.map