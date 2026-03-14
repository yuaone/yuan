## Identity
- domain: haskell
- type: language
- confidence: 0.88

# Haskell — Error Pattern Reference

Read the full GHC error including source location, the constraint context, and the inferred vs expected types. Haskell errors often appear far from the actual source of the type mismatch — read the constraint trail.

## Error Code Quick Reference
- **"No instance for (Typeclass x)"** — Missing typeclass instance for a type.
- **"Couldn't match expected type"** — Type mismatch; read both types carefully.
- **"Ambiguous type variable"** — GHC cannot determine which instance to use; add type annotation.
- **"Non-exhaustive patterns"** — Case expression or function definition missing a branch.
- **"Variable not in scope"** — Name not imported or not in scope; check module imports.
- **"Couldn't match type 'IO a' with 'a'"** — Forgetting to bind (>>=) or `<-` in do notation.
- **"Occurs check: cannot construct the infinite type"** — Recursive type without newtype wrapper.
- **"Module 'X' does not export 'y'"** — Trying to import a name that is not exported.

## Known Error Patterns

### No Instance For — Missing Typeclass
- **Symptom**: `No instance for (Show MyType) arising from a use of 'print'`; GHC refuses to compile even though the logic seems correct.
- **Cause**: A typeclass method is used on a type that has not derived or implemented the required instance. Common cases: `Show` needed for printing, `Eq` needed for `==`, `Ord` needed for sorting, `FromJSON`/`ToJSON` needed for Aeson.
- **Strategy**: 1. Read the error — it says exactly which typeclass is missing for which type. 2. If the type is yours, add a deriving clause: `data MyType = ... deriving (Show, Eq, Ord)`. 3. For more complex instances (e.g., `FromJSON` for a custom type), write the instance manually or use Template Haskell: `$(deriveJSON defaultOptions ''MyType)`. 4. For orphan instances (instance for a type you don't own in a module you don't own), create a `newtype` wrapper. 5. Check that the required module is imported: `import Data.Aeson (FromJSON, ToJSON)`.
- **Tool sequence**: file_read (type definition) → file_edit (add deriving clause or manual instance) → shell_exec (`cabal build` or `stack build`)
- **Pitfall**: Do NOT add a `newtype` wrapper just to avoid an orphan instance warning if you can define the instance in the same module as the type — orphan instances cause import order dependencies.

### Space Leak — Lazy Evaluation Accumulation
- **Symptom**: Memory usage grows linearly with input size for operations that should be constant space (e.g., `foldl sum`); program eventually runs out of memory on large inputs.
- **Cause**: Haskell is lazy by default — thunks accumulate without being evaluated. `foldl (+) 0 [1..1000000]` builds a chain of a million unevaluated additions before computing anything. The result is held as a thunk until forced.
- **Strategy**: 1. Replace `foldl` with `foldl'` (strict left fold) from `Data.List`: `import Data.List (foldl')`. 2. Use `BangPatterns` or `$!` for strict accumulation: `go !acc (x:xs) = go (acc + x) xs`. 3. Use `seq` to force evaluation: `let !x = expensiveComputation`. 4. Profile with `+RTS -hc -p` to identify which thunks are accumulating. 5. Consider using strict data structures (`Data.Map.Strict` instead of `Data.Map.Lazy`).
- **Tool sequence**: grep (`foldl `, `Data.Map` without `.Strict`) → file_read → file_edit (replace with strict versions)
- **Pitfall**: Do NOT add `seq` or `!` everywhere blindly — forcing evaluation in the wrong place can change semantics for infinite lists and lazy I/O.

### Non-Exhaustive Patterns — Missing Case Branch
- **Symptom**: `Non-exhaustive patterns in function foo` at runtime; `ghc -W` warns `Pattern match(es) are non-exhaustive`; program crashes on an input that wasn't tested.
- **Cause**: A `case` expression or multi-equation function definition does not cover all possible inputs. Common cases: not handling `Nothing` in a `Maybe`, missing constructors in a sum type `case`, not handling the empty list `[]`.
- **Strategy**: 1. Enable `-Wincomplete-patterns` in GHC options (or use `-Wall`). 2. Read which patterns are missing from the warning. 3. Add the missing cases — do not use a wildcard `_ -> error "impossible"` unless you can prove it is truly unreachable. 4. For `Maybe`, always handle both `Just x` and `Nothing`. 5. For sum types you own, add a constructor and let GHC's exhaustiveness checker find all unhandled cases.
- **Tool sequence**: shell_exec (`ghc -Wall -fno-code MyFile.hs`) → file_read (function with non-exhaustive patterns) → file_edit (add missing case branches)
- **Pitfall**: Do NOT use `_ -> undefined` or `_ -> error "unreachable"` in case expressions — if the case is truly exhaustive, GHC will tell you; if it is not, `error` crashes the program.

