## Identity
- domain: docker
- type: language
- confidence: 0.90

# Docker — Error Pattern Reference

Read the exact build error output and layer number first. Docker errors are often caused by layer ordering, missing context files, or base image issues — not the instruction itself.

## Error Code Quick Reference
- **"no such file or directory"** — COPY/ADD source path doesn't exist in build context.
- **"failed to solve: failed to read dockerfile"** — Dockerfile not found at specified path.
- **"exec format error"** — Binary built for wrong architecture (arm vs amd64).
- **"permission denied"** — File permission issue inside container, often USER switch.
- **"layer does not exist"** — Corrupted local image cache; `docker system prune` needed.
- **"Dockerfile parse error"** — Syntax error in instruction (e.g., missing space after FROM).
- **"unknown instruction"** — Typo in Dockerfile instruction keyword.

## Known Error Patterns

### Image Layer Bloat — RUN apt-get Without Cleanup
- **Symptom**: Final image size is hundreds of MB larger than expected; `docker history <image>` shows a single large layer.
- **Cause**: `RUN apt-get update && apt-get install -y <pkg>` creates a layer that includes the package index and cached `.deb` files. If `apt-get clean && rm -rf /var/lib/apt/lists/*` is in a separate `RUN` instruction, the bloat layer is already committed and cannot be removed.
- **Strategy**: 1. Run `docker history <image> --no-trunc` to find the bloated layer. 2. Merge all apt operations into a single `RUN` instruction ending with `&& apt-get clean && rm -rf /var/lib/apt/lists/*`. 3. Check if a smaller base image is appropriate (`alpine` vs `ubuntu`). 4. Use multi-stage builds to copy only the final artifact, leaving build tools behind.
- **Tool sequence**: shell_exec (`docker history`) → file_read (Dockerfile) → file_edit (merge RUN commands + cleanup)
- **Pitfall**: Do NOT put cleanup in a separate `RUN` layer — Docker layers are immutable, and a cleanup layer only adds overhead without reducing size.

### Non-Root User Missing — Security Risk
- **Symptom**: Container process runs as UID 0 (root); security scanners flag the image; Kubernetes PSP/PSA rejects it.
- **Cause**: No `USER` instruction in the Dockerfile. Default user is root, which means a compromised process inside the container has root privileges on the host filesystem if volumes are mounted.
- **Strategy**: 1. Grep the Dockerfile for `USER` instruction. 2. Before the final CMD/ENTRYPOINT, add: `RUN groupadd -r appuser && useradd -r -g appuser appuser` then `USER appuser`. 3. Ensure all application files are readable by this user (`COPY --chown=appuser:appuser . .`). 4. If the app needs specific capabilities (e.g., binding to port <1024), use `setcap` rather than running as root.
- **Tool sequence**: grep (`USER`) → file_read (Dockerfile) → file_edit (add user creation and USER instruction)
- **Pitfall**: Do NOT set `USER 0` to fix permission errors — that defeats the purpose. Fix the file permissions or use `--chown` in COPY instead.

### COPY vs ADD Confusion — Unexpected Behavior
- **Symptom**: Tar archives are auto-extracted when they should be copied as-is; remote URLs fail or succeed unexpectedly.
- **Cause**: `ADD` has two special behaviors that `COPY` does not: (1) it auto-extracts local tar archives, (2) it accepts URLs. Using `ADD` for regular files is confusing and considered bad practice by Docker best practices.
- **Strategy**: 1. Grep all `ADD` instructions in the Dockerfile. 2. Replace `ADD <local-file> <dest>` with `COPY <local-file> <dest>` unless tar auto-extraction is explicitly needed. 3. For remote URL downloads, use `RUN curl -o <dest> <url>` instead of `ADD <url>` — gives more control over the download (checksums, error handling). 4. Only use `ADD` when intentionally extracting a local tar archive.
- **Tool sequence**: grep (`^ADD `) → file_read (Dockerfile) → file_edit (replace ADD with COPY or RUN curl)
- **Pitfall**: Do NOT use `ADD` for everything just because it seems more powerful — the implicit auto-extraction is a common source of bugs when archive filenames change.

