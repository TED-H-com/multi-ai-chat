#!/usr/bin/env bash
# Chrome Web Store v2 client. --preflight checks access and upload eligibility only.
set -euo pipefail

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--preflight' ) ]]; then
  echo 'Usage: bash scripts/chrome-web-store.sh [--preflight]' >&2
  exit 1
fi
for name in ACCESS_TOKEN CWS_PUBLISHER_ID CWS_EXTENSION_ID PUBLISH_MODE GITHUB_OUTPUT; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required setting: $name" >&2
    exit 1
  fi
done
case "$PUBLISH_MODE" in
  status-only) ;;
  upload-only|staged|automatic)
    if [[ ! "${EXPECTED_VERSION:-}" =~ ^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,3}$ ]]; then
      echo 'A valid extension version is required for upload and publish modes.' >&2
      exit 1
    fi
    ;;
  *) echo "Unsupported publish mode: $PUBLISH_MODE" >&2; exit 1 ;;
esac

item="publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}"
api="https://chromewebstore.googleapis.com"
auth_header="Authorization: Bearer ${ACCESS_TOKEN}"

request() {
  local response
  if response="$(curl --fail-with-body --silent --show-error --connect-timeout 15 "$@")"; then
    printf '%s\n' "$response"
  else
    printf '%s\n' "$response" >&2
    return 1
  fi
}

validate_item() {
  if ! jq -e --arg name "$item" --arg id "$CWS_EXTENSION_ID" \
    '.name == $name and .itemId == $id' >/dev/null <<<"$1"; then
    echo 'Chrome Web Store returned a missing or unexpected item identity.' >&2
    exit 1
  fi
}

status_response="$(request --max-time 60 \
  --retry 3 \
  --header "$auth_header" \
  "$api/v2/$item:fetchStatus")"
validate_item "$status_response"
printf '%s\n' "$status_response" | jq 'del(.publicKey)'

if ! jq -e '
  [.publishedItemRevisionStatus, .submittedItemRevisionStatus] |
  all(.[]; . == null or
    (.state as $state | ["PENDING_REVIEW", "STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS", "REJECTED", "CANCELLED"] | index($state) != null))
' >/dev/null <<<"$status_response"; then
  echo 'Chrome Web Store returned an unknown revision state.' >&2
  exit 1
fi
current_state="$(jq -r \
  '.submittedItemRevisionStatus.state // .publishedItemRevisionStatus.state // "not-submitted"' \
  <<<"$status_response")"
echo "publish_state=$current_state" >> "$GITHUB_OUTPUT"

if [[ "$PUBLISH_MODE" == "status-only" ]]; then
  echo "upload_state=not-run" >> "$GITHUB_OUTPUT"
  echo "publish_state=$current_state" >> "$GITHUB_OUTPUT"
  exit 0
fi

taken_down="$(jq -r '.takenDown // false' <<<"$status_response")"
warned="$(jq -r '.warned // false' <<<"$status_response")"
if [[ "$PUBLISH_MODE" != "upload-only" && ( "$taken_down" == "true" || "$warned" == "true" ) ]]; then
  echo 'The item is taken down or has a policy warning. Use upload-only for a remediation package.' >&2
  exit 1
fi

submitted_state="$(jq -r '.submittedItemRevisionStatus.state // empty' <<<"$status_response")"
if [[ "$submitted_state" == "PENDING_REVIEW" || "$submitted_state" == "STAGED" ]]; then
  echo "An existing submission is $submitted_state; refusing to replace it." >&2
  exit 1
fi

if [[ "$(jq -r '.lastAsyncUploadState // empty' <<<"$status_response")" == 'IN_PROGRESS' ]]; then
  echo 'An existing upload is still processing; refusing to replace it.' >&2
  exit 1
fi

