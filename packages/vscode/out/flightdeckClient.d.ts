import * as vscode from "vscode";
export interface FlightdeckTask {
    id: string;
    title: string;
    role: string;
    assignedAgent?: string;
    state: "ready" | "running" | "in_review" | "done";
}
export interface FlightdeckAgent {
    id: string;
    role: string;
    status: "idle" | "working" | "error";
    model: string;
}
export interface FlightdeckStatus {
    project: string;
    tasks: FlightdeckTask[];
    agents: FlightdeckAgent[];
}
export declare class FlightdeckClient {
    private workspaceRoot;
    private outputChannel;
    constructor(outputChannel: vscode.OutputChannel);
    private runCli;
    getStatus(): Promise<FlightdeckStatus>;
    getTasks(): Promise<FlightdeckTask[]>;
    getAgents(): Promise<FlightdeckAgent[]>;
    init(): Promise<string>;
    start(): Promise<string>;
    stop(): Promise<string>;
    spawnAgent(role: string, model: string): Promise<string>;
    terminateAgent(id: string): Promise<string>;
    interruptAgent(id: string): Promise<string>;
    restartAgent(id: string): Promise<string>;
}
