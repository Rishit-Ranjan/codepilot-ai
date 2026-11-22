'use strict';

import { SecretManager } from './secretManager.js';

const STORAGE_KEY = 'codepilot.config.v1';
const MODEL_ROLES = ['chat', 'autocomplete', 'edit', 'apply', 'embed', 'rerank'];

function providerModelReference(providerId, modelId) {
  return `provider:${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
}

function parseProviderModelReference(reference) {
  if (typeof reference !== 'string' || !reference.startsWith('provider:')) return null;
  const separatorIndex = reference.indexOf(':', 'provider:'.length);
  if (separatorIndex < 0) return null;
  try {
    return {
      providerId: decodeURIComponent(reference.slice('provider:'.length, separatorIndex)),
      modelId: decodeURIComponent(reference.slice(separatorIndex + 1))
    };
  } catch (_) {
    return null;
  }
}

const DEFAULT_BUILTIN_TOOLS = [
  {
    name: 'read_file',
    description: 'Use this tool if you need to view the contents of an existing file.',
    permission: 'automatic'
  },
  {
    name: 'create_new_file',
    description: "Create a new file. Only use this when a file doesn't exist and should be created.",
    permission: 'ask_first'
  },
  {
    name: 'edit_existing_file',
    description: 'Modify an existing file by replacing targeted lines or blocks of code.',
    permission: 'ask_first'
  },
  {
    name: 'run_terminal_command',
    description: 'Run a terminal command in the current workspace directory.',
    permission: 'ask_first'
  },
  {
    name: 'file_glob_search',
    description: 'Search for files recursively in the project using glob patterns.',
    permission: 'automatic'
  },
  {
    name: 'grep_search',
    description: 'Search across workspace files for text or regular expression matches.',
    permission: 'automatic'
  },
  {
    name: 'view_diff',
    description: 'View the current git diff of working changes in the repository.',
    permission: 'automatic'
  },
  {
    name: 'read_currently_open_file',
    description: 'Read the currently active open file in the VS Code editor.',
    permission: 'ask_first'
  },
  {
    name: 'ls',
    description: 'List files and folders in a given workspace directory.',
    permission: 'automatic'
  },
  {
    name: 'create_rule_block',
    description: 'Create a reusable rule that can be referenced in future prompts.',
    permission: 'excluded'
  },
  {
    name: 'view_problems',
    description: 'Inspect active compiler, linter, and TypeScript/JS diagnostics in the workspace.',
    permission: 'automatic'
  },
  {
    name: 'codebase_search',
    description: 'Search the local indexed @codebase for relevant functions, classes, and snippets.',
    permission: 'automatic'
  },
  {
    name: 'read_terminal',
    description: 'List the open integrated terminal names. VS Code does not expose existing terminal scrollback to extensions.',
    permission: 'automatic'
  },
  {
    name: 'fetch_url',
    description: 'Fetch and extract readable text from an external HTTP/HTTPS URL.',
    permission: 'ask_first'
  },
  {
    name: 'search_web',
    description: 'Search the web for up-to-date documentation or error references.',
    permission: 'excluded'
  }
];

function createDefaultConfigProfile(id = 'main', name = 'Main Config') {
  return {
    id,
    name,
    models: [
      {
        id: 'model-ollama-llama31',
        title: 'Llama 3.1 8B',
        provider: 'ollama',
        model: 'llama3.1:8b',
        apiBase: 'http://localhost:11434/v1',
        roles: ['chat', 'edit', 'apply'],
        requiresApiKey: false,
        secretKeyId: SecretManager.buildKeyId('model-ollama-llama31')
      },
      {
        id: 'model-openrouter-router',
        title: 'Free Models Router',
        provider: 'openrouter',
        model: 'openrouter/free',
        apiBase: 'https://openrouter.ai/api/v1',
        roles: ['chat', 'edit', 'apply'],
        requiresApiKey: true,
        secretKeyId: SecretManager.buildKeyId('model-openrouter-router')
      },
      {
        id: 'model-ollama-nomic-embed',
        title: 'nomic-embed-text',
        provider: 'ollama',
        model: 'nomic-embed-text',
        apiBase: 'http://localhost:11434/v1',
        roles: ['embed'],
        requiresApiKey: false,
        secretKeyId: SecretManager.buildKeyId('model-ollama-nomic-embed')
      }
    ],
    roles: {
      chat: 'model-ollama-llama31',
      autocomplete: '',
      edit: 'model-openrouter-router',
      apply: 'model-openrouter-router',
      embed: 'model-ollama-nomic-embed',
      rerank: ''
    },
    rules: [
      {
        id: 'rule-clean-js',
        name: 'Clean Code Standards',
        description: 'Write modular, well-documented code with explicit error handling.',
        content: 'Follow clean modular architecture, validate inputs, and avoid leaving unused variables or plain-text secrets.',
        enabled: true
      }
    ],
    skills: [
      {
        id: 'skill-code-review',
        name: 'Code Review',
        description: 'Review code for correctness, security, and maintainability.',
        trigger: 'review, code review',
        instructions: 'Analyze the requested code carefully. Report concrete findings first, ordered by severity, and include file references and suggested fixes. Do not restate the code or make speculative claims.',
        enabled: true
      },
      {
        id: 'skill-debugging',
        name: 'Debugging',
        description: 'Diagnose failures and implement a verified fix.',
        trigger: 'debug, fix, error, exception',
        instructions: 'Diagnose the root cause from available evidence. Reproduce or explain the failure, identify the smallest correct fix, add or update focused tests, and verify the result.',
        enabled: true
      },
      {
        id: 'skill-test-generation',
        name: 'Test Generation',
        description: 'Create focused tests for behavior and edge cases.',
        trigger: 'test, unit test, tests',
        instructions: 'Inspect the implementation and existing test conventions. Add focused tests that cover the changed behavior and meaningful edge cases. Prefer the smallest test command that verifies the change.',
        enabled: true
      }
    ],
    toolsEnabled: true,
    tools: DEFAULT_BUILTIN_TOOLS.map((t) => ({ ...t })),
    providerConnections: [],
    indexing: {
      enabled: true,
      chunkSizeLines: 60,
      maxFileSizeKb: 512,
      docs: []
    },
    settings: {
      autocompleteEnabled: true,
      autocompleteDelayMs: 350,
      streamResponses: true,
      temperature: 0.2,
      maxTokens: 4096
    }
  };
}

function sanitizeModel(model) {
  const copy = { ...model };
  // Strict security invariant: NEVER persist plain-text apiKey in config
  delete copy.apiKey;
  if (!copy.secretKeyId) {
    copy.secretKeyId = SecretManager.buildKeyId(copy.id);
  }
  return copy;
}

function normalizeCompletionOptions(input, provider) {
  const source = input && typeof input === 'object' ? input : {};
  const options = {};
  const readNumber = (key, label, min, max, integer = false) => {
    const raw = source[key];
    if (raw === undefined || raw === null || raw === '') return;
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    ) {
      throw new Error(`${label} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
    }
    options[key] = value;
  };

  readNumber('temperature', 'Temperature', 0, provider === 'anthropic' ? 1 : 2);
  readNumber('maxTokens', 'Max output tokens', 1, 262144, true);
  readNumber('topP', 'Top P', 0, 1);
  if (provider !== 'anthropic') {
    readNumber('frequencyPenalty', 'Frequency penalty', -2, 2);
    readNumber('presencePenalty', 'Presence penalty', -2, 2);
  }
  if (provider === 'ollama') {
    readNumber('contextLength', 'Context length', 512, 262144, true);
    readNumber('topK', 'Top K', 1, 1000, true);
    readNumber('repeatPenalty', 'Repeat penalty', 0.1, 2);
  }

  return options;
}

