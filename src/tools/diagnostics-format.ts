import type { Diagnostic, DiagnosticsByFile, DroppedCounts, PartialReason } from '../lsp/types.js';
import { uriToPath } from '../utils.js';

/**
 * Severity label table. Mirrors the existing single-file tool.
 */
const SEVERITY_NAME: Record<number, string> = {
  1: 'Error',
  2: 'Warning',
  3: 'Information',
  4: 'Hint',
};

const SEVERITY_RANK: Record<string, number> = {
  error: 1,
  warning: 2,
  information: 3,
  hint: 4,
};

const PER_FILE_CAP = 20;
const MESSAGE_CLIP_LIMIT = 240;

export type MinSeverity = 'error' | 'warning' | 'information' | 'hint';
export type RenderFormat = 'summary' | 'by_file' | 'flat' | 'json';
export type GroupBy = 'file' | 'code' | 'source' | 'severity';

export interface FilterOptions {
  minSeverity: MinSeverity;
  sources?: string[];
  excludeCodes?: string[];
  maxDiagnostics: number;
}

export interface FilterCounts {
  errors: number;
  warnings: number;
  info: number;
  hints: number;
  totalBefore: number;
  totalAfter: number;
  /** Top diagnostic source counts (descending, ties broken alphabetically). */
  topSources: Array<{ source: string; count: number }>;
  /** Top diagnostic code counts. */
  topCodes: Array<{ code: string; count: number }>;
  /** Set when filtered output was truncated by max_diagnostics. */
  truncatedBy?: 'MAX_DIAGNOSTICS';
  /** Number of diagnostics dropped after applying max_diagnostics. */
  truncatedCount?: number;
}

export interface FilterResult {
  filtered: DiagnosticsByFile[];
  counts: FilterCounts;
}

/**
 * Apply min_severity / sources / exclude_codes filters, then sort
 * highest-severity first and truncate to `maxDiagnostics`. Stable across
 * runs given the same input.
 */
