'use strict';

import { existsSync, promises } from 'fs';
import { relative, basename, dirname, resolve, isAbsolute, sep } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const CONTEXT_PROVIDERS = [
  { id: 'files', label: 'Files', description: 'Search and attach workspace files', searchable: true, icon: 'folder-file' },
  { id: 'code', label: 'Code', description: 'Search symbols, functions, and classes', searchable: true, icon: 'code' },
  { id: 'folder', label: 'Folder', description: 'Summarize directory structure', searchable: true, icon: 'folder' },
  { id: 'current_file', label: 'Current File', description: 'Attach the active editor file', searchable: false, icon: 'at' },
  { id: 'git_diff', label: 'Git Diff', description: 'Attach current uncommitted git diff', searchable: false, icon: 'diff' },
  { id: 'terminal', label: 'Terminal', description: 'Attach the active terminal name; VS Code does not expose its scrollback', searchable: false, icon: 'terminal' },
  { id: 'problems', label: 'Problems', description: 'Attach active workspace diagnostics', searchable: false, icon: 'warning' },
  { id: 'rules', label: 'Rules', description: 'Attach active CodePilot AI rules', searchable: false, icon: 'pencil' },
  { id: 'codebase', label: 'Codebase', description: 'Semantic & BM25 search over @codebase index', searchable: false, icon: 'database' },
  { id: 'docs', label: 'Docs', description: 'Search indexed @docs documentation', searchable: false, icon: 'book' }
];

class ContextProviderService {
  /**
   * @param {typeof import('vscode')} vscode
   * @param {import('../indexing/codebaseIndexer').CodebaseIndexer} indexer
   * @param {import('../core/configManager').ConfigManager} configManager
   */
  constructor(vscode, indexer, configManager, llmClient = null) {
    this._vscode = vscode;
    this._indexer = indexer;
    this._config = configManager;
    this._llm = llmClient;
  }

  getWorkspaceRoot() {
    return this._vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  }

  getWorkspaceRoots() {
    return (this._vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  }

  /**
   * Search items for searchable context providers (@Files, @Code, @Folder).
   * @param {string} providerId
   * @param {string} query
   */
  async searchProviderItems(providerId, query = '') {
    const q = String(query || '').trim().toLowerCase();
    const root = this.getWorkspaceRoot();
    if (!root) return [];

    if (providerId === 'files') {
      const uris = await this._vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}',
        200
      );
      return uris
        .map((u) => {
          const rel = getRelativePathWithinRoot(root, u.fsPath);
          if (rel === null) return null;
          return {
            id: JSON.stringify({ root, path: rel }),
            label: basename(rel),
            description: rel,
            path: u.fsPath
          };
        })
        .filter((item) => item && (!q || item.description.toLowerCase().includes(q)))
        .slice(0, 25);
    }

