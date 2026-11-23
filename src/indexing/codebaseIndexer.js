'use strict';

import { existsSync, promises, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, resolve } from 'path';

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.codepilot'
]);

const DEFAULT_IGNORED_FILES= new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.php', '.swift', '.scala', '.sh', '.bash', '.zsh', '.ps1',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.sql', '.md', '.txt', '.env.example'
]);

/**
 * Pure JavaScript local codebase & documentation indexer.
 * Uses BM25 + symbol extraction + optional vector embeddings (when an Embed model is available).
 */
class CodebaseIndexer {
  /**
   * @param {string} storageDir
   * @param {import('../llm/llmClient').LLMClient} [llmClient]
   */
  constructor(storageDir, llmClient = null) {
    this._storageDir = storageDir;
    this._llmClient = llmClient;
    this._indexFile = join(storageDir, 'codepilot-index.json');
    this._chunks = [];
    this._docsChunks = [];
    this._workspaceRoot = '';
    this._idf = new Map();
    this._avgDocLen = 0;
    this._status = {
      state: 'idle', // 'idle' | 'indexing' | 'complete' | 'error'
      fileCount: 0,
      chunkCount: 0,
      docsCount: 0,
      lastIndexedAt: null,
      progress: 0,
      message: 'Not indexed yet'
    };
  }

  getStatus() {
    return { ...this._status };
  }

  async loadFromDisk(workspaceRoot = '') {
    try {
      if (existsSync(this._indexFile)) {
        const raw = await promises.readFile(this._indexFile, 'utf8');
        const parsed = JSON.parse(raw);
        this._docsChunks = Array.isArray(parsed.docsChunks) ? parsed.docsChunks : [];
        const requestedRoot = normalizeWorkspaceRoot(workspaceRoot);
        const savedRoot = normalizeWorkspaceRoot(parsed.workspaceRoot || '');
        this._workspaceRoot = savedRoot;
        const sameWorkspace = !requestedRoot || requestedRoot === savedRoot;
        this._chunks = sameWorkspace && Array.isArray(parsed.chunks) ? parsed.chunks : [];
        if (requestedRoot && !sameWorkspace) this._workspaceRoot = '';
        this._rebuildBM25Stats();
        this._status = {
          state: sameWorkspace ? 'complete' : 'idle',
          fileCount: sameWorkspace ? parsed.fileCount || 0 : 0,
          chunkCount: this._chunks.length,
          docsCount: this._docsChunks.length,
          lastIndexedAt: sameWorkspace ? parsed.lastIndexedAt || null : null,
          progress: sameWorkspace ? 100 : 0,
          message: sameWorkspace
            ? this._chunks.length > 0 ? 'Indexing complete' : 'Ready to index'
            : 'Workspace changed; indexing required'
        };
      }
    } catch (_) {
      // Ignore corrupt cache and allow clean re-index
    }
  }

  async _saveToDisk(fileCount) {
    try {
      await promises.mkdir(this._storageDir, { recursive: true });
      const payload = {
        version: 1,
        workspaceRoot: this._workspaceRoot,
        fileCount,
        lastIndexedAt: Date.now(),
        chunks: this._chunks,
        docsChunks: this._docsChunks
      };
      await promises.writeFile(this._indexFile, JSON.stringify(payload), 'utf8');
    } catch (_) {
      // Non-fatal persistence error
    }
  }