export function filterDiagnostics(items: DiagnosticsByFile[], opts: FilterOptions): FilterResult {
  const minRank = SEVERITY_RANK[opts.minSeverity] ?? 4;
  const sourcesSet = opts.sources && opts.sources.length > 0 ? new Set(opts.sources) : null;
  const excludeSet =
    opts.excludeCodes && opts.excludeCodes.length > 0 ? new Set(opts.excludeCodes) : null;

  let totalBefore = 0;
  let errors = 0;
  let warnings = 0;
  let info = 0;
  let hints = 0;
  const sourceCounts = new Map<string, number>();
  const codeCounts = new Map<string, number>();

  // Pass 1: filter per-file lists.
  const filteredPerFile: DiagnosticsByFile[] = [];
  for (const file of items) {
    totalBefore += file.items.length;
    const kept: Diagnostic[] = [];
    for (const d of file.items) {
      const sev = d.severity ?? 1;
      if (sev > minRank) continue;
      if (sourcesSet && (!d.source || !sourcesSet.has(d.source))) continue;
      const codeStr = d.code !== undefined ? String(d.code) : undefined;
      if (excludeSet && codeStr && excludeSet.has(codeStr)) continue;
      kept.push(d);
      if (sev === 1) errors++;
      else if (sev === 2) warnings++;
      else if (sev === 3) info++;
      else hints++;
      if (d.source) sourceCounts.set(d.source, (sourceCounts.get(d.source) ?? 0) + 1);
      if (codeStr) codeCounts.set(codeStr, (codeCounts.get(codeStr) ?? 0) + 1);
    }
    if (kept.length > 0) {
      filteredPerFile.push({ uri: file.uri, items: kept });
    }
  }

  let totalAfter = filteredPerFile.reduce((acc, f) => acc + f.items.length, 0);
  let truncatedBy: 'MAX_DIAGNOSTICS' | undefined;
  let truncatedCount: number | undefined;

  // Pass 2: enforce max_diagnostics globally, keeping highest-severity
  // first. We sort a flat list, then rebuild per-file groups.
  if (totalAfter > opts.maxDiagnostics) {
    const flat: Array<{ uri: string; d: Diagnostic; idx: number }> = [];
    let idx = 0;
    for (const f of filteredPerFile) {
      for (const d of f.items) {
        flat.push({ uri: f.uri, d, idx: idx++ });
      }
    }
    flat.sort((a, b) => {
      const sa = a.d.severity ?? 1;
      const sb = b.d.severity ?? 1;
      if (sa !== sb) return sa - sb;
      if (a.uri !== b.uri) return a.uri < b.uri ? -1 : 1;
      const la = a.d.range.start.line;
      const lb = b.d.range.start.line;
      if (la !== lb) return la - lb;
      return a.idx - b.idx;
    });
    const kept = flat.slice(0, opts.maxDiagnostics);
    const keptByUri = new Map<string, Diagnostic[]>();
    for (const k of kept) {
      const arr = keptByUri.get(k.uri);
      if (arr) arr.push(k.d);
      else keptByUri.set(k.uri, [k.d]);
    }
    // Preserve URI ordering from the original filteredPerFile, but drop
    // files whose diagnostics were entirely truncated.
    const rebuilt: DiagnosticsByFile[] = [];
    for (const f of filteredPerFile) {
      const items = keptByUri.get(f.uri);
      if (items && items.length > 0) {
        rebuilt.push({ uri: f.uri, items });
      }
    }
    truncatedBy = 'MAX_DIAGNOSTICS';
    truncatedCount = totalAfter - opts.maxDiagnostics;
    filteredPerFile.length = 0;
    filteredPerFile.push(...rebuilt);
    totalAfter = opts.maxDiagnostics;
  }

  const topSources = Array.from(sourceCounts.entries())
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .slice(0, 5)
    .map(([source, count]) => ({ source, count }));
  const topCodes = Array.from(codeCounts.entries())
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .slice(0, 5)
    .map(([code, count]) => ({ code, count }));

  return {
    filtered: filteredPerFile,
    counts: {
      errors,
      warnings,
      info,
      hints,
      totalBefore,
      totalAfter,
      topSources,
      topCodes,
      truncatedBy,
      truncatedCount,
    },
  };
}

/**
 * Clip a diagnostic `message` to `MESSAGE_CLIP_LIMIT` characters,
 * appending the `…` ellipsis when truncated.
 */
export function clipMessage(message: string): { text: string; originalLen: number } {
  const originalLen = message.length;
  if (originalLen <= MESSAGE_CLIP_LIMIT) return { text: message, originalLen };
  return { text: `${message.slice(0, MESSAGE_CLIP_LIMIT - 1)}…`, originalLen };
}

export interface HeaderArgs {
  status: 'OK' | 'PARTIAL' | 'EMPTY';
  scope: 'workspace' | 'paths' | 'patterns' | 'paths+patterns';
  root: string;
  bucketCount: number;
  filesConsidered: number;
  filesWithDiagnostics: number;
  counts: FilterCounts;
  caps: {
    max_files: number;
    max_diagnostics: number;
    max_bytes: number;
    time_budget_ms: number;
  };
  filters: {
    min_severity: MinSeverity;
    sources?: string[];
    exclude_codes?: string[];
  };
  partialReasons?: PartialReason[];
  partialBuckets?: string[];
  completedBuckets?: string[];
  droppedCounts?: DroppedCounts;
  autoFallback?: 'by_file_to_summary';
  budgetMs?: number;
  resultsCollected?: number;
  filesCollected?: number;
}

/**
 * Render the header block for the batch tool output. The body of the
 * report is rendered by {@link renderBatch}.
 */
