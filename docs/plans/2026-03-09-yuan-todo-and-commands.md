# YUAN — TODO 리스트 & 커맨드 SSOT

> 2026-03-09 | 전체 정리 + Claude Code 스타일 커맨드 매핑
> 2026-03-10 | Intelligence audit 반영, 통합 디스패처 완료, Phase 6 추가

---

## 1. 슬래시 커맨드 SSOT (목표: Claude Code 급)

### 현재 상태 vs 목표

| 커맨드 | Claude Code | YUAN TUI | YUAN Classic | 상태 | 우선순위 |
|--------|:-----------:|:--------:|:------------:|------|:--------:|
| `/help` | ✅ | ✅ | ✅ | **동작** | — |
| `/clear` | ✅ | ✅ | ✅ | **동작** | — |
| `/exit` `/quit` `/q` | ✅ | ✅ | ✅ | **동작** | — |
| `/diff` | ✅ | ✅ | ✅ | **동작** (ctx=5) | — |
| `/status` | ✅ | ✅ | ✅ | **동작** | — |
| `/settings` | ✅ | ✅ | ✅ | **동작** | — |
| `/undo` | ✅ | ✅ | ✅ | **동작** | — |
| `/config` | ✅ | ✅ | ✅ | **동작** | — |
| `/session` | ✅ | ✅ | ✅ | **동작** | — |
| `/model` | ✅ | ✅ | ✅ | **동작** | — |
| `/mode` | ✅ | ✅ | ✅ | **동작** | — |
| `/cost` | ✅ | ✅ | ✅ | **동작** | — |
| `/plan` | — | ✅ | ✅ | **동작** | — |
| `/approve` | — | ✅ | ✅ | **동작** | — |
| `/reject` | — | ✅ | ✅ | **동작** | — |
| `/retry` | — | ✅ | ✅ | **동작** | — |
| `/memory` | — | ✅ | ✅ | **동작** | — |
| `/tools` | — | ✅ | ✅ | **동작** | — |
| `/compact` | ✅ | ✅ | ✅ | **동작** | — |
| `/login` | ✅ | ❌ | ❌ | CLI만 존재 | P3 |

### 전체 커맨드 스펙 (Claude Code 참고)

#### 코어 (P1 — 반드시 동작해야 함)

| 커맨드 | 설명 | 구현 위치 |
|--------|------|-----------|
| `/help` | 사용 가능한 커맨드 목록 표시 | 통합 디스패처 |
| `/clear` | 대화 히스토리 초기화 | 통합 디스패처 |
| `/exit` | 종료 (aliases: /quit, /q) | 통합 디스패처 |
| `/diff` | 현재 세션에서 변경된 파일 diff 표시 | 통합 디스패처 |
| `/undo` | 마지막 파일 변경 되돌리기 (git checkout / 백업 복원) | 통합 디스패처 |
| `/status` | 프로바이더, 모델, 토큰 사용량, 세션 정보 | 통합 디스패처 |
| `/config` | 현재 설정 표시 (provider, model, mode 등) | 통합 디스패처 |
| `/session` | 세션 ID, 생성시각, 메시지 수, 작업 디렉토리 | 통합 디스패처 |
| `/model [name]` | 모델 변경 (yua-basic/normal/pro/research, gpt-4o-mini 등) | 통합 디스패처 → bridge 재초기화 |
| `/mode [name]` | 에이전트 모드 전환 (code/review/security/debug/refactor/test/plan/architect/report) | 통합 디스패처 → AgentLoop.config.mode |

#### 확장 (P2 — 있으면 좋음)

| 커맨드 | 설명 | 구현 위치 |
|--------|------|-----------|
| `/cost` | 현재 세션 토큰 비용 실시간 조회 | CostOptimizer |
| `/plan` | 현재 계획 조회 / 진행률 표시 | HierarchicalPlanner |
| `/approve` | 대기 중인 승인 요청 승인 | ApprovalManager |
| `/reject` | 대기 중인 승인 요청 거부 | ApprovalManager |
| `/settings` | 자동업데이트 등 환경설정 변경 | ConfigManager |
| `/compact` | 컨텍스트 수동 압축 | ContextManager.compactHistory() |

#### 고급 (P3 — 나중에)

| 커맨드 | 설명 | 구현 위치 |
|--------|------|-----------|
| `/retry` | 마지막 실패 작업 재시도 | FailureRecovery |
| `/memory` | YUAN.md 학습 내용 조회/편집 | MemoryManager |
| `/tools` | 사용 가능 도구 목록 + 사용 통계 | ToolRegistry |
| `/login` | YUA Platform 인증 | CLI auth |
| `/context` | 컨텍스트 윈도우 사용량 표시 | ContextManager |
| `/benchmark` | 벤치마크 결과 조회 | BenchmarkRunner |

