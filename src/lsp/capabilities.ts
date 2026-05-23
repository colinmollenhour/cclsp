import type { ServerState } from './types.js';

/**
 * Pure capability predicates derived from the `initialize` response.
 *
 * These helpers keep callers from reaching into capability internals so the
 * shape can evolve without rippling through batch/operation code.
 */

/**
 * Returns true when the server advertises any form of
 * `diagnosticProvider` capability — either the boolean `true` shorthand or
 * the structured `DiagnosticOptions` form. Implies support for
 * `textDocument/diagnostic` pull requests.
 */
export function supportsTextDocumentDiagnostic(state: ServerState): boolean {
  return !!state.capabilities?.diagnosticProvider;
}

/**
 * Returns true only when the server advertises
 * `diagnosticProvider.workspaceDiagnostics === true` (LSP 3.17). The boolean
 * `true` shorthand does NOT imply workspace diagnostics support.
 */
export function supportsWorkspaceDiagnostic(state: ServerState): boolean {
  const dp = state.capabilities?.diagnosticProvider;
  return typeof dp === 'object' && dp !== null && dp.workspaceDiagnostics === true;
}
