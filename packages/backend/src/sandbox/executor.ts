/**
 * Sandbox Executor
 * Executes commands with optional sandboxing
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { getDockerManager } from './docker-manager.js';
import {
  type SandboxConfig,
  type ExecutionRequest,
  type ExecutionResult,
  type SandboxStats,
  DANGEROUS_PATTERNS,
} from './types.js';
import { DEFAULT_SANDBOX_CONFIG } from './config.js';
import { minimalChildEnv, safeChildCwd } from '../tools/exec-policy.js';

const execAsync = promisify(exec);

/**
 * SECURITY (S0-Q.3): running commands directly on the host is OFF unless the server
 * operator sets SANDBOX_ALLOW_HOST_EXEC=true. A missing Docker never enables it.
 */
export function hostExecAllowed(): boolean {
  return process.env.SANDBOX_ALLOW_HOST_EXEC === 'true';
}

export class SandboxExecutor {
  private config: SandboxConfig;
  private stats: SandboxStats = {
    totalExecutions: 0,
    sandboxedExecutions: 0,
    blockedExecutions: 0,
    activeContainers: 0,
    avgExecutionTime: 0,
  };
  private totalExecutionTime: number = 0;
  private sessionId: string | null = null;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /**
   * Initialize sandbox (create container if needed)
   */
  async initialize(agentId?: string): Promise<void> {
    if (this.config.mode === 'off') {
      console.log('[Sandbox] Sandbox mode is off, skipping initialization');
      return;
    }

    const docker = getDockerManager();
    const available = await docker.isDockerAvailable();

    if (!available) {
      console.warn('[Sandbox] Docker not available; command execution is disabled until it is');
      return;
    }

    // Ensure image exists
    const imageReady = await docker.ensureImage(this.config.docker.image);
    if (!imageReady) {
      console.warn('[Sandbox] Failed to prepare Docker image; command execution is disabled');
      return;
    }

    // Create session
    const session = await docker.createSession(this.config, agentId);
    this.sessionId = session.id;
    this.stats.activeContainers = docker.getActiveSessions().length;

    console.log(`[Sandbox] Initialized with session: ${this.sessionId}`);
  }

