# YUAN Plugin & Skill System — Implementation Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** YUAN에 플러그인/스킬 시스템을 추가하여 도메인별 전문 지능을 끼울 수 있게 한다.
Claude Code에 없는 차별화 포인트. 커뮤니티 기여 + 마켓플레이스 확장 가능.

**Architecture:** Plugin = Skill + Tools + Patterns + Validators + Strategies.
자동 감지(detect) → 자동 로드 → 트리거 매칭 → 전략 실행.
npm 배포 가능(`@yuaone/plugin-*`), 커뮤니티 제작 가능.

**Tech Stack:** TypeScript, YAML (plugin.yaml), JSON (patterns/strategies), Markdown (skills)

---

## 1. 핵심 개념

### Plugin vs Skill

```
Plugin = 패키지 (npm 배포 단위)
  ├── Skills    = 도메인 지식 + 전략 (가벼운 단위)
  ├── Tools     = 추가 도구 (optional)
  ├── Patterns  = 코드 패턴 라이브러리
  ├── Validators = 검증 룰
  └── Strategies = 문제유형 → 해결전략 매핑

Skill = Plugin 없이도 독립 사용 가능한 지식 단위
  ├── 전문 지식 (markdown)
  ├── 도구 시퀀스 추천
  ├── 알려진 함정들
  └── 검증 체크리스트
```

### 자동 감지 흐름

```
yuan 시작
  → 프로젝트 스캔 (package.json, tsconfig, Dockerfile, ...)
  → detect 조건 매칭
  → 해당 플러그인 자동 로드
  → 에러/작업 발생 시 trigger 매칭
  → skill + strategy 자동 적용
```

---

## 2. 파일 구조

### Plugin 패키지 구조

```
@yuaone/plugin-react/
├── plugin.yaml              ← 메타데이터 SSOT
├── skills/
│   ├── bugfix.md            ← React 버그 수정 전문 지식
│   ├── refactor.md          ← 컴포넌트 리팩토링 전략
│   ├── test.md              ← RTL/MSW 테스트 패턴
│   └── ssr.md               ← SSR/hydration 전문 지식
├── patterns/
│   ├── hooks.json           ← 자주 쓰는 hook 패턴
│   ├── components.json      ← 컴포넌트 패턴 (HOC, compound, render props)
│   └── anti-patterns.json   ← 피해야 할 패턴
├── strategies/
│   ├── hydration-fix.json   ← hydration error 해결 전략
│   ├── hook-loop-fix.json   ← useEffect 무한루프 해결
│   └── build-fix.json       ← 빌드 에러 해결 전략
├── validators/
│   └── rules.json           ← "useEffect deps 체크" 등 검증 룰
├── tools/                   ← (optional) 추가 도구
│   └── component-tree.ts    ← React 컴포넌트 트리 분석 도구
└── README.md
```

### Standalone Skill 구조 (플러그인 없이)

```
.yuan/skills/
├── my-project-conventions.md    ← 프로젝트별 컨벤션
├── debugging-notes.md           ← 디버깅 노트
└── custom-strategy.json         ← 커스텀 전략
```

---

## 3. plugin.yaml 스펙

```yaml
# @yuaone/plugin-react
name: "@yuaone/plugin-react"
version: "1.0.0"
description: "React/Next.js 전문 에이전트 스킬팩"
author: "yuaone"
license: "MIT"
yuan_version: ">=0.2.0"       # 최소 YUAN 버전

# 자동 감지 조건 — 하나라도 매칭되면 로드
detect:
  files:
    - "package.json"
  dependencies:
    - "react"
    - "react-dom"
  # 또는 파일 패턴
  glob:
    - "src/**/*.tsx"
    - "src/**/*.jsx"

# 스킬 목록
skills:
  - name: "bugfix"
    file: "skills/bugfix.md"
    tags: ["debug", "error", "fix"]
  - name: "refactor"
    file: "skills/refactor.md"
    tags: ["refactor", "clean", "split"]
  - name: "test"
    file: "skills/test.md"
    tags: ["test", "jest", "rtl"]
  - name: "ssr"
    file: "skills/ssr.md"
    tags: ["ssr", "hydration", "server"]

# 트리거 — 에러/작업 패턴 → skill+strategy 자동 매칭
triggers:
  - pattern: "hydration"
    skill: "ssr"
    strategy: "hydration-fix"
    priority: 10
  - pattern: "useEffect.*maximum update depth"
    skill: "bugfix"
    strategy: "hook-loop-fix"
    priority: 10
  - pattern: "Module not found"
    skill: "bugfix"
    strategy: "build-fix"
    priority: 5
  - pattern: "Cannot read properties of (null|undefined)"
    skill: "bugfix"
    priority: 3

# 추가 도구 (optional)
tools:
  - name: "component_tree"
    file: "tools/component-tree.ts"
    description: "React 컴포넌트 트리 분석"

# 전략 파일 목록
strategies:
  - "strategies/hydration-fix.json"
  - "strategies/hook-loop-fix.json"
  - "strategies/build-fix.json"

# 검증 룰
validators:
  - "validators/rules.json"

# 패턴 라이브러리
patterns:
  - "patterns/hooks.json"
  - "patterns/components.json"
  - "patterns/anti-patterns.json"

# 설정 (유저 오버라이드 가능)
config:
  auto_load: true              # 감지되면 자동 로드
  inject_into_prompt: true     # 시스템 프롬프트에 스킬 주입
  max_patterns_in_context: 5   # 컨텍스트에 넣을 최대 패턴 수
```

---

## 4. Skill 마크다운 스펙

```markdown
# React Bugfix Skill

## Identity
- domain: react
- type: bugfix
- confidence: 0.85

## Known Error Patterns

### Hydration Mismatch
- **증상**: "Text content does not match server-rendered HTML"
- **원인**: server/client 렌더링 불일치
- **전략**:
  1. `typeof window` 체크 → useEffect로 이동
  2. `suppressHydrationWarning` (임시)
  3. dynamic import with `ssr: false`
- **도구 시퀀스**: grep → file_read → file_edit → test_run
- **함정**: Date, Math.random, localStorage 직접 접근

### useEffect Infinite Loop
- **증상**: "Maximum update depth exceeded"
- **원인**: deps 배열에 매번 새 객체/배열
- **전략**:
  1. deps 배열 확인 — 객체/배열 reference 체크
  2. useMemo/useCallback으로 안정화
  3. useRef로 이전 값 비교
- **도구 시퀀스**: file_read → grep "useEffect" → file_edit
- **함정**: ESLint exhaustive-deps 무시하면 안 됨

## Validation Checklist
- [ ] 수정 후 `pnpm build` 통과
- [ ] hydration warning 0개
- [ ] 기존 테스트 통과
- [ ] SSR/CSR 양쪽에서 동작 확인
```

---

## 5. Strategy JSON 스펙

```json
{
  "name": "hydration-fix",
  "description": "React hydration mismatch 해결 전략",
  "problem_class": "hydration_error",
  "steps": [
    {
      "action": "grep",
      "args": { "pattern": "hydration|useEffect|useState", "glob": "**/*.tsx" },
      "purpose": "서버/클라이언트 분기점 찾기"
    },
    {
      "action": "file_read",
      "args": { "target": "${matched_file}" },
      "purpose": "문제 코드 확인"
    },
    {
      "action": "analyze",
      "check": "window/document/localStorage 직접 접근 여부",
      "purpose": "CSR-only 코드 식별"
    },
    {
      "action": "file_edit",
      "template": "useEffect(() => { /* CSR-only code */ }, [])",
      "purpose": "클라이언트 전용 코드를 useEffect로 이동"
    },
    {
      "action": "test_run",
      "purpose": "수정 검증"
    }
  ],
  "exit_criteria": [
    "빌드 성공",
    "hydration warning 0개",
    "테스트 통과"
  ],
  "fallback": "ssr-disable-component",
  "estimated_tokens": 2000,
  "confidence": 0.9
}
```

---

## 6. 핵심 타입 정의 (`@yuaone/core`)

```typescript
/* ─── Plugin Types ─── */

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  yuan_version?: string;
  detect: PluginDetectConfig;
  skills: PluginSkillRef[];
  triggers: PluginTrigger[];
  tools?: PluginToolRef[];
  strategies?: string[];
  validators?: string[];
  patterns?: string[];
  config?: Record<string, unknown>;
}

export interface PluginDetectConfig {
  files?: string[];
  dependencies?: string[];
  glob?: string[];
  env?: string[];              // 환경변수 존재 여부
}

export interface PluginSkillRef {
  name: string;
  file: string;
  tags: string[];
}

export interface PluginTrigger {
  pattern: string;             // regex
  skill: string;
  strategy?: string;
  priority?: number;           // 높을수록 우선
}

export interface PluginToolRef {
  name: string;
  file: string;
  description: string;
}

/* ─── Skill Types ─── */

export interface Skill {
  name: string;
  domain: string;
  type: "bugfix" | "refactor" | "test" | "architecture" | "deploy" | "general";
  confidence: number;
  content: string;             // parsed markdown
  knownPatterns: KnownPattern[];
  validationChecklist: string[];
  toolSequence: string[];
}

export interface KnownPattern {
  name: string;
  symptoms: string[];
  causes: string[];
  strategy: string[];
  tools: string[];
  pitfalls: string[];
}

/* ─── Strategy Types ─── */

export interface Strategy {
  name: string;
  description: string;
  problemClass: string;
  steps: StrategyStep[];
  exitCriteria: string[];
  fallback?: string;
  estimatedTokens?: number;
  confidence: number;
}

export interface StrategyStep {
  action: string;
  args?: Record<string, unknown>;
  template?: string;
  check?: string;
  purpose: string;
}

/* ─── Plugin Instance (loaded) ─── */

export interface LoadedPlugin {
  manifest: PluginManifest;
  skills: Map<string, Skill>;
  strategies: Map<string, Strategy>;
  patterns: Map<string, unknown>;
  validators: unknown[];
  tools: Map<string, PluginTool>;
  basePath: string;
}

export interface PluginTool {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}
```

---

## 7. 핵심 모듈 설계

### 7.1 PluginRegistry (`@yuaone/core`)

```
plugin-registry.ts (~300 LOC)
  ├── scanProject(workDir)          → 프로젝트 스캔, detect 매칭
  ├── loadPlugin(pluginPath)        → plugin.yaml 파싱 + 리소스 로드
  ├── getActivePlugins()            → 현재 활성 플러그인 목록
  ├── matchTrigger(errorMsg)        → 에러 → skill+strategy 매칭
  ├── getSkill(name)                → 이름으로 스킬 조회
  ├── getStrategy(name)             → 이름으로 전략 조회
  └── injectIntoPrompt()            → 활성 스킬을 시스템 프롬프트에 주입
```

### 7.2 SkillLoader (`@yuaone/core`)

```
skill-loader.ts (~200 LOC)
  ├── parseSkillMarkdown(md)        → Skill 마크다운 파싱
  ├── parseStrategy(json)           → Strategy JSON 파싱
  ├── loadLocalSkills(dir)          → .yuan/skills/ 로컬 스킬 로드
  └── mergeSkills(plugin, local)    → 플러그인 + 로컬 스킬 병합
```

### 7.3 PluginManager (`@yuaone/core`)

