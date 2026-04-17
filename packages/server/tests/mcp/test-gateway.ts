import { createServer, type Server } from 'node:http';
import { Flightdeck } from '../../src/facade.js';
import { createHttpServer, type HttpServerDeps } from '../../src/api/HttpServer.js';
import { ProjectManager } from '../../src/projects/ProjectManager.js';

/**
 * Start a test HTTP server wrapping a Flightdeck instance.
 * Returns the port and a close function.
 */
export async function startTestGateway(fd: Flightdeck, projectName: string): Promise<{ port: number; close: () => void }> {
  // Create a minimal ProjectManager that returns our fd instance
  const pm = {
    list: () => [projectName],
    get: (name: string) => name === projectName ? fd : undefined,
    create: () => {},
    delete: () => false,
  } as unknown as ProjectManager;

  const httpServer = createHttpServer({
    projectManager: pm,
    leadManagers: new Map(),
    port: 0,
    corsOrigin: '*',
    wsServers: new Map(),
  });

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => httpServer.close(),
      });
    });
  });
}
