import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToUri } from '../utils.js';
import { RequestCancelledError } from './json-rpc.js';
import {
  BATCH_FILE_CONCURRENCY,
  perFilePullBatch,
  pushFallbackBatch,
  workspaceDiagnostic,
} from './operations.js';
import type {
  Diagnostic,
  ServerCapabilities,
  ServerState,
  WorkspaceDocumentDiagnosticReport,
} from './types.js';

/**
 * Tests for the PR2 batch diagnostics ops:
 *   - workspaceDiagnostic
 *   - perFilePullBatch
 *   - pushFallbackBatch
 *
 * Drives each op against fully-mocked transport / DocumentManager /
 * DiagnosticsCache to pin protocol shapes (method names, params) and
 * concurrency/cancellation semantics.
 */

interface MockTransport {
  sendRequest: ReturnType<typeof jest.fn>;
  sendCancellableRequest: ReturnType<typeof jest.fn>;
  sendNotification: ReturnType<typeof jest.fn>;
  sendMessage: ReturnType<typeof jest.fn>;
  rejectAllPending: ReturnType<typeof jest.fn>;
  cancelRequest: ReturnType<typeof jest.fn>;
  registerProgressHandler: ReturnType<typeof jest.fn>;
  unregisterProgressHandler: ReturnType<typeof jest.fn>;
}

function createMockTransport(
  overrides: Partial<MockTransport> = {},
  progressHandlerRef?: { handler?: (value: unknown) => void; token?: string | number }
): MockTransport {
  const sendRequest = overrides.sendRequest ?? jest.fn().mockResolvedValue(undefined);
  // Default `sendCancellableRequest` mirrors the real transport: it
  // returns an auto-incrementing id alongside the response promise. Each
  // call to `sendRequest` corresponds to one id. Tests that want to drive
  // the cancellation path can override `sendCancellableRequest` directly.
  let nextId = 1;
  const sendCancellableRequest =
    overrides.sendCancellableRequest ??
    jest.fn((method: string, params: unknown, timeout?: number) => {
      const id = nextId++;
      const promise = sendRequest(method, params, timeout);
      return { id, promise };
    });
  return {
    sendRequest,
    sendCancellableRequest,
    sendNotification: overrides.sendNotification ?? jest.fn(),
    sendMessage: overrides.sendMessage ?? jest.fn(),
    rejectAllPending: overrides.rejectAllPending ?? jest.fn(),
    cancelRequest: overrides.cancelRequest ?? jest.fn(),
    registerProgressHandler:
      overrides.registerProgressHandler ??
      jest.fn((token: string | number, handler: (value: unknown) => void) => {
        if (progressHandlerRef) {
          progressHandlerRef.handler = handler;
          progressHandlerRef.token = token;
        }
      }),
    unregisterProgressHandler: overrides.unregisterProgressHandler ?? jest.fn(),
  };
}

interface MockDocumentManager {
  ensureOpen: ReturnType<typeof jest.fn>;
  ensureOpenAsync: ReturnType<typeof jest.fn>;
  closeDocument: ReturnType<typeof jest.fn>;
  sendChange: ReturnType<typeof jest.fn>;
  isOpen: ReturnType<typeof jest.fn>;
  getVersion: ReturnType<typeof jest.fn>;
}

function createMockDocumentManager(opts: { isOpen?: boolean } = {}): MockDocumentManager {
  const openSet = new Set<string>();
  const openedTracker: string[] = [];
  return {
    ensureOpen: jest.fn(async (p: string) => {
      const wasOpen = openSet.has(p);
      openSet.add(p);
      if (!wasOpen) openedTracker.push(p);
      return !wasOpen;
    }),
    ensureOpenAsync: jest.fn(async (p: string) => {
      const wasOpen = openSet.has(p);
      openSet.add(p);
      if (!wasOpen) openedTracker.push(p);
      return !wasOpen;
    }),
    closeDocument: jest.fn((p: string) => {
      openSet.delete(p);
    }),
    sendChange: jest.fn(),
    isOpen: jest.fn((p: string) => (opts.isOpen !== undefined ? opts.isOpen : openSet.has(p))),
    getVersion: jest.fn().mockReturnValue(1),
  };
}

