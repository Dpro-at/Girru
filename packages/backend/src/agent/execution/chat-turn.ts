import {consumeAdmittedMemory,scopeAdmittedMemory} from './run-admission-entry.js';
import {withRunAdmission,beforeAdmittedModel,taintRunAdmission,observeAdmittedContext,executeAdmittedTool,admittedModelStep,beforeAdmittedTools,runInputDigest} from './run-admission-entry.js';
import { preferredMention } from '../context/target.js';
import { subscriptionToolLoop } from './subscription-turn.js';
import { teamContext } from '../../services/agent-org.js';
import { rulesContext } from '../../services/agent-rules.js';
import { knowledgeContext } from '../../services/agent-file-library.js';
import { libraryBehavior } from '../../services/personality-library.js';
import { frameUntrustedMemory } from '../../services/untrusted-memory-context.js';
import { narrowProjectMemory } from '../../tools/memory/project-access.js';

import { currentChatRun } from '../../services/chat-run-context.js';
import { subscriptionModel, subscriptionEnabled, runSubscription, chatImagesSeenBy } from '../../services/subscription-chat.js';
import { subscriptionAgentContext, subscriptionReplyPrompt } from '../../services/subscription-agent-context.js';
import { isPilotAgent } from '../../memory/outbox/pilot.js';
import { resolveAgentContext } from '../../agent/context/resolve.js';
import { renderCodingAppInstructions, renderMemoryData, renderSystemPrompt } from '../../agent/context/render.js';
import { CODING_APP_MEMORY_TOKENS, capTokens } from '../../agent/context/budget.js';
import { oneContextEnabled } from '../../agent/context/switch.js';
import { agentSkillsPrompt } from '../../skills/central-store.js';
import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Chat API Routes
 * Handles chat completions with streaming support
 * Uses primary agent from agents_config table
 */

import type { AgentReply } from '../contracts/reply.js';
import { chunkText, openSseStream } from '../../services/chat-sse.js';
import { handleError } from '../../services/error-response.js';
import { AgentRuntime, type Message, type Skill } from '../../agent/index.js';
import { getSettingsManager } from '../../settings/index.js';
import { all, one, sql } from '../../repositories/sql-steps.js';
import { streamChatClaude } from './cloud-turn.js';
import { createAgentToolsRegistry, useRemoteModelTools } from '../../tools/index.js';
import { channelTurnFromHeaders, type ChannelToolPolicy } from '../../tools/channel-policy.js';

import { geminiCliTool } from '../../tools/cli/gemini-cli.js';
import { claudeCliTool } from '../../tools/cli/claude-cli.js';
import { getJsonRenderPrompt, uiSpecPrompt } from '../context/json-render-prompt.js';
import { safeErrorFields } from '../../services/safe-error-log.js';
import { resolveProviderApiKey } from '../../credentials/authority.js';
import { readPersonality } from '../../services/agent-files.js';
import { agentMemoryForPrompt } from '../../memory/agent-drawer.js';
import { stripPersonalityExport, type Behavior } from '../../services/personality.js';
import { outsiderAgentMemoryEnabled } from '../../services/outsider-memory.js';
import { DrawerInputError, chatTurnDrawers, drawerId, sameDrawer, type DrawerRef } from '../../memory/drawers.js';
import { pinnedFactsForReply, scopeFactAccess, type ReplyPinnedFacts } from '../../memory/scopes/pinned.js';
import { storeP9Enabled } from '../../services/store-p9.js';
import { cloudSafeDrawers, cloudSafePinnedAllow, providerIsLocal } from '../../memory/stays-local.js';
import { MEMORY_UNAVAILABLE_NOTE, recordHealthEvent } from '../../memory/health.js';
import { withoutArchivedDrawers } from '../../memory/scopes/store.js';
import { withGroupDrawers } from '../../memory/scopes/groups.js';
import { logAudit } from '../../services/audit-logger.js';
import { loadRunPermissions } from '../../tools/agent-permissions.js';
import { createModelRouter, ModelRouter } from '../../services/model-router.js';
import { CostTracker } from '../../services/cost-tracker.js';
import { ModelUnavailable } from '../../agent/providers/ollama-agent-loop.js';
import { OLLAMA_URL, DEFAULT_OLLAMA_MODEL, ollamaThinkOption, chatThinkFor } from '../../llm/ollama.js';
import { resolveLocalModel, listLocalModels } from '../../llm/local-models.js';
import { lmStudioApiUrl, lmStudioModelName, lmStudioNotRunningMessage } from '../../llm/lmstudio.js';
import { executeLocalTurn } from '../../agent/execution/local-turn.js';
import { contextPack, messageRecall, type ContextPack, type MessageRecall } from '../../memory/context/pack.js';
import { chatRecallQuery } from '../../memory/context/entities.js';
import { budgetHistory, type BudgetedHistory, type HistoryTurn } from '../../memory/context/summaries.js';
import { saveTrace, setTraceTtft } from '../../memory/context/trace.js';
import { contextBudget, estimateTokens, keepAliveValue } from '../../memory/context/budget.js';
import { recordTtft } from '../../memory/context/metrics.js';
import { storeP2bEnabled } from '../../services/store-p2b.js';
import { isLocalTurnProvider, localModelWindow, localTurnLog, p2bLocalTurn, prepareLocalTurn } from '../../services/local-turn.js';
import { planLocalBudget } from '../../memory/context/local-budget.js';
import type { ModelWindow } from '../../llm/model-window.js';
import { beginLocalReply } from '../../llm/local-scheduler.js';
import { isOpenAiLocalModelId, openAiLocalModelName, openAiLocalNotRunningMessage, openAiLocalUrl } from '../../llm/openai-local.js';
import type { ToolDef } from '../../tools/tool-doors.js';
import { OnDemandTools } from '../../tools/on-demand.js';

const DEFAULT_MODEL = DEFAULT_OLLAMA_MODEL;

/**
 * Isolated stage 2 (chat test): every turn is answered by the local Ollama
 * model only — no paid provider, no CLI bridge, no tools — whatever the
 * agent or the request asks for. Set only by scripts/isolated-server.ts.
 */
export function localModelOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AGENT_PLAYER_LOCAL_MODEL_ONLY ?? '').trim() === '1' && (env.AGENT_PLAYER_ISOLATED ?? '').trim() === '1';
}

/**
 * Isolated stage 2 may also offer the agent's tools to the local model
 * (CHAT-REBUILD-01: long-task tests). Off unless both flags are set; the
 * registry's exec policy, grants and approvals still apply to every call.
 */
export function localModelTools(env: NodeJS.ProcessEnv = process.env): boolean {
  return localModelOnly(env) && (env.AGENT_PLAYER_LOCAL_MODEL_TOOLS ?? '').trim() === '1';
}

interface AgentConfig {
  id: string;
  name: string;
  system_prompt: string;
  model: string;
  provider: string;
  is_primary: number;
  temperature: number;
  max_tokens: number;
  api_key: string;
}

/** Load primary agent from agents_config, or first agent if none is primary (process driver, B2.2b-4). */
async function getPrimaryAgent(): Promise<AgentConfig | null> {
  try {
    const row = await sql().read(one<AgentConfig>('SELECT * FROM agents_config WHERE is_primary = 1 ORDER BY id LIMIT 1'));
    if (row) return row;
    // Fallback: first agent
    return (await sql().read(one<AgentConfig>('SELECT * FROM agents_config ORDER BY created_at, id LIMIT 1'))) ?? null;
  } catch {
    return null;
  }
}

/** Behaviour parameters from the agent's current personality version (CORE-01). */
async function personalityBehavior(agentId: string): Promise<Behavior | null> {
  try {
    return await libraryBehavior(agentId);
  } catch (err) {
    console.warn('[Chat] Personality unavailable, using agent defaults');
    return null;
  }
}

/** Load a specific agent by id (process driver, B2.2b-4) */
async function getAgentById(id: string): Promise<AgentConfig | null> {
  try {
    return (await sql().read(one<AgentConfig>('SELECT * FROM agents_config WHERE id = ?', id))) ?? null;
  } catch {
    return null;
  }
}

// Mock skills for Agent System
const mockSkills: Skill[] = [
  {
    id: 'weather',
    name: 'Weather',
    description: 'Get weather forecasts and current conditions',
    location: '/skills/weather.md',
    category: 'utilities',
    tags: ['weather', 'temperature', 'forecast', 'الطقس'],
    triggers: ['weather', 'temperature', 'الطقس'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Manage GitHub repositories and PRs',
    location: '/skills/github.md',
    category: 'development',
    tags: ['github', 'repository', 'pr', 'جيتهاب'],
    triggers: ['github', 'repository', 'جيتهاب'],
  },
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Search the web for information',
    location: '/skills/web-search.md',
    category: 'utilities',
    tags: ['search', 'web', 'google', 'بحث'],
    triggers: ['search', 'find', 'ابحث'],
  },
  {
    id: 'calculator',
    name: 'Calculator',
    description: 'Perform mathematical calculations',
    location: '/skills/calculator.md',
    category: 'utilities',
    tags: ['calculate', 'math', 'حساب'],
    triggers: ['calculate', 'compute', 'احسب'],
  },
  {
    id: 'note-taking',
    name: 'Note Taking',
    description: 'Create and manage notes',
    location: '/skills/note-taking.md',
    category: 'productivity',
    tags: ['note', 'remember', 'ملاحظة'],
    triggers: ['note', 'remember', 'ملاحظة'],
  },
];

// Initialize Agent Runtime (Smart System)
const agent = new AgentRuntime({
  skills: {
    maxSelected: 5,
    confidenceThreshold: 0.5,
    enableLearning: true,
  },
});
agent.loadSkills(mockSkills);
console.log('[Chat] 🧠 Agent System loaded');

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | any[]; // array for multimodal (vision) messages
  /** Images of this message (base64), for a model that can see (CHAT-GAPS-01). */
  images?: TurnImage[];
}
export type TurnImage = { type: string; data: string; file?: string; name?: string };

/**
 * The text of a message: the string itself, or the text parts of a
 * multimodal (vision) message joined. The agent analyzers, the model router
 * and the text-only providers need text; an array used to reach them as is
 * (`.toLowerCase()` on an array, or "User: [object Object]" for a CLI model).
 */
export function messageText(content: string | any[] | undefined | null): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

