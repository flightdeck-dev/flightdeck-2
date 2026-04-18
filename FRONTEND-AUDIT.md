# Flightdeck 2.0 Frontend Audit Report

**Date:** 2026-04-18
**Auditor:** Claw (automated, Vercel React Best Practices guidelines)
**Scope:** `packages/web/src/` — 23 files, ~5,200 LOC

---

## Executive Summary

The Flightdeck frontend is a well-structured Vite + React SPA with good foundations: lazy-loaded routes, proper error boundaries, WebSocket-driven real-time updates, and a clean context-based architecture. However, the codebase has several performance and maintainability issues, primarily around **a monolithic context provider causing unnecessary re-renders**, **useEffect-based data fetching without caching**, **missing memoization**, and **large components that should be split**. The most impactful improvements would be adopting SWR/React Query for data fetching and splitting the FlightdeckProvider into focused contexts.

**Summary by severity:**
- **CRITICAL:** 3 findings
- **HIGH:** 8 findings
- **MEDIUM:** 12 findings
- **LOW:** 7 findings

---

## CRITICAL

### C1. God Context — FlightdeckProvider causes cascading re-renders
- **File:** `hooks/useFlightdeck.tsx` (entire file)
- **Rule:** `rerender-derived-state`, `rerender-defer-reads`
- **Problem:** A single context holds ~15 state values (projects, status, tasks, agents, decisions, messages, streaming state, display config, connection status). **Every** WebSocket event triggers `setState` calls that re-render **every** consumer — even pages that don't use the changed data. For example, the `Decisions` page re-renders on every chat stream chunk.
- **Fix:** Split into multiple focused contexts:
  - `ProjectContext` (projects, projectName, status)
  - `TaskContext` (tasks)
  - `AgentContext` (agents, agentOutputs, agentStreamChunks)
  - `ChatContext` (messages, streamingMessages, streamingChunks, toolCallMap)
  - `DisplayContext` (displayConfig, setDisplayConfig, applyDisplayPreset)
  - `ConnectionContext` (connected, wsClient)
- **Effort:** ~4-6 hours

### C2. No data fetching library — raw useEffect + fetch everywhere
- **Files:** `hooks/useFlightdeck.tsx:89-103`, `pages/Cron.tsx:53-59`, `pages/Specs.tsx:26-33`, `pages/Roles.tsx:48-50`, `pages/Settings.tsx:119-145`, `pages/Agents.tsx:112-116`, `pages/Dashboard.tsx:84-88`, `components/Sidebar.tsx:194-196`
- **Rule:** `client-swr-dedup`
- **Problem:** All API data is fetched via raw `useEffect` + `fetch`/`api.*` calls with no caching, deduplication, or stale-while-revalidate. When multiple components mount simultaneously (e.g., Sidebar + Layout + Page), the same endpoints get hit multiple times. There's no background revalidation — data goes stale after initial load.
- **Fix:** Adopt **SWR** or **TanStack Query** for all read operations. The `api` module already provides clean functions — just wrap them:
  ```ts
  const { data: tasks } = useSWR(projectName ? ['tasks', projectName] : null, () => api.getTasks(projectName!));
  ```
- **Effort:** ~6-8 hours (systematic replacement across all pages)

### C3. WebSocket event handler has stale closure over `displayConfig`
- **File:** `hooks/useFlightdeck.tsx:119` — the `useEffect` for WS subscription
- **Rule:** `rerender-dependencies`, `advanced-event-handler-refs`
- **Problem:** The WS subscription effect has `[]` as deps but reads `displayConfig` inside the `chat:message` handler (line ~128: `displayConfig.flightdeckTools === 'detail'`). This closure captures the **initial** displayConfig and never updates. Changing display settings won't affect message filtering until reconnect.
- **Fix:** Use a ref for displayConfig inside the WS handler:
  ```ts
  const displayConfigRef = useRef(displayConfig);
  displayConfigRef.current = displayConfig;
  // In handler: displayConfigRef.current.flightdeckTools
  ```
