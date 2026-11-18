import type { FastifyInstance } from 'fastify';
import { dialect, one, run, sql, type Step } from '../../../../../src/repositories/sql-steps.js';
import { nowText, secondsSinceText } from '../../../../../src/db/pg/dialect.js';
import { randomBytes } from 'crypto';
import { config } from '../../../../../src/config/index.js';

/**
 * Unified Telephony Service
 * Supports multiple providers (Twilio, Google Voice)
 * Provides abstraction layer for phone number management, calling, etc.
 *
 * B2.2c: the queries run on the process driver (sql-steps). The telephony
 * timestamps are TEXT on both drivers ('YYYY-MM-DD HH:MM:SS', UTC, nowText).
 * Provider calls (network) are made outside any transaction.
 */

export interface TelephonyProvider {
  name: 'twilio' | 'google';

  // Phone Number Management
  searchAvailableNumbers(countryCode: string, areaCode?: string): Promise<AvailableNumber[]>;
  purchasePhoneNumber(phoneNumber: string, friendlyName: string, webhookBaseUrl: string): Promise<PurchasedNumber>;
  releasePhoneNumber(providerSid: string): Promise<void>;

  // Call Management
  makeCall(params: MakeCallParams): Promise<CallInfo>;
  hangupCall(callSid: string): Promise<void>;
  transferCall(callSid: string, toNumber: string): Promise<void>;

  // Utility
  validateWebhookSignature(signature: string, url: string, params: any): boolean;
}

export interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  region: string;
  capabilities: {
    voice: boolean;
    SMS: boolean;
    MMS: boolean;
  };
  monthlyCost: number;
}

export interface PurchasedNumber {
  providerSid: string;
  phoneNumber: string;
  friendlyName: string;
  capabilities: {
    voice: boolean;
    SMS: boolean;
    MMS: boolean;
  };
}

export interface MakeCallParams {
  from: string;
  to: string;
  callPointId: string;
  webhookBaseUrl: string;
}

export interface CallInfo {
  callSid: string;
  status: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
}

/**
 * Telephony Service - Unified interface for all providers
 */
export class TelephonyService {
  private providers: Map<string, TelephonyProvider> = new Map();
  private defaultProvider: string;

  constructor() {
    this.defaultProvider = process.env.DEFAULT_TELEPHONY_PROVIDER || 'twilio';
  }

  /**
   * Register a provider (Twilio, Google, etc.)
   */
  registerProvider(provider: TelephonyProvider) {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get provider by name
   */
  getProvider(name?: string): TelephonyProvider {
    const providerName = name || this.defaultProvider;
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new Error(`Telephony provider "${providerName}" not registered or configured`);
    }

    return provider;
  }

  /**
   * Search available phone numbers
   */
  async searchAvailableNumbers(
    countryCode: string,
    areaCode?: string,
    provider?: string
  ): Promise<AvailableNumber[]> {
    return this.getProvider(provider).searchAvailableNumbers(countryCode, areaCode);
  }

  /**
   * Purchase a phone number
   */
  async purchasePhoneNumber(
    phoneNumber: string,
    friendlyName: string,
    provider?: string
  ): Promise<string> {
    const webhookBaseUrl = process.env.PUBLIC_URL || `http://${config.host}:${config.port}`;
    const selectedProvider = provider || this.defaultProvider;

    // Purchase from provider
    const purchased = await this.getProvider(selectedProvider).purchasePhoneNumber(
      phoneNumber,
      friendlyName,
      webhookBaseUrl
    );

    // Store in database
    const id = randomBytes(16).toString('hex');

    await sql().read((function* (): Step<unknown> {
      const d = yield* dialect();
      return yield* run(`
      INSERT INTO phone_numbers (
        id, phone_number, friendly_name, country_code, capabilities,
        provider, provider_sid, status, purchased_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ${nowText(d)})
    `,
      id,
      purchased.phoneNumber,
      purchased.friendlyName,
      phoneNumber.substring(1, 3), // Extract country code from +1234...
      JSON.stringify(purchased.capabilities),
      selectedProvider,
      purchased.providerSid
    );
    })());

    return id;
  }

  /**
   * Release a phone number
   */
  async releasePhoneNumber(numberId: string): Promise<void> {
    const number = await sql().read(one<any>(`
      SELECT provider_sid, provider FROM phone_numbers WHERE id = ?
    `, numberId));

    if (!number) {
      throw new Error(`Phone number ${numberId} not found`);
    }

    // Release from provider
    if (number.provider_sid) {
      await this.getProvider(number.provider).releasePhoneNumber(number.provider_sid);
    }

    // Mark as released in database
    await sql().read((function* (): Step<unknown> {
      const d = yield* dialect();
      return yield* run(`
      UPDATE phone_numbers SET status = 'released', updated_at = ${nowText(d)}
      WHERE id = ?
    `, numberId);
    })());
  }

