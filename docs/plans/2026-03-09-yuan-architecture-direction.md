# YUAN Architecture Direction & Implementation Plan

> 2026-03-09 | 아키텍처 방향 정리 + 구현 우선순위

---

## 1. 현재 상태 진단

### 슬래시 커맨드 현황 (10개 정의, 4개만 양쪽 동작)

| 커맨드 | TUI | Interactive | 비고 |
|--------|:---:|:----------:|------|
| /help | OK | OK | |
| /clear | OK | OK | |
| /exit, /quit, /q | OK | OK | |
| /diff | OK | OK | |
| /undo | **STUB** | OK | TUI에 핸들러 없음 |
| /session | **STUB** | OK | TUI에 핸들러 없음 |
| /config | **STUB** | OK | TUI에 핸들러 없음 |
| /status | OK | **STUB** | Interactive에 없음 |
| /settings | OK | **STUB** | Interactive에 없음 |
| /model | **STUB** | **STUB** | 양쪽 다 미구현 |

**문제**: 커맨드 리스트에 보이는데 "Unknown command" 뜨는 것들이 절반.

### 멀티모델 라우팅 현황

| 항목 | 상태 |
|------|------|
| `model-router.ts` (867줄) | 완성되어 있으나 **어디서도 import 안 됨** |
| `llm-client.ts` 프로바이더 5개 | Anthropic + OpenAI만 실제 사용 |
| Google/DeepSeek 포맷 컨버터 | 작성만 됨, 테스트 안 됨 |
| 백엔드 모델 선택 | `claude-sonnet-4` 하드코딩 |
| DAG 기반 모델 배정 | 설계문서에만 존재 |

---

## 2. 멀티모델 라우팅: ~~제거 권장~~ **완료**

> **2026-03-09 실행 완료**

### 왜 제거했는가

1. **디버깅 지옥**: OpenAI 하나에서 tool_calls 메시지 순서 버그로 무한루프 발생.
2. **테스트 불가능**: N 프로바이더 × M 도구 × K 엣지케이스.
3. **실제 가치 없음**: 모델 전환 시 컨텍스트 손실. 하나의 좋은 모델이 더 나음.
4. **비용 대비 효과**: 라우팅 로직 유지보수 비용 > 모델 비용 절감.

### 실행 결과

- **삭제**: `model-router.ts` (867줄), `model-router.test.ts` (476줄)
- **제거**: Google, DeepSeek 프로바이더 (types, constants, config, README)
- **유지**: YUA (메인, 자체서비스) + OpenAI (폴백, mini 기본) + Anthropic (키 생기면)
- **기본 모델**: YUA → yua-normal (NORMAL 티어), OpenAI → gpt-4o-mini
- **총 삭제**: ~1,400줄, 수정 ~40줄

---

## 3. Python Client 아키텍처 방향

### 현재 구조

```
yuan-cli (TypeScript, Ink TUI)
  └→ agent-bridge.ts
      └→ @yuaone/core AgentLoop (TypeScript)
          └→ @yuaone/tools ToolExecutor (TypeScript)
              └→ 10개 내장 도구
```

모든 게 TypeScript 모노리스. CLI ↔ Core ↔ Tools 전부 in-process.

### 제안 구조: Python Client + TS Core Server

```
yuan (Python CLI client)
  └→ HTTP/WebSocket → yuan-core-server (TS, 기존 코드 재사용)
                          └→ AgentLoop + Tools (TS, 이미 구현됨)

OR

yuan (Python, 독립)
  └→ LLM API 직접 호출
  └→ Python 도구 구현 (subprocess, pathlib 등)
```

### Option A: Python Thin Client + TS Server (권장)

**장점**:
- 기존 TS 코드 (AgentLoop, Tools, ContextManager) 재사용
- Python은 CLI UX만 담당 (prompt_toolkit, rich 등)
- 서버 API 이미 일부 존재 (yua-backend)

**단점**:
- 두 런타임 (Python + Node) 필요
- 로컬 실행 시 서버 프로세스 관리 필요

### Option B: Full Python Rewrite

**장점**:
- 단일 런타임
- Python 생태계 (click, rich, textual, httpx)
- LLM SDK 성숙도 높음 (anthropic, openai 라이브러리)

**단점**:
- AgentLoop, ContextManager, Governor 등 전부 재구현
- 1만줄+ 재작성

### Option C: Python Client → REST API (하이브리드, 최종 권장)

