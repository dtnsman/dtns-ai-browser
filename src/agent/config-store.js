/**
 * ConfigStore — persisted tunnel configuration (clientId / server URL).
 *
 * Legacy kept configuration in module-level variables plus scattered
 * `chrome.storage.local.set({...})` calls from inside request handlers. Here it
 * is a single store with one load path and one save path.
 */
'use strict';

const { ProxyError } = require('../util/primitives');

const STORAGE_KEY = 'dtnsProxyConfig';
// Keys used by the pre-2.0 plugin; read once so upgrades keep the same id.
const LEGACY_KEYS = ['clientId', 'wsServerUrl', 'autoReconnect'];
const CLIENT_ID_LENGTH = 20;
const CLIENT_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_WS_URL = 'wss://res2.dtns.top/tunnel';

/** Drop keys whose value is undefined so a partial patch cannot erase a default. */
function definedOnly(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function generateClientId(length) {
  const size = length || CLIENT_ID_LENGTH;
  const bytes = new Uint8Array(size);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let id = '';
  for (let i = 0; i < size; i++) {
    id += CLIENT_ID_ALPHABET.charAt(bytes[i] % CLIENT_ID_ALPHABET.length);
  }
  return id;
}

function isValidClientId(value) {
  return typeof value === 'string' && /^[a-z0-9]{8,32}$/.test(value);
}

class ConfigStore {
  constructor(adapter, defaults) {
    this.adapter = adapter;
    this.defaults = Object.assign({
      wsServerUrl: DEFAULT_WS_URL,
      autoReconnect: true
    }, definedOnly(defaults));
    this.value = null;
  }

  async load() {
    if (this.value) return this.value;

    let raw = {};
    try {
      raw = (await this.adapter.storageGet([STORAGE_KEY].concat(LEGACY_KEYS))) || {};
    } catch (error) {
      // Storage can be unavailable (e.g. an embedded harness); defaults win.
      raw = {};
    }

    // A legacy installation keeps clientId / wsServerUrl / autoReconnect as
    // separate keys. Adopt them once so that upgrading in place does not
    // silently rotate the user's tunnel domain (and break saved URLs).
    const stored = raw[STORAGE_KEY] && typeof raw[STORAGE_KEY] === 'object'
      ? raw[STORAGE_KEY]
      : {
        clientId: raw.clientId,
        wsServerUrl: raw.wsServerUrl,
        autoReconnect: raw.autoReconnect
      };
    const migrated = !raw[STORAGE_KEY];

    const clientId = isValidClientId(stored.clientId)
      ? stored.clientId
      : generateClientId();

    this.value = {
      clientId: clientId,
      wsServerUrl: stored.wsServerUrl || this.defaults.wsServerUrl || DEFAULT_WS_URL,
      autoReconnect: stored.autoReconnect === undefined
        ? this.defaults.autoReconnect
        : !!stored.autoReconnect
    };

    if (migrated || !isValidClientId(stored.clientId)) await this._persist();
    return this.value;
  }

  async save(patch) {
    const current = await this.load();
    // `undefined` in a patch means "leave it alone"; otherwise a caller that
    // omits a field could silently erase it.
    const next = Object.assign({}, current, definedOnly(patch));
    if (!isValidClientId(next.clientId)) {
      throw new ProxyError('clientId must be 8-32 lowercase alphanumeric characters', {
        code: 'INVALID_CLIENT_ID',
        status: 400
      });
    }
    if (!/^wss?:\/\//i.test(String(next.wsServerUrl || ''))) {
      throw new ProxyError('wsServerUrl must start with ws:// or wss://', {
        code: 'INVALID_SERVER_URL',
        status: 400
      });
    }
    this.value = next;
    await this._persist();
    return this.value;
  }

  async reset() {
    this.value = {
      clientId: generateClientId(),
      // Never persist an empty URL: that makes every later save() fail and
      // leaves the tunnel unable to reconnect.
      wsServerUrl: this.defaults.wsServerUrl || DEFAULT_WS_URL,
      autoReconnect: this.defaults.autoReconnect
    };
    await this._persist();
    return this.value;
  }

  async _persist() {
    try {
      await this.adapter.storageSet({ [STORAGE_KEY]: this.value });
    } catch (error) {
      // Non-fatal: the in-memory value still serves this session.
    }
    return this.value;
  }
}

module.exports = { ConfigStore, generateClientId, isValidClientId, STORAGE_KEY, LEGACY_KEYS };
