import { Agent } from 'agents';
import type { Env } from './types';
import { createOctokit, createComment, getWorkflowRunStatus } from './github';

export interface CheckStatusPayload {
	runId: number;
	runUrl: string;
	issueNumber: number;
	createdAt: number;
}

export interface PendingWorkflow {
	issueNumber: number;
	actor: string;
	timestamp: string;
	createdAt: number;
}

interface RepoAgentState {
	installationId: number;
	// Pending workflows waiting for workflow_run event, keyed by actor:timestamp
	pendingWorkflows: Record<string, PendingWorkflow>;
}

const POLL_INTERVAL_SECONDS = 30;
const MAX_TRACKING_TIME_MS = 30 * 60 * 1000;
const PENDING_WORKFLOW_CLEANUP_SECONDS = 600;

// Removes a key from a record, returning a new object without mutation
function omitKey<T extends Record<string, unknown>>(obj: T, key: string): Omit<T, typeof key> {
	const copy = { ...obj };
	delete copy[key];
	return copy;
}

// Tracks workflow runs per repo. ID format: "{owner}/{repo}"
export class RepoAgent extends Agent<Env, RepoAgentState> {
	initialState: RepoAgentState = { installationId: 0, pendingWorkflows: {} };

	private get owner(): string {
		return this.name.split('/')[0] ?? '';
	}

	private get repo(): string {
		return this.name.split('/')[1] ?? '';
	}

	async setInstallationId(id: number): Promise<void> {
		this.setState({ ...this.state, installationId: id });
	}

	async addPendingWorkflow(actor: string, timestamp: string, issueNumber: number): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		const key = `${actor}:${timestamp}`;
		const pending: PendingWorkflow = {
			issueNumber,
			actor,
			timestamp,
			createdAt: Date.now(),
		};

		const pendingWorkflows = { ...this.state.pendingWorkflows, [key]: pending };
		this.setState({ ...this.state, pendingWorkflows });

		console.info(`${logPrefix} Added pending workflow for issue #${issueNumber} (${key})`);

		await this.schedule<{ key: string }>(PENDING_WORKFLOW_CLEANUP_SECONDS, 'cleanupPendingWorkflow', { key });
	}

	async consumePendingWorkflow(actor: string): Promise<PendingWorkflow | null> {
		const logPrefix = `[${this.owner}/${this.repo}]`;

		const entry = Object.entries(this.state.pendingWorkflows).find(
			([, pending]) => pending.actor === actor
		);

		if (!entry) {
			return null;
		}

		const [key, pending] = entry;
		this.setState({ ...this.state, pendingWorkflows: omitKey(this.state.pendingWorkflows, key) });

		console.info(`${logPrefix} Consumed pending workflow for issue #${pending.issueNumber} (${key})`);
		return pending;
	}

	async cleanupPendingWorkflow(payload: { key: string }): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;

		if (this.state.pendingWorkflows[payload.key]) {
			this.setState({ ...this.state, pendingWorkflows: omitKey(this.state.pendingWorkflows, payload.key) });
			console.info(`${logPrefix} Cleaned up expired pending workflow: ${payload.key}`);
		}
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

		await this.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
		console.info(`${logPrefix} Scheduled status check in ${POLL_INTERVAL_SECONDS}s`);
	}

	async checkWorkflowStatus(payload: CheckStatusPayload): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		const { runId, runUrl, issueNumber, createdAt } = payload;

		console.info(`${logPrefix} Checking status for run ${runId}`);

		const elapsed = Date.now() - createdAt;
		if (elapsed > MAX_TRACKING_TIME_MS) {
			console.warn(`${logPrefix} Run ${runId} timed out after ${elapsed}ms`);
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