interface ChatRequest {
  model?: string;
  agentId?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
  systemPrompt?: string;
  systemPromptAppend?: string; // Extra instructions appended AFTER agent system prompt (does not replace it)
  memoryContext?: string;  // Injected relevant memories for this user
  /** CORE-03: the turn's active project / task / mentioned people (memory drawers to open). */
  memoryScope?: { project?: string; task?: string; people?: string[] | string; experience?: boolean };
  userId?: string;         // IGNORED (S0-Q.9): the user comes from the bearer token or the server-side channel turn
  chatContext?: {
    hasAvatarViewer?: boolean;
    isInteractiveMode?: boolean;
    hasDesktopControl?: boolean;
    sessionType?: 'minimal' | 'standard' | 'full';
  };
}

/** One accepted chat turn, after authentication and the idempotency check. */
/** CHAT-BUILD-01: "Auto" model choice — only then may the cost router pick the Claude model. */
export const AUTO_MODEL = 'auto';

/** CHAT-BUILD-01 (M3): bounds on the system prompt (characters). The persona file may be up to 1 MB on disk. */
export const PERSONA_PROMPT_CHARS = 32_000;
export const PROMPT_APPEND_CHARS = 32_000;
export const SYSTEM_PROMPT_CHARS = 96_000;
/** Coding-app replies (CHAT-BUILD-01): history tokens kept in full, memory characters added. */
export const SUBSCRIPTION_HISTORY_TOKENS = 12_000;
export const SUBSCRIPTION_MEMORY_CHARS = 6_000;
/** Keeps the start and the end of an over-long text (the end holds the newest instructions and the model identity). */
export function capMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = '\n\n[… part of this text was left out for size …]\n\n';
  const head = Math.floor((max - note.length) * 0.7);
  return text.slice(0, head) + note + text.slice(text.length - (max - note.length - head));
}

