/**
 * @module design-loop
 * @description Design Mode Agent Loop — AgentLoop를 확장하여 디자인 전용 동작을 추가.
 *
 * AgentLoop의 private 멤버에 접근할 수 없으므로, 다음 전략으로 디자인 로직을 주입:
 * 1. 시스템 프롬프트에 DESIGN_SYSTEM_PROMPT를 합성 (생성자에서)
 * 2. toolExecutor를 래핑하여 파일 편집 시 경로 검증 + 보안 스캔 수행
 * 3. 사용자 메시지에 DOM 컨텍스트를 자동 주입 (run() 오버라이드)
 * 4. 디자인 전용 이벤트를 emit
 */

import { AgentLoop, type AgentLoopOptions } from "./agent-loop.js";
import type {
  AgentConfig,
  AgentTermination,
  DesignSessionConfig,
  DOMSnapshot,
  DesignEvent,
  DesignEventType,
  ToolCall,
  ToolResult,
  ToolExecutor,
} from "./types.js";
import {
  DESIGN_ALLOWED_PATHS,
  DESIGN_BLOCKED_PATHS,
  DESIGN_SECURITY_PATTERNS,
} from "./constants.js";

// ─── Design System Prompt ───

const DESIGN_SYSTEM_PROMPT = `
## Design Mode — Active

You are operating in **Design Mode**. Your purpose is to help the user visually design and refine their frontend UI by editing source files and observing live results.

### Available Design Tools
- **design_snapshot** — Capture current DOM accessibility tree
- **design_screenshot** — Capture a visual screenshot of the current page
- **design_navigate** — Navigate the browser to a URL
- **design_resize** — Resize the browser viewport
- **design_inspect** — Inspect a specific DOM element
- **design_scroll** — Scroll the page

### Design Mode Rules
1. **Allowed paths only** — You may ONLY modify files under: ${DESIGN_ALLOWED_PATHS.join(", ")}
2. **Blocked paths** — NEVER modify: ${DESIGN_BLOCKED_PATHS.join(", ")}
3. **Security checks** — Before writing any file:
   - No \`dangerouslySetInnerHTML\` unless explicitly requested
   - No inline event handlers (\`onclick=\`, \`onerror=\`, etc.)
   - No \`javascript:\` URLs
   - No inline \`<script>\` tags
   - Avoid inline \`style=\` attributes (prefer CSS classes/modules)
   - No template literal injection with user input
4. **Show diffs** — Always show the diff of every file change so the user can review
5. **Live preview** — After editing, take a snapshot or screenshot to verify the visual result
6. **Iterative refinement** — Make small, incremental changes. Check the result after each edit.
`.trim();

// ─── Types ───

/** DesignLoop 생성 옵션 */
export interface DesignLoopOptions extends AgentLoopOptions {
  /** Design Mode 세션 설정 */
  designConfig: DesignSessionConfig;
  /** DOM 스냅샷 콜백 (브라우저에서 접근성 트리 가져오기) */
  getSnapshot: () => Promise<DOMSnapshot>;
  /** 스크린샷 콜백 (base64 이미지 반환, 선택) */
  getScreenshot?: () => Promise<string>;
}

/** 보안 스캔 경고 */
interface SecurityWarning {
  category: string;
  pattern: string;
  line: number;
  content: string;
}

// ─── DesignLoop ───

/**
 * DesignLoop — Design Mode 전용 Agent Loop.
 *
 * AgentLoop를 확장하여:
 * - 디자인 시스템 프롬프트 주입
 * - DOM 컨텍스트 자동 주입 (run 오버라이드)
 * - 파일 편집 경로 검증 (toolExecutor 래핑)
 * - 보안 패턴 스캔 (파일 쓰기 후)
 * - 디자인 전용 이벤트 emit
 */
export class DesignLoop extends AgentLoop {
  private readonly designConfig: DesignSessionConfig;
  private readonly getSnapshot: () => Promise<DOMSnapshot>;
  private readonly getScreenshot?: () => Promise<string>;

  constructor(options: DesignLoopOptions) {
    // 1. 시스템 프롬프트에 Design Mode 프롬프트를 합성
    const enhancedConfig = DesignLoop.injectDesignPrompt(
      options.config,
      options.designConfig,
    );

    // 2. toolExecutor를 래핑하여 경로 검증 + 보안 스캔 추가
    const wrappedExecutor = DesignLoop.wrapToolExecutor(
      options.toolExecutor,
      options.designConfig,
      // emit 콜백은 생성 후 바인딩 (아래에서 설정)
      () => {},
    );

    // AgentLoop 생성
    super({
      ...options,
      config: enhancedConfig,
      toolExecutor: wrappedExecutor,
    });

    this.designConfig = options.designConfig;
    this.getSnapshot = options.getSnapshot;
    this.getScreenshot = options.getScreenshot;

    // 3. emit 콜백을 실제 인스턴스로 바인딩
    wrappedExecutor._setEmitCallback((event: DesignEvent) => {
      this.emitDesignEvent(event);
    });
  }

