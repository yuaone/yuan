/**
 * @module language-registry
 * @description Single source of truth for all language/framework metadata.
 * Add a language here once — detection, verification guides, and skill loading
 * all derive from this registry automatically.
 */

export type LanguageGroup =
  | "systems"     // C, C++, Rust, Go, Zig, Assembly
  | "web"         // TypeScript, JavaScript, React, Vue, Svelte, Angular, Next.js, HTML/CSS
  | "backend"     // Python, Java, Kotlin, Ruby, PHP, C#, Scala, Elixir, Groovy
  | "mobile"      // Swift, Kotlin Android, Dart/Flutter, React Native, Objective-C
  | "data"        // Python ML, R, Julia, SQL, MATLAB
  | "devops"      // Bash, PowerShell, Dockerfile, Terraform, Kubernetes, Ansible, Nix
  | "game"        // GDScript, Unity C#, GLSL, Unreal C++
  | "hdl"         // Verilog, SystemVerilog, VHDL, Chisel, SpinalHDL
  | "blockchain"  // Solidity, Solana Rust, Move
  | "emerging"    // WebAssembly, CUDA, OpenCL, Mojo
  | "scripting"   // Lua, Perl, AWK, Makefile, Tcl
  | "functional"; // Haskell, OCaml, F#, Clojure