export function renderHeader(args: HeaderArgs): string {
  const lines: string[] = [];
  lines.push(`get_workspace_diagnostics — ${args.status}`);

  // Cap-hit banners precede the main metadata so agents see them first.
  if (args.partialReasons && args.partialReasons.length > 0) {
    for (const reason of args.partialReasons) {
      lines.push(...renderReasonBanner(reason, args));
    }
  }
  if (args.autoFallback === 'by_file_to_summary') {
    lines.push(
      '[!] Auto-fallback: by_file → summary (would have exceeded max_bytes; rendered as summary).'
    );
  }

  const scopeLabel = formatScopeLabel(args);
  lines.push(`Scope: ${scopeLabel}  Root: ${args.root}`);
  lines.push(
    `Buckets: ${args.bucketCount} servers  Files considered: ${args.filesConsidered}  Files with diagnostics: ${args.filesWithDiagnostics}`
  );
  lines.push(
    `Severity counts: errors=${args.counts.errors}, warnings=${args.counts.warnings}, info=${args.counts.info}, hints=${args.counts.hints}`
  );

  const sources =
    args.counts.topSources.length > 0
      ? args.counts.topSources.map((s) => `${s.source}:${s.count}`).join(', ')
      : '(none)';
  const codes =
    args.counts.topCodes.length > 0
      ? args.counts.topCodes.map((c) => `${c.code}:${c.count}`).join(', ')
      : '(none)';
  lines.push(`Top sources: ${sources}   Top codes: ${codes}`);

  lines.push(
    `Caps: max_files=${args.caps.max_files}, max_diagnostics=${args.caps.max_diagnostics}, max_bytes=${args.caps.max_bytes}, time_budget_ms=${args.caps.time_budget_ms}`
  );

  if (
    args.filters.min_severity !== 'warning' ||
    (args.filters.sources && args.filters.sources.length > 0) ||
    (args.filters.exclude_codes && args.filters.exclude_codes.length > 0)
  ) {
    const parts: string[] = [`min_severity=${args.filters.min_severity}`];
    if (args.filters.sources && args.filters.sources.length > 0) {
      parts.push(`sources=[${args.filters.sources.join(',')}]`);
    }
    if (args.filters.exclude_codes && args.filters.exclude_codes.length > 0) {
      parts.push(`exclude_codes=[${args.filters.exclude_codes.join(',')}]`);
    }
    lines.push(`Filters: ${parts.join(', ')}`);
  } else {
    lines.push(`Filters: min_severity=${args.filters.min_severity}`);
  }

  if (args.partialBuckets && args.partialBuckets.length > 0) {
    lines.push(`Partial buckets: [${args.partialBuckets.join(', ')}]`);
  }
  if (args.completedBuckets && args.completedBuckets.length > 0) {
    lines.push(`Completed buckets: [${args.completedBuckets.join(', ')}]`);
  }

  return lines.join('\n');
}

function formatScopeLabel(args: HeaderArgs): string {
  if (args.scope === 'workspace') return 'workspace';
  if (args.scope === 'paths') return `paths=${args.filesConsidered}`;
  if (args.scope === 'patterns') return `patterns=${args.filesConsidered}`;
  return `paths+patterns=${args.filesConsidered}`;
}

function renderReasonBanner(reason: PartialReason, args: HeaderArgs): string[] {
  switch (reason) {
    case 'BUDGET': {
      const ms = args.budgetMs ?? args.caps.time_budget_ms;
      const collected = args.resultsCollected ?? args.counts.totalAfter;
      const files = args.filesCollected ?? args.filesWithDiagnostics;
      if (collected === 0) {
        return [
          `[!] Wall-clock budget exhausted (BUDGET): ${ms} ms reached with 0 results collected.`,
          '[!] Reduce scope (`paths`/`patterns`) or increase `time_budget_ms` (up to 120000). Not retried automatically.',
        ];
      }
      return [
        `[!] Wall-clock budget exhausted (BUDGET): ${ms} ms reached after collecting ${collected}/?? diagnostics across ${files}/?? files.`,
        '[!] do NOT retry with the same args — narrow scope (use `paths` or `patterns`, or raise `time_budget_ms` up to 120000).',
      ];
    }
    case 'MAX_FILES': {
      const cap = args.caps.max_files;
      const dropped = args.droppedCounts?.maxFiles ?? 0;
      const total = cap + dropped;
      return [
        `[!] File cap hit (MAX_FILES): truncated input from ${total} to ${cap} files; remaining files not inspected.`,
        '[!] do NOT retry with the same args — narrow scope (use a more specific `patterns` or raise `max_files`).',
      ];
    }
    case 'MAX_DIAGNOSTICS': {
      const cap = args.caps.max_diagnostics;
      const totalBefore = args.counts.totalBefore;
      return [
        `[!] Diagnostic cap hit (MAX_DIAGNOSTICS): ${cap}/${totalBefore} diagnostics rendered (highest severity first).`,
        '[!] do NOT retry with the same args — narrow scope (raise `min_severity` to `error`, or narrow `paths`).',
      ];
    }
    case 'MAX_BYTES': {
      return [
        `[!] Output size cap hit (MAX_BYTES): rendered output would have exceeded ${args.caps.max_bytes} bytes; fell back to \`summary\` format.`,
        '[!] do NOT retry with the same args — narrow scope (use `paths`, narrow `patterns`, or raise `min_severity`).',
      ];
    }
    case 'SERVER_CRASH': {
      const buckets =
        args.partialBuckets && args.partialBuckets.length > 0
          ? args.partialBuckets.join(', ')
          : 'unknown';
      return [`[!] Server crash (SERVER_CRASH): ${buckets} died mid-batch; its bucket is partial.`];
    }
    default:
      return [];
  }
}