class ConfigManager {
  /**
   * @param {import('vscode').Memento} globalState
   * @param {SecretManager} secretManager
   */
  constructor(globalState, secretManager) {
    this._state = globalState;
    this._secrets = secretManager;
    this._data = this._load();
  }

  _load() {
    const saved = this._state.get(STORAGE_KEY);
    if (saved && Array.isArray(saved.profiles) && saved.profiles.length > 0) {
      return {
        activeProfileId: saved.activeProfileId || saved.profiles[0].id,
        profiles: saved.profiles.map((p) => ({
          ...createDefaultConfigProfile(p.id, p.name),
          ...p,
          models: Array.isArray(p.models) ? p.models.map(sanitizeModel) : [],
          providerConnections: Array.isArray(p.providerConnections)
            ? p.providerConnections.map((connection) => ({
                ...connection,
                models: Array.isArray(connection.models) ? connection.models : []
              }))
            : [],
          tools: this._mergeTools(p.tools),
          indexing: {
            ...createDefaultConfigProfile().indexing,
            ...(p.indexing || {})
          },
          settings: {
            ...createDefaultConfigProfile().settings,
            ...(p.settings || {})
          },
          skills: Array.isArray(p.skills)
            ? p.skills
            : createDefaultConfigProfile(p.id, p.name).skills
        }))
      };
    }
    const defaultProfile = createDefaultConfigProfile();
    return {
      activeProfileId: defaultProfile.id,
      profiles: [defaultProfile]
    };
  }

