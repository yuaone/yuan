# React Bugfix Skill

## Identity
- domain: react
- type: bugfix
- confidence: 0.85
- persona: Senior React engineer with 8+ years of production debugging experience. Expert in React internals, reconciliation algorithm, fiber architecture, and common failure modes across CSR/SSR environments.

## Known Error Patterns

### 1. Hydration Mismatch
- **symptoms**:
  - "Text content does not match server-rendered HTML"
  - "Hydration failed because the initial UI does not match what was rendered on the server"
  - "There was an error while hydrating. Because the error happened outside of a Suspense boundary, the entire root will switch to client rendering"
  - Visual flicker on page load
  - Content changes immediately after hydration
- **causes**:
  - Direct access to `window`, `document`, `localStorage` during render
  - `Date.now()`, `Math.random()`, or locale-dependent formatting in render path
  - Conditional rendering based on `typeof window !== 'undefined'`
  - Browser extensions injecting DOM nodes
  - Different data between server and client (stale cache, time zones)
- **strategy**:
  1. Move client-only code into `useEffect` so it runs only after hydration
  2. Use `next/dynamic` with `{ ssr: false }` for client-only components
  3. Use `suppressHydrationWarning` as a last resort (only for intentional mismatches like timestamps)
  4. Create a `useIsClient()` hook: `const [isClient, setIsClient] = useState(false); useEffect(() => setIsClient(true), []); return isClient;`
  5. For third-party components that access `window`, wrap in dynamic import
- **tools**: grep, file_read, file_edit, shell_exec
- **pitfalls**:
  - Do NOT wrap everything in `useEffect` blindly -- this defeats SSR benefits
  - `suppressHydrationWarning` only suppresses warnings, does not fix the actual mismatch
  - Browser extensions (e.g., Grammarly, translation plugins) can cause hydration errors that are not your fault -- check if the issue reproduces in incognito mode

### 2. useEffect Infinite Loop
- **symptoms**:
  - "Maximum update depth exceeded"
  - "Too many re-renders. React limits the number of renders to prevent an infinite loop"
  - Browser tab freezing or crashing
  - CPU spike in devtools
  - Rapid state updates visible in React DevTools profiler
- **causes**:
  - Missing dependency array: `useEffect(() => { setState(val) })` (runs every render)
  - Object/array in dependency array: `useEffect(() => {}, [{ a: 1 }])` (new reference every render)
  - Setting state that is also a dependency: `useEffect(() => { setCount(count + 1) }, [count])`
  - Stale closure capturing outdated values, causing repeated updates
  - Calling a function that creates a new reference on every render as a dependency
- **strategy**:
  1. Check if dependency array exists -- add `[]` for mount-only effects
  2. Identify object/array deps -- stabilize with `useMemo` or `useCallback`
  3. Use functional updater: `setCount(prev => prev + 1)` instead of `setCount(count + 1)`
  4. Extract primitive values: `const { id } = obj; useEffect(() => {}, [id])` instead of `[obj]`
  5. Use `useRef` for values that should not trigger re-renders
  6. Consider `useReducer` for complex state logic to avoid multiple interdependent effects
- **tools**: file_read, grep, file_edit
- **pitfalls**:
  - Do NOT disable `eslint-plugin-react-hooks` exhaustive-deps rule
  - Do NOT use `// eslint-disable-next-line react-hooks/exhaustive-deps` without understanding why
  - An empty `[]` dependency array is only correct for true mount-only effects

### 3. State Not Updating
- **symptoms**:
  - UI does not reflect state change after `setState`
  - `console.log` after `setState` shows old value
  - State appears to "reset" or "revert"
  - Conditional logic based on state executes wrong branch
  - Multiple rapid updates only reflect the last one
- **causes**:
  - Direct mutation: `state.items.push(newItem); setState(state)` (same reference, no re-render)
  - Reading state immediately after `setState` (batched, asynchronous)
  - Derived state anti-pattern: duplicating prop into state without sync
  - Stale closure in event handler or timer callback
  - React 18 automatic batching grouping updates unexpectedly
- **strategy**:
  1. Always create new references: `setState(prev => [...prev, newItem])`
  2. For objects: `setState(prev => ({ ...prev, [key]: value }))`
  3. Use functional updater for sequential updates: `setCount(prev => prev + 1)`
  4. For derived state, compute during render instead of syncing with `useEffect`
  5. Use `flushSync` from `react-dom` only if you absolutely need synchronous updates (rare)
  6. Consider Immer (`useImmer`) for deeply nested state mutations
- **tools**: file_read, file_edit
- **pitfalls**:
  - Do NOT use `JSON.parse(JSON.stringify(state))` for deep cloning -- use structured clone or Immer
  - Do NOT read state right after setting it and expect the new value
  - Avoid `useEffect` to "sync" props to state -- this is almost always wrong

### 4. Key Prop Issues
- **symptoms**:
  - "Each child in a list should have a unique 'key' prop"
  - List items losing input focus on re-render
  - Animations not working correctly in lists
  - Wrong items being updated or deleted in lists
  - Component state being shared between different list items
- **causes**:
  - Using array index as key: `items.map((item, i) => <Item key={i} />)`
  - Missing key prop entirely
  - Non-unique keys (duplicate IDs in data)
  - Key changing on every render (e.g., `key={Math.random()}`)
  - Key not reflecting item identity (using wrong field)
