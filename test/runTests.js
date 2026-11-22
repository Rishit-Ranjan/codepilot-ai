'use strict';

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SecretManager } from '../src/core/secretManager.js';
import { ConfigManager, DEFAULT_BUILTIN_TOOLS } from '../src/core/configManager.js';
import { SessionManager } from '../src/core/sessionManager.js';
import { CodebaseIndexer } from '../src/indexing/codebaseIndexer.js';
import { LLMClient } from '../src/llm/llmClient.js';
import { BuiltInToolsRunner } from '../src/tools/builtInTools.js';
import { SidebarProvider } from '../src/webview/sidebarProvider.js';

function createMockSecretStorage() {
  const store = new Map();
  return {
    async get(k) { return store.get(k); },
    async store(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    _raw: store
  };
}

function createMockMemento() {
  const data = new Map();
  return {
    get(k) { return data.get(k); },
    async update(k, v) { data.set(k, v); },
    _raw: data
  };
}

async function run() {
  console.log('Running CodePilot AI verification tests...');

  // 1. SecretManager tests
  const mockSecrets = createMockSecretStorage();
  const secretMgr = new SecretManager(mockSecrets);
  const keyId = SecretManager.buildKeyId('model-openai-gpt4o');
  await secretMgr.setApiKey(keyId, 'sk-secret-test-1234567890');
  assert.strictEqual(await secretMgr.hasApiKey(keyId), true);
  assert.strictEqual(await secretMgr.getApiKey(keyId), 'sk-secret-test-1234567890');
  const masked = await secretMgr.getMaskedStatus(keyId);
  assert.ok(masked.startsWith('sk-') && masked.endsWith('7890') && !masked.includes('secret-test'));

  // 2. ConfigManager non-plaintext API key guarantee
  const globalState = createMockMemento();
  const cfgMgr = new ConfigManager(globalState, secretMgr);
  await cfgMgr.saveModel(
    {
      id: 'model-openai-gpt4o',
      title: 'GPT-4o',
      provider: 'openai',
      model: 'gpt-4o',
      apiBase: 'https://api.openai.com/v1',
      roles: ['chat', 'edit'],
      completionOptions: {
        temperature: 0.6,
        maxTokens: 1024,
        topP: 0.85,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2
      },
      requiresApiKey: true
    },
    'sk-secret-test-1234567890'
  );

  const persistedJson = JSON.stringify(Array.from(globalState._raw.entries()));
  assert.strictEqual(
    persistedJson.includes('sk-secret-test-1234567890'),
    false,
    'API key MUST NEVER appear in plain text in persisted config!'
  );

  const publicState = await cfgMgr.getPublicState();
  assert.strictEqual(publicState.profile.tools.length, DEFAULT_BUILTIN_TOOLS.length);
  const gptModel = publicState.profile.models.find((m) => m.id === 'model-openai-gpt4o');
  assert.strictEqual(gptModel.hasApiKey, true);
  assert.strictEqual('apiKey' in gptModel, false);
  assert.strictEqual(gptModel.completionOptions.maxTokens, 1024);
  const mainProfileSummary = publicState.profiles.find((p) => p.id === 'main');
  assert.strictEqual(mainProfileSummary.modelAssignments.chat, 'Llama 3.1 8B');
  assert.ok(publicState.profile.skills.length >= 3);
  await cfgMgr.saveSkill({
    name: 'Release Notes',
    description: 'Summarize changes for release notes.',
    trigger: 'release notes, changelog',
    instructions: 'Create concise release notes grouped by feature, fix, and breaking change.',
    enabled: true
  });
  const profileWithSkill = cfgMgr.getActiveProfile();
  assert.strictEqual(profileWithSkill.skills.some((skill) => skill.name === 'Release Notes'), true);
  const createdProfile = await cfgMgr.createProfile('Test Profile', 'main');
  assert.strictEqual(createdProfile.name, 'Test Profile');
  assert.strictEqual(createdProfile.skills.some((skill) => skill.name === 'Release Notes'), true);
  await cfgMgr.deleteProfile(createdProfile.id);

  const llmClient = new LLMClient(secretMgr);
  const originalFetch = global.fetch;
  let requestUrl = '';
  let requestBody = null;
  try {
    global.fetch = async (url, request) => {
      requestUrl = url;
      requestBody = JSON.parse(request.body);
      const isOllamaRequest = String(url).endsWith('/api/chat');
      const isAnthropicRequest = String(url).endsWith('/messages');
      const isGeminiRequest = String(url).includes(':generateContent?');
      if (isOllamaRequest && requestBody.stream) {
        const encoder = new TextEncoder();
        const chunk = encoder.encode(
          '{"message":{"content":"Hello"},"done":false}\n' +
          '{"message":{"content":" there."},"done":true}\n'
        );
        let sent = false;
        return {
          ok: true,
          body: {
            getReader() {
              return {
                async read() {
                  if (sent) return { done: true };
                  sent = true;
                  return { value: chunk, done: false };
                }
              };
            }
          }
        };
      }
      return {
        ok: true,
        async json() {
          if (isOllamaRequest) return { message: { content: 'ok' } };
          if (isAnthropicRequest) return { content: [{ type: 'text', text: 'ok' }] };
          if (isGeminiRequest) return { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
          return { choices: [{ message: { content: 'ok' } }] };
        }
      };
    };

    await llmClient.chat({
      modelConfig: gptModel,
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.2,
      maxTokens: 4096,
      stream: false
    });
    assert.ok(requestUrl.endsWith('/chat/completions'));
    assert.strictEqual(requestBody.temperature, 0.6);
    assert.strictEqual(requestBody.max_tokens, 1024);
    assert.strictEqual(requestBody.top_p, 0.85);
    assert.strictEqual(requestBody.frequency_penalty, 0.1);
    assert.strictEqual(requestBody.presence_penalty, 0.2);

    await llmClient.chat({
      modelConfig: {
        title: 'Claude',
        provider: 'anthropic',
        model: 'claude-test',
        apiBase: 'https://api.anthropic.com/v1',
        requiresApiKey: true,
        secretKeyId: keyId,
        completionOptions: { temperature: 0.4, maxTokens: 512, topP: 0.75 }
      },
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false
    });
    assert.ok(requestUrl.endsWith('/messages'));
    assert.strictEqual(requestBody.max_tokens, 512);
    assert.strictEqual(requestBody.top_p, 0.75);
    assert.strictEqual('temperature' in requestBody, false);

    await llmClient.chat({
      modelConfig: {
        title: 'Gemini',
        provider: 'gemini',
        model: 'gemini-test',
        apiBase: 'https://generativelanguage.googleapis.com/v1beta',
        requiresApiKey: true,
        secretKeyId: keyId,
        completionOptions: {
          maxTokens: 768,
          topP: 0.8,
          frequencyPenalty: 0.2,
          presencePenalty: 0.3
        }
      },
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false
    });
    assert.ok(String(requestUrl).includes(':generateContent?'));
    assert.strictEqual(requestBody.generationConfig.maxOutputTokens, 768);
    assert.strictEqual(requestBody.generationConfig.topP, 0.8);
    assert.strictEqual(requestBody.generationConfig.frequencyPenalty, 0.2);
    assert.strictEqual(requestBody.generationConfig.presencePenalty, 0.3);

    await llmClient.chat({
      modelConfig: {
        title: 'Local Qwen',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        apiBase: 'http://localhost:11434/v1',
        requiresApiKey: false,
        completionOptions: {
          contextLength: 8192,
          topK: 40,
          repeatPenalty: 1.1
        }
      },
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"src/index.js"}' }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'file contents' }
      ],
      stream: false
    });
    assert.ok(requestUrl.endsWith('/api/chat'));
    assert.strictEqual(requestBody.options.num_ctx, 8192);
    assert.strictEqual(requestBody.options.top_k, 40);
    assert.strictEqual(requestBody.options.repeat_penalty, 1.1);
    assert.deepStrictEqual(
      requestBody.messages[0].tool_calls[0].function.arguments,
      { path: 'src/index.js' }
    );
    assert.strictEqual(requestBody.messages[1].tool_name, 'read_file');
    assert.strictEqual('tool_call_id' in requestBody.messages[1], false);

    const streamedTokens = [];
    const streamed = await llmClient.chat({
      modelConfig: {
        title: 'Local Qwen',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        apiBase: 'http://localhost:11434/v1',
        requiresApiKey: false,
        completionOptions: { contextLength: 8192 }
      },
      messages: [{ role: 'user', content: 'Hello' }],
      onToken: (token) => streamedTokens.push(token)
    });
    assert.strictEqual(streamed.content, 'Hello there.');
    assert.deepStrictEqual(streamedTokens, ['Hello', ' there.']);

    const rerankFetchUrl = '';
    global.fetch = async (url, request) => {
      assert.strictEqual(String(url), 'https://api.voyageai.com/v1/rerank');
      const body = JSON.parse(request.body);
      assert.strictEqual(body.model, 'rerank-2');
      assert.strictEqual(body.query, 'authentication');
      assert.strictEqual(body.top_k, 2);
      assert.deepStrictEqual(body.documents, ['first document', 'second document']);
      return {
        ok: true,
        async json() {
          return {
            results: [
              { index: 1, relevance_score: 0.91 },
              { index: 0, relevance_score: 0.42 }
            ]
          };
        }
      };
    };
    const reranked = await llmClient.rerankTexts(
      {
        title: 'Voyage Rerank',
        provider: 'voyage',
        model: 'rerank-2',
        apiBase: 'https://api.voyageai.com/v1',
        requiresApiKey: true,
        secretKeyId: keyId
      },
      'authentication',
      ['first document', 'second document'],
      2
    );
    assert.deepStrictEqual(reranked.map((item) => item.index), [1, 0]);
    assert.strictEqual(reranked[0].document, 'second document');

    global.fetch = async (url, request) => {
      assert.strictEqual(String(url), 'https://api.cohere.com/v2/rerank');
      const body = JSON.parse(request.body);
      assert.strictEqual(body.model, 'rerank-v3.5');
      assert.strictEqual(body.top_n, 1);
      return {
        ok: true,
        async json() {
          return { results: [{ index: 0, relevance_score: 0.88 }] };
        }
      };
    };
    const cohereReranked = await llmClient.rerankTexts(
      {
        title: 'Cohere Rerank',
        provider: 'cohere',
        model: 'rerank-v3.5',
        apiBase: 'https://api.cohere.com/v2',
        requiresApiKey: true,
        secretKeyId: keyId
      },
      'query',
      ['first document'],
      1
    );
    assert.deepStrictEqual(cohereReranked.map((item) => item.index), [0]);

    global.fetch = async (url, request) => {
      assert.strictEqual(String(url), 'https://api.cohere.com/v2/embed');
      const body = JSON.parse(request.body);
      assert.strictEqual(body.model, 'embed-v4.0');
      assert.strictEqual(body.input_type, 'search_document');
      assert.deepStrictEqual(body.texts, ['CodePilot embedding test']);
      return {
        ok: true,
        async json() {
          return { embeddings: { float: [[0.12, 0.24, 0.48]] } };
        }
      };
    };
    const cohereEmbeddings = await llmClient.embedTexts(
      {
        title: 'Cohere Embed',
        provider: 'cohere',
        model: 'embed-v4.0',
        apiBase: 'https://api.cohere.com/v2',
        requiresApiKey: true,
        secretKeyId: keyId
      },
      ['CodePilot embedding test']
    );
    assert.deepStrictEqual(cohereEmbeddings, [[0.12, 0.24, 0.48]]);
    global.fetch = originalFetch;

    const activeFetch = global.fetch;
    global.fetch = async () => {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      throw error;
    };
    const offlineOllamaModel = {
      title: 'Local Llama',
      provider: 'ollama',
      model: 'llama3.1:8b',
      apiBase: 'http://localhost:11434/v1',
      requiresApiKey: false
    };
    await assert.rejects(
      () =>
        llmClient.chat({
          modelConfig: offlineOllamaModel,
          messages: [{ role: 'user', content: 'Hello' }]
        }),
      /Ollama is unavailable\. Start Ollama and verify the API Base URL/
    );
    await assert.rejects(
      () =>
        llmClient.chat({
          modelConfig: { ...offlineOllamaModel, completionOptions: { contextLength: 4096 } },
          messages: [{ role: 'user', content: 'Hello' }]
        }),
      /Ollama is unavailable\. Start Ollama and verify the API Base URL/
    );
    global.fetch = activeFetch;

    await assert.rejects(
      () => cfgMgr.saveModel({
        id: 'model-invalid-ollama',
        title: 'Invalid Ollama',
        provider: 'ollama',
        model: 'invalid',
        completionOptions: { contextLength: 128 }
      }),
      /Context length must be an integer between 512 and 262144/
    );
  } finally {
    global.fetch = originalFetch;
  }

  // Cycle chat model
  const cycled = await cfgMgr.cycleChatModel();
  assert.ok(cycled && cycled.id);

  // 3. CodebaseIndexer & @docs tests
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-test-'));
  const storageDir = path.join(tmpRoot, '.storage');
  fs.writeFileSync(path.join(tmpRoot, '.gitignore'), 'ignored_dir/\n', 'utf8');
  fs.mkdirSync(path.join(tmpRoot, 'ignored_dir'));
  fs.writeFileSync(path.join(tmpRoot, 'ignored_dir', 'secret.js'), 'function xyzIgnoredFn() {}', 'utf8');
  fs.mkdirSync(path.join(tmpRoot, 'src'));
  fs.writeFileSync(
    path.join(tmpRoot, 'src', 'authService.js'),
    'function verifyAuthToken(token) {\n  return Boolean(token && token.startsWith("cp_"));\n}\nmodule.exports = { verifyAuthToken };\n',
    'utf8'
  );
  const docFile = path.join(tmpRoot, 'GUIDE.md');
  fs.writeFileSync(docFile, 'CodePilot AI uses SecretStorage for encrypted API key management.', 'utf8');

  const indexer = new CodebaseIndexer(storageDir);
  const status = await indexer.indexWorkspace(tmpRoot);
  assert.strictEqual(status.state, 'complete');
  assert.ok(status.fileCount >= 1);

  const hits = indexer.searchCodebase('verifyAuthToken', 5);
  assert.ok(hits.length > 0 && hits[0].filePath.includes('authService.js'));
  const ignoredHits = indexer.searchCodebase('xyzIgnoredFn', 5);
  assert.strictEqual(ignoredHits.length, 0, '.gitignore directory should not be indexed');

  const docChunks = await indexer.indexDocumentationSource({ id: 'doc1', title: 'Guide', url: docFile });
  assert.ok(docChunks >= 1);
  const docHits = indexer.searchDocs('SecretStorage', 3);
  assert.ok(docHits.length > 0);

  // 4. BuiltInToolsRunner sandboxing & permissions
  const mockVscode = {
    workspace: { workspaceFolders: [{ uri: { fsPath: tmpRoot } }] },
    window: { terminals: [], activeTextEditor: null },
    languages: { getDiagnostics: () => [] }
  };
  const toolsRunner = new BuiltInToolsRunner(mockVscode, cfgMgr, indexer);
  const readOut = await toolsRunner.execute('read_file', { path: 'src/authService.js' });
  assert.ok(readOut.includes('verifyAuthToken'));

  await assert.rejects(
    () => toolsRunner.execute('read_file', { path: '../outside.txt' }),
    /Access denied outside workspace root/
  );
  assert.strictEqual(
    toolsRunner.requiresApproval('run_terminal_command', { command: 'Remove-Item -Recurse -Force build' }),
    true
  );
  await assert.rejects(
    () => toolsRunner.execute('run_terminal_command', { command: 'Remove-Item -Recurse -Force build' }),
    /Dangerous terminal command blocked/
  );
  await assert.rejects(
    () => toolsRunner.execute('create_rule_block', { name: 'r', content: 'c' }),
    /Excluded/
  );

  // 5. SessionManager tests
  const wsState = createMockMemento();
  const sessMgr = new SessionManager(wsState);
  const s1 = sessMgr.createSession();
  assert.deepStrictEqual(sessMgr.listSessions(), []);
  await sessMgr.appendMessage(s1.id, { role: 'user', content: 'Explain verifyAuthToken' });
  assert.deepStrictEqual(sessMgr.listSessions().map((session) => session.id), [s1.id]);
  const s2 = sessMgr.createSession();
  assert.notStrictEqual(s1.id, s2.id);
  assert.deepStrictEqual(sessMgr.listSessions().map((session) => session.id), [s1.id]);
  const last = sessMgr.getLastNonEmptySession();
  assert.strictEqual(last.id, s1.id);

  // 6. Chat/Edit model diagnosis stays independent of conversation history
  const modelTestMessages = [];
  let testedModel;
  const modelTester = Object.create(SidebarProvider.prototype);
  modelTester._config = {
    getActiveProfile() {
      return {
        models: [{ title: 'Coder', model: 'coder-model', id: 'coder-id', roles: ['edit'] }]
      };
    },
    getModelForRole(role) {
      return role === 'edit'
        ? { title: 'Coder', model: 'coder-model', id: 'coder-id', roles: ['edit'] }
        : null;
    }
  };
  modelTester._llm = {
    async chat(options) {
      testedModel = options.modelConfig;
      assert.strictEqual(options.stream, false);
      assert.strictEqual(options.temperature, 0);
      assert.strictEqual(options.messages.length, 2);
      const prompt = options.messages[1].content;
      if (prompt.includes('oldName')) {
        return { content: 'function newName() { return 1; }' };
      }
      return { content: 'CodePilot test passed.' };
    }
  };
  modelTester.postMessage = (message) => modelTestMessages.push(message);
  await modelTester._testModel('edit', 'coder-id');
  assert.strictEqual(testedModel.model, 'coder-model');
  assert.strictEqual(modelTestMessages[0].success, true);
  assert.strictEqual(modelTestMessages[0].matched, true);
  await modelTester._testModel('chat');
  assert.strictEqual(modelTestMessages[1].success, false);
  assert.match(modelTestMessages[1].error, /No Chat model is assigned/);
  await modelTester._testModel('chat', 'coder-id');
  assert.strictEqual(modelTestMessages[2].success, false);
  assert.match(modelTestMessages[2].error, /No Chat model is assigned/);

  modelTester._config = {
    getActiveProfile() {
      return {
        models: [{ title: 'Voyage Rerank', model: 'rerank-2', id: 'rerank-id', roles: ['rerank'] }]
      };
    },
    getModelForRole(role) {
      return role === 'rerank'
        ? { title: 'Voyage Rerank', model: 'rerank-2', id: 'rerank-id', roles: ['rerank'] }
        : null;
    }
  };
  modelTester._llm.rerankTexts = async () => [{ index: 0, score: 0.91, document: 'test' }];
  await modelTester._testModel('rerank', 'rerank-id');
  assert.strictEqual(modelTestMessages[3].success, true);

  modelTester._llm.rerankTexts = async () => [{ index: 1, score: 0.91, document: 'test' }];
  await modelTester._testModel('rerank', 'rerank-id');
  assert.strictEqual(modelTestMessages[4].success, false);
  assert.match(modelTestMessages[4].error, /did not rank the clearly relevant authentication document first/);

  modelTester._config = {
    getActiveProfile() {
      return {
        models: [{ title: 'Cohere Embed', model: 'embed-v4.0', id: 'embed-id', roles: ['embed'] }]
      };
    },
    getModelForRole(role) {
      return role === 'embed'
        ? { title: 'Cohere Embed', model: 'embed-v4.0', id: 'embed-id', roles: ['embed'] }
        : null;
    }
  };
  modelTester._llm.embedTexts = async () => [[0.12, 0.24, 0.48]];
  await modelTester._testModel('embed', 'embed-id');
  assert.strictEqual(modelTestMessages[5].success, true);

  // 7. Stopping generation aborts the request and preserves partial output
  const chatSession = { id: 'chat-session', messages: [] };
  let activeChatSession = chatSession;
  const chatMessages = [];
  let generationSignal;
  const chatProvider = Object.create(SidebarProvider.prototype);
  chatProvider._mode = 'chat';
  chatProvider._abortController = null;
  chatProvider._activeChatTurn = null;
  chatProvider._pendingApprovals = new Map();
  chatProvider._sessions = {
    getActiveSession: () => activeChatSession,
    async switchSession(sessionId) {
      activeChatSession = { id: sessionId, messages: [] };
      return activeChatSession;
    },
    async appendMessage(_sessionId, message) {
      chatSession.messages.push(message);
    }
  };
  chatProvider.pushFullState = async () => {};
  chatProvider._config = {
    getModelForRole: () => ({ title: 'Local Llama' }),
    getActiveProfile: () => ({
      rules: [],
      skills: [{
        id: 'skill-debug',
        name: 'Debugging',
        description: 'Diagnose failures.',
        trigger: 'debug',
        instructions: 'Identify the root cause and provide a verified fix.',
        enabled: true
      }],
      settings: { streamResponses: true, temperature: 0.2, maxTokens: 128 }
    })
  };
  chatProvider._contextProviders = { resolveAttachments: async () => [] };
  chatProvider._tools = { getEnabledSchemas: () => [] };
  let interruptedMessageWasPersistedBeforeEvent = false;
  chatProvider.postMessage = (message) => {
    if (message.type === 'streamEnd' && message.message) {
      interruptedMessageWasPersistedBeforeEvent = chatSession.messages.some(
        (saved) => saved.id === message.message.id
      );
    }
    chatMessages.push(message);
  };
  let capturedChatOptions;
  chatProvider._llm = {
    chat(options) {
      const { signal, onToken } = options;
      capturedChatOptions = options;
      generationSignal = signal;
      onToken('Partial response');
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      });
    }
  };

  const generation = chatProvider._handleMessage({
    type: 'sendMessage',
    text: 'Debug this response',
    attachments: [],
    skillIds: ['skill-debug']
  });
  for (let attempt = 0; attempt < 10 && !generationSignal; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(generationSignal, 'generation should start with an abort signal');
  assert.ok(
    capturedChatOptions.messages.some((message) =>
      String(message.content).includes('Active Skills')
    ),
    'selected skill instructions should be included in the system prompt'
  );
  await chatProvider._handleMessage({ type: 'switchSession', sessionId: 'other-chat-session' });
  await generation;
  assert.strictEqual(activeChatSession.id, 'other-chat-session');
  const stoppedStream = chatMessages.find((message) => message.type === 'streamEnd');
  assert.strictEqual(
    chatMessages.find((message) => message.type === 'sessionMessageAdded').sessionId,
    chatSession.id
  );
  assert.strictEqual(
    chatMessages.find((message) => message.type === 'streamStart').sessionId,
    chatSession.id
  );
  assert.strictEqual(stoppedStream.sessionId, chatSession.id);
  assert.strictEqual(stoppedStream.aborted, true);
  assert.strictEqual(stoppedStream.message.content, 'Partial response');
  assert.strictEqual(stoppedStream.message.interrupted, true);
  assert.strictEqual(interruptedMessageWasPersistedBeforeEvent, true);
  assert.strictEqual(chatSession.messages[1].content, 'Partial response');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('All CodePilot AI tests passed!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
