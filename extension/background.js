/**
 * background.js — MV3 service worker entry for the AI灵驹 extension.
 *
 * Wires the refactored DTNS proxy to Chrome:
 *   - starts the tunnel (69 HTTP endpoints under <prefix>.<clientId>.html.dtns.top)
 *   - keeps the existing popup working (getConnectionStatus / getConfig / ...)
 *   - keeps the content script's screenshot bridge (`capture_tab`)
 *   - keeps the Alt+S smart-select command
 *
 * The bundle is vendored by `npm run build`; do not edit it by hand.
 */
import { createBrowserAgent } from './vendor/dtns-browser-proxy.js';

/**
 * First label of the tunnel domain. The production `browser.*` label is still
 * served by the v1.0 JSON proxy, so the binary v2 tunnel must use its own
 * label. Change this single constant if the deployment uses another one.
 */
const DOMAIN_PREFIX = 'browser2';

/** @type {object|null} */
let agent = null;
let starting = null;

function startAgent() {
  if (agent) return Promise.resolve(agent);
  if (starting) return starting;

  starting = createBrowserAgent({
    domainPrefix: DOMAIN_PREFIX,
    // Leave empty to accept unauthenticated requests (legacy behaviour).
    // Set a token and call with `Authorization: Bearer <token>` in production.
    token: '',
    exposeErrors: false,
    maxBodySize: 1024 * 1024
  })
    .then(async (instance) => {
      instance.app.on('listening', () => {
        console.log('[DTNS] 隧道已注册:', instance.app.apiBase);
      });
      instance.app.on('reconnected', () => {
        console.log('[DTNS] 隧道已重连');
      });
      instance.app.on('disconnected', (info) => {
        console.warn('[DTNS] 隧道断开:', info.code, info.reason, 'willRetry=' + info.willRetry);
      });
      instance.app.on('error', (error) => {
        console.error('[DTNS] 隧道错误:', error.code, error.message);
      });

      await instance.listen();
      agent = instance;
      return instance;
    })
    .catch((error) => {
      // Allow a later message/event to retry instead of caching the failure.
      starting = null;
      throw error;
    });

  return starting;
}

function dataUrl(format, base64) {
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  return 'data:' + mime + ';base64,' + base64;
}

/* ==================== popup / content-script messages ==================== */

async function getConnectionStatus() {
  const instance = await startAgent();
  const cfg = await instance.config.load();
  const status = instance.app.status();
  const domain = instance.app.domain;
  return {
    connected: status.connected,
    clientId: cfg.clientId,
    browserDomain: domain,
    registered: status.registered,
    registeredDomains: status.registered ? [domain] : [],
    wsServerUrl: cfg.wsServerUrl,
    serverVersion: status.serverVersion
  };
}

async function applyClientId(clientId) {
  const instance = await startAgent();
  const saved = await instance.config.save({ clientId: String(clientId) });
  // Reply first, rebind second: the rebind replaces the socket carrying our
  // own popup, and the popup only needs the new id.
  const domain = await instance.app.rebind({ clientId: saved.clientId });
  return { clientId: saved.clientId, domain: domain };
}

async function applyServerUrl(url) {
  const instance = await startAgent();
  const saved = await instance.config.save({ wsServerUrl: String(url) });
  await instance.app.rebind({ wsUrl: saved.wsServerUrl });
  return { wsServerUrl: saved.wsServerUrl };
}

async function resetAll() {
  const instance = await startAgent();
  const saved = await instance.config.reset();
  await instance.app.rebind({ clientId: saved.clientId, wsUrl: saved.wsServerUrl });
  return saved;
}

async function captureTab(request, sender) {
  const instance = await startAgent();
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  const result = await instance.screenshot.capture({
    tabId: tabId,
    format: request.format === 'png' ? 'png' : 'jpeg',
    quality: request.quality,
    forceRefresh: request.forceRefresh === true
  });
  if (!result.success) return { error: result.error || 'Failed to capture screenshot' };
  return { success: true, imageData: dataUrl(result.format, result.imageData) };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request && request.action;
  if (!action) return false;

  const reply = (promise) => {
    promise
      .then((payload) => sendResponse(Object.assign({ success: true }, payload || {})))
      .catch((error) => {
        console.error('[DTNS] 处理消息失败:', action, error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // async response
  };

  switch (action) {
    case 'getConnectionStatus':
      getConnectionStatus().then(sendResponse, (error) => {
        sendResponse({ connected: false, error: error.message });
      });
      return true;

    case 'getConfig':
      startAgent()
        .then((instance) => instance.config.load())
        .then((cfg) => sendResponse({
          clientId: cfg.clientId,
          wsServerUrl: cfg.wsServerUrl,
          autoReconnect: cfg.autoReconnect
        }), (error) => sendResponse({ error: error.message }));
      return true;

    case 'setClientId':
      return reply(applyClientId(request.clientId));

    case 'generateNewClientId':
      return reply(resetAll().then((saved) => ({ clientId: saved.clientId })));

    case 'setServerUrl':
      return reply(applyServerUrl(request.url));

    case 'resetConfig':
      return reply(resetAll());

    case 'reconnect':
      return reply(startAgent().then((instance) => instance.app.reconnect()).then(() => ({})));

    case 'capture_tab':
      return reply(captureTab(request, sender));

    case 'dtns:status':
      return reply(startAgent().then((instance) => instance.status()));

    default:
      return false;
  }
});

/* ==================== commands & lifecycle ==================== */

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'start-smart-reply') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'startSmartSelect' })
      .catch((error) => console.log('[DTNS] 无法发送 startSmartSelect:', error.message));
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[DTNS] 扩展已安装');
  startAgent().catch((error) => console.error('[DTNS] 启动失败:', error));
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[DTNS] 浏览器启动');
  startAgent().catch((error) => console.error('[DTNS] 启动失败:', error));
});

// Eager start: the worker is also woken by the events above.
startAgent().catch((error) => console.error('[DTNS] 启动失败:', error));
