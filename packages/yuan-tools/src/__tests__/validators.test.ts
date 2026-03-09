/**
 * @yuan/tools — Validator unit tests
 *
 * Tests security validators: command blocking, path traversal,
 * shell metacharacters, sensitive file detection, binary detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  validatePath,
  validateNoShellMeta,
  validateCommand,
  isSensitiveFile,
  isBinaryFile,
  isImageFile,
  truncateOutput,
  detectLanguage,
} from '../validators.js';

// ─── Path Traversal Defence ─────────────────────────────────────────

describe('validatePath', () => {
  const workDir = '/home/user/project';

  it('should resolve a valid relative path', () => {
    const result = validatePath('src/app.ts', workDir);
    assert.equal(result, join(workDir, 'src/app.ts'));
  });

  it('should throw on path traversal via ../../../etc/passwd', () => {
    assert.throws(
      () => validatePath('../../../etc/passwd', workDir),
      /Path traversal detected/
    );
  });

  it('should throw on path traversal via ../', () => {
    assert.throws(
      () => validatePath('../../outside', workDir),
      /Path traversal detected/
    );
  });

  it('should throw on null byte in path', () => {
    assert.throws(
      () => validatePath('src/app\0.ts', workDir),
      /null byte/
    );
  });

  it('should allow nested valid paths', () => {
    const result = validatePath('src/deep/nested/file.ts', workDir);
    assert.equal(result, join(workDir, 'src/deep/nested/file.ts'));
  });
});

// ─── Shell Metacharacter Defence ────────────────────────────────────

describe('validateNoShellMeta', () => {
  it('should pass for clean executable and args', () => {
    assert.doesNotThrow(() => validateNoShellMeta('node', ['index.js']));
  });

  it('should throw on semicolon in arg', () => {
    assert.throws(
      () => validateNoShellMeta('ls', ['; rm -rf /']),
      /Shell metacharacter in arg/
    );
  });

  it('should throw on pipe in executable', () => {
    assert.throws(
      () => validateNoShellMeta('ls | cat', []),
      /Shell metacharacter in executable/
    );
  });

  it('should throw on backtick in arg', () => {
    assert.throws(
      () => validateNoShellMeta('echo', ['`whoami`']),
      /Shell metacharacter in arg/
    );
  });

  it('should throw on && in arg', () => {
    assert.throws(
      () => validateNoShellMeta('echo', ['hello && rm -rf /']),
      /Shell metacharacter in arg/
    );
  });

  it('should throw on $() in arg', () => {
    assert.throws(
      () => validateNoShellMeta('echo', ['$(cat /etc/passwd)']),
      /Shell metacharacter in arg/
    );
  });
});

// ─── Command Validation (delegates to @yuan/core) ───────────────────

describe('validateCommand', () => {
  it('should allow safe commands: ls', () => {
    assert.doesNotThrow(() => validateCommand('ls', ['-la']));
  });

  it('should allow safe commands: node', () => {
    assert.doesNotThrow(() => validateCommand('node', ['index.js']));
  });

  it('should allow safe commands: pnpm', () => {
    assert.doesNotThrow(() => validateCommand('pnpm', ['install']));
  });

  it('should allow safe commands: git status', () => {
    assert.doesNotThrow(() => validateCommand('git', ['status']));
  });

  it('should block rm -rf /', () => {
    assert.throws(
      () => validateCommand('rm', ['-rf', '/']),
      /blocked|Destructive/i
    );
  });

  it('should block interactive commands: vim', () => {
    assert.throws(
      () => validateCommand('vim', ['file.txt']),
      /blocked|Interactive|TTY/i
    );
  });

  it('should block interactive commands: nano', () => {
    assert.throws(
      () => validateCommand('nano', ['file.txt']),
      /blocked|Interactive|TTY/i
    );
  });

  it('should block sudo', () => {
    assert.throws(
      () => validateCommand('sudo', ['ls']),
      /blocked|Blocked/i
    );
  });

  it('should block su', () => {
    assert.throws(
      () => validateCommand('su', ['-']),
      /blocked|Blocked/i
    );
  });
});

// ─── Sensitive File Detection ───────────────────────────────────────

describe('isSensitiveFile', () => {
  it('should detect .env as sensitive', () => {
    assert.equal(isSensitiveFile('.env'), true);
  });

  it('should detect .env.local as sensitive', () => {
    assert.equal(isSensitiveFile('.env.local'), true);
  });

  it('should detect credentials.json as sensitive', () => {
    assert.equal(isSensitiveFile('credentials.json'), true);
  });

  it('should detect .pem files as sensitive', () => {
    assert.equal(isSensitiveFile('server.pem'), true);
  });

  it('should detect id_rsa as sensitive', () => {
    assert.equal(isSensitiveFile('id_rsa'), true);
  });

  it('should NOT detect src/app.ts as sensitive', () => {
    assert.equal(isSensitiveFile('src/app.ts'), false);
  });

  it('should NOT detect package.json as sensitive', () => {
    assert.equal(isSensitiveFile('package.json'), false);
  });

  it('should NOT detect README.md as sensitive', () => {
    assert.equal(isSensitiveFile('README.md'), false);
  });
});

// ─── Binary File Detection ──────────────────────────────────────────

describe('isBinaryFile', () => {
  let tmpDir: string;

  it('should detect .png as binary (image)', async () => {
    const result = await isBinaryFile('image.png');
    assert.equal(result, true);
  });

  it('should detect .jpg as binary (image)', async () => {
    const result = await isBinaryFile('photo.jpg');
    assert.equal(result, true);
  });

  it('should detect .ts as text (by extension)', async () => {
    const result = await isBinaryFile('src/app.ts');
    assert.equal(result, false);
  });

  it('should detect .json as text (by extension)', async () => {
    const result = await isBinaryFile('config.json');
    assert.equal(result, false);
  });

  it('should sniff binary content via null bytes', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yuan-test-'));
    const binFile = join(tmpDir, 'data.bin');
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]); // "Hel\0o"
    writeFileSync(binFile, buf);
    const result = await isBinaryFile(binFile);
    assert.equal(result, true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should sniff text content without null bytes', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yuan-test-'));
    const textFile = join(tmpDir, 'data.unknown');
    writeFileSync(textFile, 'Hello, this is plain text');
    const result = await isBinaryFile(textFile);
    assert.equal(result, false);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── Image File Detection ───────────────────────────────────────────

describe('isImageFile', () => {
  it('should detect .png as image', () => {
    assert.equal(isImageFile('logo.png'), true);
  });

  it('should detect .svg as image', () => {
    assert.equal(isImageFile('icon.svg'), true);
  });

  it('should NOT detect .ts as image', () => {
    assert.equal(isImageFile('src/app.ts'), false);
  });
});

// ─── Output Truncation ─────────────────────────────────────────────

describe('truncateOutput', () => {
  it('should not truncate short output', () => {
    const output = 'Hello, world!';
    assert.equal(truncateOutput(output), output);
  });

  it('should truncate long output with head/tail', () => {
    const output = 'x'.repeat(100_000);
    const result = truncateOutput(output, 1000);
    assert.ok(result.length < output.length);
    assert.ok(result.includes('truncated'));
  });
});

// ─── Language Detection ─────────────────────────────────────────────

describe('detectLanguage', () => {
  it('should detect TypeScript', () => {
    assert.equal(detectLanguage('src/app.ts'), 'typescript');
  });

  it('should detect Python', () => {
    assert.equal(detectLanguage('main.py'), 'python');
  });

  it('should detect Dockerfile', () => {
    assert.equal(detectLanguage('Dockerfile'), 'dockerfile');
  });

  it('should return plaintext for unknown', () => {
    assert.equal(detectLanguage('file.xyz'), 'plaintext');
  });
});
