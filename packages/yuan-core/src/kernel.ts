/**
 * @module kernel
 * @description YUAN Agent Kernel — 4 Core Abstractions (SSOT)
 *
 * 1. AgentSession (KernelSession) — 실행 단위의 단일 진실 원본
 * 2. PlanGraph (PlanGraphManager) — 계획의 운영 상태 관리
 * 3. ToolContract (ToolContractRegistry) — 도구 계약 SSOT
 * 4. EventLog — 모든 것을 이벤트로 기록
 *
 * 이 파일의 인터페이스와 클래스를 시스템 전체에서 SSOT로 참조한다.
 */

import type { ExecutionPlan, ToolDefinition } from "./types.js";

// ══════════════════════════════════════════════════════════════════════
// 1. AGENT SESSION — 에이전트 실행의 단일 진실 원본
// ══════════════════════════════════════════════════════════════════════

/** 승인 대기 정보 */
export interface PendingApprovalInfo {
  /** 고유 ID */
  id: string;
  /** 도구 이름 */
  toolName: string;
  /** 도구 인자 */
  toolInput: Record<string, unknown>;
  /** 위험도 */
  risk: "low" | "medium" | "high" | "critical";
  /** 유저에게 보여줄 설명 */
  description: string;
  /** 요청 시각 (epoch ms) */
  requestedAt: number;
  /** 타임아웃 (ms) */
  timeoutMs: number;
}

/** 승인 기록 */
export interface ApprovalRecord {
  /** 고유 ID */
  id: string;
  /** 도구 이름 */
  toolName: string;
  /** 위험도 */
  risk: string;
  /** 유저 응답 */
  response: "approve" | "reject" | "always_approve";
  /** 응답 시각 (epoch ms) */
  respondedAt: number;
}

/** 세션 체크포인트 — 복구 지점 */
export interface SessionCheckpoint {
  /** 체크포인트 ID */
  id: string;
  /** 생성 시각 (epoch ms) */
  timestamp: number;
  /** 체크포인트 시점의 phase */
  phase: string;
  /** 반복 횟수 */
  iterationCount: number;
  /** 토큰 사용량 */
  tokenUsage: { input: number; output: number };
  /** 변경된 파일 경로 목록 */
  changedFiles: string[];
  /** 체크포인트 요약 */
  summary: string;
  /** 작업 메모리 (자유 형식) */
  workingMemory: Record<string, unknown>;
}

/**
 * KernelSession — 에이전트 실행 단위의 전체 상태.
 *
 * AgentLoop, Governor, Planner 등 모든 모듈이 이 인터페이스를 통해
 * 세션 상태를 조회/변경한다.
 */
export interface KernelSession {
  /** 세션 고유 ID */
  id: string;
  /** 실행 고유 ID (같은 세션의 재실행 구분) */
  runId: string;

  // ─── Goal ───
  /** 에이전트에게 주어진 목표 */
  goal: string;
  /** 실행 모드 ("code" | "review" | "debug" 등) */
  mode: string;

  // ─── Project ───
  /** 프로젝트 루트 경로 */
  projectPath: string;
  /** 프로젝트 이름 */
  projectName: string;

  // ─── State ───
  /** 현재 상태 머신 phase */
  phase: string;
  /** 세션 상태 */
  status:
    | "initializing"
    | "running"
    | "paused"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "stopped";

  // ─── Files ───
  /** 변경된 파일 경로 집합 */
  changedFiles: Set<string>;
  /** 파일별 원본 스냅샷 (변경 전 내용) */
  originalSnapshots: Map<string, string>;
  /** 현재 작업 중인 파일 */
  activeFiles: Set<string>;

  // ─── Plan ───
  /** 현재 계획 ID (없으면 null) */
  currentPlan: string | null;
  /** 현재 진행 중인 단계 인덱스 */
  currentStep: number;

  // ─── Budget ───
  /** 토큰 예산 */
  tokenBudget: { total: number; used: { input: number; output: number } };
  /** 반복 예산 */
  iterationBudget: { max: number; current: number };

  // ─── Approvals ───
  /** 현재 대기 중인 승인 (없으면 null) */
  pendingApproval: PendingApprovalInfo | null;
  /** 승인 히스토리 */
  approvalHistory: ApprovalRecord[];

  // ─── Checkpoints ───
  /** 체크포인트 목록 */
  checkpoints: SessionCheckpoint[];
  /** 마지막 체크포인트 시각 (epoch ms) */
  lastCheckpointAt: number;

  // ─── Tools ───
  /** 현재 등록된 도구 이름 목록 */
  activeTools: string[];

  // ─── Timing ───
  /** 생성 시각 (epoch ms) */
  createdAt: number;
  /** 마지막 업데이트 시각 (epoch ms) */
  updatedAt: number;
  /** 실행 시작 시각 (epoch ms, 미시작이면 null) */
  startedAt: number | null;
  /** 완료 시각 (epoch ms, 미완료면 null) */
  completedAt: number | null;

  // ─── Memory ───
  /** 프로젝트 메모리 파일 경로 (YUAN.md) */
  projectMemoryPath: string;
}

// ══════════════════════════════════════════════════════════════════════
// 2. PLAN GRAPH — 계획의 운영 상태 관리
// ══════════════════════════════════════════════════════════════════════

/**
 * PlanGraph는 ExecutionPlan을 런타임 상태로 래핑한다.
 * LLM이 계획을 생성하고, PlanGraph가 실행 상태를 관리한다.
 */

/** 계획 노드의 상태 */
export type PlanNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "blocked";

/** 계획 그래프의 개별 노드 */
export interface PlanNode {
  /** 노드 ID */
  id: string;
  /** 노드 목표 */
  goal: string;
  /** 대상 파일 */
  targetFiles: string[];
  /** 필요한 도구 */
  tools: string[];
  /** 의존하는 노드 ID 목록 */
  dependsOn: string[];

  // ─── Runtime state (시스템 관리, LLM이 설정하지 않음) ───
  /** 현재 상태 */
  status: PlanNodeStatus;
  /** 실행 시작 시각 */
  startedAt: number | null;
  /** 완료 시각 */
  completedAt: number | null;
  /** 실행 결과 요약 */
  result: string | null;
  /** 에러 메시지 */
  error: string | null;
  /** 변경된 파일 */
  changedFiles: string[];
  /** 토큰 사용량 */
  tokensUsed: { input: number; output: number };
  /** 시도 횟수 */
  attempts: number;
  /** 최대 시도 횟수 */
  maxAttempts: number;
}

/** 계획 그래프의 전체 상태 */
export interface PlanGraphState {
  /** 그래프 ID */
  id: string;
  /** 소속 세션 ID */
  sessionId: string;
  /** 전체 목표 */
  goal: string;

  /** 노드 맵 (id → PlanNode) */
  nodes: Map<string, PlanNode>;

