// Re-export all shared types from the main types module
export type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeDescription,
  Config,
  DefinitionResult,
  Diagnostic,
  DiagnosticRelatedInformation,
  DocumentDiagnosticReport,
  DocumentSymbol,
  LSPError,
  LSPLocation,
  LSPServerConfig,
  Location,
  Position,
  ReferenceResult,
  SymbolInformation,
  SymbolMatch,
  SymbolSearchParams,
} from '../types.js';
export {
  DiagnosticSeverity,
  DiagnosticTag,
  SymbolKind,
  SymbolTag,
} from '../types.js';

// --- LSP-internal types (single source of truth) ---

import type { ChildProcess } from 'node:child_process';
import type { Diagnostic, LSPError, LSPServerConfig } from '../types.js';

/**
 * JSON-RPC message format used for LSP communication.
 */
export interface LSPMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: LSPError;
}

/**
 * State of a running LSP server process.
 * Single source of truth -- do NOT duplicate this interface elsewhere.
 *
 * transport, documentManager, and diagnosticsCache use structural types
 * rather than concrete class imports to keep types.ts as a dependency leaf
 * (no imports from sibling lsp/ modules that import back from here).
 */
export interface ServerState {
  process: ChildProcess;
  transport: {
    sendRequest(method: string, params: unknown, timeout?: number): Promise<unknown>;
    sendCancellableRequest?(
      method: string,
      params: unknown,
      timeout?: number
    ): { id: number; promise: Promise<unknown> };
    sendMessage(message: LSPMessage): void;
    sendNotification(method: string, params: unknown): void;
    rejectAllPending(reason: string): void;
    cancelRequest?(id: number): void;
    registerProgressHandler?(token: string | number, handler: (value: unknown) => void): void;
    unregisterProgressHandler?(token: string | number): void;
  };
  documentManager: {
    ensureOpen(filePath: string): Promise<boolean>;
    ensureOpenAsync?(filePath: string): Promise<boolean>;
    closeDocument?(filePath: string): void;
    sendChange(filePath: string, text: string): void;
    isOpen(filePath: string): boolean;
    getVersion(filePath: string): number;
    /**
     * Snapshot of currently-open file paths. Order is undefined. Optional so
     * partial-`ServerState` mock literals in tests don't need to provide it;
     * the batch path treats absence as "no files open".
     */
    listOpen?(): string[];
  };
  initialized: boolean;
  initializationPromise: Promise<void>;
  startTime: number;
  config: LSPServerConfig;
  restartTimer?: NodeJS.Timeout;
  initializationResolve?: () => void;
  diagnosticsCache: {
    update(uri: string, items: Diagnostic[], version?: number): void;
    get(uri: string): Diagnostic[] | undefined;
    waitForIdle(
      uri: string,
      options?: {
        maxWaitTime?: number;
        idleTime?: number;
        checkInterval?: number;
        signal?: AbortSignal;
      }
    ): Promise<void>;
    setResultId?(uri: string, resultId: string): void;
    getResultId?(uri: string): string | undefined;
    /**
     * Snapshot of `(uri, value)` pairs for every URI that has a cached
     * `resultId`. Used by `workspaceDiagnostic` (PR3) to populate the LSP
     * `previousResultIds` array on subsequent calls so the server can
     * answer with `kind: 'unchanged'` reports.
     */
    listResultIds?(): Array<{ uri: string; value: string }>;
  };
  adapter?: ServerAdapter;
  /**
   * LSP server capabilities captured from the `initialize` response.
   * Only diagnostic-related fields are typed; the rest of the LSP
   * capability surface is intentionally not modeled here.
   */
  capabilities?: ServerCapabilities;
  /**
   * Counter of in-flight batch operations against this server. Used by
   * `ServerManager.restartServer` to defer scheduled restarts while
   * batch diagnostics work is in progress. Default 0.
   *
   * Optional so partial-`ServerState` mock literals in tests don't need to
   * initialize it; all read-sites must use `(state.inFlightBatchCount ?? 0)`
   * so PR2 increments never observe `NaN`.
   */
  inFlightBatchCount?: number;
}

// --- Diagnostic-related types (LSP 3.17) -----------------------------------

/**
 * Server-side `DiagnosticOptions` capability (LSP 3.17).
 */
export interface DiagnosticOptions {
  identifier?: string;
  interFileDependencies: boolean;
  workspaceDiagnostics: boolean;
}

/**
 * Subset of `ServerCapabilities` that cclsp consumes. Only the
 * diagnostic-related fields are typed.
 */
export interface ServerCapabilities {
  diagnosticProvider?: DiagnosticOptions | boolean;
}

/**
 * Entry passed in `workspace/diagnostic`'s `previousResultIds` array.
 */
export interface PreviousResultId {
  uri: string;
  value: string;
}

/**
 * Params for the `workspace/diagnostic` LSP request.
 */
export interface WorkspaceDiagnosticParams {
  identifier?: string;
  previousResultIds: PreviousResultId[];
  partialResultToken?: string | number;
  workDoneToken?: string | number;
}

export interface WorkspaceFullDocumentDiagnosticReport {
  uri: string;
  version: number | null;
  kind: 'full';
  resultId?: string;
  items: Diagnostic[];
}

export interface WorkspaceUnchangedDocumentDiagnosticReport {
  uri: string;
  version: number | null;
  kind: 'unchanged';
  resultId: string;
}

export type WorkspaceDocumentDiagnosticReport =
  | WorkspaceFullDocumentDiagnosticReport
  | WorkspaceUnchangedDocumentDiagnosticReport;

