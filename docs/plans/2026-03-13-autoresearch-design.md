# YUAN AutoResearch — 설계 문서

> **목표**: 사람이 `program.md`만 작성하면 YUAN이 밤새 자율적으로 실험을 반복하고
> 최적 결과만 골라 저장하는 autonomous research loop 구현.

---

## 개요 (Karpathy autoresearch 패턴)

```
사람: program.md 작성 (방향 + metric + 제약)
              ↓
YUAN: 실험 가설 자동 생성 (LLM)
              ↓
      ┌─────────────────────────────────┐
      │  [실험 루프 — 밤새 반복]          │
      │                                 │
      │  git worktree로 격리             │
      │       ↓                         │
      │  AgentLoop로 실험 구현           │
      │       ↓                         │
      │  benchmark 실행 → 점수 측정      │
      │       ↓                         │
      │  baseline보다 좋으면 → 저장      │
      │  나쁘면 → worktree 폐기          │
      │       ↓                         │
      │  다음 실험으로 (개선 방향 반영)   │
      └─────────────────────────────────┘
              ↓
      최종 리포트 생성 (성공 실험 목록)
```

---

## 1. program.md 형식 (사용자가 작성)

```markdown
# Goal
YUAN agent loop의 추론 속도를 30% 향상시킨다.

# Hypothesis
- ContextManager의 token estimation이 병목일 것이다
- tool result compression 비율 조정이 효과적일 것이다
- 반복되는 시스템 메시지 dedup으로 컨텍스트를 줄일 수 있다

# Metric
command: pnpm run bench:loop
primary: tokens_per_second   # 클수록 좋음
threshold: +20%              # baseline 대비 20% 이상 개선 시 성공
timeout: 300s                # 실험당 최대 시간

# Constraints
max_experiments: 50
max_per_experiment: 10min
no_modify:
  - src/types.ts
  - src/llm-client.ts
branch_prefix: research/exp

# Baseline
command: pnpm run bench:loop --iterations 100
```

---

## 2. 아키텍처

### 파일 구조

```
packages/yuan-core/src/
  autoresearch/
    auto-research-loop.ts     # 메인 오케스트레이터
    experiment-generator.ts   # LLM으로 실험 가설 생성
    experiment-runner.ts      # git worktree + AgentLoop 실험 실행
    experiment-scorer.ts      # 점수 측정 + baseline 비교
    experiment-store.ts       # 실험 결과 저장/로드
    research-report.ts        # 최종 리포트 생성

packages/yuan-cli/src/
  commands/research.ts        # `yuan --research` CLI 진입점
```

---

## 3. 핵심 클래스 설계

### 3.1 AutoResearchLoop (오케스트레이터)

```typescript
export class AutoResearchLoop {
  constructor(private config: AutoResearchConfig) {}

  async run(): Promise<ResearchReport> {
    // 1. program.md 파싱
    const program = await this.loadProgram();

    // 2. baseline 측정 (비교 기준 확보)
    const baseline = await this.scorer.measureBaseline(program.metric);

    // 3. 실험 가설 생성 (LLM)
    const hypotheses = await this.generator.generate(program, baseline);

    const results: ExperimentResult[] = [];
    let iteration = 0;

    // 4. 실험 루프
    while (iteration < program.maxExperiments && !this.aborted) {
      const hypothesis = hypotheses[iteration] ?? await this.generator.refine(
        program, results, iteration  // 이전 결과 반영해서 다음 가설 개선
      );

      const result = await this.runExperiment(hypothesis, baseline, program);
      results.push(result);

      this.emit({ kind: "research:experiment_done", iteration, result });
      iteration++;
    }

    // 5. 최종 리포트
    return this.reporter.generate(program, baseline, results);
  }

  private async runExperiment(
    hypothesis: Hypothesis,
    baseline: BenchmarkScore,
    program: ResearchProgram,
  ): Promise<ExperimentResult> {
    // git worktree 생성 (격리)
    const worktree = await this.runner.createWorktree(hypothesis.id);

    try {
      // AgentLoop로 실험 구현
      await this.runner.implement(worktree, hypothesis, program.constraints);

      // 점수 측정
      const score = await this.scorer.measure(worktree, program.metric);
      const improvement = this.scorer.compare(score, baseline);

      if (improvement >= program.metric.threshold) {
        // 성공 → worktree 보존, 결과 저장
        await this.store.save(hypothesis, score, improvement);
        return { status: "success", hypothesis, score, improvement };
      } else {
        // 실패 → worktree 제거
        await this.runner.removeWorktree(worktree);
        return { status: "fail", hypothesis, score, improvement };
      }
    } catch (err) {
      await this.runner.removeWorktree(worktree).catch(() => {});
      return { status: "error", hypothesis, error: String(err) };
    }
  }
}
```

---

### 3.2 ExperimentGenerator (가설 생성)

```typescript
export class ExperimentGenerator {
  // 초기 가설 생성 (program.md의 Hypothesis 섹션 기반)
  async generate(program: ResearchProgram): Promise<Hypothesis[]> {
    const prompt = `
