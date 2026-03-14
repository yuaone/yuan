## Identity
- domain: cuda
- type: language
- confidence: 0.90

# CUDA — Error Pattern Reference

Read the exact CUDA error code and the line from `cudaGetLastError()` or the assertion. CUDA errors are asynchronous — the error may surface on a different CUDA call than the one that caused it.

## Error Code Quick Reference
- **cudaErrorIllegalAddress (700)** — Out-of-bounds memory access inside a kernel.
- **cudaErrorLaunchFailure (4)** — Kernel launch configuration invalid or device exception.
- **cudaErrorInvalidValue (1)** — Null pointer or invalid argument passed to CUDA API.
- **cudaErrorMemoryAllocation (2)** — cudaMalloc failed; GPU out of memory.
- **cudaErrorNoKernelImageForDevice (209)** — Kernel compiled for different GPU architecture.
- **cudaErrorSynchronizationError** — cudaDeviceSynchronize() found a pending kernel error.
- **cudaErrorInvalidDeviceFunction** — Kernel function pointer is invalid or not compiled for device.
- **CUDA_ERROR_NOT_INITIALIZED** — cuInit() not called before cu* API calls (Driver API).

## Known Error Patterns

### CUDA_ERROR_ILLEGAL_ADDRESS — Out-of-Bounds Memory Access
- **Symptom**: `cudaErrorIllegalAddress` on `cudaDeviceSynchronize()` or `cudaMemcpy`; Nsight Compute shows "Memory access fault". The error appears after the actual faulty kernel launch.
- **Cause**: A thread accesses device memory outside allocated bounds. Common causes: wrong index calculation (`blockIdx.x * blockDim.x + threadIdx.x` exceeds array size), pointer arithmetic error, or accessing freed device memory.
- **Strategy**: 1. Add bounds checks inside the kernel: `if (idx >= N) return;` at the kernel entry. 2. Use CUDA Compute Sanitizer: `compute-sanitizer --tool memcheck ./my_program` — it pinpoints the exact line and thread. 3. Verify index calculation: `size_t idx = blockIdx.x * blockDim.x + threadIdx.x;` — ensure total threads >= N but kernel guards against idx >= N. 4. Check that `cudaMalloc` allocated sufficient bytes: `N * sizeof(float)` not just `N`. 5. After launch, always call `cudaDeviceSynchronize()` and check its return value during debugging.
- **Tool sequence**: file_read (kernel code) → file_edit (add bounds check `if (idx >= N) return`) → shell_exec (`compute-sanitizer ./program`)
- **Pitfall**: Do NOT disable bounds checking in production without proving the launch configuration always generates valid indices — off-by-one in grid size causes silent data corruption.

### Race Condition — Missing __syncthreads()
- **Symptom**: Non-deterministic results; kernel produces correct output on small inputs but fails on large ones; different runs of the same program give different answers.
- **Cause**: Threads in the same block share shared memory but execute independently. Without `__syncthreads()`, some threads may read shared memory values written by other threads that have not completed their write yet.
- **Strategy**: 1. Identify every pattern where threads write to shared memory and other threads subsequently read from it. 2. Place `__syncthreads()` between the write phase and the read phase. 3. Ensure `__syncthreads()` is called by ALL threads in the block — placing it inside a conditional (`if (threadIdx.x < N) __syncthreads()`) causes a deadlock if some threads skip it. 4. For reduction operations, use warp-level primitives (`__shfl_down_sync`) for the last 32 threads instead of `__syncthreads()`.
- **Tool sequence**: grep (`__shared__`) → file_read (kernel) → file_edit (add __syncthreads() between write and read phases)
- **Pitfall**: Do NOT put `__syncthreads()` inside a branch that only some threads take — all threads in the block must reach the barrier or the program deadlocks.

### GPU Memory Leak — cudaMalloc Not Freed
- **Symptom**: GPU memory usage grows with each iteration; eventually `cudaMalloc` returns `cudaErrorMemoryAllocation`; `nvidia-smi` shows GPU memory at 100%.
- **Cause**: Device memory allocated with `cudaMalloc` is not freed with `cudaFree` when no longer needed. Unlike CPU memory, CUDA does not have automatic garbage collection — every `cudaMalloc` needs a matching `cudaFree`.
- **Strategy**: 1. Grep all `cudaMalloc` calls and verify each has a corresponding `cudaFree` in all exit paths (including error paths). 2. Use RAII wrappers: Thrust `thrust::device_vector` auto-frees on destruction, or write a simple CUDA RAII class. 3. Use Compute Sanitizer memcheck: `compute-sanitizer --leak-check full ./program` to detect unreleased memory. 4. In error handling, ensure `cudaFree` is called before returning even on error paths.
- **Tool sequence**: grep (`cudaMalloc`) → file_read → file_edit (add cudaFree in all exit paths or convert to RAII wrapper)
- **Pitfall**: Do NOT call `cudaFree(nullptr)` expecting it to be a no-op in all contexts — while CUDA spec says it is safe, some older driver versions behave differently. Explicitly track which pointers need freeing.