  // ─── Computed state ───
  /** 완료된 노드 ID */
  completedNodes: string[];
  /** 실행 중인 노드 ID */
  runningNodes: string[];
  /** 대기 중인 노드 ID */
  pendingNodes: string[];
  /** 실패한 노드 ID */
  failedNodes: string[];
  /** 건너뛴 노드 ID */
  skippedNodes: string[];

  // ─── Metrics ───
  /** 전체 토큰 사용량 */
  totalTokensUsed: { input: number; output: number };
  /** 그래프 시작 시각 */
  startedAt: number;
  /** 예상 완료 시각 (없으면 null) */
  estimatedCompletion: number | null;

  // ─── Topology ───
  /** 크리티컬 패스 (가장 긴 의존 체인) */
  criticalPath: string[];
  /** 병렬 실행 가능한 노드 그룹 */
  parallelGroups: string[][];
}

/** 노드 추가 시 시스템이 자동으로 채우는 필드를 제외한 입력 타입 */
type PlanNodeInput = Omit<
  PlanNode,
  | "status"
  | "startedAt"
  | "completedAt"
  | "result"
  | "error"
  | "changedFiles"
  | "tokensUsed"
  | "attempts"
  | "maxAttempts"
>;

/**
 * PlanGraphManager — 계획 그래프의 상태 전이를 관리.
 *
 * - 노드 추가/제거
 * - 의존성 기반 ready 판정
 * - 상태 전이 (pending → ready → running → completed/failed/skipped)
 * - 재시도 관리
 * - 직렬화/역직렬화
 */
export class PlanGraphManager {
  private state: PlanGraphState;

  constructor(sessionId: string, goal: string) {
    this.state = {
      id: crypto.randomUUID(),
      sessionId,
      goal,
      nodes: new Map(),
      completedNodes: [],
      runningNodes: [],
      pendingNodes: [],
      failedNodes: [],
      skippedNodes: [],
      totalTokensUsed: { input: 0, output: 0 },
      startedAt: Date.now(),
      estimatedCompletion: null,
      criticalPath: [],
      parallelGroups: [],
    };
  }

  /**
   * ExecutionPlan으로부터 PlanGraphManager를 생성.
   * 각 PlanStep을 PlanNode로 변환하고 의존성을 연결한다.
   */
  static fromExecutionPlan(
    sessionId: string,
    plan: ExecutionPlan,
  ): PlanGraphManager {
    const mgr = new PlanGraphManager(sessionId, plan.goal);
    for (const step of plan.steps) {
      mgr.addNode({
        id: step.id,
        goal: step.goal,
        targetFiles: step.targetFiles,
        tools: step.tools,
        dependsOn: step.dependsOn,
      });
    }
    mgr.updateReadyNodes();
    mgr.computeCriticalPath();
    mgr.computeParallelGroups();
    return mgr;
  }

  // ─── Node Management ───

  /**
   * 노드 추가. 런타임 상태 필드는 기본값으로 초기화.
   */
  addNode(input: PlanNodeInput): void {
    const node: PlanNode = {
      ...input,
      status: "pending",
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      changedFiles: [],
      tokensUsed: { input: 0, output: 0 },
      attempts: 0,
      maxAttempts: 3,
    };
    this.state.nodes.set(node.id, node);
    this.rebuildComputedState();
  }

  // ─── State Transitions ───

  /**
   * 노드를 ready 상태로 전환 (의존성이 모두 완료됨).
   */
  markReady(nodeId: string): void {
    const node = this.requireNode(nodeId);
    if (node.status !== "pending" && node.status !== "blocked") {
      throw new Error(
        `Cannot mark node "${nodeId}" as ready: current status is "${node.status}"`,
      );
    }
    node.status = "ready";
    this.rebuildComputedState();
  }

  /**
   * 노드를 running 상태로 전환 (실행 시작).
   */
  markRunning(nodeId: string): void {
    const node = this.requireNode(nodeId);
    if (node.status !== "ready") {
      throw new Error(
        `Cannot mark node "${nodeId}" as running: current status is "${node.status}"`,
      );
    }
    node.status = "running";
    node.startedAt = Date.now();
    node.attempts += 1;
    this.rebuildComputedState();
  }

  /**
   * 노드를 completed 상태로 전환 (성공적으로 완료).
   */
  markCompleted(
    nodeId: string,
    result: string,
    changedFiles: string[],
    tokensUsed: { input: number; output: number },
  ): void {
    const node = this.requireNode(nodeId);
    if (node.status !== "running") {
      throw new Error(
        `Cannot mark node "${nodeId}" as completed: current status is "${node.status}"`,
      );
    }
    node.status = "completed";
    node.completedAt = Date.now();
    node.result = result;
    node.changedFiles = changedFiles;
    node.tokensUsed = tokensUsed;

    // 전체 토큰 사용량 업데이트
    this.state.totalTokensUsed.input += tokensUsed.input;
    this.state.totalTokensUsed.output += tokensUsed.output;

    this.rebuildComputedState();
    this.updateReadyNodes();
  }

  /**
   * 노드를 failed 상태로 전환.
   */
  markFailed(nodeId: string, error: string): void {
    const node = this.requireNode(nodeId);
    if (node.status !== "running") {
      throw new Error(
        `Cannot mark node "${nodeId}" as failed: current status is "${node.status}"`,
      );
    }
    node.status = "failed";
    node.completedAt = Date.now();
    node.error = error;
    this.rebuildComputedState();

    // 이 노드에 의존하는 노드들을 blocked로 전환
    this.blockDependents(nodeId);
  }

  /**
   * 노드를 skipped 상태로 전환.
   */
  markSkipped(nodeId: string, reason: string): void {
    const node = this.requireNode(nodeId);
    node.status = "skipped";
    node.completedAt = Date.now();
    node.error = reason;
    this.rebuildComputedState();

    // 이 노드에 의존하는 노드들도 blocked
    this.blockDependents(nodeId);
  }

  /**
   * 실패한 노드를 재시도. maxAttempts 초과 시 false 반환.
   */
  retry(nodeId: string): boolean {
    const node = this.requireNode(nodeId);
    if (node.status !== "failed") {
      throw new Error(
        `Cannot retry node "${nodeId}": current status is "${node.status}"`,
      );
    }
    if (node.attempts >= node.maxAttempts) {
      return false;
    }
    // 상태를 ready로 되돌림 (markRunning에서 attempts 증가)
    node.status = "ready";
    node.error = null;
    node.completedAt = null;
    this.rebuildComputedState();
    return true;
  }

  // ─── Queries ───

  /**
   * 의존성이 모두 완료되어 실행 가능한 노드 목록.
   */
  getReadyNodes(): PlanNode[] {
    const result: PlanNode[] = [];
    for (const node of this.state.nodes.values()) {
      if (node.status === "ready") {
        result.push(node);
      }
    }
    return result;
  }

