/**
 * Gateway authentication: token-based bearer auth.
 *
 * When --auth token is set:
 *   - Generates a random token on first start, saves to ~/.flightdeck/gateway.token
 *   - All API requests must include Authorization: Bearer <token>
 *   - Token is printed on startup
 *
 * When --auth none: no authentication (for local dev)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FD_HOME } from '../constants.js';

const FD_DIR = FD_HOME;
const TOKEN_FILE = join(FD_DIR, 'gateway.token');

export type AuthMode = 'none' | 'token';

export function resolveToken(): string {
  if (!existsSync(FD_DIR)) mkdirSync(FD_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) {
    return readFileSync(TOKEN_FILE, 'utf-8').trim();
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export function readToken(): string | null {
  if (!existsSync(TOKEN_FILE)) return null;
  return readFileSync(TOKEN_FILE, 'utf-8').trim() || null;
}

/**
 * Create auth middleware function.
 * Returns null if request is authorized, or sends 401 and returns true if not.
 */
export function createAuthCheck(mode: AuthMode, token: string | null): (req: IncomingMessage, res: ServerResponse) => boolean {
  if (mode === 'none' || !token) {
    return () => false; // always authorized
  }

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    // Allow health endpoint without auth
    const url = req.url ?? '/';
    if (url === '/health' || url === '/health/') return false;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Provide Authorization: Bearer <token> header.' }));
      return true; // blocked
    }
    return false; // authorized
  };
}