    if (providerId === 'folder') {
      const dirs = new Set(['.']);
      const uris = await this._vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/dist/**}',
        200
      );
      for (const u of uris) {
        const withinRoot = getRelativePathWithinRoot(root, u.fsPath);
        if (withinRoot === null) continue;
        const relDir = dirname(withinRoot).replace(/\\/g, '/');
        if (relDir && relDir !== '.') dirs.add(relDir);
      }
      return Array.from(dirs)
        .filter((d) => !q || d.toLowerCase().includes(q))
        .slice(0, 25)
        .map((d) => ({ id: d, label: d === '.' ? basename(root) : d, description: d }));
    }

    if (providerId === 'code') {
      try {
        const symbols = await this._vscode.commands.executeCommand(
          'vscode.executeWorkspaceSymbolProvider',
          q || ''
        );
        if (Array.isArray(symbols)) {
          return symbols
            .map((symbol) => {
              const filePath = symbol.location.uri.fsPath;
              const rel = getRelativePathWithinRoot(root, filePath);
              if (rel === null) return null;
              const line = symbol.location.range.start.line;
              return {
                id: JSON.stringify({ root, path: rel, line }),
                label: symbol.name,
                description: `${rel}:${line + 1}`,
                path: filePath,
                line
              };
            })
            .filter(Boolean)
            .slice(0, 25);
        }
      } catch (_) {
        // Fallback to indexed symbols
      }
      const hits = this._indexer.searchCodebase(q || 'function', 15);
      return hits.map((h) => ({
        id: JSON.stringify({
          root,
          path: h.filePath,
          line: Math.max(0, h.startLine - 1)
        }),
        label: h.symbols?.[0] || basename(h.filePath),
        description: `${h.filePath}:${h.startLine}-${h.endLine}`
      }));
    }

    return [];
  }

  /**
   * Resolve attached context pills into prompt context blocks.
   * @param {Array<{ provider: string, itemId?: string, label: string }>} attachments
   * @param {string} userQuery
   */
  async resolveAttachments(attachments, userQuery) {
    const blocks = [];
    const root = this.getWorkspaceRoot();

    for (const att of attachments || []) {
      try {
        if (att.provider === 'current_file') {
          const editor = this._vscode.window.activeTextEditor;
          if (editor) {
            const doc = editor.document;
            const rel = root ? relative(root, doc.uri.fsPath) : doc.fileName;
            const selection = editor.selection && !editor.selection.isEmpty
              ? doc.getText(editor.selection)
              : null;
            blocks.push({
              title: `Current File: ${rel}`,
              content: selection
                ? `Selected code in ${rel}:\n\`\`\`${doc.languageId}\n${selection}\n\`\`\``
                : `File ${rel}:\n\`\`\`${doc.languageId}\n${doc.getText().slice(0, 14000)}\n\`\`\``
            });
          } else {
            blocks.push({
              title: 'Current File',
              content: 'No active editor file is open.'
            });
          }
        } else if (att.provider === 'files' && att.itemId && root) {
          const filePath = resolveWorkspaceAttachment(this.getWorkspaceRoots(), att.itemId);
          if (filePath && existsSync(filePath)) {
            const stat = await promises.stat(filePath);
            if (!stat.isFile()) throw new Error('The selected item is not a file.');
            if (stat.size > 512 * 1024) throw new Error('The selected file is larger than the 512 KB context limit.');
            const buffer = await promises.readFile(filePath);
            if (buffer.includes(0)) throw new Error('The selected file appears to be binary and cannot be attached as text.');
            const text = buffer.toString('utf8');
            blocks.push({
              title: `File: ${relative(root, filePath).replace(/\\/g, '/')}`,
              content: `\`\`\`\n${text.slice(0, 14000)}\n\`\`\``
            });
          } else {
            blocks.push({
              title: `File: ${att.label}`,
              content: 'The selected file is no longer inside an open workspace folder.'
            });
          }
        } else if (att.provider === 'folder' && root) {
          const targetDir = resolveWorkspaceAttachment(this.getWorkspaceRoots(), att.itemId || '.');
          if (targetDir && existsSync(targetDir)) {
            const stat = await promises.stat(targetDir);
            if (!stat.isDirectory()) throw new Error('The selected item is not a folder.');
            const entries = await promises.readdir(targetDir, { withFileTypes: true });
            const listing = entries
              .filter((entry) => !['.git', 'node_modules', 'dist', 'build'].includes(entry.name))
              .slice(0, 80)
              .map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`)
              .join('\n');
            blocks.push({
              title: `Folder: ${att.itemId || '.'}`,
              content: listing
            });
          } else {
            blocks.push({
              title: `Folder: ${att.label}`,
              content: 'The selected folder is no longer inside an open workspace folder.'
            });
          }
        } else if (att.provider === 'git_diff' && root) {
          let stdout = '';
          let diffError = '';
          try {
            ({ stdout } = await execFileAsync('git', ['diff', 'HEAD', '--no-color'], {
              cwd: root,
              timeout: 5000
            }));
          } catch (headError) {
            try {
              ({ stdout } = await execFileAsync('git', ['diff', '--no-color'], {
                cwd: root,
                timeout: 5000
              }));
            } catch (fallbackError) {
              diffError = fallbackError.message || headError.message || 'Git diff is unavailable.';
            }
          }
          blocks.push({
            title: 'Git Diff',
            content: stdout
              ? `\`\`\`diff\n${stdout.slice(0, 12000)}\n\`\`\``
              : diffError
                ? `Unable to read Git diff: ${diffError}`
                : 'No tracked uncommitted Git changes.'
          });
        } else if (att.provider === 'problems') {
          const diags = this._vscode.languages.getDiagnostics();
          const lines = [];
          for (const [uri, list] of diags) {
            if (!list || list.length === 0) continue;
            const rel = root ? relative(root, uri.fsPath) : uri.fsPath;
            for (const d of list) {
              const severity = ['Error', 'Warning', 'Information', 'Hint'][d.severity] || 'Unknown';
              lines.push(`${rel}:${d.range.start.line + 1} [${severity}] ${d.message}`);
              if (lines.length >= 100) break;
            }
            if (lines.length >= 100) break;
          }
          blocks.push({
            title: 'Workspace Problems',
            content: lines.length > 0 ? lines.join('\n') : 'No active diagnostics/problems.'
          });
        } else if (att.provider === 'terminal') {
          const activeTerm = this._vscode.window.activeTerminal;
          blocks.push({
            title: 'Terminal',
            content: activeTerm
              ? `Active terminal: "${activeTerm.name}". VS Code does not expose existing terminal scrollback to extensions, so this attachment cannot include command output.`
              : 'No active VS Code terminal open.'
          });
        } else if (att.provider === 'rules') {
          const rules = this._config.getActiveProfile().rules.filter((r) => r.enabled);
          blocks.push({
            title: 'Active Rules',
            content: rules.length > 0
              ? rules.map((r) => `- **${r.name}**: ${r.content}`).join('\n')
              : 'No active rules enabled.'
          });
        } else if (att.provider === 'codebase') {
          const profile = this._config.getActiveProfile();
          const workspaceRoot = this.getWorkspaceRoot();
          let hits = [];
          let unavailableReason = '';
          if (!profile.indexing.enabled) {
            unavailableReason = 'Codebase indexing is disabled. Enable it in Indexing settings to use @codebase.';
          } else if (!workspaceRoot) {
            unavailableReason = 'Open a workspace folder to use @codebase.';
          } else if (!this._indexer.isIndexedFor(workspaceRoot)) {
            unavailableReason = 'The workspace codebase is still being indexed. Try your request again shortly.';
          } else {
            hits = this._indexer.searchCodebase(userQuery, 12);
          }
          const rerankModel = this._config.getModelForRole('rerank');
          if (!unavailableReason && rerankModel && this._llm && hits.length > 1) {
            try {
              const reranked = await this._llm.rerankTexts(
                rerankModel,
                userQuery,
                hits.map((hit) => `${hit.filePath}\n${hit.text}`),
                8
              );
              hits = reranked
                .map((result) => hits[result.index])
                .filter(Boolean);
            } catch (_) {
              hits = hits.slice(0, 8);
            }
          } else {
            hits = hits.slice(0, 8);
          }
          blocks.push({
            title: '@codebase Search Results',
            content: hits.length > 0
              ? hits.map((h) => `### ${h.filePath}:${h.startLine}-${h.endLine}\n\`\`\`\n${h.text}\n\`\`\``).join('\n\n')
              : unavailableReason || 'No matching chunks found in @codebase index.'
          });
        } else if (att.provider === 'docs') {
          let hits = this._indexer.searchDocs(userQuery, 10);
          const rerankModel = this._config.getModelForRole('rerank');
          if (rerankModel && this._llm && hits.length > 1) {
            try {
              const reranked = await this._llm.rerankTexts(
                rerankModel,
                userQuery,
                hits.map((hit) => `${hit.title}\n${hit.text}`),
                5
              );
              hits = reranked
                .map((result) => hits[result.index])
                .filter(Boolean);
            } catch (_) {
              hits = hits.slice(0, 5);
            }
          } else {
            hits = hits.slice(0, 5);
          }
          blocks.push({
            title: '@docs Search Results',
            content: hits.length > 0
              ? hits.map((h) => `### ${h.title} (${h.url})\n${h.text}`).join('\n\n')
              : 'No matching @docs chunks found.'
          });
        } else if (att.provider === 'code' && att.itemId) {
          const codeRef = parseCodeReference(att.itemId);
          const filePath = codeRef && resolveWorkspaceAttachment(this.getWorkspaceRoots(), JSON.stringify({
            root: codeRef.root || root,
            path: codeRef.path
          }));
          if (filePath && existsSync(filePath)) {
            const stat = await promises.stat(filePath);
            if (!stat.isFile()) throw new Error('The selected symbol path is not a file.');
            if (stat.size > 512 * 1024) throw new Error('The selected source file is larger than the 512 KB context limit.');
            const text = await promises.readFile(filePath, 'utf8');
            const lines = text.split(/\r?\n/);
            const start = Math.max(0, codeRef.line - 30);
            const end = Math.min(lines.length, codeRef.line + 50);
            blocks.push({
              title: `Code Symbol: ${att.label} (${relative(root, filePath)}:${codeRef.line + 1})`,
              content: `\`\`\`\n${lines.slice(start, end).join('\n').slice(0, 10000)}\n\`\`\``
            });
          } else {
            blocks.push({
              title: `Code Symbol: ${att.label}`,
              content: 'The selected symbol is no longer inside an open workspace folder.'
            });
          }
        }
      } catch (err) {
        blocks.push({
          title: `Context (${att.label})`,
          content: `Unable to load context: ${err.message}`
        });
      }
    }

    return blocks;
  }
}

