# ask-bonk

<p align="center">
  <img src="bonk_logo.png" alt="Bonk Logo" width="200">
</p>

Just `/bonk` it.

It's a code (and docs!) review agent that responds to mentions in issues and PRs. Built on [OpenCode](https://github.com/sst/opencode), Bonk can review code, answer questions about your codebase, and make changes directly by opening PRs and telling you where you can do better.

- **Code & doc review** - Get feedback on PRs, explain code, or ask questions about your repo just by mentioning `/bonk` in an issue, PR comment or even line comments.
- **Make changes** - Bonk can edit files and create PRs from issues and update PRs.
- **Fully configurable** - Supports any [model provider](https://opencode.ai/docs/providers) that OpenCode does (Anthropic, OpenAI, Google, etc.). Why reinvent the wheel when there's a perfectly round one already?

## Installation

### 1. Install the GitHub App

Install the [ask-bonk GitHub App](https://github.com/apps/ask-bonk) on your repository.

### 2. Add the Workflow File

Create `.github/workflows/bonk.yml` in your repository:

```yaml
name: Bonk

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

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

      - name: Configure Git
        run: |
          git config --global user.name "github-actions[bot]"
          git config --global user.email "github-actions[bot]@users.noreply.github.com"

      - name: Run Bonk
        uses: elithrar/ask-bonk/github@main
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
        with:
          model: "opencode/claude-opus-4-5"
          mentions: "/bonk,@ask-bonk"
```

### 3. Add Your API Key

Add `OPENCODE_API_KEY` to your repository secrets (**Settings** > **Secrets and variables** > **Actions**) - [get one here](https://opencode.ai/api-keys)

### 4. Start Using Bonk

Mention `@ask-bonk` or `/bonk` in any issue or PR comment.

### Using Other Providers

[Any OpenCode provider](https://opencode.ai/docs/providers/) is supported. Update your `bonk.yml` workflow file to specify a different model and pass the appropriate API key:

```yaml
      - name: Run Bonk
        uses: elithrar/ask-bonk/github@main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-sonnet-4-20250514
```

## GitHub Workflows

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

### Supported Events

The default workflow triggers on `issue_comment` and `pull_request_review_comment` events. You can extend your workflow to support additional events:

| Event | Trigger | How it works |
|-------|---------|--------------|
| `issue_comment` | `/bonk` or `@ask-bonk` in an issue or PR comment | Bonk responds to mentions in the comment thread. Works for both issues and pull requests. |
| `pull_request_review_comment` | `/bonk` or `@ask-bonk` in a PR line comment | Bonk responds with full diff context from the specific line being commented on. Ideal for targeted code review questions. |
| `pull_request_review` | `/bonk` or `@ask-bonk` in a PR review body | Triggered when a review is submitted with the mention in the review body. Add `pull_request_review: types: [submitted]` to your workflow triggers. |
| `issues` | New issue opened | Automatically responds to newly created issues. Useful for triage or auto-labeling. Requires adding `issues: types: [opened]` to triggers and removing the mention check from the job condition. |
| `schedule` | Cron expression | Runs automated tasks on a schedule. The prompt comes from the workflow file's `prompt` input. |
| `workflow_dispatch` | Manual trigger in Actions UI | Runs tasks on-demand via the GitHub Actions interface. |

#### Adding PR Review Support

```yaml
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
      (
        contains(github.event.comment.body, '@ask-bonk') ||
        contains(github.event.comment.body, '/bonk') ||
        contains(github.event.review.body, '@ask-bonk') ||
        contains(github.event.review.body, '/bonk')
      )
```

#### Scheduled Tasks

```yaml
on:
  schedule:
    - cron: "0 4 * * 5"  # Friday at 4AM UTC

jobs:
  update-deps:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: elithrar/ask-bonk/github@main
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
        with:
          model: opencode/claude-opus-4-5
          prompt: |
            Update all dependencies to their latest compatible versions.
            Run tests and type-check after updating.
```

## `/ask` Sandbox Mode

> :warning: **Experimental and work-in-progress.** Uses the [Cloudflare Sandbox SDK](https://sandbox.cloudflare.com/) to run off-GitHub tasks.

For programmatic access, Bonk exposes an `/ask` endpoint that runs OpenCode directly in a Cloudflare Sandbox. This allows you to integrate Bonk into your own workflows, scripts, or applications without going through GitHub issues and PRs.

When you make a request to `/ask`:
1. Bonk clones your repository into an isolated sandbox
2. Runs OpenCode with your prompt against the codebase
3. Returns the response as a Server-Sent Events (SSE) stream

The endpoint requires bearer authentication and only works with repositories that have the Bonk GitHub App installed.

```bash
curl -N https://ask-bonk.silverlock.workers.dev/ask \
  -H "Authorization: Bearer $ASK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "your-org",
    "repo": "your-repo",
    "prompt": "Explain how the authentication system works"
  }'
```

Optional fields:
- `model` - Override the default model (e.g., `"anthropic/claude-sonnet-4-20250514"`)
- `agent` - Use a specific OpenCode agent
- `config` - Pass custom OpenCode configuration

## Config

### Defaults

| Setting | Value |
|---------|-------|
| Mention trigger | `@ask-bonk` |
| Slash command | `/bonk` |
| Model | `opencode/claude-opus-4-5` |

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

## Self-Hosting

Deploy your own Bonk instance to Cloudflare Workers:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/elithrar/ask-bonk)

You'll need to [create a GitHub App](https://docs.github.com/en/apps/creating-github-apps) with the following permissions:
- Issues: Read & Write
- Pull requests: Read & Write
- Contents: Read & Write
- Metadata: Read

Subscribe to: Issue comments, Pull request review comments, Pull request reviews.

Required environment variables:
- `GITHUB_APP_ID` - Your GitHub App ID
- `GITHUB_PRIVATE_KEY` - Your GitHub App private key
- `GITHUB_WEBHOOK_SECRET` - Webhook secret for verifying GitHub requests

## License

Apache-2.0 licensed.
