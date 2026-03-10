/**
 * @module coding-standards
 * @description Comprehensive language-specific coding best practices for sub-agents.
 *
 * Injected into system prompts when a language is detected.
 * 50+ languages covered: systems, HDL, embedded, web, mobile, data, devops,
 * functional, game, blockchain, emerging.
 *
 * Each standard: 150-250 tokens (concise rules, not essays).
 */

// ─── Types ───

/** Language category for organization */
export type LanguageCategory =
  | "systems"
  | "hdl"
  | "embedded"
  | "fpga"
  | "web-frontend"
  | "web-backend"
  | "mobile"
  | "data-ml"
  | "devops"
  | "scripting"
  | "functional"
  | "game"
  | "blockchain"
  | "emerging";

interface LanguageStandard {
  name: string;
  category: LanguageCategory;
  aliases: string[];
  standards: string;
}

// ─── Registry ───

const STANDARDS: Map<string, LanguageStandard> = new Map();

function register(std: LanguageStandard): void {
  STANDARDS.set(std.name.toLowerCase(), std);
  for (const alias of std.aliases) {
    STANDARDS.set(alias.toLowerCase(), std);
  }
}

// ═══════════════════════════════════════════════════════════════
// 1. SYSTEMS & LOW-LEVEL
// ═══════════════════════════════════════════════════════════════

register({
  name: "C",
  category: "systems",
  aliases: ["c", "c99", "c11", "c17", "c23"],
  standards: `Core rules:
- Every malloc must have a paired free. Set pointers to NULL after free. Check malloc return for NULL.
- Buffer overflow prevention: use snprintf over sprintf, strncpy over strcpy, bounds-check all array accesses.
- const-correctness: mark all read-only params as const. Use const for pointer-to-data (const char*) vs pointer itself (char* const).
- volatile for hardware registers and ISR-shared variables. Never cache volatile reads in local variables.
- Static analysis: zero warnings with -Wall -Wextra -Werror. MISRA-C compliance for safety-critical code.
Pitfalls: never return pointers to stack variables. Avoid undefined behavior (signed overflow, null deref, unsequenced modifications).
Performance: prefer stack allocation over heap. Use restrict for non-aliasing pointers. Profile before optimizing.
Safety: validate all external input lengths. Use fixed-size buffers with explicit bounds. No implicit integer conversions in security paths.`,
});

register({
  name: "C++",
  category: "systems",
  aliases: ["cpp", "cc", "cxx", "c++", "c++17", "c++20", "c++23", "hpp"],
  standards: `Core rules:
- RAII for all resource management. No manual new/delete — use smart pointers: unique_ptr > shared_ptr > raw.
- Move semantics: implement move constructor/assignment for resource-owning types. Use std::move for transfers.
- Rule of Five: if you define any of destructor/copy-ctor/copy-assign/move-ctor/move-assign, define all five.
- constexpr for compile-time computation. Prefer constexpr over macros and const for constants.
- Exception safety: basic guarantee minimum. Strong guarantee for critical operations. noexcept on move operations.
Pitfalls: avoid slicing (pass polymorphic types by reference/pointer). No raw owning pointers. Beware dangling references from temporaries.
Performance: reserve() containers when size is known. Prefer emplace_back over push_back. Use string_view for read-only string params.
Safety: enable -fsanitize=address,undefined in debug. Use [[nodiscard]] on functions whose return must not be ignored.`,
});

register({
  name: "Rust",
  category: "systems",
  aliases: ["rs", "rust"],
  standards: `Core rules:
- Ownership: prefer borrowing (&T, &mut T) over cloning. Move semantics by default — clone only when necessary.
- Result<T, E> for recoverable errors, Option<T> for absence. Propagate with ?. No .unwrap() in production — use .expect() with context or proper error handling.
- Lifetime annotations only when compiler requires them. Prefer owned types in structs over references.
- Trait bounds: use impl Trait in arguments, explicit bounds in generic structs. Derive common traits (Debug, Clone, PartialEq).
- unsafe: minimize and isolate. Document safety invariants with // SAFETY: comments. Encapsulate in safe abstractions.
Pitfalls: avoid RefCell unless truly needed (runtime borrow panics). Don't fight the borrow checker — redesign.
Performance: iterators over index loops. Use .collect() with turbofish. Prefer &str over String for read-only params.
Safety: run clippy (cargo clippy -- -D warnings). Use #[deny(unsafe_code)] at crate level for non-FFI crates. no_std for embedded targets.`,
});

register({
  name: "Assembly",
  category: "systems",
  aliases: ["asm", "assembly", "x86", "arm", "aarch64", "mips", "riscv", "s"],
  standards: `Core rules:
- Follow platform calling convention strictly: cdecl/System V AMD64 (x86-64), AAPCS (ARM), standard (RISC-V). Caller/callee-saved registers must be respected.
- Stack alignment: 16-byte on x86-64, 8-byte on ARM. Misalignment causes faults or silent performance loss.
- Comment every logical block: purpose, register usage, algorithm step. Label naming: module_function_purpose.
- Macro safety: avoid side effects in macro arguments. Use .macro/.endm (GAS) or MACRO/ENDM (MASM). Unique labels in macros with \\@ or LOCAL.
- Preserve frame pointer for debuggability unless in hot inner loops with profiling proof.
Pitfalls: don't assume register state across function calls. Clear direction flag (CLD) before string ops on x86. Beware endianness in multi-byte loads.
Performance: align branch targets. Minimize pipeline stalls — instruction scheduling matters. Use SIMD (SSE/AVX/NEON) for data parallelism.
Safety: never execute data. Mark stack non-executable. Validate all jump targets in JIT scenarios.`,
});

register({
  name: "Zig",
  category: "systems",
  aliases: ["zig"],
  standards: `Core rules:
- comptime for compile-time computation — replace macros and generics. comptime parameters for type-level programming.
- Error unions: return errors explicitly, handle with try/catch. No hidden control flow. Error sets are first-class types.
- No hidden allocations: all allocators are explicit parameters. Use std.mem.Allocator interface. Prefer arena/stack allocators for temporary data.
- Optional types (?T) for nullable values. Unwrap with orelse/if for safe access. Never assume non-null.
- C interop: use @cImport for headers. Zig pointers vs C pointers — mind sentinel-terminated ([*:0]u8) for C strings.
Pitfalls: comptime code runs at compile time — don't do I/O in comptime. Slices are fat pointers (ptr + len), not arrays.
Performance: SIMD via @Vector. Release-safe mode for production. Use @prefetch for memory access patterns.
Safety: safety checks enabled by default (bounds, overflow). Keep them on in release-safe. Disable only in release-fast with benchmarks.`,
});

// ═══════════════════════════════════════════════════════════════
// 2. HARDWARE DESCRIPTION LANGUAGES (HDL)
// ═══════════════════════════════════════════════════════════════

register({
  name: "VHDL",
  category: "hdl",
  aliases: ["vhdl", "vhd"],
  standards: `Core rules:
- Signal vs variable: signals update at end of process (concurrent), variables update immediately (sequential). Use signals for inter-process communication, variables for local computation.
- Process sensitivity lists MUST be complete — missing signals cause simulation/synthesis mismatch. Use (all) in VHDL-2008 for combinational logic.
- Synchronous design: all flip-flops clocked by single edge (rising_edge(clk)). Explicit reset strategy — synchronous reset preferred for FPGA, async for ASIC if required.
- Clock domain crossing (CDC): use 2-stage synchronizer for single-bit, handshake or async FIFO for multi-bit. Never directly sample signals across clock domains.
- Naming: snake_case for signals, UPPER_CASE for constants/generics. Prefix: i_ input, o_ output, r_ register, w_ wire, c_ constant.
Pitfalls: incomplete if/case creates latches — always have else/default. Avoid initial values on signals (not synthesizable on all targets).
Performance: pipeline long combinational paths. Register outputs for better timing. Use DSP blocks for multiplication.
Safety: DO-254 for avionics. Full testbench coverage with self-checking assertions. Use numeric_std, not std_logic_arith.`,
});

register({
  name: "Verilog",
  category: "hdl",
  aliases: ["verilog", "v", "systemverilog", "sv"],
  standards: `Core rules:
- Blocking (=) for combinational logic (always_comb), non-blocking (<=) for sequential logic (always_ff). Never mix in same block.
- SystemVerilog: use always_ff for flip-flops, always_comb for combinational, always_latch only when intentional. Avoid plain always @*.
- Avoid unintentional latches: every if needs else, every case needs default in combinational blocks. Use unique/priority case for full/parallel encoding.
- Parameterized modules: use parameter/localparam for configurability. Generate blocks for structural repetition. Interface for grouped signals.
- Assertions (SVA): assert property for functional verification. cover property for coverage. Bind assertions to modules from testbench.
Pitfalls: sensitivity list mismatch between simulation and synthesis. Don't read/write same signal in multiple always blocks. Beware integer overflow in loop bounds.
Performance: minimize clock-to-output delay. Balance pipeline stages. Use vendor-specific primitives (DSP, BRAM) for critical paths.
Safety: full CDC verification. Lint with tools like Spyglass/Verilator. Coverage-driven verification: line, toggle, FSM, assertion coverage targets >95%.`,
});

register({
  name: "Chisel",
  category: "hdl",
  aliases: ["chisel"],
  standards: `Core rules:
- Bundle for grouped signals (like VHDL record or SystemVerilog struct). Use Flipped() for input bundles in IO.
- RegNext for 1-cycle delay, RegInit for reset value, RegEnable for conditional update. Never use Reg without initialization in synthesizable code.
- when/elsewhen/otherwise for conditional logic (maps to mux). switch(enum) for FSMs with is() cases.
- Decoupled interface (valid/ready/bits) for handshake protocols. Use Queue() for FIFOs. Pipe() for pipeline stages.
- Module hierarchy: one module per file. Use lazy val io = IO(...). Parameters via case class config objects.
Pitfalls: Chisel Wire vs Reg — Wire for combinational, Reg for sequential. Don't connect same signal twice. DontCare for unused outputs.
Performance: use Mem for synchronous RAM inference. BlackBox for vendor IP integration. Annotations for physical constraints.
Safety: PeekPokeTester/ChiselTest for simulation. Use chiseltest fork/join for concurrent testing. Assert in hardware with assert() for runtime checks.`,
});

