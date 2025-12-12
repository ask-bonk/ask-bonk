#!/usr/bin/env npx tsx
/**
 * GitHub Install Script for Bonk
 *
 * Sets up Bonk workflow mode in a target repository:
 * 1. Detects git origin to suggest target repo
 * 2. Prompts for ANTHROPIC_API_KEY
 * 3. Sets secret via gh CLI (if available)
 * 4. Creates PR with workflow file
 */

import { execSync, spawnSync } from "child_process";
import * as readline from "readline";

const WORKFLOW_FILE_PATH = ".github/workflows/bonk.yml";
const WORKFLOW_BRANCH = "bonk/add-workflow-file";
const DEPLOY_BUTTON_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/elithrar/ask-bonk";

// ANSI colors
const colors = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
};

function log(message: string) {
	console.log(message);
}

function logStep(step: string) {
	log(`\n${colors.blue}==>${colors.reset} ${colors.bold}${step}${colors.reset}`);
}

function logSuccess(message: string) {
	log(`${colors.green}[OK]${colors.reset} ${message}`);
}

function logWarn(message: string) {
	log(`${colors.yellow}[!]${colors.reset} ${message}`);
}

function logError(message: string) {
	log(`${colors.red}[ERROR]${colors.reset} ${message}`);
}

function logInfo(message: string) {
	log(`${colors.dim}${message}${colors.reset}`);
}

// Prompt for user input
async function prompt(question: string, defaultValue?: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const displayDefault = defaultValue ? ` ${colors.dim}[${defaultValue}]${colors.reset}` : "";

	return new Promise((resolve) => {
		rl.question(`${question}${displayDefault}: `, (answer) => {
			rl.close();
			resolve(answer.trim() || defaultValue || "");
		});
	});
}

// Prompt for password (hidden input)
async function promptSecret(question: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		// Disable echo
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}

		process.stdout.write(`${question}: `);

		let input = "";
		process.stdin.on("data", (char) => {
			const c = char.toString();
			if (c === "\n" || c === "\r" || c === "\u0004") {
				process.stdout.write("\n");
				if (process.stdin.isTTY) {
					process.stdin.setRawMode(false);
				}
				rl.close();
				resolve(input);
			} else if (c === "\u007F" || c === "\b") {
				// Backspace
				if (input.length > 0) {
					input = input.slice(0, -1);
					process.stdout.write("\b \b");
				}
			} else if (c === "\u0003") {
				// Ctrl+C
				process.stdout.write("\n");
				process.exit(1);
			} else {
				input += c;
				process.stdout.write("*");
			}
		});
	});
}

