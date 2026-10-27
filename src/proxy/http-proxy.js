/**
 * HttpProxyApp — the refactored http-proxy module.
 *
 * Composes three independent layers:
 *
 *   TunnelTransport  (binary DTNS frames over WebSocket)
 *        ↓ decoded messages
 *   HttpProxyApp     (lifecycle, auth, CORS, response encoding)
 *        ↓ Request / Response
 *   Router           (routes, middleware, params)
 *
 * The browser agent registers its routes on this app; nothing here knows about
 * `chrome.*`. That separation is the core of the refactor: the legacy
 * `background.js` mixed socket handling, routing and browser automation in one
 * 4k-line file, which made any of the three impossible to test in isolation.
 */
'use strict';

const Protocol = require('../protocol/dtns-protocol');
const TunnelTransport = require('./transport');
const WsConnection = require('./websocket');
const { Emitter, ProxyError } = require('../util/primitives');
const {
  Router,
  Request,
  Response,
  normalizePath,
  isValidStatus
} = require('./router');

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

const DEFAULT_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With, X-Request-ID, X-Request-Time, X-Priority',
  'access-control-expose-headers': 'X-Request-ID, X-Tunnel-Version',
  'access-control-max-age': '86400'
};

class HttpProxyApp extends Emitter {
  constructor(options) {
    super();
    const opts = options || {};

    const domain = String(opts.domain || '').trim().toLowerCase();
    if (!domain || !DOMAIN_RE.test(domain)) {
      throw new ProxyError('options.domain is required, e.g. agent-xxxx.html.dtns.top', {
        code: 'INVALID_DOMAIN'
      });
    }

    this.domain = domain;
    this.apiBase = 'http://' + domain;
    this.wsUrl = opts.wsUrl || 'wss://res2.dtns.top/tunnel';
    this.clientId = opts.clientId || ('proxy-' + randomHex(6));
    this.token = opts.token ? String(opts.token).trim() : '';
    this.exposeErrors = !!opts.exposeErrors;
    this.maxBodySize = opts.maxBodySize || 1024 * 1024;
    this.cors = opts.cors === false ? false : Object.assign({}, DEFAULT_CORS, opts.cors || {});
    this.description = opts.description || 'dtns browser proxy';
    this.tunnelId = opts.tunnelId || 'browser-agent-' + this.clientId;
    // Optional mapper used when the clientId changes and the tunnel domain is
    // derived from it (e.g. browser2.<clientId>.html.dtns.top for the agent).
    this.domainFactory = typeof opts.domainFactory === 'function' ? opts.domainFactory : null;

    this.router = new Router();
    this.wsConnections = new Map();

    this.requests = 0;
    this.errors = 0;
    this.startedAt = 0;
    this.listening = false;
    this.closed = false;
    this.ready = null;

    this._resolveReady = null;
    this._rejectReady = null;

    this._transportOptions = {
      WebSocket: opts.WebSocket,
      createWebSocket: opts.createWebSocket,
      heartbeatInterval: opts.heartbeatInterval,
      heartbeatTimeout: opts.heartbeatTimeout,
      registerTimeout: opts.registerTimeout,
      registerRetries: opts.registerRetries,
      reconnect: opts.reconnect,
      capabilities: opts.capabilities,
      maxFrameSize: opts.maxFrameSize,
      // The binary protocol stores localPort in a single byte, so only 0-255
      // survives the wire. The legacy JSON schema advertised 10999, which
      // silently truncates to 247; browser tunnels are routed by domain and
      // have no local listener, so 80 is the honest value to advertise.
      localPort: opts.localPort || 80,
      localHost: opts.localHost || 'browser-extension'
    };
    this._externalTransport = opts.transport || null;

    this.transport = this._externalTransport || new TunnelTransport(this._transportConfig());

    this.transport.extraStats = () => ({
      totalRequests: this.requests,
      totalErrors: this.errors
    });

    this._wireTransport();
  }

  _transportConfig() {
    return Object.assign({}, this._transportOptions, {
      clientId: this.clientId,
      wsUrl: this.wsUrl,
      tunnel: {
        id: this.tunnelId,
        domain: this.domain,
        localPort: this._transportOptions.localPort,
        localHost: this._transportOptions.localHost,
        protocol: 'http',
        description: this.description
      }
    });
  }

