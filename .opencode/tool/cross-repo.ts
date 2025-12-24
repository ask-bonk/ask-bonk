import { tool } from "@opencode-ai/plugin"
import { Shescape } from "shescape"

// Shescape instance for safe shell argument escaping
// Uses bash shell explicitly since we spawn with bash -c
const shescape = new Shescape({ shell: "bash" })

// Wrapper for shescape.quote() - escapes a string for safe use as a shell argument
function shellEscape(str: string): string {
	return shescape.quote(str)
}

// State tracking for cloned repos across tool invocations
const clonedRepos = new Map<string, { path: string; token: string; defaultBranch: string }>()

export default tool({
	description: `Operate on GitHub repositories other than the current working repository.

Use this tool when you need to:
- Clone and make changes to a different repository (e.g. "also update the docs repo")
- Create coordinated changes across multiple repos (e.g. "update the SDK and the examples repo")
- Open PRs in related repositories based on changes in the current repo
- Summarize changes from the current repo and apply related changes to another repo

The tool handles authentication automatically via Bonk's OIDC API - you just need to specify the target owner/repo.

Supported operations:
- clone: Shallow clone a repo to /tmp/<owner>-<repo>. Returns the local path.
- branch: Create and checkout a new branch from the default branch.
- commit: Stage all changes and commit with a message.
- push: Push the current branch to remote.
- pr: Create a pull request using gh CLI.
- exec: Run arbitrary shell commands in the cloned repo directory.

Typical workflow:
1. clone the target repo
2. Use standard file tools (read, write, edit) on files in the cloned path
3. branch to create a feature branch
4. commit your changes
5. push the branch
6. pr to create a pull request

Prerequisites:
- The Bonk GitHub App must be installed on the target repository
- The current workflow must have OIDC token permissions (id-token: write)
- The target repository must be in the same organization/user as the source repository
- The actor who triggered the workflow must have write access to the target repository

Security: The token is scoped to only the target repository with minimal permissions (contents:write, pull_requests:write, issues:write).`,

	args: {
		owner: tool.schema.string().describe("Repository owner (org or user)"),
		repo: tool.schema.string().describe("Repository name"),
		operation: tool.schema
			.enum(["clone", "branch", "commit", "push", "pr", "exec"])
			.describe("Operation to perform on the target repository"),

		// Operation-specific args
		branch: tool.schema
			.string()
			.optional()
			.describe("Branch name for 'branch' operation, or specific branch to clone for 'clone'"),
		message: tool.schema
			.string()
			.optional()
			.describe("Commit message for 'commit' operation, or PR body for 'pr' operation"),
		title: tool.schema.string().optional().describe("PR title for 'pr' operation"),
		base: tool.schema.string().optional().describe("Base branch for PR (defaults to repo's default branch)"),
		command: tool.schema.string().optional().describe("Shell command to execute for 'exec' operation"),
	},

	async execute(args) {
		const repoKey = `${args.owner}/${args.repo}`

		switch (args.operation) {
			case "clone":
				return await cloneRepo(args.owner, args.repo, args.branch)

			case "branch": {
				const state = clonedRepos.get(repoKey)
				if (!state) {
					return {
						success: false,
						error: `Repository ${repoKey} not cloned. Run clone operation first.`,
					}
				}
				if (!args.branch) {
					return { success: false, error: "Branch name required for 'branch' operation" }
				}
				return await createBranch(state.path, args.branch)
			}

			case "commit": {
				const state = clonedRepos.get(repoKey)
				if (!state) {
					return {
						success: false,
						error: `Repository ${repoKey} not cloned. Run clone operation first.`,
					}
				}
				if (!args.message) {
					return { success: false, error: "Commit message required for 'commit' operation" }
				}
				return await commitChanges(state.path, args.message)
			}

			case "push": {
				const state = clonedRepos.get(repoKey)
				if (!state) {
					return {
						success: false,
						error: `Repository ${repoKey} not cloned. Run clone operation first.`,
					}
				}
				return await pushBranch(state.path, state.token)
			}

			case "pr": {
				const state = clonedRepos.get(repoKey)
				if (!state) {
					return {
						success: false,
						error: `Repository ${repoKey} not cloned. Run clone operation first.`,
					}
				}
				if (!args.title) {
					return { success: false, error: "PR title required for 'pr' operation" }
				}
				return await createPR(state.path, state.token, args.title, args.message, args.base || state.defaultBranch)
			}

			case "exec": {
				const state = clonedRepos.get(repoKey)
				if (!state) {
					return {
						success: false,
						error: `Repository ${repoKey} not cloned. Run clone operation first.`,
					}
				}
				if (!args.command) {
					return { success: false, error: "Command required for 'exec' operation" }
				}
				return await execCommand(state.path, args.command)
			}

			default:
				return { success: false, error: `Unknown operation: ${args.operation}` }
		}
	},
})

