import type { Octokit } from "@octokit/rest";
import type { Env } from "./types";
import {
	createOctokit,
	createComment,
	fileExists,
	getDefaultBranchSha,
	createBranch,
	createOrUpdateFile,
	createPullRequest,
	findOpenPR,
	findWorkflowRun,
} from "./github";
import workflowTemplate from "../scripts/bonk.yml.hbs";

const WORKFLOW_FILE_PATH = ".github/workflows/bonk.yml";
const WORKFLOW_BRANCH = "bonk/add-workflow-file";

export interface WorkflowContext {
	owner: string;
	repo: string;
	issueNumber: number;
	defaultBranch: string;
	triggeringActor: string;
	eventType: string;
	commentTimestamp: string;
}

export interface WorkflowResult {
	success: boolean;
	message: string;
	prUrl?: string;
}

const BOT_MENTION = "@ask-bonk";
const BOT_COMMAND = "/bonk";
const DEFAULT_MODEL = "opencode/claude-opus-4-5";

function generateWorkflowContent(): string {
	return workflowTemplate
		.replace(/\{\{BOT_MENTION\}\}/g, BOT_MENTION)
		.replace(/\{\{BOT_COMMAND\}\}/g, BOT_COMMAND)
		.replace(/\{\{MODEL\}\}/g, DEFAULT_MODEL);
}


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
		triggeringActor,
		eventType,
		commentTimestamp,
	} = context;
	const logPrefix = `[${owner}/${repo}#${issueNumber}]`;
	const octokit = await createOctokit(env, installationId);
	const hasWorkflow = await fileExists(octokit, owner, repo, WORKFLOW_FILE_PATH);

	if (!hasWorkflow) {
		console.info(`${logPrefix} Workflow file not found, creating PR`);
		return await createWorkflowPR(octokit, owner, repo, issueNumber, defaultBranch);
	}

	// GitHub triggers workflow automatically - we find the run and track it
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

		// RepoActor handles failure/timeout - OpenCode posts success responses
		// Only creates a comment if the workflow fails
		const actorId = env.REPO_ACTOR.idFromName(`${owner}/${repo}`);
		const actor = env.REPO_ACTOR.get(actorId);

		await actor.setInstallationId(installationId);
		await actor.trackRun(run.id, run.url, issueNumber);

		return {
			success: true,
			message: `Tracking workflow run ${run.id}`,
		};
	} else {
		// Could not find the workflow run - this is unexpected, comment to inform user
		console.warn(`${logPrefix} Could not find workflow run`);
		await createComment(
			octokit,
			owner,
			repo,
			issueNumber,
			`Could not find workflow run. [View Actions](https://github.com/${owner}/${repo}/actions)`
		);

		return {
			success: false,
			message: "Workflow run not found",
		};
	}
}

async function createWorkflowPR(
	octokit: Octokit,
	owner: string,
	repo: string,
	issueNumber: number,
	defaultBranch: string
): Promise<WorkflowResult> {
	const existingPR = await findOpenPR(octokit, owner, repo, WORKFLOW_BRANCH);
	if (existingPR) {
		await createComment(
			octokit,
			owner,
			repo,
			issueNumber,
			`Please merge PR #${existingPR.number} first for Bonk to run workflows.\n\n${existingPR.url}`
		);

		return {
			success: false,
			message: `PR already exists: #${existingPR.number}`,
			prUrl: existingPR.url,
		};
	}

	const baseSha = await getDefaultBranchSha(octokit, owner, repo, defaultBranch);

	try {
		await createBranch(octokit, owner, repo, WORKFLOW_BRANCH, baseSha);
	} catch (error) {
		// Branch may exist from a previous closed PR
		const errorMessage = error instanceof Error ? error.message : "";
		if (!errorMessage.includes("Reference already exists")) {
			throw error;
		}
	}

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

	const prBody = `## Summary

This PR adds the Bonk GitHub Action workflow to enable \`@ask-bonk\` / \`/bonk\` mentions in issues and PRs.

## Setup Required

After merging, ensure the following secret is set in your repository:

1. Go to **Settings** > **Secrets and variables** > **Actions**
2. Add a new repository secret:
   - **Name**: \`OPENCODE_API_KEY\`
   - **Value**: Your Anthropic API key (get one at https://console.anthropic.com/)

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

	await createComment(
		octokit,
		owner,
		repo,
		issueNumber,
		`I noticed the workflow file is missing. I've created a PR to add it: #${prNumber}\n\nOnce merged and configured with your \`OPENCODE_API_KEY\` secret, mention me again!\n\n${prUrl}`
	);

	return {
		success: true,
		message: `Created PR #${prNumber}`,
		prUrl,
	};
}
