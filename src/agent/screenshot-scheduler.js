/**
 * ScreenshotScheduler — capture with TTL cache, rate limiting and coalescing.
 *
 * Ported from the `SmartScreenshotScheduler` in the legacy background page,
 * with three fixes:
 *   - the cache is bounded (the old one grew without limit),
 *   - a failed capture is not cached,
 *   - dimensions come from the image header instead of a canvas round trip,
 *     so the numbers are available even when resizing is not.
 */
'use strict';

const { sniffImage, base64ByteLength } = require('./image-info');

const DEFAULTS = {
  cacheTTL: 3000,
  minInterval: 200,
  maxCacheEntries: 24,
  defaultQuality: 80,
  defaultFormat: 'webp'
};

function stripDataUrl(value) {
  const text = String(value || '');
  const comma = text.indexOf(',');
  return comma >= 0 ? text.slice(comma + 1) : text;
}

/** Best-effort downscale using OffscreenCanvas (available in MV3 workers). */
async function defaultResizer(base64, options) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return null;
  }
  const opts = options || {};
  if (!opts.maxWidth && !opts.maxHeight) return null;

  const binary = typeof atob === 'function' ? atob(base64) : '';
  if (!binary) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const blob = new Blob([bytes], { type: 'image/' + (opts.format || 'webp') });
  const bitmap = await createImageBitmap(blob);
  const ratio = Math.min(
    opts.maxWidth ? opts.maxWidth / bitmap.width : 1,
    opts.maxHeight ? opts.maxHeight / bitmap.height : 1,
    1
  );
  if (ratio >= 1) {
    if (typeof bitmap.close === 'function') bitmap.close();
    return null;
  }

  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === 'function') bitmap.close();

  const type = opts.format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const encoded = await canvas.convertToBlob({ type: type, quality: (opts.quality || 80) / 100 });
  const buffer = await encoded.arrayBuffer();
  const output = new Uint8Array(buffer);
  let binaryOut = '';
  for (let i = 0; i < output.length; i++) binaryOut += String.fromCharCode(output[i]);
  return btoa(binaryOut);
}

