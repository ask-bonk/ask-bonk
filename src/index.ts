import { Hono } from 'hono';
import type { IssueCommentEvent, PullRequestReviewCommentEvent } from '@octokit/webhooks-types';
import type { BonkMode, Env } from './types';
import {
	createOctokit,
	createGraphQL,
	createWebhooks,
	verifyWebhook,
	hasWriteAccess,
	createComment,
	updateComment,
	createPullRequest,
	getRepository,
	fetchIssue,
	fetchPullRequest,
	buildIssueContext,
	buildPRContext,
	getInstallationToken,
	createReaction,
	type CommentType,
} from './github';
import { parseIssueCommentEvent, parsePRReviewCommentEvent, getModel, formatResponse } from './events';
import { extractImages } from './images';
import { runOpencodeSandbox, type SandboxResult } from './sandbox';
import { runWorkflowMode } from './workflow';
import { handleGetInstallation, handleExchangeToken, handleExchangeTokenWithPAT } from './oidc';

export { Sandbox } from '@cloudflare/sandbox';
export { RepoActor } from './actors';

const GITHUB_REPO_URL = 'https://github.com/elithrar/ask-bonk';

const SUPPORTED_EVENTS = ['issue_comment', 'pull_request_review_comment'] as const;

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.redirect(GITHUB_REPO_URL, 302));
app.get('/health', (c) => c.text('OK'));
app.post('/webhooks', async (c) => {
	return handleWebhook(c.req.raw, c.env);
});

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

		switch (event.name) {
			case 'issue_comment':
				await handleIssueComment(event.payload as IssueCommentEvent, env);
				break;
			case 'pull_request_review_comment':
				await handlePRReviewComment(event.payload as PullRequestReviewCommentEvent, env);
				break;
		}

		return new Response('OK', { status: 200 });
	} catch (error) {
		console.error(`Webhook error [${getWebhookLogContext(event)}]:`, error);
		return new Response('Internal error', { status: 500 });
	}
}

async function handleIssueComment(payload: IssueCommentEvent, env: Env): Promise<void> {
	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error('No installation ID in payload');
		return;
	}

	const parsed = parseIssueCommentEvent(payload);
	if (!parsed) return;

	await processRequest({
		env,
		installationId,
		context: parsed.context,
		prompt: parsed.prompt,
		triggerCommentId: parsed.triggerCommentId,
		commentType: 'issue_comment',
		eventType: 'issue_comment',
		commentTimestamp: payload.comment.created_at,
	});
}

async function handlePRReviewComment(payload: PullRequestReviewCommentEvent, env: Env): Promise<void> {
	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error('No installation ID in payload');
		return;
	}

	const parsed = parsePRReviewCommentEvent(payload);
	if (!parsed) return;

	await processRequest({
		env,
		installationId,
		context: parsed.context,
		prompt: parsed.prompt,
		triggerCommentId: parsed.triggerCommentId,
		commentType: 'pull_request_review_comment',
		eventType: 'pull_request_review_comment',
		commentTimestamp: payload.comment.created_at,
	});
}

async function replyUnsupportedEvent(eventName: string, payload: unknown, env: Env): Promise<void> {
	const p = payload as {
		installation?: { id?: number };
		repository?: { owner?: { login?: string }; name?: string };
		issue?: { number?: number };
		pull_request?: { number?: number };
	};
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
	prompt: string;
	triggerCommentId: number;
	commentType: CommentType;
	eventType: string;
	commentTimestamp: string;
}

function getBonkMode(env: Env): BonkMode {
	return env.BONK_MODE ?? 'sandbox_sdk';
}

async function processRequest({
	env,
	installationId,
	context,
	prompt,
	triggerCommentId,
	commentType,
	eventType,
	commentTimestamp,
}: ProcessRequestParams): Promise<void> {
	const logPrefix = `[${context.owner}/${context.repo}#${context.issueNumber}]`;
	const mode = getBonkMode(env);
	const octokit = await createOctokit(env, installationId);

	const canWrite = await hasWriteAccess(octokit, context.owner, context.repo, context.actor);
	if (!canWrite) {
		console.log(`${logPrefix} User ${context.actor} does not have write access`);
		return;
	}

	// Add thumbs up reaction to acknowledge the request
	await createReaction(octokit, context.owner, context.repo, triggerCommentId, '+1', commentType);

	if (mode === 'github_workflow') {
		// Workflow mode: only react, don't comment unless there's a failure
		console.info(`${logPrefix} Running in workflow mode`);
		await runWorkflowMode(env, installationId, {
			owner: context.owner,
			repo: context.repo,
			issueNumber: context.issueNumber,
			defaultBranch: context.defaultBranch,
			triggeringActor: context.actor,
			eventType,
			commentTimestamp,
		});
		return;
	}

	const responseCommentId = await createComment(octokit, context.owner, context.repo, context.issueNumber, 'Bonk is working on it...');
	console.info(`${logPrefix} Created working comment: ${responseCommentId}, mode: ${mode}`);

	await processSandboxRequest({
		env,
		installationId,
		context,
		prompt,
		triggerCommentId,
		commentType,
		responseCommentId,
		eventType,
		commentTimestamp,
	});
}

