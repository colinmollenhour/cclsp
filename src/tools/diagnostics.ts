import type {
  BatchDiagnosticsRequest,
  BatchDiagnosticsResult,
  PartialReason,
} from '../lsp/types.js';
import {
  type GroupBy,
  type MinSeverity,
  type RenderFormat,
  filterDiagnostics,
  renderBatch,
  renderHeader,
} from './diagnostics-format.js';
import { resolvePath, textResult } from './helpers.js';
import type { ToolDefinition } from './registry.js';

export const getDiagnosticsTool: ToolDefinition = {
  name: 'get_diagnostics',
  description:
    'Get language diagnostics (errors, warnings, hints) for a file. Uses LSP textDocument/diagnostic to pull current diagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file to get diagnostics for',
      },
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path } = args as { file_path: string };
    const absolutePath = resolvePath(file_path);

    try {
      const diagnostics = await client.getDiagnostics(absolutePath);

      if (diagnostics.length === 0) {
        return textResult(
          `No diagnostics found for ${file_path}. The file has no errors, warnings, or hints.`
        );
      }

      const severityMap: Record<number, string> = {
        1: 'Error',
        2: 'Warning',
        3: 'Information',
        4: 'Hint',
      };

      const diagnosticMessages = diagnostics.map((diag) => {
        const severity = diag.severity ? severityMap[diag.severity] || 'Unknown' : 'Unknown';
        const code = diag.code ? ` [${diag.code}]` : '';
        const source = diag.source ? ` (${diag.source})` : '';
        const { start, end } = diag.range;

        return `• ${severity}${code}${source}: ${diag.message}\n  Location: Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}`;
      });

      return textResult(
        `Found ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'} in ${file_path}:\n\n${diagnosticMessages.join('\n\n')}`
      );
    } catch (error) {
      return textResult(
        `Error getting diagnostics: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const getWorkspaceDiagnosticsTool: ToolDefinition = {
  name: 'get_workspace_diagnostics',
  description:
    "Get diagnostics across many files in one call. Supply `paths`, `patterns` (glob, supports `!` negation), both (union), or neither (whole-workspace scope). Returns grouped diagnostics with totals, severities, top sources/codes, and per-file breakdowns. Uses LSP workspace/diagnostic when the server advertises it; otherwise falls back to per-file pull or didOpen-with-publishDiagnostics. Respects a wall-clock time budget and reports partial results clearly when truncated. Default min_severity is 'warning' for cleanup workflows.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Explicit list of file paths. May be combined with `patterns`; the final set is the union.',
      },
      patterns: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Glob patterns relative to `root`. Negation entries beginning with `!` are subtracted from the matched set (negation does NOT remove explicit `paths` entries).',
      },
      root: {
        type: 'string',
        description:
          'Root directory for `patterns` resolution and workspace-scope walking. Defaults to process cwd.',
      },
      respect_gitignore: { type: 'boolean', default: true },
      include_unopened: {
        type: 'boolean',
        default: true,
        description:
          'If false, diagnostics are only returned for files already open in their LSP server. With workspace scope this forces per-file pull mode and skips unopened files.',
      },
      min_severity: {
        enum: ['error', 'warning', 'information', 'hint'],
        default: 'warning',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Whitelist of diagnostic sources (e.g. ["typescript","eslint"]).',
      },
      exclude_codes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Blacklist of diagnostic codes (string-form).',
      },
      max_files: { type: 'integer', default: 1000, minimum: 1, maximum: 10000 },
      max_diagnostics: { type: 'integer', default: 500, minimum: 1, maximum: 5000 },
      max_bytes: { type: 'integer', default: 32768, minimum: 1024, maximum: 524288 },
      time_budget_ms: { type: 'integer', default: 30000, minimum: 1000, maximum: 120000 },
      format: { enum: ['summary', 'by_file', 'flat', 'json'], default: 'by_file' },
      group_by: { enum: ['file', 'code', 'source', 'severity'], default: 'file' },
    },
  },
  handler: async (args, client) => {
    let parsed: ParsedWorkspaceArgs;
    try {
      parsed = parseWorkspaceDiagnosticsArgs(args);
    } catch (error) {
      // Enum validation failures surface as `isError: true`, while cap
      // hits never set `isError`. The error message lists valid options
      // for the offending field.
      const result = textResult(
        `get_workspace_diagnostics — ERROR\nError: ${error instanceof Error ? error.message : String(error)}`
      );
      return { ...result, isError: true };
    }

    let batchResult: BatchDiagnosticsResult;
    try {
      batchResult = await client.getDiagnosticsBatch(parsed.request);
    } catch (error) {
      // Real exceptions get surfaced as text — cap hits never throw.
      return textResult(
        `get_workspace_diagnostics — ERROR\nError: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return renderWorkspaceDiagnosticsResult(batchResult, parsed);
  },
};