interface MockDiagnosticsCache {
  update: ReturnType<typeof jest.fn>;
  get: ReturnType<typeof jest.fn>;
  waitForIdle: ReturnType<typeof jest.fn>;
  setResultId: ReturnType<typeof jest.fn>;
  getResultId: ReturnType<typeof jest.fn>;
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
    setResultId: jest.fn(),
    getResultId: jest.fn().mockReturnValue(undefined),
  };
}

function buildState(parts: {
  transport: MockTransport;
  documentManager: MockDocumentManager;
  diagnosticsCache: MockDiagnosticsCache;
  capabilities?: ServerCapabilities;
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
    capabilities: parts.capabilities,
    inFlightBatchCount: 0,
  } as ServerState;
}

describe('workspaceDiagnostic op', () => {
  it('sends previousResultIds:[] and a UUID partialResultToken (happy path)', async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({
        items: [
          {
            uri: 'file:///a.ts',
            kind: 'full',
            version: 1,
            items: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                severity: 1,
                message: 'oops',
                source: 'mock',
              },
            ],
          },
        ],
      }),
    });
    const docManager = createMockDocumentManager();
    const cache = createMockDiagnosticsCache();
    const state = buildState({
      transport,
      documentManager: docManager,
      diagnosticsCache: cache,
      capabilities: {
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      },
    });

    const deadline = Date.now() + 5000;
    const result = await workspaceDiagnostic(state, { deadline });

    expect(result.partial).toBeFalsy();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.uri).toBe('file:///a.ts');

    // Pin the request shape.
    expect(transport.sendRequest).toHaveBeenCalledTimes(1);
    const firstCall = transport.sendRequest.mock.calls[0];
    if (!firstCall) throw new Error('expected one call');
    const [method, params] = firstCall;
    expect(method).toBe('workspace/diagnostic');
    const p = params as { previousResultIds: unknown[]; partialResultToken: string };
    expect(p.previousResultIds).toEqual([]);
    expect(typeof p.partialResultToken).toBe('string');
    expect(p.partialResultToken.length).toBeGreaterThan(0);

    // Progress handler must be registered and unregistered.
    expect(transport.registerProgressHandler).toHaveBeenCalledTimes(1);
    expect(transport.unregisterProgressHandler).toHaveBeenCalledTimes(1);
  });

  it('merges $/progress partials with the final response', async () => {
    const progressRef: { handler?: (value: unknown) => void; token?: string | number } = {};
    const partial: WorkspaceDocumentDiagnosticReport[] = [
      {
        uri: 'file:///a.ts',
        kind: 'full',
        version: 1,
        items: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            message: 'partial diag',
          },
        ],
      },
    ];
    const final: WorkspaceDocumentDiagnosticReport[] = [
      {
        uri: 'file:///b.ts',
        kind: 'full',
        version: 1,
        items: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
            severity: 2,
            message: 'final diag',
          },
        ],
      },
    ];
    const transport = createMockTransport(
      {
        sendRequest: jest.fn(async () => {
          // Fire a $/progress notification before resolving.
          progressRef.handler?.({ items: partial });
          return { items: final };
        }),
      },
      progressRef
    );
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager(),
      diagnosticsCache: createMockDiagnosticsCache(),
      capabilities: {
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      },
    });

    const result = await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });

    expect(result.partial).toBeFalsy();
    const uris = result.items.map((i) => i.uri).sort();
    expect(uris).toEqual(['file:///a.ts', 'file:///b.ts']);
  });

  it("kind:'unchanged' returns empty when cache has no entry for the uri (defensive)", async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({
        items: [
          {
            uri: 'file:///a.ts',
            kind: 'unchanged',
            version: 1,
            resultId: 'rid-1',
          },
        ],
      }),
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager(),
      diagnosticsCache: createMockDiagnosticsCache(),
      capabilities: {
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      },
    });

    const result = await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });
    expect(result.partial).toBeFalsy();
    expect(result.items).toEqual([{ uri: 'file:///a.ts', items: [] }]);
  });

  it("kind:'unchanged' returns cached items when present", async () => {
    // PR3: when the server answers `unchanged` for a URI and the cache
    // already holds items for it, `mergeReports` substitutes the cached
    // items. This is the positive side of the contract — without it, the
    // resultId-reuse optimization is useless because we'd always return [].
    const cachedUri = 'file:///cached.ts';
    const cachedItems: Diagnostic[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        severity: 1,
        message: 'pre-cached error',
        source: 'mock',
      },
    ];
    // Pre-populate the cache as if a prior `full` call had already stored
    // the items + resultId for this URI.
    const cacheMap = new Map<string, Diagnostic[]>([[cachedUri, cachedItems]]);
    const cache = createMockDiagnosticsCache(cacheMap);
    cache.getResultId = jest.fn().mockReturnValue('rid-cached-1');

    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({
        items: [
          {
            uri: cachedUri,
            kind: 'unchanged',
            version: 1,
            resultId: 'rid-cached-1',
          },
        ],
      }),
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager(),
      diagnosticsCache: cache,
      capabilities: {
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      },
    });

    const result = await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });

    expect(result.partial).toBeFalsy();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.uri).toBe(cachedUri);
    expect(result.items[0]?.items).toEqual(cachedItems);
    // The op consults the cache to resolve `unchanged`.
    expect(cache.get).toHaveBeenCalledWith(cachedUri);
  });

  it('returns BUDGET when deadline is already past', async () => {
    const transport = createMockTransport();
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager(),
      diagnosticsCache: createMockDiagnosticsCache(),
      capabilities: {
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      },
    });

    const result = await workspaceDiagnostic(state, { deadline: Date.now() - 1000 });
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('BUDGET');
    expect(transport.sendRequest).not.toHaveBeenCalled();
  });

  it('returns BUDGET partial when request rejects with RequestCancelledError', async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn().mockRejectedValue(new RequestCancelledError(1)),
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager(),
      diagnosticsCache: createMockDiagnosticsCache(),
      capabilities: {
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      },
    });

    const result = await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('BUDGET');
  });

  it('returns SERVER_CRASH partial when transport throws a generic error', async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn().mockRejectedValue(new Error('process exited')),
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager(),
      diagnosticsCache: createMockDiagnosticsCache(),
      capabilities: {
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      },
    });

    const result = await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('SERVER_CRASH');
  });
});

