## Identity
- domain: lua
- type: language
- confidence: 0.88

# Lua — Error Pattern Reference

Read the exact error message including the file path and line number. Lua errors are often runtime-only — the interpreter does not check types or undefined variables at load time.

## Error Code Quick Reference
- **"attempt to index a nil value"** — Accessing a field on a nil variable or missing table key.
- **"attempt to call a nil value"** — Calling a function that is nil (not found or not loaded).
- **"attempt to perform arithmetic on a nil value"** — Math on nil variable.
- **"attempt to concatenate a nil value"** — String concatenation with nil.
- **"stack overflow"** — Infinite recursion without a base case.
- **"bad argument #N to 'func'"** — Wrong type passed to a built-in or type-checked function.
- **"table index is nil"** — Using nil as a table key: `t[nil] = value`.
- **"module 'x' not found"** — `require` failed; package.path doesn't include the module location.

## Known Error Patterns

### Nil Value Error — Missing Table Key
- **Symptom**: `attempt to index a nil value (global 'config')` or `attempt to index a nil value (field 'options')`; crash on accessing a nested field.
- **Cause**: A table key that was expected to exist returns `nil` in Lua — there is no KeyError, just silent nil. Chaining dot access on a nil result then causes a crash: `config.database.host` crashes if `config.database` is nil.
- **Strategy**: 1. Add nil guards before table access: `if config and config.database then ... end`. 2. Provide defaults with `or`: `local host = (config and config.database and config.database.host) or "localhost"`. 3. Write a safe-get helper: `local function get(t, ...) local v = t; for _, k in ipairs({...}) do if type(v) ~= "table" then return nil end; v = v[k] end; return v end`. 4. For optional config, always initialize tables with defaults before use.
- **Tool sequence**: file_read (nil access location) → file_edit (add nil check guards or default values)
- **Pitfall**: Do NOT use `pcall` to silently swallow nil errors — use it to catch errors but always log the error message for diagnosis.

### Global vs Local Variable Confusion
- **Symptom**: A variable modified in a function doesn't change the outer value (or unexpectedly does); different files sharing the same global name clobber each other; module-level state bleeds between tests.
- **Cause**: In Lua, variables are global by default unless declared with `local`. `x = 5` sets a global; `local x = 5` creates a local. A common mistake: forgetting `local` inside a function creates an unintended global that persists and conflicts.
- **Strategy**: 1. Declare all variables with `local` unless global access is explicitly intended. 2. Use `luacheck` to detect global variable usage: it warns on undefined globals and accidental global creation. 3. Enforce strict mode in environments that support it: `local _ENV = setmetatable({}, {__newindex = function() error("global write") end, __index = _G})`. 4. For modules, return a table of public functions instead of using globals. 5. Grep for assignments without `local` at function scope.
- **Tool sequence**: shell_exec (`luacheck <file.lua>`) → file_read → file_edit (add `local` keyword to variable declarations)
- **Pitfall**: Do NOT add `local` to a variable that is intentionally global (e.g., a registered callback that another module reads) — understand the scoping intent before adding `local`.

### 1-Based Indexing Error — Off-By-One in Arrays
- **Symptom**: Last element of a table is not processed; first element is skipped; `table[0]` returns nil when the array has elements.
- **Cause**: Lua arrays are 1-indexed by convention — `t[1]` is the first element, `t[#t]` is the last. Programmers from C, Python, or JavaScript expect 0-based indexing. `t[0]` is a valid key (Lua tables have no restriction) but it is not part of the array sequence and `#t` ignores it.
- **Strategy**: 1. Loops should start at `1`: `for i = 1, #t do`. 2. The last element is `t[#t]`, not `t[#t - 1]`. 3. For string operations, `string.sub(s, 1, 1)` is the first character, `string.sub(s, -1)` is the last. 4. When interfacing with C APIs that return 0-based indices, add 1 before using as a Lua table index. 5. Use `ipairs` for forward iteration over sequences — it starts at 1 and stops at the first nil.
- **Tool sequence**: grep (`\[0\]`, `for i = 0`) → file_read → file_edit (fix to 1-based indices)
- **Pitfall**: Do NOT use `pairs` where you need ordered array iteration — `pairs` has undefined order. Use `ipairs` for arrays.

