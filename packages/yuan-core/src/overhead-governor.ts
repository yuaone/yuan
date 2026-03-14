/**
 * @module overhead-governor
 * @description 서브시스템 실행 정책 중앙 관리자.
 *
 * "Main loop is sacred. All secondary intelligence must earn the right to block."
 *
 * 모든 optional 서브시스템(AutoTSC, Debate, SelfReflection, QAPipeline 등)은
 * 이 Governor의 결정 없이 blocking으로 실행될 수 없다.
 *
 * 모드:
 *   OFF      — 실행 안 함
 *   SHADOW   — 실제 실행 없이 "실행됐을 것" 로그만 남김
 *   BLOCKING — 실제 blocking 실행
 */

import { readFileSync } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GuardMode = "OFF" | "SHADOW" | "BLOCKING";

export type TaskPhase = "explore" | "implement" | "verify" | "finalize";

/**
 * Governor가 결정할 때 사용하는 런타임 시그널.
 */
export interface TriggerContext {
  /** 이번 iteration에서 변경된 파일 목록 */
  changedFiles: string[];
  /** 마지막 verify 이후 write 횟수 */
  writeCountSinceVerify: number;
  /** 누적 tool 에러 횟수 */
  failureCount: number;
  /** 반복되는 에러 시그니처 (동일 에러 문자열) */
  repeatedErrorSignature?: string;
  /** planner 신뢰도 (0~1) */
  plannerConfidence?: number;
  /** 현재 컨텍스트 사용률 (0~1) */
  contextUsageRatio: number;
  /** 위험한 write (핵심 파일: tsconfig, package.json, public API 등) */
  riskyWrite: boolean;
  /** 현재 task phase */
  taskPhase: TaskPhase;
  /** 현재 iteration index */
  iteration: number;
  /** 이번 iteration에서 이미 verify가 실행됐는지 */
  verifyRanThisIteration: boolean;
  /** 이번 iteration에서 이미 summarize가 실행됐는지 */
  summarizeRanThisIteration: boolean;
  /** 이번 iteration에서 llmFixer가 실행된 횟수 */
  llmFixerRunCount: number;
}

/**
 * 각 서브시스템별 사용자 설정 (feature flags).
 * 기본값은 GPT 권장 정책.
 */
export interface OverheadGovernorConfig {
  autoTsc?: GuardMode;
  debate?: GuardMode;
  deepVerify?: GuardMode;
  quickVerify?: GuardMode;
  qaPipeline?: GuardMode;
  llmFixer?: GuardMode;
  summarize?: GuardMode;
  // Phase 3: Autonomous Engineering Loop subsystems
  /** ResearchAgent — web/repo/docs search orchestration */
  research?: GuardMode;
  /** PatchTournamentExecutor — multi-candidate patch generation + selection */
  tournament?: GuardMode;
  /** IncidentDebugMode — log/trace/commit failure analysis */
  debugMode?: GuardMode;
}

const DEFAULTS: Required<OverheadGovernorConfig> = {
  autoTsc:    "SHADOW",
  debate:     "OFF",
  deepVerify: "OFF",
  quickVerify: "SHADOW",
  qaPipeline:  "SHADOW",  // SHADOW: runs + emits event, but does NOT block LLM loop
  llmFixer:    "OFF",
  summarize:   "SHADOW",
  // Phase 3 defaults — OFF until explicitly enabled (high-cost operations)
  research:    "OFF",
  tournament:  "OFF",
  debugMode:   "OFF",
};

// ─── OverheadGovernor ────────────────────────────────────────────────────────

export class OverheadGovernor {
  private readonly cfg: Required<OverheadGovernorConfig>;
  /** Shadow mode 로그 콜백 (TUI로 보내거나 stdout) */
  private readonly onShadow?: (subsystem: string, reason: string) => void;

  constructor(
    config?: OverheadGovernorConfig,
    onShadow?: (subsystem: string, reason: string) => void,
  ) {
    this.cfg = { ...DEFAULTS, ...config };
    this.onShadow = onShadow;
  }

  // ─── Per-subsystem decision methods ───────────────────────────────────────

