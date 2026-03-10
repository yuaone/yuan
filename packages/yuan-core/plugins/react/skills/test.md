# React Test Generator Skill

## Identity
- domain: react
- type: testing
- confidence: 0.85
- persona: Senior test engineer specializing in React Testing Library, MSW for API mocking, and user-centric testing philosophy. Expert in writing tests that resemble how users interact with software, avoiding implementation detail testing.

## Known Error Patterns

### 1. Testing Implementation Details
- **symptoms**:
  - Tests break when refactoring internal component structure
  - Tests use `wrapper.instance()` or access internal state
  - Tests assert on class names, CSS properties, or DOM structure
  - Tests mock internal hooks or child component rendering
  - Tests break from renaming internal variables
- **causes**:
  - Using Enzyme-style testing patterns with RTL
  - Testing "how" instead of "what" the component does
  - Excessive mocking of internal modules
  - Selecting elements by class name or test ID instead of role
- **strategy**:
  1. Query by role: `getByRole('button', { name: /submit/i })`
  2. Query by label: `getByLabelText(/email/i)`
  3. Query by text: `getByText(/welcome/i)`
  4. Use `getByTestId` only as last resort
  5. Assert on visible output, not internal state
  6. Test user interactions, not method calls
- **tools**: file_read, file_edit, shell_exec
- **pitfalls**:
  - If you need `getByTestId` often, your component may lack proper accessibility
  - Do NOT test that `setState` was called -- test that the UI changed
  - Do NOT snapshot test frequently-changing components

### 2. Async Testing Failures
- **symptoms**:
  - "not wrapped in act(...)" warnings
  - Tests pass/fail intermittently (flaky tests)
  - Assertion runs before async operation completes
  - `waitFor` times out unexpectedly
  - State updates after test cleanup
- **causes**:
  - Not awaiting async operations
  - Using `getBy*` for elements that appear asynchronously (should use `findBy*`)
  - Missing `await` on `userEvent` calls (v14+)
  - Timer-dependent code without fake timers
  - Missing MSW handlers causing real network requests
- **strategy**:
  1. Use `findBy*` for elements that appear after async work: `await screen.findByText(/loaded/i)`
  2. Use `waitFor` for assertions that need retrying: `await waitFor(() => expect(...).toBe(...))`
  3. Always `await` userEvent calls: `await user.click(button)`
  4. Use `vi.useFakeTimers()` for timer-dependent code
  5. Set up MSW handlers for all API calls in tests
  6. Clean up with `afterEach` -- reset handlers, clear timers
- **tools**: file_read, file_edit, shell_exec
- **pitfalls**:
  - `waitFor` should contain only assertions, not side effects
  - Do NOT use `waitFor` with a `timeout` > 5000ms -- your test is probably wrong
  - `findBy*` already wraps `waitFor` -- do not nest them

### 3. Improper Mocking
- **symptoms**:
  - Tests pass but component fails in production
  - Mocks do not match real API shape (type mismatch)
  - Every test has extensive mock setup boilerplate
  - Changing API requires updating dozens of mock files
  - Tests do not catch real integration issues
- **causes**:
  - Manual mocking of `fetch`/`axios` instead of using MSW
  - Mock data not matching actual API response types
  - Over-mocking (mocking things that should be tested)
  - Not using TypeScript-typed mock factories
- **strategy**:
  1. Use MSW for API mocking -- intercepts at network level
  2. Define handlers per API endpoint: `rest.get('/api/users', (req, res, ctx) => ...)`
  3. Create typed mock factories: `function createMockUser(overrides?: Partial<User>): User`
  4. Share handlers across tests with a `handlers.ts` file
  5. Override individual handlers per test: `server.use(rest.get('/api/users', errorHandler))`
  6. Use `msw/node` for Vitest/Jest, `msw/browser` for Storybook
- **tools**: file_read, file_edit, grep
- **pitfalls**:
  - MSW v2 uses a different API than v1 -- check which version is installed
  - Do NOT mock `React.useState` or `React.useEffect` -- test the behavior they produce
  - Mock at the highest appropriate level (network > module > function)

### 4. Missing Edge Case Coverage
- **symptoms**:
  - Tests only cover the happy path
  - No tests for loading states, error states, empty states
  - No tests for boundary conditions (empty list, max length, special characters)
  - No tests for keyboard navigation or screen reader
  - Bugs found in production that should have been caught
- **causes**:
  - Rushing to meet coverage targets with superficial tests
  - Not thinking about failure modes during test design
  - No test plan or checklist
  - Only testing what was explicitly specified
- **strategy**:
  1. For each component, test: render, interaction, loading, error, empty, edge
  2. Test error boundaries: what happens when child throws
  3. Test with empty data, null data, maximum data
  4. Test keyboard interactions: Tab, Enter, Escape, Arrow keys
  5. Test responsive behavior if component adapts to screen size
  6. Test with slow network (MSW delay) for loading states
