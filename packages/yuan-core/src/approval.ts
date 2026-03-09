/**
 * @module approval
 * @description 승인 시스템 — 위험 작업 실행 전 사용자 승인 요청/대기.
 *
 * 플로우:
 * 1. Governor가 위험 작업 감지 (ApprovalRequiredError)
 * 2. ApprovalManager가 승인 요청 이벤트 emit
 * 3. CLI/UI에서 사용자에게 프롬프트 표시
 * 4. 사용자 응답 (approve/reject/always_approve)
 * 5. 결과를 Agent Loop에 반환
 *
 * @see 설계 문서 Section 6.3
 */

import { EventEmitter } from "node:events";
import type { ApprovalAction, PendingAction, ToolCall } from "./types.js";

// ─── Interfaces ───

/** 승인 요청 */
export interface ApprovalRequest {
  /** 고유 ID */
  id: string;
  /** 도구 이름 */
  toolName: string;
  /** 도구 인자 */
  arguments: Record<string, unknown>;
  /** 위험도 */
  riskLevel: "medium" | "high" | "critical";
  /** 승인이 필요한 이유 */
  reason: string;
  /** 변경 미리보기 (file_write/edit의 경우) */
  diff?: string;
  /** 승인 대기 타임아웃 (ms) */
  timeout: number;
}

/** 승인 응답 */
export type ApprovalResponse = "approve" | "reject" | "always_approve";

/**
 * 승인 핸들러 — CLI/UI가 구현.
 * ApprovalManager에 등록하면 승인 요청 시 호출된다.
 */
export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalResponse>;

/** 자동 승인 설정 */
export interface AutoApprovalConfig {
  /** 자동 승인할 액션 목록 */
  autoApprove: ApprovalAction[];
  /** 항상 승인 필요한 액션 목록 (기본: DELETE_FILE, GIT_PUSH, CREATE_PR) */
  requireApproval: ApprovalAction[];
}

/** 도구 → 승인 액션 매핑 규칙 */
interface ToolApprovalRule {
  /** 도구 이름 */
  toolName: string;
  /** 해당 도구에 매핑되는 액션 유형 */
  actionType: ApprovalAction;
  /** 위험도 */
  riskLevel: "medium" | "high" | "critical";
  /** 이 규칙이 적용되는 조건 (인자 기반) */
  condition?: (args: Record<string, unknown>) => boolean;
}

// ─── Constants ───

/** 항상 승인이 필요한 액션 (기본값) */
const ALWAYS_REQUIRE_APPROVAL: ApprovalAction[] = [
  "DELETE_FILE",
  "GIT_PUSH",
  "CREATE_PR",
];

/** 도구별 승인 규칙 */
const TOOL_APPROVAL_RULES: ToolApprovalRule[] = [
  {
    toolName: "file_write",
    actionType: "OVERWRITE_FILE",
    riskLevel: "medium",
    // 기존 파일 덮어쓰기일 때만 (새 파일 생성은 승인 불필요)
    condition: (args) => args.overwrite === true,
  },
  {
    toolName: "shell_exec",
    actionType: "INSTALL_PACKAGE",
    riskLevel: "medium",
    condition: (args) => {
      const cmd = String(args.command ?? args.cmd ?? "");
      const exec = String(args.executable ?? "");
      const full = `${exec} ${cmd}`.trim();
      return (
        /\bnpm\s+install\b/.test(full) ||
        /\bpnpm\s+add\b/.test(full) ||
        /\byarn\s+add\b/.test(full) ||
        /\bpip\s+install\b/.test(full)
      );
    },
  },
  {
    toolName: "shell_exec",
    actionType: "RUN_DANGEROUS_CMD",
    riskLevel: "high",
  },
  {
    toolName: "file_write",
    actionType: "MODIFY_CONFIG",
    riskLevel: "medium",
    condition: (args) => {
      const path = String(args.path ?? args.file ?? "");
      return /(?:tsconfig|package|\.eslintrc|\.prettierrc|webpack|vite)/.test(
        path,
      );
    },
  },
  {
    toolName: "file_edit",
    actionType: "MODIFY_CONFIG",
    riskLevel: "medium",
    condition: (args) => {
      const path = String(args.path ?? args.file ?? "");
      return /(?:tsconfig|package|\.eslintrc|\.prettierrc|webpack|vite)/.test(
        path,
      );
    },
  },
  {
    toolName: "git_ops",
    actionType: "GIT_PUSH",
    riskLevel: "critical",
    condition: (args) => {
      const op = String(args.operation ?? args.op ?? "");
      return op === "push";
    },
  },
];

