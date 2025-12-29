import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { Env } from './types';
import { hasWriteAccess } from './github';

// GitHub's OIDC token issuer for Actions
const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

// TTL for cached installation IDs (30 minutes)
export const APP_INSTALLATION_CACHE_TTL_SECS = 1800;
const JWKS = createRemoteJWKSet(new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`));

// JWT claims from GitHub Actions OIDC token
interface GitHubActionsJWTClaims {
	iss: string;
	sub: string;
	aud: string | string[];
	exp: number;
	iat: number;
	nbf?: number;
	jti?: string;
	// GitHub-specific claims
	repository: string;
	repository_owner: string;
	repository_id: string;
	repository_owner_id: string;
	run_id: string;
	run_number: string;
	run_attempt: string;
	actor: string;
	actor_id: string;
	workflow: string;
	head_ref?: string;
	base_ref?: string;
	event_name: string;
	ref: string;
	ref_type: string;
	job_workflow_ref: string;
	runner_environment: string;
}

interface OIDCValidationResult {
	valid: boolean;
	claims?: GitHubActionsJWTClaims;
	error?: string;
}

// Validates a GitHub Actions OIDC token using jose library
export async function validateGitHubOIDCToken(
	token: string,
	expectedAudience: string = 'opencode-github-action'
): Promise<OIDCValidationResult> {
	try {
		const { payload } = await jwtVerify(token, JWKS, {
			issuer: GITHUB_ACTIONS_ISSUER,
			audience: expectedAudience,
		});

		return { valid: true, claims: payload as unknown as GitHubActionsJWTClaims };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return { valid: false, error: message };
	}
}

// Extracts owner/repo from OIDC claims
export function extractRepoFromClaims(claims: GitHubActionsJWTClaims): { owner: string; repo: string } {
	const [owner, repo] = claims.repository.split('/');
	return { owner, repo };
}

// Gets or looks up the installation ID for a repository
export async function getInstallationId(env: Env, owner: string, repo: string): Promise<number | null> {
	const repoKey = `${owner}/${repo}`;

	// Check cache first
	const cached = await env.APP_INSTALLATIONS.get(repoKey);
	if (cached) {
		return parseInt(cached, 10);
	}

	// Look up via GitHub API using the app's JWT
	const auth = createAppAuth({
		appId: env.GITHUB_APP_ID,
		privateKey: env.GITHUB_APP_PRIVATE_KEY,
	});

	const { token } = await auth({ type: 'app' });
	const octokit = new Octokit({ auth: token });

	try {
		const response = await octokit.apps.getRepoInstallation({ owner, repo });
		const installationId = response.data.id;

		// Cache for future use
		await env.APP_INSTALLATIONS.put(repoKey, String(installationId), { expirationTtl: APP_INSTALLATION_CACHE_TTL_SECS });
		return installationId;
	} catch {
		return null;
	}
}

// Options for scoped installation token generation
interface ScopedTokenOptions {
	// Limit token to specific repository names
	repositoryNames?: string[];
	// Limit token permissions (defaults to full installation permissions)
	permissions?: {
		contents?: 'read' | 'write';
		issues?: 'read' | 'write';
		pull_requests?: 'read' | 'write';
		metadata?: 'read';
	};
}

// Generates an installation token for the GitHub App.
// Optionally scopes the token to specific repositories and/or permissions.
async function generateInstallationToken(
	env: Env,
	installationId: number,
	options?: ScopedTokenOptions
): Promise<string> {
	const auth = createAppAuth({
		appId: env.GITHUB_APP_ID,
		privateKey: env.GITHUB_APP_PRIVATE_KEY,
		installationId,
	});

	const authOptions: {
		type: 'installation';
		repositoryNames?: string[];
		permissions?: ScopedTokenOptions['permissions'];
	} = { type: 'installation' };

	if (options?.repositoryNames) {
		authOptions.repositoryNames = options.repositoryNames;
	}
	if (options?.permissions) {
		authOptions.permissions = options.permissions;
	}

	const { token } = await auth(authOptions);
	return token;
}

// Checks if an actor has write access to a repository using the app's installation token.
// Reuses hasWriteAccess from github.ts per CONVENTIONS.md: "Keep functions related to external APIs in their respective files."
async function checkActorWriteAccess(
	env: Env,
	installationId: number,
	owner: string,
	repo: string,
	actor: string
): Promise<boolean> {
	const token = await generateInstallationToken(env, installationId);
	const octokit = new Octokit({ auth: token });
	return hasWriteAccess(octokit, owner, repo, actor);
}

// Response types for API endpoints
export interface GetInstallationResponse {
	installation: {
		id: number;
	} | null;
}

export interface ExchangeTokenResponse {
	token: string;
}

export interface ErrorResponse {
	error: string;
}

// Handler for GET /get_github_app_installation
export async function handleGetInstallation(
	env: Env,
	owner: string,
	repo: string
): Promise<GetInstallationResponse | ErrorResponse> {
	if (!owner || !repo) {
		return { error: 'Missing owner or repo parameter' };
	}

	const installationId = await getInstallationId(env, owner, repo);
	if (!installationId) {
		return { installation: null };
	}

	return { installation: { id: installationId } };
}

// Handler for POST /exchange_github_app_token
// Exchanges a GitHub Actions OIDC token for a GitHub App installation token
export async function handleExchangeToken(
	env: Env,
	authHeader: string | null
): Promise<ExchangeTokenResponse | ErrorResponse> {
	if (!authHeader?.startsWith('Bearer ')) {
		return { error: 'Missing or invalid Authorization header' };
	}

	const oidcToken = authHeader.slice(7);

	// Validate the OIDC token
	const validation = await validateGitHubOIDCToken(oidcToken);
	if (!validation.valid || !validation.claims) {
		return { error: validation.error || 'Invalid OIDC token' };
	}

	// Extract repository info from claims
	const { owner, repo } = extractRepoFromClaims(validation.claims);

	// Get installation ID
	const installationId = await getInstallationId(env, owner, repo);
	if (!installationId) {
		return { error: `GitHub App not installed for ${owner}/${repo}` };
	}

	// Generate installation token
	const token = await generateInstallationToken(env, installationId);

	return { token };
}

// Handler for POST /exchange_github_app_token_for_repo
// Exchanges a GitHub Actions OIDC token for a GitHub App installation token on a DIFFERENT repository.
// This enables cross-repo operations from GitHub Actions - the caller authenticates with their
// workflow's OIDC token, but can request a token for any repo where the Bonk app is installed.
//
// Security controls:
// 1. Same-org restriction: The target repo must be in the same org/user as the source repo
// 2. Actor write access: The actor (user who triggered the workflow) must have write access to the target repo
export async function handleExchangeTokenForRepo(
	env: Env,
	authHeader: string | null,
	body: { owner?: string; repo?: string }
): Promise<ExchangeTokenResponse | ErrorResponse> {
	if (!authHeader?.startsWith('Bearer ')) {
		return { error: 'Missing or invalid Authorization header' };
	}

	const oidcToken = authHeader.slice(7);

	// Validate the OIDC token - this proves the caller is a legitimate GitHub Actions workflow
	const validation = await validateGitHubOIDCToken(oidcToken);
	if (!validation.valid || !validation.claims) {
		return { error: validation.error || 'Invalid OIDC token' };
	}

	// Target repo must be specified in body
	if (!body.owner || !body.repo) {
		return { error: 'Missing owner or repo in request body' };
	}

	// Security check 1: Same-org restriction
	// Only allow cross-repo access within the same org/user to prevent abuse
	if (validation.claims.repository_owner !== body.owner) {
		return {
			error: `Cross-org access denied: workflow in ${validation.claims.repository_owner} cannot access repos in ${body.owner}`,
		};
	}

	// Get installation ID for the TARGET repository
	const installationId = await getInstallationId(env, body.owner, body.repo);
	if (!installationId) {
		return { error: `GitHub App not installed for ${body.owner}/${body.repo}` };
	}

	// Security check 2: Actor write access
	// The actor who triggered the workflow must have write access to the target repo
	const actor = validation.claims.actor;
	const hasAccess = await checkActorWriteAccess(env, installationId, body.owner, body.repo, actor);
	if (!hasAccess) {
		return {
			error: `Access denied: ${actor} does not have write access to ${body.owner}/${body.repo}`,
		};
	}

	// Generate scoped installation token for the target repo only.
	// Token is restricted to:
	// 1. Only the target repository (not all repos the app is installed on)
	// 2. Minimum permissions needed for cross-repo operations (contents, pull_requests, issues)
	const token = await generateInstallationToken(env, installationId, {
		repositoryNames: [body.repo],
		permissions: {
			contents: 'write', // Push commits
			pull_requests: 'write', // Create PRs
			issues: 'write', // Create comments
			metadata: 'read', // Always implicitly included, but be explicit
		},
	});

	return { token };
}

// Handler for POST /exchange_github_app_token_with_pat
// Exchanges a GitHub PAT for a GitHub App installation token (for testing/local development)
export async function handleExchangeTokenWithPAT(
	env: Env,
	authHeader: string | null,
	body: { owner?: string; repo?: string }
): Promise<ExchangeTokenResponse | ErrorResponse> {
	if (!authHeader?.startsWith('Bearer ')) {
		return { error: 'Missing or invalid Authorization header' };
	}

	const pat = authHeader.slice(7);

	// Only allow tokens that look like PATs
	if (!pat.startsWith('github_pat_') && !pat.startsWith('ghp_')) {
		return { error: 'Invalid token format - expected a GitHub PAT' };
	}

	if (!body.owner || !body.repo) {
		return { error: 'Missing owner or repo in request body' };
	}

	// Verify the PAT has write access to the repository
	const octokit = new Octokit({ auth: pat });
	try {
		const { data: repoData } = await octokit.repos.get({ owner: body.owner, repo: body.repo });
		const permissions = repoData.permissions;
		if (!permissions?.admin && !permissions?.push && !permissions?.maintain) {
			return { error: `PAT does not have write permissions for ${body.owner}/${body.repo}` };
		}
	} catch {
		return { error: `PAT does not have access to ${body.owner}/${body.repo}` };
	}

	// Get installation ID
	const installationId = await getInstallationId(env, body.owner, body.repo);
	if (!installationId) {
		return { error: `GitHub App not installed for ${body.owner}/${body.repo}` };
	}

	// Generate installation token
	const token = await generateInstallationToken(env, installationId);

	return { token };
}