describe('perFilePullBatch op', () => {
  let TEST_DIR: string;
  let f1: string;
  let f2: string;
  let f3: string;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-ops-batch-'));
    f1 = join(TEST_DIR, 'a.ts');
    f2 = join(TEST_DIR, 'b.ts');
    f3 = join(TEST_DIR, 'c.ts');
    writeFileSync(f1, 'const x = 1;');
    writeFileSync(f2, 'const y = 2;');
    writeFileSync(f3, 'const z = 3;');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('exposes BATCH_FILE_CONCURRENCY = 2', () => {
    expect(BATCH_FILE_CONCURRENCY).toBe(2);
  });

  it('issues textDocument/diagnostic with kind:full and returns per-file items', async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn(async (_m, params: unknown) => {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri;
        return {
          kind: 'full',
          items: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              message: `diag for ${uri}`,
            },
          ],
        };
      }),
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager({ isOpen: true }),
      diagnosticsCache: createMockDiagnosticsCache(),
    });

    const result = await perFilePullBatch(state, [f1, f2], {
      deadline: Date.now() + 5000,
      concurrency: 2,
    });

    expect(result.partial).toBeFalsy();
    expect(result.items).toHaveLength(2);
    // Pin request shape on the first call.
    const calls = transport.sendRequest.mock.calls;
    expect(calls[0]?.[0]).toBe('textDocument/diagnostic');
    expect(calls[0]?.[1]).toEqual({ textDocument: { uri: pathToUri(f1) } });
  });

  it('enforces concurrency=2 (no more than 2 in-flight at once)', async () => {
    let inFlight = 0;
    let peak = 0;
    const transport = createMockTransport({
      sendRequest: jest.fn(async () => {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        await new Promise((r) => setTimeout(r, 25));
        inFlight--;
        return { kind: 'full', items: [] };
      }),
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager({ isOpen: true }),
      diagnosticsCache: createMockDiagnosticsCache(),
    });

    await perFilePullBatch(state, [f1, f2, f3], {
      deadline: Date.now() + 5000,
      concurrency: 2,
    });

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('honors the deadline: $/cancelRequest fires for in-flight ids, bucket marked BUDGET', async () => {
    // Pin the cancellation path end-to-end:
    //   - `sendCancellableRequest` returns a real id but a promise that
    //     NEVER resolves on its own.
    //   - The bucket's deadline race must fire after ~100ms, calling
    //     `transport.cancelRequest(id)` BEFORE the bucket settles.
    //   - The bucket then surfaces `partial=true, partialReason='BUDGET'`,
    //     and the per-file dropped count is incremented under BUDGET
    //     (not SERVER_CRASH).
    let nextId = 100;
    const issuedIds: number[] = [];
    const pending: Array<{
      id: number;
      reject: (err: unknown) => void;
    }> = [];

    const sendCancellableRequest = jest.fn(
      (_method: string, _params: unknown, _timeout?: number) => {
        const id = nextId++;
        issuedIds.push(id);
        const promise = new Promise((_resolve, reject) => {
          pending.push({ id, reject });
        });
        return { id, promise };
      }
    );
    const cancelRequest = jest.fn((id: number) => {
      // Mirror the real transport: server received the cancel, so the
      // pending local promise rejects with RequestCancelledError.
      const entry = pending.find((p) => p.id === id);
      if (entry) entry.reject(new RequestCancelledError(id));
    });

    const transport = createMockTransport({
      sendCancellableRequest,
      cancelRequest,
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager({ isOpen: true }),
      diagnosticsCache: createMockDiagnosticsCache(),
    });

    // Deadline must exceed MIN_PER_REQ_MS (250) so the worker dispatches
    // at least one request before the deadline race fires.
    const deadline = Date.now() + 400;
    const start = Date.now();
    const result = await perFilePullBatch(state, [f1, f2, f3], {
      deadline,
      concurrency: 2,
    });
    const elapsed = Date.now() - start;

    // Settles soon after the deadline (allow generous CI margin).
    expect(elapsed).toBeLessThan(2000);

    // Bucket reports BUDGET — not SERVER_CRASH.
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('BUDGET');
    expect(result.droppedCounts?.budget ?? 0).toBeGreaterThan(0);
    expect(result.droppedCounts?.serverCrash ?? 0).toBe(0);

    // cancelRequest fired for every in-flight id. With concurrency=2 we
    // expect at least one cancellation against an issued id.
    expect(cancelRequest).toHaveBeenCalled();
    const calledIds = cancelRequest.mock.calls.map((c) => c[0]);
    for (const cid of calledIds) {
      expect(issuedIds).toContain(cid);
    }
  });

  it('marks SERVER_CRASH when request rejects with a generic error', async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager({ isOpen: true }),
      diagnosticsCache: createMockDiagnosticsCache(),
    });

    const result = await perFilePullBatch(state, [f1], { deadline: Date.now() + 5000 });
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('SERVER_CRASH');
  });

  it('opens files that are not yet open and closes them after the request (one-shot)', async () => {
    const docManager = createMockDocumentManager(); // tracks open set
    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({ kind: 'full', items: [] }),
    });
    const state = buildState({
      transport,
      documentManager: docManager,
      diagnosticsCache: createMockDiagnosticsCache(),
    });

    const result = await perFilePullBatch(state, [f1], { deadline: Date.now() + 5000 });
    expect(result.partial).toBeFalsy();
    expect(docManager.ensureOpenAsync).toHaveBeenCalledTimes(1);
    expect(docManager.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('drops not-open files when includeUnopened=false and never opens them', async () => {
    const docManager = createMockDocumentManager({ isOpen: false });
    const transport = createMockTransport();
    const state = buildState({
      transport,
      documentManager: docManager,
      diagnosticsCache: createMockDiagnosticsCache(),
    });

    const result = await perFilePullBatch(state, [f1, f2], {
      deadline: Date.now() + 5000,
      includeUnopened: false,
    });

    expect(docManager.ensureOpenAsync).not.toHaveBeenCalled();
    expect(transport.sendRequest).not.toHaveBeenCalled();
    expect(result.droppedCounts?.notOpen).toBe(2);
  });

  it("treats kind:'unchanged' as empty per file", async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({ kind: 'unchanged', resultId: 'rid-x' }),
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager({ isOpen: true }),
      diagnosticsCache: createMockDiagnosticsCache(),
    });
    const result = await perFilePullBatch(state, [f1], { deadline: Date.now() + 5000 });
    expect(result.items[0]?.items).toEqual([]);
  });
});

