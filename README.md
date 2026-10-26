# Multi-AI Chat: Chrome Side Panel

**English** · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja.md) · [Deutsch](./README.de.md) · [한국어](./README.ko.md)

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/multi-ai-chat/nomhpmmhkmolkmpkjfeainjoifkipdah) · [Official website](https://ted-h-com.github.io/multi-ai-chat/) · [v0.4.0 release](https://github.com/TED-H-com/multi-ai-chat/releases/tag/v0.4.0) · [Desktop edition](https://ted-h-com.github.io/multi-ai-chat-desktop/)

Ask once and put four AIs to work. Multi-AI Chat is a lightweight Chrome Side Panel that coordinates your signed-in **ChatGPT, Claude, Gemini, and Grok** tabs. It uses the provider pages you already have access to. There are no model API keys and no separate chat backend.

**Current release: v0.4.0** · Chrome 114+ · Manifest V3 · Five interface languages · MIT

**v0.4.0 includes experimental Meta AI as a standby provider that stays off by default.** The original four remain active by default. In **Settings → Standby provider**, choose one of them to activate Meta AI in its place; exactly four providers stay active. Activating Meta asks for access to meta.ai, and declining keeps Meta on standby. Targets and workflow roles follow the selection, which persists across restarts. Existing tabs and sign-ins are preserved. Meta guest access depends on the current site/region, and an inert or disabled composer is not treated as ready.

> Multi-AI Chat automates third-party web interfaces. A provider redesign can temporarily break page selectors, and automated use may be governed by each provider's terms. Use only accounts and content you are authorized to use.

![Multi-AI Chat running a multi-provider workflow in Chrome](./store/screenshot-1280x800.png)

## What changed in v0.4.0

- **Recovery across restarts.** Workflow checkpoints preserve completed turns and pending recovery decisions. Optional automatic recovery stays off by default; accepted or uncertain sends are never automatically repeated.
- **Language and provider compatibility.** Answer language follows the task independently of the interface language. ChatGPT composer detection, Gemini plain-text insertion, and Grok sign-in detection are improved without overwriting an existing draft.
- **Panel and maintenance.** Send and Stop stay visible in short windows, long workflow traces remain scrollable, and React, Tailwind, TypeScript, and build dependencies are updated.
- **Validation and limits.** 450 tests and 131 Chromium fixture checks passed; real Gemini guest send and receive passed. Authenticated five-provider workflows, Stop, and long responses remain unverified end to end. Meta AI remains experimental and off by default. See the [full release notes](./store/RELEASE-v0.4.0.md).

## Choose your edition

| Edition | Best for |
|---|---|
| **Browser extension (this repository)** | A small Chrome Side Panel that works with the provider tabs you already use |
| [Multi-AI Chat Desktop](https://ted-h-com.github.io/multi-ai-chat-desktop/) | Isolated provider profiles, focused live WebViews, snapshots, replay, checkpoints, and local-file workflows |

Both editions use the providers' web sessions and do not require model API keys.

## Highlights

- One prompt across ChatGPT, Claude, Gemini, and Grok, with per-provider readiness shown before a run.
- Request IDs isolate late responses; Stop cancels active waiters and asks provider pages to stop generating.
- Up to 30 conversations are stored locally, with safe Markdown rendering, follow-up messages, and New chat.
- English, Traditional Chinese, Japanese, German, and Korean UI.
- Light, dark, or system appearance with WCAG-checked contrast.
- Optional, explicit publishing to HackMD with your own token.

## Workflows and recovery

| Mode | Workflow |
|---|---|
| **Free** | Send in parallel to every selected provider that is ready |
| **Debate** | Pro → Con → Judge → Synthesis |
| **Consult** | Two independent answers → Review → Final answer |
| **Coding** | Eight steps covering specification, review, implementation, testing, revision, and acceptance |
| **Roundtable** | Five rounds × four AIs = twenty contributions |

If a provider fails during Roundtable or Debate, the workflow pauses and offers **Retry**, **Skip this turn**, or **Cancel**. Retry uses a fresh request ID. Skip marks the contribution as unavailable in the remaining context; it does not invent a response or change the assigned provider. Provider error text is excluded from subsequent prompts.

The interface language is separate from the requested answer language. Workflow instructions honor explicit language or translation requests, then applicable preferences from the same conversation, then the user's task language. Quoted text and previous AI replies remain source material. Conversation replay is bounded, so older messages and long excerpts can be omitted.

Grok submission requires a matching new user message on the provider page. If acceptance cannot be confirmed, check that conversation before choosing Retry: an uncertain send may already have reached the provider. The extension does not automatically repeat an uncertain send, overwrite a different existing draft, or bypass provider usage limits.

Gemini uses the editor's plain-text paste handler and verifies the full prompt, including line breaks and significant whitespace, before one Send activation. A different draft, editor rollback, disabled Send, or uncertain acceptance stops the turn for recovery. It does not patch editor-owned DOM or repeat an ambiguous send.

## Install

### Chrome Web Store (recommended)

[Install Multi-AI Chat from the Chrome Web Store](https://chromewebstore.google.com/detail/multi-ai-chat/nomhpmmhkmolkmpkjfeainjoifkipdah). Chrome installs approved updates automatically, so this is the best option for regular use.

The Chrome Web Store listing is **v0.3.0** (updated 2026-09-23) and includes experimental Meta AI. Chrome rolls updates out gradually, so a given user may not have v0.3.0 yet.

### Manual or developer install

The GitHub Release ZIP is a manual backup that can be loaded as an unpacked extension; no source build is required.

> v0.4.0 is available on GitHub. The ZIP and checksum below are its official release files. Chrome Web Store availability follows its separate submission and review process.

1. Download [`multi-ai-chat-store-v0.4.0.zip`](https://github.com/TED-H-com/multi-ai-chat/releases/download/v0.4.0/multi-ai-chat-store-v0.4.0.zip) and its [checksum file](https://github.com/TED-H-com/multi-ai-chat/releases/download/v0.4.0/multi-ai-chat-store-v0.4.0.zip.sha256).
2. Verify the archive. The expected SHA-256 is `a128a939f9dd14606af6b8bb6c058377236664cd6ff537db4dbe6f999a145577`.

   ```powershell
   (Get-FileHash .\multi-ai-chat-store-v0.4.0.zip -Algorithm SHA256).Hash.ToLower()
   ```

   ```sh
   shasum -a 256 multi-ai-chat-store-v0.4.0.zip
   ```

3. Extract the ZIP to a permanent folder. Its root contains `manifest.json`.
4. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that extracted folder.
5. Pin **Multi-AI Chat**, click its icon to open the Side Panel, then open and sign in to each provider once. A provider becomes **Ready** after its composer is detected.

When updating, extract the new release to its own folder, point **Load unpacked** to that folder, and remove the older unpacked copy after confirming the new version works.

### Build from source

Requirements: Chrome 114+, Node.js 22.18+, npm, and Git.

```sh
git clone https://github.com/TED-H-com/multi-ai-chat.git
cd multi-ai-chat
npm ci
npm run verify
```

Then load the generated `dist/` folder from `chrome://extensions`. During development, run `npm run dev`, reload the extension from that page, and reopen the Side Panel.

## Use

1. Choose a workflow card.
2. In Free mode, keep all four providers selected or turn off any you do not need.
3. Expand **AI connections** and open or sign in to missing providers.
4. Enter a question and press Enter or **Send**.
5. Follow the workflow status; press **Stop** at any time.
6. Continue the conversation after completion, or use the menu to start a **New chat**.

Keep the Side Panel open while a serial workflow is running.

## Known limitation

- **Microsoft Edge + Claude:** Edge may prevent the extension from running on `claude.ai`, leaving the Claude card at **Open** with “This extension is not allowed on this site” and no usable site-access control. ChatGPT, Gemini, and Grok are unaffected. The same build works in Google Chrome, which is the current workaround for Claude.

## Permissions and privacy

| Access | Why it is needed |
|---|---|
| `sidePanel` | Displays the entire control interface |
| `tabs` | Finds and focuses provider tabs and tracks their load, navigation, reload, and close state; it is not used to read unrelated tabs |
| `scripting` | Re-injects only the extension's packaged content scripts when a provider tab predates an extension reload or its script was evicted; no remote code is executed |
| `storage` | Stores interface settings, up to 30 local conversations, and an optional HackMD token on your device |
| Provider hosts | On `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`, and `grok.com`, types prompts, sends them, and reads on-page responses for the selected workflow |
| `api.hackmd.io` | Contacted only after you explicitly choose **Publish**, using your token to create a guest-readable note |

Prompts go directly to the provider pages you select. There is **no Multi-AI Chat server, analytics, tracking, advertising, telemetry, or model API credential**. The optional HackMD token is restricted to trusted extension contexts, so provider content scripts cannot read it. Local data remains in Chrome until you clear it or remove the extension; removing the extension deletes its local storage. Provider and HackMD privacy policies still apply to content you choose to send them.

Read the complete [privacy policy](./store/PRIVACY.md).

## Development

```sh
npm run typecheck
npm run test
npm run build
npm run verify
npm audit
```

Key modules:

- `src/background/service-worker.ts`: workflow orchestration, request isolation, cancellation, and tab recovery
- `src/content/base.ts`: verified input, send, and response engine
- `src/content/*.ts`: provider-specific selectors and editor strategies
- `src/sidepanel/`: React interface, local sessions, Markdown, themes, and localization

Please run `npm run verify` before opening a pull request. For a provider-page breakage, [open an issue](https://github.com/TED-H-com/multi-ai-chat/issues) with the provider and browser version, but remove prompts, responses, account details, and tokens from screenshots or logs.

## Project and credits

- [Official website](https://ted-h-com.github.io/multi-ai-chat/)
- [GitHub Releases](https://github.com/TED-H-com/multi-ai-chat/releases)
- [Source and issue tracker](https://github.com/TED-H-com/multi-ai-chat)
- [Multi-AI Chat Desktop](https://ted-h-com.github.io/multi-ai-chat-desktop/)
- [MIT License](./LICENSE)

Sponsored by [AI-Sister.com](https://ai-sister.com). Created by Ted Huang ([TED@TED-H.com](mailto:TED@TED-H.com), [ted-h.com](https://ted-h.com)).

Special thanks to [@DaveTseng2019](https://github.com/DaveTseng2019) for substantial v0.2.x contributions: send and response reliability, connection recovery, localized error handling, dark mode, Side Panel UX, the transparent icon, and the project license.

## Provider Architecture Documentation

For more detailed information on provider integration setup, environment variable requirements for testing, and the error fallback architecture, please refer to the [Provider Architecture Documentation](./docs/provider-architecture.md).
