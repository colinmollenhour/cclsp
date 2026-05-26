import { describe, expect, it, jest } from 'bun:test';
import type { LSPClient } from '../lsp-client.js';
import type { BatchDiagnosticsRequest, BatchDiagnosticsResult, Diagnostic } from '../lsp/types.js';
import { getWorkspaceDiagnosticsTool } from './diagnostics.js';

/**
 * Handler-level tests for `get_workspace_diagnostics`. We mock the
 * `getDiagnosticsBatch` method on LSPClient so we can drive the handler's
 * argument parsing, formatting, and cap-hit rendering without spawning
 * any LSP servers.
 */

function mkDiag(opts: Partial<Diagnostic> = {}): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    message: 'oops',
    source: 'mock',
    code: 'E1',
    ...opts,
  };
}

function buildBatchResult(overrides: Partial<BatchDiagnosticsResult>): BatchDiagnosticsResult {
  return {
    items: [],
    buckets: [],
    filesConsidered: 0,
    filesWithDiagnostics: 0,
    scope: 'workspace',
    rootDir: '/repo',
    resolvedRoot: '/repo',
    partial: false,
    partialReasons: [],
    droppedCounts: {
      gitignored: 0,
      notMatched: 0,
      escaped: 0,
      unreadable: 0,
      maxFiles: 0,
    },
    completedBucketKeys: [],
    partialBucketKeys: [],
    ...overrides,
  };
}

interface MockClient {
  getDiagnosticsBatch: ReturnType<typeof jest.fn>;
  capturedRequest?: BatchDiagnosticsRequest;
}

function createMockClient(result: BatchDiagnosticsResult): MockClient {
  const mock: MockClient = {
    getDiagnosticsBatch: jest.fn(),
  };
  mock.getDiagnosticsBatch.mockImplementation(async (req: BatchDiagnosticsRequest) => {
    mock.capturedRequest = req;
    return result;
  });
  return mock;
}

async function callHandler(
  args: Record<string, unknown>,
  client: MockClient
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return getWorkspaceDiagnosticsTool.handler(args, client as unknown as LSPClient);
}

