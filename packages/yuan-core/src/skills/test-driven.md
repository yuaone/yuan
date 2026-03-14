## Identity
- domain: general
- type: test
- confidence: 0.85

# Test-Driven — Red, Green, Refactor

Write the failing test before writing any implementation. The test defines what "done" means.

## Workflow
1. **Red** — Write the test. Run it. It MUST fail. If it passes, the test is wrong.
2. **Green** — Write the minimal code to make it pass. No extras.
3. **Refactor** — Clean up without changing behavior. Tests must still pass.
4. **Commit** — One test + implementation at a time.

## Rules
- Test behavior, not implementation. Test what it does, not how.
- One assertion focus per test. Multiple assertions are fine if they all test the same thing.
- Use real inputs and expected outputs — no magic numbers without explanation.
- If you need a mock, you probably need to redesign the interface.

## Known Error Patterns

### Test Passes Without Implementation
- **Symptom**: Wrote test, it passed immediately before any implementation
- **Cause**: Test is testing the wrong thing, or the feature already exists
- **Strategy**: 1. Read the test assertion carefully 2. Verify the thing being tested does not already exist 3. Make the assertion stricter until it fails
- **Tool sequence**: file_read (test) → shell_exec (run test) → fix assertion
- **Pitfall**: Do NOT skip the "verify red" step. A test that never fails is worthless.

### Test Too Tightly Coupled to Implementation
- **Symptom**: Refactoring breaks tests even though behavior is unchanged
- **Cause**: Test asserts internal state, method call counts, or private methods
- **Strategy**: Rewrite test to assert observable outputs and side effects only
- **Tool sequence**: file_read (test) → file_edit (test only) → shell_exec
- **Pitfall**: Do NOT test private methods directly.

### All Tests Pass But Feature Is Incomplete
- **Symptom**: Tests pass but edge cases are missing
- **Cause**: Tests only cover the happy path
- **Strategy**: 1. Identify edge cases: null/empty, boundary values, error conditions 2. Write one test per edge case 3. Implement
- **Tool sequence**: file_read (implementation) → file_edit (add tests) → shell_exec
- **Pitfall**: Do NOT consider a feature done with only happy-path tests.

## Validation Checklist
- [ ] Test written BEFORE implementation
- [ ] Test runs RED before implementation
- [ ] Test runs GREEN after implementation
- [ ] Edge cases covered (null, empty, boundary, error)
- [ ] No implementation details asserted
- [ ] Full test suite passes
