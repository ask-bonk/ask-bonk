import { Actor, Persist } from '@cloudflare/actors';
import type { Schedule } from '@cloudflare/actors/alarms';
import type { Env } from './types';
import { createOctokit, getWorkflowRunStatus, createComment } from './github';

export interface CheckStatusPayload {
	runId: number;
	runUrl: string;
	issueNumber: number;
	createdAt: number;
}

const POLL_INTERVAL_SECONDS = 30;
const MAX_TRACKING_TIME_MS = 30 * 60 * 1000;

// Tracks workflow runs per repo. ID format: "{owner}/{repo}"
export class RepoActor extends Actor<Env> {
	private owner: string;
	private repo: string;

	@Persist installationId: number = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const [owner, repo] = ctx.id.name?.split('/') ?? ['', ''];
		this.owner = owner;
		this.repo = repo;
	}

	async setInstallationId(id: number): Promise<void> {
		this.installationId = id;
	}

	async trackRun(runId: number, runUrl: string, issueNumber: number): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		console.info(`${logPrefix} Tracking run ${runId} for issue #${issueNumber}`);

		const payload: CheckStatusPayload = {
			runId,
			runUrl,
			issueNumber,
			createdAt: Date.now(),
		};

		await this.alarms.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
		console.info(`${logPrefix} Scheduled status check in ${POLL_INTERVAL_SECONDS}s`);
	}

	// Called by alarms system
	async checkWorkflowStatus(payload: CheckStatusPayload, _schedule: Schedule<CheckStatusPayload>): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		const { runId, runUrl, issueNumber, createdAt } = payload;

		console.info(`${logPrefix} Checking status for run ${runId}`);

		const elapsed = Date.now() - createdAt;
		if (elapsed > MAX_TRACKING_TIME_MS) {
			console.warn(`${logPrefix} Run ${runId} timed out after ${elapsed}ms`);
			await this.postTimeoutComment(runUrl, issueNumber);
			return;
		}

		let octokit;
		try {
			octokit = await createOctokit(this.env, this.installationId);
		} catch (error) {
			console.error(`${logPrefix} Failed to create Octokit:`, error);
			await this.alarms.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
			return;
		}

		try {
			const status = await getWorkflowRunStatus(octokit, this.owner, this.repo, runId);

			console.info(`${logPrefix} Run ${runId} status: ${status.status}, conclusion: ${status.conclusion}`);

			if (status.status === 'completed') {
				// On success, OpenCode posts the response - we stay silent
				if (status.conclusion !== 'success') {
					await this.postFailureComment(runUrl, issueNumber, status.conclusion);
				} else {
					console.info(`${logPrefix} Run ${runId} succeeded - OpenCode will post response`);
				}
			} else {
				await this.alarms.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
			}
		} catch (error) {
			console.error(`${logPrefix} Failed to check run ${runId}:`, error);
			await this.alarms.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
		}
	}

	private async postFailureComment(runUrl: string, issueNumber: number, conclusion: string | null): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;

		const statusMessage =
			conclusion === 'failure'
				? 'Bonk workflow failed. Check the logs for details.'
				: conclusion === 'cancelled'
					? 'Bonk workflow was cancelled.'
					: `Bonk workflow finished with status: ${conclusion ?? 'unknown'}`;

		const body = `${statusMessage}\n\n[View workflow run](${runUrl})`;

		try {
			const octokit = await createOctokit(this.env, this.installationId);
			await createComment(octokit, this.owner, this.repo, issueNumber, body);
			console.info(`${logPrefix} Posted failure comment for issue #${issueNumber}: ${conclusion}`);
		} catch (error) {
			console.error(`${logPrefix} Failed to post failure comment for issue #${issueNumber}:`, error);
		}
	}

	private async postTimeoutComment(runUrl: string, issueNumber: number): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		const body = `Timed out waiting for completion. [View run](${runUrl})`;

		try {
			const octokit = await createOctokit(this.env, this.installationId);
			await createComment(octokit, this.owner, this.repo, issueNumber, body);
			console.info(`${logPrefix} Posted timeout comment for issue #${issueNumber}`);
		} catch (error) {
			console.error(`${logPrefix} Failed to post timeout comment for issue #${issueNumber}:`, error);
		}
	}
}