  /* ==================== routing surface ==================== */

  get(path, handler) { this.router.get(path, handler); return this; }
  post(path, handler) { this.router.post(path, handler); return this; }
  put(path, handler) { this.router.put(path, handler); return this; }
  patch(path, handler) { this.router.patch(path, handler); return this; }
  delete(path, handler) { this.router.delete(path, handler); return this; }
  head(path, handler) { this.router.head(path, handler); return this; }
  options(path, handler) { this.router.options(path, handler); return this; }
  all(path, handler) { this.router.all(path, handler); return this; }
  any(path, handler) { this.router.any(path, handler); return this; }
  use(pathOrFn, fn) { this.router.use(pathOrFn, fn); return this; }
  ws(path, handler) { this.router.ws(path, handler); return this; }
  routes() { return this.router.list(); }

  /* ==================== lifecycle ==================== */

  listen() {
    if (this.ready) return this.ready;
    if (this.closed) {
      return Promise.reject(new ProxyError('app is closed', { code: 'APP_CLOSED' }));
    }

    this.startedAt = Date.now();
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    try {
      this.transport.connect();
    } catch (error) {
      this._rejectReady(error);
    }
    return this.ready;
  }

  close() {
    if (this.closed) return this;
    this.closed = true;
    this.listening = false;
    this._closeAllWs(1000, 'proxy closed');
    if (this._rejectReady && !this.listening) {
      try { this._rejectReady(new ProxyError('app closed before listening', { code: 'APP_CLOSED' })); }
      catch (error) { /* already settled */ }
    }
    this.transport.close(1000, 'proxy closed');
    this.emit('close', this.status());
    return this;
  }

