/**
 * TabBridge — content-script RPC with injection fallback.
 *
 * The legacy `sendToActiveTab` did a `ping` round trip before every real
 * message, always slept 100ms waiting for tab metadata, and then had a second
 * 500ms sleep after injection. Here the happy path is a single round trip and
 * injection is only attempted after a genuine connection failure.
 */
'use strict';

const { ProxyError } = require('../util/primitives');

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-search://',
  'chrome-untrusted://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com'
];

function isRestrictedUrl(url) {
  const value = String(url || '').toLowerCase();
  return RESTRICTED_PREFIXES.some((prefix) => value.indexOf(prefix) === 0);
}

function withTimeout(promise, ms, message) {
  if (!ms) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProxyError(message || 'request timeout', { code: 'TAB_TIMEOUT', status: 504 }));
    }, ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

class TabBridge {
  constructor(adapter, options) {
    const opts = options || {};
    this.adapter = adapter;
    this.timeout = opts.timeout === undefined ? 8000 : opts.timeout;
    this.injectFile = opts.injectFile || 'content-script.js';
    this.injectDelay = opts.injectDelay === undefined ? 300 : opts.injectDelay;
    this.allowInject = opts.allowInject !== false;
  }

  async activeTab() {
    let tabs = [];
    try {
      tabs = await this.adapter.query({ active: true, currentWindow: true });
    } catch (error) {
      tabs = [];
    }
    if (tabs && tabs.length && tabs[0] && tabs[0].id !== undefined) return tabs[0];

    // Fall back to the active tab of any window (legacy did the same, but only
    // after a fixed 100ms sleep; querying is cheap so we just do it).
    try {
      const windows = await this.adapter.getAllWindows({ populate: true });
      for (const window of windows || []) {
        const active = (window.tabs || []).find((tab) => tab.active);
        if (active) return active;
      }
    } catch (error) { /* no windows area available */ }

    // Last resort: a service worker has no "current window", and a minimised
    // browser can report no focused window at all. Rather than failing every
    // page endpoint, fall back to any active tab and then to the first tab.
    try {
      const all = (await this.adapter.query({})) || [];
      const active = all.find((tab) => tab.active);
      if (active) return active;
      if (all.length) return all[0];
    } catch (error) { /* keep null */ }

    return null;
  }

  /**
   * Send a content-script message.
   * @returns {Promise<object>} always resolves — `{success:false, error}` on failure,
   *   mirroring the legacy contract that route handlers rely on.
   */
  async send(message, options) {
    const opts = options || {};
    let tab = opts.tab || null;

    if (!tab && opts.tabId !== undefined && opts.tabId !== null) {
      try {
        tab = await this.adapter.get(opts.tabId);
      } catch (error) {
        tab = null;
      }
    }
    if (!tab) tab = await this.activeTab();

    if (!tab || tab.id === undefined || tab.id === null) {
      return { success: false, error: 'No active tab found', code: 'NO_ACTIVE_TAB' };
    }

    if (isRestrictedUrl(tab.url)) {
      return {
        success: false,
        error: 'Cannot access this page type',
        code: 'RESTRICTED_PAGE',
        url: tab.url
      };
    }

    const timeout = opts.timeout === undefined ? this.timeout : opts.timeout;

    try {
      const response = await withTimeout(
        this.adapter.sendMessage(tab.id, message),
        timeout,
        'content script timeout for ' + (message && message.action)
      );
      return this._normalize(response);
    } catch (error) {
      if (!this._looksDisconnected(error)) {
        return { success: false, error: error.message, code: error.code || 'TAB_MESSAGE_FAILED' };
      }
    }

    if (!this.allowInject) {
      return {
        success: false,
        error: 'content script is not available',
        code: 'CONTENT_SCRIPT_MISSING'
      };
    }

    // Inject once, wait briefly for init, retry once. No unbounded retry loop.
    try {
      await this.adapter.executeScript({
        target: { tabId: tab.id },
        files: [this.injectFile]
      });
      if (this.injectDelay) await sleep(this.injectDelay);
      const response = await withTimeout(
        this.adapter.sendMessage(tab.id, message),
        timeout,
        'content script timeout after injection'
      );
      return this._normalize(response);
    } catch (error) {
      return {
        success: false,
        error: error.message,
        code: error.code || 'CONTENT_SCRIPT_INJECT_FAILED',
        needsReload: true
      };
    }
  }

  _normalize(response) {
    if (response && typeof response === 'object') {
      if (response.error) return Object.assign({ success: false }, response);
      if (response.success === undefined) return Object.assign({ success: true }, response);
      return response;
    }
    if (response === undefined || response === null) return { success: true };
    return { success: true, result: response };
  }

  _looksDisconnected(error) {
    if (!error) return false;
    if (error.code === 'TAB_TIMEOUT') return false;
    const message = String(error.message || '');
    return /Could not establish connection|Receiving end does not exist|message channel closed|Extension context invalidated/i
      .test(message);
  }
}

module.exports = { TabBridge, isRestrictedUrl, withTimeout, RESTRICTED_PREFIXES };
