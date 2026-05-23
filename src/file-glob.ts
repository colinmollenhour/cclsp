import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import { loadGitignore } from './file-scanner.js';
import { logger } from './logger.js';

/**
 * Options controlling {@link resolveFiles}.
 */
export interface ResolveFilesOptions {
  /**
   * Explicit list of file paths (absolute or relative to `root`). Survive
   * negation entries in `patterns` (locked-in decision 10 in the plan).
   */
  paths?: string[];
  /**
   * Glob patterns evaluated relative to `root`. Negation entries prefixed
   * with `!` are subtracted from the pattern-resolved set only.
   */
  patterns?: string[];
  /** Root directory for resolution and walking. Must be absolute. */
  root: string;
  /** Skip files matched by `.gitignore` + default ignore patterns. */
  respectGitignore: boolean;
  /**
   * Reserved for callers; not consumed by resolveFiles itself. The tool
   * layer uses it to decide whether to filter to currently-open files.
   */
  includeUnopened: boolean;
  /** Hard cap on the number of files returned. */
  maxFiles: number;
}

/**
 * Result shape of {@link resolveFiles}. `droppedCounts` lets the caller
 * surface why specific files were excluded.
 */
export interface ResolveFilesResult {
  files: string[];
  droppedCounts: {
    gitignored: number;
    notMatched: number;
    escaped: number;
    unreadable: number;
    maxFiles: number;
  };
}

const MAX_WALK_DEPTH = 20;

/**
 * Resolve a final list of absolute file paths from explicit `paths` and
 * glob `patterns`, walking from `root`. Pure file-system + matching; no
 * LSP interaction.
 *
 * Behavior:
 *  - `paths` entries are taken verbatim (no gitignore filter, no
 *    pattern-negation removal). Relative entries resolve against `root`.
 *  - `patterns` entries are matched with picomatch. `!`-prefixed entries
 *    subtract from the matched set.
 *  - When both are supplied, the final set = union(paths, patterns-result).
 *  - When neither is supplied, returns an empty `files` list (the tool
 *    layer treats that as workspace scope and delegates to
 *    `workspace/diagnostic`).
 *  - Patterns that resolve to paths *outside* `root` (after
 *    normalization) are counted under `droppedCounts.escaped`.
 *  - Returns absolute paths sorted alphabetically for determinism.
 */
export async function resolveFiles(opts: ResolveFilesOptions): Promise<ResolveFilesResult> {
  const root = normalize(opts.root);
  if (!isAbsolute(root)) {
    throw new Error(`resolveFiles: root must be absolute (got: ${opts.root})`);
  }

  const dropped = {
    gitignored: 0,
    notMatched: 0,
    escaped: 0,
    unreadable: 0,
    maxFiles: 0,
  };

  const finalSet = new Set<string>();

  // 1. Explicit `paths`: resolved against root, no gitignore filter.
  if (opts.paths && opts.paths.length > 0) {
    for (const p of opts.paths) {
      const abs = isAbsolute(p) ? normalize(p) : normalize(resolve(root, p));
      finalSet.add(abs);
    }
  }

  // 2. `patterns`: split into positive and negative entries.
  const patternsList = opts.patterns ?? [];
  const hasPatterns = patternsList.length > 0;
  if (hasPatterns) {
    const positive: string[] = [];
    const negative: string[] = [];
    for (const p of patternsList) {
      if (p.startsWith('!')) negative.push(p.slice(1));
      else positive.push(p);
    }

    // Reject patterns that escape `root` after normalization. We don't
    // attempt to walk above `root`; any pattern whose effective base
    // resolves outside `root` is counted under `escaped` and skipped.
    const safePositive: string[] = [];
    for (const pat of positive) {
      if (escapesRoot(root, pat)) {
        dropped.escaped++;
        continue;
      }
      safePositive.push(pat);
    }

    if (safePositive.length > 0) {
      const positiveMatcher = picomatch(safePositive, { dot: false, nocase: false });
      const negativeMatcher = negative.length > 0 ? picomatch(negative, { dot: false }) : null;

      const ig = opts.respectGitignore ? await loadGitignore(root) : null;

      const candidates: string[] = [];
      await walkDirectory(root, root, MAX_WALK_DEPTH, async (relPath, absPath) => {
        const normalizedRel = relPath.split(sep).join('/');
        if (ig?.ignores(normalizedRel)) {
          dropped.gitignored++;
          return;
        }
        candidates.push(absPath);
      });

      for (const abs of candidates) {
        const rel = relative(root, abs).split(sep).join('/');
        if (!positiveMatcher(rel)) {
          dropped.notMatched++;
          continue;
        }
        if (negativeMatcher?.(rel)) {
          // Negation removes from the pattern-resolved set only.
          dropped.notMatched++;
          continue;
        }
        finalSet.add(abs);
      }
    }
  }

  // 3. Apply max-files cap. Sort deterministically before capping.
  const sorted = Array.from(finalSet).sort();
  if (sorted.length > opts.maxFiles) {
    dropped.maxFiles = sorted.length - opts.maxFiles;
    sorted.length = opts.maxFiles;
  }

  return { files: sorted, droppedCounts: dropped };
}

/**
 * Walk `dir` up to `maxDepth` levels deep, calling `visit` for every file
 * encountered. Errors reading directories are logged and silently skipped
 * so a single unreadable subdirectory cannot kill the whole walk.
 */
async function walkDirectory(
  rootDir: string,
  dir: string,
  maxDepth: number,
  visit: (relPath: string, absPath: string) => Promise<void>,
  currentDepth = 0
): Promise<void> {
  if (currentDepth > maxDepth) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    logger.debug(`[DEBUG resolveFiles] readdir failed for ${dir}: ${err}\n`);
    return;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(abs);
    } catch (err) {
      logger.debug(`[DEBUG resolveFiles] stat failed for ${abs}: ${err}\n`);
      continue;
    }

    const rel = relative(rootDir, abs);
    if (st.isDirectory()) {
      await walkDirectory(rootDir, abs, maxDepth, visit, currentDepth + 1);
    } else if (st.isFile()) {
      await visit(rel, abs);
    }
  }
}

/**
 * Returns true when `pattern` (relative or absolute) clearly resolves
 * outside `root` after normalization. We use a conservative check: any
 * pattern containing `..` segments or starting with an absolute path that
 * is not a child of `root` is rejected. picomatch itself doesn't enforce
 * sandboxing, so this guard prevents `../../etc/**` from being treated
 * as legitimate.
 */
function escapesRoot(root: string, pattern: string): boolean {
  if (pattern.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(pattern)) {
    // Absolute path: must be inside root.
    const normalized = normalize(pattern);
    const rel = relative(root, normalized);
    return rel.startsWith('..') || isAbsolute(rel);
  }
  // Relative: any `..` segment is suspicious.
  const segments = pattern.split(/[\\/]/);
  return segments.some((s) => s === '..');
}
