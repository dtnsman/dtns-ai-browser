/**
 * WebSocket passthrough for tunnel-delivered upgrades.
 *
 * The tunnel server terminates the browser's WebSocket and relays frames as
 * DTNS WEBSOCKET_* messages. This class exposes those frames as a familiar
 * socket-like object (`send`, `close`, `on('message')`).
 */
'use strict';

const Protocol = require('../protocol/dtns-protocol');
const { Emitter, ProxyError } = require('../util/primitives');

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function textOf(bytes) {
  try { return decoder.decode(bytes || new Uint8Array(0)); }
  catch (error) { return ''; }
}

class WsConnection extends Emitter {
  /**
   * @param {object} hooks
   * @param {function(Uint8Array): boolean} hooks.send  raw frame writer
   * @param {function(string): void} hooks.release      drop from the registry
   */
  constructor(message, req, protocol, hooks) {
    super();
    this.message = message;
    this.req = req;
    this.hooks = hooks || {};
    this.wsRequestId = message.wsRequestId;
    this.readyState = 1;
    this.open = true;
    this.remoteAddress = req ? req.remoteAddress : '';
    this.path = req ? req.path : '';
    this.protocol = protocol || '';
    this.url = req ? 'ws://' + (req.domain || '') + req.url : '';
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this._closed = false;
  }

  send(data, options) {
    if (this._closed || this.readyState !== 1) return false;

    let binary;
    let bytes;
    if (typeof data === 'string') {
      bytes = encoder.encode(data);
      binary = false;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
      binary = true;
    } else if (data instanceof Uint8Array) {
      bytes = data;
      binary = true;
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      binary = true;
    } else if (data === undefined || data === null) {
      bytes = new Uint8Array(0);
      binary = false;
    } else {
      bytes = encoder.encode(String(data));
      binary = false;
    }

    if (typeof options === 'boolean') binary = options;
    else if (options && typeof options.binary === 'boolean') binary = options.binary;

    const frame = Protocol.encodeWebSocketData({
      wsRequestId: this.wsRequestId,
      data: bytes,
      binary: binary,
      timestamp: new Date().toISOString()
    });
    const sent = this.hooks.send ? this.hooks.send(frame) : false;
    if (sent) this.bytesSent += bytes.length;
    return sent;
  }

  sendText(text) { return this.send(text); }
  sendBinary(data) { return this.send(data, true); }

  close(code, reason) {
    if (this._closed) return;
    this.readyState = 2;
    let closeCode = code === undefined ? 1000 : Number(code);
    if (!isFinite(closeCode)) closeCode = 1000;
    this._finish(closeCode, reason || '', true);
  }

  terminate() {
    this.close(1000, 'terminated');
  }

  _handleMessage(message) {
    if (this._closed) return;
    const data = message.data || new Uint8Array(0);
    this.bytesReceived += data.length;
    const isBinary = !!message.isBinary;
    this.emit('message', isBinary ? data : textOf(data), isBinary);
  }

  _onServerClose(message) {
    let code = Number(message.code);
    if (!code || code < 1000) code = 1000;
    this._finish(code, message.reason || '', false);
  }

  _onServerEnd() {
    this._finish(1000, 'ended', false);
  }

  _onServerError(message) {
    this.emit('error', new ProxyError(
      (message && message.error) || 'websocket error',
      { code: 'WS_PEER_ERROR' }
    ));
    this._finish(1011, (message && message.error) || 'websocket error', false);
  }

  _finish(code, reason, sendClose) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3;
    this.open = false;

    let closeCode = code === undefined ? 1000 : Number(code);
    if (!isFinite(closeCode)) closeCode = 1000;

    if (sendClose && this.hooks.send) {
      // The tunnel protocol carries the close code in a single byte; the server
      // maps 0 back to the normal-closure 1000.
      const protocolCode = closeCode === 1000 ? 0 : (closeCode & 0xff);
      this.hooks.send(Protocol.encodeWebSocketClose({
        wsRequestId: this.wsRequestId,
        code: protocolCode,
        reason: reason || '',
        timestamp: new Date().toISOString()
      }));
    }

    if (this.hooks.release) this.hooks.release(this.wsRequestId);
    this.emit('close', closeCode, reason || '');
  }

  _fail(error) {
    this.emit('error', error);
    this.close(1011, (error && error.message) || 'websocket handler error');
  }
}

WsConnection.OPEN = 1;
WsConnection.CLOSING = 2;
WsConnection.CLOSED = 3;

module.exports = WsConnection;
