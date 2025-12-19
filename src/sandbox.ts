import { getSandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { Config, OpencodeClient } from "@opencode-ai/sdk";
import type { Env, ImageData } from "./types";
import { imagesToPromptParts } from "./images";
import { generateBranchName } from "./events";

const SHARE_URL = "https://opencode.ai";

export interface SandboxParams {
	env: Env;
	owner: string;
	repo: string;
	branch: string;
	prompt: string;
	images: ImageData[];
	modelConfig: { providerID: string; modelID: string };
	token: string;
	isPrivate: boolean;
	actor: string;
	isPullRequest: boolean;
	issueNumber: number;
}

export interface SandboxResult {
	response: string;
	changedFiles: string[] | null;
	sessionLink: string | null;
	newBranch: string | null;
	summary: string | null;
}

export async function runOpencodeSandbox(params: SandboxParams): Promise<SandboxResult> {
	const {
		env,
		owner,
		repo,
		branch,
		prompt,
		images,
		modelConfig,
		token,
		isPrivate,
		actor,
		isPullRequest,
		issueNumber,
	} = params;

	const logPrefix = `[${owner}/${repo}#${issueNumber}]`;
	const sandboxId = `${owner}-${repo}-${Date.now()}`;
	const sandbox = getSandbox(env.Sandbox, sandboxId);
	const repoUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
	try {
		await sandbox.gitCheckout(repoUrl, {
			targetDir: "/home/user/workspace",
			branch: branch,
		});
	} catch (error) {
		console.error(`${logPrefix} Failed to clone repository:`, error);
		throw error;
	}

	const gitConfigResult = await sandbox.exec(
		`git config user.name "bonk[bot]" && git config user.email "bonk[bot]@users.noreply.github.com"`,
		{ cwd: "/home/user/workspace" }
	);
	if (!gitConfigResult.success) {
		console.error(`${logPrefix} Git config failed:`, gitConfigResult.stderr);
	}

	await sandbox.exec(
		`git config credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
		{ cwd: "/home/user/workspace" }
	);

	const config: Config = {
		provider: {
			anthropic: {
				options: {
					apiKey: env.OPENCODE_API_KEY,
				},
			},
		},
	};

	let client: OpencodeClient;
	try {
		const opencode = await createOpencode<OpencodeClient>(sandbox, {
			directory: "/home/user/workspace",
			config,
		});
		client = opencode.client;
	} catch (error) {
		console.error(`${logPrefix} Failed to start OpenCode:`, error);
		throw error;
	}

	const session = await client.session.create({
		body: { title: `Bonk: ${owner}/${repo}#${issueNumber}` },
		query: { directory: "/home/user/workspace" },
	});

	if (!session.data) {
		const err = new Error("Failed to create OpenCode session");
		console.error(`${logPrefix}`, err.message);
		throw err;
	}

	let sessionLink: string | null = null;
	if (!isPrivate) {
		try {
			await client.session.share({
				path: { id: session.data.id },
			});
			const shareId = session.data.id.slice(-8);
			sessionLink = `${SHARE_URL}/s/${shareId}`;
		} catch (error) {
			console.error(`${logPrefix} Failed to share session:`, error);
		}
	}

	let promptResult;
	try {
		promptResult = await client.session.prompt({
			path: { id: session.data.id },
			query: { directory: "/home/user/workspace" },
			body: {
				model: {
					providerID: modelConfig.providerID,
					modelID: modelConfig.modelID,
				},
				parts: [
					{ type: "text", text: prompt },
					...imagesToPromptParts(images),
				],
			},
		});
	} catch (error) {
		console.error(`${logPrefix} OpenCode prompt failed:`, error);
		throw error;
	}

	const parts = promptResult.data?.parts ?? [];
	const textPart = parts.find((p: { type: string }) => p.type === "text") as
		| { text?: string }
		| undefined;
	const response = textPart?.text ?? "No response";

	const statusResult = await sandbox.exec("git status --porcelain", {
		cwd: "/home/user/workspace",
	});
	if (!statusResult.success) {
		console.error(`${logPrefix} Git status failed:`, statusResult.stderr);
	}
	const hasChanges = statusResult.stdout.trim().length > 0;

	let changedFiles: string[] | null = null;
	let newBranch: string | null = null;
	let summary: string | null = null;

	if (hasChanges) {
		const files = statusResult.stdout
			.trim()
			.split("\n")
			.map((line: string) => line.slice(3).trim())
			.filter((f: string) => f.length > 0);
		changedFiles = files;
		summary = await generateSummary(client, session.data.id, response);

		if (!isPullRequest) {
			newBranch = generateBranchName("issue", issueNumber);
			await sandbox.exec(`git checkout -b ${newBranch}`, {
				cwd: "/home/user/workspace",
			});
			await sandbox.exec("git add .", { cwd: "/home/user/workspace" });
			await sandbox.exec(
				`git commit -m "${summary}\n\nCo-authored-by: ${actor} <${actor}@users.noreply.github.com>"`,
				{ cwd: "/home/user/workspace" }
			);
			const pushResult = await sandbox.exec(`git push -u origin ${newBranch}`, {
				cwd: "/home/user/workspace",
			});
			if (!pushResult.success) {
				console.error(`${logPrefix} Git push failed:`, pushResult.stderr);
				throw new Error(`Git push failed: ${pushResult.stderr}`);
			}
		} else {
			await sandbox.exec("git add .", { cwd: "/home/user/workspace" });
			await sandbox.exec(
				`git commit -m "${summary}\n\nCo-authored-by: ${actor} <${actor}@users.noreply.github.com>"`,
				{ cwd: "/home/user/workspace" }
			);
			const pushResult = await sandbox.exec("git push", {
				cwd: "/home/user/workspace",
			});
			if (!pushResult.success) {
				console.error(`${logPrefix} Git push failed:`, pushResult.stderr);
				throw new Error(`Git push failed: ${pushResult.stderr}`);
			}
		}
	}

	return {
		response,
		changedFiles,
		sessionLink,
		newBranch,
		summary,
	};
}

async function generateSummary(
	client: OpencodeClient,
	sessionId: string,
	response: string
): Promise<string> {
	try {
		const summaryResult = await client.session.prompt({
			path: { id: sessionId },
			body: {
				model: {
					providerID: "anthropic",
					modelID: "claude-haiku-4-5",
				},
				parts: [
					{
						type: "text",
						text: `Summarize the following in less than 40 characters:\n\n${response}`,
					},
				],
			},
		});

		const parts = summaryResult.data?.parts ?? [];
		const textPart = parts.find(
			(p: { type: string }) => p.type === "text"
		) as { text?: string } | undefined;
		return textPart?.text?.slice(0, 40) ?? "Fix issue";
	} catch {
		return "Fix issue";
	}
}
