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
exports.StatusBar = void 0;
const vscode = __importStar(require("vscode"));
class StatusBar {
    item;
    client;
    timer;
    constructor(client) {
        this.client = client;
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.command = "workbench.action.quickOpen";
        this.item.text = "$(rocket) Flightdeck";
        this.item.tooltip = "Click to open Flightdeck commands";
        this.item.show();
    }
    startPolling(intervalMs = 5000) {
        this.update();
        this.timer = setInterval(() => this.update(), intervalMs);
    }
    async update() {
        try {
            const status = await this.client.getStatus();
            const done = status.tasks.filter((t) => t.state === "done").length;
            const total = status.tasks.length;
            const agents = status.agents.length;
            this.item.text = `$(rocket) ${status.project}: ${done}/${total} tasks · ${agents} agents`;
        }
        catch {
            this.item.text = "$(rocket) Flightdeck";
        }
    }
    dispose() {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.item.dispose();
    }
}
exports.StatusBar = StatusBar;
//# sourceMappingURL=statusBar.js.map