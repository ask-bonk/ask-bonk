import type { Env } from './types';

// Event types for categorizing metrics
export type EventType = 'webhook' | 'track' | 'finalize' | 'setup' | 'installation' | 'failure_comment';

// Status values for tracking outcomes
export type EventStatus = 'success' | 'failure' | 'error' | 'skipped' | 'cancelled';

// Metric event structure matching WAE schema
// index1 (blob): {owner}/{repo} - primary grouping key
// blob1: event_type, blob2: event_subtype, blob3: status, blob4: actor, blob5: error_code
// double1: issue_number, double2: run_id, double3: duration_ms, double4: is_private, double5: is_pull_request
export interface MetricEvent {
	repo: string; // index1 - {owner}/{repo}
	eventType: EventType; // blob1
	eventSubtype?: string; // blob2 - e.g., 'issue_comment', 'schedule'
	status: EventStatus; // blob3
	actor?: string; // blob4
	errorCode?: string; // blob5
	issueNumber?: number; // double1
	runId?: number; // double2
	durationMs?: number; // double3
	isPrivate?: boolean; // double4
	isPullRequest?: boolean; // double5
}

// Emit a metric event to Analytics Engine
// Uses optional chaining to gracefully handle missing binding (e.g., in tests)
export function emitMetric(env: Env, event: MetricEvent): void {
	env.BONK_EVENTS?.writeDataPoint({
		indexes: [event.repo],
		blobs: [event.eventType, event.eventSubtype ?? '', event.status, event.actor ?? '', event.errorCode ?? ''],
		doubles: [event.issueNumber ?? 0, event.runId ?? 0, event.durationMs ?? 0, event.isPrivate ? 1 : 0, event.isPullRequest ? 1 : 0],
	});
}
