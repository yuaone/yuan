## Identity
- domain: gdscript
- type: language
- confidence: 0.88

# GDScript — Error Pattern Reference

Read the exact Godot error output including script path, line number, and the full message. GDScript errors often come from the editor Output panel or runtime debugger — check both.

## Error Code Quick Reference
- **"Invalid get index 'x' on base 'null instance'"** — Accessing property on a null node reference.
- **"Node not found: 'NodePath'"** — get_node() path is wrong or the node doesn't exist yet.
- **"Cannot call method 'connect' on null value"** — Signal target node is null.
- **"Nonexistent signal 'signal_name'"** — Signal not defined or misspelled.
- **"Type mismatch: expected built-in 'int', got 'String'"** — Export variable type mismatch in inspector.
- **"Parse error: expected 'end of statement', got..."** — Indentation or syntax error.
- **"Function 'func_name' already has a body"** — Duplicate function definition.
- **"Identifier 'name' is not declared"** — Variable used before declaration or out of scope.

## Known Error Patterns

### Signal Not Connected — connect() Missing
- **Symptom**: An event (button press, timer timeout, area entered) fires but nothing happens; no error is shown. Or `Error: Signal 'pressed' is already connected` on duplicate connects.
- **Cause**: The signal was defined with `signal my_signal` or exists on a node (e.g., `Button.pressed`) but `connect()` was never called, or it was connected in the wrong node's `_ready()`. In Godot 4, the callable syntax changed from `connect("signal_name", self, "method_name")` to `signal_name.connect(method)`.
- **Strategy**: 1. Grep the script for the signal name to find where it should be connected. 2. Verify `connect()` is called in `_ready()` of the node that owns the signal or a parent. 3. In Godot 4, use `$NodeName.signal_name.connect(_on_signal)` syntax. 4. Alternatively, connect signals in the Godot editor (Scene panel → Node tab → Signals) and check the editor connection icons. 5. Add `assert($NodeName != null)` before connect calls to catch null nodes early.
- **Tool sequence**: grep (`connect(`, `signal `) → file_read → file_edit (add connect() call in _ready())
- **Pitfall**: Do NOT connect signals inside `_process()` or `_physics_process()` — you will create thousands of duplicate connections per second, causing severe performance degradation.

### Null Node Reference — get_node Path Wrong
- **Symptom**: `Invalid get index 'x' on base 'null instance'` or `Node not found: 'Player/Weapon'`; crash occurs the moment a node is accessed.
- **Cause**: `get_node("path")` or `$NodePath` shorthand points to a node that doesn't exist at that path, was renamed, or was not yet added to the scene tree when `_ready()` ran.
- **Strategy**: 1. Open the scene in the Godot editor and verify the exact node path using the Scene tree panel. 2. Check for typos in the path — paths are case-sensitive. 3. If the node is added dynamically, access it after it is added, not in `_ready()`. 4. Use `@onready var node = $NodePath` (Godot 4) or `onready var node = $NodePath` (Godot 3) to defer node lookup to scene tree entry. 5. Add null checks: `if node != null:` before accessing properties.
- **Tool sequence**: file_read (script) → shell_exec (check scene .tscn file for node names) → file_edit (fix path or add @onready)
- **Pitfall**: Do NOT use `get_node()` in `_init()` — the node is not in the scene tree yet. Always use `_ready()` or `@onready` for node references.

### _ready vs _init Timing Issue — Node Not in Tree
- **Symptom**: Accessing sibling nodes, calling `get_parent()`, or reading export variables in `_init()` returns null or wrong values; works fine when moved to `_ready()`.
- **Cause**: `_init()` is called when the object is created in memory, before it is added to the scene tree. `_ready()` is called after the node and all its children have entered the scene tree. Scene-dependent operations must be in `_ready()`.
- **Strategy**: 1. Grep for `_init()` functions in scripts. 2. Identify any node access, `get_node()`, `get_parent()`, or signal connections inside `_init()`. 3. Move scene-dependent initialization to `_ready()`. 4. Keep `_init()` for pure in-memory object initialization (setting default values for non-node properties). 5. For class instantiation via `ClassName.new(args)`, pass data through `_init()` parameters only — do not access the tree.
- **Tool sequence**: grep (`func _init`) → file_read → file_edit (move scene access to _ready())
- **Pitfall**: Do NOT add `await get_tree().process_frame` in `_init()` to "wait" for the tree — use `_ready()` which is guaranteed to fire after tree entry.

