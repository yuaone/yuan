# React Hook Extraction Skill

## Identity
- domain: react
- type: refactor
- confidence: 0.80
- persona: Senior React developer specializing in hook architecture, composition patterns, and separation of concerns. Expert in identifying extractable logic, creating testable custom hooks, and maintaining clean component boundaries.

## Known Error Patterns

### 1. God Component (Too Much Logic)
- **symptoms**:
  - Component file exceeds 300 lines
  - Multiple unrelated `useState`/`useEffect` pairs in one component
  - Difficult to test individual behaviors
  - Multiple concerns mixed (data fetching, form handling, animations)
  - Code duplication across components for similar logic
- **causes**:
  - Organic growth without refactoring
  - All logic added directly to the component instead of hooks
  - No separation between presentation and business logic
- **strategy**:
  1. Identify logical groups: state + effects that belong together
  2. Extract each group into a named custom hook: `useFormValidation`, `useDataFetch`
  3. Component becomes a thin shell: hooks + JSX
  4. Each hook should have a single responsibility
  5. Hooks can compose other hooks
- **tools**: file_read, file_edit, grep
- **pitfalls**:
  - Do NOT extract a hook with 10+ return values -- split further
  - Do NOT create `useComponent` hooks that mirror the component 1:1 -- find meaningful abstractions
  - Hooks should be reusable, not just "code moved to another file"

### 2. Duplicated State Logic
- **symptoms**:
  - Same `useState` + `useEffect` pattern repeated in 3+ components
  - Copy-paste of fetch/loading/error state management
  - Identical form validation logic in multiple forms
  - Similar timer/interval patterns across components
- **causes**:
  - No shared hook library in the project
  - Developers unaware of existing hooks
  - Similar but slightly different requirements leading to copy-paste
- **strategy**:
  1. Grep for repeated patterns: `useState.*loading`, `useEffect.*fetch`
  2. Create a generalized hook with configuration parameters
  3. Use TypeScript generics for type-safe data hooks
  4. Document the hook's API and add it to a shared hooks directory
  5. Replace all duplicated instances with the new hook
- **tools**: grep, file_read, file_edit
- **pitfalls**:
  - Do NOT over-generalize -- if two patterns share 60% but differ in critical ways, two separate hooks may be better
  - Ensure the extracted hook handles all edge cases from every call site

### 3. Tightly Coupled Effects
- **symptoms**:
  - One `useEffect` does multiple unrelated things
  - Dependency array contains unrelated values
  - Changing one behavior requires modifying an unrelated effect
  - Difficult to reason about when effects run
- **causes**:
  - Multiple concerns combined in one effect for convenience
  - "Just add it to the existing effect" mentality
  - Unclear mental model of effect lifecycle
- **strategy**:
  1. Split into separate `useEffect` calls -- one per concern
  2. Group related state and effect into a custom hook
  3. Each effect should have a clear, single purpose
  4. Name the extracted hook after its purpose, not its implementation
- **tools**: file_read, file_edit
- **pitfalls**:
  - Multiple effects are fine -- React handles them well
  - Do NOT merge unrelated effects just to "reduce hook calls"
  - Watch for effects that depend on each other -- these might need `useReducer` instead

### 4. Untestable Component Logic
- **symptoms**:
  - Testing requires full component render for logic-only assertions
  - Mocking is excessive because logic is interleaved with rendering
  - Cannot test edge cases without UI interaction
  - Business logic cannot be reused in different UI contexts
- **causes**:
  - Business logic lives inside the component body
  - Data transformations done inline in JSX
  - Side effects triggered by rendering, not by explicit calls
- **strategy**:
  1. Extract logic into a custom hook
  2. Test the hook with `renderHook` from `@testing-library/react`
  3. Hook returns a clean API: `{ data, loading, error, actions }`
  4. Component becomes a thin rendering layer -- easy to test separately
  5. Hook can be reused in different UI contexts (mobile, desktop, CLI)
- **tools**: file_read, file_edit, shell_exec
- **pitfalls**:
  - `renderHook` is the correct way to test hooks -- do NOT call hooks outside React
  - If a hook needs complex setup, consider if it is doing too much

### 5. Hook Composition Failure
- **symptoms**:
  - Custom hook re-implements logic that exists in another hook
  - Deep hook call chains that are hard to debug
  - Hooks with too many parameters (> 4)
  - Return type is a large tuple or object with 8+ fields
