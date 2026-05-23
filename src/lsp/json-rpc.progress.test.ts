import { beforeEach, describe, expect, it, jest } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonRpcTransport } from './json-rpc.js';
import type { LSPMessage } from './types.js';

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

describe('JsonRpcTransport progress handling', () => {
  let mock: ReturnType<typeof createMockProcess>;
  let messageHandler: ReturnType<typeof jest.fn>;
  let transport: JsonRpcTransport;

  beforeEach(() => {
    mock = createMockProcess();
    messageHandler = jest.fn();
    transport = new JsonRpcTransport(mock.process, messageHandler);
  });

  it('routes $/progress notifications to the registered handler by token', () => {
    const handler = jest.fn();
    transport.registerProgressHandler('token-1', handler);

    mock.simulateResponse({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'token-1', value: { items: ['a', 'b'] } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ items: ['a', 'b'] });
    // Progress notifications should NOT bubble to onMessage.
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('drops $/progress notifications with unknown tokens at debug level', () => {
    // No handler registered for 'mystery'.
    expect(() => {
      mock.simulateResponse({
        jsonrpc: '2.0',
        method: '$/progress',
        params: { token: 'mystery', value: 'whatever' },
      });
    }).not.toThrow();

    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('accumulates multiple progress notifications in order', () => {
    const received: unknown[] = [];
    transport.registerProgressHandler('batch', (value) => {
      received.push(value);
    });

    mock.simulateResponse({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'batch', value: { items: ['x'] } },
    });
    mock.simulateResponse({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'batch', value: { items: ['y'] } },
    });
    mock.simulateResponse({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'batch', value: { items: ['z'] } },
    });

    expect(received).toEqual([{ items: ['x'] }, { items: ['y'] }, { items: ['z'] }]);
  });

  it('supports numeric tokens', () => {
    const handler = jest.fn();
    transport.registerProgressHandler(7, handler);

    mock.simulateResponse({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 7, value: 'hello' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('hello');
  });

  it('unregisterProgressHandler removes the handler', () => {
    const handler = jest.fn();
    transport.registerProgressHandler('t', handler);
    transport.unregisterProgressHandler('t');

    mock.simulateResponse({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 't', value: {} },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('replaces the prior handler when re-registered with the same token', () => {
    const first = jest.fn();
    const second = jest.fn();
    transport.registerProgressHandler('t', first);
    transport.registerProgressHandler('t', second);

    mock.simulateResponse({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 't', value: { items: [] } },
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ignores $/progress notifications missing a token', () => {
    expect(() => {
      mock.simulateResponse({
        jsonrpc: '2.0',
        method: '$/progress',
        params: { value: 'no token' },
      });
    }).not.toThrow();

    expect(messageHandler).not.toHaveBeenCalled();
  });
});
