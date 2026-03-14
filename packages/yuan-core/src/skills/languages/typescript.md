## Identity
- domain: typescript
- type: language
- confidence: 0.95

# TypeScript — Error Pattern Reference

Read the exact error code first. Each TS error has a precise meaning — do not guess from the message alone.

## Error Code Quick Reference
- **TS2345** — Argument type mismatch. Read the function signature.
- **TS2322** — Assignment type mismatch. Read the variable declaration.
- **TS2304** — Cannot find name. Missing import or typo.
- **TS2339** — Property does not exist on type. Wrong type assumption.
- **TS2307** — Cannot find module. Missing package or wrong path.
- **TS7006** — Parameter implicitly has 'any'. Add explicit type.
- **TS2531** — Object is possibly null. Add null check.
- **TS2532** — Object is possibly undefined. Add undefined check.
- **TS2769** — No overload matches. Read all overload signatures.
- **TS1005** — Syntax error. Read the exact line and column.
- **TS2741** — Missing required properties in object literal.
- **TS2366** — Function lacks ending return statement.
- **TS2411** — Index signature incompatible.
- **TS4023** — Exported expression refers to unexported type.

## Known Error Patterns

### TS2345 — Wrong Argument Type
- **Symptom**: `Argument of type 'X' is not assignable to parameter of type 'Y'`
- **Cause**: Passing wrong type to function. Common cases: string where number expected, union type wider than parameter, optional field passed as required.
- **Strategy**: 1. Read the exact function signature by grepping the function name and reading its definition. 2. Identify which parameter is mismatched. 3. Fix the call site by passing the correct type or narrowing the value. Only add a type assertion if you have verified the runtime type is correct.
- **Tool sequence**: grep (function name) → file_read (definition) → file_edit (fix call site)
- **Pitfall**: Do NOT cast to `any` as a first resort. Read the actual expected type before touching the call site.

### TS2322 — Wrong Assignment Type
- **Symptom**: `Type 'X' is not assignable to type 'Y'`
- **Cause**: Assigning a value to a variable whose declared type does not accept it. Often: number assigned to string, wider union assigned to narrower union, optional assigned to required.
- **Strategy**: 1. Find the variable declaration (grep or file_read). 2. Decide whether the declaration is wrong (widen it) or the assigned value is wrong (narrow/convert it). 3. Fix the narrower of the two.
- **Tool sequence**: grep (variable name) → file_read (declaration) → file_edit
- **Pitfall**: Do NOT widen the type to `any` or `unknown` unless the variable genuinely needs to hold arbitrary values.

### TS2339 — Property Does Not Exist
- **Symptom**: `Property 'x' does not exist on type 'Y'`
- **Cause**: Accessing a property that is not in the type definition. Common after API response parsing, JSON.parse, or accessing a subtype's property on a base type.
- **Strategy**: 1. Grep the interface or type definition. 2. Check if the property exists but on a subtype — use type narrowing (`if ('x' in obj)` or `instanceof`). 3. If the property should exist, add it to the interface. 4. If it is conditional, make it optional (`x?: T`).
- **Tool sequence**: grep (interface name or type name) → file_read → file_edit
- **Pitfall**: Do NOT extend the interface blindly. Confirm the property actually exists at runtime before adding it to the type.

### TS2531 / TS2532 — Possibly Null or Undefined
- **Symptom**: `Object is possibly 'null'` or `Object is possibly 'undefined'`
- **Cause**: Using a value that TypeScript knows might be null or undefined without a guard.
- **Strategy**: Add an explicit check: `if (x !== null && x !== undefined)`, or use nullish coalescing `x ?? defaultValue`, or optional chaining `x?.property`. For function returns, add a null return guard at the top.
- **Tool sequence**: file_read (lines around error) → file_edit (add null check or optional chain)
- **Pitfall**: Do NOT use the non-null assertion operator `!` unless you can read code that guarantees non-null at that exact point. Using `!` without proof creates silent runtime crashes.

