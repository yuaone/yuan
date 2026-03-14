## Identity
- domain: javascript
- type: language
- confidence: 0.90

# JavaScript — Error Pattern Reference

Read the full error message including the call stack. JavaScript errors are often discovered at runtime — the stack trace tells you the exact call chain. Enable strict mode and ESLint to catch many issues earlier.

## Error Code Quick Reference
- **TypeError: X is not a function** — Value is not callable (undefined/null/wrong type).
- **TypeError: Cannot read properties of undefined (reading 'x')** — Property access on undefined.
- **ReferenceError: X is not defined** — Variable not declared or not in scope.
- **SyntaxError: Cannot use import statement outside a module** — CommonJS vs ESM conflict.
- **UnhandledPromiseRejection** — Awaited promise rejected without catch.
- **RangeError: Maximum call stack size exceeded** — Infinite recursion.
- **TypeError: Assignment to constant variable** — Reassigning const.

## Known Error Patterns

### Pattern: undefined is not a function (this binding)

- **symptom**: `TypeError: this.myMethod is not a function` or `TypeError: undefined is not a function` inside a callback or event handler — `this` is not what was expected
- **cause**: When a method is passed as a callback, `this` is rebound to the caller's context (often `undefined` in strict mode, or the global object). Common in event listeners, setTimeout callbacks, array methods, and React class component methods.
- **strategy**: 1. Find where the method is passed as a callback — look for `addEventListener(event, obj.method)` or `arr.forEach(obj.method)`. 2. Bind `this` explicitly: `obj.method.bind(obj)`, or use an arrow function wrapper: `() => obj.method()`. 3. For class methods, use class field arrow functions: `myMethod = () => { ... }` (they bind `this` lexically). 4. For all new code, prefer arrow functions over regular functions in callbacks — arrow functions do not have their own `this`.
- **toolSequence**: grep (method name passed as callback) → file_read (method definition) → file_edit (add `.bind(this)` or convert to arrow function)
- **pitfall**: Do NOT use `.bind()` inside render loops or hot paths — it creates a new function reference on every call, causing unnecessary re-renders and GC pressure.

### Pattern: Promise not awaited (floating promise)

- **symptom**: `UnhandledPromiseRejection: ...` in Node.js, or async errors silently disappearing. A function is called that returns a Promise but the result is not awaited or `.catch()`-ed.
- **cause**: Calling an async function without `await` or `.then()/.catch()` creates a "floating promise" — it runs independently. If it rejects, the rejection is unhandled and either crashes the process (Node.js 15+) or silently disappears (older Node/browser).
- **strategy**: 1. Enable the `@typescript-eslint/no-floating-promises` or `no-promise-executor-return` ESLint rule to catch these statically. 2. Find async function calls that are not awaited: grep for function calls whose return type is `Promise`. 3. Add `await` at the call site if you need the result or want errors to propagate. 4. If truly fire-and-forget, add explicit error handling: `myAsync().catch(err => console.error(err))`. 5. In Node.js, register `process.on('unhandledRejection', ...)` to log unhandled rejections during development.
- **toolSequence**: grep (async function calls without await) → file_read → file_edit (add `await` or `.catch()`)
- **pitfall**: Do NOT add `void myAsync()` to silence the ESLint rule without adding error handling — errors will still be silently lost.

### Pattern: module resolution error (CommonJS vs ESM)

- **symptom**: `SyntaxError: Cannot use import statement outside a module` or `Error: require() of ES Module` or `ReferenceError: exports is not defined`
- **cause**: Mixing CommonJS (`require`/`module.exports`) and ESM (`import`/`export`) module systems in the same project or across package boundaries. Node.js treats `.js` files as CJS by default unless `"type": "module"` is set in `package.json`, or the file uses the `.mjs`/`.cjs` extension.
- **strategy**: 1. Read the error — it tells you which file is the problem. 2. Check `package.json` for `"type": "module"` or absence. 3. If the project is CJS, change `import/export` to `require/module.exports`. 4. If the project is ESM, change `require` to `import` and ensure all imports include file extensions (`.js`). 5. For files that must be CJS in an ESM project, rename to `.cjs`. 6. For Node.js scripts importing ESM packages, either switch the script to ESM or use dynamic `import()`.
- **toolSequence**: file_read (package.json "type" field) → file_read (error file) → file_edit (unify module syntax)
- **pitfall**: Do NOT mix `require` and `import` in the same file — choose one module system and be consistent. Some bundlers allow it but Node.js runtime does not.

### Pattern: closure in loop (var vs let)

- **symptom**: A loop creates functions (callbacks, event handlers, Promises) that all reference the same final value of the loop variable instead of each iteration's value. Classic: all closures log the same number (e.g., the loop limit).
- **cause**: `var` is function-scoped, not block-scoped. Inside a `for (var i = 0; ...)` loop, all closures share the same `i` variable — by the time the callback runs, `i` has already reached its final value. `let` creates a new binding per iteration.
- **strategy**: 1. Find `for (var ...` loops where closures are created inside. 2. Change `var` to `let` — this is the definitive fix for modern JavaScript. 3. For pre-ES6 compatibility, use an IIFE to capture the value: `(function(captured_i) { ... })(i)`. 4. Enable `no-var` ESLint rule to prevent `var` usage entirely.
- **toolSequence**: grep (`for (var `) → file_read (loop body for closures) → file_edit (change `var` to `let`)
- **pitfall**: Do NOT convert `var` to `const` in loop initializers — loop variables must be mutable. Use `let`.

### Pattern: prototype chain mutation

- **symptom**: Adding a property to a built-in prototype (`Array.prototype.myMethod`, `Object.prototype.helper`) causes unexpected properties to appear in `for...in` loops, third-party code breaks, or global behavior changes across the codebase.
- **cause**: Mutating built-in prototypes adds properties to all instances of that type globally. This pollutes every `for...in` loop that does not use `hasOwnProperty`, conflicts with future JavaScript built-ins of the same name, and breaks libraries that rely on prototype purity.
- **strategy**: 1. Grep for assignments to `*.prototype.*` on built-in types. 2. Replace with utility functions: instead of `Array.prototype.last = fn`, use a standalone `function last(arr) {}` or a module-level helper. 3. For polyfills, check if the property already exists before adding: `if (!Array.prototype.at) Array.prototype.at = ...`. 4. Use ES6+ class inheritance instead of prototype mutation for custom behavior. 5. Enable ESLint `no-extend-native` rule.
- **toolSequence**: grep (`prototype\.`) → file_read (each mutation) → file_edit (extract to utility function)
- **pitfall**: Do NOT add `hasOwnProperty` checks everywhere as a workaround — remove the prototype mutation at the source.

## Verification
Run: `node --check <file>` (syntax check) or `eslint <file>`
- For projects: `npx eslint src/` or `pnpm run lint`
- For Node.js module issues: `node -e "require('./file.js')"` or `node --input-type=module`

## Validation Checklist
- [ ] No `var` in loops that create closures — use `let`
- [ ] All async function calls either awaited or have `.catch()` error handling
- [ ] Module system is consistent (all CJS or all ESM) — no mixing
- [ ] No prototype mutation of built-in types
- [ ] Callbacks that reference `this` use arrow functions or explicit `.bind()`
- [ ] `eslint` passes with no errors
- [ ] No `UnhandledPromiseRejection` in Node.js output
