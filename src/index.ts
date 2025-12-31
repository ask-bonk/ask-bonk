import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { ulid } from 'ulid';
import type { IssueCommentEvent, IssuesEvent, PullRequestReviewCommentEvent } from '@octokit/webhooks-types';
import type { Env, AskRequest, TrackWorkflowRequest, FinalizeWorkflowRequest, SetupWorkflowRequest } from './types';
import {
	createOctokit,
	createWebhooks,
	verifyWebhook,
	createReaction,
	deleteInstallation,
	type ReactionTarget,
} from './github';
import type { ScheduleEventPayload, WorkflowDispatchPayload } from './types';
import { parseIssueCommentEvent, parseIssuesEvent, parsePRReviewCommentEvent, parseScheduleEvent, parseWorkflowDispatchEvent } from './events';
import { ensureWorkflowFile } from './workflow';
import { handleGetInstallation, handleExchangeToken, handleExchangeTokenForRepo, handleExchangeTokenWithPAT, validateGitHubOIDCToken, extractRepoFromClaims, getInstallationId } from './oidc';
import { RepoAgent } from './agent';
import { runAsk } from './sandbox';
import { getAgentByName } from 'agents';
import { emitMetric } from './metrics';

export { Sandbox } from '@cloudflare/sandbox';
export { RepoAgent };

const GITHUB_REPO_URL = 'https://github.com/ask-bonk/ask-bonk';

function isAllowedOrg(owner: string, env: Env): boolean {
	const allowed = env.ALLOWED_ORGS ?? [];
	if (allowed.length === 0) return true;
	return allowed.map((o) => o.toLowerCase()).includes(owner.toLowerCase());
}

// User-driven events: triggered by user actions (comments, issue creation)
// Repo-driven events: triggered by repository automation (schedule, workflow_dispatch)
// Meta events: GitHub App lifecycle events (installation)
const USER_EVENTS = ['issue_comment', 'pull_request_review_comment', 'issues'] as const;
const REPO_EVENTS = ['schedule', 'workflow_dispatch'] as const;
const META_EVENTS = ['installation'] as const;
const SUPPORTED_EVENTS = [...USER_EVENTS, ...REPO_EVENTS, ...META_EVENTS] as const;

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.redirect(GITHUB_REPO_URL, 302));
app.get('/health', (c) => c.text('OK'));

// Webhooks endpoint - receives GitHub events, logs them
// Tracking is now handled by the GitHub Action calling /api/github/track
app.post('/webhooks', async (c) => {
	return handleWebhook(c.req.raw, c.env);
});

// /ask endpoint - runs OpenCode directly in the sandbox
// Requires bearer auth with ASK_SECRET. Returns SSE stream.
// In future, responses may be routed to other destinations (email, Discord, etc)
const ask = new Hono<{ Bindings: Env }>();

ask.use('*', async (c, next) => {
	const secret = c.env.ASK_SECRET;
	// Empty or missing secret means endpoint is disabled
	if (!secret) {
		return c.json({ error: 'Ask endpoint is disabled' }, 403);
	}
	const auth = bearerAuth({ token: secret });
	return auth(c, next);
});

