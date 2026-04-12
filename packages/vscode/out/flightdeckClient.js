"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FlightdeckClient = void 0;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
class FlightdeckClient {
    workspaceRoot;
    outputChannel;
    constructor(outputChannel) {
        this.workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this.outputChannel = outputChannel;
    }
    runCli(args) {
        return new Promise((resolve, reject) => {
            const cmd = "npx";
            const fullArgs = [
                "tsx",
                "packages/server/src/cli/index.ts",
                ...args,
                "--json",
            ];
            this.outputChannel.appendLine(`> ${cmd} ${fullArgs.join(" ")}`);
            const proc = (0, child_process_1.spawn)(cmd, fullArgs, {
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
                }
                else {
                    this.outputChannel.appendLine(`CLI error: ${stderr}`);
                    reject(new Error(`CLI exited with code ${code}: ${stderr}`));
                }
            });
            proc.on("error", reject);
        });
    }
    async getStatus() {
        try {
            const raw = await this.runCli(["status"]);
            return JSON.parse(raw);
        }
        catch {
            return { project: "unknown", tasks: [], agents: [] };
        }
    }
    async getTasks() {
        try {
            const raw = await this.runCli(["task", "list"]);
            return JSON.parse(raw);
        }
        catch {
            return [];
        }
    }
    async getAgents() {
        try {
            const raw = await this.runCli(["agent", "list"]);
            return JSON.parse(raw);
        }
        catch {
            return [];
        }
    }
    async init() {
        return this.runCli(["init"]);
    }
    async start() {
        return this.runCli(["start"]);
    }
    async stop() {
        return this.runCli(["stop"]);
    }
    async spawnAgent(role, model) {
        return this.runCli(["agent", "spawn", "--role", role, "--model", model]);
    }
    async terminateAgent(id) {
        return this.runCli(["agent", "terminate", id]);
    }
    async interruptAgent(id) {
        return this.runCli(["agent", "interrupt", id]);
    }
    async restartAgent(id) {
        return this.runCli(["agent", "restart", id]);
    }
}
exports.FlightdeckClient = FlightdeckClient;
//# sourceMappingURL=flightdeckClient.js.map