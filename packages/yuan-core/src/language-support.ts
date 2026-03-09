/**
 * @module language-support
 * @description Multi-language intelligence for the YUAN coding agent.
 * Provides language detection, parsing patterns, tool configuration,
 * code generation hints, and project type detection for 14+ languages.
 */

import { extname, basename } from "node:path";

// ─── Types ───

/** All languages supported by YUAN's language intelligence. */
export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "ruby"
  | "php"
  | "swift"
  | "kotlin"
  | "dart"
  | "shell"
  | "unknown";

/** Regex patterns for extracting language constructs from source code. */
export interface LanguagePatterns {
  /** Matches function/method declarations. */
  function: RegExp;
  /** Matches class declarations. */
  class: RegExp;
  /** Matches interface/protocol/trait declarations (if applicable). */
  interface?: RegExp;
  /** Matches import/include/require statements. */
  import: RegExp;
  /** Matches export/public API declarations (if applicable). */
  export?: RegExp;
  /** Matches single-line comments. */
  singleLineComment: RegExp;
  /** Matches multi-line comment delimiters. */
  multiLineComment: { start: RegExp; end: RegExp };
  /** Matches doc comments (JSDoc, pydoc, rustdoc, etc.). */
  docComment?: RegExp;
  /** Matches string literals (for avoiding false matches inside strings). */
  stringLiteral: RegExp;
}

/** Complete configuration for a supported language. */
export interface LanguageConfig {
  /** Language identifier. */
  name: SupportedLanguage;
  /** Human-readable display name. */
  displayName: string;
  /** File extensions (without leading dot). */
  extensions: string[];
  /** Shebang patterns for content-based detection. */
  shebangs?: string[];

  // Parsing
  /** Regex patterns for extracting code constructs. */
  patterns: LanguagePatterns;

  // Tooling
  /** Common build commands for this language. */
  buildCommands: string[];
  /** Common test commands for this language. */
  testCommands: string[];
  /** Common lint commands for this language. */
  lintCommands: string[];
  /** Package manifest file names. */
  packageFiles: string[];
  /** Lock file names. */
  lockFiles: string[];

  // Style
  /** Primary naming convention for identifiers. */
  namingConvention: "camelCase" | "snake_case" | "PascalCase" | "kebab-case";
  /** Primary naming convention for files. */
  fileNaming: "camelCase" | "snake_case" | "PascalCase" | "kebab-case";
  /** Import path style. */
  importStyle: "relative" | "absolute" | "package" | "mixed";

  // Doc comments
  /** Prefix for doc comments. */
  docCommentPrefix: string;
  /** Doc comment style. */
  docCommentStyle:
    | "jsdoc"
    | "pydoc"
    | "godoc"
    | "rustdoc"
    | "javadoc"
    | "none";
}

/** Detected project type information. */
export interface ProjectType {
  /** Human-readable project type name. */
  name: string;
  /** Primary language of the project. */
  language: SupportedLanguage;
  /** Framework name if detected. */
  framework?: string;
  /** Whether this is a monorepo. */
  isMonorepo: boolean;
  /** File or pattern that triggered detection. */
  detectedBy: string;
  /** Suggested tools and configurations for this project. */
  suggestedTools: string[];
}

/** Configuration for customizing language support. */
export interface LanguageSupportConfig {
  /** Additional language configurations to register. */
  additionalLanguages?: LanguageConfig[];
  /** Overrides for built-in language configurations. */
  overrides?: Partial<Record<SupportedLanguage, Partial<LanguageConfig>>>;
}

/** A parsed symbol extracted from source code. */
export interface ParsedSymbol {
  /** Symbol name. */
  name: string;
  /** Line number (1-based). */
  line: number;
  /** Parameter list string (if applicable). */
  params?: string;
  /** Return type string (if applicable). */
  returnType?: string;
  /** Visibility modifier. */
  visibility?: "public" | "private" | "protected";
}

/** A parsed import statement. */
export interface ParsedImport {
  /** Import source/module path. */
  source: string;
  /** Named imports. */
  names: string[];
  /** Line number (1-based). */
  line: number;
  /** Whether this is a default import. */
  isDefault: boolean;
}

// ─── Built-in Language Configs ───