  /**
   * Walk and index a workspace root directory.
   * @param {string} rootDir
   * @param {Object} [options]
   * @param {number} [options.chunkSizeLines=60]
   * @param {number} [options.maxFileSizeKb=512]
   * @param {Object} [options.embedModel]
   * @param {(status: Object) => void} [options.onProgress]
   */
  async indexWorkspace(rootDir, options = {}) {
    if (!rootDir || !existsSync(rootDir)) {
      this._workspaceRoot = '';
      this._chunks = [];
      this._rebuildBM25Stats();
      this._status = {
        ...this._status,
        state: 'complete',
        fileCount: 0,
        chunkCount: 0,
        progress: 100,
        message: 'No workspace folder open'
      };
      await this._saveToDisk(0);
      if (options.onProgress) options.onProgress(this.getStatus());
      return this.getStatus();
    }

    const workspaceRoot = normalizeWorkspaceRoot(rootDir);
    if (workspaceRoot !== this._workspaceRoot) {
      this._chunks = [];
      this._rebuildBM25Stats();
    }
    this._workspaceRoot = workspaceRoot;

    const chunkSizeLines = options.chunkSizeLines || 60;
    const maxBytes = (options.maxFileSizeKb || 512) * 1024;
    const ignorePatterns = this._loadGitignore(rootDir);

    this._status = {
      ...this._status,
      state: 'indexing',
      progress: 5,
      message: 'Scanning workspace files...'
    };
    if (options.onProgress) options.onProgress(this.getStatus());

    const files = [];
    this._walkDir(rootDir, rootDir, ignorePatterns, maxBytes, files);

    const chunks = [];
    const total = files.length || 1;

    for (let i = 0; i < files.length; i++) {
      const absPath = files[i];
      const relPath = relative(rootDir, absPath).replace(/\\/g, '/');
      try {
        const content = await promises.readFile(absPath, 'utf8');
        const fileChunks = this._chunkFile(relPath, content, chunkSizeLines);
        chunks.push(...fileChunks);
      } catch (_) {
        // Skip unreadable files
      }

      if (i % 15 === 0 || i === files.length - 1) {
        this._status = {
          ...this._status,
          state: 'indexing',
          fileCount: i + 1,
          chunkCount: chunks.length,
          progress: Math.min(90, Math.round(((i + 1) / total) * 85) + 5),
          message: `Indexing ${i + 1}/${files.length} files...`
        };
        if (options.onProgress) options.onProgress(this.getStatus());
      }
    }

    // Optional embedding pass if an Embed model is configured & reachable
    if (options.embedModel && this._llmClient && chunks.length > 0 && chunks.length <= 300) {
      try {
        const batchSize = 25;
        for (let i = 0; i < chunks.length; i += batchSize) {
          const slice = chunks.slice(i, i + batchSize);
          const vectors = await this._llmClient.embedTexts(
            options.embedModel,
            slice.map((c) => `${c.filePath}\n${c.text.slice(0, 1000)}`)
          );
          for (let j = 0; j < slice.length; j++) {
            if (vectors[j]) slice[j].embedding = vectors[j];
          }
        }
      } catch (_) {
        // Fall back gracefully to local BM25 when embedding endpoint is offline
      }
    }

    this._chunks = chunks;
    this._rebuildBM25Stats();
    await this._saveToDisk(files.length);

    this._status = {
      state: 'complete',
      fileCount: files.length,
      chunkCount: this._chunks.length,
      docsCount: this._docsChunks.length,
      lastIndexedAt: Date.now(),
      progress: 100,
      message: 'Indexing complete'
    };
    if (options.onProgress) options.onProgress(this.getStatus());
    return this.getStatus();
  }

  /**
   * Index a documentation source (URL or local file/directory).
   * @param {{ id: string, title: string, url: string }} docSource
   */
  async indexDocumentationSource(docSource) {
    let rawText = '';
    if (/^https?:\/\//i.test(docSource.url)) {
      const res = await fetch(docSource.url);
      if (!res.ok) throw new Error(`Failed to fetch docs (${res.status}): ${docSource.url}`);
      const html = await res.text();
      rawText = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } else if (existsSync(docSource.url)) {
      rawText = await promises.readFile(docSource.url, 'utf8');
    } else {
      throw new Error(`Documentation source not accessible: ${docSource.url}`);
    }

    // Remove previous chunks for this docSource.id
    this._docsChunks = this._docsChunks.filter((c) => c.docId !== docSource.id);
    const words = rawText.split(/\s+/);
    const step = 220;
    for (let i = 0; i < words.length; i += step) {
      const text = words.slice(i, i + 260).join(' ');
      if (!text.trim()) continue;
      this._docsChunks.push({
        id: `${docSource.id}#${i}`,
        docId: docSource.id,
        title: docSource.title,
        url: docSource.url,
        text,
        tokens: tokenize(text)
      });
    }
    this._status.docsCount = this._docsChunks.length;
    await this._saveToDisk(this._status.fileCount);
    return this._docsChunks.filter((c) => c.docId === docSource.id).length;
  }

  removeDocumentationSource(docId) {
    this._docsChunks = this._docsChunks.filter((c) => c.docId !== docId);
    this._status.docsCount = this._docsChunks.length;
    this._saveToDisk(this._status.fileCount);
  }

