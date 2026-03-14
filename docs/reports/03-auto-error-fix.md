# 에러 자동수정 파이프라인 — 검증 리포트

> 검증일: 2026-03-13 | 검증 에이전트: Explore (Haiku 4.5)

---

## 판정: ✅ 실제 작동 (간접적 LLM 매개 방식, Claude Code와 구조 차이)

---

## 실제 작동 흐름

```
도구 실행 완료
  ↓
validateAndFeedback() 호출 (agent-loop.ts:2494)
  ↓
autoFixLoop.validateResult() → 실제 tsc/eslint 실행 (auto-fix.ts:318-381)
  ↓
canRetry() 체크 (최대 3회)
  ↓
buildFixPrompt() → "[AUTO-FIX 1/3]" 프롬프트 생성
  ↓
deferredFixPrompts에 추가 (agent-loop.ts:2496)
  ↓
tool results 이후 context에 주입 (agent-loop.ts:1837-1841)
  ↓
LLM이 프롬프트 받아 새 tool call 생성 (file_write/file_edit)
  ↓
검증 통과 시: resetAttempts() / 실패 시 다음 단계 에스컬레이션
```

---

## 모듈별 실제 구현

### AutoFixLoop (auto-fix.ts) ✅
- **실제 tsc/eslint 실행:** `execFile()` (line 466), 30초 타임아웃
  - ESLint 우선 (line 325: `npx eslint . --quiet`)
  - 실패 시 TypeScript fallback (line 368: `npx tsc --noEmit --pretty`)
- **에러 분류:** type, lint, import, build, runtime
- **최대 재시도:** 3회 (line 101: `maxRetries: 3`)
- **대상 도구:** file_write, file_edit, shell_exec 결과 검증

### SelfDebugLoop (self-debug-loop.ts) ✅
- **5단계 에스컬레이션** (lines 223-229):
  1. `direct_fix` — 타겟 에디트
  2. `context_expand` — 더 많은 파일 읽기
  3. `alternative` — 완전히 다른 접근
  4. `rollback_fresh` — 원본 복원 후 재시작
  5. `escalate` — 사용자에게 에스컬레이션
- **실제 검증 명령 실행:** `runTest(testCommand)` (line 371)
- **최대 시도:** 5회 (line 275)
- **⚠️ 버그:** 테스트 커맨드 하드코딩 `"pnpm build"` (line 1985) — 프로젝트별 설정 불가

### FailureRecovery (failure-recovery.ts) ✅
- **5가지 전략:** retry, rollback, approach_change, scope_reduce, escalate
- **전략 선택 로직:**
  - 1회 시도 + 수정 가능 에러(BUILD/LINT/TYPE) → retry
  - PERMISSION/RESOURCE 에러 → 즉시 escalate
  - 2회+ + 롤백 미실행 → rollback
  - 타임아웃 + 2회+ → scope_reduce
  - 전략 2개 이상 실패 → escalate
- **롤백:** 파일 원본 원자적 복원 (line 448)
- **총 최대 시도 횟수:** AutoFix(3) + SelfDebug(5) + Recovery(2) = **최대 10회**

### QAPipeline (qa-pipeline.ts) ✅ (선택 모드)
- **5단계:** Structural → Semantic → Quality → Review → Decision
- **quick 모드:** 구조적 검사만
- **thorough 모드:** LLM 코드리뷰 포함
- **자동 fix:** `autoFix: true` 기본, `maxFixAttempts: 3`
- **⚠️ 미연결:** agent-loop에서 기본 활성화 안 됨

---

## Claude Code 비교

| 항목 | Claude Code | YUAN |
|------|-------------|------|
| 빌드 에러 감지 | ✅ (tsc 직접 실행) | ✅ (tsc/eslint 실행) |
| 에러 파싱 | ✅ | ✅ |
| 파일 직접 수정 | ✅ (Claude가 직접 편집) | ❌ (LLM에 프롬프트 → LLM이 tool call 생성) |
| 빌드 재실행 | ✅ | ✅ |
| 최대 재시도 | 암묵적 | 명시적 3+5+2=10회 |
| 결정론적 수정 | ✅ | ❌ (LLM 매개라 비결정론적) |
| 병렬 검증 | ❌ | ❌ |

**핵심 차이:** Claude Code는 에러를 읽고 **직접** 파일을 편집. YUAN은 에러를 읽고 LLM에게 "고쳐달라"는 **프롬프트를 주입** → LLM이 tool call 생성 → 도구가 파일 편집. 한 단계 더 간접적.

---

## 실제 버그 목록

| 버그 | 위치 | 심각도 |
|------|------|--------|
| 테스트 커맨드 `"pnpm build"` 하드코딩 | agent-loop.ts:1985 | 중 |
| AutoFixLoop가 LLM 수정 성공 여부 미추적 | auto-fix.ts:2680-2685 | 중 |
| SelfDebugLoop llmFixer가 optional이라 미주입 시 분석만 하고 수정 안 함 | self-debug-loop.ts:285 | 고 |
| 같은 에러 연속 3회 시 즉시 에스컬레이션 로직 없음 | failure-recovery.ts | 저 |

---

## 수정 우선순위

| 순위 | 작업 | 난이도 |
|------|------|--------|
| 1 | SelfDebugLoop에 llmFixer 콜백 실제 주입 | 중 |
| 2 | 테스트 커맨드를 프로젝트 설정에서 읽도록 수정 | 저 |
| 3 | AutoFixLoop 성공 추적 피드백 루프 추가 | 중 |
| 4 | QAPipeline을 agent-loop 기본 활성화 | 중 |
