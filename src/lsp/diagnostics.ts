import { logger } from '../logger.js';
import type { Diagnostic } from './types.js';

/**
 * Cache for LSP diagnostics received via publishDiagnostics notifications.
 * Tracks diagnostic state per URI with version and timestamp tracking
 * to support idle detection for pull-based fallback.
 */
export class DiagnosticsCache {
  private diagnostics = new Map<string, Diagnostic[]>();
  private lastUpdate = new Map<string, number>();
  private versions = new Map<string, number>();
  private resultIds = new Map<string, string>();

  /**
   * Update cached diagnostics for a URI (called from publishDiagnostics handler).
   */
  update(uri: string, items: Diagnostic[], version?: number): void {
    this.diagnostics.set(uri, items);
    this.lastUpdate.set(uri, Date.now());
    if (version !== undefined) {
      this.versions.set(uri, version);
    }
  }

  /**
   * Get cached diagnostics for a URI, or undefined if none cached.
   */
  get(uri: string): Diagnostic[] | undefined {
    return this.diagnostics.get(uri);
  }

  /**
   * Store a server-provided `resultId` for a URI. Used by the batch
   * `workspace/diagnostic` and `textDocument/diagnostic` paths so that
   * subsequent calls can populate `previousResultIds` and let the server
   * answer with `kind: 'unchanged'` reports.
   */
  setResultId(uri: string, resultId: string): void {
    if (resultId) {
      this.resultIds.set(uri, resultId);
    } else {
      this.resultIds.delete(uri);
    }
  }

  /**
   * Retrieve the last known `resultId` for a URI, if any.
   */
  getResultId(uri: string): string | undefined {
    return this.resultIds.get(uri);
  }

  /**
   * Returns a snapshot of `(uri, value)` pairs for every URI that has a
   * cached `resultId`. Used to build the `previousResultIds` array for
   * `workspace/diagnostic` requests so the server can answer with
   * `kind: 'unchanged'` reports on subsequent calls.
   *
   * Order is undefined. The returned array is a fresh copy — mutating it
   * does not affect the cache.
   */
  listResultIds(): Array<{ uri: string; value: string }> {
    const out: Array<{ uri: string; value: string }> = [];
    for (const [uri, value] of this.resultIds) {
      out.push({ uri, value });
    }
    return out;
  }

  /**
   * Wait for diagnostics to stabilize (no updates for `idleTime` ms).
   * Used as fallback when textDocument/diagnostic is not supported.
   *
   * Optionally accepts an `AbortSignal`; when aborted (either on entry or
   * between polling iterations) the method returns immediately so callers
   * racing against an external deadline can short-circuit cleanly. Existing
   * call sites that omit `signal` see no behavior change.
   */
  async waitForIdle(
    uri: string,
    options: {
      maxWaitTime?: number;
      idleTime?: number;
      checkInterval?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<void> {
    const { maxWaitTime = 1000, idleTime = 100, checkInterval = 50, signal } = options;

    if (signal?.aborted) {
      logger.debug('[DEBUG waitForDiagnosticsIdle] Signal already aborted; returning early\n');
      return;
    }

    const startTime = Date.now();
    let lastVersion = this.versions.get(uri) ?? -1;
    let lastUpdateTime = this.lastUpdate.get(uri) ?? startTime;

    logger.debug(
      `[DEBUG waitForDiagnosticsIdle] Waiting for diagnostics to stabilize for ${uri}\n`
    );

    while (Date.now() - startTime < maxWaitTime) {
      if (signal?.aborted) {
        logger.debug('[DEBUG waitForDiagnosticsIdle] Aborted mid-wait\n');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
      if (signal?.aborted) {
        logger.debug('[DEBUG waitForDiagnosticsIdle] Aborted after poll tick\n');
        return;
      }

      const currentVersion = this.versions.get(uri) ?? -1;
      const currentUpdateTime = this.lastUpdate.get(uri) ?? lastUpdateTime;

      if (currentVersion !== lastVersion) {
        logger.debug(
          `[DEBUG waitForDiagnosticsIdle] Version changed from ${lastVersion} to ${currentVersion}\n`
        );
        lastVersion = currentVersion;
        lastUpdateTime = currentUpdateTime;
        continue;
      }

      const timeSinceLastUpdate = Date.now() - currentUpdateTime;
      if (timeSinceLastUpdate >= idleTime) {
        logger.debug(
          `[DEBUG waitForDiagnosticsIdle] Server appears idle after ${timeSinceLastUpdate}ms without updates\n`
        );
        return;
      }
    }

    logger.debug(`[DEBUG waitForDiagnosticsIdle] Max wait time reached (${maxWaitTime}ms)\n`);
  }
}
