import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LSPClient } from './lsp-client.js';
import type { ServerState } from './lsp/types.js';
import { pathToUri } from './utils.js';

/** Write a file using Bun.write to avoid node:fs mock interference. */
async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

/**
 * Tests for the LSPClient.getDiagnosticsBatch wiring layer.
 * Stubs serverManager.getServer to return a synthetic ServerState so we can
 * verify file→bucket routing, shared deadline propagation, and the
 * inFlightBatchCount increment/decrement contract.
 */

/** Access the private `serverManager` field for test spying. */
function getServerManager(client: LSPClient): {
  getServer: (cfg: unknown) => Promise<ServerState>;
} {
  return (
    client as unknown as { serverManager: { getServer: (cfg: unknown) => Promise<ServerState> } }
  ).serverManager;
}

function makeServerState(opts: {
  configCommand: string[];
  capabilities?: ServerState['capabilities'];
  sendRequest?: (...args: unknown[]) => Promise<unknown>;
}): ServerState {
  const inFlightTracker = { current: 0, peak: 0 };
  const state: ServerState = {
    process: { kill: jest.fn() } as never,
    transport: {
      sendRequest: opts.sendRequest ?? jest.fn().mockResolvedValue({ kind: 'full', items: [] }),
      sendMessage: jest.fn(),
      sendNotification: jest.fn(),
      rejectAllPending: jest.fn(),
      cancelRequest: jest.fn(),
      registerProgressHandler: jest.fn(),
      unregisterProgressHandler: jest.fn(),
    },
    documentManager: {
      ensureOpen: jest.fn().mockResolvedValue(false),
      ensureOpenAsync: jest.fn().mockResolvedValue(false),
      closeDocument: jest.fn(),
      sendChange: jest.fn(),
      isOpen: jest.fn().mockReturnValue(true),
      getVersion: jest.fn().mockReturnValue(1),
    },
    initialized: true,
    initializationPromise: Promise.resolve(),
    startTime: Date.now(),
    config: { extensions: ['ts'], command: opts.configCommand },
    diagnosticsCache: {
      update: jest.fn(),
      get: jest.fn().mockReturnValue(undefined),
      waitForIdle: jest.fn().mockResolvedValue(undefined),
      setResultId: jest.fn(),
      getResultId: jest.fn().mockReturnValue(undefined),
    },
    capabilities: opts.capabilities,
    inFlightBatchCount: 0,
  };
  // Stash counter on the state for inspection.
  (state as { __tracker?: typeof inFlightTracker }).__tracker = inFlightTracker;
  return state;
}

