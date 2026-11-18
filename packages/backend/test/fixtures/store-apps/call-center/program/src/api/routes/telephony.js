import {telephonyNames} from '../../db/index.js';
import { handleError } from '../error-handler.js';
import { q as scopedQ, run, one, sql } from '../../repositories/sql-steps.js';
import { nowText, secondsSinceText } from '../../db/pg/dialect.js';
import { getTelephonyService } from '../../services/telephony-service.js';
import { handleIncomingCall, handleOutboundTwiml, processSpeech, handleStatusWebhook, handleRecordingWebhook, } from '../../telephony/voice-handler.js';
import { processIvrSelection } from '../../telephony/ivr-engine.js';
import { maskSecret } from '../../credentials/secret-mask.js';
import { authorizeActiveRole, OWNER_OR_ADMIN } from '../../auth/route-guards.js';
import { TELEPHONY_KEYS, getTelephonySecret, setTelephonySecret, } from '../../telephony/credentials.js';
import { randomBytes } from 'crypto';
import { registerRawBodyParsers } from '../../webhooks/verify.js';
import { verifyTwilioWebhook } from '../../telephony/webhook-auth.js';
const labelRow=row=>{
 if(!row||!Object.hasOwn(row,'agentName'))return row;
 const labels=telephonyNames(row.agentId??row.agent_id,row.workflowId??row.workflow_id);
 return {...row,agentName:labels.agentName,...(Object.hasOwn(row,'workflowName')?{workflowName:labels.workflowName}:{})};
};
const q=Object.freeze({...scopedQ,all:async(...args)=>(await scopedQ.all(...args)).map(labelRow),one:async(...args)=>labelRow(await scopedQ.one(...args))});
/**
 * Telephony / Assistant Center API Routes
 * Complete call center functionality with Twilio/Google Voice integration
 */
