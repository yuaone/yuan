## Identity
- domain: vue
- type: language
- confidence: 0.92

# Vue.js — Error Pattern Reference

Read the full Vue warning in the browser console. Vue warnings include the component name and the exact issue. Options API and Composition API have different error patterns — identify which is in use first.

## Quick Reference
- **[Vue warn]: Property or method "x" is not defined** — Options API scope issue.
- **[Vue warn]: Missing required prop** — Parent did not pass a required prop.
- **[Vue warn]: Extraneous non-emits event listeners** — Event name mismatch between `$emit` and `emits`.
- **[Vue warn]: Component emitted event "x" but it is not declared** — Add to `emits` option.
- **[Vue warn]: Failed to mount component** — Template or render error during initial mount.

## Known Error Patterns

### Property or Method Not Defined on Instance
- **Symptom**: `[Vue warn]: Property or method "foo" is not defined on the instance but referenced during render.`
- **Cause**: In Options API, a property used in the template is not declared in `data()`, `computed`, `methods`, or `props`. Common causes: typo in property name, forgetting to add to `data()`, using a local variable instead of reactive data.
- **Strategy**: 1. Read the component's `data()` function and `methods` object. 2. Verify the property name matches exactly (case-sensitive). 3. If the property should be reactive, add it to `data()` with an initial value. 4. If it is a computed value, add it to `computed`. 5. If it is read-only input, add it to `props`.
- **Tool sequence**: file_read (component data/methods) → grep (property name in template) → file_edit (add to data or methods)
- **Pitfall**: Do NOT add a property directly to `this` outside of `data()` (e.g., in `created`). Vue 2 cannot make it reactive retroactively; use `this.$set` or declare it in `data()` with an initial value.

### Reactive Data Mutation — Direct Array Index Set
- **Symptom**: Array is modified but the UI does not update. No Vue warning. `console.log` shows the correct value.
- **Cause**: In Vue 2, direct index assignment (`this.items[0] = newValue`) and `length` mutation are not reactive. Vue 2's reactivity cannot track these. In Vue 3, `reactive()` arrays do support index assignment, but replacing a `ref`'d array element requires reassignment.
- **Strategy**: Vue 2: Use `this.$set(this.items, 0, newValue)` or `this.items.splice(0, 1, newValue)`. Vue 3 with `reactive`: direct assignment works. Vue 3 with `ref`: replace the whole array `items.value = [...items.value.slice(0, 0), newValue, ...items.value.slice(1)]` or use splice on `items.value`.
- **Tool sequence**: file_read (mutation code) → file_edit (replace index assignment with $set/splice or reassignment)
- **Pitfall**: Do NOT use `Vue.set` in Vue 3 — it does not exist. Only needed in Vue 2.

### v-for Without :key
- **Symptom**: `[Vue warn]: Elements in iteration expect to have a 'v-key' directive`. List re-renders incorrectly: items swap, animations are wrong, component state is misattributed.
- **Cause**: `v-for` without a unique `:key` forces Vue to use positional diffing, which is incorrect when the list can be reordered, filtered, or have items added/removed.
- **Strategy**: 1. Add `:key` to every `v-for` element with a stable, unique identifier from the data (e.g., `:key="item.id"`). 2. Do NOT use the loop index as key when items can be reordered or deleted. 3. Use index as key only for truly static lists that never change order.
- **Tool sequence**: grep (`v-for`) → file_read (template) → file_edit (add `:key="item.id"`)
- **Pitfall**: Do NOT use `Math.random()` as a key — it regenerates on every render, destroying component state.

### Composition API Reactive Destructure Loss
- **Symptom**: Destructured value from `reactive()` is not reactive — does not update when the original object changes.
- **Cause**: `const { foo } = reactive({ foo: 1 })` creates a plain (non-reactive) copy of the value. Reactivity requires keeping the reference to the reactive object.
- **Strategy**: 1. Use `toRefs()` to preserve reactivity when destructuring: `const { foo } = toRefs(state)`. Then access as `foo.value`. 2. Alternatively, do not destructure — access as `state.foo` throughout. 3. For Composable return values, always return `toRefs(state)` or individual `ref`s so callers can destructure safely.
- **Tool sequence**: grep (`reactive`) → file_read (destructure site) → file_edit (wrap in `toRefs` or access via object)
- **Pitfall**: `toRef(state, 'foo')` creates a single ref linked to one property. Use `toRefs(state)` to convert the whole object.

### async setup Without Suspense
- **Symptom**: Component renders blank or throws. Parent shows no loading state. Vue warning: `async setup() is used without a parent <Suspense>`.
- **Cause**: In Vue 3, a component with `async setup()` (or `await` at the top level of `<script setup>`) must be wrapped by a `<Suspense>` component. Without it, async setup is not awaited before render.
- **Strategy**: 1. Wrap the async component with `<Suspense>` in the parent: `<Suspense><AsyncComponent /></Suspense>`. 2. Provide a `#fallback` slot for the loading state. 3. If Suspense is not suitable, move async data fetching to `onMounted` and manage loading state with a `ref<boolean>`.
- **Tool sequence**: file_read (async component) → file_read (parent template) → file_edit (add Suspense wrapper or move await to onMounted)
- **Pitfall**: Do NOT silence the warning by removing `async` from `setup` — this breaks the `await`. Fix by adding Suspense or refactoring to `onMounted`.

### Watchers Not Triggering on Nested Object Change
- **Symptom**: `watch` callback does not fire when a nested property of a reactive object changes.
- **Cause**: By default, `watch` in Vue 3 is not deep. It only detects top-level reference changes. Mutating a nested property does not trigger the watcher.
- **Strategy**: 1. Add `{ deep: true }` to the watch options: `watch(state, callback, { deep: true })`. 2. Alternatively, watch the specific nested property: `watch(() => state.nested.value, callback)`. 3. The targeted approach (option 2) is preferred for performance.
- **Tool sequence**: file_read (watch definition) → file_edit (add `{ deep: true }` or narrow watch target)
- **Pitfall**: `{ deep: true }` traverses the entire object tree on every change. Use targeted watches for deeply nested or large objects.

## Verification
Run: `vue-tsc --noEmit` (if using TypeScript with Vue), or `vite build` for full compilation.
- Browser console must show zero `[Vue warn]` messages in development.

## Validation Checklist
- [ ] All `v-for` elements have `:key` bound to a stable unique ID (not index for dynamic lists)
- [ ] All reactive data mutations use Vue-compatible methods (not index assignment in Vue 2)
- [ ] All `reactive()` destructures use `toRefs()`
- [ ] All `async setup()` components are wrapped in `<Suspense>`
- [ ] Vue console shows zero `[Vue warn]` messages in development build
- [ ] Watchers on nested object properties use `{ deep: true }` or targeted arrow function
- [ ] `emits` option declared for all events emitted by the component
- [ ] `props` declared with types and required flag for all parent-to-child data
