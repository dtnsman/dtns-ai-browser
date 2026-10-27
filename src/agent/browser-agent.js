/**
 * createBrowserAgent — assembles the browser agent on top of the proxy.
 *
 * Wiring only: pick up the persisted client id, derive the tunnel domain,
 * construct the proxy, build the browser services (tabs, debugger, screenshots,
 * network, console) and register the route table.
 */
'use strict';

const { createProxy } = require('../proxy/http-proxy');
const { ChromeAdapter } = require('./chrome-adapter');
const { ConfigStore } = require('./config-store');
const { TabBridge } = require('./tab-bridge');
const DebuggerHub = require('./debugger-hub');
const { NetworkMonitor } = require('./network-monitor');
const { ConsoleCollector } = require('./console-collector');
const { ScreenshotScheduler } = require('./screenshot-scheduler');
const { registerBrowserRoutes } = require('./routes');

const VERSION = '2.0.0';
const DOMAIN_SUFFIX = '.html.dtns.top';

/**
 * Tunnel domain labels are routed by the first label, and the production
 * `browser.*` label is still served by the v1.0 JSON proxy. The binary v2
 * tunnel lives under its own label, so this is the default for this agent.
 * Override with `options.domainPrefix` if the server deployment differs.
 */
const DEFAULT_DOMAIN_PREFIX = 'browser2';

/** <prefix>.<clientId>.html.dtns.top — the domain the tunnel server routes to. */
function browserDomain(clientId, prefix) {
  const label = String(prefix || DEFAULT_DOMAIN_PREFIX).replace(/\.+$/, '');
  return label + '.' + clientId + DOMAIN_SUFFIX;
}

/**
 * @param {object} [options]
 * @param {object} [options.chrome]        chrome API object (defaults to global chrome)
 * @param {string} [options.domain]        override the derived tunnel domain
 * @param {string} [options.domainPrefix]  first label of the tunnel domain (default "browser2")
 * @param {string} [options.wsUrl]         override the server URL
 * @param {string} [options.token]         require bearer auth on every request
 * @param {object} [options.WebSocket]     WebSocket implementation (defaults to global)
 * @param {number} [options.maxBodySize]   request body cap in bytes
 * @param {boolean}[options.exposeErrors]  include error messages in 5xx bodies
 * @param {number} [options.requestTimeout] content-script RPC timeout
 * @returns {Promise<object>} agent handle
 */
async function createBrowserAgent(options) {
  const opts = options || {};
  const chromeApi = opts.chrome || (typeof chrome !== 'undefined' ? chrome : null);
  if (!chromeApi) {
    throw new Error('createBrowserAgent requires a chrome API object (or run inside an extension)');
  }

  const adapter = new ChromeAdapter(chromeApi, { protocolVersion: opts.protocolVersion });
  // Only forward wsUrl when the caller actually set one. Passing
  // `{ wsServerUrl: undefined }` would overwrite ConfigStore's default with
  // undefined (Object.assign copies own properties even when the value is
  // undefined), which in turn made reset() persist an unusable server URL.
  const configDefaults = {};
  if (opts.wsUrl !== undefined && opts.wsUrl !== null && opts.wsUrl !== '') {
    configDefaults.wsServerUrl = opts.wsUrl;
  }
  const config = new ConfigStore(adapter, configDefaults);
  const cfg = await config.load();

  const clientId = cfg.clientId;
  const domainPrefix = opts.domainPrefix || DEFAULT_DOMAIN_PREFIX;
  const domain = opts.domain || browserDomain(clientId, domainPrefix);

  const app = createProxy({
    domain: domain,
    clientId: clientId,
    wsUrl: opts.wsUrl || cfg.wsServerUrl,
    WebSocket: opts.WebSocket,
    token: opts.token,
    exposeErrors: opts.exposeErrors,
    maxBodySize: opts.maxBodySize,
    heartbeatInterval: opts.heartbeatInterval,
    heartbeatTimeout: opts.heartbeatTimeout,
    reconnect: opts.reconnect,
    description: opts.description || '浏览器控制Agent - 内置HTTP代理',
    domainFactory: (id) => browserDomain(id, domainPrefix)
  });

  const bridge = new TabBridge(adapter, {
    timeout: opts.requestTimeout === undefined ? 8000 : opts.requestTimeout,
    injectFile: opts.injectFile || 'content-script.js',
    allowInject: opts.allowInject !== false
  });

  const hub = new DebuggerHub(adapter, { protocolVersion: opts.protocolVersion });
  const screenshot = new ScreenshotScheduler(adapter, opts.screenshot || {});
  const network = new NetworkMonitor(hub, opts.network || {});
  const consoleCollector = new ConsoleCollector(hub, opts.console || {});

  const controls = {
    rebind: async (patch) => {
      const next = Object.assign({}, patch);
      if (next.clientId && !next.wsUrl) next.wsUrl = app.wsUrl;
      return app.rebind(next);
    },
    reconnect: () => app.reconnect(),
    domainFor: (clientId) => browserDomain(clientId || app.clientId, domainPrefix)
  };

  registerBrowserRoutes(app, {
    adapter: adapter,
    config: config,
    bridge: bridge,
    screenshot: screenshot,
    network: network,
    consoleCollector: consoleCollector,
    hub: hub,
    controls: controls,
    version: VERSION
  });

  const agent = {
    version: VERSION,
    app: app,
    adapter: adapter,
    config: config,
    bridge: bridge,
    hub: hub,
    screenshot: screenshot,
    network: network,
    consoleCollector: consoleCollector,
    domain: domain,
    clientId: clientId,

    listen() {
      return app.listen();
    },

    status() {
      return Object.assign(app.status(), {
        version: VERSION,
        monitors: network.status().activeMonitors || [],
        debugger: hub.status()
      });
    },

    async close() {
      await network.stopAll().catch(() => {});
      await hub.dispose().catch(() => {});
      app.close();
    }
  };

  return agent;
}

module.exports = {
  createBrowserAgent,
  browserDomain,
  VERSION,
  DOMAIN_SUFFIX,
  DEFAULT_DOMAIN_PREFIX
};