register({
  name: "SpinalHDL",
  category: "hdl",
  aliases: ["spinalhdl", "spinal"],
  standards: `Core rules:
- Component hierarchy: one Component per module. Use in()/out() for port directions. Bundle for grouped signals.
- ClockDomain handling: explicit clock domains with ClockDomain(). Use ClockDomainTag for multi-clock designs. BufferCC for clock domain crossing.
- Stream interface for handshake (valid/ready/payload): use .queue(), .m2sPipe(), .s2mPipe() for buffering. Flow for valid-only (no backpressure).
- Reg() for registers with init(). RegNext/RegNextWhen for convenience. Use switch/is for FSMs.
- Simulation: SimConfig for test setup. fork/sleep/waitUntil for testbench timing. Use SpinalSimTester for regression.
Pitfalls: latches from incomplete when/otherwise. Use default() assignment before conditional logic. Mind simulation delta cycles vs real hardware timing.
Performance: use pipeline building blocks from lib. Explicit retiming with KeepAttribute. Memory blackboxing for BRAM inference.
Safety: generate VHDL/Verilog and verify with formal tools. Use SpinalHDL's built-in assertion framework for hardware assertions.`,
});

// ═══════════════════════════════════════════════════════════════
// 3. EMBEDDED & RTOS
// ═══════════════════════════════════════════════════════════════

register({
  name: "Embedded C",
  category: "embedded",
  aliases: ["embedded-c", "embedded_c", "mcu-c"],
  standards: `Core rules:
- ISR rules: keep ISRs short (set flag, return). No malloc/printf/floating-point in ISR. Use volatile for ISR-shared variables. Disable/enable interrupts for critical sections.
- DMA safety: ensure buffer alignment. Use memory barriers before/after DMA transfers. Invalidate cache for DMA-written memory.
- Peripheral register access: use bit manipulation (|=, &= ~, ^=) with defined masks. Read-modify-write needs interrupt protection. Use volatile pointer casts for MMIO.
- Power management: enter low-power modes when idle. Disable unused peripherals' clocks. Use WFI/WFE instructions.
- Watchdog: configure early, kick regularly. Don't kick in ISR (masks main loop hangs). Use windowed watchdog if available.
Pitfalls: stack overflow in tasks/ISR — size conservatively, use canaries. Pointer alignment for ARM Cortex-M (unaligned access faults on some cores).
Performance: DMA for bulk transfers. Lookup tables over runtime computation. Interrupt coalescing for high-frequency events.
Safety: MISRA-C compliance for automotive/medical. Static analysis mandatory. Defensive programming: check all peripheral status before use.`,
});

register({
  name: "Arduino",
  category: "embedded",
  aliases: ["arduino", "esp32", "esp8266", "platformio"],
  standards: `Core rules:
- setup() for one-time initialization, loop() for main execution. Never block loop() with long delays.
- millis() over delay() for non-blocking timing. Use state machines for multi-step sequences. Track previousMillis for intervals.
- ISR-safe variables: declare volatile for shared variables. Use ATOMIC_BLOCK or noInterrupts()/interrupts() for multi-byte reads.
- PROGMEM for constant strings/arrays to save RAM: const char str[] PROGMEM. Read with pgm_read_byte/word.
- WiFi/BLE: reconnect logic with exponential backoff. Watchdog timer for network hangs. Secure connections (TLS/encrypted).
Pitfalls: String class fragments heap — use char arrays and snprintf. Don't use delay() in libraries. analogRead() on ESP32 is noisy — use averaging.
Performance: minimize Serial.print in production. Use hardware timers over software timing. Direct port manipulation for speed-critical GPIO.
Safety: input validation on all serial/network data. OTA updates with checksum verification. Brownout detection and graceful shutdown.`,
});

register({
  name: "FreeRTOS",
  category: "embedded",
  aliases: ["freertos", "rtos"],
  standards: `Core rules:
- Task priorities: assign based on urgency, not importance. Avoid priority inversion — use priority inheritance mutexes. Keep ISR-triggered tasks at high priority.
- Mutex vs semaphore: mutex for resource ownership (has owner, supports inheritance), binary semaphore for signaling (no owner). Never use mutex in ISR.
- Queue usage: xQueueSend for task-to-task communication. xQueueSendFromISR in ISR (with pxHigherPriorityTaskWoken). Size queues to handle burst traffic.
- Stack overflow detection: enable configCHECK_FOR_STACK_OVERFLOW=2. Size stacks with uxTaskGetStackHighWaterMark(). Add 20% safety margin.
- ISR-safe API: always use FromISR variants in ISR context (xSemaphoreGiveFromISR, xQueueSendFromISR). Pass and check pxHigherPriorityTaskWoken, call portYIELD_FROM_ISR.
Pitfalls: deadlock from nested mutex acquisition — always lock in consistent order. Don't call vTaskDelay in ISR. Heap fragmentation — use static allocation where possible.
Performance: minimize critical sections. Use task notifications (faster than semaphores) for simple signaling. Stream/message buffers for ISR-to-task data.
Safety: configASSERT for development. Idle hook for watchdog kicks. Stack canaries for overflow detection.`,
});

register({
  name: "Zephyr RTOS",
  category: "embedded",
  aliases: ["zephyr", "zephyr-rtos"],
  standards: `Core rules:
- Devicetree bindings: define hardware in .dts/.dtsi overlay files. Use DT_NODELABEL, DT_ALIAS macros to reference nodes. DEVICE_DT_GET for driver instances.
- Kconfig options: CONFIG_ prefix for all build options. Use menuconfig for interactive config. Dependent options with depends on/select.
- Kernel objects: k_thread for threads, k_sem/k_mutex for sync, k_msgq for message passing, k_timer for periodic events. All objects require initialization.
- Power management API: pm_device_runtime_get/put for device power. Automatic idle entry. Configure with CONFIG_PM.
- Logging: use LOG_MODULE_REGISTER for per-module logging. LOG_DBG/INF/WRN/ERR macros. Runtime log level filtering.
Pitfalls: thread stack size in Kconfig/overlay — too small causes silent corruption. Mind ISR vs thread context for API calls. Devicetree property access must match binding type.
Performance: use zero-copy APIs (net_buf, ring_buffer). Hardware offload where available. Minimize ISR-to-thread latency with direct ISR-to-thread notification.
Safety: use Zephyr's built-in security subsystem. MPU-based thread isolation. Certified for IEC 61508 (SIL3).`,
});

// ═══════════════════════════════════════════════════════════════
// 4. FPGA & DIGITAL DESIGN
// ═══════════════════════════════════════════════════════════════

register({
  name: "HLS",
  category: "fpga",
  aliases: ["hls", "vivado-hls", "vitis-hls", "high-level-synthesis"],
  standards: `Core rules:
- Pragma directives: #pragma HLS PIPELINE II=1 for throughput. #pragma HLS UNROLL for loop parallelism. #pragma HLS ARRAY_PARTITION for parallel memory access.
- Interface synthesis: #pragma HLS INTERFACE for port protocols. Use AXI4-Lite for control registers, AXI4-Stream for data streams, FIFO for producer-consumer.
- Latency vs throughput: pipeline for throughput, unroll for latency. Use DATAFLOW pragma for task-level parallelism between functions.
- Fixed-point arithmetic: ap_fixed<W,I> over float. Define bit-widths to match precision requirements. Use ap_int<N> for arbitrary-width integers.
- Loop optimization: merge nested loops when possible. Trip count hints with #pragma HLS LOOP_TRIPCOUNT. Avoid variable-bound loops.
Pitfalls: dynamic memory allocation not synthesizable. Recursion not supported. System calls (printf) only for simulation. Pointer arithmetic limitations.
Performance: minimize II (Initiation Interval). Partition arrays to resolve port contention. Use burst access for DDR. Balance pipeline stages.
Safety: verify with C/RTL co-simulation. Check resource utilization (LUT, FF, BRAM, DSP) against device limits. Timing closure at target frequency.`,
});

register({
  name: "Tcl",
  category: "fpga",
  aliases: ["tcl", "vivado-tcl", "quartus-tcl"],
  standards: `Core rules:
- Timing constraints: create_clock for all clock sources with accurate period. set_false_path for truly asynchronous paths. set_multicycle_path for multi-cycle operations.
- Proper quoting: curly braces {} for literal strings (no substitution), double quotes "" for substitution. Use list for building command arguments safely.
- Vivado/Quartus scripting: source scripts for reproducibility. Use project mode for interactive, non-project for CI. Store constraints in .xdc/.sdc files.
- Variable handling: set for assignment, $ for reference. Use upvar for pass-by-reference. namespace for encapsulation.
- Error handling: catch for error recovery. Always check return codes from tool commands. Use -quiet flag sparingly (masks real errors).
Pitfalls: whitespace sensitivity in Tcl — extra spaces change command parsing. Unquoted brackets trigger command substitution. Glob patterns need proper escaping.
Performance: batch mode over GUI for CI. Incremental compilation where supported. Parallel synthesis/implementation with -jobs flag.
Safety: version-control all constraint files. Review timing reports — never ignore unconstrained paths. Validate I/O constraints match schematic.`,
});

// ═══════════════════════════════════════════════════════════════
// 5. WEB FRONTEND
// ═══════════════════════════════════════════════════════════════

register({
  name: "TypeScript",
  category: "web-frontend",
  aliases: ["ts", "typescript", "tsx"],
  standards: `Core rules:
- Strict mode always (strict: true in tsconfig). Explicit return types on exported functions. No any — use unknown + type guards or generics.
- Prefer const over let, never var. Use readonly for immutable properties. Prefer interfaces for object shapes, type aliases for unions/intersections.
- Named exports over default exports. Discriminated unions for state modeling. Exhaustive switch with never for completeness checking.
- Null safety: optional chaining (?.) and nullish coalescing (??). Strict null checks enabled. No non-null assertions (!) unless provably safe.
- Error handling: custom Error subclasses with cause chain. Async functions always try-catch. Never swallow errors silently.
Pitfalls: avoid enums (use const objects + typeof for tree-shaking). Don't over-type — let inference work for local variables. Beware index signature pitfalls.
Performance: use satisfies for validation without widening. Prefer template literal types for string manipulation. Use import type for type-only imports.
Safety: enable strict tsconfig options (noUncheckedIndexedAccess, exactOptionalPropertyTypes). Validate external data at boundaries with runtime checks.`,
});

register({
  name: "JavaScript",
  category: "web-frontend",
  aliases: ["js", "javascript", "jsx", "mjs", "cjs"],
  standards: `Core rules:
- ES2022+: const by default, let when needed, never var. Optional chaining (?.) and nullish coalescing (??) for null safety.
- Structured clone for deep copy (structuredClone). Promise.allSettled for parallel independent operations. Array methods (map, filter, reduce) over for loops.
- Arrow functions for callbacks, named function declarations for top-level (hoisting + better stack traces). Destructuring for clean parameter handling.
- Error handling: wrap async calls in try-catch. Custom Error classes. Never swallow errors. Use cause property for error chains.
- Modules: ESM (import/export) over CommonJS (require). Dynamic import() for code splitting.
Pitfalls: === over == always. typeof null === 'object' trap. Floating point: use Math.round/toFixed for currency. Avoid prototype pollution.
Performance: avoid creating objects in hot loops. Use Map/Set for frequent lookups. Lazy evaluation with generators for large datasets.
Safety: validate and sanitize all user input. No eval() or new Function(). Use Object.freeze for constants. CSP headers for XSS protection.`,
});

