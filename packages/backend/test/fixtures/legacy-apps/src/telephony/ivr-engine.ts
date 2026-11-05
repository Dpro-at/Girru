import type { FastifyRequest, FastifyReply } from 'fastify';
import { one, run, sql } from '../../../../../src/repositories/sql-steps.js';
import { nowText } from '../../../../../src/db/pg/dialect.js';
import { randomBytes } from 'crypto';

/**
 * IVR (Interactive Voice Response) Engine
 * Processes DTMF input and routes calls based on menu structure
 */

export interface IvrMenu {
  message: string;
  options: Record<string, IvrOption>;
  timeout?: number;
  retries?: number;
}

export interface IvrOption {
  action: 'workflow' | 'transfer' | 'agent' | 'submenu' | 'hangup';
  workflowId?: string;
  number?: string;
  agentId?: string;
  submenu?: IvrMenu;
  message?: string;
}

/**
 * Process IVR menu selection
 */
export async function processIvrSelection(request: FastifyRequest, reply: FastifyReply) {
  const { Digits, CallSid } = request.body as any;
  const { sessionId } = request.query as any;

  try {
    const db = sql();

    // Get session and call point
    const session = await db.read(one<any>(`
      SELECT cs.*, cp.ivr_menu, cp.voice_id, cp.transfer_number
      FROM call_sessions cs
      JOIN call_points cp ON cp.id = cs.call_point_id
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

    const ivrMenu: IvrMenu = JSON.parse(session.ivr_menu);
    const voice = getTwilioVoice(session.voice_id);

    // Log IVR selection
    const messageId = randomBytes(16).toString('hex');
    await db.read(run(`
      INSERT INTO call_messages (id, call_session_id, role, content, timestamp)
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
            UPDATE call_sessions SET agent_id = ? WHERE id = ?
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
  } catch (error: any) {
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
function getTwilioVoice(voiceId: string): string {
  const voiceMap: Record<string, string> = {
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
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
