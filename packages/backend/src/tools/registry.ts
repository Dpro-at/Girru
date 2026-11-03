/**
 * Tools Registry
 *
 * Central registry for all available tools.
 * Tools can be registered and executed through this registry.
 */

import { requiresReviewerApproval } from '../auth/verification/reviewer-quorum.js';
import { currentChatRun } from '../services/chat-run-context.js';
import { modeFor, permissionCategory } from './agent-permissions.js';
import type { Tool, ToolResult, ToolExecutionContext } from './types.js';
import { execToolRefusal, isToolAllowedByExecPolicy, isToolObjectAllowedByExecPolicy, isToolExecClass } from './exec-policy.js';
import { channelToolCallRefusal, isToolAllowedInChannel } from './channel-policy.js';
import { defaultGrants, grantCallRefusal, isToolGranted, type AgentToolGrants } from './grants.js';
import { approvalCategory, consumeApprovalTicket, isConfinedChannelReply, requestApproval } from './approvals.js';
import { actorFromToolContextAsync } from '../repositories/actor.js';
import { NO_MCP_AGENTS } from '../mcp-client/config.js';
import { hasSecretRef, resolveSecretRefs, scrubSecretValues, vaultToolResult } from '../services/chat-secrets.js';

/** Tools whose input is stored as text by Girru: key-store references are never resolved for them (CHAT-SECRETS-01). */
const KEEPS_TEXT = /^(?:memory_|board_|task_|handoff_|rule_suggest$|plan_steps$|create_reminder$)/;

/** Self-only tools need no grant; an extension or MCP tool can never claim it. */
const SELF_ONLY_TOOLS = new Set(['plan_steps', 'board_suggest_card', 'rule_suggest', 'handoff_save', 'handoff_read', 'guide_read', 'run_note']);
const isSelfOnly = (tool: Tool) => tool.selfOnly === true && SELF_ONLY_TOOLS.has(tool.name) && !tool.extensionId && !(tool as { mcp?: unknown }).mcp && !tool.execClass;
/**
 * CORE-MEM-HANDOFF: the agent's own handoff note also lives in board task runs
 * (not delegated ones, which get exactly the delegated tools); never in a channel turn.
 */
const HANDOFF_TOOLS = new Set(['handoff_save', 'handoff_read']);
const selfOnlyOffered = (tool: Tool, context: ToolExecutionContext) => HANDOFF_TOOLS.has(tool.name)
  ? !context.toolPolicy && context.handoffTools !== false && (context.chatPlan === true || (!!context.taskId && !context.delegatedFrom?.length && context.agentId !== 'small-local-agent')
    // STORE-MAP-01 P8 (D26): a part a lead handed over keeps its own note too (delegation is set only while P8 is on).
    || !!context.delegation)
  // STORE-MAP-01 P2 (AG1): an agent reads its own guides wherever it runs (registered only while GIRRU_STORE_P2 is on).
  : tool.name === 'guide_read' ? !!context.agentId && context.agentId !== 'small-local-agent'
  // STORE-MAP-01 P8 (D27): working notes inside any run (registered only while P8 is on, for models not on this computer).
  : tool.name === 'run_note' ? !context.toolPolicy && context.agentId !== 'small-local-agent' && (context.chatPlan === true || !!context.taskId || !!context.delegation)
  : context.chatPlan === true;

/** Words in fetched or read content that try to steer the agent (prompt injection), with a short excerpt. */
const INJECTION = /(ignore|disregard|forget) (all |any |the )?(previous|prior|above|earlier) (instructions|messages|rules)|you are now (a|an|in) |new instructions?:|system prompt|<\/?(system|assistant)>|(send|upload|post|email|forward) (all |the |your )?(files|secrets|keys|passwords|tokens|credentials|data) to|do not tell the (user|owner)/i;
export function injectedOrder(result: { content?: { type: string; text?: string }[] } | undefined): string | null {
  const text = (result?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  const m = INJECTION.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - 60);
  return text.slice(start, m.index + 160).replace(/\s+/g, ' ').trim();
}

