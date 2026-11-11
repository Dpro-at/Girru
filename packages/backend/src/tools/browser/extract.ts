import {loadBrowserRuntime} from '../../services/browser-runtime.js';
/**
 * Browser Extract Tool
 *
 * Extract data from web pages (text, links, tables, images, etc.)
 * Professional data extraction with multiple modes
 */

import type { Tool, ToolResult } from '../types.js';
import { getBrowserController } from '../../browser/controller.js';
import {
  extractLinks,
  extractImages,
  extractTableData,
  extractStructuredData,
  extractText,
  getPageMetadata,
} from './page-utils.js';

/** Table rows as { headers, rows }: the first row is the header row. */
function toTable(rows: string[][]): { headers: string[]; rows: string[][] } | null {
  if (rows.length === 0) return null;
  return { headers: rows[0], rows: rows.slice(1) };
}

interface BrowserExtractParams {
  /** URL to extract data from */
  url: string;
  /** What to extract: text, links, images, table, metadata, structured, all */
  extract: 'text' | 'links' | 'images' | 'table' | 'metadata' | 'structured' | 'all';
  /** CSS selector for the extraction (required for text and table) */
  selector?: string;
  /** For text extraction: return multiple elements */
  multiple?: boolean;
  /** For text extraction: trim whitespace */
  trim?: boolean;
  /** Container selector to limit extraction scope */
  container?: string;
}

