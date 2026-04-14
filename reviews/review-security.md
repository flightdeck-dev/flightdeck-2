# Flightdeck 2.0 — Security & Error Handling Review

**Reviewed:** 2026-04-14
**Scope:** `~/clawspace/flightdeck-2/packages/server/src/`

---

## Executive Summary

Flightdeck 2.0 is reasonably well-structured for a local-first orchestration tool. The biggest risks are around **auth defaults**, **process spawning**, and **file system access boundaries**. SQL injection risk is low due to Drizzle ORM. Error handling is generally present but has gaps in the async fire-and-forget paths.

---

## 1. Authentication & Authorization

### 1.1 Auth is OFF by default — **HIGH**
**File:** `src/cli/gateway-lifecycle.ts` (line ~`gatewayRun`)
```ts
const authMode: AuthMode = (opts.auth ?? 'none') as AuthMode;
```
Default is `--auth none`. The warning for non-loopback without auth is stderr-only and non-blocking. Anyone on the network can control agent spawning, task management, and read project data.

**Recommendation:** Default to `--auth token` when `--bind lan` or `--bind 0.0.0.0` is used. Or at minimum, require `--auth none` to be explicit when binding non-loopback.

### 1.2 CORS default is wildcard — **MEDIUM**
**File:** `src/cli/gateway-lifecycle.ts`
```ts
corsOrigin: opts.corsOrigin ?? '*',
```
Combined with no auth, any website can make API calls to the gateway via the browser.

**File:** `src/api/HttpServer.ts`
```ts
res.setHeader('Access-Control-Allow-Origin', corsOrigin);
```

**Recommendation:** Default CORS to `http://localhost:*` patterns only.

### 1.3 Health endpoint bypasses auth (intentional but noted) — **LOW**
**File:** `src/cli/gateway/auth.ts`
```ts
if (url === '/health' || url === '/health/') return false;
```
Acceptable for health checks, but leaks project names.

### 1.4 WebSocket connections have no auth — **HIGH**
**File:** `src/cli/gateway.ts`
```ts
wss.on('connection', (socket, req) => {
  // No auth check here
  const wsUrl = new URL(req.url ?? '/', ...);
```
HTTP endpoints have optional auth, but WebSocket upgrade has zero authentication even when `--auth token` is set.

**Recommendation:** Check bearer token in WS handshake (query param or `Sec-WebSocket-Protocol` header).

### 1.5 MCP tool permissions are role-based but agent IDs are self-asserted — **MEDIUM**
**File:** `src/mcp/server.ts`
```ts
const _ENV_AGENT_ID = process.env.FLIGHTDECK_AGENT_ID || undefined;
```
Agents self-report their ID via `agentId` parameter in MCP tool calls. A compromised agent process could claim to be any agent ID. The `resolveAgent` function trusts whatever ID is passed.

**Recommendation:** For ACP-spawned agents, validate that the calling process's session matches the claimed agent ID.

---

## 2. SQL Injection & Database

### 2.1 Drizzle ORM parameterization — **LOW risk**
**File:** `src/storage/SqliteStore.ts`

All queries use Drizzle's `eq()`, `sql` template literals, or `insert().values()`. No string concatenation in queries. The `sql.raw()` calls are only used for DDL (CREATE TABLE, ALTER TABLE, PRAGMA) with hardcoded strings — no user input.

✅ No SQL injection vectors found.

### 2.2 Raw SQL in migrations is safe — **LOW**
All `sql.raw()` in `migrate()` uses static strings only.

---

## 3. Input Validation on API Endpoints

### 3.1 Project name validation — **GOOD**
**File:** `src/api/HttpServer.ts`
```ts
if (!/^[a-zA-Z0-9_-]+$/.test(name)) { json(400, { error: '...' }); return; }
```
Project creation validates name format. ✅

### 3.2 Project name in URL path is decoded but not validated — **MEDIUM**
**File:** `src/api/HttpServer.ts`
```ts
const projectName = decodeURIComponent(m[1]);
```
The `projectName` from URL is `decodeURIComponent`'d and passed to `projectManager.get()` which does a Map lookup. Not exploitable for injection, but path traversal in project names from URL isn't checked (Map lookup would just return null).

### 3.3 Body size limit — **GOOD**
```ts
const MAX_BODY = 1024 * 1024; // 1MB
```
Enforced on all POST/PUT endpoints. ✅