/** A notice frame: shown in the chat while the turn runs, never stored as answer text. */
export const noticeFrame = (code: string, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ type: 'notice', code, ...extra })}\n\n`;

export interface ChatTurnInput {
  /** Trusted saved/group dispatcher selected the writer; never populated from HTTP body. */
  targetResolved?: boolean;
  agentId?: string;
  messages: ChatMessage[];
  stream: boolean;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  sessionId: string;
  systemPrompt?: string;
  systemPromptAppend?: string;
  memoryContext?: string;
  memoryScope?: ChatRequest['memoryScope'];
  chatContext?: ChatRequest['chatContext'];
  userId: string;
  channelTurn?: ReturnType<typeof channelTurnFromHeaders>;
  /** The model's provider when the turn picks a model itself (chat model picker). */
  provider?: 'ollama' | 'claude' | 'lmstudio';
  /** CHAT-PRO-02 A: the project folder the read tool reads from (writes stay in the agent's workspace). */
  fileReadRoot?: string;
  /** CHAT-SPEC-01: which rich-answer components the page draws ('chat' = the new chat's display set). */
  uiSet?: 'full' | 'chat';
  /** MEM-CACHE-01: the turn's run id (its recall trace is stored under it). */
  runId?: string;
  /**
   * MEM-CACHE-01: a saved conversation's whole history (oldest first, the new
   * message last). The turn keeps the newest turns in full and gives older
   * ones as rolling summaries within the context budget; `messages` is then
   * only the fallback.
   */
  conversation?: { turns: HistoryTurn[] };
  /** CHAT-BUILD-01 stage 3: the project's added folders a coding app may change (Mode "Accept edits"). */
  writeFolders?: string[];
  /** CORE-MEM-HANDOFF: the newest handoff note of the conversation (part of the cached context pack). */
  handoff?: { id: string; scope: string; text: string } | null;
  /** CHAT-GAPS-01: images of the new message (only that message's; older images are not sent again). */
  images?: TurnImage[];
}

/** Room for the tool definitions and instructions the turn adds after the system prompt (tokens). */
const TOOLS_RESERVE_TOKENS = 3000;

/**
 * Drawers the agent may read automatically: the turn's drawers narrowed by its memory permissions
 * (CORE-PERMS-01) and its inherited access in this project (MEM-SCALE-01).
 */
async function readableDrawers(agentId: string | undefined, drawers: DrawerRef[], userId: string): Promise<DrawerRef[]> {
  if (!agentId || drawers.length === 0) return drawers;
  const project = drawers.find((d) => d.kind === 'project')?.key ?? null;
  const read = (await loadRunPermissions(agentId, [], { userId, project })).memoryRead;
  return (await narrowProjectMemory({agentId,userId,memoryDrawers:drawers}) ?? []).filter((d) => read.includes(d.kind));
}

/**
 * MEM-CACHE-01: time to the first word of the reply (text or reasoning), from
 * the moment the turn was accepted. Wraps the stream's write once.
 */
function watchFirstWord(raw: { write: (...args: any[]) => any }, startedAt: number, onFirst: (ms: number) => void): void {
  const write = raw.write;
  let seen = false;
  raw.write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
    if (!seen && typeof chunk === 'string' && chunk.startsWith('data:') && /"content":"[^"]/.test(chunk) && !/"type":"error"/.test(chunk)) {
      seen = true;
      try { onFirst(Date.now() - startedAt); } catch { /* metrics only */ }
    }
    return write.call(this, chunk, ...rest);
  };
}

/**
 * Resolve the agent, build its prompt and run the turn on the reply
 * (CHAT-REBUILD-01: shared by POST /api/chat and the background chat runs,
 * which pass a reply whose raw stream feeds the run's event log).
 */
export async function executeChatTurn(reply: AgentReply, input: ChatTurnInput): Promise<unknown> {
    const {
      messages, stream, model: requestedModel, temperature, maxTokens, sessionId, systemPrompt, systemPromptAppend: rawPromptAppend,
      memoryContext: bodyMemoryContext, memoryScope, chatContext, userId,
    } = input;
    let agentId = input.agentId;
    const targetUserMessage = [...messages].reverse().find(m => m.role === 'user');
    const targetText = targetUserMessage ? messageText(targetUserMessage.content) : '';
    if (!input.targetResolved && !input.channelTurn && targetText.includes('@')) {
      const owner = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id=?', userId));
      if (owner?.role === 'owner') {
        const team = await sql().read(all<{ id: string; name: string }>('SELECT id,name FROM agents_config ORDER BY id LIMIT 5001'));
        try { agentId = preferredMention(targetText, team) ?? agentId; }
        catch { return reply.code(400).send({ code: 'ambiguous_group_mentions', error: 'Choose the intended agent.' }); }
      }
    }
    // CHAT-BUILD-01: a picked model is used as picked; "auto" answers with the agent's model and lets the router choose.
    const autoModel = requestedModel === AUTO_MODEL;
    const systemPromptAppend = rawPromptAppend === undefined ? undefined : capMiddle(rawPromptAppend, PROMPT_APPEND_CHARS);
    const model = autoModel ? undefined : requestedModel;
    const notices: string[] = [];
    const savedReplyAgent=agentId?await getAgentById(agentId):await getPrimaryAgent();
    if (agentId && !savedReplyAgent) return reply.code(400).send({ code: 'unknown_agent', error: 'Unknown agent.' });
    return withRunAdmission({runId:input.runId??currentChatRun()?.runId??'',ownerId:userId,agentId:savedReplyAgent?.id??'',sessionId,kind:'chat',inputDigest:runInputDigest({runId:input.runId??currentChatRun()?.runId??null,sessionId,userId,agent:savedReplyAgent,messages,conversation:input.conversation??null,images:input.images??[],memoryContext:bodyMemoryContext??null,systemPrompt:systemPrompt??null,systemPromptAppend:rawPromptAppend??null,handoff:input.handoff??null,model:requestedModel??null,fileReadRoot:input.fileReadRoot??null,writeFolders:input.writeFolders??[]}),unknownSources:[
      ...(messages.length!==1||messages[0]?.role!=='user'||input.conversation?.turns.length?['unverified-chat-history']:[]),
      ...(bodyMemoryContext?['client-memory-context']:[]),...(systemPrompt||rawPromptAppend?['unversioned-prompt-input']:[]),
      ...(input.handoff?['prior-handoff-input']:[]),...(input.images?.length?['unverified-image-source']:[]),
      'unversioned-agent-configuration',
    ]},async()=>{
    const subscriptionSource=model||savedReplyAgent?.model;
    if(subscriptionModel(subscriptionSource)){
      taintRunAdmission('external-coding-app-context');
      const owner=await sql().read(one<{role:string}>('SELECT role FROM users WHERE id=?',userId));
      if(!subscriptionEnabled()||owner?.role!=='owner'||input.channelTurn||!input.fileReadRoot)return reply.code(403).send({code:'forbidden'});
      const abort=new AbortController();reply.raw.once?.('close',()=>{if(!reply.raw.writableEnded)abort.abort();});
      openSseStream(reply.raw);
      try{
        const selectedAgent=savedReplyAgent;
        if(!selectedAgent)throw Error('agent_context_unavailable');
        // STORE-MAP-01 P2 (CX6, AG1): the one resolved context; guides by name (read with guide_read through Girru's tools).
        // P4 (D16): with the personality record on, coding apps use the same one context.
        let p2Context:Awaited<ReturnType<typeof resolveAgentContext>>|null=null;
        let drawers=await withoutArchivedDrawers(userId,chatTurnDrawers(true,memoryScope));
        // STORE-MAP-01 P9 (PRIV2): a coding app is not on this computer; places that stay here are left out.
        if(storeP9Enabled())drawers=(await cloudSafeDrawers(userId,drawers)).drawers;
        const codingMemoryScope={userId,agentId:selectedAgent.id,drawers,project:drawers.find(d=>d.kind==='project')?.key??null,delegatedFrom:[],audience:'owner' as const,runId:input.runId??currentChatRun()?.runId};
        if(oneContextEnabled())p2Context=await scopeAdmittedMemory(codingMemoryScope,()=>resolveAgentContext({agentId:selectedAgent.id,entry:'coding_app',ownerId:userId,sessionId}));
        const context=p2Context?renderCodingAppInstructions(p2Context):await scopeAdmittedMemory(codingMemoryScope,()=>subscriptionAgentContext(selectedAgent.id,{sessionId}));
        // CHAT-BUILD-01: the coding app gets the newest turns plus summaries of older ones and a bounded
        // set of top memories, instead of the whole conversation on every turn (plan usage).
        const lines=(list:readonly {role:string;content:unknown}[])=>list.map(m=>`${m.role}: ${messageText(m.content as ChatMessage['content'])}`).join('\n\n');
        let history=lines(messages);
        if(input.conversation?.turns.length){
          try{const h=await budgetHistory({sessionId,userId,turns:input.conversation.turns,historyTokens:SUBSCRIPTION_HISTORY_TOKENS,summaryTokens:contextBudget().summaryTokens});history=`${h.summaryText?`${h.summaryText}\n\n`:''}${lines(h.messages)}`;}
          catch(err){safeConsole.log('[Chat] Conversation summaries unavailable',safeErrorFields(err));}
        }
        let memoryText='';
        try{const readable=await readableDrawers(selectedAgent.id,drawers,userId);const selectedPack=await consumeAdmittedMemory({userId,agentId:selectedAgent.id,drawers:readable,project:readable.find(d=>d.kind==='project')?.key??null,delegatedFrom:[],audience:'owner',runId:input.runId??currentChatRun()?.runId},()=>contextPack({userId,agentId:selectedAgent.id,drawers:readable,persona:'',scopeFacts:null,handoff:input.handoff??null}));observeAdmittedContext(selectedPack.items);memoryText=selectedPack.text.trim();}
        catch(err){safeConsole.log('[Chat] Memory context unavailable',safeErrorFields(err));}
        // STORE-MAP-01 pilot (CX6): the pilot agent's coding-app reply also gets its pinned facts and the
        // project's newest handoff (Girru agents and coding tools), as data, from the one resolved context.
        if(p2Context||isPilotAgent(selectedAgent.id)){try{const data=renderMemoryData(p2Context??await scopeAdmittedMemory(codingMemoryScope,()=>resolveAgentContext({agentId:selectedAgent.id,entry:'coding_app',ownerId:userId,sessionId})));if(data)memoryText=memoryText?`${data}\n\n${memoryText}`:data;}
          catch(err){safeConsole.log('[Chat] Pilot context unavailable',safeErrorFields(err));}}
        // SUB3: with P2 the memory part has a token budget (counted like every other prompt part), not a character cap.
        if(memoryText)history=`${p2Context?capTokens(memoryText,CODING_APP_MEMORY_TOKENS):capMiddle(memoryText,SUBSCRIPTION_MEMORY_CHARS)}\n\n${history}`;
        const registry=await createAgentToolsRegistry({userId,sessionId,agentId:selectedAgent.id,workspaceDir:input.fileReadRoot,fileReadRoot:input.fileReadRoot,memoryDrawers:drawers,chatPlan:true});
        useRemoteModelTools(registry); // STORE-MAP-01 P8: a coding app is not a local model (nothing changes with P8 off)
        let toolStep=0;
        // CHAT-GAPS-01: Codex sees the images (-i, files of the chat's own image folder), Claude Code too (image blocks in one
        // stream-json message); Gemini cannot take images on its stream-json input, so it is told the names and the chat says so.
        const seen=await chatImagesSeenBy(subscriptionSource,input.images?.map(i=>i.file));
        if(input.images?.length&&!seen.length){currentChatRun()?.notice?.('images_not_seen',`${subscriptionSource?.includes('codex')?'Codex':subscriptionSource?.includes('gemini')?'Gemini':'Claude Code'} cannot see ${input.images.length===1?'this image':'these images'} (Gemini takes text only; Claude Code takes images up to 3.75 MB). Pick Claude Code, Codex or Claude, or a local model that can see.`);history+=`\n\n(The owner attached ${input.images.length} image${input.images.length===1?'':'s'}: ${input.images.map(i=>i.name??'image').join(', ')}. You cannot see them; say so if they matter.)`;}
        // STORE-MAP-01 P2b (XP1): the same tools on demand as a local model (the memory verbs, tool_load, an index).
        const allTools=registry.getAll().map(t=>({name:t.name,description:t.description,input_schema:t.input_schema}));
        const onDemand=storeP2bEnabled()?new OnDemandTools(allTools,'large'):null;
        const toolIndex=onDemand?.index()??'';
        // CHAT-LIVE-01 (LW6): outside "Accept edits" the coding app's own file access is read-only; file changes go through Girru's edit/write (the owner approves each).
        const fileNote=currentChatRun()?.chatMode!=='accept_edits'&&input.fileReadRoot?'Your own file access in this chat is read-only. To change a file in this folder, call the Girru tool edit (part of an existing file; read it first) or write (a whole file), loading it with tool_load first when it is not listed; the owner approves the change, then it is made in the real file. Do not say the change is impossible.':'';
        // CP15: when the owner lets agents run commands, say so, so the agent runs them instead of listing them for the owner.
        const commandNote=input.fileReadRoot&&allTools.some(t=>t.name==='run_command')?'You can run shell commands in this chat\u2019s project folder with the Girru tool run_command (git status, log, diff, fetch, pull, ls, cat, grep), loading it with tool_load first when it is not listed. Run them yourself and answer with the result; do not give the owner commands to copy. Any other command (builds, tests, installs, pipes, deleting, pushing) goes through run_command_owner, which shows the owner a Run button.':'';
        const replyPrompt=subscriptionReplyPrompt(context+(toolIndex?`\n\n${toolIndex}`:'')+(systemPromptAppend?`\n\n${systemPromptAppend}`:'')+(fileNote?`\n\n${fileNote}`:'')+(commandNote?`\n\n${commandNote}`:''),history);
        {const run=currentChatRun();if(run)run.usage={model:subscriptionSource!,tokensIn:estimateTokens(replyPrompt)};}
        const answer=await subscriptionToolLoop({prompt:replyPrompt,signal:abort.signal,
          tools:onDemand?onDemand.definitions():allTools,
          ...(onDemand?{isOffered:(name:string)=>onDemand.has(name)}:{}),
          // CHAT-BUILD-01 stage 3: "Accept edits" lets the coding app edit files in the chat's folders (its write folders too).
          reply:async prompt=>{await beforeAdmittedModel();return runSubscription(subscriptionSource,input.fileReadRoot!,prompt,abort.signal,{...(currentChatRun()?.chatMode==='accept_edits'?{editsOnly:true,addDirs:input.writeFolders??[]}:{appToolsOnly:true}),images:seen,thinking:currentChatRun()?.thinking,agentId:selectedAgent?.id??null});},
          execute:(name,args)=>{toolStep++;if(!reply.raw.writableEnded)reply.raw.write(`data: ${JSON.stringify({type:'tool_start',step:toolStep,tools:[{id:`subscription-${toolStep}`,name,input:JSON.stringify(args)}]})}\n\n`);return onDemand?onDemand.execute(name,args,(n,a)=>executeAdmittedTool(registry,n,a)):executeAdmittedTool(registry,name,args);},
          onTool:(name,result)=>{if(!reply.raw.writableEnded)reply.raw.write(`data: ${JSON.stringify({type:'tool_result',step:toolStep,results:[{id:`subscription-${toolStep}`,name,output:result.content.filter(b=>b.type==='text').map(b=>b.text??'').join('\n').slice(0,2000),isError:!!result.error}]})}\n\n`);},
        });
        for(const content of chunkText(answer,ANSWER_FRAME_BYTES))if(!reply.raw.writableEnded)reply.raw.write(`data: ${JSON.stringify({content,done:false})}\n\n`);
        if(!reply.raw.writableEnded)reply.raw.write(`data: ${JSON.stringify({content:'',done:true})}\n\n`);
      }catch(error){
        // CP15: a coding app that stopped leaves a short, safe reason in the log (an error code only, never its output).
        {const m=error instanceof Error?error.message:'';if(!abort.signal.aborted&&subscriptionSource){try{const {signedInCodingApps}=await import('../../devices/ai-tool.js');if(!(await signedInCodingApps()).has(subscriptionSource.split(':').slice(0,2).join(':')))currentChatRun()?.notice?.('not_signed_in',`${subscriptionSource.includes('codex')?'Codex':subscriptionSource.includes('gemini')?'Gemini':'Claude Code'} is not signed in on this computer. Sign in once in Girru's Terminal (for example claude auth login), then try again.`);}catch{/* the error line below still shows */}}console.warn('subscription_turn_failed',subscriptionSource?.replace(/[^a-z:_-]/gi,'').slice(0,40)??'unknown',abort.signal.aborted?'stopped':/^[a-z0-9_:-]{1,80}$/i.test(m)?m:'unclassified');}
        // CHAT-BUILD-01 stage 5 (CH10): a coding app that hit its plan limit says so before the error.
        if(!abort.signal.aborted&&error instanceof Error&&!/^cli_/.test(error.message)&&/limit|quota|usage|rate/i.test(error.message))currentChatRun()?.notice?.('plan_limit','The coding app hit its plan limit. Switch this chat to Auto or a local model.');
        if(!abort.signal.aborted&&!reply.raw.writableEnded)reply.raw.write(`data: ${JSON.stringify({type:'error',code:error instanceof Error&&error.message==='subscription_org_blocked'?'subscription_org_blocked':error instanceof Error&&error.message==='cli_usage_limit'?'usage_limit':'model_unavailable',error:'The subscription CLI could not finish.'})}\n\n`);}
      reply.raw.end();return reply;
    }
    const channelTurn = input.channelTurn || undefined;
    // SECURITY (S0-Q.8): a channel-originated turn (Telegram/Discord/Agent Connect sender)
    // gets the restricted channel tool policy. It is bound to a server-created token,
    // never to anything in the request body.
    const toolPolicy: ChannelToolPolicy | undefined = channelTurn?.policy;

    // Resolve agent config: specific agent > primary agent > fallback defaults
    const agentConfig = agentId ? await getAgentById(agentId) : await getPrimaryAgent();
    // The local-model-only stage answers with the default local model, or with a picked LM Studio model (also on this machine).
    let resolvedModel = localModelOnly() ? (input.provider === 'lmstudio' && model ? model : DEFAULT_MODEL) : (model || agentConfig?.model || DEFAULT_MODEL);
    // CORE-01: the agent's current personality version sets temperature,
    // output length and the working-style prompt block. An explicit request
    // value still wins. Personality never changes tools or approvals: the
    // tool registry below is built from grants only.
    const behavior = agentConfig?.id ? await personalityBehavior(agentConfig.id) : null;
    const resolvedTemp = temperature ?? behavior?.temperature ?? agentConfig?.temperature ?? 0.7;
    const resolvedMaxTokens = maxTokens ?? behavior?.maxTokens ?? agentConfig?.max_tokens;
    const agentName = agentConfig?.name;

    // SECURITY (S0-A.14): a channel turn answers an outside sender, so the
    // agent's private MEMORY.md and recalled memory context stay out of the
    // prompt unless the server opts in (OUTSIDER_AGENT_MEMORY=true).
    const includeAgentMemory = !channelTurn || outsiderAgentMemoryEnabled();
    const memoryContext = includeAgentMemory ? bodyMemoryContext : undefined;

    // CORE-03: memory drawers the agent's memory tools may read this turn. The
    // user's own chat opens owner + experience + only the named project/task/
    // people drawers; a channel turn (outsider) opens none.
    let memoryDrawers: DrawerRef[];
    try {
      memoryDrawers = chatTurnDrawers(includeAgentMemory, memoryScope);
    } catch (err) {
      if (err instanceof DrawerInputError) return reply.status(400).send({ error: 'Invalid memoryScope' });
      throw err;
    }
    // MEM-SCALE-01: an archived project is kept but never loaded into a reply.
    memoryDrawers = await withoutArchivedDrawers(userId, memoryDrawers);
    // MEM-UX-02: a group of projects that shares within opens its other projects too (audited).
    const grouped = await withGroupDrawers(userId, memoryDrawers, async project => !agentConfig?.id || (await loadRunPermissions(agentConfig.id, [], {userId,project})).memoryRead.includes('project'));
    if (grouped.added.length) {
      memoryDrawers = grouped.drawers;
      logAudit({
        event_type: 'data.read', event_category: 'data_access', severity: 'info', user_id: userId,
        resource_type: 'memory_group', resource_id: grouped.groupId ?? '', action: 'memory_group.share_within', success: true,
        metadata: { agentId: agentConfig?.id ?? null, project: memoryDrawers.find((d) => d.kind === 'project')?.key ?? null, added: grouped.added.map((d) => d.key) },
      });
    }
    // STORE-MAP-01 P9 (PRIV2, D23): a place that stays on this computer never reaches a model that is not.
    // The provider is decided below from the same inputs; it can only become more local there (no key -> local).
    const p9Cloud = storeP9Enabled() && !providerIsLocal(localModelOnly() ? (input.provider === 'lmstudio' ? 'lmstudio' : 'ollama')
      : (input.provider || agentConfig?.provider || ((await getSettingsManager().getSettings()).provider === 'claude' ? 'claude' : 'ollama')), resolvedModel);
    let withheldLocal: DrawerRef[] = [];
    if (p9Cloud) ({ drawers: memoryDrawers, withheld: withheldLocal } = await cloudSafeDrawers(userId, memoryDrawers));
    // MEM-SCALE-01: the owner's pinned facts of this scope load first (company, department, project).
    // Only facts of drawers this agent may read in this project (its inherited access, CORE-PERMS-01 cap).
    const pinnedProject = memoryDrawers.find((d) => d.kind === 'project')?.key ?? null;
    let pinnedFacts: ReplyPinnedFacts = { text: '', facts: [] };
    if (includeAgentMemory) {
      try {
        const perms = agentConfig?.id
          ? await loadRunPermissions(agentConfig.id, [], { userId, project: pinnedProject })
          : { memoryRead: ['owner', 'project'] };
        let allow = scopeFactAccess(perms, memoryDrawers.some((d) => d.kind === 'owner'));
        if (p9Cloud) allow = await cloudSafePinnedAllow(userId, pinnedProject ?? withheldLocal.find((d) => d.kind === 'project')?.key ?? null, allow);
        if (allow.company || allow.project) pinnedFacts = await consumeAdmittedMemory({userId,agentId:agentConfig?.id??'',drawers:memoryDrawers,project:pinnedProject,delegatedFrom:[],audience:channelTurn?'outsider':'owner',runId:input.runId??currentChatRun()?.runId},()=>pinnedFactsForReply(userId,pinnedProject,allow));
      } catch { pinnedFacts = { text: '', facts: [] }; }
    }

    // Load PERSONALITY.md and MEMORY.md from agent files if agent has ID
    let personalityContent = '';
    let memoryFileContent = '';
    if (agentConfig?.id) {
      try {
        // The generated settings block is a readable export; the database values are used instead.
        personalityContent = stripPersonalityExport(await readPersonality(agentConfig.id));
        // STORE-MAP-01 P5: the agent's own notes from its drawer once imported (else the file), framed as data below.
        memoryFileContent = includeAgentMemory ? await consumeAdmittedMemory({userId,agentId:agentConfig.id,drawers:memoryDrawers,project:pinnedProject,delegatedFrom:[],audience:channelTurn?'outsider':'owner',runId:input.runId??currentChatRun()?.runId},()=>agentMemoryForPrompt(agentConfig!.id)) : '';
        console.log(`[Chat] 📝 Loaded PERSONALITY.md (${personalityContent.length} chars) and MEMORY.md (${memoryFileContent.length} chars) for agent ${agentConfig.name}`);
      } catch (err) {
        console.log('[Chat] No agent files found, using database system_prompt');
      }
    }

    // STORE-MAP-01 P2 (CX6): one resolved context. Owner rules come first, then the hired
    // instructions, personality text, working style, guides by name, team and knowledge; the
    // context pack below adds the memory. Off: the earlier builder, unchanged.
    let resolvedSystemPrompt = '';
    // P4 (T7, D16): the personality record and the job text reach chat through the same one context.
    if (oneContextEnabled() && agentConfig?.id && agentConfig.id !== 'small-local-agent') {
      const ctx = await scopeAdmittedMemory({userId,agentId:agentConfig.id,drawers:memoryDrawers,project:pinnedProject,delegatedFrom:[],audience:channelTurn?'outsider':'owner',runId:input.runId??currentChatRun()?.runId},()=>resolveAgentContext({agentId:agentConfig!.id,entry:channelTurn?'channel':'chat',ownerId:userId,sessionId,instructionsOverride:systemPrompt??null}));
      resolvedSystemPrompt = renderSystemPrompt(ctx, { data: false });
      if (memoryFileContent) resolvedSystemPrompt += frameUntrustedMemory(memoryFileContent,'agent');
    } else {
      // Build system prompt: PERSONALITY.md > database system_prompt > none
      const personaText = systemPrompt || personalityContent || (agentConfig?.system_prompt?.trim() ? agentConfig.system_prompt : undefined);
      const rawSystemPrompt = personaText === undefined ? undefined : capMiddle(personaText, PERSONA_PROMPT_CHARS);

      // Auto-inject agent name into system prompt if it's set and not already mentioned
      const baseSystemPrompt = agentName && rawSystemPrompt && !rawSystemPrompt.toLowerCase().includes(agentName.toLowerCase())
        ? `Your name is ${agentName}.\n\n${rawSystemPrompt}`
        : rawSystemPrompt;

      // Build complete context: Base Prompt + Personality settings + Agent Memory File + Session Memory
      resolvedSystemPrompt = baseSystemPrompt || '';
      if (agentConfig?.id && agentConfig.id !== 'small-local-agent') resolvedSystemPrompt += await agentSkillsPrompt(agentConfig.id);
      // AGENTS-ORG-01: who it reports to, who is under it, its sub-agents (names only; grants nothing).
      if (agentConfig?.id && agentConfig.id !== 'small-local-agent') {
        const team = await teamContext(agentConfig.id).catch(() => '');
        if (team) resolvedSystemPrompt += `\n\n## Team\n${team}`;
        // RULES-01: the owner's rules for this agent in this chat's project.
        const rules = await rulesContext(agentConfig.id, { sessionId }).catch(() => '');
        if (rules) resolvedSystemPrompt += `\n\n## Owner rules\n${rules}`;
      }

      if (behavior) {
        resolvedSystemPrompt = resolvedSystemPrompt
          ? `${resolvedSystemPrompt}\n\n${behavior.promptBlock}`
          : behavior.promptBlock;
      }

      // Add MEMORY.md content if exists
      if (memoryFileContent) {
        resolvedSystemPrompt += frameUntrustedMemory(memoryFileContent,'agent');
      }
      // AGENT-FILES-01: the Knowledge files the owner marked "It reads this file" (reference data; same gate as MEMORY.md).
      if (includeAgentMemory && agentConfig?.id && agentConfig.id !== 'small-local-agent') {
        resolvedSystemPrompt += await knowledgeContext(agentConfig.id).catch(() => '');
      }
    }

    // MEM-CACHE-01: the context pack (this persona text + the scope's pinned facts,
    // pinned memories, standing topics and the handoff note, cached per agent +
    // drawers + revisions; every item listed in the reply trace), then
    // the memories that match this message. A turn for an outsider opens no
    // drawers and gets no handoff note.
    const turnStartedAt = Date.now();
    let pack: ContextPack | null = null;
    let recall: MessageRecall = { text: '', items: [], hit: false };
    const lastUser = messages[messages.length - 1];
    let loadedDrawers: DrawerRef[] = [];
    try {
      const drawers = await readableDrawers(agentConfig?.id, memoryDrawers, userId);
      loadedDrawers = drawers;
      pack = await consumeAdmittedMemory({userId,agentId:agentConfig?.id??'',drawers,project:drawers.find(d=>d.kind==='project')?.key??null,delegatedFrom:[],audience:channelTurn?'outsider':'owner',runId:input.runId??currentChatRun()?.runId},()=>contextPack({userId,agentId:agentConfig?.id??null,drawers,persona:resolvedSystemPrompt,scopeFacts:pinnedFacts,handoff:includeAgentMemory&&!channelTurn?input.handoff??null:null}));
      const admittedPack=pack;
      observeAdmittedContext(admittedPack.items);
      resolvedSystemPrompt = admittedPack.text;
      // MEM-ACC-02: the recall query carries the names of what the conversation is about (no model).
      const recallQuery = await chatRecallQuery({ ownerId: userId, message: messageText(lastUser?.content), history: messages.slice(0, -1).slice(-60).map((m) => messageText(m.content)).filter(Boolean), openProjectSlug: drawers.find((d) => d.kind === 'project')?.key ?? null });
      recall = await consumeAdmittedMemory({userId,agentId:agentConfig?.id??'',drawers,project:drawers.find(d=>d.kind==='project')?.key??null,delegatedFrom:[],audience:channelTurn?'outsider':'owner',runId:input.runId??currentChatRun()?.runId},()=>messageRecall({userId,drawers,query:recallQuery.query,parts:recallQuery.parts,pack:admittedPack,agentId:agentConfig?.id??null}));
      observeAdmittedContext(recall.items);
    } catch (err) {
      taintRunAdmission('incomplete-memory-context');
      safeConsole.log('[Chat] Memory context unavailable', safeErrorFields(err));
      // STORE-MAP-01 P9 (FAIL4, AG8): the reply goes on without memory, says so when it matters, never invents it.
      if (storeP9Enabled() && includeAgentMemory) {
        resolvedSystemPrompt += `${resolvedSystemPrompt ? '\n\n' : ''}${MEMORY_UNAVAILABLE_NOTE}`;
        void recordHealthEvent(userId, 'recall_failed', agentConfig?.id ?? null);
      }
      if (pinnedFacts.text) resolvedSystemPrompt += `${resolvedSystemPrompt ? '\n\n' : ''}${pinnedFacts.text}`;
      if (input.handoff?.text && includeAgentMemory && !channelTurn) resolvedSystemPrompt += `\n\n${input.handoff.text}`;
    }

    // Add session memory context if available
    if (memoryContext) {
      resolvedSystemPrompt += frameUntrustedMemory(memoryContext,'client');
    }
    // An agent's explicit provider wins; without one, follow the global settings provider.
    // LM Studio is local too (127.0.0.1 only), so the local-model-only stage keeps a picked LM Studio model.
    let resolvedProvider = localModelOnly() ? (input.provider === 'lmstudio' ? 'lmstudio' : 'ollama') : (input.provider || agentConfig?.provider
      || ((await getSettingsManager().getSettings()).provider === 'claude' ? 'claude' : 'ollama'));
    // SECURITY (S1.1): keys come from the credential authority only: the
    // agent's own encrypted key, else the global Settings key.
    const resolvedApiKey = resolvedProvider === 'claude'
      ? await resolveProviderApiKey('claude', { agentId: agentConfig?.id })
      : '';
    // No key for the paid provider: answer with the local model instead of
    // sending a Claude model name to the local server (which always failed).
    if (resolvedProvider === 'claude' && !resolvedApiKey) {
      resolvedProvider = 'ollama';
      resolvedModel = DEFAULT_MODEL;
      console.log('[Chat] No Claude key set; using the local model', { model: resolvedModel });
      notices.push(noticeFrame('claude_key_missing', { model: resolvedModel }));
    }
    // STORE-MAP-01 P2b: a generic OpenAI-compatible server on this computer (`openai-local:<model>`); off, it is never used.
    if (storeP2bEnabled() && !localModelOnly() && (resolvedProvider === 'openai-local' || isOpenAiLocalModelId(resolvedModel)) && openAiLocalModelName(resolvedModel) && openAiLocalUrl()) resolvedProvider = 'openai-local';
    else if (resolvedProvider === 'openai-local') { resolvedProvider = 'ollama'; resolvedModel = DEFAULT_MODEL; }
    // A Claude model name never goes to the local model server.
    if (resolvedProvider === 'ollama' && /^(claude-|lmstudio:|openai-local:)/.test(resolvedModel)) resolvedModel = DEFAULT_MODEL;
    // CORE-MODEL-01: a local model that is no longer installed (or an embedding
    // model) is replaced by an installed chat model, the default one first.
    if (resolvedProvider === 'ollama') {
      const installed = await resolveLocalModel(resolvedModel, DEFAULT_MODEL);
      if (installed !== resolvedModel) safeConsole.log('[Chat] Local model not installed; using', installed, 'instead of', resolvedModel);
      resolvedModel = installed;
    }
    // P9 (PRIV2): the model finally chosen must be as local as the one memory was loaded for (fail closed).
    if (storeP9Enabled() && !p9Cloud && !providerIsLocal(resolvedProvider, resolvedModel)) {
      return reply.status(409).send({ error: 'This model is not on this computer, and this reply holds memory that stays on this computer. Pick a local model or try again.', code: 'stays_local' });
    }
    // MEM-CACHE-01: a saved conversation keeps its newest turns in full and
    // gives older ones as rolling summaries, within the context budget.
    const budget = contextBudget();
    // STORE-MAP-01 P2b (LOCAL-ONLY-01): a local model's real window sets this turn's budget.
    const p2bWindow: ModelWindow | null = p2bLocalTurn(resolvedProvider) ? await localModelWindow(resolvedProvider, resolvedModel) : null;
    const p2bBudget = p2bWindow ? planLocalBudget(p2bWindow.tokens) : null;
    if (p2bBudget) { budget.promptTokens = p2bBudget.promptTokens; budget.numCtx = p2bBudget.window; budget.summaryTokens = Math.min(budget.summaryTokens, Math.floor(p2bBudget.promptTokens / 8)); }
    let turnMessages: ChatMessage[] = messages;
    let history: BudgetedHistory | null = null;
    if (input.conversation?.turns.length) {
      const fixed = estimateTokens(resolvedSystemPrompt) + estimateTokens(systemPromptAppend ?? '') + estimateTokens(uiSpecPrompt(p2bBudget?.tier === 'small' ? 'chat' : input.uiSet ?? 'full'))
        + estimateTokens(recall.text) + (p2bBudget ? p2bBudget.tools : TOOLS_RESERVE_TOKENS) + 200;
      try {
        history = await budgetHistory({
          sessionId, userId, turns: input.conversation.turns,
          historyTokens: Math.max(512, budget.promptTokens - fixed), summaryTokens: budget.summaryTokens,
        });
        turnMessages = history.messages;
        if (history.summaryText) resolvedSystemPrompt += `\n\n${history.summaryText}`;
        // CHAT-BUILD-01 stage 5 (CH10): say once that older messages were summed up to keep room for the work.
        if (history.summarisedTurns > 0) currentChatRun()?.notice?.('summarized', `${history.summarisedTurns} older messages were summed up to keep room for the work.\n\n${history.summaries.map((u) => u.text).join('\n\n')}`.trim());
      } catch (err) {
        safeConsole.log('[Chat] Conversation summaries unavailable', safeErrorFields(err));
      }
    }
    // The recalled memory goes with the new message (after the history), so the
    // system text and the earlier turns stay a stable prefix for the model's cache.
    if (recall.text) {
      const last = turnMessages[turnMessages.length - 1];
      if (last && last.role === 'user' && typeof last.content === 'string') {
        turnMessages = [...turnMessages.slice(0, -1), { ...last, content: `${recall.text}\n\n${last.content}` }];
      } else {
        resolvedSystemPrompt += `\n\n${recall.text}`;
      }
    }
    // CHAT-GAPS-01: the new message's images ride on it (each provider turns them into its own format).
    if (input.images?.length) {
      const last = turnMessages[turnMessages.length - 1];
      if (last && last.role === 'user') turnMessages = [...turnMessages.slice(0, -1), { ...last, images: input.images }];
    }

    // CORE-MODEL-02: the agent knows which model ("brain") answers this turn,
    // so it can name it when asked instead of guessing.
    resolvedSystemPrompt = `${resolvedSystemPrompt ? `${capMiddle(resolvedSystemPrompt, SYSTEM_PROMPT_CHARS)}\n\n` : ''}${modelIdentityBlock(resolvedProvider, resolvedModel)}`;

    // CHAT-BUILD-01 stage 4: tokens by model in the chat (the router may still pick the Claude model for Auto).
    { const run = currentChatRun(); if (run) run.usage = { model: resolvedModel, tokensIn: estimateTokens(resolvedSystemPrompt) + estimateTokens(systemPromptAppend ?? '') + turnMessages.reduce((n, m) => n + estimateTokens(messageText(m.content)), 0) }; }
    // MEM-CACHE-01: the reply trace (never for a turn that answers an outsider).
    const traceRun = !channelTurn && input.runId ? input.runId : undefined;
    if (traceRun) {
      const promptTokens = estimateTokens(resolvedSystemPrompt) + estimateTokens(systemPromptAppend ?? '')
        + turnMessages.reduce((n, m) => n + estimateTokens(messageText(m.content)), 0);
      await consumeAdmittedMemory({userId,agentId:agentConfig?.id??'',drawers:loadedDrawers,project:loadedDrawers.find(d=>d.kind==='project')?.key??null,delegatedFrom:[],audience:'owner',runId:traceRun},()=>saveTrace({
        runId: traceRun, userId, sessionId, agentId: agentConfig?.id ?? null,
        items: [...(pack?.items ?? []), ...recall.items],
        context: {
          keptTurns: history?.keptTurns ?? turnMessages.length,
          summarisedTurns: history?.summarisedTurns ?? 0,
          summaries: (history?.summaries ?? []).map((u) => ({ id: u.id, turns: u.turns, source: u.source })),
          droppedTurns: history?.droppedTurns ?? 0,
          fromCache: { pack: !!pack?.hit, recall: recall.hit },
          budgetTokens: budget.promptTokens, numCtx: budget.numCtx,
          // MEM-GAPS-02: what the reply loaded; open drawers this agent may not read.
          drawers: {
            loaded: loadedDrawers.map(drawerId),
            noAccess: memoryDrawers.filter((d) => !loadedDrawers.some((x) => sameDrawer(x, d))).map(drawerId),
            // P9 (PRIV2): ids only; the places that stayed on this computer for this provider.
            ...(withheldLocal.length ? { staysLocal: withheldLocal.map(drawerId), provider: resolvedProvider } : {}),
          },
        },
        packHit: !!pack?.hit, packChars: pack?.memoryChars ?? 0, promptTokens,
      })).catch((err) => safeConsole.log('[Chat] Recall trace not stored', safeErrorFields(err)));
    }
    if (stream) watchFirstWord(reply.raw as any, turnStartedAt, (ms) => {
      recordTtft(ms);
      if (traceRun) void consumeAdmittedMemory({userId,agentId:agentConfig?.id??'',drawers:loadedDrawers,project:loadedDrawers.find(d=>d.kind==='project')?.key??null,delegatedFrom:[],audience:'owner',runId:traceRun},()=>setTraceTtft(traceRun,ms)).catch(()=>{});
    });
    // CHAT-PRO-02 G: an LM Studio turn needs an LM Studio model id (`lmstudio:<name>`).
    if (resolvedProvider === 'lmstudio' && !lmStudioModelName(resolvedModel)) return reply.status(400).send({ error: 'Pick an LM Studio model', code: 'invalid_model' });
    if (resolvedProvider === 'openai-local' && !openAiLocalModelName(resolvedModel)) return reply.status(400).send({ error: 'Pick a local model', code: 'invalid_model' });

    safeConsole.log('[Chat] Agent:', agentConfig?.name || 'none (fallback)', '| Provider:', resolvedProvider, '| Model:', resolvedModel);
    if (memoryContext) console.log('[Chat] Memory context injected', { chars: String(memoryContext).length });

    // CLI bridge providers run a separate local agent with its own tools; never for channel turns.
    if ((toolPolicy || currentChatRun()?.reviewTools) && (resolvedProvider === 'gemini-cli' || resolvedProvider === 'claude-cli')) {
      return reply.status(403).send({ error: 'This agent provider is not available for channel messages' });
    }

    // CHAT-01: a stream turn sends its SSE headers (and starts the heartbeat)
    // as soon as it is accepted, before any model is contacted.
    if (stream) openSseStream(reply.raw);
    if (stream) for (const n of notices) if (!reply.raw.writableEnded) reply.raw.write(n);

    try {
      await beforeAdmittedModel();
      if (stream) {
        return await streamChat(reply, resolvedModel, resolvedProvider, resolvedApiKey, turnMessages, resolvedTemp, resolvedMaxTokens, sessionId, resolvedSystemPrompt, systemPromptAppend, userId, chatContext, toolPolicy, agentConfig?.id, memoryDrawers, input.fileReadRoot, input.uiSet, autoModel, p2bWindow);
      } else {
        const out = await nonStreamChat(reply, resolvedModel, resolvedProvider, resolvedApiKey, turnMessages, resolvedTemp, resolvedMaxTokens, sessionId, resolvedSystemPrompt, systemPromptAppend, userId, chatContext, toolPolicy, agentConfig?.id, memoryDrawers, p2bWindow);
        // A plain result object goes through reply.send so it gets the turn ids.
        return (out as unknown) === reply ? reply : reply.send(out);
      }
    } catch (error: any) {
      if (reply.raw.headersSent) {
        // The stream is open: end it with the one typed error event (H-09).
        console.error('[Chat] Chat request failed:', error?.name || 'Error');
        if (!reply.raw.writableEnded) {
          reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Chat request failed' })}\n\n`);
          reply.raw.end();
        }
        return reply;
      }
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Chat] Chat request failed');
    }
    });
}

