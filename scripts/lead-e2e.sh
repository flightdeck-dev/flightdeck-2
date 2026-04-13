#!/usr/bin/env bash
# lead-e2e.sh — Live Lead E2E test
#
# Tests the full Lead → MCP → SQLite loop with a real Copilot CLI process.
# Requires: gateway NOT already running on :3000
#
# Usage:
#   ./scripts/lead-e2e.sh              # full run
#   ./scripts/lead-e2e.sh --skip-boot  # skip gateway startup (assumes already running)
#
# What it tests:
#   1. Gateway boots, idle projects skip Lead/Planner
#   2. Lead sees correct project via flightdeck_status
#   3. Lead can list tasks via flightdeck_task_list
#   4. Lead can create a spec via flightdeck_spec_create
#   5. Lead can batch-create tasks with deps via flightdeck_declare_tasks
#   6. Lead can write to project memory via flightdeck_memory_write
#   7. Lead provides UX feedback (qualitative, logged)
#
# Exit codes: 0 = all pass, 1 = failure

set -euo pipefail

PROJECT="e2e-live"
BASE_URL="http://localhost:3000"
API="$BASE_URL/api/projects/$PROJECT"
GATEWAY_LOG="/tmp/fd-e2e-gateway.log"
SKIP_BOOT="${1:-}"
PASS=0
FAIL=0
RESULTS=()

# ── Helpers ──

green()  { printf '\033[32m%s\033[0m\n' "$1"; }
red()    { printf '\033[31m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

log() { echo "  → $1"; }

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    green "  ✓ $label"
    PASS=$((PASS + 1))
    RESULTS+=("✓ $label")
  else
    red "  ✗ $label (expected '$needle')"
    FAIL=$((FAIL + 1))
    RESULTS+=("✗ $label")
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if ! echo "$haystack" | grep -q "$needle"; then
    green "  ✓ $label"
    PASS=$((PASS + 1))
    RESULTS+=("✓ $label")
  else
    red "  ✗ $label (should NOT contain '$needle')"
    FAIL=$((FAIL + 1))
    RESULTS+=("✗ $label")
  fi
}

# Send async message, poll for Lead reply, return response content
send_and_wait() {
  local content="$1"
  local timeout="${2:-120}"  # seconds
  
  # Send async
  local send_result
  send_result=$(curl -sf -X POST "${API}/messages?async=true" \
    -H 'Content-Type: application/json' \
    -d "{\"content\": \"$content\"}" 2>&1) || {
    echo "ERROR: Failed to send message"
    return 1
  }
  
  local msg_id
  msg_id=$(echo "$send_result" | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['id'])" 2>/dev/null) || {
    echo "ERROR: Could not parse message ID from: $send_result"
    return 1
  }
  
  # Poll for reply
  local elapsed=0
  local interval=5
  while [ $elapsed -lt $timeout ]; do
    sleep $interval
    elapsed=$((elapsed + interval))
    
    local reply
    reply=$(curl -sf "${API}/messages?limit=5" 2>/dev/null | python3 -c "
import sys, json
msgs = json.load(sys.stdin)
for m in msgs:
    if m.get('authorType') == 'lead' and m.get('parentId') == '$msg_id':
        print(m['content'])
        break
" 2>/dev/null) || true
    
    if [ -n "$reply" ]; then
      echo "$reply"
      return 0
    fi
  done
  
  echo "TIMEOUT: No Lead reply after ${timeout}s"
  return 1
}

cleanup() {
  if [ "$SKIP_BOOT" != "--skip-boot" ]; then
    log "Stopping gateway..."
    pkill -f "gateway run" 2>/dev/null || true
    pkill -f "copilot.*acp" 2>/dev/null || true
    sleep 2
  fi
}
trap cleanup EXIT

# ── Phase 0: Prepare ──

echo ""
echo "═══════════════════════════════════════════"
echo "  Flightdeck Lead E2E Test"
echo "═══════════════════════════════════════════"
echo ""

