#!/bin/bash
# Finalize tracking a workflow run
# Called by the GitHub Action after OpenCode completes (with if: always())

# Don't use set -e - we want to continue on errors and just warn

# Required inputs from environment
: "${OIDC_BASE_URL:?OIDC_BASE_URL is required}"
: "${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}"
: "${GITHUB_REPOSITORY_NAME:?GITHUB_REPOSITORY_NAME is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${OPENCODE_STATUS:?OPENCODE_STATUS is required}"

# Get OIDC token
OIDC_TOKEN=$(curl -sf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=opencode-github-action" | jq -r '.value')

if [ -z "$OIDC_TOKEN" ] || [ "$OIDC_TOKEN" = "null" ]; then
  echo "::warning::Failed to get OIDC token for finalize"
  exit 0
fi

# Build API URL from OIDC base URL
API_BASE="${OIDC_BASE_URL%/auth}"

# Build payload
PAYLOAD=$(jq -n \
  --arg owner "$GITHUB_REPOSITORY_OWNER" \
  --arg repo "$GITHUB_REPOSITORY_NAME" \
  --argjson run_id "$GITHUB_RUN_ID" \
  --arg status "$OPENCODE_STATUS" \
  '{owner: $owner, repo: $repo, run_id: $run_id, status: $status}')

# Call finalize endpoint - don't fail on error, just warn
if ! curl -sf -X PUT "$API_BASE/api/github/track" \
  -H "Authorization: Bearer $OIDC_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null; then
  echo "::warning::Failed to finalize Bonk run tracking"
  exit 0
fi

echo "Successfully finalized run $GITHUB_RUN_ID with status $OPENCODE_STATUS"