```
plugin-manager.ts (~400 LOC)
  ├── init(workDir)                 → 프로젝트 초기화 시 전체 스캔+로드
  ├── install(pluginName)           → npm에서 플러그인 설치
  ├── uninstall(pluginName)         → 플러그인 제거
  ├── list()                        → 설치된 플러그인 목록
  ├── enable(name) / disable(name)  → 토글
  └── createSkill(name, template)   → 새 스킬 생성 (scaffold)
```

### 7.4 Agent Loop 연동

```
기존: AgentLoop → LLM → Tool → Loop
신규: AgentLoop → PluginRegistry.injectIntoPrompt() → LLM
                → 에러 발생 → PluginRegistry.matchTrigger(error)
                → Strategy 실행 → Tool → Loop
```

---

## 8. 플러그인 검색 경로

```
우선순위 (높은 것부터):
1. .yuan/plugins/         ← 프로젝트 로컬 (git tracked)
2. .yuan/skills/          ← 프로젝트 로컬 스킬 (git tracked)
3. node_modules/@yuaone/plugin-*    ← npm 설치된 공식 플러그인
4. node_modules/yuan-plugin-*       ← npm 설치된 커뮤니티 플러그인
5. ~/.yuan/plugins/       ← 글로벌 플러그인 (유저 레벨)
```

---

## 9. CLI 명령어 추가

```
/plugins                  ← 활성 플러그인 목록
/plugins install <name>   ← 플러그인 설치
/plugins remove <name>    ← 플러그인 제거
/skills                   ← 현재 로드된 스킬 목록
/skills add <name>        ← 로컬 스킬 추가 (scaffold)
```

---

## 10. 플러그인 목록 — 공식 Tier S/A/B/C

### Tier S — 설치하면 바로 체감 (필수급)

| Plugin | 설명 | detect |
|--------|------|--------|
| `@yuaone/plugin-react` | React/Next.js 전문가 | `react` in deps |
| `@yuaone/plugin-typescript` | TS 에러 해결사 | `tsconfig.json` exists |
| `@yuaone/plugin-api` | REST/GraphQL 자동 생성 | express/fastify/hono in deps |
| `@yuaone/plugin-db` | Prisma/SQL 전문가 | `prisma` in deps |
| `@yuaone/plugin-testing` | Vitest/Jest/Playwright 자동 생성 | vitest/jest in deps |
| `@yuaone/plugin-git` | PR 자동, conflict 해결 | `.git` exists |
| `@yuaone/plugin-monorepo` | pnpm/turborepo/nx 관리 | `pnpm-workspace.yaml` exists |
| `@yuaone/plugin-refactor` | 대규모 리팩토링 안전하게 | always available |

### Tier A — 1인 개발자 필수

| Plugin | 설명 | detect |
|--------|------|--------|
| `@yuaone/plugin-mobile` | React Native/Expo | `expo`/`react-native` in deps |
| `@yuaone/plugin-deploy` | Vercel/AWS/Docker 배포 | `vercel.json`/`Dockerfile` |
| `@yuaone/plugin-auth` | Firebase/NextAuth/Supabase | `firebase`/`next-auth` in deps |
| `@yuaone/plugin-payment` | Stripe/Toss 결제 | `@tosspayments`/`stripe` in deps |
| `@yuaone/plugin-docker` | Dockerfile/compose 자동 | `Dockerfile` exists |
| `@yuaone/plugin-ci` | GitHub Actions/GitLab CI | `.github/workflows/` exists |
| `@yuaone/plugin-perf` | 번들/렌더링 최적화 | `webpack`/`vite` in deps |
| `@yuaone/plugin-security` | OWASP 스캔 + 패치 | always available |
| `@yuaone/plugin-migration` | DB 마이그레이션 | `prisma`/`knex`/`typeorm` in deps |
| `@yuaone/plugin-design-system` | 디자인 토큰→컴포넌트 | `tailwindcss`/`styled-components` |
| `@yuaone/plugin-seo` | 메타태그/sitemap/OG | `next` in deps |
| `@yuaone/plugin-i18n` | 다국어 자동 번역 | `i18next`/`next-intl` in deps |

### Tier B — 비개발자 킬러

| Plugin | 설명 | detect |
|--------|------|--------|
| `@yuaone/plugin-landing` | 랜딩페이지 원샷 생성 | manual |
| `@yuaone/plugin-admin` | 어드민 대시보드 자동 | manual |
| `@yuaone/plugin-saas` | SaaS 풀스택 스캐폴딩 | manual |
| `@yuaone/plugin-blog` | MDX 블로그 자동 | manual |
| `@yuaone/plugin-ecommerce` | 쇼핑몰 스캐폴딩 | manual |
| `@yuaone/plugin-form` | 폼 빌더+validation+DB | manual |
| `@yuaone/plugin-chart` | 데이터→차트/대시보드 | manual |
| `@yuaone/plugin-email` | 이메일 템플릿+발송 | `nodemailer`/`resend` in deps |
| `@yuaone/plugin-pdf` | PDF 생성/파싱 | manual |

### Tier C — 니치하지만 중독

| Plugin | 설명 | detect |
|--------|------|--------|
| `@yuaone/plugin-scraper` | 웹 크롤링+데이터 추출 | `puppeteer`/`playwright` in deps |
| `@yuaone/plugin-webhook` | 웹훅 엔드포인트 자동 | manual |
| `@yuaone/plugin-cron` | 스케줄러 설정 | `node-cron` in deps |
| `@yuaone/plugin-notification` | 슬랙/디스코드 알림 | `@slack/bolt`/`discord.js` |
| `@yuaone/plugin-ai-fine-tune` | 파인튜닝 파이프라인 | `openai` in deps |

---

## 11. Skills 전체 목록

### Coding Skills (30개)

```
debugging/
  stack-trace-reader        — 스택트레이스 → 원인 파일:라인 즉시 특정
  binary-search-bug         — git bisect 자동으로 버그 커밋 찾기
  console-log-surgeon       — 전략적 로그 삽입 → 원인 추적 → 로그 제거
  type-error-resolver       — TS 에러 코드별 해결 패턴 매핑 (TS2322, TS2345 등)
  runtime-vs-compile        — 런타임/컴파일 에러 구분 후 다른 전략 적용
  dependency-conflict       — 버전 충돌 해결 (peer deps, resolution)
  env-mismatch              — 환경별 동작 차이 디버깅 (dev/prod/test)

architecture/
  file-structure-advisor    — 프로젝트 구조 분석 + 개선안
  dependency-analyzer       — 순환 의존성 탐지 + 해결
  api-design                — REST/GraphQL 엔드포인트 설계
  state-management          — 전역상태 설계 (Zustand/Redux/Context)
  db-schema-design          — ERD → Prisma schema → migration
  monorepo-architect        — 패키지 분리/통합 전략

code-quality/
  dead-code-eliminator      — 사용 안 하는 코드 찾아서 정리
  duplication-killer         — 중복 코드 → 공통 함수/컴포넌트 추출
  naming-improver           — 변수/함수명 개선 제안
  complexity-reducer        — 복잡한 함수 분해 (cyclomatic complexity)
  accessibility-checker     — a11y 위반 자동 수정

testing/
  test-generator            — 함수/컴포넌트 → 테스트 자동 생성
  test-fixer                — 깨진 테스트 수정 (mock reset, snapshot update)
  e2e-writer                — Playwright/Cypress E2E 시나리오 생성
  coverage-improver         — 커버리지 낮은 부분 타겟팅

migration/
  framework-migrator        — CRA→Next.js, Vue2→Vue3 등 프레임워크 마이그레이션
  package-upgrader          — 메이저 버전 업그레이드 (breaking changes 해결)
  api-versioner             — API 버전 관리 전략

security/
  vulnerability-patcher     — CVE/npm audit 취약점 자동 패치
  secret-rotator            — 시크릿 교체 가이드
  auth-hardener             — 인증 보안 강화
  input-sanitizer           — 입력 검증/sanitize 자동 추가
  csp-configurator          — Content Security Policy 설정
```

### 운영 Skills (15개)

```
devops/
  env-setup                 — .env 구성 + secret 관리
  ssl-cert                  — Let's Encrypt 자동 설정
  nginx-config              — 리버스 프록시 설정
  pm2-manager               — 프로세스 관리 + 모니터링
  log-analyzer              — 서버 로그 패턴 분석

performance/
  lighthouse-optimizer      — 성능 점수 자동 개선 (CLS, LCP, FID)
  query-optimizer           — N+1 탐지 + SQL 최적화
  image-optimizer           — 이미지 포맷/사이즈 최적화 (WebP, AVIF)
  cache-strategy            — Redis/CDN 캐싱 전략 설정
  bundle-analyzer           — 번들 사이즈 분석 + tree-shaking

monitoring/
  error-tracker-setup       — Sentry/Datadog 자동 연동
  uptime-monitor            — 헬스체크 + 알림 설정
  metrics-dashboard         — Grafana/Prometheus 대시보드
  alert-rules               — 알림 임계값 설정
  cost-monitor              — 클라우드 비용 모니터링
```

### 비개발자 킬러 Skills (10개)

```
no-code/
  describe-to-code          — "이런 거 만들어줘" → 전체 구현
  screenshot-to-code        — 스크린샷 → 코드 변환
  figma-to-code             — Figma URL → 컴포넌트
  spreadsheet-to-app        — 엑셀/구글시트 → 웹앱
  voice-to-code             — 음성 설명 → 코드 (향후)

business/
  mvp-generator             — 아이디어 → 3일 MVP 자동 생성
  competitor-clone           — "저 사이트 비슷하게" → 클론
  analytics-setup           — GA/Mixpanel 자동 연동
  ab-test-setup             — A/B 테스트 인프라 자동
  cost-calculator           — 인프라 비용 예측
```

---

## 12. 조합 시나리오 (킬러 유스케이스)

### 시나리오 1: "결제 페이지 만들어줘"

```
유저: "토스 결제 페이지 만들어줘"

YUAN 자동 흐름:
  1. detect: react + @tosspayments/payment-sdk 감지
  2. plugin-react 로드 + plugin-payment 로드
  3. skill: api-design → 결제 API 엔드포인트 설계
  4. skill: db-schema-design → orders, payments 테이블
  5. strategy: toss-payment-flow → SDK 초기화 → 결제 요청 → 웹훅 → 완료
  6. skill: describe-to-code → 결제 UI 컴포넌트 생성
  7. skill: test-generator → 결제 플로우 E2E 테스트
  8. Self-Critic → PCI-DSS 보안 검토
  9. Trust Report → confidence: 0.87, risk: 웹훅 실패 시 재시도 로직 필요
```

### 시나리오 2: "빌드가 안 돼"

```
유저: "pnpm build 하면 에러 남"

YUAN 자동 흐름:
  1. shell_exec: pnpm build → 에러 캡처
  2. trigger 매칭: "Module not found" → plugin-typescript
  3. skill: type-error-resolver → TS2307 패턴 매칭
  4. strategy: build-fix → tsconfig paths 확인 → import 수정
  5. 재빌드 → 성공 확인
  6. Experience Engine → "이 프로젝트에서 path alias는 @/ 사용" 학습
```

### 시나리오 3: 비개발자 "쇼핑몰 만들어줘"

