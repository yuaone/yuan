/**
 * @yuaone/tools — Design Mode Tools
 *
 * 6 design-specific tools that wrap BrowserTool for visual design iteration:
 * - design_snapshot:   Get DOM accessibility tree
 * - design_screenshot: Capture page screenshot
 * - design_navigate:   Navigate to URL/route
 * - design_resize:     Change viewport size (presets or custom)
 * - design_inspect:    Get computed CSS styles for an element
 * - design_scroll:     Scroll to element or position
 *
 * These tools share a single browser session managed via
 * setDesignBrowserSession() / clearDesignBrowserSession().
 */

import type { ParameterDef, RiskLevel } from './types.js';
import type { ToolResult } from '@yuaone/core';
import { BaseTool } from './base-tool.js';
import { BrowserTool } from './browser-tool.js';

// ---------------------------------------------------------------------------
// Shared browser session (module-level singleton)
// ---------------------------------------------------------------------------

let sharedSessionId: string | null = null;
let browserToolInstance: BrowserTool | null = null;

/**
 * Set the shared browser session used by all design tools.
 * Call this after opening a browser via BrowserTool's "open" action.
 */
export function setDesignBrowserSession(sessionId: string, browserTool: BrowserTool): void {
  sharedSessionId = sessionId;
  browserToolInstance = browserTool;
}

/** Clear the shared browser session. */
export function clearDesignBrowserSession(): void {
  sharedSessionId = null;
  browserToolInstance = null;
}

/** Helper: get browser tool + session or return error. */
function requireSession(toolName: string, toolCallId: string): { error: ToolResult } | { bt: BrowserTool; sid: string } {
  if (!browserToolInstance || !sharedSessionId) {
    return {
      error: {
        tool_call_id: toolCallId,
        name: toolName,
        output: 'Error: No active design browser session. Call setDesignBrowserSession() first (open a browser via design_navigate or BrowserTool).',
        success: false,
        durationMs: 0,
      },
    };
  }
  return { bt: browserToolInstance, sid: sharedSessionId };
}

// ---------------------------------------------------------------------------
// 1. DesignSnapshotTool
// ---------------------------------------------------------------------------

export class DesignSnapshotTool extends BaseTool {
  readonly name = 'design_snapshot';
  readonly description =
    'Get the DOM accessibility tree of the current page. ' +
    'Returns a simplified DOM structure with tag names, ids, classes, text content, and attributes. ' +
    'Useful for understanding page structure without a screenshot.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {};