  /** 노드 조회 */
  getNode(id: string): PlanNode | undefined {
    return this.state.nodes.get(id);
  }

  /** 전체 상태 (읽기 전용) */
  getState(): Readonly<PlanGraphState> {
    return this.state;
  }

  /**
   * 모든 노드가 종료 상태(completed/failed/skipped)인지 확인.
   */
  isComplete(): boolean {
    for (const node of this.state.nodes.values()) {
      if (
        node.status !== "completed" &&
        node.status !== "failed" &&
        node.status !== "skipped"
      ) {
        return false;
      }
    }
    return this.state.nodes.size > 0;
  }

  /** 진행률 */
  getProgress(): { completed: number; total: number; percent: number } {
    const total = this.state.nodes.size;
    const completed = this.state.completedNodes.length;
    return {
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }

  /**
   * 의존성 완료 후 ready 상태로 전환할 수 있는 노드를 업데이트.
   * @returns 새로 ready가 된 노드 ID 목록
   */
  updateReadyNodes(): string[] {
    const newlyReady: string[] = [];

    for (const node of this.state.nodes.values()) {
      if (node.status !== "pending") continue;

      const depsAllCompleted = node.dependsOn.every((depId) => {
        const dep = this.state.nodes.get(depId);
        return dep !== undefined && dep.status === "completed";
      });

      if (depsAllCompleted) {
        node.status = "ready";
        newlyReady.push(node.id);
      }
    }

    if (newlyReady.length > 0) {
      this.rebuildComputedState();
    }

    return newlyReady;
  }

  // ─── Serialization ───

  /** JSON 직렬화 (Map/Set → 배열 변환) */
  toJSON(): Record<string, unknown> {
    const nodesArr: PlanNode[] = [];
    for (const node of this.state.nodes.values()) {
      nodesArr.push({ ...node });
    }
    return {
      id: this.state.id,
      sessionId: this.state.sessionId,
      goal: this.state.goal,
      nodes: nodesArr,
      completedNodes: this.state.completedNodes,
      runningNodes: this.state.runningNodes,
      pendingNodes: this.state.pendingNodes,
      failedNodes: this.state.failedNodes,
      skippedNodes: this.state.skippedNodes,
      totalTokensUsed: this.state.totalTokensUsed,
      startedAt: this.state.startedAt,
      estimatedCompletion: this.state.estimatedCompletion,
      criticalPath: this.state.criticalPath,
      parallelGroups: this.state.parallelGroups,
    };
  }

  /** JSON에서 PlanGraphManager 복구 */
  static fromJSON(json: Record<string, unknown>): PlanGraphManager {
    const sessionId = json.sessionId as string;
    const goal = json.goal as string;
    const mgr = new PlanGraphManager(sessionId, goal);

    mgr.state.id = json.id as string;
    mgr.state.startedAt = json.startedAt as number;
    mgr.state.estimatedCompletion =
      (json.estimatedCompletion as number | null) ?? null;
    mgr.state.totalTokensUsed = json.totalTokensUsed as {
      input: number;
      output: number;
    };
    mgr.state.criticalPath = (json.criticalPath as string[]) ?? [];
    mgr.state.parallelGroups = (json.parallelGroups as string[][]) ?? [];

    const nodesArr = json.nodes as PlanNode[];
    for (const node of nodesArr) {
      mgr.state.nodes.set(node.id, { ...node });
    }

    mgr.rebuildComputedState();
    return mgr;
  }

  // ─── Private Helpers ───

  /** 노드 존재 확인 (없으면 throw) */
  private requireNode(nodeId: string): PlanNode {
    const node = this.state.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Plan node not found: "${nodeId}"`);
    }
    return node;
  }

  /** 상태별 노드 목록 재계산 */
  private rebuildComputedState(): void {
    this.state.completedNodes = [];
    this.state.runningNodes = [];
    this.state.pendingNodes = [];
    this.state.failedNodes = [];
    this.state.skippedNodes = [];

    for (const node of this.state.nodes.values()) {
      switch (node.status) {
        case "completed":
          this.state.completedNodes.push(node.id);
          break;
        case "running":
          this.state.runningNodes.push(node.id);
          break;
        case "pending":
        case "ready":
        case "blocked":
          this.state.pendingNodes.push(node.id);
          break;
        case "failed":
          this.state.failedNodes.push(node.id);
          break;
        case "skipped":
          this.state.skippedNodes.push(node.id);
          break;
      }
    }
  }

  /** 실패/스킵된 노드에 의존하는 노드를 blocked 상태로 전환 */
  private blockDependents(failedNodeId: string): void {
    for (const node of this.state.nodes.values()) {
      if (
        node.dependsOn.includes(failedNodeId) &&
        (node.status === "pending" || node.status === "ready")
      ) {
        node.status = "blocked";
      }
    }
    this.rebuildComputedState();
  }

  /** 크리티컬 패스 계산 (가장 긴 의존 체인) */
  private computeCriticalPath(): void {
    const memo = new Map<string, string[]>();

    const longestPath = (nodeId: string, visited: Set<string> = new Set()): string[] => {
      if (memo.has(nodeId)) return memo.get(nodeId)!;
      if (visited.has(nodeId)) return []; // cycle detected — break recursion

      visited.add(nodeId);

      const node = this.state.nodes.get(nodeId);
      if (!node || node.dependsOn.length === 0) {
        const path = [nodeId];
        memo.set(nodeId, path);
        return path;
      }

      let longest: string[] = [];
      for (const depId of node.dependsOn) {
        const depPath = longestPath(depId, visited);
        if (depPath.length > longest.length) {
          longest = depPath;
        }
      }

      const path = [...longest, nodeId];
      memo.set(nodeId, path);
      return path;
    };

    let criticalPath: string[] = [];
    for (const nodeId of this.state.nodes.keys()) {
      const path = longestPath(nodeId);
      if (path.length > criticalPath.length) {
        criticalPath = path;
      }
    }

    this.state.criticalPath = criticalPath;
  }

  /** 병렬 실행 가능한 노드 그룹 계산 (토폴로지 레벨별) */
  private computeParallelGroups(): void {
    const levels = new Map<string, number>();

    const getLevel = (nodeId: string, visited: Set<string> = new Set()): number => {
      if (levels.has(nodeId)) return levels.get(nodeId)!;
      if (visited.has(nodeId)) return 0; // cycle detected — break recursion

      visited.add(nodeId);

      const node = this.state.nodes.get(nodeId);
      if (!node || node.dependsOn.length === 0) {
        levels.set(nodeId, 0);
        return 0;
      }

      let maxDepLevel = -1;
      for (const depId of node.dependsOn) {
        const depLevel = getLevel(depId, visited);
        if (depLevel > maxDepLevel) {
          maxDepLevel = depLevel;
        }
      }

      const level = maxDepLevel + 1;
      levels.set(nodeId, level);
      return level;
    };

    for (const nodeId of this.state.nodes.keys()) {
      getLevel(nodeId);
    }

    // 레벨별 그룹화
    const groupMap = new Map<number, string[]>();
    for (const [nodeId, level] of levels) {
      if (!groupMap.has(level)) {
        groupMap.set(level, []);
      }
      groupMap.get(level)!.push(nodeId);
    }

    // 레벨 순서대로 정렬
    const sortedLevels = Array.from(groupMap.keys()).sort((a, b) => a - b);
    this.state.parallelGroups = sortedLevels.map(
      (level) => groupMap.get(level)!,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. TOOL CONTRACT — 도구 계약 SSOT
// ══════════════════════════════════════════════════════════════════════

/** 도구 입력 스키마 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description: string;
      required?: boolean;
      enum?: string[];
      default?: unknown;
      /** 정규식 검증 패턴 */
      pattern?: string;
      /** 최대 길이 */
      maxLength?: number;
    }
  >;
  required: string[];
}

/** 도구 출력 스키마 */
export interface ToolOutputSchema {
  /** 출력 타입 ("string" | "object") */
  type: string;
  /** 최대 출력 토큰 수 */
  maxLength: number;
  /** 초과 시 잘라내기 전략 */
  truncateStrategy: "tail" | "head" | "middle";
}

/** 도구 권한 */
export interface ToolPermissions {
  fileRead: boolean;
  fileWrite: boolean;
  fileDelete: boolean;
  shellExec: boolean;
  networkAccess: boolean;
  gitOps: boolean;

  /** 허용된 경로 패턴 (glob). 빈 배열 = 제한 없음 */
  allowedPaths: string[];
  /** 차단된 경로 패턴 (glob) */
  blockedPaths: string[];
}

/** 도구 승인 정책 */
export interface ToolApprovalPolicy {
  /** 승인 필요 여부 */
  requiresApproval: boolean;
  /** 자동 승인 조건 */
  autoApproveConditions: AutoApproveCondition[];
  /** 위험도 */
  risk: "low" | "medium" | "high" | "critical";
  /** 승인 대기 타임아웃 (ms) */
  timeout: number;
}

/** 자동 승인 조건 */
export interface AutoApproveCondition {
  /** 조건 유형 */
  type: "always" | "same_tool" | "same_file" | "below_risk" | "user_setting";
  /** 조건 값 (유형에 따라 해석) */
  value?: string;
}

/** 도구 보안 정책 */
export interface ToolSecurityPolicy {
  /** 샌드박스 티어 (0–4, 설계 문서 참조) */
  sandboxTier: number;
  /** 입력 살균 여부 */
  inputSanitization: boolean;
  /** 출력 살균 여부 */
  outputSanitization: boolean;
  /** 최대 실행 시간 (ms) */
  maxExecutionTime: number;
  /** 거부할 정규식 패턴 */
  blockedPatterns: string[];
  /** 모든 호출을 감사 로그에 기록 */
  auditLog: boolean;
}

/** 도구 실행 제약 */
export interface ToolConstraints {
  /** 반복당 최대 호출 수 */
  maxCallsPerIteration: number;
  /** 세션당 최대 호출 수 */
  maxCallsPerSession: number;
  /** 호출 간 최소 대기 시간 (ms) */
  cooldownMs: number;
  /** 다른 도구와 병렬 실행 가능 여부 */
  parallelizable: boolean;
  /** 프로젝트 컨텍스트 필요 여부 */
  requiresProject: boolean;
  /** 지원 언어 (빈 배열 = 전체) */
  supportedLanguages: string[];
}

/**
 * ToolContract — 도구의 전체 계약.
 *
 * 이름, 스키마, 권한, 승인 정책, 보안 정책, 실행 제약을 하나로 묶는다.
 * 모든 도구는 이 계약을 준수해야 한다.
 */
export interface ToolContract {
  /** 도구 이름 (snake_case) */
  name: string;
  /** 도구 설명 */
  description: string;

  /** 입력 스키마 */
  inputSchema: ToolInputSchema;
  /** 출력 스키마 */
  outputSchema: ToolOutputSchema;

  /** 권한 */
  permissions: ToolPermissions;
  /** 승인 정책 */
  approvalPolicy: ToolApprovalPolicy;
  /** 보안 정책 */
  securityPolicy: ToolSecurityPolicy;
  /** 실행 제약 */
  constraints: ToolConstraints;
}

/**
 * ToolContractRegistry — 도구 계약 레지스트리.
 *
 * 모든 도구의 계약을 등록, 조회, 검증한다.
 * LLM에게 전달할 ToolDefinition 목록도 여기서 생성.
 */
export class ToolContractRegistry {
  private contracts: Map<string, ToolContract> = new Map();

  /** 계약 등록 */
  register(contract: ToolContract): void {
    this.contracts.set(contract.name, contract);
  }

  /** 계약 조회 */
  get(name: string): ToolContract | undefined {
    return this.contracts.get(name);
  }

  /** 전체 계약 목록 */
  getAll(): ToolContract[] {
    return Array.from(this.contracts.values());
  }

  /**
   * 도구 호출 입력을 계약에 대해 검증.
   * @returns { valid, errors } — errors는 빈 배열이면 유효
   */
  validate(
    name: string,
    input: Record<string, unknown>,
  ): { valid: boolean; errors: string[] } {
    const contract = this.contracts.get(name);
    if (!contract) {
      return { valid: false, errors: [`Unknown tool: "${name}"`] };
    }

    const errors: string[] = [];
    const schema = contract.inputSchema;

    // required 필드 검증
    for (const reqField of schema.required) {
      if (input[reqField] === undefined || input[reqField] === null) {
        errors.push(`Missing required field: "${reqField}"`);
      }
    }

    // 속성별 타입/패턴/길이 검증
    for (const [key, value] of Object.entries(input)) {
      const propSchema = schema.properties[key];
      if (!propSchema) continue; // 미정의 속성은 무시

      // enum 검증
      if (propSchema.enum && !propSchema.enum.includes(String(value))) {
        errors.push(
          `Field "${key}" must be one of: ${propSchema.enum.join(", ")}`,
        );
      }

      // pattern 검증
      if (propSchema.pattern && typeof value === "string") {
        const regex = new RegExp(propSchema.pattern);
        if (!regex.test(value)) {
          errors.push(
            `Field "${key}" does not match pattern: ${propSchema.pattern}`,
          );
        }
      }

      // maxLength 검증
      if (
        propSchema.maxLength !== undefined &&
        typeof value === "string" &&
        value.length > propSchema.maxLength
      ) {
        errors.push(
          `Field "${key}" exceeds max length of ${propSchema.maxLength}`,
        );
      }
    }

    // 보안 패턴 검증 (blockedPatterns)
    const stringInput = JSON.stringify(input);
    for (const pattern of contract.securityPolicy.blockedPatterns) {
      const regex = new RegExp(pattern, "i");
      if (regex.test(stringInput)) {
        errors.push(`Input matches blocked security pattern: ${pattern}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 도구 호출에 승인이 필요한지 판단.
   * @param autoApproveSettings 자동 승인된 도구/설정 목록
   */
  needsApproval(
    name: string,
    _input: Record<string, unknown>,
    autoApproveSettings: string[],
  ): boolean {
    const contract = this.contracts.get(name);
    if (!contract) return true; // 미등록 도구는 항상 승인 필요

    if (!contract.approvalPolicy.requiresApproval) return false;

    // autoApproveSettings에 도구 이름이 있으면 승인 불필요
    if (autoApproveSettings.includes(name)) return false;

    // autoApproveConditions 평가
    for (const cond of contract.approvalPolicy.autoApproveConditions) {
      switch (cond.type) {
        case "always":
          return false;
        case "same_tool":
          if (autoApproveSettings.includes(`always:${name}`)) return false;
          break;
        case "below_risk":
          if (cond.value) {
            const riskOrder = ["low", "medium", "high", "critical"];
            const threshold = riskOrder.indexOf(cond.value);
            const current = riskOrder.indexOf(
              contract.approvalPolicy.risk,
            );
            if (current <= threshold) return false;
          }
          break;
        case "user_setting":
          // user_setting은 외부에서 autoApproveSettings로 전달
          break;
        default:
          break;
      }
    }

    return true;
  }

  /**
   * 특정 권한을 가진 도구 목록 필터링.
   */
  getToolsWithPermission(permission: keyof ToolPermissions): ToolContract[] {
    return this.getAll().filter((c) => {
      const val = c.permissions[permission];
      // boolean 속성만 필터 (string[] 속성은 제외)
      return typeof val === "boolean" && val === true;
    });
  }

  /**
   * LLM에 전달할 ToolDefinition 배열 생성.
   */
  toToolDefinitions(): ToolDefinition[] {
    return this.getAll().map((c) => ({
      name: c.name,
      description: c.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(c.inputSchema.properties).map(([key, prop]) => [
            key,
            {
              type: prop.type,
              description: prop.description,
              ...(prop.enum ? { enum: prop.enum } : {}),
              ...(prop.default !== undefined
                ? { default: prop.default }
                : {}),
            },
          ]),
        ),
        required: c.inputSchema.required,
      },
    }));
  }

