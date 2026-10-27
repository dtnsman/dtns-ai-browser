/**
 * TunnelTransport — DTNS binary tunnel client.
 *
 * Owns exactly one WebSocket connection to the tunnel server and speaks the
 * binary DTNS frame protocol. It knows nothing about HTTP routing or browser
 * APIs; it only:
 *
 *   1. opens the socket and negotiates the protocol version (welcome frame),
 *   2. declares capabilities and registers the tunnel,
 *   3. keeps the tunnel alive (heartbeat + ack tracking),
 *   4. reconnects with capped exponential backoff and jitter,
 *   5. decodes inbound frames into semantic events.
 *
 * Events
 *   open               socket established
 *   welcome            {clientId, protocolVersion}
 *   registered         {domain}
 *   register_failed    {domain, error}
 *   message            decoded non-control message (http_request, websocket_*)
 *   heartbeat_ack      server acknowledged a heartbeat
 *   reconnecting       {attempt, delay}
 *   disconnected       {code, reason, willRetry}
 *   error              ProxyError
 *   failed             terminal failure (no further retries will happen)
 */
'use strict';

const Protocol = require('../protocol/dtns-protocol');
const { Emitter, ProxyError } = require('../util/primitives');

const DEFAULTS = {
  wsUrl: 'wss://res2.dtns.top/tunnel',
  heartbeatInterval: 25000,
  // A heartbeat that is never acknowledged means the socket is a zombie even
  // though readyState still says OPEN. Legacy never detected this.
  heartbeatTimeout: 60000,
  registerTimeout: 4000,
  registerRetries: 3,
  reconnect: {
    enabled: true,
    baseDelay: 1500,
    factor: 1.7,
    maxDelay: 20000,
    maxAttempts: 100,
    jitter: 0.2
  }
};

function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * Normalise a tunnel WebSocket URL.
 *
 * The server accepts the upgrade on `/tunnel` only. Config values frequently
 * carry just the origin (`wss://res2.dtns.top`), which handshakes against `/`
 * and is rejected with HTTP 400 — so the path is filled in here rather than in
 * every caller.
 */
