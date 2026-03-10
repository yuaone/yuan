# YUAN Project Memory

## Overview
- YUAN Coding Agent (Open Core, AGPL-3.0)
- Community: CLI + BYOK + Local execution
- Pro: Cloud mode via YUA hosted service
- GitHub: https://github.com/yuaone/yuan
- npm org: @yuaone
- Current version: 0.1.3

## Packages (npm published v0.1.3)
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
- Multi-provider BYOK (YUA, OpenAI, Anthropic)
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

## 14 Intelligence Features Audit (2026-03-10)

| # | Feature | Status | Key Modules (LOC) |
|---|---------|:------:|-------------------|
| 1 | Experience Engine | WORKING | memory-manager (742), memory-updater (584), reflexion (788) |
| 2 | Strategy Library | WORKING | task-classifier (695), reflexion (788), hierarchical-planner (1474) |
| 3 | Self-Critic Engine | WORKING | self-reflection (1312), qa-pipeline (1781), continuous-reflection (467) |
| 4 | Skill System | PARTIAL | Needs .skill format, registry, plugin system |
| 5 | Compact Mode | WORKING | context-compressor (427), context-budget (1248), context-manager (644) |
| 6 | Speculative Execution | WORKING | speculative-executor (824), parallel-executor (604), dag-orchestrator (587) |
| 7 | Superpower Mode | WORKING | execution-policy-engine (519), agent-modes (394), execution-engine (2273) |
| 8 | Trust Report | WORKING | agent-logger (1150), qa-pipeline (1781), security-scanner (1339) |
| 9 | Checkpoint/Rewind | WORKING | session-persistence (593), state-machine (1041), continuation-engine (296) |
| 10 | Background Orchestrator | WORKING | worker (327), process-manager (486), docker-manager (428) |
| 11 | Prompt Caching | PARTIAL | In-memory only; needs Anthropic cache_control headers |
| 12 | Model Tier Routing | WORKING | model-router (compiled), cost-optimizer (426) |
| 13 | Sub-agent Background | WORKING | sub-agent (498), dag-orchestrator (587) |
| 14 | Parallel Agent Execution | WORKING | parallel-executor (604), dag-orchestrator (587), debate-orchestrator (999) |

**Result: 11 WORKING, 2 PARTIAL, 1 source missing (model-router.ts)**

## Core Modules (68 files, ~53,179 lines)
| Module | Lines | Status | Description |
|--------|-------|--------|-------------|
| types.ts | ~600 | Done | Type definitions + ContentBlock multimodal + contentToString util |
| agent-loop.ts | ~1050 | Done | Main loop + memory + planning integration |
| system-prompt.ts | ~250 | Done | 10-section enhanced prompt builder |
| hierarchical-planner.ts | ~1474 | Done | 3-level planner (Strategic/Tactical/Operational) |
| context-manager.ts | ~644 | Done | Context window + replaceSystemMessage + multimodal tokens |
| context-budget.ts | ~1248 | Done | Budget management + ContentBlock support |
| context-compressor.ts | ~427 | Done | Priority-based compression + ContentBlock support |
| execution-engine.ts | ~2273 | Done | Full execution engine + checkpoints + superpower mode |
| self-reflection.ts | ~1312 | Done | Self-critic engine |
| qa-pipeline.ts | ~1781 | Done | QA pipeline + trust report |
| security-scanner.ts | ~1339 | Done | Security scanning + secret detection |
| + 57 more modules | | | See intelligence audit above |

## CLI Updates (2026-03-10)
- Mascot: Arctic fox ASCII art on launch
- Unified command dispatcher: 18 commands
- FooterBar moved above input line
- exitTUI cleanup (proper process termination)
- `/diff` context lines default: 5
- Description: "YUAN Coding Agent" (not "Autonomous")

## Status
- Phase 1a (Core): Complete
- Phase 1b (Cloud mode): Complete
- Phase 4 (Wave 1-5 + Harness Rounds 1-2): Complete
- Security + QA Audits: Complete
- **Phase 5 (Intelligence Layer): Complete**
  - 11/14 features WORKING
  - 2 PARTIAL (Skill System, Prompt Caching)
  - 1 source missing (model-router.ts — compiled .js works)
- **Phase 6 (Planned): Plugin/Skill System**
  - .skill file format definition
  - Skill registry + discovery
  - Plugin system architecture
  - Prompt Caching with Anthropic native cache_control
  - model-router.ts source recovery
- Last update: 2026-03-10