const VALID_MIN_SEVERITIES = new Set<MinSeverity>(['error', 'warning', 'information', 'hint']);
const VALID_FORMATS = new Set<RenderFormat>(['summary', 'by_file', 'flat', 'json']);
const VALID_GROUP_BY = new Set<GroupBy>(['file', 'code', 'source', 'severity']);

function validateEnum<T extends string>(
  fieldName: string,
  raw: unknown,
  validSet: Set<T>,
  defaultValue: T
): T {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw !== 'string') {
    throw new Error(
      `invalid ${fieldName}: expected string, got ${typeof raw}. Valid options: ${Array.from(validSet).join(', ')}.`
    );
  }
  if (!validSet.has(raw as T)) {
    throw new Error(
      `invalid ${fieldName}: "${raw}". Valid options: ${Array.from(validSet).join(', ')}.`
    );
  }
  return raw as T;
}

export const diagnosticsTools: ToolDefinition[] = [getDiagnosticsTool, getWorkspaceDiagnosticsTool];

// --- Helpers for get_workspace_diagnostics --------------------------------

interface ParsedWorkspaceArgs {
  request: BatchDiagnosticsRequest;
  format: RenderFormat;
  groupBy: GroupBy;
  minSeverity: MinSeverity;
  sources?: string[];
  excludeCodes?: string[];
  maxFiles: number;
  maxDiagnostics: number;
  maxBytes: number;
  timeBudgetMs: number;
  rootDir: string;
}

function parseWorkspaceDiagnosticsArgs(args: Record<string, unknown>): ParsedWorkspaceArgs {
  const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : undefined;
  const patterns = Array.isArray(args.patterns)
    ? (args.patterns as unknown[]).map(String)
    : undefined;
  const root = typeof args.root === 'string' ? args.root : undefined;
  const respectGitignore = args.respect_gitignore !== false;
  const includeUnopened = args.include_unopened !== false;
  const minSeverity = validateEnum<MinSeverity>(
    'min_severity',
    args.min_severity,
    VALID_MIN_SEVERITIES,
    'warning'
  );
  const sources = Array.isArray(args.sources) ? (args.sources as unknown[]).map(String) : undefined;
  const excludeCodes = Array.isArray(args.exclude_codes)
    ? (args.exclude_codes as unknown[]).map(String)
    : undefined;
  const maxFiles = clampInt(args.max_files, 1000, 1, 10000);
  const maxDiagnostics = clampInt(args.max_diagnostics, 500, 1, 5000);
  const maxBytes = clampInt(args.max_bytes, 32768, 1024, 524288);
  const timeBudgetMs = clampInt(args.time_budget_ms, 30000, 1000, 120000);
  const format = validateEnum<RenderFormat>('format', args.format, VALID_FORMATS, 'by_file');
  const groupBy = validateEnum<GroupBy>('group_by', args.group_by, VALID_GROUP_BY, 'file');

  return {
    request: {
      paths,
      patterns,
      root,
      respectGitignore,
      includeUnopened,
      minSeverity,
      sources,
      excludeCodes,
      maxFiles,
      maxDiagnostics,
      maxBytes,
      timeBudgetMs,
      format,
      groupBy,
    },
    format,
    groupBy,
    minSeverity,
    sources,
    excludeCodes,
    maxFiles,
    maxDiagnostics,
    maxBytes,
    timeBudgetMs,
    rootDir: root ?? process.cwd(),
  };
}

