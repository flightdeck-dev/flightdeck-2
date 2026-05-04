/**
 * Per-role MCP tool filtering.
 *
 * Three permission tiers:
 *   - lead: Lead-specific tools (plan review, suggestions, etc.)
 *   - director: Director-specific tools (task/agent management, spawning, etc.)
 *   - agent: Universal agent toolset (union of all non-lead/non-director capabilities).
 *            All user-defined roles (worker, reviewer, scout, qa-tester, etc.) use this set.
 *
 * The env var FLIGHTDECK_AGENT_ROLE is injected at spawn time by AcpAdapter.
 */

export const ROLE_TOOLS: Record<string, string[]> = {
  lead: [
    // Communication
    'flightdeck_send', 'flightdeck_read', 'flightdeck_list_channels', 'flightdeck_subscribe', 'flightdeck_unsubscribe', 'flightdeck_get_message', 'flightdeck_channel_info',
    'flightdeck_channel_create', 'flightdeck_channel_archive', 'flightdeck_broadcast', 'flightdeck_my_subscriptions',
    // Status & search (for answering user questions)
    'flightdeck_status',
    'flightdeck_task_list', 'flightdeck_task_context',
    'flightdeck_task_comment',
    'flightdeck_agent_list',
    'flightdeck_search',
    // Decisions
    'flightdeck_plan_review',  // Only Lead can approve plans
    'flightdeck_decision_log', 'flightdeck_decision_list',
    // Escalation
    'flightdeck_escalate_to_human',
    // Batch channel management
    'flightdeck_subscribe_agents',
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
    'flightdeck_task_delegate',
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
    'flightdeck_send', 'flightdeck_read', 'flightdeck_list_channels', 'flightdeck_subscribe', 'flightdeck_unsubscribe', 'flightdeck_get_message', 'flightdeck_channel_info',
    'flightdeck_channel_create', 'flightdeck_channel_archive', 'flightdeck_broadcast', 'flightdeck_my_subscriptions',
    // Search & memory
    'flightdeck_search', 'flightdeck_memory_write',
    'flightdeck_memory_read', 'flightdeck_memory_log',
    'flightdeck_learning_search',
    // Decisions
    'flightdeck_decision_log', 'flightdeck_decision_list',
    // Scheduling
    'flightdeck_cron_list', 'flightdeck_cron_add',
    // Batch channel management
    'flightdeck_subscribe_agents',
    // Utilities
    'flightdeck_role_list',
    'flightdeck_escalate', 'flightdeck_file_lock', 'flightdeck_file_unlock', 'flightdeck_file_locks',
    'flightdeck_tools_available',
  ],
  agent: [
    // Status
    'flightdeck_status',
    // Tasks (union of worker + reviewer capabilities)
    'flightdeck_task_list', 'flightdeck_task_context', 'flightdeck_task_get',
    'flightdeck_task_submit', 'flightdeck_task_complete',
    'flightdeck_task_fail', 'flightdeck_task_cancel', 'flightdeck_task_resume',
    'flightdeck_task_comment',
    // Communication
    'flightdeck_send', 'flightdeck_read', 'flightdeck_list_channels', 'flightdeck_subscribe', 'flightdeck_unsubscribe', 'flightdeck_get_message', 'flightdeck_channel_info',
    'flightdeck_my_subscriptions',
    // Search & memory
    'flightdeck_search', 'flightdeck_memory_write',
    // Specs (for product-thinker, tech-writer, scout)
    'flightdeck_spec_list',
    // Decisions
    'flightdeck_decision_log', 'flightdeck_decision_list',
    // Learnings
    'flightdeck_learning_add', 'flightdeck_learning_search',
    // Suggestions (scout)
    'flightdeck_suggestion_list',
    // Escalation & file locks
    'flightdeck_escalate', 'flightdeck_file_lock', 'flightdeck_file_unlock', 'flightdeck_file_locks',
    // Scheduling (read-only)
    'flightdeck_cron_list',
    // Utilities
    'flightdeck_tools_available',
  ],
};

/** Get allowed tools for a role. Only "lead" and "director" have dedicated sets; all others use "agent". */
export function getToolsForRole(role: string): string[] {
  if (role === 'lead') return ROLE_TOOLS.lead;
  if (role === 'director') return ROLE_TOOLS.director;
  return ROLE_TOOLS.agent;
}
