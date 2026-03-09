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

- **Agent Loop** -- Autonomous tool-use loop that plans, executes, and self-corrects
- **9 Built-in Tools** -- file_read, file_write, file_edit, shell_exec, grep, glob, git_ops, test_run, code_search
- **Multi-Provider BYOK** -- Works with OpenAI, Anthropic, Google, and DeepSeek API keys
- **Streaming Output** -- Real-time streaming of agent reasoning and tool results
- **Approval Flow** -- Dangerous operations require explicit user approval before execution
- **Interactive REPL** -- Persistent conversation with the agent in your terminal
- **One-shot Mode** -- Run a single task and exit (`yuan code "add error handling to auth.ts"`)
- **Session Persistence** -- Pause, resume, and recover agent sessions
- **MCP Server** -- Expose YUAN tools via Model Context Protocol
- **Security** -- Blocked commands, shell injection prevention, sensitive file detection

---

## Supported Providers

| Provider  | Default Model               |
|-----------|-----------------------------|
| OpenAI    | gpt-4o                      |
| Anthropic | claude-sonnet-4-20250514    |
| Google    | gemini-2.0-flash            |
| DeepSeek  | deepseek-chat               |

You can override the model per-session:

```bash
yuan code "refactor the auth module" --model gpt-4o-mini
```

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
- An API key from OpenAI, Anthropic, Google, or DeepSeek

---

## Configuration

Run the interactive setup wizard:

```bash
yuan config
```

Or set values directly:

```bash
# Set provider and API key
yuan config set-key openai sk-...
yuan config set-key anthropic sk-ant-...
yuan config set-key google AIza...
yuan config set-key deepseek sk-...

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

The agent runtime. Contains the main Agent Loop that orchestrates LLM calls and tool execution, the Governor that enforces safety limits, the Planner for task decomposition, and the Context Manager for token-aware history compaction.

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