---

## 2. 에이전트 모드 SSOT (9개)

| 모드 | 설명 | 도구 권한 | 쓰기 | 실행 |
|------|------|-----------|:----:|:----:|
| `code` | 코딩 (기본값) | 전체 | ✅ | ✅ |
| `review` | 코드 리뷰 | 읽기전용+git | ❌ | ❌ |
| `security` | 보안 감사 | 읽기전용 | ❌ | ❌ |
| `debug` | 디버깅 | 전체 | ✅ | ✅ |
| `refactor` | 리팩토링 | 전체 | ✅ | ✅ |
| `test` | 테스트 생성/실행 | 전체 | ✅ | ✅ |
| `plan` | 태스크 기획 | 읽기전용 | ❌ | ❌ |
| `architect` | 아키텍처 분석 | 읽기전용 | ❌ | ❌ |
| `report` | 분석 리포트 | 읽기전용 | ❌ | ❌ |

---

## 3. YUA 모델 티어 SSOT (4개)

| 모델명 | ChatMode | 백엔드 엔진 | 용도 |
|--------|----------|-------------|------|
| `yua-basic` | FAST | gpt-5-mini | 저비용, 빠른 응답 |
| `yua-normal` | NORMAL | gpt-5.2-chat-latest | 범용 (기본값) |
| `yua-pro` | DEEP | gpt-5.2 | 고품질, reasoning |
| `yua-research` | RESEARCH | gpt-5.2-chat-latest | 심층 리서치 |

---

## 4. TODO 리스트 (우선순위 순)

### Batch A — 통합 커맨드 디스패처 (최우선) — DONE

> 통합 디스패처 구현 완료 (18 commands). FooterBar moved above input, exitTUI cleanup.

| # | 작업 | 파일 | 상태 |
|---|------|------|------|
| A.1 | 통합 CommandDispatcher 인터페이스 정의 | `yuan-cli/src/commands/index.ts` | DONE |
| A.2 | 기존 TUI 핸들러 → 디스패처로 이전 | `yuan-cli/src/tui/App.tsx` | DONE |
| A.3 | 기존 Classic 핸들러 → 디스패처로 이전 | `yuan-cli/src/interactive.ts` | DONE |
| A.4 | `/undo` TUI 핸들러 구현 | `commands/undo.ts` | DONE |
| A.5 | `/session` TUI 핸들러 구현 | `commands/session.ts` | DONE |
| A.6 | `/config` TUI 핸들러 구현 | `commands/config.ts` | DONE |
| A.7 | `/status` Classic 핸들러 구현 | `commands/status.ts` | DONE |
| A.8 | `/model` 양쪽 구현 (bridge 재초기화) | `commands/model.ts` | DONE |
| A.9 | `/mode` 양쪽 구현 (모드 전환) | `commands/mode.ts` | DONE |

### Batch B — 신규 커맨드 (P2)

| # | 작업 | 의존성 |
|---|------|--------|
| B.1 | `/cost` — 토큰/비용 표시 | CostOptimizer |
| B.2 | `/plan` — 계획 조회/진행률 | HierarchicalPlanner |
| B.3 | `/approve` + `/reject` — 승인 흐름 | ApprovalManager |
| B.4 | `/settings` Classic 구현 | ConfigManager |
| B.5 | `/compact` — 수동 컨텍스트 압축 | ContextManager |

### Batch C — 백엔드 정합성 (P1)

| # | 작업 | 파일 |
|---|------|------|
| C.1 | `yua-spine` 레거시 참조 정리 완료 확인 | 전체 grep |
| C.2 | 모델 기본값 `yua-normal` 반영 확인 | v1-completions, yuan-llm, api-keys |
| C.3 | yua-platform docs 페이지 `yua-spine` → `yua-research` | yua-platform |
| C.4 | DB 마이그레이션 (agent_sessions, agent_iterations) | Prisma schema |
| C.5 | 인메모리 세션 → PostgreSQL 영속화 | session-repository.ts |

### Batch D — 문서 정리 (P1)

| # | 작업 | 파일 |
|---|------|------|
| D.1 | README.md 최종 검수 | yuan/README.md |
| D.2 | YUAN_CODING_AGENT_DESIGN.md 모델 정보 업데이트 | docs/ |
| D.3 | architecture-direction.md 완료 항목 체크 | docs/plans/ |
| D.4 | CLAUDE.md 태스크 큐 현행화 | 루트 CLAUDE.md |
| D.5 | yua-backend/CLAUDE.md 모델 매핑 반영 | yua-backend/CLAUDE.md |

### Batch E — 고급 기능 (P3)

| # | 작업 |
|---|------|
| E.1 | `/retry` — 실패 재시도 |
| E.2 | `/memory` — YUAN.md 학습 조회 |
| E.3 | `/tools` — 도구 목록/통계 |
| E.4 | `/context` — 컨텍스트 윈도우 사용량 |
| E.5 | Python thin client 스캐폴딩 |
| E.6 | E2E 통합 테스트 |