```
packages/
  yuan-client/          ← Python 패키지 (pip install yuan)
    yuan/
      __init__.py
      client.py         ← YuanClient class (REST/WebSocket)
      cli.py            ← Click/Typer CLI
      tui.py            ← Textual TUI (선택)
      commands/         ← 슬래시 커맨드 핸들러
        __init__.py
        help.py
        diff.py
        undo.py
        plan.py
        mode.py
        ...

  yuan-core/            ← 기존 TS (AgentLoop, Tools)
  yuan-backend/         ← 기존 TS (REST API 서버)
```

**핵심**: Python은 **프레젠테이션 레이어**만. 핵심 로직은 TS 서버.

---

## 4. 구현 우선순위

### Phase 0: 긴급 수정 (지금 즉시)

| # | 작업 | 파일 | 난이도 |
|---|------|------|--------|
| 0.1 | OpenAI 400 에러 수정 (validateAndFeedback 순서) | agent-loop.ts | **DONE** |
| 0.2 | context-manager 압축 시 tool_calls 메시지 보호 | context-manager.ts | **DONE** |
| 0.3 | 버전 하드코딩 수정 (동적 버전) | cli.ts | **DONE** (이전 세션) |
| 0.4 | Promise.race 메모리 릭 | world-state.ts | **DONE** (이전 세션) |
| 0.5 | EventEmitter 메모리 릭 | agent-bridge.ts | **DONE** (이전 세션) |

### Phase 1: 기존 커맨드 전부 동작시키기 (TS, 1-2일)

TUI 모드 기준 — 유저가 주로 쓰는 모드.

| # | 작업 | 상태 | 설명 |
|---|------|------|------|
| 1.1 | `/undo` TUI 핸들러 | STUB→구현 | git checkout -- 또는 백업 복원 |
| 1.2 | `/session` TUI 핸들러 | STUB→구현 | 세션 ID, 시간, 메시지수, 토큰 |
| 1.3 | `/config` TUI 핸들러 | STUB→구현 | 현재 설정 표시 |
| 1.4 | `/model` TUI+Interactive 핸들러 | 미구현→구현 | 모델 변경 (bridge 재초기화) |
| 1.5 | `/status` Interactive 핸들러 | STUB→구현 | TUI 로직 포팅 |
| 1.6 | `/settings` Interactive 핸들러 | STUB→구현 | TUI 로직 포팅 |
| 1.7 | 커맨드 통합 디스패처 | 신규 | TUI/Interactive 공통 핸들러 추출 |

### Phase 2: 신규 커맨드 추가 (TS, 2-3일)

| # | 커맨드 | 설명 | 연동 대상 |
|---|--------|------|----------|
| 2.1 | `/mode <name>` | 에이전트 모드 전환 (8개) | AgentLoop.config.mode |
| 2.2 | `/plan` | 현재 계획 조회/진행률 | HierarchicalPlanner |
| 2.3 | `/approve` / `/reject` | 승인 대기 작업 처리 | ApprovalManager |
| 2.4 | `/retry` | 마지막 실패 작업 재시도 | FailureRecovery |
| 2.5 | `/cost` | 토큰/비용 실시간 조회 | CostOptimizer |
| 2.6 | `/memory` | YUAN.md 학습 내용 조회 | MemoryManager |
| 2.7 | `/tools` | 사용 가능 도구 + 사용 통계 | ToolRegistry |

### Phase 3: 멀티모델 정리 (TS, 1일)

| # | 작업 | 줄 수 |
|---|------|-------|
| 3.1 | `model-router.ts` 삭제 | -867줄 |
| 3.2 | `llm-client.ts` Google/DeepSeek 컨버터 제거 | -300줄 |
| 3.3 | `constants.ts` 불필요 프로바이더 URL 제거 | -20줄 |
| 3.4 | 백엔드 하드코딩 모델 → config 기반으로 변경 | 수정 |
| 3.5 | 프로바이더 2개만 유지: Anthropic (네이티브) + OpenAI-compatible | 정리 |

### Phase 4: Python Client (새 패키지, 1-2주)

| # | 작업 | 설명 |
|---|------|------|
| 4.1 | `yuan-client/` Python 패키지 스캐폴딩 | pyproject.toml, 구조 |
| 4.2 | `YuanClient` class | REST API 클라이언트 (httpx) |
| 4.3 | SSE 스트리밍 수신 | agent 이벤트 실시간 수신 |
| 4.4 | CLI (click/typer) | `yuan chat`, `yuan run`, `yuan config` |
| 4.5 | 슬래시 커맨드 프레임워크 | 통합 디스패처 + 플러그인 구조 |
| 4.6 | TUI (textual, 선택사항) | 풀스크린 터미널 UI |
| 4.7 | yuan-backend API 확장 | 부족한 엔드포인트 추가 |