### Export Variable Type Mismatch — Inspector Corruption
- **Symptom**: `Type mismatch: expected int, got String`; inspector shows wrong value type; game behavior is wrong even though code looks correct.
- **Cause**: The `@export` variable type annotation was changed after the scene was saved. The `.tscn` scene file stores the serialized value in the old type. On load, Godot tries to assign the old value to the new type.
- **Strategy**: 1. Open the `.tscn` file in a text editor and find the serialized property value. 2. Correct the value to match the new type (e.g., change `"10"` to `10` for int). 3. Or reset the property in the Godot inspector by right-clicking and selecting "Reset to Default". 4. When changing export types, always update all scenes that use the script. 5. Use `@export_enum` for string enums instead of raw strings to avoid type confusion.
- **Tool sequence**: file_read (.tscn file) → file_edit (fix serialized property type) → shell_exec (open in Godot to verify)
- **Pitfall**: Do NOT ignore type mismatch warnings — Godot may silently coerce the value, leading to subtle bugs (e.g., `"0"` being truthy when `0` is falsy).

### Scene Instancing Memory Leak — queue_free Missing
- **Symptom**: Game stutters over time; memory usage grows with every level load; profiler shows thousands of orphaned nodes.
- **Cause**: Dynamically instanced scenes (via `PackedScene.instantiate()`) are added to the tree but never removed. When the parent scene is unloaded, child instances are orphaned if not properly freed. Circular references between nodes also prevent garbage collection.
- **Strategy**: 1. For every `instantiate()` and `add_child()` call, verify there is a corresponding `queue_free()` or `remove_child()` + `free()` call when the instance is no longer needed. 2. For bullets, enemies, and particles: use an object pool instead of instantiating/freeing per-frame. 3. Connect the `tree_exited` signal to a cleanup function. 4. Use Godot's built-in profiler (Debug → Monitors) to track node count over time. 5. Avoid keeping references to freed nodes — use `is_instance_valid(node)` before accessing.
- **Tool sequence**: grep (`instantiate()`, `add_child(`) → file_read → file_edit (add queue_free() in appropriate lifecycle location)
- **Pitfall**: Do NOT call `free()` directly on nodes that are in the scene tree — use `queue_free()` which safely defers deletion to the end of the current frame.

### Infinite Loop in _process — Frame Freeze
- **Symptom**: Game freezes completely; editor becomes unresponsive; CPU spikes to 100%.
- **Cause**: A `while` loop or recursive call inside `_process()` or `_physics_process()` never terminates. These callbacks are called every frame and must return quickly.
- **Strategy**: 1. Grep for `while` loops and deep recursion inside `_process` and `_physics_process`. 2. Convert iterative work to state machines that progress one step per frame. 3. For async work, use `await` with signals or coroutines. 4. Add a frame counter or timeout as a safety valve: `if iterations > MAX_ITERATIONS: break`.
- **Tool sequence**: grep (`func _process`, `func _physics_process`) → file_read → file_edit (convert while loop to state machine or coroutine)
- **Pitfall**: Do NOT use `while true: await get_tree().process_frame` in production logic — use proper state machines or timers.

## Verification
Run the scene in the Godot editor with the Debugger panel open.
- No errors or warnings in the Output panel on startup.
- Memory usage (Debug → Monitors → Memory Used) should remain stable over time.
- Frame rate should be consistent — check Debug → Monitors → FPS.

## Validation Checklist
- [ ] All signals are connected in `_ready()`, not `_init()` or `_process()`
- [ ] All `get_node()` / `$Node` references verified against the actual scene tree
- [ ] `@onready` used for node references that must exist when ready
- [ ] All dynamically instantiated scenes have a corresponding `queue_free()` path
- [ ] No scene-dependent code in `_init()`
- [ ] Export variable types match the values serialized in `.tscn` files
- [ ] No `while` loops in `_process()` that could block the frame
- [ ] `is_instance_valid()` used before accessing potentially freed node references
- [ ] Memory monitor checked for leaks during extended play sessions
- [ ] No duplicate signal connections (check with `is_connected()` guard if connecting dynamically)