### Kernel Launch Failure — Block/Grid Size Mismatch
- **Symptom**: `cudaErrorLaunchFailure` or `cudaErrorInvalidValue` immediately after kernel invocation; sometimes silent failure with zero output.
- **Cause**: Invalid launch configuration: `blockDim.x` exceeds device maximum (usually 1024), `gridDim.x` exceeds `INT_MAX` for 1D grids, total registers per block exceeded, or shared memory requested exceeds device limit (typically 48KB or 96KB).
- **Strategy**: 1. Query device limits: `cudaDeviceGetAttribute(&maxThreadsPerBlock, cudaDevAttrMaxThreadsPerBlock, device)`. 2. Print the launch configuration before the `<<<>>>` call to verify dimensions. 3. For large N, calculate grid: `int gridSize = (N + blockSize - 1) / blockSize;` where `blockSize <= 1024`. 4. Check shared memory: `size_t sharedMem = blockSize * sizeof(float); if (sharedMem > 49152) { /* reduce blockSize */ }`. 5. Use `cudaOccupancyMaxPotentialBlockSize()` to auto-tune block size for maximum occupancy.
- **Tool sequence**: file_read (kernel launch) → file_edit (add device property query + bounds check on blockSize/gridSize)
- **Pitfall**: Do NOT hardcode `blockSize = 1024` — older or embedded GPU devices may have lower limits. Always query and validate against device properties.

### Device/Host Memory Confusion — Dereferencing Device Pointer on CPU
- **Symptom**: Segfault or access violation in CPU code; `cudaMemcpy` direction is wrong; kernel receives a host pointer and crashes with illegal address.
- **Cause**: Device pointers (from `cudaMalloc`) cannot be dereferenced on the host. Host pointers (from `malloc` or stack) cannot be passed directly to kernels as array pointers. Passing a host pointer where a device pointer is expected causes `CUDA_ERROR_ILLEGAL_ADDRESS`.
- **Strategy**: 1. Use a clear naming convention: `d_` prefix for device pointers (`d_input`, `d_output`), `h_` prefix for host pointers. 2. Before any kernel call, verify all array arguments are device pointers obtained from `cudaMalloc`. 3. For data transfer: host→device is `cudaMemcpy(d_ptr, h_ptr, size, cudaMemcpyHostToDevice)`; device→host is the reverse. 4. Use Unified Memory (`cudaMallocManaged`) during debugging to eliminate explicit transfers and isolate logic errors.
- **Tool sequence**: grep (`cudaMalloc`, `cudaMemcpy`) → file_read → file_edit (add d_/h_ naming convention + verify memcpy directions)
- **Pitfall**: Do NOT use `cudaMallocManaged` in performance-critical production code — unified memory adds overhead from page migration. Use it only for prototyping or debugging.

### Missing Error Check — Silent CUDA Failure
- **Symptom**: Program runs without crashing but produces incorrect results; errors go undetected because CUDA API calls are not checked.
- **Cause**: CUDA API functions return `cudaError_t` — if not checked, errors are silently ignored. Kernel launches return void — errors only surface on the next synchronization point.
- **Strategy**: 1. Wrap all CUDA calls with a macro: `#define CUDA_CHECK(call) { cudaError_t err = (call); if (err != cudaSuccess) { fprintf(stderr, "CUDA error %s at %s:%d\n", cudaGetErrorString(err), __FILE__, __LINE__); exit(1); } }`. 2. After every kernel launch, add `CUDA_CHECK(cudaGetLastError()); CUDA_CHECK(cudaDeviceSynchronize());` during development. 3. Remove synchronize calls in production (they serialize execution) but keep `cudaGetLastError()` checks.
- **Tool sequence**: grep (`cudaMalloc`, `cudaMemcpy`, kernel launches) → file_edit (wrap all calls with CUDA_CHECK macro)
- **Pitfall**: Do NOT only check `cudaDeviceSynchronize()` at the end of a large function — by then, you have lost information about which specific operation failed.

## Verification
Run: `compute-sanitizer --tool memcheck ./your_program`
- No memory errors, no out-of-bounds accesses = clean run.
- Profile with Nsight Systems: `nsys profile ./your_program` — check for unintended synchronizations and memory transfer bottlenecks.
- `nvidia-smi` should show GPU memory returning to baseline after program exit.

## Validation Checklist
- [ ] All kernels have bounds check: `if (idx >= N) return;`
- [ ] `__syncthreads()` placed between shared memory writes and reads
- [ ] `__syncthreads()` never inside a conditional branch
- [ ] Every `cudaMalloc` has a corresponding `cudaFree` in all code paths
- [ ] All CUDA API calls wrapped with error checking macro
- [ ] `cudaDeviceSynchronize()` + `cudaGetLastError()` called after kernels during debugging
- [ ] Device pointers use `d_` prefix, host pointers use `h_` prefix
- [ ] Launch configuration validated against `cudaDevAttrMaxThreadsPerBlock`
- [ ] `compute-sanitizer --tool memcheck` passes with no errors
- [ ] Shared memory usage per block verified to be within device limit
