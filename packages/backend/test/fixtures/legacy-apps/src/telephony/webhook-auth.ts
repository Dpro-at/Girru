/**
 * Twilio signature check for the core telephony webhooks (S0-A.5).
 *
 * The six /api/telephony/*-webhook routes are public (Twilio cannot send a
 * bearer token), so each request must carry a valid X-Twilio-Signature made
 * with the stored Twilio auth token over the configured public URL. Without
 * an auth token or a public URL every request is refused (fail closed).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { getTelephonySecret, TELEPHONY_KEYS } from '../../../../../src/telephony/credentials.js';
import { publicRequestUrl, verifyTwilioRequest } from '../../../../../src/webhooks/verify.js';

export async function twilioWebhookSettings(): Promise<{ authToken: string | null; publicUrl: string | null }> {
  const authToken = (await getTelephonySecret(TELEPHONY_KEYS.twilioAuthToken)) || process.env.TWILIO_AUTH_TOKEN || null;
  const publicUrl = process.env.PUBLIC_URL || (await getTelephonySecret(TELEPHONY_KEYS.publicUrl)) || null;
  return { authToken, publicUrl };
}

/** preHandler: 403 unless the request is signed by Twilio. */
export async function verifyTwilioWebhook(request: FastifyRequest, reply: FastifyReply) {
  const { authToken, publicUrl } = await twilioWebhookSettings();
  if (!verifyTwilioRequest(request, authToken, publicRequestUrl(request, publicUrl))) {
    request.log.warn('[Telephony] Rejected webhook without a valid Twilio signature');
    return reply.code(403).send({ error: 'Invalid webhook signature' });
  }
}
