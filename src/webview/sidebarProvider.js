'use strict';

import { readFileSync } from 'fs';
import { join } from 'path';
import { CONTEXT_PROVIDERS } from '../context/contextProviders.js';

class SidebarProvider {
  /**
   * @param {typeof import('vscode')} vscode
   * @param {import('vscode').ExtensionContext} context
   * @param {Object} services
   */
  constructor(vscode, context, services) {
    this._vscode = vscode;
    this._context = context;
    this._secrets = services.secretManager;
    this._config = services.configManager;
    this._sessions = services.sessionManager;
    this._llm = services.llmClient;
    this._indexer = services.indexer;
    this._contextProviders = services.contextProviders;
    this._tools = services.toolsRunner;

    this._view = null;
    this._mode = 'chat'; // 'chat' | 'plan' | 'agent'
    this._abortController = null;
    this._activeChatTurn = null;
    this._reindexPromise = null;
    this._reindexRoot = '';
    this._pendingApprovals = new Map();
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui')]
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
  }

  postMessage(payload) {
    if (this._view) {
      this._view.webview.postMessage(payload);
    }
  }

  async pushFullState() {
    const publicConfig = await this._config.getPublicState();
    const activeSession = await this._sessions.getActiveSession();
    const lastSession = this._sessions.getLastNonEmptySession();
    this.postMessage({
      type: 'stateUpdate',
      state: {
        mode: this._mode,
        config: publicConfig,
        indexStatus: this._indexer.getStatus(),
        activeSession,
        lastSessionSummary: lastSession
          ? { id: lastSession.id, title: lastSession.title, messageCount: lastSession.messages.length }
          : null,
        sessions: this._sessions.listSessions(),
        contextProviders: CONTEXT_PROVIDERS
      }
    });
  }

  async cycleMode() {
    const order = ['chat', 'plan', 'agent'];
    this._mode = order[(order.indexOf(this._mode) + 1) % order.length];
    await this.pushFullState();
    return this._mode;
  }

  async openSettings(tab = 'models') {
    this.postMessage({ type: 'navigateSettings', tab });
  }

  async sendSelectionToChat(text, fileName, lineRange) {
    this.postMessage({
      type: 'prefillSelection',
      selection: {
        text,
        fileName,
        lineRange
      }
    });
  }

