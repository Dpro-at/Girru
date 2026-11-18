/**
 * Agent System - Usage Examples
 *
 * Demonstrates how to use the agent system
 *
 * @author Dpro Team
 */

import { AgentRuntime, Skill } from './index.js';

// Example: Mock skills for demonstration
const exampleSkills: Skill[] = [
  {
    id: 'weather',
    name: 'Weather',
    description: 'Get weather forecasts and current conditions',
    location: '/skills/weather.md',
    category: 'utilities',
    tags: ['weather', 'temperature', 'forecast', 'climate'],
    triggers: ['weather', 'temperature', 'forecast'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Manage GitHub repositories, PRs, and issues',
    location: '/skills/github.md',
    category: 'development',
    tags: ['github', 'repository', 'pr', 'issue', 'git'],
    triggers: ['github', 'repository', 'pull request'],
  },
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Search the web for information',
    location: '/skills/web-search.md',
    category: 'utilities',
    tags: ['search', 'web', 'google', 'find'],
    triggers: ['search', 'find online', 'look up'],
  },
  {
    id: 'note-taking',
    name: 'Note Taking',
    description: 'Create and manage notes',
    location: '/skills/note-taking.md',
    category: 'productivity',
    tags: ['note', 'remember', 'save', 'write'],
    triggers: ['note', 'remember', 'write down'],
  },
  {
    id: 'calculator',
    name: 'Calculator',
    description: 'Perform mathematical calculations',
    location: '/skills/calculator.md',
    category: 'utilities',
    tags: ['calculate', 'math', 'compute', 'sum'],
    triggers: ['calculate', 'compute', 'math'],
  },
];

// ============================================
// Example 1: Basic Usage
// ============================================

async function example1_BasicUsage() {
  console.log('\n=== Example 1: Basic Usage ===\n');

  // Create agent runtime
  const agent = new AgentRuntime();

  // Load skills
  await agent.loadSkills(exampleSkills);

  // Process a simple message
  const response = await agent.process({
    message: "What's the weather in London?",
    sessionId: 'session-example-1',
    history: [],
  });

  console.log('User:', "What's the weather in London?");
  console.log('Agent:', response.content);
  console.log('\nAnalysis:', {
    intent: response.analysis.intent,
    language: response.analysis.language,
    complexity: response.analysis.complexity,
    skillsRequired: response.analysis.requiresSkills,
  });
  console.log('\nMetrics:', {
    tokenCount: response.metrics.totalTokens,
    promptBuildTime: response.metrics.promptBuildTime + 'ms',
    totalTime: (
      response.metrics.promptBuildTime +
      response.metrics.requestAnalysisTime +
      response.metrics.skillSelectionTime
    ) + 'ms',
  });
}

// ============================================
// Example 2: With Conversation History
// ============================================

async function example2_WithHistory() {
  console.log('\n=== Example 2: With Conversation History ===\n');

  const agent = new AgentRuntime();
  await agent.loadSkills(exampleSkills);

  // First message
  const response1 = await agent.process({
    message: "Tell me about TypeScript",
    sessionId: 'session-example-2',
    history: [],
  });

  console.log('User:', "Tell me about TypeScript");
  console.log('Agent:', response1.content);

  // Follow-up message (references history)
  const response2 = await agent.process({
    message: "Can you show me an example?",
    sessionId: 'session-example-2',
    history: [
      { role: 'user', content: "Tell me about TypeScript" },
      { role: 'assistant', content: response1.content },
    ],
  });

  console.log('\nUser:', "Can you show me an example?");
  console.log('Agent:', response2.content);
  console.log('\nContext Analysis:', {
    isFollowUp: response2.analysis.context.isFollowUp,
    referencesHistory: response2.analysis.context.referencesHistory,
  });
}

// ============================================
// Example 3: With User Preferences
// ============================================

async function example3_WithPreferences() {
  console.log('\n=== Example 3: With User Preferences ===\n');

  const agent = new AgentRuntime();
  await agent.loadSkills(exampleSkills);

  // English user, technical tone
  const response1 = await agent.process({
    message: "How do I optimize React performance?",
    sessionId: 'session-example-3a',
    history: [],
    context: {
      userPreferences: {
        language: 'en',
        tone: 'professional',
        responseLength: 'long',
        codeExamples: true,
      },
    },
  });

  console.log('User (English, Professional):', "How do I optimize React performance?");
  console.log('Agent:', response1.content);

  // Arabic user, friendly tone
  const response2 = await agent.process({
    message: "كيف أحسن أداء React؟",
    sessionId: 'session-example-3b',
    history: [],
    context: {
      userPreferences: {
        language: 'ar',
        tone: 'friendly',
        responseLength: 'short',
        codeExamples: false,
      },
    },
  });

  console.log('\nUser (Arabic, Friendly):', "كيف أحسن أداء React؟");
  console.log('Agent:', response2.content);
}

// ============================================
// Example 4: Learning from Feedback
// ============================================

