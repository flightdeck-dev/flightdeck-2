---
name: task-workflow
description: The claim → execute → submit workflow for tasks
---

# Task Workflow

## Standard Flow

1. **Check tasks**: `flightdeck_task_list()` — find tasks in `ready` state
2. **Claim**: `flightdeck_task_claim(taskId)` — marks the task as yours
3. **Read context**: Check `.flightdeck/tasks/<taskId>.md` for full task details
4. **Execute**: Do the work using your own tools (read/write/exec)
5. **Submit**: `flightdeck_task_submit(taskId, claim, files)` — structured result
6. **Handle review**: If reviewer sends feedback, address it and re-submit

## Submission Format

When submitting, provide:
- **claim**: What you did (concise summary)
- **files**: List of files you created or modified

Be honest in your claim. A reviewer will check whether your claim matches reality.

## If Stuck

- Re-read the task description and spec
- Search project memory: `flightdeck_memory_search(query)`
- Check if a dependency task has relevant output
- If truly stuck: `flightdeck_escalate(reason)` — don't spin

## Review Feedback

When you receive review feedback:
1. Read the feedback carefully
2. Address each point
3. Re-submit with updated claim and files
4. Don't argue with the reviewer — fix the issues
