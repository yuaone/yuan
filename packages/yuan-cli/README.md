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
| `/tools`     | List available tools (built-in + MCP)            |
| `/memory`    | Show learned patterns from YUAN.md               |
| `/plugins`   | Plugin management (install/remove/search)        |
| `/skills`    | Available skills (tree view)                     |
| `/session`   | Session management                               |
| `/settings`  | Auto-update preferences                          |
| `/tip`       | Show a random usage tip                          |
| `/mcp`       | Show loaded MCP servers and setup guide          |
| `/qa`        | Show last QA result + governor config            |
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

### /skills — Skill Management

```bash
/skills                    # List all available skills (tree view)
/skills enable debug        # Enable a skill manually
/skills disable debug       # Disable a skill
/skills info typescript     # Show skill details and patterns
```

YUAN bundles **35 skills** by default — skills activate automatically based on file types and context. Enabling a skill also sets the corresponding agent mode (e.g., `debug` → debug mode, `security-scan` → security mode).

**Built-in skill groups:**

| Group | Skills |
|-------|--------|
| Core | `debug`, `test-driven`, `code-review`, `security-scan`, `refactor`, `plan` |
| Languages | `typescript`, `javascript`, `python`, `react`, `vue`, `svelte`, `go`, `rust`, `java`, `kotlin`, `swift`, `csharp`, `dart`, `ruby`, `php`, `c`, `cpp`, `bash`, `sql`, `elixir`, `haskell`, `lua`, `r` |
| Special Domains | `solidity`, `docker`, `terraform`, `gdscript`, `cuda`, `verilog` |

User skills: `~/.yuan/skills/*.md`. Plugin skills: `npm install @yuaone/plugin-*`.

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

## MCP Server Integration

YUAN supports any MCP (Model Context Protocol) server as external tools — no code changes needed.

### Setup

Create `~/.yuan/mcp.json` (gitignored, never committed):

```json
{
  "servers": [
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    },
    {
      "name": "fetch",
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    },
    {
      "name": "memory",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  ]
}
```

YUAN auto-discovers and connects all servers on startup. Tools appear in the LLM's tool list automatically (e.g. `github_search_code`, `fetch_fetch`).

### Recommended MCP Servers

#### Free / No API key required
| Server | Install | What it adds |
|--------|---------|-------------|
| **mcp-server-fetch** (official) | `uvx mcp-server-fetch` | Fetch any URL → clean markdown |
| **memory** (official) | `npx -y @modelcontextprotocol/server-memory` | Persistent knowledge graph across sessions |
| **git** (official) | `uvx mcp-server-git` | Git operations via MCP |
| **sequentialthinking** (official) | `npx -y @modelcontextprotocol/server-sequential-thinking` | Structured multi-step reasoning |
| **filesystem** (official) | `npx -y @modelcontextprotocol/server-filesystem` | Extended file ops with configurable paths |
| **Playwright** (Microsoft) | `npx -y @playwright/mcp` | Full browser automation |
| **Docker** (community) | `npx -y mcp-server-docker` | Container management |
| **Kubernetes** (community) | `npx -y mcp-server-kubernetes` | K8s cluster control |

#### Requires API key (BYOK)
| Server | Install | What it adds |
|--------|---------|-------------|
| **GitHub** (official) | `npx -y @modelcontextprotocol/server-github` | PR/issue management, code search |
| **Brave Search** (official) | `npx -y @modelcontextprotocol/server-brave-search` | Web search (`BRAVE_API_KEY`) |
| **Spider** | `npx -y @willbohn/spider-mcp` | Web scraping + search (`SPIDER_API_KEY`) |
| **Semgrep** | `npx -y semgrep-mcp` | SAST security scanning |
| **E2B** | `npx -y @e2b/mcp-server` | Isolated cloud code execution (`E2B_API_KEY`) |
| **Perplexity** | via ppl-ai | Real-time web research (`PERPLEXITY_API_KEY`) |

#### Self-hosted (free after setup)
| Server | Setup | What it adds |
|--------|-------|-------------|
| **SearXNG** | Docker: `docker run -p 8080:8080 searxng/searxng` | Privacy-respecting multi-engine search (no API key) |
| **Meilisearch** | Docker | Full-text + semantic search over your data |
| **Chroma** | pip/Docker | Vector DB for embeddings |

### Full mcp.json example

```json
{
  "servers": [
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    },
    {
      "name": "brave",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "BSA_xxx" }
    },
    {
      "name": "fetch",
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    },
    {
      "name": "memory",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    {
      "name": "playwright",
      "command": "npx",
      "args": ["-y", "@playwright/mcp"]
    }
  ]
}
```

> `~/.yuan/mcp.json` is gitignored and never committed — safe to store API keys.

Use `/mcp` in the TUI to see which servers are currently loaded.

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
| **TaskClassifier** | Classifies user task type (feature/debug/refactor/security/…) |
| **StrategySelector** | Picks up to 3 execution strategies, propagates to subagents |
| **SkillLoader** | Loads 35 built-in skills + user/plugin skills, auto-activates |

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