### Build Context Too Large — .dockerignore Missing
- **Symptom**: `docker build` is slow to start; "Sending build context to Docker daemon" reports gigabytes; `node_modules` or `.git` is sent to the daemon.
- **Cause**: Docker sends the entire build context directory to the daemon before processing the Dockerfile. Without a `.dockerignore` file, `node_modules`, `.git`, `dist`, large data files, and secrets are all included.
- **Strategy**: 1. Check if `.dockerignore` exists in the build context directory. 2. Create or update `.dockerignore` to exclude: `node_modules`, `.git`, `*.log`, `dist`, `.env*`, `__pycache__`, `.pytest_cache`, coverage reports, and any large binary assets. 3. Verify: run `docker build` again and check the "Sending build context" line — it should be kilobytes or a few megabytes. 4. Never COPY secrets (`.env`, credentials) into an image — use Docker secrets or build args.
- **Tool sequence**: shell_exec (`ls .dockerignore`) → file_edit (create/update .dockerignore) → shell_exec (docker build, check context size)
- **Pitfall**: Do NOT add `.dockerignore` entries after `COPY . .` instructions — the ignore happens at context-sending time, not at COPY time. Both must be correct.

### Health Check Missing — Orchestrator Cannot Detect Unhealthy Containers
- **Symptom**: Container shows as `Up` but application is not responding; Kubernetes/ECS marks pods healthy when they are not; rolling deployments shift traffic to broken instances.
- **Cause**: No `HEALTHCHECK` instruction in the Dockerfile. Without it, Docker only checks if the process is running (PID exists), not if the application is actually serving requests.
- **Strategy**: 1. Grep the Dockerfile for `HEALTHCHECK`. 2. Add a health check appropriate for the service type: HTTP services: `HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD curl -f http://localhost:8080/health || exit 1`. TCP services: `CMD nc -z localhost 8080`. Custom scripts: `CMD ["/app/healthcheck.sh"]`. 3. Ensure the health endpoint is lightweight and does not trigger side effects. 4. Test: `docker inspect --format='{{.State.Health}}' <container>`.
- **Tool sequence**: grep (`HEALTHCHECK`) → file_read (Dockerfile) → file_edit (add HEALTHCHECK instruction)
- **Pitfall**: Do NOT use a health check that exercises a database query unless the app genuinely requires DB connectivity at startup — this causes false unhealthy states during DB maintenance.

### Layer Cache Invalidation — Dependency Install Repeated
- **Symptom**: `npm install` or `pip install` runs every build even when dependencies haven't changed; builds take minutes instead of seconds.
- **Cause**: `COPY . .` before `RUN npm install` copies all source files first. Any source change invalidates the cache at that layer, causing npm install to re-run. Docker cache works top-to-bottom — each instruction invalidates all subsequent layers.
- **Strategy**: 1. Read the Dockerfile and identify where dependency manifests are copied vs. source files. 2. Restructure: copy ONLY the dependency manifests first (`COPY package.json package-lock.json ./`), run the install, THEN copy source (`COPY . .`). 3. This way the install layer is only invalidated when manifests change, not on every source edit.
- **Tool sequence**: file_read (Dockerfile) → file_edit (reorder COPY and RUN install instructions)
- **Pitfall**: Do NOT copy `package.json` and `package-lock.json` in the same instruction as all other files — split the COPY into two instructions.

## Verification
Run: `docker build -t test-image . && docker run --rm test-image`
- Successful build and run = baseline passing.
- Check image size: `docker images test-image` — compare against expected baseline.
- Run Hadolint: `hadolint Dockerfile` — no warnings at DL3 level or above.
- Inspect layers: `docker history test-image --no-trunc`

## Validation Checklist
- [ ] `.dockerignore` exists and excludes `node_modules`, `.git`, `.env*`, large binaries
- [ ] All `RUN apt-get install` instructions include `&& apt-get clean && rm -rf /var/lib/apt/lists/*`
- [ ] Non-root `USER` instruction present before CMD/ENTRYPOINT
- [ ] `COPY` used instead of `ADD` for local files that are not tar archives
- [ ] `HEALTHCHECK` instruction present with appropriate interval and timeout
- [ ] Dependency manifests copied before source files (layer cache optimization)
- [ ] Multi-stage build used if build tools should not be in the final image
- [ ] No secrets or `.env` files copied into the image
- [ ] Base image pinned to a specific digest or version tag, not `latest`
- [ ] Hadolint passes with no high-severity warnings
