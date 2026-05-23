import { describe, expect, it } from 'bun:test';
import { supportsTextDocumentDiagnostic, supportsWorkspaceDiagnostic } from './capabilities.js';
import type { ServerCapabilities, ServerState } from './types.js';

/**
 * Build a minimal ServerState-shaped object for capability tests. Only the
 * `capabilities` field is consulted by the helpers under test; the rest is
 * filled with stubs.
 */
function makeState(capabilities: ServerCapabilities | undefined): ServerState {
  return {
    process: {} as unknown as ServerState['process'],
    transport: {
      sendRequest: async () => undefined,
      sendMessage: () => undefined,
      sendNotification: () => undefined,
      rejectAllPending: () => undefined,
    },
    documentManager: {
      ensureOpen: async () => false,
      sendChange: () => undefined,
      isOpen: () => false,
      getVersion: () => 0,
    },
    initialized: true,
    initializationPromise: Promise.resolve(),
    startTime: 0,
    config: { extensions: [], command: [] },
    diagnosticsCache: {
      update: () => undefined,
      get: () => undefined,
      waitForIdle: async () => undefined,
    },
    capabilities,
    inFlightBatchCount: 0,
  };
}

describe('supportsTextDocumentDiagnostic', () => {
  it('returns false when capabilities are undefined', () => {
    expect(supportsTextDocumentDiagnostic(makeState(undefined))).toBe(false);
  });

  it('returns false when diagnosticProvider is undefined', () => {
    expect(supportsTextDocumentDiagnostic(makeState({}))).toBe(false);
  });

  it('returns true when diagnosticProvider is the boolean true shorthand', () => {
    expect(supportsTextDocumentDiagnostic(makeState({ diagnosticProvider: true }))).toBe(true);
  });

  it('returns false when diagnosticProvider is explicitly false', () => {
    expect(supportsTextDocumentDiagnostic(makeState({ diagnosticProvider: false }))).toBe(false);
  });

  it('returns true when diagnosticProvider is a DiagnosticOptions object', () => {
    expect(
      supportsTextDocumentDiagnostic(
        makeState({
          diagnosticProvider: {
            interFileDependencies: true,
            workspaceDiagnostics: false,
          },
        })
      )
    ).toBe(true);
  });
});

describe('supportsWorkspaceDiagnostic', () => {
  it('returns false when capabilities are undefined', () => {
    expect(supportsWorkspaceDiagnostic(makeState(undefined))).toBe(false);
  });

  it('returns false when diagnosticProvider is undefined', () => {
    expect(supportsWorkspaceDiagnostic(makeState({}))).toBe(false);
  });

  it('returns false when diagnosticProvider is the boolean true shorthand', () => {
    expect(supportsWorkspaceDiagnostic(makeState({ diagnosticProvider: true }))).toBe(false);
  });

  it('returns false when diagnosticProvider is false', () => {
    expect(supportsWorkspaceDiagnostic(makeState({ diagnosticProvider: false }))).toBe(false);
  });

  it('returns false when workspaceDiagnostics is not set on the object form', () => {
    expect(
      supportsWorkspaceDiagnostic(
        makeState({
          diagnosticProvider: {
            interFileDependencies: true,
            workspaceDiagnostics: false,
          },
        })
      )
    ).toBe(false);
  });

  it('returns true only when workspaceDiagnostics === true', () => {
    expect(
      supportsWorkspaceDiagnostic(
        makeState({
          diagnosticProvider: {
            interFileDependencies: true,
            workspaceDiagnostics: true,
          },
        })
      )
    ).toBe(true);
  });
});
