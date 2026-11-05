import { createRequire } from 'node:module';
import type {
  TelephonyProvider,
  AvailableNumber,
  PurchasedNumber,
  MakeCallParams,
  CallInfo,
} from './telephony-service.js';
import { TELEPHONY_KEYS, getTelephonySecret } from '../../../../../src/telephony/credentials.js';

/**
 * Vonage (Nexmo) Provider Implementation
 * Uses Vonage Voice API with NCCO (JSON-based call control)
 * More affordable alternative to Twilio
 */
export class VonageProvider implements TelephonyProvider {
  name: 'twilio' | 'google' = 'twilio' as any; // Will be 'vonage' in future type update
  private client: any;
  private apiKey: string = '';
  private apiSecret: string = '';
  private applicationId: string = '';
  private privateKey: string = '';

  constructor() {
    // Load credentials from environment first, will be updated async from DB
    this.apiKey = process.env.VONAGE_API_KEY || '';
    this.apiSecret = process.env.VONAGE_API_SECRET || '';
    this.applicationId = process.env.VONAGE_APPLICATION_ID || '';
    this.privateKey = process.env.VONAGE_PRIVATE_KEY || '';

    // Try to load from database (async)
    this.loadCredentialsFromDatabase().catch(err => {
      console.warn('[Vonage] Could not load credentials from database:', err.message);
    });

    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Vonage credentials not configured (check database credentials or .env file)');
    }

