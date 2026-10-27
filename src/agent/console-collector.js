/**
 * ConsoleCollector — CDP console capture and script evaluation.
 *
 * Same shape as the legacy `consoleCollectors` map but with deterministic
 * teardown: listeners and the debugger attachment are always released by
 * `stop()`, and `exec()` captures only the output produced by that evaluation.
 */
'use strict';

const { ProxyError } = require('../util/primitives');

const LEVEL_ALIASES = {
  warning: 'warn',
  error: 'error',
  assert: 'error',
  log: 'log',
  info: 'info',
  debug: 'debug',
  trace: 'trace',
  dir: 'log',
  table: 'log',
  group: 'log',
  groupCollapsed: 'log',
  endGroup: 'log'
};

const MAX_LOGS_PER_TAB = 500;

function formatRemoteObject(arg) {
  if (!arg) return '';
  if (arg.value !== undefined) {
    if (typeof arg.value === 'string') return arg.value;
    try { return JSON.stringify(arg.value); }
    catch (error) { return String(arg.value); }
  }
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
  return arg.description !== undefined ? String(arg.description) : String(arg.type);
}

function normalizeLevel(type) {
  return LEVEL_ALIASES[type] || String(type || 'log');
}

class ConsoleCollector {
  constructor(hub, options) {
    const opts = options || {};
    this.hub = hub;
    this.maxLogs = opts.maxLogs || MAX_LOGS_PER_TAB;
    this.collectors = new Map(); // tabId -> state
  }

  async start(tabId, duration) {
    if (tabId === undefined || tabId === null) {
      throw new ProxyError('tabId is required', { code: 'MISSING_TAB_ID', status: 400 });
    }

    if (this.collectors.has(tabId)) await this.stop(tabId);

    const handle = await this.hub.acquire(tabId);
    await this.hub.enable(handle, 'Runtime');

    const state = {
      tabId: tabId,
      handle: handle,
      logs: [],
      startedAt: Date.now(),
      duration: duration === undefined ? 0 : duration,
      timer: null,
      enabled: true,
      unsubscribe: null
    };

    state.unsubscribe = handle.onEvent((method, params) => {
      this._onEvent(state, method, params);
    });

    this.collectors.set(tabId, state);

    if (state.duration > 0) {
      state.timer = setTimeout(() => {
        state.timer = null;
        this.stop(tabId).catch(() => {});
      }, state.duration);
      if (state.timer.unref) state.timer.unref();
    }

    return {
      success: true,
      message: state.duration > 0
        ? 'Console collection started for ' + state.duration + 'ms'
        : 'Console collection started (manual stop)',
      tabId: tabId,
      duration: state.duration
    };
  }

  async stop(tabId) {
    const state = this.collectors.get(tabId);
    if (!state) {
      return { success: true, message: 'No active collector', tabId: tabId, logs: this.logs({ tabId: tabId }) };
    }

    state.enabled = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.unsubscribe) state.unsubscribe();
    this.collectors.delete(tabId);
    await state.handle.release();

    return {
      success: true,
      tabId: tabId,
      logs: state.logs,
      total: state.logs.length,
      duration: Date.now() - state.startedAt
    };
  }

  logs(options) {
    const opts = options || {};
    const scopedTab = opts.tabId !== undefined && opts.tabId !== null ? Number(opts.tabId) : null;
    let items = [];

    if (scopedTab !== null) {
      const state = this.collectors.get(scopedTab);
      items = state ? state.logs.slice() : [];
    } else {
      this.collectors.forEach((state) => { items = items.concat(state.logs); });
    }

    if (opts.level) {
      const level = normalizeLevel(opts.level);
      items = items.filter((item) => item.level === level);
    }

    const limit = opts.limit === undefined ? 100 : Math.max(0, parseInt(opts.limit, 10) || 0);
    if (limit) items = items.slice(-limit);

    // `clear` drains the buffers it just read, which is what the legacy API
    // documented and what callers rely on to avoid duplicate polling.
    if (opts.clear) this.clear(scopedTab);

    return items;
  }

  clear(tabId) {
    if (tabId === undefined || tabId === null) {
      this.collectors.forEach((state) => { state.logs = []; });
      return { success: true, message: 'All console logs cleared' };
    }
    const state = this.collectors.get(Number(tabId));
    if (state) state.logs = [];
    return { success: true, message: 'Console logs cleared', tabId: Number(tabId) };
  }

  status() {
    return {
      success: true,
      activeCollectors: Array.from(this.collectors.values()).map((state) => ({
        tabId: state.tabId,
        enabled: state.enabled,
        logs: state.logs.length,
        elapsed: Date.now() - state.startedAt
      }))
    };
  }

  /**
   * Evaluate an expression in the page and return its value plus everything
   * logged while it ran.
   */
  async exec(tabId, code, options) {
    const opts = options || {};
    if (!code || !String(code).trim()) {
      throw new ProxyError('code is required', { code: 'MISSING_CODE', status: 400 });
    }

    const handle = await this.hub.acquire(tabId);
    const captured = [];
    let unsubscribe = null;

    try {
      await this.hub.enable(handle, 'Runtime');
      // If a collector already runs for this tab we still get the evaluation
      // output, but we must not duplicate appends: collect locally only.
      unsubscribe = handle.onEvent((method, params) => {
        if (method === 'Runtime.consoleAPICalled') {
          captured.push(this._entry(params));
        }
      });

      const response = await handle.evaluate(String(code), {
        awaitPromise: opts.awaitPromise !== false,
        returnByValue: true
      });

      const result = response && response.result;
      let value;
      let errorText = null;

      if (response && response.exceptionDetails) {
        errorText = response.exceptionDetails.text ||
          (response.exceptionDetails.exception && response.exceptionDetails.exception.description) ||
          'evaluation failed';
      } else if (result) {
        value = formatRemoteObject(result);
      }

      return {
        success: !errorText,
        result: value,
        type: result ? result.type : 'undefined',
        consoleOutput: captured,
        error: errorText
      };
    } finally {
      if (unsubscribe) unsubscribe();
      await handle.release();
    }
  }

  _onEvent(state, method, params) {
    if (!state.enabled) return;

    if (method === 'Runtime.consoleAPICalled') {
      state.logs.push(this._entry(params));
      if (state.logs.length > this.maxLogs) state.logs.shift();
      return;
    }

    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {};
      state.logs.push({
        level: 'error',
        message: details.text || (details.exception && details.exception.description) || 'uncaught exception',
        timestamp: params.timestamp ? Math.round(params.timestamp * 1000) : Date.now(),
        source: 'exception'
      });
      if (state.logs.length > this.maxLogs) state.logs.shift();
      return;
    }

    if (method === '__detached__') {
      state.enabled = false;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      this.collectors.delete(state.tabId);
    }
  }

  _entry(params) {
    const args = params.args || [];
    return {
      level: normalizeLevel(params.type),
      message: args.map(formatRemoteObject).join(' '),
      timestamp: params.timestamp ? Math.round(params.timestamp * 1000) : Date.now(),
      source: 'console'
    };
  }
}

module.exports = { ConsoleCollector, formatRemoteObject, normalizeLevel, MAX_LOGS_PER_TAB };
