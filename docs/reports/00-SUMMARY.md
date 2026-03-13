# YUAN vs Claude Code — 전체 검증 요약

> 검증일: 2026-03-13 | 4개 병렬 에이전트 검증

---

## 전체 판정표

| 영역 | 상태 | 핵심 결론 |
|------|------|-----------|
| [컨텍스트 압축](./01-context-compression.md) | ⚠️ 부분 | ContextManager 연결됨, ContextCompressor/BudgetManager 미연결 |
| [코드 이해도](./02-code-understanding.md) | ⚠️ 구조적 | 정규식 기반 실제 작동, 의미 이해는 LLM 의존 |
| [에러 자동수정](./03-auto-error-fix.md) | ✅ 작동 | tsc/eslint 실행 후 LLM에 프롬프트 주입 방식 |
| [멀티파일 리팩토링](./04-multi-file-refactoring.md) | ⚠️ 부분 | 분석 인프라 우수, 실행은 순차적 + LLM 의존 |

---

## 있는데 안 쓰는 코드 (즉시 연결 가능)

```
ContextCompressor        → ContextManager 대체 가능 (우선순위 기반 압축)
ContextBudgetManager     → LLM 요약 + 체크포인트 (LLM 콜백만 주입하면 됨)
CrossFileRefactor        → rename/move 태스크에 연결하면 정확도 대폭 향상
DependencyAnalyzer       → 파일 수정 순서 자동 정렬에 활용 가능
SelfDebugLoop.llmFixer   → 현재 콜백 미주입으로 분석만 하고 수정 안 함
```

---

## Claude Code와 구조적 차이

### Claude Code
```
에러 발생 → Claude가 직접 읽음 → 직접 파일 편집 → 빌드 재실행
```

### YUAN
```
에러 발생 → tsc/eslint 실행 → 프롬프트 생성 → context 주입
→ LLM이 tool call 생성 → 도구가 파일 편집 → 다음 iteration
```

YUAN은 모든 수정이 **LLM 매개** — 한 단계 더 간접적이지만, 구조는 명확히 분리됨.

---

## 즉시 수정 가능한 버그 Top 5

| 순위 | 파일 | 버그 | 난이도 |
|------|------|------|--------|
| 1 | `agent-loop.ts:1985` | 테스트 커맨드 `"pnpm build"` 하드코딩 | 저 |
| 2 | `agent-loop.ts:~1258` | HierarchicalPlanner 기본 비활성 | 저 |
| 3 | `agent-loop.ts:~1978` | SelfDebugLoop llmFixer 미주입 | 중 |
| 4 | `agent-loop.ts:2285` | 읽기 전용 tool 순차 실행 (병렬화 가능) | 중 |
| 5 | `context-manager.ts` | ContextCompressor 미연결 | 중 |

---

## 고치면 Claude Code 수준 되는 것들

| 항목 | 현재 | 수정 후 |
|------|------|---------|
| 병렬 tool 실행 | 순차 for loop | Promise.allSettled() 배치 → 2-4x 속도 향상 |
| 에러 자동수정 | LLM 간접 | SelfDebugLoop llmFixer 연결 → 직접 수정 루프 |
| 멀티파일 리팩토링 | LLM 판단 | CrossFileRefactor 연결 → 심볼 추적 정확 |
| 컨텍스트 관리 | 단순 truncation | ContextBudgetManager 연결 → LLM 요약 |
| 코드 이해도 | 정규식 | ts-morph AST 도입 → TS/JS 정확도 대폭 향상 |

---

## 결론

YUAN은 **구조는 Claude Code보다 더 명시적이고 모듈화**되어 있음.
그런데 그 구조들이 **서로 연결이 안 된 채로 export만** 되어 있는 경우가 많음.

> "코드는 있는데 와이어링이 없다"

agent-loop.ts를 중심으로 미연결 모듈들을 하나씩 연결하는 작업이 다음 단계.
