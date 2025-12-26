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

## Dependency Management

**IMPORTANT**: When adding or updating dependencies in `package.json`, you MUST also update `bun.lock`:
1. Run `bun install` locally after modifying `package.json`
2. Commit both `package.json` AND `bun.lock` together

CI/CD uses `bun install --frozen-lockfile` which fails if the lockfile doesn't match `package.json`. This ensures reproducible builds and prevents dependency drift.

## Code Style
- **Imports**: Group by external packages, then local modules. Use `type` imports for types only.
- **Types**: Strict mode enabled. Define types in `types.ts`, use explicit return types for exported functions.
- **Naming**: camelCase for functions/variables, PascalCase for types/classes. Prefix interfaces with descriptive nouns.
- **Formatting**: Tabs for indentation. No trailing semicolons in imports.
- **Error handling**: Use try/catch for async operations, return early on validation failures.

## Testing

**IMPORTANT**: Tests must verify actual implementation behavior, not just document expected structures.

Do NOT write tests that:
- Create local objects/variables and verify their own structure
- Check string equality with hardcoded values unrelated to implementation
- "Document" expected behavior without calling real functions
- Stub/mock everything such that no real code paths are tested

Valid tests should:
- Call actual functions from the codebase and verify their return values
- Test input parsing, validation, and error handling with real payloads
- Verify API contract boundaries (request/response formats)
- Test edge cases and failure modes

Keep tests focused on: user input parsing, API interface validation, and crash resistance. More tests are not better.

- Avoid unit tests that simply test language functions or methods (e.g. testing that object spread works)
- Bias towards fewer overall tests, focusing on integration tests or stubs that test validation, state, and error handling

## Conventions
- Keep related code together; avoid splitting across too many files
- Comments explain "why", not "what"; skip for short (<10 line) functions
- External API functions stay in their respective files (`github.ts`, `sandbox.ts`)
- Prefer JSONC for config files
- Minimize new dependencies
