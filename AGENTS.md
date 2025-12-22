# AGENTS.md

GitHub code review bot built on Cloudflare Workers + Hono + TypeScript. Use `bun` only.

## Architecture

This is a **Cloudflare Workers** application. Code runs on the edge, not Node.js. Key constraints:
- No filesystem access (env vars available via `process.env` with nodejs_compat)
- Use Workers-compatible APIs (Fetch, Web Crypto, etc.)
- Durable Objects for stateful coordination (`RepoAgent` in `agent.ts`)

### Operation Modes

**`/webhooks` - GitHub Actions Mode**: Webhook events trigger GitHub Actions workflows. OpenCode runs *inside the workflow*, not in Bonk's infrastructure. The `RepoAgent` Durable Object tracks workflow run status and posts failure comments.

**`/ask` - Direct Sandbox Mode**: Runs OpenCode directly in Cloudflare Sandbox for programmatic API access. Requires bearer auth (`ASK_SECRET`). Returns SSE stream.

### Key Files
- `index.ts` - Hono app entry, webhook handling, request routing
- `github.ts` - GitHub API (Octokit with retry plugin, GraphQL for context fetching)
- `sandbox.ts` - Cloudflare Sandbox + OpenCode SDK
- `workflow.ts` - GitHub Actions workflow mode (creates workflow PRs, tracks runs)
- `agent.ts` - RepoAgent Durable Object for tracking workflow runs
- `events.ts` - Webhook event parsing and response formatting

## Commands
- `bun install` - Install dependencies
- `bun run test` - Run all tests (vitest)
- `bun run test -- src/events` - Run single test file
- `bun run tsc --noEmit` - Type check
- `bun run deploy` - Deploy (wrangler)

## Code Style
- **Imports**: Group by external packages, then local modules. Use `type` imports for types only.
- **Types**: Strict mode enabled. Define types in `types.ts`, use explicit return types for exported functions.
- **Naming**: camelCase for functions/variables, PascalCase for types/classes. Prefix interfaces with descriptive nouns.
- **Formatting**: Tabs for indentation. No trailing semicolons in imports.
- **Error handling**: Use try/catch for async operations, return early on validation failures.

## Conventions
- Keep related code together; avoid splitting across too many files
- Comments explain "why", not "what"; skip for short (<10 line) functions
- External API functions stay in their respective files (`github.ts`, `sandbox.ts`)
- Prefer JSONC for config files
- Minimize new dependencies
