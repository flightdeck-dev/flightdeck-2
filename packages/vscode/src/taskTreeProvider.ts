import * as vscode from "vscode";
import { FlightdeckClient, FlightdeckTask } from "./flightdeckClient";

type TaskState = FlightdeckTask["state"];

const STATE_ICONS: Record<string, { icon: string; color: string }> = {
  ready: { icon: "circle-outline", color: "charts.blue" },
  assigned: { icon: "circle-filled", color: "charts.blue" },
  running: { icon: "sync~spin", color: "charts.orange" },
  in_review: { icon: "eye", color: "charts.yellow" },
  done: { icon: "check", color: "charts.green" },
  failed: { icon: "error", color: "charts.red" },
  cancelled: { icon: "circle-slash", color: "disabledForeground" },
};

const STATE_ORDER: TaskState[] = ["running", "ready", "assigned", "in_review", "done", "failed", "cancelled"];

// ── Tree Items ──

export class TaskGroupItem extends vscode.TreeItem {
  constructor(
    public readonly state: TaskState,
    public readonly count: number
  ) {
    super(`${state} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    const s = STATE_ICONS[state] || STATE_ICONS["ready"];
    this.iconPath = new vscode.ThemeIcon(s.icon, new vscode.ThemeColor(s.color));
    this.contextValue = "taskGroup";
  }
}

export class EpicItem extends vscode.TreeItem {
  constructor(
    public readonly task: FlightdeckTask,
    childCount: number
  ) {
    super(task.title, vscode.TreeItemCollapsibleState.Expanded);
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

export class TaskItem extends vscode.TreeItem {
  constructor(public readonly task: FlightdeckTask) {
    super(task.title, vscode.TreeItemCollapsibleState.None);
    this.description = [task.role, task.assignedAgent].filter(Boolean).join(" · ");
    this.tooltip = new vscode.MarkdownString(
      `**${task.title}**\n\n` +
      `- **ID:** \`${task.id}\`\n` +
      `- **Role:** ${task.role}\n` +
      `- **Agent:** ${task.assignedAgent ?? "unassigned"}\n` +
      `- **State:** ${task.state}\n` +
      (task.description ? `\n---\n${task.description}` : "")
    );
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

type TreeItem = TaskGroupItem | EpicItem | TaskItem;

// ── Provider ──

export class TaskTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tasks: FlightdeckTask[] = [];

  constructor(private client: FlightdeckClient) {}

  refresh(): void {
    this.client.getTasks().then((tasks) => {
      this.tasks = tasks;
      this._onDidChangeTreeData.fire();
    });
  }

  getTreeItem(el: TreeItem): vscode.TreeItem {
    return el;
  }

  getChildren(el?: TreeItem): TreeItem[] {
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

      const items: TreeItem[] = [];
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
