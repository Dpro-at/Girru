import { type BrowserConfig, type BrowserSession, type BrowserStats, type ElementInfo, type NavigationOptions, type ClickOptions, type TypeOptions, type SelectOptions, type WaitOptions, type ScreenshotOptions, type PdfOptions, type ScriptResult, type NetworkRequest, type ConsoleMessage, type PageMetrics, type BrowserAction } from './types.js';
type Page = any;
export declare class BrowserController {
    private sessions;
    private screenshotDir;
    private downloadDir;
    private startTime;
    private stats;
    constructor();
    /**
     * Create a new browser session
     */
    createSession(config?: Partial<BrowserConfig>): Promise<BrowserSession>;
    /** The current (Puppeteer) page of a session, for the page helpers of the browser tools. */
    getPage(sessionId: string): Page | null;
    /** BROWSER-01: requests the URL guard refused in this session. */
    getBlockedRequests(sessionId: string): Array<{
        url: string;
        reason: string;
        at: Date;
    }>;
    /**
     * Close a browser session
     */
    closeSession(sessionId: string): Promise<boolean>;
    /**
     * Get session info
     */
    getSession(sessionId: string): BrowserSession | null;
    /**
     * List all sessions
     */
    listSessions(): BrowserSession[];
    /**
     * Navigate to URL
     */
    navigate(sessionId: string, url: string, options?: NavigationOptions): Promise<{
        success: boolean;
        finalUrl?: string;
        title?: string;
        error?: string;
    }>;
    /**
     * Click an element
     */
    click(sessionId: string, selector: string, options?: ClickOptions): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Type text into an element
     */
    type(sessionId: string, selector: string, text: string, options?: TypeOptions): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Select option from dropdown
     */
    select(sessionId: string, selector: string, options: SelectOptions): Promise<{
        success: boolean;
        selected?: string[];
        error?: string;
    }>;
    /**
     * Wait for element
     */
    waitForElement(sessionId: string, selector: string, options?: WaitOptions): Promise<{
        success: boolean;
        found: boolean;
        error?: string;
    }>;
    /**
     * Get element info
     */
    getElementInfo(sessionId: string, selector: string): Promise<ElementInfo | null>;
    /**
     * Take screenshot
     */
    screenshot(sessionId: string, options?: ScreenshotOptions): Promise<{
        success: boolean;
        path?: string;
        base64?: string;
        error?: string;
    }>;
    /**
     * Generate PDF
     */
    pdf(sessionId: string, options?: PdfOptions): Promise<{
        success: boolean;
        path?: string;
        error?: string;
    }>;
    /**
     * Execute JavaScript
     */
    evaluate(sessionId: string, script: string, args?: unknown[]): Promise<ScriptResult>;
    /**
     * Scroll page
     */
    scroll(sessionId: string, options: {
        x?: number;
        y?: number;
        selector?: string;
        direction?: 'up' | 'down';
    }): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Get page metrics
     */
    getMetrics(sessionId: string): Promise<PageMetrics | null>;
    /**
     * Get action history
     */
    getActions(sessionId: string, limit?: number): BrowserAction[];
    /**
     * Get console messages
     */
    getConsoleMessages(sessionId: string, limit?: number): ConsoleMessage[];
    /**
     * Get network requests
     */
    getNetworkRequests(sessionId: string, limit?: number): NetworkRequest[];
    /**
     * Get stats
     */
    getStats(): BrowserStats;
    private loadPuppeteer;
    private getCurrentPage;
    private updateSessionInfo;
    private setupPageListeners;
    private startAction;
    private endAction;
    /**
     * Validate proxy server URL to prevent SSRF attacks (H-10)
     * Blocks: localhost, private IPs, link-local, loopback
     */
    private isValidProxyServer;
    /**
     * Cleanup all sessions
     */
    cleanup(): Promise<void>;
}
export declare function getBrowserController(): BrowserController;
export {};
