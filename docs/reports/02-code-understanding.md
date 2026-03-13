# 코드 이해도 — 검증 리포트

> 검증일: 2026-03-13 | 검증 에이전트: Explore (Haiku 4.5)

---

## 판정: ⚠️ 구조 분석은 실제 작동, 의미 이해는 정규식 한계

---

## 실제 작동하는 것 ✅

### CodebaseContext (오프라인, 완전 작동)
- **파일:** `packages/yuan-core/src/codebase-context.ts` (1757줄)
- **파싱 방식:** 정규식 기반 (ts-morph/AST 아님)
- **작동하는 기능:**
  - 심볼 테이블 인덱싱 (이름 → 심볼)
  - 콜 그래프 분석 `getCallChain()` (line 617)
  - 영향 범위 분석 `getImpactAnalysis()` (line 467)
  - 역방향 의존성 맵 (누가 이 파일을 import하는지)
  - 복잡도 메트릭: cyclomatic complexity (line 919)
  - 연관 파일 BFS 탐색 `getRelatedFiles()` (line 540)
  - 핫스팟 감지 (고복잡도 + 많은 의존파일)
- **외부 의존성 없음:** 완전 in-memory

### RepoKnowledgeGraph (오프라인, 완전 작동)
- **파일:** `packages/yuan-core/src/repo-knowledge-graph.ts` (746줄)
- **노드 타입:** file, class, function, variable, interface, type, module
- **엣지 타입:** imports, calls, extends, implements, depends_on, exports, contains
- **Tarjan SCC** 순환 의존 감지
- **디스크 영속성:** `.yuan/knowledge-graph.json`
- **Dead code 감지** `findDeadCode()` (line 245)

### LanguageSupport (오프라인, 완전 작동)
- **파일:** `packages/yuan-core/src/language-support.ts` (1424줄)
- **지원 언어 14개:** TS/JS(고), Python/Go/Rust/Java(중), C/C++/Ruby/PHP/Swift/Kotlin/Dart/Shell(저)
- **언어별:** build/test/lint 커맨드, 명명규칙, 패키지 파일 목록

### code_search 도구 (오프라인, 완전 작동)
- **파일:** `packages/yuan-tools/src/code-search.ts` (330줄)
- **모드:** symbol(정의 찾기) / reference(사용처 찾기) / definition
- **파일 탐색:** fast-glob 기반, TS/JS/Python 지원

---

## 외부 인프라 필요 ⚠️

### VectorIndex (PostgreSQL + 임베딩 모델 필요)
- **파일:** `packages/yuan-core/src/vector-index.ts` (926줄)
- **구현:** 실제 production 품질, pgvector HNSW 인덱스
- **필요 인프라:**
  1. PostgreSQL 14+ + `CREATE EXTENSION vector;`
  2. 임베딩 제공자 (OpenAI text-embedding-3-small 또는 Ollama 로컬)
- **연결 위치:** execution-engine.ts (옵션 모드에서만)
- **오프라인 불가:** 임베딩 생성이 항상 외부 API 호출

---

## Claude Code 비교

| 항목 | Claude Code | YUAN |
|------|-------------|------|
| 파싱 방식 | 모델 내장 의미 이해 | 정규식 기반 구조 분석 |
| 설정 없이 작동 | ✅ | ✅ (VectorIndex 제외) |
| 심볼 의미 이해 | ✅ (LLM이 이해) | ❌ (이름/패턴만) |
| 의존성 그래프 | ✅ (grep 기반) | ✅ (regex 기반, 더 구조화) |
| 복잡도 측정 | ❌ | ✅ (cyclomatic) |
| 벡터 시맨틱 검색 | ❌ | ✅ (단, PostgreSQL 필요) |
| Dead code 감지 | ❌ | ✅ |
| 14개 언어 지원 | 모델 내장 | ✅ (패턴 기반) |

---

## 수정 우선순위

| 순위 | 작업 | 난이도 |
|------|------|--------|
| 1 | VectorIndex 로컬 임베딩(Ollama) 기본 설정 추가 | 중 |
| 2 | ts-morph 도입으로 TS/JS AST 정확도 개선 | 고 |
| 3 | code_search → CodebaseContext 통합 (중복 제거) | 중 |
