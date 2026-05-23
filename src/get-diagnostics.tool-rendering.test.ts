import { beforeEach, describe, expect, it, jest } from 'bun:test';
import type { LSPClient } from './lsp-client.js';
import { getDiagnosticsTool } from './tools/diagnostics.js';
import type { Diagnostic } from './types.js';

/**
 * Tool-renderer regression for the single-file `get_diagnostics` MCP tool.
 *
 * This file pins the exact rendered text produced by `getDiagnosticsTool` for
 * a realistic mix of diagnostic shapes (error/warning/information/hint, with
 * and without `code`/`source`). It deliberately mocks `LSPClient.getDiagnostics`
 * because the unit-under-test is the *tool renderer*, not the underlying LSP
 * op. The op-path regression lives in `src/lsp/operations.get-diagnostics.test.ts`.
 *
 * If PR2/PR3 ever change the rendered text format, this test will fail and the
 * change must be evaluated explicitly. To regenerate after an *intentional*
 * format change, replace the EXPECTED_OUTPUT block with the new rendering —
 * and only when the change is deliberate and reviewed.
 */

type MockLSPClient = {
  getDiagnostics: ReturnType<typeof jest.fn>;
};

function createMockClient(): MockLSPClient {
  return {
    getDiagnostics: jest.fn(),
  };
}

function callHandler(args: { file_path: string }, mock: MockLSPClient) {
  return getDiagnosticsTool.handler(args as Record<string, unknown>, mock as unknown as LSPClient);
}

const SNAPSHOT_DIAGNOSTICS: Diagnostic[] = [
  {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
    severity: 1,
    message: 'Missing semicolon',
    code: '1003',
    source: 'typescript',
  },
  {
    range: {
      start: { line: 2, character: 10 },
      end: { line: 2, character: 15 },
    },
    severity: 2,
    message: 'Unused variable',
    source: 'eslint',
  },
  {
    range: {
      start: { line: 5, character: 0 },
      end: { line: 5, character: 20 },
    },
    severity: 3,
    message: 'Consider using const',
  },
  {
    range: {
      start: { line: 10, character: 4 },
      end: { line: 10, character: 8 },
    },
    severity: 4,
    message: 'Add type annotation',
    code: 'no-implicit-any',
  },
];

const EXPECTED_OUTPUT = [
  'Found 4 diagnostics in src/example.ts:',
  '',
  '• Error [1003] (typescript): Missing semicolon',
  '  Location: Line 1, Column 1 to Line 1, Column 6',
  '',
  '• Warning (eslint): Unused variable',
  '  Location: Line 3, Column 11 to Line 3, Column 16',
  '',
  '• Information: Consider using const',
  '  Location: Line 6, Column 1 to Line 6, Column 21',
  '',
  '• Hint [no-implicit-any]: Add type annotation',
  '  Location: Line 11, Column 5 to Line 11, Column 9',
].join('\n');

describe('get_diagnostics tool renderer (single-file)', () => {
  let mockClient: MockLSPClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('renders a mixed-severity snapshot byte-for-byte (pins existing format)', async () => {
    mockClient.getDiagnostics.mockResolvedValue(SNAPSHOT_DIAGNOSTICS);

    const result = await callHandler({ file_path: 'src/example.ts' }, mockClient);

    const text = result.content[0]?.text;
    expect(text).toBe(EXPECTED_OUTPUT);
  });

  it('renders the "no diagnostics" message byte-for-byte', async () => {
    mockClient.getDiagnostics.mockResolvedValue([]);

    const result = await callHandler({ file_path: 'src/clean.ts' }, mockClient);

    expect(result.content[0]?.text).toBe(
      'No diagnostics found for src/clean.ts. The file has no errors, warnings, or hints.'
    );
  });

  it('renders the singular form for exactly one diagnostic', async () => {
    mockClient.getDiagnostics.mockResolvedValue([
      {
        range: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 10 },
        },
        severity: 1,
        message: 'Undefined variable',
        code: 'TS2304',
        source: 'typescript',
      },
    ]);

    const result = await callHandler({ file_path: 'src/single.ts' }, mockClient);

    expect(result.content[0]?.text).toBe(
      [
        'Found 1 diagnostic in src/single.ts:',
        '',
        '• Error [TS2304] (typescript): Undefined variable',
        '  Location: Line 1, Column 6 to Line 1, Column 11',
      ].join('\n')
    );
  });

  it('renders the error path byte-for-byte', async () => {
    mockClient.getDiagnostics.mockRejectedValue(new Error('LSP server not available'));

    const result = await callHandler({ file_path: 'src/x.ts' }, mockClient);

    expect(result.content[0]?.text).toBe('Error getting diagnostics: LSP server not available');
  });
});
