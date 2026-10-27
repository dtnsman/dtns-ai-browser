/**
 * Public entry point for the DTNS browser proxy.
 *
 * Two usage levels:
 *
 *   const { createProxy } = require('dtns-browser-proxy');
 *   const app = createProxy({ domain: 'my-agent.html.dtns.top' });
 *   app.get('/hello', () => ({ ok: true }));
 *   await app.listen();
 *
 * or, inside a browser extension:
 *
 *   const { createBrowserAgent } = require('dtns-browser-proxy');
 *   const agent = await createBrowserAgent();
 *   await agent.listen();
 */
'use strict';

const Protocol = require('./protocol/dtns-protocol');
const TunnelTransport = require('./proxy/transport');
const WsConnection = require('./proxy/websocket');
const { HttpProxyApp, createProxy, DEFAULT_CORS } = require('./proxy/http-proxy');
const router = require('./proxy/router');
const { ProxyError, Emitter } = require('./util/primitives');

const { ChromeAdapter } = require('./agent/chrome-adapter');
const { ConfigStore, generateClientId, isValidClientId } = require('./agent/config-store');
const { TabBridge, isRestrictedUrl } = require('./agent/tab-bridge');
const DebuggerHub = require('./agent/debugger-hub');
const { NetworkMonitor, summarize } = require('./agent/network-monitor');
const { ConsoleCollector, formatRemoteObject } = require('./agent/console-collector');
const { ScreenshotScheduler } = require('./agent/screenshot-scheduler');
const { sniffImage, base64ByteLength } = require('./agent/image-info');
const { registerBrowserRoutes } = require('./agent/routes');
const { createBrowserAgent, browserDomain, DEFAULT_DOMAIN_PREFIX } = require('./agent/browser-agent');

module.exports = {
  version: '2.0.0',

  // proxy
  createProxy: createProxy,
  HttpProxyApp: HttpProxyApp,
  TunnelTransport: TunnelTransport,
  Router: router.Router,
  Request: router.Request,
  Response: router.Response,
  WsConnection: WsConnection,
  DEFAULT_CORS: DEFAULT_CORS,

  // protocol
  Protocol: Protocol,

  // primitives
  ProxyError: ProxyError,
  Emitter: Emitter,

  // browser agent
  createBrowserAgent: createBrowserAgent,
  browserDomain: browserDomain,
  DEFAULT_DOMAIN_PREFIX: DEFAULT_DOMAIN_PREFIX,
  registerBrowserRoutes: registerBrowserRoutes,
  ChromeAdapter: ChromeAdapter,
  ConfigStore: ConfigStore,
  generateClientId: generateClientId,
  isValidClientId: isValidClientId,
  TabBridge: TabBridge,
  isRestrictedUrl: isRestrictedUrl,
  DebuggerHub: DebuggerHub,
  NetworkMonitor: NetworkMonitor,
  summarize: summarize,
  ConsoleCollector: ConsoleCollector,
  formatRemoteObject: formatRemoteObject,
  ScreenshotScheduler: ScreenshotScheduler,
  sniffImage: sniffImage,
  base64ByteLength: base64ByteLength
};
