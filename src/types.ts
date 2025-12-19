import type { Sandbox } from "@cloudflare/sandbox";
import type { RepoActor } from "./actors";

// Bonk operational mode
export type BonkMode = "sandbox_sdk" | "github_workflow";

// Environment bindings
export interface Env {
	Sandbox: DurableObjectNamespace<Sandbox>;
	REPO_ACTOR: DurableObjectNamespace<RepoActor>;
	APP_INSTALLATIONS: KVNamespace;
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	OPENCODE_API_KEY: string;
	DEFAULT_MODEL?: string;
	BONK_MODE?: BonkMode;
}



// Context passed through event handling
export interface EventContext {
	env: Env;
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
}

// Image data extracted from comments
export interface ImageData {
	filename: string;
	mime: string;
	content: string;
	start: number;
	end: number;
	replacement: string;
}

// GraphQL response types for issues
export interface GitHubAuthor {
	login: string;
	name?: string;
}

export interface GitHubComment {
	id: string;
	databaseId: string;
	body: string;
	author: GitHubAuthor;
	createdAt: string;
}

export interface GitHubReviewComment extends GitHubComment {
	path: string;
	line: number | null;
}

export interface GitHubIssue {
	title: string;
	body: string;
	author: GitHubAuthor;
	createdAt: string;
	state: string;
	comments: {
		nodes: GitHubComment[];
	};
}

export interface GitHubCommit {
	oid: string;
	message: string;
	author: {
		name: string;
		email: string;
	};
}

export interface GitHubFile {
	path: string;
	additions: number;
	deletions: number;
	changeType: string;
}

export interface GitHubReview {
	id: string;
	databaseId: string;
	author: GitHubAuthor;
	body: string;
	state: string;
	submittedAt: string;
	comments: {
		nodes: GitHubReviewComment[];
	};
}

export interface GitHubPullRequest {
	title: string;
	body: string;
	author: GitHubAuthor;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
	createdAt: string;
	additions: number;
	deletions: number;
	state: string;
	baseRepository: {
		nameWithOwner: string;
	};
	headRepository: {
		nameWithOwner: string;
	};
	commits: {
		totalCount: number;
		nodes: Array<{
			commit: GitHubCommit;
		}>;
	};
	files: {
		nodes: GitHubFile[];
	};
	comments: {
		nodes: GitHubComment[];
	};
	reviews: {
		nodes: GitHubReview[];
	};
}

export interface IssueQueryResponse {
	repository: {
		issue: GitHubIssue;
	};
}

export interface PullRequestQueryResponse {
	repository: {
		pullRequest: GitHubPullRequest;
	};
}

// Review comment context for PR line comments
export interface ReviewCommentContext {
	file: string;
	diffHunk: string;
	line: number | null;
	originalLine: number | null;
	position: number | null;
	commitId: string;
	originalCommitId: string;
}
