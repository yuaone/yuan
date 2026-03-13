# YUAN Proactive Autonomous Agent — 구현 계획

> **목표**: Reactive Agent → Proactive Autonomous Agent
> **핵심 갭**: (1) World Model 부재 (2) Proactive Replanning 부재
> **기준일**: 2026-03-13

---

## 아키텍처 개요

```
Goal
  │
  ▼
HierarchicalPlanner ──────────────────────────────────────┐
  │  createHierarchicalPlan()                              │
  │                                          MilestoneChecker
  ▼                                               │
SimulationEngine                            PlanEvaluator
  │  simulate(plan, worldModel)                   │
  │  → predicted state after each step            │ partial result analysis
  │  → failure probability per step               │
  ▼                                               │
executeLoop()  ←────────────────────────────────────────┘
  │
  ├─ Tool execution (file_write, shell_exec, …)
  │         │
  │         ▼
  │    StateUpdater.applyToolResult()
  │         │
  │         ▼
  │    WorldModel (StateStore updated)
  │         │
  │         ▼
  │    RiskEstimator.score(currentState, remainingPlan)
  │         │
  │         ├─ risk > 70% ──→ ReplanningEngine.proactiveReplan()
  │         │                        │
  │         │                        ▼
  │         │                  HierarchicalPlanner.replan()
  │         │                  (L1 strategic if critical)
  │         │
  │         └─ risk ≤ 70% ──→ continue
  │
  └─ FailureRecovery (unchanged — reactive fallback)
```

---

## Batch 1: World Model Core

### 파일 구조
```
packages/yuan-core/src/world-model/
  state-store.ts       ← 현재 + 히스토리 state 저장
  transition-model.ts  ← action → state delta 예측
  simulation-engine.ts ← 계획 시뮬레이션 (실패 확률 추정)
  state-updater.ts     ← 실제 tool 결과로 state 갱신
  index.ts             ← 배럴 export
```

### 1-1. state-store.ts

```typescript
export interface WorldState {
  files: Map<string, FileState>;      // path → { hash, lines, exists }
  build: BuildState;                   // { status, errors, lastRun }
  test: TestState;                     // { status, failingTests, lastRun }
  git: GitState;                       // { branch, dirty, stagedFiles }
  deps: DepsState;                     // { missing, outdated }
  timestamp: number;
}

export interface FileState {
  path: string;
  exists: boolean;
  hash: string;           // sha256 of content (for change detection)
  lines: number;
  lastModified: number;
}

export interface StateHistory {
  states: Array<{ state: WorldState; action: string; timestamp: number }>;
  maxSize: number;        // default 20
}

export class StateStore {
  private current: WorldState;
  private history: StateHistory;

  constructor(initial: WorldState) {}

  // 현재 상태 조회
  getState(): WorldState

  // 상태 업데이트 (action 이름과 함께 히스토리에 저장)
  update(delta: Partial<WorldState>, action: string): void

  // 특정 파일 상태 조회
  getFileState(path: string): FileState | undefined

  // 히스토리에서 특정 파일의 변경 이력
  getFileHistory(path: string): Array<{ action: string; before: FileState | undefined; after: FileState }>

  // 상태를 스냅샷으로 직렬화 (WorldStateSnapshot과 호환)
  toSnapshot(): WorldStateSnapshot

  // WorldStateSnapshot에서 초기화
  static fromSnapshot(snapshot: WorldStateSnapshot, projectPath: string): StateStore
}
```

### 1-2. transition-model.ts

코딩 에이전트에서 tool → state 변화 예측:

```typescript
export interface StateTransition {
  tool: string;             // "file_write" | "file_edit" | "shell_exec" | ...
  args: Record<string, unknown>;
  expectedDelta: StateDelta;
  failureProbability: number;   // 0-1
  reason: string;               // 왜 이 확률인지
}

export interface StateDelta {
  filesChanged: string[];       // 어떤 파일이 변경될 것인지
  buildInvalidated: boolean;    // build 재실행 필요 여부
  testInvalidated: boolean;     // test 재실행 필요 여부
  gitDirty: boolean;            // git dirty 상태가 될지
}

export class TransitionModel {
  // 도구 호출이 world state에 어떤 변화를 가져올지 예측
  predict(tool: string, args: Record<string, unknown>, currentState: WorldState): StateTransition

  // 실제 실행 결과로 transition model 보정
  calibrate(predicted: StateTransition, actual: StateDelta, success: boolean): void

  // 여러 도구 연속 실행 시 최종 상태 예측
  predictSequence(tools: Array<{ tool: string; args: Record<string, unknown> }>, state: WorldState): WorldState
}
```

핵심 transition 규칙:
- `file_write(path)` → filesChanged=[path], buildInvalidated=true, testInvalidated=true
- `file_edit(path)` → filesChanged=[path], buildInvalidated=true, testInvalidated=true
- `shell_exec("tsc")` → buildInvalidated=false (build 실행됨)
- `shell_exec("*test*")` → testInvalidated=false (test 실행됨)
- `git_ops("commit")` → gitDirty=false

실패 확률 계산:
- file_write: base 0.05 (파일 I/O는 거의 안 실패)
- shell_exec: base 0.15 + 0.05 * (파일 변경 수) — 많이 바꿀수록 빌드 실패 확률 ↑
- ImpactAnalyzer.riskLevel에서 보정 (HIGH → +0.2)

### 1-3. simulation-engine.ts

```typescript
export interface SimulationResult {
  planId: string;
  steps: SimulationStep[];
  overallSuccessProbability: number;
  criticalSteps: string[];    // 실패 확률 > 0.3인 스텝 ID
  estimatedTokens: number;
  warnings: string[];
}

export interface SimulationStep {
  taskId: string;
  taskDescription: string;
  predictedState: WorldState;
  failureProbability: number;
  riskFactors: string[];
}

export class SimulationEngine {
  constructor(
    private transitionModel: TransitionModel,
    private stateStore: StateStore,
  ) {}

  // 계획 전체 시뮬레이션 (planner에서 createHierarchicalPlan 후 호출)
  async simulate(plan: HierarchicalPlan): Promise<SimulationResult>

  // 단일 태스크 시뮬레이션
  simulateTask(task: TacticalTask, currentState: WorldState): SimulationStep

  // 특정 스텝까지 실행했을 때 예상 state
  predictStateAt(plan: HierarchicalPlan, taskIndex: number): WorldState
}
```

### 1-4. state-updater.ts

```typescript
export class StateUpdater {
  constructor(private stateStore: StateStore, private projectPath: string) {}

  // tool 실행 결과 → state 갱신
  async applyToolResult(
    tool: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<StateDelta>

  // 파일 변경 감지 (file_write/edit 후 실제 해시 계산)
  async refreshFileState(path: string): Promise<FileState>

  // build/test 결과 파싱 → state 갱신
  parseBuildOutput(output: string, success: boolean): void
  parseTestOutput(output: string, success: boolean): void

  // 전체 상태 재동기화 (필요 시)
  async resync(): Promise<void>
}
```

---

## Batch 2: Proactive Replanning

### 파일 구조
```
packages/yuan-core/src/planner/
  plan-evaluator.ts     ← 중간 결과 분석 + 계획 건강도 평가
  risk-estimator.ts     ← 현재 진행 상황의 리스크 점수
  replanning-engine.ts  ← proactive replanning 결정 + 실행
  milestone-checker.ts  ← 마일스톤 달성 여부 추적
  index.ts              ← 배럴 export
```

### 2-1. plan-evaluator.ts