register({
  name: "React",
  category: "web-frontend",
  aliases: ["react", "reactjs"],
  standards: `Core rules:
- Functional components only. Follow Rules of Hooks: top-level only, React functions only. Custom hooks for reusable logic (useXxx naming).
- Unique key props in lists (not array index unless static). React.memo() for expensive renders. useMemo/useCallback for stable references passed as props.
- Clean up effects: return cleanup function from useEffect. Dependency arrays must be complete (eslint-plugin-react-hooks).
- Avoid prop drilling: use context for truly global state, composition for intermediate cases. Co-locate state close to where it's used.
- Server components (Next.js 13+): server by default, 'use client' only for interactivity. Minimize client bundle. Streaming with Suspense boundaries.
Pitfalls: don't setState in render. Avoid object/array literals in JSX props (creates new reference each render). useEffect for sync, not for derived state.
Performance: React.lazy + Suspense for code splitting. Virtualize long lists (react-window). Avoid unnecessary re-renders with React DevTools profiler.
Safety: never dangerouslySetInnerHTML with user input. Sanitize URLs (javascript: protocol). Use Content-Security-Policy headers.`,
});

register({
  name: "Vue",
  category: "web-frontend",
  aliases: ["vue", "vuejs", "vue3"],
  standards: `Core rules:
- Composition API with <script setup> (Vue 3). Define props with defineProps<T>(), emits with defineEmits<T>().
- ref() for primitives, reactive() for objects. Access ref values with .value in script, auto-unwrapped in template.
- computed() for derived state (cached, reactive). watch/watchEffect for side effects. Avoid watchers when computed suffices.
- provide/inject for dependency injection down component tree. Use InjectionKey<T> for type safety.
- SFC structure: <script setup>, <template>, <style scoped>. One component per file. Composables in use*.ts files.
Pitfalls: don't destructure reactive() — loses reactivity. Use toRefs() instead. shallowRef for large objects that replace wholesale.
Performance: v-once for static content. v-memo for list optimization. defineAsyncComponent for lazy loading.
Safety: never use v-html with user content. Use CSP headers. Validate props with runtime validators.`,
});

register({
  name: "Svelte",
  category: "web-frontend",
  aliases: ["svelte", "sveltejs", "sveltekit"],
  standards: `Core rules:
- Reactive declarations with $: for derived values. Reactive statements run when dependencies change. Use $: {} blocks for side effects.
- Stores for shared state: writable for read/write, readable for read-only, derived for computed. Auto-subscribe with $ prefix in components.
- bind:value for two-way binding. on:event for event handling. Transitions with transition:, in:, out: directives.
- SvelteKit: load functions for data fetching (server-side). +page.ts for universal load, +page.server.ts for server-only. Form actions for mutations.
- Component composition: slots for content projection. $$props for spreading. Context API with setContext/getContext.
Pitfalls: reactivity only triggers on assignment (push/splice don't trigger — reassign array). Don't mutate store values without set/update.
Performance: {#key} for forcing re-creation. Lazy loading with dynamic imports. Minimal runtime overhead (Svelte compiles away the framework).
Safety: {@html} is dangerous — sanitize first. Use SvelteKit's CSRF protection. Validate form data server-side.`,
});

register({
  name: "Angular",
  category: "web-frontend",
  aliases: ["angular", "ng"],
  standards: `Core rules:
- Standalone components (no NgModule). Use signals for reactive state (signal, computed, effect). inject() for dependency injection.
- OnPush change detection for performance. Avoid default change detection in production components.
- Typed reactive forms with FormBuilder. FormControl<T> for type safety. Custom validators as pure functions.
- Lazy-load routes with loadComponent/loadChildren. Use resolvers for data prefetching. Guards for auth/permissions.
- RxJS: prefer signals over observables for state. Use async pipe in templates for subscription management. unsubscribe in ngOnDestroy or use takeUntilDestroyed.
Pitfalls: memory leaks from unmanaged subscriptions. Don't subscribe in constructors. Avoid circular dependency injection.
Performance: trackBy for *ngFor. Defer blocks (@defer) for lazy rendering. SSR with Angular Universal for initial load.
Safety: Angular auto-sanitizes templates. Don't bypass with bypassSecurityTrust* unless absolutely necessary. Use HttpInterceptors for auth tokens.`,
});

register({
  name: "HTML/CSS",
  category: "web-frontend",
  aliases: ["html", "css", "scss", "sass", "less", "html-css"],
  standards: `Core rules:
- Semantic HTML: use <article>, <section>, <nav>, <aside>, <header>, <footer>, <main>. Not div soup. Headings in order (h1>h2>h3).
- BEM naming for CSS classes: block__element--modifier. Or use utility-first (Tailwind) consistently. Never mix methodologies.
- CSS custom properties (--color-primary) for theming. Container queries (@container) for component-responsive design. Logical properties (inline/block) for i18n.
- Accessibility: ARIA roles/labels for custom widgets. Alt text on images. Focus management for modals/dialogs. Color contrast ratio ≥4.5:1.
- Modern layout: CSS Grid for 2D, Flexbox for 1D. Avoid float for layout. Use gap instead of margin hacks.
Pitfalls: don't nest selectors >3 levels deep. Avoid !important (specificity wars). Test in multiple browsers/viewports.
Performance: critical CSS inlined. Lazy-load below-fold images (loading="lazy"). Minimize layout shifts (CLS) with explicit dimensions.
Safety: sanitize user-generated HTML. CSP headers to block inline scripts. Use rel="noopener" on external links.`,
});

register({
  name: "HTMX",
  category: "web-frontend",
  aliases: ["htmx"],
  standards: `Core rules:
- hx-get/post/put/delete for HTTP methods. Server returns HTML fragments, not JSON. Progressive enhancement — works without JS as base.
- hx-target for specifying where to place response. Use CSS selectors. hx-swap for controlling how: innerHTML, outerHTML, beforeend, afterbegin.
- hx-trigger for custom event triggers. Use modifiers: changed, delay:500ms, throttle:1s. hx-trigger="load" for initial fetch.
- Boost links and forms with hx-boost="true" for SPA-like navigation without JavaScript.
- hx-indicator for loading states. hx-confirm for confirmation dialogs. hx-vals for extra values.
Pitfalls: don't return full page for fragment requests (check HX-Request header). Cache busting with hx-push-url. Mind CORS for cross-origin requests.
Performance: return minimal HTML fragments. Use 286 status code to stop polling. OOB swaps (hx-swap-oob) for updating multiple elements from one response.
Safety: CSRF tokens in forms. Validate HX-Request header server-side. Never trust hx-vals for authorization — validate server-side.`,
});

// ═══════════════════════════════════════════════════════════════
// 6. WEB BACKEND
// ═══════════════════════════════════════════════════════════════

register({
  name: "Node.js",
  category: "web-backend",
  aliases: ["nodejs", "node"],
  standards: `Core rules:
- Async/await everywhere. No callback-style code. Use try-catch in async functions. Handle unhandled rejections: process.on('unhandledRejection').
- Error handling: process.on('uncaughtException') for logging + graceful exit. Custom error classes. Never throw strings.
- Streams for large data (readable.pipe(writable)). Backpressure handling with highWaterMark. Use pipeline() from stream/promises.
- Worker threads for CPU-bound tasks. Cluster module or PM2 for multi-core. Event loop: never block with sync I/O or heavy computation.
- Graceful shutdown: listen for SIGTERM/SIGINT, stop accepting connections, drain existing requests, close DB pools, then exit.
Pitfalls: memory leaks from event listeners (setMaxListeners). Buffer handling — don't trust content length. Prototype pollution via object merge.
Performance: connection pooling for DB/HTTP. Use AbortController for request cancellation. Cache with LRU. JSON.parse in try-catch.
Safety: helmet for HTTP headers. Rate limiting. Input validation (zod/joi). No eval/Function constructor. Keep dependencies updated.`,
});

register({
  name: "Python",
  category: "web-backend",
  aliases: ["py", "python", "python3"],
  standards: `Core rules:
- Type hints on all function signatures (params + return type). Use from __future__ import annotations for forward refs. mypy strict mode.
- f-strings for formatting. pathlib.Path over os.path. enum for fixed choice sets. dataclasses or Pydantic for structured data.
- Context managers (with statement) for resource management: files, connections, locks. Create custom ones with @contextmanager.
- Async/await with asyncio for I/O-bound operations. Use asyncio.gather for parallel I/O. aiohttp/httpx for async HTTP.
- Exception handling: catch specific exceptions. Never bare except. Use raise ... from ... for exception chaining.
Pitfalls: mutable default arguments (def f(x=[])). Late binding closures in loops. Global state makes testing hard. Import cycles.
Performance: list comprehensions over map/filter. Generator expressions for large sequences. Use slots in classes for memory. C extensions or numpy for computation.
Safety: never eval() user input. Use parameterized queries. Sanitize file paths. bandit for security linting. secrets module for random tokens.`,
});

register({
  name: "Go",
  category: "web-backend",
  aliases: ["go", "golang"],
  standards: `Core rules:
- Handle every error explicitly. if err != nil { return ..., err }. Never use _ for errors unless documented why. Wrap errors with fmt.Errorf("context: %w", err).
- defer for cleanup (close files, unlock mutexes, rollback transactions). Defers run LIFO. Don't defer in loops — accumulates.
- Goroutine safety: channels for communication, sync.Mutex for shared state. Prefer channels. Use sync.WaitGroup for goroutine coordination. Always handle goroutine lifecycle.
- Interfaces: small (1-3 methods). Accept interfaces, return structs. Interface compliance: var _ Interface = (*Struct)(nil).
- context.Context: pass as first parameter. Use for cancellation, timeouts, and request-scoped values. Check ctx.Err() in long operations.
Pitfalls: goroutine leaks — always ensure goroutines can exit. Nil pointer dereference. Slice append gotcha (may or may not copy). Race detector: go test -race.
Performance: sync.Pool for frequent allocations. strings.Builder for concatenation. Benchmark with testing.B. Profile with pprof.
Safety: input validation at boundaries. Use crypto/rand not math/rand for security. Constant-time comparison for secrets.`,
});

register({
  name: "Java",
  category: "web-backend",
  aliases: ["java"],
  standards: `Core rules:
- Records for data carriers (immutable by design). Sealed interfaces/classes for sum types. Pattern matching in switch (Java 21+).
- Optional<T> for return types that may be absent. Never pass null as argument. Never call .get() without .isPresent() — use .orElse/.map/.ifPresent.
- Try-with-resources for all AutoCloseable. Specific catch blocks. Multi-catch (catch (A | B e)) for shared handling.
- var for local variables when RHS makes type obvious. Streams API for collection transformations. Collectors for terminal operations.
- Virtual threads (Java 21+) for I/O-bound concurrency. CompletableFuture for async composition. Structured concurrency for task scoping.
Pitfalls: equals/hashCode contract — override both or neither. Immutability: defensive copies of mutable fields. ConcurrentModificationException from iterating+modifying.
Performance: StringBuilder for loops. Parallel streams only for CPU-bound work on large collections. JMH for benchmarks. Avoid autoboxing in hot paths.
Safety: input validation with Bean Validation. Prepared statements for SQL. No reflection on untrusted input. Secure deserialization.`,
});

