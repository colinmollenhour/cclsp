import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonRpcTransport } from './json-rpc.js';
import type { LSPMessage } from './types.js';

/**
 * Create a mock ChildProcess with emittable stdout and writable stdin.
 */
function createMockProcess() {
  const stdout = new EventEmitter();
  const stdinData: string[] = [];
  const stdin = {
    write: jest.fn((data: string) => {
      stdinData.push(data);
      return true;
    }),
  };

  const proc = {
    stdout,
    stdin,
    stderr: new EventEmitter(),
  } as unknown as ChildProcess;

  return {
    process: proc,
    stdout,
    stdin,
    stdinData,
    /** Simulate the server sending a Content-Length framed message */
    simulateResponse(message: LSPMessage) {
      const content = JSON.stringify(message);
      const frame = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
      stdout.emit('data', Buffer.from(frame));
    },
  };
}

describe('JsonRpcTransport', () => {
  let mock: ReturnType<typeof createMockProcess>;
  let messageHandler: ReturnType<typeof jest.fn>;
  let transport: JsonRpcTransport;

  beforeEach(() => {
    mock = createMockProcess();
    messageHandler = jest.fn();
    transport = new JsonRpcTransport(mock.process, messageHandler);
  });

  describe('sendMessage', () => {
    it('writes Content-Length framed JSON to stdin', () => {
      const message: LSPMessage = {
        jsonrpc: '2.0',
        method: 'test',
        params: {},
      };
      transport.sendMessage(message);

      expect(mock.stdin.write).toHaveBeenCalledTimes(1);
      const written = mock.stdinData[0] as string;
      expect(written).toContain('Content-Length:');
      expect(written).toContain('"jsonrpc":"2.0"');
      expect(written).toContain('"method":"test"');
    });

    it('calculates Content-Length correctly for multi-byte characters', () => {
      const message: LSPMessage = {
        jsonrpc: '2.0',
        method: 'test',
        params: { text: '\u00e9' },
      };
      transport.sendMessage(message);

      const written = mock.stdinData[0] as string;
      const content = JSON.stringify(message);
      const expectedLength = Buffer.byteLength(content);
      expect(written).toContain(`Content-Length: ${expectedLength}`);
    });
  });

  describe('sendNotification', () => {
    it('sends JSON-RPC notification without id', () => {
      transport.sendNotification('textDocument/didOpen', {
        uri: 'file:///a.ts',
      });

      const written = mock.stdinData[0] as string;
      expect(written).toContain('"jsonrpc":"2.0"');
      expect(written).toContain('"method":"textDocument/didOpen"');
      expect(written).not.toContain('"id"');
    });
  });

  describe('sendRequest and response correlation', () => {
    it('resolves promise when matching response arrives', async () => {
      const promise = transport.sendRequest('textDocument/definition', {
        uri: 'file:///a.ts',
      });

      // Parse the sent message to get the ID
      const written = mock.stdinData[0] as string;
      const contentStart = written.indexOf('{');
      const sent = JSON.parse(written.substring(contentStart)) as LSPMessage;

      // Simulate server response with matching ID
      mock.simulateResponse({
        jsonrpc: '2.0',
        id: sent.id,
        result: [{ uri: 'file:///b.ts', range: {} }],
      });

      const result = await promise;
      expect(result).toEqual([{ uri: 'file:///b.ts', range: {} }]);
    });

    it('rejects promise when error response arrives', async () => {
      const promise = transport.sendRequest('textDocument/definition', {});

      const written = mock.stdinData[0] as string;
      const contentStart = written.indexOf('{');
      const sent = JSON.parse(written.substring(contentStart)) as LSPMessage;

      mock.simulateResponse({
        jsonrpc: '2.0',
        id: sent.id,
        error: { code: -32600, message: 'Invalid Request' },
      });

      expect(promise).rejects.toThrow('Invalid Request');
    });

    it('rejects promise on timeout', async () => {
      const promise = transport.sendRequest('slow/method', {}, 50);

      expect(promise).rejects.toThrow('LSP request timeout: slow/method (50ms)');
    });

    it('assigns unique IDs to each request', () => {
      transport.sendRequest('method1', {});
      transport.sendRequest('method2', {});

      const raw1 = mock.stdinData[0] as string;
      const raw2 = mock.stdinData[1] as string;
      const msg1 = JSON.parse(raw1.substring(raw1.indexOf('{')));
      const msg2 = JSON.parse(raw2.substring(raw2.indexOf('{')));

      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  describe('incoming message handling', () => {
    it('delegates notifications to message handler', () => {
      mock.simulateResponse({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///a.ts', diagnostics: [] },
      });

      expect(messageHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'textDocument/publishDiagnostics',
        })
      );
    });

    it('handles split messages across multiple data events', () => {
      const message: LSPMessage = {
        jsonrpc: '2.0',
        method: 'notification',
        params: {},
      };
      const content = JSON.stringify(message);
      const frame = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;

      // Split the frame into two parts
      const mid = Math.floor(frame.length / 2);
      mock.stdout.emit('data', Buffer.from(frame.substring(0, mid)));
      mock.stdout.emit('data', Buffer.from(frame.substring(mid)));

      expect(messageHandler).toHaveBeenCalledTimes(1);
    });

    it('handles multiple messages in a single data event', () => {
      const msg1: LSPMessage = { jsonrpc: '2.0', method: 'notif1', params: {} };
      const msg2: LSPMessage = { jsonrpc: '2.0', method: 'notif2', params: {} };
      const content1 = JSON.stringify(msg1);
      const content2 = JSON.stringify(msg2);
      const frame =
        `Content-Length: ${Buffer.byteLength(content1)}\r\n\r\n${content1}` +
        `Content-Length: ${Buffer.byteLength(content2)}\r\n\r\n${content2}`;

      mock.stdout.emit('data', Buffer.from(frame));

      expect(messageHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleIncoming dispatch (id=0 + id+method routing)', () => {
    // The transport's auto-incrementing id starts at 1, but the response
    // correlation branch must match by `id !== undefined && !method` so that
    // an id of 0 still routes to a pending request (regressions of the prior
    // `if (message.id && ...)` truthiness check). We seed the pending map
    // directly to control the id under test.
    it('routes id:0 response to pending request', async () => {
      const pending = (
        transport as unknown as {
          pendingRequests: Map<
            number,
            { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
          >;
        }
      ).pendingRequests;

      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(0, { resolve, reject });
      });

      mock.simulateResponse({
        jsonrpc: '2.0',
        id: 0,
        result: { ok: true },
      });

      const result = await promise;
      expect(result).toEqual({ ok: true });
      // Pending entry consumed.
      expect(pending.has(0)).toBe(false);
      // Server-initiated request path NOT taken.
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('treats id+method as server-initiated request, not a response', () => {
      const pending = (
        transport as unknown as {
          pendingRequests: Map<
            number,
            { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
          >;
        }
      ).pendingRequests;

      let resolved = false;
      let rejected = false;
      pending.set(42, {
        resolve: () => {
          resolved = true;
        },
        reject: () => {
          rejected = true;
        },
      });

      // Server-initiated request: has both id and method. Must NOT consume the
      // pending entry under id=42, must flow to the onMessage handler.
      mock.simulateResponse({
        jsonrpc: '2.0',
        id: 42,
        method: 'tsserver/request',
        params: { foo: 'bar' },
      });

      expect(resolved).toBe(false);
      expect(rejected).toBe(false);
      expect(pending.has(42)).toBe(true);
      expect(messageHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 42, method: 'tsserver/request' })
      );
    });
  });

  describe('rejectAllPending', () => {
    it('rejects all outstanding requests', async () => {
      const p1 = transport.sendRequest('method1', {}, 5000);
      const p2 = transport.sendRequest('method2', {}, 5000);

      transport.rejectAllPending('Server crashed');

      expect(p1).rejects.toThrow('Server crashed');
      expect(p2).rejects.toThrow('Server crashed');
    });

    it('does nothing when no requests are pending', () => {
      // Should not throw
      transport.rejectAllPending('No-op');
    });
  });
});
