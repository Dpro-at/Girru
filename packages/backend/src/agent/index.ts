/**
 * Agent System - Main Exports
 *
 * Smart Agent system with:
 * - Layered prompt architecture
 * - Intelligent request analysis
 * - Smart skill selection
 * - Learning capabilities
 *
 * @author Dpro Team
 * @license MIT
 */

// Core components
export { AgentRuntime, type AgentResponse } from './agent-runtime.js';
export { SmartPromptBuilder } from './smart-prompt-builder.js';
export { RequestAnalyzer } from './request-analyzer.js';
export { SkillsSelector } from './skills-selector.js';

// Type definitions
export * from './types.js';

// Re-export for convenience
export type {
  Message,
  PromptBuildParams,
  SystemPrompt,
  RequestAnalysis,
  Skill,
  Tool,
  Memory,
  AgentConfig,
  PerformanceMetrics,
} from './types.js';
