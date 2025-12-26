import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { ulid } from 'ulid';
import type { IssueCommentEvent, IssuesEvent, PullRequestReviewCommentEvent, WorkflowDispatchEvent, WorkflowRunRequestedEvent } from '@octokit/webhooks-types';
import type { Env, AskRequest } from './types';
import {
	createOctokit,
	createWebhooks,
	verifyWebhook,
	hasWriteAccess,
	createReaction,
	createComment,
	type ReactionTarget,
} from './github';
import type { ScheduleEventPayload, WorkflowDispatchPayload } from './types';
import { parseIssueCommentEvent, parseIssuesEvent, parsePRReviewCommentEvent, parseScheduleEvent, parseWorkflowDispatchEvent, hasMention } from './events';
import { runWorkflowMode } from './workflow';
import { handleGetInstallation, handleExchangeToken, handleExchangeTokenForRepo, handleExchangeTokenWithPAT } from './oidc';
import { RepoAgent } from './agent';
import { runAsk } from './sandbox';
import { getAgentByName } from 'agents';

export { Sandbox } from '@cloudflare/sandbox';
export { RepoAgent };

const GITHUB_REPO_URL = 'https://github.com/elithrar/ask-bonk';

// User-driven events: triggered by user actions (comments, issue creation)
// Repo-driven events: triggered by repository automation (schedule, workflow_dispatch)
// System events: triggered by GitHub itself (workflow_run)
const USER_EVENTS = ['issue_comment', 'pull_request_review_comment', 'issues'] as const;
const REPO_EVENTS = ['schedule', 'workflow_dispatch'] as const;
const SYSTEM_EVENTS = ['workflow_run'] as const;
const SUPPORTED_EVENTS = [...USER_EVENTS, ...REPO_EVENTS, ...SYSTEM_EVENTS] as const;

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.redirect(GITHUB_REPO_URL, 302));
app.get('/health', (c) => c.text('OK'));

// Webhooks endpoint - ALWAYS runs via GitHub Actions workflow mode
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

	// Look up installation ID for this repo
	const installationIdStr = await c.env.APP_INSTALLATIONS.get(repoKey);
	if (!installationIdStr) {
		console.error(`${logPrefix} No GitHub App installation found`);
		return c.json({ error: `No GitHub App installation found for ${repoKey}` }, 404);
	}
	const installationId = parseInt(installationIdStr, 10);

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

	// Cache installation ID for future API calls
	const payload = event.payload as Record<string, unknown>;
	const installation = payload.installation as { id?: number } | undefined;
	const repository = payload.repository as { owner?: { login?: string }; name?: string } | undefined;
	if (installation?.id && repository?.owner?.login && repository?.name) {
		const repoKey = `${repository.owner.login}/${repository.name}`;
		await env.APP_INSTALLATIONS.put(repoKey, String(installation.id));
		console.info(`Stored installation ${installation.id} for ${repoKey}`);
	}

	try {
		if (!SUPPORTED_EVENTS.includes(event.name as (typeof SUPPORTED_EVENTS)[number])) {
			console.error(`Unsupported event type: ${event.name}`);
			await replyUnsupportedEvent(event.name, event.payload, env);
			return new Response('OK', { status: 200 });
		}

		// Route events to appropriate handlers based on type
		const isUserEvent = USER_EVENTS.includes(event.name as (typeof USER_EVENTS)[number]);
		const isSystemEvent = SYSTEM_EVENTS.includes(event.name as (typeof SYSTEM_EVENTS)[number]);
		if (isUserEvent) {
			await handleUserEvent(event.name, event.payload, env);
		} else if (isSystemEvent) {
			await handleSystemEvent(event.name, event.payload, env);
		} else {
			await handleRepoEvent(event.name, event.payload, env);
		}

		return new Response('OK', { status: 200 });
	} catch (error) {
		console.error(`Webhook error [${getWebhookLogContext(event)}]:`, error);
		return new Response('Internal error', { status: 500 });
	}
}

// User-driven events: issue comments, PR review comments, issues
// These events are triggered by user actions and require:
// - Write access check (for comment events)
// - Reaction to acknowledge the request
// - Rate limiting for non-write users (issues only)
// All user events trigger GitHub Actions workflows
async function handleUserEvent(eventName: string, payload: unknown, env: Env): Promise<void> {
	const p = payload as { installation?: { id?: number } };
	const installationId = p.installation?.id;
	if (!installationId) {
		console.error('No installation ID in payload');
		return;
	}

	switch (eventName) {
		case 'issue_comment':
			await handleIssueComment(payload as IssueCommentEvent, env, installationId);
			break;
		case 'pull_request_review_comment':
			await handlePRReviewComment(payload as PullRequestReviewCommentEvent, env, installationId);
			break;
		case 'issues':
			await handleIssuesEvent(payload as IssuesEvent, env, installationId);
			break;
	}
}