// Check if a command exists
function commandExists(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Get git remote origin
function getGitOrigin(): string | null {
	try {
		const result = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
		// Parse owner/repo from various URL formats
		const match = result.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
		if (match) {
			return `${match[1]}/${match[2]}`;
		}
	} catch {
		// Not a git repo or no origin
	}
	return null;
}

// Check if gh is authenticated
function isGhAuthenticated(): boolean {
	try {
		execSync("gh auth status", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Set secret using gh CLI
function setSecret(repo: string, name: string, value: string): boolean {
	try {
		const result = spawnSync("gh", ["secret", "set", name, "-R", repo], {
			input: value,
			encoding: "utf-8",
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

// Check if workflow file exists in repo
function workflowExists(repo: string): boolean {
	try {
		execSync(`gh api repos/${repo}/contents/${WORKFLOW_FILE_PATH}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Check if branch exists
function branchExists(repo: string, branch: string): boolean {
	try {
		execSync(`gh api repos/${repo}/git/ref/heads/${branch}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Get default branch
function getDefaultBranch(repo: string): string {
	try {
		const result = execSync(`gh api repos/${repo} --jq '.default_branch'`, { encoding: "utf-8" });
		return result.trim();
	} catch {
		return "main";
	}
}

// Create branch from default
function createBranch(repo: string, branch: string, baseBranch: string): boolean {
	try {
		const sha = execSync(`gh api repos/${repo}/git/ref/heads/${baseBranch} --jq '.object.sha'`, {
			encoding: "utf-8",
		}).trim();
		execSync(`gh api repos/${repo}/git/refs -f ref=refs/heads/${branch} -f sha=${sha}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Create or update file in repo
function createFile(repo: string, path: string, content: string, message: string, branch: string): boolean {
	try {
		const base64Content = Buffer.from(content).toString("base64");
		execSync(
			`gh api repos/${repo}/contents/${path} -X PUT -f message="${message}" -f content="${base64Content}" -f branch="${branch}"`,
			{ stdio: "ignore" }
		);
		return true;
	} catch {
		return false;
	}
}

// Create PR
function createPR(repo: string, head: string, base: string, title: string, body: string): string | null {
	try {
		const result = execSync(`gh pr create -R ${repo} -H ${head} -B ${base} -t "${title}" -b "${body}"`, {
			encoding: "utf-8",
		});
		return result.trim();
	} catch {
		return null;
	}
}

// Find existing PR
function findExistingPR(repo: string, branch: string): string | null {
	try {
		const result = execSync(`gh pr list -R ${repo} -H ${branch} --json url --jq '.[0].url'`, {
			encoding: "utf-8",
		});
		return result.trim() || null;
	} catch {
		return null;
	}
}

// Generate workflow content
function generateWorkflowContent(botMention = "@ask-bonk", botCommand = "/bonk"): string {
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
      (github.event_name == 'issue_comment' && (contains(github.event.comment.body, '${botMention}') || contains(github.event.comment.body, '${botCommand}'))) ||
      (github.event_name == 'pull_request_review_comment' && (contains(github.event.comment.body, '${botMention}') || contains(github.event.comment.body, '${botCommand}'))) ||
      (github.event_name == 'pull_request_review' && (contains(github.event.review.body, '${botMention}') || contains(github.event.review.body, '${botCommand}')))
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



// Open URL in browser
function openUrl(url: string): boolean {
	try {
		const platform = process.platform;
		if (platform === "darwin") {
			execSync(`open "${url}"`);
		} else if (platform === "win32") {
			execSync(`start "" "${url}"`);
		} else {
			execSync(`xdg-open "${url}"`);
		}
		return true;
	} catch {
		return false;
	}
}

async function main() {
	log(`\n${colors.bold}${colors.cyan}Bonk GitHub Install${colors.reset}`);
	log(`${colors.dim}Set up Bonk workflow mode in your repository${colors.reset}\n`);

	// Check for gh CLI
	const hasGh = commandExists("gh");
	if (!hasGh) {
		logError("GitHub CLI (gh) is required but not installed.");
		log("\nInstall it from: https://cli.github.com/");
		process.exit(1);
	}

	if (!isGhAuthenticated()) {
		logError("GitHub CLI is not authenticated.");
		log("\nRun: gh auth login");
		process.exit(1);
	}

	logSuccess("GitHub CLI is installed and authenticated");

	// Detect git origin
	const detectedRepo = getGitOrigin();

	// Get target repository
	logStep("Target Repository");
	const targetRepo = await prompt("Repository (owner/repo)", detectedRepo || undefined);

	if (!targetRepo || !targetRepo.includes("/")) {
		logError("Invalid repository format. Use owner/repo format.");
		process.exit(1);
	}

	// Verify repo exists and we have access
	try {
		execSync(`gh api repos/${targetRepo}`, { stdio: "ignore" });
		logSuccess(`Repository ${targetRepo} exists and is accessible`);
	} catch {
		logError(`Cannot access repository ${targetRepo}. Check it exists and you have access.`);
		process.exit(1);
	}

	// Check if workflow already exists
	if (workflowExists(targetRepo)) {
		logWarn(`Workflow file already exists at ${WORKFLOW_FILE_PATH}`);
		const proceed = await prompt("Continue anyway? (y/n)", "n");
		if (proceed.toLowerCase() !== "y") {
			process.exit(0);
		}
	}

	// Get API key
	logStep("API Key Configuration");
	log("Bonk requires an Anthropic API key to function.");
	log(`${colors.dim}Get one at: https://console.anthropic.com/${colors.reset}\n`);

	const apiKey = await promptSecret("Enter ANTHROPIC_API_KEY");

	if (!apiKey) {
		logWarn("No API key provided. You'll need to set ANTHROPIC_API_KEY manually.");
	} else {
		// Set secret
		logInfo("Setting repository secret...");
		if (setSecret(targetRepo, "ANTHROPIC_API_KEY", apiKey)) {
			logSuccess("ANTHROPIC_API_KEY secret set successfully");
		} else {
			logError("Failed to set secret. You may need to set it manually.");
			log(`\nGo to: https://github.com/${targetRepo}/settings/secrets/actions`);
		}
	}

	// Create workflow PR
	logStep("Creating Workflow PR");

	const defaultBranch = getDefaultBranch(targetRepo);
	logInfo(`Default branch: ${defaultBranch}`);

	// Check for existing PR
	const existingPR = findExistingPR(targetRepo, WORKFLOW_BRANCH);
	if (existingPR) {
		logWarn(`PR already exists: ${existingPR}`);
		log("\nMerge or close the existing PR first.");
		process.exit(0);
	}

	// Create branch if it doesn't exist
	if (!branchExists(targetRepo, WORKFLOW_BRANCH)) {
		logInfo(`Creating branch ${WORKFLOW_BRANCH}...`);
		if (!createBranch(targetRepo, WORKFLOW_BRANCH, defaultBranch)) {
			logError("Failed to create branch");
			process.exit(1);
		}
		logSuccess("Branch created");
	}

	// Create workflow file
	logInfo("Creating workflow file...");
	const workflowContent = generateWorkflowContent();
	if (!createFile(targetRepo, WORKFLOW_FILE_PATH, workflowContent, "Add Bonk workflow file", WORKFLOW_BRANCH)) {
		logError("Failed to create workflow file");
		process.exit(1);
	}
	logSuccess("Workflow file created");

	// Create PR
	logInfo("Creating pull request...");
	const prBody = `## Summary

This PR adds the Bonk GitHub Action workflow to enable \`@ask-bonk\` / \`/bonk\` mentions in issues and PRs.

## Setup

${apiKey ? "The `ANTHROPIC_API_KEY` secret has been configured." : "**Action Required**: Set the `ANTHROPIC_API_KEY` secret in repository settings."}

## Usage

Once merged, mention the bot in any issue or PR:

\`\`\`
@ask-bonk fix the type error in utils.ts
\`\`\`

Or use the slash command:

\`\`\`
/bonk add tests for the new feature
\`\`\`
`;

	const prUrl = createPR(targetRepo, WORKFLOW_BRANCH, defaultBranch, "Add Bonk workflow", prBody);

	if (prUrl) {
		logSuccess(`Pull request created: ${prUrl}`);

		// Open PR in browser
		const shouldOpen = await prompt("Open PR in browser? (y/n)", "y");
		if (shouldOpen.toLowerCase() === "y") {
			openUrl(prUrl);
		}
	} else {
		logError("Failed to create pull request");
		log(`\nYou can create it manually at: https://github.com/${targetRepo}/compare/${WORKFLOW_BRANCH}`);
	}

	// Summary
	log(`\n${colors.bold}${colors.green}Setup Complete!${colors.reset}\n`);
	log("Next steps:");
	log(`  1. Review and merge the PR`);
	if (!apiKey) {
		log(`  2. Set ANTHROPIC_API_KEY in repository secrets`);
		log(`  3. Mention @ask-bonk or /bonk in an issue or PR`);
	} else {
		log(`  2. Mention @ask-bonk or /bonk in an issue or PR`);
	}

	log(`\n${colors.dim}Want to deploy your own Bonk instance?${colors.reset}`);
	log(`${colors.dim}Visit: ${DEPLOY_BUTTON_URL}${colors.reset}\n`);
}

main().catch((error) => {
	logError(error.message);
	process.exit(1);
});
