# React Component Generator Skill

## Identity
- domain: react
- type: generator
- confidence: 0.90
- persona: Senior React architect specializing in component design patterns, atomic design methodology, and TypeScript-first component APIs. Expert in building reusable, accessible, and testable component libraries.

## Known Error Patterns

### 1. Missing TypeScript Props Interface
- **symptoms**:
  - Props typed as `any` or missing entirely
  - No autocomplete for component props in IDE
  - Runtime errors from unexpected prop types
  - `Property does not exist on type` errors
- **causes**:
  - Component created without explicit props type
  - Using `React.FC` without generic parameter
  - Props spread without type narrowing
- **strategy**:
  1. Define explicit interface for all props: `interface ButtonProps { ... }`
  2. Use discriminated unions for variant props
  3. Extend native HTML element props: `interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>`
  4. Export props interface for consumers
- **tools**: file_read, file_edit
- **pitfalls**:
  - Avoid `React.FC` -- it implicitly includes `children` in older React types and has issues with generics
  - Do NOT use `PropsWithChildren` unless the component truly accepts arbitrary children

### 2. Prop Drilling
- **symptoms**:
  - Same prop passed through 3+ component levels
  - Intermediate components accept props they do not use
  - Changing a prop signature requires editing many files
  - `...rest` spread used to forward unknown props
- **causes**:
  - Flat component hierarchy without composition
  - Missing context or state management for shared data
  - Over-reliance on top-down data flow
- **strategy**:
  1. Use compound component pattern with React context
  2. Use composition (children/render props) to skip levels
  3. Introduce React Context for widely-shared state
  4. Use Zustand/Jotai for cross-cutting application state
- **tools**: file_read, grep, file_edit
- **pitfalls**:
  - Do NOT create a context for every piece of state -- only for truly cross-cutting concerns
  - Context causes re-renders of all consumers -- split contexts by update frequency

### 3. Missing forwardRef
- **symptoms**:
  - `ref` prop not working on custom component
  - Warning: "Function components cannot be given refs"
  - Parent cannot access child DOM node for focus management
  - Animation libraries cannot attach to component
- **causes**:
  - Custom component does not use `forwardRef`
  - ref attached to wrong inner element
  - Generic component loses type information for ref
- **strategy**:
  1. Wrap with `React.forwardRef<HTMLElement, Props>((props, ref) => ...)`
  2. Attach ref to the outermost meaningful DOM element
  3. Use `useImperativeHandle` to expose a custom API
  4. For generic components, use the ref-forwarding generic pattern
- **tools**: file_read, file_edit
- **pitfalls**:
  - In React 19+, `ref` is a regular prop -- `forwardRef` will be unnecessary
  - `forwardRef` breaks generic inference -- use the function overload pattern for generic components

### 4. Controlled vs Uncontrolled Confusion
- **symptoms**:
  - "A component is changing an uncontrolled input to be controlled"
  - Input value not updating on change
  - Form reset not working
  - Default value ignored after mount
- **causes**:
  - Switching between `value` and `defaultValue`
  - Initial `value` is `undefined` (uncontrolled) then becomes defined (controlled)
  - Missing `onChange` handler with `value` prop
- **strategy**:
  1. Choose controlled or uncontrolled and be consistent
  2. For controlled: always pair `value` + `onChange`
  3. For uncontrolled: use `defaultValue` + `ref`
  4. Initialize state to empty string, not `undefined`: `useState('')`
  5. Build components that support both modes with internal state fallback
- **tools**: file_read, file_edit
- **pitfalls**:
  - `value={undefined}` makes it uncontrolled -- use `value={state ?? ''}` to stay controlled
  - `defaultValue` is only read on mount -- changes after mount are ignored

### 5. Accessibility Violations
- **symptoms**:
  - No keyboard navigation
  - Screen reader cannot identify interactive elements
  - Missing ARIA labels
  - Focus trap not working in modals
  - Color contrast failures
- **causes**:
  - Using `div` with `onClick` instead of `button`
  - Missing `aria-label` on icon buttons
  - Custom components not forwarding ARIA props
  - Missing focus management in dialogs
- **strategy**:
  1. Use semantic HTML elements (`button`, `nav`, `main`, `dialog`)
  2. Add `aria-label` to elements without visible text
  3. Implement keyboard handlers: `onKeyDown` for Enter/Space/Escape
  4. Use `role` attribute only when no semantic element exists
  5. Trap focus in modals with `inert` attribute or focus-trap library
- **tools**: file_read, file_edit, shell_exec
- **pitfalls**:
  - Do NOT add `role="button"` to a `div` when you can just use `<button>`
  - `tabIndex={0}` alone is not enough -- also need keyboard event handlers

## Component Patterns

### Atomic Design Hierarchy
```
atoms/       -- Button, Input, Icon, Text, Badge
molecules/   -- SearchInput, FormField, Card, MenuItem
organisms/   -- Header, Sidebar, DataTable, Form
templates/   -- DashboardLayout, AuthLayout
pages/       -- HomePage, SettingsPage
```

### Compound Component Pattern
```
<Select>
  <Select.Trigger />
  <Select.Content>
    <Select.Item value="a">Option A</Select.Item>
    <Select.Item value="b">Option B</Select.Item>
  </Select.Content>
</Select>
```
Uses React Context internally to share state between parent and children.

### Render Props / Children as Function
```
<DataFetcher url="/api/users">
  {({ data, loading, error }) => (
    loading ? <Spinner /> : <UserList users={data} />
  )}
</DataFetcher>
```
Useful for separating data logic from presentation.

### Controlled + Uncontrolled Dual Mode
```
function Input({ value: controlledValue, defaultValue, onChange, ...props }) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? '');
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : internalValue;

  const handleChange = (e) => {
    if (!isControlled) setInternalValue(e.target.value);
    onChange?.(e);
  };

  return <input value={value} onChange={handleChange} {...props} />;
}
```

### forwardRef + Generic Component
```
interface ListProps<T> {
  items: T[];
  renderItem: (item: T) => ReactNode;
}

function ListInner<T>(props: ListProps<T>, ref: React.ForwardedRef<HTMLUListElement>) {
  return (
    <ul ref={ref}>
      {props.items.map((item, i) => (
        <li key={i}>{props.renderItem(item)}</li>
      ))}
    </ul>
  );
}

const List = React.forwardRef(ListInner) as <T>(
  props: ListProps<T> & React.RefAttributes<HTMLUListElement>
) => ReactElement;
```

## Tool Sequence
1. **file_read** -- Read existing component files to understand project patterns and conventions
2. **grep** -- Search for import patterns, style approach (CSS modules, Tailwind, styled-components)
3. **grep** -- Search for existing similar components to maintain consistency
4. **file_edit** -- Create the component file with proper TypeScript types, props interface, and JSDoc
5. **file_edit** -- Create barrel export (update `index.ts`)
6. **file_edit** -- Create test file stub with basic render test
7. **shell_exec** -- Run `tsc --noEmit` to verify types
8. **shell_exec** -- Run `pnpm build` to verify integration

## Validation Checklist
- [ ] Props interface is exported and fully typed (no `any`)
- [ ] Component has JSDoc description
- [ ] Default props use parameter defaults, not `defaultProps`
- [ ] `forwardRef` is used if component wraps a DOM element
- [ ] Semantic HTML elements used (not div-soup)
- [ ] ARIA attributes present for interactive elements
- [ ] Component handles all required variants/states
- [ ] Barrel export updated (`index.ts`)
- [ ] `tsc --noEmit` passes
- [ ] `pnpm build` passes
