# YUAN — Autonomous Coding Agent

[![CI](https://github.com/yuaone/yuan/actions/workflows/ci.yml/badge.svg)](https://github.com/yuaone/yuan/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

An open-source autonomous coding agent with a **deterministic Decision Engine**, intelligent code quality enforcement, and multi-mode execution. Describe a task in natural language, and the agent plans, reads, writes, verifies, and self-corrects until the job is done.

**Bring your own API key (BYOK)** — runs locally with OpenAI, Anthropic, or Google Gemini.

---

## Quick Start

```bash
# Install globally
npm install -g @yuaone/cli

# Interactive mode
yuan

# One-shot
yuan code "fix the login bug"

# Configure API key
yuan config
```

---

## Architecture

### Decision Engine (SSOT)

Every user message passes through a **deterministic Decision Engine** before any LLM call. No LLM is used in the decision process — pure heuristic reasoning.

```
User Message
  → AgentReasoningEngine (intent, stage, complexity, Code/Math AST analysis)
  → AgentAffordanceCalculator (5D execution tendency vector, cosineEase)
  → AgentDecisionOrchestrator (27-field immutable SSOT)
  → InteractionMode routing: CHAT / HYBRID / AGENT
  → PromptRuntime (3-layer: SystemCore → PromptRuntime → PromptBuilder)
  → LLM Call (with Decision-compiled prompt)
```

**27 Decision fields** control every aspect of execution:

| Category | Fields |
|----------|--------|
| Reasoning | intent (9 types), taskStage, complexity, confidence, depthHint, cognitiveLoad |
| Affordance | explain_plan, inspect_more, edit_now, run_checks, finalize |
| Execution | interactionMode, planRequired, scanBreadth, verifyDepth, microPlan |
| Safety | failureSurface, vetoFlags, toolGate, toolBudget, patchScope |
| Quality | codeQuality (strictMode, primaryRisk), responseHint, leadHint |
| Intelligence | subAgentPlan, skillActivation, pressureDecision, continuityCapsule |
| Style | personaHint, styleHint, memoryIntent, memoryLoad |

### Dual-Mode Execution

The Decision Engine automatically routes to the appropriate execution mode:

| Mode | When | Behavior |
|------|------|----------|
| **CHAT** | Simple questions, trivial tasks | Fast response, minimal tools, no planning |
| **HYBRID** | Single-file fixes, moderate tasks | Direct execution + quick verification |
| **AGENT** | Complex refactoring, multi-file work | Full planning → execution → verification pipeline |

### Prompt 3-Layer Architecture

```
SystemCore (immutable constitution — identity, behavior, safety)
  → PromptRuntime (Decision compiler — 16+ dynamic sections, token-budgeted)
    → PromptBuilder (dumb renderer — zone-ordered, droppable-aware)
```

### Tool Execution Pipeline

Every tool call passes through a **10-stage safety pipeline**:

```
SecurityGate → MutationPolicy → JudgmentRules → ToolGate
→ VetoFlags → DependencyGuard → PatchScope → ToolBudget
→ PreWriteValidator → PatchTransaction → [Execute]
→ VerifierRules → SemanticDiffReview → RollbackPoint
```

---

## Features

### Intelligence Layer
- **Code/Math AST Analysis** — Deterministic code complexity analysis (nesting depth, branches, async patterns, I/O) and math symbolic density detection in user messages
- **Code Quality Pipeline** — Task-specific constraints (GENERATION/FIX/REFACTOR/TEST/REVIEW), primary risk identification, strict mode (no TODO/stub/placeholder)
- **Model Weakness Tracker** — Learns model-specific repeated mistakes, injects preventive hints + engine coefficient boosts
- **Target File Ranker** — Post-retrieval reranking of file candidates (error stack +40, message mention +30, recent change +20)
- **Command Plan Compiler** — Deterministic shell command compilation for build/test/lint/verify (no LLM hallucination)
- **Semantic Diff Reviewer** — Classifies change meaning (SIGNATURE/CONTROL_FLOW/IMPORT/CONFIG/BEHAVIOR/STYLE/TEST_ONLY)

### Safety & Security
- **Security Gate** — 17 shell injection patterns, 8 dangerous file paths, 6 credential leak patterns
- **Workspace Mutation Policy** — 4-zone path protection (SAFE/CAUTION/PROTECTED/FORBIDDEN) with repo-local overrides
- **Pre-Write Validator** — Quality gate before every file write (context-aware: fileRole, language, changedHunks)
- **Patch Scope Controller** — Hard limits on blast radius (files, diff lines, cross-package touches) with greenfield/migration exceptions
- **Patch Transaction Journal** — Atomic before-snapshots for every file mutation, deterministic rollback on failure
- **Dependency Guard** — 10-ecosystem detection (npm/pnpm/yarn/pip/cargo/go/gem/composer), install policy enforcement
- **Judgment Rule Registry** — Rule-based tool approval with learning (success/failure tracking, confidence decay)

### Execution
- **15 Built-in Tools** — file_read, file_write, file_edit, shell_exec, bash, grep, glob, git_ops, test_run, code_search, web_search, parallel_web_search, security_scan, browser, task_complete
- **HierarchicalPlanner** — 3-level task decomposition with dependency graph
- **SubAgent Orchestration** — 6 typed roles (coder/reviewer/tester/debugger/refactorer/planner), DAG-based parallel execution
- **OverheadGovernor** — Decision-driven subsystem activation (CHAT=all OFF, AGENT=BLOCKING)
- **Tool Outcome Cache** — Content-hash based caching for deterministic commands (tsc, build, lint)

### Learning & Recovery
- **Memory Decay** — Exponential confidence decay (30-day half-life) with automatic pruning
- **Stall Detector** — 10 stall pattern types (read_loop, search_spiral, patch_churn, budget_corner, etc.)
- **Causal Chain Resolver** — Registry-driven root cause analysis for tool failures
- **Failure Surface Writer** — Categorized failure tracking for Decision calibration
- **Self-Evaluation** — Deterministic run scoring (0-1) before reporting completion
- **Execution Receipt** — Typed run outcome artifact (tools used, files changed, verification status, remaining risks)

### CLI Experience
- **Content-Aware Pacer** — Output type detection (prose/code/narration/diff/table) with type-specific pacing
- **Decision-Driven Pacing** — CHAT=instant, AGENT=buffered+narrated, complexity-aware timing
- **DEC 2026 Synchronized Output** — Flicker-free terminal rendering
- **Budget Dock Display** — Real-time tool budget warnings in terminal dock
- **Image Observer** — Automatic image classification (CODE/ERROR/UI/DIAGRAM) with OCR hints

---

## Supported Providers

| Provider  | Default Model         | Notes                            |
|-----------|-----------------------|----------------------------------|
| OpenAI    | gpt-4o-mini           | BYOK                             |
| Anthropic | claude-sonnet-4-6     | BYOK, 1M context                 |
| Google    | gemini-2.5-flash      | BYOK                             |

```bash
yuan code "refactor the auth module" --model anthropic/claude-opus-4-6
yuan code "quick fix" --model openai/gpt-4o-mini
```

---

## Installation

```bash
# Global install
npm install -g @yuaone/cli

# Without installing
npx @yuaone/cli

# Requirements: Node.js >= 20 + API key
```

---

## Packages

```
yuan/
  packages/
    yuan-core/   @yuaone/core   — Decision Engine, Agent Loop, Prompt Runtime, Safety Pipeline
    yuan-tools/  @yuaone/tools  — 15 tool implementations
    yuan-cli/    @yuaone/cli    — CLI, Content-Aware Pacer, Terminal UI
    yuan-mcp/    @yuaone/mcp    — MCP server adapter
```

---

## Configuration

```bash
yuan config                          # Interactive wizard
yuan config set-key openai sk-...    # Set API key
yuan config set-key anthropic sk-ant-...
yuan config show                     # View current config
```

Stored in `~/.yuan/config.json`.

---

## Project Memory

YUAN learns from your project:

```
.yuan/
  ├─ memory.json              — Learned patterns, conventions, failed approaches
  ├─ memory/
  │   ├─ reflections.json     — Self-reflection entries (max 100, FIFO)
  │   └─ strategies.json      — Proven task strategies (confidence-sorted)
  ├─ sessions/                — Session checkpoints with atomic writes
  ├─ cache/
  │   ├─ repo-capability-profile.json  — 1-time repo scan (package manager, test framework, etc.)
  │   └─ model-weaknesses.json         — Model-specific mistake patterns (scoped, decaying)
  └─ judgment-rules.json      — Tool approval rules (auto-expanding from repo profile)
```

---

## Contributing

```bash
git clone https://github.com/yuaone/yuan.git
cd yuan
pnpm install
pnpm run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## License

[AGPL-3.0](./LICENSE) — Copyright 2026 YUA Inc.