Given this research goal: "${program.goal}"
And these hypotheses: ${program.hypotheses.join("\n")}

Generate ${program.maxExperiments} concrete, specific experiment plans.
Each experiment should:
- Change exactly ONE variable (single-factor experiment)
- Be implementable by a coding agent in < ${program.maxPerExperiment}
- Have a clear expected mechanism of improvement

Return JSON array of { id, title, description, targetFiles, changes }.
    `;

    const resp = await this.llm.chat([{ role: "user", content: prompt }], []);
    return JSON.parse(resp.content ?? "[]");
  }

  // 이전 결과 반영해서 다음 가설 개선 (Bayesian 방식)
  async refine(
    program: ResearchProgram,
    results: ExperimentResult[],
    iteration: number,
  ): Promise<Hypothesis> {
    const successPattern = results
      .filter(r => r.status === "success")
      .map(r => `✓ ${r.hypothesis.title}: +${r.improvement?.toFixed(1)}%`)
      .join("\n");

    const failPattern = results
      .filter(r => r.status === "fail")
      .map(r => `✗ ${r.hypothesis.title}: ${r.improvement?.toFixed(1)}%`)
      .join("\n");

    const prompt = `
Research goal: "${program.goal}"
Iteration: ${iteration}

What worked:
${successPattern || "(none yet)"}

What didn't work:
${failPattern || "(none yet)"}

Based on the pattern so far, propose ONE new experiment that builds on
successes and avoids failed approaches. Return JSON: { title, description, targetFiles, changes }.
    `;

    const resp = await this.llm.chat([{ role: "user", content: prompt }], []);
    return { id: `exp-${iteration.toString().padStart(3, "0")}`, ...JSON.parse(resp.content ?? "{}") };
  }
}
```

---

### 3.3 ExperimentRunner (실험 실행)

```typescript
export class ExperimentRunner {
  // git worktree로 격리된 실험 환경 생성
  async createWorktree(experimentId: string): Promise<string> {
    const worktreePath = path.join(this.projectPath, ".yuan", "experiments", experimentId);
    const branchName = `research/exp-${experimentId}`;

    await this.exec(`git worktree add -b ${branchName} ${worktreePath}`);
    return worktreePath;
  }

  // AgentLoop를 실험 worktree에서 실행
  async implement(
    worktreePath: string,
    hypothesis: Hypothesis,
    constraints: ResearchConstraints,
  ): Promise<void> {
    const loop = new AgentLoop({
      byok: this.byokConfig,
      loop: {
        projectPath: worktreePath,
        systemPrompt: this.buildResearchPrompt(hypothesis, constraints),
        maxIterations: 20,  // 실험당 최대 20회 iteration
        tools: this.toolExecutor.definitions,
      },
    });

    const result = await loop.run(
      `Implement this experiment: ${hypothesis.title}\n\n${hypothesis.description}\n\n` +
      `Target files: ${hypothesis.targetFiles.join(", ")}\n` +
      `Do NOT modify: ${constraints.noModify.join(", ")}`
    );

    if (result.reason === "ERROR") {
      throw new Error(`AgentLoop failed: ${result.error}`);
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.exec(`git worktree remove --force ${worktreePath}`);
  }
}
```

---

### 3.4 ExperimentScorer (점수 측정)

```typescript
export class ExperimentScorer {
  // baseline 측정 (main branch에서 실행)
  async measureBaseline(metric: ResearchMetric): Promise<BenchmarkScore> {
    return this.runBenchmark(this.projectPath, metric);
  }

  // 실험 worktree에서 점수 측정
  async measure(worktreePath: string, metric: ResearchMetric): Promise<BenchmarkScore> {
    return this.runBenchmark(worktreePath, metric);
  }

  // 개선율 계산
  compare(result: BenchmarkScore, baseline: BenchmarkScore): number {
    // "클수록 좋음" 메트릭 (tokens_per_second, accuracy 등)
    return ((result.primary - baseline.primary) / baseline.primary) * 100;
  }

  private async runBenchmark(cwd: string, metric: ResearchMetric): Promise<BenchmarkScore> {
    const { stdout } = await exec(metric.command, { cwd, timeout: metric.timeout * 1000 });
    return this.parseScore(stdout, metric.primary);
  }

  // stdout에서 metric 값 파싱
  // 지원 형식: "tokens_per_second: 1234.5" / JSON / 마지막 줄 숫자
  private parseScore(output: string, metricName: string): BenchmarkScore {
    // 1. JSON 형식
    try {
      const json = JSON.parse(output);
      if (json[metricName] !== undefined) return { primary: Number(json[metricName]), raw: output };
    } catch {}

    // 2. "key: value" 형식
    const match = output.match(new RegExp(`${metricName}[:\\s]+([\\d.]+)`));
    if (match) return { primary: Number(match[1]), raw: output };

    // 3. 마지막 줄 숫자
    const lastNum = output.trim().split("\n").pop()?.match(/[\d.]+/);
    if (lastNum) return { primary: Number(lastNum[0]), raw: output };

    throw new Error(`Cannot parse metric "${metricName}" from benchmark output`);
  }
}
```

---

