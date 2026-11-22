'use strict';

/**
 * Multi-provider LLM client in pure JavaScript (Node 18+ global fetch).
 * Retrieves API keys just-in-time from SecretManager; never stores or logs keys.
 */
class LLMClient {
  /**
   * @param {import('../core/secretManager').SecretManager} secretManager
   */
  constructor(secretManager) {
    this._secrets = secretManager;
  }

  async _resolveApiKey(modelConfig) {
    if (!modelConfig) throw new Error('No model configured for this role.');
    const key = await this._secrets.getApiKey(modelConfig.secretKeyId);
    if (modelConfig.requiresApiKey && (!key || !key.trim())) {
      throw new Error(
        `API key missing for "${modelConfig.title}". Open Settings → Models to add your API key securely.`
      );
    }
    return key ? key.trim() : '';
  }

  _getDefaultBaseUrl(provider) {
    switch (provider) {
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'openrouter':
        return 'https://openrouter.ai/api/v1';
      case 'voyage':
        return 'https://api.voyageai.com/v1';
      case 'cohere':
        return 'https://api.cohere.com/v2';
      case 'jina':
        return 'https://api.jina.ai/v1';
      case 'ollama':
        return 'http://localhost:11434/v1';
      case 'anthropic':
        return 'https://api.anthropic.com/v1';
      case 'gemini':
        return 'https://generativelanguage.googleapis.com/v1beta';
      default:
        return 'https://api.openai.com/v1';
    }
  }

  /**
   * Stream or complete a chat request.
   * @param {Object} opts
   * @param {Object} opts.modelConfig
   * @param {Array} opts.messages
   * @param {Array} [opts.tools] - OpenAI-style tool schemas
   * @param {number} [opts.temperature]
   * @param {number} [opts.maxTokens]
   * @param {boolean} [opts.stream]
   * @param {AbortSignal} [opts.signal]
   * @param {(chunk: string) => void} [opts.onToken]
   * @returns {Promise<{ content: string, toolCalls: Array }>}
   */
  async chat({
    modelConfig,
    messages,
    tools = [],
    temperature,
    maxTokens,
    stream = true,
    signal,
    onToken
  }) {
    const apiKey = await this._resolveApiKey(modelConfig);
    const provider = modelConfig.provider || 'openai';
    const baseUrl = (modelConfig.apiBase || this._getDefaultBaseUrl(provider)).replace(/\/+$/, '');
    const configured = modelConfig.completionOptions || {};
    const options = {
      temperature: configured.temperature ?? temperature ?? 0.2,
      maxTokens: configured.maxTokens ?? maxTokens ?? 4096,
      topP: configured.topP,
      frequencyPenalty: configured.frequencyPenalty,
      presencePenalty: configured.presencePenalty,
      contextLength: configured.contextLength,
      topK: configured.topK,
      repeatPenalty: configured.repeatPenalty
    };

    if (
      provider === 'ollama' &&
      [options.contextLength, options.topK, options.repeatPenalty].some(Number.isFinite)
    ) {
      return await this._chatOllama({
        baseUrl,
        apiKey,
        model: modelConfig.model,
        messages,
        tools,
        ...options,
        stream,
        signal,
        onToken
      });
    }

    if (provider === 'anthropic') {
      return await this._chatAnthropic({
        baseUrl,
        apiKey,
        model: modelConfig.model,
        messages,
        tools,
        ...options,
        stream,
        signal,
        onToken
      });
    }

    if (provider === 'gemini') {
      return await this._chatGemini({
        baseUrl,
        apiKey,
        model: modelConfig.model,
        messages,
        tools,
        ...options,
        signal,
        onToken
      });
    }

    return await this._chatOpenAICompatible({
      baseUrl,
      apiKey,
      provider,
      model: modelConfig.model,
      messages,
      tools,
      ...options,
      stream,
      signal,
      onToken
    });
  }