  _mergeTools(savedTools) {
    const savedMap = new Map((savedTools || []).map((t) => [t.name, t]));
    return DEFAULT_BUILTIN_TOOLS.map((def) => {
      const existing = savedMap.get(def.name);
      return existing ? { ...def, permission: existing.permission || def.permission } : { ...def };
    });
  }

  async _save() {
    const sanitized = {
      activeProfileId: this._data.activeProfileId,
      profiles: this._data.profiles.map((p) => ({
        ...p,
        models: p.models.map(sanitizeModel)
      }))
    };
    await this._state.update(STORAGE_KEY, sanitized);
  }

  getActiveProfile() {
    return (
      this._data.profiles.find((p) => p.id === this._data.activeProfileId) ||
      this._data.profiles[0]
    );
  }

  _getProviderModel(profile, reference) {
    const parsed = parseProviderModelReference(reference);
    if (!parsed) return null;
    const connection = (profile.providerConnections || []).find(
      (candidate) => candidate.id === parsed.providerId
    );
    const model = connection?.models.find((candidate) => candidate.id === parsed.modelId);
    if (!connection || !model) return null;
    return {
      id: reference,
      title: `${connection.title} / ${model.label || model.id}`,
      provider: connection.provider,
      model: model.id,
      apiBase: connection.apiBase,
      requiresApiKey: connection.requiresApiKey,
      secretKeyId: connection.secretKeyId,
      completionOptions: connection.completionOptions || {},
      roles: Array.isArray(model.roles) ? model.roles : ['chat', 'autocomplete', 'edit', 'apply']
    };
  }

  _getModelOptions(profile, role) {
    const legacyModels = profile.models.filter((model) => model.roles.includes(role));
    const providerModels = (profile.providerConnections || []).flatMap((connection) =>
      connection.models
        .filter((model) => {
          const roles = Array.isArray(model.roles) ? model.roles : ['chat', 'autocomplete', 'edit', 'apply'];
          return roles.includes(role);
        })
        .map((model) =>
          this._getProviderModel(
            profile,
            providerModelReference(connection.id, model.id)
          )
        )
        .filter(Boolean)
    );
    return [...legacyModels, ...providerModels];
  }

  getAvailableModels(role) {
    if (!MODEL_ROLES.includes(role)) return [];
    return this._getModelOptions(this.getActiveProfile(), role);
  }

