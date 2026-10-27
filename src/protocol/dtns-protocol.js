/**
 * DTNS binary protocol codec.
 *
 * This is a faithful port of the codec embedded in `assets/sdk.js`
 * (dtns.http-proxy-site), promoted to a standalone module so that the browser
 * agent shares exactly one wire format with the SDK and the tunnel server.
 *
 * Wire format (13-byte header + payload):
 *
 *   offset  size  field
 *   0       4     magic  "DTNS"
 *   4       1     version (1 = status as u8, 2 = status as u16)
 *   5       2     type code (big endian)
 *   7       2     flags (big endian)
 *   9       4     payload length (big endian)
 *   13      N     payload
 *
 * All multi-byte integers are big endian (DataView default). Strings are a
 * u16 length prefix followed by UTF-8 bytes; buffers are a u32 length prefix.
 */
'use strict';

const MAGIC = [0x44, 0x54, 0x4e, 0x53]; // "DTNS"
const VERSION = 1;
const VERSION_2 = 2;
const HEADER_LENGTH = 13;

/** Guards against a corrupt length prefix allocating gigabytes. */
const DEFAULT_MAX_FRAME_SIZE = 32 * 1024 * 1024;

const TYPE = {
  // client -> server
  REGISTER_TUNNEL: 0x0001,
  UNREGISTER_TUNNEL: 0x0002,
  HEARTBEAT: 0x0003,
  HTTP_RESPONSE: 0x0004,
  TUNNEL_LIST: 0x0005,
  COMMAND_RESPONSE: 0x0006,
  STATS: 0x0007,
  SSE_DATA: 0x0008,
  SSE_END: 0x0009,
  SSE_ERROR: 0x000a,
  SSE_CLOSE: 0x000b,
  WEBSOCKET_UPGRADED: 0x000c,
  WEBSOCKET_DATA: 0x000d,
  WEBSOCKET_END: 0x000e,
  WEBSOCKET_ERROR: 0x000f,
  WEBSOCKET_CLOSE: 0x0010,
  SSE_CONNECTIONS: 0x0011,
  ERROR: 0x0012,
  STREAM_OPEN: 0x0020,
  STREAM_CHUNK: 0x0021,
  STREAM_END: 0x0022,
  STREAM_ACK: 0x0023,
  STREAM_CANCEL: 0x0024,
  CAPABILITIES: 0x0025,
  // server -> client
  WELCOME: 0x0101,
  REGISTERED: 0x0102,
  UNREGISTERED: 0x0103,
  HEARTBEAT_ACK: 0x0104,
  HTTP_REQUEST: 0x0105,
  TUNNEL_STATUS: 0x0106,
  COMMAND: 0x0107,
  WEBSOCKET_DATA_FROM_SERVER: 0x0108,
  WEBSOCKET_CLOSE_FROM_SERVER: 0x0109,
  SSE_DATA_FROM_SERVER: 0x010a,
  SSE_END_FROM_SERVER: 0x010b,
  SSE_ERROR_FROM_SERVER: 0x010c,
  SSE_CLOSE_FROM_SERVER: 0x010d
};

const TYPE_NAME = {};
Object.keys(TYPE).forEach((name) => {
  TYPE_NAME[TYPE[name]] = name.toLowerCase();
});

const FLAGS = {
  HAS_BODY: 0x0001,
  HAS_HEADERS: 0x0002,
  IS_SSE: 0x0004,
  IS_WEBSOCKET: 0x0008,
  GZIPPED: 0x0010,
  IS_BINARY: 0x0020
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function utf8(text) {
  return encoder.encode(text == null ? '' : String(text));
}

function toBytes(input) {
  if (input == null) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return utf8(input);
}

function concat(parts) {
  let length = 0;
  for (let i = 0; i < parts.length; i++) length += parts[i].length;
  const output = new Uint8Array(length);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    output.set(parts[i], offset);
    offset += parts[i].length;
  }
  return output;
}

function u8(value) {
  return new Uint8Array([value & 0xff]);
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value & 0xffff);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function encodeString(value) {
  const bytes = utf8(value);
  // A u16 length prefix cannot describe more than 65535 bytes.
  if (bytes.length > 0xffff) {
    throw new Error('DTNS string too long: ' + bytes.length + ' bytes');
  }
  return concat([u16(bytes.length), bytes]);
}

function encodeBuffer(value) {
  const bytes = toBytes(value);
  return concat([u32(bytes.length), bytes]);
}

