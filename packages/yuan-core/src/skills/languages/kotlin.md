## Identity
- domain: kotlin
- type: language
- confidence: 0.95

# Kotlin — Error Pattern Reference

Read the full compiler error or runtime stack trace. Kotlin's type system catches many Java pitfalls at compile time — if an error reaches runtime, trace the `!!` operators and Java interop boundaries first.

## Error Code Quick Reference
- **Smart cast to 'T' is impossible** — mutable var cannot be smart cast.
- **Only safe (?.) or non-null asserted (!!.) calls are allowed** — nullable type used directly.
- **KotlinNullPointerException** — `!!` forced non-null on a null value.
- **Type mismatch: inferred type is X but Y was expected** — type inference conflict.
- **'when' expression must be exhaustive** — sealed class/enum not fully covered.
- **Suspension functions can be called only within coroutine body** — suspend call outside coroutine.
- **JobCancellationException** — coroutine scope cancelled before completion.
- **IllegalStateException: Fragment already added** — Fragment lifecycle misuse.

## Known Error Patterns

### Pattern: Smart cast impossible (mutable var)

- **symptom**: `Smart cast to 'Foo' is impossible, because 'x' is a mutable local variable that could have been changed since the null check`
- **cause**: Kotlin's smart cast requires that the variable cannot change between the null check and its use. A `var` (mutable variable) can be reassigned by another thread or within a lambda, so the compiler refuses to smart cast it.
- **strategy**: 1. Read the variable declaration — change `var` to `val` if the variable does not need to be reassigned. 2. If `var` is required, capture the current value in a local `val`: `val current = x; if (current != null) { use(current) }`. 3. For class properties, use a local copy: `val prop = this.nullableProp ?: return`. 4. Use the Elvis operator for early returns: `val safe = nullable ?: return`.
- **toolSequence**: file_read (null check and usage) → file_edit (change `var` to `val` or capture in local val)
- **pitfall**: Do NOT add `!!` to suppress the error — it converts a compile-time safety check into a runtime crash.

### Pattern: NPE from Java interop (!! operator overuse)

- **symptom**: `kotlin.KotlinNullPointerException` at a line containing `!!`, or `NullPointerException` from a Java method call whose return type is platform type (`String!`)
- **cause**: Java methods return platform types (e.g., `String!`) which Kotlin treats as non-null by default. The `!!` operator forces non-null and crashes if the value is actually null. Also common when using Java APIs that return null for missing values.
- **strategy**: 1. Grep for every `!!` in the file. 2. For each `!!`, determine if null is actually possible at runtime. 3. Replace `!!` with safe alternatives: `?: throw IllegalStateException("expected non-null")`, `?: return`, or `?.let { }`. 4. For Java interop returns, use `?: error("descriptive message")` to fail with context. 5. Add `@Nullable` / `@NonNull` annotations to Java methods to improve Kotlin inference.
- **toolSequence**: grep (`!!`) → file_read (each occurrence) → file_edit (replace with Elvis or safe call)
- **pitfall**: Do NOT remove `!!` and replace with `?: null` — if the null case is logically impossible, use `?: error("message")` to make violations visible.

### Pattern: coroutine scope leak

- **symptom**: Coroutines continue running after their associated ViewModel/Fragment/Activity is destroyed. Memory grows; callbacks fire on destroyed views. `viewModelScope` or `lifecycleScope` not used properly.
- **cause**: Using `GlobalScope.launch` or creating a custom `CoroutineScope` without cancelling it in `onCleared()` / `onDestroy()`. The coroutine outlives the owner.
- **strategy**: 1. Grep for `GlobalScope.launch` and `CoroutineScope(` in the file. 2. Replace `GlobalScope.launch` with `viewModelScope.launch` in ViewModels or `lifecycleScope.launch` in Fragments/Activities. 3. For custom scopes, store the scope in a property and cancel it in the appropriate lifecycle method: `scope.cancel()` in `onCleared()`. 4. For long-running background work, use a `SupervisorJob` + explicit cancellation. 5. Use `viewModelScope` in all ViewModel coroutines — it auto-cancels on `onCleared()`.
- **toolSequence**: grep (`GlobalScope\|CoroutineScope(`) → file_read → file_edit (replace with viewModelScope/lifecycleScope)
- **pitfall**: Do NOT use `runBlocking` in production Android code on the main thread — it blocks the UI thread and causes ANRs.

### Pattern: sealed class exhaustiveness warning

- **symptom**: `'when' expression must be exhaustive, add necessary 'is SomeSubclass' branch or 'else' branch instead` — compile error when used as expression; silent miss when used as statement.
- **cause**: A `when` over a sealed class/interface is missing one or more subclass branches. As a statement, Kotlin allows this (no compile error), but new subclasses added to the sealed class will silently miss handling. As an expression, it is a compile error.
- **strategy**: 1. Read the sealed class definition to list all subclasses. 2. Add a branch for each missing subclass. 3. To enforce exhaustiveness on `when` statements (not just expressions), use a helper: define an extension property `val <T> T.exhaustive: T get() = this` and call `when (x) { ... }.exhaustive`. 4. Prefer not using `else` in sealed class when expressions — adding a new subclass should cause a compile error, not silently fall through.
- **toolSequence**: grep (sealed class name) → file_read (all subclasses) → file_read (when expression) → file_edit (add missing branches)
- **pitfall**: Do NOT add `else -> {}` to silence exhaustiveness — it defeats the purpose of sealed classes as a compile-time completeness guarantee.

### Pattern: data class copy pitfall

- **symptom**: Modifying a `data class` instance via `.copy()` but the original is still referenced elsewhere, or nested mutable objects inside a data class are shared between copies.
- **cause**: Kotlin's `data class` `.copy()` is a shallow copy. Nested mutable objects (e.g., `MutableList`, mutable sub-data-classes) are not deep-copied — both the original and the copy reference the same mutable object.
- **strategy**: 1. Read the data class definition — identify any mutable collection or mutable sub-object fields. 2. When copying, explicitly copy mutable fields: `original.copy(items = original.items.toMutableList())`. 3. Prefer immutable collections (`List`, `Map`, `Set`) in data classes and replace the whole list on update rather than mutating in place. 4. If deep copy is frequently needed, implement a `deepCopy()` extension function. 5. Use `@Immutable` annotation with Compose if used in UI state.
- **toolSequence**: grep (data class name) → file_read (field types) → file_read (copy usage) → file_edit (add explicit field copy for mutable fields)
- **pitfall**: Do NOT assume `.copy()` is a deep copy — always audit mutable nested fields after using it.

## Verification
Run: `./gradlew compileKotlin` or `./gradlew build`
- Exit 0 = no compile errors.
- For Android: `./gradlew assembleDebug`
- For lint: `./gradlew lint`

## Validation Checklist
- [ ] No `!!` operators without an accompanying comment proving non-null at that point
- [ ] No `GlobalScope.launch` — use `viewModelScope` or `lifecycleScope`
- [ ] All `when` on sealed classes cover every subclass explicitly (no `else` hiding new cases)
- [ ] `var` used only where mutation is necessary — smart cast issues resolved with `val` capture
- [ ] Data class mutable fields explicitly copied when using `.copy()`
- [ ] Coroutine scopes cancelled in lifecycle teardown (`onCleared`, `onDestroy`)
- [ ] `./gradlew compileKotlin` exits 0