interface ProcessSandboxParams extends ProcessRequestParams {
	responseCommentId: number;
}

async function processSandboxRequest({
	env,
	installationId,
	context,
	prompt,
	triggerCommentId,
	responseCommentId,
}: ProcessSandboxParams): Promise<void> {
	const logPrefix = `[${context.owner}/${context.repo}#${context.issueNumber}]`;
	const octokit = await createOctokit(env, installationId);
	const gql = await createGraphQL(env, installationId);

	try {
		const repoData = await getRepository(octokit, context.owner, context.repo);
		const modelConfig = getModel(env);
		const modelString = `${modelConfig.providerID}/${modelConfig.modelID}`;
		const token = await getInstallationToken(env, installationId);
		const { processedBody: processedPrompt, images } = await extractImages(prompt, token);

		let dataContext: string;
		if (context.isPullRequest) {
			const prData = await fetchPullRequest(gql, context.owner, context.repo, context.issueNumber);
			if (prData.headRepository.nameWithOwner !== prData.baseRepository.nameWithOwner) {
				await updateComment(octokit, context.owner, context.repo, responseCommentId, 'Fork PRs are not supported.');
				return;
			}

			context.headBranch = prData.headRefName;
			context.headSha = prData.headRefOid;
			dataContext = buildPRContext(prData, [triggerCommentId, responseCommentId]);
		} else {
			const issueData = await fetchIssue(gql, context.owner, context.repo, context.issueNumber);
			dataContext = buildIssueContext(issueData, [triggerCommentId, responseCommentId]);
		}

		let result: SandboxResult;
		let lastError: Error | null = null;
		const maxRetries = 3;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				result = await runOpencodeSandbox({
					env,
					owner: context.owner,
					repo: context.repo,
					branch: context.headBranch ?? context.defaultBranch,
					prompt: `${processedPrompt}\n\n${dataContext}`,
					images,
					modelConfig,
					token,
					isPrivate: repoData.private,
					actor: context.actor,
					isPullRequest: context.isPullRequest,
					issueNumber: context.issueNumber,
				});
				lastError = null;
				break;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				console.error(`${logPrefix} Sandbox attempt ${attempt}/${maxRetries} failed:`, lastError.message);

				if (attempt < maxRetries) {
					await new Promise((resolve) => setTimeout(resolve, 15000));
				}
			}
		}

		if (lastError) {
			console.error(`${logPrefix} Sandbox failed after all retries:`, lastError);
			await updateComment(octokit, context.owner, context.repo, responseCommentId, `Bonk failed\n\n\`\`\`\n${lastError.message}\n\`\`\``);
			return;
		}

		const response = formatResponse(result!.response, result!.changedFiles, result!.sessionLink, modelString);
		console.info(`${logPrefix} Updating comment with response`);
		await updateComment(octokit, context.owner, context.repo, responseCommentId, response);

		if (!context.isPullRequest && result!.changedFiles && result!.changedFiles.length > 0 && result!.newBranch) {
			console.info(`${logPrefix} Creating PR from branch ${result!.newBranch}`);
			const prNumber = await createPullRequest(
				octokit,
				context.owner,
				context.repo,
				result!.newBranch,
				context.defaultBranch,
				result!.summary || `Fix issue #${context.issueNumber}`,
				`${result!.response}\n\nCloses #${context.issueNumber}`,
			);

			const prLink = `https://github.com/${context.owner}/${context.repo}/pull/${prNumber}`;
			console.info(`${logPrefix} Created PR #${prNumber}, updating comment`);
			await updateComment(octokit, context.owner, context.repo, responseCommentId, `Bonk created PR: ${prLink}`);
		}
	} catch (error) {
		console.error(`${logPrefix} Error processing request:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		await updateComment(octokit, context.owner, context.repo, responseCommentId, `Bonk failed\n\n\`\`\`\n${errorMessage}\n\`\`\``);
	}
}
