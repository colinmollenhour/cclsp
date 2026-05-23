import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToUri } from '../utils.js';
import { getDiagnostics as opsGetDiagnostics } from './operations.js';
import type { Diagnostic, ServerState } from './types.js';

/**
 * Op-level regression for `getDiagnostics(serverState, filePath)` in
 * `src/lsp/operations.ts`. Drives the op directly against fully-mocked
 * transport, DocumentManager, and DiagnosticsCache so that any refactor of
 * the op-path messaging shape (method name, params) gets caught here.
 *
 * Covers the three branches:
 *   1. cached `publishDiagnostics` path.
 *   2. `textDocument/diagnostic` pull path — `kind: 'full'`.
 *   3. `textDocument/diagnostic` pull path — `kind: 'unchanged'`.
 *   4. error fallback path — `sendChange` no-op + `waitForIdle`.
 */

interface MockTransport {
  sendRequest: ReturnType<typeof jest.fn>;
  sendNotification: ReturnType<typeof jest.fn>;
  sendMessage: ReturnType<typeof jest.fn>;
  rejectAllPending: ReturnType<typeof jest.fn>;
}

interface MockDocumentManager {
  ensureOpen: ReturnType<typeof jest.fn>;
  sendChange: ReturnType<typeof jest.fn>;
  isOpen: ReturnType<typeof jest.fn>;
  getVersion: ReturnType<typeof jest.fn>;
}

interface MockDiagnosticsCache {
  update: ReturnType<typeof jest.fn>;
  get: ReturnType<typeof jest.fn>;
  waitForIdle: ReturnType<typeof jest.fn>;
}

function createMockTransport(overrides: Partial<MockTransport> = {}): MockTransport {
  return {
    sendRequest: overrides.sendRequest ?? jest.fn().mockResolvedValue(undefined),
    sendNotification: overrides.sendNotification ?? jest.fn(),
    sendMessage: overrides.sendMessage ?? jest.fn(),
    rejectAllPending: overrides.rejectAllPending ?? jest.fn(),
  };
}

function createMockDocumentManager(): MockDocumentManager {
  return {
    ensureOpen: jest.fn().mockResolvedValue(false),
    sendChange: jest.fn(),
    isOpen: jest.fn().mockReturnValue(true),
    getVersion: jest.fn().mockReturnValue(1),
  };
}

function createMockDiagnosticsCache(
  cache: Map<string, Diagnostic[]> = new Map()
): MockDiagnosticsCache {
  return {
    update: jest.fn((uri: string, items: Diagnostic[]) => {
      cache.set(uri, items);
    }),
    get: jest.fn((uri: string) => cache.get(uri)),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
  };
}

function buildState(parts: {
  transport: MockTransport;
  documentManager: MockDocumentManager;
  diagnosticsCache: MockDiagnosticsCache;
}): ServerState {
  return {
    process: {} as never,
    transport: parts.transport,
    documentManager: parts.documentManager,
    diagnosticsCache: parts.diagnosticsCache,
    initialized: true,
    initializationPromise: Promise.resolve(),
    startTime: Date.now(),
    config: {
      extensions: ['ts'],
      command: ['mock-lsp'],
    },
  } as ServerState;
}

const DIAGS_A: Diagnostic[] = [
  {
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
    severity: 1,
    message: 'boom',
    source: 'mock',
    code: 'E001',
  },
];

const DIAGS_B: Diagnostic[] = [
  {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    severity: 2,
    message: 'pulled via textDocument/diagnostic',
    source: 'mock',
  },
];

