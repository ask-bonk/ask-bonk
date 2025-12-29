# AGENTS.md

GitHub code review bot built on Cloudflare Workers + Hono + TypeScript. Use `bun` exclusively.

## Architecture

**Cloudflare Workers** application running on the edge (not Node.js). Key constraints:
- No filesystem access (env vars via `process.env` with nodejs_compat)
- Use Workers-compatible APIs (Fetch, Web Crypto, etc.)
- Durable Objects for stateful coordination

### Operation Modes

**`/webhooks` - GitHub Actions Mode**: Webhook events trigger GitHub Actions workflows. OpenCode runs *inside the workflow*, not in Bonk's infrastructure. The `RepoAgent` Durable Object tracks workflow run status and posts failure comments.

**`/ask` - Direct Sandbox Mode**: Runs OpenCode directly in Cloudflare Sandbox for programmatic API access. Requires bearer auth (`ASK_SECRET`). Returns SSE stream.

### Key Files
- `src/index.ts` - Hono app entry, webhook handling, request routing
- `src/github.ts` - GitHub API (Octokit with retry/throttling plugins, GraphQL for context)
- `src/sandbox.ts` - Cloudflare Sandbox + OpenCode SDK integration
- `src/workflow.ts` - GitHub Actions workflow mode (creates workflow PRs, tracks runs)
- `src/agent.ts` - RepoAgent Durable Object for tracking workflow runs
- `src/events.ts` - Webhook event parsing and response formatting
- `src/types.ts` - Type definitions (Env, request/response types, GitHub types)
- `src/oidc.ts` - OIDC token validation and exchange for GitHub Actions

## Commands

```bash
bun install              # Install dependencies
bun run test             # Run all tests (vitest in Workers pool)
bun run test -- src/events  # Run single test file by name
bun run test:plugin      # Run plugin tests (Node.js, not Workers)
bun run tsc --noEmit     # Type check
bun run deploy           # Deploy to Cloudflare (wrangler)
bun run dev              # Local development server
bun run cli              # Run CLI tool
```

### Test Notes
- Main tests run in `@cloudflare/vitest-pool-workers` (Workers environment)
- `test/tools/` tests use Node.js APIs (shescape, Bun.spawn) - run separately with `bun test test/tools/`
- Config: `vitest.config.mts` (main), `test/tsconfig.json` (test-specific)

## Dependency Management

**CRITICAL**: When modifying `package.json`, you MUST also update `bun.lock`:
1. Run `bun install` after modifying `package.json`
2. Commit both `package.json` AND `bun.lock` together

CI uses `bun install --frozen-lockfile` which fails if lockfile doesn't match.

## Code Style

### Formatting (enforced by .editorconfig + .prettierrc)
- **Indentation**: Tabs (spaces for YAML files)
- **Line endings**: LF
- **Print width**: 140 characters
- **Quotes**: Single quotes
- **Semicolons**: Required
- **Final newline**: Required

### Imports
- Group by: external packages first, then local modules
- Use `type` imports for types only: `import type { Env } from './types'`
- No trailing semicolons on import lines

### Types
- Strict mode enabled (`tsconfig.json`)
- Define shared types in `src/types.ts`
- Use explicit return types for exported functions
- Target: ES2024, module resolution: Bundler

### Naming
- `camelCase` for functions/variables
- `PascalCase` for types/classes/interfaces
- Prefix interfaces with descriptive nouns (e.g., `EventContext`, `TrackWorkflowRequest`)

### Error Handling
- Use try/catch for async operations
- Return early on validation failures
- Log errors with context prefix: `[owner/repo#issue]`
- For API handlers: return JSON errors with appropriate HTTP status codes

### Code Organization
- Keep related code together; avoid splitting across too many files
- Don't over-abstract until there are 2+ clear reuse cases
- External API functions stay in their respective files (`github.ts`, `sandbox.ts`, `oidc.ts`)
- Comments explain "why", not "what"; skip for short (<10 line) functions
- Prioritize comments for I/O boundaries, external system orchestration, and stateful code

## Testing

**IMPORTANT**: Tests must verify actual implementation behavior, not document expected structures.

### Valid Tests
- Call actual functions and verify return values
- Test input parsing, validation, and error handling with real payloads
- Verify API contract boundaries (request/response formats)
- Test edge cases and failure modes
- Use fixtures from `test/fixtures/` for realistic payloads

### Invalid Tests (Do NOT write these)
- Tests that create local objects and verify their own structure
- String equality checks with hardcoded values unrelated to implementation
- "Documentation" tests that don't call real functions
- Tests that stub/mock everything such that no real code paths are tested
- Unit tests that simply test language features (e.g., object spread)

### Test Philosophy
- Bias towards fewer tests, focusing on integration tests
- Focus on: user input parsing, API validation, crash resistance
- More tests are NOT better

## Conventions

### Configuration
- Prefer JSONC for config files (see `wrangler.jsonc`, `wrangler.test.jsonc`)
- Use `.editorconfig` and `.prettierrc` for formatting

### Dependencies
- Minimize new dependencies unless necessary
- Key packages: Hono (routing), Octokit (GitHub API), agents (Durable Objects)

### Logging
- Use `console.info()` for normal operations
- Use `console.error()` for errors
- Use `console.warn()` for warnings
- Always include context prefix: `[owner/repo]` or `[owner/repo#issue]`

### API Patterns
- Hono routes grouped by feature (auth, api/github, ask, webhooks)
- OIDC validation before processing API requests
- Bearer auth for protected endpoints
- Return `{ error: string }` for error responses with appropriate status codes
- Return `{ ok: true }` for success responses

### GitHub Integration
- Use `createOctokit()` with installation ID for authenticated requests
- `ResilientOctokit` includes retry and throttling plugins
- GraphQL for fetching issue/PR context (avoids multiple REST calls)
- REST for mutations (comments, reactions, PRs)

### Durable Objects
- `RepoAgent`: Tracks workflow runs per repo, posts failure comments
- ID format: `{owner}/{repo}`
- Uses `agents` package for simplified DO management