### 3.5 ExperimentStore (결과 저장)

```typescript
// .yuan/research/results.jsonl — 실험 결과 append-only 로그
// .yuan/research/best/       — 성공한 실험의 diff 보관

export class ExperimentStore {
  async save(
    hypothesis: Hypothesis,
    score: BenchmarkScore,
    improvement: number,
  ): Promise<void> {
    const entry: StoredExperiment = {
      id: hypothesis.id,
      title: hypothesis.title,
      description: hypothesis.description,
      score: score.primary,
      improvement,
      timestamp: new Date().toISOString(),
      diff: await this.captureDiff(hypothesis.id),
    };

    // JSONL append
    await fs.appendFile(this.resultsPath, JSON.stringify(entry) + "\n");

    // diff 파일 보관
    await fs.writeFile(
      path.join(this.bestDir, `${hypothesis.id}.patch`),
      entry.diff,
    );
  }

  private async captureDiff(experimentId: string): Promise<string> {
    const { stdout } = await exec(
      `git diff main research/exp-${experimentId}`,
      { cwd: this.projectPath },
    );
    return stdout;
  }
}
```

---

## 4. CLI 통합

```bash
# 기본 실행
yuan --research program.md

# 옵션
yuan --research program.md \
  --max-experiments 100 \
  --timeout 5m \
  --parallel 3        # 최대 3개 실험 동시 실행 (worktree 격리)
  --apply-best        # 루프 끝나고 가장 좋은 실험 자동 머지
  --no-commit         # 커밋 없이 dry-run

# 야간 모드 (무한 루프, Ctrl+C로 중단)
yuan --research program.md --overnight
```

**TUI 표시 (StatusBar):**
```
YUAN ● research  exp-023/100  best: +34.2% (exp-007)  running: tokens_per_second
```

---

## 5. 데이터 흐름

```
program.md
    │
    ▼
ResearchProgram (파싱)
    │
    ▼
baseline 측정 ─────────────────────────────────┐
    │                                           │
    ▼                                           │
Hypothesis 생성 (LLM)                          │
    │                                           │
    ▼                                    compare()
┌──────────────────────────────────────┐       │
│ 실험 루프                             │       │
│                                      │       │
│  git worktree 생성                   │       │
│       ↓                              │       │
│  AgentLoop.run(hypothesis)           │       │
│       ↓                              │       │
│  ExperimentScorer.measure() ─────────┼───────┘
│       ↓                              │
│  개선율 ≥ threshold?                 │
│    YES → store.save() + keep branch  │
│    NO  → worktree remove             │
│       ↓                              │
│  generator.refine(results) ← 이전   │
│  결과 반영해서 다음 가설 개선         │
└──────────────────────────────────────┘
    │
    ▼
ResearchReport
  - 실험 N개 중 M개 성공
  - 최고 개선율: +X% (exp-007)
  - 실패 패턴: [...]
  - 추천 다음 방향: [...]
  - 적용 명령: git merge research/exp-007
```

---

## 6. 구현 배치 (5 Batch)

### Batch 1 — 타입 & program.md 파서
- `autoresearch/types.ts` — ResearchProgram, Hypothesis, ExperimentResult, BenchmarkScore
- `autoresearch/program-parser.ts` — program.md 파싱

### Batch 2 — ExperimentGenerator
- `autoresearch/experiment-generator.ts`
- LLM 기반 초기 가설 생성 + Bayesian 개선

### Batch 3 — ExperimentRunner + ExperimentScorer
- `autoresearch/experiment-runner.ts` — git worktree + AgentLoop
- `autoresearch/experiment-scorer.ts` — benchmark 실행 + 점수 파싱

### Batch 4 — AutoResearchLoop + ExperimentStore
- `autoresearch/auto-research-loop.ts` — 메인 오케스트레이터
- `autoresearch/experiment-store.ts` — JSONL 저장 + diff 보관

### Batch 5 — CLI + TUI + Report
- `yuan-cli/src/commands/research.ts` — `yuan --research` 진입점
- `autoresearch/research-report.ts` — 최종 리포트 생성
- TUI StatusBar에 research 모드 표시

---

## 7. 기술적 고려사항

### 병렬 실험 (--parallel N)
- 각 실험이 별도 git worktree → 파일 충돌 없음
- `Promise.allSettled()` N개 동시 실행
- 점수 비교는 동기화 필요 (mutex 사용)

### benchmark 명령 유연성
- 숫자 하나만 출력해도 됨: `echo "1234.5"`
- JSON: `{"tokens_per_second": 1234.5}`
- 테스트 pass율: `jest --json | jq '.numPassedTests'`
- 어떤 쉘 명령이든 가능

### 비용 관리
- 실험당 AgentLoop 최대 20 iteration 제한
- 복잡한 실험은 timeout으로 자동 중단
- 총 예상 비용 = N × (avg tokens/experiment) × token price

### 안전장치
- `no_modify` 파일 목록 → AgentLoop 시스템 프롬프트에 명시
- 각 실험이 worktree 격리 → main branch 보호
- `--dry-run` 모드: 구현만 하고 benchmark 없이 diff만 출력
