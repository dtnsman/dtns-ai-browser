/**
 * NetworkMonitor — CDP-driven request capture for a tab.
 *
 * Replaces the legacy `activeMonitors` map + module-level request array. State
 * lives in one object, every monitor stops through the same path, and the
 * debugger attachment is released even when the duration timer fires.
 */
'use strict';

const { ProxyError } = require('../util/primitives');

const MAX_RECORDS = 1000;

class NetworkMonitor {
  constructor(hub, options) {
    const opts = options || {};
    this.hub = hub;
    this.maxRecords = opts.maxRecords || MAX_RECORDS;
    this.monitors = new Map(); // tabId -> monitor state
    this.records = new Map();  // requestId -> record
    this.order = [];           // requestIds, oldest first
    this.totalCaptured = 0;
  }

  async start(tabId, duration) {
    if (tabId === undefined || tabId === null) {
      throw new ProxyError('tabId is required', { code: 'MISSING_TAB_ID', status: 400 });
    }

    const existing = this.monitors.get(tabId);
    if (existing) {
      await this.stop(tabId);
    }

    const handle = await this.hub.acquire(tabId);
    await this.hub.enable(handle, 'Network');

    const state = {
      tabId: tabId,
      handle: handle,
      startedAt: Date.now(),
      duration: duration === undefined ? 30000 : duration,
      timer: null,
      stopped: false,
      count: 0,
      unsubscribe: null
    };

    state.unsubscribe = handle.onEvent((method, params) => {
      this._onEvent(state, method, params);
    });

    this.monitors.set(tabId, state);

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
        ? 'Network monitoring started for ' + state.duration + 'ms'
        : 'Network monitoring started (manual stop)',
      tabId: tabId,
      duration: state.duration
    };
  }

  async stop(tabId) {
    const state = this.monitors.get(tabId);
    if (!state) {
      return { success: true, message: 'No active monitor for tab', tabId: tabId, totalCount: 0 };
    }

    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.unsubscribe) state.unsubscribe();
    this.monitors.delete(tabId);
    await state.handle.release();

    const requests = this._recordsForTab(tabId);
    return {
      success: true,
      tabId: tabId,
      summary: summarize(requests),
      requests: requests,
      totalCount: requests.length,
      duration: Date.now() - state.startedAt
    };
  }

  status(tabId) {
    if (tabId !== undefined && tabId !== null) {
      const state = this.monitors.get(tabId);
      if (!state) return { success: true, active: false, tabId: tabId };
      return {
        success: true,
        active: true,
        tabId: tabId,
        duration: state.duration,
        elapsed: Date.now() - state.startedAt,
        count: this._recordsForTab(tabId).length
      };
    }

    return {
      success: true,
      activeMonitors: Array.from(this.monitors.values()).map((state) => ({
        tabId: state.tabId,
        duration: state.duration,
        elapsed: Date.now() - state.startedAt
      })),
      totalRecords: this.records.size
    };
  }

  list(query) {
    const opts = query || {};
    let items = this.order
      .map((id) => this.records.get(id))
      .filter(Boolean);

    if (opts.tabId !== undefined && opts.tabId !== null) {
      items = items.filter((item) => item.tabId === Number(opts.tabId));
    }
    if (opts.method) {
      const method = String(opts.method).toUpperCase();
      items = items.filter((item) => item.method === method);
    }
    if (opts.urlPattern) {
      let regex;
      try { regex = new RegExp(String(opts.urlPattern)); }
      catch (error) { throw new ProxyError('invalid urlPattern', { code: 'INVALID_PATTERN', status: 400 }); }
      items = items.filter((item) => regex.test(item.url));
    }

    const limit = opts.limit === undefined ? 100 : Math.max(0, parseInt(opts.limit, 10) || 0);
    if (limit) items = items.slice(-limit);

    return items;
  }

  detail(requestId) {
    const record = this.records.get(String(requestId));
    if (!record) return null;
    return record;
  }

  clear() {
    const removed = this.records.size;
    this.records.clear();
    this.order = [];
    return { success: true, cleared: removed };
  }

  summary(options) {
    const opts = options || {};
    return summarize(this.list({ limit: opts.limit || 0, tabId: opts.tabId }));
  }

  async stopAll() {
    const tabIds = Array.from(this.monitors.keys());
    await Promise.all(tabIds.map((tabId) => this.stop(tabId).catch(() => {})));
  }

  _recordsForTab(tabId) {
    return this.list({ tabId: tabId, limit: 0 });
  }

  _onEvent(state, method, params) {
    if (state.stopped) return;

    // A user closing devtools kills the session from under us; handle it before
    // the request-scoped branches, which all expect a requestId.
    if (method === '__detached__') {
      state.stopped = true;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.unsubscribe) state.unsubscribe();
      this.monitors.delete(state.tabId);
      state.handle.release().catch(() => {});
      return;
    }

    if (!params) return;

    if (method === 'Network.requestWillBeSent') {
      const requestId = params.requestId;
      const request = params.request || {};
      const record = {
        id: requestId,
        requestId: requestId,
        tabId: state.tabId,
        url: request.url || '',
        method: String(request.method || 'GET').toUpperCase(),
        type: params.type || 'Other',
        requestHeaders: request.headers || {},
        status: 0,
        statusText: '',
        mimeType: '',
        startTime: Date.now(),
        endTime: null,
        duration: null,
        size: 0,
        error: null,
        fromCache: false
      };
      this.records.set(requestId, record);
      this.order.push(requestId);
      state.count += 1;
      this.totalCaptured += 1;
      this._trim();
      return;
    }

    const record = this.records.get(params.requestId);
    if (!record) return;

    if (method === 'Network.responseReceived') {
      const response = params.response || {};
      record.status = response.status || 0;
      record.statusText = response.statusText || '';
      record.mimeType = response.mimeType || '';
      record.responseHeaders = response.headers || {};
      record.fromCache = !!response.fromDiskCache;
      return;
    }

    if (method === 'Network.loadingFinished') {
      record.endTime = Date.now();
      record.duration = record.endTime - record.startTime;
      record.size = params.encodedDataLength || record.size || 0;
      return;
    }

    if (method === 'Network.loadingFailed') {
      record.endTime = Date.now();
      record.duration = record.endTime - record.startTime;
      record.error = params.errorText || 'request failed';
      return;
    }
  }

  _trim() {
    while (this.order.length > this.maxRecords) {
      const oldest = this.order.shift();
      this.records.delete(oldest);
    }
  }
}

function summarize(requests) {
  const byMethod = {};
  const byStatus = { '200s': 0, '300s': 0, '400s': 0, '500s': 0, others: 0 };
  let errors = 0;
  let durationTotal = 0;
  let durationCount = 0;

  requests.forEach((item) => {
    byMethod[item.method] = (byMethod[item.method] || 0) + 1;

    const status = Number(item.status) || 0;
    if (!status) byStatus.others += 1;
    else if (status >= 500) byStatus['500s'] += 1;
    else if (status >= 400) byStatus['400s'] += 1;
    else if (status >= 300) byStatus['300s'] += 1;
    else if (status >= 200) byStatus['200s'] += 1;
    else byStatus.others += 1;

    if (item.error || status >= 400) errors += 1;
    if (item.duration !== null && item.duration !== undefined) {
      durationTotal += item.duration;
      durationCount += 1;
    }
  });

  return {
    total: requests.length,
    byMethod: byMethod,
    byStatus: byStatus,
    errors: errors,
    avgDuration: durationCount ? Math.round(durationTotal / durationCount) : 0
  };
}

module.exports = { NetworkMonitor, summarize, MAX_RECORDS };