register({
  name: "Kotlin",
  category: "web-backend",
  aliases: ["kt", "kotlin", "kts"],
  standards: `Core rules:
- data class for value types (auto equals/hashCode/copy/toString). sealed class/interface for exhaustive when expressions.
- Null safety: nullable types (T?) are explicit. Use ?. (safe call), ?: (elvis), let for null checks. Avoid !! (force unwrap) — use requireNotNull with message.
- Coroutines with suspend functions. Use structured concurrency (CoroutineScope). Flow for reactive streams. Never use GlobalScope in production.
- Extension functions for adding behavior without inheritance. Scope functions: let for null check + transform, apply for builder pattern, use for AutoCloseable.
- Kotlin-specific: prefer val over var. when is exhaustive for sealed types. Destructuring declarations. Delegation with by keyword.
Pitfalls: data class with mutable properties defeats purpose. Coroutine cancellation — check isActive or use ensureActive(). Kotlin/JVM interop: @JvmStatic, @JvmField.
Performance: inline functions for lambdas in hot paths. Sequence for lazy collection processing. value class for zero-overhead wrappers.
Safety: use Kotlin's type system to prevent invalid states. require/check for preconditions. @Throws for Java interop.`,
});

register({
  name: "C#",
  category: "web-backend",
  aliases: ["cs", "csharp", "c#", "dotnet"],
  standards: `Core rules:
- Nullable reference types enabled (#nullable enable). Annotate all APIs with nullability. Fix all nullable warnings.
- Records for immutable data types. record struct for value semantics. Init-only setters (init) for controlled initialization.
- Pattern matching: switch expressions, is pattern, relational/logical patterns. Use discard (_) for don't-care cases.
- async/await for all I/O operations. Use ValueTask for hot paths that often complete synchronously. CancellationToken propagation.
- LINQ for collection queries. Use method syntax for complex queries. Avoid LINQ in hot loops (allocation overhead). Span<T>/Memory<T> for zero-copy slicing.
Pitfalls: async void only for event handlers. Dispose pattern for unmanaged resources. ConfigureAwait(false) in library code.
Performance: ArrayPool/MemoryPool for buffer reuse. struct for small, frequently-allocated types. Benchmark with BenchmarkDotNet.
Safety: validate model binding. Parameterized queries via EF Core or Dapper. Use IDataProtector for encryption. Anti-forgery tokens for forms.`,
});

register({
  name: "Ruby",
  category: "web-backend",
  aliases: ["rb", "ruby"],
  standards: `Core rules:
- frozen_string_literal: true at file top for immutable strings (performance + safety). Use dup/+'' when mutation needed.
- Keyword arguments for optional params with defaults. Use **options sparingly. Blocks/procs/lambdas: blocks for iteration, procs for stored callbacks, lambdas for strict arity.
- Modules over deep inheritance hierarchies. Include for instance methods, extend for class methods. Composition with Forwardable.
- RBS type signatures (.rbs files) or Sorbet annotations for type checking. steep check in CI. Document public API types.
- Convention: snake_case methods/variables, CamelCase classes, SCREAMING_SNAKE for constants. Predicate methods end with ?. Bang methods (!) for mutation.
Pitfalls: nil is an object (NoMethodError, not NullPointerException). Hash default value shared reference trap. Monkey-patching breaks encapsulation.
Performance: freeze constant strings. Use each over map when discarding result. Symbol vs String for identifiers. Benchmark with benchmark-ips.
Safety: Brakeman for Rails security scanning. Parameterize SQL. Strong parameters in Rails. CSRF protection enabled by default.`,
});

register({
  name: "PHP",
  category: "web-backend",
  aliases: ["php"],
  standards: `Core rules:
- declare(strict_types=1) at file top. Type declarations on all function params and returns. Union types (string|int) for flexibility.
- Named arguments for readability: fn(timeout: 30, retries: 3). Enums (PHP 8.1+) for fixed choice sets. Match expression over switch for value returns.
- Readonly properties (readonly) and readonly classes for immutability. Constructor property promotion for concise DTOs.
- Fibers for cooperative concurrency. Use for async I/O frameworks (Swoole, ReactPHP, Amp).
- Null safety: ?-> (nullsafe operator), ?? (null coalesce), Nullable types (?Type). Never return mixed without documentation.
Pitfalls: loose comparison (==) quirks — use === always. Array key existence: array_key_exists vs isset (null values). Memory leaks in long-running processes.
Performance: OPcache enabled with preloading. JIT for CPU-bound tasks (PHP 8.0+). Avoid autoloading in hot paths.
Safety: prepared statements (PDO::prepare). htmlspecialchars for output. CSRF tokens. password_hash/password_verify for passwords. Never trust $_GET/$_POST directly.`,
});

register({
  name: "Elixir",
  category: "web-backend",
  aliases: ["ex", "exs", "elixir"],
  standards: `Core rules:
- Pattern matching everywhere: function heads, case, with. Multi-clause functions ordered specific → general. Guards for type checks.
- Pipe operator (|>) for data transformation chains. Left-to-right reading. First argument is piped value.
- GenServer for stateful processes. Supervision trees for fault tolerance (one_for_one, rest_for_one). Let it crash — supervisors restart.
- Protocols for polymorphism (like interfaces). Behaviours for contracts. Use @impl true for clarity.
- ExUnit for testing. describe/test structure. Use setup for shared context. async: true for concurrent tests. Doctests for examples.
Pitfalls: large binaries in process mailbox cause GC issues. Don't store state in module attributes at runtime. Avoid GenServer bottleneck (single mailbox).
Performance: binary pattern matching for parsing. ETS for shared read-heavy state. Stream for lazy enumeration. NIF for CPU-bound (with care).
Safety: Phoenix CSRF protection. Parameterized queries with Ecto. Input validation with Ecto changesets. Secrets in runtime config, not compile time.`,
});

register({
  name: "Scala",
  category: "web-backend",
  aliases: ["scala", "sc"],
  standards: `Core rules:
- Case classes for immutable data (auto equals/hashCode/copy/unapply). Sealed traits for algebraic data types with exhaustive pattern matching.
- For-comprehensions for monadic composition (Option, Future, Either, IO). Use yield for generating values.
- Scala 3: given/using over implicit. Extension methods over implicit classes. Opaque types for zero-cost wrappers. Union/intersection types.
- Cats Effect / ZIO for functional effect systems. IO monad for side effects. Resource for safe acquisition/release. Fiber for structured concurrency.
- Pattern matching: match expressions with guards. Extractors (unapply) for custom patterns. Variable patterns with backticks for constants.
Pitfalls: Future is eager (starts immediately) — use IO/Task for lazy evaluation. Avoid Any/Nothing leaking into APIs. Implicit resolution can be opaque — use given/using.
Performance: use LazyList (not Stream which is deprecated). Tail recursion with @tailrec. Avoid boxing with @specialized or opaque types.
Safety: type-level guarantees reduce runtime errors. Use refined types for validated data. Never catch Throwable (catches fatal errors).`,
});

// ═══════════════════════════════════════════════════════════════
// 7. MOBILE
// ═══════════════════════════════════════════════════════════════

register({
  name: "Swift",
  category: "mobile",
  aliases: ["swift"],
  standards: `Core rules:
- Value types: prefer struct over class. Classes only for identity, inheritance, or reference semantics. Use enum for fixed state sets.
- Protocol-oriented programming: define behavior with protocols. Use protocol extensions for default implementations. Prefer composition over inheritance.
- Concurrency: async/await for asynchronous code. Actors for shared mutable state. Sendable protocol for thread-safe types. Task groups for structured concurrency.
- SwiftUI: State, Binding, ObservedObject, EnvironmentObject for data flow. View structs are lightweight — recreated frequently. Use @ViewBuilder for composition.
- Optionals: guard let for early exit. if let for conditional binding. Never force-unwrap (!) outside tests. Use nil coalescing (??) for defaults.
Pitfalls: retain cycles with closures — use [weak self] or [unowned self]. SwiftUI body recomputation — keep it pure. MainActor for UI updates.
Performance: avoid AnyView (erases type info, prevents diff optimization). Lazy stacks (LazyVStack/LazyHStack) for long lists. Profile with Instruments.
Safety: App Transport Security for HTTPS. Keychain for sensitive data. Use CryptoKit for cryptographic operations.`,
});

register({
  name: "Kotlin Android",
  category: "mobile",
  aliases: ["kotlin-android", "android", "jetpack-compose"],
  standards: `Core rules:
- Jetpack Compose: composable functions with @Composable. State hoisting (state up, events down). remember + mutableStateOf for local state.
- ViewModel + StateFlow for UI state. Collect with collectAsStateWithLifecycle(). Single source of truth for state.
- Hilt for dependency injection: @HiltViewModel, @Inject constructor. Modules with @Provides/@Binds. Scoping: @Singleton, @ViewModelScoped.
- Coroutines: viewModelScope for ViewModel operations. lifecycleScope for Activity/Fragment. Dispatchers.IO for I/O, Main for UI.
- Room DAO: @Entity, @Dao, @Query. Flow return type for reactive queries. Suspend functions for writes. Migration strategy defined.
Pitfalls: recomposition performance — avoid lambdas creating new instances. derivedStateOf for expensive computations. key() in LazyColumn for stable items.
Performance: baseline profiles for startup. R8/ProGuard for release builds. Avoid unnecessary recomposition (stable types, immutable data).
Safety: ProGuard rules for reflection-based libraries. Encrypted SharedPreferences for sensitive data. Certificate pinning for network.`,
});

register({
  name: "Dart",
  category: "mobile",
  aliases: ["dart", "flutter"],
  standards: `Core rules:
- final for variables set once, const for compile-time constants. Use late for lazy initialization. Null safety: T? for nullable, ! only when proven safe.
- Async: Future for single values, Stream for sequences. async* for generator functions. Use await for sequential, Future.wait for parallel.
- State management: Riverpod for production apps (typed, testable, tree-shakable). Bloc for event-driven architectures. Provider as simple alternative.
- Widget composition: small, focused widgets. Prefer StatelessWidget. Extract sub-widgets for reuse and performance. Use const constructors.
- Platform channels for native code: MethodChannel for calls, EventChannel for streams. Use Pigeon for type-safe platform communication.
Pitfalls: setState causes full widget rebuild — use state management for complex state. Avoid deep widget nesting — extract widgets. BuildContext usage after async gaps.
Performance: const constructors prevent unnecessary rebuilds. RepaintBoundary for isolated repaints. ListView.builder for long lists (lazy).
Safety: secure storage (flutter_secure_storage). Certificate pinning. Obfuscate release builds (--obfuscate). Don't hardcode API keys.`,
});