  /** Auto-TSC: TS 타입 체크 자동 실행 여부 */
  shouldRunAutoTsc(ctx: TriggerContext): GuardMode {
    const base = this.cfg.autoTsc;
    if (base === "OFF") return "OFF";

    // single-flight: 이미 이번 iteration에 verify 돌았으면 SKIP
    if (ctx.verifyRanThisIteration) return "OFF";

    const tsChanged = ctx.changedFiles.filter(f =>
      f.endsWith(".ts") || f.endsWith(".tsx")
    );
    const riskyFileChanged = ctx.changedFiles.some(f =>
      f.includes("tsconfig") || f.includes("package.json") ||
      f.includes(".d.ts") || f.includes("index.ts")
    );

    // BLOCKING 조건: TS 파일 2개 이상 + (risky 파일 변경 or finalize phase)
    if (base === "BLOCKING" || ctx.taskPhase === "finalize" || ctx.taskPhase === "verify") {
      if (tsChanged.length >= 2 || riskyFileChanged) return "BLOCKING";
    }

    // 그 외엔 SHADOW
    if (tsChanged.length >= 2 || riskyFileChanged) {
      this._shadow("AutoTSC", `would run: ${tsChanged.length} TS files changed`);
      return "SHADOW";
    }

    return "OFF";
  }

  /** DebateOrchestrator: 복잡한 태스크에서 multi-agent debate */
  shouldRunDebate(ctx: TriggerContext): GuardMode {
    const base = this.cfg.debate;
    if (base === "OFF") return "OFF";

    // single-flight
    if (ctx.verifyRanThisIteration) return "OFF";

    // BLOCKING 조건: planner confidence 낮음 + 2번 이상 실패
    const lowConfidence = (ctx.plannerConfidence ?? 1) < 0.4;
    const repeatedFailure = ctx.failureCount >= 2 && !!ctx.repeatedErrorSignature;

    if (lowConfidence && repeatedFailure && ctx.riskyWrite) {
      return base === "BLOCKING" ? "BLOCKING" : "SHADOW";
    }

    this._shadow("Debate", "would run: low confidence + repeated failure");
    return "OFF";
  }

  /** SelfReflection.deepVerify: 완료 시점 심층 코드 검증 */
  shouldRunDeepVerify(ctx: TriggerContext): GuardMode {
    const base = this.cfg.deepVerify;
    if (base === "OFF") return "OFF";

    // single-flight
    if (ctx.verifyRanThisIteration) return "OFF";

    // BLOCKING 조건: finalize/verify phase + 파일 변경 있음
    const hasChanges = ctx.changedFiles.length > 0;
    if (
      (ctx.taskPhase === "finalize" || ctx.taskPhase === "verify") &&
      hasChanges
    ) {
      return base === "BLOCKING" ? "BLOCKING" : "SHADOW";
    }

    this._shadow("DeepVerify", "would run at completion");
    return "OFF";
  }

  /** SelfReflection.quickVerify: 주기적 경량 검증 */
  shouldRunQuickVerify(ctx: TriggerContext): GuardMode {
    const base = this.cfg.quickVerify;
    if (base === "OFF") return "OFF";

    // single-flight
    if (ctx.verifyRanThisIteration) return "OFF";

    // BLOCKING 조건: 실패 2회 이상 or 반복 에러
    const repeatedError = ctx.failureCount >= 2 && !!ctx.repeatedErrorSignature;
    if (repeatedError) {
      return base === "BLOCKING" ? "BLOCKING" : "SHADOW";
    }

    // SHADOW: 매 3번마다 로그만
    if (ctx.iteration % 3 === 0) {
      this._shadow("QuickVerify", `would run at iteration ${ctx.iteration}`);
    }
    return "OFF";
  }

  /** QAPipeline: write 후 코드 품질 검사 */
  shouldRunQaPipeline(ctx: TriggerContext): GuardMode {
    const base = this.cfg.qaPipeline;
    if (base === "OFF") return "OFF";

    // BLOCKING 조건: finalize phase or write count 누적
    if (ctx.taskPhase === "finalize" || ctx.writeCountSinceVerify >= 5) {
      return base === "BLOCKING" ? "BLOCKING" : "SHADOW";
    }

    this._shadow("QAPipeline", `would run: ${ctx.writeCountSinceVerify} writes since last verify`);
    return "OFF";
  }