// Get installation token for target repo via Bonk's OIDC API
async function getTargetRepoToken(owner: string, repo: string): Promise<{ token: string } | { error: string }> {
	// Get OIDC token from GitHub Actions environment
	const tokenUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
	const tokenRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN

	if (!tokenUrl || !tokenRequestToken) {
		return {
			error:
				"GitHub Actions OIDC not available. Ensure workflow has 'id-token: write' permission and is running in GitHub Actions.",
		}
	}

	// Request OIDC token with custom audience for Bonk
	const oidcUrl = `${tokenUrl}&audience=opencode-github-action`
	const oidcResponse = await fetch(oidcUrl, {
		headers: { Authorization: `Bearer ${tokenRequestToken}` },
	})

	if (!oidcResponse.ok) {
		return { error: `Failed to get OIDC token: ${oidcResponse.statusText}` }
	}

	const { value: oidcToken } = (await oidcResponse.json()) as { value: string }

	// Exchange OIDC token for installation token via Bonk API
	const bonkApiUrl = process.env.BONK_API_URL || "https://bonk.sst.dev"
	const exchangeResponse = await fetch(`${bonkApiUrl}/auth/exchange_github_app_token_for_repo`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${oidcToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ owner, repo }),
	})

	if (!exchangeResponse.ok) {
		const errorBody = await exchangeResponse.text()
		if (exchangeResponse.status === 401) {
			return {
				error: `Authentication failed for ${owner}/${repo}. Ensure the Bonk GitHub App is installed on the target repository.`,
			}
		}
		return { error: `Failed to get installation token: ${errorBody}` }
	}

	const { token } = (await exchangeResponse.json()) as { token: string }
	return { token }
}



async function cloneRepo(
	owner: string,
	repo: string,
	branch?: string
): Promise<{ success: boolean; path?: string; defaultBranch?: string; error?: string }> {
	const repoKey = `${owner}/${repo}`

	// Check if already cloned
	if (clonedRepos.has(repoKey)) {
		const state = clonedRepos.get(repoKey)!
		return {
			success: true,
			path: state.path,
			defaultBranch: state.defaultBranch,
		}
	}

	// Get installation token
	const tokenResult = await getTargetRepoToken(owner, repo)
	if ("error" in tokenResult) {
		return { success: false, error: tokenResult.error }
	}

	const clonePath = `/tmp/${owner}-${repo}`
	const cloneUrl = `https://x-access-token:${tokenResult.token}@github.com/${owner}/${repo}.git`

	// Remove existing directory if present
	await run(`rm -rf ${shellEscape(clonePath)}`)

	// Clone with depth 1 for speed - use shellEscape for branch name to prevent injection
	const branchArg = branch ? `--branch ${shellEscape(branch)}` : ""
	const cloneResult = await run(`git clone --depth 1 ${branchArg} ${shellEscape(cloneUrl)} ${shellEscape(clonePath)}`)

	if (!cloneResult.success) {
		return { success: false, error: `Clone failed: ${cloneResult.stderr}` }
	}

	// Get default branch
	const defaultBranchResult = await run(`git -C ${shellEscape(clonePath)} rev-parse --abbrev-ref HEAD`)
	const defaultBranch = defaultBranchResult.stdout.trim() || "main"

	// Configure git user for commits
	await run(`git -C ${shellEscape(clonePath)} config user.email "bonk[bot]@users.noreply.github.com"`)
	await run(`git -C ${shellEscape(clonePath)} config user.name "bonk[bot]"`)

	// Store state for subsequent operations
	clonedRepos.set(repoKey, {
		path: clonePath,
		token: tokenResult.token,
		defaultBranch,
	})

	return { success: true, path: clonePath, defaultBranch }
}

async function createBranch(
	repoPath: string,
	branchName: string
): Promise<{ success: boolean; branch?: string; error?: string }> {
	// Create and checkout new branch with properly escaped branch name
	const result = await run(`git -C ${shellEscape(repoPath)} checkout -b ${shellEscape(branchName)}`)

	if (!result.success) {
		// Branch might already exist, try just checking it out
		const checkoutResult = await run(`git -C ${shellEscape(repoPath)} checkout ${shellEscape(branchName)}`)
		if (!checkoutResult.success) {
			return { success: false, error: `Failed to create/checkout branch: ${result.stderr}` }
		}
	}

	return { success: true, branch: branchName }
}

