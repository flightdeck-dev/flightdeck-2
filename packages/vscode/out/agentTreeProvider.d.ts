import * as vscode from "vscode";
import { FlightdeckClient, FlightdeckAgent } from "./flightdeckClient";
declare class AgentItem extends vscode.TreeItem {
    readonly agent: FlightdeckAgent;
    constructor(agent: FlightdeckAgent);
}
export declare class AgentTreeProvider implements vscode.TreeDataProvider<AgentItem> {
    private client;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<void>;
    private agents;
    constructor(client: FlightdeckClient);
    refresh(): void;
    getTreeItem(el: AgentItem): vscode.TreeItem;
    getChildren(): AgentItem[];
    getAgentById(id: string): FlightdeckAgent | undefined;
}
export {};