  /** Resolve once the tunnel is registered (or reject on timeout). */
  whenReady(timeoutMs) {
    if (this.transport.registered) return Promise.resolve(this);
    const ready = this.ready || this.listen();
    if (!timeoutMs) return ready;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ProxyError('timed out waiting for registration', { code: 'READY_TIMEOUT' }));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      ready.then((value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); });
    });
  }

  /** Force a fresh socket with the current settings. */
  reconnect() {
    if (this.closed) {
      return Promise.reject(new ProxyError('app is closed', { code: 'APP_CLOSED' }));
    }
    this._swapTransport();
    return this.listen();
  }

  /**
   * Re-register with a different client id / server URL, e.g. after the user
   * changes their id in the popup. The current response frame is allowed to
   * flush before the old socket is torn down, which is why the swap happens on
   * the next macrotask.
   *
   * @returns {Promise<string>} the new tunnel domain
   */
  async rebind(options) {
    const opts = options || {};
    const clientId = opts.clientId || this.clientId;
    const wsUrl = opts.wsUrl || this.wsUrl;
    const domain = opts.domain || (this.domainFactory ? this.domainFactory(clientId) : this.domain);

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      if (timer.unref) timer.unref();
    });

    if (this.closed) return domain;

    this.clientId = clientId;
    this.wsUrl = wsUrl;
    this.domain = String(domain).toLowerCase();
    this.apiBase = 'http://' + this.domain;
    this.tunnelId = opts.tunnelId || ('browser-agent-' + clientId);

    this._swapTransport();
    this.listen().catch(() => {});
    return this.domain;
  }

  _swapTransport() {
    this._closeAllWs(1000, 'transport rebound');
    try { this.transport.close(1000, 'transport rebound'); } catch (error) { /* ignore */ }
    if (this._externalTransport) {
      // An injected transport is owned by the host; it cannot be replaced.
      this._externalTransport.connect();
      return;
    }
    this.transport = new TunnelTransport(this._transportConfig());
    this.transport.extraStats = () => ({
      totalRequests: this.requests,
      totalErrors: this.errors
    });
    this._wireTransport();
    this.listening = false;
    this.ready = null;
    this._resolveReady = null;
    this._rejectReady = null;
  }


  status() {
    const transport = this.transport;
    return {
      connected: !!transport.connected,
      registered: !!transport.registered,
      listening: this.listening,
      domain: this.domain,
      apiBase: this.apiBase,
      clientId: this.clientId,
      auth: this.token ? 'bearer' : 'none',
      serverVersion: transport.serverVersion,
      requests: this.requests,
      errors: this.errors,
      reconnects: transport.stats.reconnects,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      routes: this.router.routes.length,
      wsRoutes: this.router.wsRoutes.length,
      websockets: this.wsConnections.size,
      middlewares: this.router.middlewares.length
    };
  }

  /* ==================== transport wiring ==================== */

  _wireTransport() {
    const self = this;
    const transport = this.transport;

    transport.on('open', () => self.emit('open', self.status()));

    transport.on('welcome', (message) => {
      self.emit('welcome', {
        clientId: message.clientId,
        protocolVersion: message.protocolVersion,
        serverMessage: message.message
      });
    });

    transport.on('registered', (message) => {
      const first = !self.listening;
      self.listening = true;
      if (first && self._resolveReady) {
        try { self._resolveReady(self); } catch (error) { /* already settled */ }
      }
      self.emit(first ? 'listening' : 'reconnected', self.status());
      self.emit('registered', message);
    });

    transport.on('register_failed', (message) => {
      self.emit('register_failed', message);
    });

    transport.on('message', (message) => self._onMessage(message));

    transport.on('disconnected', (info) => {
      self._closeAllWs(1000, 'tunnel disconnected');
      self.emit('disconnected', info);
    });

    transport.on('reconnecting', (info) => self.emit('reconnecting', info));

    transport.on('error', (error) => {
      self.errors += 1;
      self.emit('error', error);
    });

    transport.on('failed', (error) => {
      if (!self.listening && self._rejectReady) {
        try { self._rejectReady(error); } catch (e) { /* already settled */ }
      }
      self.emit('failed', error);
    });
  }

  _onMessage(message) {
    switch (message.type) {
      case 'http_request':
        this.handleRequest(message);
        return;
      case 'websocket_data':
      case 'websocket_data_from_server': {
        const connection = this.wsConnections.get(message.wsRequestId);
        if (connection) connection._handleMessage(message);
        return;
      }
      case 'websocket_close':
      case 'websocket_close_from_server': {
        const connection = this.wsConnections.get(message.wsRequestId);
        if (connection) connection._onServerClose(message);
        return;
      }
      case 'websocket_end':
        this._wsEvent(message.wsRequestId, '_onServerEnd');
        return;
      case 'websocket_error':
        this._wsEvent(message.wsRequestId, '_onServerError', message);
        return;
      default:
        this.emit('message', message);
    }
  }

  _wsEvent(wsRequestId, method, argument) {
    const connection = this.wsConnections.get(wsRequestId);
    if (connection) connection[method](argument);
  }

  /* ==================== request handling ==================== */

  /**
   * Entry point for one tunnel-delivered HTTP request. Public so that a host
   * (for example a test harness or a non-WebSocket transport) can inject
   * requests without owning the socket.
   */
  handleRequest(message) {
    const started = Date.now();
    this.requests += 1;

    const req = new Request(message);
    const res = this._createResponse(req, message, started);

    if (this.cors) this._applyCors(res);

    if (message.isWebSocket) {
      this._handleWebSocket(message, req, res);
      return res;
    }

    if (message.isSSE) {
      res.status(501).json({
        ok: false,
        error: 'sse_not_supported',
        hint: 'The browser agent proxy handles plain HTTP requests only.'
      });
      return res;
    }

    try {
      this.router.handle(req, res, {
        authCheck: this.token ? (request) => this._checkAuth(request) : null,
        maxBodySize: this.maxBodySize,
        exposeErrors: this.exposeErrors,
        emitError: (error) => {
          this.errors += 1;
          this.emit('error', error);
        }
      });
    } catch (error) {
      // Routing must never take the tunnel down.
      if (!res.finished) res.status(500).json({ ok: false, error: 'internal_error' });
      this.emit('error', error);
    }

    return res;
  }

  _createResponse(req, message, started) {
    const self = this;
    return new Response(req, {
      send: (status, headers, body) => self._sendResponse(message, status, headers, body),
      finish: (status) => self._after(req, status, started),
      upgrade: (request, headers) => self._acceptWebSocket(message, request, headers)
    });
  }

  _applyCors(res) {
    Object.keys(this.cors).forEach((key) => {
      if (this.cors[key] !== undefined && this.cors[key] !== null) res.set(key, this.cors[key]);
    });
    res.set('x-tunnel-version', 'dtns/2');
  }

  _checkAuth(req) {
    const authorization = String(req.get('authorization') || '');
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match && match[1].trim() === this.token) return true;
    if (req.query && req.query.token === this.token) return true;
    return false;
  }

  _handleWebSocket(message, req, res) {
    if (!message.wsRequestId) {
      res.status(400).json({ ok: false, error: 'missing_ws_request_id' });
      return;
    }
    if (this.token && !this._checkAuth(req)) {
      res.set('www-authenticate', 'Bearer realm="dtns-agent"');
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    if (req.method !== 'GET') {
      res.set('allow', 'GET');
      res.status(405).json({ ok: false, error: 'method_not_allowed', allow: 'GET' });
      return;
    }

    const found = this.router.matchWs(req.path);
    if (!found) {
      res.status(404).json({
        ok: false,
        error: 'websocket_route_not_found',
        path: req.path
      });
      return;
    }

    req.params = found.params;
    const offered = String(req.get('sec-websocket-protocol') || '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    const protocol = offered[0] || '';

    res.acceptWebSocket(protocol ? { 'sec-websocket-protocol': protocol } : {});
    const self = this;
    const connection = new WsConnection(message, req, protocol, {
      send: (frame) => self.transport.send(frame),
      release: (id) => self.wsConnections.delete(id)
    });
    this.wsConnections.set(message.wsRequestId, connection);

    this.emit('websocket', {
      path: req.path,
      wsRequestId: message.wsRequestId,
      remoteAddress: req.remoteAddress,
      protocol: protocol
    });

    try {
      const result = found.route.handler(connection, req);
      if (result && typeof result.then === 'function') {
        result.catch((error) => connection._fail(error));
      }
    } catch (error) {
      connection._fail(error);
    }
  }

  _acceptWebSocket(message, req, headers) {
    return this._sendResponse(message, 101, headers || {}, new Uint8Array(0));
  }

  _closeAllWs(code, reason) {
    this.wsConnections.forEach((connection) => {
      connection._finish(code || 1000, reason || '', false);
    });
    this.wsConnections.clear();
  }

  _sendResponse(message, status, headers, body) {
    if (!this.transport.isOpen()) {
      this.emit('error', new ProxyError('WebSocket is not open', { code: 'WS_NOT_OPEN' }));
      return false;
    }
    if (!isValidStatus(status)) status = 200;

    const clean = {};
    Object.keys(headers || {}).forEach((key) => {
      if (headers[key] !== undefined && headers[key] !== null) {
        clean[String(key).toLowerCase()] = String(headers[key]);
      }
    });

    const frame = Protocol.encodeHttpResponse({
      requestId: message.requestId,
      domain: message.domain,
      status: status,
      headers: clean,
      body: body || new Uint8Array(0),
      isSSE: false,
      sseRequestId: message.sseRequestId || null,
      isWebSocket: !!message.isWebSocket,
      wsRequestId: message.wsRequestId || null,
      error: null
    }, this.transport.serverVersion);

    return this.transport.send(frame);
  }

  _after(req, status, started) {
    if (status >= 500) this.errors += 1;
    this.emit('request', {
      method: req.method,
      path: req.path,
      status: status,
      ms: Date.now() - (started || Date.now()),
      requestId: req.requestId
    });
  }
}

function randomHex(bytes) {
  const data = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(data);
  else for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
  return Array.prototype.map.call(data, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {object} options see HttpProxyApp constructor
 * @returns {HttpProxyApp}
 */
function createProxy(options) {
  return new HttpProxyApp(options);
}

module.exports = {
  HttpProxyApp: HttpProxyApp,
  createProxy: createProxy,
  DEFAULT_CORS: DEFAULT_CORS,
  normalizePath: normalizePath
};
