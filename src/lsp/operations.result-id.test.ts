import { describe, expect, it, jest } from 'bun:test';
import { DiagnosticsCache } from './diagnostics.js';
import { workspaceDiagnostic } from './operations.js';
import type {
  Diagnostic,
  ServerCapabilities,
  ServerState,
  WorkspaceDocumentDiagnosticReport,
} from './types.js';

/**
 * PR3 result-id reuse tests for `workspaceDiagnostic`.
 *
 *  - First call sends `previousResultIds: []` and stores returned resultIds.
 *  - Second call sends the prior ids.
 *  - `kind: 'unchanged'` reports return cached items.
 *  - Defensive fallback: `unchanged` with no cached entry returns `[]`.
 *  - Result ids are segmented per `serverState` cache instance.
 *
 * Uses a real `DiagnosticsCache` (not a mock) so we exercise the actual
 * `setResultId` / `getResultId` / `listResultIds` / `update` round-trip.
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

function createMockTransport(overrides: Partial<MockTransport> = {}): MockTransport {
  const sendRequest = overrides.sendRequest ?? jest.fn().mockResolvedValue({ items: [] });
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
    registerProgressHandler: overrides.registerProgressHandler ?? jest.fn(),
    unregisterProgressHandler: overrides.unregisterProgressHandler ?? jest.fn(),
  };
}

function createMockDocumentManager(): {
  ensureOpen: ReturnType<typeof jest.fn>;
  ensureOpenAsync: ReturnType<typeof jest.fn>;
  closeDocument: ReturnType<typeof jest.fn>;
  sendChange: ReturnType<typeof jest.fn>;
  isOpen: ReturnType<typeof jest.fn>;
  getVersion: ReturnType<typeof jest.fn>;
} {
  return {
    ensureOpen: jest.fn().mockResolvedValue(false),
    ensureOpenAsync: jest.fn().mockResolvedValue(false),
    closeDocument: jest.fn(),
    sendChange: jest.fn(),
    isOpen: jest.fn().mockReturnValue(true),
    getVersion: jest.fn().mockReturnValue(1),
  };
}

function buildState(parts: {
  transport: MockTransport;
  diagnosticsCache: DiagnosticsCache;
  capabilities?: ServerCapabilities;
}): ServerState {
  return {
    process: {} as never,
    transport: parts.transport,
    documentManager: createMockDocumentManager(),
    diagnosticsCache: parts.diagnosticsCache,
    initialized: true,
    initializationPromise: Promise.resolve(),
    startTime: Date.now(),
    config: {
      extensions: ['ts'],
      command: ['mock-lsp'],
    },
    capabilities: parts.capabilities ?? {
      diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
    },
    inFlightBatchCount: 0,
  } as ServerState;
}

const sampleDiag = (message: string): Diagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 1,
  message,
  source: 'mock',
});

describe('workspaceDiagnostic result-id reuse (PR3)', () => {
  it('first call sends empty previousResultIds and stores result ids', async () => {
    const full: WorkspaceDocumentDiagnosticReport[] = [
      {
        uri: 'file:///a.ts',
        kind: 'full',
        version: 1,
        resultId: 'rid-A-1',
        items: [sampleDiag('a-err-1')],
      },
      {
        uri: 'file:///b.ts',
        kind: 'full',
        version: 1,
        resultId: 'rid-B-1',
        items: [sampleDiag('b-err-1')],
      },
    ];
    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({ items: full }),
    });
    const cache = new DiagnosticsCache();
    const state = buildState({ transport, diagnosticsCache: cache });

    const result = await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });

    expect(result.partial).toBeFalsy();
    expect(result.items).toHaveLength(2);

    // Pin the request shape: previousResultIds is exactly [].
    expect(transport.sendRequest).toHaveBeenCalledTimes(1);
    const firstCall = transport.sendRequest.mock.calls[0];
    if (!firstCall) throw new Error('expected one sendRequest call');
    const params = firstCall[1] as {
      previousResultIds: Array<{ uri: string; value: string }>;
      partialResultToken: string;
    };
    expect(params.previousResultIds).toEqual([]);

    // Cache now holds both result ids and items.
    expect(cache.getResultId('file:///a.ts')).toBe('rid-A-1');
    expect(cache.getResultId('file:///b.ts')).toBe('rid-B-1');
    expect(cache.get('file:///a.ts')).toEqual([sampleDiag('a-err-1')]);
    expect(cache.get('file:///b.ts')).toEqual([sampleDiag('b-err-1')]);

    // listResultIds returns the snapshot for the next call.
    const snapshot = cache.listResultIds();
    expect(snapshot).toHaveLength(2);
    const sorted = [...snapshot].sort((x, y) => x.uri.localeCompare(y.uri));
    expect(sorted).toEqual([
      { uri: 'file:///a.ts', value: 'rid-A-1' },
      { uri: 'file:///b.ts', value: 'rid-B-1' },
    ]);
  });

  it('second call sends prior result ids', async () => {
    const firstFull: WorkspaceDocumentDiagnosticReport[] = [
      {
        uri: 'file:///a.ts',
        kind: 'full',
        version: 1,
        resultId: 'rid-A-1',
        items: [sampleDiag('a')],
      },
      {
        uri: 'file:///b.ts',
        kind: 'full',
        version: 1,
        resultId: 'rid-B-1',
        items: [sampleDiag('b')],
      },
    ];
    const secondFull: WorkspaceDocumentDiagnosticReport[] = [
      {
        uri: 'file:///a.ts',
        kind: 'full',
        version: 2,
        resultId: 'rid-A-2',
        items: [sampleDiag('a-updated')],
      },
    ];
    let callCount = 0;
    const transport = createMockTransport({
      sendRequest: jest.fn(async () => {
        callCount++;
        return { items: callCount === 1 ? firstFull : secondFull };
      }),
    });
    const cache = new DiagnosticsCache();
    const state = buildState({ transport, diagnosticsCache: cache });

    await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });
    await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });

    expect(transport.sendRequest).toHaveBeenCalledTimes(2);
    const secondCall = transport.sendRequest.mock.calls[1];
    if (!secondCall) throw new Error('expected two sendRequest calls');
    const params = secondCall[1] as {
      previousResultIds: Array<{ uri: string; value: string }>;
    };

    const sorted = [...params.previousResultIds].sort((x, y) => x.uri.localeCompare(y.uri));
    expect(sorted).toEqual([
      { uri: 'file:///a.ts', value: 'rid-A-1' },
      { uri: 'file:///b.ts', value: 'rid-B-1' },
    ]);

    // After the second call, the cache has the new resultId for a.ts and
    // still holds the original for b.ts (server did not mention it).
    expect(cache.getResultId('file:///a.ts')).toBe('rid-A-2');
    expect(cache.getResultId('file:///b.ts')).toBe('rid-B-1');
  });

  it('unchanged report returns cached items', async () => {
    const firstFull: WorkspaceDocumentDiagnosticReport[] = [
      {
        uri: 'file:///a.ts',
        kind: 'full',
        version: 1,
        resultId: 'rid-A-1',
        items: [sampleDiag('cached-a'), sampleDiag('cached-a-2')],
      },
    ];
    const secondUnchanged: WorkspaceDocumentDiagnosticReport[] = [
      {
        uri: 'file:///a.ts',
        kind: 'unchanged',
        version: 1,
        resultId: 'rid-A-1',
      },
    ];
    let callCount = 0;
    const transport = createMockTransport({
      sendRequest: jest.fn(async () => {
        callCount++;
        return { items: callCount === 1 ? firstFull : secondUnchanged };
      }),
    });
    const cache = new DiagnosticsCache();
    const state = buildState({ transport, diagnosticsCache: cache });

    const r1 = await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });
    expect(r1.items).toHaveLength(1);
    expect(r1.items[0]?.items).toHaveLength(2);

    const r2 = await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });
    expect(r2.partial).toBeFalsy();
    expect(r2.items).toHaveLength(1);
    expect(r2.items[0]?.uri).toBe('file:///a.ts');
    // The unchanged report should yield the same items the cache holds —
    // i.e. the items we stored on the first call.
    expect(r2.items[0]?.items).toEqual([sampleDiag('cached-a'), sampleDiag('cached-a-2')]);
  });

  it('unchanged with no cached entry returns empty for that uri', async () => {
    // Simulate the edge case where the cache was cleared between calls:
    // the server returns `unchanged` for a URI we have no items for. The
    // op must NOT throw — it logs at debug and yields [] for that URI.
    const onlyUnchanged: WorkspaceDocumentDiagnosticReport[] = [
      {
        uri: 'file:///gone.ts',
        kind: 'unchanged',
        version: 1,
        resultId: 'rid-gone-1',
      },
    ];
    const transport = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({ items: onlyUnchanged }),
    });
    const cache = new DiagnosticsCache();
    const state = buildState({ transport, diagnosticsCache: cache });

    const result = await workspaceDiagnostic(state, { deadline: Date.now() + 5000 });
    expect(result.partial).toBeFalsy();
    expect(result.items).toEqual([{ uri: 'file:///gone.ts', items: [] }]);
    // We still refresh the resultId so the next call advertises it.
    expect(cache.getResultId('file:///gone.ts')).toBe('rid-gone-1');
  });

  it('partial result from cancelled call still populates cache', async () => {
    // Pin the partial-flush write-through: when the deadline elapses
    // before the `workspace/diagnostic` request settles, the op classifies
    // the outcome as `BUDGET` but still routes any `$/progress` partials
    // through `mergeReports`, which writes `setResultId` + `update` for
    // each `kind:'full'` entry. The next call must see the cached
    // resultId + items even though this call never completed.
    const progressItems: WorkspaceDocumentDiagnosticReport[] = [
      {
        uri: 'file:///flushed.ts',
        kind: 'full',
        version: 1,
        resultId: 'p1',
        items: [sampleDiag('flushed-during-progress')],
      },
    ];

    let capturedHandler: ((value: unknown) => void) | undefined;
    let capturedToken: string | number | undefined;

    // The mock request promise NEVER settles on its own. Progress fires
    // synchronously when the request is issued; the deadline race is the
    // only thing that ends the call.
    const sendRequest = jest.fn(
      () =>
        new Promise<unknown>(() => {
          // Intentionally pending forever.
        })
    );

    const transport = createMockTransport({
      sendRequest,
      registerProgressHandler: jest.fn(
        (token: string | number, handler: (value: unknown) => void) => {
          capturedHandler = handler;
          capturedToken = token;
        }
      ),
    });

    // Wrap `sendCancellableRequest` so we fire the progress notification
    // as soon as the request is "issued" (mirrors a real server that
    // streams partials before the final response).
    transport.sendCancellableRequest = jest.fn(() => {
      const id = Math.floor(Math.random() * 1_000_000) + 1;
      const promise = sendRequest();
      // Fire `$/progress` right after the handler is registered. The
      // op registers the handler BEFORE invoking sendCancellableRequest,
      // so capturedHandler is already set.
      if (capturedHandler) {
        capturedHandler({ items: progressItems });
      }
      return { id, promise };
    });

    const cache = new DiagnosticsCache();
    const state = buildState({ transport, diagnosticsCache: cache });

    // Tiny deadline so the race fires quickly.
    const result = await workspaceDiagnostic(state, { deadline: Date.now() + 80 });

    // Op returns BUDGET (deadline race rejected via RequestCancelledError).
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('BUDGET');

    // Despite the cancellation, the cache was populated from the progress
    // payload — this is the PR3 partial-flush write-through behavior.
    expect(cache.getResultId('file:///flushed.ts')).toBe('p1');
    expect(cache.get('file:///flushed.ts')).toEqual([sampleDiag('flushed-during-progress')]);

    // The progress token registered on the transport must match the one
    // the op generated.
    expect(typeof capturedToken).toBe('string');
  });

  it('result ids are segmented per serverKey (separate caches do not bleed)', async () => {
    // Each ServerState carries its own DiagnosticsCache instance. The PR3
    // contract uses the per-state cache, so two states with two caches
    // must not see each other's resultIds.
    const transportA = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({
        items: [
          {
            uri: 'file:///a.ts',
            kind: 'full',
            version: 1,
            resultId: 'rid-A-only',
            items: [sampleDiag('a')],
          },
        ] satisfies WorkspaceDocumentDiagnosticReport[],
      }),
    });
    const transportB = createMockTransport({
      sendRequest: jest.fn().mockResolvedValue({
        items: [
          {
            uri: 'file:///b.py',
            kind: 'full',
            version: 1,
            resultId: 'rid-B-only',
            items: [sampleDiag('b')],
          },
        ] satisfies WorkspaceDocumentDiagnosticReport[],
      }),
    });

    const cacheA = new DiagnosticsCache();
    const cacheB = new DiagnosticsCache();
    const stateA = buildState({ transport: transportA, diagnosticsCache: cacheA });
    const stateB = buildState({ transport: transportB, diagnosticsCache: cacheB });

    await workspaceDiagnostic(stateA, { deadline: Date.now() + 5000 });
    await workspaceDiagnostic(stateB, { deadline: Date.now() + 5000 });

    expect(cacheA.getResultId('file:///a.ts')).toBe('rid-A-only');
    expect(cacheA.getResultId('file:///b.py')).toBeUndefined();
    expect(cacheB.getResultId('file:///b.py')).toBe('rid-B-only');
    expect(cacheB.getResultId('file:///a.ts')).toBeUndefined();

    // Now drive a SECOND call against each state and assert each only
    // advertises its own cache.
    await workspaceDiagnostic(stateA, { deadline: Date.now() + 5000 });
    await workspaceDiagnostic(stateB, { deadline: Date.now() + 5000 });

    const callA2 = transportA.sendRequest.mock.calls[1];
    const callB2 = transportB.sendRequest.mock.calls[1];
    if (!callA2 || !callB2) throw new Error('expected two calls per state');
    const paramsA = callA2[1] as { previousResultIds: Array<{ uri: string; value: string }> };
    const paramsB = callB2[1] as { previousResultIds: Array<{ uri: string; value: string }> };
    expect(paramsA.previousResultIds).toEqual([{ uri: 'file:///a.ts', value: 'rid-A-only' }]);
    expect(paramsB.previousResultIds).toEqual([{ uri: 'file:///b.py', value: 'rid-B-only' }]);
  });
});
