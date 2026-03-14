## Identity
- domain: elixir
- type: language
- confidence: 0.90

# Elixir — Error Pattern Reference

Read the exact exception type, message, and stacktrace. Elixir errors are structured — the module, function, and arity in the stacktrace tell you exactly where the failure occurred.

## Error Code Quick Reference
- **FunctionClauseError** — No function clause matched the given arguments.
- **MatchError** — Pattern match failed in `=` or `case`/`with`.
- **UndefinedFunctionError** — Module or function not found (missing import, wrong arity).
- **ArgumentError** — Invalid argument to a function (often nil where value expected).
- **KeyError** — Key not found in map (use `Map.get/3` with default instead of `map[key]!`).
- **RuntimeError** — Explicit `raise "message"` or `raise RuntimeError, message: "..."`.
- **EXIT from #PID** — A linked/monitored process crashed; check the reason.
- **** (Ecto.NoResultsError)** — `Repo.get!` or `Repo.one!` found no records.

## Known Error Patterns

### GenServer Timeout — handle_call/cast Not Returning
- **Symptom**: `** (exit) exited in: GenServer.call/3 with reason: :timeout`; caller process crashes after 5000ms default timeout; server appears unresponsive.
- **Cause**: `handle_call/3` is blocking on a slow operation (database query, HTTP request, file I/O) and does not return within the timeout. Or `handle_call` is calling another GenServer which itself is blocked, creating a deadlock.
- **Strategy**: 1. Read the `handle_call` implementation for the timed-out message type. 2. Move slow operations out of `handle_call`: reply immediately with `:noreply`, spawn a task, and send the result back via `GenServer.reply/2`. 3. For truly long operations, increase the timeout: `GenServer.call(server, msg, 30_000)`. 4. Use `Task.async/await` or `Task.Supervisor` for concurrent work. 5. Avoid chained `GenServer.call` between processes that can form circular waits.
- **Tool sequence**: grep (`handle_call`, `GenServer.call`) → file_read → file_edit (extract slow work to Task, use cast + send instead of call)
- **Pitfall**: Do NOT increase timeout indefinitely as the primary fix — a timed-out call indicates a design issue. The GenServer's inbox continues to fill while it's blocked.

### Process Leak — No Supervision Tree
- **Symptom**: Memory usage grows over time; `Process.list() |> length` increases; `:observer.start()` shows thousands of processes with no parents.
- **Cause**: Processes spawned with `spawn/1` or `Task.start/1` are not supervised. If they crash, they leave no trace. If they leak, nothing cleans them up. Long-running work done in unsupervised processes accumulates.
- **Strategy**: 1. Grep all `spawn(`, `Task.start(`, and `Process.spawn(` calls. 2. Replace fire-and-forget tasks with `Task.Supervisor.start_child(MyApp.TaskSupervisor, fn -> ... end)`. 3. For recurring workers, use `GenServer` under a `Supervisor`. 4. Define a supervision tree in `application.ex` and add all long-lived processes to it. 5. Use `DynamicSupervisor` for runtime-spawned processes.
- **Tool sequence**: grep (`spawn(`, `Task\.start(`) → file_read → file_edit (replace with Task.Supervisor or add to supervision tree)
- **Pitfall**: Do NOT add processes to a supervision tree without understanding restart strategies — a `one_for_all` supervisor will restart all children when one crashes.

### Pattern Match Failure — FunctionClauseError
- **Symptom**: `** (FunctionClauseError) no function clause matching in MyModule.my_fun/2`; occurs at runtime even though the function is defined.
- **Cause**: The function has multiple clauses with pattern matches in the arguments. The call arguments don't match any clause. Common causes: nil passed where a struct is expected, wrong map keys, incorrect atom.
- **Strategy**: 1. Read the full error — it shows the arguments that failed to match. 2. Read all clauses of the function in order — Elixir matches top to bottom. 3. Add a catch-all clause at the bottom for graceful error handling: `def my_fun(arg), do: {:error, {:unexpected_argument, arg}}`. 4. Use `IO.inspect(args, label: "my_fun args")` temporarily to log incoming values. 5. If nil is possible, add a nil-handling clause before the main clause.
- **Tool sequence**: file_read (all clauses of the failing function) → file_edit (add missing clause or fix call site to pass correct arguments)
- **Pitfall**: Do NOT add a catch-all clause that silently ignores errors — always return an error tuple or raise with context so the problem is visible.