```
유저: "간단한 쇼핑몰 만들어줘"

YUAN 자동 흐름:
  1. plugin-ecommerce 로드 (manual trigger)
  2. skill: mvp-generator → 요구사항 정리
  3. plugin-react → Next.js 프로젝트 스캐폴딩
  4. plugin-db → 상품/주문/유저 스키마 생성
  5. plugin-auth → 로그인/회원가입
  6. plugin-payment → 결제 연동
  7. skill: describe-to-code → 상품 목록, 장바구니, 주문 UI
  8. plugin-deploy → Vercel 배포
  9. Trust Report → "MVP 완성, 재고 관리는 수동, 향후 추가 필요"
```

---

## 13. 구현 우선순위

### Phase 1 — 코어 인프라 (먼저)

```
1. PluginManifest 타입 정의 (yuan-core)
2. PluginRegistry — scan + detect + load
3. SkillLoader — markdown/json 파싱
4. AgentLoop 연동 — prompt injection + trigger matching
5. CLI 명령어 — /plugins, /skills
```

### Phase 2 — 공식 플러그인 3개

```
1. @yuaone/plugin-typescript  ← 가장 범용
2. @yuaone/plugin-react       ← 가장 수요 많음
3. @yuaone/plugin-git         ← 가장 자주 사용
```

### Phase 3 — 확장

```
1. npm 배포 파이프라인
2. 커뮤니티 플러그인 가이드
3. 나머지 Tier S/A 플러그인
4. 플러그인 마켓플레이스 (yuaone.com)
```

---

## 14. Claude Code와 차별화 포인트

| 기능 | Claude Code | YUAN |
|------|------------|------|
| 범용 코딩 | 최강 | 강함 |
| 도메인 특화 | 없음 (범용만) | **플러그인으로 무한 확장** |
| 에러 패턴 매칭 | 없음 | **trigger → strategy 자동** |
| 커뮤니티 확장 | 없음 | **npm 플러그인 생태계** |
| 비개발자 모드 | 없음 | **Tier B 플러그인** |
| 프로젝트별 학습 | CLAUDE.md | **Experience Engine + Skills** |
| 전략 라이브러리 | 없음 | **Strategy JSON 재사용** |

---

## 15. 보안 모델 & 인간 승인 (QA + GPT 리뷰 반영)

> CRITICAL/HIGH 이슈를 반영한 보안 설계.

### 15.1 플러그인 3종 분류

```
1. knowledge    — skills/patterns/strategies만 (실행 코드 없음)
                  → 자동 로드 OK, 승인 불필요
                  → 보안 위험: 낮음 (프롬프트 인젝션만 주의)

2. tool         — 실행 가능한 도구 포함
                  → 🔴 설치 시 인간 승인 필수
                  → 🔴 도구 실행 시 sideEffectLevel 기반 승인
                  → 보안 위험: 높음

3. hybrid       — knowledge + tool 둘 다
                  → tool과 동일한 보안 정책 적용
```

plugin.yaml 필수 필드 추가:

```yaml
type: "knowledge" | "tool" | "hybrid"
trust: "official" | "verified" | "community" | "local"
sandbox: "none" | "restricted" | "isolated"
trigger_mode: "auto" | "suggest" | "manual"
plugin_api_version: 1
estimated_prompt_tokens: 500
checksum: "sha256:abc123..."
```

### 15.2 인간 승인 매트릭스 (HUMAN APPROVAL MATRIX)

```
┌─────────────────────────────────┬──────────┬─────────────────────────┐
│ 액션                             │ 승인 필요 │ 근거                     │
├─────────────────────────────────┼──────────┼─────────────────────────┤
│ knowledge plugin 자동 로드       │ ❌ 불필요 │ 실행 코드 없음            │
│ tool plugin 설치 (npm install)   │ 🔴 필수  │ postinstall 스크립트 위험  │
│ tool plugin 도구 실행 (read)     │ ❌ 불필요 │ 읽기만                   │
│ tool plugin 도구 실행 (write)    │ 🟡 1회   │ 파일 수정                │
│ tool plugin 도구 실행 (execute)  │ 🔴 매번  │ 셸 실행                  │
│ tool plugin 도구 실행 (destruct) │ 🔴 매번  │ 삭제/포맷                │
│ strategy 자동 실행               │ 🟡 suggest│ LLM 통해서만, 직접 X     │
│ skill 프롬프트 주입              │ ❌ 불필요 │ PromptDefense 통과 후    │
│ community plugin 첫 설치         │ 🔴 필수  │ 신뢰할 수 없는 소스       │
│ official plugin 업데이트         │ ❌ 불필요 │ 서명 검증 통과 시         │
│ plugin 비활성화/제거             │ ❌ 불필요 │ 안전한 액션              │
└─────────────────────────────────┴──────────┴─────────────────────────┘
```

### 15.3 프롬프트 인젝션 방어

```
스킬 마크다운 → PromptDefense.sanitize() → XML 태그 격리 → 토큰 예산 체크 → 주입

주입 형태:
<yuan-plugin name="react" trust="official">
  <skill name="bugfix">
    [sanitized skill content]
  </skill>
</yuan-plugin>

규칙:
1. 모든 스킬 내용은 PromptDefense 통과 필수
2. XML 태그로 격리 (LLM이 plugin context vs instruction 구분)
3. 플러그인당 최대 토큰: estimated_prompt_tokens
4. 전체 합계: TokenBudgetManager "plugin" role 예산 내
5. full-load 금지 → retrieval 방식 (현재 task 관련 section만)
```

### 15.4 전략 실행 보안

```
🔴 핵심: Strategy는 절대 도구를 직접 호출하지 않는다.

Strategy = LLM에게 컨텍스트 제공 (이렇게 하면 좋겠다)
도구 호출 = 반드시 AgentLoop → LLM → ToolExecutor 경로

action allowlist만 허용:
  file_read, file_write, file_edit, grep, glob,
  git_ops, shell_exec, test_run, code_search, security_scan

금지:
  - 커스텀 action
  - ${variable} 템플릿 미sanitize 사용
  - shell_exec 포함 strategy → trigger_mode: "suggest" 강제
```

### 15.5 도구 실행 보안

```typescript
export interface PluginToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;     // JSON Schema
  sideEffectLevel: "none" | "read" | "write" | "execute" | "destructive";
}

// 실행 흐름:
// 1. LLM이 plugin tool 호출 결정
// 2. AgentLoop → Governor.validateToolCall()
// 3. sideEffectLevel >= "write" → ApprovalManager 승인
// 4. 승인 후 → ToolExecutor.execute()
// 5. 결과 → AgentLogger 감사 기록
```

---

## 16. 기존 시스템 통합

### 16.1 우선순위 체인

```
에러/작업 발생 시 전략 매칭:

1. PluginTrigger (curated)     ← 전문가가 만든 확정적 전략
2. ReflexionEngine (learned)   ← 이 프로젝트에서 학습한 전략
3. TaskClassifier (heuristic)  ← 범용 휴리스틱 fallback

병합: Plugin 있으면 primary, Reflexion은 보조. 둘 다 없으면 TaskClassifier.
```

### 16.2 피드백 루프 (Experience Engine 연결)

```
Plugin strategy 실행 후:
  성공 → ReflexionEngine에 StrategyRecord 추가 (source: "plugin")
       → plugin efficacy score +1
  실패 → 실패 기록 + trigger blacklist + efficacy -1

.yuan/plugin-stats.json:
  {
    "@yuaone/plugin-react": {
      "triggers_matched": 42,
      "success_rate": 0.83,
      "most_used_skill": "bugfix",
      "blacklisted_triggers": ["pattern-x"]
    }
  }
```

---

## 17. 트리거 충돌 해결

### 17.1 강화된 트리거 스펙

```yaml
triggers:
  - pattern: "hydration"
    kind: "error"                    # error | task | file | dependency
    skill: "ssr"
    strategy: "hydration-fix"
    priority: 10
    requires: ["react-dom"]          # 이 의존성 있을 때만
    exclude: ["next@15"]             # 제외 조건
    cooldown: 1                      # 연속 매칭 방지 (분)
    max_matches: 3                   # 세션당 최대
    trigger_mode: "auto"             # auto | suggest | manual
```

### 17.2 충돌 해결 규칙

```
1. 동일 에러 → 여러 plugin: priority → trust → efficacy score 순
2. 같은 skill name: 네임스페이스 ("@yuaone/plugin-react/bugfix")
3. 로컬 override: .yuan/skills/ 같은 이름 있으면 로컬 우선
4. Fallback chain: strategy A 실패 → fallback → 다음 priority → 3회 실패 → blacklist
```

---

## 18. 컨텍스트 주입 정책 (토큰 절제)

> "많이 넣는 것 ❌, 정확한 순간에 정확한 전략만 ✅"

```
1. 기본 상태 (항상): 플러그인 이름+설명 (~200 tok)
2. 트리거 매칭 시: 관련 skill 섹션 + strategy steps + patterns 3개 (~500-1000 tok)
3. 명시적 요청 시: 해당 스킬 전문 (~1000-2000 tok)

토큰 예산: TokenBudgetManager "plugin" role
  기본: 2000 tok, Superpower: 5000 tok
```

---

## 19. 스킬 마크다운 파서 스펙

```
필수 섹션: ## Identity (domain, type, confidence)
권장 섹션: ## Known Error Patterns, ## Validation Checklist

파서 규칙:
  - ### 서브섹션 → KnownPattern (증상/원인/전략/도구/함정)
  - - [ ] 항목 → validationChecklist
  - 파싱 실패 → raw text fallback

Skill.type: 자유형 string (권장값 15종)
```

---

## 20. Validator 4단계 분리

```json
{
  "pre-check":     [{ "rule": "no-direct-dom-manipulation", "severity": "warning" }],
  "post-check":    [{ "rule": "build-passes", "command": "pnpm build", "severity": "error" }],
  "quality-check": [{ "rule": "no-console-log", "pattern": "console\\.log", "severity": "warning" }],
  "safety-check":  [{ "rule": "no-eval", "pattern": "eval\\(", "severity": "critical" }]
}
```

---

## 21. 플러그인 라이프사이클 훅

```typescript
export interface PluginLifecycle {
  onLoad?(context: PluginContext): Promise<void>;
  onUnload?(): Promise<void>;
  beforeAgentRun?(task: string): Promise<PluginAdvice | null>;
  afterAgentRun?(result: AgentResult): Promise<void>;
  onError?(error: string): Promise<PluginAdvice | null>;
  onProjectScan?(projectInfo: ProjectInfo): Promise<void>;
}
```

---

## 22. 에러 핸들링 & 열화

```
1. plugin.yaml 파싱 실패 → 경고 + 스킵
2. 스킬 파싱 실패 → 해당 스킬만 스킵
3. 전략 파싱 실패 → 해당 전략만 스킵
4. 도구 import 실패 → 해당 도구만 스킵
5. 이름 충돌 → 네임스페이스 자동 적용
6. API 버전 불일치 → 전체 플러그인 스킵

원칙: 하나의 문제가 전체 시스템을 멈추지 않는다.
```

---

## 23. 타입 리네임 (충돌 해결)

```
Plugin 쪽: PluginStrategy, PluginTrigger, PluginTool, PluginValidator
기존 유지: StrategyRecord (reflexion.ts), RecoveryStrategy (failure-recovery.ts)
관계: PluginStrategy 성공 → StrategyRecord로 변환 → ReflexionEngine 피드백
```

---

## 24. Deliberation Layer — 인과추론 + 서브↔메인 검증 + 빠른 협의

> 현재 3,320 LOC의 검증 모듈이 agent-loop에 하나도 연결 안 됨.
> 이 섹션은 검증 레이어를 코어 루프에 통합하는 설계.

