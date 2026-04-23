/**
 * Lightweight gateway: only Lead, no Director (save memory)
 */
import { Flightdeck } from './packages/server/src/facade.ts';
import { AcpAdapter } from './packages/server/src/agents/AcpAdapter.ts';
import { LeadManager } from './packages/server/src/lead/LeadManager.ts';
import { createServer } from 'node:http';

const PROJECT = 'demo';
const PORT = 3000;

async function main() {
  const fd = new Flightdeck(PROJECT);
  
  // Clean stale agents
  for (const a of fd.listAgents()) {
    if (a.status === 'busy' || a.status === 'idle') {
      fd.sqlite.updateAgentStatus(a.id as any, 'offline');
    }
  }

  const acpAdapter = new AcpAdapter(undefined, 'copilot');
  const leadManager = new LeadManager({
    sqlite: fd.sqlite,
    project: fd.project,
    acpAdapter,
  });

  // Only spawn Lead (no Director to save memory)
  console.error('Spawning Lead only (no Director)...');
  const leadSession = await leadManager.spawnLead();
  console.error(`Lead spawned: ${leadSession}`);

  // Minimal HTTP server for chat
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);
    
    if (url.pathname === '/api/projects/demo/messages' && req.method === 'POST') {
      const body = await new Promise<string>(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
      const { content } = JSON.parse(body);
      
      res.setHeader('Content-Type', 'application/json');
      try {
        const response = await leadManager.steerLead({ type: 'user_message', message: { content, authorType: 'user', authorId: 'claw' } as any });
        res.end(JSON.stringify({ response: { content: response } }));
      } catch (err: any) {
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/projects/demo/tasks') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(fd.listTasks()));
    } else if (url.pathname === '/api/projects/demo/agents') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(fd.listAgents()));
    } else if (url.pathname === '/api/projects/demo/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(fd.status()));
    } else if (url.pathname === '/health') {
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.error(`HTTP listening on port ${PORT}`);
  });

  process.on('SIGINT', () => { acpAdapter.clear(); fd.close(); process.exit(0); });
  process.on('SIGTERM', () => { acpAdapter.clear(); fd.close(); process.exit(0); });
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