# Clean the test project
log "Preparing project: $PROJECT"
sqlite3 ~/.flightdeck/projects/$PROJECT/state.sqlite "DELETE FROM tasks; DELETE FROM agents;" 2>/dev/null || true
# Ensure project exists
mkdir -p ~/.flightdeck/projects/$PROJECT
if [ ! -f ~/.flightdeck/projects/$PROJECT/config.json ]; then
  echo '{"name":"e2e-live","governance":"autonomous","isolation":"none","onCompletion":"ask"}' > ~/.flightdeck/projects/$PROJECT/config.json
fi

# Add a seed task so the project is active (Lead will spawn)
sqlite3 ~/.flightdeck/projects/$PROJECT/state.sqlite \
  "INSERT OR REPLACE INTO tasks (id, title, description, state, role, depends_on, priority, source, stale, created_at, updated_at)
   VALUES ('task-e2e-seed', 'E2E seed task', 'Seed task for E2E testing', 'ready', 'worker', '[]', 1, 'manual', 0, datetime('now'), datetime('now'));" 2>/dev/null

# ── Phase 1: Boot Gateway ──

if [ "$SKIP_BOOT" != "--skip-boot" ]; then
  echo ""
  echo "── Phase 1: Gateway Boot ──"
  
  # Kill existing
  pkill -f "gateway run" 2>/dev/null || true
  pkill -f "copilot.*acp" 2>/dev/null || true
  lsof -ti :3000 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 3
  
  log "Starting gateway..."
  cd ~/clawspace/flightdeck-2/packages/server
  nohup npx tsx src/cli/index.ts gateway run --no-recover > "$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID=$!
  
  # Wait for health
  for i in $(seq 1 30); do
    sleep 2
    if curl -sf "$BASE_URL/health" >/dev/null 2>&1; then
      green "  ✓ Gateway healthy (took ~$((i*2))s)"
      PASS=$((PASS + 1))
      RESULTS+=("✓ Gateway boots and responds to /health")
      break
    fi
    if [ $i -eq 30 ]; then
      red "  ✗ Gateway failed to start"
      cat "$GATEWAY_LOG"
      exit 1
    fi
  done
  
  # Check idle skip
  BOOT_LOG=$(cat "$GATEWAY_LOG")
  # Other projects (demo, default) should skip if they have no tasks
  # e2e-live should have Lead spawned
  assert_contains "e2e-live Lead spawned" "$BOOT_LOG" "e2e-live.*Lead spawned"
  
  # Wait for ACP initialization
  log "Waiting 75s for ACP sessions to initialize..."
  sleep 75
else
  echo ""
  echo "── Phase 1: Skipped (--skip-boot) ──"
  # Verify gateway is running
  curl -sf "$BASE_URL/health" >/dev/null 2>&1 || {
    red "Gateway not running on $BASE_URL"
    exit 1
  }
  green "  ✓ Gateway already running"
fi

# ── Phase 2: Lead Project Connectivity ──

echo ""
echo "── Phase 2: Project Connectivity ──"

log "Asking Lead for status..."
REPLY=$(send_and_wait "Run flightdeck_status. Tell me the project name and config." 120) || true

if [ -n "$REPLY" ]; then
  assert_contains "Lead replied" "$REPLY" "."
  assert_contains "Lead sees correct project" "$REPLY" "$PROJECT"
  assert_not_contains "Lead not on wrong project" "$REPLY" "\"name\": \"default\""
else
  red "  ✗ Lead did not reply to status check"
  FAIL=$((FAIL + 1))
  RESULTS+=("✗ Lead replied to status check")
fi

# ── Phase 3: Task Operations ──

echo ""
echo "── Phase 3: Task Operations ──"

log "Asking Lead to list tasks..."
REPLY=$(send_and_wait "Use flightdeck_task_list to list all tasks. Report what you find." 90) || true

if [ -n "$REPLY" ]; then
  assert_contains "Lead can list tasks" "$REPLY" "task"
  assert_contains "Lead sees seed task" "$REPLY" "seed"
