/**
 * DebuggerHub — one `chrome.debugger` attachment per tab, shared by features.
 *
 * Chrome allows exactly one debugger client per tab. The legacy implementation
 * attached independently for network monitoring and for console capture, so
 * enabling both produced "Another debugger is already attached" errors and
 * left sessions behind when a monitor timed out. This hub reference-counts
 * attachments per tab and multiplexes CDP events to subscribers.
 */
'use strict';

const { ProxyError } = require('../util/primitives');

class DebuggerHub {
  constructor(adapter, options) {
    this.adapter = adapter;
    this.options = options || {};
    this.sessions = new Map();
    this.totalAcquires = 0;
    this._wired = false;
    this._onEventBound = (source, method, params) => this._dispatch(source, method, params);
    this._onDetachBound = (source, reason) => this._handleDetach(source, reason);
  }

  _wire() {
    if (this._wired) return;
    this.adapter.onDebuggerEvent(this._onEventBound);
    this.adapter.onDebuggerDetach(this._onDetachBound);
    this._wired = true;
  }

  /**
   * @param {number} tabId
   * @returns {Promise<{tabId:number, target:object, send:Function, onEvent:Function,
   *   offEvent:Function, evaluate:Function, release:Function}>}
   */
  async acquire(tabId) {
    if (tabId === undefined || tabId === null) {
      throw new ProxyError('tabId is required for debugger access', {
        code: 'MISSING_TAB_ID', status: 400
      });
    }

    this._wire();

    let session = this.sessions.get(tabId);
    if (!session) {
      const target = { tabId: tabId };
      try {
        await this.adapter.attachDebugger(target, this.options.protocolVersion || '1.3');
      } catch (error) {
        const message = String(error && error.message || error);
        throw new ProxyError('cannot attach debugger: ' + message, {
          code: /already attached/i.test(message) ? 'DEBUGGER_BUSY' : 'DEBUGGER_ATTACH_FAILED',
          status: 409,
          cause: error
        });
      }
      session = {
        tabId: tabId,
        target: target,
        refs: 0,
        listeners: new Set(),
        enabled: new Set()
      };
      this.sessions.set(tabId, session);
      this.totalAcquires += 1;
    }

    session.refs += 1;
    return this._handle(session);
  }

  _handle(session) {
    const adapter = this.adapter;
    let released = false;

    const handle = {
      tabId: session.tabId,
      target: session.target,
      send: (method, params) => adapter.sendDebuggerCommand(session.target, method, params || {}),
      evaluate: async (expression, options) => {
        const opts = options || {};
        return adapter.sendDebuggerCommand(session.target, 'Runtime.evaluate', {
          expression: expression,
          returnByValue: opts.returnByValue !== false,
          awaitPromise: opts.awaitPromise !== false,
          userGesture: true
        });
      },
      onEvent: (listener) => {
        session.listeners.add(listener);
        return () => session.listeners.delete(listener);
      },
      offEvent: (listener) => session.listeners.delete(listener),
      release: () => {
        if (released) return Promise.resolve();
        released = true;
        return this._release(session);
      }
    };
    return handle;
  }

  /** Enable a CDP domain once per session (Network, Runtime, ...). */
  async enable(handle, domain) {
    const session = this.sessions.get(handle.tabId);
    if (!session) return false;
    if (session.enabled.has(domain)) return true;
    await handle.send(domain + '.enable', {});
    session.enabled.add(domain);
    return true;
  }

  async _release(session) {
    session.refs -= 1;
    if (session.refs > 0) return;
    if (this.sessions.get(session.tabId) === session) this.sessions.delete(session.tabId);
    try {
      await this.adapter.detachDebugger(session.target);
    } catch (error) {
      // Already detached (tab closed, devtools took over): nothing to do.
    }
  }

  _dispatch(source, method, params) {
    if (!source || source.tabId === undefined) return;
    const session = this.sessions.get(source.tabId);
    if (!session) return;
    session.listeners.forEach((listener) => {
      try { listener(method, params || {}); } catch (error) { /* listener errors are isolated */ }
    });
  }

  _handleDetach(source, reason) {
    if (!source || source.tabId === undefined) return;
    const session = this.sessions.get(source.tabId);
    if (!session) return;
    this.sessions.delete(source.tabId);
    const error = new ProxyError('debugger detached: ' + (reason || 'unknown'), {
      code: 'DEBUGGER_DETACHED'
    });
    session.listeners.forEach((listener) => {
      try { listener('__detached__', { reason: reason, error: error }); }
      catch (e) { /* isolate */ }
    });
  }

  async dispose() {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.map((session) => {
      return this.adapter.detachDebugger(session.target).catch(() => {});
    }));
    if (this._wired) {
      this.adapter.offDebuggerEvent(this._onEventBound);
      this.adapter.offDebuggerDetach(this._onDetachBound);
      this._wired = false;
    }
  }

  status() {
    return {
      sessions: this.sessions.size,
      tabs: Array.from(this.sessions.keys()),
      totalAcquires: this.totalAcquires
    };
  }
}

module.exports = DebuggerHub;
