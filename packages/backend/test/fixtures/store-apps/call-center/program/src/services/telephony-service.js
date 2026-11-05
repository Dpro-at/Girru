import { dialect, one, run, sql } from '../repositories/sql-steps.js';
import { nowText, secondsSinceText } from '../db/pg/dialect.js';
import { randomBytes } from 'crypto';
import { config } from '../config/index.js';
/**
 * Telephony Service - Unified interface for all providers
 */
export class TelephonyService {
    providers = new Map();
    defaultProvider;
    constructor() {
        this.defaultProvider = process.env.DEFAULT_TELEPHONY_PROVIDER || 'twilio';
    }
    /**
     * Register a provider (Twilio, Google, etc.)
     */
    registerProvider(provider) {
        this.providers.set(provider.name, provider);
    }
    /**
     * Get provider by name
     */
    getProvider(name) {
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
    async searchAvailableNumbers(countryCode, areaCode, provider) {
        return this.getProvider(provider).searchAvailableNumbers(countryCode, areaCode);
    }
    /**
     * Purchase a phone number
     */
    async purchasePhoneNumber(phoneNumber, friendlyName, provider) {
        const webhookBaseUrl = process.env.PUBLIC_URL || `http://${config.host}:${config.port}`;
        const selectedProvider = provider || this.defaultProvider;
        // Purchase from provider
        const purchased = await this.getProvider(selectedProvider).purchasePhoneNumber(phoneNumber, friendlyName, webhookBaseUrl);
        // Store in database
        const id = randomBytes(16).toString('hex');
        await sql().read((function* () {
            const d = yield* dialect();
            return yield* run(`
      INSERT INTO app_call_center__phone_numbers (
        id, phone_number, friendly_name, country_code, capabilities,
        provider, provider_sid, status, purchased_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ${nowText(d)})
    `, id, purchased.phoneNumber, purchased.friendlyName, phoneNumber.substring(1, 3), // Extract country code from +1234...
            JSON.stringify(purchased.capabilities), selectedProvider, purchased.providerSid);
        })());
        return id;
    }
    /**
     * Release a phone number
     */
    async releasePhoneNumber(numberId) {
        const number = await sql().read(one(`
      SELECT provider_sid, provider FROM app_call_center__phone_numbers WHERE id = ?
    `, numberId));
        if (!number) {
            throw new Error(`Phone number ${numberId} not found`);
        }
        // Release from provider
        if (number.provider_sid) {
            await this.getProvider(number.provider).releasePhoneNumber(number.provider_sid);
        }
        // Mark as released in database
        await sql().read((function* () {
            const d = yield* dialect();
            return yield* run(`
      UPDATE app_call_center__phone_numbers SET status = 'released', updated_at = ${nowText(d)}
      WHERE id = ?
    `, numberId);
        })());
    }
    /**
     * Make an outbound call
     */
    async makeCall(params) {
        // Get call point details
        const callPoint = await sql().read(one(`
      SELECT cp.*, pn.phone_number, pn.provider
      FROM app_call_center__call_points cp
      JOIN app_call_center__phone_numbers pn ON pn.id = cp.phone_number_id
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
        await sql().read((function* () {
            const d = yield* dialect();
            return yield* run(`
      INSERT INTO app_call_center__call_sessions (
        id, call_point_id, direction, from_number, to_number,
        call_sid, provider, status, started_at, agent_id
      ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ${nowText(d)}, ?)
    `, sessionId, params.callPointId, callInfo.from, callInfo.to, callInfo.callSid, callPoint.provider, callInfo.status, callPoint.agent_id);
        })());
        return sessionId;
    }
    /**
     * Hangup a call
     */
    async hangupCall(callSid) {
        const session = await sql().read(one(`
      SELECT provider FROM app_call_center__call_sessions WHERE call_sid = ?
    `, callSid));
        if (!session) {
            throw new Error(`Call session with SID ${callSid} not found`);
        }
        await this.getProvider(session.provider).hangupCall(callSid);
        // Update session status (one statement; the duration is computed by the database)
        await sql().read((function* () {
            const d = yield* dialect();
            const secs = secondsSinceText(d, 'started_at');
            return yield* run(`
      UPDATE app_call_center__call_sessions
      SET status = 'completed', ended_at = ${nowText(d)},
          duration_seconds = ${d === 'postgres' ? `round(${secs})` : secs}
      WHERE call_sid = ?
    `, callSid);
        })());
    }
    /**
     * Transfer a call to another number
     */
    async transferCall(callSid, toNumber) {
        const session = await sql().read(one(`
      SELECT provider FROM app_call_center__call_sessions WHERE call_sid = ?
    `, callSid));
        if (!session) {
            throw new Error(`Call session with SID ${callSid} not found`);
        }
        await this.getProvider(session.provider).transferCall(callSid, toNumber);
        // Log transfer in call messages
        const messageId = randomBytes(16).toString('hex');
        await sql().read((function* () {
            const d = yield* dialect();
            const sessionRecord = yield* one(`
      SELECT id FROM app_call_center__call_sessions WHERE call_sid = ?
    `, callSid);
            if (sessionRecord) {
                yield* run(`
        INSERT INTO app_call_center__call_messages (id, call_session_id, role, content, timestamp)
        VALUES (?, ?, 'system', ?, ${nowText(d)})
      `, messageId, sessionRecord.id, `Call transferred to ${toNumber}`);
            }
            return undefined;
        })());
    }
    /**
     * Validate webhook signature (provider-specific)
     */
    validateWebhookSignature(signature, url, params, provider) {
        return this.getProvider(provider).validateWebhookSignature(signature, url, params);
    }
    /**
     * Get list of registered providers
     */
    getAvailableProviders() {
        return Array.from(this.providers.keys());
    }
}
// Singleton instance
let telephonyServiceInstance = null;
export function getTelephonyService() {
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
    }
    catch (error) {
        console.warn('[Telephony] ⚠️  Twilio provider not available:', error.message);
    }
    try {
        const { GoogleVoiceProvider } = await import('./google-voice-provider.js');
        const googleProvider = new GoogleVoiceProvider();
        service.registerProvider(googleProvider);
        console.log('[Telephony] ✅ Google Voice provider registered');
    }
    catch (error) {
        console.warn('[Telephony] ⚠️  Google Voice provider not available:', error.message);
    }
    const providers = service.getAvailableProviders();
    if (providers.length === 0) {
        console.warn('[Telephony] ⚠️  No telephony providers configured');
    }
    else {
        console.log(`[Telephony] Configured providers: ${providers.join(', ')}`);
    }
    return service;
}
