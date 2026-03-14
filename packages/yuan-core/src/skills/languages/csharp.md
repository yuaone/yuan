## Identity
- domain: csharp
- type: language
- confidence: 0.95

# C# — Error Pattern Reference

Read the full compiler error including the CS error code and the stack trace. C#'s compiler messages are precise and the `CS` error code narrows the problem category immediately.

## Error Code Quick Reference
- **CS0103** — The name 'x' does not exist in the current context.
- **CS0019** — Operator cannot be applied to operands of type.
- **CS1998** — Async method lacks 'await' operators (sync disguised as async).
- **CS4014** — Call not awaited — fire and forget.
- **CS0246** — Type or namespace not found (missing using directive or assembly).
- **CS0266** — Cannot implicitly convert — explicit cast required.
- **CS8600** — Converting null literal or possible null value to non-nullable type.
- **CS8602** — Dereference of a possibly null reference.
- **CS8618** — Non-nullable field must contain a non-null value when exiting constructor.
- **NullReferenceException** — Runtime null dereference.

## Known Error Patterns

### Pattern: NullReferenceException

- **symptom**: `System.NullReferenceException: Object reference not set to an instance of an object` at a specific stack frame
- **cause**: A reference-type variable is `null` when a member access (method, property, indexer) is attempted. Common sources: uninitialized properties, LINQ `FirstOrDefault()` returning null, missing dependency injection registration, uninitialized optional fields.
- **strategy**: 1. Read the stack trace line. 2. Identify which object is null — use the NullReferenceException helper in .NET 6+ which names the null variable. 3. Trace backwards to where the variable was assigned. 4. Add a null check using the null-conditional operator `x?.Method()` or null coalescing `x ?? defaultValue`. 5. For method parameters, use `ArgumentNullException.ThrowIfNull(param)` at method entry. 6. Enable nullable reference types (`<Nullable>enable</Nullable>`) in the project to get CS8602 compile-time warnings.
- **toolSequence**: file_read (stack trace line) → grep (variable assignment) → file_edit (add null check or enable nullable)
- **pitfall**: Do NOT add `!` (null-forgiving operator) to suppress CS8602 warnings without proof — it silences the warning but keeps the runtime crash.

### Pattern: async void (fire-and-forget)

- **symptom**: Exceptions thrown inside `async void` methods silently crash the application or are swallowed. `CS1998` warning on async methods without await. Errors not catchable at the call site.
- **cause**: `async void` methods cannot be awaited, so exceptions propagate to the synchronization context and crash the app (in most contexts) or are silently lost. They are intended only for event handlers.
- **strategy**: 1. Grep for `async void` in the codebase. 2. For all non-event-handler `async void` methods, change the return type to `async Task`. 3. Update call sites to `await` the returned `Task`. 4. For event handlers that must be `async void`, wrap the body in try-catch: `try { await DoWorkAsync(); } catch (Exception ex) { _logger.LogError(ex, ...); }`. 5. Use `Task.Run` for fire-and-forget scenarios and log exceptions: `_ = Task.Run(async () => { try { await work(); } catch (ex) { log(ex); } });`.
- **toolSequence**: grep (`async void`) → file_read (each occurrence) → file_edit (change to `async Task` or add try-catch wrapper)
- **pitfall**: Do NOT change event handlers (`Button_Click`, `OnReceived`) from `async void` to `async Task` — the event system requires `void` return. Wrap the body instead.

### Pattern: LINQ deferred execution surprise

- **symptom**: A LINQ query appears to produce different results on multiple enumerations, or is re-executed (including side effects) every time it is iterated. Database queries run more times than expected.
- **cause**: LINQ queries (`Where`, `Select`, `OrderBy`, etc.) return `IEnumerable<T>` which is evaluated lazily — the query runs again each time the sequence is enumerated. Storing an `IQueryable` or `IEnumerable` and iterating it multiple times re-executes the underlying operation.
- **strategy**: 1. Find LINQ queries that are iterated more than once (look for multiple `foreach`, `Count()`, `ToList()` calls on the same variable). 2. Materialize the query exactly once with `.ToList()` or `.ToArray()` when the results will be used multiple times. 3. For EF Core queries, always call `.ToList()` or `.ToListAsync()` before the DbContext scope ends. 4. Be explicit: if single enumeration is intentional, document it; if multiple, materialize.
- **toolSequence**: grep (variable name used in multiple enumerations) → file_read → file_edit (add `.ToList()` after first enumeration)
- **pitfall**: Do NOT call `.ToList()` on every LINQ query blindly — for large datasets piped into further LINQ operators, deferred execution is more memory-efficient. Materialize only when the result is reused.

### Pattern: IDisposable not disposed (missing using statement)

- **symptom**: Memory/handle leak; `ObjectDisposedException` thrown after the object is used later; resource exhaustion (too many open file handles, database connections).
- **cause**: Objects implementing `IDisposable` (StreamReader, HttpClient, DbContext, SqlConnection, etc.) are not disposed when done. Their resources (file handles, network sockets, unmanaged memory) are not freed until the finalizer runs — which may be never or much later.
- **strategy**: 1. Grep for `new StreamReader`, `new SqlConnection`, `new HttpClient`, etc. — anything implementing `IDisposable`. 2. Wrap each in a `using` statement: `using var reader = new StreamReader(path);` (C# 8+) or `using (var reader = new StreamReader(path)) { ... }`. 3. For class-level `IDisposable` fields, implement `IDisposable` on the containing class and dispose fields in `Dispose()`. 4. For `HttpClient`, do NOT create one per request — use a singleton or `IHttpClientFactory` to avoid socket exhaustion.
- **toolSequence**: grep (`new .*Disposable\|new Stream\|new SqlConnection\|new DbContext`) → file_read → file_edit (wrap in `using` statement)
- **pitfall**: Do NOT create a new `HttpClient` inside a `using` block per request — `HttpClient` is designed to be reused; disposing it per request causes socket exhaustion.

### Pattern: ambiguous method overload

- **symptom**: `CS0121: The call is ambiguous between the following methods or properties: 'Foo(int)' and 'Foo(long)'`
- **cause**: Two or more overloads are equally applicable for the given arguments. Common causes: numeric literal promotion (int can match both int and long), implicit conversions, optional parameters making two overloads identical in call site.
- **strategy**: 1. Read the two (or more) ambiguous overloads listed in the error. 2. Make the call explicit by casting the argument to the desired type: `Foo((int)value)` or `Foo((long)value)`. 3. If you own the overloaded methods and the ambiguity is a design problem, rename or consolidate the overloads. 4. For extension method ambiguity, use a static method call syntax to specify the type explicitly: `Extensions.Foo(obj, arg)`.
- **toolSequence**: file_read (error line) → grep (overload definitions) → file_edit (add explicit cast at call site)
- **pitfall**: Do NOT remove one of the overloads without checking all call sites — removing an overload may break other callers that relied on it.

## Verification
Run: `dotnet build` or `msbuild /p:Configuration=Debug`
- Exit 0 = no compile errors.
- For tests: `dotnet test`
- For nullable analysis: ensure `<Nullable>enable</Nullable>` in .csproj

## Validation Checklist
- [ ] `dotnet build` exits 0 with no errors
- [ ] No `async void` except event handlers (all others return `Task`)
- [ ] All `IDisposable` objects wrapped in `using` statements
- [ ] LINQ queries materialized with `.ToList()` when iterated multiple times
- [ ] Nullable reference types enabled; no `!` null-forgiving without proof
- [ ] Method overload ambiguities resolved with explicit casts
- [ ] `HttpClient` reused via DI / `IHttpClientFactory`, not created per request