describe('pushFallbackBatch op', () => {
  let TEST_DIR: string;
  let f1: string;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-ops-batch-push-'));
    f1 = join(TEST_DIR, 'a.ts');
    writeFileSync(f1, 'const x = 1;');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('opens → waitForIdle → reads cache → closes', async () => {
    const docManager = createMockDocumentManager();
    const cacheMap = new Map<string, Diagnostic[]>([
      [
        pathToUri(f1),
        [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 2,
            message: 'cached',
          },
        ],
      ],
    ]);
    const cache = createMockDiagnosticsCache(cacheMap);
    const state = buildState({
      transport: createMockTransport(),
      documentManager: docManager,
      diagnosticsCache: cache,
    });

    const result = await pushFallbackBatch(state, [f1], { deadline: Date.now() + 5000 });
    expect(result.partial).toBeFalsy();
    expect(docManager.ensureOpenAsync).toHaveBeenCalled();
    expect(cache.waitForIdle).toHaveBeenCalled();
    expect(docManager.closeDocument).toHaveBeenCalled();
    expect(result.items[0]?.items).toHaveLength(1);
  });

  it('respects openedByMe: leaves already-open files open after batch', async () => {
    const docManager = createMockDocumentManager({ isOpen: true });
    const cache = createMockDiagnosticsCache(new Map([[pathToUri(f1), []]]));
    const state = buildState({
      transport: createMockTransport(),
      documentManager: docManager,
      diagnosticsCache: cache,
    });

    await pushFallbackBatch(state, [f1], { deadline: Date.now() + 5000 });
    expect(docManager.ensureOpenAsync).not.toHaveBeenCalled();
    expect(docManager.closeDocument).not.toHaveBeenCalled();
  });
});

describe('capability-based strategy selection (callers should gate ops)', () => {
  // These tests pin the capability helpers — they live in capabilities.ts —
  // but verify that workspaceDiagnostic and perFilePullBatch behave correctly
  // when the caller's gating is wrong (sanity check: ops do not themselves
  // re-check capabilities and just trust the caller).

  it('workspaceDiagnostic still sends the request even without explicit capabilities (caller gating only)', async () => {
    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({ items: [] }),
    });
    const state = buildState({
      transport,
      documentManager: createMockDocumentManager(),
      diagnosticsCache: createMockDiagnosticsCache(),
    });
    await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });
    expect(transport.sendRequest).toHaveBeenCalledWith(
      'workspace/diagnostic',
      expect.any(Object),
      expect.any(Number)
    );
  });
});
