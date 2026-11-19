// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP.
// It speaks the modern revision (server/discover, no handshake) and the legacy initialize
// handshake, and its six tools act on the very same store as REST and GraphQL — an issue created
// here is the issue /api/v3 lists, with the same ids. The tools list is a fixed value, so two
// tools/list answers are byte-identical by construction.

import { store } from './store.ts';
import { createIssue, createPull, mergePull } from './domain.ts';
import { issueView, pullView, repoView } from './rest.ts';
import type { Reply } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: true, required };
}

const OWNER_REPO = {
  owner: { type: 'string', description: 'The repository owner login.' },
  repo: { type: 'string', description: 'The repository name.' },
};

/** The tool catalogue: fixed at module load, listed identically forever. */
export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: objectSchema({ ...OWNER_REPO }, ['owner', 'repo']),
  },
  {
    name: 'list_repos',
    description: 'List the repositories the authenticated user owns.',
    inputSchema: objectSchema({}, []),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List a repository’s issues, optionally filtered by state (open, closed, all).',
    inputSchema: objectSchema(
      { ...OWNER_REPO, state: { type: 'string', description: 'open, closed or all.' } },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: objectSchema(
      { ...OWNER_REPO, issue_number: { type: 'number', description: 'The issue number.' } },
      ['owner', 'repo', 'issue_number'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: objectSchema(
      { ...OWNER_REPO, pull_number: { type: 'number', description: 'The pull request number.' } },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function rpcResult(id: unknown, result: unknown): Reply {
  return { status: 200, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): Reply {
  return { status, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })) };
}

function toolOk(view: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(view) }],
    structuredContent: view as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/** Run one tool against the store; answers the CallToolResult object. */
function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const tool = TOOL_BY_NAME.get(name);
  if (tool === undefined) return null;
  const required = (tool.inputSchema.required as string[]) ?? [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) throw new ToolParamError(`missing required argument(s): ${missing.join(', ')}`);

  switch (name) {
    case 'create_repo': {
      // An explicit owner argument names the token's login, like every other surface's owner does.
      if (typeof args.owner === 'string' && args.owner !== '') store.claimLogin(args.owner);
      const repoName = argStr(args, 'name');
      const existing = store.repoByName(repoName);
      if (existing !== null) return toolOk(repoView(existing));
      const repo = store.createRepo(repoName, args.private === true, argStr(args, 'description'));
      if (repo === null) return toolError(`repository ${repoName} already exists`);
      return toolOk(repoView(repo));
    }
    case 'get_repo': {
      const repo = store.repoFor(argStr(args, 'owner'), argStr(args, 'repo'));
      return repo === null ? toolError('repository not found') : toolOk(repoView(repo));
    }
    case 'list_repos': {
      return toolOk(store.allRepos().map((repo) => repoView(repo)));
    }
    case 'create_issue': {
      const repo = store.repoFor(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const result = createIssue(repo, argStr(args, 'title'), argStr(args, 'body'), []);
      if (!result.ok || result.issue === undefined) return toolError(result.message);
      return toolOk(issueView(repo, result.issue));
    }
    case 'list_issues': {
      const repo = store.repoFor(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const state = argStr(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolOk(issues.map((issue) => issueView(repo, issue)));
    }
    case 'get_issue': {
      const repo = store.repoFor(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      return issue === undefined ? toolError('issue not found') : toolOk(issueView(repo, issue));
    }
    case 'create_pull_request': {
      const repo = store.repoFor(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const result = createPull(repo, argStr(args, 'title'), argStr(args, 'body'), argStr(args, 'head'), argStr(args, 'base'));
      if (!result.ok || result.pull === undefined) return toolError(result.message);
      return toolOk(pullView(repo, result.pull));
    }
    case 'merge_pull_request': {
      const repo = store.repoFor(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError('pull request not found');
      const result = mergePull(repo, pull);
      if (!result.ok) return toolError(result.message);
      return toolOk(pullView(repo, pull));
    }
    default:
      return null;
  }
}

class ToolParamError extends Error {}

/** Handle one JSON-RPC request object; null means "notification — no reply". */
function handleRpc(request: Record<string, unknown>): Reply | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  if (id === undefined || id === null) {
    // A notification (notifications/initialized and friends): accepted, never answered.
    return null;
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: {
          'io.modelcontextprotocol/serverInfo': SERVER_INFO,
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        const result = callTool(toolName, args);
        if (result === null) return rpcError(id, -32602, `unknown tool: ${toolName}`);
        return rpcResult(id, result);
      } catch (err) {
        if (err instanceof ToolParamError) return rpcError(id, -32602, err.message);
        throw err;
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** POST /mcp. Auth is enforced by the caller (app.ts) before this runs. */
export function handleMcp(body: Buffer): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      const reply = handleRpc((entry ?? {}) as Record<string, unknown>);
      if (reply !== null) replies.push(JSON.parse(reply.body.toString('utf8')));
    }
    return { status: 200, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify(replies)) };
  }
  if (typeof parsed !== 'object' || parsed === null) return rpcError(null, -32600, 'Invalid request', 400);
  const reply = handleRpc(parsed as Record<string, unknown>);
  if (reply === null) return { status: 202, contentType: '', body: Buffer.alloc(0) };
  return reply;
}