export const browserExtractTool: Tool = {
  name: 'browser_extract',
  description: `Extract data from a web page.

Use this tool when you need to:
- Scrape text content from specific elements
- Extract all links from a page
- Get all images
- Parse HTML tables into structured data
- Extract metadata (title, description, Open Graph, etc.)
- Get JSON-LD structured data

Extraction modes:
- "text": Extract text from selector (requires selector)
- "links": Extract all links (href + text)
- "images": Extract all images (src + alt)
- "table": Extract table data as rows/columns (requires selector)
- "metadata": Extract page metadata (title, description, og:*, etc.)
- "structured": Extract JSON-LD structured data
- "all": Extract everything (comprehensive page analysis)

Returns extracted data in a structured format.`,

  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to extract data from',
      },
      extract: {
        type: 'string',
        enum: ['text', 'links', 'images', 'table', 'metadata', 'structured', 'all'],
        description: 'What type of data to extract',
      },
      selector: {
        type: 'string',
        description: 'CSS selector (required for text and table extraction)',
      },
      multiple: {
        type: 'boolean',
        description: 'For text: extract from multiple matching elements',
      },
      trim: {
        type: 'boolean',
        description: 'For text: trim whitespace from results',
      },
      container: {
        type: 'string',
        description: 'Container selector to limit scope of links/images extraction',
      },
    },
    required: ['url', 'extract'],
    examples: [
      {
        url: 'https://news.ycombinator.com',
        extract: { type: 'text', selector: '.titleline' },
        description: 'Extract all post titles from Hacker News',
      },
      {
        url: 'https://github.com/trending',
        extract: { type: 'links', container: '.Box' },
        description: 'Extract all repository links from GitHub trending page',
      },
      {
        url: 'https://example.com',
        extract: { type: 'html', selector: 'article' },
        description: 'Extract article HTML content',
      },
    ],
  },

  async execute(rawParams): Promise<ToolResult> {
    const params = rawParams as BrowserExtractParams;
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
              text: 'Error: URL must start with http:// or https://',
            },
          ],
          error: 'Invalid URL format',
        };
      }

      // Validate selector for text and table
      if ((params.extract === 'text' || params.extract === 'table') && !params.selector) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: "selector" is required for ${params.extract} extraction`,
            },
          ],
          error: 'Missing required parameter: selector',
        };
      }

      // Create browser session
      const session = await controller.createSession({
        headless: true,
      });
      sessionId = session.id;

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

      const result: any = {
        success: true,
        url: params.url,
        title: navResult.title,
      };

      // The page helpers work on the Puppeteer page (they were given the session id).
      const page = controller.getPage(sessionId);
      if (!page) throw new Error('No active page');

      // Extract based on mode
      switch (params.extract) {
        case 'text': {
          result.text = await extractText(page, params.selector!, {
            multiple: params.multiple,
            trim: params.trim !== false, // Default to true
          });
          break;
        }

        case 'links': {
          const links = await extractLinks(page, params.container);
          result.links = links;
          result.linkCount = links.length;
          break;
        }

        case 'images': {
          const images = await extractImages(page, params.container);
          result.images = images;
          result.imageCount = images.length;
          break;
        }

        case 'table': {
          const table = toTable(await extractTableData(page, params.selector!));
          result.table = table;
          result.rowCount = table?.rows?.length || 0;
          break;
        }

        case 'metadata': {
          const metadata = await getPageMetadata(page);
          result.metadata = metadata;
          break;
        }

        case 'structured': {
          const structuredData = await extractStructuredData(page);
          result.structuredData = structuredData;
          break;
        }

        case 'all': {
          // Extract everything
          const [links, images, metadata, structuredData] = await Promise.all([
            extractLinks(page),
            extractImages(page),
            getPageMetadata(page),
            extractStructuredData(page),
          ]);

          result.links = links;
          result.linkCount = links.length;
          result.images = images;
          result.imageCount = images.length;
          result.metadata = metadata;
          result.structuredData = structuredData;
          break;
        }
      }

      // Close session
      await controller.closeSession(sessionId);

      // Format response text
      let responseText = `Data extracted from: ${navResult.title}\n\n`;

      if (params.extract === 'text') {
        responseText += `Text Content:\n${Array.isArray(result.text) ? result.text.join('\n\n') : result.text}`;
      } else if (params.extract === 'links') {
        responseText += `Found ${result.linkCount} links:\n\n`;
        responseText += result.links
          .slice(0, 10)
          .map((l: any) => `- ${l.text || 'No text'}: ${l.href}`)
          .join('\n');
        if (result.linkCount > 10) {
          responseText += `\n\n... and ${result.linkCount - 10} more links`;
        }
      } else if (params.extract === 'images') {
        responseText += `Found ${result.imageCount} images:\n\n`;
        responseText += result.images
          .slice(0, 10)
          .map((img: any) => `- ${img.alt || 'No alt'}: ${img.src}`)
          .join('\n');
        if (result.imageCount > 10) {
          responseText += `\n\n... and ${result.imageCount - 10} more images`;
        }
      } else if (params.extract === 'table') {
        responseText += `Table Data (${result.rowCount} rows):\n\n`;
        if (result.table?.headers) {
          responseText += `Headers: ${result.table.headers.join(' | ')}\n`;
        }
        if (result.table?.rows && result.table.rows.length > 0) {
          responseText += '\nFirst 5 rows:\n';
          responseText += result.table.rows
            .slice(0, 5)
            .map((row: any) => row.join(' | '))
            .join('\n');
          if (result.rowCount > 5) {
            responseText += `\n\n... and ${result.rowCount - 5} more rows`;
          }
        }
      } else if (params.extract === 'metadata') {
        responseText += 'Page Metadata:\n\n';
        responseText += `Title: ${result.metadata.title || 'N/A'}\n`;
        responseText += `Description: ${result.metadata.description || 'N/A'}\n`;
        responseText += `Keywords: ${result.metadata.keywords || 'N/A'}\n`;
        if (result.metadata.ogTitle) {
          responseText += `\nOpen Graph:\n`;
          responseText += `- Title: ${result.metadata.ogTitle}\n`;
          responseText += `- Description: ${result.metadata.ogDescription || 'N/A'}\n`;
          responseText += `- Image: ${result.metadata.ogImage || 'N/A'}\n`;
        }
      } else if (params.extract === 'structured') {
        responseText += `Structured Data (JSON-LD):\n\n`;
        responseText += JSON.stringify(result.structuredData, null, 2);
      } else if (params.extract === 'all') {
        responseText += `Complete Page Analysis:\n\n`;
        responseText += `Links: ${result.linkCount}\n`;
        responseText += `Images: ${result.imageCount}\n`;
        responseText += `Title: ${result.metadata?.title || 'N/A'}\n`;
        responseText += `Description: ${result.metadata?.description || 'N/A'}\n`;
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
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
            text: `Error extracting data from ${params.url}: ${error.message}`,
          },
        ],
        error: error.message,
      };
    }
  },
};
