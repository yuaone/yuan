# @yuaone/core

Agent runtime for YUAN coding agent — skills, strategies, multi-provider LLM, tool-use loop.

```bash
npm install @yuaone/core
```

## Usage

```typescript
import { AgentLoop, createAgentLoop } from "@yuaone/core";

const loop = createAgentLoop({
  provider: "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-4-6",
  workDir: process.cwd(),
});

for await (const event of loop.run("refactor auth.ts to use async/await")) {
  if (event.kind === "agent:token") process.stdout.write(event.content);
  if (event.kind === "agent:completed") break;
}
```

## Architecture

| Module | Description |
|--------|-------------|
| `AgentLoop` | Core tool-use loop — LLM ↔ tools ↔ approval |
| `HierarchicalPlanner` | Task decomposition with dependency ordering |
| `ExecutionPolicyEngine` | Token/cost budget per iteration |
| `ContinuationEngine` | Checkpoint every 3 iters, recovery on error |
| `ReflexionEngine` | Per-iteration self-reflection & insight injection |
| `WorldStateCollector` | Tracks file changes across iterations |
| `QAPipeline` | Quick + thorough quality checks post-execution |
| `Governor` | Safety/security scanning before tool execution |
| `AutoFix` | Automatic lint/type error repair |
| `ContextManager` | Token budget management & compaction |
| `TaskClassifier` | Classifies task type for targeted system prompt injection |
| `StrategySelector` | Selects up to 3 execution strategies per task |
| `SkillLoader` | Loads & scores built-in and user skills |
| `DAGOrchestrator` | Parallel subagent execution with dependency graph |

## Skill System

YUAN bundles **35 skills** out of the box — 6 core skills and 29 language/domain skills.

### Core Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| `debug` | auto | Reproduce → Trace → Fix → Verify |
| `test-driven` | auto | Red → Green → Refactor |
| `code-review` | auto | CRITICAL / HIGH / MEDIUM / LOW severity |
| `security-scan` | auto | OWASP Top 10 pattern detection |
| `refactor` | auto | Impact radius + minimal change |
| `plan` | auto | Decompose → Sequence → Risk |

### Language Skills (29 languages)

| Group | Languages |
|-------|-----------|
| Web Frontend | TypeScript, JavaScript, React, Vue, Svelte |
| Web Backend | Python, Ruby, PHP, Java, Kotlin, Go, Elixir |
| Systems | Rust, C, C++, Haskell |
| Mobile | Swift, Dart (Flutter), Kotlin |
| Scripting | Bash, Lua, R |
| Data Science | Python, R, SQL |
| Database | SQL |
| DevOps | Docker, Terraform, Bash |
| Game Dev | GDScript (Godot), C++ |
| Blockchain | Solidity |
| Embedded/GPU | CUDA, Verilog |
| Functional | Haskell, Elixir |

Skills are stored in `dist/skills/` and loaded automatically. User skills: `~/.yuan/skills/`. Plugin skills: `node_modules/@yuaone/plugin-*`.

```typescript
import { SkillLoader } from "@yuaone/core";

const loader = new SkillLoader();
const skills = await loader.loadAll();
const matched = loader.score(skills, { filePaths: ["src/auth.ts"] });
```

## Execution Strategies

The `StrategySelector` picks up to 3 strategies per task and injects them into the system prompt. Strategies propagate to parallel subagents automatically.

| Strategy | When applied |
|----------|-------------|
| Read Before Write | Always |
| Test-Driven | feature, debug, refactor, test |
| Trace First | debug, security, performance |
| Impact Radius | refactor, migration (DEEP/SUPERPOWER modes) |
| Pattern Match First | feature, test, documentation |
| Minimal Change | debug, config, infra (FAST/NORMAL modes) |
| Verify Before Done | feature, refactor, migration, test, deploy |

## Language Registry

All 67 supported languages are defined in a single SSOT (`language-registry.ts`). Language detection, system prompt verification, and skill file linking all derive from this registry.

```typescript
import { LANGUAGE_REGISTRY, getLanguageByExtension } from "@yuaone/core";

const lang = getLanguageByExtension(".ts"); // { id: "typescript", name: "TypeScript", ... }
console.log(LANGUAGE_REGISTRY.length); // 67
```

## Events

```typescript
type AgentEvent =
  | { kind: "agent:thinking"; content: string }
  | { kind: "agent:token"; content: string }
  | { kind: "agent:tool_call"; toolName: string; arguments: unknown }
  | { kind: "agent:tool_result"; toolName: string; result: string; durationMs: number }
  | { kind: "agent:approval_needed"; action: { tool: string; input: unknown } }
  | { kind: "agent:completed"; message: string }
  | { kind: "agent:error"; message: string; retryable: boolean }
  | { kind: "agent:token_usage"; input: number; output: number }
  | { kind: "agent:qa_result"; stage: "quick" | "thorough"; passed: boolean; issues: string[] }
```

## License

AGPL-3.0 — part of [YUAN](https://github.com/yuaone/yuan).
