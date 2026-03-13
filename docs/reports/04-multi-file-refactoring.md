# 멀티파일 리팩토링 — 검증 리포트

> 검증일: 2026-03-13 | 검증 에이전트: Explore (Haiku 4.5)

---

## 판정: ⚠️ 분석 인프라는 실제 작동, 실행은 LLM 의존 + 순차적

---

## 모듈별 실제 구현

### CrossFileRefactor (cross-file-refactor.ts) ✅ 구현됨, ❌ agent-loop 미연결
- **파일:** `packages/yuan-core/src/cross-file-refactor.ts` (1983줄)
- **기능 목록 (모두 정규식 기반):**
  - `renameSymbol()` (line 397) — 전체 프로젝트 심볼 이름 변경
  - `moveSymbol()` (line 518) — 심볼 다른 파일로 이동 + import 자동 수정
  - `extractFunction()` (line 679) — 함수 추출
  - `extractInterface()` (line 853) — 인터페이스 추출
  - `inlineFunction()` (line 965) — 함수 인라인화
  - `changeSignature()` (line 1104) — 함수 시그니처 변경
  - `findAllUsages()` (line 1301) — 전체 프로젝트 심볼 사용처 탐색
  - `rollback()` (line 366) — 변경사항 원자적 롤백
- **⚠️ 정규식 한계:**
  - 주석 내 심볼 false positive 가능
  - 문자열 리터럴 내 심볼 감지 naive
  - 타입 전용 import 구분 불가
- **⚠️ 미연결:** index.ts export만, agent-loop에서 import 안 함

### ImpactAnalyzer (impact-analyzer.ts) ✅ 실제 연결됨
- **파일:** `packages/yuan-core/src/impact-analyzer.ts`
- **agent-loop 연결:**
  - 파일 수정 후마다 `analyzeFileImpact()` 비동기 호출 (line 2488)
  - 2개+ 파일 변경 시 집합 영향 분석 주입 (line 2916)
  - 종료 시 최종 영향 요약 (line 2971)
- **실제 기능:**
  - BFS 기반 영향 파일 탐색 (line 368) — 역방향 import 그래프
  - Breaking change 감지 (line 572) — git diff 파싱
    - 제거된 export, 함수 시그니처 변경, export 이름 변경
  - Tarjan SCC 순환 의존 감지 (line 1227)
  - 테스트 파일 추론 (`.test.ts`, `.spec.ts`, `__tests__/`)
  - Dead code 감지 (line 919)
- **그래프 구조:** `exportsByFile`, `reverseImports`, `symbolUsage`, `callGraph`

### DependencyAnalyzer (dependency-analyzer.ts) ✅ 구현됨, ❌ agent-loop 미연결
- **파일:** `packages/yuan-core/src/dependency-analyzer.ts`
- **ESM + CommonJS** import 파싱 모두 지원
- **독립 파일 그룹핑 `groupIndependentFiles()`** (line 150) — 병렬 실행 가능 태스크 식별
- **Tarjan 순환 감지** (line 284)
- **영리한 import 경로 해석:** .ts/.tsx 확장자 자동, index 파일 폴백
- **⚠️ 미연결:** agent-loop에서 import 안 함 (standalone 라이브러리)

### HierarchicalPlanner (hierarchical-planner.ts) ✅ 옵션으로 연결됨
- **파일:** `packages/yuan-core/src/hierarchical-planner.ts`
- **3단계 계획 분해:**
  - L1 전략: 사용자 목표 → 서브목표 (Flagship LLM)
  - L2 전술: 서브목표 → 파일별 태스크 (Premium LLM)
    - 각 TacticalTask에 `targetFiles[]`, `readFiles[]`, `dependsOn[]` 포함
  - L3 운영: 태스크 → 실제 tool call 계획 (Standard LLM)
- **병렬 그룹 식별:** `findParallelGroups()` (line 432)
- **Critical path 계산:** `findCriticalPath()` (line 433)
- **agent-loop 연결:** 복잡/대형 태스크일 때만 옵션 활성화 (line 1258)
  - `enablePlanning` config 필요 (기본값: 비활성)

---

## agent-loop 실행 방식 (현재)

```
멀티파일 태스크 수신
  ↓
(옵션) HierarchicalPlanner로 전술 계획 수립
  ↓
LLM이 tool call 생성 (file_read × N개 → file_edit × M개)
  ↓
executeTools() — for 루프로 순차 실행 (agent-loop.ts:2285)
  ↓
파일 수정 후 ImpactAnalyzer 비동기 실행
  ↓
영향 범위 보고서 → context 주입 → LLM이 다음 파일 처리
```

**핵심 문제:** `for (const toolCall of toolCalls)` — 병렬 없음

---

## Claude Code 비교

| 항목 | Claude Code | YUAN |
|------|-------------|------|
| 심볼 사용처 자동 탐색 | ✅ grep/glob 직접 | ✅ findAllUsages() 있음, 단 미연결 |
| 원자적 멀티파일 리팩토링 | ✅ | ❌ (파일 단위 tool call) |
| 의존성 순서 자동 정렬 | ✅ | ❌ (LLM 판단에 의존) |
| 병렬 실행 | ❌ | ❌ |
| 영향 분석 | ✅ (암묵적) | ✅ (명시적, ImpactAnalyzer) |
| Breaking change 감지 | ❌ | ✅ |
| 계획 수립 | 암묵적 | ✅ (HierarchicalPlanner, 옵션) |
| 빌드 자동 검증 | ✅ | ❌ (SelfDebugLoop만 있음) |

---

## 실제 버그 / 갭

| 항목 | 설명 | 심각도 |
|------|------|--------|
| CrossFileRefactor 미연결 | 심볼 추적 코드 있는데 agent-loop이 안 씀 | 고 |
| DependencyAnalyzer 미연결 | 독립 파일 그룹핑 코드 있는데 병렬화에 안 씀 | 고 |
| HierarchicalPlanner 기본 비활성 | 복잡한 태스크에도 기본으로 계획 안 세움 | 중 |
| 순차 tool 실행 | 읽기 전용 tool들도 순차 실행 | 중 |
| 빌드 검증 미자동화 | 멀티파일 수정 후 build 자동 실행 없음 | 고 |

---

## 수정 우선순위

| 순위 | 작업 | 난이도 |
|------|------|--------|
| 1 | 읽기 전용 tool (file_read/grep/glob) 병렬 실행 | 중 |
| 2 | HierarchicalPlanner 기본 활성화 (복잡도 임계값 기반) | 저 |
| 3 | CrossFileRefactor를 agent-loop의 rename/move 태스크에 연결 | 고 |
| 4 | DependencyAnalyzer로 파일 수정 순서 자동 정렬 | 고 |
| 5 | 멀티파일 수정 완료 후 tsc 자동 실행 | 중 |