  async _chatOpenAICompatible({
    baseUrl,
    apiKey,
    provider,
    model,
    messages,
    tools,
    temperature,
    maxTokens,
    topP,
    frequencyPenalty,
    presencePenalty,
    stream,
    signal,
    onToken
  }) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://codepilot-ai.local';
      headers['X-Title'] = 'CodePilot AI';
    }

    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: Boolean(stream)
    };
    if (topP !== undefined) body.top_p = topP;
    if (frequencyPenalty !== undefined) body.frequency_penalty = frequencyPenalty;
    if (presencePenalty !== undefined) body.presence_penalty = presencePenalty;
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      throw provider === 'ollama' ? toOllamaConnectionError(err, signal) : err;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Model request failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    if (!stream) {
      const json = await res.json();
      const choice = json.choices?.[0]?.message || {};
      const content = choice.content || '';
      if (content && onToken) onToken(content);
      return {
        content,
        toolCalls: normalizeOpenAIToolCalls(choice.tool_calls)
      };
    }

    // Parse SSE stream
    let fullContent = '';
    const toolCallAcc = new Map();
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            fullContent += delta.content;
            if (onToken) onToken(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallAcc.get(idx) || {
                id: tc.id || `call_${idx}`,
                name: '',
                arguments: ''
              };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              toolCallAcc.set(idx, existing);
            }
          }
        } catch (_) {
          // Ignore malformed SSE keepalive chunks
        }
      }
    }

    const toolCalls = Array.from(toolCallAcc.values()).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: safeJsonParse(tc.arguments, {})
    }));

    return { content: fullContent, toolCalls };
  }

  async _chatOllama({
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    temperature,
    maxTokens,
    topP,
    frequencyPenalty,
    presencePenalty,
    contextLength,
    topK,
    repeatPenalty,
    stream,
    signal,
    onToken
  }) {
    const options = {
      temperature,
      num_predict: maxTokens,
      num_ctx: contextLength,
      top_p: topP,
      top_k: topK,
      repeat_penalty: repeatPenalty,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty
    };
    for (const [key, value] of Object.entries(options)) {
      if (!Number.isFinite(value)) delete options[key];
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const nativeBaseUrl = baseUrl.replace(/\/v1$/i, '');
    let res;
    try {
      res = await fetch(`${nativeBaseUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: normalizeOllamaMessages(messages),
          tools: tools.length > 0 ? tools : undefined,
          options,
          stream: Boolean(stream)
        }),
        signal
      });
    } catch (err) {
      throw toOllamaConnectionError(err, signal);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama request failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    if (!stream) {
      const json = await res.json();
      const message = json.message || {};
      const content = message.content || '';
      if (content && onToken) onToken(content);
      return {
        content,
        toolCalls: normalizeOpenAIToolCalls(message.tool_calls)
      };
    }

    let fullContent = '';
    let toolCalls = [];
    let buffer = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`Ollama returned an invalid streaming response: ${err.message}`);
      }
      const message = event.message || {};
      if (typeof message.content === 'string' && message.content.length > 0) {
        fullContent += message.content;
        if (onToken) onToken(message.content);
      }
      if (Array.isArray(message.tool_calls)) {
        toolCalls = normalizeOpenAIToolCalls(message.tool_calls);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);

    return { content: fullContent, toolCalls };
  }

  async _chatAnthropic({
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    temperature,
    maxTokens,
    topP,
    stream,
    signal,
    onToken
  }) {
    const systemMsg = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const chatMsgs = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.tool_call_id,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
              }
            ]
          };
        }
        return { role: m.role, content: m.content };
      });

    const body = {
      model,
      max_tokens: maxTokens,
      messages: chatMsgs,
      stream: Boolean(stream)
    };
    if (topP !== undefined) body.top_p = topP;
    else body.temperature = temperature;
    if (systemMsg) body.system = systemMsg;
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters
      }));
    }

    const res = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic request failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    if (!stream) {
      const json = await res.json();
      let content = '';
      const toolCalls = [];
      for (const block of json.content || []) {
        if (block.type === 'text') content += block.text;
        if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input || {} });
        }
      }
      if (content && onToken) onToken(content);
      return { content, toolCalls };
    }

    let fullContent = '';
    const toolCalls = [];
    let currentTool = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const evt = JSON.parse(data);
          if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            currentTool = {
              id: evt.content_block.id,
              name: evt.content_block.name,
              rawJson: ''
            };
          } else if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              fullContent += evt.delta.text;
              if (onToken) onToken(evt.delta.text);
            } else if (evt.delta?.type === 'input_json_delta' && currentTool) {
              currentTool.rawJson += evt.delta.partial_json || '';
            }
          } else if (evt.type === 'content_block_stop' && currentTool) {
            toolCalls.push({
              id: currentTool.id,
              name: currentTool.name,
              arguments: safeJsonParse(currentTool.rawJson, {})
            });
            currentTool = null;
          }
        } catch (_) {
          // Ignore partial SSE lines
        }
      }
    }

    return { content: fullContent, toolCalls };
  }

  async _chatGemini({
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    temperature,
    maxTokens,
    topP,
    frequencyPenalty,
    presencePenalty,
    signal,
    onToken
  }) {
    const systemMsg = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
      }));

    const body = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens
      }
    };
    if (topP !== undefined) body.generationConfig.topP = topP;
    if (frequencyPenalty !== undefined) body.generationConfig.frequencyPenalty = frequencyPenalty;
    if (presencePenalty !== undefined) body.generationConfig.presencePenalty = presencePenalty;
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg }] };
    }
    if (tools && tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters
          }))
        }
      ];
    }

    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini request failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    const json = await res.json();
    const parts = json.candidates?.[0]?.content?.parts || [];
    let content = '';
    const toolCalls = [];
    for (const part of parts) {
      if (part.text) content += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {}
        });
      }
    }
    if (content && onToken) onToken(content);
    return { content, toolCalls };
  }

  /**
   * Generate embeddings using the configured Embed model.
   * @param {Object} modelConfig
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embedTexts(modelConfig, texts) {
    if (!modelConfig || !Array.isArray(texts) || texts.length === 0) return [];
    const apiKey = await this._resolveApiKey(modelConfig);
    const provider = modelConfig.provider || 'openai';
    const baseUrl = (modelConfig.apiBase || this._getDefaultBaseUrl(provider)).replace(/\/+$/, '');

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    let endpoint;
    let body;
    if (provider === 'cohere') {
      endpoint = /\/embed$/i.test(baseUrl) ? baseUrl : `${baseUrl}/embed`;
      body = { model: modelConfig.model, texts, input_type: 'search_document' };
    } else if (provider === 'jina') {
      endpoint = /\/embeddings$/i.test(baseUrl) ? baseUrl : `${baseUrl}/embeddings`;
      body = { model: modelConfig.model, input: texts };
    } else if (provider === 'voyage') {
      endpoint = /\/embeddings$/i.test(baseUrl) ? baseUrl : `${baseUrl}/embeddings`;
      body = { model: modelConfig.model, input: texts, input_type: 'document' };
    } else if (provider === 'ollama') {
      endpoint = `${baseUrl.replace(/\/v1$/i, '')}/api/embed`;
      body = { model: modelConfig.model, input: texts };
    } else {
      endpoint = /\/embeddings$/i.test(baseUrl) ? baseUrl : `${baseUrl}/embeddings`;
      body = { model: modelConfig.model, input: texts };
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Embeddings request failed (${res.status}): ${errText.slice(0, 300)}`);
    }
    const json = await res.json();
    if (provider === 'cohere') {
      const vectors = json.embeddings?.float || json.embeddings;
      return Array.isArray(vectors) ? vectors : [];
    }
    if (provider === 'ollama') {
      return Array.isArray(json.embeddings) ? json.embeddings : [];
    }
    return (json.data || []).map((d) => d.embedding).filter(Array.isArray);
  }

  /**
   * Rerank documents using a configured Rerank model.
   * @param {Object} modelConfig
   * @param {string} query
   * @param {string[]} documents
   * @param {number} [topK]
   * @returns {Promise<Array<{ index: number, score: number, document: string }>>}
   */
  async rerankTexts(modelConfig, query, documents, topK) {
    if (!modelConfig || !Array.isArray(documents) || documents.length === 0) return [];
    const apiKey = await this._resolveApiKey(modelConfig);
    const provider = modelConfig.provider || 'custom';
    const baseUrl = (modelConfig.apiBase || this._getDefaultBaseUrl(provider)).replace(/\/+$/, '');
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };

    const body = {
      model: modelConfig.model,
      query,
      documents
    };
    if (Number.isInteger(topK) && topK > 0) {
      body[provider === 'cohere' || provider === 'jina' ? 'top_n' : 'top_k'] = topK;
    }
    let endpoint;
    if (/\/rerank$/i.test(baseUrl)) {
      endpoint = baseUrl;
    } else if (provider === 'cohere') {
      endpoint = `${baseUrl}/rerank`;
    } else if (provider === 'jina') {
      endpoint = `${baseUrl}/rerank`;
    } else {
      endpoint = `${baseUrl}/rerank`;
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Rerank request failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    const json = await res.json();
    const rawResults = Array.isArray(json.results)
      ? json.results
      : Array.isArray(json.data)
        ? json.data
        : [];
    return rawResults
      .map((result) => ({
        index: Number(result.index),
        score: Number(result.relevance_score ?? result.score ?? 0),
        document: documents[Number(result.index)]
      }))
      .filter((result) => Number.isInteger(result.index) && result.document !== undefined)
      .sort((a, b) => b.score - a.score);
  }
}