  /**
   * Make an outbound call
   */
  async makeCall(params: {
    callPointId: string;
    toNumber: string;
  }): Promise<string> {
    // Get call point details
    const callPoint = await sql().read(one<any>(`
      SELECT cp.*, pn.phone_number, pn.provider
      FROM call_points cp
      JOIN phone_numbers pn ON pn.id = cp.phone_number_id
      WHERE cp.id = ?
    `, params.callPointId));

    if (!callPoint) {
      throw new Error(`Call point ${params.callPointId} not found`);
    }

    if (!callPoint.enabled) {
      throw new Error(`Call point ${params.callPointId} is disabled`);
    }

    const webhookBaseUrl = process.env.PUBLIC_URL || `http://${config.host}:${config.port}`;

    // Make call via provider
    const callInfo = await this.getProvider(callPoint.provider).makeCall({
      from: callPoint.phone_number,
      to: params.toNumber,
      callPointId: params.callPointId,
      webhookBaseUrl,
    });

    // Create call session in database
    const sessionId = randomBytes(16).toString('hex');

    await sql().read((function* (): Step<unknown> {
      const d = yield* dialect();
      return yield* run(`
      INSERT INTO call_sessions (
        id, call_point_id, direction, from_number, to_number,
        call_sid, provider, status, started_at, agent_id
      ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ${nowText(d)}, ?)
    `,
      sessionId,
      params.callPointId,
      callInfo.from,
      callInfo.to,
      callInfo.callSid,
      callPoint.provider,
      callInfo.status,
      callPoint.agent_id
    );
    })());

    return sessionId;
  }

  /**
   * Hangup a call
   */
  async hangupCall(callSid: string): Promise<void> {
    const session = await sql().read(one<any>(`
      SELECT provider FROM call_sessions WHERE call_sid = ?
    `, callSid));

    if (!session) {
      throw new Error(`Call session with SID ${callSid} not found`);
    }

    await this.getProvider(session.provider).hangupCall(callSid);

    // Update session status (one statement; the duration is computed by the database)
    await sql().read((function* (): Step<unknown> {
      const d = yield* dialect();
      const secs = secondsSinceText(d, 'started_at');
      return yield* run(`
      UPDATE call_sessions
      SET status = 'completed', ended_at = ${nowText(d)},
          duration_seconds = ${d === 'postgres' ? `round(${secs})` : secs}
      WHERE call_sid = ?
    `, callSid);
    })());
  }

  /**
   * Transfer a call to another number
   */
  async transferCall(callSid: string, toNumber: string): Promise<void> {
    const session = await sql().read(one<any>(`
      SELECT provider FROM call_sessions WHERE call_sid = ?
    `, callSid));

    if (!session) {
      throw new Error(`Call session with SID ${callSid} not found`);
    }

    await this.getProvider(session.provider).transferCall(callSid, toNumber);

    // Log transfer in call messages
    const messageId = randomBytes(16).toString('hex');
    await sql().read((function* (): Step<unknown> {
      const d = yield* dialect();
      const sessionRecord = yield* one<any>(`
      SELECT id FROM call_sessions WHERE call_sid = ?
    `, callSid);

      if (sessionRecord) {
        yield* run(`
        INSERT INTO call_messages (id, call_session_id, role, content, timestamp)
        VALUES (?, ?, 'system', ?, ${nowText(d)})
      `, messageId, sessionRecord.id, `Call transferred to ${toNumber}`);
      }
      return undefined;
    })());
  }

  /**
   * Validate webhook signature (provider-specific)
   */
  validateWebhookSignature(
    signature: string,
    url: string,
    params: any,
    provider?: string
  ): boolean {
    return this.getProvider(provider).validateWebhookSignature(signature, url, params);
  }

  /**
   * Get list of registered providers
   */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }
}

// Singleton instance
let telephonyServiceInstance: TelephonyService | null = null;

export function getTelephonyService(): TelephonyService {
  if (!telephonyServiceInstance) {
    telephonyServiceInstance = new TelephonyService();
  }
  return telephonyServiceInstance;
}

/**
 * Initialize telephony service with available providers
 */
export async function initializeTelephonyService() {
  const service = getTelephonyService();

  // Dynamically import and register available providers
  try {
    const { TwilioProvider } = await import('./twilio-provider.js');
    const twilioProvider = new TwilioProvider();
    service.registerProvider(twilioProvider);
    console.log('[Telephony] ✅ Twilio provider registered');
  } catch (error) {
    console.warn('[Telephony] ⚠️  Twilio provider not available:', (error as Error).message);
  }

  try {
    const { GoogleVoiceProvider } = await import('./google-voice-provider.js');
    const googleProvider = new GoogleVoiceProvider();
    service.registerProvider(googleProvider);
    console.log('[Telephony] ✅ Google Voice provider registered');
  } catch (error) {
    console.warn('[Telephony] ⚠️  Google Voice provider not available:', (error as Error).message);
  }

  const providers = service.getAvailableProviders();
  if (providers.length === 0) {
    console.warn('[Telephony] ⚠️  No telephony providers configured');
  } else {
    console.log(`[Telephony] Configured providers: ${providers.join(', ')}`);
  }

  return service;
}
