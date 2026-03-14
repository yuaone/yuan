## Identity
- domain: svelte
- type: language
- confidence: 0.91

# Svelte — Error Pattern Reference

Read the Svelte compiler error in full — it includes the file, line, column, and a description. Runtime errors appear in the browser console; compiler errors appear in the terminal during build.

## Quick Reference
- **'X' is not defined** — Variable used in template not declared in `<script>`.
- **'store' is not a store** — Variable used with `$` prefix is not a Svelte store.
- **Uncaught ReferenceError: X is not defined** — SSR/hydration mismatch or browser-only API used during SSR.
- **Each block must have a key expression** — Missing `(key)` in `{#each}`.
- **Cannot read properties of undefined** — Slot prop or store value not yet initialized.

## Known Error Patterns

### Reactive Statement Not Triggering — Mutation vs Reassignment
- **Symptom**: `$: derivedValue = compute(arr)` does not update when `arr` is mutated (e.g., `arr.push(item)`). UI stays stale.
- **Cause**: Svelte's reactivity is triggered by assignment. Mutating an array or object in place (`.push`, `.pop`, property assignment without reassignment) does not trigger reactivity because no assignment to the top-level variable occurs.
- **Strategy**: 1. After any mutation, reassign the variable: `arr.push(item); arr = arr;`. 2. Use immutable patterns: `arr = [...arr, item]` for push, `arr = arr.filter(...)` for remove. 3. For objects: `obj = { ...obj, key: value }` or `obj.key = value; obj = obj;`.
- **Tool sequence**: grep (mutation calls on reactive variable) → file_read → file_edit (add reassignment after mutation or switch to immutable pattern)
- **Pitfall**: Do NOT mutate a prop from inside a child component. Props flow down; use an event or a writable store for two-way data flow.

### Store Subscription Not Unsubscribed
- **Symptom**: Memory leak or stale callbacks after component is destroyed. Effects fire on unmounted components. Warning: "Cannot update a component after it has been destroyed."
- **Cause**: Manual store subscription using `store.subscribe(callback)` returns an unsubscribe function. If not called in `onDestroy`, the callback keeps firing after the component is unmounted.
- **Strategy**: 1. For manual subscriptions, always unsubscribe in `onDestroy`: `const unsub = store.subscribe(cb); onDestroy(unsub);`. 2. Use the `$store` auto-subscription syntax instead — Svelte automatically unsubscribes when the component is destroyed: `$myStore` in the template or reactive block.
- **Tool sequence**: grep (`\.subscribe\(`) → file_read (onDestroy presence) → file_edit (add onDestroy(unsub) or replace with $ syntax)
- **Pitfall**: Do NOT call `unsub()` in `onMount` return — that unsubscribes too early. Call it in `onDestroy`.

### Slot Prop Undefined
- **Symptom**: `Cannot read properties of undefined (reading 'x')` when accessing a slot prop. The slot renders but prop values are undefined.
- **Cause**: The parent passes a slot without the expected `let:propName` binding, or the child component's `<slot>` element does not pass the prop correctly with the named attribute.
- **Strategy**: 1. In the child component, verify the slot exports the prop: `<slot propName={value} />`. 2. In the parent, bind the prop with `let:propName`: `<svelte:fragment slot="name" let:propName>`. 3. Check for typos in the prop name — they must match exactly.
- **Tool sequence**: file_read (child component slot definition) → file_read (parent usage) → file_edit (add or fix let: binding)
- **Pitfall**: Slot props are only available within the slot markup in the parent. Do NOT try to use them outside the `<svelte:fragment>` or slot element.

### SSR Hydration Mismatch
- **Symptom**: Console warning: `Hydration mismatch` or elements flicker/reset on initial page load. Content rendered server-side differs from client-side initial render.
- **Cause**: Code that runs differently on server vs client: `Math.random()`, `Date.now()`, `window`/`document` access, locale-dependent formatting, or data fetched at different times.
- **Strategy**: 1. Identify the non-deterministic or browser-only value. 2. For browser-only APIs, guard with `if (browser)` from `$app/environment`, or use `onMount` (which only runs on client). 3. For random/time values, generate them on the server and pass as props, or synchronize the seed. 4. For locale: use a consistent locale setting shared between server and client.
- **Tool sequence**: file_read (component that flickers) → grep (`window\|document\|Math.random\|Date.now`) → file_edit (move to onMount or add browser guard)
- **Pitfall**: Do NOT wrap entire components with `{#if browser}` as a shortcut — this suppresses SSR entirely and loses SEO benefits. Fix the specific non-deterministic expression.

### Each Block Key Missing
- **Symptom**: `[svelte] warning: Each block requires a (key) expression` — list items re-render incorrectly, animations are wrong, component state is misattributed when list changes.
- **Cause**: `{#each items as item}` without `(item.id)` makes Svelte use positional diffing. Reordering, adding, or removing items confuses component identity.
- **Strategy**: 1. Add a unique key: `{#each items as item (item.id)}`. 2. The key must be a primitive (string, number) or something serializable. 3. Do NOT use array index as a key when items can be reordered or deleted.
- **Tool sequence**: grep (`{#each`) → file_read (template) → file_edit (add key expression)
- **Pitfall**: The key goes in parentheses after the item variable: `(item.id)`. Do NOT use `:key` (that is Vue syntax).

### Reactive Declaration Ordering
- **Symptom**: `$: b = a * 2` uses `a` which is defined by another reactive statement `$: a = fetch(...)`. `b` always sees the previous value of `a`.
- **Cause**: Svelte orders reactive statements topologically based on declared dependencies. If the dependency graph is not clear (e.g., both depend on the same store side-effect), ordering can be non-intuitive.
- **Strategy**: 1. Ensure reactive statements form a clear dependency graph. 2. If `b` depends on `a`, write `$: b = a * 2` AFTER `$: a = compute()` in the file, and make the dependency explicit (read `a` in the expression for `b`). 3. For complex derived state, use a store with a derived: `const b = derived(aStore, $a => $a * 2)`.
- **Tool sequence**: file_read (reactive block order) → file_edit (reorder or extract to derived store)
- **Pitfall**: Do NOT rely on file-order alone when reactive statements have side effects. Explicit data dependencies are more reliable.

## Verification
Run: `svelte-check` for static type and template checking (with TypeScript).
- `vite build` or `svelte-kit build` for full compilation.
- Browser console must show zero Svelte hydration warnings on initial load.

## Validation Checklist
- [ ] All array/object mutations followed by reassignment (`arr = arr`) or use immutable update patterns
- [ ] All `store.subscribe()` calls have matching `onDestroy(unsub)` or replaced with `$store` syntax
- [ ] All `{#each}` blocks have a `(key)` expression using stable unique ID
- [ ] Browser-only APIs guarded with `if (browser)` or moved to `onMount`
- [ ] Slot props bound with `let:propName` in parent matching child's slot attribute
- [ ] `svelte-check` reports zero errors
- [ ] Reactive declaration order reflects data dependency order
- [ ] No component mutations to received props (use events or writable stores)
