import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import { JsonRpcTransport, RequestCancelledError } from './json-rpc.js';
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
    simulateResponse(message: LSPMessage) {
      const content = JSON.stringify(message);
      const frame = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
      stdout.emit('data', Buffer.from(frame));
    },
  };
}

/** Extract the parsed JSON payload from a `stdinData[i]` string. */
function parseFramed(written: string): LSPMessage {
  const contentStart = written.indexOf('{');
  return JSON.parse(written.substring(contentStart)) as LSPMessage;
}

type DebugSpy = ReturnType<typeof spyOn<typeof logger, 'debug'>>;

describe('JsonRpcTransport.cancelRequest', () => {
  let mock: ReturnType<typeof createMockProcess>;
  let messageHandler: ReturnType<typeof jest.fn>;
  let transport: JsonRpcTransport;
  let debugSpy: DebugSpy | undefined;

  beforeEach(() => {
    mock = createMockProcess();
    messageHandler = jest.fn();
    transport = new JsonRpcTransport(mock.process, messageHandler);
  });

  afterEach(() => {
    debugSpy?.mockRestore();
    debugSpy = undefined;
  });

  it('sends $/cancelRequest framed notification with the request id', async () => {
    const promise = transport.sendRequest('textDocument/diagnostic', { uri: 'file:///a.ts' }, 5000);
    promise.catch(() => {
      // Rejection is expected due to cancel.
    });

    const sent = parseFramed(mock.stdinData[0] as string);
    expect(typeof sent.id).toBe('number');
    const requestId = sent.id as number;

    transport.cancelRequest(requestId);

    // Second framed message should be the $/cancelRequest notification.
    expect(mock.stdinData.length).toBe(2);
    const cancel = parseFramed(mock.stdinData[1] as string);
    expect(cancel.method).toBe('$/cancelRequest');
    expect(cancel.params).toEqual({ id: requestId });
    // Notifications have no `id` field.
    expect(cancel.id).toBeUndefined();

    // Ensure the pending promise rejects so it doesn't dangle.
    await expect(promise).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it('rejects the pending promise immediately with RequestCancelledError', async () => {
    const promise = transport.sendRequest('textDocument/diagnostic', {}, 5000);

    const sent = parseFramed(mock.stdinData[0] as string);
    transport.cancelRequest(sent.id as number);

    await expect(promise).rejects.toBeInstanceOf(RequestCancelledError);
    await expect(promise).rejects.toThrow(/cancelled/);
  });

  it('drops late server responses for already-cancelled ids', async () => {
    // Spy on logger.debug so we can prove the drop path actually fired,
    // not just that nothing threw. Restored in afterEach.
    debugSpy = spyOn(logger, 'debug').mockImplementation(() => {});

    const promise = transport.sendRequest('textDocument/diagnostic', {}, 5000);

    const sent = parseFramed(mock.stdinData[0] as string);
    const requestId = sent.id as number;

    transport.cancelRequest(requestId);
    await expect(promise).rejects.toBeInstanceOf(RequestCancelledError);

    // Simulate a late server response for the cancelled id; should NOT throw.
    expect(() => {
      mock.simulateResponse({
        jsonrpc: '2.0',
        id: requestId,
        result: { items: [] },
      });
    }).not.toThrow();

    // messageHandler is for notifications/requests — responses go nowhere.
    expect(messageHandler).not.toHaveBeenCalled();

    // The drop path must have emitted a debug line. Match any of the
    // synonymous markers the implementation may use.
    const debugMessages = debugSpy.mock.calls
      .map((args: unknown[]) => (typeof args[0] === 'string' ? args[0] : ''))
      .join('\n');
    expect(debugMessages).toMatch(/late response|dropped|cancelled/i);
  });

  it('is a no-op (race guard) when called for an unknown id', () => {
    const initialWrites = mock.stdinData.length;
    // Should not send any notification and should not throw.
    expect(() => transport.cancelRequest(9999)).not.toThrow();
    expect(mock.stdinData.length).toBe(initialWrites);
  });

  it('is a no-op when the response already settled the promise', async () => {
    const promise = transport.sendRequest('textDocument/diagnostic', {}, 5000);
    const sent = parseFramed(mock.stdinData[0] as string);
    const requestId = sent.id as number;

    // Settle normally.
    mock.simulateResponse({
      jsonrpc: '2.0',
      id: requestId,
      result: { ok: true },
    });
    await promise;

    const before = mock.stdinData.length;
    transport.cancelRequest(requestId);
    // No additional $/cancelRequest should be sent.
    expect(mock.stdinData.length).toBe(before);
  });
});

describe('RequestCancelledError', () => {
  it('exposes the request id in the message and uses the right name', () => {
    const err = new RequestCancelledError(42);
    expect(err.name).toBe('RequestCancelledError');
    expect(err.message).toContain('42');
    expect(err).toBeInstanceOf(Error);
  });
});
