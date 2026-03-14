## Identity
- domain: solidity
- type: language
- confidence: 0.95

# Solidity — Error Pattern Reference

Read the exact compiler error and line number first. Solidity errors often point to a security vulnerability, not just a type mismatch — treat every warning as a potential exploit vector.

## Error Code Quick Reference
- **SWC-107** — Reentrancy: external call before state update.
- **SWC-101** — Integer overflow/underflow (pre-0.8.x without SafeMath).
- **SWC-104** — Unchecked return value from low-level call.
- **SWC-115** — tx.origin used for authentication.
- **SWC-128** — DoS with failed call (gas exhaustion).
- **TypeError: Overriding function missing "override"** — function override not declared.
- **TypeError: Function state mutability can be restricted** — view/pure missing.
- **Warning: Return value of low-level call is not used** — unchecked `.call()` return.
- **DeclarationError: Identifier already declared** — name collision in scope.

## Known Error Patterns

### Reentrancy Attack — Call Before State Update
- **Symptom**: Funds drained repeatedly in a single transaction; contract balance zeroed unexpectedly. Compiler may emit no error — this is a logic bug.
- **Cause**: An external `.call{value: amount}()` is made before the internal accounting state (balance mapping, flag) is updated. The callee's `receive()` or `fallback()` re-enters the function before the state reflects the first withdrawal.
- **Strategy**: 1. Grep all external calls (`\.call{`, `\.transfer(`, `\.send(`). 2. For each call site, read the function and verify the state update (e.g., `balances[msg.sender] -= amount`) happens BEFORE the call. 3. Apply the Checks-Effects-Interactions (CEI) pattern: checks first, state mutations second, external interactions last. 4. As an additional layer, add a `ReentrancyGuard` modifier using a `locked` boolean flag. 5. Re-audit any function that calls an external contract.
- **Tool sequence**: grep (`\.call{value`) → file_read → file_edit (move state update before call, add nonReentrant modifier)
- **Pitfall**: Do NOT rely on `transfer()` or `send()` alone as reentrancy protection — their 2300 gas stipend is not guaranteed to remain safe with EVM upgrades (EIP-1884).

### Integer Overflow / Underflow — Pre-0.8.x SafeMath
- **Symptom**: Token balances wrap around to huge values; subtraction from small value produces near-`uint256` max.
- **Cause**: Solidity <0.8.0 does not revert on arithmetic overflow/underflow. `uint8(255) + 1 == 0`. Without SafeMath, any unchecked arithmetic can wrap.
- **Strategy**: 1. Check the `pragma solidity` version at the top of each file. 2. If <0.8.0, grep all arithmetic operations (`+`, `-`, `*`, `/`) on numeric types. 3. Import and use OpenZeppelin's SafeMath library for every operation, or upgrade to >=0.8.0 which has built-in overflow checks. 4. After upgrade, test edge cases (max value +1, 0 -1) in unit tests.
- **Tool sequence**: grep (`pragma solidity`) → file_read (arithmetic operations) → file_edit (add SafeMath or upgrade pragma)
- **Pitfall**: Do NOT assume `uint256` is safe from underflow — subtracting from a value smaller than the subtrahend wraps to near `2^256`. Underflow is as dangerous as overflow.

### Unchecked Return Value — ERC20 transfer / low-level call
- **Symptom**: Transfer silently fails; funds are not moved but execution continues. Non-reverting ERC20 tokens (e.g., USDT) return `false` instead of reverting.
- **Cause**: `token.transfer(to, amount)` on non-standard ERC20 tokens returns `false` on failure instead of reverting. Low-level `.call()` always returns `(bool success, bytes memory data)` — ignoring `success` means silent failures.
- **Strategy**: 1. Grep all `.transfer(`, `.transferFrom(`, `.call(` usages. 2. For ERC20 transfers, use OpenZeppelin's `SafeERC20.safeTransfer()` which internally checks return values and reverts on failure. 3. For low-level calls, always destructure and check: `(bool success, ) = addr.call{...}(...); require(success, "call failed");`. 4. Audit all external call return values.
- **Tool sequence**: grep (`\.call(`, `\.transfer(`) → file_read → file_edit (wrap with SafeERC20 or add require(success))
- **Pitfall**: Do NOT use `.transfer()` on ERC20 tokens and assume it behaves like ETH transfer — they are completely different methods.

