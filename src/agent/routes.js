/**
 * Browser agent routes.
 *
 * These are the HTTP endpoints the extension exposes through the tunnel. The
 * URL surface, query parameters and response envelopes are unchanged from the
 * legacy plugin so existing clients keep working; what changed is that every
 * handler receives a normal `req`/`res` pair instead of reading a shared
 * `params` variable, and no handler touches `chrome.*` directly.
 */
'use strict';

const { isRestrictedUrl } = require('./tab-bridge');

/* ==================== parameter helpers ==================== */

function mergeParams(req) {
  const body = req.body && typeof req.body === 'object' && !(req.body instanceof Uint8Array)
    ? req.body
    : {};
  // Query wins over body, matching the legacy merge order.
  return Object.assign({}, body, req.query);
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return fallback;
}

function intOr(value, fallback) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function ok(res, data) {
  return res.json(Object.assign({ success: true }, data || {}));
}

function fail(res, message, extra) {
  return res.json(Object.assign({ success: false, error: message }, extra || {}));
}

function requireParam(res, params, name) {
  if (params[name] === undefined || params[name] === null || params[name] === '') {
    res.status(400).json({ success: false, error: name + ' is required' });
    return false;
  }
  return true;
}

/** Relay a TabBridge result, preserving the legacy `{success:false,error}` shape. */
function relay(res, result, mapper) {
  if (!result || result.success === false || result.error) {
    return fail(res, (result && (result.error || result.message)) || 'operation failed', {
      needsReload: result && result.needsReload ? true : undefined
    });
  }
  return ok(res, mapper ? mapper(result) : result);
}

/* ==================== route registration ==================== */

/**
 * @param {import('../proxy/http-proxy').HttpProxyApp} app
 * @param {object} ctx services created by browser-agent.js
 */
