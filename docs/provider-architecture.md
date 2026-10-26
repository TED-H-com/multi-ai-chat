# Multi-Provider Configuration and Architecture

This document outlines how Multi-AI Chat coordinates multiple AI providers, the environment variables required for development and testing, and the error fallback architecture.

## Provider Integration Setup

Multi-AI Chat operates by coordinating signed-in tabs for supported providers (ChatGPT, Claude, Gemini, Grok, and the standby Meta AI). It does not use model API keys; instead, it leverages the user's active web session for each provider.

- **Content Scripts:** Provider-specific DOM selectors and editor strategies are injected into the respective web pages (`src/content/*.ts`).
- **Standby Provider Substitution:** The extension supports exactly four active providers at a time. Meta AI is included as an experimental standby provider. Through the extension settings, users can swap out one of the default providers to route requests to Meta AI instead. Roles and targets automatically follow the active selection, which persists across restarts.

## Environment Variable Requirements

When developing or running UI and integration tests (located in `scripts/`), the following environment variables can be configured to control the test execution environment:

- **Browser Executables:** Path to the browser executable to use for tests.
  - `READINESS_BROWSER`
  - `GEMINI_BROWSER`
  - `GROK_BROWSER`
  - `EXTENSION_SMOKE_BROWSER`
  - `CHATGPT_BROWSER`
- **Playwright Configuration:**
  - `PLAYWRIGHT_MODULE`: Defaults to 'playwright'. Allows overriding the playwright module if needed.
  - `READINESS_CDP_URL`, `EXTENSION_SMOKE_CDP_URL`: Connect to an existing browser instance via Chrome DevTools Protocol (CDP) instead of launching a new one.
- **Test Output:** Path to save test reports or JSON results.
  - `READINESS_OUTPUT`, `GEMINI_OUTPUT`, `GROK_OUTPUT`, `EXTENSION_SMOKE_OUTPUT`, `CHATGPT_OUTPUT`
- **Specific Configurations:**
  - `READINESS_LOCALES`: Comma-separated list of locales to test in the readiness UI.
  - `EXTENSION_SMOKE_LEXICAL_BUNDLE`: Set to bundle the Lexical editor for smoke tests.
  - `EXTENSION_SMOKE_EDITOR`: Specifies the editor kind ('textarea' or 'contenteditable') for smoke tests.

## Model Fallback Routing and Error Architecture

Multi-AI Chat incorporates an error fallback and recovery architecture to handle provider failures gracefully during multi-provider workflows (like Roundtable or Debate):

1. **Workflow Pausing:** If a provider fails to accept input or generate a response, the workflow automatically pauses to prevent corrupted or unverified output from propagating.
2. **User-Driven Fallback Routing:** The user is presented with fallback routing options:
   - **Retry:** Attempts the prompt again with a fresh request ID.
   - **Skip this turn:** Marks the provider's contribution as unavailable in the remaining context. It routes around the failure without inventing a response or silently reassigning the task to a different provider.
   - **Cancel:** Aborts the entire workflow safely.
3. **DOM Fallbacks:** At the content script level, provider adapters use robust fallback selectors to locate input composers (e.g., trying standard `contenteditable` if a specific rich-text editor is not immediately detected). This prevents integration breakages when a provider updates their UI layout.
