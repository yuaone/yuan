## Identity
- domain: swift
- type: language
- confidence: 0.95

# Swift — Error Pattern Reference

Read the full Xcode error and the associated `note:` context. Swift's compiler is strict but its error messages are detailed — the fix is usually contained in the output.

## Error Code Quick Reference
- **Fatal error: Unexpectedly found nil while unwrapping an Optional value** — force unwrap `!` on nil.
- **Value of optional type 'X?' must be unwrapped** — optional used where non-optional expected.
- **Type 'X' does not conform to protocol 'Y'** — missing protocol requirement.
- **Sendable warning** — non-Sendable type crossing actor/concurrency boundary.
- **Expression is 'async' but is not marked with 'await'** — async call without await.
- **Call to main actor-isolated method in synchronous context** — @MainActor violation.
- **Capture of 'x' with non-sendable type** — Swift 6 strict concurrency violation.
- **Retain cycle** — strong reference cycle causing memory leak (detected in Instruments).

## Known Error Patterns

### Pattern: force unwrap crash (! on nil Optional)

- **symptom**: `Fatal error: Unexpectedly found nil while unwrapping an Optional value` at a line with `!`
- **cause**: The `!` force-unwrap operator is used on an `Optional` that is `nil` at runtime. Common sources: IBOutlet not connected, storyboard/nib loading timing, JSON parsing, optional chaining bypassed, `as!` cast failure.
- **strategy**: 1. Find every `!` at or near the crashing line. 2. Replace force unwrap with safe alternatives: `if let x = optional { }`, `guard let x = optional else { return }`, or `optional ?? defaultValue`. 3. For `as!` casts, use `as?` with a guard: `guard let view = obj as? UIView else { return }`. 4. For IBOutlets, verify the outlet is connected in the storyboard (open IB, check the connection inspector). 5. Use `XCTUnwrap` in tests instead of `!`.
- **toolSequence**: file_read (crashing line + surrounding context) → grep (`!` usage near the line) → file_edit (replace `!` with guard let or if let)
- **pitfall**: Do NOT replace `!` with `?` and silently ignore nil — use `guard let` to fail explicitly with context when nil is unexpected.

### Pattern: protocol conformance missing

- **symptom**: `Type 'MyClass' does not conform to protocol 'Equatable'` (or `Codable`, `Hashable`, `Identifiable`, etc.)
- **cause**: A type used in a context requiring a protocol does not implement all required methods/properties. Common for `Equatable` (needs `==`), `Hashable` (needs `hash(into:)`), `Codable` (needs `encode`/`init(from:)` for non-synthesizable types).
- **strategy**: 1. Read the protocol requirement in the error. 2. For `Equatable`/`Hashable`/`Codable` with simple stored properties, add the protocol to the declaration — Swift synthesizes conformance automatically if all properties conform. 3. For types with custom logic or non-conforming properties, implement the required methods manually. 4. For `Identifiable`, add `var id: SomeHashable { }` property. 5. Use an extension to add conformance cleanly.
- **toolSequence**: grep (protocol name + requirements) → file_read (type definition) → file_edit (add protocol conformance or implement requirements)
- **pitfall**: Do NOT add `@unchecked Sendable` to dismiss protocol warnings without verifying thread safety manually.

### Pattern: Sendable warning (concurrency)

- **symptom**: `Sending 'x' risks causing data races` or `Type 'Foo' does not conform to 'Sendable'` — Swift 6 strict concurrency or Xcode 15+ warnings
- **cause**: A value of non-Sendable type is passed across actor boundaries (e.g., from background Task to @MainActor). Swift's concurrency model requires types crossing isolation boundaries to be Sendable (value types or thread-safe classes).
- **strategy**: 1. Identify the type causing the warning. 2. If it is a struct with value-type properties, it is automatically Sendable — no action needed (compiler should infer). 3. If it is a class, make it `final` and ensure all mutable state is protected by a lock or actor, then add `Sendable` conformance. 4. Use `@MainActor` on types that should always run on main thread. 5. For data flowing into async tasks, capture immutable copies: `let snapshot = mutableData` before the `Task { }`. 6. As a last resort for third-party types, use `@unchecked Sendable` with a `// THREAD-SAFE: reason` comment.
- **toolSequence**: file_read (type crossing boundary) → file_edit (make Sendable or capture immutable copy before Task)
- **pitfall**: Do NOT use `@unchecked Sendable` without a comment proving thread safety — it suppresses the warning but not data races.

### Pattern: memory retain cycle (weak/unowned)

- **symptom**: Memory grows unboundedly; objects not released after dismissal. Instruments Leaks shows a cycle. Common in closures capturing `self`, delegates, and notification observers.
- **cause**: Object A holds a strong reference to object B, which holds a strong reference back to A. ARC cannot release either. Common in: closure capturing `self` strongly, delegate properties not marked `weak`, NotificationCenter observers not removed, Timer targets.
- **strategy**: 1. In closures that reference `self`, use `[weak self]` capture: `{ [weak self] in guard let self else { return } ... }`. 2. Delegate properties: declare as `weak var delegate: MyDelegate?`. 3. NotificationCenter: store the observer token and remove it in `deinit`. 4. Timer: use `[weak self]` in the timer block and invalidate in `deinit`. 5. Use `[unowned self]` only when the closure's lifetime is strictly shorter than `self` — prefer `weak` when in doubt.
- **toolSequence**: grep (`self\.`) in closure bodies → file_read → file_edit (add `[weak self]` capture list)
- **pitfall**: Do NOT use `unowned` as a performance optimization for convenience — if the assumption is wrong and `self` is nil when the closure runs, it is an immediate crash.

### Pattern: @MainActor isolation error

- **symptom**: `Call to main actor-isolated instance method 'updateUI()' in a synchronous nonisolated context` or `Expression is 'async' but is not marked with 'await'`
- **cause**: A `@MainActor`-isolated method is called from a non-isolated context (background task, async function without actor annotation). Swift 5.7+ enforces actor isolation at compile time.
- **strategy**: 1. Identify the caller context — is it inside a `Task`, `DispatchQueue.global()` block, or plain function? 2. Wrap the `@MainActor` call in `await MainActor.run { }` when inside an async context. 3. Mark the calling function `@MainActor` if it logically belongs to the main thread. 4. Use `Task { @MainActor in ... }` to dispatch UI work. 5. For legacy code with `DispatchQueue.main.async`, migrate to `Task { @MainActor in }` for consistency with Swift Concurrency.
- **toolSequence**: file_read (calling function) → file_edit (add `await MainActor.run { }` or `@MainActor` annotation)
- **pitfall**: Do NOT use `DispatchQueue.main.async` to bypass `@MainActor` errors in new code — it defeats Swift's compile-time isolation checks and can still cause data races.

## Verification
Run: `xcodebuild -scheme <scheme> build` or `swift build`
- For warnings as errors: `xcodebuild -scheme <scheme> build SWIFT_TREAT_WARNINGS_AS_ERRORS=YES`
- For tests: `xcodebuild test -scheme <scheme>`

## Validation Checklist
- [ ] No force unwrap `!` without a `// SAFE: reason` comment proving non-nil
- [ ] All closures capturing `self` use `[weak self]` unless lifetime is provably shorter
- [ ] Delegate properties declared as `weak var`
- [ ] NotificationCenter observers removed in `deinit`
- [ ] `@MainActor` isolation errors resolved with `await MainActor.run` or actor annotation
- [ ] Sendable violations resolved without `@unchecked Sendable` unless thread safety is documented
- [ ] `xcodebuild build` exits 0 with no errors