  /**
   * YUAN 기본 9개 도구의 계약을 생성.
   */
  static createDefaultContracts(): ToolContractRegistry {
    const registry = new ToolContractRegistry();

    // ─── file_read ───
    registry.register({
      name: "file_read",
      description: "Read file contents from the project directory",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative file path to read",
          },
          offset: {
            type: "number",
            description: "Line offset to start reading from (0-based)",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read",
          },
        },
        required: ["path"],
      },
      outputSchema: { type: "string", maxLength: 50000, truncateStrategy: "tail" },
      permissions: {
        fileRead: true,
        fileWrite: false,
        fileDelete: false,
        shellExec: false,
        networkAccess: false,
        gitOps: false,
        allowedPaths: [],
        blockedPaths: ["**/.env", "**/*.pem", "**/*.key"],
      },
      approvalPolicy: {
        requiresApproval: false,
        autoApproveConditions: [{ type: "always" }],
        risk: "low",
        timeout: 0,
      },
      securityPolicy: {
        sandboxTier: 0,
        inputSanitization: true,
        outputSanitization: true,
        maxExecutionTime: 5000,
        blockedPatterns: [],
        auditLog: false,
      },
      constraints: {
        maxCallsPerIteration: 20,
        maxCallsPerSession: 500,
        cooldownMs: 0,
        parallelizable: true,
        requiresProject: true,
        supportedLanguages: [],
      },
    });

    // ─── file_write ───
    registry.register({
      name: "file_write",
      description:
        "Write or create a file in the project directory. Overwrites existing files.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative file path to write",
          },
          content: {
            type: "string",
            description: "File content to write",
            maxLength: 100000,
          },
          overwrite: {
            type: "boolean",
            description: "Whether to overwrite existing files",
            default: false,
          },
        },
        required: ["path", "content"],
      },
      outputSchema: { type: "string", maxLength: 500, truncateStrategy: "tail" },
      permissions: {
        fileRead: false,
        fileWrite: true,
        fileDelete: false,
        shellExec: false,
        networkAccess: false,
        gitOps: false,
        allowedPaths: [],
        blockedPaths: [
          "**/.env",
          "**/*.pem",
          "**/*.key",
          "**/node_modules/**",
        ],
      },
      approvalPolicy: {
        requiresApproval: true,
        autoApproveConditions: [
          { type: "below_risk", value: "medium" },
        ],
        risk: "medium",
        timeout: 120000,
      },
      securityPolicy: {
        sandboxTier: 1,
        inputSanitization: true,
        outputSanitization: false,
        maxExecutionTime: 10000,
        blockedPatterns: [],
        auditLog: true,
      },
      constraints: {
        maxCallsPerIteration: 10,
        maxCallsPerSession: 200,
        cooldownMs: 0,
        parallelizable: false,
        requiresProject: true,
        supportedLanguages: [],
      },
    });

    // ─── file_edit ───
    registry.register({
      name: "file_edit",
      description:
        "Edit an existing file by replacing specific text content (diff-based)",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to edit",
          },
          old_string: {
            type: "string",
            description: "Exact text to find and replace",
            maxLength: 50000,
          },
          new_string: {
            type: "string",
            description: "Replacement text",
            maxLength: 50000,
          },
          replace_all: {
            type: "boolean",
            description: "Replace all occurrences (default: false)",
            default: false,
          },
        },
        required: ["path", "old_string", "new_string"],
      },
      outputSchema: { type: "string", maxLength: 1000, truncateStrategy: "tail" },
      permissions: {
        fileRead: true,
        fileWrite: true,
        fileDelete: false,
        shellExec: false,
        networkAccess: false,
        gitOps: false,
        allowedPaths: [],
        blockedPaths: [
          "**/.env",
          "**/*.pem",
          "**/*.key",
          "**/node_modules/**",
        ],
      },
      approvalPolicy: {
        requiresApproval: true,
        autoApproveConditions: [
          { type: "below_risk", value: "medium" },
        ],
        risk: "medium",
        timeout: 120000,
      },
      securityPolicy: {
        sandboxTier: 1,
        inputSanitization: true,
        outputSanitization: false,
        maxExecutionTime: 10000,
        blockedPatterns: [],
        auditLog: true,
      },
      constraints: {
        maxCallsPerIteration: 15,
        maxCallsPerSession: 300,
        cooldownMs: 0,
        parallelizable: false,
        requiresProject: true,
        supportedLanguages: [],
      },
    });

    // ─── shell_exec ───
    registry.register({
      name: "shell_exec",
      description:
        "Execute a shell command in the project directory. Commands are validated for safety.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute",
            maxLength: 2000,
          },
          cwd: {
            type: "string",
            description: "Working directory (defaults to project root)",
          },
          timeout: {
            type: "number",
            description: "Execution timeout in milliseconds (default: 30000)",
            default: 30000,
          },
        },
        required: ["command"],
      },
      outputSchema: { type: "string", maxLength: 30000, truncateStrategy: "tail" },
      permissions: {
        fileRead: true,
        fileWrite: true,
        fileDelete: true,
        shellExec: true,
        networkAccess: false,
        gitOps: false,
        allowedPaths: [],
        blockedPaths: [],
      },
      approvalPolicy: {
        requiresApproval: true,
        autoApproveConditions: [],
        risk: "high",
        timeout: 120000,
      },
      securityPolicy: {
        sandboxTier: 3,
        inputSanitization: true,
        outputSanitization: true,
        maxExecutionTime: 60000,
        blockedPatterns: [
          "rm\\s+-rf\\s+/",
          "mkfs",
          "dd\\s+if=",
          ":(){ :|:& };:",
          "curl.*\\|.*sh",
          "wget.*\\|.*sh",
        ],
        auditLog: true,
      },
      constraints: {
        maxCallsPerIteration: 5,
        maxCallsPerSession: 100,
        cooldownMs: 500,
        parallelizable: false,
        requiresProject: true,
        supportedLanguages: [],
      },
    });

    // ─── grep ───
    registry.register({
      name: "grep",
      description:
        "Search file contents using regex patterns. Returns matching lines with context.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression pattern to search for",
          },
          path: {
            type: "string",
            description: "Directory or file to search in",
          },
          glob: {
            type: "string",
            description: 'File glob pattern filter (e.g., "*.ts")',
          },
          context: {
            type: "number",
            description: "Number of context lines before and after each match",
            default: 2,
          },
          max_results: {
            type: "number",
            description: "Maximum number of matching lines to return",
            default: 50,
          },
        },
        required: ["pattern"],
      },
      outputSchema: { type: "string", maxLength: 30000, truncateStrategy: "tail" },
      permissions: {
        fileRead: true,
        fileWrite: false,
        fileDelete: false,
        shellExec: false,
        networkAccess: false,
        gitOps: false,
        allowedPaths: [],
        blockedPaths: ["**/.env", "**/*.pem", "**/*.key"],
      },
      approvalPolicy: {
        requiresApproval: false,
        autoApproveConditions: [{ type: "always" }],
        risk: "low",
        timeout: 0,
      },
      securityPolicy: {
        sandboxTier: 0,
        inputSanitization: true,
        outputSanitization: true,
        maxExecutionTime: 15000,
        blockedPatterns: [],
        auditLog: false,
      },
      constraints: {
        maxCallsPerIteration: 20,
        maxCallsPerSession: 500,
        cooldownMs: 0,
        parallelizable: true,
        requiresProject: true,
        supportedLanguages: [],
      },
    });

    // ─── glob ───
    registry.register({
      name: "glob",
      description:
        "Find files matching glob patterns in the project directory",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.tsx")',
          },
          path: {
            type: "string",
            description: "Base directory to search from",
          },
        },
        required: ["pattern"],
      },
      outputSchema: { type: "string", maxLength: 20000, truncateStrategy: "tail" },
      permissions: {
        fileRead: true,
        fileWrite: false,
        fileDelete: false,
        shellExec: false,
        networkAccess: false,
        gitOps: false,
        allowedPaths: [],
        blockedPaths: [],
      },
      approvalPolicy: {
        requiresApproval: false,
        autoApproveConditions: [{ type: "always" }],
        risk: "low",
        timeout: 0,
      },
      securityPolicy: {
        sandboxTier: 0,
        inputSanitization: true,
        outputSanitization: false,
        maxExecutionTime: 10000,
        blockedPatterns: [],
        auditLog: false,
      },
      constraints: {
        maxCallsPerIteration: 15,
        maxCallsPerSession: 300,
        cooldownMs: 0,
        parallelizable: true,
        requiresProject: true,
        supportedLanguages: [],
      },
    });

    // ─── git_ops ───
    registry.register({
      name: "git_ops",
      description:
        "Perform git operations (status, diff, add, commit, log, branch). Push requires approval.",
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description: "Git operation to perform",
            enum: [
              "status",
              "diff",
              "add",
              "commit",
              "log",
              "branch",
              "push",
              "stash",
              "checkout",
            ],
          },
          args: {
            type: "string",
            description: "Additional arguments for the git operation",
          },
          message: {
            type: "string",
            description: "Commit message (for commit operation)",
          },
        },
        required: ["operation"],
      },
      outputSchema: { type: "string", maxLength: 20000, truncateStrategy: "tail" },
      permissions: {
        fileRead: true,
        fileWrite: true,
        fileDelete: false,
        shellExec: true,
        networkAccess: false,
        gitOps: true,
        allowedPaths: [],
        blockedPaths: [],
      },
      approvalPolicy: {
        requiresApproval: true,
        autoApproveConditions: [
          { type: "below_risk", value: "low" },
        ],
        risk: "medium",
        timeout: 120000,
      },
      securityPolicy: {
        sandboxTier: 2,
        inputSanitization: true,
        outputSanitization: true,
        maxExecutionTime: 30000,
        blockedPatterns: [
          "force",
          "--force",
          "-f\\b",
          "reset\\s+--hard",
        ],
        auditLog: true,
      },
      constraints: {
        maxCallsPerIteration: 10,
        maxCallsPerSession: 100,
        cooldownMs: 200,
        parallelizable: false,
        requiresProject: true,
        supportedLanguages: [],
      },
    });

    // ─── test_run ───
    registry.register({
      name: "test_run",
      description:
        "Run project tests (unit, integration). Detects test framework automatically.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description:
              'Test scope: "all", "file", or "pattern"',
            enum: ["all", "file", "pattern"],
            default: "all",
          },
          target: {
            type: "string",
            description:
              "Test file path or pattern (for scope=file or scope=pattern)",
          },
          watch: {
            type: "boolean",
            description: "Run tests in watch mode",
            default: false,
          },
        },
        required: [],
      },
      outputSchema: { type: "string", maxLength: 30000, truncateStrategy: "tail" },
      permissions: {
        fileRead: true,
        fileWrite: false,
        fileDelete: false,
        shellExec: true,
        networkAccess: false,
        gitOps: false,
        allowedPaths: [],
        blockedPaths: [],
      },
      approvalPolicy: {
        requiresApproval: false,
        autoApproveConditions: [{ type: "always" }],
        risk: "low",
        timeout: 0,
      },
      securityPolicy: {
        sandboxTier: 2,
        inputSanitization: true,
        outputSanitization: true,
        maxExecutionTime: 120000,
        blockedPatterns: [],
        auditLog: true,
      },
      constraints: {
        maxCallsPerIteration: 3,
        maxCallsPerSession: 30,
        cooldownMs: 1000,
        parallelizable: false,
        requiresProject: true,
        supportedLanguages: [],
      },
    });

    // ─── security_scan ───
    registry.register({
      name: "security_scan",
      description:
        "Scan files or diffs for security issues (secrets, vulnerabilities, unsafe patterns)",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "File path, directory, or 'staged' for git staged changes",
          },
          scan_type: {
            type: "string",
            description: "Type of scan to perform",
            enum: ["secrets", "vulnerabilities", "all"],
            default: "all",
          },
        },
        required: ["target"],
      },
      outputSchema: { type: "object", maxLength: 10000, truncateStrategy: "tail" },
      permissions: {
        fileRead: true,
        fileWrite: false,
        fileDelete: false,
        shellExec: false,
        networkAccess: false,
        gitOps: false,
        allowedPaths: [],
        blockedPaths: [],
      },
      approvalPolicy: {
        requiresApproval: false,
        autoApproveConditions: [{ type: "always" }],
        risk: "low",
        timeout: 0,
      },
      securityPolicy: {
        sandboxTier: 0,
        inputSanitization: true,
        outputSanitization: false,
        maxExecutionTime: 30000,
        blockedPatterns: [],
        auditLog: true,
      },
      constraints: {
        maxCallsPerIteration: 5,
        maxCallsPerSession: 50,
        cooldownMs: 0,
        parallelizable: true,
        requiresProject: true,
        supportedLanguages: [],
      },
    });

    return registry;
  }
}