### 24.1 문제 진단

```
현재 AgentLoop 흐름:
  User → LLM → Tool Call → Result → LLM → ... → Done
                                                    ↑
                                              여기서 "됐다" 선언
                                              검증 없이.

있어야 할 흐름:
  User → LLM → Tool Call → Result → 🔍 Quick Verify → LLM → ... → 🔍 Deep Verify → Done
                                     ↑                              ↑
                               매 iteration                    최종 완료 전
```

### 24.2 3단계 검증 통합

```
Level 0: Auto (매 tool call 후)
  → ImpactAnalyzer.assessBlastRadius() ← 이미 있음, 더 활용
  → 파일 변경 diff 크기 체크
  → build 깨졌는지 빠르게 확인 (tsc --noEmit)
  → 비용: ~0 토큰 (heuristic only)

Level 1: Quick Verify (매 iteration 후)
  → SelfReflection.quickVerify() 호출
  → "방금 한 수정이 원래 목표와 맞는지?" 1문장 체크
  → 위험 감지 시 → Level 2로 에스컬레이션
  → 비용: ~200 토큰

Level 2: Deep Verify (완료 선언 전 / 위험 감지 시)
  → SelfReflection.deepVerify() 호출 (6차원 검증)
  → DebateOrchestrator 단축 모드 (Coder↔Reviewer 1회전만)
  → 인과추론: "왜 이 수정이 문제를 해결하는가?" 체인
  → 비용: ~500-1000 토큰
```

### 24.3 인과추론 엔진 (Causal Reasoning)

```typescript
export interface CausalChain {
  symptom: string;           // "빌드 에러: TS2307"
  hypothesis: string[];      // ["import path 오류", "패키지 미설치", "tsconfig 잘못"]
  evidence: CausalEvidence[];// 각 가설에 대한 증거
  rootCause: string;         // 최종 판정된 근본 원인
  confidence: number;        // 0-1
  reasoning: string;         // 추론 과정 설명
}

export interface CausalEvidence {
  hypothesis: string;
  supports: boolean;         // 이 증거가 가설을 지지하는지
  tool: string;              // 증거를 얻은 도구 (grep, file_read 등)
  finding: string;           // 발견 내용
}
```

```
인과추론 흐름:
  1. 에러 발생 → 증상 추출
  2. LLM에게 가설 3개 생성 요청 (cheap model OK)
  3. 각 가설별 증거 수집 (grep, file_read 등)
  4. 증거 기반 근본 원인 판정
  5. 판정 → 수정 → 수정이 근본 원인을 해결했는지 검증

핵심: "고쳤다"가 아니라 "왜 고쳐졌는지"를 추적.
이게 있으면 hacky fix vs proper fix 구분 가능.
```

### 24.4 서브↔메인 검증 프로토콜

```
현재: SubAgent.run() → SubAgentResult { success, summary, changedFiles }
     → 메인이 그냥 믿고 계속 진행

신규:
  SubAgent.run() → SubAgentResult + VerificationReport
    ├── changedFiles: string[]
    ├── diffs: ParsedDiff[]           ← 실제 변경 내용
    ├── testsRun: boolean             ← 테스트 돌렸는지
    ├── testsPassed: boolean          ← 테스트 통과했는지
    ├── buildPassed: boolean          ← 빌드 통과했는지
    ├── causalChain: CausalChain      ← 왜 이렇게 수정했는지
    └── confidence: number            ← 서브 자체 확신도

  Main Agent 검증:
    1. confidence < 0.7 → Deep Verify 강제
    2. changedFiles > 5 → Deep Verify 강제
    3. testsRun === false → 🔴 경고 + 테스트 강제 실행
    4. causalChain.confidence < 0.5 → 🔴 수정 거부 + 재시도
    5. diffs 리뷰 → blast radius 체크
```

### 24.5 빠른 협의 (Quick Deliberation)

```
시나리오: 에이전트가 수정하려는데 확신이 없을 때

현재: 그냥 함 → 망하면 AutoFix 시도
신규: 빠른 협의 후 진행

Quick Deliberation 프로토콜:
  1. 메인 에이전트: "이 수정이 맞는지 확신 없음"
  2. Critic 호출 (cheap model, ~100 토큰):
     → "src/auth.ts:42에서 null check 추가하려는데,
        이게 근본 원인이 맞나? 아니면 상위에서 처리해야 하나?"
  3. Critic 응답:
     → "상위 middleware에서 처리하는 게 맞음. auth.ts는 증상이지 원인 아님."
  4. 메인: 전략 수정 → middleware 수정으로 변경

비용: ~200-300 토큰 (cheap model)
효과: hacky fix 방지, 근본 원인 해결률 상승
```

### 24.6 AgentLoop 통합 위치

```typescript
// agent-loop.ts 수정 포인트

class AgentLoop {
  private selfReflection: SelfReflection;        // 추가
  private continuousReflection: ContinuousReflection; // 추가

  async run() {
    // ... 기존 루프 ...

    // 매 iteration 후 (Level 1)
    for (const iteration of iterations) {
      const result = await this.executeIteration();

      // 🔍 Quick Verify 추가
      const quickResult = await this.selfReflection.quickVerify(
        result.changedFiles,
        this.verifyFn
      );
      if (quickResult.needsDeepVerify) {
        // Level 2 에스컬레이션
        const deepResult = await this.selfReflection.deepVerify(
          this.currentGoal, result.changedFiles, ...
        );
        if (!deepResult.passed) {
          // 수정 롤백 + 재시도
          await this.rollbackAndRetry(deepResult.feedback);
        }
      }
    }

    // 최종 완료 전 (Level 2)
    const finalVerify = await this.selfReflection.deepVerify(...);
    if (!finalVerify.passed) {
      // 유저에게 경고 + Trust Report에 반영
    }
  }
}
```

### 24.7 Deliberation 비용 제어

```
비용 정책 (ExecutionPolicy 연동):

trivial task:
  Level 0 only (heuristic)
  비용: 0 토큰

simple task:
  Level 0 + Level 1 (마지막 iteration만)
  비용: ~200 토큰

moderate task:
  Level 0 + Level 1 (매 iteration) + Level 2 (완료 전)
  비용: ~1000 토큰

complex/massive task (Superpower Mode):
  Level 0 + Level 1 + Level 2 + Quick Deliberation + 인과추론
  비용: ~2000-3000 토큰

cheap model 활용:
  Level 1 Quick Verify → yua-basic (FAST)
  Quick Deliberation → yua-basic (FAST)
  Level 2 Deep Verify → yua-normal (NORMAL)
  인과추론 → yua-pro (DEEP)
```

---

## QA 이슈 해결 추적표

| # | 이슈 | 심각도 | 해결 |
|---|------|--------|------|
| C1 | Strategy 타입 충돌 | CRITICAL | §23 |
| C2 | 플러그인 도구 보안 | CRITICAL | §15.5 |
| C3 | 프롬프트 인젝션 | CRITICAL | §15.3 |
| H1 | 전략 자동 실행 승인 | HIGH | §15.4 |
| H2 | 기존 시스템 중복 | HIGH | §16 |
| H3 | ToolExecutor 불일치 | HIGH | §15.5 |
| H4 | 토큰 예산 없음 | HIGH | §18 |
| M1-7 | Medium 이슈 7개 | MEDIUM | §15.1, §17, §19-22 |
| GPT 1-8 | GPT 리뷰 8개 | - | §15-22 전체 |

**전체 해결: CRITICAL 3/3, HIGH 4/4, MEDIUM 7/7, GPT 8/8**

---

## 25. Skills Marketplace

> 커뮤니티 기여 플러그인/스킬을 검색·배포·설치할 수 있는 마켓플레이스 설계.

### 25.1 Registry Architecture

```
Central Registry (npm-like):
  ├── Storage: S3-compatible (plugin tarballs)
  ├── Metadata DB: plugin_registry + plugin_versions (§26 참고)
  ├── Search Index: Elasticsearch / Meilisearch
  └── CDN: CloudFront/Cloudflare (다운로드 가속)

API Endpoints:
  GET    /api/marketplace/search?q=react&category=coding&sort=downloads
  GET    /api/marketplace/plugins/:name                  — 상세 정보
  GET    /api/marketplace/plugins/:name/versions          — 버전 목록
  POST   /api/marketplace/plugins                         — 퍼블리시 (인증 필요)
  GET    /api/marketplace/plugins/:name/download/:version — 다운로드
  POST   /api/marketplace/plugins/:name/rate              — 평점
  POST   /api/marketplace/plugins/:name/report            — 신고
  GET    /api/marketplace/categories                      — 카테고리 목록
  GET    /api/marketplace/trending                        — 트렌딩 (7일 기준)
  GET    /api/marketplace/featured                        — 큐레이션 추천

Version Management:
  - semver 준수 필수 (major.minor.patch)
  - yuan_version 호환성 체크 (>=0.2.0 등)
  - 자동 호환성 매트릭스 생성
  - deprecated 버전 표시 (보안 이슈 등)

Categories:
  coding    — 언어/프레임워크 전문 (react, typescript, python, rust ...)
  devops    — CI/CD, Docker, k8s, 클라우드
  security  — 보안 스캔, 취약점 패치, 인증 강화
  design    — UI/UX, 디자인 시스템, 접근성
  no-code   — 비개발자용 (screenshot-to-code, describe-to-code)
  data      — DB, 데이터 파이프라인, 분석
```

### 25.2 Marketplace UI Components

```
Browse/Search Page:
  ├── 검색바 (자동완성 + 태그 필터)
  ├── 카테고리 사이드바 (coding, devops, security, design, no-code, data)
  ├── 정렬: 인기순 / 최신순 / 평점순 / 다운로드순
  ├── 필터: trust level (official/verified/community), 무료/유료
  ├── 플러그인 카드 (이름, 설명, 평점, 다운로드 수, trust badge)
  └── 페이지네이션 (infinite scroll)

Plugin Detail Page:
  ├── 헤더: 이름, 버전, 작성자, trust badge, 설치 버튼
  ├── 탭: Overview | Skills | Changelog | Reviews | Versions
  ├── Overview: README 렌더링, 스크린샷/GIF, 호환성 정보
  ├── Skills: 포함된 스킬 목록 + 각 스킬 설명
  ├── Changelog: 버전별 변경사항
  ├── Reviews: 유저 리뷰 + 평점 분포
  └── Install 버튼 → CLI 명령어 복사 or 원클릭 설치

One-Click Install:
  ├── Web: "Install" 클릭 → 로컬 YUAN CLI에 deeplink → `yuan plugin install <name>`
  ├── CLI: `/plugins install <name>` → npm registry fetch → 설치 + 자동 detect
  └── 설치 후: 자동으로 plugin.yaml 로드 + 스킬 활성화

Publisher Dashboard:
  ├── 플러그인 업로드/업데이트
  ├── 다운로드 통계 (일별/주별/월별)
  ├── 리뷰 관리 (답글 달기)
  ├── 수익 대시보드 (유료 플러그인)
  └── Webhook 알림 (새 리뷰, 이슈 리포트)
```

### 25.3 Publishing Flow