### Ambiguous Type Variable — Missing Annotation
- **Symptom**: `Ambiguous type variable 'a0' arising from a use of 'show'`; GHC knows a typeclass constraint is needed but cannot choose which instance to use without more information.
- **Cause**: An expression has a polymorphic type and the context does not constrain it sufficiently. Common cases: `show (read "123")` — GHC doesn't know which type to read into; `mempty` when the monoid type is unclear; numeric literals without context.
- **Strategy**: 1. Add a type annotation at the ambiguous expression: `show (read "123" :: Int)`. 2. Add a type signature to the function containing the ambiguous expression. 3. Use `ScopedTypeVariables` extension to annotate inner expressions. 4. For `defaulting` issues with numeric types, GHC may default to `Integer` — add explicit `:: Double` or `:: Int` annotations.
- **Tool sequence**: file_read (ambiguous expression location) → file_edit (add :: TypeAnnotation at the expression or full function signature)
- **Pitfall**: Do NOT use `asTypeOf` to hint types unless you understand its semantics — add an explicit type annotation instead, which documents intent clearly.

### Import Conflict — Module.Function vs Unqualified
- **Symptom**: `Ambiguous occurrence 'lookup'` — the name is defined in multiple imported modules; compilation fails.
- **Cause**: Multiple modules export the same name (e.g., `lookup` from `Prelude` and `Data.Map`, `fromList` from `Data.Set` and `Data.Map`). Both are in scope unqualified.
- **Strategy**: 1. Use qualified imports for container modules: `import qualified Data.Map.Strict as Map`, `import qualified Data.Set as Set`. 2. Then use `Map.lookup`, `Set.fromList` to disambiguate. 3. Alternatively, use explicit import lists to import only what's needed: `import Data.Map (Map, fromList)`. 4. Hide Prelude clashes: `import Prelude hiding (lookup)`. 5. Enable `PackageImports` extension if the same module name exists in multiple packages.
- **Tool sequence**: grep (`^import `) → file_read → file_edit (add qualified imports or explicit import lists)
- **Pitfall**: Do NOT hide Prelude names without a good reason — other readers of the code expect Prelude names to be available and unqualified.

### IO vs Pure Confusion — Missing Bind in do Notation
- **Symptom**: `Couldn't match type 'IO String' with 'String'`; `Couldn't match expected type '[Char]' with actual type 'IO [Char]'`.
- **Cause**: In do notation, `let x = getLine` binds the IO action itself (not the result) to `x`. To extract the value from an IO action, use `<-`: `x <- getLine`. Forgetting `<-` leaves the monadic wrapper.
- **Strategy**: 1. Read the do block carefully — every `IO a` value that needs the inner `a` must use `<-`. 2. `let x = pureExpression` for pure values; `x <- ioAction` for IO actions. 3. For `Maybe`/`Either` in `ExceptT` stacks, use `lift` or `liftIO` to bring IO actions into the monad transformer context. 4. If you need to use a pure value inside IO, it is already usable — no wrapping needed.
- **Tool sequence**: file_read (do block with type error) → file_edit (change `let x =` to `x <-` for IO actions)
- **Pitfall**: Do NOT use `unsafePerformIO` to force IO values into pure context — this breaks referential transparency and causes non-deterministic behavior.

## Verification
Run: `cabal build 2>&1` or `stack build 2>&1`
- Zero errors, zero warnings with `-Wall -Wincomplete-patterns`.
- Run HLint: `hlint src/` — apply all "Suggestion" level hints.
- Run tests: `cabal test` or `stack test`.

## Validation Checklist
- [ ] GHC build passes with `-Wall` and zero warnings
- [ ] All `case` expressions and function equations are exhaustive
- [ ] `foldl` replaced with `foldl'` in all non-lazy contexts
- [ ] All container module imports are qualified (`Data.Map` as `Map`, etc.)
- [ ] All ambiguous type variables have explicit annotations
- [ ] No `error` or `undefined` in production code paths
- [ ] `Maybe` and `Either` error cases handled (no partial functions like `head` on empty list)
- [ ] `unsafePerformIO` and `unsafeCoerce` not used
- [ ] HLint passes with no errors
- [ ] All exported functions have type signatures