### Phase 5: 도구 확장 (TS core, 1주)

| # | 도구 | 설명 |
|---|------|------|
| 5.1 | `web_fetch` | URL 읽기 (docs, API 참조) |
| 5.2 | `file_list` | 디렉토리 트리 조회 |
| 5.3 | `patch_apply` | unified diff 적용 |
| 5.4 | `task_manager` | 내부 TODO 관리 |

---

## 5. 커맨드 통합 디스패처 설계

현재 문제: TUI와 Interactive가 각각 커맨드를 따로 구현.

```typescript
// 제안: packages/yuan-cli/src/commands/index.ts

export interface CommandContext {
    bridge: AgentBridge;
    config: ConfigManager;
    session: SessionManager;
    output: (msg: string) => void;  // TUI: addSystemMessage, Interactive: console.log
}

export interface CommandResult {
    output?: string;      // 표시할 메시지
    exit?: boolean;       // 종료 여부
    clear?: boolean;      // 화면 클리어
}

export type CommandHandler = (ctx: CommandContext, args: string[]) => Promise<CommandResult>;

// 각 커맨드 파일
// commands/help.ts → export const help: CommandHandler = ...
// commands/undo.ts → export const undo: CommandHandler = ...
// commands/mode.ts → export const mode: CommandHandler = ...

// 통합 레지스트리
export const COMMANDS: Record<string, CommandHandler> = {
    help, clear, exit, diff, undo, session, config, model,
    status, settings, mode, plan, approve, reject, retry,
    cost, memory, tools,
};
```

TUI의 `handleSlashCommand`와 Interactive의 `handleSlashCommand` 모두
이 통합 디스패처를 호출. **한 번만 구현, 양쪽에서 동작.**

---

## 6. Python Client API 설계 (초안)

```python
# yuan-client/yuan/client.py

class YuanClient:
    """YUAN Agent REST/SSE Client"""

    def __init__(self, base_url: str = "http://localhost:3001"):
        self.base_url = base_url
        self.session_id: str | None = None

    async def create_session(self, project_path: str, **kwargs) -> Session:
        """POST /api/yuan/session"""

    async def send_message(self, message: str) -> AsyncIterator[AgentEvent]:
        """POST /api/yuan/session/{id}/message → SSE stream"""

    async def interrupt(self) -> None:
        """POST /api/yuan/session/{id}/interrupt"""

    async def get_status(self) -> SessionStatus:
        """GET /api/yuan/session/{id}/status"""

    async def execute_command(self, command: str, args: list[str]) -> CommandResult:
        """POST /api/yuan/session/{id}/command"""

    async def approve(self, request_id: str, decision: str) -> None:
        """POST /api/yuan/session/{id}/approve"""
```

```python
# yuan-client/yuan/cli.py

@app.command()
def chat(prompt: str = typer.Argument(None)):
    """Interactive chat or one-shot execution"""

@app.command()
def run(prompt: str):
    """One-shot task execution"""

@app.command()
def config(action: str = "show"):
    """Configuration management"""
```

---

## 7. 결정 필요 사항

| # | 질문 | 옵션 | 추천 |
|---|------|------|------|
| 1 | Python client 프레임워크 | click / typer / argparse | **typer** (타입힌트 기반) |
| 2 | Python TUI | textual / prompt_toolkit / 없음 | **textual** (모던, 위젯) |
| 3 | 프로바이더 유지 범위 | Anthropic만 / +OpenAI호환 / 전부 | **Anthropic + OpenAI호환** |
| 4 | 커맨드 통합 시점 | Phase 1에서 / Phase 4에서 | **Phase 1** (TS 먼저 정리) |
| 5 | yuan-backend API 확장 | 기존 확장 / 새로 설계 | **기존 확장** (호환성) |

---

## 8. 요약: 한 줄 방향

> **TS core는 서버(엔진)로 유지, 멀티라우팅 제거, 커맨드 통합 디스패처로 기존 전부 살리고,
> Python thin client가 REST/SSE로 호출하는 구조.**

```
[Python CLI/TUI]  ←REST/SSE→  [TS Backend]  →  [AgentLoop + Tools]
    (프레젠테이션)                (API 서버)        (핵심 엔진)
```
