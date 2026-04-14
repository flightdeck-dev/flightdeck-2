# Evening Summary

Generate an end-of-day project summary.

## Steps
1. Use `flightdeck_status` for overall progress
2. Use `flightdeck_task_list` to find tasks completed today
3. Identify carry-over items for tomorrow
4. Log summary to daily memory via `flightdeck_memory_log`

## Output Format
📊 **Evening Summary — {date}**

**Completed Today:**
- ✅ [done tasks]

**Key Events:**
- [important things that happened]

**Tomorrow:**
- [carry-over + next priorities]

**Cost:** $X.XX total

⚠️ **Needs Your Input:**
- [anything blocked on user decision — highlight these]

Always end with items needing user attention.
