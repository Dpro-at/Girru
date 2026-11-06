/**
 * Telephony Provider Interface
 * Abstract interface that all telephony providers must implement
 * Supports: Twilio, Microsoft Teams Phone, Vonage, Plivo
 */

/**
 * @typedef {Object} PhoneNumber
 * @property {string} phoneNumber - E.164 format
 * @property {string} friendlyName
 * @property {string} countryCode
 * @property {Object} capabilities - {voice: boolean, sms: boolean, mms: boolean}
 * @property {string} provider - Provider name
 * @property {string} providerSid - Provider's unique ID
 * @property {number} monthlyCost
 */

/**
 * @typedef {Object} CallOptions
 * @property {string} from - Caller phone number
 * @property {string} to - Recipient phone number
 * @property {string} [url] - Webhook URL for call instructions
 * @property {string} [statusCallback] - Webhook for status updates
 * @property {boolean} [record] - Enable recording
 * @property {number} [timeout] - Call timeout in seconds
 * @property {Object} [metadata] - Additional metadata
 */

/**
 * @typedef {Object} CallResult
 * @property {string} callSid - Unique call identifier
 * @property {string} status - Call status
 * @property {string} direction - 'outbound' or 'inbound'
 * @property {string} from
 * @property {string} to
 */

/**
 * Base interface for all telephony providers
 */
export class TelephonyProvider {
  /**
   * @param {string} providerName - Provider identifier
   * @param {Object} config - Provider configuration
   */
  constructor(providerName, config) {
    if (new.target === TelephonyProvider) {
      throw new TypeError('Cannot construct TelephonyProvider instances directly');
    }
    this.providerName = providerName;
    this.config = config;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATION & SETUP
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize and authenticate with provider
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented by provider');
  }

  /**
   * Test provider connectivity and credentials
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    throw new Error('testConnection() must be implemented by provider');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHONE NUMBERS MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Search available phone numbers to purchase
   * @param {string} country - Country code (e.g., 'US', 'GB')
   * @param {string} [areaCode] - Optional area code filter
   * @returns {Promise<PhoneNumber[]>}
   */
  async searchAvailableNumbers(country, areaCode) {
    throw new Error('searchAvailableNumbers() must be implemented by provider');
  }

  /**
   * Purchase a phone number
   * @param {string} phoneNumber - E.164 format
   * @param {string} friendlyName
   * @returns {Promise<string>} - Number ID
   */
  async purchaseNumber(phoneNumber, friendlyName) {
    throw new Error('purchaseNumber() must be implemented by provider');
  }

  /**
   * Release (delete) a phone number
   * @param {string} numberSid - Provider's number identifier
   * @returns {Promise<void>}
   */
  async releaseNumber(numberSid) {
    throw new Error('releaseNumber() must be implemented by provider');
  }

  /**
   * List all owned phone numbers
   * @returns {Promise<PhoneNumber[]>}
   */
  async listNumbers() {
    throw new Error('listNumbers() must be implemented by provider');
  }

  /**
   * Update phone number configuration
   * @param {string} numberSid
   * @param {Object} updates - {voiceUrl, smsUrl, friendlyName, etc.}
   * @returns {Promise<void>}
   */
  async updateNumber(numberSid, updates) {
    throw new Error('updateNumber() must be implemented by provider');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CALL MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Initiate outbound call
   * @param {CallOptions} options
   * @returns {Promise<CallResult>}
   */
  async makeCall(options) {
    throw new Error('makeCall() must be implemented by provider');
  }

  /**
   * Hangup active call
   * @param {string} callSid - Call identifier
   * @returns {Promise<void>}
   */
  async hangupCall(callSid) {
    throw new Error('hangupCall() must be implemented by provider');
  }

  /**
   * Transfer call to another number
   * @param {string} callSid
   * @param {string} toNumber - Transfer destination
   * @returns {Promise<void>}
   */
  async transferCall(callSid, toNumber) {
    throw new Error('transferCall() must be implemented by provider');
  }

  /**
   * Mute/unmute call
   * @param {string} callSid
   * @param {boolean} muted
   * @returns {Promise<void>}
   */
  async muteCall(callSid, muted) {
    throw new Error('muteCall() must be implemented by provider');
  }

  /**
   * Hold/unhold call
   * @param {string} callSid
   * @param {boolean} hold
   * @returns {Promise<void>}
   */
  async holdCall(callSid, hold) {
    throw new Error('holdCall() must be implemented by provider');
  }

  /**
   * Get call details
   * @param {string} callSid
   * @returns {Promise<Object>}
   */
  async getCall(callSid) {
    throw new Error('getCall() must be implemented by provider');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RECORDING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Start recording active call
   * @param {string} callSid
   * @returns {Promise<string>} - Recording SID
   */
  async startRecording(callSid) {
    throw new Error('startRecording() must be implemented by provider');
  }

  /**
   * Stop recording
   * @param {string} callSid
   * @param {string} recordingSid
   * @returns {Promise<void>}
   */
  async stopRecording(callSid, recordingSid) {
    throw new Error('stopRecording() must be implemented by provider');
  }

  /**
   * Get recording URL
   * @param {string} recordingSid
   * @returns {Promise<string>} - Download URL
   */
  async getRecordingUrl(recordingSid) {
    throw new Error('getRecordingUrl() must be implemented by provider');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBHOOK HANDLING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Parse incoming webhook request
   * @param {Object} body - Request body
   * @param {Object} headers - Request headers
   * @returns {Object} - Normalized call data
   */
  parseWebhook(body, headers) {
    throw new Error('parseWebhook() must be implemented by provider');
  }

  /**
   * Validate webhook signature (security)
   * @param {string} signature - Webhook signature header
   * @param {string} url - Webhook URL
   * @param {Object} params - Webhook parameters
   * @returns {boolean}
   */
  validateWebhook(signature, url, params) {
    throw new Error('validateWebhook() must be implemented by provider');
  }

  /**
   * Generate call control response (TwiML, JSON, etc.)
   * @param {Object} instructions - Call instructions
   * @returns {string} - Provider-specific response format
   */
  generateCallResponse(instructions) {
    throw new Error('generateCallResponse() must be implemented by provider');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CAPABILITIES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get provider capabilities
   * @returns {string[]} - Array of supported features
   */
  getCapabilities() {
    return [
      'voice',
      'recording',
      'transfer',
      'hold',
      'mute',
    ];
  }

  /**
   * Check if provider supports a specific feature
   * @param {string} feature
   * @returns {boolean}
   */
  supports(feature) {
    return this.getCapabilities().includes(feature);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HEALTH & MONITORING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Perform health check
   * @returns {Promise<{healthy: boolean, latency: number, message: string}>}
   */
  async healthCheck() {
    const startTime = Date.now();
    try {
      await this.testConnection();
      const latency = Date.now() - startTime;
      return { healthy: true, latency, message: 'Provider is healthy' };
    } catch (error) {
      const latency = Date.now() - startTime;
      return { healthy: false, latency, message: error.message };
    }
  }
}