// ─── ApprovalManager ───

/**
 * ApprovalManager — 위험 작업의 승인 프로세스를 관리.
 *
 * 역할:
 * - 도구 호출이 승인 필요한지 판단
 * - 승인 요청 생성 및 핸들러 호출
 * - always_approve 세션 캐시 관리
 * - 승인 타임아웃 처리
 *
 * @example
 * ```typescript
 * const manager = new ApprovalManager();
 *
 * // CLI에서 핸들러 등록
 * manager.setHandler(async (request) => {
 *   const answer = await askUser(`Approve ${request.reason}? [Y/n/a]`);
 *   if (answer === 'a') return 'always_approve';
 *   return answer === 'n' ? 'reject' : 'approve';
 * });
 *
 * // Agent Loop에서 사용
 * if (manager.needsApproval('file_write', args)) {
 *   const response = await manager.requestApproval(request);
 *   if (response === 'reject') { ... }
 * }
 * ```
 */
export class ApprovalManager extends EventEmitter {
  /** always_approve로 승인된 도구 (세션 내 유지) */
  private readonly alwaysApproved: Set<string> = new Set();
  /** 자동 승인 설정 */
  private readonly autoApproveActions: Set<ApprovalAction>;
  /** 항상 승인 필요한 액션 */
  private readonly requireApprovalActions: Set<ApprovalAction>;
  /** 승인 핸들러 (CLI/UI가 등록) */
  private handler: ApprovalHandler | null = null;
  /** 기본 타임아웃 (ms) */
  private readonly defaultTimeout: number;

