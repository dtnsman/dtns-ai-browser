/**
 * Builds the `api.json` document that the agent serves on `/api.json` (and the
 * `/apis` alias).
 *
 * Design constraints:
 *   - The document is generated per request. `apiBase` follows the live tunnel
 *     domain, which changes when the user rebinds the clientId, so a cached or
 *     committed copy would advertise a dead URL.
 *   - The token is never embedded. Only `auth.required` is exposed, which is
 *     enough for a caller to know it must ask the user for a bearer token.
 *   - The shape is a flat catalog rather than OpenAPI: every endpoint is a GET
 *     with query parameters, and the payload is meant to be read by an LLM's
 *     tool-planner, not by a code generator. A `groups` view is included
 *     because planners pick tools by task area far more often than by path.
 */
'use strict';

const { API_CATALOG, API_ALIASES, DISCOVERY_PATHS, GROUP_ORDER } = require('./api-catalog');

const SCHEMA_VERSION = 1;
const DEFAULT_NAME = 'DTNS Browser Proxy';

/** Catalog params are an object keyed by name; the wire format is an array. */
function normalizeParams(params) {
  if (!params) return [];
  return Object.keys(params).map((name) => Object.assign({ name: name }, params[name]));
}

function toPublicEndpoint(entry) {
  const out = {
    method: entry.method,
    path: entry.path,
    group: entry.group,
    summary: entry.summary,
    readOnly: !!entry.readOnly,
    params: normalizeParams(entry.params)
  };
  if (entry.danger) out.danger = true;
  return out;
}

function groupEndpoints(endpoints) {
  const known = GROUP_ORDER.slice();
  // Anything a future route adds without a catalog entry still shows up, at the
  // end, instead of disappearing from the document.
  endpoints.forEach((entry) => {
    if (known.indexOf(entry.group) === -1) known.push(entry.group);
  });

  return known
    .map((name) => ({
      name: name,
      endpoints: endpoints.filter((entry) => entry.group === name).map(toPublicEndpoint)
    }))
    .filter((group) => group.endpoints.length > 0);
}

function summarize(endpoints) {
  return {
    endpoints: endpoints.length,
    groups: groupEndpoints(endpoints).length,
    readOnly: endpoints.filter((entry) => entry.readOnly).length,
    mutating: endpoints.filter((entry) => !entry.readOnly).length,
    dangerous: endpoints.filter((entry) => entry.danger).length
  };
}

/**
 * @param {object} options
 * @param {object} options.app       HttpProxyApp (uses apiBase / clientId / token)
 * @param {string} [options.version] agent version
 * @param {string} [options.name]
 * @param {Array}  [options.catalog] override the endpoint table (tests)
 * @returns {object} JSON-serialisable document
 */
function buildApiDoc(options) {
  const opts = options || {};
  const app = opts.app || {};
  const catalog = opts.catalog || API_CATALOG;
  const apiBase = app.apiBase || 'http://localhost';
  const endpoints = catalog.map((entry) => Object.assign({ method: 'GET' }, entry));

  return {
    schemaVersion: SCHEMA_VERSION,
    name: opts.name || DEFAULT_NAME,
    version: opts.version || '2.0.0',
    description:
      '把用户本机已登录的 Chrome 变成公网 HTTP API。所有端点通过 DTNS 二进制隧道转发到浏览器扩展，' +
      '浏览器标签页必须保持打开；页面相关的端点作用在当前激活标签页上。',
    apiBase: apiBase,
    clientId: app.clientId || '',
    generatedAt: new Date().toISOString(),

    transport: {
      protocol: 'dtns/2',
      methods: ['GET', 'HEAD', 'OPTIONS'],
      contentType: 'application/json; charset=utf-8',
      cors: 'Access-Control-Allow-Origin: *',
      responseHeader: 'X-Tunnel-Version: dtns/2',
      sse: false,
      websocketRoutes: false
    },

    auth: {
      required: !!(app.token),
      scheme: 'bearer',
      header: 'Authorization: Bearer <token>',
      queryParam: '?token=<token>',
      publicPaths: DISCOVERY_PATHS.slice()
    },

    conventions: {
      params: '全部参数走查询字符串（?a=1）；若同时传 JSON body，查询字符串优先。布尔值接受 true/false/1/0/yes/no。',
      envelope: {
        success: '{ "success": true, ... }',
        businessError: '{ "success": false, "error": "<message>" }（HTTP 仍为 200）',
        proxyError: '{ "ok": false, "error": "<code>" }（404 / 405 / 401 / 400 / 413 / 500）'
      },
      errorCodes: [
        'not_found',
        'method_not_allowed',
        'unauthorized',
        'invalid_json',
        'payload_too_large',
        'internal_error'
      ],
      limits: {
        requestBodyBytes: 1024 * 1024,
        note: '响应经单帧传输，上限 32 MiB'
      },
      flags: {
        readOnly: '无副作用，可安全重试或批量调用',
        danger: '执行任意代码或改变隧道域名，调用前应先与用户确认'
      }
    },

    aliases: API_ALIASES.slice(),
    stats: summarize(endpoints),
    groups: groupEndpoints(endpoints),
    endpoints: endpoints.map(toPublicEndpoint),

    examples: [
      'curl "' + apiBase + '/api/page/visible-text"',
      'curl "' + apiBase + '/api/screenshot2?quality=80"',
      'curl "' + apiBase + '/api/click?selector=%23submit"'
    ]
  };
}

module.exports = {
  buildApiDoc,
  normalizeParams,
  SCHEMA_VERSION
};
