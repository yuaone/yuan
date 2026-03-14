# 컨텍스트 압축 — 검증 리포트

> 검증일: 2026-03-13 | 검증 에이전트: Explore (Haiku 4.5)

---

## 판정: ⚠️ 부분 구현 (핵심만 작동, 고급 기능 미연결)

---

## 실제 작동하는 것 ✅

### ContextManager (agent-loop에 연결됨)
- **파일:** `packages/yuan-core/src/context-manager.ts` (533줄)
- **진입점:** `prepareForLLM()` — 매 iteration 호출 (agent-loop.ts:1558)
- **압축 파이프라인 (실제 동작):**
  ```
  prepareForLLM()
  ├─ 예산 이내 → 그대로 반환
  └─ 초과 시:
     ├─ compactHistory() — 3단계 전략
     │   ├─ 시스템 메시지 보존
     │   ├─ 최근 5개 메시지 보존 (recentWindow=5)
     │   ├─ 중간 10개 요약 (summaryWindow=10)
     │   └─ 오래된 메시지 전체 요약
     └─ emergencyTrim() — 최후 fallback
         ├─ 시스템 + 최근 6개만 유지
         └─ 나머지 1개 요약으로 압축
  ```
- **도구 결과 압축:** head(30%) + "..." + tail(30%) 트런케이션
- **CJK 인식 토큰 카운팅:** 한/중/일 2char/token, ASCII 4char/token
- **85% 도달 시:** 체크포인트 저장 + 경고 이벤트 발생 (agent-loop.ts:1512-1523)

### TokenBudgetManager (agent-loop에 연결됨)
- **파일:** `packages/yuan-core/src/token-budget.ts`
- **역할별 예산:** executor(16k) > governor(8k) > validator(8k) > planner(4k) > ...
- **rebalance():** 유휴 역할 예산을 활성 역할로 재분배

---

## 코드는 있지만 미연결 ❌

### ContextCompressor
- **파일:** `context-compressor.ts` (668줄) — export만 됨, agent-loop에서 import 안 함
- **구현:** 우선순위 기반 4단계 압축 (system=10, userGoal=9, recentTool=8...)
- **도구별 압축 규칙:** file_read(70줄), grep(20줄), shell_exec(30줄 tail-only)
- **문제:** ContextManager보다 정교하나 완전히 미사용

### ContextBudgetManager
- **파일:** `context-budget.ts` (1249줄) — export만 됨
- **구현:** LLM 기반 요약, 체크포인트, 관련성 기반 검색
- **예산 배분:** systemPrompt(15%), conversation(40%), toolResults(25%), projectContext(10%), workingMemory(10%)
- **문제:** LLM 요약 콜백 주입 없이 사용 불가, agent-loop 미연결

---

## Claude Code 비교

| 항목 | Claude Code | YUAN |
|------|-------------|------|
| 압축 트리거 | 80% 자동 요약 | 85% 체크포인트만 (압축은 매 iteration) |
| 요약 방식 | LLM 기반 | 로컬 truncation + 단순 요약 |
| 슬라이딩 윈도우 | ✅ | ✅ (최근 5개) |
| 관련성 필터링 | ✅ | ❌ (항상 전체 히스토리) |
| 체크포인트/복구 | ✅ | 코드 있음, 미연결 |
| 토큰 정확도 | tiktoken (정확) | 정규식 근사 (±20%) |

---

## 수정 우선순위

| 순위 | 작업 | 난이도 |
|------|------|--------|
| 1 | ContextCompressor를 ContextManager 대신 연결 | 중 |
| 2 | 80% 임계값에서 LLM 요약 트리거 추가 | 중 |
| 3 | ContextBudgetManager.createCheckpoint() 세션에 연결 | 중 |
| 4 | 관련성 기반 메시지 필터링 추가 | 고 |