function registerBrowserRoutes(app, ctx) {
  const { adapter, config, bridge, screenshot, network, consoleCollector, hub, controls } = ctx;

  /* ---------- 系统 ---------- */

  app.get('/health', (req, res) => {
    const status = app.status();
    res.json({
      status: status.registered ? 'ok' : 'degraded',
      clientId: status.clientId,
      registeredDomains: status.registered ? [app.domain] : [],
      protocolVersion: status.serverVersion,
      uptimeMs: status.uptimeMs,
      timestamp: new Date().toISOString()
    });
  });

  app.get('/api/info', async (req, res) => {
    const cfg = await config.load();
    ok(res, {
      name: 'AI灵驹浏览器插件',
      version: ctx.version,
      clientId: cfg.clientId,
      registeredDomains: app.status().registered ? [app.domain] : [],
      capabilities: [
        'smart_reply', 'dom_query', 'click', 'type', 'navigate',
        'clipboard', 'evaluate', 'screenshot', 'tabs', 'network', 'console'
      ]
    });
  });

  app.get('/api/domains', async (req, res) => {
    const cfg = await config.load();
    ok(res, {
      clientId: cfg.clientId,
      registeredDomains: app.status().registered ? [app.domain] : []
    });
  });

  /* ---------- 页面信息 ---------- */

  app.get('/api/page/info', async (req, res) => {
    const result = await bridge.send({ action: 'get_page_info' });
    if (result.success === false) {
      // Legacy degraded instead of erroring: clients rely on the shape.
      return res.json({
        success: false,
        error: result.error,
        url: 'unknown',
        title: '无法获取',
        readyState: 'unknown'
      });
    }
    return ok(res, result);
  });

  app.get('/api/page/visible-text', async (req, res) => {
    const params = mergeParams(req);
    const result = await bridge.send({
      action: 'get_visible_text',
      includePosition: bool(params.includePosition, true),
      mergeText: bool(params.mergeText, true)
    });
    return relay(res, result);
  });

  app.get('/api/page/visible-text/blocks', async (req, res) => {
    const result = await bridge.send({ action: 'get_visible_text_blocks' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { blocks: result.blocks || [], total: result.total || 0 });
  });

  app.get('/api/page/visible-text/merged', async (req, res) => {
    const params = mergeParams(req);
    const result = await bridge.send({
      action: 'get_visible_text_merged',
      separator: params.separator === undefined ? '\n' : params.separator
    });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { text: result.text || '', length: result.length || 0 });
  });

  app.get('/api/page/elements', async (req, res) => relay(
    res, await bridge.send({ action: 'get_page_elements' })
  ));

  app.get('/api/page/elements/simple', async (req, res) => relay(
    res, await bridge.send({ action: 'get_page_elements_simple' })
  ));

  app.get('/api/page/links', async (req, res) => {
    const result = await bridge.send({ action: 'get_page_links' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { links: result.links || [] });
  });

  app.get('/api/page/images', async (req, res) => {
    const result = await bridge.send({ action: 'get_page_images' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { images: result.images || [] });
  });

  app.get('/api/page/forms', async (req, res) => {
    const result = await bridge.send({ action: 'get_page_forms' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { forms: result.forms || [] });
  });

  app.get('/api/page/inputs', async (req, res) => {
    const result = await bridge.send({ action: 'get_page_inputs' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { inputs: result.inputs || [] });
  });

  app.get('/api/page/buttons', async (req, res) => {
    const result = await bridge.send({ action: 'get_page_buttons' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { buttons: result.buttons || [] });
  });

  app.get('/api/page/clickable-elements', async (req, res) => {
    const params = mergeParams(req);
    const result = await bridge.send({
      action: 'get_clickable_elements',
      includePosition: bool(params.includePosition, true),
      includeSelector: bool(params.includeSelector, true)
    });
    if (result.success === false) return fail(res, result.error);
    return ok(res, {
      total: result.total,
      elements: result.elements,
      summary: result.summary
    });
  });

  app.get('/api/page/clickable-elements/grouped', async (req, res) => {
    const result = await bridge.send({ action: 'get_clickable_elements_grouped' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { groups: result.groups, total: result.total });
  });

  app.get('/api/page/clickable-elements/selectors', async (req, res) => {
    const result = await bridge.send({ action: 'get_clickable_element_selectors' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { selectors: result.selectors, total: result.total });
  });

  app.get('/api/element/info', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'selector')) return undefined;
    const result = await bridge.send({ action: 'get_element_info', selector: params.selector });
    return relay(res, result);
  });

  app.get('/api/element/position', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'selector')) return undefined;
    const result = await bridge.send({ action: 'get_element_position', selector: params.selector });
    return relay(res, result);
  });

  app.get('/api/element', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'selector')) return undefined;
    const result = await bridge.send({
      action: 'query_dom',
      selector: params.selector,
      all: bool(params.all, false)
    });
    return relay(res, result);
  });

  app.get('/api/query', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'selector')) return undefined;
    const result = await bridge.send({
      action: 'query_dom',
      selector: params.selector,
      all: bool(params.all, false)
    });
    return relay(res, result);
  });

  app.get('/api/viewport/info', async (req, res) => relay(
    res, await bridge.send({ action: 'get_viewport_info' })
  ));

  /* ---------- 脚本执行 ---------- */

  app.get('/api/script/evaluate', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'script')) return undefined;
    const tab = await bridge.activeTab();
    if (!tab) return fail(res, 'No active tab found');
    if (isRestrictedUrl(tab.url)) return fail(res, 'Cannot access this page type', { url: tab.url });

    const handle = await hub.acquire(tab.id);
    try {
      const response = await handle.evaluate(String(params.script));
      if (response && response.exceptionDetails) {
        return ok(res, {
          success: false,
          error: response.exceptionDetails.text || 'evaluation failed'
        });
      }
      const result = response && response.result;
      return res.json({
        success: true,
        result: result && result.value !== undefined ? result.value : (result ? result.description : null),
        type: result ? result.type : 'undefined'
      });
    } finally {
      await handle.release();
    }
  });

  /* ---------- 交互 ---------- */

  app.get('/api/click', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'selector')) return undefined;
    return relay(res, await bridge.send({ action: 'click_element', selector: params.selector }));
  });

  app.get('/api/click/at', async (req, res) => {
    const params = mergeParams(req);
    if (params.x === undefined || params.y === undefined) {
      return res.status(400).json({ success: false, error: 'x and y are required' });
    }
    const result = await bridge.send({
      action: 'click_at_coordinates',
      x: intOr(params.x, 0),
      y: intOr(params.y, 0),
      button: params.button || 'left',
      double: bool(params.double, false)
    });
    return relay(res, result);
  });

  app.get('/api/click/right', async (req, res) => {
    const params = mergeParams(req);
    if (params.x === undefined || params.y === undefined) {
      return res.status(400).json({ success: false, error: 'x and y are required' });
    }
    return relay(res, await bridge.send({
      action: 'click_at_coordinates',
      x: intOr(params.x, 0),
      y: intOr(params.y, 0),
      button: 'right'
    }));
  });

  app.get('/api/click/double', async (req, res) => {
    const params = mergeParams(req);
    if (params.x === undefined || params.y === undefined) {
      return res.status(400).json({ success: false, error: 'x and y are required' });
    }
    return relay(res, await bridge.send({
      action: 'click_at_coordinates',
      x: intOr(params.x, 0),
      y: intOr(params.y, 0),
      double: true
    }));
  });

  app.get('/api/mouse/move', async (req, res) => {
    const params = mergeParams(req);
    if (params.x === undefined || params.y === undefined) {
      return res.status(400).json({ success: false, error: 'x and y are required' });
    }
    return relay(res, await bridge.send({
      action: 'mouse_move_to',
      x: intOr(params.x, 0),
      y: intOr(params.y, 0)
    }));
  });

  app.get('/api/type', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'selector') || !requireParam(res, params, 'text')) return undefined;
    return relay(res, await bridge.send({
      action: 'type_text',
      selector: params.selector,
      text: params.text
    }));
  });

  app.get('/api/smart_reply', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'text')) return undefined;
    return relay(res, await bridge.send({
      action: 'smart_reply',
      text: params.text,
      context: params.context || ''
    }));
  });

  app.get('/api/scroll', async (req, res) => {
    const params = mergeParams(req);
    return relay(res, await bridge.send({
      action: 'scroll',
      x: intOr(params.x, 0),
      y: intOr(params.y, 0)
    }));
  });

  /* ---------- 导航 ---------- */

  app.get('/api/navigate', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'url')) return undefined;
    const tab = await bridge.activeTab();
    if (!tab) return fail(res, 'No active tab found');
    try {
      const updated = await adapter.update(tab.id, { url: params.url });
      return ok(res, { url: params.url, tabId: tab.id, status: updated && updated.status });
    } catch (error) {
      return relay(res, await bridge.send({ action: 'navigate', url: params.url }));
    }
  });

  app.get('/api/refresh', async (req, res) => {
    const tab = await bridge.activeTab();
    if (!tab) return fail(res, 'No active tab found');
    try {
      await adapter.reload(tab.id);
      return ok(res, { tabId: tab.id, message: 'Page reloaded' });
    } catch (error) {
      return relay(res, await bridge.send({ action: 'refresh' }));
    }
  });

  /* ---------- 剪贴板 ---------- */

  app.get('/api/clipboard/copy', async (req, res) => {
    const params = mergeParams(req);
    if (!params.text && !params.html) {
      return res.status(400).json({ success: false, error: 'text or html is required' });
    }
    return relay(res, await bridge.send({
      action: 'copy_to_clipboard',
      text: params.text || '',
      html: params.html || ''
    }), () => ({ message: 'Copied to clipboard' }));
  });

  app.get('/api/clipboard/read', async (req, res) => {
    const result = await bridge.send({ action: 'read_clipboard' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, {
      text: result.text || '',
      html: result.html || '',
      length: (result.text || '').length
    });
  });

  app.get('/api/clipboard/append', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'text')) return undefined;
    return relay(res, await bridge.send({
      action: 'append_to_clipboard',
      text: params.text,
      separator: params.separator === undefined ? '\n' : params.separator
    }));
  });

  app.get('/api/clipboard/clear', async (req, res) => {
    const result = await bridge.send({ action: 'clear_clipboard' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { message: 'Clipboard cleared' });
  });

  app.get('/api/selected/text', async (req, res) => {
    const result = await bridge.send({ action: 'get_selected_text' });
    if (result.success === false) return fail(res, result.error);
    return ok(res, { text: result.text || '' });
  });

  /* ---------- 截图 ---------- */

  app.get('/api/screenshot', async (req, res) => {
    const params = mergeParams(req);
    const result = await screenshot.capture({
      quality: intOr(params.quality, 75),
      format: params.format === 'png' ? 'jpeg' : (params.format || 'jpeg')
    });
    if (!result.success) return fail(res, result.error);
    return ok(res, { imageData: result.imageData, format: result.format });
  });

  app.get('/api/screenshot2', async (req, res) => {
    const params = mergeParams(req);
    const force = bool(params.forceRefresh, false);
    const result = await screenshot.capture({
      tabId: params.tabId ? intOr(params.tabId, null) : null,
      quality: intOr(params.quality, 80),
      format: params.format === 'jpeg' ? 'jpeg' : 'webp',
      maxWidth: params.maxWidth ? intOr(params.maxWidth, null) : null,
      maxHeight: params.maxHeight ? intOr(params.maxHeight, null) : null,
      forceRefresh: force
    });

    res.set('cache-control', force ? 'no-cache' : 'private, max-age=3');
    res.set('x-screenshot-latency', String(result.latency || 0));
    res.set('x-screenshot-from-cache', result.fromCache ? 'true' : 'false');

    if (!result.success) return fail(res, result.error, { latency: result.latency });
    return ok(res, result);
  });

  app.get('/api/screenshot/stats', (req, res) => {
    ok(res, { stats: screenshot.getStats() });
  });

  app.get('/api/screenshot/clear-cache', (req, res) => {
    const cleared = screenshot.clearCache();
    ok(res, { message: 'Screenshot cache cleared', ...cleared });
  });

  app.get('/api/screenshot/preload', async (req, res) => {
    // Warm the cache without blocking the response, exactly as before.
    screenshot.capture({ forceRefresh: true }).catch(() => {});
    ok(res, { message: 'Preload started in background' });
  });

  /* ---------- 网络监控 ---------- */

  app.get('/api/network/start', async (req, res) => {
    const params = mergeParams(req);
    const tabId = params.tabId ? intOr(params.tabId, null) : await activeTabId(bridge);
    if (tabId === null) return fail(res, 'No active tab found');
    const result = await network.start(tabId, intOr(params.duration, 30000));
    const tab = await adapter.get(tabId).catch(() => null);
    return ok(res, { message: result.message, tabId: tabId, url: tab ? tab.url : undefined });
  });

  app.get('/api/network/stop', async (req, res) => {
    const params = mergeParams(req);
    const tabId = params.tabId ? intOr(params.tabId, null) : await activeTabId(bridge);
    if (tabId === null) return fail(res, 'No active tab found');
    const result = await network.stop(tabId);
    return res.json(result);
  });

  app.get('/api/network/status', async (req, res) => {
    const params = mergeParams(req);
    if (params.tabId !== undefined) {
      return res.json(network.status(intOr(params.tabId, null)));
    }
    return res.json(network.status());
  });

  app.get('/api/network/requests', (req, res) => {
    const params = mergeParams(req);
    const requests = network.list({
      limit: params.limit === undefined ? 100 : intOr(params.limit, 100),
      method: params.method || '',
      urlPattern: params.urlPattern || '',
      tabId: params.tabId ? intOr(params.tabId, null) : null
    });
    ok(res, { requests: requests, total: requests.length });
  });

  app.get('/api/network/request/detail', (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'requestId')) return undefined;
    const detail = network.detail(params.requestId);
    if (!detail) return fail(res, 'Request not found', { requestId: params.requestId });
    return ok(res, { request: detail });
  });

  app.get('/api/network/clear', (req, res) => {
    const result = network.clear();
    ok(res, { message: 'Network records cleared', cleared: result.cleared });
  });

  /* ---------- 控制台 ---------- */

  app.get('/api/console/logs', async (req, res) => {
    const params = mergeParams(req);
    const tabId = params.tabId ? intOr(params.tabId, null) : await activeTabId(bridge);
    const logs = consoleCollector.logs({
      tabId: tabId === null ? null : tabId,
      limit: params.limit === undefined ? 100 : intOr(params.limit, 100),
      level: params.level || '',
      clear: bool(params.clear, false)
    });
    ok(res, { logs: logs, total: logs.length, tabId: tabId });
  });

  app.get('/api/console/start', async (req, res) => {
    const params = mergeParams(req);
    const tabId = params.tabId ? intOr(params.tabId, null) : await activeTabId(bridge);
    if (tabId === null) return fail(res, 'No active tab found');
    const result = await consoleCollector.start(tabId, intOr(params.duration, 0));
    return ok(res, { message: result.message, tabId: tabId });
  });

  app.get('/api/console/stop', async (req, res) => {
    const params = mergeParams(req);
    const tabId = params.tabId ? intOr(params.tabId, null) : await activeTabId(bridge);
    if (tabId === null) return fail(res, 'No active tab found');
    const result = await consoleCollector.stop(tabId);
    return res.json(result);
  });

  app.get('/api/console/clear', async (req, res) => {
    const params = mergeParams(req);
    const tabId = params.tabId ? intOr(params.tabId, null) : null;
    return res.json(consoleCollector.clear(tabId));
  });

  app.get('/api/console/exec', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'code')) return undefined;
    const tabId = params.tabId ? intOr(params.tabId, null) : await activeTabId(bridge);
    if (tabId === null) return fail(res, 'No active tab found');
    const result = await consoleCollector.exec(tabId, params.code);
    return res.json(result);
  });

  /* ---------- 标签页 ---------- */

  app.get('/api/tabs/list', async (req, res) => {
    const params = mergeParams(req);
    const queryInfo = {};
    if (bool(params.active, false)) queryInfo.active = true;
    if (bool(params.currentWindow, false)) queryInfo.currentWindow = true;
    const tabs = await adapter.query(queryInfo);
    ok(res, {
      total: tabs.length,
      tabs: tabs.map(summarizeTab)
    });
  });

  app.get('/api/tabs/current', async (req, res) => {
    const tab = await bridge.activeTab();
    if (!tab) return fail(res, 'No active tab found');
    return ok(res, { tab: summarizeTab(tab) });
  });

  app.get('/api/tabs/switch', async (req, res) => {
    const params = mergeParams(req);
    const tabs = await adapter.query({});
    const target = findTab(tabs, params);
    if (!target) return fail(res, 'No matching tab found', { candidates: tabs.length });
    await adapter.update(target.id, { active: true });
    if (bool(params.focusWindow, true) && target.windowId !== undefined) {
      try {
        await adapter.updateWindow(target.windowId, { focused: true });
      } catch (error) {
        // Focusing is best-effort; the tab switch already succeeded.
      }
    }
    return ok(res, { tab: summarizeTab(target), message: 'Switched to tab' });
  });

  app.get('/api/tabs/open', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'url')) return undefined;
    const props = {
      url: params.url,
      active: bool(params.active, true)
    };
    const index = params.position === 'start' ? 0 : intOr(params.position, undefined);
    if (index !== undefined && !isNaN(index)) props.index = index;
    if (params.windowId !== undefined) props.windowId = intOr(params.windowId, undefined);

    const tab = await adapter.create(props);
    return ok(res, { tab: summarizeTab(tab) });
  });

  app.get('/api/tabs/open/batch', async (req, res) => {
    const params = mergeParams(req);
    const urls = parseUrlList(params.urls);
    if (!urls.length) return res.status(400).json({ success: false, error: 'urls is required' });

    const activeMode = params.active === undefined ? 'last' : String(params.active);
    const created = [];
    for (let i = 0; i < urls.length; i++) {
      const isActive = activeMode === 'first' ? i === 0
        : activeMode === 'none' || activeMode === 'false' ? false
          : activeMode === 'last' || activeMode === 'true' ? i === urls.length - 1
            : intOr(activeMode, urls.length - 1) === i;
      const props = { url: urls[i], active: isActive };
      if (params.windowId !== undefined) props.windowId = intOr(params.windowId, undefined);
      try {
        created.push(summarizeTab(await adapter.create(props)));
      } catch (error) {
        created.push({ url: urls[i], error: error.message });
      }
    }
    return ok(res, { created: created, total: created.length });
  });

  app.get('/api/tabs/openOrSwitch', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'url')) return undefined;
    const tabs = await adapter.query({});
    const existing = tabs.find((tab) => sameUrl(tab.url, params.url));
    if (existing) {
      await adapter.update(existing.id, { active: bool(params.active, true) });
      return ok(res, { tab: summarizeTab(existing), switched: true });
    }
    const tab = await adapter.create({ url: params.url, active: bool(params.active, true) });
    return ok(res, { tab: summarizeTab(tab), switched: false });
  });

  app.get('/api/tabs/open/background', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'url')) return undefined;
    const tab = await adapter.create({ url: params.url, active: false });
    return ok(res, { tab: summarizeTab(tab) });
  });

  app.get('/api/tabs/close', async (req, res) => {
    const params = mergeParams(req);
    const tabs = await adapter.query({});
    let targets = [];

    if (params.tabId !== undefined) {
      targets = [intOr(params.tabId, null)].filter((id) => id !== null);
    } else if (params.tabIds !== undefined) {
      targets = parseUrlList(params.tabIds).map((value) => intOr(value, null)).filter((id) => id !== null);
    } else if (params.url !== undefined) {
      targets = tabs.filter((tab) => sameUrl(tab.url, params.url)).map((tab) => tab.id);
    } else if (params.title !== undefined) {
      targets = tabs.filter((tab) => String(tab.title || '').indexOf(params.title) >= 0).map((tab) => tab.id);
    } else if (bool(params.current, false)) {
      const tab = await bridge.activeTab();
      targets = tab ? [tab.id] : [];
    } else {
      return res.status(400).json({ success: false, error: 'tabId, tabIds, url, title or current is required' });
    }

    if (!targets.length) return fail(res, 'No matching tab found');
    let closed = 0;
    for (const id of targets) {
      try {
        await adapter.remove(id);
        closed += 1;
      } catch (error) { /* tab may already be gone */ }
    }
    return ok(res, { closed: closed, requested: targets.length });
  });

  /* ---------- 窗口 ---------- */

  app.get('/api/windows/open', async (req, res) => {
    const params = mergeParams(req);
    const urls = parseUrlList(params.urls);
    const props = {};
    if (urls.length) props.url = urls;
    if (params.width !== undefined) props.width = intOr(params.width, undefined);
    if (params.height !== undefined) props.height = intOr(params.height, undefined);
    if (params.left !== undefined) props.left = intOr(params.left, undefined);
    if (params.top !== undefined) props.top = intOr(params.top, undefined);
    if (params.type) props.type = String(params.type);
    if (params.active !== undefined) props.focused = bool(params.active, true);

    const win = await adapter.createWindow(props);
    return ok(res, {
      windowId: win && win.id,
      tabs: win && win.tabs ? win.tabs.map(summarizeTab) : []
    });
  });

  /* ---------- 配置 ---------- */

  app.get('/api/config', async (req, res) => {
    const cfg = await config.load();
    ok(res, {
      config: {
        clientId: cfg.clientId,
        wsServerUrl: cfg.wsServerUrl,
        autoReconnect: cfg.autoReconnect
      },
      status: {
        connected: app.status().connected,
        registered: app.status().registered,
        browserDomain: app.apiBase,
        wsUrl: app.wsUrl,
        serverVersion: app.status().serverVersion
      }
    });
  });

  app.get('/api/config/clientId', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'clientId')) return undefined;

    let saved;
    try {
      saved = await config.save({ clientId: String(params.clientId) });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message });
    }

    const domain = controls.domainFor(saved.clientId);
    // Respond over the current socket *before* rebinding: the rebind swaps the
    // transport, and the client must not lose the reply to its own request.
    res.json({
      success: true,
      message: 'Client ID changed to ' + saved.clientId + ', reconnecting...',
      newClientId: saved.clientId,
      expectedDomain: 'http://' + domain
    });
    await controls.rebind({ clientId: saved.clientId }).catch(() => {});
    return undefined;
  });

  app.get('/api/config/clientId/generate', async (req, res) => {
    const saved = await config.reset();
    const domain = controls.domainFor(saved.clientId);

    res.json({
      success: true,
      message: 'New client ID generated and reconnected',
      clientId: saved.clientId,
      expectedDomain: 'http://' + domain
    });
    await controls.rebind({ clientId: saved.clientId }).catch(() => {});
    return undefined;
  });

  app.get('/api/config/server', async (req, res) => {
    const params = mergeParams(req);
    if (!requireParam(res, params, 'url')) return undefined;

    let saved;
    try {
      saved = await config.save({ wsServerUrl: String(params.url) });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      message: 'Server URL changed to ' + saved.wsServerUrl + ', reconnecting...',
      newUrl: saved.wsServerUrl
    });
    await controls.rebind({ wsUrl: saved.wsServerUrl }).catch(() => {});
    return undefined;
  });

  app.get('/api/config/reset', async (req, res) => {
    const saved = await config.reset();
    const domain = controls.domainFor(saved.clientId);

    res.json({
      success: true,
      message: 'Configuration reset',
      clientId: saved.clientId,
      wsServerUrl: saved.wsServerUrl,
      expectedDomain: 'http://' + domain
    });
    await controls.rebind({
      clientId: saved.clientId,
      wsUrl: saved.wsServerUrl
    }).catch(() => {});
    return undefined;
  });

  app.get('/api/config/reconnect', async (req, res) => {
    res.json({ success: true, message: 'Reconnection initiated' });
    await controls.reconnect().catch(() => {});
    return undefined;
  });
}