### TS2307 — Cannot Find Module
- **Symptom**: `Cannot find module './path' or its corresponding type declarations`
- **Cause**: Import path wrong, package not installed, missing `@types/` package, or tsconfig path alias not resolving.
- **Strategy**: 1. Verify the file exists at the import path using shell_exec. 2. Check tsconfig.json for path aliases that might apply. 3. Check package.json for the package. 4. If the package exists but lacks types, install `@types/<package>` or add a `.d.ts` declaration stub.
- **Tool sequence**: shell_exec (`ls <path>`) → file_read (tsconfig.json) → file_read (package.json) → shell_exec (pnpm add @types/package)
- **Pitfall**: Do NOT assume the import path is wrong — check tsconfig path aliases before renaming imports.

### TS7006 — Implicit Any on Parameter
- **Symptom**: `Parameter 'x' implicitly has an 'any' type`
- **Cause**: Function parameter has no type annotation and TypeScript cannot infer it from context.
- **Strategy**: Read how the function is called (grep call sites) to determine what type is actually passed. Add that type as an explicit annotation. If multiple types are possible, use a union type.
- **Tool sequence**: grep (function name call sites) → file_read (definition) → file_edit (add annotation)
- **Pitfall**: Do NOT write `: any` to satisfy the compiler. Infer the real type from the call sites.

### TS2769 — No Overload Matches
- **Symptom**: `No overload matches this call` with a list of overload candidates
- **Cause**: Calling a function with arguments that do not satisfy any of its overload signatures.
- **Strategy**: 1. Read ALL listed overload signatures in the error output. 2. Identify which argument is causing the mismatch (the error lists which overload got closest). 3. Fix the argument type or add the correct overload if you own the function.
- **Tool sequence**: file_read (error output fully) → grep (function definition) → file_read → file_edit
- **Pitfall**: Do NOT add a new overload signature as a first resort if you do not own the library. Fix the call site argument.

### TS2741 — Missing Required Properties
- **Symptom**: `Type 'X' is missing the following properties from type 'Y': a, b, c`
- **Cause**: Object literal or variable missing required fields for the target interface.
- **Strategy**: 1. Read the target interface definition. 2. Add all missing required properties. 3. If a property should be optional, make it optional in the interface (if you own it).
- **Tool sequence**: grep (interface name) → file_read → file_edit (add missing fields)
- **Pitfall**: Do NOT make all fields optional to silence the error. Required fields exist for a reason.

### Type Narrowing Failure
- **Symptom**: TypeScript still shows a union type inside a conditional block that should have narrowed it
- **Cause**: The narrowing condition uses a pattern TypeScript does not recognize, or a type guard function is not declared with a type predicate.
- **Strategy**: Use `typeof x === "string"`, `x instanceof ClassName`, discriminant property check (`x.kind === "foo"`), or a type predicate function `(x): x is SpecificType`. Ensure the check is directly in the condition — TypeScript does not follow complex indirect narrowing.
- **Tool sequence**: file_read (narrowing block) → file_edit (replace condition with recognized narrowing pattern)
- **Pitfall**: Do NOT use `x as SpecificType` inside the block to work around failed narrowing. Fix the condition.

### Circular Type Reference
- **Symptom**: `Type alias 'X' circularly references itself` or extremely slow tsc
- **Cause**: Type A references Type B which references Type A directly.
- **Strategy**: Break the cycle by introducing an intermediate interface or by using `interface` instead of `type` alias (interfaces handle some recursive cases). Extract shared fields into a base interface.
- **Tool sequence**: grep (type name references) → file_read → file_edit (introduce base interface)
- **Pitfall**: Do NOT wrap in `any` to break the cycle. The circular reference usually signals a design issue.

## Verification
Run: `tsc --noEmit`
- Exit 0 with no output = success.
- Any line starting with `error TS` = failure. The format is `file(line,col): error TSxxxx: message`.
- Always read the full error line including file path and column number before acting.

## Validation Checklist
- [ ] `tsc --noEmit` exits 0
- [ ] No `as any` added without a comment explaining the runtime guarantee
- [ ] No non-null assertions `!` added without a comment citing the proof
- [ ] All new interfaces have required fields marked optional only if they can genuinely be absent
- [ ] No `@ts-ignore` or `@ts-expect-error` added to suppress errors without comment
- [ ] Import paths verified to exist on disk or in tsconfig aliases
