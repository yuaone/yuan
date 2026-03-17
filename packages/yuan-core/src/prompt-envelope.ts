/**
 * @module prompt-envelope
 * @description PromptRuntime → PromptBuilder 전달 계약.
 * PromptBuilder는 이 타입만 받아서 string으로 렌더링.
 * 정책 판단 불가, 필드 해석 불가 — 문자열 합치기만.
 */

/** 프롬프트 섹션 하나 */
export interface PromptSection {
  /** 섹션 이름 (디버그/로깅용) */
  name: string;
  /** 섹션 내용 */
  content: string;
  /** 우선순위 (낮을수록 먼저, 같으면 삽입 순서) */
  priority: number;
  /** 토큰 예산 초과 시 삭제 가능 여부 */
  droppable: boolean;
}

/** PromptRuntime이 생성, PromptBuilder가 소비 */
export interface PromptEnvelope {
  /** 불변 헌법 (정체성, safety, core rules) — 항상 첫 번째 */
  systemCoreSections: PromptSection[];
  /** Decision 기반 정책 (mode, role, budget hints, veto hints) */
  runtimePolicySections: PromptSection[];
  /** 역할 섹션 (planner/coder/verifier — Decision에서 결정) */
  roleSections: PromptSection[];
  /** 태스크 컨텍스트 (worldState, memory, skills, project) */
  taskContextSections: PromptSection[];
  /** 이번 iteration 전용 (반복당 힌트: QA, reflection, budget warning) */
  ephemeralSections: PromptSection[];
  /** 강화 섹션 (U-curve 두 번째 피크 — 마지막에 배치) */
  reinforceSections: PromptSection[];
  /** system prompt 토큰 예산 (PromptBuilder가 이 한도 내에서 droppable 관리) */
  maxTokens?: number;
}

/** section 생성 헬퍼 */
export function section(name: string, content: string, opts?: {
  priority?: number;
  droppable?: boolean;
}): PromptSection {
  return {
    name,
    content,
    priority: opts?.priority ?? 50,
    droppable: opts?.droppable ?? false,
  };
}