ask.post('/', async (c) => {
	const askId = ulid();
	let rawBody: Omit<AskRequest, 'id'>;
	try {
		rawBody = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	// Validate required fields
	if (!rawBody.owner || !rawBody.repo || !rawBody.prompt) {
		return c.json({ error: 'Missing required fields: owner, repo, prompt' }, 400);
	}

	// Build full request with ID
	const body: AskRequest = { id: askId, ...rawBody };
	const repoKey = `${body.owner}/${body.repo}`;
	const logPrefix = `[${repoKey}][ask:${askId}]`;

	// Look up installation ID for this repo (uses cache, falls back to GitHub API)
	const installationId = await getInstallationId(c.env, body.owner, body.repo);
	if (!installationId) {
		console.error(`${logPrefix} No GitHub App installation found`);
		return c.json({ error: `No GitHub App installation found for ${repoKey}` }, 404);
	}

	try {
		const stream = await runAsk(c.env, installationId, body);
		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(`${logPrefix} Ask failed:`, message);
		return c.json({ error: message }, 500);
	}
});

app.route('/ask', ask);

// OIDC endpoints for OpenCode GitHub Action token exchange
const auth = new Hono<{ Bindings: Env }>();

auth.get('/get_github_app_installation', async (c) => {
	const owner = c.req.query('owner');
	const repo = c.req.query('repo');

	if (!owner || !repo) {
		return c.json({ error: 'Missing owner or repo parameter' }, 400);
	}

	const result = await handleGetInstallation(c.env, owner, repo);
	if ('error' in result) {
		return c.json(result, 400);
	}
	return c.json(result);
});

auth.post('/exchange_github_app_token', async (c) => {
	const authHeader = c.req.header('Authorization') ?? null;
	const result = await handleExchangeToken(c.env, authHeader);

	if ('error' in result) {
		return c.json(result, 401);
	}
	return c.json(result);
});

auth.post('/exchange_github_app_token_for_repo', async (c) => {
	const authHeader = c.req.header('Authorization');
	let body: { owner?: string; repo?: string } = {};

	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const result = await handleExchangeTokenForRepo(c.env, authHeader ?? null, body);
	if ('error' in result) {
		return c.json(result, 401);
	}
	return c.json(result);
});

auth.post('/exchange_github_app_token_with_pat', async (c) => {
	const authHeader = c.req.header('Authorization');
	let body: { owner?: string; repo?: string } = {};

	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const result = await handleExchangeTokenWithPAT(c.env, authHeader ?? null, body);
	if ('error' in result) {
		return c.json(result, 401);
	}
	return c.json(result);
});

app.route('/auth', auth);

// GitHub API endpoints - called by the GitHub Action for tracking
const apiGithub = new Hono<{ Bindings: Env }>();

// POST /api/github/setup - Check if workflow file exists, create PR if not
apiGithub.post('/setup', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return c.json({ error: 'Missing or invalid Authorization header' }, 401);
	}

	const oidcToken = authHeader.slice(7);
	const validation = await validateGitHubOIDCToken(oidcToken);
	if (!validation.valid || !validation.claims) {
		return c.json({ error: validation.error || 'Invalid OIDC token' }, 401);
	}

	let body: SetupWorkflowRequest;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	// Validate required fields
	if (!body.owner || !body.repo || !body.issue_number || !body.default_branch) {
		return c.json({ error: 'Missing required fields: owner, repo, issue_number, default_branch' }, 400);
	}

	// Verify owner/repo from OIDC claims matches request
	const { owner: claimsOwner, repo: claimsRepo } = extractRepoFromClaims(validation.claims);
	if (claimsOwner !== body.owner || claimsRepo !== body.repo) {
		return c.json({ error: `OIDC token is for ${claimsOwner}/${claimsRepo}, not ${body.owner}/${body.repo}` }, 403);
	}

	const logPrefix = `[${body.owner}/${body.repo}#${body.issue_number}]`;

	// Look up installation ID
	const installationId = await getInstallationId(c.env, body.owner, body.repo);
	if (!installationId) {
		console.error(`${logPrefix} No GitHub App installation found`);
		return c.json({ error: `No GitHub App installation found for ${body.owner}/${body.repo}` }, 404);
	}

	try {
		const octokit = await createOctokit(c.env, installationId);
		const result = await ensureWorkflowFile(octokit, body.owner, body.repo, body.issue_number, body.default_branch);

		console.info(`${logPrefix} Setup result: exists=${result.exists}, prUrl=${result.prUrl ?? 'none'}`);
		emitMetric(c.env, {
			repo: `${body.owner}/${body.repo}`,
			eventType: 'setup',
			status: 'success',
			issueNumber: body.issue_number,
		});
		return c.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(`${logPrefix} Setup failed:`, message);
		emitMetric(c.env, {
			repo: `${body.owner}/${body.repo}`,
			eventType: 'setup',
			status: 'error',
			errorCode: message.slice(0, 100),
			issueNumber: body.issue_number,
		});
		return c.json({ error: message }, 500);
	}
});