function clampInt(raw: unknown, def: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  const v = Math.floor(raw);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function renderWorkspaceDiagnosticsResult(
  batchResult: BatchDiagnosticsResult,
  parsed: ParsedWorkspaceArgs
): ReturnType<typeof textResult> {
  const filterRes = filterDiagnostics(batchResult.items, {
    minSeverity: parsed.minSeverity,
    sources: parsed.sources,
    excludeCodes: parsed.excludeCodes,
    maxDiagnostics: parsed.maxDiagnostics,
  });

  const partialReasons = new Set<PartialReason>(batchResult.partialReasons);
  if (filterRes.counts.truncatedBy === 'MAX_DIAGNOSTICS') {
    partialReasons.add('MAX_DIAGNOSTICS');
  }

  const filesWithDiagnostics = filterRes.filtered.filter((f) => f.items.length > 0).length;

  // Compute initial status before considering MAX_BYTES auto-fallback.
  let status: 'OK' | 'PARTIAL' | 'EMPTY';
  if (
    filterRes.counts.totalAfter === 0 &&
    batchResult.filesConsidered === 0 &&
    partialReasons.size === 0
  ) {
    status = 'EMPTY';
  } else if (filterRes.counts.totalAfter === 0 && partialReasons.size === 0) {
    status = 'OK';
  } else if (partialReasons.size > 0) {
    status = 'PARTIAL';
  } else {
    status = 'OK';
  }

  // First render attempt (pre-fallback) to detect MAX_BYTES.
  const tentativeHeader = renderHeader({
    status,
    scope: batchResult.scope,
    root: parsed.rootDir,
    bucketCount: batchResult.buckets.length,
    filesConsidered: batchResult.filesConsidered,
    filesWithDiagnostics,
    counts: filterRes.counts,
    caps: {
      max_files: parsed.maxFiles,
      max_diagnostics: parsed.maxDiagnostics,
      max_bytes: parsed.maxBytes,
      time_budget_ms: parsed.timeBudgetMs,
    },
    filters: {
      min_severity: parsed.minSeverity,
      sources: parsed.sources,
      exclude_codes: parsed.excludeCodes,
    },
    partialReasons: Array.from(partialReasons),
    partialBuckets: batchResult.partialBucketKeys,
    completedBuckets: batchResult.completedBucketKeys,
    droppedCounts: batchResult.droppedCounts,
    budgetMs: parsed.timeBudgetMs,
    resultsCollected: filterRes.counts.totalAfter,
    filesCollected: filesWithDiagnostics,
  });

  const rendered = renderBatch(filterRes.filtered, {
    format: parsed.format,
    groupBy: parsed.groupBy,
    maxBytes: parsed.maxBytes,
    header: tentativeHeader,
  });

  // If output exceeded max_bytes, MAX_BYTES is the partial reason.
  let finalText = rendered.text;
  if (rendered.autoFallback === 'by_file_to_summary' || rendered.hardTruncated) {
    partialReasons.add('MAX_BYTES');
    const finalHeader = renderHeader({
      status: 'PARTIAL',
      scope: batchResult.scope,
      root: parsed.rootDir,
      bucketCount: batchResult.buckets.length,
      filesConsidered: batchResult.filesConsidered,
      filesWithDiagnostics,
      counts: filterRes.counts,
      caps: {
        max_files: parsed.maxFiles,
        max_diagnostics: parsed.maxDiagnostics,
        max_bytes: parsed.maxBytes,
        time_budget_ms: parsed.timeBudgetMs,
      },
      filters: {
        min_severity: parsed.minSeverity,
        sources: parsed.sources,
        exclude_codes: parsed.excludeCodes,
      },
      partialReasons: Array.from(partialReasons),
      partialBuckets: batchResult.partialBucketKeys,
      completedBuckets: batchResult.completedBucketKeys,
      droppedCounts: batchResult.droppedCounts,
      autoFallback: rendered.autoFallback,
      budgetMs: parsed.timeBudgetMs,
      resultsCollected: filterRes.counts.totalAfter,
      filesCollected: filesWithDiagnostics,
    });
    const reRendered = renderBatch(filterRes.filtered, {
      format: rendered.autoFallback === 'by_file_to_summary' ? 'summary' : parsed.format,
      groupBy: parsed.groupBy,
      maxBytes: parsed.maxBytes,
      header: finalHeader,
    });
    finalText = reRendered.text;
  }

  if (status === 'EMPTY') {
    finalText += '\n\nNo files matched. Check `patterns` and `respect_gitignore`.';
  } else if (status === 'OK' && filterRes.counts.totalAfter === 0) {
    finalText += `\n\nNo diagnostics found across ${batchResult.filesConsidered} files. Workspace looks clean for filters (min_severity=${parsed.minSeverity}).`;
  }

  return textResult(finalText);
}