export interface LanguageRegistryEntry {
  /** Canonical ID — matches coding-standards key, used for skill file names */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** File extensions (with leading dot) */
  extensions: string[];
  /** Project manifest/config files for project-level detection */
  manifestFiles?: string[];
  /** Primary build command */
  buildCmd?: string;
  /** Primary test command */
  testCmd?: string;
  /** Lint command */
  lintCmd?: string;
  /** Type-check / static analysis command (distinct from build) */
  typeCheckCmd?: string;
  /** String that appears in stdout/stderr on success */
  successSignal?: string;
  /** String prefix/pattern that indicates an error line */
  errorSignal?: string;
  /** Common error codes or patterns to watch for */
  commonErrors?: string[];
  /** Category group */
  group: LanguageGroup;
  /** Path to bundled skill file (relative to skills/) — undefined if not yet created */
  skillFile?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

export const LANGUAGE_REGISTRY: LanguageRegistryEntry[] = [

  // ═══════════════════════════════════════════════════════════════
  // SYSTEMS
  // ═══════════════════════════════════════════════════════════════

  {
    id: "c",
    displayName: "C",
    extensions: [".c", ".h"],
    buildCmd: "gcc -Wall -Wextra -Werror -o out main.c",
    testCmd: "make test",
    lintCmd: "cppcheck --enable=all .",
    errorSignal: "error:",
    commonErrors: ["undefined reference", "implicit declaration", "segmentation fault"],
    group: "systems",
    skillFile: "languages/c.md",
  },

  {
    id: "cpp",
    displayName: "C++",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    buildCmd: "cmake --build build",
    testCmd: "ctest --test-dir build",
    lintCmd: "clang-tidy src/**/*.cpp",
    typeCheckCmd: "g++ -fsyntax-only -Wall -Wextra src/**/*.cpp",
    errorSignal: "error:",
    commonErrors: ["no matching function", "use of deleted function", "undefined reference"],
    group: "systems",
    skillFile: "languages/cpp.md",
  },

  {
    id: "rust",
    displayName: "Rust",
    extensions: [".rs"],
    manifestFiles: ["Cargo.toml"],
    buildCmd: "cargo build",
    testCmd: "cargo test",
    lintCmd: "cargo clippy -- -D warnings",
    typeCheckCmd: "cargo check",
    successSignal: "Finished",
    errorSignal: "error[",
    commonErrors: ["cannot borrow", "lifetime", "mismatched types", "cannot move"],
    group: "systems",
    skillFile: "languages/rust.md",
  },

  {
    id: "go",
    displayName: "Go",
    extensions: [".go"],
    manifestFiles: ["go.mod"],
    buildCmd: "go build ./...",
    testCmd: "go test ./...",
    lintCmd: "golangci-lint run",
    typeCheckCmd: "go vet ./...",
    successSignal: "ok",
    errorSignal: "# ",
    commonErrors: ["undefined:", "cannot use", "declared but not used", "import cycle"],
    group: "systems",
    skillFile: "languages/go.md",
  },

  {
    id: "zig",
    displayName: "Zig",
    extensions: [".zig"],
    manifestFiles: ["build.zig"],
    buildCmd: "zig build",
    testCmd: "zig build test",
    errorSignal: "error:",
    commonErrors: ["expected type", "cannot assign to constant", "undeclared identifier"],
    group: "systems",
  },

  {
    id: "assembly",
    displayName: "Assembly",
    extensions: [".asm", ".s"],
    group: "systems",
  },

  // ═══════════════════════════════════════════════════════════════
  // WEB
  // ═══════════════════════════════════════════════════════════════

  {
    id: "typescript",
    displayName: "TypeScript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    manifestFiles: ["tsconfig.json", "package.json"],
    buildCmd: "tsc",
    testCmd: "vitest run",
    lintCmd: "eslint . --ext .ts,.tsx",
    typeCheckCmd: "tsc --noEmit",
    successSignal: "0 errors",
    errorSignal: "error TS",
    commonErrors: ["TS2345", "TS2322", "TS2304", "TS7006", "TS2339"],
    group: "web",
    skillFile: "languages/typescript.md",
  },

  {
    id: "javascript",
    displayName: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    manifestFiles: ["package.json"],
    buildCmd: "node --check index.js",
    testCmd: "vitest run",
    lintCmd: "eslint . --ext .js,.jsx",
    errorSignal: "SyntaxError:",
    commonErrors: ["is not a function", "Cannot read properties of", "is not defined"],
    group: "web",
    skillFile: "languages/javascript.md",
  },

  {
    id: "react",
    displayName: "React",
    extensions: [".tsx", ".jsx"],
    manifestFiles: ["package.json"],
    buildCmd: "vite build",
    testCmd: "vitest run",
    lintCmd: "eslint . --ext .tsx,.jsx",
    typeCheckCmd: "tsc --noEmit",
    errorSignal: "error TS",
    commonErrors: ["JSX element", "React Hook", "key prop", "Hooks can only"],
    group: "web",
    skillFile: "languages/react.md",
  },

  {
    id: "vue",
    displayName: "Vue",
    extensions: [".vue"],
    manifestFiles: ["package.json", "vite.config.ts", "vue.config.js"],
    buildCmd: "vite build",
    testCmd: "vitest run",
    lintCmd: "eslint . --ext .vue,.ts",
    typeCheckCmd: "vue-tsc --noEmit",
    errorSignal: "error TS",
    commonErrors: ["Property does not exist on type", "Extraneous non-props", "Missing required prop"],
    group: "web",
    skillFile: "languages/vue.md",
  },

  {
    id: "svelte",
    displayName: "Svelte",
    extensions: [".svelte"],
    manifestFiles: ["package.json", "svelte.config.js"],
    buildCmd: "vite build",
    testCmd: "vitest run",
    lintCmd: "eslint . --ext .svelte,.ts",
    typeCheckCmd: "svelte-check --tsconfig tsconfig.json",
    errorSignal: "Error:",
    commonErrors: ["Reactive statement", "store must have subscribe", "Cannot find module"],
    group: "web",
    skillFile: "languages/svelte.md",
  },

  {
    id: "angular",
    displayName: "Angular",
    extensions: [".ts", ".html"],
    manifestFiles: ["angular.json", "package.json"],
    buildCmd: "ng build",
    testCmd: "ng test --watch=false",
    lintCmd: "ng lint",
    typeCheckCmd: "tsc --noEmit",
    errorSignal: "error TS",
    commonErrors: ["NG0", "NullInjectorError", "Cannot read properties of null"],
    group: "web",
  },

  {
    id: "nextjs",
    displayName: "Next.js",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    manifestFiles: ["next.config.js", "next.config.ts", "next.config.mjs"],
    buildCmd: "next build",
    testCmd: "vitest run",
    lintCmd: "next lint",
    typeCheckCmd: "tsc --noEmit",
    successSignal: "Route (app)",
    errorSignal: "error TS",
    commonErrors: ["useClient directive", "Server Component", "Hydration", "Dynamic server usage"],
    group: "web",
  },

  {
    id: "html",
    displayName: "HTML/CSS",
    extensions: [".html", ".css", ".scss", ".sass", ".less"],
    buildCmd: "npx sass src:dist",
    lintCmd: "stylelint **/*.css",
    errorSignal: "Error:",
    group: "web",
  },

  {
    id: "htmx",
    displayName: "HTMX",
    extensions: [".html"],
    group: "web",
  },

  {
    id: "nodejs",
    displayName: "Node.js",
    extensions: [".js", ".mjs", ".cjs"],
    manifestFiles: ["package.json"],
    buildCmd: "node --check server.js",
    testCmd: "node --test",
    lintCmd: "eslint .",
    errorSignal: "Error:",
    commonErrors: ["ENOENT", "ECONNREFUSED", "Cannot find module", "UnhandledPromiseRejection"],
    group: "web",
  },

  // ═══════════════════════════════════════════════════════════════
  // BACKEND
  // ═══════════════════════════════════════════════════════════════

  {
    id: "python",
    displayName: "Python",
    extensions: [".py", ".pyi", ".pyx"],
    manifestFiles: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"],
    buildCmd: "python -m build",
    testCmd: "pytest",
    lintCmd: "ruff check .",
    typeCheckCmd: "mypy .",
    successSignal: "passed",
    errorSignal: "Error:",
    commonErrors: ["IndentationError", "TypeError", "AttributeError", "ImportError", "ModuleNotFoundError"],
    group: "backend",
    skillFile: "languages/python.md",
  },

  {
    id: "java",
    displayName: "Java",
    extensions: [".java"],
    manifestFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
    buildCmd: "mvn compile",
    testCmd: "mvn test",
    lintCmd: "mvn checkstyle:check",
    typeCheckCmd: "mvn compile -q",
    successSignal: "BUILD SUCCESS",
    errorSignal: "BUILD FAILURE",
    commonErrors: ["NullPointerException", "ClassNotFoundException", "cannot find symbol", "incompatible types"],
    group: "backend",
    skillFile: "languages/java.md",
  },

  {
    id: "kotlin",
    displayName: "Kotlin",
    extensions: [".kt", ".kts"],
    manifestFiles: ["build.gradle.kts", "build.gradle", "pom.xml"],
    buildCmd: "gradle build",
    testCmd: "gradle test",
    lintCmd: "ktlint",
    typeCheckCmd: "gradle compileKotlin",
    successSignal: "BUILD SUCCESSFUL",
    errorSignal: "BUILD FAILED",
    commonErrors: ["Unresolved reference", "Type mismatch", "Smart cast is impossible", "Val cannot be reassigned"],
    group: "backend",
    skillFile: "languages/kotlin.md",
  },

  {
    id: "ruby",
    displayName: "Ruby",
    extensions: [".rb"],
    manifestFiles: ["Gemfile", "Gemfile.lock", ".ruby-version"],
    buildCmd: "bundle exec rake build",
    testCmd: "bundle exec rspec",
    lintCmd: "bundle exec rubocop",
    typeCheckCmd: "bundle exec steep check",
    successSignal: "0 failures",
    errorSignal: "Error:",
    commonErrors: ["NoMethodError", "NameError", "ArgumentError", "LoadError"],
    group: "backend",
    skillFile: "languages/ruby.md",
  },

  {
    id: "php",
    displayName: "PHP",
    extensions: [".php"],
    manifestFiles: ["composer.json", "composer.lock"],
    buildCmd: "composer install",
    testCmd: "vendor/bin/phpunit",
    lintCmd: "vendor/bin/phpcs",
    typeCheckCmd: "vendor/bin/phpstan analyse",
    successSignal: "OK",
    errorSignal: "Fatal error:",
    commonErrors: ["Undefined variable", "Call to a member function", "Class not found", "Parse error"],
    group: "backend",
    skillFile: "languages/php.md",
  },

  {
    id: "csharp",
    displayName: "C#",
    extensions: [".cs"],
    manifestFiles: ["*.csproj", "*.sln"],
    buildCmd: "dotnet build",
    testCmd: "dotnet test",
    lintCmd: "dotnet format --verify-no-changes",
    typeCheckCmd: "dotnet build -warnaserror",
    successSignal: "Build succeeded",
    errorSignal: "error CS",
    commonErrors: ["CS0103", "CS0246", "CS8600", "NullReferenceException", "CS0161"],
    group: "backend",
    skillFile: "languages/csharp.md",
  },

  {
    id: "scala",
    displayName: "Scala",
    extensions: [".scala", ".sc"],
    manifestFiles: ["build.sbt", "project/build.properties"],
    buildCmd: "sbt compile",
    testCmd: "sbt test",
    lintCmd: "sbt scalafmtCheck",
    typeCheckCmd: "sbt compile",
    successSignal: "[success]",
    errorSignal: "[error]",
    commonErrors: ["value is not a member of", "type mismatch", "not found: value", "overloaded method"],
    group: "backend",
  },

  {
    id: "elixir",
    displayName: "Elixir",
    extensions: [".ex", ".exs"],
    manifestFiles: ["mix.exs"],
    buildCmd: "mix compile",
    testCmd: "mix test",
    lintCmd: "mix credo",
    typeCheckCmd: "mix dialyzer",
    successSignal: "Finished in",
    errorSignal: "** (CompileError)",
    commonErrors: ["undefined function", "no clause matching", "FunctionClauseError", "KeyError"],
    group: "backend",
    skillFile: "languages/elixir.md",
  },

  {
    id: "groovy",
    displayName: "Groovy",
    extensions: [".groovy"],
    manifestFiles: ["build.gradle"],
    buildCmd: "gradle build",
    testCmd: "gradle test",
    lintCmd: "npm-groovy-lint",
    successSignal: "BUILD SUCCESSFUL",
    errorSignal: "BUILD FAILED",
    commonErrors: ["MissingMethodException", "GroovyCastException", "ClassNotFoundException"],
    group: "backend",
  },

  // ═══════════════════════════════════════════════════════════════
  // MOBILE
  // ═══════════════════════════════════════════════════════════════

  {
    id: "swift",
    displayName: "Swift",
    extensions: [".swift"],
    manifestFiles: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
    buildCmd: "swift build",
    testCmd: "swift test",
    lintCmd: "swiftlint",
    typeCheckCmd: "swift build -Xswiftc -warnings-as-errors",
    successSignal: "Build complete!",
    errorSignal: "error:",
    commonErrors: ["value of type has no member", "cannot convert value", "use of unresolved identifier", "force unwrap"],
    group: "mobile",
    skillFile: "languages/swift.md",
  },

  {
    id: "kotlin-android",
    displayName: "Kotlin Android",
    extensions: [".kt", ".kts"],
    manifestFiles: ["AndroidManifest.xml", "build.gradle.kts"],
    buildCmd: "gradle assembleDebug",
    testCmd: "gradle test",
    lintCmd: "gradle lint",
    typeCheckCmd: "gradle compileDebugKotlin",
    successSignal: "BUILD SUCCESSFUL",
    errorSignal: "BUILD FAILED",
    commonErrors: ["Unresolved reference", "Type mismatch", "NullPointerException", "Activity not found"],
    group: "mobile",
  },

  {
    id: "dart",
    displayName: "Dart / Flutter",
    extensions: [".dart"],
    manifestFiles: ["pubspec.yaml", "pubspec.lock"],
    buildCmd: "flutter build apk",
    testCmd: "flutter test",
    lintCmd: "dart analyze",
    typeCheckCmd: "dart analyze",
    successSignal: "All tests passed",
    errorSignal: "error •",
    commonErrors: ["Undefined name", "The method doesn't exist", "A value of type cannot be assigned", "Null safety"],
    group: "mobile",
    skillFile: "languages/dart.md",
  },

  {
    id: "react-native",
    displayName: "React Native",
    extensions: [".tsx", ".jsx", ".ts", ".js"],
    manifestFiles: ["app.json", "metro.config.js"],
    buildCmd: "npx react-native build-android",
    testCmd: "jest",
    lintCmd: "eslint . --ext .tsx,.ts,.jsx,.js",
    typeCheckCmd: "tsc --noEmit",
    errorSignal: "error TS",
    commonErrors: ["Metro bundler", "Module not found", "Red Box", "Native module cannot be null"],
    group: "mobile",
  },

  {
    id: "objective-c",
    displayName: "Objective-C",
    extensions: [".m", ".mm", ".h"],
    buildCmd: "xcodebuild build",
    testCmd: "xcodebuild test",
    errorSignal: "error:",
    commonErrors: ["ARC forbids", "undeclared identifier", "instance method not found", "incompatible pointer types"],
    group: "mobile",
  },

  // ═══════════════════════════════════════════════════════════════
  // DATA
  // ═══════════════════════════════════════════════════════════════

  {
    id: "python-ml",
    displayName: "Python ML",
    extensions: [".py", ".ipynb"],
    manifestFiles: ["requirements.txt", "pyproject.toml", "environment.yml"],
    testCmd: "pytest",
    lintCmd: "ruff check .",
    typeCheckCmd: "mypy .",
    errorSignal: "Error:",
    commonErrors: ["CUDA out of memory", "shape mismatch", "ValueError", "RuntimeError", "device mismatch"],
    group: "data",
  },

  {
    id: "r",
    displayName: "R",
    extensions: [".r", ".R", ".Rmd", ".qmd"],
    manifestFiles: ["DESCRIPTION", "renv.lock"],
    buildCmd: "R CMD build .",
    testCmd: "Rscript -e \"testthat::test_dir('tests')\"",
    lintCmd: "Rscript -e \"lintr::lint_dir('.')\"",
    errorSignal: "Error in",
    commonErrors: ["object not found", "could not find function", "subscript out of bounds", "non-numeric argument"],
    group: "data",
    skillFile: "languages/r.md",
  },

  {
    id: "julia",
    displayName: "Julia",
    extensions: [".jl"],
    manifestFiles: ["Project.toml", "Manifest.toml"],
    buildCmd: "julia --project=. -e 'using Pkg; Pkg.build()'",
    testCmd: "julia --project=. -e 'using Pkg; Pkg.test()'",
    errorSignal: "ERROR:",
    commonErrors: ["MethodError", "UndefVarError", "BoundsError", "DomainError", "type instability"],
    group: "data",
  },

  {
    id: "sql",
    displayName: "SQL",
    extensions: [".sql"],
    lintCmd: "sqlfluff lint .",
    typeCheckCmd: "sqlfluff fix --check .",
    errorSignal: "ERROR:",
    commonErrors: ["syntax error", "relation does not exist", "column does not exist", "null value in column"],
    group: "data",
    skillFile: "languages/sql.md",
  },

  // ═══════════════════════════════════════════════════════════════
  // DEVOPS
  // ═══════════════════════════════════════════════════════════════

  {
    id: "bash",
    displayName: "Bash",
    extensions: [".sh", ".bash", ".zsh"],
    lintCmd: "shellcheck **/*.sh",
    errorSignal: "line",
    commonErrors: ["command not found", "unbound variable", "bad substitution", "syntax error near unexpected token"],
    group: "devops",
    skillFile: "languages/bash.md",
  },

  {
    id: "powershell",
    displayName: "PowerShell",
    extensions: [".ps1", ".psm1", ".psd1"],
    lintCmd: "Invoke-ScriptAnalyzer -Path . -Recurse",
    errorSignal: "At line:",
    commonErrors: ["is not recognized", "NullReference", "cannot bind parameter", "access is denied"],
    group: "devops",
  },

  {
    id: "dockerfile",
    displayName: "Dockerfile",
    extensions: [],
    manifestFiles: ["Dockerfile", "Containerfile"],
    buildCmd: "docker build .",
    lintCmd: "hadolint Dockerfile",
    successSignal: "Successfully built",
    errorSignal: "ERROR:",
    commonErrors: ["COPY failed", "RUN returned a non-zero code", "no such file or directory", "permission denied"],
    group: "devops",
    skillFile: "languages/docker.md",
  },

  {
    id: "terraform",
    displayName: "Terraform",
    extensions: [".tf", ".tfvars"],
    buildCmd: "terraform init && terraform plan",
    testCmd: "terraform validate",
    lintCmd: "tflint",
    typeCheckCmd: "terraform validate",
    successSignal: "No changes",
    errorSignal: "Error:",
    commonErrors: ["Invalid reference", "Missing required argument", "Unsupported attribute", "Cycle in dependency graph"],
    group: "devops",
    skillFile: "languages/terraform.md",
  },

  {
    id: "kubernetes",
    displayName: "Kubernetes",
    extensions: [".yaml", ".yml"],
    manifestFiles: ["Chart.yaml", "values.yaml", "kustomization.yaml"],
    buildCmd: "helm template .",
    testCmd: "helm test",
    lintCmd: "helm lint . && kubectl --dry-run=client apply -f .",
    typeCheckCmd: "kubeconform -strict .",
    errorSignal: "Error:",
    commonErrors: ["ImagePullBackOff", "CrashLoopBackOff", "OOMKilled", "Pending", "ErrImagePull"],
    group: "devops",
  },

  {
    id: "ansible",
    displayName: "Ansible",
    extensions: [".yaml", ".yml"],
    manifestFiles: ["playbook.yml", "site.yml", "ansible.cfg", "inventory"],
    testCmd: "ansible-playbook --syntax-check site.yml",
    lintCmd: "ansible-lint",
    typeCheckCmd: "ansible-playbook --check site.yml",
    errorSignal: "fatal:",
    commonErrors: ["unreachable", "FAILED!", "MODULE FAILURE", "Timeout", "Authentication failure"],
    group: "devops",
  },

  {
    id: "nix",
    displayName: "Nix",
    extensions: [".nix"],
    manifestFiles: ["flake.nix", "default.nix", "shell.nix"],
    buildCmd: "nix build",
    testCmd: "nix flake check",
    lintCmd: "statix check",
    typeCheckCmd: "nix eval .#",
    successSignal: "✓",
    errorSignal: "error:",
    commonErrors: ["infinite recursion", "attribute missing", "collision between packages", "hash mismatch"],
    group: "devops",
  },

  {
    id: "makefile",
    displayName: "Makefile",
    extensions: [],
    manifestFiles: ["Makefile", "GNUmakefile", "makefile"],
    buildCmd: "make",
    testCmd: "make test",
    errorSignal: "*** Error",
    commonErrors: ["No rule to make target", "missing separator", "command not found", "recipe for target failed"],
    group: "devops",
  },

  {
    id: "awk",
    displayName: "AWK",
    extensions: [".awk"],
    errorSignal: "awk:",
    commonErrors: ["syntax error", "attempt to access field", "illegal reference", "division by zero"],
    group: "devops",
  },

  // ═══════════════════════════════════════════════════════════════
  // GAME
  // ═══════════════════════════════════════════════════════════════

  {
    id: "gdscript",
    displayName: "GDScript",
    extensions: [".gd"],
    manifestFiles: ["project.godot"],
    buildCmd: "godot --headless --export-release Linux game.x86_64",
    testCmd: "godot --headless -s addons/gut/gut_cmdln.gd",
    errorSignal: "ERROR:",
    commonErrors: ["Identifier not declared", "Invalid get index", "Null reference", "Method not found"],
    group: "game",
    skillFile: "languages/gdscript.md",
  },

  {
    id: "unity-csharp",
    displayName: "Unity C#",
    extensions: [".cs"],
    manifestFiles: ["ProjectSettings/ProjectVersion.txt", "Assets"],
    buildCmd: "unity-editor -batchmode -buildLinux64Player Build/game",
    testCmd: "unity-editor -batchmode -runEditorTests",
    errorSignal: "error CS",
    commonErrors: ["CS0103", "NullReferenceException", "MissingReferenceException", "Object reference not set"],
    group: "game",
  },

  {
    id: "glsl",
    displayName: "GLSL",
    extensions: [".glsl", ".frag", ".vert", ".geom", ".comp", ".hlsl"],
    buildCmd: "glslangValidator -V shader.vert",
    lintCmd: "glslangValidator --target-env vulkan1.2 **/*.vert **/*.frag",
    errorSignal: "ERROR:",
    commonErrors: ["undeclared identifier", "no matching overloaded function", "type mismatch", "precision qualifier required"],
    group: "game",
  },

  {
    id: "unreal-cpp",
    displayName: "Unreal C++",
    extensions: [".cpp", ".h"],
    manifestFiles: ["*.uproject"],
    buildCmd: "UnrealBuildTool MyProject Win64 Development",
    testCmd: "UnrealEditor -ExecCmds=\"Automation RunTests\"",
    errorSignal: "error C",
    commonErrors: ["UPROPERTY missing", "Unresolved external", "UClass not found", "Blueprint callable"],
    group: "game",
  },

  // ═══════════════════════════════════════════════════════════════
  // HDL
  // ═══════════════════════════════════════════════════════════════

  {
    id: "verilog",
    displayName: "Verilog",
    extensions: [".v", ".vh"],
    buildCmd: "iverilog -o sim.vvp design.v",
    testCmd: "vvp sim.vvp",
    lintCmd: "verilator --lint-only design.v",
    errorSignal: "error:",
    commonErrors: ["Undefined variable", "Implicit net declaration", "sensitivity list", "always @* latch"],
    group: "hdl",
    skillFile: "languages/verilog.md",
  },

  {
    id: "systemverilog",
    displayName: "SystemVerilog",
    extensions: [".sv", ".svh"],
    buildCmd: "iverilog -g2012 -o sim.vvp design.sv",
    testCmd: "vvp sim.vvp",
    lintCmd: "verilator --lint-only --sv design.sv",
    errorSignal: "error:",
    commonErrors: ["Invalid module port", "Undeclared interface", "Packed/unpacked mismatch", "Assertion failed"],
    group: "hdl",
  },

  {
    id: "vhdl",
    displayName: "VHDL",
    extensions: [".vhd", ".vhdl"],
    buildCmd: "ghdl -a design.vhd",
    testCmd: "ghdl -r testbench",
    lintCmd: "ghdl -s design.vhd",
    errorSignal: "error:",
    commonErrors: ["undefined identifier", "signal vs variable", "sensitivity list incomplete", "latch inferred"],
    group: "hdl",
  },

  {
    id: "chisel",
    displayName: "Chisel",
    extensions: [".scala"],
    manifestFiles: ["build.sbt"],
    buildCmd: "sbt compile",
    testCmd: "sbt test",
    lintCmd: "sbt scalafmtCheck",
    successSignal: "[success]",
    errorSignal: "[error]",
    commonErrors: ["chisel3.ChiselException", "firrtl.passes.CheckTypes", "unconnected wire", "DontCare"],
    group: "hdl",
  },

  {
    id: "spinalhdl",
    displayName: "SpinalHDL",
    extensions: [".scala"],
    manifestFiles: ["build.sbt"],
    buildCmd: "sbt compile",
    testCmd: "sbt test",
    lintCmd: "sbt scalafmtCheck",
    successSignal: "[success]",
    errorSignal: "[error]",
    commonErrors: ["SpinalError", "Clock domain crossing", "Latch detected", "unconnected signal"],
    group: "hdl",
  },

  // ═══════════════════════════════════════════════════════════════
  // BLOCKCHAIN
  // ═══════════════════════════════════════════════════════════════

  {
    id: "solidity",
    displayName: "Solidity",
    extensions: [".sol"],
    manifestFiles: ["hardhat.config.ts", "hardhat.config.js", "foundry.toml"],
    buildCmd: "forge build",
    testCmd: "forge test",
    lintCmd: "solhint 'contracts/**/*.sol'",
    typeCheckCmd: "forge build --deny-warnings",
    successSignal: "Compiling done",
    errorSignal: "Error:",
    commonErrors: ["reentrancy", "integer overflow", "unauthorized", "underflow", "Solidity syntax error"],
    group: "blockchain",
    skillFile: "languages/solidity.md",
  },

  {
    id: "solana-rust",
    displayName: "Solana Rust",
    extensions: [".rs"],
    manifestFiles: ["Anchor.toml", "Cargo.toml"],
    buildCmd: "anchor build",
    testCmd: "anchor test",
    lintCmd: "cargo clippy -- -D warnings",
    typeCheckCmd: "cargo check",
    successSignal: "Build successful",
    errorSignal: "error[",
    commonErrors: ["account not found", "invalid program id", "constraint violated", "arithmetic overflow"],
    group: "blockchain",
  },

  {
    id: "move",
    displayName: "Move",
    extensions: [".move"],
    manifestFiles: ["Move.toml"],
    buildCmd: "aptos move compile",
    testCmd: "aptos move test",
    lintCmd: "move-lint",
    typeCheckCmd: "aptos move compile --skip-fetch-latest-git-deps",
    successSignal: "Compiling, may take a little while",
    errorSignal: "error[",
    commonErrors: ["resource already exists", "cannot copy resource", "borrow violated", "type parameter constraint"],
    group: "blockchain",
  },

  // ═══════════════════════════════════════════════════════════════
  // EMERGING
  // ═══════════════════════════════════════════════════════════════

  {
    id: "webassembly",
    displayName: "WebAssembly",
    extensions: [".wat", ".wast"],
    buildCmd: "wat2wasm module.wat -o module.wasm",
    testCmd: "wabt run --spec module.wast",
    lintCmd: "wasm-validate module.wasm",
    errorSignal: "error:",
    commonErrors: ["type mismatch", "unknown function", "stack type mismatch", "unreachable"],
    group: "emerging",
  },

  {
    id: "cuda",
    displayName: "CUDA",
    extensions: [".cu", ".cuh"],
    buildCmd: "nvcc -O2 -o kernel kernel.cu",
    testCmd: "ctest",
    lintCmd: "cuda-memcheck ./kernel",
    errorSignal: "error:",
    commonErrors: ["cudaErrorMemoryAllocation", "misaligned address", "an illegal memory access", "CUDA error"],
    group: "emerging",
    skillFile: "languages/cuda.md",
  },

  {
    id: "opencl",
    displayName: "OpenCL",
    extensions: [".cl"],
    buildCmd: "gcc -o clapp main.c -lOpenCL",
    errorSignal: "CL_",
    commonErrors: ["CL_BUILD_PROGRAM_FAILURE", "CL_INVALID_WORK_GROUP_SIZE", "CL_OUT_OF_RESOURCES", "CL_COMPILER_NOT_AVAILABLE"],
    group: "emerging",
  },

  {
    id: "mojo",
    displayName: "Mojo",
    extensions: [".mojo", ".🔥"],
    buildCmd: "mojo build main.mojo",
    testCmd: "mojo test",
    errorSignal: "error:",
    commonErrors: ["value used as a type", "cannot unify", "missing overload", "not Copyable"],
    group: "emerging",
  },

  // ═══════════════════════════════════════════════════════════════
  // SCRIPTING
  // ═══════════════════════════════════════════════════════════════

  {
    id: "lua",
    displayName: "Lua",
    extensions: [".lua"],
    buildCmd: "luac -o out.luac main.lua",
    testCmd: "busted",
    lintCmd: "luacheck .",
    errorSignal: "stdin:",
    commonErrors: ["attempt to index", "attempt to call", "stack overflow", "table index is nil"],
    group: "scripting",
    skillFile: "languages/lua.md",
  },

  {
    id: "perl",
    displayName: "Perl",
    extensions: [".pl", ".pm"],
    buildCmd: "perl -c script.pl",
    testCmd: "prove -lr t/",
    lintCmd: "perlcritic .",
    errorSignal: "at script.pl line",
    commonErrors: ["Global symbol requires", "Undefined subroutine", "Can't locate", "Use of uninitialized value"],
    group: "scripting",
  },

  {
    id: "tcl",
    displayName: "Tcl",
    extensions: [".tcl"],
    buildCmd: "tclsh script.tcl",
    testCmd: "tclsh tests/all.tcl",
    errorSignal: "Error in startup script:",
    commonErrors: ["wrong # args", "bad option", "can't read variable", "invalid command name"],
    group: "scripting",
  },

  // ═══════════════════════════════════════════════════════════════
  // FUNCTIONAL
  // ═══════════════════════════════════════════════════════════════

  {
    id: "haskell",
    displayName: "Haskell",
    extensions: [".hs", ".lhs"],
    manifestFiles: ["stack.yaml", "cabal.project", "*.cabal"],
    buildCmd: "stack build",
    testCmd: "stack test",
    lintCmd: "hlint .",
    typeCheckCmd: "stack build --ghc-options -Wall",
    successSignal: "Completed",
    errorSignal: "error:",
    commonErrors: ["No instance for", "Couldn't match type", "Variable not in scope", "Non-exhaustive patterns"],
    group: "functional",
    skillFile: "languages/haskell.md",
  },

  {
    id: "ocaml",
    displayName: "OCaml",
    extensions: [".ml", ".mli"],
    manifestFiles: ["dune-project", "*.opam"],
    buildCmd: "dune build",
    testCmd: "dune test",
    lintCmd: "ocamlformat --check **/*.ml",
    typeCheckCmd: "dune build @check",
    successSignal: "",
    errorSignal: "Error:",
    commonErrors: ["Unbound value", "This expression has type", "Unused variable", "Warning 8"],
    group: "functional",
  },

  {
    id: "fsharp",
    displayName: "F#",
    extensions: [".fs", ".fsi", ".fsx"],
    manifestFiles: ["*.fsproj", "*.sln"],
    buildCmd: "dotnet build",
    testCmd: "dotnet test",
    lintCmd: "dotnet fantomas --check .",
    typeCheckCmd: "dotnet build -warnaserror",
    successSignal: "Build succeeded",
    errorSignal: "error FS",
    commonErrors: ["FS0001", "FS0003", "FS0010", "Value restriction", "This expression was expected to have type"],
    group: "functional",
  },

  {
    id: "clojure",
    displayName: "Clojure",
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    manifestFiles: ["project.clj", "deps.edn", "bb.edn"],
    buildCmd: "clj -T:build jar",
    testCmd: "clj -M:test",
    lintCmd: "clj-kondo --lint src",
    typeCheckCmd: "clj -M:clj-kondo",
    successSignal: "Ran",
    errorSignal: "Syntax error",
    commonErrors: ["Unable to resolve symbol", "ArityException", "ClassCastException", "NullPointerException"],
    group: "functional",
  },
  // ═══════════════════════════════════════════════════════════════
  // TPU / JAX / XLA
  // ═══════════════════════════════════════════════════════════════

  {
    id: "jax",
    displayName: "JAX/XLA (TPU)",
    extensions: [".py"],
    manifestFiles: ["requirements.txt"],
    buildCmd: "python -c 'import jax; print(jax.devices())'",
    testCmd: "pytest tests/",
    errorSignal: "XlaRuntimeError",
    commonErrors: [
      "RESOURCE_EXHAUSTED",
      "TracerArrayConversionError",
      "UnexpectedTracerError",
      "INVALID_ARGUMENT: Shapes must be compatible",
      "Cannot use a jit-compiled function",
    ],
    group: "emerging",
  },

  {
    id: "torch-xla",
    displayName: "PyTorch/XLA (TPU)",
    extensions: [".py"],
    errorSignal: "torch_xla",
    commonErrors: [
      "XLA device not found",
      "mark_step",
      "RESOURCE_EXHAUSTED",
      "unsupported operation on XLA",
      "xla_model",
    ],
    group: "emerging",
  },

  // ═══════════════════════════════════════════════════════════════
  // NPU (Neural Processing Unit)
  // ═══════════════════════════════════════════════════════════════

  {
    id: "coreml",
    displayName: "Core ML / Apple Neural Engine",
    extensions: [".py", ".mlmodel", ".mlpackage"],
    errorSignal: "coremltools.models",
    commonErrors: [
      "Unsupported op",
      "Model conversion failed",
      "shape mismatch",
      "Operator not supported in target compute unit",
      "ANE compiler error",
    ],
    group: "emerging",
  },

  {
    id: "openvino",
    displayName: "OpenVINO (Intel NPU)",
    extensions: [".py", ".xml", ".bin"],
    errorSignal: "[ERROR] OpenVINO",
    commonErrors: [
      "Unsupported primitive",
      "Layer type is not supported",
      "Input shape is not supported",
      "runtime error",
      "Failed to compile model",
    ],
    group: "emerging",
  },

  {
    id: "snpe",
    displayName: "Qualcomm SNPE (NPU)",
    extensions: [".py", ".dlc"],
    errorSignal: "SNPE Error",
    commonErrors: [
      "Unsupported network layer",
      "Buffer size mismatch",
      "Runtime backend not found",
      "Failed to load model",
      "Quantization failed",
    ],
    group: "emerging",
  },

  // ═══════════════════════════════════════════════════════════════
  // QPU (Quantum Processing Unit)
  // ═══════════════════════════════════════════════════════════════

  {
    id: "qiskit",
    displayName: "Qiskit (IBM QPU)",
    extensions: [".py"],
    manifestFiles: ["requirements.txt"],
    buildCmd: "python -c 'import qiskit; print(qiskit.__version__)'",
    testCmd: "pytest tests/",
    errorSignal: "QiskitError",
    commonErrors: [
      "CircuitError",
      "TranspilerError",
      "Circuit too wide",
      "JobError: job status is ERROR",
      "BackendJobLimit",
    ],
    group: "emerging",
  },

  {
    id: "cirq",
    displayName: "Cirq (Google QPU)",
    extensions: [".py"],
    errorSignal: "cirq.errors",
    commonErrors: [
      "InvalidArgumentError",
      "Moment can only hold",
      "No qubits specified",
      "Gate not supported on device",
      "Simulation error",
    ],
    group: "emerging",
  },

  {
    id: "pennylane",
    displayName: "PennyLane (QPU)",
    extensions: [".py"],
    errorSignal: "pennylane.DeviceError",
    commonErrors: [
      "DeviceError",
      "Operation not supported",
      "Invalid wire",
      "gradient not defined",
      "QuantumFunctionError",
    ],
    group: "emerging",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Look up a language by its canonical ID */
export function getLanguage(id: string): LanguageRegistryEntry | undefined {
  return LANGUAGE_REGISTRY.find((e) => e.id === id);
}

/** Find language by file extension (e.g. ".ts" → typescript entry) */
export function getLanguageByExtension(ext: string): LanguageRegistryEntry | undefined {
  const normalized = ext.startsWith(".") ? ext : `.${ext}`;
  return LANGUAGE_REGISTRY.find((e) => e.extensions.includes(normalized));
}

/** Find language by manifest filename (e.g. "Cargo.toml" → rust entry) */
export function getLanguageByManifest(filename: string): LanguageRegistryEntry | undefined {
  return LANGUAGE_REGISTRY.find((e) => e.manifestFiles?.includes(filename));
}

/** Get all languages in a group */
export function getLanguagesByGroup(group: LanguageGroup): LanguageRegistryEntry[] {
  return LANGUAGE_REGISTRY.filter((e) => e.group === group);
}
