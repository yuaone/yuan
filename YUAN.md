# YUAN Project — Agent Behavior Guidelines

> This file is injected into the agent's system prompt. Follow all instructions here as established conventions for this project.

## Project Info

- **Name:** yuan
- **Language:** TypeScript
- **Framework:** Node.js + Ink (TUI)
- **Build:** `pnpm run build`
- **Test:** `pnpm run test`
- **Persistence:** workspace-local (`.yuan/memory.json`)

## Package Structure

This is a pnpm monorepo with 4 packages. **Publish order matters (dependencies first):**
1. `packages/yuan-core` → `@yuaone/core`
2. `packages/yuan-tools` → `@yuaone/tools`
3. `packages/yuan-cli` → `@yuaone/cli`
4. `packages/yuan-mcp` → `@yuaone/mcp-server`

## Build & Publish Rules

- **Always use `pnpm`**, never `npm`.
- Build all: `pnpm run build` (from repo root)
- Publish: `pnpm --filter @yuaone/<pkg> publish --no-git-checks` (workspace:* auto-resolved)
- Before publishing: bump `version` in each package's `package.json` manually.

## Code Conventions

- **Indent:** 2 spaces (TypeScript standard)
- **Imports:** ESM `.js` extension required in `import` statements (e.g., `import ... from "./foo.js"`)
- **tsconfig:** `"jsx": "react-jsx"` for yuan-cli (Ink), NOT `jsxImportSource`
- **skipLibCheck:** true in yuan-core (ioredis optional dep)
- **Types:** No `any` unless absolutely necessary. Use proper generics.

## Architecture — Key Files

- `packages/yuan-core/src/agent-loop.ts` — main agent orchestration (2500+ lines)
- `packages/yuan-core/src/llm-client.ts` — multi-provider LLM client (streaming)
- `packages/yuan-core/src/execution-engine.ts` — optional ExecutionEngine path
- `packages/yuan-cli/src/cli.ts` — CLI entry, slash commands, set-key
- `packages/yuan-cli/src/tui/` — Ink TUI components

## Agent Loop Behavior

When working on `agent-loop.ts`:
- The `executeTools()` method at line ~2285 is the main tool dispatch — currently sequential
- `validateAndFeedback()` at line ~2494 runs after tool execution (tsc/eslint)
- `updateMemoryAfterRun()` calls `addConvention()`, `addPattern()`, `prune()` — do not remove these
- `HierarchicalPlanner` is wired at line ~1258 — only activates for complex tasks (enablePlanning config)
- `ImpactAnalyzer` is wired at line ~2488 — runs after each file modification

## Wired vs Unwired Modules

**Wired (active):**
- ContextManager, ImpactAnalyzer, AutoFixLoop, SelfDebugLoop, FailureRecovery, MemoryManager

**Exported but NOT wired to agent-loop:**
- ContextCompressor (priority-based compression)
- ContextBudgetManager (LLM summarization)
- CrossFileRefactor (symbol tracking + rename/move)
- DependencyAnalyzer (independent file grouping for parallel execution)

Do NOT remove or stub these — they are planned for future wiring.

## Provider Support

Supported: `yua`, `openai`, `anthropic`, `google` (Gemini)

Gemini quirk: OpenAI-compatible endpoint omits `index` field in streaming tool_call deltas.
Fix already applied in `llm-client.ts`: use id-based index mapping (`idToIndex` Map).

## Failed Approaches

- **LLM provider: google** — 400 status code error may occur if key is invalid or model not available; verify key with `yuan config set-key google <key>`
- **WelcomeBanner with unicode box chars** — causes terminal width miscount; use ASCII art only

## Learnings

- `file_read` is highly effective for parallel exploration tasks
- Always read files before editing (agent-loop enforces this but LLM should too)
- `pnpm run build` from root builds all packages in dependency order