```typescript
export interface PlanHealth {
  score: number;              // 0-100 (높을수록 좋음)
  completedTasks: number;
  totalTasks: number;
  progressRatio: number;      // 0-1
  tokensUsed: number;
  tokensRemaining: number;
  deviations: PlanDeviation[];
  recommendation: "continue" | "replan_minor" | "replan_major" | "abort";
}

export interface PlanDeviation {
  type: "unexpected_file" | "scope_creep" | "blocked_dependency" | "token_overrun" | "quality_regression";
  description: string;
  severity: "low" | "medium" | "high";
  affectedTaskIds: string[];
}

export class PlanEvaluator {
  constructor(
    private stateStore: StateStore,
    private simulationEngine: SimulationEngine,
  ) {}

  // 매 N번 iteration마다 계획 건강도 평가
  evaluate(
    plan: HierarchicalPlan,
    completedTaskIds: string[],
    toolResults: ToolResult[],
    tokensUsed: number,
  ): PlanHealth

  // 예상치 못한 파일 변경 감지
  detectUnexpectedChanges(
    plan: HierarchicalPlan,
    actualChangedFiles: string[],
  ): PlanDeviation[]

  // 토큰 오버런 예측
  predictTokenOverrun(
    plan: HierarchicalPlan,
    tokensUsed: number,
    completedRatio: number,
  ): boolean
}
```

### 2-2. risk-estimator.ts

```typescript
export interface RiskScore {
  overall: number;            // 0-100
  components: {
    buildRisk: number;        // 빌드 실패 가능성
    testRisk: number;         // 테스트 실패 가능성
    scopeRisk: number;        // 범위 확장 가능성
    dependencyRisk: number;   // 의존성 파괴 가능성
    tokenRisk: number;        // 토큰 예산 초과 가능성
  };
  factors: string[];          // 위험 요인 설명
  mitigations: string[];      // 완화 방안
}

export class RiskEstimator {
  constructor(
    private transitionModel: TransitionModel,
    private impactAnalyzer: ImpactAnalyzer,  // 기존 모듈 재사용
  ) {}

  // 현재 상태 + 남은 계획에 대한 리스크 점수
  async estimate(
    currentState: WorldState,
    remainingTasks: TacticalTask[],
    completedTasks: TacticalTask[],
    changedFiles: string[],
  ): Promise<RiskScore>

  // 단일 태스크 리스크
  async estimateTaskRisk(task: TacticalTask, state: WorldState): Promise<number>

  // 임계값 체크
  isHighRisk(score: RiskScore, threshold?: number): boolean  // default threshold: 70
}
```

### 2-3. replanning-engine.ts

```typescript
export interface ReplanDecision {
  shouldReplan: boolean;
  scope: "none" | "operational" | "tactical" | "strategic";
  trigger: string;
  urgency: "low" | "medium" | "high" | "critical";
  reasoning: string;
}

export interface ProactiveReplanResult {
  triggered: boolean;
  decision: ReplanDecision;
  newPlan?: HierarchicalPlan;
  modifiedTasks?: TacticalTask[];
  message: string;          // 사용자에게 보여줄 메시지
}

export class ReplanningEngine {
  constructor(
    private planner: HierarchicalPlanner,
    private planEvaluator: PlanEvaluator,
    private riskEstimator: RiskEstimator,
    private milestoneChecker: MilestoneChecker,
  ) {}

  // 매 iteration 후 proactive replan 필요 여부 판단 + 실행
  async evaluate(
    plan: HierarchicalPlan,
    currentState: WorldState,
    completedTaskIds: string[],
    toolResults: ToolResult[],
    tokensUsed: number,
    changedFiles: string[],
    llmClient: BYOKClient,
  ): Promise<ProactiveReplanResult>

  // Proactive replan 조건 판단
  private shouldTrigger(
    health: PlanHealth,
    risk: RiskScore,
    milestoneStatus: MilestoneStatus,
  ): ReplanDecision

  // 실제 replan 실행
  private async executeReplan(
    plan: HierarchicalPlan,
    decision: ReplanDecision,
    currentState: WorldState,
    llmClient: BYOKClient,
  ): Promise<HierarchicalPlan | TacticalTask[]>
}
```

**Proactive trigger 기준:**
```
risk.overall > 70       → tactical replan
risk.overall > 85       → strategic replan
health.score < 40       → major replan
milestone 2회 연속 miss → strategic replan
token 80% 소진 + 50% 미완 → scope reduce replan
unexpected files > 3    → tactical replan
```

### 2-4. milestone-checker.ts