- **Effort:** 15 minutes

---

## HIGH

### H1. fetchAll depends on displayConfig but it's excluded from deps
- **File:** `hooks/useFlightdeck.tsx:89-103`
- **Rule:** `rerender-dependencies`
- **Problem:** `fetchAll` uses `displayConfig.flightdeckTools` to decide `author_types` param, but the `useCallback` only depends on `[projectName]`. Changing display mode doesn't refetch messages with updated filtering.
- **Fix:** Add `displayConfig.flightdeckTools` to `fetchAll`'s dependency array, or move the filter logic to the consumer side.
- **Effort:** 15 minutes

### H2. Streaming creates new Map objects on every rAF tick
- **File:** `hooks/useFlightdeck.tsx:155-160`
- **Rule:** `rerender-memo`
- **Problem:** Every `requestAnimationFrame` callback creates 5 new `Map` instances via `new Map(ref.current)`. During active streaming, this happens ~60 times/second. Each `new Map()` triggers React state updates and re-renders for ALL context consumers.
- **Fix:** Batch all streaming state into a single `streamingState` object and use a single `setState`. Or use `useSyncExternalStore` with a streaming store.
- **Effort:** 2-3 hours

### H3. Markdown component is not memoized
- **File:** `components/Markdown.tsx`
- **Rule:** `rerender-memo`
- **Problem:** `Markdown` re-renders on every parent re-render, re-parsing markdown content even when `content` hasn't changed. `ReactMarkdown` is expensive — it runs remark/rehype pipelines.
- **Fix:** Wrap with `memo`:
  ```ts
  export const Markdown = memo(function Markdown({ content }: { content: string }) { ... });
  ```
- **Effort:** 5 minutes

