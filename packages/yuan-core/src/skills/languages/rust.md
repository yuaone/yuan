## Identity
- domain: rust
- type: language
- confidence: 0.95

# Rust — Error Pattern Reference

Read the full `rustc` error output including the `help:` and `note:` lines. Rust's compiler diagnostics are among the most detailed available — the suggestion often contains the exact fix.

## Error Code Quick Reference
- **E0502** — Cannot borrow as mutable because it is also borrowed as immutable.
- **E0505** — Cannot move out of value because it is borrowed.
- **E0507** — Cannot move out of `*x` which is behind a reference.
- **E0106** — Missing lifetime specifier.
- **E0277** — Trait bound not satisfied.
- **E0308** — Mismatched types.
- **E0004** — Non-exhaustive patterns in match.
- **E0382** — Use of moved value.
- **E0499** — Cannot borrow as mutable more than once at a time.
- **E0716** — Temporary value dropped while borrowed.

## Known Error Patterns

### Pattern: borrow checker — cannot borrow as mutable (E0502 / E0499)

- **symptom**: `cannot borrow 'x' as mutable because it is also borrowed as immutable` or `cannot borrow 'x' as mutable more than once at a time`
- **cause**: Rust enforces at most one mutable reference OR any number of immutable references at a time. Violating this at the same scope triggers E0502/E0499.
- **strategy**: 1. Read the error span — it shows exactly where each borrow starts and ends. 2. Restructure code so the immutable borrow is dropped (goes out of scope or is no longer used) before the mutable borrow begins. 3. If both borrows are needed simultaneously, clone the data for the immutable side. 4. For collections, use `split_at_mut` or index-based access instead of simultaneous slice references.
- **toolSequence**: file_read (error lines) → file_edit (restructure borrow scopes or add `.clone()`)
- **pitfall**: Do NOT reach for `unsafe` or `RefCell` as the first solution. Restructuring lifetimes or cloning is almost always the correct fix.

### Pattern: lifetime annotation error (E0106 / E0597)

- **symptom**: `missing lifetime specifier` or `borrowed value does not live long enough` — value dropped while still borrowed
- **cause**: A reference in a struct, function return, or trait object lacks a lifetime annotation, or a local variable is returned as a reference but is dropped at end of function.
- **strategy**: 1. Read the error to find where the lifetime is needed. 2. For struct fields holding references, add a lifetime parameter to the struct: `struct Foo<'a> { x: &'a str }`. 3. For function returns borrowing from input, add matching lifetime: `fn foo<'a>(x: &'a str) -> &'a str`. 4. If returning a reference to a local, return an owned value (`String`, `Vec`, etc.) instead. 5. Use `'static` only for string literals or `Box::leak` — never to silence the error.
- **toolSequence**: file_read (struct or function definition) → file_edit (add lifetime parameters)
- **pitfall**: Do NOT add `'static` to every lifetime just to make the compiler happy — it severely restricts callers and is almost always wrong.

### Pattern: match non-exhaustive (E0004)

- **symptom**: `non-exhaustive patterns: X not covered` in a `match` expression
- **cause**: The match does not cover all variants of an enum, or a range/literal pattern leaves some values unhandled.
- **strategy**: 1. Read the error to find the uncovered variant(s). 2. Add an explicit arm for each missing variant. 3. If a catch-all is semantically correct, add `_ => { /* handle default */ }` at the end. 4. For enums you own, prefer explicit arms over `_` so new variants added later cause compile errors.
- **toolSequence**: file_read (enum definition) → file_read (match expression) → file_edit (add missing arms)
- **pitfall**: Do NOT add `_ => unreachable!()` unless you have formally proven the branch cannot be reached — prefer `_ => panic!("unexpected variant: {:?}", x)` for better diagnostics.

### Pattern: unwrap on None/Err (runtime panic)

- **symptom**: `thread 'main' panicked at 'called Option::unwrap() on a None value'` or `called Result::unwrap() on an Err value`
- **cause**: `.unwrap()` or `.expect()` on an `Option` or `Result` that is `None`/`Err` at runtime. Often from file I/O, parsing, or indexing.
- **strategy**: 1. Locate every `.unwrap()` and `.expect()` in the code path that panicked. 2. Replace with proper error propagation using `?` operator or explicit match. 3. For `Option`, use `.unwrap_or(default)`, `.unwrap_or_else(|| compute())`, or `if let Some(x) = opt { ... }`. 4. For `Result`, propagate with `?` in functions that return `Result`, or handle with `match`/`if let Err(e)`.
- **toolSequence**: grep (`\.unwrap()\|\.expect(`) → file_read (each occurrence) → file_edit (replace with `?` or match)
- **pitfall**: Do NOT replace `.unwrap()` with `.unwrap_or_default()` blindly — the default value (empty string, 0, false) may silently cause incorrect behavior downstream.

### Pattern: trait not implemented for type (E0277)

- **symptom**: `the trait bound 'MyType: SomeTrait' is not satisfied` or `'MyType' doesn't implement 'Display'`
- **cause**: A generic function, operator, or macro requires a trait that the concrete type does not implement. Common cases: `Display`, `Debug`, `Clone`, `Send`, `Sync`, `Iterator`.
- **strategy**: 1. Read the full error including `note:` lines — they list which trait is required and where. 2. For `Debug`/`Clone`/`PartialEq`, add `#[derive(Debug, Clone, PartialEq)]` to the struct. 3. For custom traits, implement them manually. 4. For `Send`/`Sync`, check if the type contains non-Send/Sync fields (like `Rc`, raw pointers) and replace with thread-safe alternatives (`Arc`). 5. For third-party types, use a newtype wrapper to implement the trait.
- **toolSequence**: file_read (type definition) → file_edit (add `#[derive(...)]` or `impl Trait for Type`)
- **pitfall**: Do NOT implement `unsafe impl Send for T` to silence the error — this can cause data races. Fix the underlying non-Send field instead.

## Verification
Run: `cargo check` and `cargo clippy -- -D warnings`
- `cargo check` exit 0 = no compile errors (faster than `cargo build`).
- `cargo clippy` with `-D warnings` = no lints that could become bugs.
- For tests: `cargo test`

## Validation Checklist
- [ ] `cargo check` exits 0 with no errors
- [ ] `cargo clippy -- -D warnings` exits 0
- [ ] No `.unwrap()` in production code paths without comment explaining the guarantee
- [ ] Every `context.WithCancel` equivalent (Drop impl) verified to run on all paths
- [ ] Lifetime annotations are minimal — not `'static` unless truly static
- [ ] Non-exhaustive match arms handled explicitly, not silently with `_`
- [ ] `unsafe` blocks, if any, have a `// SAFETY:` comment explaining the invariant
