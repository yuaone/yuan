/**
 * @yuan/tools — YUAN Agent Tool Implementations
 *
 * Provides the complete tool system for the YUAN coding agent:
 * file_read, file_write, file_edit, shell_exec, grep, glob, git_ops, test_run, code_search, security_scan
 */

// Core types (re-exported from @yuan/core via types.ts)
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolParameterSchema,
} from '@yuan/core';

// Tool-local types
export type {
  ParameterDef,
  RiskLevel,
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  FileWriteOutput,
  FileEditInput,
  FileEditOutput,
  ShellExecInput,
  ShellExecOutput,
  GrepInput,
  GrepMatch,
  GrepOutput,
  GlobInput,
  GlobOutput,
  GitOperation,
  GitOpsInput,
  GitOpsOutput,
  TestRunInput,
  TestRunOutput,
  CodeSearchMode,
  CodeSearchInput,
  CodeSearchResult,
  CodeSearchOutput,
} from './types.js';

// Base class
export { BaseTool } from './base-tool.js';

// Tool implementations
export { FileReadTool } from './file-read.js';
export { FileWriteTool } from './file-write.js';
export { FileEditTool } from './file-edit.js';
export { ShellExecTool } from './shell-exec.js';
export { GrepTool } from './grep.js';
export { GlobTool } from './glob.js';
export { GitOpsTool } from './git-ops.js';
export { TestRunTool } from './test-run.js';
export { CodeSearchTool } from './code-search.js';
export { SecurityScanTool } from './security-scan.js';
export type { SecurityFinding, SecurityReport, FindingSeverity } from './security-scan.js';
export { BrowserTool } from './browser-tool.js';

// Registry
export { ToolRegistry, createDefaultRegistry, createDesignRegistry } from './tool-registry.js';

// Dev Server Manager (Design Mode)
export { DevServerManager } from './dev-server-manager.js';
export type { DevServerManagerEvents } from './dev-server-manager.js';

// Design Mode Tools
export {
  DesignSnapshotTool,
  DesignScreenshotTool,
  DesignNavigateTool,
  DesignResizeTool,
  DesignInspectTool,
  DesignScrollTool,
  createDesignTools,
  setDesignBrowserSession,
  clearDesignBrowserSession,
} from './design-tools.js';

// Validators
export {
  validatePath,
  validateNoShellMeta,
  validateCommand,
  isSensitiveFile,
  isBinaryFile,
  isImageFile,
  truncateOutput,
  detectLanguage,
} from './validators.js';