const TYPESCRIPT_CONFIG: LanguageConfig = {
  name: "typescript",
  displayName: "TypeScript",
  extensions: ["ts", "tsx", "mts", "cts"],
  patterns: {
    function:
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g,
    class:
      /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    interface:
      /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{/g,
    import:
      /import\s+(?:(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g,
    export:
      /export\s+(?:default\s+)?(?:type\s+)?(?:(?:async\s+)?function|class|interface|type|enum|const|let|var)\s+(\w+)/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\*\*[\s\S]*?\*\//g,
    stringLiteral: /(?:`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
  },
  buildCommands: ["tsc", "npm run build", "pnpm run build"],
  testCommands: ["jest", "vitest", "npm test", "pnpm test"],
  lintCommands: ["eslint .", "biome check .", "tsc --noEmit"],
  packageFiles: ["package.json", "tsconfig.json"],
  lockFiles: [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
  ],
  namingConvention: "camelCase",
  fileNaming: "kebab-case",
  importStyle: "mixed",
  docCommentPrefix: "/**",
  docCommentStyle: "jsdoc",
};

const JAVASCRIPT_CONFIG: LanguageConfig = {
  name: "javascript",
  displayName: "JavaScript",
  extensions: ["js", "jsx", "mjs", "cjs"],
  shebangs: ["node", "nodejs"],
  patterns: {
    function:
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{/g,
    class:
      /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g,
    import:
      /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g,
    export:
      /export\s+(?:default\s+)?(?:(?:async\s+)?function|class|const|let|var)\s+(\w+)/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\*\*[\s\S]*?\*\//g,
    stringLiteral: /(?:`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
  },
  buildCommands: ["npm run build", "pnpm run build"],
  testCommands: ["jest", "vitest", "mocha", "npm test"],
  lintCommands: ["eslint .", "biome check ."],
  packageFiles: ["package.json"],
  lockFiles: [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
  ],
  namingConvention: "camelCase",
  fileNaming: "kebab-case",
  importStyle: "mixed",
  docCommentPrefix: "/**",
  docCommentStyle: "jsdoc",
};

const PYTHON_CONFIG: LanguageConfig = {
  name: "python",
  displayName: "Python",
  extensions: ["py", "pyi", "pyw"],
  shebangs: ["python", "python3"],
  patterns: {
    function:
      /(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\s:]+))?\s*:/g,
    class: /class\s+(\w+)(?:\(([^)]*)\))?\s*:/g,
    interface:
      /class\s+(\w+)\((?:Protocol|ABC)\):/g,
    import:
      /(?:from\s+([\w.]+)\s+import\s+(?:\([\s\S]*?\)|[^;\n]+)|import\s+([\w.,\s]+))/g,
    singleLineComment: /#.*/g,
    multiLineComment: { start: /"""/g, end: /"""/g },
    docComment: /"""[\s\S]*?"""/g,
    stringLiteral:
      /(?:f?r?"""[\s\S]*?"""|f?r?'''[\s\S]*?'''|f?r?"(?:[^"\\]|\\.)*"|f?r?'(?:[^'\\]|\\.)*')/g,
  },
  buildCommands: ["python -m build", "pip install -e ."],
  testCommands: ["pytest", "python -m pytest", "python -m unittest"],
  lintCommands: ["ruff check .", "flake8", "mypy .", "pylint"],
  packageFiles: [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
  ],
  lockFiles: ["poetry.lock", "Pipfile.lock", "requirements.lock"],
  namingConvention: "snake_case",
  fileNaming: "snake_case",
  importStyle: "absolute",
  docCommentPrefix: '"""',
  docCommentStyle: "pydoc",
};

