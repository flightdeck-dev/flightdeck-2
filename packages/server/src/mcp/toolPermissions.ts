/**
 * Per-role MCP tool filtering.
 *
 * Each role only sees the tools it needs, reducing context waste
 * and tool misselection. Unknown roles default to worker-level access.
 *
 * The env var FLIGHTDECK_AGENT_ROLE is injected at spawn time by AcpAdapter.
 */

export const ROLE_TOOLS: Record<string, string[]> = {
  lead: [
    // Communication
    'flightdeck_send', 'flightdeck_read',
    'flightdeck_discuss',
    // Status & search (for answering user questions)
    'flightdeck_status',
    'flightdeck_task_list', 'flightdeck_task_context',
    'flightdeck_agent_list',
    'flightdeck_search',
    // Decisions
    'flightdeck_plan_review',  // Only Lead can approve plans
    'flightdeck_decision_log', 'flightdeck_decision_list',
    // Escalation
    'flightdeck_escalate_to_human',
    // Memory
    'flightdeck_memory_write', 'flightdeck_memory_read',
    'flightdeck_memory_log',
    // Suggestions (from Scout)
    'flightdeck_suggestion_list', 'flightdeck_suggestion_approve', 'flightdeck_suggestion_reject',
    // Utilities
    'flightdeck_role_list',
    'flightdeck_tools_available',
  ],
  director: [
    // Status & monitoring
    'flightdeck_status', 'flightdeck_report',
    'flightdeck_task_list', 'flightdeck_task_context', 'flightdeck_task_get',
    // Task management (Director owns ALL task operations)
    'flightdeck_task_add', 'flightdeck_task_cancel', 'flightdeck_task_reopen',
    'flightdeck_task_pause', 'flightdeck_task_resume', 'flightdeck_task_skip',
    'flightdeck_task_fail', 'flightdeck_task_retry', 'flightdeck_task_complete',
    'flightdeck_declare_tasks', 'flightdeck_declare_subtasks',
    // Agent management (Director spawns and manages ALL agents)
    'flightdeck_agent_list', 'flightdeck_agent_spawn', 'flightdeck_agent_terminate',
    'flightdeck_agent_hibernate', 'flightdeck_agent_wake',
    'flightdeck_agent_restart', 'flightdeck_agent_retire',
    // Specs
    'flightdeck_spec_list', 'flightdeck_spec_create', 'flightdeck_spec_changes',
    // Models (needs to choose runtime/model for workers)
    'flightdeck_model_list', 'flightdeck_model_config',
    // Communication
    'flightdeck_send', 'flightdeck_read',
    'flightdeck_discuss',
    // Search & memory
    'flightdeck_search', 'flightdeck_memory_write',
    'flightdeck_memory_read', 'flightdeck_memory_log',
    'flightdeck_learning_search',
    // Decisions
    'flightdeck_decision_log', 'flightdeck_decision_list',
    // Scheduling
    'flightdeck_cron_list', 'flightdeck_cron_add',
    // Utilities
    'flightdeck_role_list',
    'flightdeck_escalate', 'flightdeck_file_lock', 'flightdeck_file_unlock', 'flightdeck_file_locks',
    'flightdeck_tools_available',
  ],
  worker: [
    'flightdeck_status',
    'flightdeck_task_list', 'flightdeck_task_context', 'flightdeck_task_claim', 'flightdeck_task_submit',
    'flightdeck_task_fail', 'flightdeck_task_cancel', 'flightdeck_task_resume',
    'flightdeck_send', 'flightdeck_read',
    'flightdeck_search', 'flightdeck_memory_write',
    'flightdeck_escalate', 'flightdeck_file_lock', 'flightdeck_file_unlock', 'flightdeck_file_locks',
    'flightdeck_learning_add',
    'flightdeck_decision_log',
    'flightdeck_cron_list',
    'flightdeck_tools_available',
  ],
  reviewer: [
    'flightdeck_status',
    'flightdeck_task_list', 'flightdeck_task_context', 'flightdeck_task_get', 'flightdeck_task_complete', 'flightdeck_task_fail',
    'flightdeck_send', 'flightdeck_read',
    'flightdeck_search',
    'flightdeck_decision_log', 'flightdeck_decision_list',
    'flightdeck_escalate', 'flightdeck_file_lock', 'flightdeck_file_unlock', 'flightdeck_file_locks',
    'flightdeck_cron_list',
    'flightdeck_tools_available',
  ],
  'product-thinker': [
    'flightdeck_status',
    'flightdeck_spec_list',
    'flightdeck_task_list', 'flightdeck_task_context', 'flightdeck_task_add',
    'flightdeck_send', 'flightdeck_read', 'flightdeck_discuss',
    'flightdeck_search', 'flightdeck_memory_write',
    'flightdeck_decision_log', 'flightdeck_decision_list',
    'flightdeck_escalate', 'flightdeck_file_lock', 'flightdeck_file_unlock', 'flightdeck_file_locks',
    'flightdeck_tools_available',
  ],
  'qa-tester': [
    'flightdeck_status',
    'flightdeck_task_list', 'flightdeck_task_context', 'flightdeck_task_claim', 'flightdeck_task_submit',
    'flightdeck_task_fail', 'flightdeck_task_resume',
    'flightdeck_send', 'flightdeck_read',
    'flightdeck_search', 'flightdeck_memory_write',
    'flightdeck_escalate', 'flightdeck_file_lock', 'flightdeck_file_unlock', 'flightdeck_file_locks',
    'flightdeck_learning_add',
    'flightdeck_tools_available',
  ],
  'tech-writer': [
    'flightdeck_status',
    'flightdeck_task_list', 'flightdeck_task_context', 'flightdeck_task_claim', 'flightdeck_task_submit',
    'flightdeck_task_fail',
    'flightdeck_send', 'flightdeck_read',
    'flightdeck_search', 'flightdeck_memory_write',
    'flightdeck_spec_list',
    'flightdeck_escalate', 'flightdeck_file_lock', 'flightdeck_file_unlock', 'flightdeck_file_locks',
    'flightdeck_tools_available',
  ],
  scout: [
    'flightdeck_status',
    'flightdeck_task_list', 'flightdeck_task_context',
    'flightdeck_spec_list',
    'flightdeck_search',
    'flightdeck_decision_list',
    'flightdeck_learning_search',
    'flightdeck_suggestion_list',
    'flightdeck_escalate', 'flightdeck_file_lock', 'flightdeck_file_unlock', 'flightdeck_file_locks',
    'flightdeck_tools_available',
  ],
};

/** Get allowed tools for a role. Unknown roles get worker-level access. */
export function getToolsForRole(role: string): string[] {
  return ROLE_TOOLS[role] ?? ROLE_TOOLS.worker;
}