// ══════════════════════════════════════════════════════════════════════
// 4. EVENT LOG — 모든 것을 이벤트로 기록
// ══════════════════════════════════════════════════════════════════════

/** 커널 이벤트 타입 */
export type KernelEventType =
  // Session lifecycle
  | "session:start"
  | "session:pause"
  | "session:resume"
  | "session:complete"
  | "session:fail"
  | "session:stop"
  // Plan
  | "plan:created"
  | "plan:updated"
  | "plan:node_ready"
  | "plan:node_running"
  | "plan:node_completed"
  | "plan:node_failed"
  | "plan:replan"
  // Tool
  | "tool:call"
  | "tool:result"
  | "tool:error"
  | "tool:approval_needed"
  | "tool:approved"
  | "tool:rejected"
  // File
  | "file:read"
  | "file:write"
  | "file:edit"
  | "file:delete"
  | "file:snapshot"
  // Verify
  | "verify:start"
  | "verify:pass"
  | "verify:concern"
  | "verify:fail"
  // LLM
  | "llm:request"
  | "llm:response"
  | "llm:text_delta"
  | "llm:thinking"
  // Agent
  | "agent:monologue"
  | "agent:decision"
  | "agent:learning"
  // Checkpoint
  | "checkpoint:created"
  | "checkpoint:restored"
  // Context
  | "context:summarized"
  | "context:evicted"
  | "context:warning"
  | "context:overflow";