/** One short prompt block that names the model and where it runs (CORE-MODEL-02). */
export function modelIdentityBlock(provider: string, model: string): string {
  const where = provider === 'claude' ? 'Anthropic Claude (cloud API)'
    : provider === 'lmstudio' ? 'LM Studio on this computer'
    : provider === 'ollama' ? 'Ollama on this computer'
    : provider;
  const name = provider === 'lmstudio' ? lmStudioModelName(model) || model : model;
  return `## Your model\nThis reply is generated by the model "${name}" (${where}). Keep your normal style and formatting. Only when someone asks who you are or which model or "brain" you use: answer as you normally would, then end with one short line naming this model exactly, written as \`code\` so it shows unchanged. Never claim another model.`;
}

/** Text per answer frame for one-shot answers (CLI bridges). */
const ANSWER_FRAME_BYTES = 4 * 1024;

/** The model could not be reached or refused: one generic error, no upstream text (H-09). */
function modelUnavailable(reply: AgentReply): AgentReply {
  if (reply.raw.headersSent) {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Chat request failed', code: 'model_unavailable' })}\n\n`);
      reply.raw.end();
    }
    return reply;
  }
  return reply.status(502).send({ error: 'Model unavailable', code: 'model_unavailable' });
}

/** The local model server is running but does not have the model (HTTP 404): say so instead of "unreachable". */
function localModelMissing(reply: AgentReply): AgentReply {
  const error = 'The local model is not installed';
  if (reply.raw.headersSent) {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error, code: 'local_model_missing' })}\n\n`);
      reply.raw.end();
    }
    return reply;
  }
  return reply.status(502).send({ error, code: 'local_model_missing' });
}

/** LM Studio could not be reached or refused: one typed error that says what to do (no upstream text). */
/** STORE-MAP-01 P2b: the local OpenAI-compatible server did not answer. */
function openAiLocalNotRunning(reply: AgentReply): AgentReply {
  const error = openAiLocalNotRunningMessage();
  if (reply.raw.headersSent) {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error, code: 'local_server_not_running' })}\n\n`);
      reply.raw.end();
    }
    return reply;
  }
  return reply.status(502).send({ error, code: 'local_server_not_running' });
}

