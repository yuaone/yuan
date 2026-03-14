## Identity
- domain: verilog
- type: language
- confidence: 0.88

# Verilog/SystemVerilog — Error Pattern Reference

Read the exact synthesis or simulation tool message including the file, line, and severity level. HDL errors split into simulation errors (behavioral bugs) and synthesis errors (hardware mapping failures) — both must be resolved separately.

## Error Code Quick Reference
- **"Multiple drivers on net 'x'"** — Wire driven from more than one always block or assignment.
- **"Latch inferred for 'x'"** — Incomplete sensitivity list or missing else/default branch.
- **"Sensitivity list may not be complete"** — Missing signal in always block sensitivity.
- **"Width mismatch in assignment"** — Left and right side bit widths differ.
- **"Undefined variable 'x'"** — Wire/reg not declared before use.
- **"Non-blocking assignment in combinational logic"** — `<=` used in `always @(*)` block.
- **"Blocking assignment in sequential logic"** — `=` used in `always @(posedge clk)` block.
- **"Undeclared port in module instantiation"** — Port name not found in the module definition.

## Known Error Patterns

### Blocking vs Non-Blocking Assignment — always Block Confusion
- **Symptom**: Simulation produces correct results but synthesis behavior differs; waveforms show immediate vs delayed value updates; Synopsys/Vivado warns about mixed assignment types.
- **Cause**: In `always @(posedge clk)` (sequential/flip-flop) blocks, non-blocking assignments (`<=`) should be used — they model register behavior with all updates applied simultaneously at the end of the time step. In `always @(*)` (combinational) blocks, blocking assignments (`=`) should be used — they model wire behavior with immediate evaluation. Mixing them causes simulation-synthesis mismatch.
- **Strategy**: 1. Grep all `always @(posedge` blocks and verify every assignment uses `<=`. 2. Grep all `always @(*)` blocks and verify every assignment uses `=`. 3. Never mix `=` and `<=` in the same `always` block. 4. For `always @(posedge clk or posedge rst)` reset blocks, use `<=` for both the reset assignment and the normal operation.
- **Tool sequence**: grep (`always @(posedge`, `always @(*`, `always @\(`) → file_read → file_edit (fix assignment operators)
- **Pitfall**: Do NOT use blocking assignments in sequential logic to "optimize" simulation speed — it causes race conditions in simulation and simulation-synthesis mismatch that only appears on real hardware.

### Multiple Drivers on Wire — Synthesis Error
- **Symptom**: `Error: Multiple drivers on net 'bus_data'`; tool refuses to synthesize; simulation shows X (unknown) values on the wire.
- **Cause**: In Verilog, a `wire` can only have one driver. If two `always` blocks both assign to the same `wire` or `reg`, or if two module instantiations both drive the same net, the result is undefined. Common in bus architectures where multiple modules share a data bus.
- **Strategy**: 1. Grep the signal name to find all assignment locations (`assign`, `always` blocks, module output ports). 2. For bus sharing, use a mux: only one driver is active at a time based on a select signal. 3. For tri-state buses, use `wire` with `assign bus = enable ? data : 1'bz`. 4. For `reg` types, ensure only one `always` block drives each register. 5. Use SystemVerilog `logic` type which provides better error detection for multiple drivers.
- **Tool sequence**: grep (signal name across all files) → file_read → file_edit (add mux or tri-state logic, remove duplicate drivers)
- **Pitfall**: Do NOT use `wire` with multiple `assign` statements hoping the synthesis tool will "figure it out" — multiple drivers on a wire is a hardware short circuit.

### Latch Inferred — Incomplete Case or Missing Else
- **Symptom**: Synthesis warning `Latch inferred for signal 'x' in process`; FPGA resource usage shows unexpected latches instead of flip-flops; behavior differs between simulation and synthesis.
- **Cause**: In combinational `always @(*)` blocks, if not all possible input combinations assign a value to an output, the synthesizer infers a latch to "hold" the previous value. This happens with: incomplete `if-else` (missing `else`), incomplete `case` (missing `default`), or a signal only assigned in some branches.
- **Strategy**: 1. Grep all `always @(*)` blocks. 2. For every `if` statement, ensure there is a matching `else` that assigns all outputs. 3. For every `case` statement, ensure there is a `default` branch that assigns all outputs. 4. As a defensive pattern, assign default values to all outputs at the top of the combinational block before the `if`/`case`, then override in branches. 5. If a latch is intentionally needed, use a `reg` in a sequential block instead.
- **Tool sequence**: grep (`always @(\*)`) → file_read → file_edit (add default assignments at top or add else/default branch)
- **Pitfall**: Do NOT suppress latch inference warnings — latches are timing hazards and usually indicate a bug. Investigate every latch warning.

