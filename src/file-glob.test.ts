import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFiles } from './file-glob.js';

/**
 * Tests for src/file-glob.ts.
 *
 * IMPORTANT: This file uses `Bun.write` for file content and
 * `fs.promises.mkdir` for directories instead of `node:fs` writeFileSync
 * because `src/setup.test.ts` process-globally replaces `node:fs` via
 * `mock.module('node:fs', ...)`. Using `Bun.write` bypasses the mock.
 * The same hazard is documented in `src/lsp/document-manager.test.ts`.
 */

/** Write a file using Bun.write to avoid node:fs mock interference. */
async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

describe('resolveFiles', () => {
  let TEST_DIR: string;

  beforeEach(async () => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-file-glob-'));
    // Create a small tree.
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });
    await mkdir(join(TEST_DIR, 'src/sub'), { recursive: true });
    await mkdir(join(TEST_DIR, 'dist'), { recursive: true });
    await mkdir(join(TEST_DIR, 'node_modules'), { recursive: true });

    await writeFile(join(TEST_DIR, 'src/a.ts'), 'a');
    await writeFile(join(TEST_DIR, 'src/b.ts'), 'b');
    await writeFile(join(TEST_DIR, 'src/c.js'), 'c');
    await writeFile(join(TEST_DIR, 'src/sub/d.ts'), 'd');
    await writeFile(join(TEST_DIR, 'dist/out.js'), 'out');
    await writeFile(join(TEST_DIR, 'node_modules/lib.js'), 'lib');
    await writeFile(join(TEST_DIR, 'README.md'), 'readme');
    await writeFile(join(TEST_DIR, '.gitignore'), 'dist/\n');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('matches positive picomatch patterns', async () => {
    const r = await resolveFiles({
      patterns: ['src/**/*.ts'],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    const rel = r.files.map((f) => f.replace(TEST_DIR, '')).sort();
    expect(rel).toEqual([join('/src', 'a.ts'), join('/src', 'b.ts'), join('/src', 'sub', 'd.ts')]);
  });

  it('subtracts negation entries (! prefix) from the matched set only', async () => {
    const r = await resolveFiles({
      patterns: ['src/**/*.ts', '!src/sub/**'],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    const rel = r.files.map((f) => f.replace(TEST_DIR, '')).sort();
    expect(rel).toEqual([join('/src', 'a.ts'), join('/src', 'b.ts')]);
  });

  it('keeps explicit `paths` entries even when `patterns` negation would remove them', async () => {
    const explicit = join(TEST_DIR, 'src/sub/d.ts');
    const r = await resolveFiles({
      paths: [explicit],
      patterns: ['src/**/*.ts', '!src/sub/**'],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    expect(r.files).toContain(explicit);
  });

  it('respects gitignore when enabled', async () => {
    const r = await resolveFiles({
      patterns: ['**/*.js'],
      root: TEST_DIR,
      respectGitignore: true,
      includeUnopened: true,
      maxFiles: 100,
    });
    const rel = r.files.map((f) => f.replace(TEST_DIR, ''));
    // `dist/out.js` filtered by .gitignore, `node_modules/lib.js` by defaults.
    expect(rel).toEqual([join('/src', 'c.js')]);
    expect(r.droppedCounts.gitignored).toBe(0);
  });

  it('still skips always-ignored directories when respectGitignore=false', async () => {
    const r = await resolveFiles({
      patterns: ['**/*.js'],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    const rel = r.files.map((f) => f.replace(TEST_DIR, '')).sort();
    expect(rel).not.toContain(join('/dist', 'out.js'));
    expect(rel).not.toContain(join('/node_modules', 'lib.js'));
    expect(rel).toContain(join('/src', 'c.js'));
  });

  it('rejects patterns that escape the root', async () => {
    const r = await resolveFiles({
      patterns: ['../../etc/**'],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    expect(r.files).toEqual([]);
    expect(r.droppedCounts.escaped).toBeGreaterThan(0);
  });

  it('rejects explicit paths that escape the root', async () => {
    const r = await resolveFiles({
      paths: ['../../etc/passwd', '/etc/passwd'],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    expect(r.files).toEqual([]);
    expect(r.droppedCounts.escaped).toBe(2);
  });

  it('enforces maxFiles cap and reports the drop count', async () => {
    const r = await resolveFiles({
      patterns: ['**/*.ts'],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 2,
    });
    expect(r.files.length).toBe(2);
    expect(r.droppedCounts.maxFiles).toBeGreaterThan(0);
  });

  it('returns absolute paths sorted alphabetically for determinism', async () => {
    const r = await resolveFiles({
      patterns: ['src/**/*.ts'],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    const sortedCopy = [...r.files].sort();
    expect(r.files).toEqual(sortedCopy);
  });

  it('returns explicit paths in the union', async () => {
    const explicit1 = join(TEST_DIR, 'README.md');
    const explicit2 = join(TEST_DIR, 'src/a.ts');
    const r = await resolveFiles({
      paths: [explicit1, explicit2],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    expect(r.files).toContain(explicit1);
    expect(r.files).toContain(explicit2);
  });

  it('returns empty list when neither paths nor patterns supplied', async () => {
    const r = await resolveFiles({
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    expect(r.files).toEqual([]);
  });

  it('throws when root is relative', async () => {
    await expect(
      resolveFiles({
        patterns: ['**/*.ts'],
        root: 'relative/path',
        respectGitignore: false,
        includeUnopened: true,
        maxFiles: 100,
      })
    ).rejects.toThrow(/root must be absolute/);
  });

  it('walks subdirectories up to the depth cap (no infinite recursion)', async () => {
    // Create a deeper tree (10 levels) and ensure we still find the leaf.
    let leaf = join(TEST_DIR, 'deep');
    await mkdir(leaf, { recursive: true });
    for (let i = 0; i < 6; i++) {
      leaf = join(leaf, `lvl${i}`);
      await mkdir(leaf, { recursive: true });
    }
    await writeFile(join(leaf, 'leaf.ts'), 'leaf');

    const r = await resolveFiles({
      patterns: ['**/leaf.ts'],
      root: TEST_DIR,
      respectGitignore: false,
      includeUnopened: true,
      maxFiles: 100,
    });
    expect(r.files).toContain(join(leaf, 'leaf.ts'));
  });
});