### Metamethod Not Set — __index Missing for OOP
- **Symptom**: `attempt to index a nil value (method 'draw')` when calling a method on an "object"; the method is defined in a base class but not accessible on instances.
- **Cause**: Lua does not have built-in OOP. The common pattern uses metatables: `setmetatable(instance, {__index = BaseClass})`. If `__index` is not set, method lookups fall through to nil. Forgetting to call the constructor or set the metatable on instances breaks method dispatch.
- **Strategy**: 1. Verify the class constructor sets the metatable: `setmetatable(self, ClassName); ClassName.__index = ClassName`. 2. Check that `ClassName.__index = ClassName` is set (or `__index` points to the methods table). 3. For inheritance: `setmetatable(Child, {__index = Parent})` — missing this breaks parent method access. 4. Use a consistent OOP pattern (e.g., `middleclass`, `30log`) rather than rolling your own metamethod setup, which is error-prone.
- **Tool sequence**: grep (`setmetatable`, `__index`) → file_read (class definition) → file_edit (add missing __index assignment)
- **Pitfall**: Do NOT set `__index = self` on an instance — it should be `__index = ClassName` (the class table), not the instance itself.

### Coroutine Yield Across C Boundary
- **Symptom**: `attempt to yield from outside a coroutine` or `attempt to yield across a C-call boundary`; coroutine yields work in pure Lua but crash when called from C callbacks.
- **Cause**: When Lua is embedded in a C application (e.g., Nginx/OpenResty, game engines), some C API callbacks don't support Lua coroutine yields. The Lua C API `lua_yield` cannot be called from a C function that was itself called from a C function not designed for yielding.
- **Strategy**: 1. Identify which C callbacks are involved in the yield path (Nginx directives, game engine callbacks). 2. Check if the embedding environment provides coroutine-compatible APIs (e.g., OpenResty's `ngx.sleep` instead of OS sleep). 3. Use `coroutine.wrap` with `pcall` to catch yield errors gracefully. 4. Restructure to avoid yielding from within C-initiated callbacks — use event-driven callbacks instead of blocking yields. 5. Use `lua_isyieldable()` to check before yielding.
- **Tool sequence**: grep (`coroutine.yield`, `coroutine.resume`) → file_read → file_edit (use environment-specific non-blocking alternatives)
- **Pitfall**: Do NOT wrap a yield in `pcall` to suppress the error — the coroutine does not actually yield and the operation blocks. Use environment-provided async APIs.

### require Path Not Found — Module Loading Failure
- **Symptom**: `module 'mymodule' not found: no field package.preload['mymodule']...`; the file exists but Lua cannot find it.
- **Cause**: Lua searches `package.path` for modules (`.lua` files) and `package.cpath` for C modules (`.so`/`.dll`). The default path may not include the project directory. Module names use dots as separators which map to directory separators.
- **Strategy**: 1. Print the current path: `print(package.path)`. 2. Add the project root to the path: `package.path = package.path .. ";./?.lua;./src/?.lua"` (or set `LUA_PATH` environment variable). 3. Check module name matches file path: `require("utils.helpers")` looks for `utils/helpers.lua`. 4. For LuaRocks modules, verify installation: `luarocks list`. 5. In embedded Lua, the host application may need to set `package.path` explicitly.
- **Tool sequence**: shell_exec (`lua -e "print(package.path)"`) → file_read (module loading code) → file_edit (add correct path to package.path)
- **Pitfall**: Do NOT use absolute paths in `require()` — always use relative module paths with dots. Absolute paths are not portable.

## Verification
Run: `luac -p <file.lua>` for syntax check, then `lua <file.lua>` for runtime.
- Run luacheck: `luacheck . --globals <known_globals>` — zero errors, zero warnings.
- Run LuaUnit or busted test suite: all tests must pass.

## Validation Checklist
- [ ] All variables declared with `local` unless intentionally global
- [ ] All table accesses guarded with nil checks or `and` short-circuit
- [ ] Array loops start at index `1`, not `0`
- [ ] All class definitions have `ClassName.__index = ClassName` set
- [ ] `setmetatable` called on every class instance in the constructor
- [ ] No coroutine yields inside C callback boundaries
- [ ] `require` paths use dot notation and match the actual file structure
- [ ] `package.path` configured correctly for the project layout
- [ ] luacheck passes with no undefined globals
- [ ] All error paths use `error()` or return `nil, error_message` — not silent nil returns