class ScreenshotScheduler {
  constructor(adapter, options) {
    const opts = options || {};
    this.adapter = adapter;
    this.cacheTTL = opts.cacheTTL === undefined ? DEFAULTS.cacheTTL : opts.cacheTTL;
    this.minInterval = opts.minInterval === undefined ? DEFAULTS.minInterval : opts.minInterval;
    this.maxCacheEntries = opts.maxCacheEntries || DEFAULTS.maxCacheEntries;
    this.resizer = opts.resizer === undefined ? defaultResizer : opts.resizer;
    this.now = opts.now || (() => Date.now());
    this.sleep = opts.sleep || ((ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer.unref) timer.unref();
    }));

    this.cache = new Map();
    this.pending = new Map();
    this.lastCaptureTime = 0;
    this.stats = {
      requests: 0,
      captures: 0,
      cacheHits: 0,
      coalesced: 0,
      failures: 0,
      lastLatency: 0,
      totalLatency: 0
    };
  }

  /**
   * @param {object} request {tabId, quality, format, maxWidth, maxHeight, forceRefresh, tab}
   * @returns {Promise<object>} `{success, imageData, format, quality, width, height, size, latency, fromCache, timestamp}`
   */
  async capture(request) {
    const opts = request || {};
    const quality = clampQuality(opts.quality, DEFAULTS.defaultQuality);
    // captureVisibleTab natively supports png and jpeg; webp is requested by
    // the HTTP API and passed through to Chrome as well.
    const format = opts.format === 'webp' || opts.format === 'png' ? opts.format : 'jpeg';
    const force = opts.forceRefresh === true || opts.forceRefresh === 'true';
    const key = [
      opts.tabId === undefined || opts.tabId === null ? 'active' : 'tab' + opts.tabId,
      format,
      quality,
      opts.maxWidth || 0,
      opts.maxHeight || 0
    ].join('|');

    this.stats.requests += 1;

    if (!force) {
      const cached = this.cache.get(key);
      if (cached && this.now() - cached.at < this.cacheTTL) {
        this.stats.cacheHits += 1;
        this._touch(key, cached);
        return Object.assign({}, cached.value, { latency: 0, fromCache: true });
      }
    }

    if (this.pending.has(key)) {
      this.stats.coalesced += 1;
      const shared = await this.pending.get(key);
      return Object.assign({}, shared, { fromCache: true, coalesced: true });
    }

    const promise = this._capture(key, Object.assign({}, opts, {
      quality: quality,
      format: format,
      forceRefresh: force
    })).finally(() => {
      this.pending.delete(key);
    });

    this.pending.set(key, promise);
    return promise;
  }

  async _capture(key, opts) {
    const started = this.now();

    // Rate limit: never hammer captureVisibleTab, which throws when called too
    // often. Only the capture itself is serialised, not the cache lookups.
    const sinceLast = this.now() - this.lastCaptureTime;
    if (this.minInterval && sinceLast < this.minInterval) {
      await this.sleep(this.minInterval - sinceLast);
    }
    this.lastCaptureTime = this.now();

    try {
      const tab = opts.tab || await this._resolveTab(opts.tabId);
      if (!tab) {
        return this._failure('No active tab', started);
      }

      const dataUrl = await this.adapter.captureVisibleTab(tab.windowId, {
        format: opts.format,
        quality: opts.quality
      });

      let imageData = stripDataUrl(dataUrl);

      if (this.resizer && (opts.maxWidth || opts.maxHeight)) {
        try {
          const resized = await this.resizer(imageData, {
            maxWidth: opts.maxWidth,
            maxHeight: opts.maxHeight,
            format: opts.format,
            quality: opts.quality
          });
          if (resized) imageData = stripDataUrl(resized);
        } catch (error) {
          // Resizing is best-effort; the full-size capture is still valid.
        }
      }

      const dimensions = sniffImage(imageData) || { width: 0, height: 0 };
      const latency = this.now() - started;
      const value = {
        success: true,
        imageData: imageData,
        format: opts.format,
        quality: opts.quality,
        width: dimensions.width || 0,
        height: dimensions.height || 0,
        size: base64ByteLength(imageData),
        latency: latency,
        fromCache: false,
        timestamp: new Date(this.now()).toISOString()
      };

      this.stats.captures += 1;
      this.stats.lastLatency = latency;
      this.stats.totalLatency += latency;
      this._store(key, value);
      return value;
    } catch (error) {
      this.stats.failures += 1;
      return this._failure(error.message, started);
    }
  }

  async _resolveTab(tabId) {
    if (tabId !== undefined && tabId !== null) {
      try { return await this.adapter.get(Number(tabId)); }
      catch (error) { return null; }
    }
    const tabs = await this.adapter.query({ active: true, currentWindow: true });
    return tabs && tabs.length ? tabs[0] : null;
  }

  _failure(message, started) {
    return {
      success: false,
      error: message,
      latency: this.now() - started,
      fromCache: false
    };
  }

  _store(key, value) {
    this.cache.set(key, { at: this.now(), value: value });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  _touch(key, entry) {
    // Refresh LRU position without extending the TTL.
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  getStats() {
    return {
      requests: this.stats.requests,
      captures: this.stats.captures,
      cacheHits: this.stats.cacheHits,
      coalesced: this.stats.coalesced,
      failures: this.stats.failures,
      cacheSize: this.cache.size,
      pending: this.pending.size,
      lastLatency: this.stats.lastLatency,
      avgLatency: this.stats.captures
        ? Math.round(this.stats.totalLatency / this.stats.captures)
        : 0
    };
  }

  clearCache() {
    const size = this.cache.size;
    this.cache.clear();
    return { success: true, cleared: size };
  }
}

function clampQuality(value, fallback) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return fallback;
  return Math.min(100, Math.max(1, parsed));
}

module.exports = { ScreenshotScheduler, defaultResizer, clampQuality, DEFAULTS };
