import { Agent } from 'agents';
import type { Env } from './types';
import { createOctokit, createComment, getWorkflowRunStatus } from './github';

export interface CheckStatusPayload {
	runId: number;
	runUrl: string;
	issueNumber: number;
	createdAt: number;
}

interface RepoAgentState {
	installationId: number;
	// Active workflow runs being tracked, keyed by run ID
	activeRuns: Record<number, CheckStatusPayload>;
}

// Poll every 5 minutes as a safety net (action calls finalizeRun on completion)
const POLL_INTERVAL_SECONDS = 300;
const MAX_TRACKING_TIME_MS = 30 * 60 * 1000;

// Tracks workflow runs per repo. ID format: "{owner}/{repo}"
export class RepoAgent extends Agent<Env, RepoAgentState> {
	initialState: RepoAgentState = { installationId: 0, activeRuns: {} };

	private get owner(): string {
		return this.name.split('/')[0] ?? '';
	}

	private get repo(): string {
		return this.name.split('/')[1] ?? '';
	}

	async setInstallationId(id: number): Promise<void> {
		this.setState({ ...this.state, installationId: id });
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

		// Store in activeRuns state
		const activeRuns = { ...this.state.activeRuns, [runId]: payload };
		this.setState({ ...this.state, activeRuns });

		// Schedule polling as safety net
		await this.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
		console.info(`${logPrefix} Scheduled status check in ${POLL_INTERVAL_SECONDS}s`);
	}

	async finalizeRun(runId: number, status: string): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		console.info(`${logPrefix} Finalizing run ${runId} with status: ${status}`);

		const run = this.state.activeRuns[runId];
		if (!run) {
			console.info(`${logPrefix} Run ${runId} not found in activeRuns, may have already been finalized`);
			return;
		}

		// Remove from activeRuns (this effectively "cancels" the polling)
		const { [runId]: _, ...remainingRuns } = this.state.activeRuns;
		this.setState({ ...this.state, activeRuns: remainingRuns });

		// Post failure comment if needed
		if (status !== 'success' && status !== 'skipped') {
			await this.postFailureComment(run.runUrl, run.issueNumber, status);
		} else {
			console.info(`${logPrefix} Run ${runId} completed with ${status} - no failure comment needed`);
		}
	}

	async checkWorkflowStatus(payload: CheckStatusPayload): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		const { runId, runUrl, issueNumber, createdAt } = payload;

		// Check if run is still being tracked (may have been finalized by action)
		if (!this.state.activeRuns[runId]) {
			console.info(`${logPrefix} Run ${runId} already finalized, skipping poll`);
			return;
		}

		console.info(`${logPrefix} Checking status for run ${runId}`);

		const elapsed = Date.now() - createdAt;
		if (elapsed > MAX_TRACKING_TIME_MS) {
			console.warn(`${logPrefix} Run ${runId} timed out after ${elapsed}ms`);
			// Remove from activeRuns
			const { [runId]: _, ...remainingRuns } = this.state.activeRuns;
			this.setState({ ...this.state, activeRuns: remainingRuns });
			await this.postFailureComment(runUrl, issueNumber, 'timeout');
			return;
		}

		let octokit;
		try {
			octokit = await createOctokit(this.env, this.state.installationId);
		} catch (error) {
			console.error(`${logPrefix} Failed to create Octokit:`, error);
			await this.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
			return;
		}

		try {
			const status = await getWorkflowRunStatus(octokit, this.owner, this.repo, runId);

			console.info(`${logPrefix} Run ${runId} status: ${status.status}, conclusion: ${status.conclusion}`);

			if (status.status === 'completed') {
				// Remove from activeRuns
				const { [runId]: _, ...remainingRuns } = this.state.activeRuns;
				this.setState({ ...this.state, activeRuns: remainingRuns });

				// On success, OpenCode posts the response - we stay silent
				if (status.conclusion !== 'success') {
					await this.postFailureComment(runUrl, issueNumber, status.conclusion);
				} else {
					console.info(`${logPrefix} Run ${runId} succeeded - OpenCode will post response`);
				}
			} else {
				await this.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
			}
		} catch (error) {
			console.error(`${logPrefix} Failed to check run ${runId}:`, error);
			await this.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
		}
	}

	private async postFailureComment(runUrl: string, issueNumber: number, conclusion: string | null): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;

		const statusMessage =
			conclusion === 'timeout'
				? 'Bonk workflow timed out.'
				: conclusion === 'failure'
					? 'Bonk workflow failed. Check the logs for details.'
					: conclusion === 'cancelled'
						? 'Bonk workflow was cancelled.'
						: `Bonk workflow finished with status: ${conclusion ?? 'unknown'}`;

		const body = `${statusMessage}\n\n[View workflow run](${runUrl})`;

		try {
			const octokit = await createOctokit(this.env, this.state.installationId);
			await createComment(octokit, this.owner, this.repo, issueNumber, body);
			console.info(`${logPrefix} Posted failure comment for issue #${issueNumber}: ${conclusion}`);
		} catch (error) {
			console.error(`${logPrefix} Failed to post failure comment for issue #${issueNumber}:`, error);
		}
	}
}