```typescript
export interface Milestone {
  id: string;
  description: string;
  targetTaskIds: string[];   // 이 태스크들이 완료되면 마일스톤 달성
  expectedByIteration: number;
  priority: "must" | "should" | "could";
}

export interface MilestoneStatus {
  achieved: string[];
  missed: string[];
  pending: string[];
  behindSchedule: boolean;   // 예상 iteration 대비 지연
  consecutiveMisses: number;
}

export class MilestoneChecker {
  constructor() {}

  // HierarchicalPlan에서 마일스톤 추출
  extractMilestones(plan: HierarchicalPlan): Milestone[]

  // 현재 진행 상황에서 마일스톤 상태 평가
  check(
    milestones: Milestone[],
    completedTaskIds: string[],
    currentIteration: number,
  ): MilestoneStatus

  // 마일스톤 달성 이벤트 emit
  onMilestoneAchieved(milestone: Milestone): void
  onMilestoneMissed(milestone: Milestone, iterations: number): void
}
```

---

## Batch 3: Agent Loop 통합

### agent-loop.ts 변경 사항

**새로 추가할 필드:**
```typescript
private worldModel: StateStore | null = null;
private transitionModel: TransitionModel | null = null;
private simulationEngine: SimulationEngine | null = null;
private stateUpdater: StateUpdater | null = null;
private planEvaluator: PlanEvaluator | null = null;
private riskEstimator: RiskEstimator | null = null;
private replanningEngine: ReplanningEngine | null = null;
private milestoneChecker: MilestoneChecker | null = null;
private activeMilestones: Milestone[] = [];
private completedTaskIds: Set<string> = new Set();
```

**init() 변경:**
```typescript
// WorldState 수집 후 StateStore 초기화
const snapshot = await worldStateCollector.collect();
this.worldModel = StateStore.fromSnapshot(snapshot, projectPath);
this.transitionModel = new TransitionModel();
this.simulationEngine = new SimulationEngine(this.transitionModel, this.worldModel);
this.stateUpdater = new StateUpdater(this.worldModel, projectPath);

// Proactive replanning 모듈
this.planEvaluator = new PlanEvaluator(this.worldModel, this.simulationEngine);
this.riskEstimator = new RiskEstimator(this.transitionModel, this.impactAnalyzer);
this.milestoneChecker = new MilestoneChecker();
this.replanningEngine = new ReplanningEngine(
  this.planner,
  this.planEvaluator,
  this.riskEstimator,
  this.milestoneChecker,
);
```

**executeLoop() 변경:**

현재 (3반복마다 plan progress 주입 + 에러 시 replan):
```
iteration++ → injectPlanProgress → LLM → tools → 에러 시 replan
```

새 흐름 (매 iteration 리스크 평가 + proactive replan):
```
iteration++
  → stateUpdater.applyToolResult(이전 도구 결과)   ← 실제 state 갱신
  → milestoneChecker.check()                        ← 마일스톤 진행 확인
  → replanningEngine.evaluate()                     ← proactive replan 판단
      └─ risk > 70% → planner.replan() → activePlan 갱신
  → injectPlanProgress (기존 유지)
  → LLM 호출
  → executeTools()
```

**executeTools() 변경:**
- 각 도구 실행 후 `stateUpdater.applyToolResult()` 호출
- `transitionModel.calibrate()` — 예측 vs 실제 비교로 모델 보정

**planner에서 simulation 연결:**
```typescript
// createHierarchicalPlan() 직후 시뮬레이션 실행
const plan = await this.planner.createHierarchicalPlan(goal, this.llmClient);
if (this.simulationEngine) {
  const simResult = await this.simulationEngine.simulate(plan);
  // criticalSteps를 시스템 메시지에 주입
  // overallSuccessProbability < 0.5 → 경고 발행
}
this.activePlan = plan;
this.activeMilestones = this.milestoneChecker?.extractMilestones(plan) ?? [];
```

---

## 데이터 플로우 (완전한 루프)