async function commitChanges(
	repoPath: string,
	message: string
): Promise<{ success: boolean; commit?: string; error?: string }> {
	// Stage all changes
	const addResult = await run(`git -C ${shellEscape(repoPath)} add -A`)
	if (!addResult.success) {
		return { success: false, error: `Failed to stage changes: ${addResult.stderr}` }
	}

	// Check if there are changes to commit
	const statusResult = await run(`git -C ${shellEscape(repoPath)} status --porcelain`)
	if (!statusResult.stdout.trim()) {
		return { success: false, error: "No changes to commit" }
	}

	// Commit with properly escaped message
	const commitResult = await run(`git -C ${shellEscape(repoPath)} commit -m ${shellEscape(message)}`)
	if (!commitResult.success) {
		return { success: false, error: `Failed to commit: ${commitResult.stderr}` }
	}

	// Get commit SHA
	const shaResult = await run(`git -C ${shellEscape(repoPath)} rev-parse HEAD`)
	const commit = shaResult.stdout.trim()

	return { success: true, commit }
}

async function pushBranch(repoPath: string, token: string): Promise<{ success: boolean; error?: string }> {
	// Get current branch
	const branchResult = await run(`git -C ${shellEscape(repoPath)} rev-parse --abbrev-ref HEAD`)
	const branch = branchResult.stdout.trim()

	// Get remote URL and inject token
	const remoteResult = await run(`git -C ${shellEscape(repoPath)} remote get-url origin`)
	let remoteUrl = remoteResult.stdout.trim()

	// Ensure token is in the URL for push
	if (!remoteUrl.includes("x-access-token")) {
		remoteUrl = remoteUrl.replace("https://", `https://x-access-token:${token}@`)
		await run(`git -C ${shellEscape(repoPath)} remote set-url origin ${shellEscape(remoteUrl)}`)
	}

	// Push with upstream tracking
	const pushResult = await run(`git -C ${shellEscape(repoPath)} push -u origin ${shellEscape(branch)}`)

	if (!pushResult.success) {
		return { success: false, error: `Push failed: ${pushResult.stderr}` }
	}

	return { success: true }
}

async function createPR(
	repoPath: string,
	token: string,
	title: string,
	body?: string,
	base?: string
): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
	// Get current branch
	const branchResult = await run(`git -C ${shellEscape(repoPath)} rev-parse --abbrev-ref HEAD`)
	const headBranch = branchResult.stdout.trim()

	// Use gh CLI with token auth and properly escaped arguments
	const bodyArg = body ? `--body ${shellEscape(body)}` : `--body ${shellEscape("")}`
	const baseArg = base ? `--base ${shellEscape(base)}` : ""

	const prResult = await run(
		`cd ${shellEscape(repoPath)} && GH_TOKEN=${shellEscape(token)} gh pr create --title ${shellEscape(title)} ${bodyArg} ${baseArg} --head ${shellEscape(headBranch)}`
	)

	if (!prResult.success) {
		return { success: false, error: `PR creation failed: ${prResult.stderr}` }
	}

	// Parse PR URL from output
	const prUrl = prResult.stdout.trim()
	const prNumberMatch = prUrl.match(/\/pull\/(\d+)/)
	const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined

	return { success: true, prUrl, prNumber }
}

async function execCommand(
	repoPath: string,
	command: string
): Promise<{ success: boolean; stdout?: string; stderr?: string; error?: string }> {
	// Note: The command is intentionally NOT escaped - the exec operation is designed
	// to allow arbitrary shell commands. Security is handled at the API layer by:
	// 1. Same-org restriction on token exchange
	// 2. Actor write access verification
	// The LLM/user providing the command is already authorized to write to this repo.
	const result = await run(`cd ${shellEscape(repoPath)} && ${command}`)

	return {
		success: result.success,
		stdout: result.stdout,
		stderr: result.stderr,
		error: result.success ? undefined : result.stderr,
	}
}

// Simple shell execution helper
async function run(command: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(["bash", "-c", command], {
			stdout: "pipe",
			stderr: "pipe",
		})

		const stdout = await new Response(proc.stdout).text()
		const stderr = await new Response(proc.stderr).text()
		const exitCode = await proc.exited

		return {
			success: exitCode === 0,
			stdout,
			stderr,
		}
	} catch (error) {
		return {
			success: false,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		}
	}
}
