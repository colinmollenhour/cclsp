import { describe, expect, it } from 'bun:test';
import type { Diagnostic, DiagnosticsByFile } from '../lsp/types.js';
import { clipMessage, filterDiagnostics, renderBatch, renderHeader } from './diagnostics-format.js';

function mkDiag(opts: Partial<Diagnostic> = {}): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    message: 'oops',
    source: 'mock',
    code: 'E001',
    ...opts,
  };
}

function mkFile(uri: string, items: Diagnostic[]): DiagnosticsByFile {
  return { uri, items };
}

describe('filterDiagnostics', () => {
  it('drops diagnostics below min_severity', () => {
    const items = [
      mkFile('file:///a.ts', [
        mkDiag({ severity: 1, message: 'err' }),
        mkDiag({ severity: 2, message: 'warn' }),
        mkDiag({ severity: 3, message: 'info' }),
        mkDiag({ severity: 4, message: 'hint' }),
      ]),
    ];
    const res = filterDiagnostics(items, {
      minSeverity: 'warning',
      maxDiagnostics: 100,
    });
    const msgs = res.filtered.flatMap((f) => f.items.map((d) => d.message));
    expect(msgs).toEqual(['err', 'warn']);
    expect(res.counts.errors).toBe(1);
    expect(res.counts.warnings).toBe(1);
  });

  it('honors sources whitelist', () => {
    const items = [
      mkFile('file:///a.ts', [
        mkDiag({ source: 'typescript', severity: 1 }),
        mkDiag({ source: 'eslint', severity: 1 }),
        mkDiag({ source: undefined, severity: 1 }),
      ]),
    ];
    const res = filterDiagnostics(items, {
      minSeverity: 'hint',
      sources: ['typescript'],
      maxDiagnostics: 100,
    });
    expect(res.filtered[0]?.items).toHaveLength(1);
    expect(res.filtered[0]?.items[0]?.source).toBe('typescript');
  });

  it('honors exclude_codes blacklist', () => {
    const items = [
      mkFile('file:///a.ts', [
        mkDiag({ code: 'E001', severity: 1 }),
        mkDiag({ code: 'E002', severity: 1 }),
      ]),
    ];
    const res = filterDiagnostics(items, {
      minSeverity: 'hint',
      excludeCodes: ['E001'],
      maxDiagnostics: 100,
    });
    expect(res.filtered[0]?.items).toHaveLength(1);
    expect(res.filtered[0]?.items[0]?.code).toBe('E002');
  });

  it('truncates highest-severity-first when above max_diagnostics', () => {
    const items = [
      mkFile('file:///a.ts', [
        mkDiag({ severity: 4, message: 'h1' }),
        mkDiag({ severity: 2, message: 'w1' }),
        mkDiag({ severity: 1, message: 'e1' }),
        mkDiag({ severity: 1, message: 'e2' }),
        mkDiag({ severity: 3, message: 'i1' }),
      ]),
    ];
    const res = filterDiagnostics(items, {
      minSeverity: 'hint',
      maxDiagnostics: 2,
    });
    expect(res.counts.truncatedBy).toBe('MAX_DIAGNOSTICS');
    expect(res.counts.totalAfter).toBe(2);
    const msgs = res.filtered.flatMap((f) => f.items.map((d) => d.message));
    // Both errors should win (severity 1).
    expect(msgs.sort()).toEqual(['e1', 'e2']);
  });

  it('truncation is deterministic across runs', () => {
    const items = [
      mkFile('file:///b.ts', [
        mkDiag({ severity: 1, message: 'b-e1' }),
        mkDiag({ severity: 2, message: 'b-w1' }),
      ]),
      mkFile('file:///a.ts', [
        mkDiag({ severity: 1, message: 'a-e1' }),
        mkDiag({ severity: 2, message: 'a-w1' }),
      ]),
    ];
    const r1 = filterDiagnostics(items, { minSeverity: 'hint', maxDiagnostics: 2 });
    const r2 = filterDiagnostics(items, { minSeverity: 'hint', maxDiagnostics: 2 });
    const flat1 = r1.filtered.flatMap((f) => f.items.map((d) => d.message)).join(',');
    const flat2 = r2.filtered.flatMap((f) => f.items.map((d) => d.message)).join(',');
    expect(flat1).toBe(flat2);
  });
});

