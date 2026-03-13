/**
 * @module dynamic-role-generator
 * @description 동적 에이전트 롤 생성기.
 *
 * Orchestrator가 기존 8종 고정 롤로 부족할 때 LLM에게 요청하여
 * 세션 범위의 동적 롤을 생성한다. 최대 2개 (슬롯 #9, #10).
 *
 * - LLM 호출은 콜백으로 주입 (직접 import 없음)
 * - 생성된 롤은 세션 종료 시 소멸
 * - 자주 생성되는 패턴은 저장하여 다음 세션에서 자동 제안
 */

import type { DynamicAgentRole, AgentRole } from "./types.js";

// ─── Types ───

/** 동적 롤 생성 요청 */
export interface DynamicRoleRequest {
  /** 현재 태스크 설명 */
  taskContext: string;
  /** 이미 활성화된 롤 목록 */
  existingRoles: AgentRole[];
  /** 왜 기존 롤로 부족한지 */
  gap: string;
}

/** 자주 생성되는 동적 롤 패턴 (학습용) */
export interface DynamicRolePattern {
  /** 역할 이름 */
  name: string;
  /** 역할 설명 */
  description: string;
  /** 생성 횟수 */
  frequency: number;
  /** 마지막 생성 시각 (epoch ms) */
  lastUsedAt: number;
}

// ─── Prompt ───

const DYNAMIC_ROLE_PROMPT = `현재 태스크: {taskContext}
활성 에이전트: {existingRoles}
부족한 부분: {gap}

새 에이전트 역할을 정의하세요. 반드시 아래 JSON 형식으로만 응답하세요:

{
  "name": "짧은 역할명 (영문, kebab-case)",
  "description": "1줄 설명",
  "systemPrompt": "이 에이전트의 시스템 프롬프트 (구체적이고 행동 지향적)",
  "allowedTools": ["필요한", "도구", "목록"],
  "reason": "왜 이 역할이 필요한지"
}

주의:
- 기존 8종(orchestrator, coder, reviewer, memory, search, security, data, automation)과 중복되면 안 됩니다.
- name은 kebab-case 영문만 사용하세요.
- allowedTools는 실제 존재하는 도구만 지정하세요.`;

// ─── DynamicRoleGenerator ───

/**
 * 동적 에이전트 롤 생성기.
 *
 * 사용법:
 * ```ts
 * const generator = new DynamicRoleGenerator();
 * const role = await generator.generate(request, llmCall);
 * ```
 */
export class DynamicRoleGenerator {
  private dynamicRoles: DynamicAgentRole[] = [];
  private readonly maxDynamic: number;
  private readonly patterns: Map<string, DynamicRolePattern> = new Map();

  constructor(maxDynamic = 2) {
    this.maxDynamic = maxDynamic;
  }

  /**
   * LLM을 통해 동적 롤을 생성한다.
   *
   * @param request - 생성 요청 (태스크 컨텍스트, 기존 롤, 부족한 부분)
   * @param llmCall - LLM 호출 콜백 (prompt → response)
   * @returns 생성된 DynamicAgentRole
   * @throws 슬롯 초과 또는 LLM 응답 파싱 실패 시 Error
   */
  async generate(
    request: DynamicRoleRequest,
    llmCall: (prompt: string) => Promise<string>,
  ): Promise<DynamicAgentRole> {
    // 슬롯 제한 확인
    if (this.dynamicRoles.length >= this.maxDynamic) {
      throw new Error(
        `Dynamic role limit reached (max ${this.maxDynamic}). ` +
          `Active: ${this.dynamicRoles.map((r) => r.name).join(", ")}`,
      );
    }

    // 프롬프트 구성
    const existingRoleNames = request.existingRoles.map((r) =>
      typeof r === "string" ? r : r.name,
    );
    const prompt = DYNAMIC_ROLE_PROMPT.replace(
      "{taskContext}",
      request.taskContext,
    )
      .replace("{existingRoles}", existingRoleNames.join(", "))
      .replace("{gap}", request.gap);

    // LLM 호출
    const response = await llmCall(prompt);

    // JSON 파싱
    const parsed = this.parseResponse(response);

    // 중복 검증
    this.validateNoDuplicate(parsed.name, request.existingRoles);

    // DynamicAgentRole 생성
    const role: DynamicAgentRole = {
      name: parsed.name,
      description: parsed.description,
      systemPrompt: parsed.systemPrompt,
      allowedTools: parsed.allowedTools,
      createdBy: "model",
      reason: parsed.reason,
    };

    this.dynamicRoles.push(role);

    // 패턴 학습
    this.recordPattern(role);

    return role;
  }