export interface WorkspaceDiagnosticReport {
  items: WorkspaceDocumentDiagnosticReport[];
}

export interface WorkspaceDiagnosticReportPartialResult {
  items: WorkspaceDocumentDiagnosticReport[];
}

export interface ProgressParams<T = unknown> {
  token: string | number;
  value: T;
}

// --- PR2 batch operation result types -------------------------------------

/**
 * Reason a partial result was returned. Maps 1:1 to the cap-hit header
 * variants in the plan ("BUDGET", "MAX_FILES", "MAX_DIAGNOSTICS",
 * "MAX_BYTES", "SERVER_CRASH").
 */
export type PartialReason =
  | 'BUDGET'
  | 'MAX_FILES'
  | 'MAX_DIAGNOSTICS'
  | 'MAX_BYTES'
  | 'SERVER_CRASH';

/**
 * Counts of files dropped at the resolution/scan stage. Tools surface
 * these in the rendered header.
 */
export interface DroppedCounts {
  gitignored: number;
  notMatched: number;
  escaped: number;
  unreadable: number;
  maxFiles: number;
  /** Files dropped because the budget elapsed before we could request them. */
  budget?: number;
  /** Files dropped because no LSP server matched their extension. */
  noServer?: number;
  /** Files dropped because their server-bucket crashed mid-batch. */
  serverCrash?: number;
  /** Files dropped because `include_unopened=false` and they weren't open. */
  notOpen?: number;
}

/**
 * Per-URI diagnostics item bundle returned by batch ops.
 */
export interface DiagnosticsByFile {
  uri: string;
  items: Diagnostic[];
}

/**
 * Output of the `workspaceDiagnostic` op (single-bucket).
 */
export interface WorkspaceDiagnosticOpResult {
  items: DiagnosticsByFile[];
  partial?: boolean;
  partialReason?: PartialReason;
  droppedCounts?: Partial<DroppedCounts>;
}

/**
 * Output of `perFilePullBatch` and `pushFallbackBatch`.
 */
export interface PerFileBatchResult {
  items: DiagnosticsByFile[];
  partial?: boolean;
  partialReason?: PartialReason;
  droppedCounts?: Partial<DroppedCounts>;
}

/**
 * Input to `LSPClient.getDiagnosticsBatch`.
 *
 * If both `paths` and `patterns` are absent/empty the call falls back to
 * workspace scope (workspace/diagnostic when supported by every bucket,
 * otherwise the per-file pull path against open files).
 */
export interface BatchDiagnosticsRequest {
  paths?: string[];
  patterns?: string[];
  root?: string;
  respectGitignore?: boolean;
  includeUnopened?: boolean;
  minSeverity?: 'error' | 'warning' | 'information' | 'hint';
  sources?: string[];
  excludeCodes?: string[];
  maxFiles?: number;
  maxDiagnostics?: number;
  maxBytes?: number;
  timeBudgetMs?: number;
  format?: 'summary' | 'by_file' | 'flat' | 'json';
  groupBy?: 'file' | 'code' | 'source' | 'severity';
}

/**
 * Output of `LSPClient.getDiagnosticsBatch` -- the tool layer renders this.
 */
export interface BatchDiagnosticsResult {
  items: DiagnosticsByFile[];
  buckets: Array<{
    serverKey: string;
    completed: boolean;
    partialReason?: PartialReason;
    fileCount: number;
  }>;
  filesConsidered: number;
  filesWithDiagnostics: number;
  scope: 'workspace' | 'paths' | 'patterns' | 'paths+patterns';
  rootDir: string;
  partial: boolean;
  partialReasons: PartialReason[];
  droppedCounts: DroppedCounts;
  resolvedRoot: string;
  /** Server-key strings for buckets that fully completed. */
  completedBucketKeys: string[];
  /** Server-key strings for buckets that finished partially. */
  partialBucketKeys: string[];
}

/**
 * LSP server adapter for handling server-specific behavior.
 * This is an internal interface - no user extensions supported.
 *
 * Adapters allow cclsp to handle LSP servers that deviate from the standard
 * protocol or have special requirements.
 */
export interface ServerAdapter {
  /** Adapter name for logging */
  readonly name: string;

  /**
   * Check if this adapter should be used for the given config.
   * Called during server initialization to auto-detect the appropriate adapter.
   */
  matches(config: LSPServerConfig): boolean;

  /**
   * Customize initialization parameters before sending to server.
   * Use this to add server-specific initialization options.
   */
  customizeInitializeParams?(params: InitializeParams): InitializeParams;

  /**
   * Handle custom notifications from server.
   * Return true if handled, false to fall through to standard handling.
   */
  handleNotification?(method: string, params: unknown, state: ServerState): boolean;

  /**
   * Handle custom requests from server.
   * Should return a promise that resolves to the response.
   * Throw an error to indicate the request was not handled.
   */
  handleRequest?(method: string, params: unknown, state: ServerState): Promise<unknown>;

  /**
   * Get custom timeout for specific LSP methods.
   * Return undefined to use the default timeout (30000ms).
   */
  getTimeout?(method: string): number | undefined;
}

/**
 * LSP InitializeParams type
 * Subset of the full LSP specification
 */
export interface InitializeParams {
  processId: number | null;
  clientInfo: { name: string; version: string };
  capabilities: unknown;
  rootUri: string;
  workspaceFolders: Array<{ uri: string; name: string }>;
  initializationOptions?: unknown;
}