describe('LSPClient.getDiagnosticsBatch', () => {
  let TEST_DIR: string;
  let configPath: string;

  beforeEach(async () => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-lsp-client-batch-'));
    configPath = join(TEST_DIR, 'cclsp.json');
    const config = {
      servers: [
        {
          extensions: ['ts', 'tsx'],
          command: ['typescript-language-server', '--stdio'],
        },
        {
          extensions: ['py'],
          command: ['pylsp'],
        },
      ],
    };
    await writeFile(configPath, JSON.stringify(config));
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });
    await writeFile(join(TEST_DIR, 'src/a.ts'), 'x');
    await writeFile(join(TEST_DIR, 'src/b.py'), 'y');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('buckets files across two server configs and uses a single shared deadline', async () => {
    const client = new LSPClient(configPath);
    const aTs = join(TEST_DIR, 'src/a.ts');
    const bPy = join(TEST_DIR, 'src/b.py');

    const tsState = makeServerState({
      configCommand: ['typescript-language-server', '--stdio'],
      capabilities: { diagnosticProvider: true },
    });
    const pyState = makeServerState({
      configCommand: ['pylsp'],
      capabilities: { diagnosticProvider: true },
    });

    spyOn(getServerManager(client), 'getServer').mockImplementation(async (cfg: unknown) => {
      const c = cfg as { command: string[] };
      if (c.command[0] === 'pylsp') return pyState;
      return tsState;
    });

    const result = await client.getDiagnosticsBatch({
      paths: [aTs, bPy],
      timeBudgetMs: 5000,
    });

    expect(result.buckets.length).toBe(2);
    const bucketKeys = result.buckets.map((b) => b.serverKey).sort();
    expect(bucketKeys[0]).toContain('pylsp');
    expect(bucketKeys[1]).toContain('typescript-language-server');

    // Each bucket runs perFilePullBatch (because supportsTextDocumentDiagnostic
    // is true on the boolean form, but workspaceDiagnostics is false).
    expect(tsState.transport.sendRequest).toHaveBeenCalledWith(
      'textDocument/diagnostic',
      { textDocument: { uri: pathToUri(aTs) } },
      expect.any(Number)
    );
    expect(pyState.transport.sendRequest).toHaveBeenCalledWith(
      'textDocument/diagnostic',
      { textDocument: { uri: pathToUri(bPy) } },
      expect.any(Number)
    );

    client.dispose();
  });

  it('increments and decrements inFlightBatchCount via try/finally', async () => {
    const client = new LSPClient(configPath);
    const aTs = join(TEST_DIR, 'src/a.ts');

    let observedDuring = -1;
    const tsState = makeServerState({
      configCommand: ['typescript-language-server', '--stdio'],
      capabilities: { diagnosticProvider: true },
      sendRequest: jest.fn(async () => {
        observedDuring = tsState.inFlightBatchCount ?? 0;
        return { kind: 'full', items: [] };
      }),
    });

    spyOn(getServerManager(client), 'getServer').mockResolvedValue(tsState);

    await client.getDiagnosticsBatch({ paths: [aTs], timeBudgetMs: 2000 });

    expect(observedDuring).toBe(1);
    // After return, must be back to 0.
    expect(tsState.inFlightBatchCount).toBe(0);

    client.dispose();
  });

  it('falls through to perFilePullBatch when workspaceDiagnostics=false on workspace scope', async () => {
    const client = new LSPClient(configPath);
    const tsState = makeServerState({
      configCommand: ['typescript-language-server', '--stdio'],
      capabilities: { diagnosticProvider: true },
    });
    const pyState = makeServerState({
      configCommand: ['pylsp'],
      capabilities: { diagnosticProvider: true },
    });
    spyOn(getServerManager(client), 'getServer').mockImplementation(async (cfg: unknown) => {
      const c = cfg as { command: string[] };
      if (c.command[0] === 'pylsp') return pyState;
      return tsState;
    });

    // workspace scope: empty paths/patterns; both buckets get per-file path
    // (perFilePullBatch on zero files = empty result).
    const result = await client.getDiagnosticsBatch({ timeBudgetMs: 2000 });
    expect(result.buckets.length).toBe(2);
    // No sendRequest because both buckets have 0 files in workspace mode here.
    expect(tsState.transport.sendRequest).not.toHaveBeenCalled();
    expect(pyState.transport.sendRequest).not.toHaveBeenCalled();

    client.dispose();
  });

  it('uses workspace/diagnostic when server advertises workspaceDiagnostics=true', async () => {
    const client = new LSPClient(configPath);
    const tsState = makeServerState({
      configCommand: ['typescript-language-server', '--stdio'],
      capabilities: {
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      },
      sendRequest: jest.fn().mockResolvedValue({ items: [] }),
    });
    const pyState = makeServerState({
      configCommand: ['pylsp'],
      capabilities: {
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      },
      sendRequest: jest.fn().mockResolvedValue({ items: [] }),
    });
    spyOn(getServerManager(client), 'getServer').mockImplementation(async (cfg: unknown) => {
      const c = cfg as { command: string[] };
      if (c.command[0] === 'pylsp') return pyState;
      return tsState;
    });

    await client.getDiagnosticsBatch({ timeBudgetMs: 2000 });

    expect(tsState.transport.sendRequest).toHaveBeenCalledWith(
      'workspace/diagnostic',
      expect.any(Object),
      expect.any(Number)
    );
    expect(pyState.transport.sendRequest).toHaveBeenCalledWith(
      'workspace/diagnostic',
      expect.any(Object),
      expect.any(Number)
    );

    client.dispose();
  });

  it('handles bucket throwing as SERVER_CRASH', async () => {
    const client = new LSPClient(configPath);
    const aTs = join(TEST_DIR, 'src/a.ts');

    const tsState = makeServerState({
      configCommand: ['typescript-language-server', '--stdio'],
      capabilities: { diagnosticProvider: true },
    });
    spyOn(getServerManager(client), 'getServer').mockRejectedValue(new Error('cannot start'));

    const result = await client.getDiagnosticsBatch({ paths: [aTs], timeBudgetMs: 2000 });
    expect(result.partial).toBe(true);
    expect(result.partialReasons).toContain('SERVER_CRASH');
    void tsState;
    client.dispose();
  });

  it('skips workspace-scope buckets for servers whose extensions are not in root (S3)', async () => {
    // Build a separate config with a Go server alongside the TS server. The
    // tmpdir only contains *.ts/*.py files, so the Go server should NOT
    // get a bucket on workspace scope.
    const customConfig = {
      servers: [
        {
          extensions: ['ts', 'tsx'],
          command: ['typescript-language-server', '--stdio'],
        },
        {
          extensions: ['go'],
          command: ['gopls'],
        },
      ],
    };
    const customConfigPath = join(TEST_DIR, 'cclsp-go.json');
    await writeFile(customConfigPath, JSON.stringify(customConfig));

    const client = new LSPClient(customConfigPath);
    const tsState = makeServerState({
      configCommand: ['typescript-language-server', '--stdio'],
      capabilities: { diagnosticProvider: true },
    });
    const goState = makeServerState({
      configCommand: ['gopls'],
      capabilities: { diagnosticProvider: true },
    });
    spyOn(getServerManager(client), 'getServer').mockImplementation(async (cfg: unknown) => {
      const c = cfg as { command: string[] };
      if (c.command[0] === 'gopls') return goState;
      return tsState;
    });

    const result = await client.getDiagnosticsBatch({
      root: TEST_DIR,
      timeBudgetMs: 2000,
    });

    const bucketKeys = result.buckets.map((b) => b.serverKey);
    const hasGo = bucketKeys.some((k) => k.includes('gopls'));
    expect(hasGo).toBe(false);
    // Sanity check: the TS bucket exists.
    expect(bucketKeys.some((k) => k.includes('typescript-language-server'))).toBe(true);

    client.dispose();
  });

  it('aggregates global BUDGET when one bucket times out and another succeeds (F6)', async () => {
    const client = new LSPClient(configPath);
    const aTs = join(TEST_DIR, 'src/a.ts');
    const bPy = join(TEST_DIR, 'src/b.py');

    // TS bucket succeeds quickly.
    const tsState = makeServerState({
      configCommand: ['typescript-language-server', '--stdio'],
      capabilities: { diagnosticProvider: true },
      sendRequest: jest.fn().mockResolvedValue({ kind: 'full', items: [] }),
    });

    // pylsp bucket: sendCancellableRequest returns a never-resolving promise
    // until the bucket cancels via cancelRequest. This forces a BUDGET drop.
    const pending: Array<{ id: number; reject: (e: unknown) => void }> = [];
    let nextId = 200;
    const pyState = makeServerState({
      configCommand: ['pylsp'],
      capabilities: { diagnosticProvider: true },
    });
    (pyState.transport as { sendCancellableRequest: unknown }).sendCancellableRequest = jest.fn(
      () => {
        const id = nextId++;
        const promise = new Promise((_r, reject) => {
          pending.push({ id, reject });
        });
        return { id, promise };
      }
    );
    (pyState.transport as { cancelRequest: unknown }).cancelRequest = jest.fn((id: number) => {
      const e = pending.find((p) => p.id === id);
      if (e) {
        // Lazy require to avoid hoisting issues with bun:test.
        const { RequestCancelledError } = require('./lsp/json-rpc.js') as {
          RequestCancelledError: new (id: number) => Error;
        };
        e.reject(new RequestCancelledError(id));
      }
    });

    spyOn(getServerManager(client), 'getServer').mockImplementation(async (cfg: unknown) => {
      const c = cfg as { command: string[] };
      if (c.command[0] === 'pylsp') return pyState;
      return tsState;
    });

    const result = await client.getDiagnosticsBatch({
      paths: [aTs, bPy],
      timeBudgetMs: 150,
    });

    expect(result.partial).toBe(true);
    expect(result.partialReasons).toContain('BUDGET');
    expect(result.partialReasons).not.toContain('SERVER_CRASH');

    client.dispose();
  });
});
