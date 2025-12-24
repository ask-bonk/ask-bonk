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

The tool handles authentication automatically:
- In GitHub Actions (with id-token: write): Uses Bonk's OIDC API for secure token exchange
- Outside GitHub Actions: Uses gh CLI authentication or GH_TOKEN/GITHUB_TOKEN env var

Supported operations:
- clone: Shallow clone a repo to /tmp/<owner>-<repo>. Returns the local path.
- read: Read a file from the cloned repo (path relative to repo root).
- write: Write content to a file in the cloned repo (path relative to repo root).
- list: List files in the cloned repo (optionally under a subpath).
- branch: Create and checkout a new branch from the default branch.
- commit: Stage all changes and commit with a message.
- push: Push the current branch to remote.
- pr: Create a pull request using gh CLI. IMPORTANT: Always include a meaningful PR body/description via the 'message' parameter.
- exec: Run arbitrary shell commands in the cloned repo directory.

Typical workflow:
1. clone the target repo
2. Use read/write/list operations to view and modify files
3. branch to create a feature branch
4. commit your changes
5. push the branch
6. pr to create a pull request with a descriptive body (use message parameter with markdown formatting)

Prerequisites (GitHub Actions mode):
- The Bonk GitHub App must be installed on the target repository
- The workflow must have 'id-token: write' permission
- The target repo must be in the same org as the source repo
- The actor must have write access to the target repository

Prerequisites (local/other environments):
- Authenticated via 'gh auth login' with appropriate permissions, or
- GH_TOKEN/GITHUB_TOKEN env var set with appropriate permissions

