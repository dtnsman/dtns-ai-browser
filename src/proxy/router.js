/**
 * Router — Express-style routing for tunnel-delivered HTTP requests.
 *
 * Extracted from the AgentApp in `assets/sdk.js` so that the routing model,
 * request/response objects and middleware semantics are reusable and testable
 * without a live socket. Behaviour matches the SDK:
 *
 *   - `:param` segments, trailing `*` wildcard, path params on `req.params`
 *   - `use([prefix], fn)` middleware with `next()` / `next(err)` semantics
 *   - 204 for a matched route that returns nothing, 405 with `Allow` when the
 *     path exists but the method does not, 404 otherwise
 *   - automatic JSON/text/buffer serialization of a returned value
 *   - `OPTIONS` answers 204 unless an explicit OPTIONS route exists
 *
 * Deliberate changes versus the SDK are documented in docs/DESIGN.md; the most
 * visible one is that a Response no longer reaches back into an app singleton —
 * it writes through the `send`/`upgrade` hooks it was constructed with.
 */
'use strict';

const { ProxyError } = require('../util/primitives');

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function utf8(value) {
  return encoder.encode(String(value == null ? '' : value));
}

function textOf(bytes) {
  try {
    return decoder.decode(bytes || new Uint8Array(0));
  } catch (error) {
    return '';
  }
}

function normalizePath(path) {
  let value = String(path || '/');
  if (value.charAt(0) !== '/') value = '/' + value;
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value || '/';
}

function parseQuery(search) {
  const out = {};
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  params.forEach((value, key) => {
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  });
  return out;
}

function lowerHeaders(headers) {
  const out = {};
  Object.keys(headers || {}).forEach((key) => {
    out[String(key).toLowerCase()] = headers[key];
  });
  return out;
}

function headerValue(headers, name) {
  const value = headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

function compilePath(path) {
  const normalized = normalizePath(path);
  if (normalized === '/') return [];
  return normalized.slice(1).split('/').map((segment) => {
    if (segment === '*') return { wildcard: true };
    if (segment.charAt(0) === ':') return { param: segment.slice(1) };
    return { literal: segment };
  });
}

function matchPath(segments, path) {
  const parts = path === '/' ? [] : path.slice(1).split('/');
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.wildcard) {
      params['*'] = parts.slice(i).join('/');
      return params;
    }
    if (i >= parts.length) return null;
    if (segment.param) {
      try { params[segment.param] = decodeURIComponent(parts[i]); }
      catch (error) { params[segment.param] = parts[i]; }
    } else if (segment.literal !== parts[i]) {
      return null;
    }
  }
  return parts.length === segments.length ? params : null;
}

function matchesPrefix(path, prefix) {
  if (!prefix || prefix === '/') return true;
  return path === prefix || path.indexOf(prefix + '/') === 0;
}

function isValidStatus(code) {
  return code >= 100 && code <= 599;
}

function isPromise(value) {
  return !!value && typeof value.then === 'function';
}

class Request {
  constructor(message) {
    this.method = String(message.method || 'GET').toUpperCase();
    this.url = message.url || '/';
    this.originalUrl = this.url;
    const parsed = new URL(this.url, 'http://proxy.local');
    this.path = normalizePath(parsed.pathname);
    this.query = parseQuery(parsed.search);
    this.headers = lowerHeaders(message.headers || {});
    this.rawBody = message.body || new Uint8Array(0);
    this.body = undefined;
    this.params = {};
    this.domain = message.domain || '';
    this.requestId = message.requestId || '';
    this.remoteAddress = message.remoteAddress || '';
    this.locals = {};
    this.message = message;
  }

  get(name) { return headerValue(this.headers, name); }
  header(name) { return this.get(name); }
}

class Response {
  /**
   * @param {Request} req
   * @param {object} hooks
   * @param {function(number, object, Uint8Array): boolean} hooks.send
   * @param {function(number): void} [hooks.finish]
   * @param {function(object): boolean} [hooks.upgrade] handles a 101 upgrade
   */
  constructor(req, hooks) {
    this.req = req;
    this.hooks = hooks || {};
    this.statusCode = 200;
    this.headers = {};
    this.locals = {};
    this.finished = false;
    this.headersSent = false;
  }