const GO_CONFIG: LanguageConfig = {
  name: "go",
  displayName: "Go",
  extensions: ["go"],
  patterns: {
    function:
      /func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]+)\)|(\w+)))?\s*\{/g,
    class: /type\s+(\w+)\s+struct\s*\{/g,
    interface: /type\s+(\w+)\s+interface\s*\{/g,
    import: /import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\/\s*\w[\s\S]*?(?=\nfunc|\ntype|\nvar|\nconst)/g,
    stringLiteral: /(?:`[^`]*`|"(?:[^"\\]|\\.)*")/g,
  },
  buildCommands: ["go build ./..."],
  testCommands: ["go test ./..."],
  lintCommands: ["golangci-lint run", "go vet ./..."],
  packageFiles: ["go.mod"],
  lockFiles: ["go.sum"],
  namingConvention: "camelCase",
  fileNaming: "snake_case",
  importStyle: "package",
  docCommentPrefix: "//",
  docCommentStyle: "godoc",
};

const RUST_CONFIG: LanguageConfig = {
  name: "rust",
  displayName: "Rust",
  extensions: ["rs"],
  patterns: {
    function:
      /(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^\s{]+))?\s*(?:where\s+[^{]*)?\{/g,
    class: /(?:pub(?:\(crate\))?\s+)?struct\s+(\w+)(?:<[^>]*>)?/g,
    interface: /(?:pub(?:\(crate\))?\s+)?trait\s+(\w+)(?:<[^>]*>)?/g,
    import: /use\s+([\w:]+(?:::\{[^}]+\}|::\*)?)\s*;/g,
    export: /pub\s+(?:(?:async\s+)?fn|struct|trait|enum|type|const|mod)\s+(\w+)/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\/\/.*(?:\n\/\/\/.*)*/g,
    stringLiteral: /(?:r#*"[\s\S]*?"#*|"(?:[^"\\]|\\.)*")/g,
  },
  buildCommands: ["cargo build"],
  testCommands: ["cargo test"],
  lintCommands: ["cargo clippy", "cargo check"],
  packageFiles: ["Cargo.toml"],
  lockFiles: ["Cargo.lock"],
  namingConvention: "snake_case",
  fileNaming: "snake_case",
  importStyle: "absolute",
  docCommentPrefix: "///",
  docCommentStyle: "rustdoc",
};

const JAVA_CONFIG: LanguageConfig = {
  name: "java",
  displayName: "Java",
  extensions: ["java"],
  patterns: {
    function:
      /(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:synchronized\s+)?(?:[\w<>\[\],\s]+)\s+(\w+)\s*\(([^)]*)\)(?:\s+throws\s+[\w,\s]+)?\s*\{/g,
    class:
      /(?:(?:public|private|protected)\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    interface:
      /(?:public\s+)?interface\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+[\w,\s]+)?\s*\{/g,
    import: /import\s+(?:static\s+)?([\w.*]+)\s*;/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\*\*[\s\S]*?\*\//g,
    stringLiteral: /(?:"""[\s\S]*?"""|"(?:[^"\\]|\\.)*")/g,
  },
  buildCommands: ["mvn compile", "gradle build", "javac"],
  testCommands: ["mvn test", "gradle test"],
  lintCommands: ["checkstyle", "spotbugs"],
  packageFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
  lockFiles: ["gradle.lockfile"],
  namingConvention: "camelCase",
  fileNaming: "PascalCase",
  importStyle: "absolute",
  docCommentPrefix: "/**",
  docCommentStyle: "javadoc",
};

const C_CONFIG: LanguageConfig = {
  name: "c",
  displayName: "C",
  extensions: ["c", "h"],
  patterns: {
    function:
      /(?:(?:static|extern|inline)\s+)?(?:[\w*]+\s+)+(\w+)\s*\(([^)]*)\)\s*\{/g,
    class: /(?:typedef\s+)?struct\s+(\w+)\s*\{/g,
    import: /#include\s+[<"]([^>"]+)[>"]/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\*\*[\s\S]*?\*\//g,
    stringLiteral: /"(?:[^"\\]|\\.)*"/g,
  },
  buildCommands: ["make", "cmake --build .", "gcc"],
  testCommands: ["make test", "ctest"],
  lintCommands: ["cppcheck", "clang-tidy"],
  packageFiles: ["CMakeLists.txt", "Makefile", "meson.build"],
  lockFiles: [],
  namingConvention: "snake_case",
  fileNaming: "snake_case",
  importStyle: "relative",
  docCommentPrefix: "/**",
  docCommentStyle: "javadoc",
};

const CPP_CONFIG: LanguageConfig = {
  name: "cpp",
  displayName: "C++",
  extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
  patterns: {
    function:
      /(?:(?:virtual|static|inline|explicit|constexpr)\s+)*(?:[\w:*&<>,\s]+)\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:const|noexcept|override|final|\s)+)*\s*\{/g,
    class:
      /(?:template\s*<[^>]*>\s*)?class\s+(\w+)(?:\s*:\s*(?:public|private|protected)\s+[\w:]+(?:\s*,\s*(?:public|private|protected)\s+[\w:]+)*)?\s*\{/g,
    import: /#include\s+[<"]([^>"]+)[>"]/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\*\*[\s\S]*?\*\//g,
    stringLiteral: /(?:R"([^(]*)\([\s\S]*?\)\1"|"(?:[^"\\]|\\.)*")/g,
  },
  buildCommands: ["make", "cmake --build .", "g++", "clang++"],
  testCommands: ["make test", "ctest"],
  lintCommands: ["cppcheck", "clang-tidy", "cpplint"],
  packageFiles: [
    "CMakeLists.txt",
    "Makefile",
    "meson.build",
    "conanfile.txt",
    "vcpkg.json",
  ],
  lockFiles: ["conan.lock"],
  namingConvention: "camelCase",
  fileNaming: "snake_case",
  importStyle: "mixed",
  docCommentPrefix: "/**",
  docCommentStyle: "javadoc",
};

const RUBY_CONFIG: LanguageConfig = {
  name: "ruby",
  displayName: "Ruby",
  extensions: ["rb", "rake", "gemspec"],
  shebangs: ["ruby"],
  patterns: {
    function: /def\s+(self\.)?(\w+[?!=]?)\s*(?:\(([^)]*)\))?/g,
    class: /class\s+([\w:]+)(?:\s*<\s*([\w:]+))?/g,
    interface: /module\s+([\w:]+)/g,
    import: /require(?:_relative)?\s+['"]([^'"]+)['"]/g,
    singleLineComment: /#.*/g,
    multiLineComment: { start: /=begin/g, end: /=end/g },
    docComment: /##.*(?:\n#.*)*/g,
    stringLiteral:
      /(?:%[qQwWiI]?(?:\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|<[^>]*>|([^\w\s])[\s\S]*?\1)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
  },
  buildCommands: ["bundle exec rake build", "gem build"],
  testCommands: ["bundle exec rspec", "bundle exec rake test", "ruby -Itest"],
  lintCommands: ["rubocop", "bundle exec rubocop"],
  packageFiles: ["Gemfile", "*.gemspec"],
  lockFiles: ["Gemfile.lock"],
  namingConvention: "snake_case",
  fileNaming: "snake_case",
  importStyle: "absolute",
  docCommentPrefix: "#",
  docCommentStyle: "none",
};

const PHP_CONFIG: LanguageConfig = {
  name: "php",
  displayName: "PHP",
  extensions: ["php", "phtml"],
  shebangs: ["php"],
  patterns: {
    function:
      /(?:(?:public|private|protected|static)\s+)*function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*\??([\w|]+))?\s*\{/g,
    class:
      /(?:(?:abstract|final)\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    interface: /interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{/g,
    import: /(?:use\s+([\w\\]+)(?:\s+as\s+\w+)?;|require(?:_once)?\s+['"]([^'"]+)['"])/g,
    singleLineComment: /(?:\/\/|#).*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\*\*[\s\S]*?\*\//g,
    stringLiteral: /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
  },
  buildCommands: ["composer install"],
  testCommands: ["phpunit", "./vendor/bin/phpunit"],
  lintCommands: ["phpstan", "phpcs", "php-cs-fixer fix --dry-run"],
  packageFiles: ["composer.json"],
  lockFiles: ["composer.lock"],
  namingConvention: "camelCase",
  fileNaming: "PascalCase",
  importStyle: "absolute",
  docCommentPrefix: "/**",
  docCommentStyle: "javadoc",
};

const SWIFT_CONFIG: LanguageConfig = {
  name: "swift",
  displayName: "Swift",
  extensions: ["swift"],
  patterns: {
    function:
      /(?:(?:public|private|internal|fileprivate|open)\s+)?(?:(?:static|class|mutating|override)\s+)?func\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*(?:throws|rethrows)\s*)?(?:\s*->\s*([^\s{]+))?\s*\{/g,
    class:
      /(?:(?:public|private|internal|fileprivate|open)\s+)?(?:final\s+)?class\s+(\w+)(?:<[^>]*>)?(?:\s*:\s*[\w,\s]+)?\s*\{/g,
    interface:
      /(?:(?:public|private|internal)\s+)?protocol\s+(\w+)(?:\s*:\s*[\w,\s]+)?\s*\{/g,
    import: /import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(\w+)/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\/\/.*(?:\n\/\/\/.*)*/g,
    stringLiteral:
      /(?:"""[\s\S]*?"""|"(?:[^"\\]|\\.)*")/g,
  },
  buildCommands: ["swift build", "xcodebuild"],
  testCommands: ["swift test", "xcodebuild test"],
  lintCommands: ["swiftlint"],
  packageFiles: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
  lockFiles: ["Package.resolved"],
  namingConvention: "camelCase",
  fileNaming: "PascalCase",
  importStyle: "package",
  docCommentPrefix: "///",
  docCommentStyle: "none",
};

const KOTLIN_CONFIG: LanguageConfig = {
  name: "kotlin",
  displayName: "Kotlin",
  extensions: ["kt", "kts"],
  patterns: {
    function:
      /(?:(?:public|private|protected|internal)\s+)?(?:(?:suspend|inline|infix|operator|override)\s+)*fun\s+(?:<[^>]*>\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\s{=]+))?\s*[{=]/g,
    class:
      /(?:(?:public|private|protected|internal)\s+)?(?:(?:abstract|open|data|sealed|inner|enum)\s+)*class\s+(\w+)(?:<[^>]*>)?(?:\s*\([^)]*\))?(?:\s*:\s*[\w(),\s]+)?\s*\{?/g,
    interface:
      /(?:(?:public|private|protected|internal)\s+)?interface\s+(\w+)(?:<[^>]*>)?(?:\s*:\s*[\w,\s]+)?\s*\{/g,
    import: /import\s+([\w.*]+)/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\*\*[\s\S]*?\*\//g,
    stringLiteral: /(?:"""[\s\S]*?"""|"(?:[^"\\]|\\.)*")/g,
  },
  buildCommands: ["gradle build", "./gradlew build", "mvn compile"],
  testCommands: ["gradle test", "./gradlew test", "mvn test"],
  lintCommands: ["ktlint", "detekt"],
  packageFiles: ["build.gradle.kts", "build.gradle", "pom.xml"],
  lockFiles: ["gradle.lockfile"],
  namingConvention: "camelCase",
  fileNaming: "PascalCase",
  importStyle: "absolute",
  docCommentPrefix: "/**",
  docCommentStyle: "javadoc",
};

const DART_CONFIG: LanguageConfig = {
  name: "dart",
  displayName: "Dart",
  extensions: ["dart"],
  patterns: {
    function:
      /(?:(?:static|external)\s+)?(?:Future<[\w<>?]+>|[\w<>?]+)\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*(?:async\*?|sync\*))?\s*\{/g,
    class:
      /(?:abstract\s+)?class\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+\w+)?(?:\s+with\s+[\w,\s]+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    interface:
      /(?:abstract\s+)?class\s+(\w+)(?:<[^>]*>)?\s*\{/g,
    import:
      /import\s+'([^']+)'/g,
    export: /export\s+'([^']+)'/g,
    singleLineComment: /\/\/.*/g,
    multiLineComment: { start: /\/\*/g, end: /\*\//g },
    docComment: /\/\/\/.*(?:\n\/\/\/.*)*/g,
    stringLiteral:
      /(?:r?"""[\s\S]*?"""|r?'''[\s\S]*?'''|r?"(?:[^"\\]|\\.)*"|r?'(?:[^'\\]|\\.)*')/g,
  },
  buildCommands: ["dart compile", "flutter build"],
  testCommands: ["dart test", "flutter test"],
  lintCommands: ["dart analyze", "flutter analyze"],
  packageFiles: ["pubspec.yaml"],
  lockFiles: ["pubspec.lock"],
  namingConvention: "camelCase",
  fileNaming: "snake_case",
  importStyle: "package",
  docCommentPrefix: "///",
  docCommentStyle: "none",
};

const SHELL_CONFIG: LanguageConfig = {
  name: "shell",
  displayName: "Shell",
  extensions: ["sh", "bash", "zsh", "fish"],
  shebangs: ["bash", "sh", "zsh", "fish"],
  patterns: {
    function: /(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/g,
    class: /(?!)/g, // no classes in shell
    import: /(?:source|\.)[ \t]+['"]?([^'";\s]+)['"]?/g,
    singleLineComment: /#.*/g,
    multiLineComment: { start: /<<'?COMMENT'?/g, end: /^COMMENT$/gm },
    stringLiteral: /(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$'(?:[^'\\]|\\.)*')/g,
  },
  buildCommands: [],
  testCommands: ["bats", "shunit2"],
  lintCommands: ["shellcheck"],
  packageFiles: [],
  lockFiles: [],
  namingConvention: "snake_case",
  fileNaming: "kebab-case",
  importStyle: "relative",
  docCommentPrefix: "#",
  docCommentStyle: "none",
};

/** Map of all built-in language configurations. */
const BUILTIN_LANGUAGES: Record<SupportedLanguage, LanguageConfig> = {
  typescript: TYPESCRIPT_CONFIG,
  javascript: JAVASCRIPT_CONFIG,
  python: PYTHON_CONFIG,
  go: GO_CONFIG,
  rust: RUST_CONFIG,
  java: JAVA_CONFIG,
  c: C_CONFIG,
  cpp: CPP_CONFIG,
  ruby: RUBY_CONFIG,
  php: PHP_CONFIG,
  swift: SWIFT_CONFIG,
  kotlin: KOTLIN_CONFIG,
  dart: DART_CONFIG,
  shell: SHELL_CONFIG,
  unknown: {
    name: "unknown",
    displayName: "Unknown",
    extensions: [],
    patterns: {
      function: /(?!)/g,
      class: /(?!)/g,
      import: /(?!)/g,
      singleLineComment: /(?!)/g,
      multiLineComment: { start: /(?!)/g, end: /(?!)/g },
      stringLiteral: /(?!)/g,
    },
    buildCommands: [],
    testCommands: [],
    lintCommands: [],
    packageFiles: [],
    lockFiles: [],
    namingConvention: "camelCase",
    fileNaming: "kebab-case",
    importStyle: "relative",
    docCommentPrefix: "//",
    docCommentStyle: "none",
  },
};

/** Extension to language lookup table. */
const EXTENSION_MAP: Record<string, SupportedLanguage> = {};
for (const [lang, config] of Object.entries(BUILTIN_LANGUAGES)) {
  for (const ext of config.extensions) {
    EXTENSION_MAP[ext] = lang as SupportedLanguage;
  }
}

// ─── Project Type Detection Patterns ───

interface ProjectDetectionRule {
  name: string;
  language: SupportedLanguage;
  framework?: string;
  /** Files that trigger this detection. */
  triggerFiles: string[];
  /** Content patterns in specific files. */
  contentPatterns?: { file: string; pattern: RegExp }[];
  suggestedTools: string[];
}

const PROJECT_DETECTION_RULES: ProjectDetectionRule[] = [
  // JavaScript / TypeScript frameworks
  {
    name: "Next.js",
    language: "typescript",
    framework: "nextjs",
    triggerFiles: ["next.config.js", "next.config.mjs", "next.config.ts"],
    suggestedTools: [
      "eslint",
      "prettier",
      "jest",
      "playwright",
      "next lint",
    ],
  },
  {
    name: "Express",
    language: "typescript",
    framework: "express",
    triggerFiles: [],
    contentPatterns: [
      { file: "package.json", pattern: /"express"\s*:/ },
    ],
    suggestedTools: ["eslint", "jest", "supertest"],
  },
  {
    name: "React (Vite)",
    language: "typescript",
    framework: "react-vite",
    triggerFiles: ["vite.config.ts", "vite.config.js"],
    contentPatterns: [
      { file: "package.json", pattern: /"react"\s*:/ },
    ],
    suggestedTools: ["eslint", "vitest", "playwright"],
  },
  {
    name: "Vue.js",
    language: "typescript",
    framework: "vue",
    triggerFiles: [],
    contentPatterns: [
      { file: "package.json", pattern: /"vue"\s*:/ },
    ],
    suggestedTools: ["eslint", "vitest", "vue-tsc"],
  },
  {
    name: "Svelte",
    language: "typescript",
    framework: "svelte",
    triggerFiles: ["svelte.config.js", "svelte.config.ts"],
    suggestedTools: ["eslint", "svelte-check", "vitest"],
  },
  // Python frameworks
  {
    name: "Django",
    language: "python",
    framework: "django",
    triggerFiles: ["manage.py"],
    contentPatterns: [
      { file: "requirements.txt", pattern: /django/i },
    ],
    suggestedTools: ["pytest-django", "ruff", "mypy", "black"],
  },
  {
    name: "Flask",
    language: "python",
    framework: "flask",
    triggerFiles: [],
    contentPatterns: [
      { file: "requirements.txt", pattern: /flask/i },
      { file: "pyproject.toml", pattern: /flask/i },
    ],
    suggestedTools: ["pytest", "ruff", "mypy"],
  },
  {
    name: "FastAPI",
    language: "python",
    framework: "fastapi",
    triggerFiles: [],
    contentPatterns: [
      { file: "requirements.txt", pattern: /fastapi/i },
      { file: "pyproject.toml", pattern: /fastapi/i },
    ],
    suggestedTools: ["pytest", "ruff", "mypy", "uvicorn"],
  },
  // Go
  {
    name: "Go Project",
    language: "go",
    triggerFiles: ["go.mod"],
    suggestedTools: ["golangci-lint", "go vet", "go test"],
  },
  // Rust
  {
    name: "Rust Project",
    language: "rust",
    triggerFiles: ["Cargo.toml"],
    suggestedTools: ["cargo clippy", "cargo test", "cargo fmt"],
  },
  // Java / Kotlin
  {
    name: "Spring Boot",
    language: "java",
    framework: "spring",
    triggerFiles: [],
    contentPatterns: [
      { file: "pom.xml", pattern: /spring-boot/ },
      { file: "build.gradle", pattern: /spring-boot/ },
      { file: "build.gradle.kts", pattern: /spring-boot/ },
    ],
    suggestedTools: ["maven", "gradle", "junit", "checkstyle"],
  },
  {
    name: "Android (Kotlin)",
    language: "kotlin",
    framework: "android",
    triggerFiles: [],
    contentPatterns: [
      {
        file: "build.gradle.kts",
        pattern: /com\.android\.application/,
      },
      {
        file: "build.gradle",
        pattern: /com\.android\.application/,
      },
    ],
    suggestedTools: ["gradle", "ktlint", "detekt"],
  },
  // Swift
  {
    name: "Swift Package",
    language: "swift",
    triggerFiles: ["Package.swift"],
    suggestedTools: ["swift build", "swift test", "swiftlint"],
  },
  {
    name: "iOS App",
    language: "swift",
    framework: "uikit",
    triggerFiles: [],
    contentPatterns: [
      {
        file: "*.xcodeproj/project.pbxproj",
        pattern: /iphoneos/i,
      },
    ],
    suggestedTools: ["xcodebuild", "swiftlint", "xctest"],
  },
  // Dart / Flutter
  {
    name: "Flutter",
    language: "dart",
    framework: "flutter",
    triggerFiles: [],
    contentPatterns: [
      { file: "pubspec.yaml", pattern: /flutter:/ },
    ],
    suggestedTools: ["flutter analyze", "flutter test", "dart fix"],
  },
  {
    name: "Dart Project",
    language: "dart",
    triggerFiles: ["pubspec.yaml"],
    suggestedTools: ["dart analyze", "dart test"],
  },
  // Ruby
  {
    name: "Ruby on Rails",
    language: "ruby",
    framework: "rails",
    triggerFiles: ["Rakefile", "config/routes.rb"],
    contentPatterns: [
      { file: "Gemfile", pattern: /rails/ },
    ],
    suggestedTools: ["rubocop", "rspec", "bundler"],
  },
  // PHP
  {
    name: "Laravel",
    language: "php",
    framework: "laravel",
    triggerFiles: ["artisan"],
    contentPatterns: [
      { file: "composer.json", pattern: /laravel\/framework/ },
    ],
    suggestedTools: ["phpstan", "phpunit", "pint"],
  },
];

const MONOREPO_INDICATORS = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "turbo.json",
  "rush.json",
  "packages",
  "apps",
];

// ─── LanguageSupport Class ───

/**
 * Provides multi-language intelligence for the YUAN coding agent.
 *
 * Supports language detection (by extension and content), parsing pattern access,
 * tool configuration, code generation hints, and project type detection.
 */
export class LanguageSupport {
  private readonly configs: Map<SupportedLanguage, LanguageConfig>;
  private readonly extMap: Map<string, SupportedLanguage>;

  /**
   * Creates a new LanguageSupport instance.
   * @param config Optional configuration for additional languages or overrides.
   */
  constructor(config?: LanguageSupportConfig) {
    this.configs = new Map();
    this.extMap = new Map(Object.entries(EXTENSION_MAP) as [string, SupportedLanguage][]);

    // Load built-in configs
    for (const [lang, cfg] of Object.entries(BUILTIN_LANGUAGES)) {
      this.configs.set(lang as SupportedLanguage, { ...cfg });
    }

    // Apply overrides
    if (config?.overrides) {
      for (const [lang, overrides] of Object.entries(config.overrides)) {
        const existing = this.configs.get(lang as SupportedLanguage);
        if (existing && overrides) {
          this.configs.set(lang as SupportedLanguage, {
            ...existing,
            ...overrides,
          } as LanguageConfig);
        }
      }
    }

    // Register additional languages
    if (config?.additionalLanguages) {
      for (const langConfig of config.additionalLanguages) {
        this.configs.set(langConfig.name, langConfig);
        for (const ext of langConfig.extensions) {
          this.extMap.set(ext, langConfig.name);
        }
      }
    }
  }

  // ─── Detection ───

  /**
   * Detects the programming language of a file.
   * First checks file extension, then falls back to content-based detection.
   * @param filePath File path to detect language from.
   * @param content Optional file content for shebang/syntax detection.
   * @returns Detected language identifier.
   */
  detectLanguage(filePath: string, content?: string): SupportedLanguage {
    // 1. Try extension
    const ext = extname(filePath).replace(/^\./, "").toLowerCase();
    const byExt = this.extMap.get(ext);
    if (byExt) return byExt;

    // Special filename handling
    const name = basename(filePath).toLowerCase();
    if (name === "makefile" || name === "gnumakefile") return "c";
    if (name === "rakefile") return "ruby";
    if (name === "gemfile") return "ruby";
    if (name === "dockerfile") return "shell";

    // 2. Try content-based detection
    if (content) {
      return this.detectFromContent(content);
    }

    return "unknown";
  }

  /**
   * Detects project types from a list of files present in the project.
   * @param files List of file paths (relative or absolute).
   * @param readFile Optional function to read file content for pattern matching.
   * @returns Array of detected project types, sorted by specificity.
   */
  detectProjectType(
    files: string[],
    readFile?: (path: string) => string | null,
  ): ProjectType[] {
    const fileSet = new Set(files.map((f) => basename(f)));
    const results: ProjectType[] = [];
    const isMonorepo = MONOREPO_INDICATORS.some((indicator) =>
      files.some(
        (f) => basename(f) === indicator || f.includes(`/${indicator}/`),
      ),
    );

    for (const rule of PROJECT_DETECTION_RULES) {
      let detected = false;
      let detectedBy = "";

      // Check trigger files
      for (const trigger of rule.triggerFiles) {
        if (fileSet.has(trigger) || files.some((f) => f.endsWith(trigger))) {
          detected = true;
          detectedBy = trigger;
          break;
        }
      }

      // Check content patterns (if readFile provided and not yet detected)
      if (!detected && rule.contentPatterns && readFile) {
        for (const { file, pattern } of rule.contentPatterns) {
          const matchingFiles = files.filter((f) => {
            const b = basename(f);
            if (file.includes("*")) {
              const re = new RegExp(
                "^" + file.replace(/\*/g, ".*") + "$",
              );
              return re.test(b) || re.test(f);
            }
            return b === file || f.endsWith(file);
          });

          for (const mf of matchingFiles) {
            const content = readFile(mf);
            if (content && pattern.test(content)) {
              detected = true;
              detectedBy = `${file} (content match)`;
              break;
            }
          }
          if (detected) break;
        }
      }

      if (detected) {
        results.push({
          name: rule.name,
          language: rule.language,
          framework: rule.framework,
          isMonorepo,
          detectedBy,
          suggestedTools: rule.suggestedTools,
        });
      }
    }

    return results;
  }

  // ─── Config Access ───

  /**
   * Returns the full configuration for a language.
   * @param language Language to get config for.
   * @returns Language configuration.
   */
  getConfig(language: SupportedLanguage): LanguageConfig {
    return this.configs.get(language) ?? BUILTIN_LANGUAGES.unknown;
  }

  /**
   * Returns parsing patterns for a language.
   * @param language Language to get patterns for.
   * @returns Language patterns.
   */
  getPatterns(language: SupportedLanguage): LanguagePatterns {
    return this.getConfig(language).patterns;
  }

  /**
   * Returns all registered language identifiers.
   * @returns Array of supported language names.
   */
  getAllLanguages(): SupportedLanguage[] {
    return [...this.configs.keys()];
  }

  // ─── Language-Specific Helpers ───

  /**
   * Returns the primary build command for a language, optionally specialized by project type.
   * @param language Target language.
   * @param projectType Optional project type/framework name.
   * @returns Build command string.
   */
  getBuildCommand(language: SupportedLanguage, projectType?: string): string {
    const config = this.getConfig(language);

    // Project-type specific overrides
    if (projectType) {
      const pt = projectType.toLowerCase();
      if (pt === "nextjs" || pt === "next.js") return "next build";
      if (pt === "vite" || pt === "react-vite") return "vite build";
      if (pt === "flutter") return "flutter build";
      if (pt === "android") return "./gradlew assembleDebug";
      if (pt === "spring") return "mvn package";
      if (pt === "rails") return "bundle exec rake assets:precompile";
      if (pt === "laravel") return "composer install --optimize-autoloader";
    }

    return config.buildCommands[0] ?? "";
  }

  /**
   * Returns the primary test command for a language, optionally specialized by project type.
   * @param language Target language.
   * @param projectType Optional project type/framework name.
   * @returns Test command string.
   */
  getTestCommand(language: SupportedLanguage, projectType?: string): string {
    const config = this.getConfig(language);

    if (projectType) {
      const pt = projectType.toLowerCase();
      if (pt === "nextjs" || pt === "next.js") return "jest --config jest.config.ts";
      if (pt === "django") return "python manage.py test";
      if (pt === "flutter") return "flutter test";
      if (pt === "rails") return "bundle exec rspec";
      if (pt === "laravel") return "php artisan test";
    }

    return config.testCommands[0] ?? "";
  }

  /**
   * Returns the primary lint command for a language, optionally specialized by project type.
   * @param language Target language.
   * @param projectType Optional project type/framework name.
   * @returns Lint command string.
   */
  getLintCommand(language: SupportedLanguage, projectType?: string): string {
    const config = this.getConfig(language);

    if (projectType) {
      const pt = projectType.toLowerCase();
      if (pt === "nextjs" || pt === "next.js") return "next lint";
      if (pt === "flutter") return "flutter analyze";
    }

    return config.lintCommands[0] ?? "";
  }

  /**
   * Returns the primary package manifest file name for a language.
   * @param language Target language.
   * @returns Package file name, or null if not applicable.
   */
  getPackageFile(language: SupportedLanguage): string | null {
    const config = this.getConfig(language);
    return config.packageFiles[0] ?? null;
  }

  // ─── Parsing Helpers ───

  /**
   * Extracts function/method declarations from source code.
   * @param content Source code content.
   * @param language Language of the source code.
   * @returns Array of parsed function symbols.
   */
  extractFunctions(content: string, language: SupportedLanguage): ParsedSymbol[] {
    const patterns = this.getPatterns(language);
    const regex = new RegExp(patterns.function.source, patterns.function.flags);
    const results: ParsedSymbol[] = [];
    const lines = content.split("\n");

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const line = this.getLineNumber(content, match.index);
      const name = this.extractName(match, language);
      if (!name) continue;

      const visibility = this.extractVisibility(
        lines[line - 1] ?? "",
        language,
      );

      results.push({
        name,
        line,
        params: match[2]?.trim() || undefined,
        returnType: match[3]?.trim() || undefined,
        visibility,
      });
    }

    return results;
  }

  /**
   * Extracts class/struct declarations from source code.
   * @param content Source code content.
   * @param language Language of the source code.
   * @returns Array of parsed class symbols.
   */
  extractClasses(content: string, language: SupportedLanguage): ParsedSymbol[] {
    const patterns = this.getPatterns(language);
    const regex = new RegExp(patterns.class.source, patterns.class.flags);
    const results: ParsedSymbol[] = [];

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const line = this.getLineNumber(content, match.index);
      const name = match[1];
      if (!name) continue;

      const lineText = content.split("\n")[line - 1] ?? "";
      const visibility = this.extractVisibility(lineText, language);

      results.push({ name, line, visibility });
    }

    return results;
  }

  /**
   * Extracts import statements from source code.
   * @param content Source code content.
   * @param language Language of the source code.
   * @returns Array of parsed imports.
   */
  extractImports(content: string, language: SupportedLanguage): ParsedImport[] {
    const patterns = this.getPatterns(language);
    const regex = new RegExp(patterns.import.source, patterns.import.flags);
    const results: ParsedImport[] = [];

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const line = this.getLineNumber(content, match.index);
      const fullMatch = match[0];

      // Extract source — use first non-empty capture group
      let source = "";
      for (let i = 1; i < match.length; i++) {
        if (match[i]) {
          source = match[i];
          break;
        }
      }
      if (!source) continue;

      // Extract named imports
      const names: string[] = [];
      const namedMatch = fullMatch.match(/\{([^}]+)\}/);
      if (namedMatch) {
        names.push(
          ...namedMatch[1]
            .split(",")
            .map((n) => n.trim().replace(/\s+as\s+\w+/, ""))
            .filter(Boolean),
        );
      }

      // Detect default import
      const isDefault =
        !namedMatch &&
        !fullMatch.includes("*") &&
        (language === "typescript" ||
          language === "javascript" ||
          language === "python");

      results.push({ source, names, line, isDefault });
    }

    return results;
  }

  // ─── Naming ───

  /**
   * Converts a name to the naming convention of the target language.
   * @param name Name to convert (supports camelCase, snake_case, PascalCase, kebab-case input).
   * @param language Target language.
   * @returns Converted name.
   */
  toLanguageConvention(name: string, language: SupportedLanguage): string {
    const config = this.getConfig(language);
    const words = this.splitWords(name);
    if (words.length === 0) return name;

    switch (config.namingConvention) {
      case "camelCase":
        return (
          words[0].toLowerCase() +
          words
            .slice(1)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join("")
        );
      case "snake_case":
        return words.map((w) => w.toLowerCase()).join("_");
      case "PascalCase":
        return words
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join("");
      case "kebab-case":
        return words.map((w) => w.toLowerCase()).join("-");
      default:
        return name;
    }
  }

  /**
   * Returns the file naming convention description for a language.
   * @param language Target language.
   * @returns File naming convention string.
   */
  getFileNameConvention(language: SupportedLanguage): string {
    const config = this.getConfig(language);
    const examples: Record<string, string> = {
      camelCase: "myComponent.ts",
      snake_case: "my_component.py",
      PascalCase: "MyComponent.java",
      "kebab-case": "my-component.ts",
    };
    return `${config.fileNaming} (e.g., ${examples[config.fileNaming] ?? "file.ext"})`;
  }

  // ─── Private Helpers ───

  /**
   * Detects language from file content (shebangs and syntax patterns).
   */
  private detectFromContent(content: string): SupportedLanguage {
    // Check shebang
    const shebangMatch = content.match(/^#!\s*(?:\/usr\/bin\/env\s+)?(\w+)/);
    if (shebangMatch) {
      const interpreter = shebangMatch[1].toLowerCase();
      for (const [, config] of this.configs) {
        if (config.shebangs?.some((s) => interpreter.includes(s))) {
          return config.name;
        }
      }
    }

    // Heuristic: check for language-specific syntax patterns
    if (
      content.includes("<?php") ||
      content.match(/^\s*<\?(?:php)?/m)
    ) {
      return "php";
    }
    if (content.match(/^package\s+\w+/m) && content.includes("func ")) {
      return "go";
    }
    if (
      content.match(/^use\s+\w+::/m) ||
      content.match(/^fn\s+\w+/m)
    ) {
      return "rust";
    }
    if (
      content.match(/^import\s+\w+/m) &&
      content.match(/^(?:public\s+)?class\s+\w+/m)
    ) {
      // Could be Java or Kotlin — check for Kotlin-specific syntax
      if (
        content.includes("fun ") ||
        content.includes("val ") ||
        content.includes("var ")
      ) {
        return "kotlin";
      }
      return "java";
    }
    if (
      content.match(/^import\s+(?:Foundation|UIKit|SwiftUI)/m) ||
      content.match(/^(?:struct|class)\s+\w+\s*:\s*(?:View|ObservableObject)/m)
    ) {
      return "swift";
    }
    if (
      content.match(/^import\s+'/m) ||
      content.match(/^class\s+\w+\s+extends\s+State(?:less|ful)Widget/m)
    ) {
      return "dart";
    }
    if (
      content.match(/^(?:def|class)\s+/m) &&
      content.match(/:\s*$/m) &&
      !content.includes("{")
    ) {
      return "python";
    }
    if (
      content.match(/^(?:require|module\.exports)/m) ||
      content.match(/^(?:const|let|var)\s+\w+\s*=\s*require\(/m)
    ) {
      return "javascript";
    }
    if (
      content.match(/^import\s+.*from\s+['"]/m) ||
      content.match(/^(?:interface|type)\s+\w+/m)
    ) {
      return "typescript";
    }
    if (
      content.match(/^(?:require|gem|class)\s+/m) &&
      content.match(/\bdo\b.*\|/)
    ) {
      return "ruby";
    }

    return "unknown";
  }

  /** Returns the 1-based line number for a character index. */
  private getLineNumber(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
      if (content[i] === "\n") line++;
    }
    return line;
  }

  /** Extracts function name from a regex match, handling language-specific patterns. */
  private extractName(
    match: RegExpExecArray,
    language: SupportedLanguage,
  ): string | null {
    // Ruby: function pattern captures `self.` in group 1, name in group 2
    if (language === "ruby") {
      return match[2] ?? match[1] ?? null;
    }
    return match[1] ?? null;
  }

  /** Detects visibility modifier from a line of code. */
  private extractVisibility(
    line: string,
    language: SupportedLanguage,
  ): "public" | "private" | "protected" | undefined {
    const trimmed = line.trimStart();

    switch (language) {
      case "typescript":
      case "java":
      case "kotlin":
      case "swift":
      case "php":
      case "dart":
      case "cpp":
        if (trimmed.startsWith("private")) return "private";
        if (trimmed.startsWith("protected")) return "protected";
        if (trimmed.startsWith("public")) return "public";
        // In TS/Java, no modifier defaults to public (TS) or package-private (Java)
        if (language === "typescript") return "public";
        return undefined;
      case "python":
        if (trimmed.match(/def\s+__\w+/)) return "private";
        if (trimmed.match(/def\s+_\w+/)) return "protected";
        return "public";
      case "rust":
        if (trimmed.startsWith("pub")) return "public";
        return "private";
      case "go":
        // Go uses capitalization for visibility
        // Handled at call site via name
        return undefined;
      case "ruby":
        // Ruby visibility is context-dependent — simplified here
        return undefined;
      default:
        return undefined;
    }
  }

  /** Splits a name into words (handles camelCase, snake_case, PascalCase, kebab-case). */
  private splitWords(name: string): string[] {
    return name
      .replace(/[-_]/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/)
      .filter(Boolean);
  }
}
