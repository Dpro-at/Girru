/**
 * Call Point Knowledge Base API Routes
 * CRUD operations for FAQ, scripts, policies per call point
 */

import { Router } from 'express';
import { getDatabase } from '../../../../../../src/db/index.js';

const router = Router();

/**
 * GET /api/ext/call-center/knowledge
 * List knowledge entries (with optional call point filter)
 */
router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    const { call_point_id, category, is_active, search } = req.query;

    let query = `SELECT * FROM call_point_knowledge WHERE 1=1`;
    const params = [];

    if (call_point_id) {
      query += ` AND call_point_id = ?`;
      params.push(call_point_id);
    }

    if (category) {
      query += ` AND category = ?`;
      params.push(category);
    }

    if (is_active !== undefined) {
      query += ` AND is_active = ?`;
      params.push(is_active === 'true' ? 1 : 0);
    }

    if (search) {
      query += ` AND (question LIKE ? OR answer LIKE ? OR keywords LIKE ?)`;
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    query += ` ORDER BY priority DESC, created_at DESC`;

    const entries = await db.all(query, params);

    res.json({
      entries: entries.map(e => ({
        ...e,
        is_active: e.is_active === 1
      }))
    });
  } catch (error) {
    console.error('[Knowledge API] Error listing entries:', error);
    res.status(500).json({ error: 'Failed to list knowledge entries' });
  }
});

/**
 * GET /api/ext/call-center/knowledge/:id
 * Get single knowledge entry
 */
router.get('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;

    const entry = await db.get(
      `SELECT * FROM call_point_knowledge WHERE id = ?`,
      [id]
    );

    if (!entry) {
      return res.status(404).json({ error: 'Knowledge entry not found' });
    }

    res.json({
      entry: {
        ...entry,
        is_active: entry.is_active === 1
      }
    });
  } catch (error) {
    console.error('[Knowledge API] Error getting entry:', error);
    res.status(500).json({ error: 'Failed to get knowledge entry' });
  }
});

/**
 * POST /api/ext/call-center/knowledge
 * Create new knowledge entry
 */
router.post('/', async (req, res) => {
  try {
    const db = getDatabase();
    const {
      call_point_id,
      category,
      question,
      answer,
      keywords,
      priority = 0,
      is_active = true
    } = req.body;

    // Validate required fields
    if (!call_point_id || !category || !answer) {
      return res.status(400).json({
        error: 'call_point_id, category, and answer are required'
      });
    }

    // Validate category
    const validCategories = ['faq', 'product', 'policy', 'script'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        error: `Invalid category. Must be one of: ${validCategories.join(', ')}`
      });
    }

    // Verify call point exists
    const callPoint = await db.get(
      `SELECT id FROM call_points WHERE id = ?`,
      [call_point_id]
    );

    if (!callPoint) {
      return res.status(404).json({ error: 'Call point not found' });
    }

    // Generate ID
    const id = `knowledge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Insert entry
    await db.run(
      `INSERT INTO call_point_knowledge (
        id, call_point_id, category, question, answer,
        keywords, priority, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        id,
        call_point_id,
        category,
        question || null,
        answer,
        keywords || null,
        priority,
        is_active ? 1 : 0
      ]
    );

    // Return created entry
    const created = await db.get(
      `SELECT * FROM call_point_knowledge WHERE id = ?`,
      [id]
    );

    res.status(201).json({
      entry: {
        ...created,
        is_active: created.is_active === 1
      }
    });
  } catch (error) {
    console.error('[Knowledge API] Error creating entry:', error);
    res.status(500).json({ error: 'Failed to create knowledge entry' });
  }
});

/**
 * PUT /api/ext/call-center/knowledge/:id
 * Update knowledge entry
 */
