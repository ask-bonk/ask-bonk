#!/bin/bash
# Check if workflow file exists, create PR if not
# Called by the GitHub Action before running OpenCode

set -e

# Required inputs from environment
: "${OIDC_BASE_URL:?OIDC_BASE_URL is required}"
: "${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}"
: "${GITHUB_REPOSITORY_NAME:?GITHUB_REPOSITORY_NAME is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"

# Get OIDC token
OIDC_TOKEN=$(curl -sf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=opencode-github-action" | jq -r '.value')

if [ -z "$OIDC_TOKEN" ] || [ "$OIDC_TOKEN" = "null" ]; then
  echo "::error::Failed to get OIDC token"
  exit 1
fi

# Build API URL from OIDC base URL
API_BASE="${OIDC_BASE_URL%/auth}"

# Call setup endpoint
if ! RESPONSE=$(curl -sf -X POST "$API_BASE/api/github/setup" \
  -H "Authorization: Bearer $OIDC_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg owner "$GITHUB_REPOSITORY_OWNER" \
    --arg repo "$GITHUB_REPOSITORY_NAME" \
    --argjson issue_number "$ISSUE_NUMBER" \
    --arg default_branch "$DEFAULT_BRANCH" \
    '{owner: $owner, repo: $repo, issue_number: $issue_number, default_branch: $default_branch}')"); then
  echo "::error::Failed to call setup endpoint"
  exit 1
fi

# Check if workflow exists
EXISTS=$(echo "$RESPONSE" | jq -r '.exists // false')
PR_URL=$(echo "$RESPONSE" | jq -r '.prUrl // empty')

if [ "$EXISTS" = "true" ]; then
  echo "Workflow file exists"
  echo "skip=false" >> "$GITHUB_OUTPUT"
else
  echo "Workflow file missing - PR created: $PR_URL"
  echo "skip=true" >> "$GITHUB_OUTPUT"
  echo "pr_url=$PR_URL" >> "$GITHUB_OUTPUT"
fi
