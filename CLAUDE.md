# YUAN Coding Agent — CLAUDE SSOT

## 🚨 절대 규칙
- **pnpm install을 루트(`/home/dmsal020813/projects/`)에서 절대 실행 금지**
- pnpm install은 반드시 `/home/dmsal020813/projects/yuan/` 안에서만 실행
- 전역 pnpm 설치/업데이트 금지 — `packageManager: pnpm@10.26.2` 사용
- 상위 디렉토리(`/home/dmsal020813/projects/`)의 파일을 수정하지 마세요

## 프로젝트 개요
- **이름**: YUAN (Autonomous Coding Agent)
- **포지션**: Autonomous Coding Agent (Devin/Claude Code 카테고리)
- **전략**: Open Core (Community = 무료 CLI + BYOK, Pro = 유료 SaaS)
- **라이선스**: AGPL-3.0
- **설계 문서**: /home/dmsal020813/projects/docs/YUAN_CODING_AGENT_DESIGN.md

## 모노레포 구조
```
yuan/
├── packages/
│   ├── yuan-core/    # 에이전트 런타임 (Agent Loop, Governor, Planner)
│   ├── yuan-tools/   # 도구 구현 (file_read, file_write, shell_exec 등)
│   └── yuan-cli/     # CLI 진입점 (npx yuan)
```

## 패키지 매니저
- pnpm workspace (pnpm-workspace.yaml)
- 설치: `cd /home/dmsal020813/projects/yuan && pnpm install`
- 패키지별: `pnpm --filter @yuan/core add <dep>`

## 구현 순서 (Phase 1a — 코어)

### Batch 1: 타입 & 인터페이스 (@yuan/core)
1. `src/types.ts` — AgentConfig, ToolResult, Message, BYOKConfig 등 전체 타입
2. `src/errors.ts` — YuanError, ToolError, SandboxError 등
3. `src/constants.ts` — 플랜별 제한, 도구 목록, 모델 매핑
4. `src/index.ts` — 전체 export

### Batch 2: 도구 구현 (@yuan/tools) — 코어 5개
5. `src/base-tool.ts` — BaseTool 추상 클래스
6. `src/file-read.ts` — file_read 도구
7. `src/file-write.ts` — file_write 도구
8. `src/file-edit.ts` — file_edit 도구 (diff 기반)
9. `src/shell-exec.ts` — shell_exec 도구 (execFile, 메타문자 검증)
10. `src/grep.ts` — grep 도구
11. `src/index.ts` — 전체 export

### Batch 3: Agent Loop (@yuan/core)
12. `src/agent-loop.ts` — 메인 Agent Loop (LLM ↔ Tool 반복)
13. `src/planner.ts` — 작업 계획 수립
14. `src/governor.ts` — 실행 제한/안전 검증
15. `src/context-manager.ts` — 컨텍스트 윈도우 관리
16. `src/memory.ts` — YUAN.md 읽기/쓰기

### Batch 4: CLI (@yuan/cli)
17. `src/cli.ts` — 메인 CLI 진입점 (commander 기반)
18. `src/config.ts` — BYOK 키 설정/저장 (~/.yuan/config.json)
19. `src/renderer.ts` — 터미널 출력 렌더러 (chalk 기반)
20. `src/diff-renderer.ts` — 터미널 Diff Viewer (green/red)

## 코딩 규칙
- TypeScript strict mode
- ESM (type: "module")
- 모든 공개 함수에 JSDoc
- 에러는 YuanError 계열 사용
- LLM 호출은 BYOK 키로 직접 호출 (서버 경유 X)
- 도구 실행은 로컬 파일시스템 직접 접근

## 금지사항
- npm install, yarn add 사용 금지
- 상위 디렉토리 파일 수정 금지
- lockfile 임의 재생성 금지
- 전역 도구 설치/업데이트 금지
