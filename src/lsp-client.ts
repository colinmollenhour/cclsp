import { readFileSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';
import { resolveFiles } from './file-glob.js';
import { loadGitignore, scanDirectoryForExtensions } from './file-scanner.js';
import { logger } from './logger.js';
import { supportsTextDocumentDiagnostic, supportsWorkspaceDiagnostic } from './lsp/capabilities.js';
import { loadConfig } from './lsp/config.js';
import {
  getValidSymbolKinds,
  findDefinition as opsFindDefinition,
  findImplementation as opsFindImplementation,
  findReferences as opsFindReferences,
  findSymbolsByName as opsFindSymbolsByName,
  getDiagnostics as opsGetDiagnostics,
  hover as opsHover,
  incomingCalls as opsIncomingCalls,
  outgoingCalls as opsOutgoingCalls,
  perFilePullBatch as opsPerFilePullBatch,
  prepareCallHierarchy as opsPrepareCallHierarchy,
  pushFallbackBatch as opsPushFallbackBatch,
  renameSymbol as opsRenameSymbol,
  workspaceDiagnostic as opsWorkspaceDiagnostic,
  workspaceSymbol as opsWorkspaceSymbol,
  symbolKindToString,
} from './lsp/operations.js';
import { ServerManager } from './lsp/server-manager.js';
import type {
  BatchDiagnosticsRequest,
  BatchDiagnosticsResult,
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Config,
  Diagnostic,
  DiagnosticsByFile,
  DroppedCounts,
  LSPServerConfig,
  Location,
  PartialReason,
  PerFileBatchResult,
  Position,
  ServerState,
  SymbolInformation,
  SymbolMatch,
  WorkspaceDiagnosticOpResult,
} from './lsp/types.js';
import type { SymbolKind } from './lsp/types.js';
import { uriToPath } from './utils.js';

export class LSPClient {
  private config: Config;
  private serverManager = new ServerManager();

  constructor(configPath?: string) {
    this.config = loadConfig(configPath);
  }

  get tools(): Record<string, boolean> | undefined {
    return this.config.tools;
  }

  private getServerForFile(filePath: string): LSPServerConfig | null {
    const extension = filePath.split('.').pop();
    if (!extension) return null;

    logger.debug(`Looking for server for extension: ${extension}\n`);
    logger.debug(
      `Available servers: ${this.config.servers.map((s) => s.extensions.join(',')).join(' | ')}\n`
    );

    // Find all servers that support this extension
    const matchingServers = this.config.servers.filter((server) =>
      server.extensions.includes(extension)
    );

    if (matchingServers.length === 0) {
      logger.debug(`No server found for extension: ${extension}\n`);
      return null;
    }

    // If only one server matches, use it
    if (matchingServers.length === 1) {
      const server = matchingServers[0];
      if (server) {
        logger.debug(`Found server for ${extension}: ${server.command.join(' ')}\n`);
      }
      return server || null;
    }

    // Multiple servers match - pick the one with most specific rootDir
    // Check if filePath is already absolute (Unix: /, Windows: C:\ or UNC paths)
    const isAbsolutePath =
      filePath.startsWith('/') || filePath.startsWith('\\') || /^[a-zA-Z]:/.test(filePath);
    const absoluteFilePath = normalize(isAbsolutePath ? filePath : join(process.cwd(), filePath));
    let bestMatch: LSPServerConfig | null = null;
    let longestRootLength = -1;

    for (const server of matchingServers) {
      // Normalize rootDir to use platform-specific separators
      // rootDir might be stored with '/' separators even on Windows
      const normalizedServerRoot = server.rootDir ? normalize(server.rootDir) : '.';
      const isAbsolute =
        normalizedServerRoot.startsWith('/') || /^[a-zA-Z]:/.test(normalizedServerRoot);
      const rootDir = normalize(
        isAbsolute ? normalizedServerRoot : join(process.cwd(), normalizedServerRoot)
      );

      const rel = relative(rootDir, absoluteFilePath);

      // File is inside rootDir if relative path doesn't escape with '..'
      // Works on both Unix and Windows (normalize handles path separators)
      if (!rel.startsWith('..')) {
        if (rootDir.length > longestRootLength) {
          longestRootLength = rootDir.length;
          bestMatch = server;
        }
      }
    }

    // Fallback to first match if no rootDir contains the file
    const server = bestMatch || matchingServers[0];

    if (server) {
      logger.debug(
        `Found server for ${extension}: ${server.command.join(' ')} (rootDir: ${server.rootDir || '.'})\n`
      );
    }

    return server || null;
  }

  /**
   * Manually restart LSP servers for specific extensions or all servers
   * @param extensions Array of file extensions, or null to restart all
   * @returns Object with success status and details about restarted servers
   */
  async restartServers(extensions?: string[]): Promise<{
    success: boolean;
    restarted: string[];
    failed: string[];
    message: string;
  }> {
    const restarted: string[] = [];
    const failed: string[] = [];

    logger.debug(
      `[restartServers] Request to restart servers for extensions: ${extensions ? extensions.join(', ') : 'all'}\n`
    );

    // Collect servers to restart
    const serversToRestart: Array<{ key: string; state: ServerState }> = [];

    for (const [key, serverState] of this.serverManager.getRunningServers().entries()) {
      if (!extensions || extensions.some((ext) => serverState.config.extensions.includes(ext))) {
        serversToRestart.push({ key, state: serverState });
      }
    }

    if (serversToRestart.length === 0) {
      const message = extensions
        ? `No LSP servers found for extensions: ${extensions.join(', ')}`
        : 'No LSP servers are currently running';
      return { success: false, restarted: [], failed: [], message };
    }

    // Restart each server by disposing and re-getting via serverManager
    for (const { state } of serversToRestart) {
      const serverDesc = `${state.config.command.join(' ')} (${state.config.extensions.join(', ')})`;

      try {
        // Clear existing timer
        if (state.restartTimer) {
          clearTimeout(state.restartTimer);
          state.restartTimer = undefined;
        }

        // Terminate old server
        state.process.kill();

        // Remove from running servers and start new one
        this.serverManager.getRunningServers().delete(JSON.stringify(state.config));
        await this.serverManager.getServer(state.config);

        restarted.push(serverDesc);
        logger.debug(`[restartServers] Successfully restarted: ${serverDesc}\n`);
      } catch (error) {
        failed.push(`${serverDesc}: ${error}`);
        logger.error(`[restartServers] Failed to restart: ${serverDesc}: ${error}\n`);
      }
    }

    const success = failed.length === 0;
    let message: string;

    if (success) {
      message = `Successfully restarted ${restarted.length} LSP server(s)`;
    } else if (restarted.length > 0) {
      message = `Restarted ${restarted.length} server(s), but ${failed.length} failed`;
    } else {
      message = `Failed to restart all ${failed.length} server(s)`;
    }

    return { success, restarted, failed, message };
  }

  /**
   * Synchronize file content with LSP server after external modifications
   * This should be called after any disk writes to keep the LSP server in sync
   */
  async syncFileContent(filePath: string): Promise<void> {
    try {
      const serverState = await this.getServer(filePath);

      // If file is not already open in the LSP server, open it first
      if (!serverState.documentManager.isOpen(filePath)) {
        logger.debug(`[syncFileContent] File not open, opening it first: ${filePath}\n`);
        await serverState.documentManager.ensureOpen(filePath);
      }

      logger.debug(`[syncFileContent] Syncing file: ${filePath}\n`);

      const fileContent = readFileSync(filePath, 'utf-8');
      serverState.documentManager.sendChange(filePath, fileContent);

      logger.debug(`[syncFileContent] File synced: ${filePath}\n`);
    } catch (error) {
      logger.error(`[syncFileContent] Failed to sync file ${filePath}: ${error}\n`);
      // Don't throw - syncing is best effort
    }
  }

  private async getServer(filePath: string): Promise<ServerState> {
    logger.debug(`[getServer] Getting server for file: ${filePath}\n`);

    const serverConfig = this.getServerForFile(filePath);
    if (!serverConfig) {
      throw new Error(`No LSP server configured for file: ${filePath}`);
    }

    logger.debug(`[getServer] Found server config: ${serverConfig.command.join(' ')}\n`);

    return this.serverManager.getServer(serverConfig);
  }

  async findDefinition(filePath: string, position: Position): Promise<Location[]> {
    const serverState = await this.getServer(filePath);
    return opsFindDefinition(serverState, filePath, position);
  }

  async findReferences(
    filePath: string,
    position: Position,
    includeDeclaration = true
  ): Promise<Location[]> {
    const serverState = await this.getServer(filePath);
    return opsFindReferences(serverState, filePath, position, includeDeclaration);
  }

  async renameSymbol(
    filePath: string,
    position: Position,
    newName: string
  ): Promise<{
    changes?: Record<string, Array<{ range: { start: Position; end: Position }; newText: string }>>;
  }> {
    const serverState = await this.getServer(filePath);
    return opsRenameSymbol(serverState, filePath, position, newName);
  }

  symbolKindToString(kind: SymbolKind): string {
    return symbolKindToString(kind);
  }

  getValidSymbolKinds(): string[] {
    return getValidSymbolKinds();
  }

  async findSymbolsByName(
    filePath: string,
    symbolName: string,
    symbolKind?: string
  ): Promise<{ matches: SymbolMatch[]; warning?: string }> {
    const serverState = await this.getServer(filePath);
    return opsFindSymbolsByName(serverState, filePath, symbolName, symbolKind);
  }

  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const serverState = await this.getServer(filePath);
    return opsGetDiagnostics(serverState, filePath, this.config.diagnostics);
  }

  /**
   * Batch variant of `getDiagnostics`: collects diagnostics across many
   * files in one call, bucketed by responsible LSP server, with a shared
   * wall-clock deadline. Used by the `get_workspace_diagnostics` MCP tool.
   *
   * - When `paths`/`patterns` are present: resolves the file set via
   *   `src/file-glob.ts`, buckets by responsible LSPServerConfig, and
   *   uses per-server `textDocument/diagnostic` or push-fallback paths.
   * - When both are empty: workspace scope. Each running server with
   *   `workspaceDiagnostics` capability gets a single
   *   `workspace/diagnostic` request; otherwise we fall back per-server
   *   to currently-open files via the per-file pull or push paths.
   * - `include_unopened=false` forces per-file paths and drops files that
   *   are not already open in their LSP server.
   *
   * Never throws on cap hits — the result's `partial` / `partialReasons`
   * carry that information so the tool layer can render a header.
   */
  async getDiagnosticsBatch(req: BatchDiagnosticsRequest): Promise<BatchDiagnosticsResult> {
    const rootDir = req.root ? resolve(req.root) : process.cwd();
    const respectGitignore = req.respectGitignore ?? true;
    const includeUnopened = req.includeUnopened ?? true;
    const maxFiles = req.maxFiles ?? 1000;
    const timeBudgetMs = req.timeBudgetMs ?? 30000;

    const hasPaths = !!req.paths && req.paths.length > 0;
    const hasPatterns = !!req.patterns && req.patterns.length > 0;
    const workspaceScope = !hasPaths && !hasPatterns;
    const scope: BatchDiagnosticsResult['scope'] = workspaceScope
      ? 'workspace'
      : hasPaths && hasPatterns
        ? 'paths+patterns'
        : hasPaths
          ? 'paths'
          : 'patterns';

    const droppedCounts: DroppedCounts = {
      gitignored: 0,
      notMatched: 0,
      escaped: 0,
      unreadable: 0,
      maxFiles: 0,
      budget: 0,
      noServer: 0,
      serverCrash: 0,
      notOpen: 0,
    };

    const partialReasons = new Set<PartialReason>();

    // 1. Resolve files for non-workspace scope.
    let files: string[] = [];
    if (!workspaceScope) {
      const r = await resolveFiles({
        paths: req.paths,
        patterns: req.patterns,
        root: rootDir,
        respectGitignore,
        includeUnopened,
        maxFiles,
      });
      files = r.files;
      droppedCounts.gitignored += r.droppedCounts.gitignored;
      droppedCounts.notMatched += r.droppedCounts.notMatched;
      droppedCounts.escaped += r.droppedCounts.escaped;
      droppedCounts.unreadable += r.droppedCounts.unreadable;
      droppedCounts.maxFiles += r.droppedCounts.maxFiles;
      if (r.droppedCounts.maxFiles > 0) partialReasons.add('MAX_FILES');
    }

    // 2. Bucket files by responsible server config.
    interface Bucket {
      key: string;
      serverConfig: LSPServerConfig;
      files: string[];
      /**
       * When set, this workspace-scope bucket is forced into per-file
       * pull mode (because `include_unopened=false` and we enumerated the
       * server's currently-open files). The pull path will then run
       * against `files` directly.
       */
      forcePerFile?: boolean;
    }
    const buckets = new Map<string, Bucket>();
    const noServerFiles: string[] = [];
    for (const file of files) {
      const cfg = this.getServerForFile(file);
      if (!cfg) {
        noServerFiles.push(file);
        continue;
      }
      const key = serverKey(cfg);
      const bucket = buckets.get(key);
      if (bucket) bucket.files.push(file);
      else buckets.set(key, { key, serverConfig: cfg, files: [file] });
    }
    droppedCounts.noServer = (droppedCounts.noServer ?? 0) + noServerFiles.length;

    // For workspace scope:
    //   - When `include_unopened=false`, do NOT use workspace pull. Build
    //     buckets from each running server's currently-open files (via the
    //     PR1-additive `DocumentManager.listOpen()`), then force per-file
    //     pull mode in `runBucket`. Configured-but-not-running servers
    //     contribute nothing because they have no open files.
    //   - When `include_unopened=true`, work against the union of all
    //     configured servers — but skip buckets for servers whose
    //     extensions have no match in a quick scan of `root`, unless the
    //     server is already running (S3). Caches the scan result.
    if (workspaceScope) {
      if (!includeUnopened) {
        const running = Array.from(this.serverManager.getRunningServers().values());
        for (const serverState of running) {
          const openFiles = serverState.documentManager.listOpen?.() ?? [];
          for (const file of openFiles) {
            const cfg = this.getServerForFile(file) ?? serverState.config;
            const key = serverKey(cfg);
            const bucket = buckets.get(key);
            if (bucket) {
              if (!bucket.files.includes(file)) bucket.files.push(file);
              bucket.forcePerFile = true;
            } else {
              buckets.set(key, {
                key,
                serverConfig: cfg,
                files: [file],
                forcePerFile: true,
              });
            }
          }
        }
      } else {
        const runningKeys = new Set<string>();
        for (const s of this.serverManager.getRunningServers().values()) {
          runningKeys.add(serverKey(s.config));
        }
        const foundExts = await this.scanRootExtensions(rootDir, respectGitignore);
        for (const cfg of this.config.servers) {
          const key = serverKey(cfg);
          if (buckets.has(key)) continue;
          const overlap = cfg.extensions.some((ext) => foundExts.has(ext));
          if (overlap || runningKeys.has(key)) {
            const runningState = Array.from(this.serverManager.getRunningServers().values()).find(
              (s) => serverKey(s.config) === key
            );
            const openFiles = runningState?.documentManager.listOpen?.() ?? [];
            const matchingOpenFiles = openFiles.filter((file) =>
              cfg.extensions.includes(getExtension(file))
            );
            const fallbackFiles = overlap
              ? await this.resolveWorkspaceFilesForServer(cfg, rootDir, respectGitignore, maxFiles)
              : [];
            buckets.set(key, {
              key,
              serverConfig: cfg,
              files: dedupeStrings([...matchingOpenFiles, ...fallbackFiles]),
            });
          } else {
            logger.debug(
              `[getDiagnosticsBatch] Skipping bucket for ${key}: no matching extensions in ${rootDir}\n`
            );
          }
        }
      }
    }

    // 3. Single shared deadline.
    const deadline = Date.now() + timeBudgetMs;

    const items: DiagnosticsByFile[] = [];
    const bucketSummaries: BatchDiagnosticsResult['buckets'] = [];
    const partialBucketKeys: string[] = [];
    const completedBucketKeys: string[] = [];

    // 4. Run buckets in parallel.
    const bucketPromises: Promise<void>[] = [];
    for (const bucket of buckets.values()) {
      bucketPromises.push(
        this.runBucket({
          bucket,
          deadline,
          workspaceScope,
          includeUnopened,
        })
          .then((result) => {
            for (const it of result.items) items.push(it);
            bucketSummaries.push({
              serverKey: bucket.key,
              completed: !result.partial,
              partialReason: result.partialReason,
              fileCount: bucket.files.length,
            });
            if (result.partial) {
              partialBucketKeys.push(bucket.key);
              if (result.partialReason) partialReasons.add(result.partialReason);
            } else {
              completedBucketKeys.push(bucket.key);
            }
            // Merge bucket drops.
            const dc = result.droppedCounts ?? {};
            droppedCounts.budget = (droppedCounts.budget ?? 0) + (dc.budget ?? 0);
            droppedCounts.unreadable += dc.unreadable ?? 0;
            droppedCounts.serverCrash = (droppedCounts.serverCrash ?? 0) + (dc.serverCrash ?? 0);
            droppedCounts.notOpen = (droppedCounts.notOpen ?? 0) + (dc.notOpen ?? 0);
          })
          .catch((err) => {
            logger.error(`[getDiagnosticsBatch] Bucket ${bucket.key} threw: ${err}\n`);
            partialBucketKeys.push(bucket.key);
            partialReasons.add('SERVER_CRASH');
            bucketSummaries.push({
              serverKey: bucket.key,
              completed: false,
              partialReason: 'SERVER_CRASH',
              fileCount: bucket.files.length,
            });
            droppedCounts.serverCrash = (droppedCounts.serverCrash ?? 0) + bucket.files.length;
          })
      );
    }
    await Promise.all(bucketPromises);

    // F6: global BUDGET aggregation. If the shared deadline elapsed but no
    // bucket flagged BUDGET (e.g., the buckets completed exactly at the
    // wire), add BUDGET unless a higher-priority reason is already set.
    if (Date.now() >= deadline) {
      addReasonRespectingPriority(partialReasons, 'BUDGET');
    }

    // 5. Dedup defensively by (uri, line, character, code).
    const seen = new Set<string>();
    const dedupedByUri = new Map<string, Diagnostic[]>();
    for (const file of items) {
      const kept = dedupedByUri.get(file.uri) ?? [];
      for (const d of file.items) {
        const key = `${file.uri}|${d.range.start.line}|${d.range.start.character}|${d.code ?? ''}|${d.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(d);
      }
      dedupedByUri.set(file.uri, kept);
    }
    const dedupedItems: DiagnosticsByFile[] = Array.from(dedupedByUri.entries()).map(
      ([uri, items]) => ({ uri, items })
    );

    const filesWithDiagnostics = dedupedItems.filter((f) => f.items.length > 0).length;
    const filesConsidered = workspaceScope ? dedupedItems.length : files.length;

    const partial = partialReasons.size > 0;

    return {
      items: dedupedItems,
      buckets: bucketSummaries,
      filesConsidered,
      filesWithDiagnostics,
      scope,
      rootDir,
      resolvedRoot: rootDir,
      partial,
      partialReasons: Array.from(partialReasons),
      droppedCounts,
      completedBucketKeys,
      partialBucketKeys,
    };
  }

  /**
   * One-shot per call: quick scan of `root` for the set of file extensions
   * present (depth=5, respecting `.gitignore` when requested). Used by
   * workspace-scope bucket creation to skip servers whose extensions don't
   * appear in the tree.
   */
  private async scanRootExtensions(
    rootDir: string,
    respectGitignore: boolean
  ): Promise<Set<string>> {
    try {
      const ig = respectGitignore ? await loadGitignore(rootDir) : undefined;
      return await scanDirectoryForExtensions(rootDir, 5, ig, false);
    } catch (err) {
      logger.debug(`[getDiagnosticsBatch] scanRootExtensions failed: ${err}\n`);
      return new Set();
    }
  }

  /**
   * Run a single bucket: pick the strategy (workspace / per-file pull /
   * push fallback) based on capability and scope, increment/decrement
   * the in-flight counter, and return the bucket's op result.
   */
  private async runBucket(args: {
    bucket: {
      key: string;
      serverConfig: LSPServerConfig;
      files: string[];
      forcePerFile?: boolean;
    };
    deadline: number;
    workspaceScope: boolean;
    includeUnopened: boolean;
  }): Promise<WorkspaceDiagnosticOpResult | PerFileBatchResult> {
    const { bucket, deadline, workspaceScope, includeUnopened } = args;
    const serverState = await this.serverManager.getServer(bucket.serverConfig);
    serverState.inFlightBatchCount = (serverState.inFlightBatchCount ?? 0) + 1;
    try {
      // Workspace-scope happy path: server supports workspace/diagnostic.
      // Forced per-file (e.g., include_unopened=false) skips this branch.
      if (
        workspaceScope &&
        includeUnopened &&
        !bucket.forcePerFile &&
        supportsWorkspaceDiagnostic(serverState)
      ) {
        return await opsWorkspaceDiagnostic(serverState, { deadline });
      }

      const filesForBucket = bucket.files;
      if (supportsTextDocumentDiagnostic(serverState)) {
        return await opsPerFilePullBatch(serverState, filesForBucket, {
          deadline,
          includeUnopened,
        });
      }
      return await opsPushFallbackBatch(serverState, filesForBucket, {
        deadline,
        includeUnopened,
      });
    } finally {
      serverState.inFlightBatchCount = Math.max(0, (serverState.inFlightBatchCount ?? 1) - 1);
    }
  }

  private async resolveWorkspaceFilesForServer(
    cfg: LSPServerConfig,
    rootDir: string,
    respectGitignore: boolean,
    maxFiles: number
  ): Promise<string[]> {
    const patterns = cfg.extensions.flatMap((ext) => [`*.${ext}`, `**/*.${ext}`]);
    const result = await resolveFiles({
      patterns,
      root: rootDir,
      respectGitignore,
      includeUnopened: true,
      maxFiles,
    });
    return result.files;
  }

  async hover(
    filePath: string,
    position: Position
  ): Promise<{
    contents: string | { kind: string; value: string };
    range?: { start: Position; end: Position };
  } | null> {
    const serverState = await this.getServer(filePath);
    return opsHover(serverState, filePath, position);
  }

  async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
    const servers = Array.from(this.serverManager.getRunningServers().values());
    if (servers.length === 0) {
      logger.debug('[workspaceSymbol] No LSP servers running\n');
      return [];
    }

    const serverState = servers[0];
    if (!serverState) return [];

    return opsWorkspaceSymbol(serverState, query);
  }

  async findImplementation(filePath: string, position: Position): Promise<Location[]> {
    const serverState = await this.getServer(filePath);
    return opsFindImplementation(serverState, filePath, position);
  }

  async prepareCallHierarchy(filePath: string, position: Position): Promise<CallHierarchyItem[]> {
    const serverState = await this.getServer(filePath);
    return opsPrepareCallHierarchy(serverState, filePath, position);
  }

  async incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    const filePath = uriToPath(item.uri);
    const serverState = await this.getServer(filePath);
    return opsIncomingCalls(serverState, item);
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    const filePath = uriToPath(item.uri);
    const serverState = await this.getServer(filePath);
    return opsOutgoingCalls(serverState, item);
  }

  async preloadServers(debug = true): Promise<void> {
    if (debug) {
      logger.info('Scanning configured server directories for supported file types\n');
    }

    const serversToStart = new Set<LSPServerConfig>();

    // Scan each server's rootDir for its configured extensions
    for (const serverConfig of this.config.servers) {
      const serverDir = serverConfig.rootDir || process.cwd();

      if (debug) {
        logger.info(
          `Scanning ${serverDir} for extensions: ${serverConfig.extensions.join(', ')}\n`
        );
      }

      try {
        const ig = await loadGitignore(serverDir);
        const foundExtensions = await scanDirectoryForExtensions(serverDir, 3, ig, false);

        // Check if any of this server's extensions are found in its rootDir
        const hasMatchingExtensions = serverConfig.extensions.some((ext) =>
          foundExtensions.has(ext)
        );

        if (hasMatchingExtensions) {
          serversToStart.add(serverConfig);
          if (debug) {
            const matchingExts = serverConfig.extensions.filter((ext) => foundExtensions.has(ext));
            logger.info(`Found matching extensions in ${serverDir}: ${matchingExts.join(', ')}\n`);
          }
        }
      } catch (error) {
        if (debug) {
          logger.error(`Failed to scan ${serverDir}: ${error}\n`);
        }
      }
    }

    if (debug) {
      logger.info(`Starting ${serversToStart.size} LSP servers...\n`);
    }

    const startPromises = Array.from(serversToStart).map(async (serverConfig) => {
      try {
        if (debug) {
          logger.info(`Preloading LSP server: ${serverConfig.command.join(' ')}\n`);
        }
        await this.serverManager.getServer(serverConfig);
        if (debug) {
          logger.info(
            `Successfully preloaded LSP server for extensions: ${serverConfig.extensions.join(', ')}\n`
          );
        }
      } catch (error) {
        logger.error(
          `Failed to preload LSP server for ${serverConfig.extensions.join(', ')}: ${error}\n`
        );
      }
    });

    await Promise.all(startPromises);
    if (debug) {
      logger.info('LSP server preloading completed\n');
    }
  }

  dispose(): void {
    this.serverManager.dispose();
  }
}

/**
 * Stable identity key for a server config used to bucket files in batch
 * diagnostics. Mirrors locked-in decision 12 in the plan:
 *   `serverKey = config.command.join(' ') + '@' + (config.rootDir ?? cwd)`.
 * Ignores irrelevant fields like `restartInterval`.
 */
function serverKey(config: LSPServerConfig): string {
  const root = config.rootDir ?? process.cwd();
  return `${config.command.join(' ')}@${root}`;
}

function getExtension(filePath: string): string {
  return filePath.split('.').pop() ?? '';
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Partial-reason priority used when aggregating across buckets. A higher
 * index = higher priority. Aggregation only forces BUDGET (or any lower
 * reason) when no higher-priority reason is already present.
 *
 *   SERVER_CRASH > BUDGET > MAX_FILES > MAX_DIAGNOSTICS > MAX_BYTES
 */
const PARTIAL_REASON_PRIORITY: PartialReason[] = [
  'MAX_BYTES',
  'MAX_DIAGNOSTICS',
  'MAX_FILES',
  'BUDGET',
  'SERVER_CRASH',
];

/**
 * Add `reason` to the running set unless a higher-priority reason is
 * already present. Used by `getDiagnosticsBatch` to surface a global
 * BUDGET status after `Promise.all` over buckets without overriding a
 * SERVER_CRASH that happened in any bucket.
 */
function addReasonRespectingPriority(set: Set<PartialReason>, reason: PartialReason): void {
  const incomingRank = PARTIAL_REASON_PRIORITY.indexOf(reason);
  for (const existing of set) {
    const r = PARTIAL_REASON_PRIORITY.indexOf(existing);
    if (r > incomingRank) return; // already have a higher-priority reason
  }
  set.add(reason);
}
