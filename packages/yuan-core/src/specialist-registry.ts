/**
 * @module specialist-registry
 * @description Specialist Agent Registry — Domain-specific agent configurations.
 *
 * Each specialist has pre-loaded expertise, preferred tools, and quality thresholds.
 * Routing: TaskClassifier -> SpecialistRegistry -> specialist config -> SubAgent
 */

// ─── Types ───

/** Configuration for a domain specialist agent */
export interface SpecialistConfig {
  /** Unique specialist ID */
  id: string;
  /** Display name */
  name: string;
  /** Domain description */
  domain: string;
  /** System prompt prefix for this specialist */
  systemPrompt: string;
  /** Preferred tools (ordered by priority) */
  preferredTools: string[];
  /** Plugin skills to auto-activate */
  preferredSkills: string[];
  /** Minimum quality threshold for output (0–1) */
  qualityThreshold: number;
  /** Languages this specialist handles */
  languages?: string[];
  /** Frameworks this specialist handles */
  frameworks?: string[];
  /** Can delegate to these other specialists */
  canDelegateTo?: string[];
}

/** Result of matching a specialist to a task */
export interface SpecialistMatch {
  /** The matched specialist configuration */
  specialist: SpecialistConfig;
  /** Confidence of the match (0–1) */
  confidence: number;
  /** Reason for the match */
  reason: string;
}

// ─── SpecialistRegistry Class ───

/**
 * Registry for domain-specific specialist agent configurations.
 *
 * Manages built-in and custom specialists that can be matched to tasks
 * based on type, language, framework, and error context.
 *
 * @example
 * ```typescript
 * const registry = new SpecialistRegistry();
 *
 * // Find best specialist for a TypeScript security task
 * const match = registry.findSpecialist("security", {
 *   language: "typescript",
 * });
 * if (match) {
 *   console.log(match.specialist.name); // "Security Specialist"
 *   console.log(match.confidence);      // 0.9
 * }
 *
 * // Register a custom specialist
 * registry.register({
 *   id: "rust-specialist",
 *   name: "Rust Specialist",
 *   domain: "Rust systems programming",
 *   systemPrompt: "You are a Rust expert...",
 *   preferredTools: ["file_read", "file_edit", "shell_exec"],
 *   preferredSkills: ["cargo-check", "clippy-lint"],
 *   qualityThreshold: 0.85,
 *   languages: ["rust"],
 * });
 * ```
 */
export class SpecialistRegistry {
  private specialists: Map<string, SpecialistConfig> = new Map();

  constructor() {
    this.registerBuiltins();
  }

  /**
   * Register a specialist configuration.
   * If a specialist with the same ID exists, it is replaced.
   *
   * @param config - Specialist configuration to register
   */
  register(config: SpecialistConfig): void {
    this.specialists.set(config.id, config);
  }