- **causes**:
  - Not composing existing hooks
  - Trying to make one hook do everything
  - Flat hook architecture instead of layered
- **strategy**:
  1. Build hooks in layers: primitive hooks -> domain hooks -> feature hooks
  2. Primitive: `useLocalStorage`, `useDebounce`, `useMediaQuery`
  3. Domain: `useAuth` (uses `useLocalStorage`), `useApi` (uses `useDebounce`)
  4. Feature: `useUserSearch` (uses `useAuth` + `useApi` + `useDebounce`)
  5. Each layer adds specific domain knowledge
- **tools**: file_read, grep, file_edit
- **pitfalls**:
  - Avoid circular hook dependencies
  - Keep primitive hooks truly primitive -- no business logic
  - Document the hook layer architecture for the team

## Extraction Rules

### When to Extract
- Same logic appears in 2+ components
- Component has 3+ `useState` calls for unrelated concerns
- Component file exceeds 200 lines of logic (excluding JSX)
- An `useEffect` has 4+ dependencies from different concerns
- You need to test business logic independently from rendering

### When NOT to Extract
- Logic is used in exactly one component and is simple (< 20 lines)
- Extraction would create a hook with only one `useState` and no effects
- The "hook" would just be a wrapper around a single function call
- Logic is purely presentational (use a utility function instead)

### Naming Conventions
- `use<Resource><Action>`: `useUserFetch`, `useFormValidation`
- NOT `use<Component>Logic`: avoid `useHeaderLogic`, `useSidebarStuff`
- Return object, not tuple, if > 2 values: `{ data, loading, error, refetch }`
- File name matches hook name: `useUserFetch.ts`

### State + Effect Grouping
Group these together in one hook:
1. Related `useState` calls (e.g., `data`, `loading`, `error`)
2. The `useEffect` that manages them (e.g., fetch call)
3. Derived state (`useMemo`) from those states
4. Event handlers (`useCallback`) that modify those states

### Hook Composition Pattern
```
// Layer 1: Primitive
function useDebounce<T>(value: T, delay: number): T { ... }

// Layer 2: Domain
function useSearchApi(query: string) {
  const debouncedQuery = useDebounce(query, 300);
  const [results, setResults] = useState([]);
  useEffect(() => { /* fetch with debouncedQuery */ }, [debouncedQuery]);
  return { results };
}

// Layer 3: Feature
function useUserSearch() {
  const [query, setQuery] = useState('');
  const { results } = useSearchApi(query);
  const filtered = useMemo(() => filterActive(results), [results]);
  return { query, setQuery, results: filtered };
}
```

### Testing Custom Hooks
```
import { renderHook, act } from '@testing-library/react';
import { useCounter } from './useCounter';

test('should increment counter', () => {
  const { result } = renderHook(() => useCounter(0));
  act(() => { result.current.increment(); });
  expect(result.current.count).toBe(1);
});

test('should handle async operations', async () => {
  const { result } = renderHook(() => useDataFetch('/api/users'));
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.data).toBeDefined();
});
```

## Tool Sequence
1. **file_read** -- Read the target component to identify extractable logic groups
2. **grep** -- Search for similar patterns across the codebase to identify reuse opportunities
3. **grep** -- Check for existing hooks in `hooks/` or `utils/` that could be composed
4. **file_edit** -- Create the new custom hook file with full TypeScript types
5. **file_edit** -- Refactor the component to use the extracted hook
6. **file_edit** -- Create test file for the hook using `renderHook`
7. **shell_exec** -- Run `tsc --noEmit` to verify types
8. **shell_exec** -- Run tests to verify behavior is preserved

## Validation Checklist
- [ ] Hook has a single, clear responsibility
- [ ] Hook name follows `use<Resource><Action>` convention
- [ ] Return type is a typed object (not a large tuple)
- [ ] Hook is exported and documented with JSDoc
- [ ] Component is simpler after extraction (fewer lines, fewer concerns)
- [ ] All existing behavior is preserved (no regression)
- [ ] Hook test file exists with `renderHook` tests
- [ ] `tsc --noEmit` passes
- [ ] `pnpm build` passes
- [ ] No duplicated logic remains in the original component