function encodeHeaders(headers, multiValue) {
  headers = headers || {};
  const keys = Object.keys(headers).filter((key) => {
    return headers[key] !== undefined && headers[key] !== null;
  });

  const parts = [u16(keys.length)];
  keys.forEach((key) => {
    const value = headers[key];
    const text = Array.isArray(value)
      ? value.map(String).join(multiValue ? '\n' : ',')
      : String(value);
    parts.push(encodeString(key));
    parts.push(encodeString(text));
  });
  return concat(parts);
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  _need(n) {
    if (this.offset + n > this.bytes.length) {
      throw new Error(
        'DTNS payload underflow: need ' + n + ' bytes at offset ' + this.offset +
        ', have ' + this.bytes.length
      );
    }
  }

  u8() {
    this._need(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16() {
    this._need(2);
    const value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  }

  u32() {
    this._need(4);
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  str() {
    const length = this.u16();
    this._need(length);
    const value = decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  buf() {
    const length = this.u32();
    this._need(length);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  headers() {
    const count = this.u16();
    const output = {};
    for (let i = 0; i < count; i++) {
      const key = this.str();
      const value = this.str();
      output[key] = value.indexOf('\n') >= 0 ? value.split('\n') : value;
    }
    return output;
  }

  remaining() {
    return this.bytes.length - this.offset;
  }
}

function encodeFrame(typeName, payload, version, flags) {
  const typeCode = TYPE[String(typeName).toUpperCase()];
  if (typeCode === undefined) throw new Error('Unknown DTNS frame type: ' + typeName);

  const body = toBytes(payload);
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(MAGIC, 0);
  header[4] = version === VERSION_2 ? VERSION_2 : VERSION;
  const view = new DataView(header.buffer);
  view.setUint16(5, typeCode);
  view.setUint16(7, flags || 0);
  view.setUint32(9, body.length);
  return concat([header, body]);
}

function decodeFrame(input, options) {
  const maxFrameSize = (options && options.maxFrameSize) || DEFAULT_MAX_FRAME_SIZE;
  const bytes = toBytes(input);
  if (bytes.length < HEADER_LENGTH) throw new Error('DTNS frame too short: ' + bytes.length);

  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('Invalid DTNS magic');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[4];
  const typeCode = view.getUint16(5);
  const flags = view.getUint16(7);
  const length = view.getUint32(9);

  if (length > maxFrameSize) {
    throw new Error('DTNS frame too large: ' + length + ' > ' + maxFrameSize);
  }
  if (bytes.length < HEADER_LENGTH + length) {
    throw new Error('DTNS frame truncated: need ' + (HEADER_LENGTH + length) + ', got ' + bytes.length);
  }

  return {
    version: version,
    typeCode: typeCode,
    type: TYPE_NAME[typeCode] || 'unknown_0x' + typeCode.toString(16),
    flags: flags,
    payload: bytes.slice(HEADER_LENGTH, HEADER_LENGTH + length),
    byteLength: bytes.length
  };
}

/* ==================== client -> server encoders ==================== */

function encodeRegisterTunnel(fields) {
  const tunnel = fields.tunnel || fields;
  const payload = concat([
    encodeString(fields.clientId || ''),
    encodeString(tunnel.id || ''),
    encodeString(tunnel.domain || ''),
    u8((tunnel.localPort || 80) & 0xff),
    encodeString(tunnel.localHost || '127.0.0.1'),
    encodeString(tunnel.protocol || 'http'),
    encodeString(tunnel.description || '')
  ]);
  return encodeFrame('register_tunnel', payload, VERSION, 0);
}

function encodeUnregisterTunnel(fields) {
  const payload = concat([
    encodeString(fields.clientId || ''),
    encodeString(fields.domain || '')
  ]);
  return encodeFrame('unregister_tunnel', payload, VERSION, 0);
}

function encodeCapabilities(fields) {
  let flags = 0;
  if (fields.stream) flags |= 0x01;
  if (fields.multiValueHeaders) flags |= 0x02;
  const payload = concat([encodeString(fields.clientId || ''), u8(flags)]);
  return encodeFrame('capabilities', payload, VERSION, 0);
}

function encodeHeartbeat(fields) {
  const stats = fields.stats || {};
  const payload = concat([
    encodeString(fields.clientId || ''),
    encodeString(fields.timestamp || new Date().toISOString()),
    u32(stats.tunnelCount || 0),
    u32(stats.registeredCount || 0),
    u32(stats.sseConnections || 0),
    u32(stats.totalRequests || 0),
    u32(stats.totalErrors || 0)
  ]);
  return encodeFrame('heartbeat', payload, VERSION, 0);
}

function encodeHttpResponse(fields, version) {
  const v = version >= VERSION_2 ? VERSION_2 : VERSION;
  let status = Number(fields.status);
  if (!(status >= 100 && status <= 599)) status = 200;

  const body = toBytes(fields.body);
  const headers = fields.headers || {};
  let payloadFlags = 0;
  if (fields.isSSE) payloadFlags |= 0x01;
  if (fields.isWebSocket) payloadFlags |= 0x02;
  if (fields.error) payloadFlags |= 0x04;

  const payload = concat([
    encodeString(fields.requestId || ''),
    encodeString(fields.domain || ''),
    v >= VERSION_2 ? u16(status) : u8(status % 0x100),
    encodeHeaders(headers, true),
    encodeBuffer(body),
    u8(payloadFlags),
    encodeString(fields.sseRequestId || ''),
    encodeString(fields.wsRequestId || ''),
    encodeString(fields.error || '')
  ]);

  let frameFlags = 0;
  if (body.length) frameFlags |= FLAGS.HAS_BODY;
  if (Object.keys(headers).length) frameFlags |= FLAGS.HAS_HEADERS;
  if (fields.isSSE) frameFlags |= FLAGS.IS_SSE;
  if (fields.isWebSocket) frameFlags |= FLAGS.IS_WEBSOCKET;

  return encodeFrame('http_response', payload, v, frameFlags);
}

function encodeWebSocketData(fields) {
  const data = toBytes(fields.data);
  const payload = concat([
    encodeString(fields.wsRequestId || ''),
    encodeBuffer(data),
    encodeString(fields.timestamp || new Date().toISOString())
  ]);
  const flags = fields.binary ? FLAGS.IS_BINARY : 0;
  return encodeFrame('websocket_data', payload, VERSION, flags);
}

function encodeWebSocketClose(fields) {
  let code = fields.code === undefined ? 1000 : Number(fields.code);
  if (!isFinite(code)) code = 1000;
  const payload = concat([
    encodeString(fields.wsRequestId || ''),
    u8(code & 0xff),
    encodeString(fields.reason || ''),
    encodeString(fields.timestamp || new Date().toISOString())
  ]);
  return encodeFrame('websocket_close', payload, VERSION, 0);
}

/* ==================== server -> client decoders ==================== */

function decodeWelcome(payload) {
  const reader = new Reader(payload);
  const clientId = reader.str();
  const timestamp = reader.str();
  const message = reader.str();
  const protocolVersion = reader.remaining() > 0 ? reader.u8() : VERSION;
  return {
    type: 'welcome',
    clientId: clientId,
    timestamp: timestamp,
    message: message,
    protocolVersion: protocolVersion
  };
}

function decodeRegistered(payload) {
  const reader = new Reader(payload);
  const domain = reader.str();
  const success = reader.u8() === 1;
  const error = reader.str();
  const message = reader.str();
  return {
    type: 'registered',
    domain: domain,
    success: success,
    error: error || null,
    message: message
  };
}

function decodeHttpRequest(payload) {
  const reader = new Reader(payload);
  const requestId = reader.str();
  const domain = reader.str();
  const method = reader.str();
  const url = reader.str();
  const headers = reader.headers();
  const body = reader.buf();
  const remoteAddress = reader.str();
  const timestamp = reader.str();
  const flags = reader.u8();
  // Older servers may stop after the flags byte; the remaining fields are
  // optional so that we stay compatible with both.
  const sseRequestId = reader.remaining() > 0 ? reader.str() : '';
  const wsRequestId = reader.remaining() > 0 ? reader.str() : '';

  return {
    type: 'http_request',
    requestId: requestId,
    domain: domain,
    method: method,
    url: url,
    headers: headers,
    body: body,
    remoteAddress: remoteAddress,
    timestamp: timestamp,
    isSSE: !!(flags & 0x01),
    isWebSocket: !!(flags & 0x02),
    sseRequestId: sseRequestId || null,
    wsRequestId: wsRequestId || null
  };
}

function decodeWebSocketData(payload, flags) {
  const reader = new Reader(payload);
  const wsRequestId = reader.str();
  const data = reader.buf();
  const timestamp = reader.str();
  return {
    type: 'websocket_data',
    wsRequestId: wsRequestId,
    data: data,
    isBinary: !!(flags & FLAGS.IS_BINARY),
    timestamp: timestamp
  };
}

function decodeWebSocketClose(payload) {
  const reader = new Reader(payload);
  const wsRequestId = reader.str();
  const code = reader.u8();
  const reason = reader.str();
  const timestamp = reader.str();
  return {
    type: 'websocket_close',
    wsRequestId: wsRequestId,
    code: code,
    reason: reason,
    timestamp: timestamp
  };
}

function decodeMessage(frame) {
  switch (frame.type) {
    case 'welcome':
      return decodeWelcome(frame.payload);
    case 'registered':
      return decodeRegistered(frame.payload);
    case 'http_request':
      return decodeHttpRequest(frame.payload);
    case 'http_response':
      return decodeHttpResponse(frame.payload, frame.version);
    case 'register_tunnel':
      return decodeRegisterTunnel(frame.payload);
    case 'unregister_tunnel':
      return decodeUnregisterTunnel(frame.payload);
    case 'capabilities':
      return decodeCapabilities(frame.payload);
    case 'heartbeat':
      return decodeHeartbeat(frame.payload);
    case 'heartbeat_ack':
      return { type: 'heartbeat_ack' };
    case 'websocket_data':
    case 'websocket_data_from_server':
      return decodeWebSocketData(frame.payload, frame.flags);
    case 'websocket_close':
    case 'websocket_close_from_server':
      return decodeWebSocketClose(frame.payload);
    default:
      return { type: frame.type, payload: frame.payload };
  }
}

/* ==================== server -> client encoders ==================== */

/**
 * The codec is symmetric by design: the same module encodes and decodes both
 * directions, which is what makes a hermetic in-process tunnel server (and its
 * tests) possible without a second protocol implementation.
 */

function encodeWelcome(fields) {
  const payload = concat([
    encodeString(fields.clientId || ''),
    encodeString(fields.timestamp || new Date().toISOString()),
    encodeString(fields.message || 'DTNS tunnel ready'),
    u8(fields.protocolVersion === VERSION_2 ? VERSION_2 : VERSION)
  ]);
  return encodeFrame('welcome', payload, VERSION, 0);
}

function encodeRegistered(fields) {
  const payload = concat([
    encodeString(fields.domain || ''),
    u8(fields.success === false ? 0 : 1),
    encodeString(fields.error || ''),
    encodeString(fields.message || '')
  ]);
  return encodeFrame('registered', payload, VERSION, 0);
}

function encodeHeartbeatAck() {
  return encodeFrame('heartbeat_ack', new Uint8Array(0), VERSION, 0);
}

function encodeHttpRequest(fields) {
  const body = toBytes(fields.body);
  const headers = fields.headers || {};
  let payloadFlags = 0;
  if (fields.isSSE) payloadFlags |= 0x01;
  if (fields.isWebSocket) payloadFlags |= 0x02;

  const payload = concat([
    encodeString(fields.requestId || ''),
    encodeString(fields.domain || ''),
    encodeString(fields.method || 'GET'),
    encodeString(fields.url || '/'),
    encodeHeaders(headers, true),
    encodeBuffer(body),
    encodeString(fields.remoteAddress || ''),
    encodeString(fields.timestamp || new Date().toISOString()),
    u8(payloadFlags),
    encodeString(fields.sseRequestId || ''),
    encodeString(fields.wsRequestId || '')
  ]);

  let frameFlags = 0;
  if (body.length) frameFlags |= FLAGS.HAS_BODY;
  if (Object.keys(headers).length) frameFlags |= FLAGS.HAS_HEADERS;
  if (fields.isSSE) frameFlags |= FLAGS.IS_SSE;
  if (fields.isWebSocket) frameFlags |= FLAGS.IS_WEBSOCKET;

  return encodeFrame('http_request', payload, VERSION, frameFlags);
}

function encodeServerWebSocketData(fields) {
  const data = toBytes(fields.data);
  const payload = concat([
    encodeString(fields.wsRequestId || ''),
    encodeBuffer(data),
    encodeString(fields.timestamp || new Date().toISOString())
  ]);
  const flags = fields.binary ? FLAGS.IS_BINARY : 0;
  return encodeFrame('websocket_data_from_server', payload, VERSION, flags);
}

function encodeServerWebSocketClose(fields) {
  let code = fields.code === undefined ? 1000 : Number(fields.code);
  if (!isFinite(code)) code = 1000;
  const payload = concat([
    encodeString(fields.wsRequestId || ''),
    u8(code & 0xff),
    encodeString(fields.reason || ''),
    encodeString(fields.timestamp || new Date().toISOString())
  ]);
  return encodeFrame('websocket_close_from_server', payload, VERSION, 0);
}

/* ==================== decoders for client -> server frames ==================== */
function decodeRegisterTunnel(payload) {
  const reader = new Reader(payload);
  return {
    type: 'register_tunnel',
    clientId: reader.str(),
    id: reader.str(),
    domain: reader.str(),
    localPort: reader.u8(),
    localHost: reader.str(),
    protocol: reader.str(),
    description: reader.str()
  };
}

function decodeUnregisterTunnel(payload) {
  const reader = new Reader(payload);
  return { type: 'unregister_tunnel', clientId: reader.str(), domain: reader.str() };
}

function decodeCapabilities(payload) {
  const reader = new Reader(payload);
  const clientId = reader.str();
  const flags = reader.u8();
  return {
    type: 'capabilities',
    clientId: clientId,
    stream: !!(flags & 0x01),
    multiValueHeaders: !!(flags & 0x02)
  };
}

function decodeHeartbeat(payload) {
  const reader = new Reader(payload);
  return {
    type: 'heartbeat',
    clientId: reader.str(),
    timestamp: reader.str(),
    stats: {
      tunnelCount: reader.u32(),
      registeredCount: reader.u32(),
      sseConnections: reader.u32(),
      totalRequests: reader.u32(),
      totalErrors: reader.u32()
    }
  };
}

function decodeHttpResponse(payload, version) {
  const reader = new Reader(payload);
  const v = version >= VERSION_2 ? VERSION_2 : VERSION;
  const requestId = reader.str();
  const domain = reader.str();
  const status = v >= VERSION_2 ? reader.u16() : reader.u8();
  const headers = reader.headers();
  const body = reader.buf();
  const flags = reader.u8();
  const sseRequestId = reader.remaining() > 0 ? reader.str() : '';
  const wsRequestId = reader.remaining() > 0 ? reader.str() : '';
  const error = reader.remaining() > 0 ? reader.str() : '';

  return {
    type: 'http_response',
    requestId: requestId,
    domain: domain,
    status: status,
    headers: headers,
    body: body,
    isSSE: !!(flags & 0x01),
    isWebSocket: !!(flags & 0x02),
    hasError: !!(flags & 0x04),
    sseRequestId: sseRequestId || null,
    wsRequestId: wsRequestId || null,
    error: error || null
  };
}


module.exports = {
  MAGIC: MAGIC,
  VERSION: VERSION,
  VERSION_2: VERSION_2,
  HEADER_LENGTH: HEADER_LENGTH,
  DEFAULT_MAX_FRAME_SIZE: DEFAULT_MAX_FRAME_SIZE,
  TYPE: TYPE,
  TYPE_NAME: TYPE_NAME,
  FLAGS: FLAGS,
  utf8: utf8,
  toBytes: toBytes,
  concat: concat,
  encodeFrame: encodeFrame,
  decodeFrame: decodeFrame,
  decodeMessage: decodeMessage,
  encodeRegisterTunnel: encodeRegisterTunnel,
  encodeUnregisterTunnel: encodeUnregisterTunnel,
  encodeCapabilities: encodeCapabilities,
  encodeHeartbeat: encodeHeartbeat,
  encodeHttpResponse: encodeHttpResponse,
  encodeWebSocketData: encodeWebSocketData,
  encodeWebSocketClose: encodeWebSocketClose,
  encodeWelcome: encodeWelcome,
  encodeRegistered: encodeRegistered,
  encodeHeartbeatAck: encodeHeartbeatAck,
  encodeHttpRequest: encodeHttpRequest,
  encodeServerWebSocketData: encodeServerWebSocketData,
  encodeServerWebSocketClose: encodeServerWebSocketClose,
  decodeWelcome: decodeWelcome,
  decodeRegistered: decodeRegistered,
  decodeHttpRequest: decodeHttpRequest,
  decodeWebSocketData: decodeWebSocketData,
  decodeWebSocketClose: decodeWebSocketClose,
  decodeRegisterTunnel: decodeRegisterTunnel,
  decodeUnregisterTunnel: decodeUnregisterTunnel,
  decodeCapabilities: decodeCapabilities,
  decodeHeartbeat: decodeHeartbeat,
  decodeHttpResponse: decodeHttpResponse
};