/** 커널 이벤트 — 시스템의 모든 이벤트를 통일된 구조로 기록 */
export interface KernelEvent {
  /** 이벤트 고유 ID */
  id: string;
  /** 단조 증가 시퀀스 번호 */
  seq: number;
  /** 이벤트 타입 */
  type: KernelEventType;
  /** 소속 세션 ID */
  sessionId: string;
  /** 발생 시각 (epoch ms) */
  timestamp: number;

  /** 이벤트 데이터 (타입별 자유 형식) */
  data: Record<string, unknown>;

  /** 원인 이벤트 ID (인과 체인) */
  parentEventId?: string;
  /** 관련 계획 노드 ID */
  planNodeId?: string;
  /** 관련 도구 이름 */
  toolName?: string;
  /** 관련 파일 경로 */
  file?: string;

  /** 이 이벤트의 토큰 비용 */
  tokenCost?: number;
}

/** 이벤트 리스너 타입 */
type EventListener = (event: KernelEvent) => void;

/**
 * EventLog — 순서가 보장되는 이벤트 스트림 관리.
 *
 * - append: 이벤트 추가 (id, seq, timestamp 자동 설정)
 * - on: 타입별 구독 ("*"로 전체 구독)
 * - query: 타입/세션/노드/범위별 조회
 * - analysis: 타임라인, 도구 통계, 토큰 사용량
 * - replay: 비동기 이벤트 재생
 * - persistence: JSON 직렬화/역직렬화
 */
