# YUAN CLI Hard Test Results

**Date:** 2026-03-13
**CLI:** `node /home/dmsal020813/projects/yuan/packages/yuan-cli/dist/cli.js`
**Provider:** Google Gemini (`gemini-2.5-flash`, local BYOK mode)
**Timeout per test:** 60 seconds

---

## Test 1: Bug Fix — divide by zero (`test-basic/`)

**Prompt:** `"Fix the divide by zero bug in calculator.ts"`

### Result: PARTIAL PASS (timeout)

- **Completed:** NO — process exited with code 124 (timeout at 60s)
- **Files Modified:** `src/calculator.ts` — YES, correctly modified
- **Tool calls observed:**
  1. `grep` — search for `divide|/` (initial miss due to relative path)
  2. `glob` — search for `*calculator*.ts` (miss, needed `src/`)
  3. `grep` — search `**/*.ts` for keywords — FOUND `src/calculator.ts`
  4. `file_read` — read `src/calculator.ts`
  5. `file_edit` — apply the fix
  6. `test_run` — FAILED (no jest/vitest/pytest detected)
  7. `file_read` — read `package.json`
  8. `shell_exec ts-node src/index.ts` — REJECTED by security governor (2 retries)
  9. `test_run` with `framework:"auto"` — FAILED again
  10. `file_read` — re-read file to confirm fix

- **Approximate tool calls:** ~10
- **Fix correct?** YES

**Before:**
```typescript
export function divide(a: number, b: number): number {
  return a / b;
}
```

**After:**
```typescript
export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Cannot divide by zero");
  }
  return a / b;
}
```

### Issues Observed
- Timed out because agent tried to run `ts-node` to verify the fix, which was blocked by the security governor (`shell_exec` rejected). Recovery loop consumed remaining time.
- Initial `grep`/`glob` missed the file because it searched for exact filename without `src/` prefix. Recovered on 3rd try with a glob `**/*.ts` search.
- `file_edit` was called twice (idempotency confusion) but second call was harmless.

---

## Test 2: Multi-file Refactor — rename method (`test-refactor/`)

**Prompt:** `"Rename getUserById to findUserById across all files"`

### Result: PARTIAL PASS (timeout, incomplete refactor)

- **Completed:** NO — process exited with code 124 (timeout at 60s)
- **Files Modified:**
  - `src/user.ts` — YES, method definition renamed to `findUserById` ✓
  - `src/profile.ts` — YES, both call-sites renamed to `findUserById` ✓
  - `src/order.ts` — NO, still uses `getUserById` (3 call-sites missed) ✗

- **Tool calls observed:**
  1. `grep` — found all `getUserById` occurrences (order.ts, profile.ts)
  2. `file_edit` on `src/order.ts` with `replace_all:true` — reported success then immediately reported "Error: old_string not found" (race/confusion)
  3. `file_edit` on `src/profile.ts` with `replace_all:true` — partially succeeded (profile.ts OK)
  4. `file_edit` on `src/user.ts` with `replace_all:true` — succeeded (user.ts OK)
  5. Multiple `file_read` + re-try loops on `order.ts` — failed repeatedly
  6. Final `grep` still showed `getUserById` in `order.ts`

- **Approximate tool calls:** ~12
- **Fix correct?** PARTIAL — 2/3 files done

**Summary of rename state:**
| File | Status |
|------|--------|
| `src/user.ts` (definition) | ✓ Renamed to `findUserById` |
| `src/profile.ts` (2 usages) | ✓ Renamed to `findUserById` |
| `src/order.ts` (3 usages) | ✗ Still `getUserById` — INCOMPLETE |

### Issues Observed
- **Critical bug:** `file_edit` with `replace_all:true` on `src/order.ts` reported "1 replacement(s)" then immediately errored "old_string not found" — this suggests a tool-level idempotency/caching bug where the first `file_edit` succeeded but the tool emitter reported it as failed, causing infinite retry loops.
- The agent correctly identified all 3 target files from the `grep` results but got stuck in a retry loop on `order.ts` until timeout.

---

## Test 3: TypeScript Error Fix — complex project (`test-complex/`)

**Prompt:** `"Fix all TypeScript errors in this project"`

### Result: PARTIAL PASS (timeout, 2/3 files fixed)

