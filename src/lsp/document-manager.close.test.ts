import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToUri } from '../utils.js';
import { DocumentManager } from './document-manager.js';
import type { JsonRpcTransport } from './json-rpc.js';

/** Write a file using Bun.write to avoid node:fs mock interference. */
async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

let TEST_DIR: string;

function createMockTransport(): JsonRpcTransport & {
  sendNotification: ReturnType<typeof jest.fn>;
} {
  return {
    sendRequest: jest.fn(),
    sendMessage: jest.fn(),
    sendNotification: jest.fn(),
    rejectAllPending: jest.fn(),
  } as unknown as JsonRpcTransport & {
    sendNotification: ReturnType<typeof jest.fn>;
  };
}

describe('DocumentManager.ensureOpenAsync', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let manager: DocumentManager;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-docmgr-close-test-'));
    transport = createMockTransport();
    manager = new DocumentManager(transport);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('opens a file via fs.promises.readFile and sends didOpen', async () => {
    const filePath = join(TEST_DIR, 'a.ts');
    await writeFile(filePath, 'export const x = 1;');

    const opened = await manager.ensureOpenAsync(filePath);

    expect(opened).toBe(true);
    expect(transport.sendNotification).toHaveBeenCalledTimes(1);
    expect(transport.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
      textDocument: expect.objectContaining({
        languageId: 'typescript',
        version: 1,
        text: 'export const x = 1;',
      }),
    });
    expect(manager.isOpen(filePath)).toBe(true);
    expect(manager.getVersion(filePath)).toBe(1);
  });

  it('returns false and does not re-send for an already-open file', async () => {
    const filePath = join(TEST_DIR, 'a.ts');
    await writeFile(filePath, 'export const x = 1;');

    await manager.ensureOpenAsync(filePath);
    const result = await manager.ensureOpenAsync(filePath);

    expect(result).toBe(false);
    expect(transport.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('throws when the file does not exist', async () => {
    const filePath = join(TEST_DIR, 'nonexistent.ts');
    await expect(manager.ensureOpenAsync(filePath)).rejects.toThrow();
  });
});

describe('DocumentManager.closeDocument', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let manager: DocumentManager;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-docmgr-close-test-'));
    transport = createMockTransport();
    manager = new DocumentManager(transport);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('sends textDocument/didClose and removes the file from open set', async () => {
    const filePath = join(TEST_DIR, 'a.ts');
    await writeFile(filePath, 'const a = 1;');
    await manager.ensureOpenAsync(filePath);
    expect(manager.isOpen(filePath)).toBe(true);

    manager.closeDocument(filePath);

    const uri = pathToUri(filePath);
    expect(transport.sendNotification).toHaveBeenCalledWith('textDocument/didClose', {
      textDocument: { uri },
    });
    expect(manager.isOpen(filePath)).toBe(false);
  });

  it('returns silently when called for a file that is not open', () => {
    const filePath = join(TEST_DIR, 'never-opened.ts');

    expect(() => manager.closeDocument(filePath)).not.toThrow();
    // No didClose sent because the file was not tracked as open.
    const calls = transport.sendNotification.mock.calls.filter(
      (call) => call[0] === 'textDocument/didClose'
    );
    expect(calls.length).toBe(0);
  });

  it('does NOT clear fileVersions when closing (R3 contract)', async () => {
    const filePath = join(TEST_DIR, 'a.ts');
    await writeFile(filePath, 'const a = 1;');

    await manager.ensureOpenAsync(filePath);
    expect(manager.getVersion(filePath)).toBe(1);

    manager.closeDocument(filePath);

    // Version map remains as a hint for any future reopen path.
    expect(manager.getVersion(filePath)).toBe(1);
  });

  it('closeDocument on an already-closed file is idempotent', async () => {
    const filePath = join(TEST_DIR, 'a.ts');
    await writeFile(filePath, 'const a = 1;');

    await manager.ensureOpenAsync(filePath);
    manager.closeDocument(filePath);

    // Second close should be a no-op (no extra didClose).
    transport.sendNotification.mockClear();
    manager.closeDocument(filePath);
    const calls = transport.sendNotification.mock.calls.filter(
      (call) => call[0] === 'textDocument/didClose'
    );
    expect(calls.length).toBe(0);
  });
});
