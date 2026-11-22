'use strict';

const SESSIONS_KEY = 'codepilot.sessions.v1';
const MAX_SESSIONS = 40;

class SessionManager {
  /**
   * @param {import('vscode').Memento} workspaceState
   */
  constructor(workspaceState) {
    this._state = workspaceState;
    this._sessions = this._load();
    this._activeSessionId = this._sessions[0]?.id || null;
  }

  _load() {
    const saved = this._state.get(SESSIONS_KEY);
    return Array.isArray(saved) ? saved : [];
  }

  async _save() {
    if (this._sessions.length > MAX_SESSIONS) {
      this._sessions = this._sessions.slice(0, MAX_SESSIONS);
    }
    await this._state.update(SESSIONS_KEY, this._sessions);
  }

  createSession(title = 'New Session') {
    const session = {
      id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    this._sessions.unshift(session);
    this._activeSessionId = session.id;
    this._save();
    return session;
  }

  getActiveSession() {
    if (!this._activeSessionId) {
      return this.createSession();
    }
    const found = this._sessions.find((s) => s.id === this._activeSessionId);
    return found || this.createSession();
  }

  getLastNonEmptySession() {
    return this._sessions.find(
      (s) => s.id !== this._activeSessionId && s.messages && s.messages.length > 0
    ) || this._sessions.find((s) => s.messages && s.messages.length > 0) || null;
  }

  async switchSession(sessionId) {
    const found = this._sessions.find((s) => s.id === sessionId);
    if (!found) return null;
    this._activeSessionId = found.id;
    return found;
  }

  async appendMessage(sessionId, message) {
    const session = this._sessions.find((s) => s.id === sessionId);
    if (!session) return;
    session.messages.push(message);
    session.updatedAt = Date.now();
    if (
      session.title === 'New Session' &&
      message.role === 'user' &&
      typeof message.content === 'string'
    ) {
      session.title = message.content.trim().slice(0, 48) || 'New Session';
    }
    await this._save();
  }

  async deleteSession(sessionId) {
    this._sessions = this._sessions.filter((s) => s.id !== sessionId);
    if (this._activeSessionId === sessionId) {
      this._activeSessionId = this._sessions[0]?.id || null;
    }
    await this._save();
  }

  listSessions() {
    return this._sessions
      .filter((s) => Array.isArray(s.messages) && s.messages.length > 0)
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length
      }));
  }
}

export { SessionManager };
