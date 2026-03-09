# YUAN Project Memory

## Overview
- Autonomous Coding Agent (Open Core, AGPL-3.0)
- Community: CLI + BYOK + Local execution
- Pro: Cloud mode via YUA hosted service
- GitHub: https://github.com/yuaone/yuan
- npm org: @yuaone

## Packages (npm published v0.1.0)
| Package | npm | Description |
|---------|-----|-------------|
| `@yuaone/core` | published | Agent runtime (loop, governor, planner, context, security) |
| `@yuaone/tools` | published | 9 tools (file_read, file_write, file_edit, shell_exec, grep, glob, git_ops, test_run, code_search) |
| `@yuaone/cli` | published | CLI entry point, REPL, session management, cloud mode |
| `@yuaone/mcp-server` | not yet | MCP server adapter |
| `@yuaone/backend` | private | Independent API server for cloud execution |

## Architecture
```
npx @yuaone/cli code "fix bug"
  → Local mode: @yuaone/core AgentLoop + @yuaone/tools (BYOK)
  → Cloud mode: SSE → yua-backend → AgentExecutor → Tools
```

## Key Features
- Multi-provider BYOK (OpenAI, Anthropic, Google, DeepSeek)
- Agent Loop with tool-use cycle + self-correction
- Approval flow for dangerous operations
- Session persistence (save/resume/list)
- Cloud mode (SSE streaming to YUA backend)
- Security: blocked commands, shell injection prevention, secret detection, audit logging
- MCP server for external tool access

## Status
- Phase 1a (Core): Complete
- Phase 1b (Cloud mode): Complete
- Security (C-stage): Complete — secret detector, audit logger, workdir sandbox
- Open-source (D-stage): Complete — GitHub public, npm published, CI workflow
- Current version: 0.1.0
- Initialized: 2026-03-08