### Clock Domain Crossing Metastability
- **Symptom**: Intermittent failures only on actual FPGA hardware; simulation passes; timing analysis shows paths crossing clock domains; MTBF (mean time between failures) calculation fails.
- **Cause**: Signals passing from one clock domain to another can arrive at a flip-flop near its setup/hold time window. The flip-flop enters a metastable state that randomly resolves to 0 or 1. A single flip-flop synchronizer does not provide sufficient metastability resolution time.
- **Strategy**: 1. Identify all signals that cross clock domains — look for signals driven in one `always @(posedge clk_a)` block and read in another `always @(posedge clk_b)` block. 2. For single-bit signals, use a 2-flip-flop synchronizer: two cascaded FFs in the destination clock domain. 3. For multi-bit data, use a FIFO with separate read/write clock ports (Gray code counter or vendor-provided async FIFO). 4. For control signals, use handshake protocols (req/ack). 5. Use CDC analysis tools (Synopsys SpyGlass, Cadence JasperGold CDC).
- **Tool sequence**: grep (signals used across multiple clock domains) → file_read → file_edit (add synchronizer FFs or async FIFO)
- **Pitfall**: Do NOT use a simple `assign` to cross clock domains — even a single combinational wire crossing clock domains is a CDC violation that will cause intermittent failures.

### Simulation vs Synthesis Mismatch — Initial Blocks and Delays
- **Symptom**: Simulation shows correct behavior with `#delay` timing; synthesis produces incorrect functionality; `initial` block values don't reflect on FPGA startup.
- **Cause**: (1) `#delay` timing constructs are ignored by synthesis tools — they are simulation-only. (2) `initial` blocks are not synthesizable in most target technologies (exception: FPGA block RAMs with initial values). (3) Simulation starts with `x` values which combine operations may mask; synthesis optimizes based on don't-care.
- **Strategy**: 1. Grep all `#` delay statements — remove them from synthesizable RTL and document they are testbench-only constructs. 2. Grep all `initial` blocks — if they are in RTL (not testbench), replace register initialization with a reset signal. 3. Use synchronous reset `always @(posedge clk) if (rst) out <= 0;` instead of `initial begin out = 0; end`. 4. Maintain separate testbench files (`*_tb.v`) with clear naming to avoid mixing simulation and RTL constructs.
- **Tool sequence**: grep (`#[0-9]`, `initial begin`) → file_read → file_edit (remove #delays, replace initial with reset logic)
- **Pitfall**: Do NOT use `#1` delays in RTL to "fix" simulation race conditions — the correct fix is proper use of non-blocking assignments, not delays.

### Width Mismatch — Truncation or Zero-Extension Bug
- **Symptom**: Tool warns `Width mismatch: assigning 32-bit value to 8-bit net`; runtime shows truncated or zero-extended values; arithmetic produces unexpected results.
- **Cause**: Verilog implicitly truncates or zero-extends values when widths don't match. Assigning a 32-bit result to an 8-bit register silently discards the upper 24 bits. Integer literals default to 32 bits.
- **Strategy**: 1. Enable all synthesis and simulation warnings — treat width mismatch warnings as errors. 2. Explicitly size all literals: `8'd255` not `255`. 3. Use explicit width casts: `result[7:0]` to select specific bits. 4. For addition with carry, declare the result one bit wider than the operands: `wire [8:0] sum = {1'b0, a} + {1'b0, b}; wire carry = sum[8];`. 5. Use SystemVerilog `logic [N-1:0]` with explicit width declarations everywhere.
- **Tool sequence**: file_read (signals and assignments) → file_edit (add explicit bit widths to literals and widen result registers)
- **Pitfall**: Do NOT treat implicit truncation as intentional bit selection — use explicit `[N-1:0]` slice notation to document intent.

## Verification
Run simulation: `vvp a.out` (Icarus) or ModelSim `vsim`
- All assertions must pass; waveform matches expected behavior.
- Run synthesis: Vivado `synth_design` or Quartus — zero errors, zero latch warnings.
- Run static timing analysis (STA) — all timing paths must meet constraints (WNS > 0).

## Validation Checklist
- [ ] All `always @(posedge clk)` blocks use non-blocking assignments (`<=`)
- [ ] All `always @(*)` blocks use blocking assignments (`=`)
- [ ] No `#delay` constructs in RTL (only in testbenches)
- [ ] No `initial` blocks in synthesizable RTL (use reset logic instead)
- [ ] All `case` statements have a `default` branch
- [ ] All `if` statements have a matching `else` branch (or default assignment at block top)
- [ ] No multiple drivers on any single net
- [ ] All CDC paths use 2-FF synchronizers or async FIFOs
- [ ] All signal widths explicitly declared — no implicit width mismatches
- [ ] Synthesis timing analysis passes with positive WNS on all critical paths
