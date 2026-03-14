## Identity
- domain: cpp
- type: language
- confidence: 0.93

# C++ — Error Pattern Reference

Compile with `-Wall -Wextra -Werror -std=c++17` (or `c++20`). Use sanitizers (`-fsanitize=address,undefined`) and run under Valgrind. Prefer RAII and smart pointers to manual memory management.

## Compiler Warning Quick Reference
- **-Wdelete-non-virtual-dtor** — Deleting through base pointer without virtual destructor.
- **-Wunused-variable / -Wunused-parameter** — Declared but never used.
- **-Wreorder** — Member initializer order does not match declaration order.
- **-Wshadow** — Local variable shadows outer scope variable.
- **-Wreturn-type** — Non-void function missing return.
- **-Wnull-dereference** — Pointer that may be null is dereferenced.

## Known Error Patterns

### Use-After-Free — Dangling Pointer
- **Symptom**: ASan reports `heap-use-after-free`. Program crashes with random values or corrupt behavior.
- **Cause**: A raw pointer is used after `delete` (or `delete[]`) has been called on it. Common after ownership transfer without setting the old pointer to `nullptr`, or returning a reference to a local variable.
- **Strategy**: 1. Run with ASan: `g++ -fsanitize=address -g`. 2. Identify the delete and the subsequent access. 3. After deleting a raw pointer, set it to `nullptr`. 4. Prefer `std::unique_ptr` or `std::shared_ptr` — they prevent use-after-free by tying lifetime to scope. 5. Never return a reference or pointer to a local variable.
- **Tool sequence**: shell_exec (`g++ -fsanitize=address -g && ./program`) → file_read (reported lines) → file_edit (replace raw pointer with smart pointer or add nullptr assignment)
- **Pitfall**: Do NOT check `if (ptr != nullptr)` after use-after-free — once freed, the pointer is invalid even if not null.

### Double Free
- **Symptom**: ASan reports `double-free`. `glibc` detected "double free or corruption". Crash in heap management code.
- **Cause**: `delete` or `free` called twice on the same pointer. Happens when multiple owners hold raw pointers to the same allocation, or a copy constructor/assignment is missing (Rule of Three/Five).
- **Strategy**: 1. Grep for `delete` and `free` on the affected pointer. 2. Ensure only one owner calls delete. 3. Use `std::unique_ptr` to enforce single ownership. 4. If a class manages memory, implement the Rule of Five (destructor, copy ctor, copy assign, move ctor, move assign) or use `= delete` for copy.
- **Tool sequence**: grep (`delete\|free`) → file_read (class definition) → file_edit (add Rule of Five or use smart pointer)
- **Pitfall**: Setting pointer to `nullptr` after delete prevents double-free on the same pointer variable, but does NOT help if the pointer was copied first.

### ODR Violation — Multiple Definitions
- **Symptom**: Linker error: `multiple definition of 'foo'`; or subtle wrong-behavior bugs with no error (when violations occur across translation units with different definitions).
- **Cause**: A function or non-inline variable defined (not just declared) in a header file that is included in multiple translation units. Or the same name defined twice in different `.cpp` files.
- **Strategy**: 1. For functions defined in headers, mark them `inline` or move the definition to a `.cpp` file. 2. For variables in headers, use `inline` variable (C++17): `inline int g_count = 0;` or declare `extern` in header and define in one `.cpp`. 3. For templates, definitions in headers are allowed and do not violate ODR as long as they are identical.
- **Tool sequence**: grep (function/variable name across headers) → file_read → file_edit (add `inline` or move to .cpp)
- **Pitfall**: Do NOT add `static` to a header function to suppress the linker error — this gives each TU its own copy, which is a different bug.

### std::vector Iterator Invalidation
- **Symptom**: Crash or undefined behavior after modifying a `std::vector` while iterating it. Sanitizers may report heap-use-after-free.
- **Cause**: `push_back`, `insert`, `erase`, or `resize` may reallocate the vector's internal buffer, invalidating all iterators, references, and pointers into the vector. Continuing to use old iterators causes UB.
- **Strategy**: 1. Identify any modification to the vector inside a loop that iterates it. 2. For `erase`: use the erase-remove idiom or capture the returned iterator: `it = vec.erase(it)`. 3. For `push_back` during iteration: collect new elements in a separate vector and append after the loop. 4. If indices are used instead of iterators, re-read the index from the start after mutation.
- **Tool sequence**: grep (`push_back\|erase\|insert`) → file_read (enclosing loop) → file_edit (fix iteration pattern)
- **Pitfall**: Do NOT cache `vec.end()` before a loop that modifies the vector — recompute it or use index-based iteration.

### Template Instantiation Error
- **Symptom**: Long compiler error message starting with "note: required from here" with a chain of template instantiations. The actual error is at the bottom of the chain.
- **Cause**: A template is instantiated with a type that does not satisfy the template's requirements (missing method, wrong type, etc.). Concept violations (C++20) or SFINAE failures.
- **Strategy**: 1. Read the error from the BOTTOM UP — the root cause is at the last "error:" line. 2. Identify the type being substituted. 3. Check what operations the template body performs on `T` and confirm the substituted type supports them. 4. In C++20, use concepts to get clearer error messages.
- **Tool sequence**: file_read (full error output, bottom first) → grep (template definition) → file_read → file_edit (constrain template or fix calling type)
- **Pitfall**: Do NOT add template specializations to paper over a type mismatch. Fix the type or add proper constraints.

### Missing Virtual Destructor
- **Symptom**: Valgrind reports memory leaks for derived class members. Objects deleted through base pointer only partially destroy the object.
- **Cause**: A base class with virtual methods lacks a virtual destructor. Deleting a derived object through a base pointer calls only the base destructor, skipping derived class cleanup.
- **Strategy**: 1. Grep all base classes (classes with virtual methods). 2. Check if they have `virtual ~ClassName() = default;` or a defined virtual destructor. 3. Add it if missing.
- **Tool sequence**: grep (`virtual`) → file_read (class definitions) → file_edit (add `virtual ~ClassName() = default;`)
- **Pitfall**: Do NOT make a class non-polymorphic just to avoid the destructor — if it has any virtual methods, it needs a virtual destructor.

## Verification
Compile: `g++ -std=c++17 -Wall -Wextra -Werror -g -fsanitize=address,undefined -o program *.cpp`
- Run Valgrind in CI: `valgrind --error-exitcode=1 --leak-check=full ./program`
- For large projects: integrate with `clang-tidy` and `cppcheck`.

## Validation Checklist
- [ ] All base classes with virtual methods have a virtual destructor
- [ ] No raw `new`/`delete` — prefer `std::make_unique`/`std::make_shared`
- [ ] No iterator or pointer used after vector/container modification
- [ ] No function or variable defined (not declared) in a header without `inline`
- [ ] Rule of Five implemented for any class that manages a resource
- [ ] Template errors read from bottom up before attempting a fix
- [ ] `-fsanitize=address,undefined` run during development
- [ ] No dangling references returned from functions (local variable reference)
