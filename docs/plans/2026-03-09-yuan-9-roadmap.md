# YUAN Coding Agent — 9/10 로드맵

> **목표:** 현재 4.5/10 → 9/10 프로덕션급 자율 코딩 에이전트
> **기준일:** 2026-03-09
> **현재 규모:** ~100 source files, ~55,000+ lines (yuan-core: 57 files, ~47,000 lines)

---

## 현재 상태 요약

### 완료 (Phase 1-5)
- Core Agent Loop (LLM ↔ Tool 반복)
- Governor + ContextManager + ApprovalManager + AutoFixLoop
- HierarchicalPlanner (L1-L3) + Replan
- TaskClassifier + PromptDefense + ReflexionEngine + TokenBudgetManager
- ContinuationEngine (체크포인트 저장/복원)
- MemoryUpdater (풍부한 학습 추출)
- SSE Streaming (11 이벤트, 풀 파이프라인)
- 130+ 테스트, 보안 감사 + QA 완료

### 문제점 (감사 결과)
- **모듈 40% 미연결** — 만들어놓고 배선 안 됨
- **TokenBudget "executor"만 추적** — 6역할 중 5개 미사용
- **MCPClient AgentLoop에 없음** — ExecutionEngine에서만 사용
- **VectorIndex no-op** — 시맨틱 검색 비활성
- **Multi-Agent Debate/Speculative 미연결** — 독립 모듈 상태
- **Error Recovery 단순** — retry만, 근본 원인 분석 없음
- **실사용 검증 0** — 벤치마크 없음

---

## Phase 6: Foundation Wiring (4.5 → 6.0)

> 기존 모듈 전부 배선. 새 모듈 없이 있는 것 연결만으로 +1.5

### Batch 6-1: 미연결 모듈 배선
| 작업 | 파일 | 내용 |
|------|------|------|
| MCPClient → AgentLoop | agent-loop.ts | constructor에 MCPClient 주입, tool executor에 MCP 도구 등록 |
| TokenBudget 6역할 추적 | agent-loop.ts | planner/validator/reflector/classifier/governor LLM 호출에 recordUsage 추가 |
| DebateOrchestrator → ExecutionEngine | execution-engine.ts | verify phase에서 실제 debate 루프 활성화 |
| SpeculativeExecutor → ExecutionEngine | execution-engine.ts | design phase에서 2-3 approach 병렬 생성 |

### Batch 6-2: 기존 모듈 강화
| 작업 | 파일 | 내용 |
|------|------|------|
| ReflexionEngine guidance 검증 | agent-loop.ts | guidance 유효성 체크, 빈 전략 필터링 |
| PromptDefense LLM 응답 살균 | agent-loop.ts | LLM response도 injection 체크 |
| Memory 로드 에러 로깅 | agent-loop.ts | silent catch → 로깅 추가 |
| HierarchicalPlanner 전략 리플랜 | hierarchical-planner.ts | 전술적 수정뿐 아니라 전략 수준 리플랜 |

---

## Phase 7: World State + Failure Recovery (6.0 → 7.0)

> 에이전트가 프로젝트 상태를 "알고" 시작하고, 실패에 지능적으로 대응

### Batch 7-1: world-state.ts (신규)
```
WorldState
├── git: branch, status, recent commits, uncommitted changes
├── build: last build result, errors
├── test: last test result, failing tests
├── deps: outdated packages, missing deps
├── files: recently changed, conflict files
└── errors: recent runtime errors
```
- **배선:** AgentLoop.init()에서 WorldState 수집 → system prompt 주입
- **효과:** planner가 "빌드 깨져있는 상태"를 알고 시작 → 정확도 ↑

