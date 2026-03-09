/**
 * @yuaone/tools — Type definitions
 *
 * Core types (ToolDefinition, ToolCall, ToolResult, etc.) are re-exported from @yuaone/core.
 * Tool-specific I/O types remain here.
 */

// ─── Re-export core types ───────────────────────────────────────────
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolParameterSchema,
} from '@yuaone/core';

// ─── Parameter Definition (tools-local, used by BaseTool subclasses) ─
export interface ParameterDef {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  items?: ParameterDef;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// ─── Tool-specific I/O types ─────────────────────────────────────────

// file_read
export interface FileReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface FileReadOutput {
  content: string;
  totalLines: number;
  language: string;
  truncated: boolean;
}

// file_write
export interface FileWriteInput {
  path: string;
  content: string;
  createDirectories?: boolean;
}

export interface FileWriteOutput {
  bytesWritten: number;
  created: boolean;
}

// file_edit
export interface FileEditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface FileEditOutput {
  replacements: number;
  preview: string;
}

// shell_exec
export interface ShellExecInput {
  executable: string;
  args: string[];
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ShellExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// grep
export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  maxResults?: number;
  context?: number;
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface GrepOutput {
  matches: GrepMatch[];
  totalMatches: number;
  truncated: boolean;
}

// glob
export interface GlobInput {
  pattern: string;
  path?: string;
  maxResults?: number;
}

export interface GlobOutput {
  files: string[];
  totalMatches: number;
  truncated: boolean;
}

// git_ops
export type GitOperation =
  | 'status'
  | 'diff'
  | 'log'
  | 'add'
  | 'commit'
  | 'create_branch'
  | 'stash'
  | 'restore';

export interface GitOpsInput {
  operation: GitOperation;
  message?: string;
  files?: string[];
  count?: number;
  branch?: string;
}

export interface GitOpsOutput {
  result: string;
  success: boolean;
}

// test_run
export interface TestRunInput {
  testPath?: string;
  framework?: 'jest' | 'vitest' | 'pytest' | 'auto';
  coverage?: boolean;
}

export interface TestRunOutput {
  passed: number;
  failed: number;
  skipped: number;
  coverage?: number;
  failedTests: Array<{ name: string; error: string }>;
  stdout: string;
}

// code_search
export type CodeSearchMode = 'symbol' | 'reference' | 'definition';

export interface CodeSearchInput {
  query: string;
  mode?: CodeSearchMode;
  path?: string;
  language?: string;
  maxResults?: number;
}

export interface CodeSearchResult {
  file: string;
  line: number;
  column: number;
  content: string;
  kind: string;
}

export interface CodeSearchOutput {
  results: CodeSearchResult[];
  totalCount: number;
}
