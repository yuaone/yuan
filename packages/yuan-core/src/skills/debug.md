## Identity
- domain: general
- type: debug
- confidence: 0.9

# Debug — Reproduce, Trace, Fix, Verify

Always reproduce the bug before touching any code. A fix you can't verify didn't happen.

## Workflow
1. **Reproduce** — Write a minimal script or test that triggers the bug. Run it. Confirm it fails.
2. **Trace** — Read the error message completely. Find the deepest frame in YOUR code (not library internals). Read that file.
3. **Localize** — Grep for the function/symbol in the error. Read 3 levels of call hierarchy.
4. **Fix** — Smallest change that resolves the root cause. Not the symptom.
5. **Verify** — Rerun the reproduction script. Run full test suite. Confirm no regressions.

## Known Error Patterns

### Fixing the Wrong Location
- **Symptom**: Fix applied, error persists or appears elsewhere
- **Cause**: Patched a caller when the bug is in the callee, or patched a copy/subclass instead of the source
- **Strategy**: 1. Grep all files containing the error pattern 2. Read the deepest implementation, not the surface call 3. Fix the source, not the symptom
- **Tool sequence**: grep → file_read (implementation) → file_edit → shell_exec (reproduce)
- **Pitfall**: Do NOT assume the first grep result is the right location. Read at least 2 candidates.

### Same Error Repeating After Fix
- **Symptom**: Retried same fix 2+ times, error unchanged
- **Cause**: Mental model of the bug is wrong
- **Strategy**: 1. Stop retrying 2. Read the full error message again from scratch 3. Search for the exact error string in the codebase 4. Try a structurally different approach
- **Tool sequence**: grep (exact error string) → file_read → re-analyze
- **Pitfall**: Do NOT make a third attempt with the same approach. The model of the problem is broken.

### Test Passes But Bug Persists
- **Symptom**: Test green, but reported behavior still broken
- **Cause**: Test does not cover the actual failure path
- **Strategy**: 1. Read the bug report carefully 2. Write a reproduction that exactly matches the reported flow 3. If test passes, the reproduction is wrong — fix the test first
- **Tool sequence**: file_read (test) → write_file (reproduction) → shell_exec
- **Pitfall**: Do NOT declare fixed based on passing tests alone. Run the exact reported scenario.

## Validation Checklist
- [ ] Reproduction script confirms the bug exists before fix
- [ ] Reproduction script confirms the bug is gone after fix
- [ ] Full test suite passes (no regressions)
- [ ] Root cause addressed, not just symptom
- [ ] No unrelated code changed
