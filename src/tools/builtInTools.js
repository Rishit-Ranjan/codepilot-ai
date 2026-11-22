'use strict';

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of an existing file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path to the file' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_new_file',
      description: 'Create a new file with the specified content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path' },
          content: { type: 'string', description: 'File contents' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_existing_file',
      description: 'Replace an exact text snippet inside an existing workspace file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path' },
          oldText: { type: 'string', description: 'Exact existing text to replace' },
          newText: { type: 'string', description: 'Replacement text' }
        },
        required: ['path', 'oldText', 'newText']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
      description: 'Run a shell command in the workspace root directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_glob_search',
      description: 'Search for workspace files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.js' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search for a text or regex pattern across workspace files.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex to search for' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_diff',
      description: 'View the current git diff of working changes.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_currently_open_file',
      description: 'Read the file currently open in the active VS Code editor.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: 'List files and directories inside a workspace folder.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Workspace-relative directory path (default ".")' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_rule_block',
      description: 'Create a reusable rule in CodePilot AI.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['name', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_problems',
      description: 'View active diagnostics/problems in the workspace.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'codebase_search',
      description: 'Search the indexed @codebase for relevant code chunks.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_terminal',
      description: 'List open terminal names in VS Code.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch text content from an HTTP/HTTPS URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web using DuckDuckGo Instant Answer API.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      }
    }
  }
];

class BuiltInToolsRunner {
  /**
   * @param {typeof import('vscode')} vscode
   * @param {import('../core/configManager').ConfigManager} configManager
   * @param {import('../indexing/codebaseIndexer').CodebaseIndexer} indexer
   */
  constructor(vscode, configManager, indexer) {
    this._vscode = vscode;
    this._config = configManager;
    this._indexer = indexer;
  }

  getEnabledSchemas() {
    const profile = this._config.getActiveProfile();
    if (!profile.toolsEnabled) return [];
    const allowed = new Set(
      profile.tools.filter((t) => t.permission !== 'excluded').map((t) => t.name)
    );
    return TOOL_SCHEMAS.filter((s) => allowed.has(s.function.name));
  }

  getPermission(toolName) {
    const profile = this._config.getActiveProfile();
    if (!profile.toolsEnabled) return 'excluded';
    const found = profile.tools.find((t) => t.name === toolName);
    return found ? found.permission : 'excluded';
  }

  requiresApproval(toolName, args = {}) {
    if (toolName === 'run_terminal_command') {
      return this._isDangerousTerminalCommand(String(args.command || ''));
    }
    return false;
  }

  _isDangerousTerminalCommand(command) {
    const normalized = command.trim().toLowerCase();
    const dangerousPatterns = [
      /(^|\s)(?:rm\s+.*-(?:r|rf|fr|f)|remove-item\b.*-(?:recurse|r)\b)/i,
      /\brm\b\s+(?:-[a-z]*r[a-z]*\s+)?(?:\/|[a-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\*)/i,
      /\b(?:format|diskpart|mkfs(?:\.[a-z0-9]+)?|dd)\b/i,
      /\b(?:git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f)/i,
      /\b(?:shutdown|reboot)\b/i,
      /\bchmod\s+-r\b/i,
      /\bchown\s+-r\b/i
    ];
    return dangerousPatterns.some((pattern) => pattern.test(normalized));
  }

  _resolveSafePath(relPath) {
    const root = this._vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error('No workspace folder is open.');
    const resolved = path.resolve(root, relPath || '.');
    const normalizedRoot = path.resolve(root);
    if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
      throw new Error(`Access denied outside workspace root: ${relPath}`);
    }
    return { root: normalizedRoot, fullPath: resolved };
  }