describe('get_workspace_diagnostics MCP tool', () => {
  it('emits OK status when there are zero diagnostics across some files', async () => {
    const client = createMockClient(
      buildBatchResult({
        items: [],
        filesConsidered: 5,
      })
    );
    const result = await callHandler({}, client);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('get_workspace_diagnostics — OK');
    expect(text).toContain('No diagnostics found across 5 files');
    expect(result.isError).toBeUndefined();
  });

  it('emits EMPTY status when no files matched', async () => {
    const client = createMockClient(
      buildBatchResult({
        items: [],
        filesConsidered: 0,
      })
    );
    const result = await callHandler({}, client);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('get_workspace_diagnostics — EMPTY');
    expect(text).toContain('No files matched');
  });

  it('passes both paths and patterns through to the client (union)', async () => {
    const client = createMockClient(buildBatchResult({}));
    await callHandler(
      {
        paths: ['/repo/a.ts'],
        patterns: ['src/**/*.ts'],
      },
      client
    );
    expect(client.capturedRequest?.paths).toEqual(['/repo/a.ts']);
    expect(client.capturedRequest?.patterns).toEqual(['src/**/*.ts']);
  });

  it('passes include_unopened=false through to the client', async () => {
    const client = createMockClient(buildBatchResult({}));
    await callHandler({ include_unopened: false }, client);
    expect(client.capturedRequest?.includeUnopened).toBe(false);
  });

  it('renders by_file format with diagnostics', async () => {
    const client = createMockClient(
      buildBatchResult({
        items: [
          {
            uri: 'file:///a.ts',
            items: [
              mkDiag({ severity: 1, message: 'err-a', code: 'E1' }),
              mkDiag({ severity: 2, message: 'warn-a', code: 'W1' }),
            ],
          },
        ],
        filesConsidered: 1,
        filesWithDiagnostics: 1,
      })
    );
    const result = await callHandler({ format: 'by_file' }, client);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('a.ts');
    expect(text).toContain('err-a');
    expect(text).toContain('warn-a');
  });

  it('shows MAX_DIAGNOSTICS banner when filter truncates', async () => {
    const items = Array.from({ length: 600 }, (_, i) =>
      mkDiag({ severity: 1, message: `err${i}`, code: `C${i}` })
    );
    const client = createMockClient(
      buildBatchResult({
        items: [{ uri: 'file:///a.ts', items }],
        filesConsidered: 1,
        filesWithDiagnostics: 1,
      })
    );
    const result = await callHandler({ format: 'summary' }, client);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Diagnostic cap hit (MAX_DIAGNOSTICS)');
    expect(text).toContain('500/600');
    expect(result.isError).toBeUndefined();
  });

  it('shows BUDGET banner when client returns partial with BUDGET reason', async () => {
    const client = createMockClient(
      buildBatchResult({
        items: [{ uri: 'file:///a.ts', items: [mkDiag({ severity: 1, message: 'partial err' })] }],
        partial: true,
        partialReasons: ['BUDGET'],
        filesConsidered: 5,
        filesWithDiagnostics: 1,
      })
    );
    const result = await callHandler({}, client);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('get_workspace_diagnostics — PARTIAL');
    expect(text).toContain('Wall-clock budget exhausted (BUDGET)');
    expect(result.isError).toBeUndefined();
  });

  it('shows MAX_FILES banner when client returns MAX_FILES partial reason', async () => {
    const client = createMockClient(
      buildBatchResult({
        partial: true,
        partialReasons: ['MAX_FILES'],
        filesConsidered: 1000,
        droppedCounts: {
          gitignored: 0,
          notMatched: 0,
          escaped: 0,
          unreadable: 0,
          maxFiles: 3823,
        },
      })
    );
    const result = await callHandler({}, client);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('File cap hit (MAX_FILES)');
    expect(text).toContain('truncated input from 4823 to 1000');
  });

  it('shows SERVER_CRASH banner', async () => {
    const client = createMockClient(
      buildBatchResult({
        partial: true,
        partialReasons: ['SERVER_CRASH'],
        partialBucketKeys: ['pylsp@/repo'],
      })
    );
    const result = await callHandler({}, client);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Server crash (SERVER_CRASH)');
    expect(text).toContain('pylsp@/repo');
  });

  it('shows MAX_BYTES banner when summary output is hard-truncated', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      uri: `file:///very/long/path/file-${i}.ts`,
      items: [mkDiag({ severity: 1, message: `err${i}`, code: `C${i}` })],
    }));
    const client = createMockClient(
      buildBatchResult({
        items,
        filesConsidered: items.length,
        filesWithDiagnostics: items.length,
      })
    );
    const result = await callHandler({ format: 'summary', max_bytes: 1024 }, client);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('get_workspace_diagnostics — PARTIAL');
    expect(text).toContain('Output size cap hit (MAX_BYTES)');
    expect(text).toContain('output truncated');
  });

  it('clamps invalid integer args to defaults', async () => {
    const client = createMockClient(buildBatchResult({}));
    await callHandler(
      {
        max_files: 999999, // above the schema max 10000
        max_diagnostics: -5, // below minimum 1
        max_bytes: 'not a number',
        time_budget_ms: 1, // below minimum 1000
      },
      client
    );
    expect(client.capturedRequest?.maxFiles).toBe(10000);
    expect(client.capturedRequest?.maxDiagnostics).toBe(1);
    expect(client.capturedRequest?.maxBytes).toBe(32768);
    expect(client.capturedRequest?.timeBudgetMs).toBe(1000);
  });

  it('never sets isError=true even when batch fully crashes', async () => {
    const client: MockClient = {
      getDiagnosticsBatch: jest.fn().mockResolvedValue(
        buildBatchResult({
          partial: true,
          partialReasons: ['SERVER_CRASH'],
        })
      ),
    };
    const result = await callHandler({}, client);
    expect(result.isError).toBeUndefined();
  });

  it('surfaces unexpected exceptions as text without isError', async () => {
    const client: MockClient = {
      getDiagnosticsBatch: jest.fn().mockRejectedValue(new Error('unexpected')),
    };
    const result = await callHandler({}, client);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text ?? '').toContain('get_workspace_diagnostics — ERROR');
    expect(result.content[0]?.text ?? '').toContain('unexpected');
  });

  it('renders flat format with messageLen annotation', async () => {
    const client = createMockClient(
      buildBatchResult({
        items: [
          {
            uri: 'file:///a.ts',
            items: [mkDiag({ severity: 1, message: 'flat test' })],
          },
        ],
        filesConsidered: 1,
        filesWithDiagnostics: 1,
      })
    );
    const result = await callHandler({ format: 'flat' }, client);
    expect(result.content[0]?.text ?? '').toContain('messageLen:');
  });

  it('passes min_severity through to the client', async () => {
    const client = createMockClient(buildBatchResult({}));
    await callHandler({ min_severity: 'error' }, client);
    expect(client.capturedRequest?.minSeverity).toBe('error');
  });

  it('passes sources whitelist through to the client', async () => {
    const client = createMockClient(buildBatchResult({}));
    await callHandler({ sources: ['typescript', 'eslint'] }, client);
    expect(client.capturedRequest?.sources).toEqual(['typescript', 'eslint']);
  });

  it('returns isError=true with a clear message on invalid min_severity', async () => {
    const client = createMockClient(buildBatchResult({}));
    const result = await callHandler({ min_severity: 'critical' }, client);
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('invalid min_severity');
    expect(text).toContain('error, warning, information, hint');
    // Must not have called the client when validation fails.
    expect(client.getDiagnosticsBatch).not.toHaveBeenCalled();
  });

  it('returns isError=true with a clear message on invalid format', async () => {
    const client = createMockClient(buildBatchResult({}));
    const result = await callHandler({ format: 'xml' }, client);
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('invalid format');
    expect(text).toContain('summary, by_file, flat, json');
  });

  it('returns isError=true with a clear message on invalid group_by', async () => {
    const client = createMockClient(buildBatchResult({}));
    const result = await callHandler({ group_by: 'planet' }, client);
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('invalid group_by');
    expect(text).toContain('file, code, source, severity');
  });
});