- **strategy**:
  1. Use a stable, unique identifier from data: `key={item.id}`
  2. If no ID exists, generate one when creating the item (not during render)
  3. For static lists that never reorder, index is acceptable
  4. Use `crypto.randomUUID()` at item creation time, not render time
  5. For compound keys: `key={\`${item.type}-${item.id}\`}`
- **tools**: grep, file_read, file_edit
- **pitfalls**:
  - Index keys cause bugs when list is sorted, filtered, or items are inserted/removed
  - `key={Math.random()}` forces remount on every render -- massive performance issue
  - Keys must be stable across re-renders -- do NOT generate IDs in the render function

### 5. Memory Leaks
- **symptoms**:
  - "Can't perform a React state update on an unmounted component"
  - Increasing memory usage over time (check Performance tab)
  - Stale data appearing after navigation
  - Event listeners firing for unmounted components
  - WebSocket connections staying open after unmount
- **causes**:
  - Missing cleanup function in `useEffect`
  - Not aborting fetch requests on unmount
  - Not removing event listeners (`window.addEventListener` without cleanup)
  - Not clearing timers (`setInterval`, `setTimeout`)
  - Subscriptions (WebSocket, EventSource) not closed on unmount
- **strategy**:
  1. Always return cleanup from `useEffect`:
     ```
     useEffect(() => {
       const controller = new AbortController();
       fetch(url, { signal: controller.signal });
       return () => controller.abort();
     }, [url]);
     ```
  2. Use `AbortController` for all fetch calls
  3. Clear all timers: `return () => clearInterval(id);`
  4. Remove event listeners: `return () => window.removeEventListener('resize', handler);`
  5. Close WebSocket/EventSource connections in cleanup
  6. For React 18 Strict Mode double-mount, ensure cleanup is idempotent
- **tools**: grep, file_read, file_edit
- **pitfalls**:
  - React 18 Strict Mode in dev intentionally double-mounts -- this exposes leaks, do not suppress it
  - The "unmounted component" warning was removed in React 18 but the leak still exists
  - `AbortError` from aborted fetch is expected -- catch and ignore it

### 6. Conditional Hook Call
- **symptoms**:
  - "React Hook is called conditionally. React Hooks must be called in the exact same order"
  - "Rendered more hooks than during the previous render"
  - "Rendered fewer hooks than expected"
  - Cryptic errors after adding/removing hooks in conditionals
- **causes**:
  - Hook inside `if` statement or ternary
  - Hook after early return
  - Hook inside loop or nested function
  - Dynamic hook calls based on props
- **strategy**:
  1. Move all hooks to the top level of the component, before any conditionals
  2. Use the hook unconditionally, then conditionally use its result
  3. For conditional effects: `useEffect(() => { if (condition) { /* ... */ } }, [condition])`
  4. Split into separate components if hook logic is fundamentally conditional
  5. For dynamic lists of hooks, restructure to use a single hook with array state
- **tools**: file_read, file_edit
- **pitfalls**:
  - Hooks rely on call order -- React uses position to match hooks between renders
  - Even if a condition is "always true", the linter cannot verify it -- restructure instead
  - Custom hooks are still hooks -- they follow the same rules

### 7. Stale Closure
- **symptoms**:
  - Event handler uses outdated state value
  - `setTimeout`/`setInterval` callback sees initial state
  - Click handler in a loop always captures last iteration value
  - Async callback returns stale data after state changed
- **causes**:
  - Closure captures the state value at the time of creation
  - Event handler created in a previous render still references old state
  - Timer callback captures stale variable
- **strategy**:
  1. Use functional updater: `setState(prev => prev + 1)`
  2. Use `useRef` to always have current value: `const countRef = useRef(count); countRef.current = count;`
  3. Use `useCallback` with correct deps to recreate handler when deps change
  4. For intervals, use a custom `useInterval` hook with ref-based callback
  5. In event listeners, re-attach when deps change via useEffect cleanup
- **tools**: file_read, file_edit, grep
- **pitfalls**:
  - Adding state to useEffect deps to fix stale closure can introduce infinite loops -- use refs for read-only access
  - `useRef` does not trigger re-renders -- if you need both current value and re-render, combine ref + state

## Tool Sequence
1. **grep** -- Search for error pattern in source files (`**/*.tsx`, `**/*.jsx`)
2. **file_read** -- Read the identified file(s) to understand context
3. **grep** -- Search for related patterns (hook usage, state definitions, effect dependencies)
4. **file_read** -- Read related files (parent components, shared hooks, store)
5. **file_edit** -- Apply the fix with minimal changes
6. **shell_exec** -- Run `pnpm build` or `next build` to verify no build errors
7. **shell_exec** -- Run tests if available (`pnpm test` or `vitest run`)
8. **grep** -- Verify the error pattern no longer exists in build output

## Validation Checklist
- [ ] Error message no longer appears in console/build output
- [ ] `pnpm build` (or `next build`) passes without errors
- [ ] Existing tests pass (`pnpm test`)
- [ ] No new TypeScript errors (`tsc --noEmit`)
- [ ] No new ESLint warnings from `react-hooks/exhaustive-deps`
- [ ] Component renders correctly in both SSR and CSR
- [ ] No performance regression (no unnecessary re-renders introduced)
- [ ] Fix does not break other components that depend on the modified code
