// rest.ts — the REST v3 surface: the API root and meta, repository CRUD with Link-header
// pagination, branches, git refs, commit lists, the contents API, labels, issues and comments,
// and pull requests with their file diffs and squash merges. Every reply is JSON with a `message`
// on errors; shapes are GitHub's, with the fields the suite reads and a few honest extras.

import { encodeGlobalId, store, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { commitOf, flattenTree as flattenTreeImpl, getObject, parseTree, subtreeOid } from './gitobj.ts';
// (parseCommit lives in gitobj for the protocol layer; REST reads commits through commitOf.)
import {
  branchTip, createIssue, createPull, deleteContents, mergePull, pullFiles, putContents, readTip,
} from './domain.ts';
import type { Reply } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers };
}

function notFound(message = 'Not Found'): Reply {
  return json(404, { message });
}

function badRequest(message: string): Reply {
  return json(400, { message });
}

/** Parse a JSON request body; {} for an empty body, null for malformed JSON. */
function parseBody(body: Buffer): Record<string, unknown> | null {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function viewer(): string {
  return store.viewerLogin ?? '';
}

// ------------------------------------------------------------------ views

export function repoView(repo: RepoRec): Record<string, unknown> {
  const owner = viewer();
  return {
    id: repo.dbId,
    node_id: encodeGlobalId('Repository', [repo.dbId]),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner, id: 1000, type: 'User' },
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: store.isoAt(repo.seq),
    updated_at: store.isoAt(repo.seq),
    fork: false,
    archived: false,
  };
}

function labelView(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return {
    id: Math.abs(hash) + 1,
    node_id: encodeGlobalId('Label', [repo.dbId, name]),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: false,
  };
}

export function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeGlobalId('Issue', [repo.dbId, issue.number]),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelView(repo, name)),
    user: { login: viewer(), id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: store.isoAt(issue.seq),
    updated_at: store.isoAt(issue.seq),
    html_url: `https://github.com/${viewer()}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentView(repo: RepoRec, issue: IssueRec, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  void repo;
  void issue;
  return {
    id: comment.id,
    node_id: encodeGlobalId('Comment', [comment.id]),
    body: comment.body,
    user: { login: viewer(), id: 1000, type: 'User' },
    created_at: store.isoAt(comment.seq),
    updated_at: store.isoAt(comment.seq),
  };
}

export function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? '';
  const baseSha = branchTip(repo, pull.baseRef) ?? '';
  const owner = viewer();
  return {
    id: pull.id,
    node_id: encodeGlobalId('PullRequest', [repo.dbId, pull.number]),
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}` },
    user: { login: owner, id: 1000, type: 'User' },
    created_at: store.isoAt(pull.seq),
    updated_at: store.isoAt(pull.seq),
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ------------------------------------------------------------------ repositories

function createRepoReply(body: Buffer): Reply {
  const data = parseBody(body);
  if (data === null) return badRequest('Problems parsing JSON');
  const name = str(data.name);
  if (name === '') return json(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] });
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return json(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }] });
  const repo = store.createRepo(name, data.private === true, str(data.description));
  if (repo === null) {
    return json(422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  return json(201, repoView(repo));
}

function listUserRepos(query: URLSearchParams, host: string): Reply {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const all = store.allRepos();
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const last = Math.ceil(all.length / perPage);
    headers.link =
      `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next", ` +
      `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${last}>; rel="last"`;
  }
  return json(200, slice.map(repoView), headers);
}

function patchRepo(repo: RepoRec, body: Buffer): Reply {
  const data = parseBody(body);
  if (data === null) return badRequest('Problems parsing JSON');
  if (typeof data.description === 'string') repo.description = data.description;
  if (typeof data.private === 'boolean') repo.isPrivate = data.private;
  if (typeof data.name === 'string' && data.name !== '' && data.name !== repo.name) {
    if (store.repoByName(data.name) !== null) return json(422, { message: 'Repository rename failed: name already exists' });
    store.deleteRepo(repo.name);
    repo.name = data.name;
    store.repos.set(repo.name, repo);
  }
  if (typeof data.default_branch === 'string' && branchTip(repo, data.default_branch) !== null) {
    repo.defaultBranch = data.default_branch;
  }
  return json(200, repoView(repo));
}

// ------------------------------------------------------------------ branches, refs, commits

function listBranches(repo: RepoRec): Reply {
  const branches: Array<Record<string, unknown>> = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false });
  }
  return json(200, branches);
}

function listCommits(repo: RepoRec, query: URLSearchParams): Reply {
  const ref = query.get('sha');
  const tip = readTip(repo, ref);
  if (tip === null) return json(200, []);
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < 200) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    out.push({
      sha: commit.oid,
      node_id: encodeGlobalId('Commit', [commit.oid]),
      commit: {
        message: commit.info.message,
        tree: { sha: commit.info.tree },
        author: { name: 'Forge Bot', email: 'forge@localhost', date: store.isoAt(repo.seq) },
        committer: { name: 'Forge Bot', email: 'forge@localhost', date: store.isoAt(repo.seq) },
      },
      parents: commit.info.parents.map((parent) => ({ sha: parent })),
      author: { login: viewer(), id: 1000 },
      committer: { login: viewer(), id: 1000 },
    });
    for (const parent of commit.info.parents) queue.push(parent);
  }
  return json(200, out);
}

