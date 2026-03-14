## Identity
- domain: react
- type: language
- confidence: 0.9

# React — Hook Rules, Rendering, and Common Errors

Read the full error message and component stack before touching any code.

## Hook Rules (Enforced by eslint-plugin-react-hooks)
- Call hooks only at the top level of a function component — never inside conditions, loops, or nested functions.
- Call hooks only from React function components or other custom hooks.
- Custom hooks must start with `use`.
- These rules are not style preferences — violating them causes non-deterministic behavior and crashes that are hard to reproduce.

## Known Error Patterns

### Hook Called Conditionally
- **Symptom**: ESLint error `React Hook "useX" is called conditionally` — or a runtime crash: `Rendered more hooks than during the previous render`
- **Cause**: Hook call placed inside an `if` block, after an early `return`, or inside a loop. React requires the same hooks to run in the same order on every render.
- **Strategy**: Move all hook calls to the top of the component function, above any conditional logic. If the hook should only do something conditionally, move the condition inside the hook's callback or pass a flag to the hook.
- **Tool sequence**: file_read (component) → file_edit (move hook calls above all conditionals)
- **Pitfall**: Do NOT wrap hook calls in try/catch or ternary expressions. Restructure the component so all hooks run unconditionally.

### Stale Closure in useEffect
- **Symptom**: Effect reads an old value of state or props. The callback always has the value from the first render regardless of updates.
- **Cause**: The dependency array is incomplete — it is missing variables that are read inside the effect.
- **Strategy**: Add every variable read inside the effect body to the dependency array. If adding a function reference creates an infinite loop, wrap the function in `useCallback` with its own deps. If adding an object creates an infinite loop, use `useMemo` or restructure to pass only primitive values.
- **Tool sequence**: file_read (useEffect block and deps array) → file_edit (add missing deps)
- **Pitfall**: Do NOT add `// eslint-disable-next-line react-hooks/exhaustive-deps` to suppress the exhaustive-deps warning. Fix the missing dependencies.

### Infinite Re-render Loop
- **Symptom**: Component re-renders continuously; browser tab becomes unresponsive or crashes.
- **Cause**: One of: (a) `setState` called unconditionally inside `useEffect` with no deps or with deps that always change, (b) an object or array literal created inline is in the dependency array (new reference every render), (c) parent passes a new object/function prop on every render.
- **Strategy**: 1. Read every `useEffect` in the component. Find any `setState` call without a guard condition. 2. Check the deps array for inline object/array literals — move them outside the component or wrap in `useMemo`/`useCallback`. 3. If the loop comes from a parent prop, memoize the prop at the parent.
- **Tool sequence**: file_read (all useEffect blocks) → file_edit (add condition or memoize deps)
- **Pitfall**: Do NOT add an empty dependency array `[]` to stop the loop without understanding why it loops. That causes stale closure bugs.

### Hydration Mismatch (Next.js / SSR)
- **Symptom**: `Error: Text content does not match server-rendered HTML` or `Error: Hydration failed because the initial UI does not match what was rendered on the server`
- **Cause**: Component renders different content on server vs. client. Common sources: `Date.now()`, `Math.random()`, `window` access, browser-only APIs, locale-dependent formatting.
- **Strategy**: 1. Identify the value that differs between server and client renders. 2. Move it into a `useEffect` with a local state variable — `useEffect` only runs on the client. 3. Render a placeholder or `null` on first render, then update after mount. 4. Use `suppressHydrationWarning` only on elements with genuinely intentional dynamic content such as timestamps.
- **Tool sequence**: file_read (component) → file_edit (move dynamic value to useEffect + useState)
- **Pitfall**: Do NOT use `suppressHydrationWarning` as a general fix. It hides real bugs where content genuinely differs.

### Missing key Prop in List
- **Symptom**: React warning `Each child in a list should have a unique "key" prop`
- **Cause**: `Array.map()` renders JSX elements without a `key` prop, or key is not unique within the list.
- **Strategy**: Add a stable, unique `key` to each element. Use the item's ID from data, not the array index.
- **Tool sequence**: grep (`\.map(`) → file_read (render section) → file_edit (add key prop)
- **Pitfall**: Do NOT use array index as key when the list can reorder, filter, or have items added or removed. Index keys cause incorrect reconciliation and state bugs.

### Cannot Read Property of Undefined (During Render)
- **Symptom**: `TypeError: Cannot read properties of undefined (reading 'x')` thrown during render
- **Cause**: Component accesses a property on a value that is `undefined` or `null` at mount time — typically async data, optional props, or uninitialized store state.
- **Strategy**: 1. Add a loading/null guard before the access: `if (!data) return null` or `data?.property`. 2. Provide a default value in the prop type or initial state. 3. Never assume async data is available at first render.
- **Tool sequence**: file_read (render return and prop types) → file_edit (add guard)
- **Pitfall**: Do NOT add `!` non-null assertion in TypeScript to hide this — the crash will still happen at runtime.

### Context Value Lost After Rerender
- **Symptom**: Component reads default context value instead of the provided value; context updates do not propagate.
- **Cause**: Provider is placed too low in the tree, or `value` prop creates a new object every render causing unnecessary re-renders and sometimes missed updates.
- **Strategy**: 1. Confirm the consuming component is inside the Provider in the tree. 2. Memoize the context value with `useMemo` to prevent new object reference on every render. 3. Split contexts if one high-frequency value is causing all consumers to re-render.
- **Tool sequence**: file_read (Provider placement) → file_read (consumer component) → file_edit (add useMemo to context value)
- **Pitfall**: Do NOT create the context value inline in the JSX without memoization — `value={{ foo, bar }}` creates a new object on every render.

### useRef Value Not Triggering Re-render
- **Symptom**: Component does not update when a `ref.current` value changes.
- **Cause**: `useRef` mutations do not trigger re-renders — this is by design.
- **Strategy**: If you need UI to update when a value changes, use `useState` or `useReducer` instead. Use `useRef` only for values that should NOT trigger re-renders: DOM references, timers, previous value tracking, and imperative handles.
- **Tool sequence**: file_read (ref usage) → file_edit (convert to useState if re-render is needed)
- **Pitfall**: Do NOT try to force a re-render after mutating a ref. Switch to state.

## Verification
- ESLint: `eslint --ext .tsx,.ts src/` — look for `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` violations.
- Type check: `tsc --noEmit`
- Dev server: confirm no console errors beginning with `Warning: ` or `Error: ` in the browser.

## Validation Checklist
- [ ] All hooks called unconditionally at component top level, before any early returns
- [ ] useEffect dependency arrays include all referenced variables (no exhaustive-deps suppressions)
- [ ] No inline object or array literals in dependency arrays
- [ ] All list renders have stable unique keys from data (not array index)
- [ ] Browser-only code wrapped in useEffect or guarded with `typeof window !== "undefined"`
- [ ] Context values memoized with useMemo if they are object or array literals
- [ ] Async data access guarded with null/undefined check at render time
