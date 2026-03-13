# @yuaone/core

Agent runtime for YUAN coding agent.

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

for await (const event of loop.run("refactor auth.ts to async/await")) {
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