### Ecto Changeset Validation Error Ignored
- **Symptom**: Data is saved to the database with invalid or incomplete values; validation rules defined in the changeset have no effect; tests pass but production data is corrupted.
- **Cause**: The result of `Repo.insert/2` or `Repo.update/2` returns `{:error, changeset}` on validation failure, but the caller only pattern-matches the success case: `{:ok, record} = Repo.insert(changeset)`. The match error causes a crash, or the error is ignored entirely.
- **Strategy**: 1. Grep all `Repo.insert`, `Repo.update`, `Repo.delete` calls. 2. Verify each uses a `case` or `with` expression that handles both `{:ok, record}` and `{:error, changeset}`. 3. Never use `Repo.insert!` in production code paths that can fail validation — use `Repo.insert/2` with explicit error handling. 4. In Phoenix controllers, use `render(conn, :new, changeset: changeset)` to re-render the form with errors.
- **Tool sequence**: grep (`Repo\.insert`, `Repo\.update`) → file_read → file_edit (add case/with error handling)
- **Pitfall**: Do NOT use `{:ok, _} = Repo.insert!(...)` — `insert!` raises on failure. Use `insert/2` + case expression for user-facing operations.

### Atom Exhaustion — Dynamic Atom Creation
- **Symptom**: `** (SystemLimitError) a system limit has been reached`; BEAM VM crashes after processing many unique strings as atoms; memory grows until VM limit (~1 million atoms by default).
- **Cause**: Atoms in Elixir are never garbage collected. Converting arbitrary user input to atoms with `String.to_atom/1` or `:erlang.binary_to_atom/2` exhausts the atom table. This is a denial-of-service vector if user input drives atom creation.
- **Strategy**: 1. Grep all `String.to_atom(`, `:erlang.binary_to_atom(`, and `:"#{var}"` interpolations. 2. Replace with `String.to_existing_atom/1` for known atoms (raises if atom doesn't exist — safe). 3. For map keys from external data (JSON, APIs), use string keys instead of atom keys. 4. Use `Jason.decode!(json, keys: :strings)` instead of `keys: :atoms` for JSON parsing. 5. For finite, known sets of atoms, define a conversion function with a `case` statement.
- **Tool sequence**: grep (`String\.to_atom`, `binary_to_atom`) → file_read → file_edit (replace with String.to_existing_atom or keep as strings)
- **Pitfall**: Do NOT use `String.to_existing_atom/1` for user input that could send arbitrary strings — it still creates atoms at compile time for every match clause, and it raises on unknown atoms which may be handled incorrectly.

### Hot Code Reload State Loss — GenServer State Schema Change
- **Symptom**: After deploying a new version, GenServer crashes immediately with `FunctionClauseError` or `MatchError` on the state; rollback restores stability.
- **Cause**: The state data structure of a GenServer was changed (e.g., a map field added/removed, a struct field renamed) without implementing `code_change/3`. Old processes running the old code have state in the old format; new code expects the new format.
- **Strategy**: 1. Implement `code_change/3` in the GenServer to migrate old state to new state format. 2. For OTP releases, use `:sys.replace_state/2` during deployment to update running processes. 3. Prefer maps over structs for GenServer state to allow forward compatibility. 4. During blue-green deployments, drain old processes before starting new ones.
- **Tool sequence**: file_read (GenServer module) → file_edit (add code_change/3 with state migration)
- **Pitfall**: Do NOT rely on process restart (via supervisor) alone to fix state schema changes — the new process will start with empty/default state, losing all in-memory data.

## Verification
Run: `mix compile --warnings-as-errors && mix test`
- All tests must pass with zero compilation warnings.
- Run dialyzer: `mix dialyzer` — no type errors.
- Check supervision tree: `Application.started_applications()` and `:observer.start()`.

## Validation Checklist
- [ ] All `Repo.insert/update/delete` calls handle `{:error, changeset}` case
- [ ] No `String.to_atom/1` called with user input or external data
- [ ] All long-lived processes are under a supervision tree
- [ ] No `spawn/1` without corresponding supervisor or `Task.Supervisor`
- [ ] All `GenServer.call/3` callers handle `:timeout` gracefully
- [ ] `mix dialyzer` passes with no type errors
- [ ] All function clauses have a catch-all or explicit error-returning clause
- [ ] No blocking I/O inside `handle_call/3` — use async reply pattern
- [ ] `code_change/3` implemented for GenServers with non-trivial state
- [ ] `mix test --cover` shows all critical paths covered
