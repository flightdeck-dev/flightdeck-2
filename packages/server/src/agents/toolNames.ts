/**
 * Canonical tool name constants shared between MCP server and CopilotSdkAdapter.
 * Single source of truth — if you add a tool, add the name here first.
 */
export const TOOL_NAMES = {
  // Task tools
  TASK_LIST: 'flightdeck_task_list',
  TASK_GET: 'flightdeck_task_get',
  TASK_CONTEXT: 'flightdeck_task_context',
  TASK_ADD: 'flightdeck_task_add',
  TASK_CLAIM: 'flightdeck_task_claim',
  TASK_SUBMIT: 'flightdeck_task_submit',
  TASK_FAIL: 'flightdeck_task_fail',
  TASK_CANCEL: 'flightdeck_task_cancel',
  TASK_PAUSE: 'flightdeck_task_pause',
  TASK_RESUME: 'flightdeck_task_resume',
  TASK_RETRY: 'flightdeck_task_retry',
  TASK_SKIP: 'flightdeck_task_skip',
  TASK_COMPLETE: 'flightdeck_task_complete',
  TASK_COMMENT: 'flightdeck_task_comment',
  TASK_REOPEN: 'flightdeck_task_reopen',
  TASK_COMPACT: 'flightdeck_task_compact',
  TASK_CLEAR_STALE: 'flightdeck_task_clear_stale',
  REVIEW_SUBMIT: 'flightdeck_review_submit',
  DECLARE_TASKS: 'flightdeck_declare_tasks',
  DECLARE_SUBTASKS: 'flightdeck_declare_subtasks',

  // Agent tools
  AGENT_LIST: 'flightdeck_agent_list',
  AGENT_SPAWN: 'flightdeck_agent_spawn',
  AGENT_TERMINATE: 'flightdeck_agent_terminate',
  AGENT_OUTPUT: 'flightdeck_agent_output',
  AGENT_HIBERNATE: 'flightdeck_agent_hibernate',
  AGENT_WAKE: 'flightdeck_agent_wake',
  AGENT_RETIRE: 'flightdeck_agent_retire',
  AGENT_RESTART: 'flightdeck_agent_restart',
  AGENT_INTERRUPT: 'flightdeck_agent_interrupt',

  // Communication
  SEND: 'flightdeck_send',
  READ: 'flightdeck_read',
  SEARCH: 'flightdeck_search',
  MSG_LIST: 'flightdeck_msg_list',
  THREAD_CREATE: 'flightdeck_thread_create',
  THREAD_LIST: 'flightdeck_thread_list',
  DISCUSS: 'flightdeck_discuss',

  // Memory
  MEMORY_READ: 'flightdeck_memory_read',
  MEMORY_WRITE: 'flightdeck_memory_write',
  MEMORY_LOG: 'flightdeck_memory_log',

  // Learnings
  LEARNING_ADD: 'flightdeck_learning_add',
  LEARNING_SEARCH: 'flightdeck_learning_search',

  // Decisions
  DECISION_LOG: 'flightdeck_decision_log',
  DECISION_LIST: 'flightdeck_decision_list',

  // Status & reporting
  STATUS: 'flightdeck_status',
  REPORT: 'flightdeck_report',
  COST_REPORT: 'flightdeck_cost_report',
  PLAN_REVIEW: 'flightdeck_plan_review',
  ESCALATE: 'flightdeck_escalate',
  ESCALATE_TO_HUMAN: 'flightdeck_escalate_to_human',

  // Roles
  ROLE_LIST: 'flightdeck_role_list',
  ROLE_INFO: 'flightdeck_role_info',

  // Models
  MODEL_LIST: 'flightdeck_model_list',
  MODEL_SET: 'flightdeck_model_set',
  MODEL_CONFIG: 'flightdeck_model_config',

  // Specs
  SPEC_LIST: 'flightdeck_spec_list',
  SPEC_CREATE: 'flightdeck_spec_create',
  SPEC_CHANGES: 'flightdeck_spec_changes',

  // Skills
  SKILL_LIST: 'flightdeck_skill_list',
  SKILL_INSTALL: 'flightdeck_skill_install',

  // Suggestions
  SUGGESTION_LIST: 'flightdeck_suggestion_list',
  SUGGESTION_APPROVE: 'flightdeck_suggestion_approve',
  SUGGESTION_REJECT: 'flightdeck_suggestion_reject',

  // File locks
  FILE_LOCK: 'flightdeck_file_lock',
  FILE_UNLOCK: 'flightdeck_file_unlock',
  FILE_LOCKS: 'flightdeck_file_locks',

  // Timers
  TIMER_SET: 'flightdeck_timer_set',
  TIMER_CANCEL: 'flightdeck_timer_cancel',
  TIMER_LIST: 'flightdeck_timer_list',

  // Cron
  CRON_LIST: 'flightdeck_cron_list',
  CRON_ADD: 'flightdeck_cron_add',
  CRON_ENABLE: 'flightdeck_cron_enable',
  CRON_DISABLE: 'flightdeck_cron_disable',
  CRON_REMOVE: 'flightdeck_cron_remove',
  CRON_RUN: 'flightdeck_cron_run',

  // Misc
  TOOLS_AVAILABLE: 'flightdeck_tools_available',
  ISOLATION_STATUS: 'flightdeck_isolation_status',
  WEBHOOK_TEST: 'flightdeck_webhook_test',
} as const;

/** All tool name values */
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/** All tool names as an array */
export const ALL_TOOL_NAMES: string[] = Object.values(TOOL_NAMES);
