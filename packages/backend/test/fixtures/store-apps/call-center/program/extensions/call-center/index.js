/**
 * Call Center Extension
 * AI-powered telephony with Twilio/Google Voice integration
 * Entry point - pure JavaScript only
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export default {
    id: 'call-center',
    name: 'Call Center',
    version: '1.0.0',
    async register(api) {
        api.log('info', '[Call Center] 📞 Initializing extension...');
        // 1. Run database migrations
        // The Store installer creates the namespaced schema before activation.
        // 2. Register telephony routes
        const { registerCallCenterRoutes } = await import('./src/routes.js');
        api.registerRoutes(registerCallCenterRoutes);
        // 3. Register provider management routes (Fastify)
        const { registerProviderRoutes } = await import('./routes/providers.js');
        api.registerRoutes(registerProviderRoutes);
        // 3.1 Register phone numbers management routes (Fastify)
        const { registerNumberRoutes } = await import('./routes/numbers.js');
        api.registerRoutes(registerNumberRoutes);
        // 4. Register professional call center routes (Express - TEMPORARILY DISABLED)
        // TODO: Convert these routes from Express to Fastify format like providers.js
        // const templatesRouter = (await import('./routes/templates.js')).default;
        // const knowledgeRouter = (await import('./routes/knowledge.js')).default;
        // const queueRouter = (await import('./routes/queue.js')).default;
        // const analyticsRouter = (await import('./routes/analytics.js')).default;
        // const campaignsRouter = (await import('./routes/campaigns.js')).default;
        // const campaignWebhooksRouter = (await import('./routes/campaign-webhooks.js')).default;
        // api.registerRoutes((app) => {
        //   app.use('/api/ext/call-center/templates', templatesRouter);
        //   app.use('/api/ext/call-center/knowledge', knowledgeRouter);
        //   app.use('/api/ext/call-center/queue', queueRouter);
        //   app.use('/api/ext/call-center/analytics', analyticsRouter);
        //   app.use('/api/ext/call-center/campaigns', campaignsRouter);
        //   app.use('/api/ext/call-center', campaignWebhooksRouter);
        // });
        // 4. Register AI agent tools
        const { makeCallTool, hangupCallTool } = await import('./src/tools.js');
        api.registerTool(makeCallTool);
        api.registerTool(hangupCallTool);
        // 5. Initialize telephony services
        const { initializeTelephonyService } = await import('./src/service.js');
        await initializeTelephonyService();
        // 6. Initialize call queue manager and restore queues
        const { getCallQueueManager } = await import('./services/call-queue-manager.js');
        const queueManager = getCallQueueManager();
        await queueManager.restoreQueues();
        // 7. Seed system templates if needed
        await this.seedSystemTemplates(api);
        api.log('info', '[Call Center] ✅ Extension ready - Professional call center online');
    },
    async seedSystemTemplates(api) {
        try {
            const { getDatabase } = await import('../../src/db/index.js');
            const db = getDatabase();
            // Check if templates already seeded
            const existing = db.prepare(`SELECT COUNT(*) as count FROM app_call_center__call_point_templates WHERE is_system = 1`).get();
            if (existing && existing.count > 0) {
                api.log('info', `[Call Center] System templates already seeded (${existing.count} templates)`);
                return;
            }
            // Load all template files
            const templates = [
                (await import('./templates/tech-support.js')).default,
                (await import('./templates/restaurant.js')).default,
                (await import('./templates/sales.js')).default,
                (await import('./templates/medical.js')).default,
                (await import('./templates/ecommerce.js')).default,
                (await import('./templates/generic.js')).default,
            ];
            // Insert each template
            for (const template of templates) {
                const id = `template_${template.category}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                db.prepare(`INSERT INTO app_call_center__call_point_templates (
            id, name, category, description,
            default_system_prompt, default_ivr_menu, default_business_hours, default_knowledge_base,
            default_voice_provider, default_voice_id, default_language,
            icon, is_system, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`).run(id, template.name, template.category, template.description, template.defaultSystemPrompt, JSON.stringify(template.defaultIvrMenu), JSON.stringify(template.defaultBusinessHours), JSON.stringify(template.defaultKnowledgeBase), template.voiceSettings.provider, template.voiceSettings.voiceId, template.voiceSettings.language, template.icon);
            }
            api.log('info', `[Call Center] ✅ Seeded ${templates.length} system templates`);
        }
        catch (error) {
            api.log('error', `[Call Center] Error seeding templates: ${error.message}`);
        }
    },
    async onDisable(api) {
        // Cleanup when extension is disabled
        api.unregisterTool('make_call');
        api.unregisterTool('hangup_call');
        api.log('info', '[Call Center] ❌ Extension disabled');
    },
    // Extension metadata for UI
    getMetadata() {
        return {
            displayName: 'Call Center',
            description: 'Professional AI call center with multi-provider support',
            icon: 'phone',
            color: '#10b981', // green-600
            category: 'channel',
            providers: ['Twilio', 'Microsoft Teams Phone', 'Vonage'],
            features: [
                'Multi-provider support (Twilio, Teams, Vonage)',
                'Phone number search & purchase',
                'Inbound/outbound call handling',
                'IVR menu builder',
                'Call recording & transcription',
                'Call analytics & sentiment analysis',
                'Queue management with VIP priority',
                'Industry templates (support, sales, restaurant, etc.)',
                'Knowledge base per call point',
                'AI agent integration',
                'Multi-language support',
            ],
            dashboardUrl: '/dashboard/call-center',
            settingsRequired: true,
            credentialsRequired: ['Provider API credentials'],
        };
    },
};
