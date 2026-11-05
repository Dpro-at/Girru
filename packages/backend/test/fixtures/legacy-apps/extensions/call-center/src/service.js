/**
 * Call Center Service Initialization
 * Initializes Twilio/Google Voice providers
 */

export async function initializeTelephonyService() {
  // Import and initialize the telephony service from core
  const { getTelephonyService } = await import('../../../src/services/telephony-service.js');

  try {
    const service = getTelephonyService();
    console.log('[Call Center] ✅ Telephony service initialized');
    return service;
  } catch (error) {
    console.warn('[Call Center] ⚠️ Telephony service initialization failed:', error.message);
    console.warn('[Call Center] Make sure Twilio/Google credentials are configured in Settings');
    return null;
  }
}