```
CLI 퍼블리시:
  $ yuan plugin publish
    1. plugin.yaml 매니페스트 검증 (필수 필드, 스키마 체크)
    2. 자동 보안 스캔:
       - secrets 탐지 (API key, password 패턴)
       - eval/exec 사용 검사
       - 파일 사이즈 제한 (단일 파일 1MB, 전체 5MB)
       - node_modules 포함 금지
    3. tarball 생성 (files 필드 기준)
    4. checksum 생성 (SHA-256)
    5. registry API로 업로드 (인증 토큰 필요)
    6. 완료 → 마켓플레이스에 즉시 게시

Review Queue (community 플러그인):
  - type: "knowledge" → 자동 승인 (보안 스캔 통과 시)
  - type: "tool" / "hybrid" → 수동 리뷰 큐 진입
  - 리뷰어: YUAN 코어 팀 or 승인된 커뮤니티 리뷰어
  - 리뷰 기준: 보안, 품질, 유용성, 문서화

Auto-Promote to Verified:
  조건 (모두 충족 시):
    - 다운로드 500+
    - 평균 평점 4.0+
    - 리뷰 10+
    - 보안 이슈 0건 (최근 90일)
    - 작성자 계정 30일+
  → trust_level: "community" → "verified" 자동 승격
```

### 25.4 Revenue Model (Optional)

```
Free Tier:
  - 모든 official 플러그인 무료
  - 모든 community 플러그인 무료
  - 기본 마켓플레이스 기능 전체 무료

Premium Plugins:
  - 작성자가 유료 설정 가능 (one-time 또는 subscription)
  - 가격 범위: $1 ~ $99 (one-time), $1 ~ $19/mo (subscription)
  - 무료 trial 지원 (7일/14일/30일)
  - Revenue split: 70% creator / 30% platform
  - 최소 지급 기준: $50 (월별 정산)

향후 확장:
  - Plugin Bundle (묶음 할인)
  - Enterprise License (조직 단위)
  - Sponsorship (플러그인 후원)
```

---

## 26. DB Persistence (Plugin State & Sessions)

> 플러그인 상태, 유저 설정, 세션 데이터를 영속적으로 관리하는 DB 스키마 설계.

### 26.1 Schema Design

```sql
-- Plugin installations per user
-- 유저별 설치된 플러그인 관리
CREATE TABLE user_plugins (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  plugin_id VARCHAR(255) NOT NULL,
  version VARCHAR(50),
  config JSONB DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Plugin marketplace registry
-- 마켓플레이스에 등록된 플러그인 메타데이터
CREATE TABLE plugin_registry (
  id UUID PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  author_id UUID,
  category VARCHAR(50),
  trust_level VARCHAR(20) DEFAULT 'community',
  latest_version VARCHAR(50),
  total_downloads INTEGER DEFAULT 0,
  average_rating DECIMAL(3,2),
  manifest JSONB NOT NULL,
  published_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Plugin versions
-- 플러그인 버전 히스토리 (다운그레이드 지원)
CREATE TABLE plugin_versions (
  id UUID PRIMARY KEY,
  plugin_id UUID REFERENCES plugin_registry(id),
  version VARCHAR(50) NOT NULL,
  changelog TEXT,
  package_url TEXT NOT NULL,
  checksum VARCHAR(128),
  size_bytes INTEGER,
  published_at TIMESTAMPTZ DEFAULT NOW()
);

-- Skill execution history (for learning/analytics)
-- 스킬 실행 이력 — Experience Engine 피드백 + 사용 통계
CREATE TABLE skill_executions (
  id UUID PRIMARY KEY,
  user_id UUID,
  session_id UUID,
  skill_id VARCHAR(255),
  plugin_id VARCHAR(255),
  trigger_type VARCHAR(50),
  input_summary TEXT,
  output_summary TEXT,
  success BOOLEAN,
  duration_ms INTEGER,
  tokens_used INTEGER,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Plugin reviews
-- 마켓플레이스 리뷰 (평점 + 코멘트)
CREATE TABLE plugin_reviews (
  id UUID PRIMARY KEY,
  plugin_id UUID REFERENCES plugin_registry(id),
  user_id UUID,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_user_plugins_user ON user_plugins(user_id);
CREATE INDEX idx_user_plugins_plugin ON user_plugins(plugin_id);
CREATE INDEX idx_plugin_registry_name ON plugin_registry(name);
CREATE INDEX idx_plugin_registry_category ON plugin_registry(category);
CREATE INDEX idx_plugin_versions_plugin ON plugin_versions(plugin_id);
CREATE INDEX idx_skill_executions_user ON skill_executions(user_id);
CREATE INDEX idx_skill_executions_session ON skill_executions(session_id);
CREATE INDEX idx_skill_executions_skill ON skill_executions(skill_id);
CREATE INDEX idx_plugin_reviews_plugin ON plugin_reviews(plugin_id);
```

### 26.2 Migration Strategy

```
Migration 방식:
  - 기존 yua-backend migration 시스템 사용 (SQL 파일 기반)
  - 파일명: YYYYMMDD_plugin_system.sql
  - 롤백 파일: YYYYMMDD_plugin_system_rollback.sql

Migration 순서:
  1. plugin_registry (마켓플레이스 기반 테이블)
  2. plugin_versions (버전 관리)
  3. user_plugins (유저별 설치)
  4. skill_executions (실행 이력)
  5. plugin_reviews (리뷰)
  6. indexes (성능 최적화)

Rollback 지원:
  - 각 migration에 대응하는 DROP TABLE IF EXISTS
  - 데이터 백업: migration 전 pg_dump 자동 (production만)
  - 실패 시 트랜잭션 자동 롤백 (BEGIN/COMMIT/ROLLBACK)
```

### 26.3 Caching Layer

```
Redis (Hot Data):
  ├── marketplace:plugin:<name>          — 플러그인 메타데이터 (TTL: 1h)
  ├── marketplace:search:<query_hash>    — 검색 결과 캐시 (TTL: 5m)
  ├── marketplace:trending               — 트렌딩 목록 (TTL: 15m)
  ├── marketplace:featured               — 큐레이션 추천 (TTL: 1h)
  ├── user:<uid>:plugins                 — 유저 설치 목록 (TTL: 24h)
  └── plugin:<name>:stats                — 다운로드/평점 통계 (TTL: 5m)

Local Disk Cache (CLI/Desktop):
  ├── ~/.yuan/cache/plugins/<name>@<version>/  — 설치된 플러그인 파일
  ├── ~/.yuan/cache/registry.json              — 로컬 레지스트리 캐시 (TTL: 1h)
  └── ~/.yuan/cache/search/                    — 최근 검색 결과 (TTL: 30m)

Invalidation:
  - 플러그인 업데이트 시 → Redis 키 삭제
  - 리뷰/평점 변경 시 → stats 키 삭제
  - CLI에서 --no-cache 옵션으로 캐시 우회 가능
```

---

## 27. Plugin/Skill Selection UI (CLI Tree View)

> CLI에서 플러그인/스킬을 트리 형태로 탐색·관리하는 인터랙티브 UI 설계.

### 27.1 Command Interface

```
/plugins                  — 설치된 플러그인 목록 (tree view)
/plugins search <query>   — 마켓플레이스 검색
/plugins install <name>   — 플러그인 설치
/plugins remove <name>    — 플러그인 제거
/plugins update           — 모든 플러그인 업데이트
/plugins update <name>    — 특정 플러그인 업데이트
/plugins info <name>      — 플러그인 상세 정보
/plugins config <name>    — 플러그인 설정 변경

/skills                   — 사용 가능한 스킬 목록 (tree view)
/skills <name>            — 스킬 실행
/skills enable <name>     — 스킬 활성화
/skills disable <name>    — 스킬 비활성화
/skills info <name>       — 스킬 상세 정보
/skills add <name>        — 로컬 스킬 추가 (scaffold)
```

### 27.2 Tree View Format

```
📦 Installed Plugins (3)
├── 🟢 @yuaone/plugin-typescript v1.2.0 [official]
│   ├── 📋 Skills: ts-strict, ts-migrate, ts-refactor
│   ├── 🔧 Tools: tsc-check, type-analyzer
│   └── ⚙️  Config: strict=true, target=ES2022
├── 🟢 @yuaone/plugin-react v1.0.0 [official]
│   ├── 📋 Skills: component-gen, hook-extract
│   └── 🔧 Tools: jsx-analyzer
└── 🟡 community/docker-helper v0.3.1 [community]
    ├── 📋 Skills: dockerfile-gen, compose-validate
    └── ⚠️  Requires: shell_exec approval

Available Skills (grouped by plugin):
├── typescript/
│   ├── ts-strict      — Enforce strict TypeScript
│   ├── ts-migrate     — JS → TS migration
│   └── ts-refactor    — Type-safe refactoring
├── react/
│   ├── component-gen  — Generate components
│   └── hook-extract   — Extract custom hooks
└── built-in/
    ├── code-review    — Code review mode
    ├── security-scan  — Security audit
    └── test-gen       — Test generation

Trust Level 색상:
  🟢 official   — 공식 플러그인 (자동 신뢰)
  🔵 verified   — 검증된 커뮤니티 (auto-promote 통과)
  🟡 community  — 커뮤니티 (설치 시 승인 필요)
  ⚪ local      — 로컬/프로젝트 플러그인
```

### 27.3 Interactive Selection (TUI)

```
TUI 인터랙션 모델:

Navigation:
  ↑/↓         — 트리 노드 간 이동
  ←/→         — 트리 접기/펼치기
  Space        — 노드 expand/collapse 토글
  Enter        — 선택된 항목 실행/상세보기
  Tab          — 검색 필터 활성화
  Esc          — 검색 닫기 / 이전 화면
  q            — 트리 뷰 종료

Search Filter (Tab 활성화):
  ┌─────────────────────────────────────┐
  │ 🔍 Filter: react                    │
  ├─────────────────────────────────────┤
  │ ├── 🟢 @yuaone/plugin-react v1.0.0 │
  │ │   ├── component-gen               │
  │ │   └── hook-extract                │
  │ └── 🟡 community/react-patterns    │
  │     └── pattern-library             │
  └─────────────────────────────────────┘

색상 코딩 (Ink/Chalk 기반):
  green     — official trust, enabled 상태
  blue      — verified trust
  yellow    — community trust, 주의 필요
  gray      — disabled 상태
  red       — 에러/보안 경고
  cyan      — 현재 선택된 노드 (커서)
  dim       — 비활성/접힌 노드

구현 참고:
  - 기존 TUI 프레임워크 활용 (packages/yuan-cli/src/tui/)
  - Ink React 컴포넌트로 트리 렌더링
  - useInput() 훅으로 키보드 이벤트 처리
  - useFocusManager()로 포커스 관리
```

### 27.4 Plugin Search Results (Marketplace)

```
/plugins search react 실행 시:

🔍 Marketplace Search: "react" (12 results)

 #  Name                           Version  ⭐   Downloads  Trust
 1  @yuaone/plugin-react           v1.2.0   4.8  12,340     official
 2  @yuaone/plugin-react-native    v1.0.0   4.5   3,210     official
 3  community/react-patterns       v0.5.2   4.2   1,890     verified
 4  community/react-testing-pro    v0.3.0   4.0     654     community
 5  community/react-hook-master    v0.2.1   3.8     321     community

[↑↓ Navigate] [Enter Install] [i Info] [q Quit]

상세 정보 (i 키):
┌─────────────────────────────────────────────┐
│ @yuaone/plugin-react v1.2.0                 │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│ React/Next.js 전문 에이전트 스킬팩          │
│                                             │
│ Skills: bugfix, refactor, test, ssr         │
│ Tools:  component-tree, jsx-analyzer        │
│ Size:   42 KB                               │
│ License: MIT                                │
│ Requires: yuan >=0.2.0                      │
│                                             │
│ [Install] [Back]                            │
└─────────────────────────────────────────────┘
```