register({
  name: "React Native",
  category: "mobile",
  aliases: ["react-native", "rn"],
  standards: `Core rules:
- FlatList for lists (not ScrollView — ScrollView renders all items). Use keyExtractor, getItemLayout for performance. SectionList for grouped data.
- Native modules: use TurboModules (new architecture) for native bridge. Fabric for custom native views. Codegen for type-safe native interfaces.
- Hermes engine: enabled by default. Supports bytecode precompilation. JSON.parse is optimized — use for large data. No eval() support.
- Reanimated for animations: worklets run on UI thread. useSharedValue for animated values. useAnimatedStyle for style interpolation.
- Gesture handling: react-native-gesture-handler for performant gestures. Gesture.Pan/Tap/LongPress composable. GestureDetector wrapping.
Pitfalls: bridge serialization overhead — minimize cross-bridge calls. Don't pass complex objects. Inline requires for startup performance.
Performance: use memo/useCallback for list items. InteractionManager for post-animation work. Avoid large images without caching (FastImage).
Safety: secure storage for tokens (react-native-keychain). Certificate pinning. No sensitive data in AsyncStorage (unencrypted).`,
});

// ═══════════════════════════════════════════════════════════════
// 8. DATA & ML
// ═══════════════════════════════════════════════════════════════

register({
  name: "Python ML",
  category: "data-ml",
  aliases: ["python-ml", "ml", "pytorch", "tensorflow", "numpy", "pandas"],
  standards: `Core rules:
- NumPy vectorization: no Python loops over arrays. Use broadcasting, fancy indexing, einsum for batch operations. Shape comments on complex ops.
- Pandas method chaining: df.pipe().assign().query().groupby(). No iterrows() — use vectorized operations or apply() as last resort.
- scikit-learn pipeline: Pipeline/ColumnTransformer for reproducible preprocessing. Train/test split before any preprocessing. Cross-validation for evaluation.
- PyTorch: torch.no_grad() for inference. Gradient checkpointing for large models. Mixed precision (torch.cuda.amp) for training speed.
- Reproducibility: set seeds (random, numpy, torch, CUDA). Pin dependency versions. Log hyperparameters. Version control data with DVC.
Pitfalls: data leakage (fitting on test data). SettingWithCopyWarning in Pandas — use .loc[]. GPU memory leaks from detached tensors. NaN propagation.
Performance: GPU-CPU transfer is expensive — batch operations on GPU. Use DataLoader with num_workers>0. Prefetch data.
Safety: validate input data shape and type before model. Sanitize user-provided model paths. Don't pickle untrusted data.`,
});

register({
  name: "R",
  category: "data-ml",
  aliases: ["r", "rlang"],
  standards: `Core rules:
- Tidyverse: use tibbles over data.frames. Pipe operator (|> or %>%) for readable chains. dplyr verbs: mutate, filter, select, summarize, group_by.
- ggplot2 layers: aes() for mapping, geom_ for geometry, scale_ for axes, theme_ for styling. Facets for multi-panel plots.
- purrr::map family for iteration: map for list, map_dbl for double, map_dfr for row-binding. Avoid for loops for data operations.
- Reproducible reports: R Markdown (.Rmd) or Quarto (.qmd). Set seeds (set.seed). Use renv for dependency management.
- Functions: explicit return() or last expression. Use roxygen2 for documentation (@param, @return, @examples).
Pitfalls: R is 1-indexed. Factor vs character confusion. Recycling rule silently extends short vectors. Partial matching in $ operator.
Performance: vectorize operations. data.table for large datasets. Avoid growing vectors in loops (preallocate). Use Rcpp for C++ hot paths.
Safety: don't source() untrusted R scripts. Validate file paths. Use parameterized queries for DB access. Sanitize Shiny inputs.`,
});

register({
  name: "SQL",
  category: "data-ml",
  aliases: ["sql", "postgresql", "postgres", "mysql", "sqlite", "mssql"],
  standards: `Core rules:
- PARAMETERIZED QUERIES ALWAYS. Never concatenate user input into SQL strings. Use $1/$2 (Postgres), ? (MySQL), @param (MSSQL), or ORM parameterization.
- CTEs (WITH) over nested subqueries for readability and reuse. Window functions (ROW_NUMBER, RANK, LAG, LEAD) over self-joins for analytics.
- Proper indexing: columns in WHERE, JOIN ON, ORDER BY. Composite indexes: leftmost prefix rule. Don't over-index (write overhead). EXPLAIN ANALYZE to verify.
- Transaction isolation: READ COMMITTED default. Use SERIALIZABLE for critical consistency. Keep transactions short. Handle deadlocks with retry logic.
- SELECT only needed columns (not *). Use EXISTS over IN for correlated subqueries. COALESCE for null handling.
Pitfalls: implicit type conversions break index usage. NULL in comparisons (use IS NULL/IS NOT NULL). ORDER BY without LIMIT on large tables. N+1 query problem.
Performance: batch inserts over single-row. Use COPY (Postgres) for bulk loading. Materialized views for expensive aggregations. Partial indexes for filtered queries.
Safety: least privilege (GRANT specific permissions). Row-level security for multi-tenant. Audit logging for sensitive tables. Encrypted connections (SSL).`,
});

register({
  name: "Julia",
  category: "data-ml",
  aliases: ["jl", "julia"],
  standards: `Core rules:
- Type stability: functions should return consistent types. Use @code_warntype to check. Avoid containers with abstract element types (Vector{Any}).
- Multiple dispatch: define methods for specific type combinations. Use abstract types for hierarchy. Parametric types for generic containers.
- Broadcasting with dot syntax: f.(x) applies elementwise. Use @. macro for fusing multiple broadcasts. Avoids temporary allocations.
- Avoid global variables in performance-critical code (type instability). Use const for global constants. Pass data as function arguments.
- Package development: use Pkg.develop for local packages. Precompilation with __init__() for setup. SnoopPrecompile for reducing load time.
Pitfalls: 1-indexed arrays. First-call latency (compilation). Column-major storage (iterate columns first). String indexing is byte-based (use eachindex).
Performance: preallocate output arrays. Use @inbounds in inner loops (after correctness verification). StaticArrays for small fixed-size arrays.
Safety: input validation at public API boundaries. Don't eval untrusted strings. Use Sandbox.jl for untrusted code execution.`,
});

// ═══════════════════════════════════════════════════════════════
// 9. DEVOPS & INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════

register({
  name: "Bash",
  category: "devops",
  aliases: ["sh", "bash", "shell", "zsh"],
  standards: `Core rules:
- set -euo pipefail at script top. -e exits on error, -u on undefined variable, -o pipefail catches pipe failures.
- ShellCheck compliance: run shellcheck on all scripts. Fix all warnings. SC2086 (quote variables) is critical.
- Quote all variable expansions: "$var", "$@", "$(command)". Unquoted variables cause word splitting and globbing bugs.
- trap for cleanup: trap cleanup EXIT. Clean up temp files, kill background processes, restore state.
- Functions over inline scripts. Local variables with local keyword. Return values via stdout (capture with $()) or return code.
Pitfalls: [ vs [[ — use [[ for bash (pattern matching, no word splitting). Don't parse ls output — use globs. No spaces around = in assignment.
Performance: avoid subshells in loops ($(command) forks). Use bash builtins over external commands. Process substitution (<()) over temp files.
Safety: never use eval with user input. Validate all external inputs. Use mktemp for temp files. Set restrictive umask (077) for sensitive files.`,
});

register({
  name: "PowerShell",
  category: "devops",
  aliases: ["ps1", "powershell", "pwsh"],
  standards: `Core rules:
- Approved verbs: Get-, Set-, New-, Remove-, Invoke-, etc. Use Get-Verb to list. Follow Verb-Noun naming for cmdlets.
- Pipeline: pipe objects (not text). Use Where-Object, ForEach-Object, Select-Object for filtering/transformation. Pipeline input via process block.
- Error handling: try/catch/finally for terminating errors. Use -ErrorAction Stop to make non-terminating errors catchable. $ErrorActionPreference = 'Stop' in scripts.
- PSScriptAnalyzer: run for lint checking. Fix all warnings. Use [CmdletBinding()] for advanced function features (Verbose, Debug, WhatIf).
- Parameter validation: [ValidateNotNullOrEmpty()], [ValidateSet()], [ValidateRange()]. Use mandatory parameters with [Parameter(Mandatory)].
Pitfalls: single-element arrays unwrap automatically (use @()). Comparison operators are case-insensitive by default (-ceq for case-sensitive). Pipeline unrolls arrays.
Performance: avoid Write-Host for output (use Write-Output). StringBuilder for string concatenation. Filter left, format right. Avoid Where-Object on large collections — use .Where() method.
Safety: execution policy doesn't prevent malicious scripts. Use -Credential for remote operations. SecureString for passwords. Sign scripts in production.`,
});

register({
  name: "Dockerfile",
  category: "devops",
  aliases: ["dockerfile", "docker", "containerfile"],
  standards: `Core rules:
- Multi-stage builds: separate build and runtime stages. Copy only artifacts to final stage. Minimize final image size.
- .dockerignore: exclude .git, node_modules, build artifacts, secrets. Keep context small for fast builds.
- Non-root user: RUN adduser/useradd + USER directive. Never run production containers as root.
- COPY over ADD (ADD has implicit tar extraction and URL fetch — unexpected behavior). Use --chown with COPY.
- Layer caching: order from least to most frequently changing. Dependencies before source code. Use --mount=type=cache for package managers.
Pitfalls: each RUN creates a layer — chain with && and \ for related commands. Don't store secrets in layers (use BuildKit secrets). Pin base image versions.
Performance: use slim/alpine base images. Health checks with HEALTHCHECK. Minimize layers. Use BuildKit parallel builds.
Safety: scan images with trivy/grype. No secrets in ENV or ARG. Use read-only filesystem (--read-only). Drop capabilities (--cap-drop ALL).`,
});

register({
  name: "Terraform",
  category: "devops",
  aliases: ["tf", "terraform", "hcl", "opentofu"],
  standards: `Core rules:
- Modules for reusable infrastructure. Keep modules focused (one resource group per module). Use versioned module sources.
- State management: remote backend (S3+DynamoDB, GCS, Azure Blob). State locking enabled. Never edit state manually. Use terraform state mv for refactoring.
- Variables: validation blocks for constraints. Use type constraints. sensitive = true for secrets. Default values where sensible.
- Lifecycle blocks: prevent_destroy for critical resources. create_before_destroy for zero-downtime. ignore_changes for externally managed attributes.
- Data sources over hardcoding: data.aws_ami, data.aws_vpc for dynamic references. Locals for computed values.
Pitfalls: terraform plan doesn't catch all issues (IAM, quotas). Circular dependencies. Provider version constraints required. State drift detection.
Performance: targeted applies (-target) for large stacks. Parallelism tuning (-parallelism). Module composition over monolithic configs.
Safety: checkov/tfsec for security scanning. No secrets in .tf files (use vault or environment variables). Least privilege IAM. Enable access logging.`,
});