describe('clipMessage', () => {
  it('returns original when within 240 chars', () => {
    const { text, originalLen } = clipMessage('short');
    expect(text).toBe('short');
    expect(originalLen).toBe(5);
  });

  it('clips messages > 240 chars to 239 + ellipsis', () => {
    const msg = 'x'.repeat(300);
    const { text, originalLen } = clipMessage(msg);
    expect(originalLen).toBe(300);
    expect(text.length).toBe(240);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('renderBatch formats', () => {
  const fixture = [
    mkFile('file:///a.ts', [
      mkDiag({ severity: 1, message: 'err-a', code: 'E1' }),
      mkDiag({ severity: 2, message: 'warn-a', code: 'W1' }),
    ]),
    mkFile('file:///b.ts', [mkDiag({ severity: 1, message: 'err-b', code: 'E2' })]),
  ];

  it('by_file format includes per-file headers and bullets', () => {
    const r = renderBatch(fixture, {
      format: 'by_file',
      groupBy: 'file',
      maxBytes: 100000,
      header: 'HEADER',
    });
    expect(r.text).toContain('a.ts');
    expect(r.text).toContain('b.ts');
    expect(r.text).toContain('•');
    expect(r.text).toContain('err-a');
    expect(r.text).toContain('warn-a');
    expect(r.text).toContain('err-b');
  });

  it('summary format lists files and counts', () => {
    const r = renderBatch(fixture, {
      format: 'summary',
      groupBy: 'file',
      maxBytes: 100000,
      header: 'HEADER',
    });
    expect(r.text).toContain('Summary');
    expect(r.text).toMatch(/a\.ts/);
    expect(r.text).toMatch(/→ 2/);
  });

  it('flat format includes messageLen annotation', () => {
    const r = renderBatch(fixture, {
      format: 'flat',
      groupBy: 'file',
      maxBytes: 100000,
      header: 'HEADER',
    });
    expect(r.text).toContain('messageLen:');
  });

  it('json format produces a fenced JSON block', () => {
    const r = renderBatch(fixture, {
      format: 'json',
      groupBy: 'file',
      maxBytes: 100000,
      header: 'HEADER',
    });
    expect(r.text).toContain('```json');
    expect(r.text).toContain('```');
  });

  it('by_file auto-falls back to summary when projected size > max_bytes', () => {
    // Build a fixture that is genuinely large in by_file form.
    const big: DiagnosticsByFile[] = [];
    for (let f = 0; f < 50; f++) {
      const items: Diagnostic[] = [];
      for (let i = 0; i < 20; i++) {
        items.push(
          mkDiag({
            severity: 1,
            message: `lorem ipsum dolor sit amet ${i}`,
            code: `C${i}`,
          })
        );
      }
      big.push(mkFile(`file:///f${f}.ts`, items));
    }
    const r = renderBatch(big, {
      format: 'by_file',
      groupBy: 'file',
      maxBytes: 1500,
      header: 'HEADER',
    });
    expect(r.autoFallback).toBe('by_file_to_summary');
  });

  it('hard-truncates output when over max_bytes', () => {
    const items: Diagnostic[] = [];
    for (let i = 0; i < 100; i++) {
      items.push(mkDiag({ message: `lorem ipsum dolor sit amet ${i}` }));
    }
    const r = renderBatch([mkFile('file:///a.ts', items)], {
      format: 'flat',
      groupBy: 'file',
      maxBytes: 500,
      header: 'HEADER',
    });
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(500);
    expect(r.text).toContain('output truncated');
  });
});

describe('renderHeader', () => {
  it('renders OK status with severity counts and caps', () => {
    const counts = {
      errors: 3,
      warnings: 5,
      info: 0,
      hints: 0,
      totalBefore: 8,
      totalAfter: 8,
      topSources: [{ source: 'typescript', count: 8 }],
      topCodes: [],
    };
    const header = renderHeader({
      status: 'OK',
      scope: 'workspace',
      root: '/repo',
      bucketCount: 1,
      filesConsidered: 10,
      filesWithDiagnostics: 4,
      counts,
      caps: { max_files: 1000, max_diagnostics: 500, max_bytes: 32768, time_budget_ms: 30000 },
      filters: { min_severity: 'warning' },
    });
    expect(header).toContain('get_workspace_diagnostics — OK');
    expect(header).toContain('Scope: workspace  Root: /repo');
    expect(header).toContain('Severity counts: errors=3, warnings=5');
    expect(header).toContain('Top sources: typescript:8');
    expect(header).toContain('Caps: max_files=1000');
  });

  it('renders BUDGET banner when partial', () => {
    const counts = {
      errors: 0,
      warnings: 0,
      info: 0,
      hints: 0,
      totalBefore: 0,
      totalAfter: 0,
      topSources: [],
      topCodes: [],
    };
    const header = renderHeader({
      status: 'PARTIAL',
      scope: 'workspace',
      root: '/repo',
      bucketCount: 1,
      filesConsidered: 0,
      filesWithDiagnostics: 0,
      counts,
      caps: { max_files: 1000, max_diagnostics: 500, max_bytes: 32768, time_budget_ms: 30000 },
      filters: { min_severity: 'warning' },
      partialReasons: ['BUDGET'],
      budgetMs: 30000,
      resultsCollected: 0,
    });
    expect(header).toContain('Wall-clock budget exhausted (BUDGET): 30000 ms');
    expect(header).toContain('0 results collected');
  });

  it('renders MAX_FILES banner', () => {
    const counts = {
      errors: 0,
      warnings: 0,
      info: 0,
      hints: 0,
      totalBefore: 0,
      totalAfter: 0,
      topSources: [],
      topCodes: [],
    };
    const header = renderHeader({
      status: 'PARTIAL',
      scope: 'patterns',
      root: '/repo',
      bucketCount: 1,
      filesConsidered: 1000,
      filesWithDiagnostics: 0,
      counts,
      caps: { max_files: 1000, max_diagnostics: 500, max_bytes: 32768, time_budget_ms: 30000 },
      filters: { min_severity: 'warning' },
      partialReasons: ['MAX_FILES'],
      droppedCounts: {
        gitignored: 0,
        notMatched: 0,
        escaped: 0,
        unreadable: 0,
        maxFiles: 3823,
      },
    });
    expect(header).toContain('File cap hit (MAX_FILES)');
    expect(header).toContain('truncated input from 4823 to 1000');
  });

  it('renders MAX_DIAGNOSTICS banner', () => {
    const counts = {
      errors: 500,
      warnings: 0,
      info: 0,
      hints: 0,
      totalBefore: 1247,
      totalAfter: 500,
      topSources: [],
      topCodes: [],
      truncatedBy: 'MAX_DIAGNOSTICS' as const,
    };
    const header = renderHeader({
      status: 'PARTIAL',
      scope: 'workspace',
      root: '/repo',
      bucketCount: 1,
      filesConsidered: 50,
      filesWithDiagnostics: 25,
      counts,
      caps: { max_files: 1000, max_diagnostics: 500, max_bytes: 32768, time_budget_ms: 30000 },
      filters: { min_severity: 'warning' },
      partialReasons: ['MAX_DIAGNOSTICS'],
    });
    expect(header).toContain('Diagnostic cap hit (MAX_DIAGNOSTICS): 500/1247');
  });

  it('renders MAX_BYTES banner', () => {
    const counts = {
      errors: 0,
      warnings: 0,
      info: 0,
      hints: 0,
      totalBefore: 0,
      totalAfter: 0,
      topSources: [],
      topCodes: [],
    };
    const header = renderHeader({
      status: 'PARTIAL',
      scope: 'workspace',
      root: '/repo',
      bucketCount: 1,
      filesConsidered: 0,
      filesWithDiagnostics: 0,
      counts,
      caps: { max_files: 1000, max_diagnostics: 500, max_bytes: 32768, time_budget_ms: 30000 },
      filters: { min_severity: 'warning' },
      partialReasons: ['MAX_BYTES'],
      autoFallback: 'by_file_to_summary',
    });
    expect(header).toContain('Output size cap hit (MAX_BYTES)');
    expect(header).toContain('Auto-fallback: by_file → summary');
  });

  it('renders SERVER_CRASH banner', () => {
    const counts = {
      errors: 0,
      warnings: 0,
      info: 0,
      hints: 0,
      totalBefore: 0,
      totalAfter: 0,
      topSources: [],
      topCodes: [],
    };
    const header = renderHeader({
      status: 'PARTIAL',
      scope: 'workspace',
      root: '/repo',
      bucketCount: 2,
      filesConsidered: 10,
      filesWithDiagnostics: 5,
      counts,
      caps: { max_files: 1000, max_diagnostics: 500, max_bytes: 32768, time_budget_ms: 30000 },
      filters: { min_severity: 'warning' },
      partialReasons: ['SERVER_CRASH'],
      partialBuckets: ['pylsp@/repo'],
    });
    expect(header).toContain('Server crash (SERVER_CRASH)');
    expect(header).toContain('pylsp@/repo');
  });
});
