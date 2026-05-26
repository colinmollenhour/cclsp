import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import { pathToUri, uriToPath } from '../utils.js';
import { LSPRequestTimeoutError, RequestCancelledError } from './json-rpc.js';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Diagnostic,
  DiagnosticsByFile,
  DocumentDiagnosticReport,
  DocumentSymbol,
  LSPLocation,
  Location,
  PerFileBatchResult,
  Position,
  PreviousResultId,
  ServerState,
  SymbolInformation,
  SymbolMatch,
  WorkspaceDiagnosticOpResult,
  WorkspaceDiagnosticReport,
  WorkspaceDiagnosticReportPartialResult,
  WorkspaceDocumentDiagnosticReport,
} from './types.js';
import { SymbolKind } from './types.js';

/**
 * Default per-server concurrency for `perFilePullBatch` and
 * `pushFallbackBatch`. Tunable constant per the plan.
 */
export const BATCH_FILE_CONCURRENCY = 2;

/**
 * Minimum per-request timeout for batch paths. If less than this much
 * budget remains, we drop the file instead of issuing the request.
 */
const MIN_PER_REQ_MS = 250;

/**
 * Default upper-bound timeout used when no adapter overrides it. Mirrors
 * the default in the single-file ops.
 */
const DEFAULT_OP_TIMEOUT_MS = 30000;

/**
 * Maximum time we wait after the deadline for `closeDocument` cleanup and
 * any cancellation rejections to settle before returning the bucket
 * result. Pure safety net — under normal operation the rejects resolve
 * synchronously inside `cancelRequest`.
 */
const CANCEL_GRACE_MS = 100;

// --- Symbol Utilities ---

export function symbolKindToString(kind: SymbolKind): string {
  const kindMap: Record<SymbolKind, string> = {
    [SymbolKind.File]: 'file',
    [SymbolKind.Module]: 'module',
    [SymbolKind.Namespace]: 'namespace',
    [SymbolKind.Package]: 'package',
    [SymbolKind.Class]: 'class',
    [SymbolKind.Method]: 'method',
    [SymbolKind.Property]: 'property',
    [SymbolKind.Field]: 'field',
    [SymbolKind.Constructor]: 'constructor',
    [SymbolKind.Enum]: 'enum',
    [SymbolKind.Interface]: 'interface',
    [SymbolKind.Function]: 'function',
    [SymbolKind.Variable]: 'variable',
    [SymbolKind.Constant]: 'constant',
    [SymbolKind.String]: 'string',
    [SymbolKind.Number]: 'number',
    [SymbolKind.Boolean]: 'boolean',
    [SymbolKind.Array]: 'array',
    [SymbolKind.Object]: 'object',
    [SymbolKind.Key]: 'key',
    [SymbolKind.Null]: 'null',
    [SymbolKind.EnumMember]: 'enum_member',
    [SymbolKind.Struct]: 'struct',
    [SymbolKind.Event]: 'event',
    [SymbolKind.Operator]: 'operator',
    [SymbolKind.TypeParameter]: 'type_parameter',
  };
  return kindMap[kind] || 'unknown';
}

export function getValidSymbolKinds(): string[] {
  return [
    'file',
    'module',
    'namespace',
    'package',
    'class',
    'method',
    'property',
    'field',
    'constructor',
    'enum',
    'interface',
    'function',
    'variable',
    'constant',
    'string',
    'number',
    'boolean',
    'array',
    'object',
    'key',
    'null',
    'enum_member',
    'struct',
    'event',
    'operator',
    'type_parameter',
  ];
}

export function stringToSymbolKind(kindStr: string): SymbolKind | null {
  const kindMap: Record<string, SymbolKind> = {
    file: SymbolKind.File,
    module: SymbolKind.Module,
    namespace: SymbolKind.Namespace,
    package: SymbolKind.Package,
    class: SymbolKind.Class,
    method: SymbolKind.Method,
    property: SymbolKind.Property,
    field: SymbolKind.Field,
    constructor: SymbolKind.Constructor,
    enum: SymbolKind.Enum,
    interface: SymbolKind.Interface,
    function: SymbolKind.Function,
    variable: SymbolKind.Variable,
    constant: SymbolKind.Constant,
    string: SymbolKind.String,
    number: SymbolKind.Number,
    boolean: SymbolKind.Boolean,
    array: SymbolKind.Array,
    object: SymbolKind.Object,
    key: SymbolKind.Key,
    null: SymbolKind.Null,
    enum_member: SymbolKind.EnumMember,
    struct: SymbolKind.Struct,
    event: SymbolKind.Event,
    operator: SymbolKind.Operator,
    type_parameter: SymbolKind.TypeParameter,
  };
  return kindMap[kindStr.toLowerCase()] || null;
}

export function flattenDocumentSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
  const flattened: DocumentSymbol[] = [];
  for (const symbol of symbols) {
    flattened.push(symbol);
    if (symbol.children) {
      flattened.push(...flattenDocumentSymbols(symbol.children));
    }
  }
  return flattened;
}

export function isDocumentSymbolArray(
  symbols: DocumentSymbol[] | SymbolInformation[]
): symbols is DocumentSymbol[] {
  if (symbols.length === 0) return true;
  const firstSymbol = symbols[0];
  if (!firstSymbol) return true;
  return 'range' in firstSymbol && 'selectionRange' in firstSymbol;
}

