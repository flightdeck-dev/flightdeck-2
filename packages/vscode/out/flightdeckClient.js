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
const http = __importStar(require("http"));
const https = __importStar(require("https"));
// ── Client ──
class FlightdeckClient {
    _project;
    outputChannel;
    _onProjectChanged = new vscode.EventEmitter();
    onProjectChanged = this._onProjectChanged.event;
    constructor(outputChannel) {
        this.outputChannel = outputChannel;
        // Auto-detect from config
        const cfg = vscode.workspace.getConfiguration("flightdeck");
        this._project = cfg.get("defaultProject") || undefined;
    }
    get project() {
        return this._project;
    }
    setProject(name) {
        this._project = name;
        this._onProjectChanged.fire(name);
    }
    get baseUrl() {
        const cfg = vscode.workspace.getConfiguration("flightdeck");
        return cfg.get("gatewayUrl") || "http://localhost:18800";
    }
    get authToken() {
        const cfg = vscode.workspace.getConfiguration("flightdeck");
        return cfg.get("authToken") || undefined;
    }
    fetch(path, options = {}) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, this.baseUrl);
            const isHttps = url.protocol === "https:";
            const lib = isHttps ? https : http;
            const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
            const headers = {
                "Accept": "application/json",
            };
            if (bodyStr) {
                headers["Content-Type"] = "application/json";
                headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
            }
            if (this.authToken) {
                headers["Authorization"] = `Bearer ${this.authToken}`;
            }
            const req = lib.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method: options.method || "GET",
                headers,
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(data ? JSON.parse(data) : null);
                        }
                        catch {
                            resolve(data);
                        }
                    }
                    else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });
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
    projectPath(sub) {
        if (!this._project) {
            throw new Error("No project selected. Run 'Flightdeck: Set Project' first.");
        }
        return `/api/projects/${encodeURIComponent(this._project)}${sub}`;
    }
    // ── Project ──
    async listProjects() {
        const res = (await this.fetch("/api/projects"));
        return res.projects || [];
    }
    async createProject(name) {
        await this.fetch("/api/projects", { method: "POST", body: { name } });
    }
    // ── Status ──
    async getStatus() {
        try {
            return (await this.fetch(this.projectPath("/status")));
        }
        catch {
            return { project: this._project || "unknown", tasks: [], agents: [] };
        }
    }
    // ── Tasks ──
    async getTasks() {
        try {
            return (await this.fetch(this.projectPath("/tasks")));
        }
        catch {
            return [];
        }
    }
    async getTask(id) {
        try {
            return (await this.fetch(this.projectPath(`/tasks/${encodeURIComponent(id)}`)));
        }
        catch {
            return null;
        }
    }
    async createTask(title, opts = {}) {
        return (await this.fetch(this.projectPath("/tasks"), {
            method: "POST",
            body: { title, ...opts },
        }));
    }
    // ── Agents ──
    async getAgents() {
        try {
            return (await this.fetch(this.projectPath("/agents")));
        }
        catch {
            return [];
        }
    }
    // ── Chat ──
    async getMessages(opts = {}) {
        const limit = opts.limit || 50;
        return (await this.fetch(this.projectPath(`/messages?limit=${limit}`)));
    }
    async sendMessage(content) {
        return (await this.fetch(this.projectPath("/messages"), {
            method: "POST",
            body: { content },
        }));
    }
    // ── Orchestrator ──
    async pauseOrchestrator() {
        await this.fetch(this.projectPath("/orchestrator/pause"), { method: "POST" });
    }
    async resumeOrchestrator() {
        await this.fetch(this.projectPath("/orchestrator/resume"), { method: "POST" });
    }
}
exports.FlightdeckClient = FlightdeckClient;
//# sourceMappingURL=flightdeckClient.js.map