import * as vscode from "vscode";
import { FlightdeckClient } from "./flightdeckClient";
import { TaskTreeProvider } from "./taskTreeProvider";
import { AgentTreeProvider } from "./agentTreeProvider";
export declare function registerCommands(context: vscode.ExtensionContext, client: FlightdeckClient, taskTree: TaskTreeProvider, agentTree: AgentTreeProvider, outputChannel: vscode.OutputChannel): void;