  async _handleMessage(msg) {
    try {
      switch (msg.type) {
        case 'ready':
          await this.pushFullState();
          break;

        case 'setMode':
          if (['chat', 'plan', 'agent'].includes(msg.mode)) {
            this._mode = msg.mode;
            await this.pushFullState();
          }
          break;

        case 'sendMessage':
          if (this._activeChatTurn) {
            this.postMessage({
              type: 'errorToast',
              message: 'A chat response is already in progress.'
            });
            break;
          }
          {
            const activeChatTurn = this._runChatTurn(msg);
            this._activeChatTurn = activeChatTurn;
            try {
              await activeChatTurn;
            } finally {
              if (this._activeChatTurn === activeChatTurn) this._activeChatTurn = null;
            }
          }
          break;

        case 'stopGeneration':
          if (this._abortController) {
            this._abortController.abort();
          }
          break;

        case 'toolApprovalResponse': {
          const pending = this._pendingApprovals.get(msg.approvalId);
          if (pending) {
            this._pendingApprovals.delete(msg.approvalId);
            pending.cleanup();
            pending.resolve(Boolean(msg.approved));
          }
          break;
        }

        case 'searchContextProvider': {
          let items;
          let error;
          try {
            items = await this._contextProviders.searchProviderItems(msg.providerId, msg.query);
          } catch (err) {
            items = [];
            error = err.message || 'Context search failed.';
          }
          this.postMessage({
            type: 'contextProviderResults',
            providerId: msg.providerId,
            requestId: msg.requestId,
            items,
            error
          });
          break;
        }

        case 'newSession':
          await this._stopActiveChatTurn();
          await this._sessions.createSession();
          await this.pushFullState();
          break;

        case 'switchSession':
          if (msg.sessionId !== (await this._sessions.getActiveSession()).id) {
            await this._stopActiveChatTurn();
          }
          await this._sessions.switchSession(msg.sessionId);
          await this.pushFullState();
          break;

        case 'restoreLastSession': {
          const last = this._sessions.getLastNonEmptySession();
          if (last) {
            if (last.id !== (await this._sessions.getActiveSession()).id) {
              await this._stopActiveChatTurn();
            }
            await this._sessions.switchSession(last.id);
            await this.pushFullState();
          }
          break;
        }

        case 'deleteSession':
          if (msg.sessionId === (await this._sessions.getActiveSession()).id) {
            await this._stopActiveChatTurn();
          }
          await this._sessions.deleteSession(msg.sessionId);
          await this.pushFullState();
          break;

        case 'setRoleModel':
          await this._config.setRoleModel(msg.role, msg.modelId);
          await this.pushFullState();
          break;

        case 'testModel':
          await this._testModel(msg.role, msg.modelId);
          break;

        case 'listModels': {
          const provider = String(msg.provider || '');
          const allowedProviders = [
            'openai', 'anthropic', 'gemini', 'openrouter', 'voyage',
            'cohere', 'jina', 'custom', 'ollama'
          ];
          if (!allowedProviders.includes(provider)) {
            this.postMessage({
              type: 'modelsListed',
              requestId: msg.requestId,
              provider,
              error: 'Select a supported model provider.'
            });
            break;
          }

          const profile = this._config.getActiveProfile();
          const existingModel = profile.models.find(
            (model) => model.id === msg.modelId && model.provider === provider
          );
          const existingConnection = (profile.providerConnections || []).find(
            (connection) => connection.id === msg.connectionId && connection.provider === provider
          );
          try {
            const models = await this._llm.listModels(
              {
                title: existingConnection?.title || existingModel?.title || provider,
                provider,
                apiBase: String(msg.apiBase || existingConnection?.apiBase || ''),
                requiresApiKey: provider !== 'ollama',
                secretKeyId: existingConnection?.secretKeyId || existingModel?.secretKeyId
              },
              typeof msg.apiKey === 'string' ? msg.apiKey : '',
              String(msg.role || 'chat')
            );
            this.postMessage({
              type: 'modelsListed',
              requestId: msg.requestId,
              provider,
              connectionId: msg.connectionId,
              models
            });
          } catch (err) {
            this.postMessage({
              type: 'modelsListed',
              requestId: msg.requestId,
              provider,
              connectionId: msg.connectionId,
              error: err.message || 'Unable to load models.'
            });
          }
          break;
        }

        case 'saveProviderConnection':
          await this._config.saveProviderConnection(msg.connection, msg.apiKey);
          await this.pushFullState();
          this.postMessage({
            type: 'providerConnectionSaved',
            requestId: msg.requestId,
            connectionId: msg.connection.id
          });
          break;

        case 'deleteProviderConnection':
          await this._config.deleteProviderConnection(msg.connectionId);
          await this.pushFullState();
          break;

        case 'saveModel':
          await this._config.saveModel(msg.model, msg.apiKey);
          await this.pushFullState();
          break;

        case 'deleteModel':
          await this._config.deleteModel(msg.modelId);
          await this.pushFullState();
          break;

        case 'setActiveProfile':
          await this._config.setActiveProfile(msg.profileId);
          await this.pushFullState();
          break;

        case 'createProfile':
          await this._config.createProfile(msg.name, msg.cloneFromId);
          await this.pushFullState();
          break;

        case 'deleteProfile':
          await this._config.deleteProfile(msg.profileId);
          await this.pushFullState();
          break;

        case 'saveRule':
          await this._config.saveRule(msg.rule);
          await this.pushFullState();
          break;

        case 'deleteRule':
          await this._config.deleteRule(msg.ruleId);
          await this.pushFullState();
          break;

        case 'saveSkill':
          await this._config.saveSkill(msg.skill);
          await this.pushFullState();
          break;

        case 'deleteSkill':
          await this._config.deleteSkill(msg.skillId);
          await this.pushFullState();
          break;

        case 'setToolPermission':
          await this._config.setToolPermission(msg.toolName, msg.permission);
          await this.pushFullState();
          break;

        case 'setToolsMasterEnabled':
          await this._config.setToolsMasterEnabled(msg.enabled);
          await this.pushFullState();
          break;

        case 'toggleIndexing':
          await this._config.updateIndexingSettings({ enabled: Boolean(msg.enabled) });
          if (msg.enabled) await this.triggerReindex();
          await this.pushFullState();
          break;

        case 'reindexCodebase':
          await this.triggerReindex(true);
          break;

        case 'addDocSource': {
          const profile = this._config.getActiveProfile();
          const newDoc = {
            id: `doc-${Date.now()}`,
            title: String(msg.title || msg.url).trim(),
            url: String(msg.url || '').trim(),
            chunkCount: 0
          };
          const count = await this._indexer.indexDocumentationSource(newDoc);
          newDoc.chunkCount = count;
          const updatedDocs = [...(profile.indexing.docs || []), newDoc];
          await this._config.updateIndexingSettings({ docs: updatedDocs });
          await this.pushFullState();
          break;
        }

        case 'removeDocSource': {
          const profile = this._config.getActiveProfile();
          this._indexer.removeDocumentationSource(msg.docId);
          const updatedDocs = (profile.indexing.docs || []).filter((d) => d.id !== msg.docId);
          await this._config.updateIndexingSettings({ docs: updatedDocs });
          await this.pushFullState();
          break;
        }

        case 'updateGeneralSettings':
          await this._config.updateGeneralSettings(msg.settings);
          await this.pushFullState();
          break;

        case 'applyCodeBlock':
          await this._applyCodeToActiveEditor(msg.code);
          break;

        case 'editCodeBlock':
          await this._editCodeBlock(msg.code);
          break;

        case 'copyCodeBlock':
          await this._vscode.env.clipboard.writeText(String(msg.code || ''));
          this._vscode.window.setStatusBarMessage('CodePilot AI: Copied to clipboard', 2000);
          break;

        default:
          break;
      }
    } catch (err) {
      this.postMessage({
        type: 'errorToast',
        message: err.message || 'An unexpected error occurred.'
      });
    }
  }

