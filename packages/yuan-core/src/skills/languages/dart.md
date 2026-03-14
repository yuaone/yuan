## Identity
- domain: dart
- type: language
- confidence: 0.95

# Dart / Flutter — Error Pattern Reference

Read the full Dart analyzer error and the Flutter stack trace. Flutter errors often include a widget ancestry chain — read it to find where the bad state originates.

## Error Code Quick Reference
- **Null check operator used on a null value** — `!` used on null (null safety violation at runtime).
- **setState() called after dispose()** — State method called on unmounted widget.
- **A build function returned null** — Widget build() returned null instead of a Widget.
- **'context' is not a valid BuildContext** — BuildContext used across async gap.
- **type 'X' is not a subtype of type 'Y'** — Type mismatch from platform channel or JSON.
- **Late initialization error: LateInitializationError** — `late` variable read before assignment.
- **RenderFlex overflowed** — Layout overflow (not a Dart error, but a Flutter render error).
- **MissingPluginException** — Platform channel plugin not registered.

## Known Error Patterns

### Pattern: Null safety migration (late keyword misuse)

- **symptom**: `LateInitializationError: Field 'x' has not been initialized.` at runtime, or `Null check operator used on a null value` — despite null safety being enabled
- **cause**: The `late` keyword promises to the compiler that a variable will be initialized before its first read — but there is no runtime enforcement until the read happens. If the variable is read in a code path that runs before initialization, it crashes.
- **strategy**: 1. Find the `late` variable declaration. 2. Trace all code paths to its first read — check `initState`, async callbacks, and conditional initialization. 3. If initialization depends on async work, use a nullable type (`String?`) and guard reads with `if (x != null)` or `?`. 4. For `late` fields initialized in `initState`, ensure `initState` runs before the first build that reads them. 5. Replace `late` with proper initialization in the constructor or with a nullable type if initialization is not guaranteed.
- **toolSequence**: grep (`late `) → file_read (variable and its first read) → file_edit (replace with nullable or ensure guaranteed initialization)
- **pitfall**: Do NOT use `late` for all non-nullable fields just to satisfy the analyzer — it moves the error from compile time to runtime.

### Pattern: setState after dispose

- **symptom**: `setState() called after dispose()` — Flutter prints this as a warning/error in debug mode; in release mode, it may silently corrupt state or crash
- **cause**: An async operation (HTTP call, Timer, animation) completes and calls `setState()` after the widget has been removed from the tree (disposed). The `State` object is still referenced by the callback closure.
- **strategy**: 1. Find async operations (HTTP calls, `Future.delayed`, `Timer`, stream subscriptions) inside `State` classes. 2. Add a mounted check before `setState`: `if (mounted) setState(() { ... });`. 3. Cancel timers and stream subscriptions in `dispose()`. 4. For `Future` callbacks, capture the result and check mounted: `final data = await fetchData(); if (!mounted) return; setState(() { _data = data; });`. 5. For streams, store the `StreamSubscription` and call `subscription.cancel()` in `dispose()`.
- **toolSequence**: grep (`setState`) → file_read (async context around each call) → file_edit (add `if (mounted)` guard) + file_edit (cancel subscriptions in dispose)
- **pitfall**: Do NOT omit the `dispose()` override — always cancel timers, animations, and stream subscriptions in `dispose()`.

### Pattern: widget rebuild loop (setState in build)

- **symptom**: Widget rebuilds continuously (high CPU, hot reload doesn't settle, "build called 60 times/sec" in profile). Often caused by calling `setState` inside `build` or in a listener that triggers rebuild which triggers the listener again.
- **cause**: Calling `setState()` during a `build()` call, or setting up a listener in `build()` that immediately fires and calls `setState()`, causing an infinite loop of rebuilds.
- **strategy**: 1. Check the `build()` method for any direct `setState()` calls — remove them. 2. Move listener setup to `initState()` so it runs once. 3. For `addListener` patterns, ensure the listener does not call `setState` synchronously in the first frame. 4. Use `WidgetsBinding.instance.addPostFrameCallback(() { setState(() {}); })` when state update must happen after a build. 5. For `AnimationController`, initialize in `initState`, not in `build`.
- **toolSequence**: file_read (build method) → grep (`setState` inside build) → file_edit (move initialization to initState)
- **pitfall**: Do NOT use `setState` inside `build` — use `initState`, `didUpdateWidget`, or `addPostFrameCallback` for post-build state updates.

### Pattern: async gap (BuildContext across async)

- **symptom**: `Don't use 'BuildContext's across async gaps` — lint warning. In release builds, may cause `FlutterError` or incorrect navigation/dialog behavior when context is no longer valid.
- **cause**: After an `await` point, the widget may have been disposed or rebuilt, making the captured `BuildContext` stale. Using it for `Navigator.push`, `showDialog`, `ScaffoldMessenger.of(context)`, etc., can fail silently or crash.
- **strategy**: 1. Find every `await` inside event handlers or async methods that also use `context`. 2. Check the `use_build_context_synchronously` lint — enable it in `analysis_options.yaml`. 3. Before the `await`, save any context-dependent values (e.g., `Navigator.of(context)` → `final nav = Navigator.of(context);`). 4. After the `await`, add a `if (!mounted) return;` check before using `context` again. 5. Use `ref` (Riverpod) or BLoC events that don't capture context for post-async navigation.
- **toolSequence**: grep (`await`) in widget files → file_read (context usage after await) → file_edit (save navigator before await, add mounted check)
- **pitfall**: Do NOT suppress the lint with `// ignore:` — it exists to prevent real crashes. Fix the async context usage instead.

### Pattern: platform channel type mismatch

- **symptom**: `type 'int' is not a subtype of type 'double'` or `PlatformException: argument type 'LinkedHashMap<Object?, Object?>' is not a subtype of type 'Map<String, dynamic>'` — from platform channel callbacks
- **cause**: Platform channel (MethodChannel, EventChannel) passes types that differ between Dart and the native platform. Android/iOS may return `int` where Dart expects `double`, or a generic `Map<Object?, Object?>` where `Map<String, dynamic>` is expected. The codec does not automatically coerce types.
- **strategy**: 1. Read the exact types in the error message. 2. Cast the received value explicitly: `(result as num).toDouble()` for int/double mismatch. 3. For Map type issues, cast recursively: `Map<String, dynamic>.from(result as Map)`. 4. For nested maps, use a deep-cast helper or `jsonDecode(jsonEncode(result))` to normalize types. 5. Add type validation at the channel boundary with descriptive error messages.
- **toolSequence**: file_read (channel callback) → file_edit (add explicit cast with `.from()` or `as num`)
- **pitfall**: Do NOT use `dynamic` throughout the app to avoid casts — cast once at the channel boundary and use typed models internally.

## Verification
Run: `flutter analyze` and `dart analyze`
- `flutter analyze` exit 0 = no analyzer errors.
- For tests: `flutter test`
- For build: `flutter build apk --debug` or `flutter build ios --debug`

## Validation Checklist
- [ ] `flutter analyze` exits 0 with no errors
- [ ] All `setState` calls guarded with `if (mounted)` when in async callbacks
- [ ] All `late` variables have guaranteed initialization path before first read
- [ ] No `setState` inside `build()` — initialization moved to `initState`
- [ ] `context` not used after `await` without mounted check
- [ ] Platform channel values cast explicitly at the boundary
- [ ] `StreamSubscription`, `Timer`, and `AnimationController` cancelled/disposed in `dispose()`