  constructor(config?: Partial<AutoApprovalConfig>, defaultTimeout = 120_000) {
    super();
    this.autoApproveActions = new Set(config?.autoApprove ?? []);
    this.requireApprovalActions = new Set(
      config?.requireApproval ?? ALWAYS_REQUIRE_APPROVAL,
    );
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * 승인 핸들러 등록.
   * CLI에서 readline 기반 프롬프트, UI에서 웹소켓 기반 프롬프트를 구현한다.
   * @param handler 승인 요청을 처리할 함수
   */
  setHandler(handler: ApprovalHandler): void {
    this.handler = handler;
  }

  /**
   * 도구 호출이 승인 필요한지 판단.
   * @param toolName 도구 이름
   * @param args 도구 인자
   * @returns 승인이 필요하면 해당 ApprovalRequest 정보, 불필요하면 null
   */
  checkApproval(
    toolName: string,
    args: Record<string, unknown>,
  ): ApprovalRequest | null {
    // always_approve된 도구는 스킵
    const toolKey = this.buildToolKey(toolName, args);
    if (this.alwaysApproved.has(toolName) || this.alwaysApproved.has(toolKey)) {
      return null;
    }

    // 승인 규칙 매칭
    for (const rule of TOOL_APPROVAL_RULES) {
      if (rule.toolName !== toolName) continue;

      // 조건이 있으면 평가
      if (rule.condition && !rule.condition(args)) continue;

      // 자동 승인 액션이면 스킵
      if (
        this.autoApproveActions.has(rule.actionType) &&
        !this.requireApprovalActions.has(rule.actionType)
      ) {
        return null;
      }

      // 승인 필요
      const request: ApprovalRequest = {
        id: crypto.randomUUID(),
        toolName,
        arguments: args,
        riskLevel: rule.riskLevel,
        reason: this.buildReason(rule.actionType, toolName, args),
        diff: this.extractDiff(toolName, args),
        timeout: this.defaultTimeout,
      };

      return request;
    }

    return null;
  }

  /**
   * 승인 필요 여부를 간단히 확인하는 편의 메서드.
   * @param toolName 도구 이름
   * @param args 도구 인자
   * @returns 승인이 필요하면 true
   */
  needsApproval(
    toolName: string,
    args: Record<string, unknown>,
  ): boolean {
    return this.checkApproval(toolName, args) !== null;
  }

  /**
   * 승인 요청을 핸들러에 전달하고 응답을 반환.
   * 핸들러가 없으면 기본적으로 reject.
   * @param request 승인 요청
   * @returns 승인 응답
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    this.emit("approval:requested", request);

    if (!this.handler) {
      // 핸들러 미등록 → reject (안전 기본값)
      this.emit("approval:no_handler", request);
      return "reject";
    }

    // 타임아웃 처리 — clear timer after race resolves to prevent leak
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<ApprovalResponse>((resolve) => {
      timer = setTimeout(() => {
        this.emit("approval:timeout", request.id);
        resolve("reject");
      }, request.timeout);
    });

    const response = await Promise.race([
      this.handler(request),
      timeoutPromise,
    ]);

    clearTimeout(timer);

    // always_approve 처리
    if (response === "always_approve") {
      this.addAlwaysApprove(request.toolName);
      this.emit("approval:always_approved", request.toolName);
    }

    this.emit("approval:responded", { request, response });
    return response;
  }

  /**
   * 도구를 always_approve 목록에 추가.
   * 세션 내에서 해당 도구의 모든 호출이 자동 승인된다.
   * @param toolName 도구 이름
   */
  addAlwaysApprove(toolName: string): void {
    this.alwaysApproved.add(toolName);
  }

  /**
   * always_approve 목록을 초기화.
   */
  clearAlwaysApproved(): void {
    this.alwaysApproved.clear();
  }

  /**
   * 현재 always_approve 목록을 반환.
   */
  getAlwaysApproved(): ReadonlySet<string> {
    return this.alwaysApproved;
  }

  /**
   * ToolCall에서 PendingAction을 생성하는 헬퍼.
   * AgentLoop에서 agent:approval_needed 이벤트 emit에 사용.
   */
  buildPendingAction(
    toolCall: ToolCall,
    request: ApprovalRequest,
  ): PendingAction {
    return {
      id: request.id,
      type: this.resolveActionType(request.toolName, request.arguments),
      description: request.reason,
      details: request.arguments,
      risk: request.riskLevel === "critical" ? "high" : request.riskLevel,
      timeout: request.timeout,
    };
  }

  // ─── Private ───

  private buildToolKey(
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    const path = String(args.path ?? args.file ?? "");
    return path ? `${toolName}:${path}` : toolName;
  }

  private buildReason(
    actionType: ApprovalAction,
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    const path = String(args.path ?? args.file ?? "");

    switch (actionType) {
      case "DELETE_FILE":
        return `File deletion: ${path}`;
      case "OVERWRITE_FILE":
        return `File overwrite: ${path}`;
      case "INSTALL_PACKAGE": {
        const cmd = String(args.command ?? args.cmd ?? "");
        return `Package installation: ${cmd}`;
      }
      case "RUN_DANGEROUS_CMD": {
        const cmd = String(args.command ?? args.cmd ?? "");
        return `Dangerous command: ${cmd}`;
      }
      case "MODIFY_CONFIG":
        return `Config file modification: ${path}`;
      case "GIT_PUSH":
        return "Git push to remote";
      case "CREATE_PR":
        return "Pull request creation";
      default:
        return `${toolName} requires approval`;
    }
  }

  private extractDiff(
    toolName: string,
    args: Record<string, unknown>,
  ): string | undefined {
    if (toolName === "file_write") {
      const content = String(args.content ?? "");
      return content.length > 500 ? content.slice(0, 500) + "\n..." : content;
    }
    if (toolName === "file_edit") {
      const old = String(args.old_string ?? args.old ?? "");
      const newStr = String(args.new_string ?? args.new ?? "");
      return `--- old\n${old}\n+++ new\n${newStr}`;
    }
    return undefined;
  }

  private resolveActionType(
    toolName: string,
    args: Record<string, unknown>,
  ): ApprovalAction {
    for (const rule of TOOL_APPROVAL_RULES) {
      if (rule.toolName !== toolName) continue;
      if (rule.condition && !rule.condition(args)) continue;
      return rule.actionType;
    }
    return "RUN_DANGEROUS_CMD";
  }

}
