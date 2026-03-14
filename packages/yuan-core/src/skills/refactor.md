## Identity
- domain: general
- type: refactor
- confidence: 0.85

# Refactor — Preserve Behavior, Improve Structure

Behavior must be identical before and after. Tests are your proof.

## Workflow
1. **Baseline** — Run test suite. All tests must pass. Record the result.
2. **Impact map** — Grep for all usages of what you are changing. List every file.
3. **One change** — Make one structural change at a time.
4. **Verify** — Run tests. Must still pass.
5. **Repeat** — Next structural change.
6. **Commit** — Each logical refactor is its own commit.

## Known Error Patterns

### Partial Rename
- **Symptom**: Build error or runtime failure after renaming a function/variable
- **Cause**: Some call sites not updated
- **Strategy**: grep ALL usages before renaming. Update every occurrence.
- **Tool sequence**: grep (exact name) → file_read (each result) → file_edit (all occurrences) → shell_exec (build)
- **Pitfall**: Do NOT rename without grepping first. IDEs miss dynamic usages.

### Changed Interface, Missed Consumers
- **Symptom**: Tests pass for the changed file, but integration tests fail
- **Cause**: Callers of the changed interface not updated
- **Strategy**: 1. grep for import of the changed module 2. Read each consumer 3. Update to new interface
- **Tool sequence**: grep (from.*moduleName, require.*moduleName) → file_read → file_edit
- **Pitfall**: Do NOT update the implementation without updating all consumers.

### Behavior Change During Refactor
- **Symptom**: Tests that were passing now fail after "only structural" changes
- **Cause**: Subtle logic change introduced during structural refactor
- **Strategy**: 1. Stop. 2. git diff the changes. 3. Identify which line changed behavior. 4. Revert behavior, keep structure.
- **Tool sequence**: shell_exec (git diff) → file_read → file_edit (revert behavior change only)
- **Pitfall**: Do NOT proceed with failing tests. Fix the regression immediately.

## Validation Checklist
- [ ] Test suite passes before refactor starts (baseline)
- [ ] All usages of changed symbols grepped and listed
- [ ] Test suite passes after each individual change
- [ ] No behavior changes (same inputs produce same outputs)
- [ ] Build passes
