/**
 * Phone Numbers Management Routes
 * Search and purchase phone numbers from telephony providers
 * Fastify routes - NOT Express
 */
import { getDatabase } from '../../../src/db/index.js';
import { getCredentialManager } from '../../../src/credentials/index.js';
import { registerRawBodyParsers, verifyTwilioRequest, publicRequestUrl } from '../../shared/webhook-verify.js';
/**
 * Register phone numbers routes under /api/ext/call-center/numbers/
 */
export async function registerNumberRoutes(fastify) {
    const db = getDatabase();
    const credManager = getCredentialManager();
    // Twilio webhooks post form-encoded bodies; keep the raw body for checks.
    registerRawBodyParsers(fastify);
    /**
     * SECURITY (S0-Q.18): the /webhooks/* routes are public (Twilio calls them),
     * so each request must carry a valid X-Twilio-Signature for the configured
     * auth token and PUBLIC_URL. Missing token/URL/signature → 403, nothing is
     * written.
     */
    async function verifyTwilioWebhook(request, reply) {
        let authToken = null;
        try {
            authToken = await credManager.getValueByName('telephony.twilio.auth_token');
        }
        catch {
            authToken = null;
        }
        if (verifyTwilioRequest(request, authToken, publicRequestUrl(request)))
            return true;
        reply.status(403).send({ error: 'Invalid Twilio signature' });
        return false;
    }
    /**
     * GET /api/ext/call-center/numbers/available
     * Search for available phone numbers
     * Query params: country, areaCode (optional), contains (optional)
     */
    fastify.get('/numbers/available', async (request, reply) => {
        try {
            const { country = 'US', areaCode, contains } = request.query;
            // Get default provider
            const provider = db
                .prepare('SELECT provider_name, enabled FROM app_call_center__telephony_providers WHERE is_default = 1')
                .get();
            if (!provider || !provider.enabled) {
                return reply.status(400).send({ error: 'No default telephony provider enabled' });
            }
            let numbers = [];
            // Twilio
            if (provider.provider_name === 'twilio') {
                const accountSid = await credManager.getValueByName('telephony.twilio.account_sid');
                const authToken = await credManager.getValueByName('telephony.twilio.auth_token');
                if (!accountSid || !authToken) {
                    return reply.status(400).send({ error: 'Twilio credentials not configured' });
                }
                try {
                    const twilio = (await import('twilio')).default;
                    const client = twilio(accountSid, authToken);
                    const searchParams = {
                        voiceEnabled: true,
                        smsEnabled: true,
                        ...(areaCode && { areaCode }),
                        ...(contains && { contains }),
                    };
                    const availableNumbers = await client.availablePhoneNumbers(country).local.list(searchParams);
                    numbers = availableNumbers.map((n) => ({
                        phoneNumber: n.phoneNumber,
                        friendlyName: n.friendlyName,
                        locality: n.locality || 'Unknown',
                        region: n.region || 'Unknown',
                        capabilities: {
                            voice: n.capabilities.voice,
                            sms: n.capabilities.SMS,
                            mms: n.capabilities.MMS,
                        },
                        monthlyPrice: '$1.15',
                        setupPrice: '$1.00',
                    }));
                }
                catch (err) {
                    fastify.log.error('[Numbers] Twilio search error:', err);
                    return reply.status(500).send({ error: 'Failed to search Twilio numbers', message: err.message });
                }
            }
            // Vonage
            else if (provider.provider_name === 'vonage') {
                const apiKey = await credManager.getValueByName('telephony.vonage.api_key');
                const apiSecret = await credManager.getValueByName('telephony.vonage.api_secret');
                if (!apiKey || !apiSecret) {
                    return reply.status(400).send({ error: 'Vonage credentials not configured' });
                }
                try {
                    const { Vonage } = await import('@vonage/server-sdk');
                    const vonage = new Vonage({ apiKey, apiSecret });
                    const searchParams = {
                        country,
                        type: 'landline-toll-free',
                        features: 'VOICE,SMS',
                        ...(contains && { pattern: contains }),
                    };
                    const response = await vonage.numbers.searchAvailable(searchParams);
                    numbers = (response.numbers || []).map((n) => ({
                        phoneNumber: n.msisdn,
                        friendlyName: n.msisdn,
                        locality: n.city || 'Unknown',
                        region: country,
                        capabilities: {
                            voice: n.features.includes('VOICE'),
                            sms: n.features.includes('SMS'),
                            mms: false,
                        },
                        monthlyPrice: '$0.90',
                        setupPrice: '$0.90',
                    }));
                }
                catch (err) {
                    fastify.log.error('[Numbers] Vonage search error:', err);
                    return reply.status(500).send({ error: 'Failed to search Vonage numbers', message: err.message });
                }
            }
            // Microsoft Teams
            else if (provider.provider_name === 'microsoft_teams') {
                return reply.status(501).send({
                    error: 'Microsoft Teams Phone number search not implemented yet',
                    message: 'Teams phone numbers are managed through Microsoft 365 admin center',
                });
            }
            return { success: true, numbers, count: numbers.length };
        }
        catch (error) {
            fastify.log.error('[Numbers] Search error:', error);
            return reply.status(500).send({ error: 'Failed to search numbers', message: error.message });
        }
    });
    /**
     * POST /api/ext/call-center/numbers/purchase
     * Purchase a phone number
     * Body: { phoneNumber, providerId (optional) }
     */
    fastify.post('/numbers/purchase', async (request, reply) => {
        try {
            const { phoneNumber, providerId } = request.body;
            if (!phoneNumber) {
                return reply.status(400).send({ error: 'Phone number is required' });
            }
            // Get provider (use providerId if given, otherwise default)
            const provider = providerId
                ? db.prepare('SELECT * FROM app_call_center__telephony_providers WHERE id = ?').get(providerId)
                : db.prepare('SELECT * FROM app_call_center__telephony_providers WHERE is_default = 1').get();
            if (!provider || !provider.enabled) {
                return reply.status(400).send({ error: 'Provider not found or not enabled' });
            }
            let purchasedNumber = null;
            // Twilio
            if (provider.provider_name === 'twilio') {
                const accountSid = await credManager.getValueByName('telephony.twilio.account_sid');
                const authToken = await credManager.getValueByName('telephony.twilio.auth_token');
                if (!accountSid || !authToken) {
                    return reply.status(400).send({ error: 'Twilio credentials not configured' });
                }
                try {
                    const twilio = (await import('twilio')).default;
                    const client = twilio(accountSid, authToken);
                    const number = await client.incomingPhoneNumbers.create({
                        phoneNumber,
                        voiceUrl: `${process.env.PUBLIC_URL || 'https://your-domain.com'}/api/telephony/twilio-voice`,
                        statusCallback: `${process.env.PUBLIC_URL || 'https://your-domain.com'}/api/telephony/twilio-status`,
                        smsUrl: `${process.env.PUBLIC_URL || 'https://your-domain.com'}/api/telephony/twilio-sms`,
                    });
                    purchasedNumber = {
                        sid: number.sid,
                        phoneNumber: number.phoneNumber,
                        friendlyName: number.friendlyName,
                    };
                }
                catch (err) {
                    fastify.log.error('[Numbers] Twilio purchase error:', err);
                    return reply.status(500).send({ error: 'Failed to purchase number', message: err.message });
                }
            }
            // Vonage
            else if (provider.provider_name === 'vonage') {
                const apiKey = await credManager.getValueByName('telephony.vonage.api_key');
                const apiSecret = await credManager.getValueByName('telephony.vonage.api_secret');
                if (!apiKey || !apiSecret) {
                    return reply.status(400).send({ error: 'Vonage credentials not configured' });
                }
                try {
                    const { Vonage } = await import('@vonage/server-sdk');
                    const vonage = new Vonage({ apiKey, apiSecret });
                    const response = await vonage.numbers.buy('US', phoneNumber);
                    purchasedNumber = {
                        sid: response['error-code-label'] || 'success',
                        phoneNumber: phoneNumber,
                        friendlyName: phoneNumber,
                    };
                }
                catch (err) {
                    fastify.log.error('[Numbers] Vonage purchase error:', err);
                    return reply.status(500).send({ error: 'Failed to purchase number', message: err.message });
                }
            }
            // Microsoft Teams
            else if (provider.provider_name === 'microsoft_teams') {
                return reply.status(501).send({
                    error: 'Microsoft Teams Phone number purchase not implemented yet',
                    message: 'Teams phone numbers are managed through Microsoft 365 admin center',
                });
            }
            // Save to database
            const numberId = db
                .prepare(`
        INSERT INTO app_call_center__phone_numbers (
          phone_number, friendly_name, provider_type, provider_sid, capabilities, status
        ) VALUES (?, ?, ?, ?, ?, 'active')
      `)
                .run(purchasedNumber.phoneNumber, purchasedNumber.friendlyName, provider.provider_name, purchasedNumber.sid, JSON.stringify({ voice: true, sms: true, mms: false })).lastInsertRowid;
            fastify.log.info(`[Numbers] Purchased ${phoneNumber} via ${provider.provider_name}`);
            return {
                success: true,
                number: {
                    id: numberId,
                    ...purchasedNumber,
                    provider: provider.provider_name,
                },
            };
        }
        catch (error) {
            fastify.log.error('[Numbers] Purchase error:', error);
            return reply.status(500).send({ error: 'Failed to purchase number', message: error.message });
        }
    });
    /**
     * POST /api/ext/call-center/numbers
     * Add an existing phone number manually
     * Body: { phone_number, friendly_name, capabilities, status }
     * Provider is auto-detected from enabled credentials
     */
    fastify.post('/numbers', async (request, reply) => {
        try {
            const { phone_number, friendly_name, capabilities, status } = request.body;
            // Validation
            if (!phone_number) {
                return reply.status(400).send({ error: 'phone_number is required' });
            }
            // Check if number already exists
            const existing = db.prepare('SELECT id FROM app_call_center__phone_numbers WHERE phone_number = ?').get(phone_number);
            if (existing) {
                return reply.status(409).send({ error: 'Phone number already exists' });
            }
            // Auto-detect provider from enabled credentials
            const enabledProviders = db
                .prepare('SELECT provider_name FROM app_call_center__telephony_providers WHERE enabled = 1 ORDER BY is_default DESC')
                .all();
            let detectedProvider = 'manual';
            if (enabledProviders.length > 0) {
                detectedProvider = enabledProviders[0].provider_name;
            }
            // Generate provider SID
            const generatedSid = `manual_${Date.now()}`;
            // Insert new number
            const result = db
                .prepare(`INSERT INTO app_call_center__phone_numbers (
            phone_number, friendly_name, provider_type, provider_sid, capabilities, status
          ) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(phone_number, friendly_name || phone_number, detectedProvider, generatedSid, capabilities || JSON.stringify({ voice: true, sms: true, mms: false }), status || 'active');
            fastify.log.info(`[Numbers] Added ${phone_number} (${detectedProvider})`);
            return {
                success: true,
                number: {
                    id: result.lastInsertRowid,
                    phone_number,
                    friendly_name: friendly_name || phone_number,
                    provider_type: detectedProvider,
                    provider_sid: generatedSid,
                    capabilities: capabilities || JSON.stringify({ voice: true, sms: true, mms: false }),
                    status: status || 'active',
                },
            };
        }
        catch (error) {
            fastify.log.error('[Numbers] Add error:', error);
            return reply.status(500).send({ error: 'Failed to add number', message: error.message });
        }
    });
    /**
     * GET /api/ext/call-center/numbers
     * List all purchased phone numbers
     */
    fastify.get('/numbers', async (request, reply) => {
        try {
            const numbers = db
                .prepare(`
        SELECT
          id, phone_number, friendly_name, provider_type,
          provider_sid as sid,
          capabilities, status, created_at,
          voice, language, tts_provider, provider_api_key,
          stt_provider, stt_provider_api_key,
          COALESCE(total_calls, 0) as total_calls,
          COALESCE(total_inbound_calls, 0) as total_inbound_calls,
          COALESCE(total_outbound_calls, 0) as total_outbound_calls,
          COALESCE(total_duration_seconds, 0) as total_duration_seconds,
          COALESCE(total_inbound_duration_seconds, 0) as total_inbound_duration_seconds,
          COALESCE(total_outbound_duration_seconds, 0) as total_outbound_duration_seconds,
          COALESCE(total_cost_spent, 0) as total_cost_spent,
          last_used_at
        FROM app_call_center__phone_numbers
        ORDER BY created_at DESC
      `)
                .all();
            // Stats are now read directly from database
            return { success: true, numbers };
        }
        catch (error) {
            fastify.log.error('[Numbers] List error:', error);
            return reply.status(500).send({ error: 'Failed to list numbers', message: error.message });
        }
    });
    /**
     * PUT /api/ext/call-center/numbers/:id
     * Update phone number details (friendly_name, status)
     */
    fastify.put('/numbers/:id', async (request, reply) => {
        try {
            const { id } = request.params;
            const { friendly_name, status, voice, language, tts_provider, provider_api_key, stt_provider, stt_provider_api_key } = request.body;
            const number = db.prepare('SELECT * FROM app_call_center__phone_numbers WHERE id = ?').get(id);
            if (!number) {
                return reply.status(404).send({ error: 'Phone number not found' });
            }
            // Update fields
            const updates = [];
            const values = [];
            if (friendly_name !== undefined) {
                updates.push('friendly_name = ?');
                values.push(friendly_name);
            }
            if (status !== undefined) {
                updates.push('status = ?');
                values.push(status);
            }
            if (tts_provider !== undefined) {
                updates.push('tts_provider = ?');
                values.push(tts_provider);
            }
            if (provider_api_key !== undefined) {
                updates.push('provider_api_key = ?');
                values.push(provider_api_key);
            }
            if (stt_provider !== undefined) {
                updates.push('stt_provider = ?');
                values.push(stt_provider);
            }
            if (stt_provider_api_key !== undefined) {
                updates.push('stt_provider_api_key = ?');
                values.push(stt_provider_api_key);
            }
            if (voice !== undefined) {
                updates.push('voice = ?');
                values.push(voice);
            }
            if (language !== undefined) {
                updates.push('language = ?');
                values.push(language);
            }
            if (updates.length === 0) {
                return reply.status(400).send({ error: 'No fields to update' });
            }
            values.push(id);
            db.prepare(`UPDATE app_call_center__phone_numbers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
            fastify.log.info(`[Numbers] Updated ${number.phone_number} (provider: ${tts_provider || 'unchanged'}, voice: ${voice || 'unchanged'}, language: ${language || 'unchanged'})`);
            return { success: true, message: 'Phone number updated' };
        }
        catch (error) {
            fastify.log.error('[Numbers] Update error:', error);
            return reply.status(500).send({ error: 'Failed to update number', message: error.message });
        }
    });
    /**
     * DELETE /api/ext/call-center/numbers/:id
     * Release a phone number
     */
    fastify.delete('/numbers/:id', async (request, reply) => {
        try {
            const { id } = request.params;
            const number = db.prepare('SELECT * FROM app_call_center__phone_numbers WHERE id = ?').get(id);
            if (!number) {
                return reply.status(404).send({ error: 'Phone number not found' });
            }
            // Release from provider
            if (number.provider_type === 'twilio') {
                const accountSid = await credManager.getValueByName('telephony.twilio.account_sid');
                const authToken = await credManager.getValueByName('telephony.twilio.auth_token');
                if (accountSid && authToken) {
                    try {
                        const twilio = (await import('twilio')).default;
                        const client = twilio(accountSid, authToken);
                        await client.incomingPhoneNumbers(number.sid).remove();
                    }
                    catch (err) {
                        fastify.log.error('[Numbers] Twilio release error:', err);
                    }
                }
            }
            else if (number.provider_type === 'vonage') {
                const apiKey = await credManager.getValueByName('telephony.vonage.api_key');
                const apiSecret = await credManager.getValueByName('telephony.vonage.api_secret');
                if (apiKey && apiSecret) {
                    try {
                        const { Vonage } = await import('@vonage/server-sdk');
                        const vonage = new Vonage({ apiKey, apiSecret });
                        await vonage.numbers.cancel('US', number.phone_number);
                    }
                    catch (err) {
                        fastify.log.error('[Numbers] Vonage release error:', err);
                    }
                }
            }
            // Delete from database
            db.prepare('DELETE FROM app_call_center__phone_numbers WHERE id = ?').run(id);
            fastify.log.info(`[Numbers] Released ${number.phone_number}`);
            return { success: true, message: 'Phone number released' };
        }
        catch (error) {
            fastify.log.error('[Numbers] Release error:', error);
            return reply.status(500).send({ error: 'Failed to release number', message: error.message });
        }
    });
    /**
     * POST /api/ext/call-center/numbers/:id/test-call
     * Initiate a test call to verify the phone number works
     * Body: { to: '+1234567890' }
     */
    fastify.post('/numbers/:id/test-call', async (request, reply) => {
        try {
            const { id } = request.params;
            const { to } = request.body;
            if (!to) {
                return reply.status(400).send({ error: 'Destination number (to) is required' });
            }
            // Get the phone number
            const number = db.prepare('SELECT * FROM app_call_center__phone_numbers WHERE id = ?').get(id);
            if (!number) {
                return reply.status(404).send({ error: 'Phone number not found' });
            }
            // Only Twilio is supported for now
            if (number.provider_type !== 'twilio') {
                return reply.status(501).send({
                    error: 'Test calls are only supported for Twilio numbers at this time',
                    provider: number.provider_type
                });
            }
            // Get Twilio credentials
            const accountSid = await credManager.getValueByName('telephony.twilio.account_sid');
            const authToken = await credManager.getValueByName('telephony.twilio.auth_token');
            if (!accountSid || !authToken) {
                return reply.status(400).send({ error: 'Twilio credentials not configured' });
            }
            try {
                const twilio = (await import('twilio')).default;
                const client = twilio(accountSid, authToken);
                // Determine base URL for webhooks
                const baseUrl = process.env.PUBLIC_URL || 'https://your-domain.com';
                // Get voice and language settings from database
                const voiceToUse = number.voice || 'Polly.Joanna';
                const languageToUse = number.language || 'en-US';
                // Make the test call with recording and status callback
                const call = await client.calls.create({
                    from: number.phone_number,
                    to: to,
                    record: true, // Enable call recording
                    recordingStatusCallback: `${baseUrl}/api/ext/call-center/webhooks/recording-status`,
                    statusCallback: `${baseUrl}/api/ext/call-center/webhooks/call-status`,
                    statusCallbackEvent: ['completed'], // Notify when call ends
                    twiml: `
            <Response>
              <Say voice="${voiceToUse}" language="${languageToUse}">
                Hello! This is a test call from your Girru Call Center system.
                Your phone number ${number.phone_number.split('').join(' ')} is working correctly.
                This was an automated test. Thank you!
              </Say>
              <Pause length="1"/>
              <Say voice="${voiceToUse}" language="${languageToUse}">Goodbye!</Say>
            </Response>
          `
                });
                // Create call_sessions record
                const sessionId = db
                    .prepare(`INSERT INTO app_call_center__call_sessions (
              call_sid, direction, from_number, to_number,
              provider, status, started_at
            ) VALUES (?, 'outbound', ?, ?, 'twilio', 'queued', datetime('now'))`)
                    .run(call.sid, number.phone_number, to).lastInsertRowid;
                fastify.log.info(`[Numbers] Test call initiated from ${number.phone_number} to ${to}, SID: ${call.sid}, Session: ${sessionId}`);
                // Update phone number stats immediately (increment test call count)
                const currentStats = db
                    .prepare('SELECT total_calls, total_outbound_calls FROM app_call_center__phone_numbers WHERE id = ?')
                    .get(id) || { total_calls: 0, total_outbound_calls: 0 };
                db.prepare(`UPDATE app_call_center__phone_numbers
           SET total_calls = ?,
               total_outbound_calls = ?,
               last_used_at = datetime('now')
           WHERE id = ?`).run((currentStats.total_calls || 0) + 1, (currentStats.total_outbound_calls || 0) + 1, id);
                return {
                    success: true,
                    message: 'Test call initiated successfully',
                    callSid: call.sid,
                    sessionId: sessionId,
                    from: number.phone_number,
                    to: to,
                    status: call.status,
                    recording: 'enabled'
                };
            }
            catch (err) {
                fastify.log.error('[Numbers] Test call error:', err);
                return reply.status(500).send({
                    error: 'Failed to initiate test call',
                    message: err.message,
                    details: err.moreInfo || 'Check Twilio credentials and account balance'
                });
            }
        }
        catch (error) {
            fastify.log.error('[Numbers] Test call error:', error);
            return reply.status(500).send({ error: 'Failed to initiate test call', message: error.message });
        }
    });
    /**
     * POST /api/ext/call-center/numbers/sync
     * Sync phone numbers from provider to local database
     */
    fastify.post('/numbers/sync', async (request, reply) => {
        try {
            // Get default provider
            const provider = db
                .prepare('SELECT provider_name, enabled FROM app_call_center__telephony_providers WHERE is_default = 1')
                .get();
            if (!provider || !provider.enabled) {
                return reply.status(400).send({ error: 'No default telephony provider enabled' });
            }
            let syncedCount = 0;
            // Twilio
            if (provider.provider_name === 'twilio') {
                const accountSid = await credManager.getValueByName('telephony.twilio.account_sid');
                const authToken = await credManager.getValueByName('telephony.twilio.auth_token');
                if (!accountSid || !authToken) {
                    return reply.status(400).send({ error: 'Twilio credentials not configured' });
                }
                try {
                    const twilio = (await import('twilio')).default;
                    const client = twilio(accountSid, authToken);
                    // Fetch all incoming phone numbers from Twilio
                    const numbers = await client.incomingPhoneNumbers.list();
                    for (const num of numbers) {
                        // Check if number already exists in database
                        const existing = db
                            .prepare('SELECT id FROM app_call_center__phone_numbers WHERE provider_sid = ?')
                            .get(num.sid);
                        if (!existing) {
                            // Add to database
                            db.prepare(`INSERT INTO app_call_center__phone_numbers (
                  phone_number, friendly_name, provider_type, provider_sid, capabilities, status
                ) VALUES (?, ?, ?, ?, ?, 'active')`).run(num.phoneNumber, num.friendlyName || num.phoneNumber, 'twilio', num.sid, JSON.stringify({
                                voice: num.capabilities.voice,
                                sms: num.capabilities.SMS,
                                mms: num.capabilities.MMS,
                            }));
                            syncedCount++;
                        }
                    }
                    fastify.log.info(`[Numbers] Synced ${syncedCount} new numbers from Twilio`);
                }
                catch (err) {
                    fastify.log.error('[Numbers] Twilio sync error:', err);
                    return reply.status(500).send({ error: 'Failed to sync Twilio numbers', message: err.message });
                }
            }
            // Vonage
            else if (provider.provider_name === 'vonage') {
                const apiKey = await credManager.getValueByName('telephony.vonage.api_key');
                const apiSecret = await credManager.getValueByName('telephony.vonage.api_secret');
                if (!apiKey || !apiSecret) {
                    return reply.status(400).send({ error: 'Vonage credentials not configured' });
                }
                try {
                    const { Vonage } = await import('@vonage/server-sdk');
                    const vonage = new Vonage({ apiKey, apiSecret });
                    // Fetch owned numbers from Vonage
                    const response = await vonage.numbers.listOwned();
                    for (const num of response.numbers || []) {
                        // Check if number already exists
                        const existing = db
                            .prepare('SELECT id FROM app_call_center__phone_numbers WHERE phone_number = ?')
                            .get(num.msisdn);
                        if (!existing) {
                            // Add to database
                            db.prepare(`INSERT INTO app_call_center__phone_numbers (
                  phone_number, friendly_name, provider_type, provider_sid, capabilities, status
                ) VALUES (?, ?, ?, ?, ?, 'active')`).run(num.msisdn, num.msisdn, 'vonage', num.msisdn, JSON.stringify({
                                voice: num.features.includes('VOICE'),
                                sms: num.features.includes('SMS'),
                                mms: false,
                            }));
                            syncedCount++;
                        }
                    }
                    fastify.log.info(`[Numbers] Synced ${syncedCount} new numbers from Vonage`);
                }
                catch (err) {
                    fastify.log.error('[Numbers] Vonage sync error:', err);
                    return reply.status(500).send({ error: 'Failed to sync Vonage numbers', message: err.message });
                }
            }
            // Microsoft Teams
            else if (provider.provider_name === 'microsoft_teams') {
                return reply.status(501).send({
                    error: 'Microsoft Teams Phone number sync not implemented yet',
                    message: 'Teams phone numbers are managed through Microsoft 365 admin center',
                });
            }
            return { success: true, synced: syncedCount, message: `Synced ${syncedCount} new phone numbers` };
        }
        catch (error) {
            fastify.log.error('[Numbers] Sync error:', error);
            return reply.status(500).send({ error: 'Failed to sync numbers', message: error.message });
        }
    });
    /**
     * GET /recordings
     * Get all call sessions (recordings + all calls)
     * Query params: limit, offset, phone_number_id
     */
    fastify.get('/recordings', async (request, reply) => {
        try {
            const { limit = 50, offset = 0, phone_number_id } = request.query;
            let query = `
        SELECT
          cs.id,
          cs.call_sid,
          cs.direction,
          cs.from_number,
          cs.to_number,
          cs.caller_name,
          cs.status,
          cs.started_at,
          cs.ended_at,
          cs.duration_seconds,
          cs.recording_url,
          cs.transcript,
          pn.friendly_name as phone_friendly_name,
          pn.id as phone_number_id
        FROM app_call_center__call_sessions cs
        LEFT JOIN app_call_center__phone_numbers pn ON (
          cs.from_number = pn.phone_number OR
          cs.to_number = pn.phone_number
        )
        WHERE 1=1
      `;
            const params = [];
            if (phone_number_id) {
                query += ` AND pn.id = ?`;
                params.push(phone_number_id);
            }
            query += ` ORDER BY cs.started_at DESC LIMIT ? OFFSET ?`;
            params.push(parseInt(limit), parseInt(offset));
            const recordings = db.prepare(query).all(...params);
            // Get total count
            let countQuery = `SELECT COUNT(*) as total FROM app_call_center__call_sessions cs WHERE 1=1`;
            if (phone_number_id) {
                countQuery += ` AND EXISTS (SELECT 1 FROM app_call_center__phone_numbers WHERE id = ? AND (phone_number = cs.from_number OR phone_number = cs.to_number))`;
            }
            const totalResult = phone_number_id
                ? db.prepare(countQuery).get(phone_number_id)
                : db.prepare(countQuery).get();
            const total = totalResult?.total || 0;
            return {
                success: true,
                recordings,
                total,
                limit: parseInt(limit),
                offset: parseInt(offset)
            };
        }
        catch (error) {
            fastify.log.error('[Recordings] Fetch error:', error);
            return reply.status(500).send({ error: 'Failed to fetch recordings', message: error.message });
        }
    });
    /**
     * GET /numbers/:id/usage - Get usage statistics for a phone number
     */
    fastify.get('/numbers/:id/usage', async (request, reply) => {
        const { id } = request.params;
        try {
            const db = getDatabase();
            // Get phone number details
            const number = db
                .prepare(`SELECT
            id, phone_number, provider_type, provider_sid,
            total_calls, total_inbound_calls, total_outbound_calls,
            total_duration_seconds, total_inbound_duration_seconds, total_outbound_duration_seconds,
            total_cost_spent, estimated_monthly_cost, last_used_at, last_sync_at
          FROM app_call_center__phone_numbers
          WHERE id = ?`)
                .get(id);
            if (!number) {
                return reply.status(404).send({ error: 'Phone number not found' });
            }
            // Get daily usage breakdown (last 30 days)
            const dailyUsage = db
                .prepare(`SELECT * FROM app_call_center__phone_number_usage
           WHERE phone_number_id = ?
           ORDER BY date DESC
           LIMIT 30`)
                .all(id);
            return {
                success: true,
                usage: {
                    phone_number: number.phone_number,
                    totals: {
                        calls: number.total_calls || 0,
                        inbound_calls: number.total_inbound_calls || 0,
                        outbound_calls: number.total_outbound_calls || 0,
                        duration_minutes: Math.round((number.total_duration_seconds || 0) / 60),
                        cost_spent: number.total_cost_spent || 0,
                        estimated_monthly_cost: number.estimated_monthly_cost || 0,
                    },
                    last_used: number.last_used_at,
                    last_sync: number.last_sync_at,
                    daily: dailyUsage,
                },
            };
        }
        catch (error) {
            fastify.log.error('[Numbers] Usage fetch error:', error);
            return reply.status(500).send({ error: 'Failed to fetch usage', message: error.message });
        }
    });
    /**
     * POST /webhooks/call-status
     * Twilio webhook when call status changes (completed)
     * Updates call_sessions with duration and final status
     */
    fastify.post('/webhooks/call-status', async (request, reply) => {
        if (!(await verifyTwilioWebhook(request, reply)))
            return reply;
        try {
            const { CallSid, CallStatus, CallDuration, From, To } = request.body;
            fastify.log.info(`[Webhooks] Call status: ${CallSid} → ${CallStatus}, Duration: ${CallDuration}s`);
            // Update call_sessions
            const updated = db
                .prepare(`UPDATE app_call_center__call_sessions
           SET status = ?,
               ended_at = datetime('now'),
               duration_seconds = ?
           WHERE call_sid = ?`)
                .run(CallStatus, parseInt(CallDuration || 0), CallSid);
            if (updated.changes > 0) {
                // Update phone_numbers total_duration_seconds
                const session = db.prepare('SELECT from_number FROM app_call_center__call_sessions WHERE call_sid = ?').get(CallSid);
                if (session) {
                    const phoneNumber = db.prepare('SELECT id FROM app_call_center__phone_numbers WHERE phone_number = ?').get(session.from_number);
                    if (phoneNumber) {
                        db.prepare(`UPDATE app_call_center__phone_numbers
               SET total_duration_seconds = COALESCE(total_duration_seconds, 0) + ?
               WHERE id = ?`).run(parseInt(CallDuration || 0), phoneNumber.id);
                    }
                }
            }
            return reply.send('<Response></Response>'); // Twilio expects TwiML response
        }
        catch (error) {
            fastify.log.error('[Webhooks] Call status error:', error);
            return reply.send('<Response></Response>');
        }
    });
    /**
     * POST /webhooks/recording-status
     * Twilio webhook when recording is ready
     * Downloads recording and triggers transcription
     */
    fastify.post('/webhooks/recording-status', async (request, reply) => {
        if (!(await verifyTwilioWebhook(request, reply)))
            return reply;
        try {
            const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = request.body;
            fastify.log.info(`[Webhooks] Recording ready: ${RecordingSid} for call ${CallSid}`);
            // Update call_sessions with recording URL
            db.prepare(`UPDATE app_call_center__call_sessions
         SET recording_url = ?
         WHERE call_sid = ?`).run(RecordingUrl, CallSid);
            // TODO: Download recording to local storage
            // TODO: Trigger transcription via Whisper
            return reply.send('<Response></Response>');
        }
        catch (error) {
            fastify.log.error('[Webhooks] Recording status error:', error);
            return reply.send('<Response></Response>');
        }
    });
    /**
     * POST /numbers/:id/sync-usage - Sync usage from provider API
     */
    fastify.post('/numbers/:id/sync-usage', async (request, reply) => {
        const { id } = request.params;
        try {
            const db = getDatabase();
            // Get phone number details
            const number = db
                .prepare('SELECT phone_number, provider_type, provider_sid FROM app_call_center__phone_numbers WHERE id = ?')
                .get(id);
            if (!number) {
                return reply.status(404).send({ error: 'Phone number not found' });
            }
            // Twilio only for now
            if (number.provider_type === 'twilio') {
                const accountSid = await credManager.getValueByName('telephony.twilio.account_sid');
                const authToken = await credManager.getValueByName('telephony.twilio.auth_token');
                if (!accountSid || !authToken) {
                    return reply.status(400).send({ error: 'Twilio credentials not configured' });
                }
                try {
                    const twilio = (await import('twilio')).default;
                    const client = twilio(accountSid, authToken);
                    // Fetch last 30 days of calls for this number
                    const thirtyDaysAgo = new Date();
                    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                    const calls = await client.calls.list({
                        from: number.phone_number,
                        startTimeAfter: thirtyDaysAgo,
                        limit: 1000,
                    });
                    const outboundCalls = await client.calls.list({
                        to: number.phone_number,
                        startTimeAfter: thirtyDaysAgo,
                        limit: 1000,
                    });
                    // Calculate totals and save calls to database
                    let totalCalls = 0;
                    let totalInbound = 0;
                    let totalOutbound = 0;
                    let totalDuration = 0;
                    let totalCost = 0;
                    let syncedNewCalls = 0;
                    for (const call of [...calls, ...outboundCalls]) {
                        if (call.status === 'completed') {
                            totalCalls++;
                            const direction = (call.direction === 'inbound' || call.to === number.phone_number) ? 'inbound' : 'outbound';
                            if (direction === 'inbound') {
                                totalInbound++;
                            }
                            else {
                                totalOutbound++;
                            }
                            totalDuration += parseInt(call.duration || 0);
                            const durationMinutes = parseInt(call.duration || 0) / 60;
                            totalCost += durationMinutes * 0.0085; // Twilio's rate
                            // Check if call already exists in database
                            const existingCall = db.prepare('SELECT id FROM app_call_center__call_sessions WHERE call_sid = ?').get(call.sid);
                            if (!existingCall) {
                                // Insert new call into call_sessions
                                try {
                                    db.prepare(`INSERT INTO app_call_center__call_sessions (
                      call_sid, direction, from_number, to_number,
                      provider, status, started_at, ended_at, duration_seconds
                    ) VALUES (?, ?, ?, ?, 'twilio', ?, ?, ?, ?)`).run(call.sid, direction, call.from || '', call.to || '', call.status, call.dateCreated ? call.dateCreated.toISOString() : new Date().toISOString(), call.endTime ? call.endTime.toISOString() : null, parseInt(call.duration || 0));
                                    syncedNewCalls++;
                                }
                                catch (insertErr) {
                                    fastify.log.warn(`[Numbers] Failed to insert call ${call.sid}: ${insertErr.message}`);
                                }
                            }
                        }
                    }
                    fastify.log.info(`[Numbers] Synced ${syncedNewCalls} new calls into database`);
                    // Update phone number totals
                    db.prepare(`UPDATE app_call_center__phone_numbers
             SET total_calls = ?,
                 total_inbound_calls = ?,
                 total_outbound_calls = ?,
                 total_duration_seconds = ?,
                 total_cost_spent = ?,
                 estimated_monthly_cost = ?,
                 last_sync_at = datetime('now')
             WHERE id = ?`).run(totalCalls, totalInbound, totalOutbound, totalDuration, totalCost, totalCost, id);
                    fastify.log.info(`[Numbers] Synced usage for ${number.phone_number}: ${totalCalls} calls, ${totalDuration}s`);
                    return {
                        success: true,
                        message: `Synced ${syncedNewCalls} new calls successfully`,
                        usage: {
                            calls: totalCalls,
                            inbound: totalInbound,
                            outbound: totalOutbound,
                            duration_minutes: Math.round(totalDuration / 60),
                            cost_spent: totalCost.toFixed(2),
                        },
                        syncedNewCalls: syncedNewCalls,
                    };
                }
                catch (err) {
                    fastify.log.error('[Numbers] Twilio usage sync error:', err);
                    return reply.status(500).send({ error: 'Failed to sync usage from Twilio', message: err.message });
                }
            }
            return reply.status(501).send({ error: 'Usage sync not implemented for this provider' });
        }
        catch (error) {
            fastify.log.error('[Numbers] Usage sync error:', error);
            return reply.status(500).send({ error: 'Failed to sync usage', message: error.message });
        }
    });
    /**
     * POST /voice-preview - Generate voice preview sample
     * Body: { voice, language, text, tts_provider, provider_api_key }
     */
    fastify.post('/voice-preview', async (request, reply) => {
        try {
            const { voice, language, text, tts_provider = 'twilio', provider_api_key } = request.body;
            if (!voice || !language) {
                return reply.status(400).send({ error: 'Voice and language are required' });
            }
            // Default preview text if not provided
            const previewText = text ||
                (language.startsWith('ar')
                    ? 'مرحباً! هذا نموذج من الصوت المختار. شكراً لاستخدامك نظامنا.'
                    : 'Hello! This is a preview of the selected voice. Thank you for using our system.');
            // Use TTS service for non-Twilio providers
            if (tts_provider !== 'twilio') {
                try {
                    const ttsService = require('../services/tts-service');
                    const audioBuffer = await ttsService.generateSpeech({
                        text: previewText,
                        provider: tts_provider,
                        voice,
                        language,
                        apiKey: provider_api_key
                    });
                    // Return audio file directly
                    reply.header('Content-Type', 'audio/mpeg');
                    reply.header('Content-Length', audioBuffer.length);
                    return reply.send(audioBuffer);
                }
                catch (error) {
                    fastify.log.error(`[Voice Preview] ${tts_provider} TTS error:`, error);
                    return reply.status(500).send({
                        error: `Failed to generate voice preview with ${tts_provider}`,
                        message: error.message
                    });
                }
            }
            // Twilio TTS preview (original logic)
            const accountSid = await credManager.getValueByName('telephony.twilio.account_sid');
            const authToken = await credManager.getValueByName('telephony.twilio.auth_token');
            if (!accountSid || !authToken) {
                return reply.status(400).send({ error: 'Twilio credentials not configured' });
            }
            try {
                const twilio = (await import('twilio')).default;
                const client = twilio(accountSid, authToken);
                // Generate TwiML with the selected voice and language
                const twiml = `
          <Response>
            <Say voice="${voice}" language="${language}">
              ${previewText}
            </Say>
          </Response>
        `;
                // For Twilio, return TwiML (frontend will need to handle playback)
                // Note: In production, you could use Twilio's voice API to generate audio file
                return {
                    success: true,
                    voice,
                    language,
                    text: previewText,
                    twiml,
                    // For now, we'll use a data URL approach
                    previewUrl: `data:text/xml;base64,${Buffer.from(twiml).toString('base64')}`
                };
            }
            catch (err) {
                fastify.log.error('[Voice Preview] Twilio error:', err);
                return reply.status(500).send({
                    error: 'Failed to generate voice preview',
                    message: err.message
                });
            }
        }
        catch (error) {
            fastify.log.error('[Voice Preview] Error:', error);
            return reply.status(500).send({ error: 'Failed to generate preview', message: error.message });
        }
    });
}
