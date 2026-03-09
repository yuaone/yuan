/**
 * @yuan/tools — Browser Visual Debugging Tool
 *
 * Provides browser automation for visual debugging:
 * - browser open:       Launch browser and navigate to URL
 * - browser screenshot: Capture page screenshot (returns base64)
 * - browser click:      Click an element by selector
 * - browser type:       Type text into an element
 * - browser evaluate:   Execute JavaScript in page context
 * - browser dom:        Extract DOM structure for analysis
 * - browser close:      Close browser
 *
 * Uses Playwright for cross-browser automation.
 * Screenshots are returned as base64 for LLM vision analysis.
 *
 * Security constraints:
 * - Only localhost / 127.0.0.1 / file:// URLs allowed
 * - Script evaluation timeout: 5s
 * - Script length limit: 10KB
 * - DOM extraction depth: 5 levels, max 500 nodes
 * - Max 5 concurrent sessions, 5-minute timeout
 */

import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';

// ---------------------------------------------------------------------------
// Lazy-load Playwright so the tool doesn't crash if not installed
// ---------------------------------------------------------------------------

let playwrightModule: any = null;

async function getPlaywright(): Promise<any> {
  if (!playwrightModule) {
    try {
      // Dynamic import with variable to prevent TypeScript from resolving the module
      const moduleName = 'playwright';
      playwrightModule = await (Function('m', 'return import(m)') as (m: string) => Promise<any>)(moduleName);
    } catch {
      throw new Error(
        'Playwright is not installed. Run: pnpm --filter @yuan/tools add playwright && npx playwright install chromium',
      );
    }
  }
  return playwrightModule;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface BrowserSession {
  browser: any;
  context: any;
  page: any;
  createdAt: number;
}

const sessions = new Map<string, BrowserSession>();
const MAX_SESSIONS = 5;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Generate a short random session ID. */
function generateSessionId(): string {
  return `bs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Evict expired sessions. */
async function evictExpiredSessions(): Promise<void> {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TIMEOUT_MS) {
      try {
        await session.browser?.close();
      } catch {
        // ignore
      }
      sessions.delete(id);
    }
  }
}

/** Get a session or return an error ToolResult. */
function getSession(
  sessionId: string | undefined,
): BrowserSession | null {
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  // Check if expired
  if (Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
    session.browser?.close().catch(() => {});
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

// ---------------------------------------------------------------------------
// URL validation — only allow safe local URLs
// ---------------------------------------------------------------------------

const ALLOWED_URL_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?(\/|$)/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
  /^https?:\/\/0\.0\.0\.0(:\d+)?(\/|$)/,
  /^https?:\/\/\[::1\](:\d+)?(\/|$)/,
  /^file:\/\//,
];

function isAllowedUrl(url: string): boolean {
  return ALLOWED_URL_PATTERNS.some((p) => p.test(url));
}

// ---------------------------------------------------------------------------
// DOM extraction helpers
// ---------------------------------------------------------------------------

const MAX_DOM_DEPTH = 5;
const MAX_DOM_NODES = 500;

/**
 * Script injected into the page to extract a simplified DOM tree.
 * Returns a serializable object with tag, id, class, text, and children.
 */
function buildDomExtractionScript(maxDepth: number, maxNodes: number): string {
  return `
    (() => {
      let nodeCount = 0;
      const MAX_DEPTH = ${maxDepth};
      const MAX_NODES = ${maxNodes};
      const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH']);

      function extract(el, depth) {
        if (depth > MAX_DEPTH || nodeCount >= MAX_NODES) return null;
        if (!el || !el.tagName) return null;
        if (SKIP_TAGS.has(el.tagName)) return null;

        nodeCount++;

        const node = {
          tag: el.tagName.toLowerCase(),
        };

        if (el.id) node.id = el.id;
        if (el.className && typeof el.className === 'string' && el.className.trim()) {
          node.cls = el.className.trim().split(/\\s+/).slice(0, 5).join(' ');
        }

        // Direct text content (not from children)
        const textContent = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent?.trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 100);

        if (textContent) node.text = textContent;

        // Useful attributes
        if (el.href) node.href = el.href;
        if (el.src) node.src = el.src;
        if (el.type) node.type = el.type;
        if (el.name) node.name = el.name;
        if (el.value && el.value.length < 100) node.value = el.value;
        if (el.placeholder) node.placeholder = el.placeholder;

        // Children
        if (depth < MAX_DEPTH && el.children && el.children.length > 0) {
          const children = [];
          for (const child of el.children) {
            if (nodeCount >= MAX_NODES) break;
            const childNode = extract(child, depth + 1);
            if (childNode) children.push(childNode);
          }
          if (children.length > 0) node.children = children;
        }

        return node;
      }

      return extract(document.body, 0);
    })()
  `;
}

// ---------------------------------------------------------------------------
// BrowserTool
// ---------------------------------------------------------------------------

export class BrowserTool extends BaseTool {
  readonly name = 'browser';
  readonly description =
    'Browser automation for visual debugging. ' +
    'Actions: open, screenshot, click, type, evaluate, dom, close. ' +
    'Screenshots are returned as base64 for visual analysis. ' +
    'Only localhost/127.0.0.1/file:// URLs are allowed (security).';
  readonly riskLevel: RiskLevel = 'high';

  readonly parameters: Record<string, ParameterDef> = {
    action: {
      type: 'string',
      description: 'Browser action to perform',
      required: true,
      enum: ['open', 'screenshot', 'click', 'type', 'evaluate', 'dom', 'close'],
    },
    url: {
      type: 'string',
      description: 'URL to navigate to (for open action). Only localhost/127.0.0.1/file:// allowed.',
      required: false,
    },
    selector: {
      type: 'string',
      description: 'CSS selector for target element (for click, type actions)',
      required: false,
    },
    text: {
      type: 'string',
      description: 'Text to type (for type action)',
      required: false,
    },
    script: {
      type: 'string',
      description: 'JavaScript to evaluate in page context (for evaluate action, max 10KB)',
      required: false,
    },
    sessionId: {
      type: 'string',
      description: 'Browser session ID. Auto-generated on open; reuse for subsequent actions.',
      required: false,
    },
    fullPage: {
      type: 'boolean',
      description: 'Capture full page screenshot (default: false)',
      required: false,
      default: false,
    },
    viewport: {
      type: 'object',
      description: 'Viewport size { width, height } for open action (default: 1280x720)',
      required: false,
    },
    waitFor: {
      type: 'string',
      description: 'CSS selector to wait for before performing action',
      required: false,
    },
  };

  async execute(
    args: Record<string, unknown>,
    workDir: string,
    _abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const action = args.action as string;

    // Evict expired sessions before every action
    await evictExpiredSessions();

    try {
      switch (action) {
        case 'open':
          return await this.browserOpen(toolCallId, args);
        case 'screenshot':
          return await this.browserScreenshot(toolCallId, args);
        case 'click':
          return await this.browserClick(toolCallId, args);
        case 'type':
          return await this.browserType(toolCallId, args);
        case 'evaluate':
          return await this.browserEvaluate(toolCallId, args);
        case 'dom':
          return await this.browserDom(toolCallId, args);
        case 'close':
          return await this.browserClose(toolCallId, args);
        default:
          return this.fail(toolCallId, `Unknown browser action: ${action}. Valid actions: open, screenshot, click, type, evaluate, dom, close`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return this.fail(toolCallId, `Browser action "${action}" failed: ${message}`);
    }
  }

  // ─── open ──────────────────────────────────────────────────────────

  private async browserOpen(
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const url = args.url as string | undefined;
    if (!url) {
      return this.fail(toolCallId, 'Missing required parameter: url');
    }

    // Security: only allow local URLs
    if (!isAllowedUrl(url)) {
      return this.fail(
        toolCallId,
        `URL not allowed: "${url}". Only localhost, 127.0.0.1, 0.0.0.0, [::1], and file:// URLs are permitted.`,
      );
    }

    // Enforce session limit
    if (sessions.size >= MAX_SESSIONS) {
      return this.fail(
        toolCallId,
        `Maximum concurrent browser sessions reached (${MAX_SESSIONS}). Close an existing session first.`,
      );
    }

    const pw = await getPlaywright();
    const viewport = args.viewport as { width?: number; height?: number } | undefined;
    const vw = viewport?.width ?? 1280;
    const vh = viewport?.height ?? 720;

    const browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: vw, height: vh },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // Navigate
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    const sessionId = generateSessionId();
    sessions.set(sessionId, {
      browser,
      context,
      page,
      createdAt: Date.now(),
    });

    const title = await page.title();

    return this.ok(
      toolCallId,
      JSON.stringify({
        sessionId,
        title,
        url: page.url(),
        viewport: { width: vw, height: vh },
      }),
    );
  }

  // ─── screenshot ────────────────────────────────────────────────────

  private async browserScreenshot(
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const sessionId = args.sessionId as string | undefined;
    const session = getSession(sessionId);
    if (!session) {
      return this.fail(
        toolCallId,
        sessionId
          ? `Session not found or expired: ${sessionId}`
          : 'Missing required parameter: sessionId',
      );
    }

    const fullPage = (args.fullPage as boolean) ?? false;
    const waitFor = args.waitFor as string | undefined;

    if (waitFor) {
      await session.page.waitForSelector(waitFor, { timeout: 10_000 });
    }

    const screenshotBuffer: Buffer = await session.page.screenshot({
      fullPage,
      type: 'png',
    });

    const base64 = screenshotBuffer.toString('base64');
    const title = await session.page.title();

    return this.ok(
      toolCallId,
      JSON.stringify({
        sessionId,
        title,
        url: session.page.url(),
        fullPage,
        imageBase64: base64,
        imageMimeType: 'image/png',
        imageSizeBytes: screenshotBuffer.byteLength,
      }),
    );
  }

  // ─── click ─────────────────────────────────────────────────────────

  private async browserClick(
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const sessionId = args.sessionId as string | undefined;
    const session = getSession(sessionId);
    if (!session) {
      return this.fail(
        toolCallId,
        sessionId
          ? `Session not found or expired: ${sessionId}`
          : 'Missing required parameter: sessionId',
      );
    }

    const selector = args.selector as string | undefined;
    if (!selector) {
      return this.fail(toolCallId, 'Missing required parameter: selector');
    }

    const waitFor = args.waitFor as string | undefined;
    if (waitFor) {
      await session.page.waitForSelector(waitFor, { timeout: 10_000 });
    }

    // Wait for the target element
    await session.page.waitForSelector(selector, { timeout: 10_000 });

    // Get element info before clicking (evaluate as string to avoid TS DOM type issues)
    const elementInfoScript = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 100),
          id: el.id || undefined,
          className: el.className && typeof el.className === 'string'
            ? el.className.trim().slice(0, 100)
            : undefined,
        };
      })()
    `;
    const elementInfo = await session.page.evaluate(elementInfoScript);

    // Click and wait for any navigation or network activity to settle
    await session.page.click(selector);
    await session.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

    return this.ok(
      toolCallId,
      JSON.stringify({
        sessionId,
        action: 'click',
        selector,
        element: elementInfo,
        url: session.page.url(),
      }),
    );
  }

  // ─── type ──────────────────────────────────────────────────────────

  private async browserType(
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const sessionId = args.sessionId as string | undefined;
    const session = getSession(sessionId);
    if (!session) {
      return this.fail(
        toolCallId,
        sessionId
          ? `Session not found or expired: ${sessionId}`
          : 'Missing required parameter: sessionId',
      );
    }

    const selector = args.selector as string | undefined;
    if (!selector) {
      return this.fail(toolCallId, 'Missing required parameter: selector');
    }

    const text = args.text as string | undefined;
    if (text === undefined || text === null) {
      return this.fail(toolCallId, 'Missing required parameter: text');
    }

    const waitFor = args.waitFor as string | undefined;
    if (waitFor) {
      await session.page.waitForSelector(waitFor, { timeout: 10_000 });
    }

    // Wait for the target element
    await session.page.waitForSelector(selector, { timeout: 10_000 });

    // Use fill() to clear and set value (works for input/textarea)
    await session.page.fill(selector, text);

    return this.ok(
      toolCallId,
      JSON.stringify({
        sessionId,
        action: 'type',
        selector,
        textLength: text.length,
      }),
    );
  }

  // ─── evaluate ──────────────────────────────────────────────────────

  private async browserEvaluate(
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const sessionId = args.sessionId as string | undefined;
    const session = getSession(sessionId);
    if (!session) {
      return this.fail(
        toolCallId,
        sessionId
          ? `Session not found or expired: ${sessionId}`
          : 'Missing required parameter: sessionId',
      );
    }

    const script = args.script as string | undefined;
    if (!script) {
      return this.fail(toolCallId, 'Missing required parameter: script');
    }

    // Security: limit script length
    const MAX_SCRIPT_LENGTH = 10 * 1024; // 10KB
    if (script.length > MAX_SCRIPT_LENGTH) {
      return this.fail(
        toolCallId,
        `Script too long: ${script.length} bytes (max ${MAX_SCRIPT_LENGTH} bytes)`,
      );
    }

    const waitFor = args.waitFor as string | undefined;
    if (waitFor) {
      await session.page.waitForSelector(waitFor, { timeout: 10_000 });
    }

    // Evaluate with timeout
    const EVAL_TIMEOUT = 5_000;
    let result: unknown;
    try {
      result = await Promise.race([
        session.page.evaluate(script),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Script evaluation timed out (5s)')), EVAL_TIMEOUT),
        ),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.fail(toolCallId, `Script evaluation error: ${msg}`);
    }

    // Serialize result
    let serialized: string;
    try {
      serialized = JSON.stringify(result, null, 2);
    } catch {
      serialized = String(result);
    }

    // Limit output size
    const MAX_OUTPUT = 50 * 1024; // 50KB
    if (serialized.length > MAX_OUTPUT) {
      serialized = serialized.slice(0, MAX_OUTPUT) + '\n...(truncated)';
    }

    return this.ok(
      toolCallId,
      JSON.stringify({
        sessionId,
        action: 'evaluate',
        result: serialized,
      }),
    );
  }

  // ─── dom ───────────────────────────────────────────────────────────

  private async browserDom(
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const sessionId = args.sessionId as string | undefined;
    const session = getSession(sessionId);
    if (!session) {
      return this.fail(
        toolCallId,
        sessionId
          ? `Session not found or expired: ${sessionId}`
          : 'Missing required parameter: sessionId',
      );
    }

    const waitFor = args.waitFor as string | undefined;
    if (waitFor) {
      await session.page.waitForSelector(waitFor, { timeout: 10_000 });
    }

    const domScript = buildDomExtractionScript(MAX_DOM_DEPTH, MAX_DOM_NODES);
    const domTree = await session.page.evaluate(domScript);

    const title = await session.page.title();

    return this.ok(
      toolCallId,
      JSON.stringify({
        sessionId,
        title,
        url: session.page.url(),
        dom: domTree,
      }),
    );
  }

  // ─── close ─────────────────────────────────────────────────────────

  private async browserClose(
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const sessionId = args.sessionId as string | undefined;

    // If no sessionId, close all sessions
    if (!sessionId) {
      const count = sessions.size;
      for (const [id, session] of sessions) {
        try {
          await session.browser?.close();
        } catch {
          // ignore
        }
        sessions.delete(id);
      }
      return this.ok(
        toolCallId,
        JSON.stringify({ action: 'close', closedSessions: count }),
      );
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return this.fail(toolCallId, `Session not found: ${sessionId}`);
    }

    try {
      await session.browser?.close();
    } catch {
      // ignore
    }
    sessions.delete(sessionId);

    return this.ok(
      toolCallId,
      JSON.stringify({ action: 'close', sessionId }),
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup all sessions on process exit
// ---------------------------------------------------------------------------

process.on('exit', () => {
  for (const [, session] of sessions) {
    session.browser?.close?.().catch(() => {});
  }
  sessions.clear();
});
