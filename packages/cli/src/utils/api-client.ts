import { chatReplyText } from './chat-response.js';
/**
 * API Client
 *
 * Communicates with the Girru backend. Authenticated calls send the
 * token saved by `agent-player login` as a bearer token. The token is never
 * printed or included in error messages.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getBackendUrl, getStoredToken } from './auth-store.js';

// Load .env from CLI package directory (optional BACKEND_URL)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '..', '.env'), quiet: true } as any);

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export const NOT_SIGNED_IN =
  'Not signed in or the session has ended. Run "agent-player login" first.';

interface RequestOptions {
  body?: unknown;
  /** Send the saved token (default true). */
  auth?: boolean;
  timeoutMs?: number;
}

export class ApiClient {
  private baseURL: string;

  constructor(baseURL?: string) {
    this.baseURL = (baseURL || getBackendUrl()).replace(/\/+$/, '');
  }

  getBaseUrl(): string {
    return this.baseURL;
  }

  async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const token = options.auth === false ? null : getStoredToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}${path}`, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch {
      throw new ApiError(`Cannot reach the backend at ${this.baseURL}`, 0);
    }

    const text = await response.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      if (response.status === 401) throw new ApiError(NOT_SIGNED_IN, 401);
      const detail = data && typeof data === 'object' ? data.message || data.error : undefined;
      throw new ApiError(
        `Request failed (${response.status})${detail ? `: ${String(detail)}` : ''}`,
        response.status
      );
    }
    return data as T;
  }

  /**
   * Check if backend is running
   */
  async isBackendRunning(): Promise<boolean> {
    try {
      const data = await this.request('GET', '/health', { auth: false, timeoutMs: 5_000 });
      return data?.status === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Get backend status
   */
  async getStatus(): Promise<any> {
    return this.request('GET', '/health', { auth: false });
  }

  /**
   * Auth API
   */
  async login(email: string, password: string): Promise<{ token: string; user?: any }> {
    let data: any;
    try {
      data = await this.request('POST', '/api/auth/login', { body: { email, password }, auth: false });
    } catch (err: any) {
      // A 401 here means wrong credentials, not an ended session.
      if (err?.status === 401) throw new ApiError('Login failed: wrong email or password', 401);
      throw err;
    }
    if (!data || typeof data.token !== 'string' || !data.token) {
      throw new ApiError('Login failed: the backend returned no session', 500);
    }
    return { token: data.token, user: data.user };
  }

  async logout(): Promise<void> {
    await this.request('POST', '/api/auth/logout');
  }

  /**
   * Skills API
   */
  async getSkills(): Promise<any[]> {
    const data = await this.request('GET', '/api/skills');
    return data?.skills || [];
  }

  async installSkill(name: string): Promise<any> {
    return this.request('POST', '/api/skills/install', { body: { name } });
  }

  async removeSkill(id: string): Promise<any> {
    return this.request('DELETE', `/api/skills/${encodeURIComponent(id)}`);
  }

  async updateSkill(id: string, data: any): Promise<any> {
    return this.request('PUT', `/api/skills/${encodeURIComponent(id)}`, { body: data });
  }

  /**
   * Channels API
   */
  async getChannels(): Promise<any[]> {
    const data = await this.request('GET', '/api/channels');
    return data?.channels || [];
  }

  async connectChannel(id: string): Promise<any> {
    return this.request('POST', `/api/channels/${encodeURIComponent(id)}/connect`);
  }

  async disconnectChannel(id: string): Promise<any> {
    return this.request('POST', `/api/channels/${encodeURIComponent(id)}/disconnect`);
  }

  /**
   * Jobs API
   */
  async getJobs(): Promise<any[]> {
    const data = await this.request('GET', '/api/scheduler/jobs');
    return data?.jobs || [];
  }

  async createJob(data: any): Promise<any> {
    return this.request('POST', '/api/scheduler/jobs', { body: data });
  }

  async runJob(id: string): Promise<any> {
    return this.request('POST', `/api/scheduler/jobs/${encodeURIComponent(id)}/execute`);
  }

  async deleteJob(id: string): Promise<any> {
    return this.request('DELETE', `/api/scheduler/jobs/${encodeURIComponent(id)}`);
  }

  /**
   * Safe import (CLI-02): the same owner-only pipeline the web UI uses.
   */
  async importPreview(body: {
    files: Array<{ name: string; contentBase64: string }>;
    source?: string; drawer?: string; redactEmails?: boolean; redactPhones?: boolean;
  }): Promise<any> {
    if (!getStoredToken()) throw new ApiError(NOT_SIGNED_IN, 401);
    return this.request('POST', '/api/memory/import/preview', { body, timeoutMs: 120_000 });
  }

  async importCommit(batchId: string, body: { version: number; contentHash: string; operationKey: string; confirm: true }): Promise<any> {
    return this.request('POST', `/api/memory/import/${encodeURIComponent(batchId)}/commit`, { body, timeoutMs: 120_000 });
  }

  async importCancel(batchId: string): Promise<any> {
    return this.request('POST', `/api/memory/import/${encodeURIComponent(batchId)}/cancel`, { body: {} });
  }

  /**
   * Chat API (non-streaming). Returns the assistant's reply text.
   */
  async sendMessage(message: string, sessionId?: string): Promise<string> {
    if (!getStoredToken()) throw new ApiError(NOT_SIGNED_IN, 401);
    const data = await this.request('POST', '/api/chat', {
      body: {
        messages: [{ role: 'user', content: message }],
        stream: false,
        sessionId: sessionId || 'cli-session',
      },
      timeoutMs: 240_000,
    });
    return chatReplyText(data);
  }
}

// Singleton instance
let apiClient: ApiClient | null = null;

export function getApiClient(): ApiClient {
  if (!apiClient) {
    apiClient = new ApiClient();
  }
  return apiClient;
}