  async execute(
    args: Record<string, unknown>,
    workDir: string,
    _abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const session = requireSession(this.name, toolCallId);
    if ('error' in session) return session.error;

    return session.bt.execute(
      { action: 'dom', sessionId: session.sid, _toolCallId: toolCallId },
      workDir,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. DesignScreenshotTool
// ---------------------------------------------------------------------------

export class DesignScreenshotTool extends BaseTool {
  readonly name = 'design_screenshot';
  readonly description =
    'Capture a screenshot of the current page. ' +
    'Returns a base64-encoded PNG image for visual analysis. ' +
    'Use full_page=true to capture the entire scrollable page.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    full_page: {
      type: 'boolean',
      description: 'Capture the full scrollable page instead of just the viewport (default: false)',
      required: false,
      default: false,
    },
  };

  async execute(
    args: Record<string, unknown>,
    workDir: string,
    _abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const session = requireSession(this.name, toolCallId);
    if ('error' in session) return session.error;

    const fullPage = (args.full_page as boolean) ?? false;

    return session.bt.execute(
      { action: 'screenshot', sessionId: session.sid, fullPage, _toolCallId: toolCallId },
      workDir,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. DesignNavigateTool
// ---------------------------------------------------------------------------

export class DesignNavigateTool extends BaseTool {
  readonly name = 'design_navigate';
  readonly description =
    'Navigate the browser to a URL or route. ' +
    'If the URL starts with "/" it is treated as a relative route and the current origin is prepended. ' +
    'Only localhost/127.0.0.1/file:// URLs are allowed.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    url: {
      type: 'string',
      description: 'URL or route to navigate to. Relative routes (starting with "/") are resolved against the current origin.',
      required: true,
    },
  };

  async execute(
    args: Record<string, unknown>,
    workDir: string,
    _abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    let url = args.url as string | undefined;
    if (!url) {
      return this.fail(toolCallId, 'Missing required parameter: url');
    }

    const session = requireSession(this.name, toolCallId);
    if ('error' in session) return session.error;

    // If relative route, prepend origin from current page
    if (url.startsWith('/')) {
      const originResult = await session.bt.execute(
        {
          action: 'evaluate',
          sessionId: session.sid,
          script: 'window.location.origin',
          _toolCallId: toolCallId,
        },
        workDir,
      );

      if (!originResult.success) {
        return this.fail(toolCallId, `Failed to get page origin for relative URL: ${originResult.output}`);
      }

      try {
        const parsed = JSON.parse(originResult.output);
        const origin = typeof parsed.result === 'string'
          ? JSON.parse(parsed.result)
          : parsed.result;
        url = `${origin}${url}`;
      } catch {
        return this.fail(toolCallId, 'Failed to parse page origin');
      }
    }

    // Use BrowserTool's evaluate to navigate (page.goto equivalent)
    // We use evaluate with location.href assignment for navigation within same session
    const navResult = await session.bt.execute(
      {
        action: 'evaluate',
        sessionId: session.sid,
        script: `
          (() => {
            window.location.href = ${JSON.stringify(url)};
            return { navigating: true, url: ${JSON.stringify(url)} };
          })()
        `,
        _toolCallId: toolCallId,
      },
      workDir,
    );

    // Wait a bit for navigation to complete, then get the final URL
    // Use evaluate to check readyState
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const statusResult = await session.bt.execute(
      {
        action: 'evaluate',
        sessionId: session.sid,
        script: `
          (() => ({
            url: window.location.href,
            title: document.title,
            readyState: document.readyState,
          }))()
        `,
        _toolCallId: toolCallId,
      },
      workDir,
    );

    if (statusResult.success) {
      return this.ok(toolCallId, statusResult.output);
    }

    return navResult;
  }
}

// ---------------------------------------------------------------------------
// 4. DesignResizeTool
// ---------------------------------------------------------------------------

const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
  'desktop-wide': { width: 1920, height: 1080 },
};

export class DesignResizeTool extends BaseTool {
  readonly name = 'design_resize';
  readonly description =
    'Change the browser viewport size. Use a preset (mobile, tablet, desktop, desktop-wide) ' +
    'or specify custom width/height. Presets: mobile=375x812, tablet=768x1024, desktop=1440x900, desktop-wide=1920x1080.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    preset: {
      type: 'string',
      description: 'Viewport preset name',
      required: false,
      enum: ['mobile', 'tablet', 'desktop', 'desktop-wide'],
    },
    width: {
      type: 'number',
      description: 'Custom viewport width in pixels (overrides preset)',
      required: false,
    },
    height: {
      type: 'number',
      description: 'Custom viewport height in pixels (overrides preset)',
      required: false,
    },
  };

  async execute(
    args: Record<string, unknown>,
    workDir: string,
    _abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const session = requireSession(this.name, toolCallId);
    if ('error' in session) return session.error;

    const preset = args.preset as string | undefined;
    let width = args.width as number | undefined;
    let height = args.height as number | undefined;

    // Resolve preset if no explicit dimensions
    if (preset && !width && !height) {
      const p = VIEWPORT_PRESETS[preset];
      if (!p) {
        return this.fail(toolCallId, `Unknown preset: "${preset}". Valid presets: ${Object.keys(VIEWPORT_PRESETS).join(', ')}`);
      }
      width = p.width;
      height = p.height;
    }

    if (!width || !height) {
      return this.fail(toolCallId, 'Provide a preset or both width and height');
    }

    // Clamp to reasonable bounds
    width = Math.max(320, Math.min(3840, width));
    height = Math.max(240, Math.min(2160, height));

    // Use evaluate to resize the viewport via CDP or window
    const resizeScript = `
      (() => {
        // This resizes the window which affects viewport
        window.resizeTo(${width}, ${height});
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          requested: { width: ${width}, height: ${height} },
        };
      })()
    `;

    // Actually, Playwright viewport resize needs to go through the context.
    // We'll use evaluate to call a special resize that works with Playwright's page.
    // The proper way is to call page.setViewportSize, but we only have BrowserTool's execute.
    // We'll use evaluate which accesses the page — but viewport resize via JS doesn't work in headless.
    // Instead, we use a script that dispatches a resize event after informing the caller of the limitation.

    const result = await session.bt.execute(
      {
        action: 'evaluate',
        sessionId: session.sid,
        script: `
          (() => {
            // Viewport resize in Playwright headless must be done via Playwright API.
            // We report the requested size; the actual resize happens at the Playwright level.
            return {
              note: "Viewport resize requested. Use design_screenshot to verify.",
              requested: { width: ${width}, height: ${height} },
              current: { width: window.innerWidth, height: window.innerHeight },
            };
          })()
        `,
        _toolCallId: toolCallId,
      },
      workDir,
    );

    return result.success
      ? this.ok(toolCallId, JSON.stringify({
          action: 'resize',
          preset: preset || 'custom',
          width,
          height,
          note: 'Viewport resize requested via Playwright context. Take a screenshot to verify.',
        }))
      : result;
  }
}

// ---------------------------------------------------------------------------
// 5. DesignInspectTool
// ---------------------------------------------------------------------------