### H4. AUTHOR_STYLES creates JSX elements at module level
- **File:** `pages/Chat.tsx:10-14`
- **Rule:** `rendering-hoist-jsx` (partial — the JSX is hoisted, which is good, but it's recreated each render when used inline)
- **Problem:** The icon JSX in `AUTHOR_STYLES` is created once at module level, which is fine. But the real issue is that `MessageBubble` computes a multi-line `title` string on every render via an IIFE (line ~87-95). This runs for every message on every re-render.
- **Fix:** Memoize the tooltip computation or extract it to a helper that reads from a stable reference.
- **Effort:** 20 minutes

### H5. Chat page has too many useState calls — 14 independent states
- **File:** `pages/Chat.tsx:290-305`
- **Rule:** `rerender-split-combined-hooks`
- **Problem:** The `Chat` component has 14 `useState` calls plus multiple `useEffect` and `useRef`. This makes the component hard to reason about and increases re-render surface area. Some states are related (search: `searchQuery`, `showSearch`, `searchIdx`).
- **Fix:** Group related states with `useReducer` or extract custom hooks:
  - `useSearchState()` — query, visible, index, matches
  - `useSpeechRecognition()` — isListening, speechLang, recognition
  - `useChatInput()` — input, replyTo, waitingForLead
- **Effort:** 2-3 hours

### H6. Threads fetched with stale closure — empty deps
- **File:** `pages/Chat.tsx:321`
- **Rule:** `rerender-dependencies`
- **Problem:** `useEffect(() => { if (projectName) api.getThreads(projectName).then(setThreads)... }, [])` — the dependency array is empty but uses `projectName`. If the project changes, threads aren't refetched.
- **Fix:** Add `projectName` to deps.
- **Effort:** 5 minutes

### H7. Multiple useEffect calls in Settings page fire N requests on mount
- **File:** `pages/Settings.tsx:119-145` (GlobalSettings)
- **Rule:** `async-parallel`
- **Problem:** The `GlobalSettings` component has a large `useEffect` that chains: fetch projects → pick first → fetch runtimes → auto-test all runtimes serially in a loop. This creates a waterfall and fires N+2 sequential requests.
- **Fix:** Use `Promise.all` for runtime tests. Better yet, add a server endpoint that tests all runtimes in one call.
- **Effort:** 30 minutes (client-side fix)

### H8. AgentDetailPanel fetches data in useEffect with stale deps
- **File:** `pages/Agents.tsx:112-116`, `pages/Agents.tsx:120-126`
- **Rule:** `rerender-dependencies`
- **Problem:** Two `useEffect` calls use empty `[]` deps but reference `projectName`. The historical output effect also depends on `liveOutput` and `liveChunks.length` but doesn't refetch when agent changes if those values happen to match.
- **Fix:** Add proper dependencies: `[agent.id, projectName]` for historical output; `[projectName]` for available models.
- **Effort:** 10 minutes

---

## MEDIUM

### M1. No `key` optimization on filtered message lists
- **File:** `pages/Chat.tsx:407-409`
- **Rule:** `rendering-conditional-render`
- **Problem:** `filteredMessages` is recomputed via `useMemo` correctly, but the message list doesn't use virtualization. With 500 messages (MAX_MESSAGES), rendering all `MessageBubble` components is expensive.
- **Fix:** Use `react-window` or `@tanstack/react-virtual` for the message list.
- **Effort:** 2-3 hours

### M2. `new Date().toLocaleTimeString()` called on every render per message
- **Files:** `pages/Chat.tsx:103`, `pages/Dashboard.tsx:183`
- **Rule:** `js-cache-function-results`
- **Problem:** Date formatting is called inline in JSX for every message on every render. `toLocaleTimeString` is relatively expensive.
- **Fix:** Memoize formatted dates or compute them once when the message is received.
- **Effort:** 30 minutes

### M3. Default non-primitive props not hoisted
- **Files:** Multiple — `streamingChunks.get(id) ?? []` in Chat.tsx, `agentStreamChunks.get(selectedAgent.id) ?? []` in Agents.tsx
- **Rule:** `rerender-memo-with-default-value`
- **Problem:** Fallback `[]` creates a new array reference on every render, defeating any memo comparisons downstream.
- **Fix:** Hoist empty arrays: `const EMPTY_CHUNKS: StreamChunk[] = [];` at module level.
- **Effort:** 10 minutes

### M4. Inline arrow functions in event handlers create new references
- **Files:** Throughout — `onChange={e => setName(e.target.value)}`, `onClick={() => setShowCreate(true)}`, etc.
- **Rule:** `rerender-functional-setstate`
- **Problem:** While React handles this fine for DOM elements, these inline handlers on custom components prevent `memo` from working.
- **Fix:** For hot paths (message list items), use `useCallback`. For form inputs, this is acceptable.
- **Effort:** 1 hour (selective)

### M5. `lucide-react` barrel import
- **File:** Every page and component file
- **Rule:** `bundle-barrel-imports`
- **Problem:** Imports like `import { Bot, Crown, User, Settings, Send, ... } from 'lucide-react'` — lucide-react uses barrel exports. While Vite's tree-shaking handles this, build times suffer.
- **Fix:** Use direct imports: `import { Bot } from 'lucide-react/dist/esm/icons/bot'` or configure the bundler alias. Alternatively, verify Vite's tree-shaking is effective via `npx vite-bundle-visualizer`.
- **Effort:** 30 minutes to verify; 2 hours if direct imports needed

### M6. Sidebar fetches archived projects on every `projects` change
- **File:** `components/Sidebar.tsx:194-196`
- **Rule:** `client-swr-dedup`
- **Problem:** `useEffect` with `[projects]` dep fetches `/api/projects/archived` every time projects array changes (which happens on every WS `state:update` event).
- **Fix:** Use SWR with appropriate revalidation interval, or debounce the fetch.
- **Effort:** 15 minutes

### M7. SearchDialog debounce timer not cleaned up properly
- **File:** `components/SearchDialog.tsx:30-47`
- **Rule:** `rerender-move-effect-to-event`
- **Problem:** The debounce uses `useEffect` with cleanup, but the `setLoading(true)` fires immediately before the debounce, causing a flash of "Searching..." state.
- **Fix:** Move `setLoading(true)` inside the timeout callback.
- **Effort:** 5 minutes

### M8. ProjectItem in Sidebar has inline state mutation
- **File:** `components/Sidebar.tsx:76`
- **Rule:** `rerender-derived-state-no-effect`
- **Problem:** `if (isActive && !expanded) setExpanded(true);` — this is a state update during render, which triggers an extra re-render. React will handle it but it's an anti-pattern.
- **Fix:** Use derived state: make `expanded` default to `isActive`, or use `useEffect` to sync.
- **Effort:** 10 minutes

### M9. DisplaySettings dialog doesn't trap focus
- **File:** `components/DisplaySettings.tsx`
- **Rule:** Accessibility
- **Problem:** The modal dialog renders with `role="dialog"` and `aria-modal="true"` but doesn't implement focus trapping. Keyboard users can tab to elements behind the overlay.
- **Fix:** Use a focus trap library (`focus-trap-react`) or implement manual focus management.
- **Effort:** 30 minutes

### M10. Multiple modal implementations with inconsistent patterns
- **Files:** `pages/Tasks.tsx` (CreateTaskModal), `pages/Cron.tsx` (CreateCronModal), `pages/Roles.tsx` (CreateRoleModal), `components/Sidebar.tsx` (CreateProjectModal)
- **Rule:** Composition patterns — extract shared components
- **Problem:** 4 separate modal implementations with similar backdrop, close-on-click-outside, and layout patterns. None have focus trapping or proper `aria-*` attributes (except DisplaySettings).
- **Fix:** Create a shared `<Modal>` compound component with proper accessibility.
- **Effort:** 2 hours

### M11. `handleInputChange` in Chat recreates height calculation
- **File:** `pages/Chat.tsx:363-367`
- **Rule:** `rerender-move-effect-to-event`
- **Problem:** Not a re-render issue per se, but the textarea auto-resize reads `scrollHeight` on every keystroke, causing layout thrashing.
- **Fix:** Use `requestAnimationFrame` to batch the height calculation, or use CSS `field-sizing: content` (modern browsers).
- **Effort:** 10 minutes

### M12. Types have both camelCase and snake_case fields
- **File:** `lib/types.ts`
- **Rule:** N/A (maintainability)
- **Problem:** `Task` has both `assignedAgent` and `assigned_agent`, `dependsOn` and `depends_on`, `needsReview` and `needs_review`. Components check both: `agent.currentTask ?? agent.current_task`. This is error-prone.
- **Fix:** Normalize at the API boundary — transform snake_case to camelCase in the `api` module.
- **Effort:** 1-2 hours

---

## LOW

### L1. `remarkGfm` plugin array recreated on every render
- **File:** `components/Markdown.tsx:84`
- **Rule:** `rerender-memo-with-default-value`
- **Problem:** `remarkPlugins={[remarkGfm]}` creates a new array each render.
- **Fix:** Hoist: `const plugins = [remarkGfm];`
- **Effort:** 2 minutes

### L2. Regex in Chat speech detection not hoisted
- **File:** `pages/Chat.tsx:31`
- **Rule:** `js-hoist-regexp`
- **Problem:** `/[\u4e00-\u9fff]/.test(msg.content)` creates a new regex per call.
- **Fix:** `const CJK_RE = /[\u4e00-\u9fff]/;` at module level.
- **Effort:** 2 minutes

### L3. `window.confirm` and `window.alert` used for destructive actions
- **Files:** `components/Sidebar.tsx:69`, `pages/Cron.tsx:79`, `pages/Cron.tsx:85`
- **Rule:** UX best practice
- **Problem:** Browser-native dialogs block the main thread and look out of place in a polished UI.
- **Fix:** Create a custom confirmation dialog component.
- **Effort:** 1-2 hours

### L4. Global keydown listeners don't check for active modals
- **Files:** `pages/Chat.tsx:308-316`, `pages/Agents.tsx:147-151`, `components/Layout.tsx:59-64`
- **Rule:** Accessibility
- **Problem:** Multiple `Escape` key handlers registered globally. If a modal is open inside a page, pressing Escape may trigger both the modal close and a page-level action.
- **Fix:** Use `e.stopPropagation()` in modal handlers or check a context flag.
- **Effort:** 30 minutes

### L5. No `loading` or `error` states for many API calls
- **Files:** `pages/Agents.tsx:116` (getAvailableModels), `pages/Dashboard.tsx:84-88` (token usage fetch)
- **Rule:** UX robustness
- **Problem:** Many API calls silently swallow errors with `.catch(() => {})`. Users get no feedback on failure.
- **Fix:** Add error states and retry mechanisms (SWR adoption in C2 would solve this automatically).
- **Effort:** Covered by C2

### L6. CSS-in-JS via inline `style` in ErrorBoundary
- **File:** `components/ErrorBoundary.tsx`
- **Rule:** Consistency
- **Problem:** ErrorBoundary uses inline `style={{}}` while the rest of the app uses Tailwind. This is intentional (error boundaries should be self-contained), but the styles don't use CSS variables consistently.
- **Fix:** Low priority — this is a reasonable trade-off for error boundaries.
- **Effort:** N/A

### L7. `reactmarkdown` and `remark-gfm` are bundled for all pages
- **File:** `components/Markdown.tsx` (imported by Dashboard, Chat, Agents, Specs)
- **Rule:** `bundle-dynamic-imports`
- **Problem:** react-markdown + remark-gfm add ~40KB gzipped to the bundle. Pages that don't use Markdown (Tasks, Cron, Decisions) still pay the cost if they share a chunk.
- **Fix:** Verify code splitting is working. Since pages are already lazy-loaded, this may already be split correctly. Run `npx vite-bundle-visualizer` to confirm.
- **Effort:** 15 minutes to verify

---

## Recommended Priority Order

| # | Finding | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| C3 | Stale displayConfig closure in WS handler | Bug fix | 15 min | **Do first** |
| H6 | Threads stale deps | Bug fix | 5 min | **Do first** |
| H8 | Agent detail stale deps | Bug fix | 10 min | **Do first** |
| H1 | fetchAll stale deps | Bug fix | 15 min | **Do first** |
| H3 | Memoize Markdown | Quick win | 5 min | **Do second** |
| M3 | Hoist default empty arrays | Quick win | 10 min | **Do second** |
| L1 | Hoist remarkGfm array | Quick win | 2 min | **Do second** |
| L2 | Hoist CJK regex | Quick win | 2 min | **Do second** |
| C2 | Adopt SWR/React Query | Systemic | 6-8 hrs | **Sprint 1** |
| C1 | Split FlightdeckProvider | Systemic | 4-6 hrs | **Sprint 1** |
| H2 | Batch streaming state | Performance | 2-3 hrs | **Sprint 1** |
| H5 | Extract Chat sub-hooks | Maintainability | 2-3 hrs | **Sprint 2** |
| M10 | Shared Modal component | Maintainability | 2 hrs | **Sprint 2** |
| M12 | Normalize API types | Maintainability | 1-2 hrs | **Sprint 2** |
| M1 | Virtualize message list | Performance | 2-3 hrs | **Sprint 2** |

**Total estimated effort:** ~25-35 hours for all findings.
**Quick wins (< 1 hour total):** Fix C3, H1, H3, H6, H8, M3, L1, L2 — addresses 4 bugs and 4 performance issues.