register({
  name: "Kubernetes",
  category: "devops",
  aliases: ["k8s", "kubernetes", "kubectl", "helm"],
  standards: `Core rules:
- Resource limits: always set requests and limits for CPU/memory. Requests for scheduling, limits for enforcement. Use LimitRange for defaults.
- Health probes: livenessProbe (restart on failure), readinessProbe (remove from service), startupProbe (slow-starting apps). Configure appropriate intervals and thresholds.
- Security context: runAsNonRoot: true, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false. Drop all capabilities, add only needed.
- Pod disruption budgets: minAvailable or maxUnavailable for high availability during rolling updates/node drains.
- Labels/selectors: consistent labeling (app, version, environment, team). Use label selectors for service routing and policy targeting.
Pitfalls: don't use :latest tag (non-deterministic). imagePullPolicy: Always wastes bandwidth. Resource limits too tight cause OOMKill. Graceful shutdown with preStop hook.
Performance: horizontal pod autoscaler (HPA) with custom metrics. Topology spread constraints for even distribution. Resource right-sizing with VPA recommendations.
Safety: NetworkPolicy for pod-to-pod isolation. RBAC with least privilege. Pod Security Standards (restricted). Secrets encrypted at rest. No hostPath volumes in production.`,
});

register({
  name: "Ansible",
  category: "devops",
  aliases: ["ansible", "ansible-playbook"],
  standards: `Core rules:
- Idempotency: all tasks must be safe to run multiple times. Use state: present/absent, not shell commands. Check mode (--check) support.
- Handlers for service restarts: notify on change, handlers run once at end. Use listen for multiple triggers.
- Roles for reusable automation: defaults/vars/tasks/handlers/templates/files structure. Galaxy for sharing. Requirements.yml for dependencies.
- Vault for secrets: ansible-vault encrypt_string for inline. Vault files for bulk secrets. Never commit plaintext secrets.
- Molecule for testing: create/converge/verify/destroy cycle. Use testinfra or goss for verification. CI/CD integration.
Pitfalls: YAML gotchas (yes/no as booleans, colon in strings). Variable precedence is complex (extra vars > role vars > inventory). Jinja2 whitespace control.
Performance: use async for long-running tasks. Forks for parallel execution. Fact caching for repeated runs. Mitogen strategy for speed.
Safety: become: yes only when needed. Limit playbook scope with --limit. No shell/command modules for tasks that have dedicated modules. Audit changes with --diff.`,
});

register({
  name: "Nix",
  category: "devops",
  aliases: ["nix", "nixos", "nixpkgs"],
  standards: `Core rules:
- Pure functions: every derivation is a function of its inputs. No side effects. Fixed-output derivations for network access only.
- Flakes for reproducibility: flake.nix with inputs/outputs. Lock file (flake.lock) pins all dependencies. Use nix develop for dev shells.
- Overlays for package modifications: final: prev: pattern. Use overlays for patching, version bumps, or adding packages. Composable and ordered.
- nixpkgs patterns: mkDerivation for packages. buildInputs vs nativeBuildInputs (cross-compilation). Phases: unpackPhase, buildPhase, installPhase.
- Development shells: use devShells in flake.nix. Include all build dependencies. Use direnv with use flake for auto-activation.
Pitfalls: infinite recursion from circular overlays. String interpolation evaluates eagerly. Large closures waste disk space — use nix-store --gc.
Performance: binary caches (cachix) for pre-built packages. Minimize closure size with removeReferencesTo. Use nix-diff to compare derivations.
Safety: sandboxed builds by default (no network, restricted filesystem). Verify hashes for fetchurl. NixOS: declarative system configuration, atomic upgrades and rollbacks.`,
});

// ═══════════════════════════════════════════════════════════════
// 10. SCRIPTING & AUTOMATION
// ═══════════════════════════════════════════════════════════════

register({
  name: "Lua",
  category: "scripting",
  aliases: ["lua", "luajit"],
  standards: `Core rules:
- Always use local: local x = 1. Global variables pollute the environment and are slower. Use module pattern for encapsulation.
- Metatables for OOP: __index for inheritance, __newindex for proxy, __tostring for display. Keep metatable chains shallow.
- Coroutines for cooperative multitasking: coroutine.create/resume/yield. Use for generators, state machines, async patterns.
- Tables are the single data structure: arrays (1-indexed), dictionaries, objects. Use # operator for array length (caveat: holes).
- LuaJIT FFI for C interop: ffi.cdef for declarations, ffi.new for allocation. Zero-overhead C function calls.
Pitfalls: table length with holes is undefined. nil in tables creates holes. 1-based indexing. String comparison is by value, table comparison by reference.
Performance: LuaJIT: avoid NYI (not-yet-implemented) operations in traces. Localize frequently used functions (local insert = table.insert). Avoid table creation in hot loops.
Safety: sandbox untrusted scripts by removing dangerous functions (os, io, loadfile). Use setfenv/debug.setfenv (Lua 5.1) or _ENV (5.2+) for sandboxing.`,
});

register({
  name: "Perl",
  category: "scripting",
  aliases: ["pl", "perl", "pm"],
  standards: `Core rules:
- use strict; use warnings; at top of every file. Use Modern::Perl or feature bundles for modern syntax. use utf8 for Unicode source.
- References for complex data: \\@array, \\%hash, \\&sub. Dereference with ->. Use data structures (AoH, HoA) for structured data.
- Regex mastery: named captures (?<name>), /x for readable patterns, qr// for compiled regex. Non-greedy (.*?) by default thinking.
- OOP: use Moose/Moo for modern OO. has for attributes, with for roles. Type constraints. BUILD/BUILDARGS for initialization.
- CPAN module structure: use Dist::Zilla or ExtUtils::MakeMaker. Tests in t/. POD documentation. Semantic versioning.
Pitfalls: list vs scalar context changes behavior. Implicit $_ can be confusing. Autovivification creates structure unexpectedly. Regex greediness.
Performance: avoid regex compilation in loops (use qr//). Benchmark with Benchmark or Dumbbench. Use XS for hot inner loops.
Safety: taint mode (-T) for CGI/input handling. Validate all user input. Use DBI with placeholders for SQL. No eval on untrusted input.`,
});

register({
  name: "AWK",
  category: "scripting",
  aliases: ["awk", "gawk", "mawk"],
  standards: `Core rules:
- Pattern-action paradigm: /pattern/ { action }. Each line is processed automatically. Use BEGIN for initialization, END for summary.
- Field separator: -F for command-line, FS variable in BEGIN block. OFS for output field separator. Split with split(string, array, separator).
- Associative arrays: array[key] = value. Use (key in array) to test existence. delete array[key]. for (key in array) for iteration (unordered).
- Built-in variables: NR (record number), NF (number of fields), $0 (whole line), $1-$NF (fields). FILENAME, FNR (file record number).
- Printf for formatted output: printf "%s\\t%d\\n", $1, $2. Use sprintf for string formatting.
Pitfalls: uninitialized variables are "" or 0 (not errors). String vs number comparison depends on context. Regex with / / not " ". Field assignment rebuilds $0.
Performance: avoid external commands (system/getline pipe) in tight loops. Pre-compile regex with match(). Mawk is fastest for simple tasks.
Safety: don't process untrusted input without field validation. Escape shell metacharacters in system() calls. Use getline carefully (can return -1 on error).`,
});

register({
  name: "Makefile",
  category: "scripting",
  aliases: ["makefile", "make", "gnumake"],
  standards: `Core rules:
- .PHONY targets for non-file targets: .PHONY: all clean test build. Prevents conflicts with same-named files.
- Automatic variables: $@ (target), $< (first prerequisite), $^ (all prerequisites), $* (stem in pattern rules). Use consistently.
- Pattern rules: %.o: %.c for generic build rules. Static pattern rules for specific subsets. Use $< for the source file.
- Order-only prerequisites (| delimiter): directories that must exist but don't trigger rebuild. target: normal | order-only.
- Variable assignment: := (immediate), = (recursive), ?= (conditional), += (append). Use := for computed values to avoid re-evaluation.
Pitfalls: recipes use shell (not make) syntax. Each line is a separate shell — use \\ for multi-line or .ONESHELL. Tabs required (not spaces) for recipes.
Performance: parallel builds with -j N. Proper dependency tracking (auto-generate with -MMD -MP). Avoid recursive make (use include instead).
Safety: validate inputs in recipes. Use $(shell) sparingly. Set SHELL := /bin/bash explicitly if using bash features. Don't ignore errors (prefix with - only when intentional).`,
});

// ═══════════════════════════════════════════════════════════════
// 11. FUNCTIONAL LANGUAGES
// ═══════════════════════════════════════════════════════════════

register({
  name: "Haskell",
  category: "functional",
  aliases: ["hs", "haskell"],
  standards: `Core rules:
- Pure functions by default. IO monad for side effects — isolate at program edges. Use do-notation for monadic composition.
- Type classes: define behavior contracts. Derive common instances (Show, Eq, Ord, Read). Newtypes for type-safe wrappers with zero runtime cost.
- Maybe for optional values (Just/Nothing), Either for error handling (Left error/Right value). Never use error/undefined in library code.
- Lazy evaluation: be aware of thunk accumulation. Use seq/BangPatterns/StrictData for performance-critical data. -Wall -Werror in CI.
- Pattern matching: exhaustive matches (-Wincomplete-patterns). Use guards for complex conditions. As-patterns (x@(Cons _ _)) for binding and destructuring.
Pitfalls: space leaks from laziness (unevaluated thunks). String is [Char] (slow) — use Text or ByteString. Orphan instances break coherence.
Performance: Text over String. Vector over List for random access. Strict fields in data types (!) for known-evaluated data. Profile with +RTS -s.
Safety: use Safe Haskell for untrusted code. Type-level programming for static guarantees. QuickCheck for property-based testing.`,
});