  status(code) {
    this.statusCode = Number(code) || 200;
    return this;
  }

  set(name, value) {
    if (!this.finished) this.headers[String(name).toLowerCase()] = String(value);
    return this;
  }

  header(name, value) { return this.set(name, value); }
  setHeader(name, value) { return this.set(name, value); }
  get(name) { return this.headers[String(name).toLowerCase()]; }
  removeHeader(name) { delete this.headers[String(name).toLowerCase()]; return this; }

  type(value) {
    let type = String(value || '');
    if (type === 'json') type = 'application/json; charset=utf-8';
    else if (type === 'text' || type === 'txt') type = 'text/plain; charset=utf-8';
    else if (type === 'html') type = 'text/html; charset=utf-8';
    else if (type.indexOf('/') === -1) type = 'application/' + type;
    return this.set('content-type', type);
  }

  json(value) {
    if (!this.get('content-type')) this.set('content-type', 'application/json; charset=utf-8');
    return this.end(JSON.stringify(value === undefined ? null : value));
  }

  send(value) {
    if (value === undefined || value === null) return this.end('');
    if (value instanceof Uint8Array) {
      if (!this.get('content-type')) this.set('content-type', 'application/octet-stream');
      return this.end(value);
    }
    if (typeof value === 'object') return this.json(value);
    if (typeof value === 'string') {
      if (!this.get('content-type')) this.set('content-type', 'text/plain; charset=utf-8');
      return this.end(value);
    }
    return this.end(String(value));
  }

  text(value) {
    if (!this.get('content-type')) this.set('content-type', 'text/plain; charset=utf-8');
    return this.end(String(value == null ? '' : value));
  }

  redirect(url, status) {
    this.status(status || 302);
    this.set('location', String(url));
    return this.end('');
  }

  sendStatus(code) {
    this.status(code);
    return this.end('');
  }

  /** Accept a WebSocket upgrade; the proxy layer performs the 101 handshake. */
  acceptWebSocket(headers) {
    if (this.finished) return this;
    this.finished = true;
    this.headersSent = true;
    const merged = Object.assign({}, this.headers, headers || {});
    if (this.hooks.upgrade) this.hooks.upgrade(this.req, merged);
    if (this.hooks.finish) this.hooks.finish(101);
    return this;
  }

  end(body) {
    if (this.finished) return this;

    let status = isValidStatus(this.statusCode) ? this.statusCode : 200;
    let bytes;
    if (body instanceof Uint8Array) bytes = body;
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else if (body === undefined || body === null) bytes = new Uint8Array(0);
    else if (typeof body === 'string') bytes = utf8(body);
    else bytes = utf8(String(body));

    // HEAD responses keep the headers of the GET representation but carry
    // no payload. The declared content-length still describes the GET body.
    const payloadLength = bytes.length;
    if (this.req && this.req.method === 'HEAD') bytes = new Uint8Array(0);

    const headers = {};
    Object.keys(this.headers).forEach((key) => {
      if (this.headers[key] !== undefined && this.headers[key] !== null) {
        headers[key] = String(this.headers[key]);
      }
    });

    if (status === 204 || status === 304) {
      delete headers['content-type'];
      delete headers['content-length'];
    } else {
      if (headers['content-type'] === undefined && payloadLength) {
        headers['content-type'] = 'application/octet-stream';
      }
      if (headers['content-length'] === undefined) {
        headers['content-length'] = String(payloadLength);
      }
    }

    this.finished = true;
    this.headersSent = true;
    if (this.hooks.send) this.hooks.send(status, headers, bytes);
    if (this.hooks.finish) this.hooks.finish(status);
    return this;
  }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

class Router {
  constructor() {
    this.routes = [];
    this.wsRoutes = [];
    this.middlewares = [];
  }

  add(method, path, handler) {
    if (typeof handler !== 'function') {
      throw new ProxyError(method + ' ' + path + ' handler must be a function', {
        code: 'INVALID_HANDLER'
      });
    }
    const normalized = normalizePath(path);
    this.routes.push({
      method: method,
      path: normalized,
      matcher: compilePath(normalized),
      handler: handler
    });
    return this;
  }

