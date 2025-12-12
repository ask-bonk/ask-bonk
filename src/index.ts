import { Hono } from "hono";
import type {
	IssueCommentEvent,
	PullRequestReviewCommentEvent,
	PullRequestReviewEvent,
} from "@octokit/webhooks-types";
import type { BonkMode, Env } from "./types";
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
} from "./github";
import {
	parseIssueCommentEvent,
	parsePRReviewCommentEvent,
	parsePRReviewEvent,
	getModel,
	formatResponse,
} from "./events";
import { extractImages } from "./images";
import { runOpencodeSandbox, type SandboxResult } from "./sandbox";
import { runWorkflowMode } from "./workflow";

export { Sandbox } from "@cloudflare/sandbox";
export { RepoActor } from "./actors";

const GITHUB_REPO_URL = "https://github.com/elithrar/ask-bonk";

const app = new Hono<{ Bindings: Env }>();

// Redirect to GitHub repo
app.get("/", (c) => c.redirect(GITHUB_REPO_URL, 302));

// Health check
app.get("/health", (c) => c.text("OK"));

// Webhook endpoint
app.post("/webhooks", async (c) => {
	return handleWebhook(c.req.raw, c.env);
});

export default app;

function getWebhookLogContext(event: { name: string; payload: unknown }): string {
	const payload = event.payload as Record<string, unknown>;
	const repo = payload.repository as { owner?: { login?: string }; name?: string } | undefined;
	const owner = repo?.owner?.login ?? "unknown";
	const repoName = repo?.name ?? "unknown";
	const issue = payload.issue as { number?: number } | undefined;
	const pr = payload.pull_request as { number?: number } | undefined;
	const num = issue?.number ?? pr?.number ?? "?";
	return `${owner}/${repoName} - ${event.name} - #${num}`;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const webhooks = createWebhooks(env);

	// Verify webhook signature
	const event = await verifyWebhook(webhooks, request);
	if (!event) {
		console.error("Webhook signature verification failed");
		return new Response("Invalid signature", { status: 401 });
	}

	console.info(`Webhook: ${getWebhookLogContext(event)}`);

	// Handle supported events
	try {
		switch (event.name) {
			case "issue_comment":
				await handleIssueComment(event.payload as IssueCommentEvent, env);
				break;

			case "pull_request_review_comment":
				await handlePRReviewComment(event.payload as PullRequestReviewCommentEvent, env);
				break;

			case "pull_request_review":
				await handlePRReview(event.payload as PullRequestReviewEvent, env);
				break;

			default:
				return new Response("Event not handled", { status: 200 });
		}

		return new Response("OK", { status: 200 });
	} catch (error) {
		console.error(`Webhook error [${getWebhookLogContext(event)}]:`, error);
		return new Response("Internal error", { status: 500 });
	}
}

async function handleIssueComment(payload: IssueCommentEvent, env: Env): Promise<void> {
	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error("No installation ID in payload");
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
		eventType: "issue_comment",
		commentTimestamp: payload.comment.created_at,
	});
}

async function handlePRReviewComment(payload: PullRequestReviewCommentEvent, env: Env): Promise<void> {
	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error("No installation ID in payload");
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
		eventType: "pull_request_review_comment",
		commentTimestamp: payload.comment.created_at,
	});
}

async function handlePRReview(payload: PullRequestReviewEvent, env: Env): Promise<void> {
	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error("No installation ID in payload");
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
		eventType: "pull_request_review",
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

// Get the operational mode from environment
function getBonkMode(env: Env): BonkMode {
	return env.BONK_MODE ?? "sandbox_sdk";
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

	// Check permissions
	const canWrite = await hasWriteAccess(octokit, context.owner, context.repo, context.actor);
	if (!canWrite) {
		console.log(`${logPrefix} User ${context.actor} does not have write access`);
		return;
	}

	// Create initial "working" comment
	const responseCommentId = await createComment(
		octokit,
		context.owner,
		context.repo,
		context.issueNumber,
		"Bonk is working on it..."
	);
	console.info(`${logPrefix} Created working comment: ${responseCommentId}, mode: ${mode}`);

	// Switch based on mode
	if (mode === "github_workflow") {
		await runWorkflowMode(env, installationId, {
			owner: context.owner,
			repo: context.repo,
			issueNumber: context.issueNumber,
			defaultBranch: context.defaultBranch,
			responseCommentId,
			triggeringActor: context.actor,
			eventType,
			commentTimestamp,
		});
		return;
	}

	// Default: sandbox_sdk mode
	await processSandboxRequest({
		env,
		installationId,
		context,
		prompt,
		triggerCommentId,
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
		// Get repository info
		const repoData = await getRepository(octokit, context.owner, context.repo);

		// Get model configuration (uses DEFAULT_MODEL env var)
		const modelConfig = getModel(env);
		const modelString = `${modelConfig.providerID}/${modelConfig.modelID}`;

		// Get installation token for git operations
		const token = await getInstallationToken(env, installationId);

		// Process images in prompt
		const { processedBody: processedPrompt, images } = await extractImages(prompt, token);

		// Build context from issue/PR data
		let dataContext: string;
		if (context.isPullRequest) {
			const prData = await fetchPullRequest(gql, context.owner, context.repo, context.issueNumber);

			// Check if fork PR
			if (prData.headRepository.nameWithOwner !== prData.baseRepository.nameWithOwner) {
				await updateComment(octokit, context.owner, context.repo, responseCommentId, "Fork PRs are not supported.");
				return;
			}

			context.headBranch = prData.headRefName;
			context.headSha = prData.headRefOid;
			dataContext = buildPRContext(prData, [triggerCommentId, responseCommentId]);
		} else {
			const issueData = await fetchIssue(gql, context.owner, context.repo, context.issueNumber);
			dataContext = buildIssueContext(issueData, [triggerCommentId, responseCommentId]);
		}

		// Run OpenCode in sandbox with retry
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
			await updateComment(
				octokit,
				context.owner,
				context.repo,
				responseCommentId,
				`Bonk failed\n\n\`\`\`\n${lastError.message}\n\`\`\``
			);
			return;
		}

		// Update comment with result
		const response = formatResponse(result!.response, result!.changedFiles, result!.sessionLink, modelString);
		console.info(`${logPrefix} Updating comment with response`);
		await updateComment(octokit, context.owner, context.repo, responseCommentId, response);

		// Create PR if on issue and changes were made
		if (!context.isPullRequest && result!.changedFiles && result!.changedFiles.length > 0 && result!.newBranch) {
			console.info(`${logPrefix} Creating PR from branch ${result!.newBranch}`);
			const prNumber = await createPullRequest(
				octokit,
				context.owner,
				context.repo,
				result!.newBranch,
				context.defaultBranch,
				result!.summary || `Fix issue #${context.issueNumber}`,
				`${result!.response}\n\nCloses #${context.issueNumber}`
			);

			const prLink = `https://github.com/${context.owner}/${context.repo}/pull/${prNumber}`;
			console.info(`${logPrefix} Created PR #${prNumber}, updating comment`);
			await updateComment(octokit, context.owner, context.repo, responseCommentId, `Bonk created PR: ${prLink}`);
		}
	} catch (error) {
		console.error(`${logPrefix} Error processing request:`, error);
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		await updateComment(
			octokit,
			context.owner,
			context.repo,
			responseCommentId,
			`Bonk failed\n\n\`\`\`\n${errorMessage}\n\`\`\``
		);
	}
}