  /**
   * run()을 오버라이드하여 DOM 컨텍스트를 사용자 메시지 앞에 주입.
   */
  override async run(userMessage: string): Promise<AgentTermination> {
    // DOM 스냅샷 가져와서 컨텍스트로 주입
    let contextPrefix = "";

    try {
      const snapshot = await this.getSnapshot();
      contextPrefix += `\n[Design Context — DOM Snapshot]\nURL: ${snapshot.url}\nTitle: ${snapshot.title}\nTimestamp: ${new Date(snapshot.timestamp).toISOString()}\n\nAccessibility Tree:\n${truncate(snapshot.accessibilityTree, 8000)}\n`;

      this.emitDesignEvent({
        type: "design:dom_snapshot",
        data: { url: snapshot.url, title: snapshot.title },
        timestamp: Date.now(),
      });
    } catch {
      // 스냅샷 실패 시 무시하고 진행
      contextPrefix += "\n[Design Context — DOM snapshot unavailable]\n";
    }

    // 스크린샷이 가능하면 추가
    if (this.getScreenshot && this.designConfig.autoVision) {
      try {
        const screenshot = await this.getScreenshot();
        contextPrefix += `\n[Design Context — Screenshot captured (base64, ${Math.round(screenshot.length / 1024)}KB)]\n`;

        this.emitDesignEvent({
          type: "design:screenshot",
          data: { sizeKB: Math.round(screenshot.length / 1024) },
          timestamp: Date.now(),
        });
      } catch {
        // 스크린샷 실패 시 무시
      }
    }

    // 컨텍스트를 사용자 메시지에 합성
    const enrichedMessage = contextPrefix
      ? `${contextPrefix}\n---\n\n${userMessage}`
      : userMessage;

    return super.run(enrichedMessage);
  }

  /**
   * 현재 디자인 설정을 반환.
   */
  getDesignConfig(): Readonly<DesignSessionConfig> {
    return { ...this.designConfig };
  }

  // ─── Static Helpers ───

  /**
   * AgentConfig의 시스템 프롬프트에 디자인 프롬프트를 주입.
   */
  private static injectDesignPrompt(
    config: AgentConfig,
    designConfig: DesignSessionConfig,
  ): AgentConfig {
    const viewportInfo = designConfig.viewport
      ? `\nCurrent viewport: ${designConfig.viewport.width}x${designConfig.viewport.height}`
      : "";

    const designPromptSection = `\n\n${DESIGN_SYSTEM_PROMPT}\n\n### Project Context\n- Working directory: ${designConfig.workDir}${viewportInfo}\n`;

    return {
      ...config,
      loop: {
        ...config.loop,
        systemPrompt: config.loop.systemPrompt + designPromptSection,
      },
    };
  }

  /**
   * ToolExecutor를 래핑하여 파일 편집 도구 호출 시 경로 검증 + 보안 스캔을 수행.
   * emit 콜백은 나중에 _setEmitCallback으로 바인딩.
   */
  private static wrapToolExecutor(
    original: ToolExecutor,
    designConfig: DesignSessionConfig,
    emitCallback: (event: DesignEvent) => void,
  ): WrappedToolExecutor {
    return new WrappedToolExecutor(original, designConfig, emitCallback);
  }

  /**
   * 디자인 이벤트를 emit.
   */
  private emitDesignEvent(event: DesignEvent): void {
    this.emit("design_event", event);
    // 기존 이벤트 버스와도 호환 (agent:error 등으로 변환 가능)
    this.emit("event", {
      kind: "agent:thinking" as const,
      content: `[Design] ${event.type}: ${JSON.stringify(event.data)}`,
    });
  }
}

// ─── Wrapped Tool Executor ───

/**
 * ToolExecutor를 래핑하여 Design Mode 전용 검증을 추가하는 내부 클래스.
 */
class WrappedToolExecutor implements ToolExecutor {
  readonly definitions: ToolExecutor["definitions"];
  private readonly original: ToolExecutor;
  private readonly designConfig: DesignSessionConfig;
  private emitCallback: (event: DesignEvent) => void;

  constructor(
    original: ToolExecutor,
    designConfig: DesignSessionConfig,
    emitCallback: (event: DesignEvent) => void,
  ) {
    this.original = original;
    this.definitions = original.definitions;
    this.designConfig = designConfig;
    this.emitCallback = emitCallback;
  }

  /**
   * emit 콜백을 (재)설정. DesignLoop 인스턴스 생성 후 바인딩용.
   */
  _setEmitCallback(cb: (event: DesignEvent) => void): void {
    this.emitCallback = cb;
  }

