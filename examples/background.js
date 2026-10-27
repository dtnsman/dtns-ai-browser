/**
 * examples/background.js — MV3 service worker entry using the refactored proxy.
 *
 * Drop `dist/dtns-browser-proxy.mjs` into the extension folder, point the
 * manifest at this file as the service worker, and the tunnel comes up with
 * the same 69 endpoints the legacy plugin exposed.
 *
 * manifest.json (relevant parts):
 *
 *   {
 *     "background": { "service_worker": "background.js", "type": "module" },
 *     "permissions": ["tabs", "storage", "scripting", "debugger", "clipboardRead",
 *                     "clipboardWrite", "webNavigation", "activeTab"],
 *     "host_permissions": ["<all_urls>"]
 *   }
 */
import { createBrowserAgent } from '../dist/dtns-browser-proxy.mjs';

let agent = null;
let starting = null;

/**
 * Service workers can be woken by any event, so start-up must be idempotent:
 * concurrent callers share one promise and never open two tunnels.
 */
function startAgent() {
  if (agent) return Promise.resolve(agent);
  if (starting) return starting;

  starting = createBrowserAgent({
    // Optional: require "Authorization: Bearer <token>" on every request.
    token: '',
    // Surface handler error messages in 5xx bodies while developing.
    exposeErrors: false,
    // Increase if you proxy large uploads through /api/script/evaluate.
    maxBodySize: 1024 * 1024
  }).then(async (instance) => {
    instance.app.on('listening', () => {
      console.log('[dtns] tunnel registered:', instance.app.apiBase);
    });
    instance.app.on('reconnected', () => {
      console.log('[dtns] tunnel reconnected');
    });
    instance.app.on('disconnected', (info) => {
      console.warn('[dtns] tunnel disconnected', info);
    });
    instance.app.on('error', (error) => {
      console.error('[dtns] tunnel error', error.code, error.message);
    });
    instance.app.on('request', (info) => {
      console.log('[dtns]', info.method, info.path, info.status, info.ms + 'ms');
    });

    await instance.listen();
    agent = instance;
    return instance;
  });

  return starting;
}

chrome.runtime.onInstalled.addListener(() => { startAgent(); });
chrome.runtime.onStartup.addListener(() => { startAgent(); });

// Start eagerly; MV3 will restart the worker once the tunnel drops.
startAgent().catch((error) => {
  console.error('[dtns] failed to start tunnel:', error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'dtns:status') {
    startAgent()
      .then((instance) => sendResponse({ ok: true, status: instance.status() }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // async response
  }
  return false;
});