function lmStudioNotRunning(reply: AgentReply): AgentReply {
  const error = lmStudioNotRunningMessage();
  if (reply.raw.headersSent) {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error, code: 'lmstudio_not_running' })}\n\n`);
      reply.raw.end();
    }
    return reply;
  }
  return reply.status(502).send({ error, code: 'lmstudio_not_running' });
}

// Streaming chat response
async function streamChat(
  reply: AgentReply,
  model: string,
  provider: string,
  apiKey: string,
  messages: ChatMessage[],
  temperature: number,
  maxTokens?: number,
  sessionId: string = 'default-session',
  customSystemPrompt?: string,
  systemPromptAppend?: string,
  userId: string = 'default',
  chatContext?: any,
  toolPolicy?: ChannelToolPolicy,
  agentId?: string,
  memoryDrawers?: DrawerRef[],
  fileReadRoot?: string,
  uiSet: 'full' | 'chat' = 'full',
  autoModel = false,
  p2bWindow: ModelWindow | null = null
) {
  console.log('[Chat] 🚀 Starting stream chat');
  safeConsole.log('[Chat]   📦 Model:', model);
  console.log('[Chat]   🏭 Provider:', provider, `(type: ${typeof provider})`);
  safeConsole.log('[Chat]   🆔 Session:', sessionId);
  safeConsole.log('[Chat]   💬 Messages:', messages.length);

  // Extract user message and history
  const userMessage = messages[messages.length - 1]?.content || '';
  // Text form for the agent analyzers, the router and text-only providers;
  // userMessage (maybe multimodal) still goes to the model that takes it.
  const userText = messageText(userMessage);
  const history: Message[] = messages.slice(0, -1).map(m => ({
    role: m.role as 'system' | 'user' | 'assistant',
    content: messageText(m.content),
  }));

  safeConsole.log('[Chat]   Last message length:', typeof userMessage === 'string' ? userMessage.length : 'multimodal');

  // 🧠 Use Agent System to build smart prompt
  let agentResponse;
  try {
    agentResponse = await agent.process({
      message: userText,
      sessionId,
      history,
    });

    console.log('[Chat] 🧠 Agent analysis complete:');
    console.log('[Chat]   Intent:', agentResponse.analysis.intent);
    console.log('[Chat]   Language:', agentResponse.analysis.language);
    console.log('[Chat]   Complexity:', agentResponse.analysis.complexity);
    console.log('[Chat]   Skills suggested:', agentResponse.analysis.requiresSkills);
    console.log('[Chat]   Prompt tokens:', agentResponse.systemPrompt.metadata.tokenCount);
  } catch (error) {
    console.error('[Chat] ⚠️ Agent error, falling back to simple mode:', error);
    // Fallback to simple mode if agent fails
    agentResponse = null;
  }

  // Build messages for Ollama with smart system prompt
  const ollamaMessages: ChatMessage[] = [];

  // Build system prompt: customSystemPrompt takes priority; fall back to SmartPromptBuilder
  // Then append systemPromptAppend (e.g. animation instructions) WITHOUT replacing the base prompt
  const baseSmartPrompt = customSystemPrompt || (agentResponse ? agentResponse.systemPrompt.full : undefined);
  const resolvedSmartPrompt = baseSmartPrompt && systemPromptAppend
    ? `${baseSmartPrompt}\n\n${systemPromptAppend}`
    : (baseSmartPrompt || systemPromptAppend);

  if (resolvedSmartPrompt) {
    ollamaMessages.push({
      role: 'system',
      content: resolvedSmartPrompt,
    });
  }

  // Add history
  ollamaMessages.push(...messages.slice(0, -1));

  // Add user message (with its images, for a model that can see)
  ollamaMessages.push({
    role: 'user',
    content: userMessage,
    ...(messages[messages.length - 1]?.images?.length ? { images: messages[messages.length - 1].images } : {}),
  });

  // Get real tools from the tools registry (11 tools: exec, read, write, browser×4, memory×2, desktop)
  const toolsRegistry = await createAgentToolsRegistry({ userId, sessionId, workspaceDir: process.cwd(), toolPolicy, agentId, memoryDrawers, chatPlan: !toolPolicy, ...(fileReadRoot ? { fileReadRoot } : {}), ...(currentChatRun()?.readRoots?.length ? { extraReadRoots: currentChatRun()!.readRoots } : {}) });
  // STORE-MAP-01 P8: only a turn on the Claude API gets the P8 tool variants; a local model's list never grows (LOCAL-ONLY-01).
  if (provider === 'claude' && apiKey && !toolPolicy) useRemoteModelTools(toolsRegistry);
  const tools = localModelOnly() && !localModelTools() ? [] : toolsRegistry.getToolsForAPI();
  // STORE-MAP-01 P2b (LOCAL-ONLY-01): a local model gets the memory verbs, tool_load and a short index,
  // in a turn fitted to its real window; calls are checked (XP2) and run a few at a time.
  const p2b = p2bWindow && isLocalTurnProvider(provider) ? prepareLocalTurn({
    window: p2bWindow, tools: tools as ToolDef[], systemHead: resolvedSmartPrompt ?? '',
    systemTail: uiSpecPrompt(planLocalBudget(p2bWindow.tokens).tier === 'small' ? 'chat' : uiSet),
    messages: ollamaMessages.filter((m) => m.role !== 'system'), maxTokens, run: (name, args) => executeAdmittedTool(toolsRegistry,name, args),
  }) : null;
  if (p2b) {
    ollamaMessages.length = 0;
    ollamaMessages.push({ role: 'system', content: p2b.system }, ...p2b.messages);
    console.log('[Chat] P2b local turn', localTurnLog(p2b));
  }

  console.log('[Chat] 🔧 Available tools:', tools.length);
  if (tools.length > 0) {
    console.log('[Chat]   Tools:', tools.map((t: any) => t.name).join(', '));
  }

  // Build tool usage instructions for Ollama (explicit instructions required)
  const toolInstructions = tools.length > 0 && !p2b ? `