  /**
   * Find the best specialist for a given task type and context.
   *
   * Matching priority:
   * 1. Exact task type match
   * 2. Language/framework affinity bonus
   * 3. Error message pattern match
   *
   * @param taskType - Task type string (from TaskClassifier)
   * @param context - Optional context for better matching
   * @returns Best matching specialist or null if none found
   */
  findSpecialist(
    taskType: string,
    context?: {
      language?: string;
      framework?: string;
      errorMessage?: string;
    },
  ): SpecialistMatch | null {
    const candidates: SpecialistMatch[] = [];

    for (const specialist of this.specialists.values()) {
      let confidence = 0;
      let reason = "";

      // 1. Domain match via specialist ID or domain keywords
      if (this.matchesDomain(specialist, taskType)) {
        confidence = 0.7;
        reason = `Domain match: ${specialist.domain}`;
      }

      // 2. Language affinity bonus
      if (
        context?.language &&
        specialist.languages?.some(
          (lang) => lang.toLowerCase() === context.language!.toLowerCase(),
        )
      ) {
        confidence += 0.15;
        reason += reason ? "; language match" : `Language match: ${context.language}`;
      }

      // 3. Framework affinity bonus
      if (
        context?.framework &&
        specialist.frameworks?.some(
          (fw) => fw.toLowerCase() === context.framework!.toLowerCase(),
        )
      ) {
        confidence += 0.1;
        reason += reason ? "; framework match" : `Framework match: ${context.framework}`;
      }

      // 4. Error message pattern match (for debugger/security specialists)
      if (context?.errorMessage && specialist.id === "security-specialist") {
        const securityPatterns = /xss|csrf|injection|auth|token|secret|vuln/i;
        if (securityPatterns.test(context.errorMessage)) {
          confidence += 0.15;
          reason += "; security error pattern detected";
        }
      }

      if (confidence > 0) {
        candidates.push({
          specialist,
          confidence: Math.min(1.0, confidence),
          reason,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Return highest confidence match (lexicographic tie-break for determinism)
    candidates.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.specialist.id.localeCompare(b.specialist.id);
    });
    return candidates[0];
  }

  /**
   * Get a specialist by its unique ID.
   *
   * @param id - Specialist ID
   * @returns Specialist config or undefined if not found
   */
  get(id: string): SpecialistConfig | undefined {
    return this.specialists.get(id);
  }

  /**
   * List all registered specialists.
   *
   * @returns Array of all specialist configurations
   */
  list(): SpecialistConfig[] {
    return Array.from(this.specialists.values());
  }

  /**
   * Remove a specialist by ID.
   *
   * @param id - Specialist ID to remove
   * @returns true if removed, false if not found
   */
  remove(id: string): boolean {
    return this.specialists.delete(id);
  }

  /**
   * Get the total number of registered specialists.
   */
  get size(): number {
    return this.specialists.size;
  }

  // ─── Private Helpers ───

  /**
   * Check if a specialist's domain matches the given task type.
   */
  private matchesDomain(specialist: SpecialistConfig, taskType: string): boolean {
    const normalizedType = taskType.toLowerCase();

    // Direct ID match patterns
    const domainMap: Record<string, string[]> = {
      "typescript-specialist": ["feature", "refactor", "config"],
      "react-specialist": ["feature", "design", "refactor"],
      "infra-specialist": ["infra", "deploy"],
      "testing-specialist": ["test"],
      "security-specialist": ["security"],
      "python-specialist": ["feature", "refactor"],
      "database-specialist": ["migration", "feature", "performance"],
      "performance-specialist": ["performance"],
    };

    const matchTypes = domainMap[specialist.id];
    if (matchTypes && matchTypes.includes(normalizedType)) {
      return true;
    }

    // Fallback: check domain description keywords
    return specialist.domain.toLowerCase().includes(normalizedType);
  }

  /**
   * Register all built-in specialist configurations.
   */
  private registerBuiltins(): void {
    // 1. TypeScript Specialist
    this.register({
      id: "typescript-specialist",
      name: "TypeScript Specialist",
      domain: "TypeScript type system, generics, and advanced patterns",
      systemPrompt: `You are a TypeScript expert. Your strength is leveraging the type system for maximum safety and developer experience.

Expertise:
- Strict mode, noUncheckedIndexedAccess, exactOptionalPropertyTypes
- Generic constraints, conditional types, mapped types, template literals
- Type inference optimization — let TS infer when possible, annotate when ambiguous
- Declaration files (.d.ts) for untyped dependencies
- tsconfig optimization for monorepos (composite, references, paths)
- Discriminated unions over type assertions; exhaustive switches with never

Rules:
- Never use \`any\` — use \`unknown\` with type guards instead
- Prefer \`interface\` for objects, \`type\` for unions/intersections/utility types
- Use \`satisfies\` for type-safe object literals with inference
- Export types explicitly; avoid re-exporting \`*\` from barrel files
- Use \`as const\` for literal type inference on constant arrays/objects`,
      preferredTools: ["file_read", "file_edit", "grep", "shell_exec"],
      preferredSkills: ["type-check", "tsconfig-lint"],
      qualityThreshold: 0.85,
      languages: ["typescript", "javascript"],
      frameworks: ["node", "deno", "bun"],
      canDelegateTo: ["react-specialist", "testing-specialist"],
    });

    // 2. React Specialist
    this.register({
      id: "react-specialist",
      name: "React Specialist",
      domain: "React, hooks, SSR/hydration, state management, and Next.js",
      systemPrompt: `You are a React expert. Your goal: build performant, accessible UI with clean component architecture.

Expertise:
- Hooks: useState, useEffect, useCallback, useMemo, useRef, custom hooks
- SSR/hydration pitfalls: useEffect vs useLayoutEffect, window checks, dynamic imports
- State management: Zustand, React Query/TanStack Query, context (sparingly)
- Performance: React.memo, useMemo, useCallback — only when measured as needed
- Next.js: App Router, Server Components, route handlers, middleware, ISR/SSG
- Suspense boundaries, error boundaries, streaming SSR

Rules:
- Prefer Server Components by default; use 'use client' only when needed
- Never store derived state — compute it during render
- Keep components small (<100 lines); extract hooks for reusable logic
- Use \`key\` prop correctly to avoid stale state bugs
- Always handle loading, error, and empty states
- Accessibility: semantic HTML, ARIA labels, keyboard navigation`,
      preferredTools: ["file_read", "file_edit", "file_write", "glob", "shell_exec"],
      preferredSkills: ["component-lint", "accessibility-check", "bundle-analyzer"],
      qualityThreshold: 0.80,
      languages: ["typescript", "javascript"],
      frameworks: ["react", "next.js", "remix", "gatsby"],
      canDelegateTo: ["typescript-specialist", "performance-specialist"],
    });

    // 3. Infrastructure Specialist
    this.register({
      id: "infra-specialist",
      name: "Infrastructure Specialist",
      domain: "DevOps, Docker, CI/CD, Terraform, Kubernetes, cloud services",
      systemPrompt: `You are an infrastructure and DevOps expert. Your goal: reliable, reproducible, secure deployments.

Expertise:
- Docker: multi-stage builds, layer caching, minimal images (distroless/alpine)
- CI/CD: GitHub Actions, GitLab CI, Jenkins — caching, matrix builds, artifact management
- Terraform/IaC: state management, modules, workspaces, drift detection
- Kubernetes: deployments, services, ingress, HPA, resource limits, health checks
- Cloud: AWS (ECS, Lambda, RDS, S3), GCP (Cloud Run, GKE), Azure basics
- Monitoring: Prometheus, Grafana, CloudWatch, structured logging, alerting rules

Rules:
- Always pin versions (Docker tags, Terraform providers, CI action versions)
- Secrets via env vars or secret managers — never hardcode
- Health checks on every service; graceful shutdown handlers
- Least-privilege IAM roles and network policies
- Idempotent deployments; rollback strategy for every change
- Cost awareness: right-size resources, use spot/preemptible when safe`,
      preferredTools: ["file_read", "file_edit", "shell_exec", "file_write"],
      preferredSkills: ["docker-lint", "terraform-validate", "cloud-cost-estimate"],
      qualityThreshold: 0.85,
      languages: ["yaml", "hcl", "bash", "typescript"],
      frameworks: ["docker", "kubernetes", "terraform", "github-actions"],
      canDelegateTo: ["security-specialist"],
    });

    // 4. Testing Specialist
    this.register({
      id: "testing-specialist",
      name: "Testing Specialist",
      domain: "Unit, integration, e2e testing, TDD, mocking, coverage",
      systemPrompt: `You are a testing expert. Your goal: comprehensive, maintainable tests that catch real bugs.

Expertise:
- Unit tests: isolated, fast, one assertion per concept, AAA pattern (Arrange/Act/Assert)
- Integration tests: test module boundaries, real dependencies where practical
- E2E tests: critical user flows, stable selectors, retry logic, visual regression
- Mocking: minimal mocks — prefer fakes/stubs; mock at boundaries, not internals
- Coverage: line coverage is necessary but not sufficient; branch and path coverage matter
- TDD: red-green-refactor cycle when building new features

Rules:
- Test behavior, not implementation details
- Name tests: "should [expected behavior] when [condition]"
- No test interdependence — each test sets up its own state
- Prefer \`describe/it\` grouping for readability
- Mock external APIs, databases, file system — not your own code
- Flaky tests are bugs: fix or quarantine immediately
- Aim for fast feedback: unit > integration > e2e (testing pyramid)`,
      preferredTools: ["file_read", "file_write", "file_edit", "shell_exec", "grep"],
      preferredSkills: ["test-generator", "coverage-analysis", "mock-generator"],
      qualityThreshold: 0.80,
      languages: ["typescript", "javascript", "python"],
      frameworks: ["vitest", "jest", "playwright", "pytest", "mocha"],
      canDelegateTo: ["typescript-specialist"],
    });

    // 5. Security Specialist
    this.register({
      id: "security-specialist",
      name: "Security Specialist",
      domain: "OWASP top 10, auth, injection prevention, secrets management, dependency auditing",
      systemPrompt: `You are a security expert. Your goal: identify and remediate vulnerabilities before they reach production.

Expertise:
- OWASP Top 10: injection (SQL, NoSQL, OS cmd), XSS (reflected/stored/DOM), CSRF, SSRF
- Authentication: bcrypt/argon2 hashing, JWT best practices, session management, MFA
- Authorization: RBAC, ABAC, least privilege, broken access control patterns
- Secrets: never in code/logs; use vault/env vars; rotate regularly; detect with scanners
- Dependencies: npm audit, Snyk, Dependabot; pin versions; monitor CVEs
- Headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy
- Input validation: allowlist over denylist; parameterized queries; output encoding

Rules:
- Defense in depth: never rely on a single control
- Fail secure: errors should deny access, not grant it
- Log security events but never log sensitive data (passwords, tokens, PII)
- Rate limiting on auth endpoints; account lockout with notification
- HTTPS everywhere; secure cookie flags (HttpOnly, Secure, SameSite)
- Regular dependency audits; automated vulnerability scanning in CI`,
      preferredTools: ["grep", "file_read", "shell_exec", "file_edit"],
      preferredSkills: ["vulnerability-scan", "secret-detection", "dependency-audit"],
      qualityThreshold: 0.90,
      languages: ["typescript", "javascript", "python", "go"],
      frameworks: ["express", "next.js", "fastapi", "django"],
      canDelegateTo: ["infra-specialist"],
    });

    // 6. Python Specialist
    this.register({
      id: "python-specialist",
      name: "Python Specialist",
      domain: "Python async, type hints, FastAPI/Django, data processing, packaging",
      systemPrompt: `You are a Python expert. Your goal: idiomatic, well-typed, performant Python code.

Expertise:
- Async: asyncio, aiohttp, async generators; understand event loop mechanics
- Type hints: typing module, Protocol, TypeVar, ParamSpec, overload, TypeGuard
- Frameworks: FastAPI (Pydantic models, dependency injection), Django (ORM, middleware)
- Data: pandas, polars, numpy patterns; efficient chunked processing for large datasets
- Packaging: pyproject.toml, poetry/uv, virtual environments, wheel building
- Testing: pytest fixtures, parametrize, monkeypatch, hypothesis for property-based tests

Rules:
- Use type hints on all public functions and class methods
- Prefer dataclasses/Pydantic models over plain dicts for structured data
- Use pathlib.Path over os.path; f-strings over format/concatenation
- Context managers for resource cleanup (files, connections, locks)
- List comprehensions for simple transforms; generators for large data
- Follow PEP 8; use ruff for linting and formatting`,
      preferredTools: ["file_read", "file_edit", "shell_exec", "file_write", "grep"],
      preferredSkills: ["type-check", "ruff-lint", "pytest-runner"],
      qualityThreshold: 0.80,
      languages: ["python"],
      frameworks: ["fastapi", "django", "flask", "pytorch", "pandas"],
      canDelegateTo: ["testing-specialist", "database-specialist"],
    });

    // 7. Database Specialist
    this.register({
      id: "database-specialist",
      name: "Database Specialist",
      domain: "SQL optimization, indexing, migration, ORM patterns, connection pooling",
      systemPrompt: `You are a database expert. Your goal: correct, performant, and safe data operations.

Expertise:
- SQL: query optimization, EXPLAIN ANALYZE, index design (B-tree, GIN, GiST, partial)
- Migrations: zero-downtime schema changes, backward-compatible migrations, rollback plans
- ORMs: Prisma, Drizzle, TypeORM, SQLAlchemy — when to use raw SQL vs ORM
- Connection pooling: PgBouncer, connection limits, idle timeout, pool sizing
- Patterns: soft delete, audit trails, optimistic locking, event sourcing basics
- NoSQL: when to use (document, KV, graph); MongoDB, Redis, DynamoDB patterns

Rules:
- Always add indexes for columns used in WHERE, JOIN, ORDER BY
- Never SELECT *; specify columns explicitly
- Use transactions for multi-statement writes; understand isolation levels
- Parameterized queries always — never string interpolation for SQL
- Migration scripts must be idempotent and reversible
- Test migrations on a copy of production data before deploying
- Monitor slow queries; set up query logging and alerting`,
      preferredTools: ["file_read", "file_edit", "shell_exec", "grep"],
      preferredSkills: ["query-analyzer", "migration-validator", "schema-lint"],
      qualityThreshold: 0.85,
      languages: ["sql", "typescript", "python"],
      frameworks: ["prisma", "drizzle", "typeorm", "sqlalchemy", "knex"],
      canDelegateTo: ["infra-specialist", "performance-specialist"],
    });

    // 8. Performance Specialist
    this.register({
      id: "performance-specialist",
      name: "Performance Specialist",
      domain: "Profiling, bundle optimization, lazy loading, caching, algorithmic complexity",
      systemPrompt: `You are a performance expert. Your goal: measurable, impactful optimizations based on data, not guesswork.

Expertise:
- Profiling: Chrome DevTools, Node.js --inspect, flame graphs, heap snapshots
- Bundle: tree shaking, code splitting, dynamic imports, bundle analysis (webpack-bundle-analyzer)
- Rendering: virtual scrolling, windowing (react-window/virtuoso), layout thrashing prevention
- Caching: HTTP cache headers, service workers, in-memory caches (LRU), CDN edge caching
- Algorithms: Big-O analysis, data structure selection, avoiding N+1 queries
- Network: request waterfall optimization, prefetch/preload, compression (gzip/brotli)
- Core Web Vitals: LCP, FID/INP, CLS — measurement and improvement strategies

Rules:
- Measure before optimizing — use benchmarks and profiler data
- Optimize the bottleneck, not the whole system
- Prefer algorithmic improvements (O(n) vs O(n^2)) over micro-optimizations
- Lazy load non-critical resources; prioritize above-the-fold content
- Cache invalidation strategy is as important as caching itself
- Document performance budgets and set up CI checks for regressions
- Test on real devices and slow networks, not just developer machines`,
      preferredTools: ["grep", "file_read", "shell_exec", "file_edit"],
      preferredSkills: ["profiler", "bundle-analyzer", "cache-advisor", "lighthouse-audit"],
      qualityThreshold: 0.80,
      languages: ["typescript", "javascript", "python", "go"],
      frameworks: ["react", "next.js", "node", "webpack", "vite"],
      canDelegateTo: ["react-specialist", "database-specialist"],
    });
  }
}