/**
 * Result of {@link renderBatch}: the rendered text plus a flag noting
 * when an auto-fallback from `by_file` to `summary` happened.
 */
export interface RenderBatchResult {
  text: string;
  autoFallback?: 'by_file_to_summary';
}

export interface RenderBatchOptions {
  format: RenderFormat;
  groupBy: GroupBy;
  maxBytes: number;
  header: string;
  perFileCap?: number;
}

/**
 * Render the body of a batch diagnostics report. The header is rendered
 * separately by {@link renderHeader}.
 *
 * Honors the plan's rules:
 *   - by_file: per-file blocks, sorted by file URI, first 20 diagnostics
 *     per file (severity asc, then line), `... +N more` rollup.
 *   - summary: one-line totals + top sources / codes.
 *   - flat: one line per diagnostic with `messageLen:N` annotation.
 *   - json: fenced JSON block.
 *   - by_file + projected size > max_bytes → falls back to summary.
 *   - Hard truncation at max_bytes; tries to close fences cleanly.
 */
export function renderBatch(
  filtered: DiagnosticsByFile[],
  opts: RenderBatchOptions
): RenderBatchResult {
  const headerSize = Buffer.byteLength(opts.header);
  const headerWithGap = `${opts.header}\n\n`;

  let format = opts.format;
  let body = renderBody(filtered, format, opts);
  let autoFallback: 'by_file_to_summary' | undefined;

  if (format === 'by_file') {
    const projected = headerSize + Buffer.byteLength(`\n\n${body}`);
    if (projected > opts.maxBytes) {
      format = 'summary';
      body = renderBody(filtered, format, opts);
      autoFallback = 'by_file_to_summary';
    }
  }

  let text = headerWithGap + body;
  const finalSize = Buffer.byteLength(text);
  if (finalSize > opts.maxBytes) {
    text = hardTruncate(text, opts.maxBytes, format);
  }

  return autoFallback ? { text, autoFallback } : { text };
}

function renderBody(
  filtered: DiagnosticsByFile[],
  format: RenderFormat,
  opts: RenderBatchOptions
): string {
  switch (format) {
    case 'summary':
      return renderSummary(filtered);
    case 'by_file':
      return renderByFile(filtered, opts.perFileCap ?? PER_FILE_CAP);
    case 'flat':
      return renderFlat(filtered);
    case 'json':
      return renderJson(filtered);
    default:
      return renderByFile(filtered, opts.perFileCap ?? PER_FILE_CAP);
  }
}

function renderSummary(filtered: DiagnosticsByFile[]): string {
  if (filtered.length === 0) {
    return '(no diagnostics)';
  }
  const lines: string[] = ['Summary (file → diagnostic count):'];
  for (const file of filtered) {
    const path = safeUriToPath(file.uri);
    lines.push(`  ${path} → ${file.items.length}`);
  }
  return lines.join('\n');
}

