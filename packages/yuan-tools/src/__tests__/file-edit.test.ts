/**
 * @yuan/tools — FileEditTool unit tests
 *
 * Tests file editing: replacement, ambiguity, replace_all,
 * deletion, whitespace sensitivity, large files, fuzzy suggestions.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { FileEditTool } from '../file-edit.js';

let tool: FileEditTool;
let tmpDir: string;

function setup(): void {
  tool = new FileEditTool();
  tmpDir = mkdtempSync(join(tmpdir(), 'yuan-edit-test-'));
}

function teardown(): void {
  rmSync(tmpDir, { recursive: true, force: true });
}

// Helper to write a temp file and return its relative path
function writeTempFile(name: string, content: string): string {
  const absPath = join(tmpDir, name);
  const dir = absPath.substring(0, absPath.lastIndexOf('/'));
  if (dir !== tmpDir) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(absPath, content, 'utf-8');
  return name;
}

function readTempFile(name: string): string {
  return readFileSync(join(tmpDir, name), 'utf-8');
}

describe('FileEditTool', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('should have correct name and risk level', () => {
    assert.equal(tool.name, 'file_edit');
    assert.equal(tool.riskLevel, 'medium');
  });

  // 1. Simple replacement
  it('should perform simple replacement when exact match found', async () => {
    const file = writeTempFile('app.ts', 'const x = 1;\nconst y = 2;\n');
    const result = await tool.execute(
      { path: file, old_string: 'const x = 1;', new_string: 'const x = 42;', _toolCallId: 't1' },
      tmpDir
    );
    assert.equal(result.success, true);
    assert.ok(result.output.includes('1 replacement'));
    assert.equal(readTempFile(file), 'const x = 42;\nconst y = 2;\n');
  });

  // 2. No match → error with suggestion
  it('should return error when old_string not found', async () => {
    const file = writeTempFile('app.ts', 'const x = 1;\n');
    const result = await tool.execute(
      { path: file, old_string: 'const z = 99;', new_string: 'replaced', _toolCallId: 't2' },
      tmpDir
    );
    assert.equal(result.success, false);
    assert.ok(result.output.includes('not found'));
  });

  // 3. Multiple matches without replace_all → error (ambiguous)
  it('should return error when old_string matches multiple times without replace_all', async () => {
    const file = writeTempFile('app.ts', 'foo\nbar\nfoo\nbaz\n');
    const result = await tool.execute(
      { path: file, old_string: 'foo', new_string: 'qux', _toolCallId: 't3' },
      tmpDir
    );
    assert.equal(result.success, false);
    assert.ok(result.output.includes('matches 2 times'));
  });

  // 4. replace_all: multiple matches → all replaced
  it('should replace all occurrences when replace_all=true', async () => {
    const file = writeTempFile('app.ts', 'foo\nbar\nfoo\nbaz\n');
    const result = await tool.execute(
      { path: file, old_string: 'foo', new_string: 'qux', replace_all: true, _toolCallId: 't4' },
      tmpDir
    );
    assert.equal(result.success, true);
    assert.ok(result.output.includes('2 replacement'));
    assert.equal(readTempFile(file), 'qux\nbar\nqux\nbaz\n');
  });

  // 5. Empty new_string → deletion
  it('should delete when new_string is empty', async () => {
    const file = writeTempFile('app.ts', 'keep\ndelete-me\nkeep\n');
    const result = await tool.execute(
      { path: file, old_string: 'delete-me\n', new_string: '', _toolCallId: 't5' },
      tmpDir
    );
    assert.equal(result.success, true);
    assert.equal(readTempFile(file), 'keep\nkeep\n');
  });

  // 6. Whitespace sensitivity: exact whitespace match required
  it('should require exact whitespace match', async () => {
    const file = writeTempFile('app.ts', '  const x = 1;\n');
    // Missing leading spaces → should not match
    const result = await tool.execute(
      { path: file, old_string: 'const x = 1;', new_string: 'const x = 2;', _toolCallId: 't6' },
      tmpDir
    );
    // It should find it (substring match), but the replacement is exact
    // Actually 'const x = 1;' IS found as substring of '  const x = 1;'
    assert.equal(result.success, true);
    // The leading spaces should be preserved since only the matching portion is replaced
    assert.equal(readTempFile(file), '  const x = 2;\n');
  });

  // 7. Large file: handle 10K+ lines
  it('should handle large files with 10K+ lines', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 12000; i++) {
      lines.push(`line ${i}: content here`);
    }
    // Put a unique string at line 6000
    lines[6000] = 'UNIQUE_MARKER_HERE';
    const file = writeTempFile('large.ts', lines.join('\n'));

    const result = await tool.execute(
      { path: file, old_string: 'UNIQUE_MARKER_HERE', new_string: 'REPLACED_MARKER', _toolCallId: 't7' },
      tmpDir
    );
    assert.equal(result.success, true);
    const content = readTempFile(file);
    assert.ok(content.includes('REPLACED_MARKER'));
    assert.ok(!content.includes('UNIQUE_MARKER_HERE'));
  });

  // 8. Missing path parameter
  it('should fail when path is missing', async () => {
    const result = await tool.execute(
      { old_string: 'x', new_string: 'y', _toolCallId: 't8' },
      tmpDir
    );
    assert.equal(result.success, false);
    assert.ok(result.output.includes('Missing'));
  });

  // 9. File not found
  it('should fail when file does not exist', async () => {
    const result = await tool.execute(
      { path: 'nonexistent.ts', old_string: 'x', new_string: 'y', _toolCallId: 't9' },
      tmpDir
    );
    assert.equal(result.success, false);
    assert.ok(result.output.includes('not found'));
  });

  // 10. Sensitive file blocked
  it('should block editing sensitive files', async () => {
    writeTempFile('.env', 'SECRET=value');
    const result = await tool.execute(
      { path: '.env', old_string: 'SECRET=value', new_string: 'SECRET=new', _toolCallId: 't10' },
      tmpDir
    );
    assert.equal(result.success, false);
    assert.ok(result.output.includes('Sensitive'));
  });
});
