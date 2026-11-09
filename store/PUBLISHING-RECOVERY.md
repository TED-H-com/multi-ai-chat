# Chrome Web Store publishing recovery

Authentication rechecked 2026-11-08. The public listing was last verified as 0.3.0
on 2026-11-06. GitHub Releases and GitHub Pages are separate from Chrome Web Store
submission.

## Current blocker

The [read-only authentication check](https://github.com/TED-H-com/multi-ai-chat/actions/runs/42181274959)
failed with Google STS `invalid_target` before any upload or submission. The
error indicates that the configured workload identity pool/provider may be missing,
deleted, or disabled; it does not distinguish which:

- Project: `gen-lang-client-0134339345` (number `737791843417`)
- Pool: `github-actions`, location `global`
- Provider: `multi-ai-chat`
- Service account: `multi-ai-chat-cws-publisher@gen-lang-client-0134339345.iam.gserviceaccount.com`

The locally authenticated account `tedjchuang@gmail.com` cannot read this pool;
the project does not appear in its accessible-project list. A fresh service-account
lookup on 2026-11-08 also returned `IAM_PERMISSION_DENIED`. These permission errors
do not prove that the project or service account was deleted. This is an external
access/configuration blocker, not a package verification error. The previous
0.4.0 submission also failed authentication and never uploaded its package.

## Restore publishing

Use a Google account with access to the original project. Inspect before changing:

```sh
gcloud auth login
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

If a resource is reported missing, inspect the pool/provider list with
`--show-deleted` using the authorized account. Google supports restoring deleted
pools/providers for 30 days; use the matching `gcloud iam workload-identity-pools
undelete` or `providers undelete` command only for the original resource. Enable a
disabled pool with `workload-identity-pools update --no-disabled`, or its OIDC
provider with `providers update-oidc --no-disabled`, keeping the original project,
location, pool and provider arguments. Read back the trust condition and service
account binding after recovery. See Google's
[pool/provider management guide](https://docs.cloud.google.com/iam/docs/manage-workload-identity-pools-providers).

Do not create credentials in an unrelated accessible project as a workaround. A
replacement service account must be linked to the existing publisher in the
[Chrome Web Store account settings](https://developer.chrome.com/docs/webstore/service-accounts),
and the GitHub environment must refer to that same project and identity.

Run `Chrome Web Store` on `master` with `publish_mode=status-only`, then approve
its environment deployment. A successful status check must show access to the
existing item. Once it succeeds, run with `version=0.4.1` and
`publish_mode=automatic`. The workflow builds and verifies the package, refuses
to replace pending/staged submissions, checks policy warnings, uploads, and
submits for automatic publication after Google's review.

The workflow now checks Google authentication and item access **before** installing
dependencies or building. It refreshes the short-lived token after building and
rechecks item eligibility immediately before upload. The shared
`scripts/chrome-web-store.sh` client refuses to replace pending/staged submissions
or an upload still processing. It validates response item identity and treats
missing/unknown submission states as failure. A timed-out POST is not automatically
repeated; inspect `status-only` before retrying. `not-confirmed` in the summary
means a request was attempted without a confirmed result, not that nothing happened.

Run `node --test test/chromeWebStore.test.mts` for the offline publishing regression
suite. These tests exercise the actual shell client with simulated HTTP responses;
they do not establish access to the live publisher. Restoring Google authentication
and obtaining a successful live status response are still required.

An alternative is to upload the official GitHub Release ZIP in the existing
publisher's Developer Dashboard and submit it there. Both routes require access
to the publishing Google account; neither a requested workflow nor an uploaded
GitHub asset establishes Chrome Web Store approval.
