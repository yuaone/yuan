# YUAN CLI

**Autonomous Coding Agent** — runs in your terminal, powered by any LLM.

```
npm install -g @yuaone/cli
yuan
```

---

## Features

- **Full TUI** — full-screen terminal UI with message history, status bar, slash menu
- **Persistent conversation** — conversation history preserved across messages within a session
- **BYOK** — bring your own API key (OpenAI, Anthropic, Google Gemini, or YUA Platform)
- **Multi-provider** — store keys for all providers, switch model at runtime
- **Tool Use** — file read/write/edit, shell exec, grep, glob, git ops, web search
- **Approval system** — interactive `[Allow] [Always Allow] [Deny]` for destructive tools
- **Design Mode** — AI-powered real-time design collaboration with Playwright
- **Parallel tools** — dependency-aware batching for read-only tools
- **Advanced AI engine** — HierarchicalPlanner, ReflexionEngine, ContinuationEngine, PolicyEngine

---

## Install

```bash
npm install -g @yuaone/cli
# or
pnpm install -g @yuaone/cli
```

Requires Node.js ≥ 18.

---

## Quick Start

```bash
# Interactive TUI (default)
yuan

# One-shot task
yuan code "refactor auth.ts to use async/await"

# Classic readline REPL
yuan --classic

# Setup API keys
yuan config
```

---

## Configuration

```bash
# Interactive setup wizard
yuan config

# Set key for a specific provider
yuan config set-key anthropic sk-ant-xxxxx
yuan config set-key openai sk-xxxxx
yuan config set-key google AIzaxxx
yuan config set-key yua yua_sk_xxxxx

# Show current config (keys masked)
yuan config show

# Switch execution mode
yuan config set-mode local    # BYOK (default)
yuan config set-mode cloud    # YUA Platform

# Set cloud server
yuan config set-server https://api.yuaone.com
```

Config is stored at `~/.yuan/config.json` (chmod 600).

### Environment Variables

Keys can also be set via env vars — no config file needed:

| Provider  | Env var                              |
|-----------|--------------------------------------|
| OpenAI    | `OPENAI_API_KEY`                     |
| Anthropic | `ANTHROPIC_API_KEY`                  |
| Google    | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| YUA       | `YUA_API_KEY`                        |

---

## Slash Commands

Type `/` in the TUI to open the command menu (arrow keys to navigate, Enter to select).

| Command      | Description                                      |
|--------------|--------------------------------------------------|
| `/help`      | Show available commands                          |
| `/status`    | Provider, model, tokens, session info            |
| `/model`     | Show or change model / set provider key          |
| `/mode`      | Show or change agent mode                        |
| `/config`    | Show current configuration                       |
| `/clear`     | Clear conversation history                       |
| `/compact`   | Compress context to save tokens                  |
| `/diff`      | Show file changes (git diff)                     |
| `/undo`      | Undo last file change                            |
| `/approve`   | Approve pending tool action                      |
| `/reject`    | Reject pending tool action                       |
| `/retry`     | Retry last failed action                         |
| `/cost`      | Token usage & estimated cost                     |
| `/tools`     | List available tools                             |
| `/memory`    | Show YUAN.md learnings                           |
| `/plugins`   | Plugin management (install/remove/search)        |
| `/skills`    | Available skills (tree view)                     |
| `/session`   | Session management                               |
| `/settings`  | Auto-update preferences                          |
| `/exit`      | Exit YUAN                                        |

### /model — Provider & Model Management

```bash
# Show current model + all available providers
/model

# Switch model (provider/model format)
/model anthropic/claude-sonnet-4-6
/model openai/gpt-4o
/model google/gemini-2.5-pro

# Store a provider key at runtime (no restart needed)
/model setkey anthropic sk-ant-xxxxx
/model setkey openai sk-xxxxx
/model setkey google AIzaxxx
```

### /mode — Agent Modes

```bash
/mode             # Show current mode
/mode auto        # Automatic (default)
/mode manual      # Step-by-step with approval
/mode architect   # High-level planning focus
/mode code        # Pure coding focus
/mode ask         # Q&A only, no file changes
```

---

## Model Catalog (2026)

### OpenAI
| Model | Notes |
|-------|-------|
| `gpt-4o` | Fast, multimodal |
| `gpt-4o-mini` | Default for OpenAI — fast & cheap |
| `gpt-4.1` | Latest GPT-4 generation |
| `gpt-4.1-mini` | Fast, cost-effective |
| `o3` | Advanced reasoning |
| `o3-mini` | Fast reasoning |
| `o4-mini` | Latest mini reasoning |
| `gpt-5` | Flagship, 1M context |
| `gpt-5-mini` | Fast GPT-5 |

### Anthropic
| Model | Notes |
|-------|-------|
| `claude-opus-4-6` | Most capable, 1M context |
| `claude-sonnet-4-6` | Default — balanced speed/quality |
| `claude-haiku-4-5` | Fastest, lowest cost |

### Google Gemini
| Model | Notes |
|-------|-------|
| `gemini-2.5-pro` | Frontier, 2M context |
| `gemini-2.5-flash` | Default for Google — fast |
| `gemini-2.5-flash-lite` | Ultra-fast & cheap |
| `gemini-3.1-pro` | Latest frontier, 2M context |
| `gemini-3.1-flash` | Fast |

---

## Session Management

```bash
# Resume last session
yuan resume

# List recent sessions
yuan resume --list

# Resume specific session by ID
yuan resume --id <sessionId>
```

---

## Design Mode

AI-powered real-time UI design collaboration using Playwright:

```bash
yuan design                          # Auto-detect dev server
yuan design --port 3000              # Specify port
yuan design --auto-vision            # Screenshot after every change
yuan design --viewport mobile        # Mobile viewport
yuan design --dev-command "npm run dev"  # Custom dev command
```

---

## Auth (YUA Platform)

```bash
yuan login                 # Browser-based OAuth
yuan logout
yuan whoami               # Show current user and plan
```

---

## Agent Architecture (v0.6.0)

YUAN uses a multi-layer AI engine:

| Module | Role |
|--------|------|
| **AgentLoop** | Core tool-use loop — sends messages, executes tools, handles approval |
| **HierarchicalPlanner** | Breaks complex tasks into sub-tasks with dependency ordering |
| **ExecutionPolicyEngine** | Token/cost budget enforcement per iteration |
| **ContinuationEngine** | Checkpointing every 3 iterations, recovery on error |
| **ReflexionEngine** | Per-iteration reflection — injects self-improvement insights |
| **WorldStateCollector** | Tracks file changes, propagates context updates |
| **QAPipeline** | Quick + thorough quality checks post-execution |
| **Governor** | Safety/security scanning before tool execution |
| **AutoFix** | Automatic lint/type error repair loop |

---

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `@yuaone/cli` | [![npm](https://img.shields.io/npm/v/@yuaone/cli)](https://www.npmjs.com/package/@yuaone/cli) | CLI + TUI |
| `@yuaone/core` | [![npm](https://img.shields.io/npm/v/@yuaone/core)](https://www.npmjs.com/package/@yuaone/core) | Agent runtime |
| `@yuaone/tools` | [![npm](https://img.shields.io/npm/v/@yuaone/tools)](https://www.npmjs.com/package/@yuaone/tools) | Tool implementations |

---

## License

AGPL-3.0 — see [LICENSE](LICENSE).

Built by [YUAone](https://yuaone.com).