/* ==================== small helpers ==================== */

async function activeTabId(bridge) {
  const tab = await bridge.activeTab();
  return tab && tab.id !== undefined ? tab.id : null;
}

function summarizeTab(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: !!tab.active,
    url: tab.url,
    title: tab.title,
    status: tab.status
  };
}

function parseUrlList(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value).trim();
  if (text.charAt(0) === '[') {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch (error) { /* fall through to comma split */ }
  }
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function sameUrl(a, b) {
  const left = String(a || '').replace(/\/+$/, '');
  const right = String(b || '').replace(/\/+$/, '');
  return left === right;
}

function findTab(tabs, params) {
  if (params.tabId !== undefined) {
    const id = intOr(params.tabId, null);
    return tabs.find((tab) => tab.id === id) || null;
  }
  if (params.index !== undefined) {
    const index = intOr(params.index, null);
    return tabs.find((tab) => tab.index === index) || null;
  }
  if (params.url !== undefined) return tabs.find((tab) => sameUrl(tab.url, params.url)) || null;
  if (params.title !== undefined) {
    return tabs.find((tab) => String(tab.title || '').indexOf(params.title) >= 0) || null;
  }
  return null;
}

module.exports = {
  registerBrowserRoutes,
  mergeParams,
  bool,
  intOr,
  parseUrlList,
  summarizeTab,
  findTab
};
