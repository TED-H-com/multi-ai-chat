# Chrome Web Store publishing recovery

Checked 2026-11-06. The public listing remains 0.3.0. GitHub Releases and GitHub
Pages are separate from Chrome Web Store submission.

## Current blocker

The [read-only authentication check](https://github.com/TED-H-com/multi-ai-chat/actions/runs/42181274959)
failed with Google STS `invalid_target` before any upload or submission. The
configured workload identity pool/provider is missing, deleted, or disabled:

- Project: `gen-lang-client-0134339345` (number `737791843417`)
- Pool: `github-actions`, location `global`
- Provider: `multi-ai-chat`
- Service account: `multi-ai-chat-cws-publisher@gen-lang-client-0134339345.iam.gserviceaccount.com`

The locally authenticated account `tedjchuang@gmail.com` cannot read this pool;
the project does not appear in its accessible-project list. This is an external
access/configuration blocker, not a package verification error. The previous
0.4.0 submission also failed authentication and never uploaded its package.

## Restore publishing

Use a Google account with access to the original project. Inspect before changing:

```sh
gcloud projects describe gen-lang-client-0134339345
gcloud iam workload-identity-pools describe github-actions \
  --location=global --project=gen-lang-client-0134339345
gcloud iam workload-identity-pools providers describe multi-ai-chat \
  --workload-identity-pool=github-actions --location=global \
  --project=gen-lang-client-0134339345
```

Restore or enable the original resource if it was deleted or disabled. If the
publisher moved to a different project, update all three `GCP_*` variables in the
`chrome-web-store` GitHub environment together, and register the replacement
service account in the existing Chrome Web Store publisher account. Preserve the
repository/owner ID, branch, workflow, event and environment restrictions described
in [SUBMISSION.md](SUBMISSION.md); do not broaden the trust condition to fix an
identity error. Keep the existing extension and publisher IDs.

Run `Chrome Web Store` on `master` with `publish_mode=status-only`, then approve
its environment deployment. A successful status check must show access to the
existing item. Once it succeeds, run with `version=0.4.1` and
`publish_mode=automatic`. The workflow builds and verifies the package, refuses
to replace pending/staged submissions, checks policy warnings, uploads, and
submits for automatic publication after Google's review.

An alternative is to upload the official GitHub Release ZIP in the existing
publisher's Developer Dashboard and submit it there. Both routes require access
to the publishing Google account; neither a requested workflow nor an uploaded
GitHub asset establishes Chrome Web Store approval.
