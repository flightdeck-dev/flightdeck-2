import * as vscode from "vscode";
import { FlightdeckClient, FlightdeckTask } from "./flightdeckClient";
type TaskState = FlightdeckTask["state"];
declare class TaskGroupItem extends vscode.TreeItem {
    readonly state: TaskState;
    readonly count: number;
    constructor(state: TaskState, count: number);
}
declare class TaskItem extends vscode.TreeItem {
    readonly task: FlightdeckTask;
    constructor(task: FlightdeckTask);
}
export declare class TaskTreeProvider implements vscode.TreeDataProvider<TaskGroupItem | TaskItem> {
    private client;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<void>;
    private tasks;
    constructor(client: FlightdeckClient);
    refresh(): void;
    getTreeItem(el: TaskGroupItem | TaskItem): vscode.TreeItem;
    getChildren(el?: TaskGroupItem | TaskItem): (TaskGroupItem | TaskItem)[];
}
export {};