  async execute(toolName, args = {}) {
    const perm = this.getPermission(toolName);
    if (perm === 'excluded') {
      throw new Error(`Tool "${toolName}" is set to Excluded in Tools settings.`);
    }

    switch (toolName) {
      case 'read_file': {
        const { fullPath } = this._resolveSafePath(args.path);
        const content = await fs.promises.readFile(fullPath, 'utf8');
        return content.slice(0, 16000);
      }

      case 'create_new_file': {
        const { fullPath } = this._resolveSafePath(args.path);
        if (fs.existsSync(fullPath)) {
          throw new Error(`File already exists: ${args.path}`);
        }
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, String(args.content ?? ''), 'utf8');
        return `Created file ${args.path}`;
      }

      case 'edit_existing_file': {
        const { fullPath } = this._resolveSafePath(args.path);
        const content = await fs.promises.readFile(fullPath, 'utf8');
        if (!content.includes(args.oldText)) {
          throw new Error(`Could not find target oldText in ${args.path}`);
        }
        const updated = content.replace(args.oldText, args.newText);
        await fs.promises.writeFile(fullPath, updated, 'utf8');
        return `Updated ${args.path}`;
      }

      case 'run_terminal_command': {
        const { root } = this._resolveSafePath('.');
        const command = String(args.command || '').trim();
        if (!command) {
          throw new Error('Terminal command cannot be empty.');
        }
        if (this._isDangerousTerminalCommand(command)) {
          throw new Error(
            'Dangerous terminal command blocked. Request explicit user approval or use a safer command.'
          );
        }
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: root,
            timeout: 15000,
            maxBuffer: 1024 * 1024,
            windowsHide: true
          });
          return `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`.trim().slice(0, 12000);
        } catch (err) {
          if (err.killed || err.code === 'ETIMEDOUT') {
            throw new Error('Terminal command timed out after 15 seconds.');
          }
          throw new Error(
            `Terminal command failed (${err.code ?? 'unknown'}): ${String(err.stderr || err.message || '').slice(0, 600)}`
          );
        }
      }

      case 'file_glob_search': {
        const { root } = this._resolveSafePath('.');
        const uris = await this._vscode.workspace.findFiles(
          args.pattern || '**/*',
          '{**/node_modules/**,**/.git/**}',
          100
        );
        return uris.map((u) => path.relative(root, u.fsPath).replace(/\\/g, '/')).join('\n') || 'No matches.';
      }

      case 'grep_search': {
        const { root } = this._resolveSafePath('.');
        const hits = this._indexer.searchCodebase(String(args.query || ''), 12);
        if (hits.length > 0) {
          return hits
            .map((h) => `${h.filePath}:${h.startLine}-${h.endLine}\n${h.text.slice(0, 400)}`)
            .join('\n---\n');
        }
        return `No matches found for "${args.query}" in ${path.basename(root)}.`;
      }

      case 'view_diff': {
        const { root } = this._resolveSafePath('.');
        const { stdout } = await execAsync('git diff --no-color', { cwd: root, timeout: 5000 }).catch(
          () => ({ stdout: '' })
        );
        return stdout ? stdout.slice(0, 12000) : 'No uncommitted git diff.';
      }

      case 'read_currently_open_file': {
        const editor = this._vscode.window.activeTextEditor;
        if (!editor) return 'No active editor open.';
        return `File: ${editor.document.fileName}\n\n${editor.document.getText().slice(0, 16000)}`;
      }

      case 'ls': {
        const { fullPath } = this._resolveSafePath(args.dir || '.');
        const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
        return entries
          .map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`)
          .join('\n') || '(empty directory)';
      }

      case 'create_rule_block': {
        const rule = await this._config.saveRule({
          name: args.name,
          description: 'Created by Agent',
          content: args.content,
          enabled: true
        });
        return `Created rule "${rule.name}"`;
      }

      case 'view_problems': {
        const { root } = this._resolveSafePath('.');
        const diags = this._vscode.languages.getDiagnostics();
        const out = [];
        for (const [uri, list] of diags) {
          for (const d of list.slice(0, 15)) {
            out.push(`${path.relative(root, uri.fsPath)}:${d.range.start.line + 1}: ${d.message}`);
          }
        }
        return out.join('\n') || 'No problems found.';
      }

      case 'codebase_search': {
        const hits = this._indexer.searchCodebase(String(args.query || ''), 8);
        return hits.length > 0
          ? hits.map((h) => `${h.filePath}:${h.startLine}-${h.endLine}\n${h.text}`).join('\n---\n')
          : 'No matching indexed code chunks found.';
      }

      case 'read_terminal': {
        const terms = this._vscode.window.terminals || [];
        return terms.length > 0
          ? `Open terminals: ${terms.map((t) => t.name).join(', ')}`
          : 'No open terminals.';
      }

      case 'fetch_url': {
        const res = await fetch(String(args.url || ''));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
      }

      case 'search_web': {
        const q = encodeURIComponent(String(args.query || ''));
        const res = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1`);
        const json = await res.json();
        return json.AbstractText || json.RelatedTopics?.[0]?.Text || 'No instant summary available.';
      }

      default:
        throw new Error(`Unknown built-in tool: ${toolName}`);
    }
  }
}

export { BuiltInToolsRunner, TOOL_SCHEMAS };
