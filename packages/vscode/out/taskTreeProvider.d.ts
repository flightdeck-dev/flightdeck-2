import * as vscode from "vscode";
import { FlightdeckClient, FlightdeckTask } from "./flightdeckClient";
type TaskState = FlightdeckTask["state"];
export declare class TaskGroupItem extends vscode.TreeItem {
    readonly state: TaskState;
    readonly count: number;
    constructor(state: TaskState, count: number);
}
export declare class EpicItem extends vscode.TreeItem {
    readonly task: FlightdeckTask;
    constructor(task: FlightdeckTask, childCount: number);
}
export declare class TaskItem extends vscode.TreeItem {
    readonly task: FlightdeckTask;
    constructor(task: FlightdeckTask);
}
type TreeItem = TaskGroupItem | EpicItem | TaskItem;
export declare class TaskTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private client;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<void>;
    private tasks;
    constructor(client: FlightdeckClient);
    refresh(): void;
    getTreeItem(el: TreeItem): vscode.TreeItem;
    getChildren(el?: TreeItem): TreeItem[];
}
export {};
