import type { Octokit } from "@octokit/rest";
import type { Env } from "./types";
import {
	createOctokit,
	fileExists,
	getDefaultBranchSha,
	createBranch,
	createOrUpdateFile,
	createPullRequest,
	findOpenPR,
	findWorkflowRun,
	updateComment,
} from "./github";

const WORKFLOW_FILE_PATH = ".github/workflows/bonk.yml";
const WORKFLOW_BRANCH = "bonk/add-workflow-file";

export interface WorkflowContext {
	owner: string;
	repo: string;
	issueNumber: number;
	defaultBranch: string;
	responseCommentId: number;
	triggeringActor: string;
	eventType: string;
	commentTimestamp: string;
}

export interface WorkflowResult {
	success: boolean;
	message: string;
	prUrl?: string;
}

// Mention patterns (must match events.ts)
const BOT_MENTION = "@ask-bonk";
const BOT_COMMAND = "/bonk";

/**
 * Generate the workflow file content using sst/opencode/github@latest
 */
function generateWorkflowContent(): string {
	return `name: Bonk

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

jobs:
  bonk:
    if: |
      (github.event_name == 'issue_comment' && (contains(github.event.comment.body, '${BOT_MENTION}') || contains(github.event.comment.body, '${BOT_COMMAND}'))) ||
      (github.event_name == 'pull_request_review_comment' && (contains(github.event.comment.body, '${BOT_MENTION}') || contains(github.event.comment.body, '${BOT_COMMAND}'))) ||
      (github.event_name == 'pull_request_review' && (contains(github.event.review.body, '${BOT_MENTION}') || contains(github.event.review.body, '${BOT_COMMAND}')))
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: write
      issues: write
      pull-requests: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Run Bonk
        uses: sst/opencode/github@latest
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-sonnet-4-20250514
`;
}



/**
 * Handle workflow mode: check for workflow file, create PR if missing, or track workflow run
 */
export async function runWorkflowMode(
	env: Env,
	installationId: number,
	context: WorkflowContext
): Promise<WorkflowResult> {
	const {
		owner,
		repo,
		issueNumber,
		defaultBranch,
		responseCommentId,
		triggeringActor,
		eventType,
		commentTimestamp,
	} = context;
	const logPrefix = `[${owner}/${repo}#${issueNumber}]`;
	const octokit = await createOctokit(env, installationId);

	// Check if workflow file exists
	const hasWorkflow = await fileExists(octokit, owner, repo, WORKFLOW_FILE_PATH);

	if (!hasWorkflow) {
		console.info(`${logPrefix} Workflow file not found, creating PR`);
		return await createWorkflowPR(octokit, owner, repo, defaultBranch, responseCommentId);
	}

	// Workflow exists - GitHub triggers it automatically via the comment event
	// Our job: find the run and hand off to RepoActor for completion tracking
	console.info(`${logPrefix} Polling for workflow run`);

	const run = await findWorkflowRun(
		octokit,
		owner,
		repo,
		"bonk.yml",
		eventType,
		triggeringActor,
		commentTimestamp
	);

	if (run) {
		console.info(`${logPrefix} Found workflow run ${run.id}`);

		// Update comment with workflow link
		await updateComment(
			octokit,
			owner,
			repo,
			responseCommentId,
			`Bonk is working on it...\n\n[View workflow run](${run.url})`
		);

		// Hand off to RepoActor for completion tracking
		const actorId = env.REPO_ACTOR.idFromName(`${owner}/${repo}`);
		const actor = env.REPO_ACTOR.get(actorId);

		await actor.setInstallationId(installationId);
		await actor.trackRun(responseCommentId, run.id, run.url, issueNumber);

		return {
			success: true,
			message: `Tracking workflow run ${run.id}`,
		};
	} else {
		console.warn(`${logPrefix} Could not find workflow run, falling back to Actions link`);

		// Fallback: link to Actions tab
		await updateComment(
			octokit,
			owner,
			repo,
			responseCommentId,
			`Bonk is working on it...\n\n[View Actions](https://github.com/${owner}/${repo}/actions)`
		);

		return {
			success: true,
			message: "Workflow triggered (run not found, linked to Actions tab)",
		};
	}
}

/**
 * Create a PR with the workflow file (and config if missing)
 */
async function createWorkflowPR(
	octokit: Octokit,
	owner: string,
	repo: string,
	defaultBranch: string,
	responseCommentId: number
): Promise<WorkflowResult> {
	// Check if PR already exists
	const existingPR = await findOpenPR(octokit, owner, repo, WORKFLOW_BRANCH);
	if (existingPR) {
		await updateComment(
			octokit,
			owner,
			repo,
			responseCommentId,
			`Please merge PR #${existingPR.number} first for Bonk to run workflows.\n\n${existingPR.url}`
		);

		return {
			success: false,
			message: `PR already exists: #${existingPR.number}`,
			prUrl: existingPR.url,
		};
	}

	// Get default branch SHA
	const baseSha = await getDefaultBranchSha(octokit, owner, repo, defaultBranch);

	// Create new branch
	try {
		await createBranch(octokit, owner, repo, WORKFLOW_BRANCH, baseSha);
	} catch (error) {
		// Branch might already exist from a previous closed PR
		const errorMessage = error instanceof Error ? error.message : "";
		if (!errorMessage.includes("Reference already exists")) {
			throw error;
		}
	}

	// Create workflow file
	const workflowContent = generateWorkflowContent();
	await createOrUpdateFile(
		octokit,
		owner,
		repo,
		WORKFLOW_FILE_PATH,
		workflowContent,
		"Add Bonk workflow file",
		WORKFLOW_BRANCH
	);

	// Create PR
	const prBody = `## Summary

This PR adds the Bonk GitHub Action workflow to enable \`@ask-bonk\` / \`/bonk\` mentions in issues and PRs.

## Setup Required

After merging, ensure the following secret is set in your repository:

1. Go to **Settings** > **Secrets and variables** > **Actions**
2. Add a new repository secret:
   - **Name**: \`ANTHROPIC_API_KEY\`
   - **Value**: Your Anthropic API key

## Usage

Once merged and configured, mention the bot in any issue or PR:

\`\`\`
@ask-bonk fix the type error in utils.ts
\`\`\`

Or use the slash command:

\`\`\`
/bonk add tests for the new feature
\`\`\`
`;

	const prNumber = await createPullRequest(
		octokit,
		owner,
		repo,
		WORKFLOW_BRANCH,
		defaultBranch,
		"Add Bonk workflow",
		prBody
	);

	const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

	await updateComment(
		octokit,
		owner,
		repo,
		responseCommentId,
		`I noticed the workflow file is missing. I've created a PR to add it: #${prNumber}\n\nOnce merged and configured with your \`ANTHROPIC_API_KEY\` secret, mention me again!\n\n${prUrl}`
	);

	return {
		success: true,
		message: `Created PR #${prNumber}`,
		prUrl,
	};
}
