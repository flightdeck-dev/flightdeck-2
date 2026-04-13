import * as vscode from "vscode";
export interface FlightdeckTask {
    id: string;
    title: string;
    description?: string;
    role: string;
    assignedAgent?: string;
    state: "ready" | "assigned" | "running" | "in_review" | "done" | "failed" | "cancelled";
    parentId?: string | null;
    epicId?: string | null;
    createdAt?: string;
    updatedAt?: string;
}
export interface FlightdeckAgent {
    id: string;
    role: string;
    status: "idle" | "busy" | "working" | "error" | "terminated";
    model: string;
    currentTask?: string;
}
export interface FlightdeckStatus {
    project: string;
    tasks: FlightdeckTask[];
    agents: FlightdeckAgent[];
}
export interface ChatMessage {
    id: string;
    threadId?: string | null;
    parentId?: string | null;
    taskId?: string | null;
    authorType: "user" | "lead" | "agent";
    authorId: string;
    content: string;
    createdAt?: string;
}
export interface ProjectInfo {
    name: string;
}
export declare class FlightdeckClient {
    private _project;
    private outputChannel;
    private _onProjectChanged;
    readonly onProjectChanged: vscode.Event<string | undefined>;
    constructor(outputChannel: vscode.OutputChannel);
    get project(): string | undefined;
    setProject(name: string | undefined): void;
    private get baseUrl();
    private get authToken();
    private fetch;
    private projectPath;
    listProjects(): Promise<ProjectInfo[]>;
    createProject(name: string): Promise<void>;
    getStatus(): Promise<FlightdeckStatus>;
    getTasks(): Promise<FlightdeckTask[]>;
    getTask(id: string): Promise<FlightdeckTask | null>;
    createTask(title: string, opts?: {
        description?: string;
        role?: string;
    }): Promise<FlightdeckTask>;
    getAgents(): Promise<FlightdeckAgent[]>;
    getMessages(opts?: {
        limit?: number;
    }): Promise<ChatMessage[]>;
    sendMessage(content: string): Promise<{
        message: ChatMessage | null;
        response: ChatMessage | string | null;
    }>;
    pauseOrchestrator(): Promise<void>;
    resumeOrchestrator(): Promise<void>;
}