---

## 28. Task Classification Router (태스크 분류 라우터)

> 기존 TaskClassifier(695 LOC, task-classifier.ts)를 확장하여 전문 에이전트 라우팅을 지원.

### 28.1 확장 TaskType 정의

```
기존 8개 TaskType:
  debug, feature, refactor, test, explain, search, config, deploy

신규 6개 TaskType 추가:
  design       — UI/UX 설계, 컴포넌트 아키텍처
  security     — 보안 스캔, 취약점 패치, 인증 강화
  infra        — CI/CD, Docker, k8s, 인프라 설정
  performance  — 성능 최적화, 번들 사이즈, 메모리 누수
  migration    — 프레임워크/라이브러리 버전 마이그레이션
  documentation — API 문서, JSDoc, README 생성

총 14개 TaskType → TaskType enum 확장
```

### 28.2 Specialist Agent Routing

```typescript
export interface TaskClassification {
  taskType: TaskType;
  confidence: number;          // 0-1
  specialist: string | null;   // 전문 에이전트 ID (confidence > 0.7일 때)
  activatedSkills: string[];   // 태스크에 맞는 플러그인 스킬
  toolSequence: string[];      // 추천 도구 시퀀스
}

export interface SpecialistRouting {
  taskType: TaskType;
  specialistId: string;
  fallbackToGeneral: boolean;  // 전문가 실패 시 일반 에이전트 폴백
}
```

### 28.3 분류 → 라우팅 흐름

```
User Request
  → TaskClassifier.classify(request)
  → TaskClassification { taskType, confidence, ... }
  → confidence > 0.7?
      YES → Specialist Agent 선택 (§29)
            + PluginRegistry에서 관련 스킬 자동 활성화
      NO  → General Agent (기존 방식)
            + 관련 스킬은 힌트로만 제공

PluginRegistry 연동:
  TaskType → Plugin trigger 매칭
  예: taskType="security" → @yuaone/plugin-security 자동 활성화
  예: taskType="debug" + framework="react" → @yuaone/plugin-react bugfix 스킬

Confidence Threshold 정책:
  > 0.9  → 전문가 직행 + 스킬 강제 적용
  > 0.7  → 전문가 + 스킬 추천
  > 0.5  → 일반 에이전트 + 스킬 힌트
  < 0.5  → 일반 에이전트 only (분류 불확실)
```

---

## 29. Specialist Agent Framework (전문 에이전트 프레임워크)

> 도메인별 전문 지식이 사전 탑재된 에이전트. TaskClassifier 결과에 따라 자동 선택.

### 29.1 Specialist 목록

```
Specialist ID              Domain              Typical Tasks
─────────────────────────────────────────────────────────────────
typescript-specialist      TypeScript          타입 에러, strict 마이그레이션, 제네릭
react-specialist           React/Next.js       hydration, hooks, SSR, 컴포넌트 설계
infra-specialist           DevOps/Infra        Docker, CI/CD, k8s, 클라우드 설정
testing-specialist         Testing             테스트 작성, 커버리지, mocking 전략
security-specialist        Security            취약점, 인증, 인가, 시크릿 관리
python-specialist          Python              Django, FastAPI, 타이핑, 패키지 관리
database-specialist        Database            쿼리 최적화, 마이그레이션, 스키마 설계
```

### 29.2 SpecialistConfig

```typescript
export interface SpecialistConfig {
  id: string;                    // "react-specialist"
  domain: string;                // "React/Next.js"
  systemPrompt: string;          // 도메인 전문 시스템 프롬프트
  preferredTools: string[];      // ["file_read", "grep", "file_edit", "shell_exec"]
  preferredSkills: string[];     // ["react/bugfix", "react/refactor", "react/ssr"]
  qualityThreshold: number;      // 0.8 — 이 이상이어야 결과 승인
  taskTypes: TaskType[];         // [TaskType.debug, TaskType.feature, TaskType.refactor]
  delegationRules: DelegationRule[];  // 서브태스크 위임 규칙
}

export interface DelegationRule {
  condition: string;             // "needs test generation"
  delegateTo: string;            // "testing-specialist"
  context: string;               // 위임 시 전달할 컨텍스트
}
```

### 29.3 Specialist 실행 흐름

```
TaskClassifier → react-specialist 선택
  1. Specialist 시스템 프롬프트 로드 (React 전문 지식)
  2. preferredSkills 자동 활성화 (react/bugfix 등)
  3. preferredTools 우선 사용 (불필요한 도구 호출 감소)
  4. 작업 수행
  5. 서브태스크 필요 시 → delegationRules 체크
     예: "테스트 필요" → testing-specialist에 위임
  6. 결과 quality 검증 (qualityThreshold 이상인지)
  7. 미달 시 → 재시도 or general agent 폴백

예시: hydration 에러 디버깅
  User: "이 hydration 에러 고쳐줘"
  → TaskClassifier: { taskType: "debug", confidence: 0.92 }
  → react-specialist 선택
  → react/bugfix 스킬 + react/ssr 스킬 활성화
  → hook-loop-fix 전략 적용
  → 수정 완료 → testing-specialist에 테스트 생성 위임
  → 테스트 통과 확인 → 완료
```

### 29.4 SubAgent 시스템 연동

```
기존 SubAgent + SubAgentRole 시스템과 통합:

SpecialistAgent extends SubAgent {
  role: SubAgentRole = "specialist"
  config: SpecialistConfig

  // Specialist는 자신의 도메인 내에서 독립적으로 작업
  // 다른 Specialist에게 위임 가능 (delegation)
  // 메인 AgentLoop이 최종 검증 (§24 Deliberation Layer)
}

메인 AgentLoop ↔ Specialist 관계:
  - 메인이 Specialist 선택 + 디스패치
  - Specialist가 독립 실행 (자체 iteration loop)
  - 결과를 메인에 반환 (VerificationReport 포함, §24.4)
  - 메인이 최종 검증 + 사용자 응답
```

---

## 30. Memory & Experience System (메모리/경험 학습 시스템)

> 기존 MemoryManager(742 LOC) + MemoryUpdater(654 LOC)를 확장하여 레포별 패턴 학습.

### 30.1 RepoProfile 스키마

```typescript
export interface RepoProfile {
  repoId: string;                    // git remote URL hash
  lastUpdated: string;               // ISO timestamp
  framework: FrameworkInfo;
  conventions: CodeConventions;
  errorPatterns: ErrorPattern[];
  toolPreferences: ToolPreference[];
}

export interface FrameworkInfo {
  language: string;                  // "typescript"
  frameworks: string[];              // ["react", "next"]
  frameworkVersions: Record<string, string>; // { "react": "18.3", "next": "14.2" }
  packageManager: "pnpm" | "npm" | "yarn" | "bun";
  testFramework: string;             // "vitest"
  bundler: string;                   // "webpack" | "vite" | "turbopack"
}

export interface CodeConventions {
  pathAliases: Record<string, string>;  // { "@/": "src/", "~/": "src/" }
  namingConvention: "camelCase" | "snake_case" | "PascalCase";
  fileNaming: "kebab-case" | "camelCase" | "PascalCase";
  componentPattern: "function" | "arrow" | "class";
  importOrder: string[];              // ["react", "next", "@/", "./"]
  indentation: "tabs" | "spaces";
  indentSize: number;                 // 2 or 4
}

export interface ErrorPattern {
  pattern: string;                   // regex or keyword
  frequency: number;                 // 발생 횟수
  lastSeen: string;                  // ISO timestamp
  typicalFix: string;               // 일반적 해결법 요약
  relatedFiles: string[];            // 관련 파일 패턴
}
```

### 30.2 Experience Entry 스키마

```typescript
export interface ExperienceEntry {
  id: string;
  timestamp: string;
  taskType: TaskType;
  taskSummary: string;
  approach: string;                  // 어떤 접근법을 사용했는지
  outcome: "success" | "partial" | "failure";
  lessonsLearned: string[];          // 배운 점
  toolsUsed: string[];               // 사용한 도구 목록
  filesChanged: string[];            // 변경한 파일
  tokensUsed: number;
  iterationCount: number;
  confidence: number;                // 0-1, 시간에 따라 감소
}

export interface LearningEvent {
  type: "success" | "failure" | "correction" | "pattern";
  source: string;                    // "agent_run" | "user_correction" | "test_result"
  data: Record<string, unknown>;
  weight: number;                    // 학습 신호 강도
}
```

### 30.3 학습 트리거 & 흐름

```
학습 트리거:
  1. 에이전트 실행 완료 후 → 성공/실패 패턴 분석
  2. 유저 수정 감지 (에이전트 결과를 유저가 고침) → 높은 학습 신호
  3. 빌드/테스트 결과 → 무엇이 깨지고 무엇이 통과했는지
  4. 반복 에러 패턴 → ErrorPattern 엔트리 생성

학습 흐름:
  Agent Run 완료
    → MemoryUpdater.analyzeRun(runResult)
    → ExperienceEntry 생성
    → RepoProfile 업데이트 (새 패턴, 컨벤션 변화)
    → .yuan/memory/repo-profile.json 저장
    → .yuan/memory/experiences/ 에 엔트리 저장

경험 재생 (Experience Replay):
  새 태스크 시작 전
    → TaskClassifier 결과 기반으로 관련 경험 검색
    → 상위 3개 경험을 컨텍스트에 주입
    → "이전에 비슷한 작업에서 이렇게 했고 결과가 이랬다"

Confidence Decay:
  - 새 경험: confidence = 1.0
  - 매일 -0.01 감소
  - 30일 후: confidence = 0.7 (여전히 유효)
  - 90일 후: confidence = 0.1 (거의 무시)
  - 관련 경험이 다시 성공하면 confidence 리셋
```

### 30.4 저장 구조

```
.yuan/
├── memory/
│   ├── repo-profile.json           ← 레포 프로필 (프레임워크, 컨벤션, 에러 패턴)
│   ├── experiences/
│   │   ├── 2026-03-10-debug-001.json
│   │   ├── 2026-03-10-feature-002.json
│   │   └── ...
│   └── learning-log.jsonl          ← LearningEvent 스트림 (append-only)
```

---

## 31. Tool Planning Layer (도구 계획 레이어)

> 추론과 실행 사이에 명시적 계획 단계를 추가. 불필요한 도구 호출을 줄이고 토큰 절약.

### 31.1 Module: tool-planner.ts

```typescript
export interface ToolPlan {
  taskType: TaskType;
  steps: PlannedStep[];
  estimatedToolCalls: number;
  estimatedTokens: number;
  adaptations: string[];           // Memory 시스템 기반 조정사항
}

export interface PlannedStep {
  order: number;
  tool: string;                    // "grep", "file_read", "file_edit", ...
  purpose: string;                 // "관련 파일 찾기", "컨텍스트 이해", ...
  args?: Record<string, unknown>;  // 사전에 알 수 있는 인자
  conditional?: string;            // "이전 단계에서 에러 발견 시만"
  skipIf?: string;                 // "파일 경로를 이미 아는 경우"
}
```

### 31.2 TaskType별 기본 도구 시퀀스