// POST /api/github/track - Start tracking a workflow run
apiGithub.post('/track', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return c.json({ error: 'Missing or invalid Authorization header' }, 401);
	}

	const oidcToken = authHeader.slice(7);
	const validation = await validateGitHubOIDCToken(oidcToken);
	if (!validation.valid || !validation.claims) {
		return c.json({ error: validation.error || 'Invalid OIDC token' }, 401);
	}

	let body: TrackWorkflowRequest;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	// Validate required fields
	if (!body.owner || !body.repo || !body.run_id || !body.run_url || !body.issue_number || !body.created_at) {
		return c.json({ error: 'Missing required fields: owner, repo, run_id, run_url, issue_number, created_at' }, 400);
	}

	// Verify owner/repo from OIDC claims matches request
	const { owner: claimsOwner, repo: claimsRepo } = extractRepoFromClaims(validation.claims);
	if (claimsOwner !== body.owner || claimsRepo !== body.repo) {
		return c.json({ error: `OIDC token is for ${claimsOwner}/${claimsRepo}, not ${body.owner}/${body.repo}` }, 403);
	}

	const logPrefix = `[${body.owner}/${body.repo}#${body.issue_number}]`;

	// Look up installation ID
	const installationId = await getInstallationId(c.env, body.owner, body.repo);
	if (!installationId) {
		console.error(`${logPrefix} No GitHub App installation found`);
		return c.json({ error: `No GitHub App installation found for ${body.owner}/${body.repo}` }, 404);
	}

	try {
		// Create reaction if comment/issue ID provided
		if (body.comment_id || body.review_comment_id || body.issue_id) {
			const octokit = await createOctokit(c.env, installationId);
			const targetId = body.comment_id ?? body.review_comment_id ?? body.issue_id!;
			const reactionTarget: ReactionTarget = body.comment_id
				? 'issue_comment'
				: body.review_comment_id
					? 'pull_request_review_comment'
					: 'issue';

			await createReaction(octokit, body.owner, body.repo, targetId, '+1', reactionTarget);
			console.info(`${logPrefix} Created reaction on ${reactionTarget} ${targetId}`);
		}

		// Get/create RepoAgent and start tracking
		const agent = await getAgentByName<Env, RepoAgent>(c.env.REPO_AGENT, `${body.owner}/${body.repo}`);
		await agent.setInstallationId(installationId);
		await agent.trackRun(body.run_id, body.run_url, body.issue_number);

		console.info(`${logPrefix} Started tracking run ${body.run_id}`);
		emitMetric(c.env, {
			repo: `${body.owner}/${body.repo}`,
			eventType: 'track',
			status: 'success',
			issueNumber: body.issue_number,
			runId: body.run_id,
		});
		return c.json({ ok: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(`${logPrefix} Track failed:`, message);
		emitMetric(c.env, {
			repo: `${body.owner}/${body.repo}`,
			eventType: 'track',
			status: 'error',
			errorCode: message.slice(0, 100),
			issueNumber: body.issue_number,
			runId: body.run_id,
		});
		return c.json({ error: message }, 500);
	}
});

// PUT /api/github/track - Finalize tracking a workflow run
apiGithub.put('/track', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return c.json({ error: 'Missing or invalid Authorization header' }, 401);
	}

	const oidcToken = authHeader.slice(7);
	const validation = await validateGitHubOIDCToken(oidcToken);
	if (!validation.valid || !validation.claims) {
		return c.json({ error: validation.error || 'Invalid OIDC token' }, 401);
	}

	let body: FinalizeWorkflowRequest;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	// Validate required fields
	if (!body.owner || !body.repo || !body.run_id || !body.status) {
		return c.json({ error: 'Missing required fields: owner, repo, run_id, status' }, 400);
	}

	// Verify owner/repo from OIDC claims matches request
	const { owner: claimsOwner, repo: claimsRepo } = extractRepoFromClaims(validation.claims);
	if (claimsOwner !== body.owner || claimsRepo !== body.repo) {
		return c.json({ error: `OIDC token is for ${claimsOwner}/${claimsRepo}, not ${body.owner}/${body.repo}` }, 403);
	}

	const logPrefix = `[${body.owner}/${body.repo}]`;

	// Look up installation ID
	const installationId = await getInstallationId(c.env, body.owner, body.repo);
	if (!installationId) {
		console.error(`${logPrefix} No GitHub App installation found`);
		return c.json({ error: `No GitHub App installation found for ${body.owner}/${body.repo}` }, 404);
	}

	try {
		// Get RepoAgent and finalize
		const agent = await getAgentByName<Env, RepoAgent>(c.env.REPO_AGENT, `${body.owner}/${body.repo}`);
		await agent.setInstallationId(installationId);
		await agent.finalizeRun(body.run_id, body.status);

		console.info(`${logPrefix} Finalized run ${body.run_id} with status ${body.status}`);
		emitMetric(c.env, {
			repo: `${body.owner}/${body.repo}`,
			eventType: 'finalize',
			status: body.status,
			runId: body.run_id,
		});
		return c.json({ ok: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(`${logPrefix} Finalize failed:`, message);
		emitMetric(c.env, {
			repo: `${body.owner}/${body.repo}`,
			eventType: 'finalize',
			status: 'error',
			errorCode: message.slice(0, 100),
			runId: body.run_id,
		});
		// Always return 200 for finalize - errors are logged but don't fail the action
		return c.json({ ok: true, warning: message });
	}
});

