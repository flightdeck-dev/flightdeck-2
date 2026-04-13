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
exports.TaskTreeProvider = exports.TaskItem = exports.EpicItem = exports.TaskGroupItem = void 0;
const vscode = __importStar(require("vscode"));
const STATE_ICONS = {
    ready: { icon: "circle-outline", color: "charts.blue" },
    assigned: { icon: "circle-filled", color: "charts.blue" },
    running: { icon: "sync~spin", color: "charts.orange" },
    in_review: { icon: "eye", color: "charts.yellow" },
    done: { icon: "check", color: "charts.green" },
    failed: { icon: "error", color: "charts.red" },
    cancelled: { icon: "circle-slash", color: "disabledForeground" },
};
const STATE_ORDER = ["running", "ready", "assigned", "in_review", "done", "failed", "cancelled"];
// ── Tree Items ──
class TaskGroupItem extends vscode.TreeItem {
    state;
    count;
    constructor(state, count) {
        super(`${state} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
        this.state = state;
        this.count = count;
        const s = STATE_ICONS[state] || STATE_ICONS["ready"];
        this.iconPath = new vscode.ThemeIcon(s.icon, new vscode.ThemeColor(s.color));
        this.contextValue = "taskGroup";
    }
}
exports.TaskGroupItem = TaskGroupItem;
class EpicItem extends vscode.TreeItem {
    task;
    constructor(task, childCount) {
        super(task.title, vscode.TreeItemCollapsibleState.Expanded);
        this.task = task;
        this.description = `${childCount} sub-tasks`;
        const s = STATE_ICONS[task.state] || STATE_ICONS["ready"];
        this.iconPath = new vscode.ThemeIcon(s.icon, new vscode.ThemeColor(s.color));
        this.contextValue = "task";
        this.command = {
            command: "flightdeck.taskDetail",
            title: "Show Task Detail",
            arguments: [task],
        };
    }
}
exports.EpicItem = EpicItem;
class TaskItem extends vscode.TreeItem {
    task;
    constructor(task) {
        super(task.title, vscode.TreeItemCollapsibleState.None);
        this.task = task;
        this.description = [task.role, task.assignedAgent].filter(Boolean).join(" · ");
        this.tooltip = new vscode.MarkdownString(`**${task.title}**\n\n` +
            `- **ID:** \`${task.id}\`\n` +
            `- **Role:** ${task.role}\n` +
            `- **Agent:** ${task.assignedAgent ?? "unassigned"}\n` +
            `- **State:** ${task.state}\n` +
            (task.description ? `\n---\n${task.description}` : ""));
        const s = STATE_ICONS[task.state] || STATE_ICONS["ready"];
        this.iconPath = new vscode.ThemeIcon(s.icon, new vscode.ThemeColor(s.color));
        this.contextValue = "task";
        this.command = {
            command: "flightdeck.taskDetail",
            title: "Show Task Detail",
            arguments: [task],
        };
    }
}
exports.TaskItem = TaskItem;
// ── Provider ──
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
            // Root: state groups with tasks
            return STATE_ORDER.map((state) => {
                const count = this.tasks.filter((t) => t.state === state).length;
                return new TaskGroupItem(state, count);
            }).filter((g) => g.count > 0);
        }
        if (el instanceof TaskGroupItem) {
            const tasksInState = this.tasks.filter((t) => t.state === el.state);
            // Group epics (tasks that are parents)
            const childIds = new Set(this.tasks.filter((t) => t.parentId || t.epicId).map((t) => t.parentId || t.epicId));
            const epics = tasksInState.filter((t) => childIds.has(t.id));
            const standalone = tasksInState.filter((t) => !childIds.has(t.id) && !t.parentId && !t.epicId);
            const children = tasksInState.filter((t) => (t.parentId || t.epicId) && t.state === el.state);
            const items = [];
            for (const epic of epics) {
                const subs = this.tasks.filter((t) => (t.parentId === epic.id || t.epicId === epic.id) && t.state === el.state);
                items.push(new EpicItem(epic, subs.length));
            }
            for (const task of [...standalone, ...children]) {
                items.push(new TaskItem(task));
            }
            return items;
        }
        if (el instanceof EpicItem) {
            return this.tasks
                .filter((t) => t.parentId === el.task.id || t.epicId === el.task.id)
                .map((t) => new TaskItem(t));
        }
        return [];
    }
}
exports.TaskTreeProvider = TaskTreeProvider;
//# sourceMappingURL=taskTreeProvider.js.map