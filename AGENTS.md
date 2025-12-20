# AGENTS.md

This file provides guidance to AI coding agents working on ask-bonk.

## Project Overview

ask-bonk is a GitHub code review bot built on OpenCode. It responds to `/bonk` or `@ask-bonk` mentions in issues and PRs, running in a Cloudflare Workers environment with Durable Objects.

## Package Manager

**Use `bun` for all package management and script execution.**

- Install dependencies: `bun install`
- Run tests: `bun run test` (vitest)
- Type check: `bun run tsc --noEmit`
- Deploy: `bun run deploy` (wrangler)

Do NOT use npm, yarn, or pnpm.

## Tech Stack

- Runtime: Cloudflare Workers
- Framework: Hono
- Language: TypeScript
- Testing: Vitest with `@cloudflare/vitest-pool-workers`
- GitHub API: Octokit (REST and GraphQL)
- Sandbox: `@cloudflare/sandbox` for OpenCode execution

## Project Structure

```
src/
  index.ts      # Hono app entry, webhook handling, request routing
  github.ts     # GitHub API interactions (Octokit, GraphQL queries)
  sandbox.ts    # Cloudflare Sandbox + OpenCode SDK integration
  events.ts     # Webhook event parsing and response formatting
  workflow.ts   # GitHub Actions workflow mode
  oidc.ts       # OIDC token exchange for GitHub Actions
  actors.ts     # Durable Object actors
  images.ts     # Image extraction from comments
  types.ts      # TypeScript type definitions
test/
  index.spec.ts # Main test file
  fixtures/     # JSON fixtures for webhook payloads
scripts/
  github-install.ts  # GitHub App installation script
```

## Code Conventions

1. Keep related functionality together - avoid excessive file splitting
2. External API functions (GitHub, Sandbox) stay in their respective files
3. Comments explain "why", not "what" - skip comments on short functions
4. Prefer JSONC for configuration files
5. Minimize new dependencies

## Testing

Run tests with `bun run test`. Tests focus on:
- Webhook event parsing and validation
- API interface correctness
- Error handling and crash resistance

## Key Patterns

- Octokit uses the retry plugin for automatic 5xx error retry
- GraphQL is used for fetching issue/PR context with comments
- Webhook signature verification via `@octokit/webhooks`
- Sandbox executes OpenCode in isolated environment with git access