register({
  name: "OCaml",
  category: "functional",
  aliases: ["ml", "ocaml"],
  standards: `Core rules:
- Pattern matching: exhaustive match/with. Compiler warns on incomplete patterns — never disable. Use _ for wildcard, as for binding.
- Modules/functors: module signatures (.mli) define interfaces. Functors for parameterized modules. First-class modules for runtime abstraction.
- Immutable by default: use ref only when necessary. List/Map for persistent data structures. Array/Hashtbl for mutable when performance requires.
- GADTs for type-safe DSLs and embedded languages. Polymorphic variants for extensible types. Type annotations for clarity at module boundaries.
- Dune build system: dune-project for project config. Libraries with (library) stanza. Inline tests with ppx_inline_test.
Pitfalls: value restriction for polymorphic mutable values. Structural vs nominal typing for objects vs records. Tail recursion — use @tail_mod_cons or List.rev.
Performance: flambda optimization pass (-O2). Use Bigarray for numerical work. Avoid excessive allocation in inner loops. Benchmark with core_bench.
Safety: type system prevents most runtime errors. Use Result.t for recoverable errors. Alcotest for testing. OCaml 5: effects for structured concurrency.`,
});

register({
  name: "F#",
  category: "functional",
  aliases: ["fs", "fsharp", "f#"],
  standards: `Core rules:
- Computation expressions: async { }, task { }, seq { }, result { } for monadic workflows. Custom builders for domain-specific control flow.
- Active patterns: (|Pattern|_|) for reusable pattern matching. Partial active patterns for parsing/validation. Parameterized active patterns.
- Type providers: compile-time types from external schemas (JSON, SQL, CSV). Use for strongly-typed data access without code generation.
- Discriminated unions for algebraic data types: type Shape = Circle of float | Rectangle of float * float. Exhaustive matching enforced.
- Pipe operator (|>) for left-to-right data flow. Function composition (>>) for point-free style. Partial application for factory functions.
Pitfalls: indentation-based scoping — whitespace sensitive. Equality is structural for records/unions, referential for classes. Mutable variables need <- not =.
Performance: struct records/unions for stack allocation. Span<T> for zero-allocation slicing. Tail calls with rec keyword. Inline for generic numerical code.
Safety: Fable for F#-to-JavaScript compilation. Use Result<'T,'E> over exceptions. Expecto for testing. Type-safe API with Giraffe/Saturn.`,
});

register({
  name: "Clojure",
  category: "functional",
  aliases: ["clj", "cljs", "clojure", "clojurescript"],
  standards: `Core rules:
- Immutable data by default: maps {}, vectors [], sets #{}, lists (). Persistent data structures (structural sharing). Use assoc/update/dissoc for transformation.
- Protocols for polymorphism: defprotocol + extend-protocol/extend-type. Like interfaces but extensible to existing types. Multimethods for flexible dispatch.
- Transducers for composable transformations: (comp (map f) (filter g)) — no intermediate collections. Use with transduce, into, sequence.
- Spec for data validation: s/def, s/fdef for function specs. s/valid? for checking. Generative testing with spec + test.check.
- REPL-driven development: evaluate forms interactively. Rich comments (comment ...) for development snippets. Develop bottom-up, compose upward.
Pitfalls: lazy sequences hold head in memory (don't bind to local). Nil punning (nil is falsey, empty collection is truthy). Reflection warnings indicate performance issue.
Performance: type hints for Java interop (^String x). Transients for local mutation in builders. Avoid reflection — use (set! *warn-on-reflection* true).
Safety: don't eval user input. Use clojure.edn/read-string (not read-string) for untrusted data. Component/Integrant for system lifecycle management.`,
});

// ═══════════════════════════════════════════════════════════════
// 12. GAME DEVELOPMENT
// ═══════════════════════════════════════════════════════════════

register({
  name: "GDScript",
  category: "game",
  aliases: ["gd", "gdscript", "godot"],
  standards: `Core rules:
- Signals for decoupled communication: signal my_signal(arg). Connect via code (connect) or editor. Custom signals over direct references.
- Node references: @onready var for deferred access. Use $ or get_node for children. Never hardcode paths to distant nodes — use groups or signals.
- Lifecycle: _ready() for initialization, _process(delta) for per-frame logic, _physics_process(delta) for physics. _enter_tree/_exit_tree for scene management.
- @export vars for inspector-exposed properties. Use @export_range, @export_enum for constrained values. Resource types for shared data.
- Scene composition: one script per scene root. Child scenes for reusable components. PackedScene for dynamic instantiation.
Pitfalls: _process runs every frame — avoid heavy computation. Use is_instance_valid before accessing freed nodes. Signal connections leak if not disconnected.
Performance: use Object pooling for frequent instantiation. Visibility notifiers for off-screen culling. GDExtension (C++) for hot paths.
Safety: validate deserialized save data. Don't trust client-side game state in multiplayer. Sanitize player names/chat input.`,
});

register({
  name: "Unity C#",
  category: "game",
  aliases: ["unity", "unity-csharp", "unity-c#"],
  standards: `Core rules:
- MonoBehaviour lifecycle: Awake → OnEnable → Start → Update/FixedUpdate → LateUpdate → OnDisable → OnDestroy. Never use constructors.
- Coroutines for time-based sequences: yield return new WaitForSeconds(). Use StopCoroutine for cleanup. Consider async/await with UniTask.
- ScriptableObjects for shared data assets: configuration, events, variables. Reduce scene dependencies. Reusable across scenes.
- Object pooling: reuse frequently spawned objects (bullets, particles, enemies). Deactivate instead of Destroy. Pool managers with Queue<T>.
- [SerializeField] for private fields in inspector. Never public fields without reason. Use [Header], [Tooltip], [Range] for editor UX.
Pitfalls: GetComponent is expensive — cache in Awake. String-based APIs (SendMessage, Find) are slow and fragile. Don't allocate in Update (GC spikes).
Performance: FixedUpdate rate for physics (not frame-dependent). Jobs + Burst compiler for CPU-intensive work. LOD groups for rendering.
Safety: validate user-generated content. Server-authoritative for multiplayer. Don't trust PlayerPrefs for security. Obfuscate builds for anti-cheat.`,
});

register({
  name: "GLSL",
  category: "game",
  aliases: ["glsl", "hlsl", "shader", "shading"],
  standards: `Core rules:
- Precision qualifiers: highp for position/depth, mediump for color/UV, lowp for simple masks. Mobile requires explicit precision (GLES).
- Uniforms for per-draw data, varying/in-out for vertex→fragment interpolation, attributes/in for per-vertex data. Minimize varying count.
- Avoid dynamic branching in fragment shaders (all threads in a warp diverge). Use step/mix/smoothstep for branchless selection.
- Texture sampling: minimize dependent texture reads. Pack data into fewer textures (channel packing). Use mipmaps to prevent aliasing.
- Compute shaders: shared memory for intra-workgroup data. memoryBarrierShared + barrier() for synchronization. Dispatch size = data size / workgroup size.
Pitfalls: integer division truncates. normalize(vec3(0)) is undefined. Floating point precision issues at large world coordinates. Driver bugs vary across vendors.
Performance: minimize texture fetches and register usage. Use half precision where quality allows (HLSL: half, GLSL: mediump). Batch draw calls.
Safety: validate shader compilation (glGetShaderiv GL_COMPILE_STATUS). Handle driver crashes gracefully. Test on minimum-spec hardware.`,
});

register({
  name: "Unreal C++",
  category: "game",
  aliases: ["unreal", "ue5", "ue4", "unreal-cpp"],
  standards: `Core rules:
- UPROPERTY() macro for all UObject member variables: enables GC tracking, serialization, replication, Blueprint exposure. Categories with Category="Name".
- UFUNCTION() for Blueprint-callable/overridable functions. BlueprintCallable, BlueprintPure, BlueprintImplementableEvent. Server/Client for RPC.
- Garbage collection: UObject pointers are tracked. Use UPROPERTY or TWeakObjectPtr for non-owning refs. TSharedPtr for non-UObject shared ownership.
- FString for mutable strings, FName for identifiers (case-insensitive, hashed), FText for localized display text. Use FString::Printf for formatting.
- Delegates: DECLARE_DYNAMIC_MULTICAST_DELEGATE for Blueprint-bindable events. Regular delegates for C++ only. Lambda binding with BindLambda.
Pitfalls: UPROPERTY(Transient) for non-serialized fields. Hard references cause memory bloat — use soft references (TSoftObjectPtr). Tick functions are expensive — disable when unused.
Performance: object pooling with SpawnActor/DestroyActor avoidance. Level streaming for open worlds. Nanite for geometry, Lumen for lighting (UE5).
Safety: validate replicated data server-side. Anti-cheat integration. Limit Blueprint execution authority. Encrypt pak files for asset protection.`,
});

// ═══════════════════════════════════════════════════════════════
// 13. BLOCKCHAIN & SMART CONTRACTS
// ═══════════════════════════════════════════════════════════════

register({
  name: "Solidity",
  category: "blockchain",
  aliases: ["sol", "solidity"],
  standards: `Core rules:
- Checks-Effects-Interactions pattern: validate inputs (require/revert), update state, then external calls. Prevents reentrancy. Use ReentrancyGuard as defense-in-depth.
- Gas optimization: pack storage variables (uint128+uint128 in one slot). Use calldata over memory for readonly params. Minimize storage writes (SSTORE is 20k gas).
- Custom errors over string reverts: error InsufficientBalance(uint256 available, uint256 required). Saves ~50 bytes per error site.
- Access control: OpenZeppelin Ownable/AccessControl. Role-based permissions. Timelocks for admin functions. onlyOwner/onlyRole modifiers.
- Events for off-chain indexing: emit Event for every state change. Indexed parameters (up to 3) for filtering. Log topic optimization.
Pitfalls: integer overflow (use Solidity 0.8+ built-in checks or SafeMath). Don't use tx.origin for auth (phishing). Delegatecall storage collision. Front-running.
Performance: batch operations over loops. Mapping over array for lookups. Immutable/constant for gas-free reads. Assembly (Yul) for micro-optimization.
Safety: audit before mainnet. Test with Foundry/Hardhat (fork testing). Formal verification for critical contracts. Upgradeable proxy pattern with storage gaps.`,
});

register({
  name: "Solana Rust",
  category: "blockchain",
  aliases: ["solana", "solana-rust", "anchor"],
  standards: `Core rules:
- Account validation: verify account owner, signer, writable status. Check discriminators. Use Anchor constraints: #[account(mut, has_one = authority)].
- PDA derivation: Pubkey::find_program_address with deterministic seeds. Store bump for re-derivation. Use canonical bumps. Seeds must be unique per PDA purpose.
- CPI safety: Cross-Program Invocations with explicit signer seeds for PDAs. Verify target program ID. Propagate errors with into() conversion.
- Rent exemption: accounts must hold minimum rent-exempt balance. Use SystemProgram::create_account with proper space calculation. Close accounts to reclaim rent.
- Anchor framework: #[program] for entrypoints, #[derive(Accounts)] for account contexts. #[account(init, payer, space)] for account creation.
Pitfalls: arithmetic overflow (use checked_add/mul). Account reallocation needs realloc instruction. Signer checks missing = anyone can call. Close account properly (zero data + lamports transfer).
Performance: minimize account lookups. Batch instructions in single transaction. Use zero-copy for large accounts. Compute budget with set_compute_unit_limit.
Safety: verify all account constraints. No unchecked arithmetic. Audit with Soteria/sec3. Timelock for admin instructions. Emergency pause mechanism.`,
});