mapfile -t current_versions < <(jq -r '
  [
    .publishedItemRevisionStatus.distributionChannels[]?.crxVersion,
    .submittedItemRevisionStatus.distributionChannels[]?.crxVersion
  ] | unique[]
' <<<"$status_response")
for current_version in "${current_versions[@]}"; do
  if ! node - "$EXPECTED_VERSION" "$current_version" <<'NODE'
const [nextVersion, currentVersion] = process.argv.slice(2);
const normalize = (version) => {
  if (!/^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,3}$/.test(version)) throw new Error('Invalid extension version');
  const parts = version.split('.').map(Number);
  if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) throw new Error('Invalid extension version');
  return parts.concat([0, 0, 0, 0]).slice(0, 4);
};
const next = normalize(nextVersion);
const current = normalize(currentVersion);
const comparison = next.findIndex((part, index) => part !== current[index]);
process.exit(comparison >= 0 && next[comparison] > current[comparison] ? 0 : 1);
NODE
  then
    echo "Version $EXPECTED_VERSION must be newer than existing version $current_version." >&2
    exit 1
  fi
done

if [[ "${1:-}" == '--preflight' ]]; then
  echo 'upload_state=not-run' >> "$GITHUB_OUTPUT"
  echo 'Publisher access and upload eligibility verified.'
  exit 0
fi
if [[ ! -s "${ARCHIVE:-}" ]]; then
  echo 'A nonempty extension archive is required.' >&2
  exit 1
fi

echo 'upload_state=not-confirmed' >> "$GITHUB_OUTPUT"
upload_response="$(request --max-time 120 \
  --request POST \
  --header "$auth_header" \
  --header 'Content-Type: application/zip' \
  --data-binary "@$ARCHIVE" \
  "$api/upload/v2/$item:upload")"
validate_item "$upload_response"
printf '%s\n' "$upload_response" | jq .

upload_state="$(jq -r '.uploadState // empty' <<<"$upload_response")"
uploaded_version="$(jq -r '.crxVersion // empty' <<<"$upload_response")"
if [[ ( "$upload_state" == 'SUCCEEDED' || -n "$uploaded_version" ) && "$uploaded_version" != "$EXPECTED_VERSION" ]]; then
  echo "Chrome Web Store reported version $uploaded_version; expected $EXPECTED_VERSION." >&2
  exit 1
fi
for attempt in {1..30}; do
  case "$upload_state" in
    SUCCEEDED|FAILED)
      break
      ;;
    IN_PROGRESS|UPLOAD_STATE_UNSPECIFIED|NOT_FOUND|'')
      sleep 10
      status_response="$(request --max-time 60 \
        --retry 3 \
        --header "$auth_header" \
        "$api/v2/$item:fetchStatus")"
      validate_item "$status_response"
      upload_state="$(jq -r '.lastAsyncUploadState // empty' <<<"$status_response")"
      echo "Upload status ($attempt/30): ${upload_state:-not-reported}"
      ;;
    *)
      echo "Chrome Web Store returned an unknown upload state: $upload_state" >&2
      exit 1
      ;;
  esac
done

if [[ "$upload_state" != "SUCCEEDED" ]]; then
  echo "Chrome Web Store upload did not succeed (state: ${upload_state:-missing})." >&2
  exit 1
fi

echo "upload_state=$upload_state" >> "$GITHUB_OUTPUT"

if [[ "$PUBLISH_MODE" == "upload-only" ]]; then
  echo "publish_state=not-submitted" >> "$GITHUB_OUTPUT"
  exit 0
fi

case "$PUBLISH_MODE" in
  staged) publish_type="STAGED_PUBLISH" ;;
  automatic) publish_type="DEFAULT_PUBLISH" ;;
  *)
    echo "Unsupported publish mode: $PUBLISH_MODE" >&2
    exit 1
    ;;
esac

echo 'publish_state=not-confirmed' >> "$GITHUB_OUTPUT"
publish_response="$(request --max-time 120 \
  --request POST \
  --header "$auth_header" \
  --header 'Content-Type: application/json' \
  --data "{\"publishType\":\"$publish_type\",\"blockOnWarnings\":true}" \
  "$api/v2/$item:publish")"
validate_item "$publish_response"
printf '%s\n' "$publish_response" | jq .
publish_state="$(jq -r '.state // "missing"' <<<"$publish_response")"
case "$publish_state" in
  PENDING_REVIEW|STAGED|PUBLISHED|PUBLISHED_TO_TESTERS)
    echo "publish_state=$publish_state" >> "$GITHUB_OUTPUT"
    ;;
  *)
    echo 'publish_state=not-confirmed' >> "$GITHUB_OUTPUT"
    echo "Chrome Web Store did not confirm submission (state: $publish_state). Check status-only before retrying." >&2
    exit 1
    ;;
esac