  async _testModel(role, modelId) {
    if (!['chat', 'edit', 'autocomplete', 'apply', 'embed', 'rerank'].includes(role)) {
      this.postMessage({
        type: 'modelTestResult',
        role,
        success: false,
        error: 'This model role cannot be tested.'
      });
      return;
    }

    const model = modelId
      ? this._config.getAvailableModels(role).find((candidate) => candidate.id === modelId)
      : this._config.getModelForRole(role) ||
        (['edit', 'apply', 'autocomplete'].includes(role)
          ? this._config.getModelForRole('chat')
          : null);
    if (!model) {
      this.postMessage({
        type: 'modelTestResult',
        role,
        success: false,
        error: `No ${role[0].toUpperCase()}${role.slice(1)} model is assigned.`
      });
      return;
    }

    try {
      if (role === 'embed') {
        const vectors = await this._llm.embedTexts(
          model,
          ['CodePilot embedding test']
        );
        this.postMessage({
          type: 'modelTestResult',
          role,
          modelTitle: model.title,
          success: vectors.length > 0 && Array.isArray(vectors[0]) && vectors[0].length > 0,
          matched: true,
          response: vectors.length > 0
            ? `Returned an embedding vector with ${vectors[0].length} dimensions.`
            : 'The embedding endpoint returned no vectors.',
          error: vectors.length > 0 ? undefined : 'The embedding endpoint returned no vectors.'
        });
        return;
      }
      if (role === 'rerank') {
        const reranked = await this._llm.rerankTexts(
          model,
          'The authentication service validates API tokens.',
          [
            'Authentication service: API tokens are validated against the secret store.',
            'Weather service: temperatures are converted between Celsius and Fahrenheit.'
          ],
          1
        );
        const rankedCorrectly =
          reranked.length > 0 &&
          reranked[0].index === 0 &&
          Number.isFinite(reranked[0].score);
        this.postMessage({
          type: 'modelTestResult',
          role,
          modelTitle: model.title,
          success: rankedCorrectly,
          matched: rankedCorrectly,
          response: reranked.length > 0
            ? `Ranked the authentication document as index ${reranked[0].index} with score ${reranked[0].score}.`
            : 'The rerank endpoint returned no results.',
          error: rankedCorrectly
            ? undefined
            : reranked.length === 0
              ? 'The rerank endpoint returned no results.'
              : 'The rerank endpoint did not rank the clearly relevant authentication document first.'
        });
        return;
      }
      const rolePrompts = {
        chat: {
          system: 'This is a model connection check. Follow the user instruction exactly and do not add any other text.',
          user: 'Reply with exactly: CodePilot test passed.',
          match: (text) => text.toLowerCase().includes('codepilot test passed')
        },
        edit: {
          system: 'You are a code editor. Return only the transformed code without markdown fences or commentary.',
          user: 'Change the JavaScript function name from "oldName" to "newName" in: function oldName() { return 1; }',
          match: (text) => text.includes('newName') && text.includes('oldName') === false
        },
        apply: {
          system: 'You merge a code update into existing source code. Return only the complete updated code without markdown fences or commentary.',
          user: 'Add a semicolon to the final line and return the complete code: const value = 1',
          match: (text) => text.includes('const value = 1;')
        },
        autocomplete: {
          system: 'Complete code at the cursor. Return only the continuation text, without markdown fences or commentary.',
          user: 'function add(a, b) {',
          match: (text) => text.includes('return') && text.includes('a') && text.includes('b')
        }
      };
      const prompt = rolePrompts[role] || rolePrompts.chat;
      const result = await this._llm.chat({
        modelConfig: model,
        stream: false,
        temperature: 0,
        maxTokens: 48,
        messages: [
          {
            role: 'system',
            content: prompt.system
          },
          {
            role: 'user',
            content: prompt.user
          }
        ]
      });
      const response = String(result.content || '').trim();
      const matched = response.length > 0 && prompt.match(response);
      this.postMessage({
        type: 'modelTestResult',
        role,
        modelTitle: model.title,
        success: matched,
        matched,
        response: response.slice(0, 240),
        error: response
          ? (matched ? undefined : `The ${role} model responded, but did not satisfy the role-specific test.`)
          : 'The model returned an empty response.'
      });
    } catch (err) {
      this.postMessage({
        type: 'modelTestResult',
        role,
        modelTitle: model.title,
        success: false,
        error: err.message || 'The model request failed.'
      });
    }
  }