register({
  name: "Move",
  category: "blockchain",
  aliases: ["move", "aptos", "sui"],
  standards: `Core rules:
- Resource types: struct with key/store abilities. Resources can't be copied or dropped — must be explicitly moved or destroyed. Enforces asset safety.
- Abilities: key (storable in global storage), store (nested in other structs), copy (copyable), drop (droppable). Minimal abilities principle.
- Acquires annotation: functions accessing global storage must declare acquires T. Compiler enforces — prevents dangling reference issues.
- Module friends: friend keyword for controlled inter-module access. public(friend) for restricted visibility. Module is the unit of encapsulation.
- Phantom types: phantom type parameters for type-level tags without runtime cost. Useful for Coin<CoinType> patterns.
Pitfalls: global storage ops (borrow_global, move_from) can abort on missing resources — check exists() first. Move's linear type system is strict — plan ownership flow.
Performance: minimize global storage reads/writes. Use vector for batch operations. Inline functions for small utilities.
Safety: formal verification with Move Prover (spec blocks). Integer overflow checked by default. Resource safety guaranteed by type system. Access control via signer parameter.`,
});

// ═══════════════════════════════════════════════════════════════
// 14. EMERGING & SPECIALIZED
// ═══════════════════════════════════════════════════════════════

register({
  name: "WebAssembly",
  category: "emerging",
  aliases: ["wasm", "wat", "webassembly"],
  standards: `Core rules:
- Linear memory: single contiguous byte array. Grow with memory.grow (page = 64KB). Bounds-checked access. Shared memory for threads (SharedArrayBuffer).
- Stack machine model: instructions consume/produce stack values. Type-safe — stack types verified at validation time. No undefined behavior.
- Import/export: import functions, memory, tables, globals from host. Export module functions for host to call. Use function indices for indirect calls.
- WASI for system interface: file I/O, sockets, clocks. Capability-based security. Preview 2 with component model.
- Component model: interfaces defined in WIT (WebAssembly Interface Type). Composable modules with type-safe boundaries.
Pitfalls: no GC (manage memory manually or use GC languages targeting wasm). No direct DOM access (call through JS). Integer-only (no native strings).
Performance: SIMD instructions for vectorized computation. Memory alignment for performance. Streaming compilation for fast startup. Use wasm-opt for optimization.
Safety: sandboxed execution by design. Validate all imported function arguments. Memory bounds checked by runtime. No raw pointer access to host memory.`,
});

register({
  name: "CUDA",
  category: "emerging",
  aliases: ["cu", "cuda"],
  standards: `Core rules:
- Grid/block/thread hierarchy: grid of blocks, block of threads. dim3 for dimensions. Thread ID: threadIdx.x + blockIdx.x * blockDim.x. Size blocks as multiples of warp (32).
- Shared memory (__shared__): per-block fast memory for inter-thread communication. Use for tiling, reduction, prefix sum. __syncthreads() for barrier synchronization.
- Coalesced memory access: adjacent threads access adjacent global memory addresses. Stride-1 pattern. Avoid bank conflicts in shared memory (padding).
- Synchronization: __syncthreads() within block. Atomics for inter-block (atomicAdd, atomicCAS). Cooperative groups for flexible sync patterns.
- Occupancy: balance threads/block, shared memory, registers for maximum SM utilization. Use CUDA occupancy calculator. Launch bounds with __launch_bounds__.
Pitfalls: race conditions without sync. Warp divergence (if/else) serializes threads. Host-device transfer is bottleneck — minimize and overlap with computation.
Performance: use streams for async execution + overlap. Pinned memory for fast H2D/D2H transfer. Tensor cores for matrix operations. Unified memory for convenience.
Safety: check all CUDA API calls (cudaGetLastError). Handle device OOM. Validate kernel launch parameters. nsight-compute for profiling.`,
});

register({
  name: "OpenCL",
  category: "emerging",
  aliases: ["cl", "opencl"],
  standards: `Core rules:
- Work-items (threads) organized in work-groups (blocks). NDRange defines global/local work sizes. Global ID: get_global_id(dim).
- Local memory (__local): per-work-group fast memory. Use barrier(CLK_LOCAL_MEM_FENCE) for synchronization. Explicit allocation in kernel arguments or inline.
- Kernel optimization: vectorize with vector types (float4, int8). Coalesced global memory access. Minimize branching divergence.
- Platform portability: query device capabilities (CL_DEVICE_MAX_WORK_GROUP_SIZE). Use cl_khr extensions conditionally. Test on multiple vendors (NVIDIA, AMD, Intel).
- Memory model: global, local, constant, private address spaces. Explicit transfers (clEnqueueReadBuffer/WriteBuffer). Map for zero-copy when available.
Pitfalls: work-group size must divide global size evenly (or use remainder handling). Different precision on different devices. Compiler optimization varies by vendor.
Performance: use image objects for 2D data (hardware-accelerated access). Persistent kernels for reducing launch overhead. Sub-buffers for partitioned data.
Safety: check all cl_ API return codes. Release all cl objects (clRelease*). Validate kernel arguments. Handle device disconnection gracefully.`,
});

register({
  name: "Mojo",
  category: "emerging",
  aliases: ["mojo", "modular"],
  standards: `Core rules:
- Python superset: full Python compatibility plus systems-level performance. Use def for Python-compatible functions, fn for strict Mojo functions.
- SIMD types: SIMD[DType.float32, 8] for vectorized operations. Hardware-width agnostic. Use @parameter for compile-time SIMD width selection.
- Ownership model: borrowed (immutable reference), inout (mutable reference), owned (transfer ownership). Similar to Rust but gradual adoption.
- struct vs @value decorator: struct for C-like performance types. @value auto-generates __init__, __copyinit__, __moveinit__. Use for value semantics.
- Compile-time metaprogramming: alias for compile-time constants. @parameter decorator for compile-time function variants. Parametric types for generic code.
Pitfalls: not all Python libraries available in compiled mode. Mojo structs are not Python classes (no inheritance). Memory management differs from Python GC.
Performance: autotune for automatic parameter optimization. Parallelize with parallelize(). Tiling for cache-friendly access patterns. Benchmark with benchmark module.
Safety: bounds checking enabled by default. Use DTypePointer safely. Validate external data at boundaries. Mojo's type system catches many errors at compile time.`,
});

// ═══════════════════════════════════════════════════════════════
// GENERAL STANDARDS (language-agnostic)
// ═══════════════════════════════════════════════════════════════

const GENERAL_STANDARDS = `- DRY: Don't repeat yourself, but don't abstract prematurely either.
- YAGNI: Don't build what you don't need yet.
- Meaningful names: variables describe what they hold, functions describe what they do.
- Small functions: each function does one thing. If it needs a comment to explain, it's too complex.
- Early returns: reduce nesting by handling edge cases first.
- Fail fast: validate inputs at boundaries, trust data internally.
- Separation of concerns: I/O at the edges, pure logic in the core.`;

// ═══════════════════════════════════════════════════════════════
// FILE EXTENSION → LANGUAGE MAPPING
// ═══════════════════════════════════════════════════════════════

const EXT_MAP: Record<string, string> = {
  // Systems
  c: "c", h: "c",
  cpp: "c++", hpp: "c++", cc: "c++", cxx: "c++", hxx: "c++",
  rs: "rust",
  asm: "assembly", s: "assembly",
  zig: "zig",
  // HDL
  vhd: "vhdl", vhdl: "vhdl",
  v: "verilog", sv: "verilog",
  // Web frontend
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  vue: "vue", svelte: "svelte",
  html: "html/css", css: "html/css", scss: "html/css", sass: "html/css", less: "html/css",
  // Web backend
  py: "python", pyi: "python",
  go: "go",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  cs: "c#", csx: "c#",
  rb: "ruby", rake: "ruby",
  php: "php",
  ex: "elixir", exs: "elixir",
  scala: "scala", sc: "scala",
  // Mobile
  swift: "swift",
  dart: "dart",
  // Data & ML
  r: "r", rmd: "r",
  sql: "sql",
  jl: "julia",
  // DevOps
  sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  tf: "terraform", tfvars: "terraform",
  nix: "nix",
  // Scripting
  lua: "lua",
  pl: "perl", pm: "perl",
  awk: "awk",
  // Functional
  hs: "haskell", lhs: "haskell",
  ml: "ocaml", mli: "ocaml",
  fs: "f#", fsi: "f#", fsx: "f#",
  clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure",
  // Game
  gd: "gdscript",
  glsl: "glsl", hlsl: "glsl", frag: "glsl", vert: "glsl", comp: "glsl",
  // Blockchain
  sol: "solidity",
  move: "move",
  // Emerging
  wat: "webassembly", wast: "webassembly",
  cu: "cuda", cuh: "cuda",
  cl: "opencl",
  mojo: "mojo",
};

// Also handle special filenames
const FILENAME_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  "docker-compose.yml": "kubernetes",
  "docker-compose.yaml": "kubernetes",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "makefile",
  jenkinsfile: "bash",
  vagrantfile: "ruby",
};

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Get coding standards for a language.
 * Accepts language name or alias (case-insensitive).
 */
export function getCodingStandards(language: string): string | null {
  const std = STANDARDS.get(language.toLowerCase().trim());
  return std?.standards ?? null;
}

/**
 * Get all supported language names (unique, sorted).
 * Backward-compatible alias for getAllLanguages.
 */
export function getSupportedLanguages(): string[] {
  return getAllLanguages();
}

/**
 * Get all unique language names (sorted).
 */
export function getAllLanguages(): string[] {
  const seen = new Set<string>();
  for (const std of STANDARDS.values()) {
    seen.add(std.name);
  }
  return [...seen].sort();
}

/**
 * Get languages by category.
 */
export function getLanguagesByCategory(category: LanguageCategory): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const std of STANDARDS.values()) {
    if (std.category === category && !seen.has(std.name)) {
      result.push(std.name);
      seen.add(std.name);
    }
  }
  return result.sort();
}

/**
 * Check if coding standards exist for a given language.
 */
export function hasStandards(language: string): boolean {
  return STANDARDS.has(language.toLowerCase().trim());
}

/**
 * Get the general coding principles that apply to all languages.
 * Appended when no language-specific standards are available.
 */
export function getGeneralStandards(): string {
  return GENERAL_STANDARDS;
}

/**
 * Detect language from file path (extension or filename).
 * Returns the canonical language key usable with getCodingStandards().
 */
export function detectLanguage(filePath: string): string | null {
  // Check special filenames first
  const filename = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (FILENAME_MAP[filename]) {
    return FILENAME_MAP[filename];
  }

  // Check extension
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;

  return EXT_MAP[ext] ?? null;
}
