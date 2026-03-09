# Contributing to YUAN

Thanks for your interest in contributing to YUAN! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm (the repo uses `packageManager: pnpm@10.26.2` -- corepack will handle it)

### Setup

```bash
git clone https://github.com/yua-inc/yuan.git
cd yuan
pnpm install
pnpm run build
```

### Development

```bash
# Watch mode for the CLI
pnpm run dev

# Build all packages
pnpm run build

# Type-check without emitting
pnpm -r lint
```

## Workflow

1. **Fork** the repository
2. **Create a branch** from `main` for your change (`git checkout -b feat/my-feature`)
3. **Make your changes** following the code style below
4. **Build and test** to make sure nothing is broken
5. **Submit a PR** with a clear description of the change

## Monorepo Structure

YUAN uses a pnpm workspace with these packages:

| Package | Path | Description |
|---------|------|-------------|
| `@yuan/core` | `packages/yuan-core/` | Agent runtime (loop, governor, planner) |
| `@yuan/tools` | `packages/yuan-tools/` | Tool implementations (9 built-in tools) |
| `yuan` (CLI) | `packages/yuan-cli/` | CLI entry point and REPL |
| `@yuan/mcp` | `packages/yuan-mcp/` | MCP server adapter |

### Adding dependencies

```bash
# Add to a specific package
pnpm --filter @yuan/core add <dependency>

# Add a dev dependency to the workspace root
pnpm add -Dw <dependency>
```

**Never use `npm install` or `yarn add`.**

## Code Style

- **TypeScript strict mode** -- all packages use `"strict": true`
- **ESM only** -- all packages use `"type": "module"`
- **JSDoc required** -- all public functions and exported types must have JSDoc comments
- **Error handling** -- use the `YuanError` hierarchy from `@yuan/core` (never throw plain strings)
- **No `any`** -- avoid `any` types; use `unknown` and narrow with type guards

### Naming Conventions

- Files: `kebab-case.ts` (e.g., `agent-loop.ts`, `file-read.ts`)
- Classes: `PascalCase` (e.g., `AgentLoop`, `FileReadTool`)
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Types/interfaces: `PascalCase`

## Testing

```bash
# Run all tests
pnpm run test

# Run tests for a specific package
pnpm --filter @yuan/core test
```

Tests use Node.js built-in test runner (`node --test`).

## Building

```bash
# Build all packages (respects dependency order)
pnpm run build

# Build a specific package
pnpm --filter @yuan/core build
```

Ensure `pnpm run build` passes before submitting a PR.

## Reporting Issues

- Use GitHub Issues
- Include Node.js version, OS, and pnpm version
- Include the full error output
- If possible, include a minimal reproduction

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 license.