function getRelativePathWithinRoot(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function resolveWorkspaceAttachment(workspaceRoots, itemId) {
  let reference;
  try {
    reference = JSON.parse(itemId);
  } catch (_) {
    reference = { root: workspaceRoots[0], path: itemId };
  }
  if (!reference || typeof reference.root !== 'string' || typeof reference.path !== 'string') return null;

  const workspaceRoot = workspaceRoots.find((candidate) => resolve(candidate) === resolve(reference.root));
  if (!workspaceRoot) return null;
  const fullPath = resolve(workspaceRoot, reference.path);
  return getRelativePathWithinRoot(workspaceRoot, fullPath) === null ? null : fullPath;
}

function parseCodeReference(itemId) {
  try {
    const reference = JSON.parse(itemId);
    if (
      typeof reference.root === 'string' &&
      typeof reference.path === 'string' &&
      Number.isInteger(reference.line)
    ) {
      return reference;
    }
  } catch (_) {
    // Older in-memory selections used a file path and line joined with a colon.
  }

  const separator = itemId.lastIndexOf(':');
  if (separator <= 0) return null;
  const line = Number(itemId.slice(separator + 1));
  if (!Number.isInteger(line)) return null;
  return {
    root: '',
    path: itemId.slice(0, separator),
    line
  };
}

export { ContextProviderService, CONTEXT_PROVIDERS };
export default { ContextProviderService, CONTEXT_PROVIDERS };