export class EventLog {
  private events: KernelEvent[] = [];
  private seqCounter = 0;
  private readonly maxSize: number;
  private listeners: Map<
    KernelEventType | "*",
    Set<EventListener>
  > = new Map();

  /**
   * @param maxSize 최대 이벤트 보관 수 (기본 10000)
   */
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  // ─── Append ───

  /**
   * 이벤트 추가. id, seq, timestamp를 자동으로 설정한다.
   * maxSize 초과 시 가장 오래된 이벤트를 제거.
   */
  append(
    event: Omit<KernelEvent, "id" | "seq" | "timestamp">,
  ): KernelEvent {
    const fullEvent: KernelEvent = {
      ...event,
      id: crypto.randomUUID(),
      seq: this.seqCounter++,
      timestamp: Date.now(),
    };

    this.events.push(fullEvent);

    // 용량 초과 시 오래된 이벤트 제거
    if (this.events.length > this.maxSize) {
      const excess = this.events.length - this.maxSize;
      this.events.splice(0, excess);
    }

    // 리스너 통지
    this.notifyListeners(fullEvent);

    return fullEvent;
  }

  // ─── Subscribe ───

  /**
   * 이벤트 구독. "*"로 모든 이벤트를 구독할 수 있다.
   * @returns 구독 해제 함수
   */
  on(
    type: KernelEventType | "*",
    listener: EventListener,
  ): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);

    return () => {
      const set = this.listeners.get(type);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.listeners.delete(type);
        }
      }
    };
  }

  // ─── Query ───

  /** 전체 이벤트 목록 (읽기 전용) */
  getAll(): readonly KernelEvent[] {
    return this.events;
  }

  /** 타입별 이벤트 조회 */
  getByType(type: KernelEventType): KernelEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /** 세션별 이벤트 조회 */
  getBySession(sessionId: string): KernelEvent[] {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  /** 계획 노드별 이벤트 조회 */
  getByPlanNode(nodeId: string): KernelEvent[] {
    return this.events.filter((e) => e.planNodeId === nodeId);
  }

  /** 시퀀스 범위로 이벤트 조회 */
  getRange(fromSeq: number, toSeq?: number): KernelEvent[] {
    return this.events.filter(
      (e) => e.seq >= fromSeq && (toSeq === undefined || e.seq <= toSeq),
    );
  }

  /** 마지막 N개 이벤트 조회 */
  getLast(n: number): KernelEvent[] {
    if (n <= 0) return [];
    return this.events.slice(-n);
  }

  // ─── Analysis ───

  /**
   * 세션 타임라인 — 이벤트를 phase 전이 기준으로 그룹화.
   */
  getTimeline(
    sessionId: string,
  ): { phase: string; events: KernelEvent[]; duration: number }[] {
    const sessionEvents = this.getBySession(sessionId);
    if (sessionEvents.length === 0) return [];

    const phases: {
      phase: string;
      events: KernelEvent[];
      duration: number;
    }[] = [];

    let currentPhase = "init";
    let phaseEvents: KernelEvent[] = [];
    let phaseStart = sessionEvents[0].timestamp;

    for (const event of sessionEvents) {
      // phase 전환 감지: session:start, plan:created, tool:call 등의 패턴
      const newPhase = this.detectPhase(event);
      if (newPhase && newPhase !== currentPhase) {
        // 이전 phase 마감
        if (phaseEvents.length > 0) {
          phases.push({
            phase: currentPhase,
            events: phaseEvents,
            duration: event.timestamp - phaseStart,
          });
        }
        currentPhase = newPhase;
        phaseEvents = [];
        phaseStart = event.timestamp;
      }
      phaseEvents.push(event);
    }

    // 마지막 phase 마감
    if (phaseEvents.length > 0) {
      const lastTs = phaseEvents[phaseEvents.length - 1].timestamp;
      phases.push({
        phase: currentPhase,
        events: phaseEvents,
        duration: lastTs - phaseStart,
      });
    }

    return phases;
  }

  /**
   * 에이전트 의사결정 로그 (type === "agent:decision").
   */
  getDecisionLog(sessionId: string): KernelEvent[] {
    return this.events.filter(
      (e) => e.sessionId === sessionId && e.type === "agent:decision",
    );
  }

  /**
   * 도구별 통계 — 호출 수, 에러 수, 평균 실행 시간.
   */
  getToolStats(
    sessionId: string,
  ): { tool: string; calls: number; errors: number; avgDuration: number }[] {
    const toolMap = new Map<
      string,
      { calls: number; errors: number; totalDuration: number }
    >();

    const sessionEvents = this.getBySession(sessionId);

    for (const event of sessionEvents) {
      if (!event.toolName) continue;

      if (!toolMap.has(event.toolName)) {
        toolMap.set(event.toolName, {
          calls: 0,
          errors: 0,
          totalDuration: 0,
        });
      }
      const stats = toolMap.get(event.toolName)!;

      if (event.type === "tool:call") {
        stats.calls += 1;
      } else if (event.type === "tool:error") {
        stats.errors += 1;
      } else if (event.type === "tool:result") {
        const duration =
          typeof event.data.durationMs === "number"
            ? event.data.durationMs
            : 0;
        stats.totalDuration += duration;
      }
    }

    return Array.from(toolMap.entries()).map(([tool, stats]) => ({
      tool,
      calls: stats.calls,
      errors: stats.errors,
      avgDuration:
        stats.calls > 0
          ? Math.round(stats.totalDuration / stats.calls)
          : 0,
    }));
  }

  /**
   * 세션별 토큰 사용량 — 전체 + phase별 분류.
   */
  getTokenUsage(
    sessionId: string,
  ): { total: number; byPhase: Record<string, number> } {
    let total = 0;
    const byPhase: Record<string, number> = {};
    const timeline = this.getTimeline(sessionId);

    for (const phase of timeline) {
      let phaseTokens = 0;
      for (const event of phase.events) {
        if (event.tokenCost !== undefined) {
          phaseTokens += event.tokenCost;
          total += event.tokenCost;
        }
      }
      if (phaseTokens > 0) {
        byPhase[phase.phase] = phaseTokens;
      }
    }

    return { total, byPhase };
  }

  // ─── Replay ───

  /**
   * 비동기 이벤트 재생 — 지정 시퀀스부터 이벤트를 순서대로 yield.
   * @param fromSeq 시작 시퀀스 번호
   * @param speed 재생 속도 배율 (1 = 실시간, 2 = 2배속). 0이면 즉시.
   */
  async *replay(
    fromSeq: number,
    speed = 0,
  ): AsyncGenerator<KernelEvent> {
    const events = this.getRange(fromSeq);
    let prevTimestamp: number | null = null;

    for (const event of events) {
      // 속도 배율에 따라 이벤트 간 대기
      if (speed > 0 && prevTimestamp !== null) {
        const delay = (event.timestamp - prevTimestamp) / speed;
        if (delay > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      }
      prevTimestamp = event.timestamp;
      yield event;
    }
  }

  // ─── Persistence ───

  /** JSON 직렬화 */
  toJSON(): Record<string, unknown> {
    return {
      events: this.events,
      seqCounter: this.seqCounter,
      maxSize: this.maxSize,
    };
  }

  /** JSON에서 EventLog 복구 */
  static fromJSON(json: Record<string, unknown>): EventLog {
    const maxSize = (json.maxSize as number) ?? 10000;
    const log = new EventLog(maxSize);
    log.events = (json.events as KernelEvent[]) ?? [];
    log.seqCounter = (json.seqCounter as number) ?? 0;
    return log;
  }

  // ─── Cleanup ───

  /**
   * 오래된 이벤트를 제거.
   * @param keepLast 유지할 최근 이벤트 수 (기본: maxSize의 절반)
   * @returns 제거된 이벤트 수
   */
  prune(keepLast?: number): number {
    const keep = keepLast ?? Math.floor(this.maxSize / 2);
    if (this.events.length <= keep) return 0;

    const removeCount = this.events.length - keep;
    this.events.splice(0, removeCount);
    return removeCount;
  }

  // ─── Private Helpers ───

  /** 리스너에게 이벤트 통지 */
  private notifyListeners(event: KernelEvent): void {
    // 타입별 리스너
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(event);
        } catch {
          // 리스너 에러는 무시 (이벤트 시스템의 안정성 우선)
        }
      }
    }

    // 와일드카드 리스너
    const allListeners = this.listeners.get("*");
    if (allListeners) {
      for (const listener of allListeners) {
        try {
          listener(event);
        } catch {
          // 리스너 에러는 무시
        }
      }
    }
  }

  /** 이벤트 타입에서 phase 감지 */
  private detectPhase(event: KernelEvent): string | null {
    switch (event.type) {
      case "session:start":
        return "start";
      case "plan:created":
        return "planning";
      case "plan:node_running":
      case "tool:call":
        return "executing";
      case "verify:start":
        return "verifying";
      case "plan:replan":
        return "replanning";
      case "session:complete":
        return "complete";
      case "session:fail":
        return "failed";
      case "session:stop":
        return "stopped";
      default:
        return null;
    }
  }
}
