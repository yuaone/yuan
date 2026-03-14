## Identity
- domain: go
- type: language
- confidence: 0.95

# Go — Error Pattern Reference

Read the exact compiler error message first. Go errors are terse but precise — the line number, symbol name, and package path are always actionable.

## Error Code Quick Reference
- **declared and not used** — Variable declared but never read. Remove or use it.
- **undefined: X** — Symbol not found in scope. Missing import or typo.
- **cannot use X as type Y** — Type mismatch in assignment or function call.
- **nil pointer dereference** — Accessing a field/method on a nil pointer.
- **too many arguments in call** / **not enough arguments** — Arity mismatch.
- **imported and not used** — Import declared but no symbol from it used.
- **interface does not implement** — Missing method(s) for interface satisfaction.
- **context deadline exceeded** — Context timed out before operation completed.
- **goroutine leak** — goroutine blocked forever on channel or lock.
- **data race** — Two goroutines accessing same memory without synchronization.

## Known Error Patterns

### Pattern: declared and not used

- **symptom**: `./main.go:12:5: x declared and not used`
- **cause**: Go requires every declared variable to be read at least once. Assigning to `_` or simply not reading the variable causes a compile error.
- **strategy**: 1. Read the line where the variable is declared. 2. Determine if the variable is genuinely unused — delete it. 3. If the value is needed for a side effect only (e.g., error return), assign to `_`: `_ = val`. 4. If the variable was meant to be used elsewhere, trace where it should be consumed and add the usage.
- **toolSequence**: file_read (declaration line) → file_edit (remove or assign to `_`)
- **pitfall**: Do NOT assign everything to `_` indiscriminately. If the value is an error, silently discarding it hides real failures.

### Pattern: undefined: X (import path / symbol)

- **symptom**: `./main.go:8:10: undefined: SomeFunc` or `undefined: pkg.SomeType`
- **cause**: Either (a) the import path is wrong, (b) the package is not added to go.mod, (c) the symbol is unexported (lowercase), or (d) there is a typo in the symbol name.
- **strategy**: 1. Grep for the symbol definition in the project. 2. If found, check whether the import path matches the directory path. 3. If not found, check go.mod for the module — run `go get module@version` if missing. 4. If the symbol starts with a lowercase letter it is unexported — use the exported version or define a wrapper.
- **toolSequence**: grep (symbol name) → file_read (go.mod) → shell_exec (`go get <module>`) → file_edit (fix import path or symbol name)
- **pitfall**: Do NOT confuse package name with directory name — Go package name is the `package` declaration inside the file, not the directory.

### Pattern: goroutine leak (missing defer cancel)

- **symptom**: Memory grows unboundedly over time; `runtime.NumGoroutine()` keeps increasing. Often paired with `context.WithCancel` or `context.WithTimeout` never cancelled.
- **cause**: Every `context.WithCancel` or `context.WithTimeout` allocates resources that are only freed when the cancel function is called. If `cancel()` is never called (or called only in the non-error path), the goroutine and timer leak.
- **strategy**: 1. Grep for `context.WithCancel` and `context.WithTimeout` in the file. 2. Verify that immediately after each call there is a `defer cancel()`. 3. Place `defer cancel()` on the very next line after the `ctx, cancel :=` assignment — before any error-returning calls. 4. Verify with `go vet` and the `context` linter.
- **toolSequence**: grep (`WithCancel\|WithTimeout`) → file_read → file_edit (add `defer cancel()` immediately after assignment)
- **pitfall**: Do NOT place `defer cancel()` inside an `if err == nil` block — that leaves it uncalled on the error path.

### Pattern: nil pointer dereference

- **symptom**: `panic: runtime error: invalid memory address or nil pointer dereference` with a goroutine stack trace.
- **cause**: A pointer, interface, map, slice, or channel variable is `nil` when a field or method is accessed on it. Common sources: uninitialized struct fields, function returning `nil` error value cast to an interface, or a map not initialized with `make`.
- **strategy**: 1. Read the stack trace line number to find the exact dereference. 2. Trace backwards to where the variable was assigned — check every code path, including early returns. 3. Add a nil guard: `if ptr == nil { return fmt.Errorf("...") }`. 4. For maps, ensure initialization: `m = make(map[K]V)`. 5. For interfaces, avoid `var err error; return err` when the concrete type is nil but the interface is non-nil.
- **toolSequence**: file_read (panic line from stack trace) → grep (variable assignment) → file_edit (add nil check or initialize)
- **pitfall**: Do NOT confuse a nil interface with a nil pointer inside the interface. A `(*MyType)(nil)` stored in an `error` interface is NOT nil at the interface level.

### Pattern: interface satisfaction error

- **symptom**: `*MyStruct does not implement MyInterface (missing method Foo)` or `cannot use *MyStruct as type MyInterface`
- **cause**: The concrete type is missing one or more methods required by the interface, the receiver type is wrong (pointer vs value), or the method signature differs (parameter or return type mismatch).
- **strategy**: 1. Read the interface definition (grep the interface name). 2. List all required methods. 3. Grep for the method on the concrete type. 4. If missing, implement it. 5. If receiver is value but interface requires pointer (or vice versa), adjust the method receiver or the assignment (`&myStruct{}`). 6. Add a compile-time check: `var _ MyInterface = (*MyStruct)(nil)`.
- **toolSequence**: grep (interface name) → file_read → grep (method name on struct) → file_edit (implement missing method or fix receiver)
- **pitfall**: Do NOT implement the method on the value receiver when the interface is satisfied only by the pointer receiver — only `*T` satisfies both pointer and value receiver methods, not the other way around.

## Verification
Run: `go build ./...` and `go vet ./...`
- `go build` exit 0 = no compile errors.
- `go vet` exit 0 = no common correctness issues.
- For race detection: `go test -race ./...`

## Validation Checklist
- [ ] `go build ./...` exits 0 with no output
- [ ] `go vet ./...` exits 0 with no output
- [ ] Every `context.WithCancel` / `context.WithTimeout` is immediately followed by `defer cancel()`
- [ ] No nil pointer dereferences — all pointers nil-checked before use
- [ ] Interface satisfaction verified (either compiler confirms or explicit `var _ I = (*T)(nil)` check)
- [ ] No imported packages unused; no variables declared but unused
- [ ] Maps initialized with `make()` before write
