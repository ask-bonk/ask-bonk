# ask-bonk

Bonk is like Ask Jeeves, but well, for code.

It's a code (and docs!) review agent that responds to mentions in issues and PRs. Built on [OpenCode](https://github.com/sst/opencode), Bonk can review code, answer questions about your codebase, and make changes directly by opening PRs and telling you where you can do better.

- **Code & doc review** - Get feedback on PRs, explain code, or ask questions about your repo just by mentioning `/bonk` in an issue, PR comment or even line comments.
- **Make changes** - Bonk can edit files and create PRs from issues and update PRs.
- **Fully configurable** - Supports any [model provider](https://opencode.ai/docs/providers) that Opencode does (Anthropic, OpenAI, Google, etc.). Why reinvent the wheel when there's a perfectly round one already?


## Setup

### GitHub App

**Managed (recommended)**: Install the [ask-bonk GitHub App](https://github.com/apps/ask-bonk) on your repositories. No configuration required.

**Self-hosted**: Deploy your own instance and [create a GitHub App](https://docs.github.com/en/apps/creating-github-apps) with the following permissions:
- Issues: Read & Write
- Pull requests: Read & Write
- Contents: Read & Write
- Metadata: Read

Subscribe to: Issue comments, Pull request review comments, Pull request reviews.

### Runner Modes

**GitHub Actions (default)**: Bonk triggers a workflow in your repo using [`sst/opencode/github`](https://github.com/sst/opencode). Requires `ANTHROPIC_API_KEY` as a repository secret.

**Cloudflare Sandbox SDK (beta)**: Runs OpenCode in [Cloudflare Containers](https://developers.cloudflare.com/containers/). Set `BONK_MODE=sandbox_sdk` in your deployment.

## Usage

Mention the bot in any issue or PR:

```
@ask-bonk fix the type error in utils.ts
```

Or use the slash command:

```
/bonk add tests for the auth module
```

## Config

### Defaults

| Setting | Value |
|---------|-------|
| Mention trigger | `@ask-bonk` |
| Slash command | `/bonk` |
| Model | `anthropic/claude-sonnet-4-20250514` |

### OpenCode Config

For advanced configuration (custom providers, system prompts, etc.), create `.opencode/opencode.jsonc`. See [OpenCode docs](https://opencode.ai/docs/config) for all options.

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

## License

MIT
