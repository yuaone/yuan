## Identity
- domain: python
- type: language
- confidence: 0.9

# Python — Common Errors and Patterns

Read the full traceback from bottom to top. The bottom frame is the immediate cause; the top is the entry point.

## Known Error Patterns

### ModuleNotFoundError
- **Symptom**: `ModuleNotFoundError: No module named 'x'`
- **Cause**: Package not installed in the active environment, wrong virtual environment active, or a relative import missing the leading dot (`.`).
- **Strategy**: 1. Run `pip show <package>` to confirm installation. 2. Confirm the correct virtualenv is active (`which python`). 3. If it is a local module, check whether the import should be relative (`.module`) vs. absolute. 4. If the package is missing, install it and add to requirements.txt or pyproject.toml.
- **Tool sequence**: shell_exec (`pip show package`) → file_read (requirements.txt or pyproject.toml) → shell_exec (`pip install package`) → file_edit (update requirements)
- **Pitfall**: Do NOT install globally if the project uses a virtualenv. Installing globally can shadow the wrong version and break other projects.

### IndentationError / TabError
- **Symptom**: `IndentationError: unexpected indent`, `IndentationError: expected an indented block after ...`, or `TabError: inconsistent use of tabs and spaces`
- **Cause**: Mixed tabs and spaces in the same file, or wrong indent level after a block opener (`def`, `if`, `for`, `class`, `with`, `try`).
- **Strategy**: 1. Run `python -m py_compile file.py` to get the exact line. 2. Read that line and the line above it. 3. Use `expand` or editor settings to convert all tabs to 4 spaces. 4. Run `black file.py` or `autopep8 --in-place file.py` to auto-fix indentation.
- **Tool sequence**: shell_exec (`python -m py_compile file.py`) → file_read (reported line) → shell_exec (`black file.py` or `autopep8 --in-place file.py`)
- **Pitfall**: Do NOT fix indentation by eye in a file with mixed tabs and spaces. Convert all tabs to spaces first, then fix the structure.

### AttributeError: 'NoneType' has no attribute 'x'
- **Symptom**: `AttributeError: 'NoneType' object has no attribute 'foo'`
- **Cause**: A variable expected to hold an object is `None`. Typically from a function that returns `None` on failure, an uninitialized field, or a failed ORM query.
- **Strategy**: 1. Find where the variable is assigned (trace the traceback up). 2. Determine whether `None` is a valid value or an error. 3. If `None` is unexpected, add an assertion or raise early: `if obj is None: raise ValueError(...)`. 4. If `None` is valid, add a guard: `if obj is not None: obj.foo`.
- **Tool sequence**: file_read (assignment site from traceback) → file_edit (add None check or early raise)
- **Pitfall**: Do NOT use `getattr(obj, 'foo', None)` to hide the `None` object — that shifts the error downstream. Fix the root cause.

### TypeError — Wrong Number of Arguments
- **Symptom**: `TypeError: foo() takes X positional arguments but Y were given` or `TypeError: foo() missing Y required positional arguments`
- **Cause**: Calling a function with wrong argument count. Common: forgetting `self` when calling a method as a function, or passing too many positional args when some should be keyword args.
- **Strategy**: 1. Grep the function definition to read its signature. 2. Count the parameters. 3. Check if it is a method (requires `self`). 4. Fix the call site to match the signature.
- **Tool sequence**: grep (function/method name `def`) → file_read → file_edit (fix call site)
- **Pitfall**: Do NOT add `*args` or `**kwargs` to the function signature to silence the error. Fix the call.

### TypeError — Unsupported Operand Types
- **Symptom**: `TypeError: unsupported operand type(s) for +: 'int' and 'str'`
- **Cause**: Mixing incompatible types in an arithmetic or comparison operation. Often from user input (always a string) or mixed data sources.
- **Strategy**: 1. Read the line in the traceback. 2. Identify which variable has the unexpected type. 3. Add an explicit conversion: `int(x)`, `str(x)`, `float(x)` at the right point. 4. Add a type check if the input source is untrusted.
- **Tool sequence**: file_read (traceback line) → file_edit (add explicit conversion)
- **Pitfall**: Do NOT add a bare `try/except` around the operation to hide the error. Convert the type before the operation.

### KeyError on Dictionary Access
- **Symptom**: `KeyError: 'foo'`
- **Cause**: Accessing `dict['key']` when the key does not exist.
- **Strategy**: 1. Use `dict.get('key')` to return `None` when missing, or `dict.get('key', default)` for a default value. 2. If the key must exist, add an assertion or raise with a descriptive message: `if 'key' not in d: raise KeyError(f"Expected key 'key' in {d}")`. 3. If reading from external data, validate the schema before access.
- **Tool sequence**: file_read (traceback line) → file_edit (replace `dict[key]` with `dict.get(key)` or add guard)
- **Pitfall**: Do NOT wrap the access in bare `except KeyError: pass`. That hides missing data bugs.

### Circular Import
- **Symptom**: `ImportError: cannot import name 'X' from partially initialized module 'y'`
- **Cause**: Module A imports from module B, and module B imports from module A at the top level.
- **Strategy**: 1. Grep import statements in both modules to confirm the cycle. 2. Move shared types or functions to a third module that neither imports from the other two. 3. Alternatively, use a lazy import (move the import inside the function that needs it). 4. Avoid restructuring via `importlib.import_module` — that just hides the problem.
- **Tool sequence**: grep (import statements in both modules) → file_read → file_edit (move shared code to third module or use lazy import)
- **Pitfall**: Do NOT move the import to the bottom of the file as a workaround. That makes the dependency order implicit and fragile.

### RecursionError — Maximum Depth Exceeded
- **Symptom**: `RecursionError: maximum recursion depth exceeded`
- **Cause**: A recursive function has no base case, or the base case is never reached for the given input, or two functions call each other indefinitely.
- **Strategy**: 1. Read the function and identify the base case. 2. Add a print or log to confirm the base case is reachable. 3. If depth is legitimately large, increase with `sys.setrecursionlimit(N)` as a last resort. 4. Convert deep recursion to an iterative loop with an explicit stack.
- **Tool sequence**: file_read (recursive function) → file_edit (add/fix base case or convert to loop)
- **Pitfall**: Do NOT just increase the recursion limit without fixing the base case — that defers the crash.

### ValueError from Type Conversion
- **Symptom**: `ValueError: invalid literal for int() with base 10: 'abc'`
- **Cause**: Attempting to convert a string that does not represent the target type.
- **Strategy**: 1. Validate the input before conversion. 2. Wrap in a try/except and handle the ValueError specifically. 3. For user-facing input, return an error message rather than crashing.
- **Tool sequence**: file_read (conversion site) → file_edit (add try/except ValueError or pre-validation)
- **Pitfall**: Do NOT use a bare `except:` or `except Exception:`. Catch `ValueError` specifically.

## Verification
- Syntax: `python -m py_compile file.py` — exit 0 means no syntax errors.
- Tests: `pytest` or `python -m pytest` — all tests must pass.
- Type check (if project uses mypy): `mypy .` — zero errors.
- Linting: `flake8 .` or `ruff check .`

## Validation Checklist
- [ ] `python -m py_compile` exits 0 on all modified files
- [ ] All imports resolve in the active virtual environment
- [ ] No mixed tabs and spaces (run `black` or `autopep8`)
- [ ] All None-returning function calls guarded before attribute access
- [ ] All dict accesses use `.get()` or have key existence check
- [ ] Recursive functions have a reachable base case
- [ ] Tests pass with `pytest`
- [ ] mypy exits 0 if the project has a mypy configuration
