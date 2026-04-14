import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import * as net from "net";
import * as http from "http";

export type DaemonStatus = "stopped" | "starting" | "running" | "error";

interface DaemonEvents {
  status: [DaemonStatus];
  log: [string];
}

export class DaemonManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private _status: DaemonStatus = "stopped";
  private _port: number = 18800;
  private restartCount = 0;
  private maxRestarts = 5;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  get status(): DaemonStatus {
    return this._status;
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://localhost:${this._port}`;
  }

  private setStatus(status: DaemonStatus) {
    this._status = status;
    this.emit("status", status);
  }

  async start(): Promise<void> {
    if (this._status === "running" || this._status === "starting") return;
    this.shuttingDown = false;
    this._port = await this.findFreePort(18800);
    this.setStatus("starting");
    this.spawnDaemon();
    await this.waitForHealth();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.stopHealthCheck();

    if (this.process) {
      this.process.kill("SIGTERM");
      // Give it 5s to shut down gracefully
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) this.process.kill("SIGKILL");
          resolve();
        }, 5000);
        if (this.process) {
          this.process.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.process = null;
    }
    this.setStatus("stopped");
  }

  async restart(): Promise<void> {
    await this.stop();
    this.restartCount = 0;
    await this.start();
  }

  private spawnDaemon() {
    const rootDir = path.resolve(__dirname, "..", "..", "..");
    const cliPath = path.join(
      rootDir,
      "packages",
      "server",
      "src",
      "cli",
      "index.ts"
    );

    // Use npx tsx to run the TypeScript CLI
    const args = [
      "--prefix",
      path.join(rootDir, "packages", "server"),
      "tsx",
      cliPath,
      "start",
      "--no-recover",
    ];

    this.emit("log", `Starting daemon on port ${this._port}...`);

    this.process = spawn("npx", args, {
      cwd: rootDir,
      env: {
        ...process.env,
        PORT: String(this._port),
        FLIGHTDECK_PORT: String(this._port),
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.emit("log", data.toString().trim());
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.emit("log", `[stderr] ${data.toString().trim()}`);
    });

    this.process.on("exit", (code) => {
      this.emit("log", `Daemon exited with code ${code}`);
      if (!this.shuttingDown && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        this.emit(
          "log",
          `Auto-restarting (${this.restartCount}/${this.maxRestarts})...`
        );
        this.setStatus("starting");
        setTimeout(() => this.spawnDaemon(), 2000);
      } else if (!this.shuttingDown) {
        this.setStatus("error");
      }
    });

    this.process.on("error", (err) => {
      this.emit("log", `Daemon error: ${err.message}`);
      this.setStatus("error");
    });
  }

  private async waitForHealth(
    timeoutMs: number = 30000
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.checkHealth()) {
        this.setStatus("running");
        this.restartCount = 0;
        this.startHealthCheck();
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.emit("log", "Daemon health check timed out");
    this.setStatus("error");
  }

  private async checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${this.url}/health`, { timeout: 2000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      if (this._status !== "running") return;
      const healthy = await this.checkHealth();
      if (!healthy && !this.shuttingDown) {
        this.emit("log", "Health check failed — daemon may have crashed");
        this.setStatus("error");
      }
    }, 15000);
  }

  private stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private async findFreePort(preferred: number): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(preferred, () => {
        server.close(() => resolve(preferred));
      });
      server.on("error", () => {
        // Port taken, find a random free one
        const server2 = net.createServer();
        server2.listen(0, () => {
          const addr = server2.address();
          const port = typeof addr === "object" && addr ? addr.port : 3001;
          server2.close(() => resolve(port));
        });
      });
    });
  }
}
