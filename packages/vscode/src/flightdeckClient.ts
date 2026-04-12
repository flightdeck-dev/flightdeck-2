import * as vscode from "vscode";
import { spawn } from "child_process";

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

export class FlightdeckClient {
  private workspaceRoot: string;
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.outputChannel = outputChannel;
  }

  private runCli(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const cmd = "npx";
      const fullArgs = [
        "tsx",
        "packages/server/src/cli/index.ts",
        ...args,
        "--json",
      ];
      this.outputChannel.appendLine(`> ${cmd} ${fullArgs.join(" ")}`);

      const proc = spawn(cmd, fullArgs, {
        cwd: this.workspaceRoot,
        shell: true,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          this.outputChannel.appendLine(`CLI error: ${stderr}`);
          reject(new Error(`CLI exited with code ${code}: ${stderr}`));
        }
      });
      proc.on("error", reject);
    });
  }

  async getStatus(): Promise<FlightdeckStatus> {
    try {
      const raw = await this.runCli(["status"]);
      return JSON.parse(raw);
    } catch {
      return { project: "unknown", tasks: [], agents: [] };
    }
  }

  async getTasks(): Promise<FlightdeckTask[]> {
    try {
      const raw = await this.runCli(["task", "list"]);
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async getAgents(): Promise<FlightdeckAgent[]> {
    try {
      const raw = await this.runCli(["agent", "list"]);
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async init(): Promise<string> {
    return this.runCli(["init"]);
  }

  async start(): Promise<string> {
    return this.runCli(["start"]);
  }

  async stop(): Promise<string> {
    return this.runCli(["stop"]);
  }

  async spawnAgent(role: string, model: string): Promise<string> {
    return this.runCli(["agent", "spawn", "--role", role, "--model", model]);
  }

  async terminateAgent(id: string): Promise<string> {
    return this.runCli(["agent", "terminate", id]);
  }

  async interruptAgent(id: string): Promise<string> {
    return this.runCli(["agent", "interrupt", id]);
  }

  async restartAgent(id: string): Promise<string> {
    return this.runCli(["agent", "restart", id]);
  }
}
