'use strict';

import * as vscode from 'vscode';
import { SecretManager } from './core/secretManager.js';
import { ConfigManager } from './core/configManager.js';
import { SessionManager } from './core/sessionManager.js';
import { LLMClient } from './llm/llmClient.js';
import { CodebaseIndexer } from './indexing/codebaseIndexer.js';
import { ContextProviderService } from './context/contextProviders.js';
import { BuiltInToolsRunner } from './tools/builtInTools.js';
import { SidebarProvider } from './webview/sidebarProvider.js';

const { window, commands, ProgressLocation, languages, Range, Position, InlineCompletionItem } = vscode;

function buildActivePromptInstructions(profile, userText = '') {
  const sections = [];
  const activeRules = (profile.rules || []).filter((rule) => rule.enabled);
  if (activeRules.length > 0) {
    sections.push(
      'Active Workspace Rules:\n' +
        activeRules.map((rule) => `- ${rule.name}: ${rule.content}`).join('\n')
    );
  }

  const lowerText = String(userText).toLowerCase();
  const activeSkills = (profile.skills || []).filter((skill) => {
    if (!skill.enabled) return false;
    return String(skill.trigger || '')
      .split(',')
      .map((trigger) => trigger.trim().toLowerCase())
      .filter(Boolean)
      .some((trigger) => lowerText.includes(trigger));
  });
  if (activeSkills.length > 0) {
    sections.push(
      'Active Skills:\n' +
        activeSkills
          .map((skill) =>
            `## ${skill.name}\n${skill.description ? `${skill.description}\n` : ''}${skill.instructions}`
          )
          .join('\n\n')
    );
  }
  return sections.join('\n\n');
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  const secretManager = new SecretManager(context.secrets);
  const configManager = new ConfigManager(context.globalState, secretManager);
  const sessionManager = new SessionManager(context.workspaceState);
  const llmClient = new LLMClient(secretManager);

  const storagePath = context.storageUri?.fsPath || context.globalStorageUri.fsPath;
  const indexer = new CodebaseIndexer(storagePath, llmClient);
  await indexer.loadFromDisk();

  const contextProviders = new ContextProviderService(vscode, indexer, configManager, llmClient);
  const toolsRunner = new BuiltInToolsRunner(vscode, configManager, indexer);

  const sidebarProvider = new SidebarProvider(vscode, context, {
    secretManager,
    configManager,
    sessionManager,
    llmClient,
    indexer,
    contextProviders,
    toolsRunner
  });

  context.subscriptions.push(
    window.registerWebviewViewProvider('codepilot.chatView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Command: Ctrl+L Focus Chat / Send Selection
  context.subscriptions.push(
    commands.registerCommand('codepilot.focusChat', async () => {
      await commands.executeCommand('codepilot.chatView.focus');
      const editor = window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const text = editor.document.getText(editor.selection);
        const start = editor.selection.start.line + 1;
        const end = editor.selection.end.line + 1;
        await sidebarProvider.sendSelectionToChat(text, editor.document.fileName, `${start}-${end}`);
      }
    })
  );

  // Command: Ctrl+I Inline Edit Selection using Edit model role
  context.subscriptions.push(
    commands.registerCommand('codepilot.inlineEdit', async () => {
      const editor = window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        window.showInformationMessage('CodePilot AI: Select code in the editor to run Inline Edit (Ctrl+I).');
        return;
      }

      const instruction = await window.showInputBox({
        prompt: 'CodePilot AI Inline Edit: Describe how to transform the selected code',
        placeHolder: 'e.g., Add input validation and JSDoc comments'
      });
      if (!instruction) return;

      const editModel = configManager.getModelForRole('edit') || configManager.getModelForRole('chat');
      if (!editModel) {
        window.showErrorMessage('CodePilot AI: No Edit or Chat model configured.');
        return;
      }

      const selectedText = editor.document.getText(editor.selection);
      const lang = editor.document.languageId;

      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `CodePilot AI: Editing with ${editModel.title}...`,
          cancellable: true
        },
        async (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          try {
            const activeProfile = configManager.getActiveProfile();
            const promptInstructions = buildActivePromptInstructions(activeProfile, instruction);
            const res = await llmClient.chat({
              modelConfig: editModel,
              stream: false,
              temperature: 0.1,
              signal: controller.signal,
              messages: [
                {
                  role: 'system',
                  content: [
                    `You are an expert ${lang} code editor. Return ONLY the transformed replacement code without markdown code fences or commentary.`,
                    promptInstructions
                  ].filter(Boolean).join('\n\n')
                },
                {
                  role: 'user',
                  content: `Instruction: ${instruction}\n\nSelected code:\n${selectedText}`
                }
              ]
            });
            const cleaned = res.content.replace(/^```[\w]*\n?/m, '').replace(/```\s*$/m, '');
            if (cleaned.trim()) {
              await editor.edit((eb) => eb.replace(editor.selection, cleaned));
            }
          } catch (err) {
            if (err.name !== 'AbortError') {
              window.showErrorMessage(`CodePilot AI Edit failed: ${err.message}`);
            }
          }
        }
      );
    })
  );

  // Command: New Session
  context.subscriptions.push(
    commands.registerCommand('codepilot.newSession', async () => {
      sessionManager.createSession();
      await sidebarProvider.pushFullState();
    })
  );

  // Command: Ctrl+. Next Mode
  context.subscriptions.push(
    commands.registerCommand('codepilot.nextMode', async () => {
      const mode = await sidebarProvider.cycleMode();
      window.setStatusBarMessage(`CodePilot AI Mode: ${mode.toUpperCase()}`, 2000);
    })
  );

  // Command: Ctrl+' Toggle Model
  context.subscriptions.push(
    commands.registerCommand('codepilot.toggleModel', async () => {
      const next = await configManager.cycleChatModel();
      await sidebarProvider.pushFullState();
      if (next) {
        window.setStatusBarMessage(`CodePilot AI Model: ${next.title}`, 2000);
      }
    })
  );

  // Command: Re-index Codebase
  context.subscriptions.push(
    commands.registerCommand('codepilot.reindexCodebase', async () => {
      await sidebarProvider.triggerReindex();
    })
  );

  // Command: Open Settings
  context.subscriptions.push(
    commands.registerCommand('codepilot.openSettings', async () => {
      await commands.executeCommand('codepilot.chatView.focus');
      await sidebarProvider.openSettings('models');
    })
  );

  // Inline Autocomplete Provider (ghost text)
  let autocompleteTimer = null;
  context.subscriptions.push(
    languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      {
        async provideInlineCompletionItems(document, position, _ctx, token) {
          const profile = configManager.getActiveProfile();
          if (!profile.settings.autocompleteEnabled) return [];
          const acModel = configManager.getModelForRole('autocomplete');
          if (!acModel) return [];

          if (autocompleteTimer) clearTimeout(autocompleteTimer);
          await new Promise((r) => {
            autocompleteTimer = setTimeout(r, profile.settings.autocompleteDelayMs || 350);
          });
          if (token.isCancellationRequested) return [];

          const prefixRange = new Range(
            new Position(Math.max(0, position.line - 30), 0),
            position
          );
          const prefix = document.getText(prefixRange);
          if (prefix.trim().length < 5) return [];

          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());

          try {
            const promptInstructions = buildActivePromptInstructions(profile, prefix);
            const res = await llmClient.chat({
              modelConfig: acModel,
              stream: false,
              temperature: 0.1,
              maxTokens: 128,
              signal: controller.signal,
              messages: [
                {
                  role: 'system',
                  content: [
                    `Complete the ${document.languageId} code at the cursor. Output ONLY the continuation text with no markdown fences.`,
                    promptInstructions
                  ].filter(Boolean).join('\n\n')
                },
                { role: 'user', content: prefix }
              ]
            });
            const suggestion = res.content.replace(/^```[\w]*\n?/m, '').replace(/```\s*$/m, '');
            if (!suggestion.trim()) return [];
            return [new InlineCompletionItem(suggestion, new Range(position, position))];
          } catch (_) {
            return [];
          }
        }
      }
    )
  );

  // Kick off background indexing if enabled and not yet indexed
  const activeProfile = configManager.getActiveProfile();
  if (activeProfile.indexing.enabled && indexer.getStatus().chunkCount === 0) {
    setTimeout(() => {
      sidebarProvider.triggerReindex().catch(() => {});
    }, 1500);
  }
}

function deactivate() {}

export { activate, deactivate };