  /** 현재 활성 동적 롤 목록 반환 */
  getActive(): DynamicAgentRole[] {
    return [...this.dynamicRoles];
  }

  /** 남은 동적 슬롯 수 */
  getRemainingSlots(): number {
    return this.maxDynamic - this.dynamicRoles.length;
  }

  /** 모든 동적 롤 제거 (세션 종료 시) */
  clear(): void {
    this.dynamicRoles = [];
  }

  /** 자주 생성되는 패턴 조회 (빈도 내림차순) */
  getFrequentPatterns(limit = 5): DynamicRolePattern[] {
    return [...this.patterns.values()]
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, limit);
  }

  /**
   * 외부에서 저장된 패턴을 로드한다 (세션 시작 시).
   * YUAN.md 등에서 읽어온 패턴을 주입.
   */
  loadPatterns(patterns: DynamicRolePattern[]): void {
    for (const p of patterns) {
      this.patterns.set(p.name, p);
    }
  }

  // ─── Private ───

  /** LLM 응답에서 JSON 파싱 */
  private parseResponse(response: string): {
    name: string;
    description: string;
    systemPrompt: string;
    allowedTools: string[];
    reason: string;
  } {
    // JSON 블록 추출 (```json ... ``` 또는 raw JSON)
    const jsonMatch =
      response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ??
      response.match(/(\{[\s\S]*\})/);

    if (!jsonMatch?.[1]) {
      throw new Error(
        `Failed to parse dynamic role response: no JSON found.\nResponse: ${response.slice(0, 200)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      throw new Error(
        `Failed to parse dynamic role JSON: ${jsonMatch[1].slice(0, 200)}`,
      );
    }

    // 필수 필드 검증
    const obj = parsed as Record<string, unknown>;
    const required = [
      "name",
      "description",
      "systemPrompt",
      "allowedTools",
      "reason",
    ] as const;
    for (const field of required) {
      if (!(field in obj)) {
        throw new Error(
          `Dynamic role response missing required field: ${field}`,
        );
      }
    }

    if (
      typeof obj.name !== "string" ||
      typeof obj.description !== "string" ||
      typeof obj.systemPrompt !== "string" ||
      typeof obj.reason !== "string"
    ) {
      throw new Error("Dynamic role response has invalid field types");
    }

    if (!Array.isArray(obj.allowedTools)) {
      throw new Error("Dynamic role allowedTools must be an array");
    }

    const allowedTools = obj.allowedTools.filter(
      (t): t is string => typeof t === "string"
    );

    // name 형식 검증 (kebab-case)
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(obj.name)) {
      throw new Error(
        `Dynamic role name must be kebab-case: got "${obj.name}"`,
      );
    }

    return {
      name: obj.name,
      description: obj.description,
      systemPrompt: obj.systemPrompt,
      allowedTools,
      reason: obj.reason,
    };
  }

  /** 기존 롤과 중복 확인 */
  private validateNoDuplicate(
    name: string,
    existingRoles: AgentRole[],
  ): void {
    // 이미 활성화된 동적 롤과 중복 확인
    if (this.dynamicRoles.some((r) => r.name === name)) {
      throw new Error(`Dynamic role "${name}" already exists in this session`);
    }

    // 기존 롤(고정 포함)과 중복 확인
    for (const role of existingRoles) {
      const roleName = typeof role === "string" ? role : role.name;
      if (roleName === name) {
        throw new Error(
          `Dynamic role "${name}" conflicts with existing role`,
        );
      }
    }
  }

  /** 패턴 학습 — 빈도 기록 */
  private recordPattern(role: DynamicAgentRole): void {
    const existing = this.patterns.get(role.name);
    if (existing) {
      existing.frequency += 1;
      existing.lastUsedAt = Date.now();
    } else {
      this.patterns.set(role.name, {
        name: role.name,
        description: role.description,
        frequency: 1,
        lastUsedAt: Date.now(),
      });
    }
  }
}