export function findSymbolPositionInFile(filePath: string, symbol: SymbolInformation): Position {
  try {
    const fileContent = readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    const range = symbol.location.range;
    const startLine = range.start.line;
    const endLine = range.end.line;

    logger.debug(
      `[DEBUG findSymbolPositionInFile] Searching for "${symbol.name}" in lines ${startLine}-${endLine}\n`
    );

    for (let lineNum = startLine; lineNum <= endLine && lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      if (!line) continue;

      let searchStart = 0;
      if (lineNum === startLine) {
        searchStart = range.start.character;
      }

      let searchEnd = line.length;
      if (lineNum === endLine) {
        searchEnd = range.end.character;
      }

      const searchText = line.substring(searchStart, searchEnd);
      const symbolIndex = searchText.indexOf(symbol.name);

      if (symbolIndex !== -1) {
        const actualCharacter = searchStart + symbolIndex;
        logger.debug(
          `[DEBUG findSymbolPositionInFile] Found "${symbol.name}" at line ${lineNum}, character ${actualCharacter}\n`
        );
        return { line: lineNum, character: actualCharacter };
      }
    }

    logger.debug(
      `[DEBUG findSymbolPositionInFile] Symbol "${symbol.name}" not found in range, using range start\n`
    );
    return range.start;
  } catch (error) {
    logger.debug(
      `[DEBUG findSymbolPositionInFile] Error reading file: ${error}, using range start\n`
    );
    return symbol.location.range.start;
  }
}

// --- LSP Operations ---