// ------------------------------------------------------------------ contents

function contentsGet(repo: RepoRec, parts: string[], query: URLSearchParams): Reply {
  const tip = readTip(repo, query.get('ref'));
  if (tip === null) return notFound('Not Found');
  const commit = commitOf(repo, tip);
  if (commit === null) return notFound('Not Found');
  const path = parts.join('/');
  if (path !== '') {
    // A file?
    const map = flattenTreeImpl(repo, commit.info.tree);
    const file = map.get(path);
    if (file !== undefined) {
      const object = getObject(repo, file.oid);
      if (object === null) return notFound('Not Found');
      const base64 = object.data.toString('base64').replace(/.{60}/g, '$&\n');
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: base64.endsWith('\n') ? base64 : `${base64}\n`,
        sha: file.oid,
        size: object.data.length,
        name: parts[parts.length - 1],
        path,
      });
    }
  }
  // A directory (or the root)?
  const dirOid = path === '' ? commit.info.tree : subtreeOid(repo, commit.info.tree, parts);
  if (dirOid === null) return notFound('Not Found');
  const dirObject = getObject(repo, dirOid);
  if (dirObject === null || dirObject.type !== 'tree') return notFound('Not Found');
  const entries = parseTree(dirObject.data).map((entry) => {
    const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : getObject(repo, entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: entryPath,
      sha: entry.oid,
      size: blob === null ? 0 : blob.data.length,
    };
  });
  return json(200, entries);
}

function contentsPut(repo: RepoRec, parts: string[], body: Buffer): Reply {
  const data = parseBody(body);
  if (data === null) return badRequest('Problems parsing JSON');
  const content = Buffer.from(str(data.content).replace(/\s/g, ''), 'base64');
  const result = putContents(
    repo,
    parts.join('/'),
    content,
    str(data.message) || 'update',
    typeof data.branch === 'string' ? data.branch : null,
    typeof data.sha === 'string' ? data.sha : null,
  );
  if (!result.ok) return json(result.status, { message: result.message });
  return json(result.status, {
    content: {
      name: parts[parts.length - 1],
      path: parts.join('/'),
      sha: result.blobOid,
      size: content.length,
      encoding: 'base64',
      type: 'file',
    },
    commit: { sha: result.commitOid, message: str(data.message) || 'update' },
  });
}

function contentsDelete(repo: RepoRec, parts: string[], body: Buffer): Reply {
  const data = parseBody(body);
  if (data === null) return badRequest('Problems parsing JSON');
  const path = parts.join('/');
  const branch = typeof data.branch === 'string' ? data.branch : null;
  const tip = branchTip(repo, branch ?? repo.defaultBranch);
  if (tip === null) return notFound('Not Found');
  const map = new Map<string, { oid: string; mode: string }>();
  const commit = commitOf(repo, tip);
  if (commit !== null) for (const [key, value] of flattenTreeImpl(repo, commit.info.tree)) map.set(key, value);
  const existing = map.get(path);
  if (existing === undefined) return notFound('Not Found');
  if (typeof data.sha === 'string' && data.sha !== existing.oid) {
    return json(409, { message: `${path} has changed since it was read: sha does not match` });
  }
  const result = deleteContents(repo, path, str(data.message) || 'delete', branch);
  if (!result.ok) return json(result.status, { message: result.message });
  return json(200, { content: null, commit: { sha: result.commitOid, message: str(data.message) || 'delete' } });
}

// ------------------------------------------------------------------ labels, issues, pulls