  get(path, handler) { return this.add('GET', path, handler); }
  post(path, handler) { return this.add('POST', path, handler); }
  put(path, handler) { return this.add('PUT', path, handler); }
  patch(path, handler) { return this.add('PATCH', path, handler); }
  delete(path, handler) { return this.add('DELETE', path, handler); }
  head(path, handler) { return this.add('HEAD', path, handler); }
  options(path, handler) { return this.add('OPTIONS', path, handler); }
  all(path, handler) { return this.add('ALL', path, handler); }
  /** Convenience: register the same handler for every common method. */
  any(path, handler) {
    METHODS.forEach((method) => this.add(method, path, handler));
    return this;
  }

  ws(path, handler) {
    if (typeof handler !== 'function') {
      throw new ProxyError('ws ' + path + ' handler must be a function', {
        code: 'INVALID_HANDLER'
      });
    }
    const normalized = normalizePath(path);
    this.wsRoutes.push({
      path: normalized,
      matcher: compilePath(normalized),
      handler: handler
    });
    return this;
  }

  use(pathOrFn, fn) {
    let prefix = '';
    let handler = pathOrFn;
    if (typeof pathOrFn === 'string') {
      prefix = normalizePath(pathOrFn);
      handler = fn;
    }
    if (typeof handler !== 'function') {
      throw new ProxyError('middleware must be a function', { code: 'INVALID_MIDDLEWARE' });
    }
    this.middlewares.push({ path: prefix, fn: handler });
    return this;
  }

  list() {
    const http = this.routes.map((route) => ({ method: route.method, path: route.path }));
    const ws = this.wsRoutes.map((route) => ({ method: 'WS', path: route.path }));
    return http.concat(ws);
  }

  match(method, path) {
    const allowed = [];
    for (let i = 0; i < this.routes.length; i++) {
      const route = this.routes[i];
      const params = matchPath(route.matcher, path);
      if (!params) continue;
      const methodOk = route.method === 'ALL' || route.method === method ||
        (method === 'HEAD' && route.method === 'GET');
      if (methodOk) return { route: route, params: params };
      if (route.method !== 'ALL' && allowed.indexOf(route.method) === -1) {
        allowed.push(route.method);
      }
    }
    return { route: null, params: null, allowed: allowed };
  }

  matchWs(path) {
    for (let i = 0; i < this.wsRoutes.length; i++) {
      const route = this.wsRoutes[i];
      const params = matchPath(route.matcher, path);
      if (params) return { route: route, params: params };
    }
    return null;
  }

  allowHeader(allowed) {
    const methods = allowed.slice();
    if (methods.indexOf('GET') !== -1 && methods.indexOf('HEAD') === -1) methods.push('HEAD');
    if (methods.indexOf('OPTIONS') === -1) methods.push('OPTIONS');
    return methods.join(', ');
  }

  /**
   * Dispatch one request. `options`:
   *   authCheck(req) -> boolean | null   null/undefined means "no auth configured"
   *   maxBodySize, exposeErrors, emitError(error), onComplete(status)
   */
  handle(req, res, options) {
    const opts = options || {};
    const emitError = opts.emitError || function () {};

    if (req.method === 'OPTIONS') {
      const optionsMatch = this.match('OPTIONS', req.path);
      if (!optionsMatch.route) {
        res.status(204).end();
        return;
      }
      req.params = optionsMatch.params;
      const stack = this._stackFor(req, optionsMatch.route);
      this._runStack(stack, req, res, opts, emitError);
      return;
    }

    if (opts.authCheck && !opts.authCheck(req)) {
      res.set('www-authenticate', 'Bearer realm="dtns-agent"');
      res.status(401).json({
        ok: false,
        error: 'unauthorized',
        hint: 'Send Authorization: Bearer <token>' + (this.wsRoutes.length ? ', or use ?token= for browser WebSocket.' : '.')
      });
      return;
    }

    try {
      this.parseBody(req, opts.maxBodySize);
    } catch (error) {
      res.status(error.status || 400).json({
        ok: false,
        error: error.code || 'invalid_body'
      });
      return;
    }

    const found = this.match(req.method, req.path);
    if (!found.route) {
      if (found.allowed.length) {
        const allow = this.allowHeader(found.allowed);
        res.set('allow', allow);
        res.status(405).json({ ok: false, error: 'method_not_allowed', allow: allow });
      } else {
        res.status(404).json({
          ok: false,
          error: 'not_found',
          method: req.method,
          path: req.path
        });
      }
      return;
    }

    req.params = found.params;
    this._runStack(this._stackFor(req, found.route), req, res, opts, emitError);
  }