### Batch 7-2: failure-recovery.ts (신규)
```
Failure
  → RootCauseAnalyzer (에러 분류 + 원인 추론)
  → StrategySelector (5개 전략)
    ├── retry (동일 접근 재시도)
    ├── rollback (변경 되돌리기)
    ├── approach_change (다른 방법 시도)
    ├── scope_reduce (범위 축소)
    └── escalate (사용자에게 도움 요청)
  → StrategyExecutor (선택된 전략 실행)
```
- **배선:** AgentLoop.executeLoop() 에러 핸들링에서 FailureRecovery 호출
- **기존 auto-fix.ts 대체 아님** — auto-fix 위에 전략 레이어 추가

### Batch 7-3: execution-policy-engine.ts (신규)
```
ExecutionPolicy
├── planning: { enabled, threshold, maxDepth }
├── speculation: { enabled, maxApproaches }
├── debate: { enabled, rounds, roles }
├── verification: { depth, strictness }
├── cost: { maxTokens, preferredModel, budgetPerRole }
├── safety: { sandboxTier, approvalLevel }
└── recovery: { maxRetries, strategies }
```
- **배선:** AgentLoop constructor에서 정책 로드 → 각 모듈에 전달
- **설정 소스:** `.yuan/policy.json` 또는 YUAN.md

---

## Phase 8: Intelligence Upgrade (7.0 → 8.0)

> 학습 고도화 + 비용 최적화 + 벤치마크

### Batch 8-1: cost-optimizer.ts (신규)
```
CostOptimizer
├── ModelSelector: task complexity → 최적 모델 자동 선택
│   ├── cheap: haiku/mini (simple tasks, grep, classify)
│   ├── default: sonnet/gpt-4o (standard coding)
│   └── premium: opus/o3 (complex planning, debate)
├── TokenPredictor: 작업별 예상 토큰 사전 계산
├── CostTracker: 실시간 비용 추적 + 예산 경고
└── BatchOptimizer: 비슷한 작업 배칭으로 컨텍스트 재사용
```
- **배선:** ModelRouter 확장 + AgentLoop의 callLLMStreaming에서 모델 동적 선택

### Batch 8-2: 기존 모듈 시맨틱 강화
| 작업 | 파일 | 내용 |
|------|------|------|
| CodebaseContext relation API | codebase-context.ts | `getRelatedFiles()`, `getCallChain()`, `getImpactRadius()` |
| GitIntelligence 학습 통합 | git-intelligence.ts + memory-updater.ts | co-change 패턴을 MemoryManager에 자동 저장 |
| HierarchicalPlanner 마일스톤 | hierarchical-planner.ts | L0 Milestone 레이어 추가 (multi-session goal tracking) |
| VectorIndex 인메모리 모드 | vector-index.ts | pgvector 없이도 동작하는 cosine similarity 폴백 |

### Batch 8-3: impact-analyzer.ts (신규, CodebaseContext 확장)
```
ImpactAnalyzer
├── analyzeChange(file): AffectedFile[], AffectedTest[], AffectedAPI[]
├── estimateRisk(changes): RiskLevel
├── suggestTests(changes): TestSuggestion[]
└── detectBreaking(changes): BreakingChange[]
```
- **배선:** AgentLoop executeTools에서 file_write/file_edit 후 자동 impact 분석
- **CrossFileRefactor + TestIntelligence 통합**

---

## Phase 9: Production Hardening (8.0 → 9.0)

> 실사용 검증 + 벤치마크 + 폴리시

### Batch 9-1: benchmark-runner.ts (신규)
```
BenchmarkRunner
├── SWEBenchAdapter: SWE-bench lite 태스크 실행
├── MetricCollector
│   ├── success_rate: 버그 수정 성공률
│   ├── token_cost: 태스크당 평균 토큰
│   ├── latency: 태스크당 평균 시간
│   ├── test_pass_rate: 테스트 통과율
│   └── regression_rate: 의도치 않은 회귀율
├── ResultReporter: JSON + 마크다운 리포트 생성
└── RegressionDetector: 이전 벤치마크 대비 성능 저하 감지
```