/** Tools that only read, or keep text in Girru's own owner-reviewed stores, never ask because of the chat mode. */
const MODE_FREE = new Set(['read', 'search', 'list', 'plan_steps', 'board_suggest_card', 'rule_suggest', 'memory_save', 'memory_search', 'memory_recall', 'team_list', 'team_results', 'web_fetch', 'web_search']);
/** Girru's own file tools (in the agent's workspace). An extension or MCP tool never counts as one. */
const isFileEdit = (tool: { name: string; extensionId?: string; mcp?: unknown }) => !tool.extensionId && !tool.mcp && (tool.name === 'write' || tool.name === 'edit');
/** CHAT-BUILD-01 stage 3: does this tool change something (files, messages, settings, money, programs)? */
export function changesSomething(tool: Pick<Tool, 'name'> & { mcp?: unknown; execClass?: boolean; extensionId?: string }): boolean {
  if (MODE_FREE.has(tool.name)) return false;
  // An extension's tool changes something unless its name says it only reads.
  if (tool.extensionId) return !/^([a-z0-9]+_)*(get|list|read|search|fetch|find|show|view|status|info|lookup|check)(_|$)/.test(tool.name);
  if (/^(board|memory)_(comment|check|checklist|trash|restore|reflect|edit|delete|forget|move)/.test(tool.name)) return true;
  if (isToolExecClass(tool as Tool) || approvalCategory(tool as Tool) || (permissionCategory(tool) && permissionCategory(tool) !== 'network' && permissionCategory(tool) !== 'browser')) return true;
  return /(^|_)(write|edit|create|update|delete|remove|send|save|set|move|install|run|start|stop|apply|publish|post|upload|rename|archive)($|_)/.test(tool.name) || !!tool.mcp || tool.name.startsWith('mcp__') || /^browser_/.test(tool.name) && !/^browser_(read|snapshot|screenshot|get)/.test(tool.name);
}

export class ToolsRegistry {
  private tools = new Map<string, Tool>();
  private context: ToolExecutionContext;

