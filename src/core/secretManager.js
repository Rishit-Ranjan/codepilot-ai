'use strict';

const SECRET_PREFIX = 'codepilot.apiKey.';

/**
 * SecretManager wraps VS Code's encrypted SecretStorage so API keys are
 * NEVER persisted in plain text in settings.json, config files, or globalState.
 */
class SecretManager {
  /**
   * @param {import('vscode').SecretStorage} secretStorage
   */
  constructor(secretStorage) {
    if (!secretStorage) {
      throw new Error('SecretStorage instance is required.');
    }
    this._secrets = secretStorage;
  }

  /**
   * Build a deterministic secret key identifier for a model or provider.
   * @param {string} modelId
   * @returns {string}
   */
  static buildKeyId(modelId) {
    const safe = String(modelId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${SECRET_PREFIX}${safe}`;
  }

  /**
   * Store an API key securely in OS-backed SecretStorage.
   * @param {string} secretKeyId
   * @param {string} apiKey
   */
  async setApiKey(secretKeyId, apiKey) {
    if (!secretKeyId) {
      throw new Error('secretKeyId is required.');
    }
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!trimmed) {
      await this._secrets.delete(secretKeyId);
      return false;
    }
    await this._secrets.store(secretKeyId, trimmed);
    return true;
  }

  /**
   * Retrieve an API key from SecretStorage. Never expose this to webview or logs.
   * @param {string} secretKeyId
   * @returns {Promise<string|undefined>}
   */
  async getApiKey(secretKeyId) {
    if (!secretKeyId) return undefined;
    return await this._secrets.get(secretKeyId);
  }

  /**
   * Check whether a non-empty API key exists for the given secretKeyId.
   * @param {string} secretKeyId
   * @returns {Promise<boolean>}
   */
  async hasApiKey(secretKeyId) {
    const val = await this.getApiKey(secretKeyId);
    return Boolean(val && val.trim().length > 0);
  }

  /**
   * Return a masked preview (e.g. "sk-...a1b2") for safe UI display.
   * Never returns the full key.
   * @param {string} secretKeyId
   * @returns {Promise<string>}
   */
  async getMaskedStatus(secretKeyId) {
    const val = await this.getApiKey(secretKeyId);
    if (!val || !val.trim()) return '';
    const trimmed = val.trim();
    if (trimmed.length <= 8) return '••••••••';
    return `${trimmed.slice(0, 3)}••••••••${trimmed.slice(-4)}`;
  }

  /**
   * Delete an API key from SecretStorage.
   * @param {string} secretKeyId
   */
  async deleteApiKey(secretKeyId) {
    if (!secretKeyId) return;
    await this._secrets.delete(secretKeyId);
  }
}

export { SecretManager, SECRET_PREFIX };