describe('opsGetDiagnostics (single-file op)', () => {
  let TEST_DIR: string;
  let filePath: string;
  let fileUri: string;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-ops-get-diag-'));
    filePath = join(TEST_DIR, 'example.ts');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');
    fileUri = pathToUri(filePath);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns cached publishDiagnostics when available (no transport request issued)', async () => {
    const transport = createMockTransport();
    const docManager = createMockDocumentManager();
    const cache = createMockDiagnosticsCache(new Map([[fileUri, DIAGS_A]]));
    const state = buildState({
      transport,
      documentManager: docManager,
      diagnosticsCache: cache,
    });

    const result = await opsGetDiagnostics(state, filePath);

    expect(result).toEqual(DIAGS_A);
    expect(docManager.ensureOpen).toHaveBeenCalledWith(filePath);
    // Cached path must NOT issue a request.
    expect(transport.sendRequest).not.toHaveBeenCalled();
  });

  it('returns items from textDocument/diagnostic when report is kind:full', async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({
        kind: 'full',
        items: DIAGS_B,
      }),
    });
    const docManager = createMockDocumentManager();
    const cache = createMockDiagnosticsCache(); // nothing cached
    const state = buildState({
      transport,
      documentManager: docManager,
      diagnosticsCache: cache,
    });

    const result = await opsGetDiagnostics(state, filePath);

    expect(result).toEqual(DIAGS_B);
    // Pin the exact request shape: method + textDocument.uri.
    expect(transport.sendRequest).toHaveBeenCalledTimes(1);
    expect(transport.sendRequest).toHaveBeenCalledWith('textDocument/diagnostic', {
      textDocument: { uri: fileUri },
    });
  });

  it('returns [] when textDocument/diagnostic report is kind:unchanged', async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({
        kind: 'unchanged',
        resultId: 'rid-123',
      }),
    });
    const docManager = createMockDocumentManager();
    const cache = createMockDiagnosticsCache();
    const state = buildState({
      transport,
      documentManager: docManager,
      diagnosticsCache: cache,
    });

    const result = await opsGetDiagnostics(state, filePath);

    expect(result).toEqual([]);
    expect(transport.sendRequest).toHaveBeenCalledTimes(1);
    expect(transport.sendRequest).toHaveBeenCalledWith('textDocument/diagnostic', {
      textDocument: { uri: fileUri },
    });
  });

  it('falls back to waitForIdle when textDocument/diagnostic throws (cache hit after first idle wait)', async () => {
    // This pins the simpler half of the error-fallback path: when the pull
    // request fails, the op first awaits `cache.waitForIdle` and then checks
    // the cache. If the cache is now populated (i.e. publishDiagnostics
    // arrived during the wait), the op returns those items WITHOUT entering
    // the no-op `didChange` re-trigger path. We deliberately exercise this
    // earlier-exit branch because the re-trigger path additionally calls
    // `readFileSync` from `node:fs`, which is `mock.module`-replaced by
    // `setup.test.ts` in this test suite — replicating that here would only
    // duplicate that fragile module-mock dance.
    const transport = createMockTransport({
      sendRequest: jest.fn().mockRejectedValue(new Error('not supported')),
    });
    const docManager = createMockDocumentManager();

    const cacheMap = new Map<string, Diagnostic[]>();
    const cache: MockDiagnosticsCache = {
      update: jest.fn((uri: string, items: Diagnostic[]) => {
        cacheMap.set(uri, items);
      }),
      get: jest.fn((uri: string) => cacheMap.get(uri)),
      // Simulate publishDiagnostics arriving during the first idle wait.
      waitForIdle: jest.fn().mockImplementation(async () => {
        cacheMap.set(fileUri, DIAGS_A);
      }),
    };

    const state = buildState({
      transport,
      documentManager: docManager,
      diagnosticsCache: cache,
    });

    const result = await opsGetDiagnostics(state, filePath);

    expect(result).toEqual(DIAGS_A);
    // The pull request was attempted exactly once with the canonical shape.
    expect(transport.sendRequest).toHaveBeenCalledTimes(1);
    expect(transport.sendRequest).toHaveBeenCalledWith('textDocument/diagnostic', {
      textDocument: { uri: fileUri },
    });
    // We exited at the first cache-hit after waitForIdle, so the no-op churn
    // path must not run.
    expect(docManager.sendChange).not.toHaveBeenCalled();
    expect(cache.waitForIdle).toHaveBeenCalledTimes(1);
  });
});