else
  red "  ✗ Lead did not reply to task_list"
  FAIL=$((FAIL + 1))
  RESULTS+=("✗ Lead can list tasks")
fi

log "Asking Lead to create tasks with deps..."
REPLY=$(send_and_wait "Use flightdeck_declare_tasks to create 3 tasks: 1) Setup project structure, 2) Implement core logic (depends on #0), 3) Write tests (depends on #1). List the tasks after." 120) || true

if [ -n "$REPLY" ]; then
  assert_contains "Lead can declare tasks" "$REPLY" "Setup\|setup\|structure"
  assert_contains "Lead created dep chain" "$REPLY" "pending\|depends\|ready"
else
  red "  ✗ Lead did not reply to declare_tasks"
  FAIL=$((FAIL + 1))
  RESULTS+=("✗ Lead can declare tasks")
fi

# ── Phase 4: Spec & Memory ──

echo ""
echo "── Phase 4: Spec & Memory Operations ──"

log "Asking Lead to create a spec..."
REPLY=$(send_and_wait "Use flightdeck_spec_create to create a spec titled 'E2E Test App' with content describing a simple Node.js hello world app. Confirm what was created." 90) || true

if [ -n "$REPLY" ]; then
  assert_contains "Lead can create spec" "$REPLY" "creat\|spec\|E2E\|e2e"
else
  red "  ✗ Lead did not reply to spec_create"
  FAIL=$((FAIL + 1))
  RESULTS+=("✗ Lead can create spec")
fi

log "Asking Lead to write memory..."
REPLY=$(send_and_wait "Use flightdeck_memory_write to write a file called 'e2e-test-log.md' with content '# E2E Test\\nTest passed at $(date -u +%H:%M)'. Confirm it was written." 90) || true

if [ -n "$REPLY" ]; then
  assert_contains "Lead can write memory" "$REPLY" "writ\|memory\|e2e-test"
else
  red "  ✗ Lead did not reply to memory_write"
  FAIL=$((FAIL + 1))
  RESULTS+=("✗ Lead can write memory")
fi

# ── Phase 5: UX Feedback ──

echo ""
echo "── Phase 5: Lead UX Feedback ──"

log "Asking Lead for feedback..."
REPLY=$(send_and_wait "Quick feedback: Rate your MCP tool experience 1-10. What improved since last time? What still needs work? Be specific and honest." 120) || true

if [ -n "$REPLY" ]; then
  green "  ✓ Got Lead feedback"
  PASS=$((PASS + 1))
  RESULTS+=("✓ Lead provided UX feedback")
  echo ""
  echo "  ┌─────────────────────────────────┐"
  echo "  │ Lead's Feedback:                │"
  echo "  └─────────────────────────────────┘"
  echo "$REPLY" | sed 's/^/  │ /'
  echo ""
  
  # Save feedback
  mkdir -p ~/clawspace/flightdeck-2/e2e-results
  {
    echo "# Lead E2E Feedback — $(date -u +%Y-%m-%d_%H:%M)"
    echo ""
    echo "$REPLY"
  } > ~/clawspace/flightdeck-2/e2e-results/lead-feedback-$(date -u +%Y%m%d_%H%M).md
else
  red "  ✗ Lead did not provide feedback"
  FAIL=$((FAIL + 1))
  RESULTS+=("✗ Lead provided UX feedback")
fi

# ── Summary ──

echo ""
echo "═══════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "═══════════════════════════════════════════"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""

# Save results
mkdir -p ~/clawspace/flightdeck-2/e2e-results
{
  echo "# Lead E2E Results — $(date -u +%Y-%m-%d %H:%M UTC)"
  echo ""
  echo "Pass: $PASS | Fail: $FAIL"
  echo ""
  for r in "${RESULTS[@]}"; do
    echo "- $r"
  done
} > ~/clawspace/flightdeck-2/e2e-results/lead-e2e-$(date -u +%Y%m%d_%H%M).md

if [ $FAIL -gt 0 ]; then
  red "E2E FAILED"
  exit 1
else
  green "E2E PASSED ✓"
  exit 0
fi
