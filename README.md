# ask-bonk

A GitHub bot powered by OpenCode that responds to mentions in issues and PRs. Runs on Cloudflare Workers with sandboxed code execution.

## Setup

### 1. Create a GitHub App

1. Go to **GitHub Settings** > **Developer settings** > **GitHub Apps** > **New GitHub App**
2. Configure:
   - **Name**: `ask-bonk` (or your preferred name)
   - **Webhook URL**: `https://your-worker.workers.dev/webhooks`
   - **Webhook secret**: Generate a secure secret
   - **Permissions**:
     - Issues: Read & Write
     - Pull requests: Read & Write
     - Contents: Read & Write
     - Metadata: Read
   - **Subscribe to events**:
     - Issue comments
     - Pull request review comments
     - Pull request reviews
3. Generate and download a private key

### 2. Configure Secrets

**Important**: The private key must be in PKCS#8 format. GitHub generates keys in PKCS#1 format, so you need to convert it first:

```bash
# Convert the private key from PKCS#1 to PKCS#8
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in your-app-name.private-key.pem \
  -out your-app-name.private-key.pkcs8.pem
```

Then set the secrets:

```bash
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put ANTHROPIC_API_KEY

# For the private key, use the converted PKCS#8 file
cat your-app-name.private-key.pkcs8.pem | wrangler secret put GITHUB_APP_PRIVATE_KEY
```

### 3. Deploy

```bash
npm install
npx wrangler deploy
```

**Note**: First deployment may take 2-3 minutes for the container to provision.

## Usage

Mention the bot in any issue or PR comment:

```
@ask-bonk fix the type error in utils.ts
```

Or use the slash command:

```
/bonk add tests for the new feature
```

The bot will:
1. Immediately reply with "Bonk is working on it..."
2. Clone the repository and run OpenCode in a sandbox
3. Update the comment with the response
4. If changes are made on an issue, create a PR

## Configuration

### Per-Repository Settings

Create `.bonk/config.jsonc` in your repository root:

```jsonc
{
  // Override the default model
  "model": "anthropic/claude-sonnet-4-20250514",

  // Customize bot triggers (optional)
  "botMention": "@my-bot",
  "botCommand": "/mybot"
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `anthropic/claude-opus-4-5` | LLM model to use |
| `botMention` | `@ask-bonk` | Mention trigger |
| `botCommand` | `/bonk` | Slash command trigger |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_MODEL` | `anthropic/claude-opus-4-5` | Fallback model when not configured per-repo |

## Supported Events

- **Issue comments** - Comments on issues
- **PR review comments** - Line/file comments on pull requests
- **PR reviews** - Review body with comments

## Notes

### Fork PRs

Fork PRs are **not supported**. The bot cannot push to fork branches and will ignore mentions on PRs from forked repositories.

### Session Sharing

OpenCode session links are only included in responses for **public repositories**. Private repository sessions are not shared.

### Rate Limiting / Abuse Prevention

> **TODO**: Not yet implemented

- [ ] Per-user cooldowns
- [ ] Per-repo rate limits
- [ ] Maximum session duration limits
- [ ] Queue system for high-traffic repos
- [ ] Blocklist for abusive users/repos

## Development

```bash
# Install dependencies
npm install

# Run locally (requires Docker)
npm run dev

# Run tests
npm test

# Type check
npx tsc --noEmit

# Deploy
npm run deploy
```

## Architecture

```
┌─────────┐    ┌──────────────────┐    ┌─────────────────┐    ┌──────────────┐
│ GitHub  │───▶│ Cloudflare       │───▶│ Cloudflare      │───▶│ OpenCode     │
│ Webhook │    │ Worker           │    │ Container       │    │ Server       │
└─────────┘    └──────────────────┘    └─────────────────┘    └──────────────┘
                     │                        │                      │
               1. Verify sig            3. Clone repo          5. Model processes
               2. Create comment        4. Start opencode         prompt & works
                     │                        │                      on repo
                     │                        │◀─────────────────────┘
                     │                   6. Git commit/push
                     │                      (if changes)
                     │◀───────────────────────┘
               7. Update comment
                  (+ create PR if needed)
```

## License

MIT
