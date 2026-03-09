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
| `@yuaone/core` | published | Agent runtime (loop, governor, planner, context, memory, security) |
| `@yuaone/tools` | published | 9 tools (file_read, file_write, file_edit, shell_exec, grep, glob, git_ops, test_run, code_search) |
| `@yuaone/cli` | published | CLI entry point, REPL, session management, cloud mode |
| `@yuaone/mcp-server` | not yet | MCP server adapter |
| `@yuaone/backend` | private | Independent API server for cloud execution |

## Architecture
```
npx @yuaone/cli code "fix bug"
  → Local mode: @yuaone/core AgentLoop + @yuaone/tools (BYOK)
  → Cloud mode: SSE → yuan-backend → AgentExecutor → Tools

Agent Loop Pipeline:
  User Message → Complexity Detection → [Auto Planning] → LLM Call → Tool Execution → Re-planning on Error → Memory Update

Memory Pipeline:
  init() → YUAN.md load + MemoryManager load → Enhanced System Prompt → Context Injection
  run() complete → Learning/Failure extraction → MemoryManager save
```

## Key Features
- Multi-provider BYOK (OpenAI, Anthropic, Google, DeepSeek,YUA)
- Agent Loop with tool-use cycle + self-correction
- **Multimodal support** (text, image, file ContentBlock)
- **Auto-planning** (HierarchicalPlanner: L1 Strategic → L2 Tactical → L3 Operational)
- **Complexity detection** (trivial/simple/moderate/complex/massive → auto-plan trigger)
- **Re-planning** on execution errors (retry_with_fix, alternative_approach, skip, escalate)
- **Memory auto-injection** (YUAN.md + MemoryManager → system prompt)
- **Memory auto-update** (learnings + failed approaches saved after each run)
- **Enhanced system prompt** 
- Approval flow for dangerous operations
- Session persistence (save/resume/list)
- Cloud mode (SSE streaming to YUA backend)
- Security: blocked commands, shell injection prevention, secret detection, audit logging
- MCP server for external tool access

## Core Modules (55 files, ~45,575 lines)
| Module | Lines | Status | Description |
|--------|-------|--------|-------------|
| types.ts | ~600 | ✅ | Type definitions + ContentBlock multimodal + contentToString util |
| agent-loop.ts | ~1050 | ✅ | Main loop + memory + planning integration |
| system-prompt.ts | ~250 | ✅ | 10-section enhanced prompt builder |
| hierarchical-planner.ts | ~1315 | ✅ Wired | 3-level planner (Strategic/Tactical/Operational) |
| context-manager.ts | ~360 | ✅ | Context window + replaceSystemMessage + multimodal tokens |
| context-budget.ts | ~1200 | ✅ | Budget management + ContentBlock support |
| context-compressor.ts | ~700 | ✅ | Priority-based compression + ContentBlock support |
| llm-client.ts | ~600 | ✅ | BYOK client + multimodal message formatting |
| memory.ts | ~400 | ✅ | YUAN.md reading/writing/parsing |
| memory-manager.ts | ~300 | ✅ | Structured learnings/patterns/failures |
| governor.ts | ~400 | ✅ | Execution limits + safety validation |
| execution-engine.ts | ~1500 | ✅ | Full execution engine + checkpoints |
| kernel.ts | ~1200 | ✅ | Core kernel |
| + 42 more modules | | | See yuan-progress.md |

## Status
- Phase 1a (Core): Complete
- Phase 1b (Cloud mode): Complete
- Phase 4 (Wave 1-5 + Harness Rounds 1-2): Complete
- Security + QA Audits: Complete
- **Phase 5 (Intelligence Layer)**: In Progress
  - ✅ Memory auto-injection + auto-update
  - ✅ Enhanced system prompt (Claude Code-quality)
  - ✅ Multimodal support (ContentBlock type)
  - ✅ HierarchicalPlanner → AgentLoop wiring
  - ✅ Complexity detection + auto-planning
  - ✅ Re-planning on errors
  - 🔲 Task Classifier (tool sequence mapping)
  - 🔲 Reflexion layer (structured reflection storage)
  - 🔲 Prompt injection defense
  - 🔲 Role-based token budgets
- Current version: 0.1.0
- Initialized: 2026-03-08
- Last update: 2026-03-09