```
debug:
  1. grep (에러 패턴 검색)
  2. file_read (에러 발생 파일 읽기)
  3. [analyze — LLM 추론]
  4. file_edit (수정 적용)
  5. shell_exec: tsc --noEmit (타입 체크)
  6. shell_exec: test (관련 테스트 실행)

feature:
  1. file_read (관련 기존 코드 컨텍스트)
  2. file_write (새 파일 생성)
  3. file_edit (기존 파일에 통합)
  4. shell_exec: tsc --noEmit
  5. shell_exec: test
  6. git_commit

refactor:
  1. grep (리팩토링 대상 검색)
  2. file_read (전체 컨텍스트 파악)
  3. file_edit (리팩토링 적용)
  4. shell_exec: tsc --noEmit
  5. shell_exec: test (회귀 테스트)

security:
  1. shell_exec: security_scan (초기 스캔)
  2. file_read (취약점 파일 읽기)
  3. file_edit (패치 적용)
  4. shell_exec: security_scan (검증 스캔)

performance:
  1. file_read (병목 파일 읽기)
  2. grep (비효율 패턴 검색)
  3. file_edit (최적화 적용)
  4. shell_exec: build (번들 사이즈 비교)
  5. shell_exec: benchmark (성능 측정)
```

### 31.3 계획 최적화 로직

```
최적화 규칙:
  1. 이미 아는 정보 스킵:
     - 유저가 파일 경로를 알려줌 → grep 스킵
     - 이전 iteration에서 이미 읽은 파일 → file_read 스킵

  2. Memory 기반 조정:
     - RepoProfile.packageManager === "pnpm" → npm 명령 → pnpm 자동 변환
     - RepoProfile.testFramework === "vitest" → jest 명령 → vitest 변환
     - ErrorPattern에 "tsc 필수" 있으면 → tsc 단계 항상 포함

  3. 병렬 가능 단계 식별:
     - grep + file_read → 병렬 가능 (서로 독립)
     - file_edit → file_read 후에만 (의존성)

  4. 조건부 단계:
     - "에러 발견 시만 file_edit"
     - "테스트 실패 시만 재시도"

토큰 절약 효과 (예상):
  - 무계획 평균: 12 tool calls / task
  - 계획 적용: 7 tool calls / task (42% 감소)
  - 토큰 절약: ~40% per task

TaskClassifier 연동:
  - TaskClassification.toolSequence 필드 활용 (이미 존재)
  - ToolPlanner가 toolSequence를 상세 PlannedStep[]으로 확장
```

---

## 32. Long-Running Background Agents (지속형 백그라운드 에이전트)

> 코딩 세션 동안 백그라운드에서 지속적으로 모니터링하는 에이전트.

### 32.1 Background Agent 타입

```
Agent Type          Trigger              Output
──────────────────────────────────────────────────────────
test-watcher        파일 변경 감지        테스트 결과 (pass/fail)
perf-analyzer       빌드 완료 시          번들 사이즈, 빌드 시간 변화
security-scanner    파일 변경 감지        보안 취약점 경고
dependency-watcher  package.json 변경     outdated deps, 취약점, 라이선스
type-checker        .ts/.tsx 변경         타입 에러 목록
```

### 32.2 Architecture

```typescript
export abstract class BackgroundAgent extends EventEmitter {
  abstract readonly type: string;
  abstract readonly intervalMs: number;        // 체크 간격
  protected paused: boolean = false;

  abstract check(): Promise<BackgroundCheckResult>;
  abstract shouldRun(changedFiles: string[]): boolean;

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
}

export interface BackgroundCheckResult {
  agentType: string;
  timestamp: string;
  status: "ok" | "warning" | "error";
  findings: BackgroundFinding[];
  duration_ms: number;
}

export interface BackgroundFinding {
  severity: "info" | "warning" | "error" | "critical";
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}
```

### 32.3 구체 Agent 설계

```
test-watcher:
  - Trigger: .ts/.tsx/.js/.jsx 파일 변경 감지 (fs.watch)
  - Action: 변경된 파일과 관련된 테스트만 실행 (vitest --related)
  - Output: 테스트 결과를 HybridEventBus로 emit
  - Interval: 파일 변경 후 debounce 2초

perf-analyzer:
  - Trigger: 빌드 완료 이벤트
  - Action: 빌드 산출물 사이즈 비교 (이전 vs 현재)
  - Output: 사이즈 변화 리포트 (증가 시 warning)
  - Threshold: >5% 증가 = warning, >15% 증가 = error

security-scanner:
  - Trigger: 파일 변경 감지
  - Action: 변경 파일에서 보안 패턴 스캔 (eval, innerHTML, SQL 인젝션 등)
  - Output: 취약점 목록 + 심각도
  - Integration: §15 보안 레이어 재사용

dependency-watcher:
  - Trigger: package.json / pnpm-lock.yaml 변경
  - Action: npm audit, outdated 체크
  - Output: 취약 패키지 목록, 업데이트 권장
  - Interval: 변경 감지 시 즉시 + 세션 시작 시 1회

type-checker:
  - Trigger: .ts/.tsx 파일 변경
  - Action: tsc --noEmit --watch (이미 실행 중이면 결과만 수집)
  - Output: 새로 발생한 타입 에러 목록
  - Dedup: 이전에 이미 알려진 에러는 재보고 안 함
```

### 32.4 리소스 제어

```
CPU/Memory 제한:
  - Background agent 전체: CPU 25% cap (nice 값 조정)
  - 개별 agent: 메모리 100MB 제한
  - 메인 에이전트 작업 중: 자동 pause (CPU 경합 방지)
  - 메인 에이전트 idle 시: resume

우선순위 모델:
  Main Agent     → P0 (항상 최우선)
  type-checker   → P1 (가장 자주 필요)
  test-watcher   → P2 (파일 변경 시)
  security-scan  → P3 (변경 시)
  perf-analyzer  → P4 (빌드 후)
  dep-watcher    → P5 (가장 낮음)

CLI 통합:
  Ctrl+O  → 백그라운드 에이전트 관리 패널 (TUI에 이미 개념 존재)
  상태바  → 백그라운드 에이전트 상태 아이콘 표시
            ✓ = 전부 OK, ⚠ = 경고 있음, ✗ = 에러 있음
```

### 32.5 HybridEventBus 연동

```
Background Agent → HybridEventBus Event 흐름:

BackgroundAgent.check()
  → BackgroundCheckResult
  → HybridEventBus.emit("background:finding", finding)
  → MainAgent가 구독 → 관련 작업 중이면 즉시 반영
  → TUI가 구독 → 상태바 업데이트 + 알림

Event Types:
  "background:test:pass"       — 테스트 통과
  "background:test:fail"       — 테스트 실패 (⚠ 알림)
  "background:security:alert"  — 보안 경고 (🔴 즉시 알림)
  "background:type:error"      — 새 타입 에러
  "background:perf:regression" — 성능 회귀 감지
  "background:dep:vulnerable"  — 취약한 의존성 발견
```

---

## 33. Repo Knowledge Graph (코드베이스 지식 그래프)

> 코드베이스의 구조적 관계를 그래프로 모델링. 영향 분석, 리팩토링 안전성, 데드코드 탐지 지원.

### 33.1 Graph Schema

```typescript
export interface GraphNode {
  id: string;                      // "src/auth.ts::AuthService"
  type: "file" | "class" | "function" | "variable" | "interface" | "type" | "module";
  name: string;
  filePath: string;
  line: number;
  metadata: Record<string, unknown>;  // 추가 정보 (exported, async, generic 등)
}

export interface GraphEdge {
  source: string;                  // source node id
  target: string;                  // target node id
  type: "imports" | "calls" | "extends" | "implements" | "depends_on" | "exports" | "uses";
  weight: number;                  // 관계 강도 (1=직접, 0.5=간접)
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  lastUpdated: string;
  fileHashes: Record<string, string>;  // 변경 감지용 파일 해시
}

export interface ImpactRadius {
  changedNode: string;             // 변경된 노드
  directlyAffected: string[];     // 직접 영향 (1-hop)
  indirectlyAffected: string[];   // 간접 영향 (2+ hop)
  totalAffected: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  suggestedTests: string[];        // 영향받는 테스트 파일
}
```

### 33.2 Graph Construction

```
빌드 소스:
  TypeScript:
    - TypeScript Compiler API (ts.createProgram → AST 순회)
    - import/export 관계 추출
    - 함수 호출 관계 추출
    - 클래스 상속/구현 관계 추출

  Other Languages:
    - tree-sitter (Python, Go, Rust, Java 등)
    - 동일한 GraphNode/GraphEdge로 정규화

빌드 흐름:
  1. 프로젝트 최초 로드 → 전체 파일 파싱 (초기 비용 1회)
  2. 파일 변경 감지 → 변경된 파일만 재파싱 (incremental)
  3. 그래프 업데이트 → 변경된 노드/엣지만 교체
  4. .yuan/knowledge-graph.json 저장 (incremental write)

성능 목표:
  - 1000 파일 프로젝트: 초기 빌드 < 10초
  - 단일 파일 변경: 업데이트 < 500ms
  - 그래프 쿼리: < 50ms
```

### 33.3 Query API

```typescript
export class KnowledgeGraphQuery {
  // 이 함수를 호출하는 모든 곳 찾기
  findCallers(functionId: string): GraphNode[];

  // 이 파일에 의존하는 모든 파일 찾기
  findDependents(filePath: string): GraphNode[];

  // 이 심볼을 변경하면 영향받는 범위
  getImpactRadius(symbolId: string, depth?: number): ImpactRadius;

  // 이 인터페이스를 구현하는 모든 클래스
  findImplementors(interfaceId: string): GraphNode[];

  // 아무도 사용하지 않는 exported 심볼 (데드코드)
  findDeadCode(): GraphNode[];

  // 두 노드 간 최단 경로 (의존성 체인)
  findPath(sourceId: string, targetId: string): GraphNode[];

  // 순환 의존성 탐지
  findCircularDependencies(): GraphEdge[][];
}
```

### 33.4 Agent 통합

```
에이전트가 Knowledge Graph를 사용하는 시나리오:

1. 리팩토링 안전성 확인:
   "이 함수 이름을 바꾸면 어디가 깨지나?"
   → graph.findCallers(fn) → 모든 호출처 목록
   → 자동으로 모든 호출처 수정

2. 영향 범위 분석 (file_edit 전):
   "이 파일 수정하면 blast radius는?"
   → graph.getImpactRadius(file) → 영향받는 파일 목록
   → Level 2 Deep Verify 트리거 여부 판단 (§24)

3. 데드코드 정리:
   "사용 안 되는 코드 찾아줘"
   → graph.findDeadCode() → 미사용 exports 목록
   → 안전하게 삭제 가능한 코드 식별

4. 테스트 대상 추천:
   "이 수정에 대해 어떤 테스트를 돌려야 하나?"
   → graph.getImpactRadius(changedSymbol).suggestedTests
   → test-watcher (§32)에 전달

Cursor/Copilot 차별화:
  - 단순 grep이 아닌 AST 기반 정확한 관계 분석
  - 크로스파일 의존성 추적 (import chain 전체)
  - 영향 범위 정량화 (riskLevel + affected count)
  - 리팩토링 시 자동 전파 수정
```

### 33.5 Storage

```
.yuan/
├── knowledge-graph.json            ← 전체 그래프 (노드 + 엣지)
├── graph-hashes.json               ← 파일별 해시 (incremental 판단용)
└── graph-cache/
    ├── file-nodes/                 ← 파일별 노드 캐시 (빠른 부분 로드)
    │   ├── src-auth-ts.json
    │   └── src-api-router-ts.json
    └── impact-cache/               ← 자주 쿼리되는 impact radius 캐시
        └── ...
```