- **Completed:** NO — process exited with code 124 (timeout at 60s)
- **Files Modified:**
  - `src/auth/login.ts` — YES, 2 of 3 errors fixed ✓
  - `src/auth/middleware.ts` — YES, import path corrected ✓
  - `src/utils/hash.ts` — NO, `hashPwd` → `hashSync` not fixed ✗

- **Tool calls observed:**
  1. `shell_exec npx tsc --noEmit` — REJECTED by security governor
  2. `glob **/*.ts` — found all 3 files
  3. `file_read tsconfig.json`
  4. `file_read src/auth/login.ts`
  5. `file_edit` to fix `tok:` → `token:` — SUCCESS (1 replacement)
  6. `file_edit` on `login.ts` to fix `now: string` → `now: number` — SUCCESS
  7. `file_read src/auth/middleware.ts`
  8. `file_edit` to fix import path → SUCCESS (`./login`)
  9. Multiple failed `file_edit` retries on `login.ts` (re-applying already-fixed edits)
  10. Recovery loop escalated to 5 strategies exhausted

- **Approximate tool calls:** ~14
- **Fix correct?** PARTIAL — 2/3 files fixed

**Errors fixed:**
| Error | File | Status |
|-------|------|--------|
| `tok:` → `token:` (wrong property name) | `login.ts` | ✓ Fixed |
| `now: string` → `now: number` (type error) | `login.ts` | ✓ Fixed |
| Wrong import `'../auth/login-service'` → `'./login'` | `middleware.ts` | ✓ Fixed |
| `bcrypt.hashPwd` → `bcrypt.hashSync` (wrong method) | `hash.ts` | ✗ Not fixed |

### Issues Observed
- `shell_exec npx tsc --noEmit` was blocked by the security governor before the agent could get compiler error output — this forced the agent to work "blind" (reading files manually instead of using tsc for error listing).
- After fixing `login.ts` errors, the agent got confused and tried to re-apply already-fixed edits, triggering the recovery escalation loop until timeout.
- `hash.ts` was never reached due to loop exhaustion.

---

## Summary

| Test | Task | Completed | Exit Code | Files Changed | Correct? |
|------|------|-----------|-----------|---------------|----------|
| Test 1 | Bug fix (divide by zero) | Partial | 124 (timeout) | 1/1 | ✓ Fully correct |
| Test 2 | Multi-file rename | Partial | 124 (timeout) | 2/3 | Partial (order.ts missed) |
| Test 3 | TS error fixes | Partial | 124 (timeout) | 2/3 | Partial (hash.ts missed) |

---

## Key Findings

### What worked well
1. **File discovery** — Agent reliably found files using `grep`/`glob` even when initial searches missed.
2. **Single-file edits** — `file_edit` applied correct content in all successful cases.
3. **Import path correction** — Correctly identified and fixed wrong module path in middleware.ts.
4. **Type error identification** — Read source files and correctly diagnosed `tok` vs `token`, `string` vs `number`.

### Bugs / Failure modes identified

1. **`file_edit` idempotency confusion (CRITICAL):** When `replace_all:true` is used and the old_string was already replaced (or is no longer present), the tool reports error even though an earlier pass succeeded. This causes infinite retry loops.

2. **Security governor blocks shell_exec too aggressively:** Both `ts-node src/index.ts` and `npx tsc --noEmit` were rejected. This prevents the agent from verifying fixes and causes time-consuming manual workarounds.

3. **No `tsc` integration for error listing:** Without being able to run `tsc --noEmit`, the agent must manually read every file to find errors. A dedicated `typecheck` tool would dramatically improve TS error fixing.

4. **All tests timed out at 60s:** The 60s limit is too tight for multi-step tasks. The agent was mid-execution in all cases. 120-180s would be more appropriate.

5. **Grep output duplication:** Tool results showed each match line twice (appears to be a display/rendering issue in the terminal output — not affecting logic).

6. **File_read truncation (5 lines + "X more lines"):** The tool preview shows only 5 lines in the TUI output, which means the agent's "thinking" loop must make additional reads to see full file content, adding latency.

---

## Recommendations

1. Fix `file_edit` replace_all retry logic — track which edits have been applied per-session.
2. Add a `typecheck` built-in tool that runs `tsc --noEmit` in a sandboxed way.
3. Allow `shell_exec` for read-only compiler commands (`tsc --noEmit`, `tsc --version`) without full security escalation.
4. Increase default one-shot timeout to 120s or make it configurable via `--timeout` flag.
5. Fix grep output duplication in TUI rendering.