// Repo-driven events: schedule, workflow_dispatch
// These events are triggered by repository automation and:
// - Have no triggering actor to check permissions for
// - Have no comment to react to
// - Are processed by the GitHub Action, not Bonk's sandbox
async function handleRepoEvent(eventName: string, payload: unknown, env: Env): Promise<void> {
	switch (eventName) {
		case 'schedule':
			await handleScheduleEvent(payload as ScheduleEventPayload, env);
			break;
		case 'workflow_dispatch':
			await handleWorkflowDispatchEvent(payload as WorkflowDispatchPayload, env);
			break;
	}
}

// System events: triggered by GitHub itself (workflow_run)
// These events notify us about workflow lifecycle changes
async function handleSystemEvent(eventName: string, payload: unknown, env: Env): Promise<void> {
	switch (eventName) {
		case 'workflow_run':
			await handleWorkflowRunEvent(payload as WorkflowRunRequestedEvent, env);
			break;
	}
}

async function handleIssueComment(payload: IssueCommentEvent, env: Env, installationId: number): Promise<void> {
	const parsed = parseIssueCommentEvent(payload);
	if (!parsed) return;

	await processRequest({
		env,
		installationId,
		context: parsed.context,
		triggerCommentId: parsed.triggerCommentId,
		reactionTarget: 'issue_comment',
		eventType: 'issue_comment',
		commentTimestamp: payload.comment.created_at,
	});
}

async function handlePRReviewComment(payload: PullRequestReviewCommentEvent, env: Env, installationId: number): Promise<void> {
	const parsed = parsePRReviewCommentEvent(payload);
	if (!parsed) return;

	await processRequest({
		env,
		installationId,
		context: parsed.context,
		triggerCommentId: parsed.triggerCommentId,
		reactionTarget: 'pull_request_review_comment',
		eventType: 'pull_request_review_comment',
		commentTimestamp: payload.comment.created_at,
	});
}

// Schedule events are handled by the GitHub Action directly - Bonk webhook just acknowledges
async function handleScheduleEvent(payload: ScheduleEventPayload, env: Env): Promise<void> {
	const parsed = parseScheduleEvent(payload);
	if (!parsed) {
		console.error('Invalid schedule event payload');
		return;
	}

	const logPrefix = `[${parsed.owner}/${parsed.repo}]`;
	console.info(`${logPrefix} Received schedule event: ${parsed.schedule}`);

	// Schedule events don't have an actor or issue context - they are processed by the
	// GitHub Action (sst/opencode/github) which reads the prompt from the workflow file.
	// Bonk's webhook handler acknowledges receipt but does not process these further.
}

// Reply with helpful message when someone mentions Bonk in an unsupported event type
async function replyUnsupportedEvent(eventName: string, payload: unknown, env: Env): Promise<void> {
	const p = payload as {
		installation?: { id?: number };
		repository?: { owner?: { login?: string }; name?: string };
		issue?: { number?: number };
		pull_request?: { number?: number };
		comment?: { body?: string };
		review?: { body?: string };
	};

	// Only post if the event actually mentions Bonk
	const body = p.comment?.body ?? p.review?.body ?? '';
	if (!hasMention(body)) return;

	const installationId = p.installation?.id;
	if (!installationId) return;

	const owner = p.repository?.owner?.login;
	const repo = p.repository?.name;
	const issueNumber = p.issue?.number ?? p.pull_request?.number;
	if (!owner || !repo || !issueNumber) return;

	const octokit = await createOctokit(env, installationId);
	const supportedList = SUPPORTED_EVENTS.map((e) => `\`${e}\``).join(', ');
	await createComment(
		octokit,
		owner,
		repo,
		issueNumber,
		`\`${eventName}\` events aren't currently supported by Bonk. Please ask Bonk from a supported event type: ${supportedList}.`,
	);
}

interface ProcessRequestParams {
	env: Env;
	installationId: number;
	context: {
		owner: string;
		repo: string;
		issueNumber: number;
		commentId: number;
		actor: string;
		isPullRequest: boolean;
		isPrivate: boolean;
		defaultBranch: string;
		headBranch?: string;
		headSha?: string;
		isFork?: boolean;
	};
	triggerCommentId: number;
	reactionTarget: ReactionTarget;
	eventType: string;
	commentTimestamp: string;
}

async function processRequest({
	env,
	installationId,
	context,
	triggerCommentId,
	reactionTarget,
	eventType,
	commentTimestamp,
}: ProcessRequestParams): Promise<void> {
	const logPrefix = `[${context.owner}/${context.repo}#${context.issueNumber}]`;
	const octokit = await createOctokit(env, installationId);

	const canWrite = await hasWriteAccess(octokit, context.owner, context.repo, context.actor);
	if (!canWrite) {
		console.log(`${logPrefix} User ${context.actor} does not have write access`);
		return;
	}

	await createReaction(octokit, context.owner, context.repo, triggerCommentId, '+1', reactionTarget);

	console.info(`${logPrefix} Triggering workflow for ${eventType}`);
	await runWorkflowMode(env, installationId, {
		owner: context.owner,
		repo: context.repo,
		issueNumber: context.issueNumber,
		defaultBranch: context.defaultBranch,
		triggeringActor: context.actor,
		commentTimestamp,
	});
}

