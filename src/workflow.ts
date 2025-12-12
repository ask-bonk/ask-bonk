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
	triggerWorkflowDispatch,
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
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: sst/opencode/github@latest
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
`;
}



/**
 * Handle workflow mode: check for workflow file, create PR if missing, or trigger workflow
 */
export async function runWorkflowMode(
	env: Env,
	installationId: number,
	context: WorkflowContext
): Promise<WorkflowResult> {
	const { owner, repo, issueNumber, defaultBranch, responseCommentId } = context;
	const logPrefix = `[${owner}/${repo}#${issueNumber}]`;
	const octokit = await createOctokit(env, installationId);

	// Check if workflow file exists
	const hasWorkflow = await fileExists(octokit, owner, repo, WORKFLOW_FILE_PATH);

	if (!hasWorkflow) {
		console.info(`${logPrefix} Workflow file not found, creating PR`);
		return await createWorkflowPR(octokit, owner, repo, defaultBranch, responseCommentId);
	}

	// Workflow exists, trigger it
	console.info(`${logPrefix} Triggering workflow dispatch`);
	try {
		await triggerWorkflowDispatch(
			octokit,
			owner,
			repo,
			"bonk.yml",
			defaultBranch,
			{}
		);

		await updateComment(
			octokit,
			owner,
			repo,
			responseCommentId,
			"Bonk workflow triggered. Check the Actions tab for progress."
		);

		return {
			success: true,
			message: "Workflow triggered successfully",
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		console.error(`${logPrefix} Failed to trigger workflow:`, errorMessage);

		await updateComment(
			octokit,
			owner,
			repo,
			responseCommentId,
			`Failed to trigger Bonk workflow.\n\n\`\`\`\n${errorMessage}\n\`\`\``
		);

		return {
			success: false,
			message: `Failed to trigger workflow: ${errorMessage}`,
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
