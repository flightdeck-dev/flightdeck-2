import { join } from 'node:path';
import { homedir } from 'node:os';

/** Flightdeck 2 home directory. Separate from v1's ~/.flightdeck/ root. */
export const FD_HOME = join(homedir(), '.flightdeck', 'v2');

/** Default gateway port. Chosen to avoid common dev-server ports (3000, 8080, etc.). */
export const DEFAULT_PORT = 18800;

/** Environment variable to override the default port. */
export const PORT_ENV = 'FLIGHTDECK_PORT';
