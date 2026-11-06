# Provider extraction, Coding and Roundtable repair

This follow-up to merged PR #71 carries all remaining local source, test and
tracked production-build changes onto upstream `master` at
`cdcf6a7`.
The integration retains upstream's 0.4.0 release, dependency updates, unmarked
ChatGPT composer support, Grok login gate and settled-failure recovery.

## Problems and resulting behavior

- **Selected mode:** New chat previously reset to Free, providing a reproducible
  path to a parallel Free run when Coding was intended. Preserve the selected
  mode and roles, show the mode beside Send, and prevent early interaction before
  stored state loads. Preserve existing conversations and clear new-chat provider
  context. The user's exact click sequence in the ambiguous live run is unknown.
- **Coding and Roundtable evidence:** Empty or image-only placeholder replies
  become explicit unavailable contributions rather than successful code or
  arguments. Apply the same rule to completed replies and older checkpoints
  recovered after worker restart. Free mode retains media output support.
  Prompts require actual source for code review/acceptance, distinguish missing
  evidence from agreement, and distinguish proposed tests from executed tests.
  Models can still disregard these instructions.
- **Recovery and progress:** Preserve accepted-submission evidence through waiter
  cleanup and later failure states. Safe continuation records a gap without
  repeating the accepted turn; strict recovery pauses with retry disabled where
  delivery is already accepted. Await each Coding stage's status before dispatch,
  preserve eight-step progress on reopen, and honor cancellation during that wait.
- **ChatGPT:** Recognize current assistant Markdown and user-bubble markers,
  retain legacy layouts, and exclude user turns and surrounding action controls
  from assistant extraction.
- **Gemini:** Read actual user-query paragraphs rather than the hidden preview;
  count nested matching turns once. Acknowledge synchronous request reservation
  before slower insertion work and keep subsequent results scoped to the request.
  Bring the existing tab forward before dispatch and retain positive acceptance
  evidence observed during mutations or polling.
- **Claude:** Compare visual composer paragraphs while preserving meaningful
  horizontal and quoted whitespace; tolerate extra blank lines introduced by the
  editor. Use one submission activation, semantic response tracking, current
  assistant transcript selectors and existing-tab foreground activation.
- **Grok:** Distinguish contractions from quoted literals during prompt matching,
  preserve different drafts, and perform one native editor insertion with bounded
  reconciliation. Exclude user Markdown from response candidates and descendants
  of the accepted user bubble. Reconstruct lists/code for remounted user turns
  without code-card controls. Foreground the existing tab for serial turns.
- **Meta AI:** Serialize sibling prose/code fragments in order, preserving code
  lines and language. Reject thinking-only shells and invisible logo images;
  honor explicit streaming completion. Expand only response-local code preview
  controls and omit hidden duplicates. Prefer the complete fresh answer over a
  longer cached rendering containing status labels.
- **Shared presentation:** Preserve literal underscores inside identifiers,
  protected code-fence text, complete scrollable workflow traces, and Free-mode
  diagnostics. No provider response is fabricated for a missing contribution.
- **Chrome errors:** Reinject only when transport explicitly proves there is no
  receiver. Check the actual provider tab and existing host grant first. Cache
  permission/error-page failures until navigation or permission changes instead
  of repeatedly injecting. Handle worker startup failures and reconnect panel
  ports with heartbeat and cleanup. This does not grant site access or establish
  that every Chrome-origin `No SW` error has been eliminated.
- **Build verification:** Build before tests that compare shipped bundles with
  source, so bundle parity checks inspect the current implementation.

All tracked bundles are rebuilt. No new dependency, manifest permission, storage
schema, credential handling, telemetry, provider substitution or release is added.

## Automated validation

- Clean locked dependency install (`npm ci`).
- `npm run verify`: TypeScript, production build, **533 tests passed, 0 failed**,
  and package/manifest version consistency at 0.4.0 on Windows with both
  Node 26.7.0 and CI's Node 22.18.0. Rebuilding with Node 22 leaves tracked bundles
  unchanged.
- `npm audit --audit-level=high`: **0 vulnerabilities**.
- `git diff --check`: passed. Existing webpack size and Node module-type warnings
  remain.

Tests include all eight Coding stages and all twenty Roundtable turns, full
reference forwarding, mode/role persistence, cancellation, permission/error-page
preflight, panel reconnect, strict/safe recovery, accepted-send preservation and
worker restart. The captured Meta fixture contains only the assistant DOM from a
synthetic calculator test; it contains no browser profile, credentials or private
conversation history. Replaying it yields complete code with preserved line breaks
and no status labels or hidden preview. Worker tests use simulated Chrome messaging
and provider completions, not new authenticated provider sends.

## Live evidence and limits

Earlier candidates completed genuine authenticated Free checks 1411/1415, Debate
1414 (including Claude), and Consult 1418. The latter completed both answers,
review and synthesis without gaps; provider-page inspection verified the real
reference handoffs. The full workflow log's scrolling and Close were confirmed.
These results establish those tested candidates and configurations, not a fresh
live pass of this integrated 0.4.0 build.

Coding 1419/1420 exposed incomplete Meta code extraction and a Grok extraction
failure. Check 1421 actually ran in Free mode and is not a Coding pass. A provider's
acceptance claim made without supplied source was not counted as success. Those
failures motivated this patch and its regression coverage.

**Fresh live Coding and Roundtable completion remains unverified.** Browser tools
could inspect the authenticated HTTPS provider pages but blocked extension-page
control, preventing autonomous reload and side-panel initiation of a fresh run.
No duplicate provider sends, Retry/Regenerate clicks, authentication bypass or
quota bypass was used to fill that evidence gap. External site changes and model
instruction compliance remain compatibility risks.
