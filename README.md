# YUAN -- Autonomous Coding Agent

[![CI](https://github.com/yuaone/yuan/actions/workflows/ci.yml/badge.svg)](https://github.com/yuaone/yuan/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

An open-source autonomous coding agent that reads, writes, and fixes code using your own API keys.

YUAN runs a **Tool Use Loop** locally on your machine: describe a task in natural language, and the agent iteratively reads files, writes code, runs commands, and self-corrects until the job is done. No hosted service required -- **bring your own API key (BYOK)**.

---

## Quick Start

```bash
# One-shot -- describe a task and let the agent handle it
npx @yuaone/cli code "fix the login bug"

# Interactive mode -- start a conversation with the agent
npx @yuaone/cli

# Configure your API key (interactive wizard)
npx @yuaone/cli config
```

On first run, YUAN will prompt you to set up an API key if none is configured.

---

## Features

### Core Agent
- **Agent Loop** -- Autonomous tool-use loop that plans, executes, and self-corrects
- **10 Built-in Tools** -- file_read, file_write, file_edit, shell_exec, grep, glob, git_ops, test_run, code_search, web_search
- **BYOK** -- Works with YUA, OpenAI, Anthropic, and Google Gemini API keys
- **Multi-provider** -- Store keys for all providers, switch model at runtime with `/model`
- **Approval Flow** -- Interactive `[Allow] [Always Allow] [Deny]` for destructive operations
- **One-shot Mode** -- Run a single task and exit (`yuan code "add error handling to auth.ts"`)
- **Session Persistence** -- Pause, resume, and recover agent sessions

### World Model & Proactive Replanning (v0.7.0)
- **World Model** -- Agent maintains a live snapshot of the codebase state (files, build status, test results) as it works
- **Transition Model** -- Per-tool failure probability predictions with EMA calibration; learns from past outcomes
- **Simulation Engine** -- Simulates plan success probability before execution begins; flags high-risk steps upfront
- **Proactive Replanning** -- Risk scoring every 5 iterations; auto-replan at 70%+ risk without waiting for failure
- **Immutable Delta-Patch State** -- World state history uses structural sharing (O(k) not O(n) memory per update)

### Planning & Intelligence
- **HierarchicalPlanner** -- Task decomposition with dependency graph for complex multi-file work
- **DebateOrchestrator** -- Coder → Reviewer → Verifier loop for higher code quality
- **6D Self-Reflection** -- Per-iteration scoring across correctness, completeness, consistency, quality, security, performance
- **CAG Prompting** -- Cache-Augmented Generation: cold system context cached, dynamic context uncached for efficiency
- **Parallel Tool Execution** -- Read-only tools (file_read, grep, glob) run in parallel waves; writes serialized by dependency

### Developer Experience
- **Full TUI** -- Full-screen terminal UI with slash menu, approval prompts, live token counters
- **Real-time Diff Output** -- file_write shows unified diff instead of silent overwrite
- **Benchmark Runner** -- `/benchmark` command for tracking performance regressions across runs
- **Design Mode** -- AI-powered real-time UI collaboration via Playwright
- **Security** -- Blocked commands, shell injection prevention, sensitive file detection, secret detector

---

## Supported Providers

| Provider  | Default Model         | Notes                            |
|-----------|-----------------------|----------------------------------|
| YUA       | yua-normal            | Self-hosted, OpenAI-compatible   |
| OpenAI    | gpt-4o-mini           | BYOK                             |
| Anthropic | claude-sonnet-4-6     | BYOK, 1M context                 |
| Google    | gemini-2.5-flash      | BYOK                             |

### Model Catalog (2026)

**OpenAI:** `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `o3`, `o3-mini`, `o4-mini`, `gpt-5`, `gpt-5-mini`

**Anthropic:** `claude-opus-4-6` (1M ctx), `claude-sonnet-4-6`, `claude-haiku-4-5`

**Google:** `gemini-2.5-pro` (2M ctx), `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-pro`, `gemini-3.1-flash`

You can override the model per-session:

```bash
yuan code "refactor the auth module" --model anthropic/claude-opus-4-6
yuan code "quick fix" --model openai/gpt-4o-mini
```

Or switch at runtime with `/model` slash command.

---

## Installation

### Global install

```bash
npm install -g @yuaone/cli
yuan
```

### Without installing

```bash
npx @yuaone/cli
```

### Requirements

- Node.js >= 20
- An API key from YUA, OpenAI, or Anthropic

---

## Configuration

Run the interactive setup wizard:

```bash
yuan config
```

Or set values directly:

```bash
# Set provider and API key
yuan config set-key yua yua-...
yuan config set-key openai sk-...
yuan config set-key anthropic sk-ant-...

# Switch to cloud mode (uses YUA hosted service instead of BYOK)
yuan config set-mode cloud
```

View current configuration:

```bash
yuan config show
```

Configuration is stored in `~/.yuan/config.json`.

---

## Usage Examples

### Interactive mode

```bash
yuan
```

Start a persistent REPL session. The agent remembers context across messages.

### One-shot mode

```bash
yuan code "add error handling to auth.ts"
yuan code "write unit tests for the UserService class"
yuan code "fix the TypeScript build errors"
```

Describe the task, the agent executes it, and exits when done.

### Cloud mode

```bash
yuan config set-mode cloud
yuan code "refactor the database layer"
```

Use the YUA hosted service instead of your own API key.

### Resume a session

```bash
yuan resume --list
yuan resume --id <sessionId>
```

---

## Architecture

YUAN is organized as a pnpm monorepo:

```
yuan/
  packages/
    yuan-core/     @yuaone/core   -- Agent runtime (loop, governor, planner, context manager, security)
    yuan-tools/    @yuaone/tools  -- Tool implementations (file I/O, shell, search, git, tests)
    yuan-cli/      @yuaone/cli    -- CLI entry point, REPL, terminal renderer, session management
    yuan-mcp/      @yuaone/mcp    -- MCP server adapter for exposing tools to external clients
```

### @yuaone/core

The agent runtime. Contains the main Agent Loop that orchestrates LLM calls and tool execution, the Governor that enforces safety limits, the HierarchicalPlanner for task decomposition, ReflexionEngine for per-iteration self-improvement, ContinuationEngine for checkpointing, ExecutionPolicyEngine for cost control, and the Context Manager for token-aware history compaction.

### @yuaone/tools

Implementations of all 9 tools. Each tool extends `BaseTool` with a consistent interface for parameter validation, execution, and result formatting.

### yuan (CLI)

The user-facing CLI built on Commander.js. Provides the interactive REPL, one-shot mode, session persistence (save/resume/list), configuration management, and terminal rendering with syntax-highlighted diffs.

### @yuaone/mcp

An MCP (Model Context Protocol) server that exposes YUAN's tools as MCP resources and tool endpoints, allowing external MCP clients to use YUAN's capabilities.

---

## Tools

| Tool          | Description                                                    |
|---------------|----------------------------------------------------------------|
| `file_read`   | Read file contents with optional line range                    |
| `file_write`  | Create or overwrite files                                      |
| `file_edit`   | Apply targeted string replacements (diff-based editing)        |
| `shell_exec`  | Execute shell commands with security validation                |
| `grep`        | Search file contents using regular expressions                 |
| `glob`        | Find files by name pattern                                     |
| `git_ops`     | Git operations (status, diff, log, commit, branch)             |
| `test_run`    | Run project test suites and report results                     |
| `code_search` | Semantic code search across the project                        |

All tool results are size-limited to prevent context window overflow.

---

## Security

YUAN enforces multiple layers of security:

- **Blocked commands** -- `sudo`, `rm -rf /`, interactive editors, network tools, destructive system ops
- **Shell injection prevention** -- Metacharacter injection (`|`, `&`, `` ` ``, `$()`) is blocked
- **Sensitive file detection** -- Operations on credentials, keys, and env files trigger warnings
- **Approval system** -- Dangerous operations (force push, publish, etc.) require explicit approval
- **Output limits** -- Tool results are capped to prevent token overflow

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

```bash
git clone https://github.com/yuaone/yuan.git
cd yuan
pnpm install
pnpm run build
pnpm run dev
```

---

## License

[AGPL-3.0](./LICENSE) -- Copyright 2026 YUA Inc.