  /**
   * Execute a command
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.stats.totalExecutions++;

    // Check if command should be blocked
    const blockCheck = this.checkBlocked(request.command);
    if (blockCheck.blocked) {
      this.stats.blockedExecutions++;
      return {
        exitCode: 1,
        stdout: '',
        stderr: '',
        duration: Date.now() - startTime,
        sandboxed: false,
        blocked: true,
        blockReason: blockCheck.reason,
      };
    }

    // Determine if we should sandbox
    const shouldSandbox = this.shouldSandbox(request);

    if (shouldSandbox) {
      if (this.sessionId) {
        return this.executeInSandbox(request, startTime);
      }
      // SECURITY (S0-Q.3): no silent fallback to the host shell
      return this.refused(startTime, 'Sandbox is not available (Docker missing or not initialized)');
    }

    if (!hostExecAllowed()) {
      return this.refused(startTime, 'Host command execution is disabled (SANDBOX_ALLOW_HOST_EXEC is not true)');
    }
    const hostCwd = safeChildCwd();
    // Only the server chooses the host directory. API input never reaches the host spawn options.
    if (request.cwd !== undefined && request.cwd !== hostCwd) {
      return this.refused(startTime, 'Custom working directories require Docker isolation');
    }
    return this.executeNative(request, startTime, hostCwd);
  }

  private refused(startTime: number, reason: string): ExecutionResult {
    this.stats.blockedExecutions++;
    return {
      exitCode: 1,
      stdout: '',
      stderr: '',
      duration: Date.now() - startTime,
      sandboxed: false,
      blocked: true,
      blockReason: reason,
    };
  }

  /**
   * Check if command should be blocked
   */
  private checkBlocked(command: string): { blocked: boolean; reason?: string } {
    // Check blocklist
    if (this.config.blockedCommands) {
      for (const blocked of this.config.blockedCommands) {
        if (command.includes(blocked)) {
          return { blocked: true, reason: `Command matches blocklist: ${blocked}` };
        }
      }
    }

    // Check dangerous patterns
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { blocked: true, reason: `Command matches dangerous pattern: ${pattern}` };
      }
    }

    // Check allowlist if defined
    if (this.config.allowedCommands && this.config.allowedCommands.length > 0) {
      const commandBase = command.split(' ')[0];
      const allowed = this.config.allowedCommands.some(
        (c) => command.startsWith(c) || commandBase === c
      );
      if (!allowed) {
        return { blocked: true, reason: 'Command not in allowlist' };
      }
    }

    return { blocked: false };
  }

  /**
   * Determine if command should be sandboxed
   */
  private shouldSandbox(request: ExecutionRequest): boolean {
    if (this.config.mode === 'off') return false;
    if (this.config.mode === 'all') return true;

    // non-main mode: sandbox if not in main thread context
    // For now, always sandbox in non-main mode
    return this.config.mode === 'non-main';
  }

  /**
   * Execute in Docker sandbox
   */
  private async executeInSandbox(
    request: ExecutionRequest,
    startTime: number
  ): Promise<ExecutionResult> {
    const docker = getDockerManager();

    if (!this.sessionId) {
      return this.refused(startTime, 'Sandbox is not available (Docker missing or not initialized)');
    }

    try {
      this.stats.sandboxedExecutions++;

      const result = await docker.execute(this.sessionId, request.command, {
        timeout: request.timeout || this.config.timeout,
        cwd: request.cwd,
        env: request.env,
        stdin: request.stdin,
      });

      const duration = Date.now() - startTime;
      this.updateAvgTime(duration);

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        duration,
        sandboxed: true,
        containerId: this.sessionId,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        exitCode: 1,
        stdout: '',
        stderr: '',
        duration,
        sandboxed: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute natively (no sandbox)
   */
  private async executeNative(
    request: ExecutionRequest,
    startTime: number,
    hostCwd: string
  ): Promise<ExecutionResult> {
    try {
      const options: any = {
        timeout: request.timeout || this.config.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      };

      // SECURITY (S0-Q.5): cwd outside the data dir; minimal env, no server secrets
      options.cwd = hostCwd;
      options.env = minimalChildEnv(request.env ?? {});

      const { stdout, stderr } = await execAsync(request.command, options);
      const duration = Date.now() - startTime;
      this.updateAvgTime(duration);

      return {
        exitCode: 0,
        stdout: String(stdout),
        stderr: String(stderr),
        duration,
        sandboxed: false,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.updateAvgTime(duration);

      return {
        exitCode: error.code || 1,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        duration,
        sandboxed: false,
        error: error.message,
      };
    }
  }

  /**
   * Update average execution time
   */
  private updateAvgTime(duration: number): void {
    this.totalExecutionTime += duration;
    this.stats.avgExecutionTime = this.totalExecutionTime / this.stats.totalExecutions;
  }

  /**
   * Get execution statistics
   */
  getStats(): SandboxStats {
    const docker = getDockerManager();
    this.stats.activeContainers = docker.getActiveSessions().length;
    return { ...this.stats };
  }

  /**
   * Get current configuration
   */
  getConfig(): SandboxConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SandboxConfig>): void {
    // SECURITY (S0-Q.3): isolation settings come from the server environment only.
    // The API may only switch between sandboxed modes and tighten resource limits
    // (never above the server defaults). Image, mounts, network, privileges, workspace
    // access and command lists are not changeable at runtime.
    if (config.mode === 'non-main' || config.mode === 'all') {
      this.config.mode = config.mode;
    }
    const clamp = (value: unknown, max: number) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, max) : undefined;
    const timeout = clamp(config.timeout, DEFAULT_SANDBOX_CONFIG.timeout);
    const maxMemory = clamp(config.maxMemory, DEFAULT_SANDBOX_CONFIG.maxMemory);
    const maxCpu = clamp(config.maxCpu, DEFAULT_SANDBOX_CONFIG.maxCpu);
    if (timeout !== undefined) this.config.timeout = timeout;
    if (maxMemory !== undefined) this.config.maxMemory = maxMemory;
    if (maxCpu !== undefined) this.config.maxCpu = maxCpu;
  }

  /**
   * Cleanup and destroy session
   */
  async cleanup(): Promise<void> {
    if (this.sessionId) {
      const docker = getDockerManager();
      await docker.destroySession(this.sessionId);
      this.sessionId = null;
    }
  }
}

// Default executor instance
let defaultExecutor: SandboxExecutor | null = null;

export function getSandboxExecutor(config?: Partial<SandboxConfig>): SandboxExecutor {
  if (!defaultExecutor) {
    defaultExecutor = new SandboxExecutor(config);
  }
  return defaultExecutor;
}

/**
 * Quick execute with sandboxing
 */
export async function sandboxExec(
  command: string,
  options: Partial<ExecutionRequest> = {}
): Promise<ExecutionResult> {
  const executor = getSandboxExecutor();
  return executor.execute({ command, ...options });
}
