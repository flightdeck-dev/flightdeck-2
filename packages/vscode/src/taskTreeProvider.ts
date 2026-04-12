import * as vscode from "vscode";
import {
  FlightdeckClient,
  FlightdeckTask,
} from "./flightdeckClient";

type TaskState = FlightdeckTask["state"];

const STATE_ICONS: Record<TaskState, string> = {
  ready: "$(circle-outline)",
  running: "$(loading~spin)",
  in_review: "$(eye)",
  done: "$(check)",
};

const STATE_ORDER: TaskState[] = ["running", "ready", "in_review", "done"];

class TaskGroupItem extends vscode.TreeItem {
  constructor(
    public readonly state: TaskState,
    public readonly count: number
  ) {
    super(`${state} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(
      state === "done"
        ? "check"
        : state === "running"
          ? "sync~spin"
          : state === "in_review"
            ? "eye"
            : "circle-outline"
    );
    this.contextValue = "taskGroup";
  }
}

class TaskItem extends vscode.TreeItem {
  constructor(public readonly task: FlightdeckTask) {
    super(task.title, vscode.TreeItemCollapsibleState.None);
    this.description = [task.role, task.assignedAgent]
      .filter(Boolean)
      .join(" · ");
    this.tooltip = `${task.title}\nRole: ${task.role}\nAgent: ${task.assignedAgent ?? "unassigned"}\nState: ${task.state}`;
    this.iconPath = new vscode.ThemeIcon(
      task.state === "done"
        ? "check"
        : task.state === "running"
          ? "sync~spin"
          : task.state === "in_review"
            ? "eye"
            : "circle-outline"
    );
    this.contextValue = "task";
    this.command = {
      command: "flightdeck.taskDetail",
      title: "Show Task Detail",
      arguments: [task],
    };
  }
}

export class TaskTreeProvider
  implements vscode.TreeDataProvider<TaskGroupItem | TaskItem>
{
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

  getTreeItem(el: TaskGroupItem | TaskItem): vscode.TreeItem {
    return el;
  }

  getChildren(
    el?: TaskGroupItem | TaskItem
  ): (TaskGroupItem | TaskItem)[] {
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
