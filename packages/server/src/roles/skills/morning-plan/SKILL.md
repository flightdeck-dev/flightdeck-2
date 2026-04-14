# Morning Plan

Generate a morning project briefing for the user.

## Steps
1. Use `flightdeck_status` to get current project state
2. Use `flightdeck_task_list` to find today's tasks (ready + running + blocked)
3. Check for pending decisions that need user input
4. Generate a concise morning plan

## Output Format
📋 **Morning Plan — {date}**

**Progress:** X/Y tasks (Z%)

**Today's Focus:**
- [top priority ready tasks]

**In Progress:**
- [currently running tasks]

**Blocked:**
- [items needing attention]

**Decisions Needed:**
- [pending decisions requiring user input]

Keep it concise — this is a daily briefing, not a report.
