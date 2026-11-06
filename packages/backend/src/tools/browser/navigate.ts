import {loadBrowserRuntime} from '../../services/browser-runtime.js';
/**
 * Browser Navigate Tool
 *
 * Navigate to a URL and optionally extract basic page information
 * Integrated with Girru's browser automation system
 */

import type { Tool, ToolResult } from '../types.js';
import { getBrowserController } from '../../browser/controller.js';

interface BrowserNavigateParams {
  /** URL to navigate to */
  url: string;
  /** Optional: Wait for specific selector before returning */
  waitFor?: string;
  /** Optional: Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Optional: Extract basic page info (title, url, meta) */
  extractInfo?: boolean;
  /** Optional: Take screenshot after navigation */
  screenshot?: boolean;
}

export const browserNavigateTool: Tool = {
  name: 'browser_navigate',
  description: `Navigate to a web page and optionally extract information.

Use this tool when you need to:
- Open a webpage
- Visit a URL to check its content
- Navigate to a page before interacting with it
- Take a quick screenshot of a page

The tool will create a browser session, navigate to the URL, and return page information.
You can optionally wait for specific elements to load or take a screenshot.`,

  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to navigate to (must include protocol, e.g., https://)',
      },
      waitFor: {
        type: 'string',
        description: 'CSS selector to wait for before returning (optional)',
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds (default: 30000)',
      },
      extractInfo: {
        type: 'boolean',
        description: 'Extract basic page information (title, description, etc.)',
      },
      screenshot: {
        type: 'boolean',
        description: 'Take a screenshot after navigation',
      },
    },
    required: ['url'],
    examples: [
      {
        url: 'https://github.com/trending',
        extractInfo: true,
        description: 'Navigate to GitHub trending page and extract page information',
      },
      {
        url: 'https://news.ycombinator.com',
        waitFor: '.itemlist',
        description: 'Open Hacker News and wait for posts to load',
      },
      {
        url: 'https://example.com',
        screenshot: true,
        description: 'Navigate to example.com and take a screenshot',
      },
    ],
  },

  async execute(rawParams): Promise<ToolResult> {
    const params = rawParams as BrowserNavigateParams;
    if(!await loadBrowserRuntime())return {error:'app_not_enabled',content:[{type:'text',text:'Add and enable Browser from the Store, then restart Girru.'}]};
    const controller = getBrowserController();
    let sessionId: string | null = null;

    try {
      // Validate URL
      if (!params.url.startsWith('http://') && !params.url.startsWith('https://')) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: URL must start with http:// or https://. Got: ${params.url}`,
            },
          ],
          error: 'Invalid URL format',
        };
      }

      // Create browser session
      const session = await controller.createSession({
        headless: true,
        viewportWidth: 1280,
        viewportHeight: 720,
      });
      sessionId = session.id;

      // Navigate to URL
      const navResult = await controller.navigate(sessionId, params.url, {
        waitUntil: 'networkidle2',
        timeout: params.timeout || 30000,
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

      const result: any = {
        success: true,
        url: params.url,
        finalUrl: navResult.finalUrl,
        title: navResult.title,
      };

      // Wait for selector if specified
      if (params.waitFor) {
        const waitResult = await controller.waitForElement(sessionId, params.waitFor, {
          timeout: params.timeout || 30000,
        });

        if (!waitResult.success) {
          result.warning = `Element "${params.waitFor}" not found within timeout`;
        } else {
          result.elementFound = true;
        }
      }

      // Extract page info if requested
      if (params.extractInfo) {
        const { getPageMetadata } = await import('./page-utils.js');
        const page = controller.getPage(sessionId);
        const metadata = page ? await getPageMetadata(page) : null;
        result.metadata = metadata;
      }

      // Take screenshot if requested
      if (params.screenshot) {
        const screenshotResult = await controller.screenshot(sessionId, {
          fullPage: false,
        });

        if (screenshotResult.success) {
          result.screenshot = screenshotResult.path;
        }
      }

      // Close session
      await controller.closeSession(sessionId);

      return {
        content: [
          {
            type: 'text',
            text: `Successfully navigated to: ${navResult.title}\n\nURL: ${navResult.finalUrl}\nStatus: Page loaded successfully${
              result.screenshot ? `\nScreenshot: ${result.screenshot}` : ''
            }${
              result.metadata
                ? `\n\nPage Info:\n- Description: ${result.metadata.description || 'N/A'}\n- Keywords: ${result.metadata.keywords || 'N/A'}`
                : ''
            }`,
          },
        ],
        data: result,
      };
    } catch (error: any) {
      // Cleanup session on error
      if (sessionId) {
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
            text: `Error navigating to ${params.url}: ${error.message}`,
          },
        ],
        error: error.message,
      };
    }
  },
};
