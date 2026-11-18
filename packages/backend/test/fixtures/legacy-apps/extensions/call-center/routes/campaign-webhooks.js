/**
 * Campaign Webhook Handlers
 * TwiML responses for outbound campaign calls
 */

import { Router } from 'express';
import { getDatabase } from '../../../../../../src/db/index.js';
import { getCampaignManager } from '../services/campaign-manager.js';

const router = Router();
const escapeXml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const callbackUrl = (route, contactId) => escapeXml((process.env.BACKEND_URL || 'http://localhost:41522').replace(/\/$/, '') + route + encodeURIComponent(String(contactId)));


/**
 * POST /api/ext/call-center/campaign-webhook/:contactId
 * Initial call webhook - plays message and gathers response
 */
router.post('/campaign-webhook/:contactId', async (req, res) => {
  try {
    const db = getDatabase();
    const { contactId } = req.params;

    const contact = await db.get(`SELECT * FROM campaign_contacts WHERE id = ?`, [contactId]);

    if (!contact) {
      return res.status(404).send('<Response><Say>Contact not found</Say><Hangup/></Response>');
    }

    const campaign = await db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [contact.campaign_id]);

    if (!campaign) {
      return res.status(404).send('<Response><Say>Campaign not found</Say><Hangup/></Response>');
    }

    // Personalize message
    let message = campaign.message_template;
    message = message.replace('{name}', contact.name || 'عزيزي العميل');

    // Replace custom data placeholders
    if (contact.custom_data) {
      try {
        const data = JSON.parse(contact.custom_data);
        Object.entries(data).forEach(([key, value]) => {
          message = message.replace(`{${key}}`, value);
        });
      } catch (e) {
        console.error('Error parsing custom_data:', e);
      }
    }

    // Generate TwiML based on response mode
    let twiml;

    if (campaign.response_mode === 'ivr') {
      // IVR mode - digit input
      const ivrOptions = campaign.ivr_options ? JSON.parse(campaign.ivr_options) : [
        { digit: '1', label: 'مهتم', action: 'interested' },
        { digit: '2', label: 'طلب معاودة الاتصال', action: 'callback' },
        { digit: '3', label: 'غير مهتم', action: 'not_interested' }
      ];

      let gatherPrompt = '';
      ivrOptions.forEach(opt => {
        gatherPrompt += `لـ${opt.label}، اضغط ${opt.digit}. `;
      });

      twiml = `
        <Response>
          <Say voice="Polly.Zeina" language="ar-SA">${escapeXml(message)}</Say>
          <Gather numDigits="1" action="${callbackUrl('/api/ext/call-center/campaign-response/', contactId)}" timeout="10">
            <Say voice="Polly.Zeina" language="ar-SA">${escapeXml(gatherPrompt)}</Say>
          </Gather>
          <Say voice="Polly.Zeina" language="ar-SA">شكراً لك.</Say>
          <Hangup/>
        </Response>
      `;
    } else {
      // AI mode - connect to agent
      twiml = `
        <Response>
          <Say voice="Polly.Zeina" language="ar-SA">${escapeXml(message)}</Say>
          <Say voice="Polly.Zeina" language="ar-SA">يرجى الانتظار، سيتم توصيلك بمستشار.</Say>
          <Redirect>${callbackUrl('/api/ext/call-center/ai-connect/', contactId)}</Redirect>
        </Response>
      `;
    }

    res.type('text/xml').send(twiml);
  } catch (error) {
    console.error('[Campaign Webhooks] Error in campaign webhook:', error);
    res.type('text/xml').send('<Response><Say>An error occurred</Say><Hangup/></Response>');
  }
});

/**
 * POST /api/ext/call-center/campaign-response/:contactId
 * Handle DTMF response from contact
 */
router.post('/campaign-response/:contactId', async (req, res) => {
  try {
    const db = getDatabase();
    const campaignManager = getCampaignManager();
    const { contactId } = req.params;
    const { Digits } = req.body;

    const contact = await db.get(`SELECT * FROM campaign_contacts WHERE id = ?`, [contactId]);
    const campaign = await db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [contact.campaign_id]);

    // Parse IVR options
    const ivrOptions = campaign.ivr_options ? JSON.parse(campaign.ivr_options) : [
      { digit: '1', label: 'مهتم', action: 'interested' },
      { digit: '2', label: 'طلب معاودة الاتصال', action: 'callback' },
      { digit: '3', label: 'غير مهتم', action: 'not_interested' }
    ];

    const selected = ivrOptions.find(opt => opt.digit === Digits);

    let result = 'no_response';
    let message = 'شكراً لك.';

    if (selected) {
      result = selected.action;

      switch (selected.action) {
        case 'interested':
          message = 'شكراً! سيتواصل معك فريقنا قريباً.';
          break;
        case 'callback':
          result = 'requested_callback';
          message = 'تم تسجيل طلبك. سنتصل بك لاحقاً.';
          break;
        case 'not_interested':
          message = 'شكراً لوقتك.';
          break;
        default:
          message = selected.label || 'تم تسجيل اختيارك.';
      }
    }

    // Update contact result
    await campaignManager.updateContactResult(contactId, {
      status: 'completed',
      call_result: result
    });

    const twiml = `
      <Response>
        <Say voice="Polly.Zeina" language="ar-SA">${escapeXml(message)}</Say>
        <Hangup/>
      </Response>
    `;

    res.type('text/xml').send(twiml);
  } catch (error) {
    console.error('[Campaign Webhooks] Error in campaign response:', error);
    res.type('text/xml').send('<Response><Say>An error occurred</Say><Hangup/></Response>');
  }
});

/**
 * POST /api/ext/call-center/campaign-status/:contactId
 * Twilio status callback
 */
router.post('/campaign-status/:contactId', async (req, res) => {
  try {
    const campaignManager = getCampaignManager();
    const { contactId } = req.params;
    const { CallStatus, CallDuration } = req.body;

    let status, call_result;

    switch (CallStatus) {
      case 'completed':
        status = 'completed';
        break;
      case 'busy':
        status = 'busy';
        call_result = null;
        break;
      case 'no-answer':
      case 'failed':
        status = 'no_answer';
        call_result = null;
        break;
      default:
        status = 'failed';
    }

    await campaignManager.updateContactResult(contactId, {
      status,
      call_result,
      call_duration_seconds: CallDuration ? parseInt(CallDuration) : null
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('[Campaign Webhooks] Error in campaign status:', error);
    res.sendStatus(500);
  }
});

export default router;
