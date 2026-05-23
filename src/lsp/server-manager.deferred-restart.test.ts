import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerManager } from './server-manager.js';
import type { LSPServerConfig, ServerState } from './types.js';

/** Write a file using Bun.write to avoid node:fs mock interference. */
async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

/** A trivial LSP mock that just answers `initialize`. */
const MOCK_SERVER = `
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  while (true) {
    const idx = buf.indexOf('\\r\\n\\r\\n');
    if (idx < 0) return;
    const header = buf.slice(0, idx);
    const m = header.match(/Content-Length: (\\d+)/);
    if (!m) { buf = buf.slice(idx + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = idx + 4;
    if (buf.length < start + len) return;
    const body = buf.slice(start, start + len);
    buf = buf.slice(start + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.method === 'initialize') {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { capabilities: { diagnosticProvider: true } },
      });
      const out = 'Content-Length: ' + Buffer.byteLength(response) + '\\r\\n\\r\\n' + response;
      process.stdout.write(out);
      const notif = JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} });
      const outN = 'Content-Length: ' + Buffer.byteLength(notif) + '\\r\\n\\r\\n' + notif;
      process.stdout.write(outN);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/** Cast helper to access the private restartServer method. */
interface RestartableManager {
  restartServer(serverState: ServerState): Promise<void>;
}

describe('ServerManager deferred restart', () => {
  let TEST_DIR: string;
  let manager: ServerManager;
  let scriptPath: string;

  beforeEach(async () => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-srvmgr-restart-'));
    scriptPath = join(TEST_DIR, 'mock-server.cjs');
    await writeFile(scriptPath, MOCK_SERVER);
    manager = new ServerManager();
  });

  afterEach(() => {
    manager.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function configFor(): LSPServerConfig {
    return {
      extensions: ['ts'],
      command: ['node', scriptPath],
      rootDir: TEST_DIR,
    };
  }

  it('defers the restart when inFlightBatchCount > 0', async () => {
    const config = configFor();
    const state = await manager.getServer(config);
    const originalPid = state.process.pid;
    expect(originalPid).toBeDefined();

    state.inFlightBatchCount = 1;

    await (manager as unknown as RestartableManager).restartServer(state);

    // Process should not have been killed; restart timer should be re-armed.
    expect(state.process.pid).toBe(originalPid as number);
    expect(state.process.killed).toBe(false);
    expect(state.restartTimer).toBeDefined();

    // Clean up the re-armed timer to avoid leaking it.
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = undefined;
    }
  });

  it('proceeds with restart when inFlightBatchCount = 0', async () => {
    const config = configFor();
    const state = await manager.getServer(config);
    const originalPid = state.process.pid;

    expect(state.inFlightBatchCount).toBe(0);

    await (manager as unknown as RestartableManager).restartServer(state);

    // The old process should be gone and a new one started in its place.
    // (The map now has a fresh ServerState; the original process has been killed.)
    const running = manager.getRunningServers();
    const key = JSON.stringify(config);
    const newState = running.get(key);
    expect(newState).toBeDefined();
    expect(newState).not.toBe(state);
    // The original process should have been signaled to exit.
    expect(state.process.killed).toBe(true);
    expect(originalPid).toBeDefined();
    expect(newState?.process.pid).not.toBe(originalPid);
  });

  it('decrement of inFlightBatchCount in finally still allows restart', async () => {
    const config = configFor();
    const state = await manager.getServer(config);

    // Simulate a batch that throws but cleans up the counter in finally.
    try {
      state.inFlightBatchCount = (state.inFlightBatchCount ?? 0) + 1;
      throw new Error('simulated bucket failure');
    } catch {
      // ignore
    } finally {
      state.inFlightBatchCount = (state.inFlightBatchCount ?? 0) - 1;
    }
    expect(state.inFlightBatchCount).toBe(0);

    // Now a restart should proceed.
    await (manager as unknown as RestartableManager).restartServer(state);

    expect(state.process.killed).toBe(true);
  });
});