export async function findDefinition(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<Location[]> {
  logger.debug(
    `[DEBUG findDefinition] Requesting definition for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;

  const wasJustOpened = await serverState.documentManager.ensureOpen(filePath);
  if (wasJustOpened) {
    logger.debug(
      '[DEBUG findDefinition] File was just opened, waiting for server to index project...\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  logger.debug('[DEBUG findDefinition] Sending textDocument/definition request\n');
  const method = 'textDocument/definition';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  logger.debug(
    `[DEBUG findDefinition] Result type: ${typeof result}, isArray: ${Array.isArray(result)}\n`
  );

  if (Array.isArray(result)) {
    logger.debug(`[DEBUG findDefinition] Array result with ${result.length} locations\n`);
    if (result.length > 0) {
      logger.debug(
        `[DEBUG findDefinition] First location: ${JSON.stringify(result[0], null, 2)}\n`
      );
    }
    return result.map((loc: LSPLocation) => ({
      uri: loc.uri,
      range: loc.range,
    }));
  }
  if (result && typeof result === 'object' && 'uri' in result) {
    logger.debug(
      `[DEBUG findDefinition] Single location result: ${JSON.stringify(result, null, 2)}\n`
    );
    const location = result as LSPLocation;
    return [{ uri: location.uri, range: location.range }];
  }

  logger.debug('[DEBUG findDefinition] No definition found or unexpected result format\n');
  return [];
}

export async function findReferences(
  serverState: ServerState,
  filePath: string,
  position: Position,
  includeDeclaration = true
): Promise<Location[]> {
  logger.debug(
    `[DEBUG] findReferences for ${filePath} at ${position.line}:${position.character}, includeDeclaration: ${includeDeclaration}\n`
  );

  await serverState.initializationPromise;

  const wasJustOpened = await serverState.documentManager.ensureOpen(filePath);
  if (wasJustOpened) {
    logger.debug(
      '[DEBUG findReferences] File was just opened, waiting for server to index project...\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const method = 'textDocument/references';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
      context: { includeDeclaration },
    },
    timeout
  );

  logger.debug(
    `[DEBUG] findReferences result type: ${typeof result}, isArray: ${Array.isArray(result)}, length: ${Array.isArray(result) ? result.length : 'N/A'}\n`
  );

  if (result && Array.isArray(result) && result.length > 0) {
    logger.debug(`[DEBUG] First reference: ${JSON.stringify(result[0], null, 2)}\n`);
  } else if (result === null || result === undefined) {
    logger.debug('[DEBUG] findReferences returned null/undefined\n');
  } else {
    logger.debug(`[DEBUG] findReferences returned unexpected result: ${JSON.stringify(result)}\n`);
  }

  if (Array.isArray(result)) {
    return result.map((loc: LSPLocation) => ({
      uri: loc.uri,
      range: loc.range,
    }));
  }

  return [];
}

export async function renameSymbol(
  serverState: ServerState,
  filePath: string,
  position: Position,
  newName: string
): Promise<{
  changes?: Record<string, Array<{ range: { start: Position; end: Position }; newText: string }>>;
}> {
  logger.debug(
    `[DEBUG renameSymbol] Requesting rename for ${filePath} at ${position.line}:${position.character} to "${newName}"\n`
  );

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  logger.debug('[DEBUG renameSymbol] Sending textDocument/rename request\n');
  const method = 'textDocument/rename';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
      newName,
    },
    timeout
  );

  logger.debug(
    `[DEBUG renameSymbol] Result type: ${typeof result}, hasChanges: ${result && typeof result === 'object' && 'changes' in result}, hasDocumentChanges: ${result && typeof result === 'object' && 'documentChanges' in result}\n`
  );

  if (result && typeof result === 'object') {
    if ('changes' in result) {
      const workspaceEdit = result as {
        changes: Record<
          string,
          Array<{ range: { start: Position; end: Position }; newText: string }>
        >;
      };
      const changeCount = Object.keys(workspaceEdit.changes || {}).length;
      logger.debug(`[DEBUG renameSymbol] WorkspaceEdit has changes for ${changeCount} files\n`);
      return workspaceEdit;
    }

    if ('documentChanges' in result) {
      const workspaceEdit = result as {
        documentChanges?: Array<{
          textDocument: { uri: string; version?: number };
          edits: Array<{
            range: { start: Position; end: Position };
            newText: string;
          }>;
        }>;
      };

      logger.debug(
        `[DEBUG renameSymbol] WorkspaceEdit has documentChanges with ${workspaceEdit.documentChanges?.length || 0} entries\n`
      );

      const changes: Record<
        string,
        Array<{ range: { start: Position; end: Position }; newText: string }>
      > = {};

      if (workspaceEdit.documentChanges) {
        for (const change of workspaceEdit.documentChanges) {
          if (change.textDocument && change.edits) {
            const uri = change.textDocument.uri;
            if (!changes[uri]) {
              changes[uri] = [];
            }
            changes[uri].push(...change.edits);
            logger.debug(`[DEBUG renameSymbol] Added ${change.edits.length} edits for ${uri}\n`);
          }
        }
      }

      return { changes };
    }
  }

  logger.debug('[DEBUG renameSymbol] No rename changes available\n');
  return {};
}

export async function getDocumentSymbols(
  serverState: ServerState,
  filePath: string
): Promise<DocumentSymbol[] | SymbolInformation[]> {
  logger.debug(`[DEBUG] Requesting documentSymbol for: ${filePath}\n`);

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const method = 'textDocument/documentSymbol';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;

  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
    },
    timeout
  );

  logger.debug(
    `[DEBUG] documentSymbol result type: ${typeof result}, isArray: ${Array.isArray(result)}, length: ${Array.isArray(result) ? result.length : 'N/A'}\n`
  );

  if (result && Array.isArray(result) && result.length > 0) {
    logger.debug(`[DEBUG] First symbol: ${JSON.stringify(result[0], null, 2)}\n`);
  } else if (result === null || result === undefined) {
    logger.debug('[DEBUG] documentSymbol returned null/undefined\n');
  } else {
    logger.debug(`[DEBUG] documentSymbol returned unexpected result: ${JSON.stringify(result)}\n`);
  }

  if (Array.isArray(result)) {
    return result as DocumentSymbol[] | SymbolInformation[];
  }

  return [];
}

export async function findSymbolsByName(
  serverState: ServerState,
  filePath: string,
  symbolName: string,
  symbolKind?: string
): Promise<{ matches: SymbolMatch[]; warning?: string }> {
  logger.debug(
    `[DEBUG findSymbolsByName] Searching for symbol "${symbolName}" with kind "${symbolKind || 'any'}" in ${filePath}\n`
  );

  let validationWarning: string | undefined;
  let effectiveSymbolKind = symbolKind;
  if (symbolKind && stringToSymbolKind(symbolKind) === null) {
    const validKinds = getValidSymbolKinds();
    validationWarning = `⚠️ Invalid symbol kind "${symbolKind}". Valid kinds are: ${validKinds.join(', ')}. Searching all symbol types instead.`;
    effectiveSymbolKind = undefined;
  }

  const symbols = await getDocumentSymbols(serverState, filePath);
  const matches: SymbolMatch[] = [];

  logger.debug(`[DEBUG findSymbolsByName] Got ${symbols.length} symbols from documentSymbols\n`);

  if (isDocumentSymbolArray(symbols)) {
    logger.debug('[DEBUG findSymbolsByName] Processing DocumentSymbol[] (hierarchical format)\n');
    const flatSymbols = flattenDocumentSymbols(symbols);
    logger.debug(`[DEBUG findSymbolsByName] Flattened to ${flatSymbols.length} symbols\n`);

    for (const symbol of flatSymbols) {
      const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
      const kindMatches =
        !effectiveSymbolKind ||
        symbolKindToString(symbol.kind) === effectiveSymbolKind.toLowerCase();

      logger.debug(
        `[DEBUG findSymbolsByName] Checking DocumentSymbol: ${symbol.name} (${symbolKindToString(symbol.kind)}) - nameMatch: ${nameMatches}, kindMatch: ${kindMatches}\n`
      );

      if (nameMatches && kindMatches) {
        logger.debug(
          `[DEBUG findSymbolsByName] DocumentSymbol match: ${symbol.name} (kind=${symbol.kind}) using selectionRange ${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}\n`
        );
        matches.push({
          name: symbol.name,
          kind: symbol.kind,
          position: symbol.selectionRange.start,
          range: symbol.range,
          detail: symbol.detail,
        });
      }
    }
  } else {
    logger.debug('[DEBUG findSymbolsByName] Processing SymbolInformation[] (flat format)\n');
    for (const symbol of symbols) {
      const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
      const kindMatches =
        !effectiveSymbolKind ||
        symbolKindToString(symbol.kind) === effectiveSymbolKind.toLowerCase();

      logger.debug(
        `[DEBUG findSymbolsByName] Checking SymbolInformation: ${symbol.name} (${symbolKindToString(symbol.kind)}) - nameMatch: ${nameMatches}, kindMatch: ${kindMatches}\n`
      );

      if (nameMatches && kindMatches) {
        logger.debug(
          `[DEBUG findSymbolsByName] SymbolInformation match: ${symbol.name} (kind=${symbol.kind}) at ${symbol.location.range.start.line}:${symbol.location.range.start.character} to ${symbol.location.range.end.line}:${symbol.location.range.end.character}\n`
        );
        const position = findSymbolPositionInFile(filePath, symbol);
        logger.debug(
          `[DEBUG findSymbolsByName] Found symbol position in file: ${position.line}:${position.character}\n`
        );
        matches.push({
          name: symbol.name,
          kind: symbol.kind,
          position: position,
          range: symbol.location.range,
          detail: undefined,
        });
      }
    }
  }

  logger.debug(`[DEBUG findSymbolsByName] Found ${matches.length} matching symbols\n`);

  let fallbackWarning: string | undefined;
  if (effectiveSymbolKind && matches.length === 0) {
    logger.debug(
      `[DEBUG findSymbolsByName] No matches found for kind "${effectiveSymbolKind}", trying fallback search for all kinds\n`
    );

    const fallbackMatches: SymbolMatch[] = [];

    if (isDocumentSymbolArray(symbols)) {
      const flatSymbols = flattenDocumentSymbols(symbols);
      for (const symbol of flatSymbols) {
        const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
        if (nameMatches) {
          fallbackMatches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: symbol.selectionRange.start,
            range: symbol.range,
            detail: symbol.detail,
          });
        }
      }
    } else {
      for (const symbol of symbols) {
        const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
        if (nameMatches) {
          const position = findSymbolPositionInFile(filePath, symbol);
          fallbackMatches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: position,
            range: symbol.location.range,
            detail: undefined,
          });
        }
      }
    }

    if (fallbackMatches.length > 0) {
      const foundKinds = [...new Set(fallbackMatches.map((m) => symbolKindToString(m.kind)))];
      fallbackWarning = `⚠️ No symbols found with kind "${effectiveSymbolKind}". Found ${fallbackMatches.length} symbol(s) with name "${symbolName}" of other kinds: ${foundKinds.join(', ')}.`;
      matches.push(...fallbackMatches);
      logger.debug(
        `[DEBUG findSymbolsByName] Fallback search found ${fallbackMatches.length} additional matches\n`
      );
    }
  }

  const combinedWarning = [validationWarning, fallbackWarning].filter(Boolean).join(' ');
  return { matches, warning: combinedWarning || undefined };
}

export async function getDiagnostics(
  serverState: ServerState,
  filePath: string
): Promise<Diagnostic[]> {
  logger.debug(`[DEBUG getDiagnostics] Requesting diagnostics for ${filePath}\n`);

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const fileUri = pathToUri(filePath);
  const cachedDiagnostics = serverState.diagnosticsCache.get(fileUri);

  if (cachedDiagnostics !== undefined) {
    logger.debug(
      `[DEBUG getDiagnostics] Returning ${cachedDiagnostics.length} cached diagnostics from publishDiagnostics\n`
    );
    return cachedDiagnostics;
  }

  logger.debug(
    '[DEBUG getDiagnostics] No cached diagnostics, trying textDocument/diagnostic request\n'
  );

  try {
    const result = await serverState.transport.sendRequest('textDocument/diagnostic', {
      textDocument: { uri: fileUri },
    });

    logger.debug(
      `[DEBUG getDiagnostics] Result type: ${typeof result}, has kind: ${result && typeof result === 'object' && 'kind' in result}\n`
    );

    if (result && typeof result === 'object' && 'kind' in result) {
      const report = result as DocumentDiagnosticReport;

      if (report.kind === 'full' && report.items) {
        logger.debug(
          `[DEBUG getDiagnostics] Full report with ${report.items.length} diagnostics\n`
        );
        return report.items;
      }
      if (report.kind === 'unchanged') {
        logger.debug('[DEBUG getDiagnostics] Unchanged report (no new diagnostics)\n');
        return [];
      }
    }

    logger.debug('[DEBUG getDiagnostics] Unexpected response format, returning empty array\n');
    return [];
  } catch (error) {
    logger.debug(
      `[DEBUG getDiagnostics] textDocument/diagnostic not supported or failed: ${error}. Waiting for publishDiagnostics...\n`
    );

    await serverState.diagnosticsCache.waitForIdle(fileUri, {
      maxWaitTime: 5000,
      idleTime: 300,
    });

    const diagnosticsAfterWait = serverState.diagnosticsCache.get(fileUri);
    if (diagnosticsAfterWait !== undefined) {
      logger.debug(
        `[DEBUG getDiagnostics] Returning ${diagnosticsAfterWait.length} diagnostics after waiting for idle state\n`
      );
      return diagnosticsAfterWait;
    }

    logger.debug(
      '[DEBUG getDiagnostics] No diagnostics yet, triggering publishDiagnostics with no-op change\n'
    );

    try {
      const fileContent = readFileSync(filePath, 'utf-8');
      serverState.documentManager.sendChange(filePath, `${fileContent} `);
      serverState.documentManager.sendChange(filePath, fileContent);

      await serverState.diagnosticsCache.waitForIdle(fileUri, {
        maxWaitTime: 3000,
        idleTime: 300,
      });

      const diagnosticsAfterTrigger = serverState.diagnosticsCache.get(fileUri);
      if (diagnosticsAfterTrigger !== undefined) {
        logger.debug(
          `[DEBUG getDiagnostics] Returning ${diagnosticsAfterTrigger.length} diagnostics after triggering publishDiagnostics\n`
        );
        return diagnosticsAfterTrigger;
      }
    } catch (triggerError) {
      logger.debug(
        `[DEBUG getDiagnostics] Failed to trigger publishDiagnostics: ${triggerError}\n`
      );
    }

    return [];
  }
}

export async function hover(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<{
  contents: string | { kind: string; value: string };
  range?: { start: Position; end: Position };
} | null> {
  logger.debug(
    `[DEBUG hover] Requesting hover for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const method = 'textDocument/hover';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  if (result && typeof result === 'object' && 'contents' in result) {
    return result as {
      contents: string | { kind: string; value: string };
      range?: { start: Position; end: Position };
    };
  }

  return null;
}

export async function workspaceSymbol(
  serverState: ServerState,
  query: string
): Promise<SymbolInformation[]> {
  logger.debug(`[DEBUG workspaceSymbol] Searching for "${query}"\n`);

  await serverState.initializationPromise;

  const method = 'workspace/symbol';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { query }, timeout);

  if (Array.isArray(result)) {
    return result as SymbolInformation[];
  }

  return [];
}

export async function findImplementation(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<Location[]> {
  logger.debug(
    `[DEBUG findImplementation] Requesting implementation for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const method = 'textDocument/implementation';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  if (Array.isArray(result)) {
    return result.map((loc: LSPLocation) => ({
      uri: loc.uri,
      range: loc.range,
    }));
  }
  if (result && typeof result === 'object' && 'uri' in result) {
    const location = result as LSPLocation;
    return [{ uri: location.uri, range: location.range }];
  }

  return [];
}

export async function prepareCallHierarchy(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<CallHierarchyItem[]> {
  logger.debug(
    `[DEBUG prepareCallHierarchy] Requesting call hierarchy for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  await serverState.documentManager.ensureOpen(filePath);

  const method = 'textDocument/prepareCallHierarchy';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  if (Array.isArray(result)) {
    return result as CallHierarchyItem[];
  }

  return [];
}

export async function incomingCalls(
  serverState: ServerState,
  item: CallHierarchyItem
): Promise<CallHierarchyIncomingCall[]> {
  logger.debug(`[DEBUG incomingCalls] Requesting incoming calls for ${item.name}\n`);

  await serverState.initializationPromise;

  const method = 'callHierarchy/incomingCalls';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { item }, timeout);

  if (Array.isArray(result)) {
    return result as CallHierarchyIncomingCall[];
  }

  return [];
}

export async function outgoingCalls(
  serverState: ServerState,
  item: CallHierarchyItem
): Promise<CallHierarchyOutgoingCall[]> {
  logger.debug(`[DEBUG outgoingCalls] Requesting outgoing calls for ${item.name}\n`);

  await serverState.initializationPromise;

  const method = 'callHierarchy/outgoingCalls';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { item }, timeout);

  if (Array.isArray(result)) {
    return result as CallHierarchyOutgoingCall[];
  }

  return [];
}

// --- Batch diagnostics operations (PR2) ----------------------------------

/**
 * Compute the per-request timeout from the shared deadline and an optional
 * adapter-provided upper bound. Returns `null` when the remaining budget is
 * below `MIN_PER_REQ_MS` (caller should drop the request as BUDGET).
 */
function computeBatchTimeout(
  serverState: ServerState,
  method: string,
  deadline: number
): number | null {
  const remaining = deadline - Date.now();
  if (remaining < MIN_PER_REQ_MS) return null;
  const adapterMax = serverState.adapter?.getTimeout?.(method) ?? DEFAULT_OP_TIMEOUT_MS;
  return Math.max(MIN_PER_REQ_MS, Math.min(adapterMax, remaining));
}

/**
 * Returns true when an error from the transport is a *cancellation* (i.e.
 * the batch path treats it as BUDGET, not SERVER_CRASH). This covers:
 *
 *  - `RequestCancelledError`: explicit `$/cancelRequest` via
 *    `transport.cancelRequest(id)` at deadline.
 *  - `LSPRequestTimeoutError`: the transport's per-request timer elapsed.
 *    Batch paths pass very generous per-request timeouts and rely on the
 *    deadline race + cancel propagation; if the internal timer still
 *    fires, it's still a budget condition, not a server crash.
 */
function isCancelledError(err: unknown): boolean {
  return err instanceof RequestCancelledError || err instanceof LSPRequestTimeoutError;
}

/**
 * Returns true when an error from the transport is specifically the
 * per-request timeout (separate from explicit cancellation).
 */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof LSPRequestTimeoutError;
}

