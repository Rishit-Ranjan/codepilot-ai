# CodePilot Coder

CodePilot Coder is a privacy-first AI coding assistant for Visual Studio Code. It combines workspace-aware chat, planning, agent tools, inline editing, and code autocomplete in a single sidebar.

Built with JavaScript and the VS Code Extension API, it supports local Ollama models and popular cloud providers while keeping API keys in VS Code `SecretStorage`.

## Features

- **Chat, Plan, and Agent modes** for conversational help, read-only planning, and tool-assisted work
- **Multi-role model configuration** for Chat, Autocomplete, Edit, Apply, Embed, and Rerank tasks
- **Local and cloud model providers**, including Ollama, OpenAI, Anthropic, Gemini, OpenRouter, and OpenAI-compatible endpoints
- **Context attachments** through `@`:
  - Files
  - Workspace symbols and code
  - Folders
  - Active editor file
  - Git diff
  - Terminal context
  - Workspace problems
  - Rules
  - Indexed codebase
  - Indexed documentation
- **Local codebase indexing** with `.gitignore` support, symbol extraction, BM25 search, and optional embeddings
- **Documentation indexing** for local Markdown/text files and URLs
- **Reusable skills** with custom instructions and trigger phrases
- **Workspace rules** injected into model prompts
- **Configuration profiles** for separating model, rule, skill, and tool settings
- **Built-in agent tools** with configurable `Automatic`, `Ask First`, and `Excluded` permissions
- **Inline editing** for selected code
- **Inline autocomplete** for ghost-text suggestions
- **Code block actions** for copying, editing, and applying generated code
- **Chat sessions** with workspace-local history
- **Secure API-key storage** using VS Code `SecretStorage`

## Requirements

- Visual Studio Code 1.85.0 or later
- A model provider:
  - An API key for a supported cloud provider
  - Or Ollama running locally
- Internet access for cloud models
- A workspace folder for codebase, file, folder, Git, terminal, and diagnostics context

## Installation

### Install a packaged release

1. Download the latest `.vsix` release.
2. Open VS Code.
3. Open **Extensions**.
4. Open the Extensions menu and select **Install from VSIX...**.
5. Choose the downloaded `.vsix` file.
6. Reload VS Code (if prompted).

### Run from source

```powershell
git clone https://github.com/Rishit-Ranjan/codepilot-ai.git
cd codepilot-ai
npm install
```

Open the project folder in VS Code, then press `F5` to launch an Extension Development Host.

## Quick Start

1. Open the **CodePilot Coder** icon in the Activity Bar.
2. Select a mode: **Chat**, **Plan**, or **Agent**.
3. Select or configure a chat model.
4. Enter a prompt.
5. Press `Enter` to send, or `Shift+Enter` to insert a new line.

To include workspace context, type `@` in the composer or use the **@** button. Select context sources and start another request.

To attach the active editor file without opening the context menu, use **Active file** or press `Ctrl+Enter`.

## Configure Models

Open **Models** in the sidebar settings. CodePilot Coder supports separate model roles:

| Role         | Purpose                                           |
| ------------ | ------------------------------------------------- |
| Chat         | Chat, Plan, and normal Agent responses            |
| Autocomplete | Inline ghost-text suggestions                     |
| Edit         | Inline transformations and code edits             |
| Apply        | Merging generated code into the active file       |
| Embed        | Generating codebase and documentation embeddings  |
| Rerank       | Ranking codebase and documentation search results |

Supported provider types include:

- Ollama
- OpenAI
- Anthropic
- Google Gemini
- OpenRouter
- Voyage AI
- Cohere
- Jina AI
- Custom OpenAI-compatible endpoints

API keys are saved using VS Code `SecretStorage`. They are not stored in `settings.json` or workspace configuration files.

Each model can have provider-specific generation settings, such as temperature, maximum output tokens, top-p, penalties, or context length.

Use **Test Model** in the Models settings to verify a role before using it.

### Ollama

Install and start Ollama, then download a chat model:

```powershell
ollama pull llama3.1:8b
ollama run llama3.1:8b
```

Configure the Ollama model with:

- API Base URL: `http://localhost:11434/v1`
- Model: `llama3.1:8b`

The default configuration also includes a local `nomic-embed-text` embedding model. Install it if codebase embeddings are enabled:

```powershell
ollama pull nomic-embed-text
```

## Modes

### Chat

Use Chat for direct questions and conversational coding assistance.

### Plan

Use Plan for implementation planning and analysis. This mode is intended to avoid workspace modifications.

### Agent

Use Agent for tasks that may need workspace tools. Tool permissions determine whether CodePilot Coder runs actions automatically, asks for approval, or excludes a tool.

## Context and Search

The composer supports:

- `@Files`
- `@Code`
- `@Folder`
- `@Current File`
- `@Git Diff`
- `@Terminal`
- `@Problems`
- `@Rules`
- `@Codebase`
- `@Docs`

For `@Codebase` and `@Docs`, run the index operation from settings or use the re-index command. The indexer respects workspace ignore rules and stores generated index data in extension storage.

## Rules, Skills, and Profiles

### Rules

Rules are persistent instructions for the active configuration profile. They can define coding style, language preferences, test conventions, or project-specific constraints.

### Skills

Skills are reusable instruction modules with optional trigger phrases. A matching skill can be activated automatically from a prompt, or selected manually in the composer.

### Profiles

Profiles isolate configuration such as:

- Model assignments
- Model generation options
- Rules
- Skills
- Tool permissions

Create or switch profiles from General settings.

## Agent Tools

Agent tools can read and search workspace files, create or edit files, inspect problems, and run terminal commands. Tool availability is controlled by permissions:

- **Automatic**: run without prompting
- **Ask First**: request approval in chat
- **Excluded**: do not make the tool available

Review tool calls and use ask-first permissions when working in unfamiliar repositories.

## Commands and Shortcuts

| Action                      | Windows/Linux   | macOS           |
| --------------------------- | --------------- | --------------- |
| Focus chat / send selection | `Ctrl+L`      | `Cmd+L`       |
| Inline edit selection       | `Ctrl+I`      | `Cmd+I`       |
| Cycle Chat / Plan / Agent   | `Ctrl+.`      | `Cmd+.`       |
| Toggle chat model           | `Ctrl+'`      | `Cmd+'`       |
| Send prompt                 | `Enter`       | `Enter`       |
| Insert newline              | `Shift+Enter` | `Shift+Enter` |
| Send with active file       | `Ctrl+Enter`  | `Cmd+Enter`   |

Additional commands are available from the VS Code Command Palette:

- `CodePilot Coder: New Chat Session`
- `CodePilot Coder: Re-index Codebase`
- `CodePilot Coder: Open Settings`

## Privacy and Storage

CodePilot Coder does not require API keys to be placed in source files or workspace settings.

- API keys are stored in VS Code `SecretStorage`
- Chat sessions are stored through VS Code workspace state
- Configuration profiles and settings use VS Code global/workspace state
- Codebase index data is stored in extension storage
- Requests to cloud providers are sent directly to the configured provider endpoint

Review provider privacy terms before sending proprietary or sensitive code to cloud models.

## Development

Run the verification suite:

```powershell
npm test
```

Package the extension:

```powershell
npx vsce package
```

## Repository

- GitHub: https://github.com/Rishit-Ranjan/codepilot-ai
- Marketplace publisher: `codepilot-ai`

## License

This project is licensed under the [Apache License 2.0](./LICENSE).