// Handle issues events (opened/edited) for triage and automated workflows.
// This is designed for GitHub Actions workflow mode where the workflow itself
// defines the prompt via the `prompt` input and uses `default_agent` for a custom agent.
//
// Supported actions:
// - opened: New issue created
// - edited: Issue edited - filtering is handled by the workflow
async function handleIssuesEvent(payload: IssuesEvent, env: Env, installationId: number): Promise<void> {
	const parsed = parseIssuesEvent(payload);
	if (!parsed) return;

	const logPrefix = `[${parsed.context.owner}/${parsed.context.repo}#${parsed.context.issueNumber}]`;
	const octokit = await createOctokit(env, installationId);

	// Rate limit users WITHOUT write access: 5 requests per 10 minutes per {owner}/{repo}+{username}
	const canWrite = await hasWriteAccess(octokit, parsed.context.owner, parsed.context.repo, parsed.context.actor);
	if (!canWrite) {
		const rateLimitKey = `${parsed.context.owner}/${parsed.context.repo}+${parsed.context.actor}`;
		const { success } = await env.RATE_LIMITER.limit({ key: rateLimitKey });
		if (!success) {
			console.info(`${logPrefix} Rate limited user ${parsed.context.actor}`);
			return;
		}
	}

	await createReaction(octokit, parsed.context.owner, parsed.context.repo, parsed.context.issueNumber, '+1', 'issue');

	console.info(`${logPrefix} Triggering workflow for issues:${payload.action}`);
	await runWorkflowMode(env, installationId, {
		owner: parsed.context.owner,
		repo: parsed.context.repo,
		issueNumber: parsed.context.issueNumber,
		defaultBranch: parsed.context.defaultBranch,
		triggeringActor: parsed.context.actor,
		commentTimestamp: payload.issue.created_at,
		issueTitle: parsed.issueTitle,
		issueBody: parsed.issueBody,
	});
}

// Handle workflow_dispatch events for manual workflow triggers.
// Similar to schedule events, the prompt comes from the workflow file's `prompt` input.
async function handleWorkflowDispatchEvent(payload: WorkflowDispatchPayload, env: Env): Promise<void> {
	const parsed = parseWorkflowDispatchEvent(payload);
	if (!parsed) {
		console.error('Invalid workflow_dispatch event payload');
		return;
	}

	const logPrefix = `[${parsed.owner}/${parsed.repo}]`;
	console.info(`${logPrefix} Received workflow_dispatch event from ${parsed.sender}`);

	// workflow_dispatch events are processed by the GitHub Action (sst/opencode/github)
	// which reads the prompt from the workflow file inputs.
	// Bonk's webhook handler acknowledges receipt but does not process these further.
}

// Handle workflow_run events to track Bonk workflow runs.
// When a bonk.yml workflow starts (action: requested), we track it via RepoAgent
// so we can post failure comments if the workflow fails.
async function handleWorkflowRunEvent(payload: WorkflowRunRequestedEvent, env: Env): Promise<void> {
	// Only process 'requested' action (workflow started)
	if (payload.action !== 'requested') {
		return;
	}

	const workflowRun = payload.workflow_run;
	const workflowName = payload.workflow?.name ?? workflowRun.name;

	// Only track bonk.yml workflows
	if (!workflowName?.toLowerCase().includes('bonk')) {
		return;
	}

	const owner = payload.repository.owner.login;
	const repo = payload.repository.name;
	const runId = workflowRun.id;
	const runUrl = workflowRun.html_url;
	const logPrefix = `[${owner}/${repo}]`;

	console.info(`${logPrefix} Workflow run ${runId} started (${workflowName})`);

	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error(`${logPrefix} No installation ID in workflow_run event`);
		return;
	}

	// Get or create RepoAgent for this repo
	const agent = await getAgentByName<Env, RepoAgent>(env.REPO_AGENT, `${owner}/${repo}`);
	await agent.setInstallationId(installationId);

	// Try to get issue number from multiple sources:
	// 1. Pull requests array (for PR-triggered runs)
	// 2. Pending workflow from RepoAgent (stored by runWorkflowMode when user comments)
	let issueNumber: number | undefined = workflowRun.pull_requests?.[0]?.number;

	if (!issueNumber) {
		// Look up the pending workflow using actor
		const actor = workflowRun.triggering_actor?.login ?? workflowRun.actor?.login;

		if (actor) {
			const pending = await agent.consumePendingWorkflow(actor);
			if (pending) {
				issueNumber = pending.issueNumber;
				console.info(`${logPrefix} Found pending workflow for issue #${issueNumber}`);
			}
		}
	}

	if (!issueNumber) {
		console.info(`${logPrefix} No issue number found for workflow run ${runId}, skipping tracking`);
		return;
	}

	// Track this run via RepoAgent for failure notifications
	await agent.trackRun(runId, runUrl, issueNumber);

	console.info(`${logPrefix} Now tracking workflow run ${runId} for issue #${issueNumber}`);
}