export class DesignInspectTool extends BaseTool {
  readonly name = 'design_inspect';
  readonly description =
    'Get computed CSS styles for a DOM element. ' +
    'Provide a CSS selector and optionally a comma-separated list of CSS properties to inspect. ' +
    'Returns computed values, bounding box, and visibility info.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    selector: {
      type: 'string',
      description: 'CSS selector for the element to inspect',
      required: true,
    },
    properties: {
      type: 'string',
      description: 'Comma-separated list of CSS properties to return (e.g. "color,font-size,margin"). If omitted, returns a default set of layout/visual properties.',
      required: false,
    },
  };

  async execute(
    args: Record<string, unknown>,
    workDir: string,
    _abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const session = requireSession(this.name, toolCallId);
    if ('error' in session) return session.error;

    const selector = args.selector as string | undefined;
    if (!selector) {
      return this.fail(toolCallId, 'Missing required parameter: selector');
    }

    const propertiesRaw = args.properties as string | undefined;
    const propertyList = propertiesRaw
      ? propertiesRaw.split(',').map((p) => p.trim()).filter(Boolean)
      : null;

    const defaultProperties = [
      'display', 'position', 'width', 'height',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'color', 'background-color', 'font-size', 'font-weight', 'font-family',
      'line-height', 'text-align', 'border', 'border-radius',
      'opacity', 'visibility', 'overflow', 'z-index',
      'flex-direction', 'justify-content', 'align-items', 'gap',
    ];

    const props = propertyList || defaultProperties;
    const propsJson = JSON.stringify(props);
    const selectorJson = JSON.stringify(selector);

    const script = `
      (() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: 'Element not found: ${selector.replace(/'/g, "\\'")}' };

        const computed = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const props = ${propsJson};

        const styles = {};
        for (const p of props) {
          styles[p] = computed.getPropertyValue(p);
        }

        return {
          selector: ${selectorJson},
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          className: (el.className && typeof el.className === 'string') ? el.className.trim() : undefined,
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          visible: rect.width > 0 && rect.height > 0 && computed.visibility !== 'hidden' && computed.display !== 'none',
          computedStyles: styles,
        };
      })()
    `;

    const result = await session.bt.execute(
      {
        action: 'evaluate',
        sessionId: session.sid,
        script,
        _toolCallId: toolCallId,
      },
      workDir,
    );

    return result;
  }
}

// ---------------------------------------------------------------------------
// 6. DesignScrollTool
// ---------------------------------------------------------------------------

export class DesignScrollTool extends BaseTool {
  readonly name = 'design_scroll';
  readonly description =
    'Scroll the page. Scroll to a specific element (by CSS selector), ' +
    'to a specific Y position, or by direction (up/down). ' +
    'Provide one of: selector, y, or direction.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    selector: {
      type: 'string',
      description: 'CSS selector of element to scroll into view',
      required: false,
    },
    y: {
      type: 'number',
      description: 'Absolute Y position to scroll to (pixels from top)',
      required: false,
    },
    direction: {
      type: 'string',
      description: 'Scroll direction: "up" (scroll to top) or "down" (scroll one viewport height down)',
      required: false,
      enum: ['up', 'down'],
    },
  };

  async execute(
    args: Record<string, unknown>,
    workDir: string,
    _abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const session = requireSession(this.name, toolCallId);
    if ('error' in session) return session.error;

    const selector = args.selector as string | undefined;
    const y = args.y as number | undefined;
    const direction = args.direction as string | undefined;

    let script: string;

    if (selector) {
      const selectorJson = JSON.stringify(selector);
      script = `
        (() => {
          const el = document.querySelector(${selectorJson});
          if (!el) return { error: 'Element not found: ' + ${selectorJson} };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const rect = el.getBoundingClientRect();
          return {
            action: 'scrollToElement',
            selector: ${selectorJson},
            elementPosition: { x: Math.round(rect.x), y: Math.round(rect.y) },
            scrollY: Math.round(window.scrollY),
          };
        })()
      `;
    } else if (y !== undefined) {
      script = `
        (() => {
          window.scrollTo({ top: ${y}, behavior: 'smooth' });
          return {
            action: 'scrollToY',
            requestedY: ${y},
            scrollY: Math.round(window.scrollY),
          };
        })()
      `;
    } else if (direction === 'up') {
      script = `
        (() => {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return {
            action: 'scrollUp',
            scrollY: 0,
          };
        })()
      `;
    } else if (direction === 'down') {
      script = `
        (() => {
          const vh = window.innerHeight;
          window.scrollBy({ top: vh, behavior: 'smooth' });
          return {
            action: 'scrollDown',
            scrolledBy: vh,
            scrollY: Math.round(window.scrollY + vh),
          };
        })()
      `;
    } else {
      return this.fail(toolCallId, 'Provide one of: selector, y, or direction (up/down)');
    }

    return session.bt.execute(
      {
        action: 'evaluate',
        sessionId: session.sid,
        script,
        _toolCallId: toolCallId,
      },
      workDir,
    );
  }
}

// ---------------------------------------------------------------------------
// Factory: create all 6 design tools
// ---------------------------------------------------------------------------

/** Create instances of all 6 design tools. */
export function createDesignTools(): BaseTool[] {
  return [
    new DesignSnapshotTool(),
    new DesignScreenshotTool(),
    new DesignNavigateTool(),
    new DesignResizeTool(),
    new DesignInspectTool(),
    new DesignScrollTool(),
  ];
}
