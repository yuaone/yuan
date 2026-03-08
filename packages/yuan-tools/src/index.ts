/**
 * @yuan/tools — YUAN Agent Tool Implementations
 *
 * Provides the complete tool system for the YUAN coding agent:
 * file_read, file_write, file_edit, shell_exec, grep, glob, git_ops
 */

// Types
export type {
  ParameterDef,
  RiskLevel,
  ToolDefinition,
  ToolCall,
  ToolResult,
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

// Registry
export { ToolRegistry, createDefaultRegistry } from './tool-registry.js';

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