### tx.origin Authentication Bypass
- **Symptom**: Phishing contract can call victim contract on behalf of the original signer; access control is bypassed.
- **Cause**: `tx.origin` refers to the original EOA that initiated the entire transaction chain, not the immediate caller. A malicious contract in the call chain can exploit `require(tx.origin == owner)` because `tx.origin` is the user, not the attacker contract.
- **Strategy**: 1. Grep all occurrences of `tx.origin`. 2. Replace every access control check with `msg.sender` — the immediate caller. 3. Only use `tx.origin` if you explicitly need to differentiate EOA from contract (e.g., `require(tx.origin == msg.sender, "no contracts")`) — but even this is rarely correct.
- **Tool sequence**: grep (`tx\.origin`) → file_read → file_edit (replace with msg.sender)
- **Pitfall**: Do NOT use `tx.origin == msg.sender` as a "contracts not allowed" guard in production — wallets like Gnosis Safe are themselves contracts and will be blocked.

### Gas Estimation Failure — Out-of-Gas in Loop
- **Symptom**: Transaction reverts with `out of gas`; Hardhat/Foundry estimates wildly differ from actual gas. Loops over dynamic arrays cause this.
- **Cause**: Iterating over an unbounded array (e.g., `for (uint i = 0; i < users.length; i++)`) consumes gas proportional to array size. If the array grows large enough, the gas cost exceeds the block gas limit, permanently locking the function.
- **Strategy**: 1. Grep all `for` loops and `while` loops in contracts. 2. Identify loops over storage arrays that are user-controlled or unbounded. 3. Replace unbounded loops with a pull-payment pattern (each user claims individually) or pagination (process N items per call). 4. Use events for off-chain aggregation instead of on-chain loops. 5. Set a max iteration constant if the loop must exist.
- **Tool sequence**: grep (`for (`, `while (`) → file_read → file_edit (add max cap or extract to pull pattern)
- **Pitfall**: Do NOT add a `gasleft() > MINIMUM` check as the primary fix — it converts a revert into a partial execution, which is often worse.

### Visibility Not Specified — Default Public
- **Symptom**: Sensitive function callable by anyone; Slither warns "function has no visibility specifier."
- **Cause**: Solidity <0.5.0 defaulted functions to `public` when no visibility was specified. In >=0.5.0 this is a compile error, but audits of legacy code reveal functions that should be `internal` or `private`.
- **Strategy**: 1. Grep all `function` declarations. 2. Verify each has an explicit `public`, `external`, `internal`, or `private` specifier. 3. Apply principle of least privilege: prefer `internal` for helper functions, `external` for functions only called from outside. 4. Run Slither static analysis to catch visibility issues automatically.
- **Tool sequence**: grep (`function `) → file_read → file_edit (add explicit visibility)
- **Pitfall**: Do NOT blindly mark all functions `private` — internal contract helpers called by child contracts must be `internal`.

## Verification
Run: `solc --strict-assembly` or `npx hardhat compile`
- Zero errors and zero warnings (especially SWC warnings) = passing baseline.
- Run Slither: `slither . --print human-summary` for static analysis.
- Run Foundry tests: `forge test -vvv` — all tests must pass.

## Validation Checklist
- [ ] All arithmetic uses SafeMath or pragma >=0.8.0 with no `unchecked` blocks near user input
- [ ] No `tx.origin` used for access control
- [ ] Every `.call()` return value is checked with `require(success, ...)`
- [ ] CEI pattern enforced: state updates happen before all external calls
- [ ] No unbounded loops over user-controlled storage arrays
- [ ] All functions have explicit visibility specifiers
- [ ] Reentrancy guard applied to all state-changing functions that make external calls
- [ ] ERC20 interactions use SafeERC20 wrappers
- [ ] Events emitted for all state changes (for off-chain auditability)
- [ ] Slither static analysis passes with no high-severity findings