function renderByFile(filtered: DiagnosticsByFile[], perFileCap: number): string {
  if (filtered.length === 0) return '(no diagnostics)';
  const lines: string[] = [];
  // Stable ordering: by URI alphabetical.
  const sorted = [...filtered].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  for (const file of sorted) {
    const path = safeUriToPath(file.uri);
    const counts = countSeverities(file.items);
    lines.push(
      `${path}  (${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info, ${counts.hints} hints)`
    );
    const sorted = [...file.items].sort((a, b) => {
      const sa = a.severity ?? 1;
      const sb = b.severity ?? 1;
      if (sa !== sb) return sa - sb;
      return a.range.start.line - b.range.start.line;
    });
    const visible = sorted.slice(0, perFileCap);
    for (const d of visible) {
      const sev = SEVERITY_NAME[d.severity ?? 1] ?? 'Unknown';
      const code = d.code !== undefined ? ` [${d.code}]` : '';
      const source = d.source ? ` (${d.source})` : '';
      const { text } = clipMessage(d.message);
      lines.push(`  • ${sev}${code}${source}: ${text}`);
      const { start, end } = d.range;
      lines.push(
        `    Location: Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}`
      );
    }
    if (sorted.length > perFileCap) {
      const extra = sorted.length - perFileCap;
      lines.push(`  ... +${extra} more (use min_severity=error or narrow paths)`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderFlat(filtered: DiagnosticsByFile[]): string {
  const lines: string[] = [];
  for (const file of filtered) {
    const path = safeUriToPath(file.uri);
    for (const d of file.items) {
      const sev = SEVERITY_NAME[d.severity ?? 1] ?? 'Unknown';
      const code = d.code !== undefined ? `[${d.code}] ` : '';
      const source = d.source ? `(${d.source}) ` : '';
      const { text, originalLen } = clipMessage(d.message);
      const { start } = d.range;
      lines.push(
        `${path}:${start.line + 1}:${start.character + 1}  ${sev} ${code}${source}${text}  messageLen:${originalLen}`
      );
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(no diagnostics)';
}

function renderJson(filtered: DiagnosticsByFile[]): string {
  const payload = filtered.map((file) => ({
    uri: file.uri,
    path: safeUriToPath(file.uri),
    items: file.items.map((d) => {
      const { text, originalLen } = clipMessage(d.message);
      return {
        severity: d.severity ?? 1,
        severityName: SEVERITY_NAME[d.severity ?? 1] ?? 'Unknown',
        code: d.code,
        source: d.source,
        message: text,
        messageLen: originalLen,
        range: d.range,
      };
    }),
  }));
  return `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function countSeverities(items: Diagnostic[]): {
  errors: number;
  warnings: number;
  info: number;
  hints: number;
} {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  let hints = 0;
  for (const d of items) {
    const sev = d.severity ?? 1;
    if (sev === 1) errors++;
    else if (sev === 2) warnings++;
    else if (sev === 3) info++;
    else hints++;
  }
  return { errors, warnings, info, hints };
}

function safeUriToPath(uri: string): string {
  try {
    return uriToPath(uri);
  } catch {
    return uri;
  }
}

/**
 * Hard-truncate `text` to `maxBytes`. Tries to close a json fence if the
 * cut lands inside one. Appends a one-line marker so the agent knows the
 * output was truncated.
 */
function hardTruncate(text: string, maxBytes: number, format: RenderFormat): string {
  const marker = `\n... [output truncated at max_bytes=${maxBytes}]`;
  const markerSize = Buffer.byteLength(marker);
  const budget = Math.max(0, maxBytes - markerSize);
  // Walk back from `budget` until we have a complete utf-8 boundary.
  const buf = Buffer.from(text);
  const sliced = buf.subarray(0, budget).toString('utf8');
  let out = sliced;
  if (format === 'json') {
    // Try to close the fence cleanly.
    if (sliced.includes('```json')) {
      out = sliced.replace(/```json[\s\S]*$/, '```json\n  /* truncated */\n```');
    }
  }
  return out + marker;
}