### Batch F — Phase 6: Plugin/Skill System + Intelligence Gaps (P2)

> Intelligence audit (2026-03-10) 결과 PARTIAL 2개 + source missing 1개 해결.

| # | 작업 | 상태 |
|---|------|------|
| F.1 | Skill System: `.skill` 파일 포맷 정의 | TODO |
| F.2 | Skill System: Skill Registry + discovery | TODO |
| F.3 | Plugin System: 아키텍처 설계 + 구현 | TODO |
| F.4 | Prompt Caching: Anthropic `cache_control` 헤더 네이티브 통합 | TODO |
| F.5 | `model-router.ts` 소스 복구 (현재 compiled .js만 존재) | TODO |

---

## 5. 커맨드 통합 디스패처 설계

```typescript
// packages/yuan-cli/src/commands/index.ts

export interface CommandContext {
  bridge: AgentBridge;
  config: ConfigManager;
  session: SessionManager;
  output: (msg: string) => void;  // TUI: addSystemMessage, Classic: console.log
}

export interface CommandResult {
  output?: string;
  exit?: boolean;
  clear?: boolean;
}

export type CommandHandler = (ctx: CommandContext, args: string[]) => Promise<CommandResult>;

export const COMMANDS: Record<string, CommandHandler> = {
  // Core (P1)
  help, clear, exit, diff, undo, status, config, session, model, mode,
  // Extended (P2)
  cost, plan, approve, reject, settings, compact,
  // Advanced (P3)
  retry, memory, tools, context,
};

// Aliases
export const ALIASES: Record<string, string> = {
  quit: "exit",
  q: "exit",
  h: "help",
};
```

**TUI:** `App.tsx` → `COMMANDS[cmd](ctx, args)`
**Classic:** `interactive.ts` → `COMMANDS[cmd](ctx, args)`

한 번 구현, 양쪽 동작. 테스트도 디스패처 단위로.

---

## 6. 프로바이더 SSOT (3개만)

| Provider | 기본 모델 | Base URL | 비고 |
|----------|-----------|----------|------|
| YUA | yua-normal | yuaone.com/api/v1 | 셀프호스팅, OpenAI 호환 |
| OpenAI | gpt-4o-mini | api.openai.com/v1 | BYOK |
| Anthropic | claude-sonnet-4 | api.anthropic.com | BYOK |

삭제됨: Google, DeepSeek, Local LLM (~1,400줄 제거 완료)

---

## 7. 백엔드 API 엔드포인트 SSOT

### YUAN Agent (`/api/yuan-agent`)

| Method | Path | 설명 | 상태 |
|--------|------|------|------|
| POST | `/run` | 에이전트 실행 시작 | ✅ |
| GET | `/stream` | SSE 스트리밍 | ✅ |
| POST | `/approve` | 승인/거부 | ✅ |
| GET | `/sessions` | 세션 목록 | ✅ |
| GET | `/session/:id` | 세션 상세 | ✅ |
| POST | `/stop` | 실행 중지 | ✅ |
| POST | `/interrupt` | 인터럽트 (soft/hard/pause/resume) | ✅ |
| GET | `/status` | 상세 상태 (토큰, 레이트) | ✅ |
| POST | `/team/join` | 옵저버 참여 | ✅ |
| POST | `/team/feedback` | 피드백 주입 | ✅ |
| GET | `/team/members` | 옵저버 목록 | ✅ |

### YUAN LLM (`/api/yuan-agent/llm`)

| Method | Path | 설명 | 상태 |
|--------|------|------|------|
| POST | `/chat` | Stateless LLM 호출 (3 provider) | ✅ |

---

## 8. 내장 도구 SSOT (16개)

### 코어 도구 (10개) — 항상 사용 가능

| # | 도구명 | 설명 | 위험도 | 상태 |
|---|--------|------|:------:|:----:|
| 1 | `file_read` | 파일 읽기 (offset/limit, 50KB 제한) | low | ✅ |
| 2 | `file_write` | 파일 쓰기 (자동 백업, 10MB 제한) | high | ✅ |
| 3 | `file_edit` | 문자열 치환 (diff 프리뷰, fuzzy 제안) | medium | ✅ |
| 4 | `grep` | 정규식 파일 검색 (max 100 결과) | low | ✅ |
| 5 | `glob` | 패턴 기반 파일 찾기 (max 100 결과) | low | ✅ |
| 6 | `code_search` | 심볼 검색 (definition/reference/symbol) | low | ✅ |
| 7 | `git_ops` | Git 작업 (status/diff/log/add/commit/branch/stash/restore) | medium | ✅ |
| 8 | `shell_exec` | 명령어 실행 (execFile, 셸 인젝션 차단) | critical | ✅ |
| 9 | `test_run` | 테스트 실행 (jest/vitest/pytest 자동감지) | medium | ✅ |
| 10 | `security_scan` | OWASP 감사 + 시크릿 탐지 + 의존성 감사 | low | ✅ |

