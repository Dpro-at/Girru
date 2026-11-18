import twilio from 'twilio';
import type {
  TelephonyProvider,
  AvailableNumber,
  PurchasedNumber,
  MakeCallParams,
  CallInfo,
} from './telephony-service.js';
import { TELEPHONY_KEYS, getTelephonySecret } from '../../../../../src/telephony/credentials.js';

/**
 * Twilio Provider Implementation
 * Handles all Twilio-specific API calls
 * Reads credentials from database first, then falls back to .env
 */
export class TwilioProvider implements TelephonyProvider {
  name: 'twilio' | 'google' = 'twilio';
  private client: any;
  private accountSid: string;
  private authToken: string;

  constructor() {
    // Initialize synchronously with env vars, will be updated async
    this.accountSid = process.env.TWILIO_ACCOUNT_SID || '';
    this.authToken = process.env.TWILIO_AUTH_TOKEN || '';

    // Try to load from database (async)
    this.loadCredentialsFromDatabase().catch(err => {
      console.warn('[Twilio] Could not load credentials from database:', err.message);
    });

    if (!this.accountSid || !this.authToken) {
      throw new Error('Twilio credentials not configured (check database credentials or .env file)');
    }

    this.client = twilio(this.accountSid, this.authToken);
  }

  /**
   * Load credentials from database (priority over .env)
   */
  private async loadCredentialsFromDatabase() {
    try {
      // Read from database - these take priority over .env
      const dbSid = await getTelephonySecret(TELEPHONY_KEYS.twilioAccountSid);
      const dbToken = await getTelephonySecret(TELEPHONY_KEYS.twilioAuthToken);

      if (dbSid && dbToken) {
        this.accountSid = dbSid;
        this.authToken = dbToken;
        this.client = twilio(this.accountSid, this.authToken);
        console.log('[Twilio] ✅ Credentials loaded from database');
      } else {
        console.log('[Twilio] Using credentials from .env file');
      }
    } catch (error) {
      // Fallback to .env silently
      console.warn('[Twilio] Failed to load from database, using .env');
    }
  }

  /**
   * Search available phone numbers in Twilio
   */
  async searchAvailableNumbers(
    countryCode: string,
    areaCode?: string
  ): Promise<AvailableNumber[]> {
    try {
      const numbers = await this.client
        .availablePhoneNumbers(countryCode)
        .local.list({
          areaCode,
          limit: 20,
        });

      return numbers.map((num: any) => ({
        phoneNumber: num.phoneNumber,
        friendlyName: num.friendlyName || num.phoneNumber,
        region: num.region || countryCode,
        capabilities: {
          voice: num.capabilities?.voice ?? true,
          SMS: num.capabilities?.SMS ?? true,
          MMS: num.capabilities?.MMS ?? false,
        },
        monthlyCost: 1.15, // Twilio US local number cost (approximate)
      }));
    } catch (error: any) {
      throw new Error(`Twilio search failed: ${error.message}`);
    }
  }

  /**
   * Purchase a phone number from Twilio
   */
  async purchasePhoneNumber(
    phoneNumber: string,
    friendlyName: string,
    webhookBaseUrl: string
  ): Promise<PurchasedNumber> {
    try {
      const incoming = await this.client.incomingPhoneNumbers.create({
        phoneNumber,
        friendlyName,
        voiceUrl: `${webhookBaseUrl}/api/telephony/voice-webhook`,
        voiceMethod: 'POST',
        statusCallback: `${webhookBaseUrl}/api/telephony/status-webhook`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      });

      return {
        providerSid: incoming.sid,
        phoneNumber: incoming.phoneNumber,
        friendlyName: incoming.friendlyName || phoneNumber,
        capabilities: {
          voice: incoming.capabilities?.voice ?? true,
          SMS: incoming.capabilities?.sms ?? true,
          MMS: incoming.capabilities?.mms ?? false,
        },
      };
    } catch (error: any) {
      throw new Error(`Twilio purchase failed: ${error.message}`);
    }
  }

  /**
   * Release a phone number from Twilio
   */
  async releasePhoneNumber(providerSid: string): Promise<void> {
    try {
      await this.client.incomingPhoneNumbers(providerSid).remove();
    } catch (error: any) {
      throw new Error(`Twilio release failed: ${error.message}`);
    }
  }

  /**
   * Make an outbound call via Twilio
   */
  async makeCall(params: MakeCallParams): Promise<CallInfo> {
    try {
      const call = await this.client.calls.create({
        from: params.from,
        to: params.to,
        url: `${params.webhookBaseUrl}/api/telephony/outbound-twiml?callPointId=${params.callPointId}`,
        method: 'POST',
        statusCallback: `${params.webhookBaseUrl}/api/telephony/status-webhook`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        record: true,
        recordingStatusCallback: `${params.webhookBaseUrl}/api/telephony/recording-webhook`,
        recordingStatusCallbackMethod: 'POST',
      });

      return {
        callSid: call.sid,
        status: call.status,
        from: call.from || params.from,
        to: call.to || params.to,
        direction: 'outbound',
      };
    } catch (error: any) {
      throw new Error(`Twilio makeCall failed: ${error.message}`);
    }
  }

  /**
   * Hangup a call in Twilio
   */
  async hangupCall(callSid: string): Promise<void> {
    try {
      await this.client.calls(callSid).update({ status: 'completed' });
    } catch (error: any) {
      throw new Error(`Twilio hangup failed: ${error.message}`);
    }
  }

  /**
   * Transfer a call to another number
   */
  async transferCall(callSid: string, toNumber: string): Promise<void> {
    try {
      // Generate TwiML for transfer
      const twiml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="Polly.Joanna">Transferring your call now.</Say>
          <Dial>${toNumber}</Dial>
        </Response>
      `;

      await this.client.calls(callSid).update({ twiml });
    } catch (error: any) {
      throw new Error(`Twilio transfer failed: ${error.message}`);
    }
  }

  /**
   * Validate Twilio webhook signature for security
   */
  validateWebhookSignature(signature: string, url: string, params: any): boolean {
    try {
      return twilio.validateRequest(this.authToken, signature, url, params);
    } catch (error) {
      return false;
    }
  }
}