### Batch 9-2: 통합 E2E 테스트
| 시나리오 | 검증 내용 |
|----------|-----------|
| 단일 파일 버그 수정 | AgentLoop → file_read → file_edit → shell_exec(test) |
| 멀티파일 리팩토링 | Planning → multi-file edit → impact analysis |
| 컨텍스트 소진 이어가기 | ContinuationEngine checkpoint → restore → resume |
| MCP 도구 사용 | MCPClient → external tool → result integration |
| 실패 복구 | FailureRecovery strategy selection → execution |
| 비용 최적화 | CostOptimizer model selection per task |

### Batch 9-3: architecture-recovery.ts (후순위, 폴리시)
- 코드에서 모듈 그래프 자동 생성
- 레이어 아키텍처 시각화
- 프로젝트 온보딩 가속

### Batch 9-4: 프로덕션 hardening
| 작업 | 내용 |
|------|------|
| 전 모듈 에러 경계 | silent catch → structured logging |
| 메모리 누수 점검 | EventEmitter listener 정리, Map 크기 제한 |
| 타임아웃 일관성 | 모든 LLM/tool 호출에 configurable timeout |
| 보안 최종 감사 | PromptDefense 패턴 업데이트, sandbox 검증 |
| CI/CD 파이프라인 | lint + build + test + benchmark 자동화 |

---

## 전체 타임라인

```
Phase 6 (Foundation)     ████████░░░░░░░░░░░░  4.5 → 6.0  (4 batches)
Phase 7 (Intelligence)   ░░░░░░░░████████░░░░  6.0 → 7.0  (3 batches)
Phase 8 (Advanced)       ░░░░░░░░░░░░░░██████  7.0 → 8.0  (3 batches)
Phase 9 (Production)     ░░░░░░░░░░░░░░░░████  8.0 → 9.0  (4 batches)
                                                Total: ~14 batches
```

## 신규 모듈 요약

| # | 모듈 | Phase | 줄 추정 | 배선 대상 |
|---|------|-------|---------|-----------|
| 1 | world-state.ts | 7 | ~400 | AgentLoop.init(), system-prompt |
| 2 | failure-recovery.ts | 7 | ~500 | AgentLoop.executeLoop() |
| 3 | execution-policy-engine.ts | 7 | ~350 | AgentLoop constructor, 전 모듈 |
| 4 | cost-optimizer.ts | 8 | ~450 | ModelRouter, AgentLoop.callLLM |
| 5 | impact-analyzer.ts | 8 | ~400 | AgentLoop.executeTools() |
| 6 | benchmark-runner.ts | 9 | ~500 | 독립 실행 (CLI) |
| 7 | architecture-recovery.ts | 9 | ~350 | 독립 실행 (문서화) |

## 기존 모듈 확장 요약

| 기존 모듈 | 확장 내용 | Phase |
|-----------|-----------|-------|
| hierarchical-planner.ts | L0 Milestone + 전략 리플랜 | 6, 8 |
| codebase-context.ts | relation API (call chain, impact) | 8 |
| git-intelligence.ts | 학습 통합 (co-change → MemoryManager) | 8 |
| vector-index.ts | 인메모리 cosine similarity 폴백 | 8 |
| agent-loop.ts | MCPClient, TokenBudget 6역할, FailureRecovery, Policy | 6, 7 |
| execution-engine.ts | Debate/Speculative 활성화 | 6 |

---

## 우선순위 원칙

1. **연결 > 생성**: 새 모듈보다 기존 모듈 배선이 우선
2. **측정 > 추측**: benchmark-runner 없이 "좋아졌다" 주장 불가
3. **안전 > 속도**: failure-recovery + policy-engine이 speculation보다 우선
4. **YAGNI**: architecture-recovery는 마지막 (당장 에이전트 성능에 영향 적음)
5. **DRY**: knowledge-graph, git-history-learning은 기존 모듈 확장으로 대체

---

## 참고 문서
- 설계 명세: `docs/YUAN_CODING_AGENT_DESIGN.md`
- 피처 리포트: `docs/YUAN_FEATURE_REPORT.md`
- 진행 추적: `memory/yuan-progress.md`
- 감사 결과: 이 문서 기반
