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

1. Install the [ask-bonk GitHub App](https://github.com/apps/ask-bonk) on your repository
2. Add `OPENCODE_API_KEY` to your repository secrets (**Settings** > **Secrets and variables** > **Actions**) - [get one here](https://opencode.ai/api-keys)
3. Mention `@ask-bonk` or `/bonk` in any issue or PR

On first mention, Bonk will create a PR to add the workflow file to your repo.

### Using Other Providers

[Any OpenCode provider](https://opencode.ai/docs/providers/) is supported. Update your `bonk.yml` workflow file to specify a different model and pass the appropriate API key:

```yaml
      - name: Run Bonk
        uses: sst/opencode/github@dev
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-sonnet-4-20250514
```

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

### Events

Bonk can respond to the following GitHub webhook events:

| Event | Action | Trigger | Description |
|-------|--------|---------|-------------|
| `issue_comment` | `created` | `/bonk` or `@ask-bonk` in comment body | Responds to mentions in issue and PR comments |
| `pull_request_review_comment` | `created` | `/bonk` or `@ask-bonk` in comment body | Responds to mentions in PR line comments (with diff context) |
| `issues` | `opened` | New issue created | Automatically responds to newly opened issues (workflow mode only) |
| `schedule` | — | Cron expression in workflow | Runs automated tasks on a schedule (prompt via workflow file) |
| `workflow_dispatch` | — | Manual workflow trigger | Runs tasks manually via Actions UI (prompt via workflow file) |

**Event Categories:**
- **User-driven events** (`issue_comment`, `pull_request_review_comment`, `issues`): Triggered by user actions. Require write access check. Add reactions to acknowledge.
- **Repo-driven events** (`schedule`, `workflow_dispatch`): Triggered by repository automation. No actor to check permissions for. Prompt comes from workflow file.

#### Issue Edits

By default, Bonk's workflow only triggers on newly created issues, not edits. To also respond to issue edits, add `edited` to the issues event types and add a condition to filter for significant changes:

```yaml
on:
  issues:
    types: [opened, edited]

jobs:
  bonk:
    # Only run if: new issue OR edited with >20% body change
    if: |
      github.event.action == 'opened' ||
      (github.event.action == 'edited' && github.event.changes.body)
    runs-on: ubuntu-latest
    steps:
      - name: Check significant change
        if: github.event.action == 'edited'
        id: check
        run: |
          OLD='${{ github.event.changes.body.from }}'
          NEW='${{ github.event.issue.body }}'
          OLD_WC=$(echo "$OLD" | wc -w)
          NEW_WC=$(echo "$NEW" | wc -w)
          AVG=$(( (OLD_WC + NEW_WC) / 2 ))
          if [ "$AVG" -eq 0 ]; then
            echo "skip=false" >> $GITHUB_OUTPUT
            exit 0
          fi
          # Count common words (simple approach)
          COMMON=$(comm -12 <(echo "$OLD" | tr ' ' '\n' | sort) <(echo "$NEW" | tr ' ' '\n' | sort) | wc -l)
          CHANGE=$(( (AVG - COMMON) * 100 / AVG ))
          echo "Change: $CHANGE%"
          if [ "$CHANGE" -lt 20 ]; then
            echo "skip=true" >> $GITHUB_OUTPUT
          else
            echo "skip=false" >> $GITHUB_OUTPUT
          fi

      - name: Run Bonk
        if: steps.check.outputs.skip != 'true'
        uses: sst/opencode/github@dev
        # ... rest of your config
```

#### Scheduled Tasks

Scheduled events use the `prompt` input in your workflow file:

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
      - uses: sst/opencode/github@dev
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
        with:
          model: opencode/claude-opus-4-5
          oidc_base_url: "https://ask-bonk.silverlock.workers.dev/auth"
          prompt: |
            Update all dependencies to their latest compatible versions.
            Run tests and type-check after updating.
```

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