    this.initializeClient();
  }

  /**
   * Initialize Vonage client
   */
  private initializeClient() {
    try {
      // Optional integration: resolve the SDK only when a configured provider is constructed.
      const { Vonage } = createRequire(import.meta.url)('@vonage/server-sdk') as {
        Vonage: new (credentials: {apiKey: string; apiSecret: string; applicationId: string; privateKey: string}) => unknown;
      };
      this.client = new Vonage({
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
        applicationId: this.applicationId,
        privateKey: this.privateKey,
      });

      console.log('[Vonage] ✅ Client initialized');
    } catch (error: any) {
      throw new Error(`Vonage initialization failed: ${error.message}`);
    }
  }

  /**
   * Load credentials from database (priority over .env)
   */
  private async loadCredentialsFromDatabase() {
    try {
      const dbApiKey = await getTelephonySecret(TELEPHONY_KEYS.vonageApiKey);
      const dbApiSecret = await getTelephonySecret(TELEPHONY_KEYS.vonageApiSecret);
      const dbAppId = await getTelephonySecret(TELEPHONY_KEYS.vonageApplicationId);
      const dbPrivateKey = await getTelephonySecret(TELEPHONY_KEYS.vonagePrivateKey);

      if (dbApiKey && dbApiSecret) {
        this.apiKey = dbApiKey;
        this.apiSecret = dbApiSecret;
        this.applicationId = dbAppId || '';
        this.privateKey = dbPrivateKey || '';
        this.initializeClient();
        console.log('[Vonage] ✅ Credentials loaded from database');
      } else {
        console.log('[Vonage] Using credentials from .env file');
      }
    } catch (error) {
      console.warn('[Vonage] Failed to load from database, using .env');
    }
  }

  /**
   * Search available phone numbers
   */
  async searchAvailableNumbers(
    countryCode: string,
    areaCode?: string
  ): Promise<AvailableNumber[]> {
    try {
      const searchParams: any = {
        country: countryCode,
        type: 'mobile-lvn', // Local Virtual Number
        features: 'VOICE',
        size: 20,
      };

      if (areaCode) {
        searchParams.pattern = areaCode;
      }

      const response = await this.client.numberInsight.advancedAsync(searchParams);
      const numbers = response.numbers || [];

      return numbers.map((num: any) => ({
        phoneNumber: num.msisdn,
        friendlyName: num.msisdn,
        region: num.country || countryCode,
        capabilities: {
          voice: num.features?.includes('VOICE') ?? true,
          SMS: num.features?.includes('SMS') ?? true,
          MMS: false, // Vonage doesn't support MMS
        },
        monthlyCost: parseFloat(num.cost) || 0.9, // Approximate cost
      }));
    } catch (error: any) {
      throw new Error(`Vonage search failed: ${error.message}`);
    }
  }

  /**
   * Purchase a phone number
   */
  async purchasePhoneNumber(
    phoneNumber: string,
    friendlyName: string,
    webhookBaseUrl: string
  ): Promise<PurchasedNumber> {
    try {
      // Purchase the number
      const response = await this.client.numbers.buy(phoneNumber.replace('+', ''), 'US');

      // Configure webhooks for the number
      await this.client.numbers.update(phoneNumber.replace('+', ''), 'US', {
        voiceCallbackType: 'app',
        voiceCallbackValue: this.applicationId,
        voiceStatusCallback: `${webhookBaseUrl}/api/telephony/vonage-status`,
      });

      return {
        providerSid: response['error-code-label'] || phoneNumber,
        phoneNumber: phoneNumber,
        friendlyName: friendlyName,
        capabilities: {
          voice: true,
          SMS: true,
          MMS: false,
        },
      };
    } catch (error: any) {
      throw new Error(`Vonage purchase failed: ${error.message}`);
    }
  }

  /**
   * Release a phone number
   */
  async releasePhoneNumber(providerSid: string): Promise<void> {
    try {
      await this.client.numbers.cancel(providerSid.replace('+', ''), 'US');
    } catch (error: any) {
      throw new Error(`Vonage release failed: ${error.message}`);
    }
  }

  /**
   * Make outbound call using NCCO
   */
  async makeCall(params: MakeCallParams): Promise<CallInfo> {
    try {
      // Create NCCO (Nexmo Call Control Objects) - JSON-based call control
      const ncco = [
        {
          action: 'talk',
          text: 'Connecting your call. Please wait.',
          voiceName: 'Amy',
        },
        {
          action: 'connect',
          eventUrl: [`${params.webhookBaseUrl}/api/telephony/vonage-event`],
          from: params.from,
          endpoint: [
            {
              type: 'phone',
              number: params.to,
            },
          ],
        },
        {
          action: 'record',
          eventUrl: [`${params.webhookBaseUrl}/api/telephony/vonage-recording`],
        },
      ];

      const response = await this.client.voice.createOutboundCall({
        to: [
          {
            type: 'phone',
            number: params.to,
          },
        ],
        from: {
          type: 'phone',
          number: params.from,
        },
        ncco: ncco,
        event_url: [`${params.webhookBaseUrl}/api/telephony/vonage-event`],
        answer_url: [`${params.webhookBaseUrl}/api/telephony/vonage-answer?callPointId=${params.callPointId}`],
      });

      return {
        callSid: response.uuid,
        status: response.status || 'initiated',
        from: params.from,
        to: params.to,
        direction: 'outbound',
      };
    } catch (error: any) {
      throw new Error(`Vonage makeCall failed: ${error.message}`);
    }
  }

  /**
   * Hangup call
   */
  async hangupCall(callSid: string): Promise<void> {
    try {
      await this.client.voice.modifyCall(callSid, { action: 'hangup' });
    } catch (error: any) {
      throw new Error(`Vonage hangup failed: ${error.message}`);
    }
  }

  /**
   * Transfer call to another number
   */
  async transferCall(callSid: string, toNumber: string): Promise<void> {
    try {
      const ncco = [
        {
          action: 'talk',
          text: 'Transferring your call now.',
          voiceName: 'Amy',
        },
        {
          action: 'connect',
          endpoint: [
            {
              type: 'phone',
              number: toNumber,
            },
          ],
        },
      ];

      await this.client.voice.modifyCall(callSid, { action: 'transfer', destination: { type: 'ncco', ncco } });
    } catch (error: any) {
      throw new Error(`Vonage transfer failed: ${error.message}`);
    }
  }

  /**
   * Validate webhook signature
   * Vonage uses JWT signature validation
   */
  validateWebhookSignature(signature: string, url: string, params: any): boolean {
    try {
      // TODO: Implement Vonage JWT signature validation
      // This requires verifying the JWT token from the request header
      console.warn('[Vonage] Webhook validation not implemented yet');
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Generate NCCO response for call control
   */
  generateNCCO(instructions: any): any[] {
    const ncco: any[] = [];

    if (instructions.say) {
      ncco.push({
        action: 'talk',
        text: instructions.say,
        voiceName: instructions.voice || 'Amy',
      });
    }

    if (instructions.play) {
      ncco.push({
        action: 'stream',
        streamUrl: [instructions.play],
      });
    }

    if (instructions.dial) {
      ncco.push({
        action: 'connect',
        endpoint: [
          {
            type: 'phone',
            number: instructions.dial,
          },
        ],
      });
    }

    if (instructions.record) {
      ncco.push({
        action: 'record',
        eventUrl: [instructions.recordingCallback],
      });
    }

    if (instructions.hangup) {
      ncco.push({
        action: 'talk',
        text: 'Goodbye.',
      });
    }

    return ncco;
  }

  /**
   * Get call recording URL
   */
  async getRecordingUrl(recordingId: string): Promise<string> {
    try {
      const recording = await this.client.voice.getRecording(recordingId);
      return recording._links?.self?.href || '';
    } catch (error: any) {
      throw new Error(`Failed to get recording URL: ${error.message}`);
    }
  }

  /**
   * Download recording
   */
  async downloadRecording(recordingId: string): Promise<Buffer> {
    try {
      const recording = await this.client.voice.getRecording(recordingId);
      return recording;
    } catch (error: any) {
      throw new Error(`Failed to download recording: ${error.message}`);
    }
  }
}