function normalizeTunnelUrl(raw) {
  let url = String(raw || '').trim();
  if (!/^wss?:\/\//i.test(url)) url = DEFAULTS.wsUrl;

  const queryIndex = url.indexOf('?');
  const query = queryIndex === -1 ? '' : url.slice(queryIndex);
  let base = (queryIndex === -1 ? url : url.slice(0, queryIndex)).replace(/\/+$/, '');

  const afterScheme = base.slice(base.indexOf('//') + 2);
  if (!afterScheme.includes('/')) base += '/tunnel';

  return base + query;
}

class TunnelTransport extends Emitter {
  constructor(options) {
    super();
    const opts = options || {};

    if (!opts.clientId) {
      throw new ProxyError('transport requires a clientId', { code: 'MISSING_CLIENT_ID' });
    }
    if (!opts.tunnel || !opts.tunnel.domain) {
      throw new ProxyError('transport requires tunnel.domain', { code: 'MISSING_DOMAIN' });
    }

    this.clientId = String(opts.clientId);
    this.wsUrl = normalizeTunnelUrl(opts.wsUrl || DEFAULTS.wsUrl);
    this.tunnel = Object.assign({ localPort: 80, localHost: '127.0.0.1', protocol: 'http' }, opts.tunnel);
    this.WebSocket = opts.WebSocket || null;
    this.createWebSocket = typeof opts.createWebSocket === 'function' ? opts.createWebSocket : null;

    this.heartbeatInterval = opts.heartbeatInterval || DEFAULTS.heartbeatInterval;
    this.heartbeatTimeout = opts.heartbeatTimeout || DEFAULTS.heartbeatTimeout;
    this.registerTimeout = opts.registerTimeout === undefined ? DEFAULTS.registerTimeout : opts.registerTimeout;
    this.registerRetries = opts.registerRetries === undefined ? DEFAULTS.registerRetries : opts.registerRetries;
    this.maxFrameSize = opts.maxFrameSize || Protocol.DEFAULT_MAX_FRAME_SIZE;
    this.capabilities = Object.assign({ stream: false, multiValueHeaders: true }, opts.capabilities);
    this.reconnect = Object.assign({}, DEFAULTS.reconnect, opts.reconnect || {});
    if (opts.reconnect === false) this.reconnect.enabled = false;

    this.socket = null;
    this.connected = false;
    this.registered = false;
    this.serverVersion = Protocol.VERSION_2;
    this.closed = false;
    this.attempts = 0;

    this.heartbeatTimer = null;
    this.heartbeatWatchdog = null;
    this.reconnectTimer = null;
    this.registerTimer = null;

    this.lastAckAt = 0;
    this.lastHeartbeatAt = 0;

    this.stats = {
      framesIn: 0,
      framesOut: 0,
      bytesIn: 0,
      bytesOut: 0,
      heartbeatsSent: 0,
      reconnects: 0,
      decodeErrors: 0
    };
  }

  /** Open the tunnel. Idempotent: a second call is a no-op. */
  connect() {
    if (this.socket || this.closed) return this;
    const WS = this.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS && !this.createWebSocket) {
      throw new ProxyError(
        'WebSocket is not available; pass options.WebSocket (e.g. require("ws"))',
        { code: 'NO_WEBSOCKET' }
      );
    }

    const url = this._buildUrl();
    let ws;
    try {
      ws = this.createWebSocket ? this.createWebSocket(url) : new WS(url);
    } catch (error) {
      this._fatal(new ProxyError('WebSocket constructor failed: ' + error.message, {
        code: 'WS_INIT_FAILED', cause: error
      }));
      return this;
    }

    this.socket = ws;
    this.connected = false;
    this.registered = false;
    try { ws.binaryType = 'arraybuffer'; } catch (error) { /* not all impls allow it */ }

    const self = this;

    ws.onopen = function () {
      if (self.socket !== ws) return;
      self.connected = true;
      // Note: `attempts` is reset on successful registration, not here, so a
      // server that accepts the socket but refuses the tunnel still backs off.
      self.emit('open');
      self._declareCapabilities();
      self._sendRegister();
      self._startHeartbeat();
    };

    ws.onmessage = function (event) {
      if (self.socket !== ws) return;
      const data = event && event.data !== undefined ? event.data : event;
      self._onData(data);
    };

    ws.onerror = function (event) {
      if (self.socket !== ws) return;
      self.emit('error', new ProxyError('WebSocket error', {
        code: 'WS_ERROR',
        cause: event && event.error ? event.error : undefined
      }));
    };

    ws.onclose = function (event) {
      if (self.socket !== ws) return;
      self.socket = null;
      self._onClose(event || {});
    };

    return this;
  }

  isOpen() {
    return !!this.socket && this.socket.readyState === 1;
  }

  /** Send a pre-encoded frame. Returns false when the socket is not open. */
  send(frame) {
    if (!this.socket || this.socket.readyState !== 1 || !frame) return false;
    try {
      this.socket.send(frame);
      this.stats.framesOut += 1;
      this.stats.bytesOut += frame.byteLength || frame.length || 0;
      return true;
    } catch (error) {
      this.emit('error', new ProxyError('WebSocket send failed: ' + error.message, {
        code: 'WS_SEND_FAILED', cause: error
      }));
      return false;
    }
  }

  close(code, reason) {
    this.closed = true;
    this.connected = false;
    this.registered = false;
    this._clearTimers();
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try { ws.close(code === undefined ? 1000 : code, reason || 'transport closed'); }
      catch (error) { /* already gone */ }
    }
  }

  status() {
    return {
      connected: this.connected,
      registered: this.registered,
      clientId: this.clientId,
      domain: this.tunnel.domain,
      serverVersion: this.serverVersion,
      wsUrl: this.wsUrl,
      attempts: this.attempts,
      lastAckAt: this.lastAckAt,
      stats: Object.assign({}, this.stats)
    };
  }

  /* ==================== internals ==================== */

  _buildUrl() {
    const separator = this.wsUrl.indexOf('?') === -1 ? '?' : '&';
    return this.wsUrl + separator + 'clientId=' + encodeURIComponent(this.clientId);
  }

  _onData(data) {
    let frame;
    try {
      frame = Protocol.decodeFrame(data, { maxFrameSize: this.maxFrameSize });
    } catch (error) {
      this.stats.decodeErrors += 1;
      this.emit('error', new ProxyError('Frame decode failed: ' + error.message, {
        code: 'FRAME_DECODE_ERROR', cause: error
      }));
      return;
    }

    this.stats.framesIn += 1;
    this.stats.bytesIn += frame.byteLength;

    let message;
    try {
      message = Protocol.decodeMessage(frame);
    } catch (error) {
      this.stats.decodeErrors += 1;
      this.emit('error', new ProxyError('Payload decode failed: ' + error.message, {
        code: 'MESSAGE_DECODE_ERROR', cause: error
      }));
      return;
    }

    switch (message.type) {
      case 'welcome':
        // Version negotiation: the server tells us whether it understands
        // two-byte status codes in HTTP_RESPONSE frames.
        this.serverVersion = message.protocolVersion || Protocol.VERSION;
        this.emit('welcome', message);
        return;
      case 'registered':
        this._onRegistered(message);
        return;
      case 'heartbeat_ack':
        this.lastAckAt = Date.now();
        this.emit('heartbeat_ack', message);
        return;
      case 'unregistered':
        this.registered = false;
        this.emit('unregistered', message);
        return;
      default:
        this.emit('message', message, frame);
    }
  }

  _onRegistered(message) {
    if (message.success) {
      this.registered = true;
      this.attempts = 0;
      this._clearRegisterTimer();
      this.emit('registered', message);
      return;
    }

    this.registered = false;
    this._clearRegisterTimer();
    const error = new ProxyError(message.error || 'tunnel registration failed', {
      code: 'REGISTER_FAILED'
    });
    this.emit('register_failed', message);
    this.emit('error', error);

    if (this.attempts === 0) {
      // Never came up once: fail loudly instead of retrying forever.
      this._fatal(error);
    } else {
      this._scheduleReconnect();
    }
  }

  _onClose(event) {
    const wasRegistered = this.registered;
    this.connected = false;
    this.registered = false;
    this._clearTimers();

    const willRetry = !this.closed && this.reconnect.enabled &&
      this.attempts < this.reconnect.maxAttempts;

    this.emit('disconnected', {
      code: event.code || 0,
      reason: event.reason || '',
      wasRegistered: wasRegistered,
      willRetry: willRetry
    });

    if (willRetry) this._scheduleReconnect();
    else if (!this.closed) this._fatal(new ProxyError('tunnel closed without reconnect', { code: 'TUNNEL_CLOSED' }));
  }

  _scheduleReconnect() {
    if (this.closed || !this.reconnect.enabled || this.reconnectTimer) return;
    if (this.attempts >= this.reconnect.maxAttempts) {
      this._fatal(new ProxyError('reconnect attempts exhausted', { code: 'RECONNECT_EXHAUSTED' }));
      return;
    }

    this.attempts += 1;
    this.stats.reconnects += 1;

    const cfg = this.reconnect;
    const raw = Math.min(cfg.baseDelay * Math.pow(cfg.factor, this.attempts - 1), cfg.maxDelay);
    // Jitter avoids a thundering herd when a server restarts.
    const jitter = raw * cfg.jitter * (Math.random() * 2 - 1);
    const delay = Math.max(250, Math.round(raw + jitter));

    this.emit('reconnecting', { attempt: this.attempts, delay: delay });

    const self = this;
    this.reconnectTimer = unref(setTimeout(function () {
      self.reconnectTimer = null;
      self.connect();
    }, delay));
  }

  _fatal(error) {
    this.closed = true;
    this.connected = false;
    this.registered = false;
    this._clearTimers();
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try { ws.close(4000, 'transport failed'); } catch (e) { /* ignore */ }
    }
    this.emit('failed', error);
    this.emit('error', error);
  }

  _declareCapabilities() {
    this.send(Protocol.encodeCapabilities({
      clientId: this.clientId,
      stream: !!this.capabilities.stream,
      multiValueHeaders: !!this.capabilities.multiValueHeaders
    }));
  }

  _sendRegister() {
    const sent = this.send(Protocol.encodeRegisterTunnel({
      clientId: this.clientId,
      tunnel: this.tunnel
    }));
    if (sent && this.registerTimeout > 0 && this.registerRetries > 0) this._armRegisterTimer();
    return sent;
  }

  /**
   * Legacy re-sent register_tunnel on a fixed 3s interval up to five times and
   * leaked the interval when registration succeeded mid-flight. Here the retry
   * is a single-shot timer that is always cleared, and it only fires when the
   * server never acknowledged.
   */
  _armRegisterTimer() {
    this._clearRegisterTimer();
    if (this.registered || this.closed) return;
    const self = this;
    let attempt = 0;
    const tick = function () {
      if (self.closed || self.registered) return;
      attempt += 1;
      if (attempt > self.registerRetries) {
        self.emit('error', new ProxyError('tunnel registration timed out', {
          code: 'REGISTER_TIMEOUT'
        }));
        self._fatal(new ProxyError('tunnel registration timed out', { code: 'REGISTER_TIMEOUT' }));
        return;
      }
      self.emit('register_retry', { attempt: attempt });
      self.send(Protocol.encodeRegisterTunnel({
        clientId: self.clientId,
        tunnel: self.tunnel
      }));
      self.registerTimer = unref(setTimeout(tick, self.registerTimeout));
    };
    this.registerTimer = unref(setTimeout(tick, this.registerTimeout));
  }

  _clearRegisterTimer() {
    if (this.registerTimer) {
      clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.lastAckAt = Date.now();
    this._beat();
    this.heartbeatTimer = unref(setInterval(this._beat.bind(this), this.heartbeatInterval));
    this.heartbeatWatchdog = unref(setInterval(this._checkHeartbeat.bind(this), this.heartbeatInterval));
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatWatchdog) {
      clearInterval(this.heartbeatWatchdog);
      this.heartbeatWatchdog = null;
    }
  }

  _beat() {
    if (!this.isOpen()) return;
    this.lastHeartbeatAt = Date.now();
    const sent = this.send(Protocol.encodeHeartbeat({
      clientId: this.clientId,
      timestamp: new Date().toISOString(),
      stats: this._heartbeatStats()
    }));
    if (sent) this.stats.heartbeatsSent += 1;
  }

  _heartbeatStats() {
    const base = { tunnelCount: 1, registeredCount: this.registered ? 1 : 0 };
    // The owner (HttpProxyApp) contributes request/error counters so the
    // server-side dashboard sees real traffic numbers.
    if (typeof this.extraStats === 'function') {
      Object.assign(base, this.extraStats() || {});
    }
    return base;
  }

  _checkHeartbeat() {
    if (!this.isOpen() || !this.heartbeatTimeout) return;
    const silentFor = Date.now() - this.lastAckAt;
    if (silentFor <= this.heartbeatTimeout) return;

    // Zombie socket: readyState says OPEN but nothing has come back. Force a
    // reconnect so the server-side tunnel is not left pointing at a dead peer.
    this.emit('error', new ProxyError('heartbeat ack timeout after ' + silentFor + 'ms', {
      code: 'HEARTBEAT_TIMEOUT'
    }));
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try { ws.close(4001, 'heartbeat timeout'); } catch (e) { /* ignore */ }
    }
    this._onClose({ code: 4001, reason: 'heartbeat timeout' });
  }

  _clearTimers() {
    this._stopHeartbeat();
    this._clearRegisterTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

TunnelTransport.DEFAULTS = DEFAULTS;

module.exports = TunnelTransport;
module.exports.normalizeTunnelUrl = normalizeTunnelUrl;
module.exports.DEFAULTS = DEFAULTS;
