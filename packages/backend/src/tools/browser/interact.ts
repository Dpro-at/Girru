import {loadBrowserRuntime} from '../../services/browser-runtime.js';
/**
 * Browser Interact Tool
 *
 * Interact with web pages (click, type, fill forms, select options)
 * Maintains session for sequential actions
 */

import type { Tool, ToolResult } from '../types.js';
import { getBrowserController } from '../../browser/controller.js';

interface BrowserInteractParams {
  /** URL to interact with (creates new session if not provided sessionId) */
  url?: string;
  /** Existing session ID to reuse (optional) */
  sessionId?: string;
  /** Actions to perform */
  actions: Array<{
    /** Action type */
    type: 'click' | 'type' | 'select' | 'scroll' | 'wait' | 'fill_form';
    /** CSS selector (required for most actions) */
    selector?: string;
    /** Text to type (for 'type' action) */
    text?: string;
    /** Value to select (for 'select' action) */
    value?: string | string[];
    /** Scroll options (for 'scroll' action) */
    x?: number;
    y?: number;
    direction?: 'up' | 'down';
    /** Wait time in ms (for 'wait' action) */
    delay?: number;
    /** Form fields (for 'fill_form' action) */
    fields?: Array<{
      selector: string;
      value: string;
      type?: 'text' | 'select' | 'checkbox' | 'radio';
    }>;
    /** Submit button selector (for 'fill_form' action) */
    submitSelector?: string;
  }>;
  /** Keep session alive after actions (default: false, closes session) */
  keepAlive?: boolean;
  /** Take screenshot after actions */
  screenshot?: boolean;
}