- **tools**: file_read, file_edit, shell_exec
- **pitfalls**:
  - 100% code coverage does not mean 100% bug coverage -- focus on behavior coverage
  - Do NOT write tests just to increase coverage numbers
  - Edge cases are where most production bugs live

### 5. Snapshot Testing Misuse
- **symptoms**:
  - Snapshot files are massive (1000+ lines)
  - Developers blindly update snapshots with `--update`
  - Snapshots break on every style change
  - Snapshots do not catch meaningful regressions
  - PR reviews skip snapshot diffs
- **causes**:
  - Snapshotting entire page/component trees
  - Using snapshots as primary testing strategy
  - Not combining with behavioral assertions
  - Snapshot of dynamic content (dates, random IDs)
- **strategy**:
  1. Use inline snapshots for small, stable output: `expect(result).toMatchInlineSnapshot()`
  2. Snapshot only the relevant portion, not the entire tree
  3. Combine with behavioral tests -- snapshots supplement, not replace
  4. Use `toMatchSnapshot` only for pure/stable components (icons, static layouts)
  5. Review every snapshot update carefully in PRs
  6. Prefer explicit assertions over snapshots for logic-heavy components
- **tools**: file_read, file_edit
- **pitfalls**:
  - If you update snapshots without reviewing, you may be locking in a bug
  - Snapshots with dynamic data (timestamps, UUIDs) will always fail -- mock or exclude
  - Large snapshot files are a code smell -- your component may be too big

## Test Structure Template

### Basic Component Test
```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders with label text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: /click me/i })).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    await user.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Click</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
```

### Async Component Test with MSW
```typescript
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { UserList } from './UserList';

const server = setupServer(
  http.get('/api/users', () => {
    return HttpResponse.json([
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ]);
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('UserList', () => {
  it('shows loading then users', async () => {
    render(<UserList />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows error on API failure', async () => {
    server.use(
      http.get('/api/users', () => {
        return HttpResponse.json({ message: 'Server Error' }, { status: 500 });
      })
    );
    render(<UserList />);
    expect(await screen.findByText(/error/i)).toBeInTheDocument();
  });

  it('shows empty message when no users', async () => {
    server.use(
      http.get('/api/users', () => {
        return HttpResponse.json([]);
      })
    );
    render(<UserList />);
    expect(await screen.findByText(/no users/i)).toBeInTheDocument();
  });
});
```

### Custom Hook Test
```typescript
import { renderHook, act } from '@testing-library/react';
import { useCounter } from './useCounter';

describe('useCounter', () => {
  it('initializes with default value', () => {
    const { result } = renderHook(() => useCounter(0));
    expect(result.current.count).toBe(0);
  });

  it('increments', () => {
    const { result } = renderHook(() => useCounter(0));
    act(() => result.current.increment());
    expect(result.current.count).toBe(1);
  });

  it('resets to initial value', () => {
    const { result } = renderHook(() => useCounter(5));
    act(() => result.current.increment());
    act(() => result.current.reset());
    expect(result.current.count).toBe(5);
  });
});
```

## RTL Query Priority (Use in This Order)
1. `getByRole` -- accessible role (button, heading, textbox, etc.)
2. `getByLabelText` -- form elements with labels
3. `getByPlaceholderText` -- input placeholders
4. `getByText` -- visible text content
5. `getByDisplayValue` -- current input value
6. `getByAltText` -- images
7. `getByTitle` -- title attribute
8. `getByTestId` -- last resort, data-testid attribute

## Tool Sequence
1. **file_read** -- Read the target component to understand its behavior and props
2. **grep** -- Search for existing test patterns in the project (test runner, assertion style)
3. **grep** -- Check for MSW setup, test utilities, custom render wrappers
4. **file_read** -- Read related hooks/stores that the component depends on
5. **file_edit** -- Create the test file following project conventions
6. **file_edit** -- Add MSW handlers if the component makes API calls
7. **shell_exec** -- Run tests: `pnpm test` or `vitest run <file>`
8. **shell_exec** -- Check coverage: `vitest run --coverage <file>`

## Validation Checklist
- [ ] Tests use `getByRole` or `getByLabelText` as primary queries (not `getByTestId`)
- [ ] All async operations are properly awaited
- [ ] Loading, success, error, and empty states are tested
- [ ] User interactions are tested with `userEvent` (not `fireEvent`)
- [ ] API calls are mocked with MSW (not manual fetch/axios mocks)
- [ ] No "act(...)" warnings in test output
- [ ] Tests do not depend on implementation details (class names, internal state)
- [ ] All tests pass: `pnpm test`
- [ ] No flaky tests (run 3x to verify)
- [ ] Edge cases covered (empty input, max length, special characters)