  /** SelfDebugLoop.llmFixer: LLM 기반 에러 자동 수정 */
  shouldRunLlmFixer(ctx: TriggerContext): GuardMode {
    const base = this.cfg.llmFixer;
    if (base === "OFF") return "OFF";

    // single-flight: 이번 iteration에 이미 실행됐으면 SKIP
    if (ctx.llmFixerRunCount >= 1) return "OFF";

    // BLOCKING 조건: 동일 에러 2회 이상 반복
    if (ctx.failureCount >= 2 && !!ctx.repeatedErrorSignature) {
      return base === "BLOCKING" ? "BLOCKING" : "SHADOW";
    }

    this._shadow("LlmFixer", "would run: error detected");
    return "OFF";
  }

  /** ContextBudgetManager.summarize: 컨텍스트 요약으로 공간 확보 */
  shouldRunSummarize(ctx: TriggerContext): GuardMode {
    const base = this.cfg.summarize;
    if (base === "OFF") return "OFF";

    // single-flight
    if (ctx.summarizeRanThisIteration) return "OFF";

    // BLOCKING 조건: 컨텍스트 75% 초과 (70% 아님 — 더 보수적)
    if (ctx.contextUsageRatio >= 0.75) {
      return base === "BLOCKING" ? "BLOCKING" : "SHADOW";
    }

    // SHADOW 로그: 60% 초과 시
    if (ctx.contextUsageRatio >= 0.60) {
      this._shadow("Summarize", `would run: context at ${Math.round(ctx.contextUsageRatio * 100)}%`);
    }
    return "OFF";
  }

  // ─── Phase 3: Autonomous Engineering Loop guards ─────────────────────────

  /** ResearchAgent: only run when goal requires external information */
  shouldRunResearch(ctx: TriggerContext): GuardMode {
    const base = this.cfg.research;
    if (base === "OFF") return "OFF";
    // BLOCKING: only at explore phase start
    if (ctx.taskPhase === "explore" && ctx.iteration === 0) {
      return base === "BLOCKING" ? "BLOCKING" : "SHADOW";
    }
    this._shadow("Research", "would run at explore phase start");
    return "OFF";
  }

  /** PatchTournamentExecutor: only run for high-risk writes in finalize */
  shouldRunTournament(ctx: TriggerContext): GuardMode {
    const base = this.cfg.tournament;
    if (base === "OFF") return "OFF";
    // BLOCKING: risky write in finalize phase
    if (ctx.taskPhase === "finalize" && ctx.riskyWrite) {
      return base === "BLOCKING" ? "BLOCKING" : "SHADOW";
    }
    this._shadow("Tournament", "would run: risky write in finalize");
    return "OFF";
  }

  /** IncidentDebugMode: only run when repeated errors detected */
  shouldRunDebugMode(ctx: TriggerContext): GuardMode {
    const base = this.cfg.debugMode;
    if (base === "OFF") return "OFF";
    // BLOCKING: 3+ repeated errors with same signature
    if (ctx.failureCount >= 3 && !!ctx.repeatedErrorSignature) {
      return base === "BLOCKING" ? "BLOCKING" : "SHADOW";
    }
    if (ctx.failureCount >= 2) {
      this._shadow("DebugMode", `would run: ${ctx.failureCount} failures`);
    }
    return "OFF";
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private _shadow(subsystem: string, reason: string): void {
    this.onShadow?.(subsystem, reason);
  }

  /**
   * 현재 설정 반환 (디버그용).
   */
  getConfig(): Required<OverheadGovernorConfig> {
    return { ...this.cfg };
  }

  /**
   * Load overrides from a JSON file (e.g. ~/.yuan/policy.json).
   * Only keys that exist in OverheadGovernorConfig are applied.
   * Unknown keys are silently ignored — safe to call with arbitrary files.
   *
   * Example .yuan/policy.json:
   *   { "research": "BLOCKING", "tournament": "BLOCKING", "debugMode": "BLOCKING" }
   */
  static loadFromFile(filePath: string): OverheadGovernorConfig {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const validModes = new Set(["OFF", "SHADOW", "BLOCKING"]);
      const validKeys = new Set<string>([
        "autoTsc", "debate", "deepVerify", "quickVerify", "qaPipeline",
        "llmFixer", "summarize", "research", "tournament", "debugMode",
      ]);
      const result: OverheadGovernorConfig = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (validKeys.has(k) && validModes.has(String(v))) {
          (result as Record<string, unknown>)[k] = v as GuardMode;
        }
      }
      return result;
    } catch {
      return {};
    }
  }
}