### 3.4 Missing validation on webhook URLs — **MEDIUM**
**File:** `src/api/HttpServer.ts` — `PUT /notifications`
```ts
if (!body.webhooks || !Array.isArray(body.webhooks)) { ... }
```
Webhooks array is validated as array, but individual webhook URLs are not validated. A user could set a webhook to an internal service URL (SSRF).

**File:** `src/integrations/WebhookNotifier.ts`
```ts
fetch(url, { method: 'POST', ... })
```
Fire-and-forget fetch to arbitrary URLs.

**Recommendation:** Validate webhook URLs against an allowlist of schemes (https only) and block private IP ranges.

### 3.5 `limit` parameter parsed but not bounded — **LOW**
```ts
const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
```
No upper bound. A huge limit could cause memory pressure on large datasets.

---

## 4. Process Spawning Security

### 4.1 Agent terminal commands — shell: true — **HIGH**
**File:** `src/agents/AcpAdapter.ts`
```ts
const child = cpSpawn(params.command, params.args ?? [], {
  cwd,
  env,
  shell: true,
});
```
Terminal creation uses `shell: true`, meaning agent-provided commands are shell-interpreted. A compromised agent can execute arbitrary shell commands.

**Mitigation exists:** Lead role is restricted to read-only commands:
```ts
const allowedLeadCmds = ['cat', 'ls', 'find', 'grep', 'head', 'tail', 'wc', 'echo', 'flightdeck'];
```
But this check is bypassable: `cat /etc/passwd; rm -rf /` would pass because it starts with `cat`. The check uses `cmd.startsWith(c)`.

