/**
 * Multi-Agent System Types
 * Orchestration and coordination of multiple agents
 */

/** Agent role in a team */
export type AgentRole =
  | 'leader'      // Coordinates the team
  | 'worker'      // Executes tasks
  | 'specialist'  // Domain expert
  | 'reviewer'    // Reviews work
  | 'assistant';  // Supports other agents

/** Agent status */
export type AgentStatus = 'idle' | 'busy' | 'waiting' | 'error' | 'offline';

/** Task priority */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Task status */
export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'review' | 'completed' | 'failed' | 'cancelled';

/** Message type between agents */
export type MessageType =
  | 'task_assignment'
  | 'task_update'
  | 'task_complete'
  | 'request_help'
  | 'provide_info'
  | 'question'
  | 'answer'
  | 'broadcast'
  | 'handoff';

/** Agent definition */
export interface AgentDefinition {
  /** Unique agent ID */
  id: string;
  /** Agent name */
  name: string;
  /** Agent description */
  description?: string;
  /** Agent role */
  role: AgentRole;
  /** Capabilities/skills */
  capabilities: string[];
  /** Model to use */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Max concurrent tasks */
  maxConcurrentTasks: number;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/** Agent instance (runtime state) */
export interface AgentInstance {
  /** Agent definition */
  definition: AgentDefinition;
  /** Current status */
  status: AgentStatus;
  /** Current tasks */
  currentTasks: string[];
  /** Completed tasks count */
  completedTasks: number;
  /** Failed tasks count */
  failedTasks: number;
  /** Last activity */
  lastActivity?: Date;
  /** Memory/context */
  memory: AgentMemory;
  /** Team membership */
  teamId?: string;
}

/** Agent memory */
export interface AgentMemory {
  /** Short-term memory (current context) */
  shortTerm: MemoryEntry[];
  /** Long-term memory (persistent) */
  longTerm: MemoryEntry[];
  /** Shared team memory reference */
  sharedMemoryId?: string;
}

/** Memory entry */
export interface MemoryEntry {
  /** Entry ID */
  id: string;
  /** Content type */
  type: 'fact' | 'task' | 'decision' | 'observation' | 'note';
  /** Content */
  content: string;
  /** Importance score */
  importance: number;
  /** Timestamp */
  timestamp: Date;
  /** Source (agent ID or 'user') */
  source: string;
  /** Related entries */
  related?: string[];
}

/** Team definition */
export interface TeamDefinition {
  /** Unique team ID */
  id: string;
  /** Team name */
  name: string;
  /** Team description */
  description?: string;
  /** Team objective */
  objective: string;
  /** Agent IDs in the team */
  agentIds: string[];
  /** Leader agent ID */
  leaderId?: string;
  /** Communication style */
  communicationStyle: 'hierarchical' | 'flat' | 'dynamic';
  /** Shared memory enabled */
  sharedMemory: boolean;
  /** Creation time */
  createdAt: Date;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/** Team instance (runtime state) */
export interface TeamInstance {
  /** Team definition */
  definition: TeamDefinition;
  /** Current status */
  status: 'active' | 'paused' | 'completed' | 'disbanded';
  /** Active tasks */
  activeTasks: string[];
  /** Completed tasks */
  completedTasks: number;
  /** Shared memory */
  sharedMemory: MemoryEntry[];
  /** Message history */
  messageHistory: AgentMessage[];
}

/** Task definition */
export interface Task {
  /** Server-recorded delegation provenance; absence never means owner-created. */
  spawnDepth?: number;
  spawnedBy?: string;
  origin?: string;
  /** Unique task ID */
  id: string;
  /** Task title */
  title: string;
  /** Task description */
  description: string;
  /** Priority */
  priority: TaskPriority;
  /** Status */
  status: TaskStatus;
  /** Required capabilities */
  requiredCapabilities?: string[];
  /** Assigned agent ID */
  assignedTo?: string;
  /** Team ID (if team task) */
  teamId?: string;
  /** Parent task ID (for subtasks) */
  parentId?: string;
  /** Subtask IDs */
  subtasks?: string[];
  /** Dependencies (task IDs that must complete first) */
  dependencies?: string[];
  /** Input data */
  input?: Record<string, unknown>;
  /** Output/result */
  output?: Record<string, unknown>;
  /** Progress (0-100) */
  progress: number;
  /** Created at */
  createdAt: Date;
  /** Started at */
  startedAt?: Date;
  /** Completed at */
  completedAt?: Date;
  /** Deadline */
  deadline?: Date;
  /** Error message if failed */
  error?: string;
  /** Retry count */
  retryCount: number;
  /** Max retries */
  maxRetries: number;
}

/** Message between agents */
export interface AgentMessage {
  /** Message ID */
  id: string;
  /** Message type */
  type: MessageType;
  /** Sender agent ID */
  from: string;
  /** Recipient agent ID (or 'all' for broadcast) */
  to: string;
  /** Team ID (if team message) */
  teamId?: string;
  /** Related task ID */
  taskId?: string;
  /** Message content */
  content: string;
  /** Structured data */
  data?: Record<string, unknown>;
  /** Timestamp */
  timestamp: Date;
  /** Is read */
  read: boolean;
  /** Reply to message ID */
  replyTo?: string;
}

/** Handoff request */
export interface HandoffRequest {
  /** Request ID */
  id: string;
  /** From agent */
  fromAgent: string;
  /** To agent */
  toAgent: string;
  /** Task ID */
  taskId: string;
  /** Reason for handoff */
  reason: string;
  /** Context to transfer */
  context: Record<string, unknown>;
  /** Status */
  status: 'pending' | 'accepted' | 'rejected' | 'completed';
  /** Timestamp */
  timestamp: Date;
}

/** Orchestration strategy */
export interface OrchestrationStrategy {
  /** Strategy name */
  name: string;
  /** Task assignment mode */
  assignmentMode: 'round_robin' | 'capability_match' | 'load_balance' | 'leader_assigns';
  /** Auto-retry failed tasks */
  autoRetry: boolean;
  /** Max retries */
  maxRetries: number;
  /** Allow task splitting */
  allowSplitting: boolean;
  /** Require review */
  requireReview: boolean;
  /** Review threshold (0-1) */
  reviewThreshold?: number;
  /** Escalation rules */
  escalation?: EscalationRule[];
}

/** Escalation rule */
export interface EscalationRule {
  /** Trigger condition */
  condition: 'timeout' | 'failure' | 'low_confidence' | 'request';
  /** Threshold value */
  threshold?: number;
  /** Action to take */
  action: 'reassign' | 'escalate_leader' | 'human_review' | 'abort';
}

/** Multi-agent stats */
export interface MultiAgentStats {
  /** Total agents */
  totalAgents: number;
  /** Active agents */
  activeAgents: number;
  /** Total teams */
  totalTeams: number;
  /** Active teams */
  activeTeams: number;
  /** Tasks completed (24h) */
  tasksCompleted24h: number;
  /** Tasks failed (24h) */
  tasksFailed24h: number;
  /** Average task duration */
  avgTaskDuration: number;
  /** Messages exchanged (24h) */
  messagesExchanged24h: number;
}

/** Default orchestration strategy */
export const DEFAULT_ORCHESTRATION: OrchestrationStrategy = {
  name: 'balanced',
  assignmentMode: 'capability_match',
  autoRetry: true,
  maxRetries: 2,
  allowSplitting: true,
  requireReview: false,
  escalation: [
    { condition: 'timeout', threshold: 300000, action: 'reassign' },
    { condition: 'failure', threshold: 2, action: 'escalate_leader' },
  ],
};
