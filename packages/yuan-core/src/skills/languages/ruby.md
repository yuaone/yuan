## Identity
- domain: ruby
- type: language
- confidence: 0.92

# Ruby — Error Pattern Reference

Read the full backtrace before acting. Ruby exceptions include the class, message, and call stack — all three matter.

## Error Code Quick Reference
- **NoMethodError** — Called a method on nil or wrong object type.
- **LoadError** — require path not found; gem not installed or path wrong.
- **ArgumentError** — Wrong number of arguments or invalid argument value.
- **NameError** — Uninitialized constant; missing require or wrong namespace.
- **TypeError** — Operation applied to wrong type (e.g., nil coercion).
- **Encoding::UndefinedConversionError** — Encoding incompatibility during string conversion.
- **RuntimeError** — Generic raise without a specific exception class.
- **ZeroDivisionError** — Division by zero.
- **KeyError** — fetch on a Hash with a missing key and no default.
- **Errno::ENOENT** — File not found on disk.

## Known Error Patterns

### NoMethodError: undefined method for nil
- **Symptom**: `NoMethodError: undefined method 'foo' for nil:NilClass`
- **Cause**: A method is called on a variable that is nil. Common after a failed `find`, `first`, optional chain that returns nil, or a hash lookup with a missing key.
- **Strategy**: 1. Read the backtrace line to identify the variable. 2. Trace where the variable is assigned — grep the variable name and read assignments. 3. Add a nil guard: `return unless obj`, `obj&.method`, or raise a more descriptive error if nil is illegal at that point.
- **Tool sequence**: grep (variable assignment) → file_read (surrounding block) → file_edit (add nil guard)
- **Pitfall**: Do NOT add `.to_s` or similar to silence the error. Determine why nil is reaching that line.

### LoadError: cannot load such file
- **Symptom**: `LoadError: cannot load such file -- some/path`
- **Cause**: `require` or `require_relative` path is wrong, the gem is not in the Gemfile, or the gem is not installed.
- **Strategy**: 1. Check if the path is a gem name — grep Gemfile for the name. 2. If missing, add it with `bundle add <gem>`. 3. If it is a relative path, verify the file exists using shell_exec. 4. Check the load path with `$LOAD_PATH` in a debug session if the gem is installed but not found.
- **Tool sequence**: grep (Gemfile) → shell_exec (`ls` on path) → file_edit (Gemfile or require statement)
- **Pitfall**: Do NOT assume the gem is installed. Always check Gemfile.lock for the actual resolved gem list.

### ArgumentError: wrong number of arguments
- **Symptom**: `ArgumentError: wrong number of arguments (given N, expected M)`
- **Cause**: Calling a method with more or fewer arguments than defined. Common after refactoring method signatures.
- **Strategy**: 1. Read the method definition (grep the method name). 2. Count required, optional (`= default`), and splat (`*args`) parameters. 3. Fix the call site to match the signature. If the definition is wrong, update it and check all call sites.
- **Tool sequence**: grep (method name `def `) → file_read (definition) → grep (call sites) → file_edit
- **Pitfall**: Do NOT add default values to all parameters just to silence the error — required parameters are required for a reason.

### NameError: uninitialized constant
- **Symptom**: `NameError: uninitialized constant Foo::Bar`
- **Cause**: A class or module constant is referenced but not loaded. Missing require, wrong namespace, or autoloading not configured.
- **Strategy**: 1. Search for the class definition (grep `class Bar` or `module Bar`). 2. Check if the file is required or autoloaded. In Rails, verify the file is in an autoloaded directory. Outside Rails, add `require_relative` or `require`. 3. Check the namespace — `Foo::Bar` means `Bar` must be defined inside `module Foo`.
- **Tool sequence**: grep (`class Bar\|module Bar`) → file_read (top of failing file) → file_edit (add require or fix namespace)
- **Pitfall**: Do NOT add a `rescue NameError` to suppress this. Find and load the correct constant.

### Encoding::UndefinedConversionError
- **Symptom**: `Encoding::UndefinedConversionError: "\xXX" from ASCII-8BIT to UTF-8`
- **Cause**: A string with one encoding is being converted to an incompatible encoding. Common when reading binary files, external HTTP responses, or database fields without encoding declared.
- **Strategy**: 1. Identify the source of the problematic string (file read, HTTP body, DB field). 2. Set the correct source encoding: `string.force_encoding('UTF-8')` if you know the source is UTF-8. 3. Use `encode` with error handling: `string.encode('UTF-8', invalid: :replace, undef: :replace)` for lossy conversion if the data may be dirty. 4. For file reads, pass `encoding: 'UTF-8'` to `File.read`.
- **Tool sequence**: file_read (string source) → file_edit (add encoding declaration or encode call)
- **Pitfall**: Do NOT use `force_encoding` blindly — it only relabels the encoding without converting. Use `encode` when actual conversion is needed.

### Frozen String Modification
- **Symptom**: `FrozenError: can't modify frozen String` (or `RuntimeError` in older Ruby)
- **Cause**: Attempting to mutate a frozen string. Common with `# frozen_string_literal: true` magic comment, string literals from constants, or strings returned from certain gem methods.
- **Strategy**: 1. Read the line causing the error. 2. If using `<<`, `gsub!`, `sub!`, or direct index assignment, replace with the non-bang version and reassign: `str = str.gsub(...)`. 3. If mutation is intentional, use `str = str.dup` before mutating.
- **Tool sequence**: file_read (error line) → file_edit (replace mutating call with non-mutating + reassign)
- **Pitfall**: Do NOT remove the `# frozen_string_literal: true` comment. Fix the mutation instead.

## Verification
Run: `ruby -c <file>` for syntax check, `bundle exec ruby <file>` for runtime.
- For Rails: `bundle exec rails runner <file>` or run the test suite.
- Always run with `bundle exec` to use the Gemfile-resolved gem versions.

## Validation Checklist
- [ ] No `rescue Exception` without re-raising or explicit justification (catches signals)
- [ ] All `require` paths verified to exist or gem present in Gemfile
- [ ] nil guard added wherever a method result could be nil
- [ ] No `.freeze` removed to fix FrozenError — fix the mutation instead
- [ ] Encoding specified at string source, not just at the point of failure
- [ ] `bundle exec` used for all ruby/rake/rails invocations
- [ ] Method signatures verified at all call sites after any definition change
