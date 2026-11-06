/**
 * Browser Automation System
 * Web interaction and automation capabilities
 */

export * from './types.js';
export * from './controller.js';
export * from './page-utils.js';

// Re-export getBrowserController explicitly
export { getBrowserController } from './controller.js';

import { getBrowserController } from './controller.js';
import type {BrowserController} from './controller-contract.js';
import {loadBrowserRuntime,browserRuntimeReady,stopBrowserRuntime} from '../services/browser-runtime.js';
import type { BrowserConfig, BrowserSession, BrowserStats } from './types.js';

let initialized = false;

/**
 * Initialize the browser automation system
 */
export async function initializeBrowser(): Promise<{
  controller: BrowserController|null;
}> {
  const controller = await loadBrowserRuntime();
  if(!controller)return {controller:null};

  initialized = true;
  console.log('[Browser] System initialized');

  return { controller };
}

/**
 * Create a new browser session
 */
export async function createBrowserSession(
  config?: Partial<BrowserConfig>
): Promise<BrowserSession> {
  const controller = getBrowserController();
  return controller.createSession(config);
}

/**
 * Close a browser session
 */
export async function closeBrowserSession(sessionId: string): Promise<boolean> {
  const controller = getBrowserController();
  return controller.closeSession(sessionId);
}

/**
 * Get browser status
 */
export function getBrowserStatus(): {
  initialized: boolean;
  stats: BrowserStats|null;
} {
  if(!browserRuntimeReady())return {initialized:false,stats:null};
  const controller = getBrowserController();

  return {
    initialized,
    stats: controller.getStats(),
  };
}

/**
 * Shutdown browser system
 */
export async function shutdownBrowser(): Promise<void> {
  await stopBrowserRuntime();

  initialized = false;
  console.log('[Browser] System shutdown');
}

/**
 * Quick navigate and screenshot
 */
export async function quickCapture(
  url: string,
  options?: {
    fullPage?: boolean;
    waitTime?: number;
    viewport?: { width: number; height: number };
  }
): Promise<{
  success: boolean;
  screenshotPath?: string;
  title?: string;
  error?: string;
}> {
  const controller = getBrowserController();

  // Create session
  const session = await controller.createSession({
    viewportWidth: options?.viewport?.width || 1280,
    viewportHeight: options?.viewport?.height || 720,
  });

  try {
    // Navigate
    const navResult = await controller.navigate(session.id, url);
    if (!navResult.success) {
      await controller.closeSession(session.id);
      return { success: false, error: navResult.error };
    }

    // Wait if specified
    if (options?.waitTime) {
      await new Promise((r) => setTimeout(r, options.waitTime));
    }

    // Screenshot
    const screenshotResult = await controller.screenshot(session.id, {
      fullPage: options?.fullPage,
    });

    // Close session
    await controller.closeSession(session.id);

    if (!screenshotResult.success) {
      return { success: false, error: screenshotResult.error };
    }

    return {
      success: true,
      screenshotPath: screenshotResult.path,
      title: navResult.title,
    };
  } catch (error: any) {
    await controller.closeSession(session.id);
    return { success: false, error: error.message };
  }
}

/**
 * Quick page scrape
 */
export async function quickScrape(
  url: string,
  selectors: {
    title?: string;
    content?: string;
    links?: boolean;
    images?: boolean;
  }
): Promise<{
  success: boolean;
  title?: string;
  content?: string | string[];
  links?: { text: string; href: string }[];
  images?: { src: string; alt?: string }[];
  error?: string;
}> {
  const controller = getBrowserController();
  const { extractText, extractLinks, extractImages } = await import('./page-utils.js');

  // Create session
  const session = await controller.createSession();

  try {
    // Navigate
    const navResult = await controller.navigate(session.id, url);
    if (!navResult.success) {
      await controller.closeSession(session.id);
      return { success: false, error: navResult.error };
    }

    const result: any = { success: true, title: navResult.title };

    // Extract content
    if (selectors.content) {
      result.content = await extractText(session.id, selectors.content);
    }

    // Extract links
    if (selectors.links) {
      result.links = await extractLinks(session.id);
    }

    // Extract images
    if (selectors.images) {
      result.images = await extractImages(session.id);
    }

    // Close session
    await controller.closeSession(session.id);

    return result;
  } catch (error: any) {
    await controller.closeSession(session.id);
    return { success: false, error: error.message };
  }
}
