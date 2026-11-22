# CodePilot AI

**CodePilot AI** is  privacy-first AI coding assistant for Visual Studio Code built in pure JavaScript.

## Key Features

- **Encrypted API Key Storage (`SecretStorage`)**: API keys are stored exclusively in VS Code's OS-backed `SecretStorage` (`context.secrets`), never in plain-text config files or `settings.json`.
- **Local Codebase & Docs Indexing (`@codebase` / `@docs`)**: Pure JavaScript indexer respecting `.gitignore` with symbol extraction, BM25 ranking, and optional embedding vectors.
- **Multi-Role Models**: Dedicated model assignments for **Chat** (`Ctrl+L`), **Autocomplete** (inline ghost text), **Edit** (`Ctrl+I`), **Apply**, **Embed**, and **Rerank** across OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama (local), and custom OpenAI-compatible endpoints. Chat, Plan, and Agent use the Chat model; inline edits use the Edit model. Configure temperature, output limits, and sampling options per model, including Ollama context length. Test Chat and Edit model connections from Models settings.
- **Modes**: **Chat**, **Plan**, and **Agent** (`Ctrl+.` to cycle).
- **15 Built-in Tools**: Per-tool permission controls (`Automatic`, `Ask First`, `Excluded`) with interactive approval cards in chat.
- **Configurable Rerank Models**: Assign Voyage AI, Cohere, Jina AI, or a custom `/rerank` endpoint to the Rerank role for `@codebase` and `@docs` result ranking.
- **Reusable Skills**: Create, edit, enable, and select task-specific instruction modules from the Skills settings page or chat composer. Enabled skills can activate automatically from trigger phrases.
- **Configuration Profiles**: Create and switch model/rules/skills/tool profiles from General Settings. Profiles clone the active profile and keep model assignments and generation options separate.
- **Role Diagnostics**: Test Chat, Edit, Apply, Autocomplete, Embed, and Rerank model assignments directly from the Models role cards.
- **Context Providers (`@`)**: `@Files`, `@Code`, `@Folder`, `@Current File`, `@Git Diff`, `@Terminal`, `@Problems`, `@Rules`, `@Codebase`, and `@Docs`.

## Running & Testing

1. Open the `codepilot-ai` folder in VS Code and press `F5` to launch the Extension Development Host.
2. Run the automated test suite with:
   ```bash
   npm test
   ```
