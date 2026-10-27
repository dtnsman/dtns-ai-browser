/**
 * ChromeAdapter — the only place in the codebase that touches `chrome.*`.
 *
 * The legacy `background.js` called `chrome.*` from inside route handlers, so
 * no route could be exercised without a real browser. Everything below is
 * injectable: production passes the global `chrome`, tests pass
 * `test/support/mock-chrome.js`.
 */
'use strict';

const { ProxyError } = require('../util/primitives');

/**
 * Call a chrome API method that may be callback-based (MV2 style) or
 * promise-based (MV3 style) and always get a promise back.
 */
function invoke(api, fn, thisArg, args) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (fn2, value) => {
      if (settled) return;
      settled = true;
      fn2(value);
    };

    const callback = (result) => {
      const lastError = api && api.runtime && api.runtime.lastError;
      if (lastError) {
        settle(reject, new ProxyError(lastError.message || String(lastError), {
          code: 'CHROME_API_ERROR'
        }));
        return;
      }
      settle(resolve, result);
    };

    let returned;
    try {
      returned = fn.apply(thisArg, args.concat([callback]));
    } catch (error) {
      settle(reject, error);
      return;
    }

    if (returned && typeof returned.then === 'function') {
      returned.then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error)
      );
      return;
    }

    if (returned !== undefined) {
      // A handful of chrome.* getters answer synchronously.
      settle(resolve, returned);
      return;
    }

    // Everything else is callback-style: `chrome.tabs.query(info, cb)` returns
    // undefined and answers later. Resolving here on the assumption that
    // "fn.length <= args.length means synchronous" is wrong — Chrome reports
    // one argument for tabs.query, which previously made every tab lookup
    // resolve as undefined.
  });
}

function requireArea(api, name) {
  if (!api || !api[name]) {
    throw new ProxyError('chrome.' + name + ' is not available in this context', {
      code: 'CHROME_AREA_MISSING',
      status: 501
    });
  }
  return api[name];
}

class ChromeAdapter {
  constructor(api, options) {
    if (!api) throw new ProxyError('chrome API object is required', { code: 'NO_CHROME' });
    this.api = api;
    this.options = options || {};
  }

  get available() { return !!this.api; }

  has(area) {
    return !!(this.api && this.api[area]);
  }

  /* ==================== tabs ==================== */

  async query(queryInfo) {
    const tabs = requireArea(this.api, 'tabs');
    return invoke(this.api, tabs.query, tabs, [queryInfo || {}]);
  }

  async get(tabId) {
    const tabs = requireArea(this.api, 'tabs');
    return invoke(this.api, tabs.get, tabs, [tabId]);
  }

  async create(props) {
    const tabs = requireArea(this.api, 'tabs');
    return invoke(this.api, tabs.create, tabs, [props || {}]);
  }

  async update(tabId, props) {
    const tabs = requireArea(this.api, 'tabs');
    return invoke(this.api, tabs.update, tabs, [tabId, props || {}]);
  }

  async remove(tabIds) {
    const tabs = requireArea(this.api, 'tabs');
    return invoke(this.api, tabs.remove, tabs, [tabIds]);
  }

  async reload(tabId, bypassCache) {
    const tabs = requireArea(this.api, 'tabs');
    return invoke(this.api, tabs.reload, tabs, [tabId, { bypassCache: !!bypassCache }]);
  }

  async sendMessage(tabId, message) {
    const tabs = requireArea(this.api, 'tabs');
    return invoke(this.api, tabs.sendMessage, tabs, [tabId, message]);
  }

  async captureVisibleTab(windowId, options) {
    const tabs = requireArea(this.api, 'tabs');
    return invoke(this.api, tabs.captureVisibleTab, tabs, [windowId, options || {}]);
  }

  /* ==================== windows / storage / scripting ==================== */

  async getAllWindows(options) {
    const windows = requireArea(this.api, 'windows');
    return invoke(this.api, windows.getAll, windows, [options || {}]);
  }

  async createWindow(props) {
    const windows = requireArea(this.api, 'windows');
    return invoke(this.api, windows.create, windows, [props || {}]);
  }

  async updateWindow(windowId, props) {
    const windows = requireArea(this.api, 'windows');
    return invoke(this.api, windows.update, windows, [windowId, props || {}]);
  }

  async storageGet(keys) {
    const storage = requireArea(this.api, 'storage');
    const local = storage.local || storage;
    return invoke(this.api, local.get, local, [keys]);
  }

  async storageSet(items) {
    const storage = requireArea(this.api, 'storage');
    const local = storage.local || storage;
    return invoke(this.api, local.set, local, [items]);
  }

  async executeScript(injection) {
    const scripting = requireArea(this.api, 'scripting');
    return invoke(this.api, scripting.executeScript, scripting, [injection]);
  }

  /* ==================== debugger ==================== */

  async attachDebugger(target, version) {
    const debuggerApi = requireArea(this.api, 'debugger');
    return invoke(this.api, debuggerApi.attach, debuggerApi, [target, version || '1.3']);
  }

  async detachDebugger(target) {
    const debuggerApi = requireArea(this.api, 'debugger');
    return invoke(this.api, debuggerApi.detach, debuggerApi, [target]);
  }

  async sendDebuggerCommand(target, method, params) {
    const debuggerApi = requireArea(this.api, 'debugger');
    return invoke(this.api, debuggerApi.sendCommand, debuggerApi, [target, method, params || {}]);
  }

  onDebuggerEvent(listener) {
    const debuggerApi = requireArea(this.api, 'debugger');
    if (debuggerApi.onEvent && debuggerApi.onEvent.addListener) debuggerApi.onEvent.addListener(listener);
  }

  offDebuggerEvent(listener) {
    const debuggerApi = this.api && this.api.debugger;
    if (debuggerApi && debuggerApi.onEvent && debuggerApi.onEvent.removeListener) {
      debuggerApi.onEvent.removeListener(listener);
    }
  }

  onDebuggerDetach(listener) {
    const debuggerApi = requireArea(this.api, 'debugger');
    if (debuggerApi.onDetach && debuggerApi.onDetach.addListener) debuggerApi.onDetach.addListener(listener);
  }

  offDebuggerDetach(listener) {
    const debuggerApi = this.api && this.api.debugger;
    if (debuggerApi && debuggerApi.onDetach && debuggerApi.onDetach.removeListener) {
      debuggerApi.onDetach.removeListener(listener);
    }
  }
}

module.exports = { ChromeAdapter, invoke };
