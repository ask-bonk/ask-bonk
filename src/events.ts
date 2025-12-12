import type {
	IssueCommentEvent,
	PullRequestReviewCommentEvent,
	PullRequestReviewEvent,
} from "@octokit/webhooks-types";
import type { Env, EventContext, ReviewCommentContext } from "./types";

// Mention patterns
const BOT_MENTION = "@ask-bonk";
const BOT_COMMAND = "/bonk";
const MENTION_PATTERN = new RegExp(`(?:^|\\s)(?:${BOT_MENTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${BOT_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|\\s)`);

// Check if a comment body contains a mention
export function hasMention(body: string): boolean {
	return MENTION_PATTERN.test(body.trim());
}

// Extract the prompt from comment body
export function extractPrompt(body: string, reviewContext?: ReviewCommentContext): string {
	const trimmed = body.trim();

	// If body is just the mention/command, provide default behavior
	if (trimmed === BOT_MENTION || trimmed === BOT_COMMAND) {
		if (reviewContext) {
			return `Review this code change and suggest improvements for the commented lines:\n\nFile: ${reviewContext.file}\nLines: ${reviewContext.line}\n\n${reviewContext.diffHunk}`;
		}
		return "Summarize this thread";
	}

	// Include review context if available
	if (reviewContext) {
		return `${trimmed}\n\nContext: You are reviewing a comment on file "${reviewContext.file}" at line ${reviewContext.line}.\n\nDiff context:\n${reviewContext.diffHunk}`;
	}

	return trimmed;
}

// Extract review comment context from PR review comment event
export function getReviewCommentContext(
	payload: PullRequestReviewCommentEvent
): ReviewCommentContext {
	return {
		file: payload.comment.path,
		diffHunk: payload.comment.diff_hunk,
		line: payload.comment.line ?? null,
		originalLine: payload.comment.original_line ?? null,
		position: payload.comment.position ?? null,
		commitId: payload.comment.commit_id,
		originalCommitId: payload.comment.original_commit_id,
	};
}

// Check if PR is from a fork
export function isForkPR(payload: IssueCommentEvent | PullRequestReviewCommentEvent | PullRequestReviewEvent): boolean {
	if ("pull_request" in payload && payload.pull_request) {
		const pr = payload.pull_request;
		if ("head" in pr && "base" in pr) {
			const head = pr.head as { repo?: { full_name?: string } };
			const base = pr.base as { repo?: { full_name?: string } };
			return head.repo?.full_name !== base.repo?.full_name;
		}
	}
	return false;
}

// Parse issue_comment event
export function parseIssueCommentEvent(payload: IssueCommentEvent): {
	context: Omit<EventContext, "env">;
	prompt: string;
	triggerCommentId: number;
} | null {
	// Only handle created comments
	if (payload.action !== "created") {
		return null;
	}

	// Check for mention
	if (!hasMention(payload.comment.body)) {
		return null;
	}

	const isPullRequest = Boolean(payload.issue.pull_request);

	return {
		context: {
			owner: payload.repository.owner.login,
			repo: payload.repository.name,
			issueNumber: payload.issue.number,
			commentId: 0, // Will be set after creating response comment
			actor: payload.comment.user.login,
			isPullRequest,
			isPrivate: payload.repository.private,
			defaultBranch: payload.repository.default_branch,
		},
		prompt: extractPrompt(payload.comment.body),
		triggerCommentId: payload.comment.id,
	};
}

// Parse pull_request_review_comment event
export function parsePRReviewCommentEvent(payload: PullRequestReviewCommentEvent): {
	context: Omit<EventContext, "env">;
	prompt: string;
	triggerCommentId: number;
	reviewContext: ReviewCommentContext;
} | null {
	// Only handle created comments
	if (payload.action !== "created") {
		return null;
	}

	// Check for mention
	if (!hasMention(payload.comment.body)) {
		return null;
	}

	// Check for fork PR
	if (isForkPR(payload)) {
		return null;
	}

	const reviewContext = getReviewCommentContext(payload);

	return {
		context: {
			owner: payload.repository.owner.login,
			repo: payload.repository.name,
			issueNumber: payload.pull_request.number,
			commentId: 0,
			actor: payload.comment.user.login,
			isPullRequest: true,
			isPrivate: payload.repository.private,
			defaultBranch: payload.repository.default_branch,
			headBranch: payload.pull_request.head.ref,
			headSha: payload.pull_request.head.sha,
			isFork: false,
		},
		prompt: extractPrompt(payload.comment.body, reviewContext),
		triggerCommentId: payload.comment.id,
		reviewContext,
	};
}

// Parse pull_request_review event
export function parsePRReviewEvent(payload: PullRequestReviewEvent): {
	context: Omit<EventContext, "env">;
	prompt: string;
	triggerCommentId: number;
} | null {
	// Only handle submitted reviews
	if (payload.action !== "submitted") {
		return null;
	}

	// Check for mention in review body
	if (!payload.review.body || !hasMention(payload.review.body)) {
		return null;
	}

	// Check for fork PR
	if (isForkPR(payload)) {
		return null;
	}

	return {
		context: {
			owner: payload.repository.owner.login,
			repo: payload.repository.name,
			issueNumber: payload.pull_request.number,
			commentId: 0,
			actor: payload.review.user.login,
			isPullRequest: true,
			isPrivate: payload.repository.private,
			defaultBranch: payload.repository.default_branch,
			headBranch: payload.pull_request.head.ref,
			headSha: payload.pull_request.head.sha,
			isFork: false,
		},
		prompt: extractPrompt(payload.review.body),
		triggerCommentId: payload.review.id,
	};
}

// Get model configuration from environment
export function getModel(env: Env): { providerID: string; modelID: string } {
	const model = env.DEFAULT_MODEL ?? "anthropic/claude-sonnet-4-20250514";
	const [providerID, ...rest] = model.split("/");
	const modelID = rest.join("/");

	if (!providerID?.length || !modelID.length) {
		throw new Error(
			`Invalid model ${model}. Model must be in the format "provider/model".`
		);
	}

	return { providerID, modelID };
}

// Format response with optional session link
export function formatResponse(
	response: string,
	changedFiles: string[] | null,
	sessionLink: string | null,
	model: string
): string {
	const parts: string[] = [response];

	if (changedFiles && changedFiles.length > 0) {
		parts.push("");
		parts.push("<details>");
		parts.push("<summary>Files changed</summary>");
		parts.push("");
		for (const file of changedFiles) {
			parts.push(`- \`${file}\``);
		}
		parts.push("");
		parts.push("</details>");
	}

	parts.push("");
	parts.push("---");

	const footerParts: string[] = [];
	if (sessionLink) {
		footerParts.push(`[View session](${sessionLink})`);
	}
	footerParts.push(`\`${model}\``);

	parts.push(footerParts.join(" | "));

	return parts.join("\n");
}

// Generate branch name for new branches
export function generateBranchName(type: "issue" | "pr", issueNumber: number): string {
	const timestamp = new Date()
		.toISOString()
		.replace(/[:-]/g, "")
		.replace(/\.\d{3}Z/, "")
		.split("T")
		.join("");
	return `bonk/${type}${issueNumber}-${timestamp}`;
}