  async execute(call: ToolCall, abortSignal?: AbortSignal): Promise<ToolResult> {
    const args = this.parseArgs(call.arguments);

    // 파일 수정 도구인 경우 경로 검증
    if (isFileWriteTool(call.name)) {
      const filePath = extractFilePath(args);

      if (filePath) {
        // 1. 차단 경로 체크
        const blockedPath = this.isBlockedPath(filePath);
        if (blockedPath) {
          return {
            tool_call_id: call.id,
            name: call.name,
            output: `[DESIGN MODE BLOCKED] Cannot modify "${filePath}" — path is blocked in Design Mode (matched: ${blockedPath}). Only files under ${DESIGN_ALLOWED_PATHS.join(", ")} are allowed.`,
            success: false,
            durationMs: 0,
          };
        }

        // 2. 허용 경로 체크
        if (!this.isAllowedPath(filePath)) {
          return {
            tool_call_id: call.id,
            name: call.name,
            output: `[DESIGN MODE BLOCKED] Cannot modify "${filePath}" — not under an allowed path. Allowed: ${DESIGN_ALLOWED_PATHS.join(", ")}`,
            success: false,
            durationMs: 0,
          };
        }
      }
    }

    // 원래 도구 실행
    const result = await this.original.execute(call, abortSignal);

    // 파일 수정 도구 성공 시 보안 스캔
    if (isFileWriteTool(call.name) && result.success) {
      const content = extractFileContent(args);
      if (content) {
        const warnings = scanForSecurityIssues(content);
        if (warnings.length > 0) {
          const warningText = warnings
            .map(
              (w) =>
                `  [${w.category.toUpperCase()}] Line ${w.line}: ${w.content.trim()} (pattern: ${w.pattern})`,
            )
            .join("\n");

          // 보안 경고 이벤트 emit
          this.emitCallback({
            type: "design:security_warning",
            data: { warnings, filePath: extractFilePath(args) },
            timestamp: Date.now(),
          });

          // 결과에 경고 추가 (LLM이 인지하도록)
          result.output += `\n\n⚠️ DESIGN MODE SECURITY WARNINGS:\n${warningText}\n\nPlease review and fix these security issues before proceeding.`;
        }
      }

      // 파일 변경 이벤트
      const filePath = extractFilePath(args);
      if (filePath) {
        this.emitCallback({
          type: "design:file_changed",
          data: { path: filePath },
          timestamp: Date.now(),
        });
      }
    }

    return result;
  }

  /**
   * 경로가 차단 목록에 해당하는지 검사.
   */
  private isBlockedPath(filePath: string): string | null {
    // workDir 기준으로 상대 경로 계산
    const relative = this.toRelative(filePath);

    for (const blocked of DESIGN_BLOCKED_PATHS) {
      if (relative === blocked || relative.startsWith(blocked)) {
        return blocked;
      }
    }
    return null;
  }

  /**
   * 경로가 허용 목록에 해당하는지 검사.
   */
  private isAllowedPath(filePath: string): boolean {
    const relative = this.toRelative(filePath);

    for (const allowed of DESIGN_ALLOWED_PATHS) {
      if (relative.startsWith(allowed)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 절대 경로를 workDir 기준 상대 경로로 변환.
   */
  private toRelative(filePath: string): string {
    const workDir = this.designConfig.workDir.endsWith("/")
      ? this.designConfig.workDir
      : this.designConfig.workDir + "/";

    if (filePath.startsWith(workDir)) {
      return filePath.slice(workDir.length);
    }
    return filePath;
  }

  /**
   * 도구 인자를 파싱.
   */
  private parseArgs(
    args: string | Record<string, unknown>,
  ): Record<string, unknown> {
    if (typeof args === "string") {
      try {
        return JSON.parse(args) as Record<string, unknown>;
      } catch {
        return { raw: args };
      }
    }
    return args;
  }
}

// ─── Utility Functions ───

/** 파일 수정 도구인지 확인 */
function isFileWriteTool(toolName: string): boolean {
  return ["file_write", "file_edit"].includes(toolName);
}

/** 도구 인자에서 파일 경로 추출 */
function extractFilePath(args: Record<string, unknown>): string | null {
  const path =
    (args.path as string) ??
    (args.file as string) ??
    (args.file_path as string) ??
    null;
  return path;
}

/** 도구 인자에서 파일 내용 추출 */
function extractFileContent(args: Record<string, unknown>): string | null {
  const content =
    (args.content as string) ??
    (args.new_string as string) ??
    (args.text as string) ??
    null;
  return content;
}

/** 문자열 길이 제한 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... (truncated, ${str.length} total chars)`;
}

/**
 * 파일 내용에서 보안 문제를 스캔.
 * DESIGN_SECURITY_PATTERNS의 xss/csp/injection 패턴을 검사.
 */
function scanForSecurityIssues(content: string): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];
  const lines = content.split("\n");

  for (const [category, patterns] of Object.entries(DESIGN_SECURITY_PATTERNS)) {
    for (const pattern of patterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          warnings.push({
            category,
            pattern: pattern.source,
            line: i + 1,
            content: lines[i],
          });
        }
      }
    }
  }

  return warnings;
}
