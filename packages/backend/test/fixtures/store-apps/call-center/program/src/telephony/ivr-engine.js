import { one, run, sql } from '../repositories/sql-steps.js';
import { nowText } from '../db/pg/dialect.js';
import { randomBytes } from 'crypto';
/**
 * Process IVR menu selection
 */
export async function processIvrSelection(request, reply) {
    const { Digits, CallSid } = request.body;
    const { sessionId } = request.query;
    try {
        const db = sql();
        // Get session and call point
        const session = await db.read(one(`
      SELECT cs.*, cp.ivr_menu, cp.voice_id, cp.transfer_number
      FROM app_call_center__call_sessions cs
      JOIN app_call_center__call_points cp ON cp.id = cs.call_point_id
      WHERE cs.id = ?
    `, sessionId));
        if (!session || !session.ivr_menu) {
            return reply.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="Polly.Joanna">Invalid menu configuration.</Say>
          <Hangup/>
        </Response>
      `);
        }
        const ivrMenu = JSON.parse(session.ivr_menu);
        const voice = getTwilioVoice(session.voice_id);
        // Log IVR selection
        const messageId = randomBytes(16).toString('hex');
        await db.read(run(`
      INSERT INTO app_call_center__call_messages (id, call_session_id, role, content, timestamp)
      VALUES (?, ?, 'system', ?, ${nowText(db.dialect)})
    `, messageId, sessionId, `IVR: Selected option ${Digits}`));
        // Get selected option
        const option = ivrMenu.options[Digits];
        if (!option) {
            // Invalid selection
            return reply.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="${voice}">Invalid selection. Please try again.</Say>
          <Redirect>/api/telephony/voice-webhook</Redirect>
        </Response>
      `);
        }
        // Handle action
        switch (option.action) {
            case 'transfer':
                const transferNumber = option.number || session.transfer_number;
                if (!transferNumber) {
                    return reply.type('text/xml').send(`
            <?xml version="1.0" encoding="UTF-8"?>
            <Response>
              <Say voice="${voice}">Transfer number not configured.</Say>
              <Hangup/>
            </Response>
          `);
                }
                return reply.type('text/xml').send(`
          <?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say voice="${voice}">${escapeXml(option.message || 'Transferring your call now.')}</Say>
            <Dial>${transferNumber}</Dial>
          </Response>
        `);
            case 'agent':
                // Update session agent_id and redirect to speech processing
                if (option.agentId) {
                    await db.read(run(`
            UPDATE app_call_center__call_sessions SET agent_id = ? WHERE id = ?
          `, option.agentId, sessionId));
                }
                return reply.type('text/xml').send(`
          <?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say voice="${voice}">${escapeXml(option.message || 'Connecting you to an agent.')}</Say>
            <Gather
              input="speech"
              action="/api/telephony/process-speech?sessionId=${sessionId}"
              method="POST"
              speechTimeout="auto">
            </Gather>
          </Response>
        `);
            case 'workflow':
                // TODO: Trigger workflow execution
                return reply.type('text/xml').send(`
          <?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say voice="${voice}">Workflow execution not yet implemented.</Say>
            <Hangup/>
          </Response>
        `);
            case 'submenu':
                // TODO: Handle nested menus
                return reply.type('text/xml').send(`
          <?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say voice="${voice}">Submenus not yet implemented.</Say>
            <Hangup/>
          </Response>
        `);
            case 'hangup':
                return reply.type('text/xml').send(`
          <?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say voice="${voice}">${escapeXml(option.message || 'Thank you for calling. Goodbye.')}</Say>
            <Hangup/>
          </Response>
        `);
            default:
                return reply.type('text/xml').send(`
          <?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say voice="${voice}">Unknown action.</Say>
            <Hangup/>
          </Response>
        `);
        }
    }
    catch (error) {
        request.log.error('IVR processing error:', error);
        return reply.type('text/xml').send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="Polly.Joanna">An error occurred processing your selection.</Say>
        <Hangup/>
      </Response>
    `);
    }
}
/**
 * Map OpenAI voice ID to Twilio Polly voice
 */
function getTwilioVoice(voiceId) {
    const voiceMap = {
        alloy: 'Polly.Joanna',
        echo: 'Polly.Matthew',
        fable: 'Polly.Kimberly',
        onyx: 'Polly.Russell',
        nova: 'Polly.Salli',
        shimmer: 'Polly.Amy',
    };
    return voiceMap[voiceId] || 'Polly.Joanna';
}
/**
 * Escape XML special characters
 */
function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
