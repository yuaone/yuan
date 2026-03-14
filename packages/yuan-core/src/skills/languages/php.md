## Identity
- domain: php
- type: language
- confidence: 0.91

# PHP — Error Pattern Reference

Read the full error message including file path, line number, and error level (Notice, Warning, Fatal). PHP distinguishes levels — a Notice does not stop execution but a Fatal does.

## Error Level Quick Reference
- **Parse error** — Syntax error; PHP cannot compile the file.
- **Fatal error** — Unrecoverable; execution stops.
- **Warning** — Non-fatal but usually indicates a bug.
- **Notice** — Informational; often undefined variable or index.
- **Deprecated** — API usage that will be removed in a future version.

## Known Error Patterns

### Undefined variable
- **Symptom**: `Notice: Undefined variable: foo` or in PHP 8: `Warning: Undefined variable $foo`
- **Cause**: Using a variable that has not been assigned in the current scope. Common when a conditional assignment is skipped or a parameter name is misspelled.
- **Strategy**: 1. Read the function or scope where the variable is used. 2. Trace all code paths — is there a branch where the variable is never set? 3. Add a default assignment before the conditional: `$foo = null;` or `$foo = [];`. 4. For superglobals (`$_GET`, `$_POST`), use `isset` or `??`: `$val = $_GET['key'] ?? null`.
- **Tool sequence**: file_read (function scope) → grep (all assignments to variable) → file_edit (add default assignment)
- **Pitfall**: Do NOT suppress with `@` operator. Fix the missing assignment.

### Call to undefined function
- **Symptom**: `Fatal error: Call to undefined function foo()`
- **Cause**: Function not defined in scope. Missing `require`/`include` for the file containing it, missing Composer autoload, or a misspelled function name.
- **Strategy**: 1. Grep for the function definition across the project. 2. If found, check whether the file containing it is required at the call site. 3. If it is a Composer package function, verify `require 'vendor/autoload.php'` is present at the entry point. 4. Check PHP extension functions — the required extension may not be loaded (check `php.ini` with `phpinfo()`).
- **Tool sequence**: grep (`function foo`) → file_read (entry point for autoload) → shell_exec (`php -m` for extensions)
- **Pitfall**: Do NOT copy-paste the function definition inline. Find the canonical source and require it properly.

### Cannot use object of type stdClass as array
- **Symptom**: `Fatal error: Cannot use object of type stdClass as array`
- **Cause**: `json_decode()` without the second argument returns an `stdClass` object, not an array. Accessing it with `$result['key']` fails; `$result->key` is required.
- **Strategy**: 1. Find the `json_decode` call. 2. Pass `true` as the second argument to return an associative array: `json_decode($json, true)`. 3. If the type needs to be `stdClass` in some places, use object notation consistently: `$result->key`.
- **Tool sequence**: grep (`json_decode`) → file_read → file_edit (add second argument `true`)
- **Pitfall**: Do NOT cast `(array)` on nested objects — it only shallowly converts the top level.

### Type juggling bug: == vs ===
- **Symptom**: Comparisons return unexpected truthy/falsy results. E.g., `"0" == false` is true, `"1" == true` is true, `0 == "foo"` is true (PHP < 8), `"1" == "01"` is true.
- **Cause**: PHP's loose comparison (`==`) coerces types. This causes subtle bugs in password comparison, status checks, and array search results.
- **Strategy**: 1. Grep all `==` comparisons involving variables that could be mixed types (strings from user input, database fields, `in_array` calls). 2. Replace with strict `===` wherever type equality must be enforced. 3. For `in_array`, pass `true` as the third argument: `in_array($val, $arr, true)`.
- **Tool sequence**: grep (`==\s`) → file_read (comparison context) → file_edit (replace with `===`)
- **Pitfall**: Do NOT globally replace all `==` with `===` — some intentional type-coercing comparisons may exist. Review each case.

### Composer autoload not loaded
- **Symptom**: `Fatal error: Class 'Vendor\Package\Foo' not found` even though the package is in `composer.json`
- **Cause**: `require_once __DIR__ . '/vendor/autoload.php';` is missing from the entry point, or the dependencies were not installed (`vendor/` directory absent).
- **Strategy**: 1. Check the entry point file (usually `index.php`, `bootstrap.php`, or the framework entry). 2. Verify `require_once __DIR__ . '/vendor/autoload.php';` is the first require. 3. Run `composer install` if `vendor/` is missing. 4. If using a namespace, verify `composer.json` has the correct `autoload.psr-4` mapping and run `composer dump-autoload`.
- **Tool sequence**: file_read (entry point) → shell_exec (`ls vendor/`) → shell_exec (`composer install` or `composer dump-autoload`)
- **Pitfall**: Do NOT manually add `require` statements for individual Composer classes. Fix the autoload setup.

### Undefined array key / index
- **Symptom**: `Warning: Undefined array key "foo"` or `Notice: Undefined index: foo`
- **Cause**: Accessing an array key that does not exist. Common with form inputs, API responses, or optional config keys.
- **Strategy**: 1. Use `isset($arr['key'])` or the null coalescing operator `$arr['key'] ?? null` before accessing. 2. For required keys, throw an explicit exception or return an error rather than silently returning null.
- **Tool sequence**: file_read (array access line) → file_edit (add `isset` check or `??` operator)
- **Pitfall**: Do NOT use `@$arr['key']` to suppress the warning. Use `??` or `isset`.

## Verification
Run: `php -l <file>` for syntax check.
- For full project: `./vendor/bin/phpstan analyse` (if PHPStan is configured) or `./vendor/bin/psalm`.
- Always run `composer install` before testing if `vendor/` is absent or stale.

## Validation Checklist
- [ ] `php -l` exits 0 for all modified files
- [ ] All `json_decode` calls pass `true` as second arg when array access is used
- [ ] All security-sensitive comparisons use `===` not `==`
- [ ] `require_once __DIR__ . '/vendor/autoload.php'` present in entry point
- [ ] No `@` error suppression operator added
- [ ] All `$_GET`/`$_POST`/`$_REQUEST` accesses use `??` or `isset`
- [ ] `in_array` calls use strict mode (`true` as third argument) for type-sensitive checks