  async triggerReindex(force = false) {
    const profile = this._config.getActiveProfile();
    if (!profile.indexing.enabled) return;
    const root = this._vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (!force && this._indexer.isIndexedFor(root)) return;
    if (this._reindexPromise && this._reindexRoot !== root) {
      try {
        await this._reindexPromise;
      } catch (_) {
        // Continue with the newly selected workspace after the previous run stops.
      }
      return this.triggerReindex(force);
    }

    if (!this._reindexPromise) {
      this._reindexRoot = root;
      this._reindexPromise = (async () => {
        const embedModel = this._config.getModelForRole('embed');
        await this._indexer.indexWorkspace(root, {
          chunkSizeLines: profile.indexing.chunkSizeLines,
          maxFileSizeKb: profile.indexing.maxFileSizeKb,
          embedModel,
          onProgress: (status) => {
            this.postMessage({ type: 'indexProgress', status });
          }
        });
        await this.pushFullState();
      })();
    }

    const reindexPromise = this._reindexPromise;
    try {
      await reindexPromise;
    } finally {
      if (this._reindexPromise === reindexPromise) {
        this._reindexPromise = null;
        this._reindexRoot = '';
      }
    }
  }

  async _stopActiveChatTurn() {
    const activeChatTurn = this._activeChatTurn;
    if (!activeChatTurn) return;
    this._abortController?.abort();
    await activeChatTurn;
  }

  async _runChatTurn(msg) {
    const session = await this._sessions.getActiveSession();
    const userText = String(msg.text || '').trim();
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (!userText && attachments.length === 0) return;

    const abortController = new AbortController();
    this._abortController = abortController;
    const releaseAbortController = () => {
      if (this._abortController === abortController) this._abortController = null;
    };
    const userMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: userText,
      attachments: attachments.map((a) => ({ provider: a.provider, label: a.label })),
      skillIds: Array.isArray(msg.skillIds) ? msg.skillIds : [],
      mode: this._mode,
      timestamp: Date.now()
    };
    try {
      await this._sessions.appendMessage(session.id, userMessage);
    } catch (err) {
      releaseAbortController();
      throw err;
    }
    this.postMessage({ type: 'sessionMessageAdded', sessionId: session.id, message: userMessage });
    if (abortController.signal.aborted) {
      releaseAbortController();
      return;
    }