/**
 * Race `promise` against the shared deadline. If the deadline elapses, the
 * returned promise rejects with `RequestCancelledError` and `onDeadline()`
 * fires so the caller can propagate the cancellation to the transport
 * (e.g., `transport.cancelRequest(id)` and/or aborting an AbortController).
 *
 * The original promise is NOT awaited after rejection; callers must ensure
 * any cleanup happens via `onDeadline`.
 */
function deadlineRace<T>(
  promise: Promise<T>,
  deadline: number,
  onDeadline?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  return new Promise<T>((resolve, reject) => {
    const ms = Math.max(0, deadline - Date.now());
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onDeadline?.();
      } catch (e) {
        logger.debug(`[DEBUG deadlineRace] onDeadline threw: ${e}\n`);
      }
      reject(new RequestCancelledError(-1));
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Execute `workspace/diagnostic` against a single server. Always sends a
 * UUID `partialResultToken` and a non-empty `previousResultIds` array
 * when the server-state cache has any cached resultIds.
 *
 * PR3 result-id reuse:
 *
 *  - `previousResultIds` defaults to the snapshot returned by
 *    `serverState.diagnosticsCache.listResultIds()`. Callers can pass an
 *    explicit array (e.g. tests) to override this. First call returns
 *    `[]` because no resultIds have been cached yet.
 *  - For each `kind: 'full'` response entry with a `resultId`, we call
 *    `setResultId(uri, resultId)` and `update(uri, items)` so subsequent
 *    calls can request `unchanged` reports.
 *  - For each `kind: 'unchanged'` response entry, we return the cached
 *    items via `diagnosticsCache.get(uri)`. If no cache entry exists for
 *    that URI (e.g. the cache was cleared between calls) we log at
 *    debug level and return an empty list for that URI.
 *
 * Accumulates `$/progress` partials and the final response items.
 */
export async function workspaceDiagnostic(
  serverState: ServerState,
  options: {
    deadline: number;
    previousResultIds?: PreviousResultId[];
    workspaceFolders?: string[];
  }
): Promise<WorkspaceDiagnosticOpResult> {
  const { deadline } = options;
  // PR3: build previousResultIds from the per-server cache when the caller
  // does not supply one. This is the day-three contract — every workspace
  // pull from now on advertises whatever resultIds we have cached so the
  // server can answer with `kind: 'unchanged'` for unchanged files.
  const previousResultIds =
    options.previousResultIds ?? serverState.diagnosticsCache.listResultIds?.() ?? [];
  const partialResultToken = randomUUID();

  await serverState.initializationPromise;

  const method = 'workspace/diagnostic';
  if (Date.now() >= deadline) {
    logger.debug('[DEBUG workspaceDiagnostic] Deadline already elapsed; dropping with BUDGET\n');
    return {
      items: [],
      partial: true,
      partialReason: 'BUDGET',
    };
  }

  // The per-request timer should practically never fire — the deadline
  // race below is what enforces the wall-clock budget. We still pass an
  // upper-bound timeout so a hung connection eventually surfaces via
  // `LSPRequestTimeoutError` (which `isCancelledError` classifies as
  // BUDGET).
  const adapterMax = serverState.adapter?.getTimeout?.(method) ?? DEFAULT_OP_TIMEOUT_MS;
  const remaining = deadline - Date.now();
  const generousTimeout = Math.max(adapterMax, remaining) + CANCEL_GRACE_MS * 2;

  const partials: WorkspaceDocumentDiagnosticReport[] = [];
  const progressHandler = (value: unknown): void => {
    const partial = value as WorkspaceDiagnosticReportPartialResult | undefined;
    if (partial?.items && Array.isArray(partial.items)) {
      partials.push(...partial.items);
    }
  };

  const transport = serverState.transport;
  transport.registerProgressHandler?.(partialResultToken, progressHandler);

  try {
    const params = {
      previousResultIds,
      partialResultToken,
    };

    // Prefer `sendCancellableRequest` if the transport exposes it so we
    // can wire $/cancelRequest at the deadline. Fall back to the legacy
    // `sendRequest` for older mock transports in tests.
    let id: number | undefined;
    let promise: Promise<unknown>;
    if (transport.sendCancellableRequest) {
      const handle = transport.sendCancellableRequest(method, params, generousTimeout);
      id = handle.id;
      promise = handle.promise;
    } else {
      promise = transport.sendRequest(method, params, generousTimeout);
    }

    let response: WorkspaceDiagnosticReport | undefined;
    try {
      const raw = await deadlineRace(promise, deadline, () => {
        if (id !== undefined) {
          try {
            transport.cancelRequest?.(id);
          } catch (e) {
            logger.debug(`[DEBUG workspaceDiagnostic] cancelRequest threw: ${e}\n`);
          }
        }
      });
      response = raw as WorkspaceDiagnosticReport;
    } catch (err) {
      if (isCancelledError(err)) {
        logger.debug('[DEBUG workspaceDiagnostic] Request cancelled (BUDGET)\n');
        return {
          items: mergeReports(serverState, partials, undefined),
          partial: true,
          partialReason: 'BUDGET',
        };
      }
      // Server crash / process exit / generic LSP error.
      logger.debug(`[DEBUG workspaceDiagnostic] Request error: ${err}\n`);
      return {
        items: mergeReports(serverState, partials, undefined),
        partial: true,
        partialReason: 'SERVER_CRASH',
      };
    }

    return {
      items: mergeReports(serverState, partials, response?.items ?? []),
    };
  } finally {
    transport.unregisterProgressHandler?.(partialResultToken);
  }
}

/**
 * Convert a list of `WorkspaceDocumentDiagnosticReport` entries (partials
 * + final) into the flat `DiagnosticsByFile[]` shape used by the tool
 * layer.
 *
 * PR3 result-id reuse:
 *
 *  - `kind: 'full'` entries with a `resultId` are stored via
 *    `diagnosticsCache.setResultId(uri, resultId)` and the items are
 *    written through `diagnosticsCache.update(uri, items)` so a later
 *    `unchanged` report can be answered from the cache.
 *  - `kind: 'unchanged'` entries return the cached items via
 *    `diagnosticsCache.get(uri)`. When no cache entry exists for the URI
 *    (e.g. the cache was cleared between calls), we log at debug level
 *    and return an empty list for that URI as a defensive fallback.
 */
function mergeReports(
  serverState: ServerState,
  partials: WorkspaceDocumentDiagnosticReport[],
  finalItems: WorkspaceDocumentDiagnosticReport[] | undefined
): DiagnosticsByFile[] {
  const byUri = new Map<string, Diagnostic[]>();
  const cache = serverState.diagnosticsCache;
  const consume = (entries: WorkspaceDocumentDiagnosticReport[]): void => {
    for (const entry of entries) {
      if (!entry || !entry.uri) continue;
      if (entry.kind === 'full') {
        const items = entry.items ?? [];
        // Later "full" reports for the same URI overwrite earlier ones.
        byUri.set(entry.uri, items);
        // Persist the resultId + items so a later call can request
        // `unchanged` reports against them.
        if (cache.setResultId) {
          cache.setResultId(entry.uri, entry.resultId ?? '');
        }
        // Always write through items so `kind: 'unchanged'` reuse on the
        // next call has fresh data, even when the server omitted resultId.
        cache.update(entry.uri, items);
      } else if (entry.kind === 'unchanged') {
        const cached = cache.get(entry.uri);
        if (cached !== undefined) {
          byUri.set(entry.uri, cached);
        } else {
          logger.debug(
            `[DEBUG workspaceDiagnostic] kind:'unchanged' for ${entry.uri} with no cached entry; returning []\n`
          );
          if (!byUri.has(entry.uri)) byUri.set(entry.uri, []);
        }
        // Refresh the resultId so the server's latest opaque token wins.
        if (cache.setResultId) {
          cache.setResultId(entry.uri, entry.resultId ?? '');
        }
      }
    }
  };
  consume(partials);
  if (finalItems) consume(finalItems);
  return Array.from(byUri.entries()).map(([uri, items]) => ({ uri, items }));
}

/**
 * Run a small concurrent worker pool over `files`, calling `worker(file)`
 * for each. Stops dispatching new work once `Date.now() >= deadline`. The
 * worker is responsible for honoring the deadline itself when issuing
 * LSP requests; this pool only gates *new* dispatches.
 *
 * Returns `{ inFlightTracker }` so the caller can observe the maximum
 * concurrency reached in tests (the value is the peak count). The pool
 * always completes after every dispatched worker settles (resolve or
 * reject) so cleanup can run in a `finally`.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  deadline: number,
  worker: (item: T, signal: { cancelled: boolean }) => Promise<R>
): Promise<{ results: Array<{ item: T; value?: R; error?: unknown }>; peakInFlight: number }> {
  const results: Array<{ item: T; value?: R; error?: unknown }> = [];
  let index = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const signal = { cancelled: false };

  const workersDone: Promise<void>[] = [];

  const launchOne = async (): Promise<void> => {
    while (true) {
      if (signal.cancelled) return;
      const i = index++;
      if (i >= items.length) return;
      if (Date.now() >= deadline) {
        // Budget elapsed; record remaining as drops.
        signal.cancelled = true;
        return;
      }
      const item = items[i];
      if (item === undefined) return;
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      try {
        const value = await worker(item, signal);
        results.push({ item, value });
      } catch (error) {
        results.push({ item, error });
      } finally {
        inFlight--;
      }
    }
  };

  const slots = Math.max(1, Math.min(concurrency, items.length));
  for (let s = 0; s < slots; s++) {
    workersDone.push(launchOne());
  }
  await Promise.all(workersDone);

  return { results, peakInFlight };
}

/**
 * Result returned by per-file fetchers to {@link runPerFileBucket}.
 * `items` is the list of diagnostics for the file's URI.
 */
interface PerFileFetcherResult {
  uri: string;
  items: Diagnostic[];
}

/**
 * Helpers a per-file fetcher receives from {@link runPerFileBucket}. The
 * fetcher must use these so the bucket can propagate cancellation cleanly:
 *
 *  - `signal`: aborted when the deadline elapses. Pass to
 *    `waitForIdle` and check before issuing new work.
 *  - `runCancellable(method, params, timeout)`: wraps
 *    `transport.sendCancellableRequest` (or `sendRequest`) and races against
 *    the shared deadline. On timeout it calls `transport.cancelRequest(id)`
 *    so the server frees its slot.
 */
interface PerFileFetcherHelpers {
  signal: AbortSignal;
  runCancellable: (method: string, params: unknown, timeout: number) => Promise<unknown>;
}

/**
 * Shared per-file bucket worker pool. Owns the open/close discipline,
 * dropCount bookkeeping, partial-flag aggregation, and deadline-driven
 * cancellation. {@link perFilePullBatch} and {@link pushFallbackBatch} are
 * thin wrappers supplying different fetchers.
 */
async function runPerFileBucket(
  serverState: ServerState,
  files: string[],
  options: {
    deadline: number;
    concurrency?: number;
    includeUnopened?: boolean;
    logTag: string;
  },
  fetcher: (
    filePath: string,
    deadline: number,
    helpers: PerFileFetcherHelpers
  ) => Promise<PerFileFetcherResult>
): Promise<PerFileBatchResult> {
  const { deadline, logTag } = options;
  const concurrency = options.concurrency ?? BATCH_FILE_CONCURRENCY;
  const includeUnopened = options.includeUnopened ?? true;

  await serverState.initializationPromise;

  const openedByMe = new Set<string>();
  const closedByMe = new Set<string>();
  const items: DiagnosticsByFile[] = [];
  let dropsBudget = 0;
  let dropsCrash = 0;
  let dropsUnreadable = 0;
  let dropsNotOpen = 0;

  const worker = async (file: string): Promise<void> => {
    if (closedByMe.has(file)) {
      // One-shot guarantee: do not reopen a file we already closed.
      return;
    }
    const wasOpen = serverState.documentManager.isOpen(file);
    if (!wasOpen && !includeUnopened) {
      dropsNotOpen++;
      return;
    }

    try {
      if (!wasOpen) {
        const opened = serverState.documentManager.ensureOpenAsync
          ? await serverState.documentManager.ensureOpenAsync(file)
          : await serverState.documentManager.ensureOpen(file);
        if (opened) openedByMe.add(file);
      }
    } catch (err) {
      logger.debug(`[DEBUG ${logTag}] Could not open ${file}: ${err}\n`);
      dropsUnreadable++;
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining < MIN_PER_REQ_MS) {
      dropsBudget++;
      if (openedByMe.has(file)) {
        serverState.documentManager.closeDocument?.(file);
        openedByMe.delete(file);
        closedByMe.add(file);
      }
      return;
    }

    // Per-file AbortController tied to the shared deadline. Used by the
    // fetcher to short-circuit `waitForIdle` calls and any other awaits
    // that accept an AbortSignal.
    const controller = new AbortController();

    const runCancellable = async (
      method: string,
      params: unknown,
      timeout: number
    ): Promise<unknown> => {
      const transport = serverState.transport;
      let id: number | undefined;
      let promise: Promise<unknown>;
      if (transport.sendCancellableRequest) {
        const handle = transport.sendCancellableRequest(method, params, timeout);
        id = handle.id;
        promise = handle.promise;
      } else {
        promise = transport.sendRequest(method, params, timeout);
      }
      return deadlineRace(promise, deadline, () => {
        if (id !== undefined) {
          try {
            transport.cancelRequest?.(id);
          } catch (e) {
            logger.debug(`[DEBUG ${logTag}] cancelRequest threw: ${e}\n`);
          }
        }
        controller.abort();
      });
    };

    try {
      const result = await fetcher(file, deadline, {
        signal: controller.signal,
        runCancellable,
      });
      items.push({ uri: result.uri, items: result.items });
    } catch (err) {
      if (isCancelledError(err)) {
        controller.abort();
        dropsBudget++;
      } else {
        logger.debug(`[DEBUG ${logTag}] Fetcher error for ${file}: ${err}\n`);
        dropsCrash++;
      }
    } finally {
      // Always abort to release any lingering signal-driven waits.
      if (!controller.signal.aborted) controller.abort();
      if (openedByMe.has(file)) {
        serverState.documentManager.closeDocument?.(file);
        openedByMe.delete(file);
        closedByMe.add(file);
      }
    }
  };

  await runWithConcurrency(files, concurrency, deadline, worker);

  // Anything not dispatched counts as BUDGET drop (deadline elapsed).
  const dispatched = items.length + dropsBudget + dropsCrash + dropsUnreadable + dropsNotOpen;
  const remaining = Math.max(0, files.length - dispatched);
  dropsBudget += remaining;

  let partial = false;
  let partialReason: PerFileBatchResult['partialReason'] | undefined;
  if (dropsCrash > 0) {
    partial = true;
    partialReason = 'SERVER_CRASH';
  } else if (dropsBudget > 0) {
    partial = true;
    partialReason = 'BUDGET';
  }

  return {
    items,
    partial,
    partialReason,
    droppedCounts: {
      budget: dropsBudget,
      unreadable: dropsUnreadable,
      serverCrash: dropsCrash,
      notOpen: dropsNotOpen,
    },
  };
}

/**
 * Per-file pull batch: for each file, open if needed → send
 * `textDocument/diagnostic` → close if we opened it. One-shot per batch
 * (R3) — a file we closed is NEVER re-opened in the same batch.
 */
export async function perFilePullBatch(
  serverState: ServerState,
  files: string[],
  options: {
    deadline: number;
    concurrency?: number;
    includeUnopened?: boolean;
  }
): Promise<PerFileBatchResult> {
  return runPerFileBucket(
    serverState,
    files,
    { ...options, logTag: 'perFilePullBatch' },
    async (file, deadline, helpers) => {
      const method = 'textDocument/diagnostic';
      const timeout = computeBatchTimeout(serverState, method, deadline);
      if (timeout === null) {
        // Surface BUDGET via RequestCancelledError so the bucket counts
        // this as a budget drop, not a crash.
        throw new RequestCancelledError(-1);
      }

      const uri = pathToUri(file);
      const raw = await helpers.runCancellable(method, { textDocument: { uri } }, timeout);

      if (raw && typeof raw === 'object' && 'kind' in raw) {
        const report = raw as DocumentDiagnosticReport;
        if (report.kind === 'full') return { uri, items: report.items ?? [] };
        return { uri, items: [] };
      }
      return { uri, items: [] };
    }
  );
}

/**
 * Push fallback batch: for servers that advertise neither
 * `textDocument/diagnostic` nor `workspace/diagnostic`. For each file:
 * open if not already open → `waitForIdle` to collect `publishDiagnostics`
 * → close if we opened it. One-shot per batch.
 */
export async function pushFallbackBatch(
  serverState: ServerState,
  files: string[],
  options: {
    deadline: number;
    concurrency?: number;
    includeUnopened?: boolean;
  }
): Promise<PerFileBatchResult> {
  return runPerFileBucket(
    serverState,
    files,
    { ...options, logTag: 'pushFallbackBatch' },
    async (file, deadline, helpers) => {
      const uri = pathToUri(file);
      const remaining = deadline - Date.now();
      if (remaining < MIN_PER_REQ_MS) {
        throw new RequestCancelledError(-1);
      }
      const maxWaitTime = Math.max(MIN_PER_REQ_MS, Math.min(remaining, 5000));

      // Race the wait against the shared deadline. The signal lets
      // `waitForIdle` return immediately on cancellation rather than
      // running its own poll loop to completion.
      try {
        await deadlineRace(
          serverState.diagnosticsCache.waitForIdle(uri, {
            maxWaitTime,
            idleTime: 300,
            signal: helpers.signal,
          }),
          deadline
        );
      } catch (err) {
        // If the deadline fired but we already have cached diagnostics
        // (e.g., the server published before the budget elapsed), surface
        // them instead of counting this as a drop.
        if (isCancelledError(err)) {
          const cached = serverState.diagnosticsCache.get(uri);
          if (cached !== undefined) {
            return { uri, items: cached };
          }
        }
        throw err;
      }

      const cached = serverState.diagnosticsCache.get(uri);
      return { uri, items: cached ?? [] };
    }
  );
}
