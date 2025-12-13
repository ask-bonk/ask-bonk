# ask-bonk

<p align="center">
  <img src="bonk_logo.png" alt="Bonk Logo" width="200">
</p>

Just `/bonk` it.

It's a code (and docs!) review agent that responds to mentions in issues and PRs. Built on [OpenCode](https://github.com/sst/opencode), Bonk can review code, answer questions about your codebase, and make changes directly by opening PRs and telling you where you can do better.

- **Code & doc review** - Get feedback on PRs, explain code, or ask questions about your repo just by mentioning `/bonk` in an issue, PR comment or even line comments.
- **Make changes** - Bonk can edit files and create PRs from issues and update PRs.
- **Fully configurable** - Supports any [model provider](https://opencode.ai/docs/providers) that OpenCode does (Anthropic, OpenAI, Google, etc.). Why reinvent the wheel when there's a perfectly round one already?

## Quick Start

The fastest way to get started:

1. Install the [ask-bonk GitHub App](https://github.com/apps/ask-bonk) on your repository
2. Add `ANTHROPIC_API_KEY` to your repository secrets
3. Mention `@ask-bonk` or `/bonk` in any issue or PR

That's it! On first mention, Bonk will create a PR to add the workflow file to your repo.

## Setup

### GitHub App

**Managed (recommended)**: Install the [ask-bonk GitHub App](https://github.com/apps/ask-bonk) on your repositories. The app handles webhook delivery and workflow tracking.

**Self-hosted**: Deploy your own instance and [create a GitHub App](https://docs.github.com/en/apps/creating-github-apps) with the following permissions:
- Issues: Read & Write
- Pull requests: Read & Write
- Contents: Read & Write
- Metadata: Read

Subscribe to: Issue comments, Pull request review comments, Pull request reviews.

### Workflow File

Bonk runs via GitHub Actions using the [`sst/opencode/github`](https://github.com/sst/opencode) action. When you first mention Bonk, it will automatically create a PR to add the workflow file (`.github/workflows/bonk.yml`) to your repository.

The generated workflow looks like this:

```yaml
name: Bonk

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

jobs:
  bonk:
    if: |
      github.event.sender.type != 'Bot' &&
      (contains(github.event.comment.body, '@ask-bonk') || contains(github.event.comment.body, '/bonk'))
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: write
      issues: write
      pull-requests: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Run Bonk
        uses: sst/opencode/github@latest
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
        with:
          model: anthropic/claude-sonnet-4-20250514
          use_github_token: true
```

### Required Secrets

Add the following secret to your repository (**Settings** > **Secrets and variables** > **Actions**):

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key ([get one here](https://console.anthropic.com/)) |

The `GITHUB_TOKEN` is automatically provided by GitHub Actions.

### Install Script

Alternatively, use the install script to set up Bonk in a repository:

```bash
npx tsx scripts/github-install.ts
```

This will:
1. Detect the target repository from your git origin
2. Prompt for your `ANTHROPIC_API_KEY` and set it as a repository secret
3. Create a PR with the workflow file

## Usage

Mention the bot in any issue or PR:

```
@ask-bonk fix the type error in utils.ts
```

Or use the slash command:

```
/bonk add tests for the auth module
```

### Examples

- `@ask-bonk review this PR` - Get a code review
- `/bonk explain how the auth system works` - Ask questions about the codebase
- `@ask-bonk fix the failing tests` - Let Bonk make changes and push commits
- `/bonk add documentation for the API endpoints` - Generate documentation

## Config

### Defaults

| Setting | Value |
|---------|-------|
| Mention trigger | `@ask-bonk` |
| Slash command | `/bonk` |
| Model | `anthropic/claude-sonnet-4-20250514` |

### OpenCode Config

For advanced configuration (custom providers, system prompts, etc.), create `.opencode/opencode.jsonc` in your repository. See [OpenCode docs](https://opencode.ai/docs/config) for all options.

```jsonc
{
  "provider": {
    "anthropic": {}
  },
  "model": {
    "default": "anthropic/claude-sonnet-4-20250514"
  }
}
```

## Architecture

```
GitHub Comment (@ask-bonk)
    │
    ▼
ask-bonk Worker (Cloudflare)
    │
    ├─► Posts "Working on it..." comment
    │
    ├─► Triggers GitHub Actions workflow
    │
    └─► Tracks workflow completion via RepoActor
            │
            ▼
        Updates comment with results
```

The ask-bonk GitHub App receives webhooks and coordinates with GitHub Actions. The actual AI work happens in the `sst/opencode/github` action running in your repository's GitHub Actions environment.

## Self-Hosting

Deploy your own Bonk instance to Cloudflare Workers:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/elithrar/ask-bonk)

Required environment variables:
- `GITHUB_APP_ID` - Your GitHub App ID
- `GITHUB_PRIVATE_KEY` - Your GitHub App private key
- `GITHUB_WEBHOOK_SECRET` - Webhook secret for verifying GitHub requests

## License

MIT