app.route('/api/github', apiGithub);

export default app;

function getWebhookLogContext(event: { name: string; payload: unknown }): string {
	const payload = event.payload as Record<string, unknown>;
	const repo = payload.repository as { owner?: { login?: string }; name?: string } | undefined;
	const owner = repo?.owner?.login ?? 'unknown';
	const repoName = repo?.name ?? 'unknown';
	const issue = payload.issue as { number?: number } | undefined;
	const pr = payload.pull_request as { number?: number } | undefined;
	const num = issue?.number ?? pr?.number ?? '?';
	return `${owner}/${repoName} - ${event.name} - #${num}`;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const webhooks = createWebhooks(env);
	const event = await verifyWebhook(webhooks, request);
	if (!event) {
		console.error('Webhook signature verification failed');
		return new Response('Invalid signature', { status: 401 });
	}

	console.info(`Webhook: ${getWebhookLogContext(event)}`);

	// Installation ID caching is handled by getInstallationId() in oidc.ts on cache miss.
	// This avoids redundant KV writes on every webhook (see issue #52).
	const payload = event.payload as Record<string, unknown>;
	const repository = payload.repository as { owner?: { login?: string }; name?: string } | undefined;
	const repoKey = repository?.owner?.login && repository?.name ? `${repository.owner.login}/${repository.name}` : 'unknown/unknown';
	const sender = (payload.sender as { login?: string })?.login;
	const issue = payload.issue as { number?: number } | undefined;
	const pr = payload.pull_request as { number?: number } | undefined;
	const issueNumber = issue?.number ?? pr?.number;
	const isPrivate = (repository as { private?: boolean })?.private;
	const isPullRequest = !!pr;

	try {
		// Handle meta events (installation) before other checks - these may delete installations
		const isMetaEvent = META_EVENTS.includes(event.name as (typeof META_EVENTS)[number]);
		if (isMetaEvent) {
			await handleMetaEvent(event.name, event.payload, env);
			emitMetric(env, { repo: repoKey, eventType: 'installation', eventSubtype: event.name, status: 'success', actor: sender });
			return new Response('OK', { status: 200 });
		}

		// Check if the repo owner is in the allowed list
		const owner = repository?.owner?.login;
		if (owner && !isAllowedOrg(owner, env)) {
			console.info(`[${owner}] Org not in allowed list, skipping`);
			emitMetric(env, { repo: repoKey, eventType: 'webhook', eventSubtype: event.name, status: 'skipped', actor: sender });
			return new Response('OK', { status: 200 });
		}

		if (!SUPPORTED_EVENTS.includes(event.name as (typeof SUPPORTED_EVENTS)[number])) {
			console.info(`Unsupported event type: ${event.name}`);
			return new Response('OK', { status: 200 });
		}

		// Route events to appropriate handlers based on type
		// All handlers now just log - tracking is done via /api/github/track
		const isUserEvent = USER_EVENTS.includes(event.name as (typeof USER_EVENTS)[number]);
		if (isUserEvent) {
			await handleUserEvent(event.name, event.payload, env);
		} else {
			await handleRepoEvent(event.name, event.payload, env);
		}

		emitMetric(env, {
			repo: repoKey,
			eventType: 'webhook',
			eventSubtype: event.name,
			status: 'success',
			actor: sender,
			issueNumber,
			isPrivate,
			isPullRequest,
		});
		return new Response('OK', { status: 200 });
	} catch (error) {
		console.error(`Webhook error [${getWebhookLogContext(event)}]:`, error);
		emitMetric(env, {
			repo: repoKey,
			eventType: 'webhook',
			eventSubtype: event.name,
			status: 'error',
			actor: sender,
			errorCode: error instanceof Error ? error.message.slice(0, 100) : 'unknown',
			issueNumber,
			isPrivate,
			isPullRequest,
		});
		return new Response('Internal error', { status: 500 });
	}
}