  async saveProviderConnection(connectionInput, apiKey) {
    const profile = this.getActiveProfile();
    const provider = String(connectionInput.provider || '');
    const id = connectionInput.id || `provider-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = (profile.providerConnections || []).find((connection) => connection.id === id);
    if (!provider || !Array.isArray(connectionInput.models) || connectionInput.models.length === 0) {
      throw new Error('Load at least one provider model before saving this connection.');
    }

    const providerChanged = existing && existing.provider !== provider;
    const secretKeyId = providerChanged
      ? SecretManager.buildKeyId(`${id}-${provider}`)
      : connectionInput.secretKeyId || existing?.secretKeyId || SecretManager.buildKeyId(id);
    const defaultRoles = provider === 'voyage' || provider === 'jina'
      ? ['embed', 'rerank']
      : provider === 'cohere'
        ? ['chat', 'embed', 'rerank']
        : ['chat', 'autocomplete', 'edit', 'apply'];
    const connection = {
      id,
      title: String(connectionInput.title || provider).trim(),
      provider,
      apiBase: String(connectionInput.apiBase || '').trim(),
      requiresApiKey: provider !== 'ollama',
      secretKeyId,
      completionOptions: normalizeCompletionOptions(connectionInput.completionOptions, provider),
      models: connectionInput.models
        .filter((model) => typeof model?.id === 'string' && model.id.trim())
        .map((model) => ({
          id: model.id.trim(),
          label: String(model.label || model.id).trim(),
          roles: Array.isArray(model.roles) && model.roles.length
            ? model.roles.filter((role) => MODEL_ROLES.includes(role))
            : defaultRoles
        }))
        .filter((model, index, models) => models.findIndex((candidate) => candidate.id === model.id) === index)
    };
    if (connection.models.length === 0) {
      throw new Error('The provider model catalog did not contain usable model IDs.');
    }

    if (!Array.isArray(profile.providerConnections)) profile.providerConnections = [];
    const existingIndex = profile.providerConnections.findIndex((candidate) => candidate.id === id);
    if (existingIndex < 0) profile.providerConnections.push(connection);
    else profile.providerConnections[existingIndex] = connection;

    if (typeof apiKey === 'string' && apiKey.trim()) {
      await this._secrets.setApiKey(secretKeyId, apiKey.trim());
    }

    for (const role of MODEL_ROLES) {
      if (!profile.roles[role] && connection.models.some((model) => model.roles.includes(role))) {
        profile.roles[role] = providerModelReference(id, connection.models.find((model) =>
          model.roles.includes(role)
        ).id);
      }
    }

    await this._save();
    if (providerChanged) await this._secrets.deleteApiKey(existing.secretKeyId);
    return connection;
  }

  async deleteProviderConnection(connectionId) {
    const profile = this.getActiveProfile();
    const connection = (profile.providerConnections || []).find((candidate) => candidate.id === connectionId);
    if (!connection) return;
    await this._secrets.deleteApiKey(connection.secretKeyId);
    profile.providerConnections = profile.providerConnections.filter(
      (candidate) => candidate.id !== connectionId
    );
    for (const role of MODEL_ROLES) {
      if (parseProviderModelReference(profile.roles[role])?.providerId === connectionId) {
        const fallback = this._getModelOptions(profile, role)[0];
        profile.roles[role] = fallback?.id || '';
      }
    }
    await this._save();
  }

  getProfilesSummary() {
    const activeProfileId = this.getActiveProfile().id;
    return this._data.profiles.map((profile) => {
      const modelAssignments = {};
      for (const [role, modelId] of Object.entries(profile.roles || {})) {
        const model = profile.models.find((candidate) => candidate.id === modelId) ||
          this._getProviderModel(profile, modelId);
        if (model) modelAssignments[role] = model.title;
      }
      return {
        id: profile.id,
        name: profile.name,
        modelCount: profile.models.length +
          (profile.providerConnections || []).reduce((count, connection) => count + connection.models.length, 0),
        modelAssignments,
        isActive: profile.id === activeProfileId
      };
    });
  }

  async setActiveProfile(profileId) {
    const found = this._data.profiles.find((p) => p.id === profileId);
    if (!found) throw new Error(`Config profile "${profileId}" not found.`);
    this._data.activeProfileId = profileId;
    await this._save();
    return found;
  }

  async createProfile(name, cloneFromId) {
    const id = `cfg-${Date.now()}`;
    const source = cloneFromId
      ? this._data.profiles.find((p) => p.id === cloneFromId)
      : null;
    const base = source
      ? JSON.parse(JSON.stringify(source))
      : createDefaultConfigProfile(id, name);
    base.id = id;
    base.name = name || 'Custom Config';
    base.models = base.models.map(sanitizeModel);
    this._data.profiles.push(base);
    this._data.activeProfileId = id;
    await this._save();
    return base;
  }

  async deleteProfile(profileId) {
    if (this._data.profiles.length <= 1) {
      throw new Error('Cannot delete the last remaining configuration profile.');
    }
    this._data.profiles = this._data.profiles.filter((p) => p.id !== profileId);
    if (this._data.activeProfileId === profileId) {
      this._data.activeProfileId = this._data.profiles[0].id;
    }
    await this._save();
  }

  async saveModel(modelInput, apiKey) {
    const profile = this.getActiveProfile();
    const id = modelInput.id || `model-${Date.now()}`;
    const existingModel = profile.models.find((model) => model.id === id);
    const providerChanged = existingModel && existingModel.provider !== modelInput.provider;
    const secretKeyId = providerChanged
      ? SecretManager.buildKeyId(`${id}-${modelInput.provider}`)
      : modelInput.secretKeyId || existingModel?.secretKeyId || SecretManager.buildKeyId(id);
    const cleanModel = sanitizeModel({
      ...modelInput,
      id,
      secretKeyId,
      completionOptions: normalizeCompletionOptions(
        modelInput.completionOptions,
        modelInput.provider
      ),
      roles: Array.isArray(modelInput.roles) && modelInput.roles.length > 0
        ? modelInput.roles
        : ['chat']
    });

    const idx = profile.models.findIndex((m) => m.id === id);
    if (idx >= 0) {
      profile.models[idx] = cleanModel;
    } else {
      profile.models.push(cleanModel);
    }

    // Store API key exclusively in SecretStorage if provided
    if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
      await this._secrets.setApiKey(secretKeyId, apiKey.trim());
    }

    // Auto-assign role if currently empty
    for (const role of cleanModel.roles) {
      if (!profile.roles[role]) {
        profile.roles[role] = cleanModel.id;
      }
    }

    await this._save();
    return cleanModel;
  }

  async deleteModel(modelId) {
    const profile = this.getActiveProfile();
    const target = profile.models.find((m) => m.id === modelId);
    if (!target) return;
    await this._secrets.deleteApiKey(target.secretKeyId);
    profile.models = profile.models.filter((m) => m.id !== modelId);
    for (const role of Object.keys(profile.roles)) {
      if (profile.roles[role] === modelId) {
        const fallback = this._getModelOptions(profile, role)[0];
        profile.roles[role] = fallback ? fallback.id : '';
      }
    }
    await this._save();
  }

  async setRoleModel(role, modelId) {
    if (!MODEL_ROLES.includes(role)) throw new Error(`Unknown model role "${role}".`);
    const profile = this.getActiveProfile();
    if (modelId && !this._getModelOptions(profile, role).some((model) => model.id === modelId)) {
      throw new Error(`The selected model is not available for the ${role} role.`);
    }
    profile.roles[role] = modelId || '';
    await this._save();
  }

  getModelForRole(role) {
    const profile = this.getActiveProfile();
    const assignedId = profile.roles[role];
    if (assignedId) {
      const exact = profile.models.find((m) => m.id === assignedId) ||
        this._getProviderModel(profile, assignedId);
      if (exact) return exact;
    }
    if (role === 'chat') {
      return this._getModelOptions(profile, role)[0] || profile.models[0] || null;
    }
    return null;
  }

  async cycleChatModel() {
    const profile = this.getActiveProfile();
    const chatModels = this._getModelOptions(profile, 'chat');
    if (chatModels.length === 0) return null;
    const currentIdx = chatModels.findIndex((m) => m.id === profile.roles.chat);
    const next = chatModels[(currentIdx + 1) % chatModels.length];
    profile.roles.chat = next.id;
    await this._save();
    return next;
  }

  async setToolPermission(toolName, permission) {
    const profile = this.getActiveProfile();
    const tool = profile.tools.find((t) => t.name === toolName);
    if (tool && ['automatic', 'ask_first', 'excluded'].includes(permission)) {
      tool.permission = permission;
      await this._save();
    }
  }

  async setToolsMasterEnabled(enabled) {
    const profile = this.getActiveProfile();
    profile.toolsEnabled = Boolean(enabled);
    await this._save();
  }

  async saveRule(ruleInput) {
    const profile = this.getActiveProfile();
    const id = ruleInput.id || `rule-${Date.now()}`;
    const cleanRule = {
      id,
      name: String(ruleInput.name || 'Untitled Rule').trim(),
      description: String(ruleInput.description || '').trim(),
      content: String(ruleInput.content || '').trim(),
      enabled: ruleInput.enabled !== false
    };
    const idx = profile.rules.findIndex((r) => r.id === id);
    if (idx >= 0) {
      profile.rules[idx] = cleanRule;
    } else {
      profile.rules.push(cleanRule);
    }
    await this._save();
    return cleanRule;
  }

  async deleteRule(ruleId) {
    const profile = this.getActiveProfile();
    profile.rules = profile.rules.filter((r) => r.id !== ruleId);
    await this._save();
  }

  async saveSkill(skillInput) {
    const profile = this.getActiveProfile();
    const id = skillInput.id || `skill-${Date.now()}`;
    const cleanSkill = {
      id,
      name: String(skillInput.name || 'Untitled Skill').trim(),
      description: String(skillInput.description || '').trim(),
      trigger: String(skillInput.trigger || '').trim(),
      instructions: String(skillInput.instructions || '').trim(),
      enabled: skillInput.enabled !== false
    };
    const idx = profile.skills.findIndex((skill) => skill.id === id);
    if (idx >= 0) {
      profile.skills[idx] = cleanSkill;
    } else {
      profile.skills.push(cleanSkill);
    }
    await this._save();
    return cleanSkill;
  }

  async deleteSkill(skillId) {
    const profile = this.getActiveProfile();
    profile.skills = profile.skills.filter((skill) => skill.id !== skillId);
    await this._save();
  }

  async updateIndexingSettings(patch) {
    const profile = this.getActiveProfile();
    profile.indexing = { ...profile.indexing, ...patch };
    await this._save();
    return profile.indexing;
  }

  async updateGeneralSettings(patch) {
    const profile = this.getActiveProfile();
    profile.settings = { ...profile.settings, ...patch };
    await this._save();
    return profile.settings;
  }

  /**
   * Build a Webview-safe state snapshot with masked secret indicators (never raw keys).
   */
  async getPublicState() {
    const profile = this.getActiveProfile();
    const modelsWithSecretStatus = await Promise.all(
      profile.models.map(async (m) => ({
        ...m,
        hasApiKey: await this._secrets.hasApiKey(m.secretKeyId),
        maskedApiKey: await this._secrets.getMaskedStatus(m.secretKeyId)
      }))
    );
    const providerConnections = await Promise.all(
      (profile.providerConnections || []).map(async (connection) => ({
        id: connection.id,
        title: connection.title,
        provider: connection.provider,
        apiBase: connection.apiBase,
        requiresApiKey: connection.requiresApiKey,
        hasApiKey: await this._secrets.hasApiKey(connection.secretKeyId),
        maskedApiKey: await this._secrets.getMaskedStatus(connection.secretKeyId),
        models: connection.models
      }))
    );
    const availableModelsByRole = Object.fromEntries(
      MODEL_ROLES.map((role) => [role, this._getModelOptions(profile, role)])
    );

    return {
      activeProfileId: profile.id,
      profiles: this.getProfilesSummary(),
      profile: {
        ...profile,
        models: modelsWithSecretStatus,
        providerConnections,
        availableModelsByRole
      }
    };
  }
}

const configManagerExports = {
  ConfigManager,
  DEFAULT_BUILTIN_TOOLS,
  createDefaultConfigProfile,
  sanitizeModel
};

export { ConfigManager, DEFAULT_BUILTIN_TOOLS, createDefaultConfigProfile, sanitizeModel };
export default configManagerExports;