## CRITICAL: Tool Usage Instructions

You have access to ${tools.length} powerful tools. **YOU MUST USE THEM** when the task requires external data or actions:

Available tools: ${tools.map((t: any) => t.name).join(', ')}

**RULES:**
1. When user asks for real-time data (weather, stocks, news, web info) → ALWAYS use web_fetch tool first
2. When user asks to browse a website → use browser tools
3. When user asks to control the computer → use desktop_control tool
4. NEVER say "I cannot access" or "I don't have access" - TRY THE TOOL FIRST!
5. Use tools in parallel when possible for faster results
6. After getting tool results, present the data using \`\`\`spec blocks for visual display

**Example workflow:**
User: "What's the weather in Basra?"
You: [Call web_fetch tool to get weather data]
You: [Present results with \`\`\`spec blocks showing temperature, conditions, etc.]
` : '';

  // Append json-render UI prompt + tool instructions to Ollama system prompt
  const finalSystemPrompt = provider !== 'claude'
    ? [resolvedSmartPrompt, toolInstructions, uiSpecPrompt(uiSet)].filter(Boolean).join('\n\n---\n\n')
    : resolvedSmartPrompt;

  // Update ollamaMessages system prompt to include JSON render instructions (for non-Claude providers)
  if (!p2b && provider !== 'claude' && ollamaMessages.length > 0 && ollamaMessages[0].role === 'system') {
    ollamaMessages[0].content = finalSystemPrompt ?? '';
  }

  // 💰 COST OPTIMIZATION: Smart model routing based on task complexity
  let selectedModel = model;
  let routingAnalysis = null;

  if (autoModel && (provider === 'claude' || provider === undefined)) {
    const router = createModelRouter({
      costOptimizationEnabled: true, // Enable by default - can make configurable later
    });

    // Analyze task and get recommended model
    const toolNames = tools.map((t: any) => t.name);
    routingAnalysis = router.analyzeAndRoute(userText, history, toolNames);

    // Convert tier to actual Claude model name
    selectedModel = ModelRouter.getModelName(routingAnalysis.recommendedModel);
    { const run = currentChatRun(); if (run?.usage) run.usage.model = selectedModel; }

    console.log('[Cost Optimizer] 🎯 Task analysis:');
    console.log('[Cost Optimizer]   Complexity:', routingAnalysis.complexity);
    console.log('[Cost Optimizer]   Recommended model:', routingAnalysis.recommendedModel, `(${selectedModel})`);
    console.log('[Cost Optimizer]   Reasoning:', routingAnalysis.reasoning);
    console.log('[Cost Optimizer]   Estimated savings:', `${routingAnalysis.estimatedCostSavings}%`);

    // Log usage to cost tracker (async, don't block response)
    CostTracker.logUsage({
      user_id: userId,
      session_id: sessionId,
      timestamp: Date.now(),
      model_used: routingAnalysis.recommendedModel,
      task_complexity: routingAnalysis.complexity,
      message_length: userText.length,
      tools_used: toolNames.join(','),
      estimated_savings_percent: routingAnalysis.estimatedCostSavings || 0,
    }).catch((err) => {
      console.error('[Cost Optimizer] ⚠️ Failed to log usage:', err);
    });
  }

  // Route to the correct provider (key resolved by the credential authority, S1.1)
  if (provider === 'claude' && apiKey) {
    console.log('[Chat] 🤖 Using Claude API');
    return streamChatClaude(
      reply,
      apiKey,
      selectedModel || (await getSettingsManager().getSettings()).claude?.model || 'claude-sonnet-4-5-20250929',
      ollamaMessages,
      finalSystemPrompt,
      tools,
      temperature,
      userId,
      sessionId,
      chatContext,
      toolPolicy,
      agentId,
      maxTokens,
      memoryDrawers,
      fileReadRoot,
      uiSet
    );
  }

  // Provider routing
  console.log('[Chat] 🔀 Routing to provider handler:', provider);

  // Gemini CLI provider: pipe message through local gemini binary
  if (provider === 'gemini-cli') {
    console.log('[Chat] 🖥️ Using Gemini CLI bridge');
    openSseStream(reply.raw);
    const startedAt = Date.now();
    try {
      // Build Gemini prompt: system instructions + json-render + user message
      const geminiSystemParts = [customSystemPrompt, getJsonRenderPrompt()].filter(Boolean).join('\n\n---\n\n');
      const geminiFullPrompt = geminiSystemParts
        ? `${geminiSystemParts}\n\n---\n\nUser: ${userText}`
        : userText;
      await beforeAdmittedModel();
      const result = await geminiCliTool.execute({ prompt: geminiFullPrompt });
      const text = result.content?.[0]?.text || '(no response)';
      const geminiModel = (result.details as any)?.model || 'gemini-2.0-flash';
      console.log(`[Chat] ✅ Gemini CLI responded | model: ${geminiModel} | length: ${text.length}`);
      for (const part of chunkText(text, ANSWER_FRAME_BYTES)) {
        reply.raw.write(`data: ${JSON.stringify({ content: part, done: false, model: geminiModel, provider: 'gemini-cli' })}\n\n`);
      }
      reply.raw.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);
    } catch (err: any) {
      // SECURITY: Don't expose error details in stream (H-09)
      // FU-01: safe fields only; the error can carry stderr, the prompt or paths.
      console.error('[Chat] Gemini CLI error', safeErrorFields(err, startedAt));
      // BUG-02 (CHAT-01): the typed terminal error frame, never text plus done.
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Chat request failed' })}\n\n`);
    }
    reply.raw.end();
    return reply;
  }

  // Claude CLI provider: pipe message through local claude CLI binary
  if (provider === 'claude-cli') {
    console.log('[Chat] 🔧 Using Claude Code CLI bridge');
    openSseStream(reply.raw);
    const startedAt = Date.now();
    try {
      // Build Claude CLI prompt: system instructions + user message
      // NOTE: Skip json-render prompt for CLI to keep under Windows CMD length limit
      const claudeFullPrompt = customSystemPrompt
        ? `${customSystemPrompt}\n\nUser: ${userText}`
        : userText;
      await beforeAdmittedModel();
      const result = await claudeCliTool.execute({
        prompt: claudeFullPrompt,
        model: model || undefined,
        timeout: 180000  // 3 minutes
      }, { workspaceDir: process.cwd(), userId, sessionId, agentId });
      const text = result.content?.[0]?.text || '(no response)';
      const claudeModel = (result.details as any)?.model || model || 'claude-sonnet-4-5-20250929';
      safeConsole.log(`[Chat] ✅ Claude CLI responded | model: ${claudeModel} | length: ${text.length}`);
      for (const part of chunkText(text, ANSWER_FRAME_BYTES)) {
        reply.raw.write(`data: ${JSON.stringify({ content: part, done: false, model: claudeModel, provider: 'claude-cli' })}\n\n`);
      }
      reply.raw.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);
    } catch (err: any) {
      // SECURITY: Don't expose error details in stream (H-09)
      // FU-01: safe fields only; the error can carry stderr, the prompt or paths.
      console.error('[Chat] Claude CLI error', safeErrorFields(err, startedAt));
      // BUG-02 (CHAT-01): the typed terminal error frame, never text plus done.
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Chat request failed' })}\n\n`);
    }
    reply.raw.end();
    return reply;
  }

  // CHAT-PRO-02 G: LM Studio on this computer, same loop and frames as the local Ollama model.
  // STORE-MAP-01 P2b: a generic OpenAI-compatible server on this computer runs the same loop.
  if (provider === 'lmstudio' || (provider === 'openai-local' && p2b)) {
    const generic = provider === 'openai-local';
    console.log(`[Chat] 🤖 Using ${generic ? 'the local OpenAI-compatible server' : 'LM Studio (local)'} agent loop`);
    openSseStream(reply.raw);
    const lmAbort = new AbortController();
    reply.raw.once?.('close', () => { if (!reply.raw.writableEnded) lmAbort.abort(); });
    const lmStarted = Date.now();
    const ended = p2b ? beginLocalReply(model) : () => {};
    try {
      const result = await executeLocalTurn({ provider: provider === 'openai-local' ? 'openai-local' : 'lmstudio', options: {
        url: generic ? openAiLocalUrl() : lmStudioApiUrl(),
        model: generic ? openAiLocalModelName(model) : lmStudioModelName(model),
        messages: ollamaMessages.map((m) => ({ role: m.role === 'system' ? 'system' as const : m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: messageText(m.content), ...(m.images?.length ? { images: m.images } : {}) })),
        tools,
        execute: p2b ? p2b.execute : (name, args) => executeAdmittedTool(toolsRegistry,name, args),
        write: (frame) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`); },
        signal: lmAbort.signal,
        temperature,
        maxTokens: p2b ? p2b.maxTokens : maxTokens,
        ...(p2b ? { toolSet: p2b.toolSet, callCap: p2b.callCap, maxSteps: p2b.maxSteps, toolOutputChars: p2b.toolOutputChars } : {}),
        beforeStep: admittedModelStep(p2b?.beforeStep),beforeTools:beforeAdmittedTools,
      } });
      console.log('[Chat] ✅ LM Studio turn ended', { steps: result.steps, chars: result.answer.length, aborted: result.aborted, ms: Date.now() - lmStarted });
    } catch (err) {
      if (lmAbort.signal.aborted) { reply.raw.end(); return reply; }
      console.error('[Chat] ❌ LM Studio unreachable', safeErrorFields(err, lmStarted));
      return generic ? openAiLocalNotRunning(reply) : lmStudioNotRunning(reply);
    } finally {
      ended();
    }
    reply.raw.end();
    return reply;
  }

  // Default: the local model, with its own agent loop (CHAT-REBUILD-01):
  // streamed text and reasoning, tool calls run through the same registry
  // (exec policy, channel policy, grants and approvals apply), results fed back.
  console.log('[Chat] 🤖 Using Ollama (local) agent loop');
  // CHAT-01: headers go out before Ollama is contacted, so a cold model load
  // cannot trip a pre-header timeout; the heartbeat keeps the stream alive.
  openSseStream(reply.raw);
  // The client went away before the reply ended: stop the model and the loop.
  const upstreamAbort = new AbortController();
  reply.raw.once?.('close', () => { if (!reply.raw.writableEnded) upstreamAbort.abort(); });
  const startedAt = Date.now();
  // CH3: the installed model's capabilities decide whether a Thinking level is sent at all.
  const thinking = currentChatRun()?.thinking;
  const thinkCaps = thinking && thinking !== 'normal' ? (await listLocalModels().catch(() => [])).find((m) => m.name === model)?.capabilities : undefined;
  const ended = p2b ? beginLocalReply(model) : () => {};
  try {
    const result = await executeLocalTurn({ provider: 'ollama', options: {
      url: OLLAMA_URL,
      model,
      messages: ollamaMessages.map((m) => ({ role: m.role, content: messageText(m.content), ...(m.images?.length ? { images: m.images.map((i) => i.data) } : {}) })),
      tools,
      execute: p2b ? p2b.execute : (name, args) => executeAdmittedTool(toolsRegistry,name, args),
      ...(p2b ? { toolSet: p2b.toolSet, callCap: p2b.callCap, maxSteps: p2b.maxSteps, toolOutputChars: p2b.toolOutputChars } : {}),
        beforeStep: admittedModelStep(p2b?.beforeStep),beforeTools:beforeAdmittedTools,
      write: (frame) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`); },
      signal: upstreamAbort.signal,
      temperature,
      maxTokens: p2b ? p2b.maxTokens : maxTokens,
      ...chatThinkFor(thinking, thinkCaps),
      // STORE-MAP-01 P2b: a small window has no room for long thinking (live: qwen3:4b spent the whole reply on it);
      // a small model answers without it unless the owner picked a Thinking level (thinkOptional: a model that cannot think is fine).
      ...(p2b?.budget.tier === 'small' && (!thinking || thinking === 'normal') && !process.env.OLLAMA_THINK ? { think: false, thinkOptional: true } : {}),
      // MEM-CACHE-01: a fixed window and a kept-loaded model let Ollama reuse the prompt prefix.
      // STORE-MAP-01 P2b: the window is the model's own (fixed per model, so the prefix cache still works).
      numCtx: p2b ? p2b.numCtx : contextBudget().numCtx,
      keepAlive: keepAliveValue(),
    } });
    console.log('[Chat] ✅ Local turn ended', { steps: result.steps, chars: result.answer.length, aborted: result.aborted, ms: Date.now() - startedAt });
  } catch (err) {
    if (err instanceof ModelUnavailable) {
      console.error('[Chat] ❌ Ollama request failed', { status: err.status });
      return err.status === 404 ? localModelMissing(reply) : modelUnavailable(reply);
    }
    if (upstreamAbort.signal.aborted) { reply.raw.end(); return reply; }
    console.error('[Chat] ❌ Ollama unreachable', safeErrorFields(err, startedAt));
    return modelUnavailable(reply);
  } finally {
    ended();
  }
  reply.raw.end();
  return reply;
}

