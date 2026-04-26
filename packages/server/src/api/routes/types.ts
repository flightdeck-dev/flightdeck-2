import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Flightdeck } from '../../facade.js';
import type { LeadManager } from '../../lead/LeadManager.js';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import type { AgentManager } from '../../agents/AgentManager.js';
import type { CronStore } from '../../cron/CronStore.js';
import type { WebhookNotifier } from '../../integrations/WebhookNotifier.js';
import type { WsBroadcaster } from '../HttpServer.js';

export interface GlobalRouteDeps {
  projectManager: ProjectManager;
  port: number;
  json: (status: number, body: unknown) => void;
  readBody: () => Promise<any>;
}

export interface ProjectRouteDeps {
  projectManager: ProjectManager;
  leadManagers: Map<string, LeadManager>;
  agentManagers?: Map<string, AgentManager>;
  wsServers: Map<string, WsBroadcaster>;
  webhookNotifiers?: Map<string, WebhookNotifier>;
  cronStores?: Map<string, CronStore>;
  onProjectSetup?: (projectName: string) => Promise<void>;
  modelCfgCache: Map<string, any>;
  json: (status: number, body: unknown) => void;
  readBody: () => Promise<any>;
  ensureModules: () => Promise<void>;
  getModelConfig: (fd: Flightdeck, projName: string) => Promise<any>;
  modRegistry: any;
  presetNames: string[];
  displayModule: any;
  serverDisplayConfig: any;
  setServerDisplayConfig: (cfg: any) => void;
}

export interface ProjectScopedDeps {
  fd: Flightdeck;
  projectName: string;
  wsServer: WsBroadcaster | undefined;
  leadManager: LeadManager | undefined;
  notifier: WebhookNotifier | undefined;
  agentManagers?: Map<string, AgentManager>;
  leadManagers: Map<string, LeadManager>;
  cronStores?: Map<string, CronStore>;
  modelCfgCache: Map<string, any>;
  json: (status: number, body: unknown) => void;
  readBody: () => Promise<any>;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  getModelConfig: (fd: Flightdeck, projName: string) => Promise<any>;
  modRegistry: any;
  presetNames: string[];
  displayModule: any;
  serverDisplayConfig: any;
  setServerDisplayConfig: (cfg: any) => void;
}