  constructor(context: ToolExecutionContext) {
    this.context = context;
  }

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolsRegistry] Tool "${tool.name}" already registered, replacing...`);
    }
    this.tools.set(tool.name, tool);
    console.log(`[ToolsRegistry] ✅ Registered tool: ${tool.name}`);
  }

  /**
   * Unregister a tool (used by extensions on disable)
   */
  unregister(name: string): void {
    if (this.tools.has(name)) {
      this.tools.delete(name);
      console.log(`[ToolsRegistry] ❌ Unregistered tool: ${name}`);
    } else {
      console.warn(`[ToolsRegistry] Tool "${name}" not found, cannot unregister`);
    }
  }

  /**
   * Get all tools usable right now. Exec-class tools are left out unless the
   * server enables them (AGENT_EXEC_TOOLS=true), see exec-policy.ts.
   * In a channel-originated turn only the channel policy's tools are left
   * (see channel-policy.ts). Only tools granted to the agent are kept
   * (see grants.ts).
   */
  getAll(): Tool[] {
    const policy = this.context.toolPolicy;
    const grants = this.grants();
    return Array.from(this.tools.values()).filter((tool) =>
      isToolObjectAllowedByExecPolicy(tool)
      && (!policy || isToolAllowedInChannel(policy, tool))
      && (isSelfOnly(tool) ? selfOnlyOffered(tool, this.context) : isToolGranted(grants, tool.name))
      && modeFor(this.context.permissions, tool) !== 'off'
    );
  }

  /** The agent's effective grants; no agent -> the minimal default set (fail closed, S1.2). */
  private grants(): AgentToolGrants {
    return this.context.grants ?? defaultGrants();
  }

  /** All registered tools, unfiltered (used to seed grants and for the owner grants view). */
  listRegistered(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Execute a tool
   */
  async execute(
    toolName: string,
    params: Record<string, any>,
    options: { approvalTicket?: unknown } = {}
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (currentChatRun()?.failed) return { content: [{ type: 'text', text: 'Checkpoint failed. No further tools will run; review the unknown outcome before continuing.' }], error: 'Checkpoint unavailable' };

    // SECURITY: exec-class tools are refused unless enabled by server env (S0-Q.5)
    if (!isToolAllowedByExecPolicy(toolName) || (tool && !isToolObjectAllowedByExecPolicy(tool))) {
      console.warn(`[ToolsRegistry] ⛔ Refused exec-class tool: ${toolName}`);
      return execToolRefusal(toolName);
    }

    // SECURITY: channel-originated turns may only run the channel policy's tools (S0-Q.8)
    const policy = this.context.toolPolicy;
    if (policy) {
      const refused = channelToolCallRefusal(policy, toolName, tool, params);
      if (refused) {
        console.warn(`[ToolsRegistry] ⛔ Refused tool in ${policy.channel} channel turn: ${toolName}`);
        return refused;
      }
    }

    if (!tool) {
      return {
        content: [{ type: 'text', text: `Error: Tool "${toolName}" not found` }],
        error: `Tool not found: ${toolName}`,
      };
    }

    // SECURITY (S1.2): only tools granted to this agent run, even if the model emits others
    const grantRefused = isSelfOnly(tool) && selfOnlyOffered(tool, this.context) ? null : grantCallRefusal(this.grants(), toolName, tool, params);
    if (grantRefused) {
      console.warn(`[ToolsRegistry] ⛔ Refused ungranted tool for agent ${this.context.agentId ?? '(none)'}: ${toolName}`);
      return grantRefused;
    }
    // MCP-01: an agent that never uses MCP is refused before any approval request (one it could never use).
    if (((tool as { mcp?: unknown }).mcp || toolName.startsWith('mcp__')) && this.context.agentId && NO_MCP_AGENTS.has(this.context.agentId)) {
      return { content: [{ type: 'text', text: `Tool "${toolName}" was not run: this agent may not use MCP tools.` }], error: 'mcp_not_allowed' };
    }

    // CORE-PERMS-01: the owner's mode for this tool's category: off = refused,
    // ask = always approval, allow = no approval (risky ones confirmed by the owner).
    const mode = modeFor(this.context.permissions, tool);
    if (mode === 'off') {
      console.warn(`[ToolsRegistry] ⛔ Refused tool switched off for agent ${this.context.agentId ?? '(none)'}: ${toolName}`);
      return {
        content: [{ type: 'text', text: `Tool "${toolName}" was not run: the owner switched off this kind of tool for this agent.` }],
        error: 'Tool switched off for this agent',
      };
    }

    // SECURITY (S1.3): risky tools (send, delete, spend, install, settings) wait
    // for a one-time owner approval. Only approveAndRun() holds a valid ticket.
    // "allow" lifts only the approval that comes from the category itself
    // (e.g. message for *_send); a tool's own approval request ('other', such
    // as a write-like MCP tool) always stays.
    const ownCategory = approvalCategory(tool);
    const modeCategory = permissionCategory(tool);
    let category = ownCategory ?? (mode === 'ask' ? modeCategory : null);
    if (mode === 'allow' && ownCategory && ownCategory === modeCategory && !isToolExecClass(tool)) category = null;
    // CHAT-SECRETS-01: a call that uses a key-store reference runs only for the
    // owning user, never in a channel turn, and always after the owner's approval.
    // Tools that keep text in Girru's own stores (memory, board, tasks, plan) get the reference itself.
    const usesSecret = !KEEPS_TEXT.test(toolName) && hasSecretRef(params);
    if (usesSecret && (policy || !this.context.userId)) {
      return {
        content: [{ type: 'text', text: `Tool "${toolName}" was not run: saved secrets can only be used in the owner's own chat.` }],
        error: 'Secret reference refused',
      };
    }
    if (usesSecret && !category) category = modeCategory ?? 'other';
    let reviewerRequired=false;
    try { reviewerRequired=await requiresReviewerApproval(this.context.agentId,toolName); }
    catch { return {content:[{type:'text',text:'The action was not run: human review rules are unavailable.'}],error:'Human review rules unavailable'}; }
    if (reviewerRequired) category=category??'other';
    if (currentChatRun()?.reviewTools) category = category ?? 'other';
    // CHAT-BUILD-01 stage 3: in "Ask me" and "Plan first" every tool that changes something asks first.
    const chatMode = currentChatRun()?.chatMode;
    // "Accept edits": Girru's own file edits run as the agent's rules say; anything else that changes something asks.
    // (For coding-app replies the owner's Accept edits also lets the app edit files in the chat's folders.)
    if ((chatMode === 'ask' || chatMode === 'plan' || (chatMode === 'accept_edits' && !isFileEdit(tool))) && changesSomething(tool)) category = category ?? modeCategory ?? 'other';
    if (category && (reviewerRequired || !isConfinedChannelReply(policy, toolName)) && !consumeApprovalTicket(options.approvalTicket, toolName)) {
      try {
        return await requestApproval(tool, params, this.context, category);
      } catch (error: any) {
        console.error('[ToolsRegistry] ❌ Could not store approval request:', error?.message);
        return {
          content: [{ type: 'text', text: `Tool "${toolName}" was not run: it needs owner approval and the request could not be stored.` }],
          error: 'Approval request failed',
        };
      }
    }

    let secrets: Awaited<ReturnType<typeof resolveSecretRefs<Record<string, any>>>> = { value: params, used: [] };
    try {
      console.log(`[ToolsRegistry] 🔧 Executing tool: ${toolName}`);
      // Parameter names only: values may hold secrets (e.g. credentials_save).
      console.log(`[ToolsRegistry]   Params:`, Object.keys(params || {}).join(', '));

      // B1-core: one actor per tool call, from the trusted run context only.
      // CHAT-SECRETS-01: references become the stored values only here, and go back into the result.
      secrets = usesSecret ? await resolveSecretRefs(this.context.userId!, params) : { value: params, used: [] };
      const checkpoint = currentChatRun();
      const intent = checkpoint ? await checkpoint.beforeTool(toolName, params) : undefined;
      const scrubbed = scrubSecretValues(await tool.execute(secrets.value, { ...this.context, actor: await actorFromToolContextAsync(this.context) }), secrets.used);
      // CHAT-BUILD-01 stage 5 (CH10): text read from pages, files or emails that tries to give orders is data; the owner sees what was tried.
      const tried = injectedOrder(scrubbed);
      if (tried) currentChatRun()?.notice?.('injection', tried);
      // CHAT-SECRETS-02: other secrets in the result (a read .env, a printed token) go to the key store too.
      const result = await vaultToolResult(this.context, scrubbed);
      if (checkpoint && intent) await checkpoint.afterTool(intent, result);

      console.log(`[ToolsRegistry] ✅ Tool executed successfully`);
      return result;
    } catch (error: any) {
      // A call that used a saved secret never logs or returns the raw error (it may echo the value).
      const message = scrubSecretValues(String(error?.message ?? error), secrets.used);
      console.error('[ToolsRegistry] Tool execution failed', { tool: toolName });
      return await vaultToolResult(this.context, {
        content: [
          {
            type: 'text',
            text: `Error executing tool "${toolName}": ${message}`,
          },
        ],
        error: message,
      });
    }
  }

  /**
   * Get tools in Anthropic API format
   */
  getToolsForAPI(): Array<{
    name: string;
    description: string;
    input_schema: any;
  }> {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  /**
   * Update context (e.g., change workspace dir)
   */
  updateContext(updates: Partial<ToolExecutionContext>): void {
    this.context = { ...this.context, ...updates };
  }

  /**
   * Get current context
   */
  getContext(): ToolExecutionContext {
    return this.context;
  }
}