export const browserInteractTool: Tool = {
  name: 'browser_interact',
  description: `Interact with a web page (click, type, fill forms, etc.).

Use this tool when you need to:
- Click buttons or links
- Type text into input fields
- Select options from dropdowns
- Fill out forms
- Scroll pages
- Perform sequential actions on a page

Actions are executed in order. The tool can:
- Create a new session and navigate to a URL
- Reuse an existing session (via sessionId)
- Keep the session alive for follow-up interactions

Available actions:
- click: Click an element (requires selector)
- type: Type text into an element (requires selector + text)
- select: Select option(s) from dropdown (requires selector + value)
- scroll: Scroll page (x, y, or direction)
- wait: Wait for specified time (delay in ms)
- fill_form: Fill multiple fields and optionally submit (requires fields array)

Returns the session ID if keepAlive is true, allowing you to continue interacting.`,

  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to navigate to (required if no sessionId)',
      },
      sessionId: {
        type: 'string',
        description: 'Existing session ID to reuse (optional)',
      },
      actions: {
        type: 'array',
        description: 'Actions to perform in sequence',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['click', 'type', 'select', 'scroll', 'wait', 'fill_form'],
            },
            selector: { type: 'string' },
            text: { type: 'string' },
            value: {
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            x: { type: 'number' },
            y: { type: 'number' },
            direction: { type: 'string', enum: ['up', 'down'] },
            delay: { type: 'number' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  selector: { type: 'string' },
                  value: { type: 'string' },
                  type: { type: 'string', enum: ['text', 'select', 'checkbox', 'radio'] },
                },
                required: ['selector', 'value'],
              },
            },
            submitSelector: { type: 'string' },
          },
          required: ['type'],
        },
      },
      keepAlive: {
        type: 'boolean',
        description: 'Keep session alive after actions (default: false)',
      },
      screenshot: {
        type: 'boolean',
        description: 'Take screenshot after actions',
      },
    },
    required: ['actions'],
    examples: [
      {
        url: 'https://www.google.com',
        actions: [
          { type: 'fill', selector: 'input[name="q"]', value: 'OpenAI GPT' },
          { type: 'click', selector: 'input[type="submit"]' },
          { type: 'wait', duration: 2000 },
        ],
        description: 'Search for "OpenAI GPT" on Google',
      },
      {
        url: 'https://github.com/login',
        actions: [
          { type: 'fill', selector: '#login_field', value: 'username' },
          { type: 'fill', selector: '#password', value: 'password' },
          { type: 'click', selector: 'input[type="submit"]' },
        ],
        description: 'Fill GitHub login form and submit',
      },
    ],
  },

  async execute(rawParams): Promise<ToolResult> {
    const params = rawParams as BrowserInteractParams;
    if(!await loadBrowserRuntime())return {error:'app_not_enabled',content:[{type:'text',text:'Add and enable Browser from the Store, then restart Girru.'}]};
    const controller = getBrowserController();
    let sessionId: string | null = null;
    let ownSession = false; // Track if we created the session

    try {
      // Get or create session
      if (params.sessionId) {
        // Reuse existing session
        const session = controller.getSession(params.sessionId);
        if (!session) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Session ${params.sessionId} not found`,
              },
            ],
            error: 'Session not found',
          };
        }
        sessionId = params.sessionId;
      } else {
        // Create new session
        if (!params.url) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: Either "url" or "sessionId" is required',
              },
            ],
            error: 'Missing required parameter',
          };
        }

        const session = await controller.createSession({
          headless: true,
        });
        sessionId = session.id;
        ownSession = true;

        // Navigate to URL
        const navResult = await controller.navigate(sessionId, params.url, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        if (!navResult.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to navigate to ${params.url}: ${navResult.error}`,
              },
            ],
            error: navResult.error,
          };
        }
      }

      // Execute actions in sequence
      const actionResults: any[] = [];

      for (const action of params.actions) {
        let result: any = null;

        switch (action.type) {
          case 'click': {
            if (!action.selector) {
              throw new Error('Click action requires "selector"');
            }
            result = await controller.click(sessionId, action.selector);
            actionResults.push({ action: 'click', selector: action.selector, ...result });
            break;
          }

          case 'type': {
            if (!action.selector || !action.text) {
              throw new Error('Type action requires "selector" and "text"');
            }
            result = await controller.type(sessionId, action.selector, action.text, {
              delay: action.delay,
            });
            actionResults.push({ action: 'type', selector: action.selector, ...result });
            break;
          }

          case 'select': {
            if (!action.selector || !action.value) {
              throw new Error('Select action requires "selector" and "value"');
            }
            result = await controller.select(sessionId, action.selector, {
              value: action.value,
            });
            actionResults.push({ action: 'select', selector: action.selector, ...result });
            break;
          }

          case 'scroll': {
            result = await controller.scroll(sessionId, {
              x: action.x,
              y: action.y,
              direction: action.direction,
            });
            actionResults.push({ action: 'scroll', ...result });
            break;
          }

          case 'wait': {
            const waitTime = action.delay || 1000;
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            actionResults.push({ action: 'wait', delay: waitTime, success: true });
            break;
          }

          case 'fill_form': {
            if (!action.fields || action.fields.length === 0) {
              throw new Error('Fill form action requires "fields" array');
            }
            // Fields are CSS selectors (the page helper it called matched input
            // names and needed the page, not the session id).
            let filled = 0;
            for (const field of action.fields) {
              const typed = await controller.type(sessionId, field.selector, String(field.value ?? ''));
              if (!typed.success) throw new Error(`Could not fill "${field.selector}": ${typed.error}`);
              filled++;
            }
            let submitted = false;
            if (action.submitSelector) {
              const clicked = await controller.click(sessionId, action.submitSelector);
              if (!clicked.success) throw new Error(`Could not click "${action.submitSelector}": ${clicked.error}`);
              submitted = true;
            }
            result = { success: true, filled, submitted };
            actionResults.push({ action: 'fill_form', ...result });
            break;
          }

          default:
            throw new Error(`Unknown action type: ${action.type}`);
        }

        // Small delay between actions
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const resultData: any = {
        success: true,
        actionsPerformed: actionResults.length,
        actions: actionResults,
      };

      // Take screenshot if requested
      if (params.screenshot) {
        const screenshotResult = await controller.screenshot(sessionId, {
          fullPage: false,
        });

        if (screenshotResult.success) {
          resultData.screenshot = screenshotResult.path;
        }
      }

      // Keep session alive or close it
      if (params.keepAlive) {
        resultData.sessionId = sessionId;
        resultData.message = 'Session kept alive for further interactions';
      } else if (ownSession) {
        await controller.closeSession(sessionId);
        resultData.message = 'Session closed after actions';
      }

      // Format response text
      let responseText = `Successfully performed ${actionResults.length} actions:\n\n`;
      actionResults.forEach((r, i) => {
        responseText += `${i + 1}. ${r.action}${r.selector ? ` (${r.selector})` : ''}${
          r.success ? ' ✓' : ' ✗'
        }\n`;
      });

      if (params.screenshot) {
        responseText += `\nScreenshot: ${resultData.screenshot}`;
      }

      if (params.keepAlive) {
        responseText += `\n\nSession ID: ${sessionId}\nUse this ID for follow-up interactions.`;
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
        data: resultData,
      };
    } catch (error: any) {
      // Cleanup session on error (only if we created it)
      if (sessionId && ownSession && !params.keepAlive) {
        try {
          await controller.closeSession(sessionId);
        } catch {
          // Ignore cleanup errors
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Error during browser interaction: ${error.message}`,
          },
        ],
        error: error.message,
      };
    }
  },
};