Security: In GitHub Actions, the token is scoped to only the target repository with minimal permissions (contents:write, pull_requests:write, issues:write).`,

	args: {
		owner: tool.schema.string().describe("Repository owner (org or user)"),
		repo: tool.schema.string().describe("Repository name"),
		operation: tool.schema
			.enum(["clone", "branch", "commit", "push", "pr", "exec", "read", "write", "list"])
			.describe("Operation to perform on the target repository"),

		// Operation-specific args
		branch: tool.schema
			.string()
			.optional()
			.describe("Branch name for 'branch' operation, or specific branch to clone for 'clone'"),
		message: tool.schema
			.string()
			.optional()
			.describe("Commit message for 'commit' operation. For 'pr' operation, this is the PR body/description - include a meaningful summary of changes (use markdown with ## Summary header)."),
		title: tool.schema.string().optional().describe("PR title for 'pr' operation"),
		base: tool.schema.string().optional().describe("Base branch for PR (defaults to repo's default branch)"),
		command: tool.schema.string().optional().describe("Shell command to execute for 'exec' operation"),
		path: tool.schema.string().optional().describe("File path for 'read', 'write', or 'list' operations (relative to repo root)"),
		content: tool.schema.string().optional().describe("File content for 'write' operation"),
	},

	async execute(args) {
		const repoKey = `${args.owner}/${args.repo}`

		// Helper to stringify result - OpenCode's tool validation requires output to be a string
		const stringify = (result: object) => JSON.stringify(result)

		try {
			switch (args.operation) {
				case "clone":
					return stringify(await cloneRepo(args.owner, args.repo, args.branch))

				case "branch": {
					const state = clonedRepos.get(repoKey)
					if (!state) {
						return stringify({
							success: false,
							error: `Repository ${repoKey} not cloned. Run clone operation first.`,
						})
					}
					if (!args.branch) {
						return stringify({ success: false, error: "Branch name required for 'branch' operation" })
					}
					return stringify(await createBranch(state.path, args.branch))
				}

				case "commit": {
					const state = clonedRepos.get(repoKey)
					if (!state) {
						return stringify({
							success: false,
							error: `Repository ${repoKey} not cloned. Run clone operation first.`,
						})
					}
					if (!args.message) {
						return stringify({ success: false, error: "Commit message required for 'commit' operation" })
					}
					return stringify(await commitChanges(state.path, args.message))
				}

				case "push": {
					const state = clonedRepos.get(repoKey)
					if (!state) {
						return stringify({
							success: false,
							error: `Repository ${repoKey} not cloned. Run clone operation first.`,
						})
					}
					return stringify(await pushBranch(state.path, state.token))
				}

				case "pr": {
					const state = clonedRepos.get(repoKey)
					if (!state) {
						return stringify({
							success: false,
							error: `Repository ${repoKey} not cloned. Run clone operation first.`,
						})
					}
					if (!args.title) {
						return stringify({ success: false, error: "PR title required for 'pr' operation" })
					}
					return stringify(await createPR(state.path, state.token, args.title, args.message, args.base || state.defaultBranch))
				}

				case "exec": {
					const state = clonedRepos.get(repoKey)
					if (!state) {
						return stringify({
							success: false,
							error: `Repository ${repoKey} not cloned. Run clone operation first.`,
						})
					}
					if (!args.command) {
						return stringify({ success: false, error: "Command required for 'exec' operation" })
					}
					return stringify(await execCommand(state.path, args.command))
				}

				case "read": {
					const state = clonedRepos.get(repoKey)
					if (!state) {
						return stringify({
							success: false,
							error: `Repository ${repoKey} not cloned. Run clone operation first.`,
						})
					}
					if (!args.path) {
						return stringify({ success: false, error: "Path required for 'read' operation" })
					}
					return stringify(await readFile(state.path, args.path))
				}

				case "write": {
					const state = clonedRepos.get(repoKey)
					if (!state) {
						return stringify({
							success: false,
							error: `Repository ${repoKey} not cloned. Run clone operation first.`,
						})
					}
					if (!args.path) {
						return stringify({ success: false, error: "Path required for 'write' operation" })
					}
					if (args.content === undefined) {
						return stringify({ success: false, error: "Content required for 'write' operation" })
					}
					return stringify(await writeFile(state.path, args.path, args.content))
				}

				case "list": {
					const state = clonedRepos.get(repoKey)
					if (!state) {
						return stringify({
							success: false,
							error: `Repository ${repoKey} not cloned. Run clone operation first.`,
						})
					}
					return stringify(await listFiles(state.path, args.path))
				}

				default:
					return stringify({ success: false, error: `Unknown operation: ${args.operation}` })
			}
		} catch (error) {
			console.error(`cross-repo tool error [${args.operation}]:`, error)
			throw error
		}
	},
})

// Check if running in GitHub Actions
function isGitHubActions(): boolean {
	return process.env.GITHUB_ACTIONS === "true"
}

// Check if OIDC permissions are available
function hasOIDCPermissions(): boolean {
	return !!(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
}

// Try to get token from gh CLI
async function getGhCliToken(): Promise<string | null> {
	const result = await run("gh auth token")
	return result.success ? result.stdout.trim() : null
}

// Get token via GitHub Actions OIDC exchange
async function getTokenViaOIDC(owner: string, repo: string): Promise<{ token: string } | { error: string }> {
	const tokenUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
	const tokenRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN

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
	// OIDC_BASE_URL is set by the OpenCode GitHub Action from the oidc_base_url workflow input
	// It already includes the /auth path, e.g. "https://ask-bonk.silverlock.workers.dev/auth"
	const oidcBaseUrl = process.env.OIDC_BASE_URL
	if (!oidcBaseUrl) {
		return {
			error:
				"OIDC_BASE_URL environment variable not set. Ensure the workflow passes oidc_base_url to the OpenCode action.",
		}
	}
	const exchangeResponse = await fetch(`${oidcBaseUrl}/exchange_github_app_token_for_repo`, {
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

// Get token for target repo - tries multiple auth strategies
async function getTargetRepoToken(owner: string, repo: string): Promise<{ token: string } | { error: string }> {
	// Strategy 1: GitHub Actions OIDC (highest priority when in Actions with permissions)
	if (isGitHubActions() && hasOIDCPermissions()) {
		return await getTokenViaOIDC(owner, repo)
	}

	// Strategy 2: gh CLI auth (most common local setup)
	const ghToken = await getGhCliToken()
	if (ghToken) {
		return { token: ghToken }
	}

	// Strategy 3: Environment variable token (fallback)
	const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
	if (envToken) {
		return { token: envToken }
	}

	return {
		error:
			"No authentication available. Authenticate with 'gh auth login', set GH_TOKEN/GITHUB_TOKEN, or run in GitHub Actions with id-token: write permission.",
	}
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

async function readFile(
	repoPath: string,
	filePath: string
): Promise<{ success: boolean; content?: string; error?: string }> {
	// Resolve the full path, preventing path traversal
	const fullPath = `${repoPath}/${filePath}`.replace(/\/+/g, "/")
	if (!fullPath.startsWith(repoPath)) {
		return { success: false, error: "Invalid path: path traversal detected" }
	}

	const result = await run(`cat ${shellEscape(fullPath)}`)
	if (!result.success) {
		return { success: false, error: `Failed to read file: ${result.stderr}` }
	}

	return { success: true, content: result.stdout }
}

async function writeFile(
	repoPath: string,
	filePath: string,
	content: string
): Promise<{ success: boolean; error?: string }> {
	// Resolve the full path, preventing path traversal
	const fullPath = `${repoPath}/${filePath}`.replace(/\/+/g, "/")
	if (!fullPath.startsWith(repoPath)) {
		return { success: false, error: "Invalid path: path traversal detected" }
	}

	// Create parent directories if needed
	const dirPath = fullPath.substring(0, fullPath.lastIndexOf("/"))
	await run(`mkdir -p ${shellEscape(dirPath)}`)

	// Write content using a heredoc to handle special characters safely
	// Use base64 encoding to safely pass arbitrary content through the shell
	const base64Content = Buffer.from(content).toString("base64")
	const result = await run(`echo ${shellEscape(base64Content)} | base64 -d > ${shellEscape(fullPath)}`)

	if (!result.success) {
		return { success: false, error: `Failed to write file: ${result.stderr}` }
	}

	return { success: true }
}

async function listFiles(
	repoPath: string,
	subPath?: string
): Promise<{ success: boolean; files?: string[]; error?: string }> {
	const targetPath = subPath ? `${repoPath}/${subPath}`.replace(/\/+/g, "/") : repoPath
	if (!targetPath.startsWith(repoPath)) {
		return { success: false, error: "Invalid path: path traversal detected" }
	}

	// List files with relative paths, excluding .git directory
	const result = await run(`find ${shellEscape(targetPath)} -type f ! -path '*/\\.git/*' | sed 's|^${repoPath}/||'`)
	if (!result.success) {
		return { success: false, error: `Failed to list files: ${result.stderr}` }
	}

	const files = result.stdout.trim().split("\n").filter(Boolean)
	return { success: true, files }
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

// Simple shell execution helper with timeout and non-interactive mode
// Timeout defaults to 120 seconds to match typical GitHub Actions timeouts
async function run(
	command: string,
	timeoutMs: number = 120_000
): Promise<{ success: boolean; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(["bash", "-c", command], {
			stdout: "pipe",
			stderr: "pipe",
			// CRITICAL: Set stdin to "ignore" to prevent git from waiting for credential prompts
			// Without this, git clone can hang forever if it tries to prompt for username/password
			stdin: "ignore",
			// Disable git's terminal prompts - fail fast instead of waiting for input
			// This is essential for non-interactive environments like CI/CD
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				// Also disable SSH interactive prompts
				GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
			},
			// Add timeout to prevent hanging forever
			timeout: timeoutMs,
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