export async function registerTelephonyRoutes(fastify) {
    const telephony = getTelephonyService();
    fastify.log.info('[Telephony API] ✅ Routes registered');
    // ════════════════════════════════════════════════════════════════════════════
    // PHONE NUMBERS MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════════
    // GET /api/telephony/numbers - List all purchased phone numbers
    fastify.get('/api/telephony/numbers', async (request, reply) => {
        try {
            // Read statistics directly from phone_numbers table (pre-computed)
            const numbers = await q.all(`
        SELECT
          id,
          phone_number as "phoneNumber",
          friendly_name as "friendlyName",
          country_code as "countryCode",
          capabilities,
          provider,
          provider_sid as "providerSid",
          status,
          monthly_cost as "monthlyCost",
          purchased_at as "purchasedAt",
          created_at as "createdAt",
          COALESCE(total_calls, 0) as "totalCalls",
          COALESCE(total_inbound_calls, 0) as "totalInboundCalls",
          COALESCE(total_outbound_calls, 0) as "totalOutboundCalls",
          COALESCE(total_duration_seconds, 0) as "totalDurationSeconds",
          COALESCE(total_inbound_duration_seconds, 0) as "totalInboundDurationSeconds",
          COALESCE(total_outbound_duration_seconds, 0) as "totalOutboundDurationSeconds",
          COALESCE(total_cost_spent, 0) as "totalCostSpent",
          last_used_at as "lastUsedAt"
        FROM app_call_center__phone_numbers
        WHERE status != 'released'
        ORDER BY purchased_at DESC
      `);
            // Parse JSON fields and map to expected format
            const parsed = numbers.map((n) => ({
                id: n.id,
                phone_number: n.phoneNumber,
                friendly_name: n.friendlyName,
                country_code: n.countryCode,
                capabilities: n.capabilities ? n.capabilities : '{}',
                provider_type: n.provider,
                sid: n.providerSid,
                status: n.status,
                monthly_cost: n.monthlyCost,
                purchased_at: n.purchasedAt,
                created_at: n.createdAt,
                total_calls: n.totalCalls || 0,
                total_inbound_calls: n.totalInboundCalls || 0,
                total_outbound_calls: n.totalOutboundCalls || 0,
                total_duration_seconds: n.totalDurationSeconds || 0,
                total_inbound_duration_seconds: n.totalInboundDurationSeconds || 0,
                total_outbound_duration_seconds: n.totalOutboundDurationSeconds || 0,
                total_cost_spent: n.totalCostSpent || 0,
                last_used_at: n.lastUsedAt || null,
            }));
            return reply.send({ success: true, numbers: parsed });
        }
        catch (error) {
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Telephony] List numbers failed');
        }
    });
    // GET /api/telephony/numbers/search - Search available numbers to purchase
    fastify.get('/api/telephony/numbers/search', async (request, reply) => {
        try {
            const { country, areaCode, provider } = request.query;
            if (!country) {
                return reply.status(400).send({ error: 'country parameter is required' });
            }
            const numbers = await telephony.searchAvailableNumbers(country, areaCode, provider);
            return reply.send({ success: true, numbers });
        }
        catch (error) {
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Telephony] Search numbers failed');
        }
    });
    // POST /api/telephony/numbers/purchase - Purchase a phone number
    fastify.post('/api/telephony/numbers/purchase', async (request, reply) => {
        try {
            const { phoneNumber, friendlyName, provider } = request.body;
            if (!phoneNumber) {
                return reply.status(400).send({ error: 'phoneNumber is required' });
            }
            const numberId = await telephony.purchasePhoneNumber(phoneNumber, friendlyName || phoneNumber, provider);
            return reply.send({ success: true, numberId });
        }
        catch (error) {
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Telephony] Purchase number failed');
        }
    });
    // DELETE /api/telephony/numbers/:id - Release a phone number
    fastify.delete('/api/telephony/numbers/:id', async (request, reply) => {
        try {
            const { id } = request.params;
            await telephony.releasePhoneNumber(id);
            return reply.send({ success: true });
        }
        catch (error) {
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Telephony] Release number failed');
        }
    });
    // ════════════════════════════════════════════════════════════════════════════
    // CALL POINTS MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════════
    // GET /api/telephony/call-points - List all call points
    fastify.get('/api/telephony/call-points', async (request, reply) => {
        try {
            const callPoints = await q.all(`
        SELECT
          cp.id, cp.name, cp.description,
          cp.phone_number_id as "phoneNumberId",
          pn.phone_number as "phoneNumber",
          pn.friendly_name as "phoneNumberName",
          cp.agent_id as "agentId",
          NULL as "agentName",
          cp.workflow_id as "workflowId",
          NULL as "workflowName",
          cp.voice_provider as "voiceProvider",
          cp.voice_id as "voiceId",
          cp.language_preference as "languagePreference",
          cp.greeting_message as "greetingMessage",
          cp.ivr_menu as "ivrMenu",
          cp.max_call_duration as "maxCallDuration",
          cp.record_calls as "recordCalls",
          cp.transcription_provider as "transcriptionProvider",
          cp.business_hours as "businessHours",
          cp.after_hours_message as "afterHoursMessage",
          cp.transfer_number as "transferNumber",
          cp.enabled,
          cp.created_at as "createdAt"
        FROM app_call_center__call_points cp
        LEFT JOIN app_call_center__phone_numbers pn ON pn.id = cp.phone_number_id
        ORDER BY cp.created_at DESC
      `);
            // Parse JSON fields
            const parsed = callPoints.map((cp) => ({
                ...cp,
                ivrMenu: cp.ivrMenu ? JSON.parse(cp.ivrMenu) : null,
                businessHours: cp.businessHours ? JSON.parse(cp.businessHours) : null,
                recordCalls: Boolean(cp.recordCalls),
                enabled: Boolean(cp.enabled),
            }));
            return reply.send({ success: true, callPoints: parsed });
        }
        catch (error) {
            fastify.log.error('List call points error:', error);
            return handleError(reply, error, 'internal', '[Telephony] List call points failed');
        }
    });
    // POST /api/telephony/call-points - Create new call point
    fastify.post('/api/telephony/call-points', async (request, reply) => {
        try {
            const id = randomBytes(16).toString('hex');
            const { name, description, phoneNumberId, agentId, workflowId, voiceProvider, voiceId, languagePreference, greetingMessage, ivrMenu, maxCallDuration, recordCalls, transcriptionProvider, businessHours, afterHoursMessage, transferNumber, enabled, } = request.body;
            if (!name || !phoneNumberId) {
                return reply.status(400).send({ error: 'name and phoneNumberId are required' });
            }
            await q.run(`
        INSERT INTO app_call_center__call_points (
          id, name, description, phone_number_id, agent_id, workflow_id,
          voice_provider, voice_id, language_preference,
          greeting_message, ivr_menu, max_call_duration, record_calls, transcription_provider,
          business_hours, after_hours_message, transfer_number, enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, name, description || null, phoneNumberId, agentId || null, workflowId || null, voiceProvider || 'openai', voiceId || 'alloy', languagePreference || 'auto', greetingMessage || 'Hello, how can I help you?', ivrMenu ? JSON.stringify(ivrMenu) : null, maxCallDuration || 600, recordCalls !== false ? 1 : 0, transcriptionProvider || 'whisper', businessHours ? JSON.stringify(businessHours) : null, afterHoursMessage || null, transferNumber || null, enabled !== false ? 1 : 0);
            return reply.send({ success: true, id });
        }
        catch (error) {
            fastify.log.error('Create call point error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Create call point failed');
        }
    });
    // PUT /api/telephony/call-points/:id - Update call point
    fastify.put('/api/telephony/call-points/:id', async (request, reply) => {
        try {
            const { id } = request.params;
            const updates = request.body;
            // Build dynamic UPDATE query
            const fields = [];
            const values = [];
            const allowedFields = [
                'name',
                'description',
                'phone_number_id',
                'agent_id',
                'workflow_id',
                'voice_provider',
                'voice_id',
                'language_preference',
                'greeting_message',
                'ivr_menu',
                'max_call_duration',
                'record_calls',
                'transcription_provider',
                'business_hours',
                'after_hours_message',
                'transfer_number',
                'enabled',
            ];
            for (const [key, value] of Object.entries(updates)) {
                if (allowedFields.includes(key)) {
                    fields.push(`${key} = ?`);
                    // Stringify JSON fields
                    if (key === 'ivr_menu' || key === 'business_hours') {
                        values.push(value ? JSON.stringify(value) : null);
                    }
                    else if (key === 'record_calls' || key === 'enabled') {
                        values.push(value ? 1 : 0);
                    }
                    else {
                        values.push(value);
                    }
                }
            }
            if (fields.length === 0) {
                return reply.status(400).send({ error: 'No valid fields to update' });
            }
            fields.push(`updated_at = ${nowText(q.dialect)}`);
            values.push(id);
            await q.run(`
        UPDATE app_call_center__call_points SET ${fields.join(', ')} WHERE id = ?
      `, ...values);
            return reply.send({ success: true });
        }
        catch (error) {
            fastify.log.error('Update call point error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Update call point failed');
        }
    });
    // DELETE /api/telephony/call-points/:id - Delete call point
    fastify.delete('/api/telephony/call-points/:id', async (request, reply) => {
        try {
            const { id } = request.params;
            await q.run('DELETE FROM app_call_center__call_points WHERE id = ?', id);
            return reply.send({ success: true });
        }
        catch (error) {
            fastify.log.error('Delete call point error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Delete call point failed');
        }
    });
    // PATCH /api/telephony/call-points/:id/toggle - Enable/disable call point
    fastify.patch('/api/telephony/call-points/:id/toggle', async (request, reply) => {
        try {
            const { id } = request.params;
            // Toggle enabled status and read it back (one transaction; the toggle is one statement)
            const d = q.dialect;
            const updated = await sql().tx(function* () {
                yield* run(`
          UPDATE app_call_center__call_points
          SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END,
              updated_at = ${nowText(d)}
          WHERE id = ?
        `, id);
                return yield* one('SELECT enabled FROM app_call_center__call_points WHERE id = ?', id);
            });
            return reply.send({ success: true, enabled: Boolean(updated?.enabled) });
        }
        catch (error) {
            fastify.log.error('Toggle call point error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Toggle call point failed');
        }
    });
    // ════════════════════════════════════════════════════════════════════════════
    // ACTIVE CALLS
    // ════════════════════════════════════════════════════════════════════════════
    // POST /api/telephony/calls/make - Make outbound call
    fastify.post('/api/telephony/calls/make', async (request, reply) => {
        try {
            const { callPointId, toNumber } = request.body;
            if (!callPointId || !toNumber) {
                return reply.status(400).send({ error: 'callPointId and toNumber are required' });
            }
            const sessionId = await telephony.makeCall({ callPointId, toNumber });
            return reply.send({ success: true, sessionId });
        }
        catch (error) {
            fastify.log.error('Make call error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Make call failed');
        }
    });
    // GET /api/telephony/calls/active - List active calls
    fastify.get('/api/telephony/calls/active', async (request, reply) => {
        try {
            const activeCalls = await q.all(`
        SELECT
          cs.id, cs.call_sid as "callSid", cs.direction, cs.from_number as "fromNumber",
          cs.to_number as "toNumber", cs.caller_name as "callerName", cs.status,
          cs.started_at as "startedAt",
          ${secondsSinceText(q.dialect, 'cs.started_at')} as "durationSeconds",
          cp.name as "callPointName",
          cs.agent_id as "agentId", NULL as "agentName"
        FROM app_call_center__call_sessions cs
        LEFT JOIN app_call_center__call_points cp ON cp.id = cs.call_point_id
        WHERE cs.status IN ('queued', 'ringing', 'in-progress')
        ORDER BY cs.started_at DESC
      `);
            return reply.send({ success: true, activeCalls });
        }
        catch (error) {
            fastify.log.error('List active calls error:', error);
            return handleError(reply, error, 'internal', '[Telephony] List active calls failed');
        }
    });
    // POST /api/telephony/calls/:callSid/hangup - Hangup call
    fastify.post('/api/telephony/calls/:callSid/hangup', async (request, reply) => {
        try {
            const { callSid } = request.params;
            await telephony.hangupCall(callSid);
            return reply.send({ success: true });
        }
        catch (error) {
            fastify.log.error('Hangup call error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Hangup call failed');
        }
    });
    // POST /api/telephony/calls/:callSid/transfer - Transfer call
    fastify.post('/api/telephony/calls/:callSid/transfer', async (request, reply) => {
        try {
            const { callSid } = request.params;
            const { toNumber } = request.body;
            if (!toNumber) {
                return reply.status(400).send({ error: 'toNumber is required' });
            }
            await telephony.transferCall(callSid, toNumber);
            return reply.send({ success: true });
        }
        catch (error) {
            fastify.log.error('Transfer call error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Transfer call failed');
        }
    });
    // ════════════════════════════════════════════════════════════════════════════
    // TWILIO WEBHOOKS (PUBLIC - TWILIO SIGNATURE REQUIRED)
    // ════════════════════════════════════════════════════════════════════════════
    // SECURITY (S0-A.5): these routes are public in the auth gate, so every
    // request must be signed by Twilio (X-Twilio-Signature, stored auth token,
    // PUBLIC_URL). Unsigned or wrongly signed requests get 403; without an auth
    // token or public URL all are refused. Twilio posts form-encoded bodies.
    await fastify.register(async (hooks) => {
        registerRawBodyParsers(hooks);
        hooks.addHook('preHandler', verifyTwilioWebhook);
        // POST /api/telephony/voice-webhook - Incoming call handler (returns TwiML)
        hooks.post('/api/telephony/voice-webhook', handleIncomingCall);
        // POST /api/telephony/outbound-twiml - Outbound call TwiML
        hooks.post('/api/telephony/outbound-twiml', handleOutboundTwiml);
        // POST /api/telephony/process-speech - Process speech input from caller
        hooks.post('/api/telephony/process-speech', processSpeech);
        // POST /api/telephony/process-ivr - Process IVR menu selection
        hooks.post('/api/telephony/process-ivr', processIvrSelection);
        // POST /api/telephony/status-webhook - Call status updates
        hooks.post('/api/telephony/status-webhook', handleStatusWebhook);
        // POST /api/telephony/recording-webhook - Recording ready notification
        hooks.post('/api/telephony/recording-webhook', handleRecordingWebhook);
    });
    // ════════════════════════════════════════════════════════════════════════════
    // TELEPHONY SETTINGS / CREDENTIALS
    // ════════════════════════════════════════════════════════════════════════════
    // GET /api/telephony/settings/credentials - Get current credentials (masked)
    // Owner/admin only; secrets are masked (S0-Q.4), never returned in full.
    fastify.get('/api/telephony/settings/credentials', async (request, reply) => {
        if (authorizeActiveRole(request, reply, OWNER_OR_ADMIN) === null)
            return reply;
        try {
            const twilioSid = await getTelephonySecret(TELEPHONY_KEYS.twilioAccountSid);
            const twilioToken = await getTelephonySecret(TELEPHONY_KEYS.twilioAuthToken);
            const googleProjectId = await getTelephonySecret(TELEPHONY_KEYS.googleProjectId);
            const googleCreds = await getTelephonySecret(TELEPHONY_KEYS.googleCredentialsJson);
            const publicUrl = await getTelephonySecret(TELEPHONY_KEYS.publicUrl);
            // Return masked credentials (only show if exists)
            return reply.send({
                success: true,
                credentials: {
                    twilio: {
                        accountSid: twilioSid ? maskSecret(twilioSid) : null,
                        authToken: twilioToken ? maskSecret(twilioToken) : null,
                        configured: !!(twilioSid && twilioToken),
                    },
                    google: {
                        projectId: googleProjectId || null,
                        credentialsJson: googleCreds ? maskSecret(googleCreds) : null,
                        configured: !!(googleProjectId && googleCreds),
                    },
                    publicUrl: publicUrl || process.env.PUBLIC_URL || null,
                },
            });
        }
        catch (error) {
            fastify.log.error('Get telephony credentials error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Get credentials failed');
        }
    });
    // PUT /api/telephony/settings/credentials - Save/update credentials
    fastify.put('/api/telephony/settings/credentials', async (request, reply) => {
        const callerId = authorizeActiveRole(request, reply, OWNER_OR_ADMIN);
        if (callerId === null)
            return reply;
        try {
            const { twilioAccountSid, twilioAuthToken, googleProjectId, googleCredentialsJson, publicUrl } = request.body || {};
            // Stored encrypted for the owner. Empty or masked values (e.g. "••••abcd"
            // echoed back by the UI) keep the stored secret.
            await setTelephonySecret(TELEPHONY_KEYS.twilioAccountSid, twilioAccountSid, callerId);
            await setTelephonySecret(TELEPHONY_KEYS.twilioAuthToken, twilioAuthToken, callerId);
            await setTelephonySecret(TELEPHONY_KEYS.googleProjectId, googleProjectId, callerId);
            await setTelephonySecret(TELEPHONY_KEYS.googleCredentialsJson, googleCredentialsJson, callerId);
            await setTelephonySecret(TELEPHONY_KEYS.publicUrl, publicUrl, callerId);
            fastify.log.info('[Telephony] Credentials updated successfully');
            return reply.send({
                success: true,
                message: 'Credentials saved successfully. Please restart the backend for changes to take effect.',
                restartRequired: true,
            });
        }
        catch (error) {
            fastify.log.error('Save telephony credentials error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Save credentials failed');
        }
    });
    // POST /api/telephony/settings/test-connection - Test provider connection
    fastify.post('/api/telephony/settings/test-connection', async (request, reply) => {
        if (authorizeActiveRole(request, reply, OWNER_OR_ADMIN) === null)
            return reply;
        try {
            const { provider } = request.body || {};
            if (!provider) {
                return reply.status(400).send({ error: 'provider is required (twilio or google)' });
            }
            if (provider === 'twilio') {
                // Test Twilio connection
                const accountSid = await getTelephonySecret(TELEPHONY_KEYS.twilioAccountSid) || process.env.TWILIO_ACCOUNT_SID;
                const authToken = await getTelephonySecret(TELEPHONY_KEYS.twilioAuthToken) || process.env.TWILIO_AUTH_TOKEN;
                if (!accountSid || !authToken) {
                    return reply.status(400).send({
                        success: false,
                        error: 'Twilio credentials not configured',
                    });
                }
                // Try to connect to Twilio API
                const twilio = (await import('twilio')).default;
                const client = twilio(accountSid, authToken);
                // Fetch account info to test connection
                const account = await client.api.accounts(accountSid).fetch();
                return reply.send({
                    success: true,
                    message: 'Twilio connection successful',
                    details: {
                        accountSid: account.sid,
                        accountName: account.friendlyName,
                        status: account.status,
                    },
                });
            }
            else if (provider === 'google') {
                // Test Google Voice connection
                const projectId = await getTelephonySecret(TELEPHONY_KEYS.googleProjectId) || process.env.GOOGLE_CLOUD_PROJECT_ID;
                const credsJson = await getTelephonySecret(TELEPHONY_KEYS.googleCredentialsJson) || process.env.GOOGLE_CLOUD_CREDENTIALS;
                if (!projectId || !credsJson) {
                    return reply.status(400).send({
                        success: false,
                        error: 'Google Cloud credentials not configured',
                    });
                }
                return reply.send({
                    success: true,
                    message: 'Google Cloud credentials found',
                    details: {
                        projectId,
                        note: 'Full Google Voice integration not yet implemented',
                    },
                });
            }
            return reply.status(400).send({ error: 'Invalid provider' });
        }
        catch (error) {
            fastify.log.error('Test connection error:', error);
            return reply.status(500).send({
                success: false,
                error: 'Connection test failed', // SECURITY: H-09 - hide error details
            });
        }
    });
    // ════════════════════════════════════════════════════════════════════════════
    // CALL HISTORY / SESSIONS
    // ════════════════════════════════════════════════════════════════════════════
    // GET /api/telephony/sessions - List call sessions (with filters)
    fastify.get('/api/telephony/sessions', async (request, reply) => {
        try {
            const { direction, status, callPointId, fromDate, toDate, limit = 100, offset = 0 } = request.query;
            // Build dynamic WHERE clause
            const whereClauses = [];
            const values = [];
            if (direction) {
                whereClauses.push('cs.direction = ?');
                values.push(direction);
            }
            if (status) {
                whereClauses.push('cs.status = ?');
                values.push(status);
            }
            if (callPointId) {
                whereClauses.push('cs.call_point_id = ?');
                values.push(callPointId);
            }
            if (fromDate) {
                whereClauses.push('cs.created_at >= ?');
                values.push(fromDate);
            }
            if (toDate) {
                whereClauses.push('cs.created_at <= ?');
                values.push(toDate);
            }
            const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
            const sessions = await q.all(`
        SELECT
          cs.id, cs.call_sid as "callSid", cs.direction, cs.from_number as "fromNumber",
          cs.to_number as "toNumber", cs.caller_name as "callerName", cs.status,
          cs.started_at as "startedAt", cs.answered_at as "answeredAt", cs.ended_at as "endedAt",
          cs.duration_seconds as "durationSeconds", cs.recording_url as "recordingUrl",
          cs.recording_file_id as "recordingFileId", cs.conversation_summary as "conversationSummary",
          cp.name as "callPointName",
          cs.agent_id as "agentId", NULL as "agentName"
        FROM app_call_center__call_sessions cs
        LEFT JOIN app_call_center__call_points cp ON cp.id = cs.call_point_id
        ${whereClause}
        ORDER BY cs.created_at DESC
        LIMIT ? OFFSET ?
      `, ...values, limit, offset);
            return reply.send({ success: true, sessions, total: sessions.length });
        }
        catch (error) {
            fastify.log.error('List call sessions error:', error);
            return handleError(reply, error, 'internal', '[Telephony] List sessions failed');
        }
    });
    // GET /api/telephony/sessions/:id - Get single session with full transcript
    fastify.get('/api/telephony/sessions/:id', async (request, reply) => {
        try {
            const { id } = request.params;
            // Get session details
            const session = await q.one(`
          SELECT
            cs.*,
            cp.name as "callPointName",
            NULL as "agentName"
          FROM app_call_center__call_sessions cs
          LEFT JOIN app_call_center__call_points cp ON cp.id = cs.call_point_id
          WHERE cs.id = ?
        `, id);
            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }
            // Get call messages (transcript)
            const messages = await q.all(`
          SELECT
            id, role, content, timestamp, audio_url as "audioUrl"
          FROM app_call_center__call_messages
          WHERE call_session_id = ?
          ORDER BY timestamp ASC
        `, id);
            return reply.send({ success: true, session, messages });
        }
        catch (error) {
            fastify.log.error('Get call session error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Get session failed');
        }
    });
    // DELETE /api/telephony/sessions/:id - Delete session
    fastify.delete('/api/telephony/sessions/:id', async (request, reply) => {
        try {
            const { id } = request.params;
            // Delete messages first (cascade), then the session: one transaction
            await sql().tx(function* () {
                yield* run('DELETE FROM app_call_center__call_messages WHERE call_session_id = ?', id);
                yield* run('DELETE FROM app_call_center__call_sessions WHERE id = ?', id);
            });
            return reply.send({ success: true });
        }
        catch (error) {
            fastify.log.error('Delete call session error:', error);
            return handleError(reply, error, 'internal', '[Telephony] Delete session failed');
        }
    });
}