---

## 34. Self-Debugging Loop (자동 디버깅 루프)

> 기존 AutoFixLoop(478 LOC)를 확장. 5단계 에스컬레이션 전략으로 더 공격적인 자동 수정.

### 34.1 5단계 에스컬레이션 전략

```
Attempt 1 — Direct Fix (직접 수정)
  → 에러 메시지 읽기 → 해당 줄 수정
  → 가장 빠르고 저렴 (~200 토큰)
  → 성공률: ~60% (단순 에러)

Attempt 2 — Context Expansion (컨텍스트 확장)
  → 관련 파일 추가 읽기 (imports, callers)
  → Knowledge Graph (§33) 활용하여 관련 파일 식별
  → 전체 흐름 이해 후 수정
  → 비용: ~500 토큰
  → 성공률: ~75% (컨텍스트 부족이 원인일 때)

Attempt 3 — Alternative Approach (대안 접근)
  → 이전 수정과 다른 전략 시도
  → SelfReflection (§24)으로 이전 실패 원인 분석
  → "왜 이전 수정이 실패했는지" 명시적 추론
  → 비용: ~800 토큰
  → 성공률: ~85% (잘못된 가정이 원인일 때)

Attempt 4 — Rollback + Fresh Approach (롤백 + 새 시작)
  → git stash로 모든 변경 롤백
  → 처음부터 다른 접근법으로 재시도
  → DebateOrchestrator (§24.5)로 전략 협의
  → 비용: ~1500 토큰
  → 성공률: ~90%

Attempt 5 — Escalate to User (사용자 에스컬레이션)
  → 자동 수정 포기
  → 상세 진단 보고서 생성:
    - 시도한 접근법 4개와 각 실패 이유
    - 근본 원인 가설 (CausalChain, §24.3)
    - 추천 수동 수정 방향
    - 관련 파일 + 줄 번호
  → 유저에게 선택지 제시
```

### 34.2 Causal Analysis 통합

```
Self-Debugging Loop + CausalChain (§24.3):

매 attempt 후:
  1. 에러 증상 추출
  2. 가설 생성 (LLM, cheap model)
  3. 증거 수집 (grep, file_read)
  4. 근본 원인 판정
  5. 근본 원인 기반 수정 (증상 아닌 원인 해결)

예시:
  증상: "TypeError: Cannot read property 'map' of undefined"
  가설 1: "API 응답이 null" → 증거: API 코드 확인 → 지지
  가설 2: "초기 state가 undefined" → 증거: store 확인 → 지지
  가설 3: "타입이 잘못됨" → 증거: 타입 확인 → 미지지
  판정: 가설 2 (초기 state) → store에서 초기값 설정 → 근본 수정
```

### 34.3 Test Isolation 전략

```
테스트 실행 최적화:

Phase 1 — Failing Tests Only (빠른 피드백)
  → 실패한 테스트만 재실행
  → Knowledge Graph로 관련 테스트 식별
  → ~5초 (전체 대비 90% 시간 절약)

Phase 2 — Related Tests (안전 확인)
  → 수정된 파일에 의존하는 테스트 실행
  → graph.getImpactRadius().suggestedTests
  → ~30초

Phase 3 — Full Suite (최종 검증)
  → 전체 테스트 실행
  → 마지막 attempt 또는 최종 완료 시에만
  → ~2-5분

테스트 실패 분석 자동화:
  → 실패 메시지 파싱
  → expected vs actual 추출
  → 관련 코드 자동 탐색
  → 수정 제안 생성
```

### 34.4 Metrics & Tracking

```typescript
export interface SelfDebugMetrics {
  totalRuns: number;
  fixSuccessRate: number;          // 자동 수정 성공률
  averageAttempts: number;         // 평균 시도 횟수
  averageTimeToFix: number;       // 평균 수정 시간 (ms)
  escalationRate: number;          // 유저 에스컬레이션 비율
  strategyBreakdown: {
    directFix: { attempts: number; successes: number };
    contextExpansion: { attempts: number; successes: number };
    alternativeApproach: { attempts: number; successes: number };
    rollbackFresh: { attempts: number; successes: number };
    escalated: number;
  };
}
```

---

## 35. Skill Learning — Self-Improving Agent (자기 개선 에이전트)

> **CRITICAL FEATURE**: YUAN이 자신의 경험으로부터 새 스킬을 자동 생성하고 진화시킴.
> 기존 플러그인 스킬은 정적(predefined). 이 시스템은 동적 스킬 생성.

### 35.1 LearnedSkill 스키마

```typescript
export interface LearnedSkill {
  id: string;                      // "ls-react-hydration-fix-001"
  pattern: string;                 // 매칭 패턴 (에러 메시지, 코드 패턴 등)
  patternType: "error" | "code" | "task" | "context";
  diagnosis: string;               // 문제 진단 설명
  strategy: SkillStrategy;         // 해결 전략
  validation: SkillValidation;     // 성공 검증 방법
  confidence: number;              // 0-1 (동적 변화)
  usageCount: number;
  successCount: number;
  failureCount: number;
  lastUsed: string;                // ISO timestamp
  createdAt: string;
  createdFrom: string;             // "run:abc123" — 어떤 실행에서 학습했는지
  tags: string[];                  // ["react", "hydration", "ssr"]
  deprecated: boolean;             // confidence < 0.2이면 true
}

export interface SkillStrategy {
  approach: string;                // 접근법 설명
  toolSequence: string[];          // 추천 도구 시퀀스
  codePatterns: string[];          // 적용할 코드 패턴
  avoidPatterns: string[];         // 피해야 할 패턴
}

export interface SkillValidation {
  method: "build" | "test" | "typecheck" | "manual";
  command?: string;                // 검증 명령어
  expectedOutcome: string;         // 기대 결과 설명
}
```

### 35.2 SkillLearner Class

```typescript
export class SkillLearner {
  /**
   * 에이전트 실행 결과를 분석하여 새 스킬 추출
   * - 에러 패턴 + 성공적 수정 → 학습 가능한 스킬
   * - 실패한 실행에서는 학습하지 않음 (노이즈 방지)
   */
  extractSkillFromRun(runAnalysis: RunAnalysis): LearnedSkill | null;

  /**
   * 스킬 사용 후 confidence 업데이트
   * - 성공: confidence += 0.1 (max 0.95)
   * - 실패: confidence -= 0.2
   */
  updateSkillConfidence(skillId: string, success: boolean): void;

  /**
   * 현재 컨텍스트에 관련된 학습 스킬 검색
   * - 에러 메시지 매칭
   * - 태스크 타입 매칭
   * - 파일 패턴 매칭
   * - confidence 순으로 정렬
   */
  getRelevantLearnedSkills(context: SkillContext): LearnedSkill[];

  /**
   * confidence < 0.2인 스킬 정리
   * - deprecated 마킹
   * - 90일 이상 미사용 + deprecated → 삭제
   */
  pruneDeprecatedSkills(): void;

  /**
   * 유저 수정으로부터 학습 (최고 신호)
   * - 에이전트 결과를 유저가 고쳤을 때
   * - 유저의 수정 패턴을 새 스킬로 변환
   */
  learnFromUserCorrection(
    agentResult: AgentResult,
    userCorrection: UserCorrection
  ): LearnedSkill | null;
}
```

### 35.3 Skill Evolution (진화) 모델

```
Confidence Lifecycle:

  Created (0.5) → Used Successfully (0.6) → ... → Mature (0.9)
       ↓                                              ↓
  Failed (0.3) → Failed Again (0.1) → Deprecated (< 0.2) → Pruned (삭제)

상세 규칙:
  새 스킬 생성:        confidence = 0.5
  성공적 사용:         confidence += 0.1 (max 0.95)
  실패:               confidence -= 0.2
  유저가 수정 기반:    confidence = 0.7 (높은 초기값, 유저 신호)
  30일 미사용:         confidence -= 0.05
  confidence < 0.2:    deprecated = true
  deprecated + 90일:   파일 삭제

결코 1.0에 도달하지 않음 (0.95 max):
  → 학습 스킬은 항상 공식 스킬보다 낮은 우선순위
  → 공식 스킬과 충돌 시 공식 스킬 우선
```

### 35.4 Learning Sources

```
학습 소스별 신호 강도:

Source                          Weight    설명
───────────────────────────────────────────────────────
유저 수정 (user correction)     1.0       에이전트 결과를 유저가 직접 고침
코드 리뷰 피드백                0.8       리뷰어 코멘트에서 패턴 추출
성공한 에러 수정                0.6       에러 → 수정 → 테스트 통과
테스트 결과                     0.5       무엇이 테스트를 통과/실패시키는지
반복 패턴                       0.4       같은 에러가 3회+ 발생
실패한 수정 (반면교사)          0.3       이렇게 하면 안 된다 학습

학습 품질 필터:
  - 너무 일반적인 패턴 제외 ("SyntaxError" 같은)
  - 프로젝트 특정 패턴만 학습 (범용 지식은 플러그인 담당)
  - 최소 2회 이상 유사 패턴 등장 시에만 스킬 생성 (노이즈 필터)
```

### 35.5 Storage & Privacy

```
Storage:
  .yuan/
  └── learned-skills/
      ├── ls-react-hydration-fix-001.json
      ├── ls-pnpm-workspace-resolve-002.json
      ├── ls-prisma-migration-003.json
      └── _index.json                 ← 스킬 목록 인덱스 (빠른 검색)

Privacy 규칙:
  1. 학습 스킬은 프로젝트 로컬 전용 (.yuan/ 디렉토리)
  2. 서버에 업로드하지 않음 (NEVER)
  3. 다른 프로젝트와 공유하지 않음 (프로젝트별 독립)
  4. .gitignore에 .yuan/learned-skills/ 포함 권장
  5. 유저가 /skills learned 명령으로 학습 스킬 열람 가능
  6. 유저가 /skills forget <id> 명령으로 삭제 가능

공식 스킬과의 관계:
  - 공식 플러그인 스킬: priority = 1.0 (항상 우선)
  - 학습 스킬: priority = confidence * 0.8 (max 0.76)
  - 충돌 시: 공식 스킬이 이김
  - 학습 스킬이 충분히 성숙하면 → 공식 플러그인 스킬로 승격 제안
    (유저에게 "이 패턴을 플러그인으로 만들까요?" 제안)
```

### 35.6 CLI Integration

```
/skills learned                    — 학습된 스킬 목록
/skills learned --verbose          — 상세 정보 (confidence, usage, created from)
/skills forget <id>                — 특정 학습 스킬 삭제
/skills forget --all               — 모든 학습 스킬 초기화
/skills promote <id>               — 학습 스킬을 로컬 플러그인 스킬로 승격
/skills export <id>                — 학습 스킬을 공유 가능한 형태로 내보내기

자동 알림:
  "새 스킬을 학습했습니다: react hydration fix (confidence: 0.5)"
  "스킬 성숙: pnpm-workspace-resolve (confidence: 0.8, 5회 성공)"
  "스킬 폐기: old-pattern-001 (confidence: 0.15, deprecated)"
```

---

*Last updated: 2026-03-10*
*Author: YUAN Team*
*Reviewed by: QA Agent (Claude Code) + GPT Cross-review*
