# Multi-AI Chat v0.4.1

A maintenance release for reliable Coding and Roundtable handoffs, provider
compatibility, message validation, and conversation performance.

## Changes

- Preserve the selected workflow and roles when starting a new conversation.
  Keep Coding's eight-step progress and full workflow history available.
- Improve ChatGPT/Claude answer detection, Gemini acknowledgement, Grok native
  editor insertion and user/assistant boundaries, and Meta's expanded code
  extraction. Preserve existing drafts and never automatically repeat accepted
  or uncertain sends.
- Reject missing text and image-only placeholders in Coding and Roundtable,
  including checkpoint recovery. Retain accepted-send evidence after waiter
  cleanup and keep unavailable contributions out of successful handoffs.
- Validate panel command senders and content-script message senders; avoid
  logging raw error objects during permission and injection failures.
- Reduce repeated conversation serialization and streaming scans, declare ESM
  explicitly, and provide `npm run benchmark` for the three latency checks.
- Translate the full workflow log into all five interface languages and manage
  keyboard focus when opening and closing it. Replace a no-op E2E assertion with
  concrete checks in the production-bundle browser fixture suite.
- Update webpack, PostCSS, Chrome types, fast-uri and vulnerable transitive build
  dependencies. The locked dependency audit reports zero vulnerabilities.
- Remove incomplete regex escaping from a test fixture flagged by CodeQL; use
  literal text matching for the provider, topic and previous answer.
- Use deterministic ZIP packaging for GitHub and Chrome Web Store. Failed store
  workflows now report authentication/upload status and link recovery steps.

Integrated PRs: #84, #86, #90, #93, #94, #95, #96, #97. Earlier changes after
v0.4.0 include #85, #87, #91 and #92; the placeholder assertion from #92 is removed.
No open issues were present during the release review.

## Validation

- `npm run verify`: TypeScript, production build, **538 tests passed**, and
  package/lockfile/source-manifest/built-manifest version consistency.
- `npm run benchmark`: **3 checks passed**.
- `npm audit --audit-level=low`: **0 vulnerabilities**.
- Chromium 156: **141 fixture checks passed** — 110 panel checks across five
  languages, 14 ChatGPT composer cases, 12 Gemini insertion cases, 5 Grok login
  cases. Provider pages and Chrome transport are simulated in these fixtures.
- Website checked in all five languages at a mobile viewport, including release
  links, version, checksum, no horizontal overflow, and no page errors.
- Two independently packaged archives were byte-identical; all **14 files** in
  the ZIP matched the verified `dist/` tree. `manifest.json` is at the ZIP root.
- `git diff --check` passed. Webpack's existing bundle-size warnings remain.

## Downloads

- [Extension ZIP](https://github.com/TED-H-com/multi-ai-chat/releases/download/v0.4.1/multi-ai-chat-store-v0.4.1.zip)
- [SHA-256 file](https://github.com/TED-H-com/multi-ai-chat/releases/download/v0.4.1/multi-ai-chat-store-v0.4.1.zip.sha256)

SHA-256: `4255487cbcdd08c9028ddf3079bc5851b951ed124e10b695d8981144e5606edc`

Extract the archive and use **chrome://extensions → Developer mode → Load
unpacked**, selecting the folder containing `manifest.json`.

## Chrome Web Store status and limits

The public Chrome Web Store listing remains **0.3.0** as checked on 2026-11-06.
The previous 0.4.0 submission and the [new authentication check](https://github.com/TED-H-com/multi-ai-chat/actions/runs/42181274959)
failed with Google STS `invalid_target` before upload. Restoring access to the
configured Google Cloud project/pool/provider is required to submit 0.4.1.
See [publishing recovery](PUBLISHING-RECOVERY.md). GitHub availability does not
mean Chrome Web Store submission or approval.

Fresh authenticated Coding/Roundtable completion on this integrated build is
unverified. Historical provider checks in PR #84 are not a new live pass.
Meta AI remains experimental and off by default; Google account sessions,
provider quotas, site changes and the known Edge/Claude restriction remain
external compatibility limits.
