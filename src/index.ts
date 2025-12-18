import { Hono } from 'hono';
import type { IssueCommentEvent, PullRequestReviewCommentEvent, PullRequestReviewEvent } from '@octokit/webhooks-types';
import type { BonkMode, Env } from './types';
import {
	createOctokit,
	createGraphQL,
	createWebhooks,
	verifyWebhook,
	hasWriteAccess,
	createComment,
	createReaction,
	createPullRequest,
	getRepository,
	fetchIssue,
	fetchPullRequest,
	buildIssueContext,
	buildPRContext,
	getInstallationToken,
} from "./github";
import { parseIssueCommentEvent, parsePRReviewCommentEvent, parsePRReviewEvent, getModel, formatResponse } from './events';
import { extractImages } from './images';
import { runOpencodeSandbox, type SandboxResult } from './sandbox';
import { runWorkflowMode } from './workflow';

export { Sandbox } from '@cloudflare/sandbox';
export { RepoActor } from './actors';

const GITHUB_REPO_URL = 'https://github.com/elithrar/ask-bonk';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.redirect(GITHUB_REPO_URL, 302));
app.get('/health', (c) => c.text('OK'));
app.post('/webhooks', async (c) => {
	return handleWebhook(c.req.raw, c.env);
});

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
		switch (event.name) {
			case 'issue_comment':
				await handleIssueComment(event.payload as IssueCommentEvent, env);
				break;

			case 'pull_request_review_comment':
				await handlePRReviewComment(event.payload as PullRequestReviewCommentEvent, env);
				break;

			case 'pull_request_review':
				await handlePRReview(event.payload as PullRequestReviewEvent, env);
				break;

			default:
				return new Response('Event not handled', { status: 200 });
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
		eventType: 'pull_request_review_comment',
		commentTimestamp: payload.comment.created_at,
	});
}

async function handlePRReview(payload: PullRequestReviewEvent, env: Env): Promise<void> {
	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error('No installation ID in payload');
		return;
	}

	const parsed = parsePRReviewEvent(payload);
	if (!parsed) return;

	await processRequest({
		env,
		installationId,
		context: parsed.context,
		prompt: parsed.prompt,
		triggerCommentId: parsed.triggerCommentId,
		eventType: 'pull_request_review',
		commentTimestamp: payload.review.submitted_at ?? new Date().toISOString(),
	});
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

	// React to the triggering comment with eyes emoji to acknowledge the request
	await createReaction(octokit, context.owner, context.repo, triggerCommentId, 'eyes');
	console.info(`${logPrefix} Added eyes reaction to comment: ${triggerCommentId}, mode: ${mode}`);

	if (mode === 'github_workflow') {
		await runWorkflowMode(env, installationId, {
			owner: context.owner,
			repo: context.repo,
			issueNumber: context.issueNumber,
			defaultBranch: context.defaultBranch,
			triggerCommentId,
			triggeringActor: context.actor,
			eventType,
			commentTimestamp,
		});
		return;
	}

	await processSandboxRequest({
		env,
		installationId,
		context,
		prompt,
		triggerCommentId,
		eventType,
		commentTimestamp,
	});
}

async function processSandboxRequest({
	env,
	installationId,
	context,
	prompt,
	triggerCommentId,
}: ProcessRequestParams): Promise<void> {
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
				await createComment(octokit, context.owner, context.repo, context.issueNumber, 'Fork PRs are not supported.');
				return;
			}

			context.headBranch = prData.headRefName;
			context.headSha = prData.headRefOid;
			dataContext = buildPRContext(prData, [triggerCommentId]);
		} else {
			const issueData = await fetchIssue(gql, context.owner, context.repo, context.issueNumber);
			dataContext = buildIssueContext(issueData, [triggerCommentId]);
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
			await createComment(octokit, context.owner, context.repo, context.issueNumber, `Bonk failed\n\n\`\`\`\n${lastError.message}\n\`\`\``);
			return;
		}

		const response = formatResponse(result!.response, result!.changedFiles, result!.sessionLink, modelString);
		console.info(`${logPrefix} Creating comment with response`);
		await createComment(octokit, context.owner, context.repo, context.issueNumber, response);

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
			console.info(`${logPrefix} Created PR #${prNumber}`);
		}
	} catch (error) {
		console.error(`${logPrefix} Error processing request:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		await createComment(octokit, context.owner, context.repo, context.issueNumber, `Bonk failed\n\n\`\`\`\n${errorMessage}\n\`\`\``);
	}
}