function normalizeOpenAIToolCalls(rawCalls) {
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls.map((tc, idx) => ({
    id: tc.id || `call_${idx}`,
    name: tc.function?.name || tc.name || '',
    arguments: safeJsonParse(tc.function?.arguments, {})
  }));
}

function toOllamaConnectionError(error, signal) {
  const causeCode = error.code || error.cause?.code;
  const connectionFailed =
    ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT'].includes(causeCode) ||
    (error instanceof TypeError && error.message === 'fetch failed');
  if (!signal?.aborted && error.name !== 'AbortError' && connectionFailed) {
    return new Error(
      'Ollama is unavailable. Start Ollama and verify the API Base URL in Models settings.'
    );
  }
  return error;
}

function normalizeOllamaMessages(messages) {
  const toolNames = new Map();
  return messages.map((message) => {
    if (message.role === 'tool') {
      const { tool_call_id: toolCallId, ...toolMessage } = message;
      const toolName = toolNames.get(toolCallId);
      return toolName ? { ...toolMessage, tool_name: toolName } : toolMessage;
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const toolCalls = message.tool_calls.map((toolCall) => {
        toolNames.set(toolCall.id, toolCall.function?.name || '');
        return {
          ...toolCall,
          function: {
            ...toolCall.function,
            arguments: safeJsonParse(toolCall.function?.arguments, {})
          }
        };
      });
      return { ...message, tool_calls: toolCalls };
    }

    return message;
  });
}

function safeJsonParse(str, fallback) {
  if (typeof str === 'object' && str !== null) return str;
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

export { LLMClient, safeJsonParse };
