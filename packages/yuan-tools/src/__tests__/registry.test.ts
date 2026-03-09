/**
 * @yuaone/tools — ToolRegistry unit tests
 *
 * Tests registry: default tools, get/has, definitions, executor.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry, createDefaultRegistry } from '../tool-registry.js';
import { FileReadTool } from '../file-read.js';

const EXPECTED_TOOL_NAMES = [
  'file_read',
  'file_write',
  'file_edit',
  'shell_exec',
  'grep',
  'glob',
  'git_ops',
  'test_run',
  'code_search',
  'security_scan',
];

describe('ToolRegistry', () => {
  // 1. Default registry has 9 tools registered
  it('should create default registry with 10 tools', () => {
    const registry = createDefaultRegistry();
    assert.equal(registry.size, 10);
  });

  // 2. All expected tool names present
  it('should contain all expected tool names', () => {
    const registry = createDefaultRegistry();
    const names = registry.listNames();
    for (const name of EXPECTED_TOOL_NAMES) {
      assert.ok(names.includes(name), `Missing tool: ${name}`);
    }
  });

  // 3. Get tool returns correct tool by name
  it('should return correct tool by name', () => {
    const registry = createDefaultRegistry();
    const tool = registry.get('file_read');
    assert.ok(tool !== undefined);
    assert.equal(tool.name, 'file_read');
  });

  // 4. Unknown tool returns undefined
  it('should return undefined for unknown tool', () => {
    const registry = createDefaultRegistry();
    const tool = registry.get('nonexistent_tool');
    assert.equal(tool, undefined);
  });

  // 5. Each tool has valid input_schema (parameters with type: 'object')
  it('should generate valid definitions for each tool', () => {
    const registry = createDefaultRegistry();
    const definitions = registry.toDefinitions();
    assert.equal(definitions.length, 10);
    for (const def of definitions) {
      assert.ok(typeof def.name === 'string' && def.name.length > 0);
      assert.ok(typeof def.description === 'string' && def.description.length > 0);
      assert.ok(def.parameters !== undefined);
      assert.equal(def.parameters.type, 'object');
      assert.ok(def.parameters.properties !== undefined);
    }
  });

  // 6. toExecutor returns a function-based executor
  it('should create executor with definitions and execute function', () => {
    const registry = createDefaultRegistry();
    const executor = registry.toExecutor('/tmp/test');
    assert.ok(executor.definitions.length === 10);
    assert.ok(typeof executor.execute === 'function');
  });

  // 7. Duplicate registration throws
  it('should throw on duplicate tool registration', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    assert.throws(
      () => registry.register(new FileReadTool()),
      /already registered/
    );
  });

  // 8. Execute unknown tool returns error result
  it('should return error result for unknown tool execution', async () => {
    const registry = createDefaultRegistry();
    const result = await registry.execute('nonexistent', { _toolCallId: 'x' }, '/tmp');
    assert.equal(result.success, false);
    assert.ok(result.output.includes('Unknown tool'));
  });
});