  /**
   * Search indexed @codebase chunks using BM25 + optional cosine similarity.
   * @param {string} query
   * @param {number} [topK=8]
   * @param {number[]} [queryEmbedding]
   */
  searchCodebase(query, topK = 8, queryEmbedding = null) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this._chunks.length === 0) return [];

    // Extract code-like tokens/phrases (anything with symbols like {/*hello*/}, backticks, or camelCase/snake_case)
    const codeLiterals = (query.match(/`([^`]+)`|([^\s"']*[^\w\s"'][^\s"']*)/g) || [])
      .map((s) => s.replace(/^`|`$/g, '').trim())
      .filter((s) => s.length >= 3);

    const scored = this._chunks.map((chunk) => {
      const bm25 = this._bm25Score(queryTokens, chunk);
      let sim = 0;
      if (queryEmbedding && Array.isArray(chunk.embedding)) {
        sim = cosineSimilarity(queryEmbedding, chunk.embedding);
      }

      // Strong boost when the exact code snippet/comment appears in the chunk
      let exactBoost = 0;
      for (const lit of codeLiterals) {
        if (chunk.text.includes(lit)) {
          exactBoost += 15;
        }
      }

      return {
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbols: chunk.symbols,
        text: chunk.text,
        score: bm25 + sim * 5 + exactBoost
      };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  isIndexedFor(workspaceRoot) {
    return Boolean(
      workspaceRoot &&
      this._status.state === 'complete' &&
      this._workspaceRoot === normalizeWorkspaceRoot(workspaceRoot)
    );
  }

  searchDocs(query, topK = 6) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this._docsChunks.length === 0) return [];
    const qSet = new Set(queryTokens);

    return this._docsChunks
      .map((chunk) => {
        let overlap = 0;
        for (const t of chunk.tokens) {
          if (qSet.has(t)) overlap += 1;
        }
        return {
          title: chunk.title,
          url: chunk.url,
          text: chunk.text,
          score: overlap / Math.sqrt((chunk.tokens.length || 1) + 1)
        };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  _loadGitignore(rootDir) {
    const giPath = join(rootDir, '.gitignore');
    const patterns = [];
    try {
      if (existsSync(giPath)) {
        const lines = readFileSync(giPath, 'utf8').split(/\r?\n/);
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line.startsWith('#') || line.startsWith('!')) continue;
          patterns.push(line.replace(/\/+$/, ''));
        }
      }
    } catch (_) {
      // Ignore unreadable .gitignore
    }
    return patterns;
  }

  _isIgnored(relPath, name, ignorePatterns) {
    if (DEFAULT_IGNORED_DIRS.has(name) || DEFAULT_IGNORED_FILES.has(name)) return true;
    for (const pat of ignorePatterns) {
      if (name === pat || relPath === pat || relPath.startsWith(`${pat}/`)) {
        return true;
      }
    }
    return false;
  }

  _walkDir(rootDir, currentDir, ignorePatterns, maxBytes, outFiles) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(rootDir, fullPath).replace(/\\/g, '/');
      if (this._isIgnored(relPath, entry.name, ignorePatterns)) continue;

      if (entry.isDirectory()) {
        this._walkDir(rootDir, fullPath, ignorePatterns, maxBytes, outFiles);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext) && entry.name !== 'Dockerfile' && entry.name !== 'Makefile') {
          continue;
        }
        try {
          const stat = statSync(fullPath);
          if (stat.size <= maxBytes && stat.size > 0) {
            outFiles.push(fullPath);
          }
        } catch (_) {
          // Skip inaccessible file
        }
      }
    }
  }

  _chunkFile(filePath, content, chunkSizeLines) {
    const lines = content.split(/\r?\n/);
    const chunks = [];
    const overlap = Math.max(5, Math.floor(chunkSizeLines / 6));
    const step = Math.max(10, chunkSizeLines - overlap);

    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(lines.length, start + chunkSizeLines);
      const slice = lines.slice(start, end).join('\n');
      if (!slice.trim()) continue;
      const symbols = extractSymbols(slice);
      chunks.push({
        filePath,
        startLine: start + 1,
        endLine: end,
        symbols,
        text: slice,
        tokens: tokenize(`${filePath} ${symbols.join(' ')} ${slice}`)
      });
      if (end >= lines.length) break;
    }
    return chunks;
  }

  _rebuildBM25Stats() {
    const df = new Map();
    let totalLen = 0;
    for (const chunk of this._chunks) {
      totalLen += chunk.tokens.length;
      const unique = new Set(chunk.tokens);
      for (const t of unique) {
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
    this._avgDocLen = this._chunks.length > 0 ? totalLen / this._chunks.length : 1;
    this._idf = new Map();
    const N = this._chunks.length;
    for (const [term, freq] of df.entries()) {
      this._idf.set(term, Math.log(1 + (N - freq + 0.5) / (freq + 0.5)));
    }
  }

  _bm25Score(queryTokens, chunk) {
    const k1 = 1.5;
    const b = 0.75;
    const tf = new Map();
    for (const t of chunk.tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    const docLen = chunk.tokens.length || 1;
    let score = 0;
    for (const q of queryTokens) {
      const freq = tf.get(q) || 0;
      if (freq === 0) continue;
      const idf = this._idf.get(q) || 0.5;
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (docLen / this._avgDocLen))));
    }
    return score;
  }
}

function tokenize(text) {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
}

function normalizeWorkspaceRoot(rootDir) {
  if (!rootDir) return '';
  const normalized = resolve(rootDir);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function extractSymbols(text) {
  const symbols = new Set();
  const patterns = [
    /(?:function|class|interface|type|enum)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g,
    /def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      symbols.add(m[1]);
    }
  }
  return Array.from(symbols);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export { CodebaseIndexer, tokenize, extractSymbols };
export default { CodebaseIndexer, tokenize, extractSymbols };