  _stackFor(req, route) {
    const stack = [];
    this.middlewares.forEach((middleware) => {
      if (matchesPrefix(req.path, middleware.path)) {
        stack.push({ fn: middleware.fn, isRoute: false });
      }
    });
    stack.push({ fn: route.handler, isRoute: true });
    return stack;
  }

  parseBody(req, maxBodySize) {
    const bytes = req.rawBody || new Uint8Array(0);
    if (maxBodySize && bytes.length > maxBodySize) {
      throw new ProxyError('payload too large', { code: 'payload_too_large', status: 413 });
    }
    if (!bytes.length) {
      req.body = undefined;
      return;
    }
    const type = String(req.get('content-type') || '');
    if (/application\/json/i.test(type)) {
      try { req.body = JSON.parse(textOf(bytes)); }
      catch (error) {
        throw new ProxyError('invalid JSON body', { code: 'invalid_json', status: 400 });
      }
    } else if (/application\/x-www-form-urlencoded/i.test(type)) {
      req.body = parseQuery('?' + textOf(bytes));
    } else if (/^text\//i.test(type)) {
      req.body = textOf(bytes);
    } else {
      req.body = bytes;
    }
  }

  _runStack(stack, req, res, opts, emitError) {
    let completed = false;

    const finish = function () {
      if (completed) return;
      completed = true;
      if (opts.onComplete) opts.onComplete(res.finished ? res.statusCode : 0);
    };

    const fail = function (error) {
      if (res.finished) { finish(); return; }
      const status = error && isValidStatus(error.status) ? error.status : 500;
      const code = error && error.code ? String(error.code) : (status === 500 ? 'internal_error' : 'error');
      const body = { ok: false, error: code };
      if (error && error.message && (opts.exposeErrors || status !== 500)) {
        body.message = String(error.message);
      }
      res.status(status).json(body);
      finish();
      emitError(error instanceof Error ? error : new ProxyError(String(error), {
        code: code, status: status
      }));
    };

    const sendAuto = function (response, value) {
      if (response.finished) return;
      if (value === undefined) { response.status(204).end(); return; }
      if (value === null) { response.json(null); return; }
      if (typeof value === 'string') { response.text(value); return; }
      if (value instanceof Uint8Array) { response.send(value); return; }
      response.json(value);
    };

    const run = (index) => {
      if (completed || res.finished) { finish(); return; }
      if (index >= stack.length) {
        if (!res.finished) res.status(204).end();
        finish();
        return;
      }

      const entry = stack[index];
      let called = false;

      const next = (error) => {
        if (called) return;
        called = true;
        if (res.finished) { finish(); return; }
        if (error) { fail(error); return; }
        run(index + 1);
      };

      let returned;
      try {
        returned = entry.fn(req, res, next);
      } catch (error) {
        if (!called) { called = true; fail(error); }
        return;
      }

      if (isPromise(returned)) {
        returned.then((value) => {
          if (res.finished) { finish(); return; }
          if (called) return;
          if (entry.isRoute && value !== undefined) {
            sendAuto(res, value);
            finish();
          } else {
            next();
          }
        }, (error) => {
          if (!called) { called = true; fail(error); }
        });
        return;
      }

      if (called) return;
      if (res.finished) { finish(); return; }
      if (entry.isRoute && returned !== undefined) {
        sendAuto(res, returned);
        finish();
      } else {
        next();
      }
    };

    run(0);
  }
}

module.exports = {
  Router: Router,
  Request: Request,
  Response: Response,
  METHODS: METHODS,
  // helpers exported for tests and for the agent layer
  utf8: utf8,
  textOf: textOf,
  normalizePath: normalizePath,
  parseQuery: parseQuery,
  lowerHeaders: lowerHeaders,
  headerValue: headerValue,
  compilePath: compilePath,
  matchPath: matchPath,
  matchesPrefix: matchesPrefix,
  isValidStatus: isValidStatus,
  isPromise: isPromise
};
