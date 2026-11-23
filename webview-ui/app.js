(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  let appState = null;
  let activeSettingsTab = 'models';
  let attachedContext = [];
  let attachedSkills = [];
  let isStreaming = false;
  let streamingMsgId = null;
  let streamingSessionId = null;
  let streamingModelTitle = '';
  let streamingText = '';
  let activeSearchProvider = null;
  let contextSearchRequestId = 0;
  let toastTimeout = null;
  let inlineMentionActive = false;
  let inlineMentionStart = -1;

  const PROVIDER_DEFAULTS = {
    openai: { base: 'https://api.openai.com/v1', needsKey: true },
    anthropic: { base: 'https://api.anthropic.com/v1', needsKey: true },
    gemini: { base: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true },
    openrouter: { base: 'https://openrouter.ai/api/v1', needsKey: true },
    voyage: { base: 'https://api.voyageai.com/v1', needsKey: true },
    cohere: { base: 'https://api.cohere.com/v2', needsKey: true },
    jina: { base: 'https://api.jina.ai/v1', needsKey: true },
    ollama: { base: 'http://localhost:11434/v1', needsKey: false },
    custom: { base: 'https://api.openai.com/v1', needsKey: true }
  };

  // DOM refs
  const tabChat = document.getElementById('tab-chat');
  const viewChat = document.getElementById('view-chat');
  const viewSettings = document.getElementById('view-settings');
  const settingsSidebar = viewSettings.querySelector('.cp-sidebar');
  const settingsSidebarToggle = document.getElementById('btn-settings-sidebar-toggle');
  const toastEl = document.getElementById('toast');
  const toastMessageEl = document.getElementById('toast-message');
  const toastCloseBtn = document.getElementById('toast-close');
  const historyDrawer = document.getElementById('history-drawer');
  const btnHistory = document.getElementById('btn-history');
  const historyList = document.getElementById('history-list');
  const chatInput = document.getElementById('chat-input');
  const contextChipsEl = document.getElementById('context-chips');
  const emptyStateEl = document.getElementById('empty-state');
  const btnLastSession = document.getElementById('btn-last-session');
  const chatMessagesEl = document.getElementById('chat-messages');
  const settingsContentEl = document.getElementById('settings-content');

  // Popovers
  const menuMode = document.getElementById('menu-mode-picker');
  const menuModel = document.getElementById('menu-model-picker');
  const menuSkills = document.getElementById('menu-skills-picker');
  const btnModePicker = document.getElementById('btn-mode-picker');
  const btnModelPicker = document.getElementById('btn-model-picker');
  const btnSkillsPicker = document.getElementById('btn-skills-picker');
  const menuContext = document.getElementById('menu-context');
  const contextMenuHeader = document.getElementById('context-menu-header');
  const contextSearchInput = document.getElementById('context-search-input');
  const contextMenuList = document.getElementById('context-menu-list');

  // Modals
  const modalModel = document.getElementById('modal-model');
  const formModel = document.getElementById('form-model');
  const modalDoc = document.getElementById('modal-doc');
  const formDoc = document.getElementById('form-doc');

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function closeAllPopovers() {
    menuMode.classList.add('hidden');
    menuModel.classList.add('hidden');
    menuSkills.classList.add('hidden');
    menuContext.classList.add('hidden');
    activeSearchProvider = null;
    contextSearchRequestId++;
    contextMenuHeader.classList.add('hidden');
  }

  toastCloseBtn.addEventListener('click', () => {
    if (toastTimeout) {
      clearTimeout(toastTimeout);
      toastTimeout = null;
    }
    toastEl.classList.add('hidden');
  });

  function showToast(message, persistent = false) {
    if (toastTimeout) {
      clearTimeout(toastTimeout);
      toastTimeout = null;
    }
    toastMessageEl.textContent = message;
    toastEl.classList.remove('hidden');
    if (!persistent) {
      toastTimeout = setTimeout(() => {
        toastEl.classList.add('hidden');
        toastTimeout = null;
      }, 5000);
    }
  }

  function showErrorToast(message) {
    const text = String(message || 'Model request failed.');
    showToast(text, text.startsWith('Ollama is unavailable.'));
  }

  function switchMainView(view) {
    if (view === 'settings') {
      tabChat.classList.remove('active');
      tabChat.setAttribute('aria-selected', 'false');
      viewChat.classList.remove('active');
      viewSettings.classList.add('active');
      renderSettingsTab();
    } else {
      tabChat.classList.add('active');
      tabChat.setAttribute('aria-selected', 'true');
      viewSettings.classList.remove('active');
      viewChat.classList.add('active');
    }
  }

  // Topbar events
  tabChat.addEventListener('click', () => switchMainView('chat'));
  document.getElementById('btn-open-settings').addEventListener('click', () => {
    activeSettingsTab = 'settings';
    switchMainView('settings');
  });
  document.getElementById('btn-settings-back').addEventListener('click', () => switchMainView('chat'));
  let sidebarPreference = vscode.getState()?.settingsSidebarCollapsed;
  let sidebarWidthPreference = vscode.getState()?.settingsSidebarWidth;
  const narrowSidebarQuery = window.matchMedia('(max-width: 420px)');
  const settingsSidebarResizer = document.getElementById('settings-sidebar-resizer');

  function setSettingsSidebarCollapsed(collapsed, remember = false) {
    settingsSidebar.classList.toggle('collapsed', collapsed);
    settingsSidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    settingsSidebarToggle.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
    settingsSidebarToggle.title = collapsed ? 'Expand navigation' : 'Collapse navigation';
    settingsSidebarToggle.dataset.tooltip = collapsed ? 'Expand navigation' : 'Collapse navigation';
    settingsSidebarToggle.querySelector('.cp-nav-icon-text').innerHTML = collapsed ? '&rsaquo;' : '&lsaquo;';
    settingsSidebarToggle.querySelector('.cp-nav-label').textContent = collapsed ? 'Expand' : 'Collapse';
    if (remember) {
      sidebarPreference = collapsed;
      vscode.setState({ ...vscode.getState(), settingsSidebarCollapsed: collapsed });
    }
  }

  function applySidebarBreakpoint() {
    if (narrowSidebarQuery.matches) {
      setSettingsSidebarCollapsed(true);
    } else if (typeof sidebarPreference === 'boolean') {
      setSettingsSidebarCollapsed(sidebarPreference);
    } else {
      setSettingsSidebarCollapsed(false);
    }
  }

  settingsSidebarToggle.addEventListener('click', () => {
    setSettingsSidebarCollapsed(!settingsSidebar.classList.contains('collapsed'), true);
  });

  const MIN_SIDEBAR_WIDTH = 142;
  const MAX_SIDEBAR_WIDTH = 220;
  const savedSidebarWidth = Number(sidebarWidthPreference);
  if (Number.isFinite(savedSidebarWidth)) {
    settingsSidebar.style.setProperty('--sidebar-width', `${Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, savedSidebarWidth))}px`);
  }
  updateResizerAria(getSidebarWidth());

  function getSidebarWidth() {
    const saved = parseFloat(settingsSidebar.style.getPropertyValue('--sidebar-width'));
    return Number.isFinite(saved) ? saved : 142;
  }

  function updateResizerAria(width) {
    settingsSidebarResizer.setAttribute('aria-valuenow', String(Math.round(width)));
  }

  settingsSidebarResizer.addEventListener('pointerdown', (event) => {
    if (settingsSidebar.classList.contains('collapsed')) {
      setSettingsSidebarCollapsed(false, true);
    }

    event.preventDefault();
    settingsSidebarResizer.setPointerCapture(event.pointerId);
    settingsSidebarResizer.classList.add('dragging');
    settingsSidebar.classList.add('resizing');

    const startX = event.clientX;
    const startWidth = getSidebarWidth();

    const resize = (moveEvent) => {
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + moveEvent.clientX - startX)
      );
      settingsSidebar.style.setProperty('--sidebar-width', `${Math.round(nextWidth)}px`);
      settingsSidebar.style.width = `${Math.round(nextWidth)}px`;
      updateResizerAria(nextWidth);
    };

    const finish = (upEvent) => {
      settingsSidebarResizer.removeEventListener('pointermove', resize);
      settingsSidebarResizer.removeEventListener('pointerup', finish);
      settingsSidebarResizer.removeEventListener('pointercancel', finish);
      settingsSidebarResizer.classList.remove('dragging');
      settingsSidebar.classList.remove('resizing');
      if (settingsSidebarResizer.hasPointerCapture(upEvent.pointerId)) {
        settingsSidebarResizer.releasePointerCapture(upEvent.pointerId);
      }

      const finalWidth = getSidebarWidth();
      sidebarWidthPreference = finalWidth;
      updateResizerAria(finalWidth);
      vscode.setState({ ...vscode.getState(), settingsSidebarCollapsed: false, settingsSidebarWidth: finalWidth });
      settingsSidebar.style.width = '';
    };

    settingsSidebarResizer.addEventListener('pointermove', resize);
    settingsSidebarResizer.addEventListener('pointerup', finish);
    settingsSidebarResizer.addEventListener('pointercancel', finish);
  });

  settingsSidebarResizer.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    if (settingsSidebar.classList.contains('collapsed')) {
      setSettingsSidebarCollapsed(false, true);
    }
    const direction = event.key === 'ArrowRight' ? 8 : -8;
    const nextWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, getSidebarWidth() + direction));
    settingsSidebar.style.setProperty('--sidebar-width', `${nextWidth}px`);
    sidebarWidthPreference = nextWidth;
    updateResizerAria(nextWidth);
    vscode.setState({ ...vscode.getState(), settingsSidebarCollapsed: false, settingsSidebarWidth: nextWidth });
  });

  narrowSidebarQuery.addEventListener('change', applySidebarBreakpoint);
  applySidebarBreakpoint();

  document.getElementById('btn-new-session').addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
    switchMainView('chat');
  });

  btnHistory.addEventListener('click', () => {
    historyDrawer.classList.toggle('hidden');
  });
  document.getElementById('btn-close-history').addEventListener('click', () => {
    historyDrawer.classList.add('hidden');
  });

  document.querySelectorAll('.cp-mini-btn[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeSettingsTab = btn.dataset.nav;
      switchMainView('settings');
    });
  });

  document.querySelectorAll('.cp-nav-item[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeSettingsTab = btn.dataset.tab;
      document.querySelectorAll('.cp-nav-item[data-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderSettingsTab();
    });
  });

  // Dropdown toggles
  btnModePicker.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menuMode.classList.contains('hidden');
    closeAllPopovers();
    if (isHidden) menuMode.classList.remove('hidden');
  });

  btnModelPicker.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menuModel.classList.contains('hidden');
    closeAllPopovers();
    if (isHidden) menuModel.classList.remove('hidden');
  });

  btnSkillsPicker.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menuSkills.classList.contains('hidden');
    closeAllPopovers();
    if (isHidden) menuSkills.classList.remove('hidden');
  });

  document.getElementById('btn-skills-settings').addEventListener('click', () => {
    closeAllPopovers();
    activeSettingsTab = 'skills';
    switchMainView('settings');
  });

  document.getElementById('btn-models-gear').addEventListener('click', () => {
    closeAllPopovers();
    activeSettingsTab = 'models';
    switchMainView('settings');
  });

  document.getElementById('btn-add-chat-model').addEventListener('click', () => {
    closeAllPopovers();
    openModelModal(null);
  });

  document.querySelectorAll('#menu-mode-picker .cp-menu-item[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'setMode', mode: btn.dataset.mode });
      closeAllPopovers();
    });
  });

  document.addEventListener('click', (e) => {
    if (!menuMode.contains(e.target) && !btnModePicker.contains(e.target)) {
      menuMode.classList.add('hidden');
    }
    if (!menuModel.contains(e.target) && !btnModelPicker.contains(e.target)) {
      menuModel.classList.add('hidden');
    }
    if (!menuSkills.contains(e.target) && !btnSkillsPicker.contains(e.target)) {
      menuSkills.classList.add('hidden');
    }
    if (!menuContext.contains(e.target) && !document.getElementById('btn-at-context').contains(e.target)) {
      closeContextMenu();
    }
    if (!e.target.closest('.cp-dropdown-wrap') && !e.target.closest('.cp-input-wrap') && !e.target.closest('#btn-at-context')) {
      closeAllPopovers();
    }
    if (
      !historyDrawer.classList.contains('hidden') &&
      !historyDrawer.contains(e.target) &&
      !btnHistory.contains(e.target)
    ) {
      historyDrawer.classList.add('hidden');
    }
  });

  function getInlineMentionMatch(inputEl) {
    const caret = inputEl.selectionStart ?? inputEl.value.length;
    const beforeCaret = inputEl.value.slice(0, caret);
    const match = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return null;
    const fullMatch = match[0];
    const atIndex = beforeCaret.length - match[1].length - 1;
    return {
      query: match[1],
      start: atIndex,
      end: caret,
      hasLeadingSpace: /^\s/.test(fullMatch)
    };
  }

  // Inline mentions menu
  function openInlineMentionMenu(query, start) {
    inlineMentionActive = true;
    inlineMentionStart = start;
    activeSearchProvider = null;
    contextSearchRequestId++;
    contextMenuHeader.classList.add('hidden');
    renderContextProvidersRoot(query);
    menuContext.classList.remove('hidden');
  }

  function closeInlineMentionMenu() {
    inlineMentionActive = false;
    inlineMentionStart = -1;
    closeContextMenu();
  }

  // @ Context Menu
  function openContextMenu() {
    activeSearchProvider = null;
    contextSearchRequestId++;
    contextMenuHeader.classList.add('hidden');
    renderContextProvidersRoot('');
    menuContext.classList.remove('hidden');
  }

  function closeContextMenu() {
    inlineMentionActive = false;
    inlineMentionStart = -1;
    activeSearchProvider = null;
    contextSearchRequestId++;
    contextMenuHeader.classList.add('hidden');
    menuContext.classList.add('hidden');
  }

  function searchContextProvider(providerId, query) {
    const requestId = ++contextSearchRequestId;
    contextMenuList.innerHTML = '<div class="cp-muted" style="padding:8px;">Searching...</div>';
    vscode.postMessage({ type: 'searchContextProvider', providerId, query, requestId });
  }

  function clearContextTrigger() {
    const caret = chatInput.selectionStart ?? chatInput.value.length;
    if (inlineMentionStart >= 0 && inlineMentionStart < caret) {
      const before = chatInput.value.slice(0, inlineMentionStart);
      const after = chatInput.value.slice(caret);
      chatInput.value = before + after;
      chatInput.setSelectionRange(before.length, before.length);
    } 
    else if (chatInput.value.endsWith('@')) {
      chatInput.value = chatInput.value.slice(0, -1);
      chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
    }
    inlineMentionActive = false;
    inlineMentionStart = -1;
    chatInput.focus();
}

  document.getElementById('btn-at-context').addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuContext.classList.contains('hidden')) {
      openContextMenu();
    } else {
      closeContextMenu();
    }
  });

  document.getElementById('btn-context-back').addEventListener('click', (e) => {
    e.stopPropagation();
    openContextMenu();
  });

  contextSearchInput.addEventListener('input', () => {
    if (activeSearchProvider) {
      searchContextProvider(activeSearchProvider, contextSearchInput.value);
    }
  });
  contextSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeContextMenu();
      chatInput.focus();
    }
  });

  function renderContextProvidersRoot(filterQuery = '') {
    const q = String(filterQuery || '').trim().toLowerCase();
    const allProviders = appState?.contextProviders || [];
    const providers = allProviders.filter((p) => {
      if (!q) return true;
      return (
        String(p.label || '').toLowerCase().includes(q) ||
        String(p.id || '').toLowerCase().includes(q)
      );
    });

    contextMenuList.innerHTML = providers.length
      ? providers
          .map(
            (p) => `
      <button class="cp-menu-item" data-provider="${escapeHtml(p.id)}" data-searchable="${p.searchable}">
        <span>${escapeHtml(p.label)}</span>
        <span class="cp-muted">${p.searchable ? 'Search &rarr;' : ''}</span>
      </button>
    `
          )
          .join('')
      : '<div class="cp-muted" style="padding:8px;">No matching context providers.</div>';

    contextMenuList.querySelectorAll('.cp-menu-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pid = btn.dataset.provider;
        const searchable = btn.dataset.searchable === 'true';
        if (searchable) {
          clearContextTrigger();
          activeSearchProvider = pid;
          contextMenuHeader.classList.remove('hidden');
          contextSearchInput.value = '';
          contextSearchInput.focus();
          menuContext.classList.remove('hidden');
          searchContextProvider(pid, '');
        } else {
          const prov = allProviders.find((x) => x.id === pid);
          clearContextTrigger();
          addAttachment({ provider: pid, label: prov ? prov.label : pid });
          closeContextMenu();
        }
      });
    });
  }

  function addAttachment(att) {
    const key = `${att.provider}:${att.itemId || ''}`;
    if (!attachedContext.some((a) => `${a.provider}:${a.itemId || ''}` === key)) {
      attachedContext.push(att);
      renderContextChips();
    }
  }

  function renderContextChips() {
    if (attachedContext.length === 0 && attachedSkills.length === 0) {
      contextChipsEl.classList.add('hidden');
      contextChipsEl.innerHTML = '';
      return;
    }
    contextChipsEl.classList.remove('hidden');
    const contextItems = attachedContext
      .map(
        (a, idx) => `
      <span class="cp-chip">
        @${escapeHtml(a.label)}
        <button data-rm-chip="${idx}" title="Remove">&times;</button>
      </span>
    `
      )
      .join('');
    const skillItems = attachedSkills
      .map(
        (skill, idx) => `
      <span class="cp-chip">
        &#9889; ${escapeHtml(skill.name)}
        <button data-rm-skill="${idx}" title="Remove Skill">&times;</button>
      </span>
    `
      )
      .join('');
    contextChipsEl.innerHTML = contextItems + skillItems;

    contextChipsEl.querySelectorAll('button[data-rm-chip]').forEach((btn) => {
      btn.addEventListener('click', () => {
        attachedContext.splice(Number(btn.dataset.rmChip), 1);
        renderContextChips();
      });
    });
    contextChipsEl.querySelectorAll('button[data-rm-skill]').forEach((btn) => {
      btn.addEventListener('click', () => {
        attachedSkills.splice(Number(btn.dataset.rmSkill), 1);
        renderContextChips();
      });
    });
  }

  // Send logic
  function sendCurrentMessage(includeActiveFile = false) {
    if (isStreaming) return;
    const text = chatInput.value.trim();
    const attachments = [...attachedContext];
    if (includeActiveFile && !attachments.some((a) => a.provider === 'current_file')) {
      attachments.push({ provider: 'current_file', label: 'Current File' });
    }
    if (!text && attachments.length === 0 && attachedSkills.length === 0) return;

    chatInput.value = '';
    attachedContext = [];
    const skillIds = attachedSkills.map((skill) => skill.id);
    attachedSkills = [];
    renderContextChips();
    closeAllPopovers();
    vscode.postMessage({ type: 'sendMessage', text, attachments, skillIds });
  }

  document.getElementById('btn-send').addEventListener('click', () => sendCurrentMessage(false));
  document.getElementById('btn-send-active-file').addEventListener('click', () => {
    addAttachment({ provider: 'current_file', label: 'Current File' });
  });
  document.getElementById('btn-stop').addEventListener('click', () => {
    vscode.postMessage({ type: 'stopGeneration' });
  });

  btnLastSession.addEventListener('click', () => {
    vscode.postMessage({ type: 'restoreLastSession' });
  });

  chatInput.addEventListener('input', () => {
    const mention = getInlineMentionMatch(chatInput);
    if (mention) {
      openInlineMentionMenu(mention.query, mention.start);
    } else if (inlineMentionActive) {
      closeInlineMentionMenu();
    } else if (!activeSearchProvider && !menuContext.classList.contains('hidden')) {
      closeContextMenu();
    }
  });

  chatInput.addEventListener('keydown', (e) => {
    const inlineMenuOpen = !menuContext.classList.contains('hidden') && !activeSearchProvider;

    if (inlineMenuOpen && (e.key === 'Enter' || e.key === 'Tab')) {
      const firstItem = contextMenuList.querySelector('button.cp-menu-item[data-provider]');
      if (firstItem) {
        e.preventDefault();
        firstItem.click();
        return;
      }
    }

    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendCurrentMessage(true);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrentMessage(false);
    } else if (e.key === 'Escape') {
      closeAllPopovers();
    }
  });

  // Markdown + code block renderer
  function highlightCode(code, language) {
    const lang = String(language || '').toLowerCase();
    if (!lang || ['code', 'text', 'plaintext', 'txt'].includes(lang)) return escapeHtml(code);

    const tokenPattern =
      /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(?:as|async|await|break|case|catch|class|const|continue|def|default|else|export|extends|finally|for|from|function|if|import|in|interface|let|new|of|package|private|public|return|static|struct|switch|throw|try|type|var|while|yield|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|CREATE|TABLE|AND|OR|NOT)\b|\b(?:true|false|null|undefined|none|none|nullptr|self|this)\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[A-Za-z_$][\w$]*(?=\s*\()/gi;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = tokenPattern.exec(code)) !== null) {
      result += escapeHtml(code.slice(lastIndex, match.index));
      const token = match[0];
      let tokenClass = 'function';
      if (match[1]) tokenClass = 'comment';
      else if (match[2]) tokenClass = 'string';
      else if (/^(true|false|null|undefined|none|nullptr)$/i.test(token)) tokenClass = 'literal';
      else if (/^\d/.test(token)) tokenClass = 'number';
      else if (/^(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|CREATE|TABLE|AND|OR|NOT)$/i.test(token)) tokenClass = 'keyword';
      else if (/^(as|async|await|break|case|catch|class|const|continue|def|default|else|export|extends|finally|for|from|function|if|import|in|interface|let|new|of|package|private|public|return|static|struct|switch|throw|try|type|var|while|yield)$/i.test(token)) tokenClass = 'keyword';
      result += `<span class="cp-token-${tokenClass}">${escapeHtml(token)}</span>`;
      lastIndex = tokenPattern.lastIndex;
    }

    return result + escapeHtml(code.slice(lastIndex));
  }

  function renderMarkdown(text) {
    const parts = [];
    const regex = /```([\w-]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    let blockIdx = 0;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(formatInlineText(text.slice(lastIndex, match.index)));
      }
      const lang = escapeHtml(match[1] || 'code');
      const rawCode = match[2];
      const encoded = encodeURIComponent(rawCode);
      parts.push(`
        <div class="cp-code-block" data-block-idx="${blockIdx++}">
          <div class="cp-code-header">
            <span>${lang}</span>
            <div class="cp-code-actions">
              <button class="cp-mini-btn" data-copy-code="${encoded}">Copy</button>
              <button class="cp-mini-btn" data-edit-code="${encoded}">Edit</button>
              <button class="cp-mini-btn" data-apply-code="${encoded}">Apply</button>
            </div>
          </div>
          <pre><code>${highlightCode(rawCode, match[1])}</code></pre>
        </div>
      `);
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(formatInlineText(text.slice(lastIndex)));
    }
    return parts.join('');
  }

  function formatInlineText(str) {
    const formatLine = (line) => escapeHtml(line)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    return String(str || '')
      .split('\n')
      .map((line, index, lines) => {
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          const level = heading[1].length;
          return `<div class="cp-heading cp-heading-${level}">${formatLine(heading[2])}</div>`;
        }
        return formatLine(line) + (index < lines.length - 1 ? '<br/>' : '');
      })
      .join('');
  }

  function bindCodeButtons(container) {
    container.querySelectorAll('button[data-copy-code]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'copyCodeBlock', code: decodeURIComponent(btn.dataset.copyCode) });
      });
    });
    container.querySelectorAll('button[data-apply-code]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'applyCodeBlock', code: decodeURIComponent(btn.dataset.applyCode) });
      });
    });
    container.querySelectorAll('button[data-edit-code]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'editCodeBlock', code: decodeURIComponent(btn.dataset.editCode) });
      });
    });
  }

  function renderMessages() {
    const activeSession = appState?.activeSession;
    const messages = activeSession?.messages || [];
    const hasActiveStream = Boolean(
      isStreaming && streamingMsgId && activeSession?.id === streamingSessionId
    );
    if (messages.length === 0 && !hasActiveStream) {
      emptyStateEl.classList.remove('hidden');
      chatMessagesEl.innerHTML = '';
      if (appState?.lastSessionSummary) {
        btnLastSession.classList.remove('hidden');
      } else {
        btnLastSession.classList.add('hidden');
      }
      return;
    }

    emptyStateEl.classList.add('hidden');
    const renderedMessages = messages
      .map((m) => {
        const badge = m.role === 'user' ? `You (${escapeHtml(m.mode || 'chat')})` : escapeHtml(m.modelTitle || 'CodePilot Coder');
        const skillNames = (m.skillIds || [])
          .map((skillId) => appState?.config?.profile?.skills?.find((skill) => skill.id === skillId)?.name)
          .filter(Boolean);
        const chips = (m.attachments || [])
          .map((a) => `<span class="cp-badge">@${escapeHtml(a.label)}</span>`)
          .concat(skillNames.map((name) => `<span class="cp-badge">&#9889; ${escapeHtml(name)}</span>`))
          .join(' ');
        const status = m.interrupted ? 'Stopped' : m.incomplete ? 'Incomplete' : '';
        return `
          <div class="cp-msg ${m.role}" data-msg-id="${escapeHtml(m.id)}">
            <div class="cp-msg-meta">
              <strong>${badge}</strong>
              <span>${status || chips}</span>
            </div>
            <div class="cp-msg-body">${renderMarkdown(m.content || '')}</div>
          </div>
        `;
      })
      .join('');
    const streamingMessage = hasActiveStream
      ? `
        <div class="cp-msg assistant" data-msg-id="${escapeHtml(streamingMsgId)}">
          <div class="cp-msg-meta"><strong>${escapeHtml(streamingModelTitle || 'CodePilot Coder')}</strong><span>Streaming...</span></div>
          <div class="cp-msg-body">${renderMarkdown(streamingText)}</div>
        </div>
      `
      : '';
    chatMessagesEl.innerHTML = renderedMessages + streamingMessage;

    bindCodeButtons(chatMessagesEl);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function upsertActiveSessionMessage(sessionId, message) {
    const activeSession = appState?.activeSession;
    if (!activeSession || activeSession.id !== sessionId || !message) return false;
    if (!Array.isArray(activeSession.messages)) activeSession.messages = [];
    const existingIndex = activeSession.messages.findIndex((item) => item.id === message.id);
    if (existingIndex === -1) {
      activeSession.messages.push(message);
    } else {
      activeSession.messages[existingIndex] = message;
    }
    return true;
  }

  function renderTopControls() {
    if (!appState) return;
    const { mode, config, sessions } = appState;
    const profile = config.profile;

    const modeControls = {
      chat: {
        icon: '<svg class="cp-mode-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v8h-6l-3 3v-3h-2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 6h6M5 8h4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
        label: 'Chat'
      },
      plan: {
        icon: '<svg class="cp-mode-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h7l2 2v11h-9z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10.5 1.5v3h3M5.5 7h5M5.5 9.5h5M5.5 12h3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
        label: 'Plan'
      },
      agent: {
        icon: '<svg class="cp-mode-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.25 3.25L12.5 6l-3.25 1.25L8 10.5l-1.25-3.25L3.5 6l3.25-1.25zM12.5 10l.65 1.85L15 12.5l-1.85.65L12.5 15l-.65-1.85L10 12.5l1.85-.65z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>',
        label: 'Agent'
      }
    };
    const selectedMode = modeControls[mode] || modeControls.chat;
    document.getElementById('label-mode').innerHTML =
      `<span aria-hidden="true">${selectedMode.icon}</span> ${selectedMode.label}`;

    // Active chat model
    const activeChatModel =
      profile.models.find((m) => m.id === profile.roles.chat) ||
      profile.models.find((m) => m.roles.includes('chat')) ||
      profile.models[0];
    document.getElementById('label-model').textContent = activeChatModel
      ? activeChatModel.title
      : 'Select Model';

    // Model picker list
    const chatModels = profile.models.filter((m) => m.roles.includes('chat'));
    const modelListEl = document.getElementById('model-picker-list');
    modelListEl.innerHTML = chatModels
      .map(
        (m) => `
      <button class="cp-menu-item ${m.id === profile.roles.chat ? 'active' : ''}" data-pick-model="${escapeHtml(m.id)}">
        <span>${escapeHtml(m.title)}</span>
        <span class="cp-muted">${m.requiresApiKey && !m.hasApiKey ? 'Key needed' : escapeHtml(m.provider)}</span>
      </button>
    `
      )
      .join('');

    modelListEl.querySelectorAll('button[data-pick-model]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'setRoleModel', role: 'chat', modelId: btn.dataset.pickModel });
        closeAllPopovers();
      });
    });

    // Skill picker
    const skills = (profile.skills || []).filter((skill) => skill.enabled);
    const skillListEl = document.getElementById('skill-picker-list');
    skillListEl.innerHTML = skills.length
      ? skills
          .map(
            (skill) => `
          <button class="cp-menu-item ${attachedSkills.some((selected) => selected.id === skill.id) ? 'active' : ''}" data-pick-skill="${escapeHtml(skill.id)}">
            <span>
              ${escapeHtml(skill.name)}
              ${skill.description ? `<span class="cp-muted" style="display:block">${escapeHtml(skill.description)}</span>` : ''}
            </span>
          </button>
        `
          )
          .join('')
      : '<div class="cp-muted" style="padding:8px">No enabled skills. Open Manage Skills to create one.</div>';
    skillListEl.querySelectorAll('button[data-pick-skill]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const skill = skills.find((candidate) => candidate.id === btn.dataset.pickSkill);
        if (!skill) return;
        if (!attachedSkills.some((selected) => selected.id === skill.id)) {
          attachedSkills.push(skill);
          renderContextChips();
        }
        closeAllPopovers();
      });
    });

    // History list
    historyList.innerHTML =
      sessions.length === 0
        ? '<p class="cp-muted" style="padding:8px">No saved sessions yet.</p>'
        : sessions
            .map(
              (s) => `
            <div class="cp-card-row" style="padding:4px 6px;">
              <button class="cp-menu-item" data-switch-session="${escapeHtml(s.id)}">
                <span>${escapeHtml(s.title)}</span>
                <span class="cp-muted">${s.messageCount} msgs</span>
              </button>
              <button class="cp-icon-btn" data-del-session="${escapeHtml(s.id)}" title="Delete">&times;</button>
            </div>
          `
            )
            .join('');

    historyList.querySelectorAll('button[data-switch-session]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'switchSession', sessionId: btn.dataset.switchSession });
        historyDrawer.classList.add('hidden');
        switchMainView('chat');
      });
    });
    historyList.querySelectorAll('button[data-del-session]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'deleteSession', sessionId: btn.dataset.delSession });
      });
    });
  }

  // Settings Tabs Renderer
  function renderSettingsTab() {
    if (!appState) return;
    const profile = appState.config.profile;
    const indexStatus = appState.indexStatus;

    document.querySelectorAll('.cp-nav-item[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === activeSettingsTab);
    });

    if (activeSettingsTab === 'models') {
      const renderRoleSelect = (role, label, shortcut, desc) => {
        const candidates = profile.models.filter((m) => m.roles.includes(role));
        const current = profile.roles[role] || '';
        const supportsTest = true;
        return `
          <div class="cp-card">
            <div class="cp-card-row">
              <div>
                <strong>${label}</strong> ${shortcut ? `<kbd>${shortcut}</kbd>` : ''}
                <div class="cp-muted">${desc}</div>
              </div>
              <button class="cp-icon-btn" data-add-role="${role}" title="Add ${label} Model">+</button>
            </div>
            <div class="cp-model-select-row">
              <select class="cp-select" data-role-select="${role}">
                <option value="">-- Setup ${label} model --</option>
                ${candidates
                  .map(
                    (m) => `<option value="${escapeHtml(m.id)}" ${m.id === current ? 'selected' : ''}>${escapeHtml(m.title)} (${escapeHtml(m.provider)})</option>`
                  )
                  .join('')}
              </select>
              ${
                supportsTest
                  ? `<button class="cp-ghost-btn" data-test-model-role="${role}">Test Model</button>`
                  : ''
              }
            </div>
            ${supportsTest ? `<div class="cp-model-test-result cp-muted" data-model-test-result="${role}" aria-live="polite"></div>` : ''}
          </div>
        `;
      };

      settingsContentEl.innerHTML = `
        <div class="cp-card-row" style="margin-bottom:10px;">
          <h2 class="cp-section-title" style="margin:0;">Models</h2>
          <button id="btn-new-model" class="cp-primary-btn">+ Add Model</button>
        </div>
        <div class="cp-card cp-muted">
          Chat, Plan, and Agent use the Chat model. Inline edits use the Edit model, falling back to Chat if Edit is unassigned. Assign a general-purpose instruct model to Chat and a code-focused model to Edit for separate routing.
        </div>
        ${renderRoleSelect('chat', 'Chat', 'Ctrl + L', 'Used in Chat, Plan, and Agent mode')}
        ${renderRoleSelect('autocomplete', 'Autocomplete', '', 'Used in inline code completions as you type')}
        ${renderRoleSelect('edit', 'Edit', 'Ctrl + I', 'Used to transform a selected section of code')}
        <details class="cp-card" open>
          <summary style="cursor:pointer; font-weight:600;">Additional model roles (Apply, Embed, Rerank)</summary>
          <div style="margin-top:10px;">
            ${renderRoleSelect('apply', 'Apply', '', 'Used to apply generated codeblocks to files')}
            ${renderRoleSelect('embed', 'Embed', '', 'Used to generate and query embeddings for @codebase and @docs')}
            ${renderRoleSelect('rerank', 'Rerank', '', 'Used to rerank retrieved context chunks')}
          </div>
        </details>
      `;

      document.getElementById('btn-new-model').addEventListener('click', () => openModelModal(null));
      settingsContentEl.querySelectorAll('select[data-role-select]').forEach((sel) => {
        sel.addEventListener('change', () => {
          vscode.postMessage({ type: 'setRoleModel', role: sel.dataset.roleSelect, modelId: sel.value });
        });
      });
      settingsContentEl.querySelectorAll('button[data-test-model-role]').forEach((btn) => {
        btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.textContent = 'Testing...';
          const result = settingsContentEl.querySelector(
            `[data-model-test-result="${btn.dataset.testModelRole}"]`
          );
          if (result) {
            result.className = 'cp-model-test-result cp-muted';
            result.textContent = 'Sending a test request without chat history...';
          }
          const role = btn.dataset.testModelRole;
          const select = settingsContentEl.querySelector(`select[data-role-select="${role}"]`);
          vscode.postMessage({ type: 'testModel', role, modelId: select ? select.value : '' });
        });
      });
      settingsContentEl.querySelectorAll('button[data-add-role]').forEach((btn) => {
        btn.addEventListener('click', () => openModelModal(null, btn.dataset.addRole));
      });
      settingsContentEl.querySelectorAll('button[data-edit-model]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const m = profile.models.find((x) => x.id === btn.dataset.editModel);
          if (m) openModelModal(m);
        });
      });
      settingsContentEl.querySelectorAll('button[data-del-model]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'deleteModel', modelId: btn.dataset.delModel });
        });
      });
    } else if (activeSettingsTab === 'configured-models') {
      settingsContentEl.innerHTML = `
        <div class="cp-card-row" style="margin-bottom:10px;">
          <h2 class="cp-section-title" style="margin:0;">Configured Models</h2>
          <button id="btn-new-configured-model" class="cp-primary-btn">+ Add Model</button>
        </div>
        <p class="cp-muted">Manage provider connections and API keys. Assign these models to roles from the Models section.</p>
        ${profile.models
          .map(
            (m) => `
          <div class="cp-card cp-card-row">
            <div style="flex:1; min-width:0;">
              <strong>${escapeHtml(m.title)}</strong>
              <div class="cp-muted">${escapeHtml(m.provider)} &middot; ${escapeHtml(m.model)}</div>
              <div class="cp-muted">${
                m.requiresApiKey
                  ? m.hasApiKey
                    ? `Key: ${escapeHtml(m.maskedApiKey)} <span class="cp-badge-secure">Encrypted</span>`
                    : '<span style="color:var(--danger)">API Key not set</span>'
                  : 'Local / No API key required'
              }</div>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <button class="cp-ghost-btn" data-edit-configured-model="${escapeHtml(m.id)}">Edit</button>
              <button class="cp-ghost-btn" data-del-configured-model="${escapeHtml(m.id)}">Delete</button>
            </div>
          </div>
        `
          )
          .join('')}
      `;

      document.getElementById('btn-new-configured-model').addEventListener('click', () => openModelModal(null));
      settingsContentEl.querySelectorAll('button[data-edit-configured-model]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const model = profile.models.find((candidate) => candidate.id === btn.dataset.editConfiguredModel);
          if (model) openModelModal(model);
        });
      });
      settingsContentEl.querySelectorAll('button[data-del-configured-model]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'deleteModel', modelId: btn.dataset.delConfiguredModel });
        });
      });
    } else if (activeSettingsTab === 'tools') {
      const enabledCount = profile.tools.filter((t) => t.permission !== 'excluded').length;
      settingsContentEl.innerHTML = `
        <div class="cp-card-row" style="margin-bottom:12px;">
          <div>
            <h2 class="cp-section-title" style="margin:0;">Built-in Tools <span class="cp-badge">${enabledCount}/${profile.tools.length}</span></h2>
          </div>
          <label class="cp-switch" title="Enable or disable all built-in tools">
            <input id="toggle-tools-master" type="checkbox" ${profile.toolsEnabled ? 'checked' : ''} />
            <span class="cp-slider"></span>
          </label>
        </div>
        ${profile.tools
          .map(
            (t) => `
          <div class="cp-card cp-card-row">
            <div style="flex:1;">
              <strong>${escapeHtml(t.name)}</strong>
              <div class="cp-muted">${escapeHtml(t.description)}</div>
            </div>
            <select class="cp-select" style="width:125px;" data-tool-perm="${escapeHtml(t.name)}">
              <option value="automatic" ${t.permission === 'automatic' ? 'selected' : ''}>Automatic</option>
              <option value="ask_first" ${t.permission === 'ask_first' ? 'selected' : ''}>Ask First</option>
              <option value="excluded" ${t.permission === 'excluded' ? 'selected' : ''}>Excluded</option>
            </select>
          </div>
        `
          )
          .join('')}
      `;

      document.getElementById('toggle-tools-master').addEventListener('change', (e) => {
        vscode.postMessage({ type: 'setToolsMasterEnabled', enabled: e.target.checked });
      });
      settingsContentEl.querySelectorAll('select[data-tool-perm]').forEach((sel) => {
        sel.addEventListener('change', () => {
          vscode.postMessage({ type: 'setToolPermission', toolName: sel.dataset.toolPerm, permission: sel.value });
        });
      });
    } else if (activeSettingsTab === 'indexing') {
      const docs = profile.indexing.docs || [];
      settingsContentEl.innerHTML = `
        <h2 class="cp-section-title">Indexing</h2>
        <div class="cp-card">
          <div class="cp-card-row">
            <div>
              <strong>Enable indexing</strong>
              <div class="cp-muted">Allows local indexing of your codebase for @codebase search and context understanding.</div>
            </div>
            <label class="cp-switch">
              <input id="toggle-indexing" type="checkbox" ${profile.indexing.enabled ? 'checked' : ''} />
              <span class="cp-slider"></span>
            </label>
          </div>
          <div class="cp-muted" style="margin-top:8px;">
            Note: Indexing runs locally using BM25 + optional embeddings without sending API keys anywhere.
          </div>
        </div>

        <h3 style="font-size:13px; margin:14px 0 8px;">@codebase index</h3>
        <div class="cp-card">
          <div class="cp-card-row">
            <span id="idx-status-msg">${escapeHtml(indexStatus.message)} (${indexStatus.fileCount} files, ${indexStatus.chunkCount} chunks)</span>
            <span>${indexStatus.state === 'complete' ? '&#10003;' : ''}</span>
          </div>
          <div class="cp-progress-track">
            <div id="idx-progress-bar" class="cp-progress-fill" style="width:${indexStatus.progress || 0}%"></div>
          </div>
          <button id="btn-reindex" class="cp-link-btn">Click to re-index</button>
        </div>

        <div class="cp-card-row" style="margin:14px 0 8px;">
          <h3 style="font-size:13px; margin:0;">Documentation</h3>
          <button id="btn-add-doc" class="cp-icon-btn" title="Add documentation source">+</button>
        </div>
        ${
          docs.length === 0
            ? `<div class="cp-card cp-muted">No documentation sources configured. Click the + button to add your first docs.</div>`
            : docs
                .map(
                  (d) => `
                <div class="cp-card cp-card-row">
                  <div>
                    <strong>${escapeHtml(d.title)}</strong>
                    <div class="cp-muted">${escapeHtml(d.url)} (${d.chunkCount || 0} chunks)</div>
                  </div>
                  <button class="cp-ghost-btn" data-del-doc="${escapeHtml(d.id)}">Remove</button>
                </div>
              `
                )
                .join('')
        }
      `;

      document.getElementById('toggle-indexing').addEventListener('change', (e) => {
        vscode.postMessage({ type: 'toggleIndexing', enabled: e.target.checked });
      });
      document.getElementById('btn-reindex').addEventListener('click', () => {
        vscode.postMessage({ type: 'reindexCodebase' });
      });
      document.getElementById('btn-add-doc').addEventListener('click', () => {
        formDoc.reset();
        modalDoc.classList.remove('hidden');
      });
      settingsContentEl.querySelectorAll('button[data-del-doc]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'removeDocSource', docId: btn.dataset.delDoc });
        });
      });
    } else if (activeSettingsTab === 'rules') {
      settingsContentEl.innerHTML = `
        <h2 class="cp-section-title">Rules</h2>
        <div class="cp-card">
          <form id="form-rule" class="cp-form">
            <input id="field-rule-name" class="cp-input" type="text" placeholder="Rule title (e.g., TypeScript Strictness)" required />
            <textarea id="field-rule-content" class="cp-input" rows="3" placeholder="Instruction injected into system prompt..." required></textarea>
            <button type="submit" class="cp-primary-btn" style="align-self:flex-end;">+ Add Rule</button>
          </form>
        </div>
        ${profile.rules
          .map(
            (r) => `
          <div class="cp-card">
            <div class="cp-card-row">
              <strong>${escapeHtml(r.name)}</strong>
              <div style="display:flex; gap:8px; align-items:center;">
                <label class="cp-switch">
                  <input type="checkbox" data-toggle-rule="${escapeHtml(r.id)}" ${r.enabled ? 'checked' : ''} />
                  <span class="cp-slider"></span>
                </label>
                <button class="cp-icon-btn" data-del-rule="${escapeHtml(r.id)}">&times;</button>
              </div>
            </div>
            <div class="cp-muted" style="margin-top:6px;">${escapeHtml(r.content)}</div>
          </div>
        `
          )
          .join('')}
      `;

      document.getElementById('form-rule').addEventListener('submit', (e) => {
        e.preventDefault();
        vscode.postMessage({
          type: 'saveRule',
          rule: {
            name: document.getElementById('field-rule-name').value,
            content: document.getElementById('field-rule-content').value,
            enabled: true
          }
        });
      });
      settingsContentEl.querySelectorAll('input[data-toggle-rule]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const rule = profile.rules.find((r) => r.id === cb.dataset.toggleRule);
          if (rule) {
            vscode.postMessage({ type: 'saveRule', rule: { ...rule, enabled: cb.checked } });
          }
        });
      });
      settingsContentEl.querySelectorAll('button[data-del-rule]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'deleteRule', ruleId: btn.dataset.delRule });
        });
      });
    } else if (activeSettingsTab === 'skills') {
      const skills = Array.isArray(profile.skills) ? profile.skills : [];
      settingsContentEl.innerHTML = `
        <h2 class="cp-section-title">Skills</h2>
        <p class="cp-muted">Skills are reusable task instructions. Select one in chat or let an enabled skill activate automatically when its trigger phrases match your request.</p>
        <div class="cp-card">
          <form id="form-skill" class="cp-form">
            <input id="field-skill-id" type="hidden" />
            <input id="field-skill-name" class="cp-input" type="text" placeholder="Skill name (e.g., Code Review)" required />
            <input id="field-skill-description" class="cp-input" type="text" placeholder="Short description" />
            <input id="field-skill-trigger" class="cp-input" type="text" placeholder="Trigger phrases (comma-separated: review, inspect code)" />
            <textarea id="field-skill-instructions" class="cp-input" rows="5" placeholder="Instructions for the model when this skill is active..." required></textarea>
            <button type="submit" class="cp-primary-btn" style="align-self:flex-end;">+ Add Skill</button>
          </form>
        </div>
        ${skills
          .map(
            (skill) => `
          <div class="cp-card">
            <div class="cp-card-row">
              <div>
                <strong>&#9889; ${escapeHtml(skill.name)}</strong>
                ${skill.description ? `<div class="cp-muted">${escapeHtml(skill.description)}</div>` : ''}
              </div>
              <div style="display:flex; gap:8px; align-items:center;">
                <label class="cp-switch" title="Enable Skill">
                  <input type="checkbox" data-toggle-skill="${escapeHtml(skill.id)}" ${skill.enabled ? 'checked' : ''} />
                  <span class="cp-slider"></span>
                </label>
                <button class="cp-ghost-btn" data-edit-skill="${escapeHtml(skill.id)}">Edit</button>
                <button class="cp-icon-btn" data-del-skill="${escapeHtml(skill.id)}" title="Delete Skill">&times;</button>
              </div>
            </div>
            ${skill.trigger ? `<div class="cp-muted" style="margin-top:6px;">Triggers: ${escapeHtml(skill.trigger)}</div>` : ''}
            <div class="cp-muted" style="margin-top:6px; white-space:pre-wrap;">${escapeHtml(skill.instructions)}</div>
          </div>
        `
          )
          .join('')}
      `;

      document.getElementById('form-skill').addEventListener('submit', (e) => {
        e.preventDefault();
        const skillId = document.getElementById('field-skill-id').value;
        const existingSkill = skillId
          ? skills.find((candidate) => candidate.id === skillId)
          : null;
        vscode.postMessage({
          type: 'saveSkill',
          skill: {
            id: skillId || undefined,
            name: document.getElementById('field-skill-name').value,
            description: document.getElementById('field-skill-description').value,
            trigger: document.getElementById('field-skill-trigger').value,
            instructions: document.getElementById('field-skill-instructions').value,
            enabled: existingSkill ? existingSkill.enabled !== false : true
          }
        });
      });
      settingsContentEl.querySelectorAll('input[data-toggle-skill]').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          const skill = skills.find((candidate) => candidate.id === checkbox.dataset.toggleSkill);
          if (skill) {
            vscode.postMessage({
              type: 'saveSkill',
              skill: { ...skill, enabled: checkbox.checked }
            });
          }
        });
      });
      settingsContentEl.querySelectorAll('button[data-del-skill]').forEach((button) => {
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'deleteSkill', skillId: button.dataset.delSkill });
        });
      });
      settingsContentEl.querySelectorAll('button[data-edit-skill]').forEach((button) => {
        button.addEventListener('click', () => {
          const skill = skills.find((candidate) => candidate.id === button.dataset.editSkill);
          if (!skill) return;
          document.getElementById('field-skill-id').value = skill.id;
          document.getElementById('field-skill-name').value = skill.name;
          document.getElementById('field-skill-description').value = skill.description || '';
          document.getElementById('field-skill-trigger').value = skill.trigger || '';
          document.getElementById('field-skill-instructions').value = skill.instructions || '';
          document.getElementById('field-skill-name').focus();
        });
      });
    } else if (activeSettingsTab === 'settings') {
      const s = profile.settings;
      const profiles = appState.config.profiles || [];
      settingsContentEl.innerHTML = `
        <h2 class="cp-section-title">General Settings</h2>
        <h3 style="font-size:13px; margin:14px 0 8px;">Configuration Profiles</h3>
        ${profiles
          .map((configProfile) => `
            <div class="cp-card cp-card-row">
              <div>
                <strong>${escapeHtml(configProfile.name)}</strong>
                ${configProfile.isActive ? '<span class="cp-badge" style="margin-left:6px;">Active</span>' : ''}
                <div class="cp-muted">${configProfile.modelCount} configured models</div>
              </div>
              <div style="display:flex; gap:6px;">
                ${configProfile.isActive ? '' : `<button class="cp-ghost-btn" data-use-config-profile="${escapeHtml(configProfile.id)}">Use</button>`}
                ${profiles.length > 1 ? `<button class="cp-ghost-btn" data-delete-config-profile="${escapeHtml(configProfile.id)}">Delete</button>` : ''}
              </div>
            </div>
          `)
          .join('')}
        <div class="cp-card cp-card-row">
          <div>
            <strong>Inline Autocomplete</strong>
            <div class="cp-muted">Show ghost-text suggestions while typing when an Autocomplete model is set.</div>
          </div>
          <label class="cp-switch">
            <input id="set-ac-enabled" type="checkbox" ${s.autocompleteEnabled ? 'checked' : ''} />
            <span class="cp-slider"></span>
          </label>
        </div>
        <div class="cp-card cp-card-row">
          <div>
            <strong>Stream Responses</strong>
            <div class="cp-muted">Display tokens live as they arrive from the model.</div>
          </div>
          <label class="cp-switch">
            <input id="set-stream" type="checkbox" ${s.streamResponses ? 'checked' : ''} />
            <span class="cp-slider"></span>
          </label>
        </div>
        <div class="cp-card">
          <strong>Security Guarantee</strong>
          <p class="cp-muted">All API keys are stored exclusively in VS Code's encrypted <code>SecretStorage</code> and are never written to plain-text JSON files.</p>
        </div>
      `;

      const saveSettings = () => {
        vscode.postMessage({
          type: 'updateGeneralSettings',
          settings: {
            autocompleteEnabled: document.getElementById('set-ac-enabled').checked,
            streamResponses: document.getElementById('set-stream').checked
          }
        });
      };
      document.getElementById('set-ac-enabled').addEventListener('change', saveSettings);
      document.getElementById('set-stream').addEventListener('change', saveSettings);
      settingsContentEl.querySelectorAll('button[data-use-config-profile]').forEach((button) => {
        button.addEventListener('click', () => {
          vscode.postMessage({
            type: 'setActiveProfile',
            profileId: button.dataset.useConfigProfile
          });
        });
      });
      settingsContentEl.querySelectorAll('button[data-delete-config-profile]').forEach((button) => {
        button.addEventListener('click', () => {
          vscode.postMessage({
            type: 'deleteProfile',
            profileId: button.dataset.deleteConfigProfile
          });
        });
      });
    } else if (activeSettingsTab === 'help') {
      settingsContentEl.innerHTML = `
        <h2 class="cp-section-title">Help & Shortcuts</h2>
        <div class="cp-card">
          <p><kbd>Ctrl+L</kbd> &mdash; Focus CodePilot Coder & attach selected code</p>
          <p><kbd>Ctrl+I</kbd> &mdash; Inline Edit selected code</p>
          <p><kbd>Ctrl+.</kbd> &mdash; Cycle Mode (Chat / Plan / Agent)</p>
          <p><kbd>Ctrl+'</kbd> &mdash; Toggle Chat Model</p>
          <p><kbd>Ctrl+Enter</kbd> &mdash; Send message with Active File context</p>
          <p><kbd>@</kbd> &mdash; Attach Files, Code, Git Diff, Problems, @codebase, or @docs</p>
        </div>
      `;
    }
  }

  // Model Modal
  let modelCatalogRequestId = 0;
  let modelModalProvider = 'openai';
  let modelModalExisting = null;
  let modelModalDefaultRole = 'chat';
  const modelCatalogSelect = document.getElementById('model-catalog-select');
  const modelCatalogStatus = document.getElementById('model-catalog-status');
  const loadModelsButton = document.getElementById('btn-load-models');

  function invalidateModelCatalog() {
    modelCatalogRequestId++;
    modelCatalogSelect.innerHTML = '';
    modelCatalogSelect.classList.add('hidden');
    loadModelsButton.disabled = false;
    loadModelsButton.textContent = 'Load Models';
  }

  function updateModelCatalogHint(provider) {
    modelCatalogStatus.textContent = provider === 'anthropic'
      ? 'Load available Claude models to auto-select the newest active model when this field is empty. You can also choose another model or enter any model ID.'
      : 'Load the provider catalog to choose a model, or enter any model ID manually.';
  }

  function updateModelIdPlaceholder(provider) {
    const slugInput = document.getElementById('field-model-slug');
    if (provider === 'voyage') {
      slugInput.placeholder = 'e.g., rerank-2.5 or rerank-2';
    } else if (provider === 'cohere') {
      slugInput.placeholder = 'e.g., rerank-v3.5';
    } else if (provider === 'jina') {
      slugInput.placeholder = 'e.g., jina-reranker-v3';
    } else if (provider === 'anthropic') {
      slugInput.placeholder = 'Auto-select a Claude model or enter its model ID';
    } else {
      slugInput.placeholder = 'Enter a model ID';
    }
  }

  function updateModelOptionFields(provider) {
    const temperatureInput = document.getElementById('field-model-temperature');
    temperatureInput.max = provider === 'anthropic' ? '1' : '2';
    document.getElementById('field-penalty-options').classList.toggle('hidden', provider === 'anthropic');
    document.getElementById('field-ollama-options').classList.toggle('hidden', provider !== 'ollama');
  }

  function openModelModal(existing, defaultRole = 'chat') {
    document.getElementById('modal-model-title').textContent = existing ? 'Edit Model' : 'Add Model';
    document.getElementById('field-model-id').value = existing?.id || '';
    const provider = existing?.provider || 'openai';
    modelModalProvider = provider;
    modelModalExisting = existing;
    modelModalDefaultRole = defaultRole;
    invalidateModelCatalog();
    updateModelCatalogHint(provider);
    updateModelIdPlaceholder(provider);
    document.getElementById('field-model-title').value = existing?.title || '';
    document.getElementById('field-model-provider').value = provider;
    document.getElementById('field-model-slug').value = existing?.model || '';
    document.getElementById('field-model-base').value =
      existing?.apiBase || PROVIDER_DEFAULTS[provider]?.base || PROVIDER_DEFAULTS.openai.base;
    document.getElementById('field-model-apikey').value = '';
    const generation = existing?.completionOptions || {};
    document.getElementById('field-model-temperature').value = generation.temperature ?? '';
    document.getElementById('field-model-max-tokens').value = generation.maxTokens ?? '';
    document.getElementById('field-model-top-p').value = generation.topP ?? '';
    document.getElementById('field-model-frequency-penalty').value = generation.frequencyPenalty ?? '';
    document.getElementById('field-model-presence-penalty').value = generation.presencePenalty ?? '';
    document.getElementById('field-model-context-length').value = generation.contextLength ?? '';
    document.getElementById('field-model-top-k').value = generation.topK ?? '';
    document.getElementById('field-model-repeat-penalty').value = generation.repeatPenalty ?? '';
    updateModelOptionFields(provider);
    document.getElementById('secret-status-hint').textContent = existing?.hasApiKey
      ? `Current key stored securely (${existing.maskedApiKey}). Leave blank to keep it.`
      : 'Stored privately in OS keychain (SecretStorage) — never saved in plain text.';

    const roles = existing?.roles || [defaultRole];
    formModel.querySelectorAll('input[name="role"]').forEach((cb) => {
      cb.checked = roles.includes(cb.value);
    });
    modalModel.classList.remove('hidden');
  }

  document.getElementById('field-model-provider').addEventListener('change', (e) => {
    const provider = e.target.value;
    if (provider !== modelModalProvider) {
      document.getElementById('field-model-slug').value = '';
      document.getElementById('field-model-apikey').value = '';
      invalidateModelCatalog();
      if (modelModalExisting && provider !== modelModalExisting.provider) {
        document.getElementById('secret-status-hint').textContent =
          'Provider changed. Enter an API key for the new provider; the previous provider key will not be reused.';
      } else {
        document.getElementById('secret-status-hint').textContent = modelModalExisting?.hasApiKey
          ? `Current key stored securely (${modelModalExisting.maskedApiKey}). Leave blank to keep it.`
          : 'Stored privately in OS keychain (SecretStorage) — never saved in plain text.';
      }
    }
    modelModalProvider = provider;
    updateModelCatalogHint(provider);
    updateModelIdPlaceholder(provider);
    const def = PROVIDER_DEFAULTS[provider];
    if (def) {
      document.getElementById('field-model-base').value = def.base;
    }
    updateModelOptionFields(provider);
  });

  modelCatalogSelect.addEventListener('change', () => {
    if (modelCatalogSelect.value) {
      document.getElementById('field-model-slug').value = modelCatalogSelect.value;
    }
  });
  document.getElementById('field-model-slug').addEventListener('input', () => {
    if (modelCatalogSelect.value !== document.getElementById('field-model-slug').value) {
      modelCatalogSelect.value = '';
    }
  });

  loadModelsButton.addEventListener('click', () => {
    const provider = document.getElementById('field-model-provider').value;
    const apiKey = document.getElementById('field-model-apikey').value;
    const existingId = document.getElementById('field-model-id').value;
    const hasStoredKey = modelModalExisting?.id === existingId &&
      modelModalExisting.provider === provider &&
      modelModalExisting.hasApiKey;
    if (PROVIDER_DEFAULTS[provider]?.needsKey !== false && !apiKey.trim() && !hasStoredKey) {
      modelCatalogStatus.textContent = 'Enter an API key for this provider before loading its model catalog.';
      document.getElementById('field-model-apikey').focus();
      return;
    }

    const requestId = ++modelCatalogRequestId;
    loadModelsButton.disabled = true;
    loadModelsButton.textContent = 'Loading...';
    modelCatalogStatus.textContent = 'Loading available models...';
    vscode.postMessage({
      type: 'listModels',
      requestId,
      provider,
      apiBase: document.getElementById('field-model-base').value.trim(),
      apiKey,
      modelId: existingId,
      role: Array.from(formModel.querySelectorAll('input[name="role"]:checked'))[0]?.value || modelModalDefaultRole
    });
  });

  document.getElementById('btn-toggle-key-vis').addEventListener('click', (e) => {
    const input = document.getElementById('field-model-apikey');
    const isPwd = input.type === 'password';
    input.type = isPwd ? 'text' : 'password';
    e.target.textContent = isPwd ? 'Hide' : 'Show';
  });

  const closeModelModal = () => {
    invalidateModelCatalog();
    modalModel.classList.add('hidden');
  };
  document.getElementById('btn-close-model-modal').addEventListener('click', closeModelModal);
  document.getElementById('btn-cancel-model').addEventListener('click', closeModelModal);

  formModel.addEventListener('submit', (e) => {
    e.preventDefault();
    const provider = document.getElementById('field-model-provider').value;
    const roles = Array.from(formModel.querySelectorAll('input[name="role"]:checked')).map((c) => c.value);
    const readOptionalNumber = (id) => {
      const value = document.getElementById(id).value.trim();
      return value === '' ? undefined : Number(value);
    };
    const model = {
      id: document.getElementById('field-model-id').value || undefined,
      title: document.getElementById('field-model-title').value.trim(),
      provider,
      model: document.getElementById('field-model-slug').value.trim(),
      apiBase: document.getElementById('field-model-base').value.trim(),
      requiresApiKey: PROVIDER_DEFAULTS[provider]?.needsKey !== false,
      roles: roles.length > 0 ? roles : ['chat'],
      completionOptions: {
        temperature: readOptionalNumber('field-model-temperature'),
        maxTokens: readOptionalNumber('field-model-max-tokens'),
        topP: readOptionalNumber('field-model-top-p'),
        frequencyPenalty: readOptionalNumber('field-model-frequency-penalty'),
        presencePenalty: readOptionalNumber('field-model-presence-penalty'),
        contextLength: provider === 'ollama' ? readOptionalNumber('field-model-context-length') : undefined,
        topK: provider === 'ollama' ? readOptionalNumber('field-model-top-k') : undefined,
        repeatPenalty: provider === 'ollama' ? readOptionalNumber('field-model-repeat-penalty') : undefined
      }
    };
    const apiKey = document.getElementById('field-model-apikey').value;
    vscode.postMessage({ type: 'saveModel', model, apiKey });
    closeModelModal();
  });

  // Doc Modal
  document.getElementById('btn-close-doc-modal').addEventListener('click', () => modalDoc.classList.add('hidden'));
  document.getElementById('btn-cancel-doc').addEventListener('click', () => modalDoc.classList.add('hidden'));
  formDoc.addEventListener('submit', (e) => {
    e.preventDefault();
    vscode.postMessage({
      type: 'addDocSource',
      title: document.getElementById('field-doc-title').value,
      url: document.getElementById('field-doc-url').value
    });
    modalDoc.classList.add('hidden');
  });

  // Extension Host Messages
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'stateUpdate':
        appState = msg.state;
        renderTopControls();
        renderMessages();
        if (viewSettings.classList.contains('active')) renderSettingsTab();
        break;

      case 'modelTestResult': {
        const result = Array.from(settingsContentEl.querySelectorAll('[data-model-test-result]'))
          .find((el) => el.dataset.modelTestResult === msg.role);
        const button = Array.from(settingsContentEl.querySelectorAll('button[data-test-model-role]'))
          .find((el) => el.dataset.testModelRole === msg.role);
        if (button) {
          button.disabled = false;
          button.textContent = 'Test Model';
        }
        if (result) {
          const status = !msg.success
            ? 'error'
            : msg.matched
              ? 'success'
              : 'warning';
          result.className = `cp-model-test-result cp-model-test-${status}`;
          result.textContent = !msg.success
            ? `Test failed: ${msg.error || 'The model request failed.'}`
            : `${msg.modelTitle || 'Model'} responded${msg.matched ? ' and followed the test prompt.' : ', but did not follow the test prompt.'}${msg.response ? `\nResponse: ${msg.response}` : ''}`;
        }
        break;
      }

      case 'modelsListed': {
        if (
          msg.requestId !== modelCatalogRequestId ||
          modalModel.classList.contains('hidden') ||
          msg.provider !== document.getElementById('field-model-provider').value
        ) {
          break;
        }
        loadModelsButton.disabled = false;
        loadModelsButton.textContent = 'Load Models';
        if (msg.error) {
          modelCatalogStatus.textContent = `${msg.error} You can still enter a model ID manually.`;
          break;
        }

        const models = Array.isArray(msg.models) ? msg.models : [];
        modelCatalogSelect.innerHTML = '<option value="">Choose a model from the loaded catalog...</option>' +
          models
            .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label || model.id)}</option>`)
            .join('');
        const modelInput = document.getElementById('field-model-slug');
        if (models.length === 0) {
          modelCatalogSelect.classList.add('hidden');
          modelCatalogStatus.textContent = 'No models were returned. Enter a model ID manually.';
        } else {
          modelCatalogSelect.classList.remove('hidden');
          if (msg.provider === 'anthropic' && !modelInput.value.trim()) {
            modelInput.value = models[0].id;
            modelCatalogSelect.value = models[0].id;
            modelCatalogStatus.textContent =
              `Auto-selected newest active Claude model: ${models[0].label || models[0].id}. Choose another from the list or enter any model ID.`;
          } else {
            modelCatalogStatus.textContent =
              `${models.length} model${models.length === 1 ? '' : 's'} loaded. Choose one from the list or enter any model ID.`;
          }
        }
        break;
      }

      case 'sessionMessageAdded':
        if (upsertActiveSessionMessage(msg.sessionId, msg.message)) renderMessages();
        break;

      case 'streamStart': {
        isStreaming = true;
        streamingMsgId = msg.messageId;
        streamingSessionId = msg.sessionId;
        streamingModelTitle = msg.modelTitle || 'CodePilot Coder';
        streamingText = '';
        document.getElementById('btn-send').classList.add('hidden');
        document.getElementById('btn-stop').classList.remove('hidden');
        renderMessages();
        break;
      }

      case 'streamChunk': {
        if (msg.messageId === streamingMsgId) {
          streamingText += msg.chunk;
          if (appState?.activeSession?.id === streamingSessionId) {
            const el = chatMessagesEl.querySelector(`[data-msg-id="${streamingMsgId}"] .cp-msg-body`);
            if (el) {
              el.innerHTML = renderMarkdown(streamingText);
              bindCodeButtons(el);
              chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
            }
          }
        }
        break;
      }

      case 'streamEnd': {
        const endedMessageId = msg.messageId || msg.message?.id;
        const sessionId = msg.sessionId ||
          (endedMessageId === streamingMsgId ? streamingSessionId : null);
        const isCurrentStream = endedMessageId === streamingMsgId;
        if (isCurrentStream) {
          isStreaming = false;
          streamingMsgId = null;
          streamingSessionId = null;
          streamingModelTitle = '';
          streamingText = '';
          document.getElementById('btn-stop').classList.add('hidden');
          document.getElementById('btn-send').classList.remove('hidden');
        }
        const updatedActiveSession = msg.message && upsertActiveSessionMessage(sessionId, msg.message);
        if (isCurrentStream || updatedActiveSession) renderMessages();
        if (msg.aborted) showToast('Generation stopped.');
        if (msg.error) showErrorToast(msg.error);
        break;
      }

      case 'assistantError': {
        const failedMessageId = msg.messageId || streamingMsgId;
        if (failedMessageId && failedMessageId === streamingMsgId) {
          isStreaming = false;
          streamingMsgId = null;
          streamingSessionId = null;
          streamingModelTitle = '';
          streamingText = '';
          document.getElementById('btn-stop').classList.add('hidden');
          document.getElementById('btn-send').classList.remove('hidden');
          renderMessages();
        } else if (failedMessageId && appState?.activeSession?.id === msg.sessionId) {
          chatMessagesEl.querySelector(`[data-msg-id="${failedMessageId}"]`)?.remove();
        }
        showErrorToast(msg.error);
        break;
      }

      case 'toolApprovalRequest': {
        const container = chatMessagesEl.querySelector(`[data-msg-id="${msg.messageId}"]`);
        if (container) {
          const card = document.createElement('div');
          card.className = 'cp-approval-card';
          card.dataset.approvalId = msg.approvalId;
          card.innerHTML = `
            <div><strong>Tool Permission Required:</strong> <code>${escapeHtml(msg.toolName)}</code></div>
            <pre class="cp-muted" style="margin:6px 0; overflow-x:auto;">${escapeHtml(JSON.stringify(msg.arguments, null, 2))}</pre>
            <div class="cp-approval-actions">
              <button class="cp-primary-btn" data-approve="true">Allow</button>
              <button class="cp-danger-btn" data-approve="false">Deny</button>
            </div>
          `;
          card.querySelectorAll('button').forEach((btn) => {
            btn.addEventListener('click', () => {
              const approved = btn.dataset.approve === 'true';
              vscode.postMessage({ type: 'toolApprovalResponse', approvalId: msg.approvalId, approved });
              card.innerHTML = `<span class="cp-muted">${approved ? 'Allowed' : 'Denied'} <code>${escapeHtml(msg.toolName)}</code></span>`;
            });
          });
          container.appendChild(card);
          chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        }
        break;
      }

      case 'toolApprovalCancelled': {
        const card = Array.from(chatMessagesEl.querySelectorAll('.cp-approval-card'))
          .find((item) => item.dataset.approvalId === msg.approvalId);
        if (card) card.innerHTML = '<span class="cp-muted">Cancelled</span>';
        break;
      }

      case 'toolResultNotice': {
        const container = chatMessagesEl.querySelector(`[data-msg-id="${msg.messageId}"]`);
        if (container) {
          const note = document.createElement('div');
          note.className = 'cp-muted';
          note.style.marginTop = '4px';
          note.textContent = `Tool ${msg.toolName}: ${msg.approved ? 'executed' : 'denied'}`;
          container.appendChild(note);
        }
        break;
      }

      case 'contextProviderResults': {
        if (
          menuContext.classList.contains('hidden') ||
          msg.requestId !== contextSearchRequestId ||
          msg.providerId !== activeSearchProvider
        ) {
          break;
        }
        const items = msg.items || [];
        contextMenuList.innerHTML =
          msg.error
            ? `<div class="cp-muted" style="padding:8px;">${escapeHtml(msg.error)}</div>`
            : items.length === 0
              ? '<div class="cp-muted" style="padding:8px;">No matching items found.</div>'
            : items
                .map(
                  (it) => `
                <button class="cp-menu-item" data-pick-item="${escapeHtml(it.id)}" data-pick-label="${escapeHtml(it.label)}">
                  <span>${escapeHtml(it.label)}</span>
                  <span class="cp-muted">${escapeHtml(it.description || '')}</span>
                </button>
              `
                )
                .join('');

        contextMenuList.querySelectorAll('button[data-pick-item]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            clearContextTrigger();
            addAttachment({
              provider: msg.providerId,
              itemId: btn.dataset.pickItem,
              label: btn.dataset.pickLabel
            });
            closeContextMenu();
          });
        });
        break;
      }

      case 'indexProgress': {
        if (appState) appState.indexStatus = msg.status;
        const bar = document.getElementById('idx-progress-bar');
        const label = document.getElementById('idx-status-msg');
        if (bar) bar.style.width = `${msg.status.progress || 0}%`;
        if (label) {
          label.textContent = `${msg.status.message} (${msg.status.fileCount} files, ${msg.status.chunkCount} chunks)`;
        }
        break;
      }

      case 'navigateSettings':
        activeSettingsTab = msg.tab || 'models';
        switchMainView('settings');
        break;

      case 'prefillSelection': {
        switchMainView('chat');
        const sel = msg.selection;
        if (sel) {
          addAttachment({ provider: 'current_file', label: `${sel.fileName.split(/[\\/]/).pop()}:${sel.lineRange}` });
          chatInput.focus();
        }
        break;
      }

      case 'errorToast':
        showErrorToast(msg.message);
        break;
    }
  });

  // Notify host ready
  vscode.postMessage({ type: 'ready' });
})();