function paginate<T>(items: T[], query: URLSearchParams): T[] {
  const perPageRaw = query.get('per_page');
  const pageRaw = query.get('page');
  if (perPageRaw === null && pageRaw === null) return items;
  const perPage = Math.max(1, Number.parseInt(perPageRaw ?? '30', 10) || 30);
  const page = Math.max(1, Number.parseInt(pageRaw ?? '1', 10) || 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

function listIssues(repo: RepoRec, query: URLSearchParams): Reply {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  return json(200, paginate(issues, query).map((issue) => issueView(repo, issue)));
}

function listPulls(repo: RepoRec, query: URLSearchParams): Reply {
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed' || pull.merged);
  pulls.sort((a, b) => a.number - b.number);
  return json(200, paginate(pulls, query).map((pull) => pullView(repo, pull)));
}

// ------------------------------------------------------------------ the router

/** Handle one /api/v3 request. `segments` are the decoded path segments after /api/v3. */
export function handleRest(method: string, segments: string[], query: URLSearchParams, body: Buffer, host: string): Reply {
  if (segments.length === 0) {
    if (method === 'GET') {
      return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return json(200, { installed_version: '1.0.0', git_version: 'forge-1.0' });
    return notFound();
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      if (store.viewerLogin === null) return notFound();
      return json(200, { login: store.viewerLogin, id: 1000, type: 'User' });
    }
    return notFound();
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') return createRepoReply(body);
    if (method === 'GET') return listUserRepos(query, host);
    return notFound();
  }
  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const repo = store.repoFor(segments[1], segments[2]);
  if (repo === null) return notFound();
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoView(repo));
    if (method === 'PATCH') return patchRepo(repo, body);
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      return { status: 204, contentType: '', body: Buffer.alloc(0) };
    }
    return notFound();
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') return listBranches(repo);
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const tip = branchTip(repo, name);
      if (tip === null) return notFound();
      return json(200, { name, commit: { sha: tip }, protected: false });
    }
    return notFound();
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const data = parseBody(body);
      if (data === null) return badRequest('Problems parsing JSON');
      const ref = str(data.ref);
      const sha = str(data.sha);
      const object = getObject(repo, sha);
      if (object === null) return json(422, { message: `Validation Failed: object ${sha} does not exist` });
      if (repo.refs.has(ref)) return json(422, { message: `Validation Failed: reference ${ref} already exists` });
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: object.type } });
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound();
      const object = getObject(repo, oid);
      return json(200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
    }
    return notFound();
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(repo, query);

  if (rest[0] === 'contents') {
    const parts = rest.slice(1);
    if (method === 'GET') return contentsGet(repo, parts, query);
    if (method === 'PUT') return contentsPut(repo, parts, body);
    if (method === 'DELETE') return contentsDelete(repo, parts, body);
    return notFound();
  }

  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return json(200, [...repo.labels.keys()].sort().map((name) => labelView(repo, name)));
    }
    if (rest.length === 1 && method === 'POST') {
      const data = parseBody(body);
      if (data === null) return badRequest('Problems parsing JSON');
      const name = str(data.name);
      if (name === '') return json(422, { message: 'Validation Failed: name is required' });
      if (repo.labels.has(name)) return json(422, { message: 'Validation Failed: label already exists' });
      repo.labels.set(name, { name, color: str(data.color).replace(/^#/, '') || 'ededed', description: str(data.description) });
      return json(201, labelView(repo, name));
    }
    return notFound();
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return listIssues(repo, query);
      if (method === 'POST') {
        const data = parseBody(body);
        if (data === null) return badRequest('Problems parsing JSON');
        const labels: string[] = [];
        if (Array.isArray(data.labels)) {
          for (const entry of data.labels) {
            if (typeof entry === 'string') labels.push(entry);
            else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
              labels.push((entry as { name: string }).name);
            }
          }
        }
        const result = createIssue(repo, str(data.title), str(data.body), labels);
        if (!result.ok || result.issue === undefined) return json(result.status, { message: result.message });
        return json(201, issueView(repo, result.issue));
      }
      return notFound();
    }
    const number = Number.parseInt(rest[1], 10);
    const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) {
        const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
        if (pull !== undefined && method === 'GET') {
          return json(200, {
            id: pull.id, number: pull.number, title: pull.title, body: pull.body,
            state: pull.merged ? 'closed' : pull.state, labels: [],
            user: { login: viewer(), id: 1000 },
            pull_request: { merged: pull.merged },
            created_at: store.isoAt(pull.seq), updated_at: store.isoAt(pull.seq),
          });
        }
        return notFound();
      }
      if (method === 'GET') return json(200, issueView(repo, issue));
      if (method === 'PATCH') {
        const data = parseBody(body);
        if (data === null) return badRequest('Problems parsing JSON');
        if (data.state === 'closed' || data.state === 'open') issue.state = data.state;
        if (typeof data.title === 'string') issue.title = data.title;
        if (typeof data.body === 'string') issue.body = data.body;
        return json(200, issueView(repo, issue));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'GET') return json(200, issue.comments.map((comment) => commentView(repo, issue, comment)));
      if (method === 'POST') {
        const data = parseBody(body);
        if (data === null) return badRequest('Problems parsing JSON');
        const comment = { id: store.nextCommentId(), body: str(data.body), seq: store.nextSeq() };
        issue.comments.push(comment);
        return json(201, commentView(repo, issue, comment));
      }
      return notFound();
    }
    return notFound();
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return listPulls(repo, query);
      if (method === 'POST') {
        const data = parseBody(body);
        if (data === null) return badRequest('Problems parsing JSON');
        const result = createPull(repo, str(data.title), str(data.body), str(data.head), str(data.base));
        if (!result.ok || result.pull === undefined) return json(result.status, { message: result.message });
        return json(201, pullView(repo, result.pull));
      }
      return notFound();
    }
    const number = Number.parseInt(rest[1], 10);
    const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
    if (pull === undefined) return notFound();
    if (rest.length === 2 && method === 'GET') return json(200, pullView(repo, pull));
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      return json(200, pullFiles(repo, pull).map((file) => ({
        filename: file.filename, status: file.status, additions: file.additions,
        deletions: file.deletions, changes: file.changes, sha: file.sha,
      })));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const data = parseBody(body);
      if (data === null) return badRequest('Problems parsing JSON');
      const result = mergePull(repo, pull);
      if (!result.ok) return json(result.status, { message: result.message });
      return json(200, { sha: result.sha, merged: true, message: result.message });
    }
    return notFound();
  }

  return notFound();
}
