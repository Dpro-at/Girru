/**
 * Call Point Templates API Routes
 * CRUD operations for industry-specific templates
 */

import { Router } from 'express';
import { getDatabase } from '../../../../../../src/db/index.js';

const router = Router();

/**
 * GET /api/ext/call-center/templates
 * List all templates
 */
router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    const { category } = req.query;

    let query = `SELECT * FROM call_point_templates WHERE 1=1`;
    const params = [];

    if (category) {
      query += ` AND category = ?`;
      params.push(category);
    }

    query += ` ORDER BY is_system DESC, name ASC`;

    const templates = await db.all(query, params);

    // Parse JSON fields
    const parsedTemplates = templates.map(template => ({
      ...template,
      is_system: template.is_system === 1,
      default_ivr_menu: template.default_ivr_menu ? JSON.parse(template.default_ivr_menu) : null,
      default_business_hours: template.default_business_hours ? JSON.parse(template.default_business_hours) : null,
      default_knowledge_base: template.default_knowledge_base ? JSON.parse(template.default_knowledge_base) : null
    }));

    res.json({ templates: parsedTemplates });
  } catch (error) {
    console.error('[Templates API] Error listing templates:', error);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

/**
 * GET /api/ext/call-center/templates/:id
 * Get single template by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;

    const template = await db.get(
      `SELECT * FROM call_point_templates WHERE id = ?`,
      [id]
    );

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Parse JSON fields
    const parsed = {
      ...template,
      is_system: template.is_system === 1,
      default_ivr_menu: template.default_ivr_menu ? JSON.parse(template.default_ivr_menu) : null,
      default_business_hours: template.default_business_hours ? JSON.parse(template.default_business_hours) : null,
      default_knowledge_base: template.default_knowledge_base ? JSON.parse(template.default_knowledge_base) : null
    };

    res.json({ template: parsed });
  } catch (error) {
    console.error('[Templates API] Error getting template:', error);
    res.status(500).json({ error: 'Failed to get template' });
  }
});

/**
 * POST /api/ext/call-center/templates
 * Create new template (user-defined)
 */
router.post('/', async (req, res) => {
  try {
    const db = getDatabase();
    const {
      name,
      category,
      description,
      defaultSystemPrompt,
      defaultIvrMenu,
      defaultBusinessHours,
      defaultKnowledgeBase,
      defaultVoiceProvider = 'edge-tts',
      defaultVoiceId = 'en-US-JennyNeural',
      defaultLanguage = 'en',
      icon = 'Phone'
    } = req.body;

    // Validate required fields
    if (!name || !category) {
      return res.status(400).json({ error: 'Name and category are required' });
    }

    // Generate ID
    const id = `template_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Insert template
    await db.run(
      `INSERT INTO call_point_templates (
        id, name, category, description,
        default_system_prompt, default_ivr_menu, default_business_hours, default_knowledge_base,
        default_voice_provider, default_voice_id, default_language,
        icon, is_system, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
      [
        id,
        name,
        category,
        description || null,
        defaultSystemPrompt || null,
        defaultIvrMenu ? JSON.stringify(defaultIvrMenu) : null,
        defaultBusinessHours ? JSON.stringify(defaultBusinessHours) : null,
        defaultKnowledgeBase ? JSON.stringify(defaultKnowledgeBase) : null,
        defaultVoiceProvider,
        defaultVoiceId,
        defaultLanguage,
        icon
      ]
    );

    // Return created template
    const created = await db.get(
      `SELECT * FROM call_point_templates WHERE id = ?`,
      [id]
    );

    res.status(201).json({
      template: {
        ...created,
        is_system: created.is_system === 1,
        default_ivr_menu: created.default_ivr_menu ? JSON.parse(created.default_ivr_menu) : null,
        default_business_hours: created.default_business_hours ? JSON.parse(created.default_business_hours) : null,
        default_knowledge_base: created.default_knowledge_base ? JSON.parse(created.default_knowledge_base) : null
      }
    });
  } catch (error) {
    console.error('[Templates API] Error creating template:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

/**
 * PUT /api/ext/call-center/templates/:id
 * Update template (user-defined only)
 */
router.put('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;

    // Check if template exists and is not system
    const existing = await db.get(
      `SELECT * FROM call_point_templates WHERE id = ?`,
      [id]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (existing.is_system === 1) {
      return res.status(403).json({ error: 'Cannot modify system templates' });
    }

    const {
      name,
      category,
      description,
      defaultSystemPrompt,
      defaultIvrMenu,
      defaultBusinessHours,
      defaultKnowledgeBase,
      defaultVoiceProvider,
      defaultVoiceId,
      defaultLanguage,
      icon
    } = req.body;

    // Update template
    await db.run(
      `UPDATE call_point_templates SET
        name = COALESCE(?, name),
        category = COALESCE(?, category),
        description = COALESCE(?, description),
        default_system_prompt = COALESCE(?, default_system_prompt),
        default_ivr_menu = COALESCE(?, default_ivr_menu),
        default_business_hours = COALESCE(?, default_business_hours),
        default_knowledge_base = COALESCE(?, default_knowledge_base),
        default_voice_provider = COALESCE(?, default_voice_provider),
        default_voice_id = COALESCE(?, default_voice_id),
        default_language = COALESCE(?, default_language),
        icon = COALESCE(?, icon)
      WHERE id = ?`,
      [
        name || null,
        category || null,
        description || null,
        defaultSystemPrompt || null,
        defaultIvrMenu ? JSON.stringify(defaultIvrMenu) : null,
        defaultBusinessHours ? JSON.stringify(defaultBusinessHours) : null,
        defaultKnowledgeBase ? JSON.stringify(defaultKnowledgeBase) : null,
        defaultVoiceProvider || null,
        defaultVoiceId || null,
        defaultLanguage || null,
        icon || null,
        id
      ]
    );

    // Return updated template
    const updated = await db.get(
      `SELECT * FROM call_point_templates WHERE id = ?`,
      [id]
    );

    res.json({
      template: {
        ...updated,
        is_system: updated.is_system === 1,
        default_ivr_menu: updated.default_ivr_menu ? JSON.parse(updated.default_ivr_menu) : null,
        default_business_hours: updated.default_business_hours ? JSON.parse(updated.default_business_hours) : null,
        default_knowledge_base: updated.default_knowledge_base ? JSON.parse(updated.default_knowledge_base) : null
      }
    });
  } catch (error) {
    console.error('[Templates API] Error updating template:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

/**
 * DELETE /api/ext/call-center/templates/:id
 * Delete template (user-defined only)
 */
router.delete('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;

    // Check if template exists and is not system
    const existing = await db.get(
      `SELECT * FROM call_point_templates WHERE id = ?`,
      [id]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (existing.is_system === 1) {
      return res.status(403).json({ error: 'Cannot delete system templates' });
    }

    // Check if template is in use
    const inUse = await db.get(
      `SELECT COUNT(*) as count FROM call_points WHERE template_id = ?`,
      [id]
    );

    if (inUse.count > 0) {
      return res.status(400).json({
        error: 'Template is in use by call points',
        callPointCount: inUse.count
      });
    }

    // Delete template
    await db.run(`DELETE FROM call_point_templates WHERE id = ?`, [id]);

    res.json({ success: true, message: 'Template deleted' });
  } catch (error) {
    console.error('[Templates API] Error deleting template:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

/**
 * GET /api/ext/call-center/templates/categories/list
 * List available template categories
 */
router.get('/categories/list', async (req, res) => {
  try {
    const categories = [
      { value: 'support', label: 'Technical Support', icon: 'Headphones' },
      { value: 'sales', label: 'Sales & Leads', icon: 'TrendingUp' },
      { value: 'restaurant', label: 'Restaurant', icon: 'UtensilsCrossed' },
      { value: 'medical', label: 'Medical', icon: 'Stethoscope' },
      { value: 'ecommerce', label: 'E-commerce', icon: 'ShoppingCart' },
      { value: 'generic', label: 'Generic Business', icon: 'Phone' }
    ];

    res.json({ categories });
  } catch (error) {
    console.error('[Templates API] Error listing categories:', error);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

export default router;