    const chatModel = this._config.getModelForRole('chat');
    if (!chatModel) {
      this.postMessage({
        type: 'assistantError',
        sessionId: session.id,
        error: 'No Chat model configured. Open Models settings to add or select a Chat model.'
      });
      releaseAbortController();
      return;
    }

    const profile = this._config.getActiveProfile();
    const activeRules = profile.rules.filter((r) => r.enabled);
    const requestedSkillIds = new Set(Array.isArray(msg.skillIds) ? msg.skillIds : []);
    const lowerUserText = userText.toLowerCase();
    const activeSkills = (profile.skills || []).filter((skill) => {
      if (!skill.enabled) return false;
      if (requestedSkillIds.has(skill.id)) return true;
      const triggers = String(skill.trigger || '')
        .split(',')
        .map((trigger) => trigger.trim().toLowerCase())
        .filter(Boolean);
      return triggers.some((trigger) => lowerUserText.includes(trigger));
    });
    let contextBlocks;
    try {
      if (attachments.some((attachment) => attachment.provider === 'codebase')) {
        await this.triggerReindex();
      }
      contextBlocks = await this._contextProviders.resolveAttachments(attachments, userText);
    } catch (err) {
      releaseAbortController();
      throw err;
    }
    if (abortController.signal.aborted) {
      releaseAbortController();
      return;
    }

    const systemParts = [
      'You are CodePilot AI, a precise, privacy-conscious AI coding assistant inside VS Code.',
      `Current Mode: ${this._mode.toUpperCase()}.`
    ];
    if (this._mode === 'plan') {
      systemParts.push(
        'In PLAN mode, produce a clear step-by-step architectural and implementation plan before making changes. Do not modify files.'
      );
    } else if (this._mode === 'agent') {
      systemParts.push(
        'In AGENT mode, you can call the provided workspace tools to inspect files, search @codebase, check diagnostics, and make targeted edits.'
      );
    }
    if (activeRules.length > 0) {
      systemParts.push(
        'Active Workspace Rules:\n' +
          activeRules.map((r) => `- ${r.name}: ${r.content}`).join('\n')
      );
    }
    if (activeSkills.length > 0) {
      systemParts.push(
        'Active Skills — follow these task-specific instructions:\n' +
          activeSkills
            .map((skill) => `## ${skill.name}\n${skill.description ? `${skill.description}\n` : ''}${skill.instructions}`)
            .join('\n\n')
      );
    }

    const llmMessages = [{ role: 'system', content: systemParts.join('\n\n') }];
    for (const m of session.messages.slice(-16)) {
      if (m.role === 'user' || m.role === 'assistant') {
        llmMessages.push({ role: m.role, content: m.content });
      }
    }
    if (contextBlocks.length > 0) {
      const last = llmMessages[llmMessages.length - 1];
      const ctxText = contextBlocks.map((b) => `## ${b.title}\n${b.content}`).join('\n\n');
      last.content = `${ctxText}\n\n---\nUser Request:\n${last.content}`;
    }

    const assistantMsgId = `msg-${Date.now() + 1}`;
    this.postMessage({
      type: 'streamStart',
      messageId: assistantMsgId,
      sessionId: session.id,
      modelTitle: chatModel.title
    });

    const tools = this._mode === 'agent' ? this._tools.getEnabledSchemas() : [];
    let accumulatedText = '';

