## Identity
- domain: c
- type: language
- confidence: 0.93

# C — Error Pattern Reference

Compile with warnings enabled: `-Wall -Wextra -Werror`. Many C bugs are silent at compile time but fatal at runtime. Always use a sanitizer (`-fsanitize=address,undefined`) during development.

## Compiler Warning Quick Reference
- **-Wimplicit-function-declaration** — Calling a function without a prototype.
- **-Wuninitialized** — Variable used before assignment.
- **-Wformat** — printf/scanf format string mismatch.
- **-Wreturn-type** — Missing return in non-void function.
- **-Warray-bounds** — Array index out of declared bounds (static analysis only).
- **-Wconversion** — Implicit narrowing conversion.
- **-Wnull-dereference** — Pointer that may be NULL is dereferenced.

## Known Error Patterns

### Segmentation Fault — Null Pointer Dereference
- **Symptom**: Program crashes with `Segmentation fault (core dumped)`. GDB shows crash at a pointer dereference.
- **Cause**: Dereferencing a pointer that is NULL, uninitialized, or has been freed. Common after `malloc` failure (returns NULL), a function returning NULL on error, or using a pointer before assignment.
- **Strategy**: 1. Run under GDB: `gdb ./program core` then `bt` for backtrace. 2. Identify the faulting line. 3. Add a NULL check before every pointer dereference. 4. For `malloc`: always check `if (ptr == NULL) { /* handle */ }` immediately after allocation. 5. Run with AddressSanitizer: `gcc -fsanitize=address -g` for detailed diagnostics.
- **Tool sequence**: shell_exec (`gcc -g -fsanitize=address`) → shell_exec (run program) → file_read (faulting line) → file_edit (add NULL check)
- **Pitfall**: Do NOT assume `malloc` always succeeds. Check the return value every time.

### Buffer Overflow — strcpy / gets / sprintf
- **Symptom**: Program writes garbage data, crashes unpredictably, or behaves differently between debug and release builds. ASan reports `heap-buffer-overflow` or `stack-buffer-overflow`.
- **Cause**: `strcpy`, `gets`, `sprintf`, or manual loop writes beyond the allocated buffer. `gets` has no length argument and is inherently unsafe.
- **Strategy**: 1. Replace `gets` with `fgets(buf, sizeof(buf), stdin)`. 2. Replace `strcpy(dst, src)` with `strncpy(dst, src, sizeof(dst) - 1); dst[sizeof(dst)-1] = '\0';` or use `strlcpy` if available. 3. Replace `sprintf` with `snprintf(buf, sizeof(buf), fmt, ...)`. 4. Audit every buffer write in the file for bound checks.
- **Tool sequence**: grep (`strcpy\|gets\|sprintf`) → file_read → file_edit (replace with safe variants)
- **Pitfall**: `strncpy` does NOT null-terminate if the source is longer than n. Always manually set `dst[n-1] = '\0'`.

### Memory Leak — malloc Without free
- **Symptom**: Program memory usage grows unboundedly. Valgrind reports `definitely lost` or `indirectly lost` blocks.
- **Cause**: Memory allocated with `malloc`/`calloc`/`realloc` is not freed on all code paths, especially error paths.
- **Strategy**: 1. Run with Valgrind: `valgrind --leak-check=full ./program`. 2. For each allocation, trace all code paths and confirm `free` is called. 3. Use a consistent pattern: allocate near the start of a scope, free at the end via a cleanup label (`goto cleanup`). 4. Ensure error paths also reach the cleanup label.
- **Tool sequence**: shell_exec (`valgrind --leak-check=full`) → grep (`malloc\|calloc`) → file_read (all exit paths) → file_edit (add free on all paths)
- **Pitfall**: Do NOT free a pointer and then use it. Set it to NULL after freeing: `free(p); p = NULL;`.

### Undefined Behavior — Signed Integer Overflow
- **Symptom**: Unexpected values or crashes only in optimized builds (`-O2`). UBSan reports `signed integer overflow`.
- **Cause**: Signed integer overflow is undefined behavior in C. Compilers exploit this for optimization, leading to code elimination or wrong values. Common in loop counters, hash functions, and arithmetic.
- **Strategy**: 1. Compile with `-fsanitize=undefined` to detect overflows. 2. For arithmetic that may overflow, use unsigned types or check before the operation: `if (a > INT_MAX - b) { /* overflow */ }`. 3. Do NOT rely on signed wrap-around behavior.
- **Tool sequence**: shell_exec (`gcc -fsanitize=undefined -g`) → file_read (arithmetic code) → file_edit (add overflow check or use unsigned)
- **Pitfall**: Do NOT use `(int)(a + b)` cast to suppress the warning. The overflow happens before the cast.

### Implicit Function Declaration
- **Symptom**: Compiler warning: `implicit declaration of function 'foo'`; in C99 and later this is an error.
- **Cause**: Calling a function before its prototype is declared. Missing `#include` for a library function, or a function defined later in the file without a forward declaration.
- **Strategy**: 1. For standard library functions, identify and add the correct `#include`. 2. For project-internal functions, add a forward declaration at the top of the file or move the definition above the call site. 3. Always compile with `-Wimplicit-function-declaration -Werror`.
- **Tool sequence**: grep (`#include`) → file_read (function call line) → shell_exec (`man <function>` for required header) → file_edit (add include or forward declaration)
- **Pitfall**: Do NOT add an implicit `int` return type declaration manually — add the full correct prototype.

### Use of Uninitialized Variable
- **Symptom**: Garbage values read, random behavior, or UBSan reports `use of uninitialized value`.
- **Cause**: Local variable declared but not assigned before first read. Conditional initialization that misses a code path.
- **Strategy**: 1. Compile with `-Wuninitialized`. 2. Initialize all local variables at declaration: `int count = 0;`, `char *p = NULL;`. 3. For structs, use `= {0}` to zero-initialize: `struct Foo f = {0};`.
- **Tool sequence**: shell_exec (`gcc -Wall -Wuninitialized`) → file_read (variable declaration) → file_edit (add initializer)
- **Pitfall**: Do NOT rely on global/static variables being zero-initialized to justify skipping local initialization. Be explicit.

## Verification
Compile command: `gcc -Wall -Wextra -Werror -g -fsanitize=address,undefined -o program main.c`
- Fix all warnings before proceeding — `-Werror` enforces this.
- Run Valgrind for memory checks in CI: `valgrind --error-exitcode=1 ./program`

## Validation Checklist
- [ ] `gcc -Wall -Wextra -Werror` produces zero warnings
- [ ] Every `malloc`/`calloc`/`realloc` return value checked for NULL
- [ ] Every `free` followed by setting pointer to NULL
- [ ] No `gets`, `strcpy`, or unbounded `sprintf` in codebase
- [ ] All local variables initialized at declaration
- [ ] No signed integer arithmetic that can overflow without a guard
- [ ] All functions declared before first use (via include or forward declaration)
- [ ] Tested with `-fsanitize=address,undefined` during development
