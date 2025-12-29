#!/bin/bash
# Start tracking a workflow run and create reaction
# Called by the GitHub Action before running OpenCode

set -e

# Required inputs from environment
: "${OIDC_BASE_URL:?OIDC_BASE_URL is required}"
: "${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}"
: "${GITHUB_REPOSITORY_NAME:?GITHUB_REPOSITORY_NAME is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_SERVER_URL:?GITHUB_SERVER_URL is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${EVENT_NAME:?EVENT_NAME is required}"

# Get OIDC token
OIDC_TOKEN=$(curl -sf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=opencode-github-action" | jq -r '.value')

if [ -z "$OIDC_TOKEN" ] || [ "$OIDC_TOKEN" = "null" ]; then
  echo "::error::Failed to get OIDC token"
  exit 1
fi

# Build API URL from OIDC base URL
API_BASE="${OIDC_BASE_URL%/auth}"
RUN_URL="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"

# Build payload based on event type
case "$EVENT_NAME" in
  issue_comment)
    ISSUE_NUMBER="${ISSUE_NUMBER:?ISSUE_NUMBER is required for issue_comment events}"
    CREATED_AT="${COMMENT_CREATED_AT:?COMMENT_CREATED_AT is required for issue_comment events}"
    COMMENT_ID="${COMMENT_ID:?COMMENT_ID is required for issue_comment events}"
    PAYLOAD=$(jq -n \
      --arg owner "$GITHUB_REPOSITORY_OWNER" \
      --arg repo "$GITHUB_REPOSITORY_NAME" \
      --argjson run_id "$GITHUB_RUN_ID" \
      --arg run_url "$RUN_URL" \
      --argjson issue_number "$ISSUE_NUMBER" \
      --arg created_at "$CREATED_AT" \
      --argjson comment_id "$COMMENT_ID" \
      '{owner: $owner, repo: $repo, run_id: $run_id, run_url: $run_url, issue_number: $issue_number, created_at: $created_at, comment_id: $comment_id}')
    ;;
  pull_request_review_comment)
    ISSUE_NUMBER="${PR_NUMBER:?PR_NUMBER is required for pull_request_review_comment events}"
    CREATED_AT="${COMMENT_CREATED_AT:?COMMENT_CREATED_AT is required for pull_request_review_comment events}"
    REVIEW_COMMENT_ID="${COMMENT_ID:?COMMENT_ID is required for pull_request_review_comment events}"
    PAYLOAD=$(jq -n \
      --arg owner "$GITHUB_REPOSITORY_OWNER" \
      --arg repo "$GITHUB_REPOSITORY_NAME" \
      --argjson run_id "$GITHUB_RUN_ID" \
      --arg run_url "$RUN_URL" \
      --argjson issue_number "$ISSUE_NUMBER" \
      --arg created_at "$CREATED_AT" \
      --argjson review_comment_id "$REVIEW_COMMENT_ID" \
      '{owner: $owner, repo: $repo, run_id: $run_id, run_url: $run_url, issue_number: $issue_number, created_at: $created_at, review_comment_id: $review_comment_id}')
    ;;
  issues)
    ISSUE_NUMBER="${ISSUE_NUMBER:?ISSUE_NUMBER is required for issues events}"
    CREATED_AT="${ISSUE_CREATED_AT:?ISSUE_CREATED_AT is required for issues events}"
    ISSUE_ID="${ISSUE_ID:?ISSUE_ID is required for issues events}"
    PAYLOAD=$(jq -n \
      --arg owner "$GITHUB_REPOSITORY_OWNER" \
      --arg repo "$GITHUB_REPOSITORY_NAME" \
      --argjson run_id "$GITHUB_RUN_ID" \
      --arg run_url "$RUN_URL" \
      --argjson issue_number "$ISSUE_NUMBER" \
      --arg created_at "$CREATED_AT" \
      --argjson issue_id "$ISSUE_ID" \
      '{owner: $owner, repo: $repo, run_id: $run_id, run_url: $run_url, issue_number: $issue_number, created_at: $created_at, issue_id: $issue_id}')
    ;;
  *)
    # For other events (workflow_dispatch, schedule, etc.) - no reaction target
    ISSUE_NUMBER="${ISSUE_NUMBER:-0}"
    CREATED_AT="${CREATED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
    PAYLOAD=$(jq -n \
      --arg owner "$GITHUB_REPOSITORY_OWNER" \
      --arg repo "$GITHUB_REPOSITORY_NAME" \
      --argjson run_id "$GITHUB_RUN_ID" \
      --arg run_url "$RUN_URL" \
      --argjson issue_number "$ISSUE_NUMBER" \
      --arg created_at "$CREATED_AT" \
      '{owner: $owner, repo: $repo, run_id: $run_id, run_url: $run_url, issue_number: $issue_number, created_at: $created_at}')
    ;;
esac

# Call track endpoint
if ! RESPONSE=$(curl -sf -X POST "$API_BASE/api/github/track" \
  -H "Authorization: Bearer $OIDC_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"); then
  echo "::error::Failed to track Bonk run"
  exit 1
fi

# Check for error in response
ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
if [ -n "$ERROR" ]; then
  echo "::error::Track failed: $ERROR"
  exit 1
fi

echo "Successfully started tracking run $GITHUB_RUN_ID"
