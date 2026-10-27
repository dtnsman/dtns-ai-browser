/**
 * Shared primitives: the SDK error type and a dependency-free event emitter.
 */
'use strict';

class ProxyError extends Error {
  constructor(message, options) {
    super(message || 'DTNS browser proxy error');
    this.name = 'DTNSProxyError';
    options = options || {};
    this.code = options.code || 'PROXY_ERROR';
    this.status = options.status || 0;
    if (options.cause) this.cause = options.cause;
  }
}

class Emitter {
  constructor() {
    this._events = Object.create(null);
  }

  on(name, fn) {
    if (typeof fn === 'function') {
      (this._events[name] = this._events[name] || []).push(fn);
    }
    return this;
  }

  once(name, fn) {
    const self = this;
    function wrapper() {
      self.off(name, wrapper);
      fn.apply(null, arguments);
    }
    wrapper.listener = fn;
    return this.on(name, wrapper);
  }

  off(name, fn) {
    const list = this._events[name];
    if (!list) return this;
    if (!fn) {
      delete this._events[name];
      return this;
    }
    this._events[name] = list.filter((item) => item !== fn && item.listener !== fn);
    return this;
  }

  emit(name) {
    const list = this._events[name];
    if (!list || !list.length) return this;
    const args = Array.prototype.slice.call(arguments, 1);
    list.slice().forEach((fn) => {
      // Listener failures must never break a live tunnel.
      try { fn.apply(null, args); } catch (error) { /* swallowed by design */ }
    });
    return this;
  }

  listenerCount(name) {
    return (this._events[name] || []).length;
  }
}

module.exports = { ProxyError, Emitter };
