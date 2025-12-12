import { Actor } from "@cloudflare/actors";
import type { Octokit } from "@octokit/rest";
import type { Env } from "../types";
import { createOctokit, getWorkflowRunStatus, updateComment } from "../github";

/**
 * Pending workflow run being tracked for completion
 */
export interface PendingRun {
	runId: number;
	runUrl: string;
	commentId: number;
	issueNumber: number;
	createdAt: number;
	pollAttempts: number;
}

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_MAX_TRACKING_TIME_MS = 30 * 60 * 1000; // 30 minutes

/**
 * RepoActor - Durable Object for tracking workflow completion per repository
 *
 * ID format: "{owner}/{repo}" (e.g., "elithrar/ask-bonk")
 *
 * Responsibilities:
 * - Track multiple pending workflow runs for a single repository
 * - Poll GitHub API periodically via alarms to check run status
 * - Update GitHub comments when runs complete or timeout
 */
export class RepoActor extends Actor<Env> {
	private owner: string;
	private repo: string;
	private maxTrackingTimeMs: number = DEFAULT_MAX_TRACKING_TIME_MS;

	// Persisted state
	installationId: number = 0;
	pendingRuns: Map<number, PendingRun> = new Map();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const [owner, repo] = ctx.id.name?.split("/") ?? ["", ""];
		this.owner = owner;
		this.repo = repo;
	}

	async onInit(): Promise<void> {
		// MAX_TRACKING_TIME could be made configurable via env in the future
		this.maxTrackingTimeMs = DEFAULT_MAX_TRACKING_TIME_MS;
	}

	/**
	 * Store the GitHub App installation ID for API authentication
	 */
	async setInstallationId(id: number): Promise<void> {
		this.installationId = id;
	}

	/**
	 * Start tracking a workflow run for completion
	 */
	async trackRun(
		commentId: number,
		runId: number,
		runUrl: string,
		issueNumber: number
	): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		console.info(`${logPrefix} Tracking run ${runId} for comment ${commentId}`);

		this.pendingRuns.set(commentId, {
			runId,
			runUrl,
			commentId,
			issueNumber,
			createdAt: Date.now(),
			pollAttempts: 0,
		});

		// Schedule alarm if not already set
		const currentAlarm = await this.ctx.storage.getAlarm();
		if (!currentAlarm) {
			console.info(`${logPrefix} Scheduling alarm in ${POLL_INTERVAL_MS}ms`);
			await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
		}
	}

	/**
	 * Alarm handler - called periodically to check workflow run status
	 */
	async alarm(): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;

		if (this.pendingRuns.size === 0) {
			console.info(`${logPrefix} No pending runs, skipping alarm`);
			return;
		}

		console.info(`${logPrefix} Alarm fired, checking ${this.pendingRuns.size} pending runs`);

		let octokit: Octokit;
		try {
			octokit = await createOctokit(this.env, this.installationId);
		} catch (error) {
			console.error(`${logPrefix} Failed to create Octokit:`, error);
			// Reschedule and retry on next alarm
			await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
			return;
		}

		const now = Date.now();

		for (const [commentId, run] of this.pendingRuns) {
			const elapsed = now - run.createdAt;

			// Check if we've exceeded max tracking time
			if (elapsed > this.maxTrackingTimeMs) {
				console.warn(`${logPrefix} Run ${run.runId} timed out after ${elapsed}ms`);
				await this.updateCommentWithTimeout(octokit, run);
				this.pendingRuns.delete(commentId);
				continue;
			}

			try {
				const status = await getWorkflowRunStatus(
					octokit,
					this.owner,
					this.repo,
					run.runId
				);

				console.info(`${logPrefix} Run ${run.runId} status: ${status.status}, conclusion: ${status.conclusion}`);

				if (status.status === "completed") {
					await this.updateCommentWithResult(octokit, run, status.conclusion);
					this.pendingRuns.delete(commentId);
				} else {
					run.pollAttempts++;
				}
			} catch (error) {
				// Log error but continue - will retry on next alarm
				console.error(
					`${logPrefix} Failed to check run ${run.runId}:`,
					error
				);
				run.pollAttempts++;
			}
		}

		// Schedule next alarm if there are still pending runs
		if (this.pendingRuns.size > 0) {
			console.info(`${logPrefix} ${this.pendingRuns.size} runs still pending, scheduling next alarm`);
			await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
		} else {
			console.info(`${logPrefix} All runs completed, no more alarms needed`);
		}
	}

	/**
	 * Update the GitHub comment with the workflow result
	 */
	private async updateCommentWithResult(
		octokit: Octokit,
		run: PendingRun,
		conclusion: string | null
	): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;

		const statusMessage =
			conclusion === "success"
				? "Bonk completed successfully!"
				: conclusion === "failure"
					? "Bonk failed. Check the workflow logs for details."
					: conclusion === "cancelled"
						? "Bonk was cancelled."
						: `Bonk finished with status: ${conclusion ?? "unknown"}`;

		const body = `${statusMessage}\n\n[View workflow run](${run.runUrl})`;

		try {
			await updateComment(octokit, this.owner, this.repo, run.commentId, body);
			console.info(`${logPrefix} Updated comment ${run.commentId} with result: ${conclusion}`);
		} catch (error) {
			console.error(`${logPrefix} Failed to update comment ${run.commentId}:`, error);
		}
	}

	/**
	 * Update the GitHub comment when tracking times out
	 */
	private async updateCommentWithTimeout(
		octokit: Octokit,
		run: PendingRun
	): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		const body = `Timed out waiting for completion. [View run](${run.runUrl})`;

		try {
			await updateComment(octokit, this.owner, this.repo, run.commentId, body);
			console.info(`${logPrefix} Updated comment ${run.commentId} with timeout`);
		} catch (error) {
			console.error(`${logPrefix} Failed to update comment ${run.commentId} with timeout:`, error);
		}
	}
}
