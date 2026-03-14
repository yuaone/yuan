## Identity
- domain: general
- type: review
- confidence: 0.95

# Code Review — Correctness, Security, Performance

Review in priority order: Correctness → Security → Performance → Style.
Style comments without correctness/security concerns are noise.

## Severity Levels
- **CRITICAL** — Will cause data loss, security breach, or crash in production. Must fix before merge.
- **HIGH** — Likely bug under realistic conditions. Fix before merge.
- **MEDIUM** — Potential issue under edge cases. Fix recommended.
- **LOW** — Style, readability, minor improvement. Optional.

## Review Checklist

### Correctness
- [ ] Does the logic match the intended behavior?
- [ ] Are all edge cases handled (null, empty, boundary)?
- [ ] Are error conditions handled or explicitly ignored?
- [ ] Are async operations awaited where needed?
- [ ] Are race conditions possible?

### Security
- [ ] User input validated and sanitized before use?
- [ ] No string interpolation into SQL/shell/HTML?
- [ ] No secrets, API keys, or credentials in code?
- [ ] File paths validated to prevent traversal?
- [ ] Permissions checked before operations?

### Performance
- [ ] No N+1 queries in loops?
- [ ] No unbounded operations on user-controlled input size?
- [ ] Expensive operations cached where appropriate?

## Known Error Patterns

### Logic Bug — Off By One
- **Symptom**: Array access, loop bounds, or range checks produce wrong results at edges
- **Cause**: < vs <=, 0 vs 1 as start index, missing last element
- **Strategy**: Test with length=0, length=1, and at-boundary inputs
- **Tool sequence**: file_read → grep (similar patterns) → file_edit
- **Pitfall**: Do NOT approve logic that was not tested at its boundaries.

### Silent Failure
- **Symptom**: Function catches error and returns undefined/null/false without logging
- **Cause**: catch block swallows errors
- **Strategy**: Flag all catch blocks that do not log or rethrow
- **Tool sequence**: grep (catch) → file_read → comment
- **Pitfall**: Do NOT approve silent error suppression in production code paths.

## Validation Checklist
- [ ] All CRITICAL issues flagged
- [ ] All HIGH issues flagged
- [ ] Security review completed
- [ ] Review output formatted as severity-labeled list