async function example4_Learning() {
  console.log('\n=== Example 4: Learning from Feedback ===\n');

  const agent = new AgentRuntime({
    learning: {
      enabled: true,
      feedbackWeight: 0.8,
      minInteractionsForUpdate: 1,
    },
  });

  await agent.loadSkills(exampleSkills);

  // First interaction
  const response1 = await agent.process({
    message: "Calculate 25 * 4",
    sessionId: 'session-example-4',
    history: [],
  });

  console.log('User:', "Calculate 25 * 4");
  console.log('Agent:', response1.content);
  console.log('Skills selected:', response1.skillsUsed);

  // Record positive feedback
  await agent.recordFeedback({
    interactionId: 'int-1',
    skillUsed: 'calculator',
    success: true,
    userFeedback: 'positive',
  });

  console.log('\n✅ Recorded positive feedback for calculator skill');

  // Second interaction (similar request)
  const response2 = await agent.process({
    message: "What's 15 + 37?",
    sessionId: 'session-example-4',
    history: [
      { role: 'user', content: "Calculate 25 * 4" },
      { role: 'assistant', content: response1.content },
    ],
  });

  console.log('\nUser:', "What's 15 + 37?");
  console.log('Agent:', response2.content);
  console.log('Skills selected:', response2.skillsUsed);

  // Show learning statistics
  const stats = agent.getLearningStats();
  console.log('\nLearning Statistics:', {
    totalContexts: stats.totalContexts,
    totalSkills: stats.totalSkills,
    avgConfidence: stats.avgConfidence.toFixed(2),
  });
}

// ============================================
// Example 5: Complex Multi-Step Request
// ============================================

async function example5_ComplexRequest() {
  console.log('\n=== Example 5: Complex Multi-Step Request ===\n');

  const agent = new AgentRuntime();
  await agent.loadSkills(exampleSkills);

  const response = await agent.process({
    message: "Search for weather in Paris, then create a note about it, and finally send me a summary",
    sessionId: 'session-example-5',
    history: [],
  });

  console.log('User:', "Search for weather in Paris, then create a note about it, and finally send me a summary");
  console.log('Agent:', response.content);
  console.log('\nAnalysis:', {
    complexity: response.analysis.complexity,
    skillsRequired: response.analysis.requiresSkills,
    toolsRequired: response.analysis.requiresTools,
  });
  console.log('\nSystem Prompt:', {
    tokenCount: response.systemPrompt.metadata.tokenCount,
    layersIncluded: response.systemPrompt.metadata.layersIncluded,
    skillsCount: response.systemPrompt.metadata.skillsCount,
  });
}

// ============================================
// Example 6: Configuration and Health Check
// ============================================

async function example6_ConfigAndHealth() {
  console.log('\n=== Example 6: Configuration and Health Check ===\n');

  // Create agent with custom config
  const agent = new AgentRuntime({
    prompt: {
      maxTokens: 1000,
      includeMemory: false,
      includeContext: true,
      adaptiveTone: true,
    },
    skills: {
      maxSelected: 3, // Only top 3 skills
      confidenceThreshold: 0.6, // Higher threshold
      enableLearning: true,
    },
  });

  await agent.loadSkills(exampleSkills);

  // Show current config
  console.log('Agent Configuration:');
  console.log(JSON.stringify(agent.getConfig(), null, 2));

  // Health check
  const health = await agent.healthCheck();
  console.log('\nHealth Check:');
  console.log({
    status: health.status,
    components: health.components,
    skillsLoaded: health.skillsLoaded,
  });
}

// ============================================
// Example 7: Export/Import Learning Data
// ============================================

async function example7_ExportImport() {
  console.log('\n=== Example 7: Export/Import Learning Data ===\n');

  const agent = new AgentRuntime();
  await agent.loadSkills(exampleSkills);

  // Simulate some interactions
  await agent.recordFeedback({
    interactionId: 'int-1',
    skillUsed: 'weather',
    success: true,
    userFeedback: 'positive',
  });

  await agent.recordFeedback({
    interactionId: 'int-2',
    skillUsed: 'github',
    success: false,
    userFeedback: 'negative',
  });

  // Export learning data
  const learningData = agent.exportLearning();
  console.log('Exported Learning Data:');
  console.log(JSON.stringify(learningData, null, 2));

  // Create new agent and import
  const newAgent = new AgentRuntime();
  await newAgent.loadSkills(exampleSkills);
  newAgent.importLearning(learningData);

  console.log('\n✅ Learning data imported to new agent');

  // Verify
  const stats = newAgent.getLearningStats();
  console.log('\nNew Agent Statistics:', {
    totalContexts: stats.totalContexts,
    totalSkills: stats.totalSkills,
  });
}

// ============================================
// Run all examples
// ============================================

async function runAllExamples() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║   Girru - System Examples     ║');
  console.log('╚═══════════════════════════════════════╝');

  try {
    await example1_BasicUsage();
    await example2_WithHistory();
    await example3_WithPreferences();
    await example4_Learning();
    await example5_ComplexRequest();
    await example6_ConfigAndHealth();
    await example7_ExportImport();

    console.log('\n✅ All examples completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Error running examples:', error);
  }
}

// Run if called directly
if (require.main === module) {
  runAllExamples();
}

// Export for use in other files
export {
  example1_BasicUsage,
  example2_WithHistory,
  example3_WithPreferences,
  example4_Learning,
  example5_ComplexRequest,
  example6_ConfigAndHealth,
  example7_ExportImport,
  runAllExamples,
};