**Recommendation:** Use a proper command parser or disallow `shell: true` entirely. At minimum, reject commands containing shell metacharacters (`;`, `|`, `&`, `$`, `` ` ``).

### 4.2 Worker agents have unrestricted terminal access — **MEDIUM**
Only `lead` role has command restrictions. Workers can run any command. This is likely by design (workers need to code), but worth documenting as an accepted risk.

### 4.3 Agent environment inherits full process.env — **MEDIUM**
**File:** `src/agents/AcpAdapter.ts`
```ts
const spawnEnv = {
  ...process.env,
  FLIGHTDECK_AGENT_ID: aid,
  ...
};
```
Spawned agents inherit all environment variables from the gateway, which may include API keys, tokens, or other secrets.

**Recommendation:** Allowlist environment variables passed to agent processes.

### 4.4 Agent-provided env vars in terminal creation — **MEDIUM**
```ts
if (params.env) {
  for (const { name, value } of params.env) {
    env[name] = value;
  }
}
```
Agents can override any environment variable (including `PATH`, `LD_PRELOAD`, etc.) for terminal processes.

---

## 5. File System Access Safety

### 5.1 writeTextFile role restriction is good but bypassable — **MEDIUM**
**File:** `src/agents/AcpAdapter.ts`
```ts
const rel = path.relative(session.cwd, filePath);
const isAllowed = rel.startsWith('.flightdeck') || rel.startsWith('memory') || rel.endsWith('.md');
```
Lead/planner can only write to `.flightdeck/`, `memory/`, and `.md` files. However:
- `path.relative()` with `..` traversal: if `filePath` resolves outside `session.cwd`, `rel` starts with `..` which doesn't match any allowed prefix. ✅ Safe.
- But `foo.md` anywhere in the tree is writable (e.g., `../../important.md`). Wait — `rel` would be `../../important.md` which doesn't start with `.flightdeck` or `memory` but DOES end with `.md`. So lead could write to `../../important.md`. **This is a path traversal issue.**

**Recommendation:** Check that `rel` doesn't start with `..` before allowing the write.

### 5.2 readTextFile has no path restrictions — **LOW**
Any agent can read any file the gateway process has access to. By design for coding agents, but notable.

### 5.3 AGENTS.md and .mcp.json written to agent cwd — **LOW**
**File:** `src/agents/AgentManager.ts`
```ts
writeFileSync(`${effectiveCwd}/AGENTS.md`, agentsMd);
writeFileSync(`${effectiveCwd}/.mcp.json`, mcpJson);
```
Uses `writeFileSync` without checking if `effectiveCwd` is valid. If isolation fails silently, this writes to the project root, which is expected.

---

## 6. Error Handling

### 6.1 Uncaught async errors in fire-and-forget paths — **MEDIUM**
**File:** `src/api/HttpServer.ts`
```ts
leadManager.steerLead({ ... }).then(raw => { ... }).catch(err => {
  console.error('Failed to steer Lead (async):', ...);
});
```
Good — async paths have `.catch()`. ✅

### 6.2 Global uncaughtException handler — **GOOD**
**File:** `src/cli/gateway.ts`
```ts
process.on('uncaughtException', (err) => {
  // Best-effort state save on crash
  ...
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('\nUnhandled rejection (non-fatal):', reason);
  // Don't crash
});
```
✅ Both are handled. Unhandled rejections are logged but non-fatal (correct for transient network errors).

### 6.3 Silent catch blocks — **LOW**
Multiple `catch {}` blocks (empty catch) throughout `AgentManager.ts` and `AcpAdapter.ts`. These are mostly for "best effort" cleanup operations and are acceptable, but make debugging harder.

### 6.4 ensureModules() in request handler — **MEDIUM**
**File:** `src/api/HttpServer.ts`
```ts
const httpServer = createServer(async (req, res) => {
    await ensureModules();
```
Every request awaits dynamic imports. If an import fails, the error propagates as an unhandled rejection (no try/catch around it). The first failure would crash subsequent requests too since `modelCfg` would remain null.

**Recommendation:** Wrap `ensureModules()` in try/catch and return 500 on failure.

### 6.5 MCP server error handling — **GOOD**
**File:** `src/mcp/server.ts`
All tool handlers use try/catch with descriptive error messages. ✅

---

## 7. Secret & Credential Handling

### 7.1 Auth token storage — **GOOD**
**File:** `src/cli/gateway/auth.ts`
```ts
writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
```
Token file has restrictive permissions. ✅

### 7.2 Token printed to stderr on startup — **LOW**
```ts
console.error(`Auth: token (${token})`);
```
Token is printed in full on startup. Acceptable for local tooling but could leak in CI logs.

### 7.3 Auth token in CLI args — **LOW**
**File:** `src/cli/gateway-lifecycle.ts`
```ts
if (opts.token) args.push('--token', opts.token);
```
Token passed as CLI argument is visible in `ps` output. The `resolveToken()` file-based approach is better.

---

## 8. Webhook SSRF Risk — **MEDIUM**
**File:** `src/integrations/WebhookNotifier.ts`

The notifier sends HTTP POST to user-configured URLs with no validation. Could be used to:
- Probe internal services
- Send requests to cloud metadata endpoints (169.254.169.254)
- Exfiltrate data via DNS/HTTP

**Recommendation:** Validate URLs, block private/link-local IPs, require HTTPS.

---

## Summary Table

| # | Issue | Severity | File |
|---|-------|----------|------|
| 1.1 | Auth off by default | HIGH | `cli/gateway-lifecycle.ts` |
| 1.4 | WebSocket has no auth | HIGH | `cli/gateway.ts` |
| 4.1 | Shell injection via terminal (bypassable lead check) | HIGH | `agents/AcpAdapter.ts` |
| 1.2 | CORS wildcard default | MEDIUM | `cli/gateway-lifecycle.ts` |
| 1.5 | Self-asserted agent IDs | MEDIUM | `mcp/server.ts` |
| 3.4 | No webhook URL validation (SSRF) | MEDIUM | `integrations/WebhookNotifier.ts` |
| 4.3 | Full env inheritance to agents | MEDIUM | `agents/AcpAdapter.ts` |
| 4.4 | Agent-controlled env vars | MEDIUM | `agents/AcpAdapter.ts` |
| 5.1 | Lead .md write allows path traversal | MEDIUM | `agents/AcpAdapter.ts` |
| 6.4 | No try/catch on ensureModules() | MEDIUM | `api/HttpServer.ts` |
| 8 | Webhook SSRF | MEDIUM | `integrations/WebhookNotifier.ts` |
| 1.3 | Health leaks project names | LOW | `cli/gateway/auth.ts` |
| 3.5 | Unbounded limit param | LOW | `api/HttpServer.ts` |
| 4.2 | Workers have full terminal access | LOW (by design) |  |
| 6.3 | Silent catch blocks | LOW | Multiple |
| 7.2 | Token in stderr | LOW | `cli/gateway-lifecycle.ts` |
| 7.3 | Token in CLI args | LOW | `cli/gateway-lifecycle.ts` |

**Top 3 to fix:**
1. WebSocket auth bypass (1.4) — simple fix, check token on upgrade
2. Shell command injection in lead terminal check (4.1) — parse properly or reject metacharacters
3. Lead writeTextFile path traversal via `.md` suffix (5.1) — check `rel` doesn't start with `..`
