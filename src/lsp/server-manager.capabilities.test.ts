import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerManager } from './server-manager.js';
import type { LSPServerConfig } from './types.js';

/** Write a file using Bun.write to avoid node:fs mock interference. */
async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

/**
 * A tiny mock LSP server: reads Content-Length framed JSON-RPC messages from
 * stdin and writes a corresponding framed initialize response. Capabilities
 * returned in the response are controlled by `capsJson` (passed via argv).
 */
function makeMockServerScript(capsJson: string): string {
  return `
const caps = ${capsJson};
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
        result: caps === null
          ? null
          : { capabilities: caps },
      });
      const out = 'Content-Length: ' + Buffer.byteLength(response) + '\\r\\n\\r\\n' + response;
      process.stdout.write(out);
      // Also send 'initialized' notification back to mark startup complete.
      const notif = JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} });
      const outN = 'Content-Length: ' + Buffer.byteLength(notif) + '\\r\\n\\r\\n' + notif;
      process.stdout.write(outN);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
}

describe('ServerManager capabilities capture', () => {
  let TEST_DIR: string;
  let manager: ServerManager;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-srvmgr-caps-'));
    manager = new ServerManager();
  });

  afterEach(() => {
    manager.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function runWithCaps(capsJson: string): Promise<LSPServerConfig> {
    const scriptPath = join(TEST_DIR, 'mock-server.cjs');
    await writeFile(scriptPath, makeMockServerScript(capsJson));
    return {
      extensions: ['ts'],
      command: ['node', scriptPath],
      rootDir: TEST_DIR,
    };
  }

  it('captures diagnosticProvider boolean from initialize response', async () => {
    const config = await runWithCaps(JSON.stringify({ diagnosticProvider: true }));
    const state = await manager.getServer(config);

    expect(state.capabilities).toBeDefined();
    expect(state.capabilities?.diagnosticProvider).toBe(true);
  });

  it('captures full DiagnosticOptions object form', async () => {
    const config = await runWithCaps(
      JSON.stringify({
        diagnosticProvider: {
          identifier: 'mock',
          interFileDependencies: true,
          workspaceDiagnostics: true,
        },
      })
    );
    const state = await manager.getServer(config);

    expect(state.capabilities?.diagnosticProvider).toEqual({
      identifier: 'mock',
      interFileDependencies: true,
      workspaceDiagnostics: true,
    });
  });

  it('leaves capabilities undefined when initialize returns no capabilities key', async () => {
    // Server returns null result entirely.
    const config = await runWithCaps('null');
    const state = await manager.getServer(config);

    expect(state.capabilities).toBeUndefined();
  });

  it('leaves capabilities undefined when initialize returns an empty object (no capabilities key)', async () => {
    // Use a custom mock that returns `result: {}` rather than the
    // `{ capabilities: <caps> }` shape produced by makeMockServerScript.
    const scriptPath = join(TEST_DIR, 'empty-result.cjs');
    const script = `
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
      const response = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} });
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
    await writeFile(scriptPath, script);

    const config: LSPServerConfig = {
      extensions: ['ts'],
      command: ['node', scriptPath],
      rootDir: TEST_DIR,
    };
    const state = await manager.getServer(config);

    expect(state.capabilities).toBeUndefined();
  });

  it('inFlightBatchCount is initialized to 0', async () => {
    const config = await runWithCaps(JSON.stringify({ diagnosticProvider: true }));
    const state = await manager.getServer(config);

    expect(state.inFlightBatchCount).toBe(0);
  });
});

describe('ServerManager client capabilities in initialize params', () => {
  let TEST_DIR: string;
  let manager: ServerManager;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-srvmgr-clientcaps-'));
    manager = new ServerManager();
  });

  afterEach(() => {
    manager.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('initialize params include workspace.diagnostics and textDocument.diagnostic', async () => {
    // Capturing server: writes the initialize params back to a side-channel file.
    const sidePath = join(TEST_DIR, 'init-params.json');
    const scriptPath = join(TEST_DIR, 'capture.cjs');
    const script = `
const fs = require('fs');
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
      fs.writeFileSync(${JSON.stringify(sidePath)}, JSON.stringify(msg.params));
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
`;
    await writeFile(scriptPath, script);

    const config: LSPServerConfig = {
      extensions: ['ts'],
      command: ['node', scriptPath],
      rootDir: TEST_DIR,
    };

    await manager.getServer(config);

    // Wait for side-channel file to be written.
    let raw = '';
    for (let i = 0; i < 50 && raw.length === 0; i++) {
      try {
        raw = await Bun.file(sidePath).text();
      } catch {
        // File may not exist yet.
      }
      if (!raw) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const params = JSON.parse(raw) as {
      capabilities: {
        textDocument: {
          diagnostic?: { dynamicRegistration?: boolean; relatedDocumentSupport?: boolean };
        };
        workspace: { diagnostics?: { refreshSupport: boolean } };
      };
    };

    expect(params.capabilities.workspace.diagnostics).toEqual({ refreshSupport: false });
    expect(params.capabilities.textDocument.diagnostic).toEqual({
      dynamicRegistration: false,
      relatedDocumentSupport: false,
    });
  });
});
