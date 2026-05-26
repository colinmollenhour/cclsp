import { promises as fsPromises, readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import { pathToUri } from '../utils.js';
import type { JsonRpcTransport } from './json-rpc.js';

/**
 * Manages document lifecycle for a single LSP server.
 *
 * Handles:
 * - Opening files (textDocument/didOpen) with version tracking
 * - Syncing file changes (textDocument/didChange) with version increment
 * - Language ID mapping from file extensions
 * - Tracking which files are open and their current versions
 */
export class DocumentManager {
  private readonly openFiles = new Set<string>();
  private readonly fileVersions = new Map<string, number>();

  constructor(private readonly transport: JsonRpcTransport) {}

  /**
   * Ensure a file is open in the LSP server. If already open, returns false.
   * If not open, reads the file synchronously, sends textDocument/didOpen, and
   * returns true.
   */
  async ensureOpen(filePath: string): Promise<boolean> {
    if (this.openFiles.has(filePath)) {
      logger.debug(`[DEBUG ensureOpen] File already open: ${filePath}\n`);
      return false;
    }

    logger.debug(`[DEBUG ensureOpen] Opening file: ${filePath}\n`);

    try {
      const fileContent = readFileSync(filePath, 'utf-8');
      this.openWithContent(filePath, fileContent);
      return true;
    } catch (error) {
      logger.debug(`[DEBUG ensureOpen] Failed to open file ${filePath}: ${error}\n`);
      throw error;
    }
  }

  /**
   * Async variant of {@link ensureOpen} using `fs.promises.readFile` instead of
   * `readFileSync`. Same return semantics: if the file is already open, returns
   * false; otherwise reads the file asynchronously, sends `textDocument/didOpen`,
   * adds it to the open-files set, and returns true.
   *
   * Added for batch diagnostics workflows that should not block the event loop
   * with synchronous reads.
   */
  async ensureOpenAsync(filePath: string): Promise<boolean> {
    if (this.openFiles.has(filePath)) {
      logger.debug(`[DEBUG ensureOpenAsync] File already open: ${filePath}\n`);
      return false;
    }

    logger.debug(`[DEBUG ensureOpenAsync] Opening file: ${filePath}\n`);

    try {
      const fileContent = await fsPromises.readFile(filePath, 'utf-8');
      if (this.openFiles.has(filePath)) {
        logger.debug(`[DEBUG ensureOpenAsync] File opened during async read: ${filePath}\n`);
        return false;
      }
      this.openWithContent(filePath, fileContent);
      return true;
    } catch (error) {
      logger.debug(`[DEBUG ensureOpenAsync] Failed to open file ${filePath}: ${error}\n`);
      throw error;
    }
  }

  /**
   * Shared open path: send `textDocument/didOpen` for `filePath` with the given
   * file content and record the file as open at version 1. Owns the
   * `pathToUri` + `getLanguageId` + transport send + `openFiles.add` +
   * `fileVersions.set` work that used to be duplicated across
   * `ensureOpen` and `ensureOpenAsync`.
   */
  private openWithContent(filePath: string, fileContent: string): void {
    const uri = pathToUri(filePath);
    const languageId = getLanguageId(filePath);

    logger.debug(
      `[DEBUG openWithContent] File content length: ${fileContent.length}, languageId: ${languageId}\n`
    );

    this.transport.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: fileContent,
      },
    });

    this.openFiles.add(filePath);
    this.fileVersions.set(filePath, 1);
    logger.debug(`[DEBUG openWithContent] File opened successfully: ${filePath}\n`);
  }

  /**
   * Close a previously-opened document.
   *
   * 1. If the file is not currently tracked as open, returns silently.
   * 2. Otherwise sends `textDocument/didClose` and removes the file from the
   *    open set.
   *
   * We intentionally do NOT clear `fileVersions` here. The R3 batch-path
   * contract forbids re-opening a file within the same batch, so the retained
   * version is currently not consumed. It is preserved for inspection/debugging
   * and to give future cross-batch reopen paths (not implemented in PR1) a
   * starting point if they ever need monotonic versions.
   */
  closeDocument(filePath: string): void {
    if (!this.openFiles.has(filePath)) {
      logger.debug(`[DEBUG closeDocument] File not open: ${filePath}\n`);
      return;
    }

    const uri = pathToUri(filePath);
    this.transport.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });

    this.openFiles.delete(filePath);
    logger.debug(`[DEBUG closeDocument] File closed: ${filePath}\n`);
  }

  /**
   * Send a textDocument/didChange notification with version increment.
   * The file must already be open (call ensureOpen first).
   */
  sendChange(filePath: string, text: string): void {
    const uri = pathToUri(filePath);
    const version = (this.fileVersions.get(filePath) || 1) + 1;
    this.fileVersions.set(filePath, version);

    this.transport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version,
      },
      contentChanges: [{ text }],
    });
  }

  /**
   * Check if a file is currently open in the LSP server.
   */
  isOpen(filePath: string): boolean {
    return this.openFiles.has(filePath);
  }

  /**
   * Returns a snapshot of currently-open file paths. Order is undefined.
   *
   * Used by the workspace-diagnostics batch path when
   * `include_unopened=false` and no explicit `paths`/`patterns` were given,
   * so the client can enumerate the union of files already open across
   * every running server.
   */
  listOpen(): string[] {
    return Array.from(this.openFiles);
  }

  /**
   * Get the current version number for a file.
   */
  getVersion(filePath: string): number {
    return this.fileVersions.get(filePath) || 0;
  }
}

/**
 * Map file extension to LSP language identifier.
 */
export function getLanguageId(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    go: 'go',
    rs: 'rust',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    java: 'java',
    jar: 'java',
    class: 'java',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    dart: 'dart',
    lua: 'lua',
    sh: 'shellscript',
    bash: 'shellscript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    vue: 'vue',
    svelte: 'svelte',
    tf: 'terraform',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    md: 'markdown',
    tex: 'latex',
    elm: 'elm',
    hs: 'haskell',
    ml: 'ocaml',
    clj: 'clojure',
    fs: 'fsharp',
    r: 'r',
    toml: 'toml',
    zig: 'zig',
  };

  return languageMap[extension || ''] || 'plaintext';
}
