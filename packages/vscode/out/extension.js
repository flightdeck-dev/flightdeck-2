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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const flightdeckClient_1 = require("./flightdeckClient");
const taskTreeProvider_1 = require("./taskTreeProvider");
const agentTreeProvider_1 = require("./agentTreeProvider");
const statusBar_1 = require("./statusBar");
const commands_1 = require("./commands");
function activate(context) {
    const outputChannel = vscode.window.createOutputChannel("Flightdeck");
    const client = new flightdeckClient_1.FlightdeckClient(outputChannel);
    // Tree views
    const taskTree = new taskTreeProvider_1.TaskTreeProvider(client);
    const agentTree = new agentTreeProvider_1.AgentTreeProvider(client);
    context.subscriptions.push(vscode.window.registerTreeDataProvider("flightdeck.tasks", taskTree), vscode.window.registerTreeDataProvider("flightdeck.agents", agentTree));
    // Status bar
    const statusBar = new statusBar_1.StatusBar(client);
    statusBar.startPolling(10000);
    context.subscriptions.push({ dispose: () => statusBar.dispose() });
    // Commands
    (0, commands_1.registerCommands)(context, client, taskTree, agentTree, outputChannel);
    // Initial data load
    taskTree.refresh();
    agentTree.refresh();
    outputChannel.appendLine("Flightdeck extension activated.");
}
function deactivate() {
    // cleanup handled by disposables
}
//# sourceMappingURL=extension.js.map