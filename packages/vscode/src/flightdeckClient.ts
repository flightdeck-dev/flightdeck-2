import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";

// ── API Types ──

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

// ── Client ──

export class FlightdeckClient {
  private _project: string | undefined;
  private outputChannel: vscode.OutputChannel;
  private _onProjectChanged = new vscode.EventEmitter<string | undefined>();
  readonly onProjectChanged = this._onProjectChanged.event;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
    // Auto-detect from config
    const cfg = vscode.workspace.getConfiguration("flightdeck");
    this._project = cfg.get<string>("defaultProject") || undefined;
  }

  get project(): string | undefined {
    return this._project;
  }

  setProject(name: string | undefined): void {
    this._project = name;
    this._onProjectChanged.fire(name);
  }

  private get baseUrl(): string {
    const cfg = vscode.workspace.getConfiguration("flightdeck");
    return cfg.get<string>("gatewayUrl") || "http://localhost:3000";
  }

  private get authToken(): string | undefined {
    const cfg = vscode.workspace.getConfiguration("flightdeck");
    return cfg.get<string>("authToken") || undefined;
  }

  private fetch(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const isHttps = url.protocol === "https:";
      const lib = isHttps ? https : http;
      const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

      const headers: Record<string, string> = {
        "Accept": "application/json",
      };
      if (bodyStr) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
      }
      if (this.authToken) {
        headers["Authorization"] = `Bearer ${this.authToken}`;
      }

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: options.method || "GET",
          headers,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(data ? JSON.parse(data) : null);
              } catch {
                resolve(data);
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  private projectPath(sub: string): string {
    if (!this._project) {
      throw new Error("No project selected. Run 'Flightdeck: Set Project' first.");
    }
    return `/api/projects/${encodeURIComponent(this._project)}${sub}`;
  }

  // ── Project ──

  async listProjects(): Promise<ProjectInfo[]> {
    const res = (await this.fetch("/api/projects")) as { projects: ProjectInfo[] };
    return res.projects || [];
  }

  async createProject(name: string): Promise<void> {
    await this.fetch("/api/projects", { method: "POST", body: { name } });
  }

  // ── Status ──

  async getStatus(): Promise<FlightdeckStatus> {
    try {
      return (await this.fetch(this.projectPath("/status"))) as FlightdeckStatus;
    } catch {
      return { project: this._project || "unknown", tasks: [], agents: [] };
    }
  }

  // ── Tasks ──

  async getTasks(): Promise<FlightdeckTask[]> {
    try {
      return (await this.fetch(this.projectPath("/tasks"))) as FlightdeckTask[];
    } catch {
      return [];
    }
  }

  async getTask(id: string): Promise<FlightdeckTask | null> {
    try {
      return (await this.fetch(this.projectPath(`/tasks/${encodeURIComponent(id)}`))) as FlightdeckTask;
    } catch {
      return null;
    }
  }

  async createTask(title: string, opts: { description?: string; role?: string } = {}): Promise<FlightdeckTask> {
    return (await this.fetch(this.projectPath("/tasks"), {
      method: "POST",
      body: { title, ...opts },
    })) as FlightdeckTask;
  }

  // ── Agents ──

  async getAgents(): Promise<FlightdeckAgent[]> {
    try {
      return (await this.fetch(this.projectPath("/agents"))) as FlightdeckAgent[];
    } catch {
      return [];
    }
  }

  // ── Chat ──

  async getMessages(opts: { limit?: number } = {}): Promise<ChatMessage[]> {
    const limit = opts.limit || 50;
    return (await this.fetch(this.projectPath(`/messages?limit=${limit}`))) as ChatMessage[];
  }

  async sendMessage(content: string): Promise<{ message: ChatMessage | null; response: ChatMessage | string | null }> {
    return (await this.fetch(this.projectPath("/messages"), {
      method: "POST",
      body: { content },
    })) as { message: ChatMessage | null; response: ChatMessage | string | null };
  }

  // ── Orchestrator ──

  async pauseOrchestrator(): Promise<void> {
    await this.fetch(this.projectPath("/orchestrator/pause"), { method: "POST" });
  }

  async resumeOrchestrator(): Promise<void> {
    await this.fetch(this.projectPath("/orchestrator/resume"), { method: "POST" });
  }
}
