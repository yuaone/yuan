# YUAN -- Autonomous Coding Agent

An open-source autonomous coding agent that reads, writes, and fixes code using your own API keys.

YUAN runs a Tool Use Loop locally on your machine: you describe a task in natural language, and the agent iteratively reads files, writes code, runs commands, and self-corrects until the job is done. No hosted service required -- bring your own API key.

---

## Features

- **Tool Use Loop** -- 9 built-in tools for reading, writing, searching, and executing code
- **BYOK (Bring Your Own Key)** -- Works with OpenAI, Anthropic, and Google API keys
- **Interactive REPL** -- Persistent conversation with the agent in your terminal
- **One-shot mode** -- Run a single task and exit (`yuan code "fix the login bug"`)
- **MCP server** -- Expose YUAN tools via Model Context Protocol
- **Session persistence** -- Pause, resume, and recover agent sessions
- **Approval system** -- Dangerous operations require explicit user approval
- **Auto-fix loop** -- Agent retries on build/test failures (up to configurable limit)
- **Security** -- Blocked commands, shell metacharacter injection prevention, sensitive file detection

---

## Quick Start

```bash
# Interactive mode -- start a conversation with the agent
npx yuan

# One-shot -- describe the task and let the agent handle it
npx yuan code "fix the login bug"

# Configure API keys (interactive wizard)
yuan config

# Resume a previous session
yuan resume --list
yuan resume --id <sessionId>
```

On first run, YUAN will prompt you to set up an API key if none is configured.

---

## Installation

### Global install

```bash
npm install -g yuan
yuan
```

### Without installing

```bash
npx yuan
```

### Requirements

- Node.js >= 20
- An API key from OpenAI, Anthropic, or Google

---

## Configuration

Run the interactive setup wizard:

```bash
yuan config
```

Or set keys directly:

```bash
yuan config set-key openai sk-...
yuan config set-key anthropic sk-ant-...
yuan config set-key google AIza...
```

View current configuration:

```bash
yuan config show
```

Configuration is stored in `~/.yuan/config.json`.

### Supported Providers and Default Models

| Provider  | Default Model               |
|-----------|-----------------------------|
| OpenAI    | gpt-4o                      |
| Anthropic | claude-sonnet-4-20250514    |
| Google    | gemini-2.0-flash            |

You can override the model per-session with the `--model` flag:

```bash
yuan code "refactor the auth module" --model gpt-4o-mini
```

---

## Architecture

YUAN is organized as a pnpm monorepo with four packages:

```
yuan/
  packages/
    yuan-core/     Agent runtime (loop, governor, planner, context manager, security)
    yuan-tools/    Tool implementations (file I/O, shell, search, git, tests)
    yuan-cli/      CLI entry point, REPL, terminal renderer, session management
    yuan-mcp/      MCP server adapter for exposing tools to external clients
```

### yuan-core

The agent runtime. Contains the main Agent Loop that orchestrates LLM calls and tool execution, the Governor that enforces safety limits, the Planner for task decomposition, and the Context Manager for token-aware history compaction.

### yuan-tools

Implementations of all 9 tools. Each tool extends `BaseTool` with a consistent interface for parameter validation, execution, and result formatting.

### yuan-cli

The user-facing CLI built on Commander.js. Provides the interactive REPL, one-shot mode, session persistence (save/resume/list), configuration management, and terminal rendering with syntax-highlighted diffs.

### yuan-mcp

An MCP (Model Context Protocol) server that exposes YUAN's tools as MCP resources and tool endpoints, allowing external MCP clients to use YUAN's capabilities.

---

## Tools

YUAN provides 9 built-in tools:

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

All tool results are size-limited to prevent context window overflow (e.g., `file_read` caps at 50KB, `shell_exec` at 100KB).

---

## MCP Integration

YUAN can run as an MCP server, exposing its tools to any MCP-compatible client:

```bash
yuan mcp
```

The MCP adapter translates between the MCP protocol and YUAN's internal tool interface, providing resources and tool endpoints.

---

## Session Management

YUAN automatically saves session state, allowing you to pause and resume work:

```bash
# List recent sessions (shows ID, status, message count, iteration)
yuan resume --list

# Resume the most recent session
yuan resume

# Resume a specific session by ID
yuan resume --id abc12345
```

Sessions track conversation history, token usage, and iteration count. Crashed sessions can be recovered.

---

## Security

YUAN enforces multiple layers of security to prevent destructive or dangerous operations.

### Blocked Commands

The following executables are completely blocked:

- **Privilege escalation**: `sudo`, `su`, `doas`
- **Interactive editors**: `vim`, `nano`, `emacs`, `less`, `more`
- **Network access**: `ssh`, `scp`, `curl`, `wget`, `ftp`, `telnet`
- **Destructive system ops**: `dd`, `mkfs`, `fdisk`, `shutdown`, `reboot`
- **Mount operations**: `mount`, `umount`

### Dangerous Argument Patterns

Certain commands are allowed but specific argument combinations are blocked:

- `rm -rf` and `rm --recursive` with force
- `chmod 777`
- `chown` (any usage)
- `git push`, `git reset --hard`, `git clean -f` (require approval)
- `npm publish` (requires approval)
- Shell metacharacter injection (`|`, `&`, `` ` ``, `$()`)

### Sensitive File Detection

YUAN detects and warns about operations on sensitive files (credentials, keys, environment files) before proceeding.

### Approval System

Operations flagged as dangerous prompt the user for explicit approval before execution. In non-interactive (one-shot) mode, dangerous operations are blocked by default.

---

## Plan Tiers

| Tier       | Daily Executions | Max Iterations | Parallel Agents | Session TTL |
|------------|-----------------|----------------|-----------------|-------------|
| Free       | 3               | 5              | 1               | 5 min       |
| Pro        | 15              | 25             | 3               | 30 min      |
| Business   | 50              | 50             | 7               | 2 hours     |
| Enterprise | 150             | 100            | Unlimited       | 8 hours     |

---

## Project Configuration

YUAN looks for a `YUAN.md` file in your project to understand project-specific context and instructions. Search paths (in priority order):

1. `YUAN.md`
2. `.yuan/config.md`
3. `.yuan/YUAN.md`
4. `docs/YUAN.md`

---

## Contributing

Contributions are welcome. To get started:

```bash
git clone https://github.com/yua-inc/yuan.git
cd yuan
pnpm install
pnpm run build
pnpm run dev
```

### Development Notes

- pnpm workspace (do not use npm or yarn)
- TypeScript strict mode, ESM modules
- All public functions require JSDoc comments
- Errors use the `YuanError` hierarchy defined in `yuan-core`

### Running Tests

```bash
pnpm run test
```

### Building

```bash
pnpm run build
```

---

## License

AGPL-3.0. See [LICENSE](./LICENSE) for details.

Copyright 2026 YUA Inc.