router.put('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;

    // Check if entry exists
    const existing = await db.get(
      `SELECT * FROM call_point_knowledge WHERE id = ?`,
      [id]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Knowledge entry not found' });
    }

    const {
      category,
      question,
      answer,
      keywords,
      priority,
      is_active
    } = req.body;

    // Validate category if provided
    if (category) {
      const validCategories = ['faq', 'product', 'policy', 'script'];
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          error: `Invalid category. Must be one of: ${validCategories.join(', ')}`
        });
      }
    }

    // Update entry
    await db.run(
      `UPDATE call_point_knowledge SET
        category = COALESCE(?, category),
        question = COALESCE(?, question),
        answer = COALESCE(?, answer),
        keywords = COALESCE(?, keywords),
        priority = COALESCE(?, priority),
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        category || null,
        question || null,
        answer || null,
        keywords || null,
        priority !== undefined ? priority : null,
        is_active !== undefined ? (is_active ? 1 : 0) : null,
        id
      ]
    );

    // Return updated entry
    const updated = await db.get(
      `SELECT * FROM call_point_knowledge WHERE id = ?`,
      [id]
    );

    res.json({
      entry: {
        ...updated,
        is_active: updated.is_active === 1
      }
    });
  } catch (error) {
    console.error('[Knowledge API] Error updating entry:', error);
    res.status(500).json({ error: 'Failed to update knowledge entry' });
  }
});

/**
 * DELETE /api/ext/call-center/knowledge/:id
 * Delete knowledge entry
 */
router.delete('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;

    // Check if entry exists
    const existing = await db.get(
      `SELECT * FROM call_point_knowledge WHERE id = ?`,
      [id]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Knowledge entry not found' });
    }

    // Delete entry
    await db.run(`DELETE FROM call_point_knowledge WHERE id = ?`, [id]);

    res.json({ success: true, message: 'Knowledge entry deleted' });
  } catch (error) {
    console.error('[Knowledge API] Error deleting entry:', error);
    res.status(500).json({ error: 'Failed to delete knowledge entry' });
  }
});

/**
 * POST /api/ext/call-center/knowledge/search
 * Search knowledge base by keywords or text
 */
router.post('/search', async (req, res) => {
  try {
    const db = getDatabase();
    const { call_point_id, query, category, limit = 10 } = req.body;

    if (!call_point_id || !query) {
      return res.status(400).json({ error: 'call_point_id and query are required' });
    }

    // Build search query
    let sql = `
      SELECT *,
        (CASE
          WHEN question LIKE ? THEN 10
          WHEN answer LIKE ? THEN 5
          WHEN keywords LIKE ? THEN 3
          ELSE 0
        END) as relevance_score
      FROM call_point_knowledge
      WHERE call_point_id = ?
        AND is_active = 1
    `;

    const params = [
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      call_point_id
    ];

    if (category) {
      sql += ` AND category = ?`;
      params.push(category);
    }

    sql += ` ORDER BY relevance_score DESC, priority DESC LIMIT ?`;
    params.push(limit);

    const results = await db.all(sql, params);

    res.json({
      results: results.map(r => ({
        ...r,
        is_active: r.is_active === 1
      }))
    });
  } catch (error) {
    console.error('[Knowledge API] Error searching knowledge base:', error);
    res.status(500).json({ error: 'Failed to search knowledge base' });
  }
});

/**
 * POST /api/ext/call-center/knowledge/bulk
 * Bulk import knowledge entries
 */
router.post('/bulk', async (req, res) => {
  try {
    const db = getDatabase();
    const { call_point_id, entries } = req.body;

    if (!call_point_id || !entries || !Array.isArray(entries)) {
      return res.status(400).json({ error: 'call_point_id and entries array are required' });
    }

    // Verify call point exists
    const callPoint = await db.get(
      `SELECT id FROM call_points WHERE id = ?`,
      [call_point_id]
    );

    if (!callPoint) {
      return res.status(404).json({ error: 'Call point not found' });
    }

    const created = [];
    const errors = [];

    // Insert each entry
    for (const entry of entries) {
      try {
        const id = `knowledge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        await db.run(
          `INSERT INTO call_point_knowledge (
            id, call_point_id, category, question, answer,
            keywords, priority, is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            id,
            call_point_id,
            entry.category || 'faq',
            entry.question || null,
            entry.answer,
            entry.keywords || null,
            entry.priority || 0,
            entry.is_active !== false ? 1 : 0
          ]
        );

        created.push(id);
      } catch (error) {
        errors.push({
          entry,
          error: error.message
        });
      }
    }

    res.status(201).json({
      success: true,
      created: created.length,
      errors: errors.length,
      createdIds: created,
      errorDetails: errors
    });
  } catch (error) {
    console.error('[Knowledge API] Error bulk importing:', error);
    res.status(500).json({ error: 'Failed to bulk import knowledge entries' });
  }
});

export default router;
