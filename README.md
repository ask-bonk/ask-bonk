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
2. Add `OPENCODE_API_KEY` to your repository secrets
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

### Required Secrets

Add the following secret to your repository (**Settings** > **Secrets and variables** > **Actions**):

| Secret | Description |
|--------|-------------|
| `OPENCODE_API_KEY` | Your OpenCode API key ([get one here](https://opencode.ai/api-keys)) |

The `GITHUB_TOKEN` is automatically provided by GitHub Actions.

### Install Script

Alternatively, use the install script to set up Bonk in a repository:

```bash
npx tsx scripts/github-install.ts
```

This will:
1. Detect the target repository from your git origin
2. Prompt for your `OPENCODE_API_KEY` and set it as a repository secret
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

## How Bonk Works

Bonk coordinates between a Cloudflare Worker (webhook handling & coordination) and [opencode](https://opencode.ai) (in GitHub Actions). The Worker provides instant feedback while opencode does the heavy lifting in your repo's Actions environment.

- **Webhook delivery**: GitHub sends comment events to both Bonk Worker and triggers the `bonk.yml` workflow
- **Instant feedback**: Bonk acknowledges the comment and posts a brief "Starting..." comment with a link to the workflow run.
- **AI execution**: opencode runs in GitHub Actions, reads context, calls the AI, and posts results
- **Failure handling**: Bonk monitors the workflow and only updates its comment if something fails
- **No duplication**: On success, opencode's responds (with comments, a new PR, or a new issue as needed).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER COMMENTS @ask-bonk                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GITHUB WEBHOOK DELIVERY                             │
│                      (issue_comment.created event)                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
                    ▼                                   ▼
┌───────────────────────────────────┐   ┌───────────────────────────────────┐
│     BONK WORKER (Cloudflare)      │   │    GITHUB ACTIONS (bonk.yml)      │
│                                   │   │                                   │
│ 1. Verify webhook                 │   │ 1. Triggered by issue_comment     │
│ 2. Check write access             │   │    event (GitHub native)          │
│ 3. POST comment:                  │   │                                   │
│    "Starting Bonk... [View run]"  │   │ 2. Runs: sst/opencode/github      │
│ 4. Hand off to RepoActor          │   │                                   │
└───────────────────────────────────┘   └───────────────────────────────────┘
                    │                                   │
                    │                                   ▼
                    │                   ┌───────────────────────────────────┐
                    │                   │      OPENCODE CLI (github.ts)     │
                    │                   │                                   │
                    │                   │ 1. Add 👀 reaction                │
                    │                   │ 2. Fetch issue/PR context         │
                    │                   │ 3. Run AI agent                   │
                    │                   │ 4. Push changes if any            │
                    │                   │ 5. POST comment with response     │
                    │                   │ 6. Remove 👀 reaction             │
                    │                   └───────────────────────────────────┘
                    │                                   │
                    ▼                                   ▼
┌───────────────────────────────────┐   ┌───────────────────────────────────┐
│   REPO ACTOR (Durable Object)     │   │       FINAL STATE                 │
│                                   │   │                                   │
│ Polls workflow status every 30s   │   │ Comment 1 (Bonk):                 │
│                                   │   │   "Starting Bonk... [View run]"   │
│ On SUCCESS: silent (OpenCode      │   │                                   │
│             already posted)       │   │ Comment 2 (OpenCode):             │
│                                   │   │   "<Full AI Response>             │
│ On FAILURE/TIMEOUT: updates       │   │    [View session]"                │
│   "Bonk workflow failed..."       │   │                                   │
└───────────────────────────────────┘   └───────────────────────────────────┘
```

## Self-Hosting

Deploy your own Bonk instance to Cloudflare Workers:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/elithrar/ask-bonk)

Required environment variables:
- `GITHUB_APP_ID` - Your GitHub App ID
- `GITHUB_PRIVATE_KEY` - Your GitHub App private key
- `GITHUB_WEBHOOK_SECRET` - Webhook secret for verifying GitHub requests

## License

Apache-2.0 licensed.
