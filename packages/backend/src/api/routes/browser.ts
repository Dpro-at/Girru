import {loadBrowserRuntime,browserRuntimeReady} from '../../services/browser-runtime.js';
/**
 * Browser Automation API Routes
 * REST endpoints for web automation
 */

import type { FastifyInstance } from 'fastify';
import { handleError } from '../error-handler.js';
import {
  getBrowserController,
  type BrowserConfig,
  type NavigationOptions,
  type ClickOptions,
  type TypeOptions,
  type SelectOptions,
  type WaitOptions,
  type ScreenshotOptions,
  type PdfOptions,
} from '../../browser/index.js';
import {
  fillForm,
  extractTable,
  extractLinks,
  extractImages,
  extractText,
  extractAttribute,
  elementExists,
  countElements,
  getPageMetadata,
  extractStructuredData,
} from '../../browser/page-utils.js';

export async function browserRoutes(fastify: FastifyInstance): Promise<void> {
  await loadBrowserRuntime();
  fastify.addHook('onRequest',async(request,reply)=>{if(!request.url.startsWith('/api/browser/'))return;if(!browserRuntimeReady())return reply.code(503).send({code:'app_not_enabled'});});
  const prefix = '/api/browser';

  // ============ Sessions ============

  /**
   * GET /api/browser/sessions - List all sessions
   */
  fastify.get(`${prefix}/sessions`, async (_request, reply) => {
    const controller = getBrowserController();
    const sessions = controller.listSessions();
    return reply.send({ sessions });
  });

  /**
   * POST /api/browser/sessions - Create a new session
   */
  fastify.post(`${prefix}/sessions`, async (request, reply) => {
    const config = request.body as Partial<BrowserConfig>;

    try {
      const controller = getBrowserController();
      const session = await controller.createSession(config);
      return reply.status(201).send({ success: true, session });
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Browser] Create session failed');
    }
  });

  /**
   * GET /api/browser/sessions/:id - Get session info
   */
  fastify.get(`${prefix}/sessions/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const controller = getBrowserController();
    const session = controller.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return reply.send({ session });
  });

  /**
   * DELETE /api/browser/sessions/:id - Close session
   */
  fastify.delete(`${prefix}/sessions/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const controller = getBrowserController();
    const success = await controller.closeSession(id);

    if (!success) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return reply.send({ success: true });
  });

  // ============ Navigation ============

  /**
   * POST /api/browser/sessions/:id/navigate - Navigate to URL
   */
  fastify.post(`${prefix}/sessions/:id/navigate`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { url, ...options } = request.body as { url: string } & NavigationOptions;

    if (!url) {
      return reply.status(400).send({ error: 'Missing required field: url' });
    }

    const controller = getBrowserController();
    const result = await controller.navigate(id, url, options);

    return reply.send(result);
  });

  /**
   * POST /api/browser/sessions/:id/back - Go back
   */
  fastify.post(`${prefix}/sessions/:id/back`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const controller = getBrowserController();

    const result = await controller.evaluate(id, 'window.history.back(); return true;');
    return reply.send({ success: result.success });
  });

  /**
   * POST /api/browser/sessions/:id/forward - Go forward
   */
  fastify.post(`${prefix}/sessions/:id/forward`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const controller = getBrowserController();

    const result = await controller.evaluate(id, 'window.history.forward(); return true;');
    return reply.send({ success: result.success });
  });

  /**
   * POST /api/browser/sessions/:id/refresh - Refresh page
   */
  fastify.post(`${prefix}/sessions/:id/refresh`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const controller = getBrowserController();

    const result = await controller.evaluate(id, 'window.location.reload(); return true;');
    return reply.send({ success: result.success });
  });

  // ============ Interactions ============

  /**
   * POST /api/browser/sessions/:id/click - Click element
   */
  fastify.post(`${prefix}/sessions/:id/click`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector, ...options } = request.body as { selector: string } & ClickOptions;

    if (!selector) {
      return reply.status(400).send({ error: 'Missing required field: selector' });
    }

    const controller = getBrowserController();
    const result = await controller.click(id, selector, options);

    return reply.send(result);
  });

  /**
   * POST /api/browser/sessions/:id/type - Type text
   */
  fastify.post(`${prefix}/sessions/:id/type`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector, text, ...options } = request.body as {
      selector: string;
      text: string;
    } & TypeOptions;

    if (!selector || text === undefined) {
      return reply.status(400).send({ error: 'Missing required fields: selector, text' });
    }

    const controller = getBrowserController();
    const result = await controller.type(id, selector, text, options);

    return reply.send(result);
  });

  /**
   * POST /api/browser/sessions/:id/select - Select option
   */
  fastify.post(`${prefix}/sessions/:id/select`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector, ...options } = request.body as { selector: string } & SelectOptions;

    if (!selector) {
      return reply.status(400).send({ error: 'Missing required field: selector' });
    }

    const controller = getBrowserController();
    const result = await controller.select(id, selector, options);

    return reply.send(result);
  });

  /**
   * POST /api/browser/sessions/:id/scroll - Scroll page
   */
  fastify.post(`${prefix}/sessions/:id/scroll`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const options = request.body as {
      x?: number;
      y?: number;
      selector?: string;
      direction?: 'up' | 'down';
    };

    const controller = getBrowserController();
    const result = await controller.scroll(id, options);

    return reply.send(result);
  });

  /**
   * POST /api/browser/sessions/:id/wait - Wait for element
   */
  fastify.post(`${prefix}/sessions/:id/wait`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector, ...options } = request.body as { selector: string } & WaitOptions;

    if (!selector) {
      return reply.status(400).send({ error: 'Missing required field: selector' });
    }

    const controller = getBrowserController();
    const result = await controller.waitForElement(id, selector, options);

    return reply.send(result);
  });

  // ============ Element Info ============

  /**
   * GET /api/browser/sessions/:id/element - Get element info
   */
  fastify.get(`${prefix}/sessions/:id/element`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector } = request.query as { selector: string };

    if (!selector) {
      return reply.status(400).send({ error: 'Missing required query: selector' });
    }

    const controller = getBrowserController();
    const element = await controller.getElementInfo(id, selector);

    if (!element) {
      return reply.status(404).send({ error: 'Element not found' });
    }

    return reply.send({ element });
  });

  /**
   * GET /api/browser/sessions/:id/element/exists - Check element exists
   */
  fastify.get(`${prefix}/sessions/:id/element/exists`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector } = request.query as { selector: string };

    if (!selector) {
      return reply.status(400).send({ error: 'Missing required query: selector' });
    }

    const exists = await elementExists(id, selector);
    return reply.send({ exists });
  });

  /**
   * GET /api/browser/sessions/:id/element/count - Count elements
   */
  fastify.get(`${prefix}/sessions/:id/element/count`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector } = request.query as { selector: string };

    if (!selector) {
      return reply.status(400).send({ error: 'Missing required query: selector' });
    }

    const count = await countElements(id, selector);
    return reply.send({ count });
  });

  // ============ Screenshots & PDF ============

  /**
   * POST /api/browser/sessions/:id/screenshot - Take screenshot
   */
  fastify.post(`${prefix}/sessions/:id/screenshot`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const options = request.body as ScreenshotOptions;

    const controller = getBrowserController();
    const result = await controller.screenshot(id, options);

    return reply.send(result);
  });

  /**
   * POST /api/browser/sessions/:id/pdf - Generate PDF
   */
  fastify.post(`${prefix}/sessions/:id/pdf`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const options = request.body as PdfOptions;

    const controller = getBrowserController();
    const result = await controller.pdf(id, options);

    return reply.send(result);
  });

  // ============ JavaScript Execution ============

  /**
   * POST /api/browser/sessions/:id/evaluate - Execute JavaScript
   */
  fastify.post(`${prefix}/sessions/:id/evaluate`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { script, args } = request.body as { script: string; args?: unknown[] };

    if (!script) {
      return reply.status(400).send({ error: 'Missing required field: script' });
    }

    const controller = getBrowserController();
    const result = await controller.evaluate(id, script, args);

    return reply.send(result);
  });

  // ============ Data Extraction ============

  /**
   * POST /api/browser/sessions/:id/extract/text - Extract text
   */
  fastify.post(`${prefix}/sessions/:id/extract/text`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector, multiple, trim } = request.body as {
      selector: string;
      multiple?: boolean;
      trim?: boolean;
    };

    if (!selector) {
      return reply.status(400).send({ error: 'Missing required field: selector' });
    }

    const text = await extractText(id, selector, { multiple, trim });
    return reply.send({ text });
  });

  /**
   * POST /api/browser/sessions/:id/extract/attribute - Extract attribute
   */
  fastify.post(`${prefix}/sessions/:id/extract/attribute`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector, attribute, multiple } = request.body as {
      selector: string;
      attribute: string;
      multiple?: boolean;
    };

    if (!selector || !attribute) {
      return reply.status(400).send({ error: 'Missing required fields: selector, attribute' });
    }

    const value = await extractAttribute(id, selector, attribute, { multiple });
    return reply.send({ value });
  });

  /**
   * POST /api/browser/sessions/:id/extract/table - Extract table data
   */
  fastify.post(`${prefix}/sessions/:id/extract/table`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selector } = request.body as { selector: string };

    if (!selector) {
      return reply.status(400).send({ error: 'Missing required field: selector' });
    }

    const table = await extractTable(id, selector);
    return reply.send({ table });
  });

  /**
   * GET /api/browser/sessions/:id/extract/links - Extract links
   */
  fastify.get(`${prefix}/sessions/:id/extract/links`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { container } = request.query as { container?: string };

    const links = await extractLinks(id, container);
    return reply.send({ links });
  });

  /**
   * GET /api/browser/sessions/:id/extract/images - Extract images
   */
  fastify.get(`${prefix}/sessions/:id/extract/images`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { container } = request.query as { container?: string };

    const images = await extractImages(id, container);
    return reply.send({ images });
  });

  /**
   * GET /api/browser/sessions/:id/metadata - Get page metadata
   */
  fastify.get(`${prefix}/sessions/:id/metadata`, async (request, reply) => {
    const { id } = request.params as { id: string };

    const metadata = await getPageMetadata(id);
    return reply.send({ metadata });
  });

  /**
   * GET /api/browser/sessions/:id/structured-data - Get structured data
   */
  fastify.get(`${prefix}/sessions/:id/structured-data`, async (request, reply) => {
    const { id } = request.params as { id: string };

    const data = await extractStructuredData(id);
    return reply.send({ data });
  });

  // ============ Forms ============

  /**
   * POST /api/browser/sessions/:id/form/fill - Fill form
   */
  fastify.post(`${prefix}/sessions/:id/form/fill`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { fields, submitSelector } = request.body as {
      fields: Array<{
        selector: string;
        value: string;
        type?: 'text' | 'select' | 'checkbox' | 'radio';
        delay?: number;
      }>;
      submitSelector?: string;
    };

    if (!fields || !Array.isArray(fields)) {
      return reply.status(400).send({ error: 'Missing required field: fields' });
    }

    const result = await fillForm(id, fields, submitSelector);
    return reply.send(result);
  });

  // ============ Metrics & History ============

  /**
   * GET /api/browser/sessions/:id/metrics - Get page metrics
   */
  fastify.get(`${prefix}/sessions/:id/metrics`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const controller = getBrowserController();

    const metrics = await controller.getMetrics(id);
    return reply.send({ metrics });
  });

  /**
   * GET /api/browser/sessions/:id/actions - Get action history
   */
  fastify.get(`${prefix}/sessions/:id/actions`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };

    const controller = getBrowserController();
    const actions = controller.getActions(id, limit ? parseInt(limit, 10) : 50);

    return reply.send({ actions });
  });

  /**
   * GET /api/browser/sessions/:id/console - Get console messages
   */
  fastify.get(`${prefix}/sessions/:id/console`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };

    const controller = getBrowserController();
    const messages = controller.getConsoleMessages(id, limit ? parseInt(limit, 10) : 100);

    return reply.send({ messages });
  });

  /**
   * GET /api/browser/sessions/:id/network - Get network requests
   */
  fastify.get(`${prefix}/sessions/:id/network`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };

    const controller = getBrowserController();
    const requests = controller.getNetworkRequests(id, limit ? parseInt(limit, 10) : 100);

    return reply.send({ requests });
  });

  // ============ Stats ============

  /**
   * GET /api/browser/stats - Get browser stats
   */
  fastify.get(`${prefix}/stats`, async (_request, reply) => {
    const controller = getBrowserController();
    const stats = controller.getStats();

    return reply.send({ stats });
  });
}
