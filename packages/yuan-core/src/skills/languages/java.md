## Identity
- domain: java
- type: language
- confidence: 0.95

# Java — Error Pattern Reference

Read the full stack trace including the cause chain (`Caused by:`). Java exceptions cascade — the root cause is at the bottom, not the top.

## Error Code Quick Reference
- **NullPointerException** — Accessing method/field on a null reference.
- **ClassCastException** — Casting an object to an incompatible type.
- **ConcurrentModificationException** — Modifying a collection while iterating it.
- **OutOfMemoryError: Java heap space** — Heap exhausted. Check for memory leaks.
- **StackOverflowError** — Unbounded recursion or circular call chain.
- **ClassNotFoundException** — Class not on classpath at runtime.
- **NoSuchMethodError** — Compiled against different version than runtime JAR.
- **IllegalArgumentException** — Invalid argument passed to method.
- **IllegalStateException** — Method called at wrong lifecycle phase.
- **checked exception not handled** — Compile error: checked exception must be caught or declared.

## Known Error Patterns

### Pattern: NullPointerException

- **symptom**: `java.lang.NullPointerException` at a specific stack frame, optionally with JDK 14+ helpful NPE message: `Cannot invoke "String.length()" because "str" is null`
- **cause**: A variable holds `null` when a method call or field access is performed. Common sources: uninitialized fields, method returning null, optional result not checked, collection `get()` returning null for missing key.
- **strategy**: 1. Read the stack trace to find the exact line. 2. Identify which variable is null at that line. 3. Trace backwards to where it was assigned. 4. Add a null check (`if (x != null)`) or use `Optional<T>` and `.orElse()`/`.orElseThrow()`. 5. For Java 8+, prefer `Objects.requireNonNull(x, "x must not be null")` at entry points. 6. Use `@NonNull` / `@Nullable` annotations for documentation.
- **toolSequence**: file_read (stack trace line) → grep (variable assignment) → file_edit (add null check or Optional)
- **pitfall**: Do NOT add null checks everywhere defensively without understanding why null is reached — find the source and fix it there.

### Pattern: ClassCastException

- **symptom**: `java.lang.ClassCastException: class Foo cannot be cast to class Bar`
- **cause**: An object of type `Foo` was stored in a reference of type `Object` (or a supertype) and then cast to `Bar`, but the actual runtime type is incompatible. Common in legacy collections (pre-generics), deserialization, or downcasting without `instanceof` check.
- **strategy**: 1. Read the exact class names in the exception. 2. Find where the cast is performed. 3. Add an `instanceof` check before the cast: `if (obj instanceof Bar) { Bar b = (Bar) obj; }`. 4. For Java 16+, use pattern matching: `if (obj instanceof Bar b) { ... }`. 5. If the cast is in serialization/deserialization code, verify the serialized type matches the expected type.
- **toolSequence**: file_read (cast line) → grep (where the object was originally stored) → file_edit (add instanceof check)
- **pitfall**: Do NOT suppress with a try/catch around the cast — understand why the wrong type is being stored and fix the storage point.

### Pattern: ConcurrentModificationException

- **symptom**: `java.util.ConcurrentModificationException` while iterating a List, Map, or Set
- **cause**: The collection was structurally modified (add/remove) while an iterator or enhanced for-loop is active over it. The fail-fast iterator detects the modification counter change and throws.
- **strategy**: 1. Find the iteration loop. 2. Find the modification inside or outside the loop. 3. Solutions by case: (a) Removing during iteration: use `Iterator.remove()` explicitly. (b) Adding during iteration: collect items to add in a separate list, add them after the loop. (c) Concurrent modification from another thread: use `CopyOnWriteArrayList`, `ConcurrentHashMap`, or synchronize access. 4. For Java streams, collect results to a new list instead of modifying the source.
- **toolSequence**: file_read (iteration loop) → file_edit (replace with Iterator.remove() or copy-then-modify pattern)
- **pitfall**: Do NOT switch to `CopyOnWriteArrayList` for single-threaded code — it has high write cost. Use Iterator.remove() for sequential removal.

### Pattern: OutOfMemoryError (heap space)

- **symptom**: `java.lang.OutOfMemoryError: Java heap space` — JVM terminates or GC overhead limit exceeded
- **cause**: Heap is exhausted. Root causes: (a) unbounded collection growth (cache without eviction), (b) large data loaded entirely into memory, (c) object retention via static fields or listener/callback leaks, (d) insufficient -Xmx setting for workload.
- **strategy**: 1. Take a heap dump: `-XX:+HeapDumpOnOutOfMemoryError`. 2. Analyze with VisualVM or Eclipse MAT — find the largest retained object. 3. If it is a collection, check the code that populates it — add size bounds or eviction (LRU cache). 4. If it is caused by large data, use streaming (BufferedReader, InputStream) instead of loading entirely. 5. If it is a listener leak, ensure listeners are removed in teardown/close methods. 6. As a last resort, increase `-Xmx` in JVM args, but fix the leak first.
- **toolSequence**: grep (`new ArrayList\|new HashMap\|static.*List\|static.*Map`) → file_read (population logic) → file_edit (add size limit or streaming)
- **pitfall**: Do NOT increase -Xmx without investigating the root cause — it only delays the crash and masks the leak.

### Pattern: checked exception not handled

- **symptom**: Compile error: `unreported exception IOException; must be caught or declared to be thrown`
- **cause**: A method that throws a checked exception is called without either (a) surrounding it in a try-catch or (b) declaring the exception in the calling method's `throws` clause.
- **strategy**: 1. Read which exception is unhandled and which line throws it. 2. Decide the correct response: (a) Handle it locally — wrap in try-catch and either recover or log + rethrow as unchecked. (b) Propagate it — add `throws IOException` (or the specific exception) to the calling method signature. 3. Avoid catching `Exception` broadly — catch the specific checked exception. 4. When rethrowing as unchecked, use `throw new RuntimeException("context message", e)` to preserve the cause.
- **toolSequence**: file_read (throwing method signature) → file_edit (add try-catch or throws declaration)
- **pitfall**: Do NOT use `catch (Exception e) { /* ignore */ }` — swallowed exceptions cause silent failures that are very hard to debug later.

## Verification
Run: `mvn compile` or `./gradlew compileJava`
- Exit 0 = no compile errors.
- For tests: `mvn test` or `./gradlew test`
- For static analysis: SpotBugs or `./gradlew spotbugsMain`

## Validation Checklist
- [ ] Compilation succeeds with zero errors
- [ ] No raw `catch (Exception e) {}` blocks swallowing exceptions silently
- [ ] All `null` return paths documented and null checks added at consumers
- [ ] Collections modified during iteration use Iterator.remove() or copy pattern
- [ ] Checked exceptions either handled locally with recovery or propagated with context
- [ ] No `instanceof` followed by unchecked cast — use pattern matching (Java 16+)
- [ ] Static collections have bounded size or explicit eviction policy
