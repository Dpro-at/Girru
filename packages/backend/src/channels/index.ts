/**
 * Channels System
 * Main entry point for channels system
 */

export * from './types.js';
export * from './registry.js';

// Export adapters
export * from './adapters/base.js';
export * from './adapters/web.js';

// Re-export singleton
export { getChannelRegistry } from './registry.js';