### 디자인 도구 (6개) — Design Mode에서만 활성

| # | 도구명 | 설명 | 상태 |
|---|--------|------|:----:|
| 11 | `design_snapshot` | DOM 접근성 트리 추출 | ✅ |
| 12 | `design_screenshot` | 페이지 스크린샷 (base64 PNG) | ✅ |
| 13 | `design_navigate` | 브라우저 네비게이션 (localhost만) | ✅ |
| 14 | `design_resize` | 뷰포트 크기 변경 | ✅ |
| 15 | `design_inspect` | Computed CSS 스타일 조회 | ✅ |
| 16 | `design_scroll` | 엘리먼트/위치로 스크롤 | ✅ |

### 계획된 도구 (미구현)

| 도구명 | 설명 | Phase |
|--------|------|:-----:|
| `web_fetch` | URL 읽기 (docs, API 참조) | P3 |
| `db_query` | DB 쿼리 실행 | P3 |
| `api_call` | HTTP API 호출 (인증 포함) | P3 |
| `docker_exec` | 컨테이너 실행 | P3 |
| `embed_search` | 임베딩 기반 시맨틱 검색 | P3 |

### 보안 제약 요약

| 카테고리 | 제약 |
|----------|------|
| 셸 실행 | execFile만 (no shell=true), 메타문자 차단, 위험 명령 블록 |
| 경로 | 심링크 TOCTOU 방어 (O_NOFOLLOW), 경로 순회 차단 |
| 민감 파일 | .env*, *secret*, *credentials*, *.key, *.pem 블록 |
| 환경변수 | PATH, LD_PRELOAD, NODE_OPTIONS 등 오버라이드 차단 |
| 출력 제한 | file_read 50KB, shell_exec 100KB, grep 100결과, 전체 50KB 트렁케이션 |
| 타임아웃 | shell 30s, test 60s, git 15s, browser eval 5s |

---

## 9. 에이전트 모드 상세 (9개)

| 모드 | 도구 | 쓰기 | 실행 | 자동승인 | 출력 | 용도 |
|------|------|:----:|:----:|:--------:|------|------|
| **code** | 전체 | ✅ | ✅ | safe_writes | streaming | 자율 코딩 (기본값) |
| **review** | 읽기+git | ❌ | ❌ | reads | checklist | 코드 리뷰 |
| **security** | 읽기+shell | ❌ | ✅ | reads | report | OWASP 감사 |
| **debug** | 전체 | ✅ | ✅ | reads | streaming | 디버깅 |
| **refactor** | 전체 | ✅ | ✅ | safe_writes | diff | 리팩토링 |
| **test** | 전체 | ✅ | ✅ | safe_writes | streaming | 테스트 생성/실행 |
| **plan** | 읽기만 | ❌ | ❌ | reads | report | 태스크 기획 |
| **architect** | 읽기만 | ❌ | ❌ | reads | report | 아키텍처 분석 |
| **report** | 읽기만 | ❌ | ❌ | reads | report | 분석 리포트 |

---

## 10. QA 검증 결과 (2026-03-09)

| # | 체크 항목 | 결과 | 비고 |
|---|----------|:----:|------|
| 1 | 모델명 SSOT (basic/normal/pro/research) | ✅ PASS | 코드/라우터에 yua-spine 없음 |
| 2 | `yua-spine` 레거시 참조 제거 | ✅ PASS | Spine 엔진 코드(.ts)는 유지 |
| 3 | 기본 모델 = `yua-normal` 전체 일치 | ✅ PASS | yuan-llm-router 수정 완료 |
| 4 | 프로바이더 3개만 (yua/openai/anthropic) | ✅ PASS | YUAN.md 수정 완료 |
| 5 | README 모델 티어 테이블 | ✅ PASS | 4행 (basic/normal/pro/research) |
| 6 | ChatMode 매핑 정확성 (4곳) | ✅ PASS | v1-completions(3) + yuan-llm(1) |
| 7 | README 프로바이더 테이블 | ✅ PASS | 3행 (YUA/OpenAI/Anthropic) |
| 8 | 문서 간 모델/프로바이더 불일치 | ✅ PASS | YUAN.md Google/DeepSeek 제거 완료 |

### 수정된 위반 사항
1. ~~`yuan-llm-router.ts:127` — 기본 모델 `yua-pro` → `yua-normal` 수정~~
2. ~~`YUAN.md:34` — Google, DeepSeek 프로바이더 참조 제거~~
