## Identity
- domain: bash
- type: language
- confidence: 0.90

# Bash/Shell — Error Pattern Reference

Always start scripts with `#!/usr/bin/env bash` and `set -euo pipefail`. Most Bash bugs are invisible without these settings. Use `shellcheck` for static analysis.

## Quick Reference
- **exit code 127** — Command not found.
- **exit code 126** — Command found but not executable (permission issue).
- **exit code 1** — General error; check the command's stderr.
- **unbound variable** — `set -u` is active and an unset variable was used.
- **broken pipe** — Consumer of a pipeline exited before producer finished.

## Known Error Patterns

### Unbound Variable (set -u)
- **Symptom**: `bash: FOO: unbound variable` — script exits immediately.
- **Cause**: `set -u` (nounset) is active and a variable is referenced before being assigned. Common with optional variables, unset environment variables, or array out-of-bounds access.
- **Strategy**: 1. Identify the variable. 2. Provide a default: `${FOO:-default_value}`. Use `${FOO:-}` (empty default) if an empty string is acceptable. 3. For required variables, add an explicit check before use: `if [[ -z "${FOO:-}" ]]; then echo "FOO is required" >&2; exit 1; fi`.
- **Tool sequence**: file_read (script lines around error) → file_edit (add `${VAR:-default}` or explicit check)
- **Pitfall**: Do NOT remove `set -u` to silence the error. The unbound variable is the real bug.

### Word Splitting on Unquoted Variable
- **Symptom**: Script fails or behaves wrong when a variable contains spaces or glob characters. A filename like `my file.txt` becomes two arguments.
- **Cause**: Unquoted variable expansion in Bash: `$var` undergoes word splitting and pathname expansion. `"$var"` does not.
- **Strategy**: 1. Quote all variable expansions: `"$var"`, `"$@"`, `"${array[@]}"`. 2. Run `shellcheck <script>` — it flags all unquoted variables. 3. For arrays, always use `"${arr[@]}"` not `${arr[*]}`.
- **Tool sequence**: shell_exec (`shellcheck <script>`) → file_read (flagged lines) → file_edit (add quotes)
- **Pitfall**: Do NOT use single quotes `'$var'` — that prevents expansion entirely. Use double quotes `"$var"`.

### Missing pipefail (set -eo pipefail)
- **Symptom**: Script reports success even when a command in a pipeline fails. E.g., `false | tee output.txt` exits 0 without `pipefail`.
- **Cause**: Without `set -o pipefail`, a pipeline's exit code is only the last command's exit code. Failures in earlier pipeline stages are silently ignored.
- **Strategy**: 1. Add `set -euo pipefail` at the top of every script (after the shebang). 2. For individual pipelines where partial failure is expected, use `set +o pipefail` around that block and restore it after.
- **Tool sequence**: file_read (top of script) → file_edit (add `set -euo pipefail` after shebang)
- **Pitfall**: `set -e` alone is not enough for pipelines. Always pair it with `set -o pipefail`.

### Command Not Found in PATH
- **Symptom**: `command not found: foo` — exit code 127.
- **Cause**: The command is not in any directory listed in `$PATH`. Common when running scripts as a different user (cron, sudo), in Docker containers with minimal PATH, or when a tool is installed in a non-standard location.
- **Strategy**: 1. Run `which foo` or `type foo` to verify presence in the current shell. 2. For cron and CI, always use absolute paths: `/usr/bin/foo` or `/usr/local/bin/foo`. 3. If the tool is optional, check before use: `if ! command -v foo &>/dev/null; then echo "foo not installed" >&2; exit 1; fi`. 4. Source the correct profile/environment if the tool is installed via a version manager (nvm, rbenv, pyenv).
- **Tool sequence**: shell_exec (`which foo`) → shell_exec (`echo $PATH`) → file_edit (use absolute path or add PATH setup)
- **Pitfall**: Do NOT hardcode `/usr/bin/foo` if the tool may be in `/usr/local/bin` on some systems. Use `command -v` to find it dynamically when portability matters.

### Wrong or Missing Shebang
- **Symptom**: Script runs with the wrong interpreter (e.g., `sh` instead of `bash`), causing `[[`, arrays, or `local` to fail with syntax errors. Or: permission denied / bad interpreter.
- **Cause**: Shebang (`#!`) is missing, wrong (`#!/bin/sh` when bashisms are used), or the path is wrong for the target system.
- **Strategy**: 1. Use `#!/usr/bin/env bash` for portability — `env` finds bash in PATH. 2. Use `#!/bin/sh` only if the script is strictly POSIX sh. 3. If using `[[`, arrays, `local`, `$((...))`, `declare`, or `source`, the shebang must be `bash`. 4. Ensure the file has execute permission: `chmod +x script.sh`.
- **Tool sequence**: file_read (first line of script) → file_edit (fix shebang) → shell_exec (`chmod +x`)
- **Pitfall**: On some systems (Alpine Linux, minimal Docker), `/bin/bash` does not exist. Use `#!/usr/bin/env bash` instead.

### Arithmetic — Unintended Glob Expansion
- **Symptom**: Script exits unexpectedly, or `*` in an expression matches files instead of meaning multiplication.
- **Cause**: In `[[ ]]` or `$(( ))`, operators like `*`, `?`, `[` have special meanings. Outside these contexts they trigger pathname expansion.
- **Strategy**: 1. Always use `$(( expr ))` for arithmetic, never `expr` or `let` in new scripts. 2. Quote file patterns that should be treated as literals. 3. Use `[[ ]]` instead of `[ ]` for conditionals — `[[ ]]` does not perform pathname or word splitting.
- **Tool sequence**: file_read (expression line) → file_edit (replace `[ ]` with `[[ ]]`, wrap arithmetic in `$(( ))`)
- **Pitfall**: `(( ))` arithmetic returns exit code 1 when the result is 0, which triggers `set -e`. Use `(( expr )) || true` or wrap in an `if`.

## Verification
Run: `shellcheck <script>` — address all SC#### warnings before deployment.
- For syntax check only: `bash -n <script>`.
- Test with edge-case inputs: empty strings, paths with spaces, special characters.

## Validation Checklist
- [ ] `#!/usr/bin/env bash` on first line
- [ ] `set -euo pipefail` on second line
- [ ] `shellcheck` reports zero warnings
- [ ] All variable expansions quoted: `"$var"`, `"${arr[@]}"`
- [ ] All external commands referenced by absolute path in cron/CI contexts
- [ ] `command -v` used to check optional tools before use
- [ ] No `[ ]` — replaced with `[[ ]]` for conditionals
- [ ] Arithmetic done in `$(( ))` not with `expr`