```
사용자 입력
     │
     ▼
[1] detectComplexity() → complex
     │
     ▼
[2] HierarchicalPlanner.createHierarchicalPlan()
     │  → L1 Strategic + L2 Tactical + L3 Operational
     │
     ▼
[3] SimulationEngine.simulate(plan)
     │  → 각 스텝별 예상 state + 실패 확률
     │  → criticalSteps 식별
     │
     ▼
[4] MilestoneChecker.extractMilestones(plan)
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  executeLoop()                                       │
│                                                      │
│  ① StateUpdater.applyToolResult(이전 결과)           │
│       → WorldModel(StateStore) 갱신                  │
│                                                      │
│  ② MilestoneChecker.check(completedTaskIds)          │
│       → 마일스톤 달성 여부 확인                       │
│                                                      │
│  ③ ReplanningEngine.evaluate()                       │
│       │                                              │
│       ├─ PlanEvaluator.evaluate() → PlanHealth       │
│       ├─ RiskEstimator.estimate() → RiskScore        │
│       └─ shouldTrigger() 판단                        │
│             │                                        │
│             ├─ risk > 70% → planner.replan()         │
│             │               → activePlan 갱신        │
│             └─ risk ≤ 70% → continue                 │
│                                                      │
│  ④ injectPlanProgress() (기존)                       │
│                                                      │
│  ⑤ LLM 호출 (ContextManager 통해)                    │
│                                                      │
│  ⑥ executeTools()                                    │
│       → 각 도구 실행                                  │
│       → TransitionModel.calibrate() (예측 보정)      │
│       → ImpactAnalyzer.analyzeChanges()              │
│                                                      │
│  ⑦ 에러 시 → FailureRecovery (기존 reactive)         │
│                                                      │
└─────────────────────────────────────────────────────┘
     │
     ▼
[5] 최종 완료 → ResearchReport (autoresearch와 연동 가능)
```

---

## 구현 순서 (의존성 기반)

```
Batch 1A: state-store.ts + transition-model.ts   (독립, 병렬 가능)
Batch 1B: simulation-engine.ts + state-updater.ts (1A 의존)

Batch 2A: milestone-checker.ts + risk-estimator.ts (독립, 병렬 가능)
Batch 2B: plan-evaluator.ts                        (1A 의존)
Batch 2C: replanning-engine.ts                     (2A + 2B 의존)

Batch 3:  agent-loop.ts 통합                       (1B + 2C 의존)
           index.ts export 추가
```

---

## 구현 난이도 평가

| 배치 | 복잡도 | 코드 변경 범위 | 예상 라인 |
|------|--------|--------------|-----------|
| 1A state-store + transition-model | Medium | 신규 2파일 | ~400 |
| 1B simulation-engine + state-updater | Medium-High | 신규 2파일 | ~350 |
| 2A milestone-checker + risk-estimator | Medium | 신규 2파일 | ~300 |
| 2B plan-evaluator | Medium | 신규 1파일 | ~200 |
| 2C replanning-engine | High | 신규 1파일 | ~250 |
| 3 agent-loop.ts 통합 | Very High | 기존 파일 수정 | ~150 추가 |

---

## 5단계 로드맵 (Devin 수준 autonomous agent)

```
Step 1: World Model Core (Batch 1A+1B)
  → 에이전트가 "현재 세계 상태"를 정확히 알고
  → tool 실행 전 "이 action은 어떤 결과를 낳을 것인가" 예측 가능

Step 2: Risk-Aware Planning (Batch 2A+2B+2C)
  → 계획 수립 시 시뮬레이션으로 위험 스텝 미리 식별
  → 중간 진행 상황 평가 → proactive replan

Step 3: Agent Loop 통합 (Batch 3)
  → 모든 모듈이 실제 실행 루프에 연결
  → "Reactive only" → "Proactive Autonomous"

Step 4: AutoResearch 연동 (별도 — autoresearch 설계 문서 참고)
  → World Model을 benchmark 점수 예측에 활용
  → SimulationEngine으로 실험 성공 확률 미리 추정

Step 5: BenchmarkRunner 검증
  → SWE-bench 태스크로 proactive replanning 효과 측정
  → 목표: complex task 성공률 55% → 70%
```