// User-driven events: issue comments, PR review comments, issues
// Now just logs the event - tracking is done by the action calling /api/github/track
async function handleUserEvent(eventName: string, payload: unknown, _env: Env): Promise<void> {
	switch (eventName) {
		case 'issue_comment':
			await handleIssueComment(payload as IssueCommentEvent);
			break;
		case 'pull_request_review_comment':
			await handlePRReviewComment(payload as PullRequestReviewCommentEvent);
			break;
		case 'issues':
			await handleIssuesEvent(payload as IssuesEvent);
			break;
	}
}

// Repo-driven events: schedule, workflow_dispatch
// Just logs - processed by the GitHub Action directly
async function handleRepoEvent(eventName: string, payload: unknown, _env: Env): Promise<void> {
	switch (eventName) {
		case 'schedule':
			await handleScheduleEvent(payload as ScheduleEventPayload);
			break;
		case 'workflow_dispatch':
			await handleWorkflowDispatchEvent(payload as WorkflowDispatchPayload);
			break;
	}
}

// Meta events: GitHub App lifecycle events (installation)
// Checks if the installation is on an allowed org, and deletes it if not
async function handleMetaEvent(eventName: string, payload: unknown, env: Env): Promise<void> {
	if (eventName !== 'installation') return;

	const p = payload as {
		action?: string;
		installation?: { id?: number; account?: { login?: string } };
	};

	// Only handle 'created' action (new installation)
	if (p.action !== 'created') return;

	const installationId = p.installation?.id;
	const owner = p.installation?.account?.login;
	if (!installationId || !owner) return;

	if (isAllowedOrg(owner, env)) {
		console.info(`[${owner}] Installation ${installationId} allowed`);
		return;
	}

	// Org not in allowed list - delete the installation
	console.info(`[${owner}] Installation ${installationId} rejected - org not in ALLOWED_ORGS, uninstalling`);
	try {
		await deleteInstallation(env, installationId);
		console.info(`[${owner}] Installation ${installationId} deleted`);
	} catch (error) {
		console.error(`[${owner}] Failed to delete installation ${installationId}:`, error);
	}
}

async function handleIssueComment(payload: IssueCommentEvent): Promise<void> {
	const parsed = parseIssueCommentEvent(payload);
	if (!parsed) return;

	const logPrefix = `[${parsed.context.owner}/${parsed.context.repo}#${parsed.context.issueNumber}]`;
	console.info(`${logPrefix} Issue comment event from ${parsed.context.actor}`);
}

async function handlePRReviewComment(payload: PullRequestReviewCommentEvent): Promise<void> {
	const parsed = parsePRReviewCommentEvent(payload);
	if (!parsed) return;

	const logPrefix = `[${parsed.context.owner}/${parsed.context.repo}#${parsed.context.issueNumber}]`;
	console.info(`${logPrefix} PR review comment event from ${parsed.context.actor}`);
}

// Schedule events are handled by the GitHub Action directly - Bonk webhook just logs
async function handleScheduleEvent(payload: ScheduleEventPayload): Promise<void> {
	const parsed = parseScheduleEvent(payload);
	if (!parsed) {
		console.error('Invalid schedule event payload');
		return;
	}

	const logPrefix = `[${parsed.owner}/${parsed.repo}]`;
	console.info(`${logPrefix} Received schedule event: ${parsed.schedule}`);
}

async function handleIssuesEvent(payload: IssuesEvent): Promise<void> {
	const parsed = parseIssuesEvent(payload);
	if (!parsed) return;

	const logPrefix = `[${parsed.context.owner}/${parsed.context.repo}#${parsed.context.issueNumber}]`;
	console.info(`${logPrefix} Issues event (${payload.action}) from ${parsed.context.actor}`);
}

// Handle workflow_dispatch events for manual workflow triggers.
async function handleWorkflowDispatchEvent(payload: WorkflowDispatchPayload): Promise<void> {
	const parsed = parseWorkflowDispatchEvent(payload);
	if (!parsed) {
		console.error('Invalid workflow_dispatch event payload');
		return;
	}

	const logPrefix = `[${parsed.owner}/${parsed.repo}]`;
	console.info(`${logPrefix} Received workflow_dispatch event from ${parsed.sender}`);
}