    try {
      let iterations = 0;
      const maxAgentSteps = this._mode === 'agent' ? 6 : 1;

      while (iterations < maxAgentSteps) {
        if (abortController.signal.aborted) {
          const abortError = new Error('Generation stopped.');
          abortError.name = 'AbortError';
          throw abortError;
        }
        iterations += 1;
        const result = await this._llm.chat({
          modelConfig: chatModel,
          messages: llmMessages,
          tools,
          temperature: profile.settings.temperature,
          maxTokens: profile.settings.maxTokens,
          stream: profile.settings.streamResponses,
          signal: abortController.signal,
          onToken: (token) => {
            accumulatedText += token;
            this.postMessage({
              type: 'streamChunk',
              messageId: assistantMsgId,
              sessionId: session.id,
              chunk: token
            });
          }
        });

        if (!result.toolCalls || result.toolCalls.length === 0 || this._mode !== 'agent') {
          break;
        }

        llmMessages.push({
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
          }))
        });

        for (const tc of result.toolCalls) {
          let perm = this._tools.getPermission(tc.name);
          if (perm === 'automatic' && this._tools.requiresApproval?.(tc.name, tc.arguments)) {
            perm = 'ask_first';
          }
          let approved = perm === 'automatic';
          if (perm === 'ask_first') {
            approved = await this._requestToolApproval(assistantMsgId, tc, abortController.signal);
          }
          if (abortController.signal.aborted) {
            const abortError = new Error('Generation stopped.');
            abortError.name = 'AbortError';
            throw abortError;
          }

          let toolOutput = '';
          if (!approved) {
            toolOutput = `User denied execution of tool "${tc.name}".`;
          } else {
            try {
              toolOutput = await this._tools.execute(tc.name, tc.arguments);
            } catch (toolErr) {
              toolOutput = `Tool error: ${toolErr.message}`;
            }
          }

          if (abortController.signal.aborted) {
            const abortError = new Error('Generation stopped.');
            abortError.name = 'AbortError';
            throw abortError;
          }

          this.postMessage({
            type: 'toolResultNotice',
            messageId: assistantMsgId,
            toolName: tc.name,
            approved,
            preview: String(toolOutput).slice(0, 240)
          });

          llmMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: String(toolOutput)
          });
        }
      }

      const finalMsg = {
        id: assistantMsgId,
        role: 'assistant',
        content: accumulatedText || '(No response text)',
        modelTitle: chatModel.title,
        timestamp: Date.now()
      };
      await this._sessions.appendMessage(session.id, finalMsg);
      this.postMessage({
        type: 'streamEnd',
        messageId: assistantMsgId,
        sessionId: session.id,
        message: finalMsg
      });
    } catch (err) {
      if (abortController.signal.aborted || err.name === 'AbortError') {
        const partialMessage = accumulatedText.trim()
          ? {
              id: assistantMsgId,
              role: 'assistant',
              content: accumulatedText,
              modelTitle: chatModel.title,
              timestamp: Date.now(),
              interrupted: true
            }
          : null;
        if (partialMessage) await this._sessions.appendMessage(session.id, partialMessage);
        this.postMessage({
          type: 'streamEnd',
          messageId: assistantMsgId,
          sessionId: session.id,
          message: partialMessage,
          aborted: true
        });
      } else if (accumulatedText.trim()) {
        const partialMessage = {
          id: assistantMsgId,
          role: 'assistant',
          content: accumulatedText,
          modelTitle: chatModel.title,
          timestamp: Date.now(),
          incomplete: true
        };
        await this._sessions.appendMessage(session.id, partialMessage);
        this.postMessage({
          type: 'streamEnd',
          messageId: assistantMsgId,
          sessionId: session.id,
          message: partialMessage,
          error: err.message || 'Model request failed.'
        });
      } else {
        this.postMessage({
          type: 'assistantError',
          messageId: assistantMsgId,
          sessionId: session.id,
          error: err.message || 'Model request failed.'
        });
      }
    } finally {
      releaseAbortController();
    }
  }

  _requestToolApproval(messageId, toolCall, signal) {
    return new Promise((resolve) => {
      const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      if (signal.aborted) {
        resolve(false);
        return;
      }

      const onAbort = () => {
        this._pendingApprovals.delete(approvalId);
        this.postMessage({ type: 'toolApprovalCancelled', approvalId });
        resolve(false);
      };
      this._pendingApprovals.set(approvalId, {
        resolve,
        cleanup: () => signal.removeEventListener('abort', onAbort)
      });
      signal.addEventListener('abort', onAbort, { once: true });
      this.postMessage({
        type: 'toolApprovalRequest',
        approvalId,
        messageId,
        toolName: toolCall.name,
        arguments: toolCall.arguments
      });
    });
  }

  async _applyCodeToActiveEditor(code) {
    const editor = this._vscode.window.activeTextEditor;
    if (!editor) {
      this._vscode.window.showWarningMessage('CodePilot AI: Open a file in the editor to apply code.');
      return;
    }

    const doc = editor.document;
    const applyModel = this._config.getModelForRole('apply');

    // If selection exists, replace selection directly; otherwise use Apply model if configured
    if (!editor.selection.isEmpty) {
      await editor.edit((editBuilder) => {
        editBuilder.replace(editor.selection, code);
      });
      this._vscode.window.setStatusBarMessage('CodePilot AI: Applied code to selection', 2500);
      return;
    }

    if (applyModel) {
      try {
        this._vscode.window.setStatusBarMessage('CodePilot AI: Applying code with Apply model...', 3000);
        const res = await this._llm.chat({
          modelConfig: applyModel,
          stream: false,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'Merge the provided code snippet cleanly into the existing file. Return ONLY the complete updated file content without markdown fences.'
            },
            {
              role: 'user',
              content: `Existing file:\n${doc.getText()}\n\nSnippet to apply:\n${code}`
            }
          ]
        });
        const cleaned = res.content.replace(/^```[\w]*\n?/m, '').replace(/```\s*$/m, '');
        if (cleaned.trim()) {
          const fullRange = new this._vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
          );
          await editor.edit((eb) => eb.replace(fullRange, cleaned));
          this._vscode.window.setStatusBarMessage('CodePilot AI: Applied code to file', 2500);
          return;
        }
      } catch (_) {
        // Fall back to inserting at cursor
      }
    }

    await editor.edit((editBuilder) => {
      editBuilder.insert(editor.selection.active, code);
    });
    this._vscode.window.setStatusBarMessage('CodePilot AI: Inserted code at cursor', 2500);
  }

  async _editCodeBlock(code) {
    const editor = this._vscode.window.activeTextEditor;
    if (!editor) {
      this._vscode.window.showWarningMessage('CodePilot AI: Open a file in the editor to edit code.');
      return;
    }

    const instruction = await this._vscode.window.showInputBox({
      prompt: 'CodePilot AI: Describe how to edit this code',
      placeHolder: 'e.g., Add validation and JSDoc comments'
    });
    if (!instruction) return;

    const editModel = this._config.getModelForRole('edit') || this._config.getModelForRole('chat');
    if (!editModel) {
      this._vscode.window.showErrorMessage('CodePilot AI: No Edit or Chat model configured.');
      return;
    }

    await this._vscode.window.withProgress(
      {
        location: this._vscode.ProgressLocation.Notification,
        title: `CodePilot AI: Editing with ${editModel.title}...`,
        cancellable: true
      },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        try {
          const result = await this._llm.chat({
            modelConfig: editModel,
            stream: false,
            temperature: 0.1,
            signal: controller.signal,
            messages: [
              {
                role: 'system',
                content: 'You are an expert code editor. Apply the instruction to the provided code. Return ONLY the transformed code without markdown fences or commentary.'
              },
              {
                role: 'user',
                content: `Instruction: ${instruction}\n\nCode:\n${code}`
              }
            ]
          });

          const cleaned = result.content
            .replace(/^```[\w-]*\r?\n/, '')
            .replace(/\r?\n```\s*$/, '')
            .trim();

          if (!cleaned) return;

          await editor.edit((editBuilder) => {
            if (editor.selection.isEmpty) {
              editBuilder.insert(editor.selection.active, cleaned);
            } else {
              editBuilder.replace(editor.selection, cleaned);
            }
          });
          this._vscode.window.setStatusBarMessage('CodePilot AI: Code edited', 2500);
        } catch (error) {
          if (!controller.signal.aborted) {
            this._vscode.window.showErrorMessage(`CodePilot AI: ${error.message || 'Could not edit code.'}`);
          }
        }
      }
    );
  }

  _getHtml(webview) {
    const uiDir = join(this._context.extensionPath, 'webview-ui');
    const htmlPath = join(uiDir, 'index.html');
    const cssUri = webview.asWebviewUri(
      this._vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'styles.css')
    );
    const jsUri = webview.asWebviewUri(
      this._vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'app.js')
    );
    const settingsIconUri = webview.asWebviewUri(
      this._vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'assets', 'general-settings.png')
    );
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;

    let html = readFileSync(htmlPath, 'utf8');
    html = html
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{stylesUri\}\}/g, cssUri.toString())
      .replace(/\{\{settingsIconUri\}\}/g, settingsIconUri.toString())
      .replace(/\{\{scriptUri\}\}/g, jsUri.toString());
    return html;
  }
}

export { SidebarProvider };
export default { SidebarProvider };