// Non-streaming chat response
async function nonStreamChat(
  reply: AgentReply,
  model: string,
  provider: string,
  apiKey: string,
  messages: ChatMessage[],
  temperature: number,
  maxTokens?: number,
  sessionId: string = 'default-session',
  customSystemPrompt?: string,
  systemPromptAppend?: string,
  userId: string = 'default',
  chatContext?: any,
  toolPolicy?: ChannelToolPolicy,
  agentId?: string,
  memoryDrawers?: DrawerRef[],
  p2bWindow: ModelWindow | null = null
) {
  console.log('[Chat] 🚀 Starting non-stream chat');
  safeConsole.log('[Chat]   📦 Model:', model);
  console.log('[Chat]   🏭 Provider:', provider, `(type: ${typeof provider})`);
  safeConsole.log('[Chat]   🆔 Session:', sessionId);
  safeConsole.log('[Chat]   💬 Messages:', messages.length);

  // Extract user message and history
  const userMessage = messages[messages.length - 1]?.content || '';
  // Text form for the agent analyzers, the router and text-only providers;
  // userMessage (maybe multimodal) still goes to the model that takes it.
  const userText = messageText(userMessage);
  const history: Message[] = messages.slice(0, -1).map(m => ({
    role: m.role as 'system' | 'user' | 'assistant',
    content: messageText(m.content),
  }));

  safeConsole.log('[Chat]   Last message length:', typeof userMessage === 'string' ? userMessage.length : 'multimodal');

  // 🧠 Use Agent System to build smart prompt
  let agentResponse;
  try {
    agentResponse = await agent.process({
      message: userText,
      sessionId,
      history,
    });

    console.log('[Chat] 🧠 Agent analysis complete:');
    console.log('[Chat]   Intent:', agentResponse.analysis.intent);
    console.log('[Chat]   Language:', agentResponse.analysis.language);
    console.log('[Chat]   Complexity:', agentResponse.analysis.complexity);
    console.log('[Chat]   Skills suggested:', agentResponse.analysis.requiresSkills);
    console.log('[Chat]   Prompt tokens:', agentResponse.systemPrompt.metadata.tokenCount);
  } catch (error) {
    console.error('[Chat] ⚠️ Agent error, falling back to simple mode:', error);
    // Fallback to simple mode if agent fails
    agentResponse = null;
  }

  // Build messages for Ollama with smart system prompt
  const ollamaMessages: ChatMessage[] = [];

  // Build system prompt: customSystemPrompt takes priority; fall back to SmartPromptBuilder
  // Then append systemPromptAppend (e.g. animation instructions) WITHOUT replacing the base prompt
  const basePromptNS = customSystemPrompt || agentResponse?.systemPrompt.full;
  const finalSystemPromptNS = basePromptNS && systemPromptAppend
    ? `${basePromptNS}\n\n${systemPromptAppend}`
    : (basePromptNS || systemPromptAppend);

  if (finalSystemPromptNS) {
    ollamaMessages.push({ role: 'system', content: finalSystemPromptNS });
  }

  // Add history
  ollamaMessages.push(...messages.slice(0, -1));

  // Add user message
  ollamaMessages.push({
    role: 'user',
    content: userMessage,
  });

  // Get real tools from the tools registry
  const toolsRegistryNS = await createAgentToolsRegistry({ userId, sessionId, workspaceDir: process.cwd(), toolPolicy, agentId, memoryDrawers });
  const tools = localModelOnly() ? [] : toolsRegistryNS.getToolsForAPI();
  // STORE-MAP-01 P2b (LOCAL-ONLY-01): a local model answers with its own loop here too (tools on demand,
  // fitted to its window, calls checked and run a few at a time); the answer comes back in one piece.
  if (p2bWindow && isLocalTurnProvider(provider)) {
    const p2b = prepareLocalTurn({
      window: p2bWindow, tools: tools as ToolDef[], systemHead: finalSystemPromptNS ?? '',
      messages: ollamaMessages.filter((m) => m.role !== 'system'), maxTokens, run: (name, args) => executeAdmittedTool(toolsRegistryNS,name, args),
    });
    console.log('[Chat] P2b local turn (one piece)', localTurnLog(p2b));
    const msgs = [{ role: 'system' as const, content: p2b.system }, ...p2b.messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: messageText(m.content) }))];
    const common = { execute: p2b.execute, write: () => {}, signal: AbortSignal.timeout(180_000), temperature, maxTokens: p2b.maxTokens, tools: [], toolSet: p2b.toolSet, callCap: p2b.callCap, maxSteps: p2b.maxSteps, toolOutputChars: p2b.toolOutputChars, beforeStep: admittedModelStep(p2b.beforeStep),beforeTools:beforeAdmittedTools };
    const ended = beginLocalReply(model);
    try {
      const result = provider === 'ollama'
        ? await executeLocalTurn({ provider: 'ollama', options: { ...common, url: OLLAMA_URL, model, messages: msgs, ...(p2b.budget.tier === 'small' && !process.env.OLLAMA_THINK ? { think: false, thinkOptional: true } : ollamaThinkOption()), numCtx: p2b.numCtx, keepAlive: keepAliveValue() } })
        : await executeLocalTurn({ provider: provider === 'openai-local' ? 'openai-local' : 'lmstudio', options: { ...common, url: provider === 'openai-local' ? openAiLocalUrl() : lmStudioApiUrl(), model: provider === 'openai-local' ? openAiLocalModelName(model) : lmStudioModelName(model), messages: msgs } });
      return { message: { role: 'assistant', content: result.answer }, steps: result.steps };
    } catch (err) {
      if (err instanceof ModelUnavailable && provider === 'ollama') return err.status === 404 ? localModelMissing(reply) : reply.status(502).send({ error: 'Model unavailable', code: 'model_unavailable' });
      if (provider === 'ollama') return reply.status(502).send({ error: 'Model unavailable', code: 'model_unavailable' });
      return provider === 'openai-local' ? openAiLocalNotRunning(reply) : lmStudioNotRunning(reply);
    } finally {
      ended();
    }
  }
  if (provider === 'claude' && apiKey) {
    console.log('[Chat] 🤖 Using Claude API (non-stream)');
    return streamChatClaude(reply, apiKey, model || (await getSettingsManager().getSettings()).claude?.model || 'claude-sonnet-4-5-20250929', ollamaMessages, finalSystemPromptNS, tools, temperature, userId, sessionId, chatContext, toolPolicy, agentId, maxTokens, memoryDrawers);
  }

  // Gemini CLI provider (non-stream path)
  if (provider === 'gemini-cli') {
    console.log('[Chat] 🤖 Using Gemini CLI bridge (non-stream)');
    await beforeAdmittedModel();
      const result = await geminiCliTool.execute({ prompt: userText });
    const text = result.content?.[0]?.text || '(no response)';
    return reply.send({ message: { role: 'assistant', content: text } });
  }

  // Claude CLI provider (non-stream path)
  if (provider === 'claude-cli') {
    console.log('[Chat] 🔧 Using Claude Code CLI bridge (non-stream)');
    await beforeAdmittedModel();
      const result = await claudeCliTool.execute({
      prompt: userText,
      model: model || undefined,
      timeout: 180000
    }, { workspaceDir: process.cwd(), userId, sessionId, agentId });
    const text = result.content?.[0]?.text || '(no response)';
    return reply.send({ message: { role: 'assistant', content: text } });
  }

  // CHAT-PRO-02 G: LM Studio answers in one piece here (no tools, like the local path below).
  if (provider === 'lmstudio') {
    try {
      const result = await executeLocalTurn({ provider: 'lmstudio', options: {
        url: lmStudioApiUrl(),
        model: lmStudioModelName(model),
        messages: ollamaMessages.map((m) => ({ role: m.role === 'system' ? 'system' as const : m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: messageText(m.content) })),
        tools: [],
        execute: async () => ({ content: [] }),
        beforeStep:admittedModelStep(),beforeTools:beforeAdmittedTools,
        write: () => {},
        signal: AbortSignal.timeout(180_000),
        temperature,
        maxTokens,
      } });
      return { message: { role: 'assistant', content: result.answer } };
    } catch {
      return lmStudioNotRunning(reply);
    }
  }

  await beforeAdmittedModel();
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: ollamaMessages,
      stream: false,
      ...ollamaThinkOption(),
      tools: tools.length > 0 ? tools : undefined, // Add tools support
      options: {
        temperature,
        ...(maxTokens && { num_predict: maxTokens })
      }
    })
  });

  if (!response.ok) {
    // SECURITY (H-09): the upstream body is never read, logged or relayed.
    console.error('[Chat] ❌ Ollama request failed', { status: response.status });
    try { await response.body?.cancel(); } catch { /* ignore */ }
    if (response.status === 404) return localModelMissing(reply);
    return reply.status(502).send({ error: 'Model unavailable', code: 'model_unavailable' });
  }

  const data = await response.json() as {
    message: { role: string; content: string };
    total_duration?: number;
    eval_count?: number;
  };

  console.log('[Chat] ✅ Response received');
  console.log('[Chat]   Response length:', data.message.content.length, 'chars');

  return {
    message: {
      role: data.message.role,
      content: data.message.content
    },
    usage: {
      totalDuration: data.total_duration,
      tokenCount: data.eval_count
    },
    // Include agent metadata
    ...(agentResponse && {
      analysis: agentResponse.analysis,
      promptMetadata: agentResponse.systemPrompt.metadata
    })
  };
}
