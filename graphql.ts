// graphql.ts — GraphQL v4 at /api/graphql: a small hand-written parser and executor covering the
// documents gh and github-mcp-server actually send — viewer, repository reads, issue and pull
// request queries and mutations, Relay node(id:), cursor pagination, batched operations, and the
// __type introspection probes those clients feature-detect with. Unknown fields answer the
// GitHub way: HTTP 200 with an `errors` array naming the field.

import { decodeGlobalId, encodeGlobalId, store, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { createIssue, createPull, mergePull, pullFiles, pullMergeable } from './domain.ts';
import type { Reply } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < input.length) {
    const ch = input[pos];
    if (ch === '#') {
      while (pos < input.length && input[pos] !== '\n') pos += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      pos += 1;
      continue;
    }
    if (input.startsWith('...', pos)) {
      tokens.push({ kind: 'spread' });
      pos += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', pos)) {
        const end = input.indexOf('"""', pos + 3);
        tokens.push({ kind: 'string', value: input.slice(pos + 3, end === -1 ? input.length : end) });
        pos = end === -1 ? input.length : end + 3;
        continue;
      }
      let value = '';
      pos += 1;
      while (pos < input.length && input[pos] !== '"') {
        if (input[pos] === '\\') {
          const esc = input[pos + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          pos += 2;
        } else {
          value += input[pos];
          pos += 1;
        }
      }
      pos += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(pos));
      if (match === null) throw new Error(`bad number at ${pos}`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      pos += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(pos));
      if (match === null) throw new Error(`bad name at ${pos}`);
      tokens.push({ kind: 'name', value: match[0] });
      pos += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${pos}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'scalar'; value: string | number | boolean | null }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[] | null;
}

type Selection =
  | FieldSel
  | { kind: 'inline'; typeCondition: string; selections: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment');
      if (token.value === 'query' || token.value === 'mutation') {
        const type = token.value;
        this.next();
        let name: string | null = null;
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'name') name = this.expectName();
        if (this.isPunct('(')) this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.isPunct('=')) {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.isPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'name' && ahead.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.isPunct(':')) {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args: Array<{ name: string; value: Value }> = [];
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      this.skipDirectives();
      const sub = this.isPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'scalar', value: token.value };
    if (token.kind === 'number') return { kind: 'scalar', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'scalar', value: true };
      if (token.value === 'false') return { kind: 'scalar', value: false };
      if (token.value === 'null') return { kind: 'scalar', value: null };
      return { kind: 'scalar', value: token.value }; // an enum, carried as its name
    }
    throw new Error('unexpected value token');
  }
}

/** Evaluate a parsed value against the operation's variables. */
function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'scalar':
      return value.value;
    case 'list':
      return value.values.map((entry) => evalValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema surface

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  User: ['login', 'id', 'name', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'isFork', 'createdAt', 'updatedAt', 'url', 'primaryLanguage',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'repository',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt',
    'mergeCommit', 'url', 'repository',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'prefix', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

/** Field return types, for steering the executor into sub-selections. */
const FIELD_TYPES: Record<string, Record<string, { type: string; list?: boolean }>> = {
  Query: {
    viewer: { type: 'User' },
    repository: { type: 'Repository' },
    node: { type: 'Node' },
    __type: { type: '__Type' },
    __schema: { type: '__Schema' },
  },
  Mutation: {
    createIssue: { type: 'CreateIssuePayload' },
    closeIssue: { type: 'CloseIssuePayload' },
    createPullRequest: { type: 'CreatePullRequestPayload' },
    mergePullRequest: { type: 'MergePullRequestPayload' },
    addComment: { type: 'AddCommentPayload' },
  },
  Repository: {
    owner: { type: 'User' },
    defaultBranchRef: { type: 'Ref' },
    issue: { type: 'Issue' },
    issues: { type: 'IssueConnection' },
    pullRequest: { type: 'PullRequest' },
    pullRequests: { type: 'PullRequestConnection' },
  },
  IssueConnection: { nodes: { type: 'Issue', list: true }, pageInfo: { type: 'PageInfo' } },
  PullRequestConnection: { nodes: { type: 'PullRequest', list: true }, pageInfo: { type: 'PageInfo' } },
  PullRequest: { files: { type: 'PullRequestChangedFileConnection' } },
  PullRequestChangedFileConnection: { nodes: { type: 'PullRequestChangedFile', list: true }, pageInfo: { type: 'PageInfo' } },
  CreateIssuePayload: { issue: { type: 'Issue' } },
  CloseIssuePayload: { issue: { type: 'Issue' } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  AddCommentPayload: { commentEdge: { type: 'CommentEdge' }, subject: { type: 'Issue' } },
  CommentEdge: { node: { type: 'IssueComment' } },
  __Type: { fields: { type: '__Field', list: true }, enumValues: { type: '__EnumValue', list: true } },
};

// ------------------------------------------------------------------ wrapped values

type Wrapped = Record<string, unknown> & { __gqlType: string };

function wrap(type: string, fields: Record<string, unknown>): Wrapped {
  return { __gqlType: type, ...fields };
}

function repoWrap(repo: RepoRec): Wrapped {
  return wrap('Repository', { repo });
}

function issueWrap(repo: RepoRec, issue: IssueRec): Wrapped {
  return wrap('Issue', { repo, issue });
}

function pullWrap(repo: RepoRec, pull: PullRec): Wrapped {
  return wrap('PullRequest', { repo, pull });
}

function repoByDbId(dbId: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

/** Find a wrapped object anywhere a global id can name one (node(id:) and mutation inputs). */
function objectByGlobalId(id: string): Wrapped | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const [first, second] = decoded.parts;
  if (decoded.kind === 'Repository') {
    const repo = repoByDbId(Number(first));
    return repo === null ? null : repoWrap(repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repo = repoByDbId(Number(first));
    if (repo === null) return null;
    const number = Number(second);
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueWrap(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullWrap(repo, pull);
  }
  if (decoded.kind === 'User') return wrap('User', {});
  return null;
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ resolvers

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
  errors: Array<{ message: string }>;
}

type Resolver = (source: Wrapped, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => wrap('User', {}),
    repository: (_source, args) => {
      const repo = store.repoFor(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : repoWrap(repo);
    },
    node: (_source, args) => objectByGlobalId(String(args.id ?? '')),
    __type: (_source, args) => {
      const name = String(args.name ?? '');
      if (SCHEMA_FIELDS[name] !== undefined || SCHEMA_ENUMS[name] !== undefined) return wrap('__Type', { name });
      return null;
    },
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = objectByGlobalId(String(input.repositoryId ?? ''));
      if (target === null || target.__gqlType !== 'Repository') {
        ctx.errors.push({ message: 'createIssue: repository not found' });
        return null;
      }
      const repo = target.repo as RepoRec;
      const result = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if (!result.ok || result.issue === undefined) {
        ctx.errors.push({ message: `createIssue: ${result.message}` });
        return null;
      }
      return wrap('CreateIssuePayload', { issue: issueWrap(repo, result.issue) });
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = objectByGlobalId(String(input.issueId ?? ''));
      if (target === null || target.__gqlType !== 'Issue') {
        ctx.errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      const issue = target.issue as IssueRec;
      issue.state = 'closed';
      return wrap('CloseIssuePayload', { issue: target });
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = objectByGlobalId(String(input.repositoryId ?? ''));
      if (target === null || target.__gqlType !== 'Repository') {
        ctx.errors.push({ message: 'createPullRequest: repository not found' });
        return null;
      }
      const repo = target.repo as RepoRec;
      const result = createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if (!result.ok || result.pull === undefined) {
        ctx.errors.push({ message: `createPullRequest: ${result.message}` });
        return null;
      }
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrap(repo, result.pull) });
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = objectByGlobalId(String(input.pullRequestId ?? ''));
      if (target === null || target.__gqlType !== 'PullRequest') {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      const repo = target.repo as RepoRec;
      const pull = target.pull as PullRec;
      const result = mergePull(repo, pull);
      if (!result.ok) {
        ctx.errors.push({ message: `mergePullRequest: ${result.message}` });
        return null;
      }
      return wrap('MergePullRequestPayload', { pullRequest: target });
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = objectByGlobalId(String(input.subjectId ?? ''));
      if (target === null || target.__gqlType !== 'Issue') {
        ctx.errors.push({ message: 'addComment: subject not found' });
        return null;
      }
      const repo = target.repo as RepoRec;
      const issue = target.issue as IssueRec;
      const comment = { id: store.nextCommentId(), body: String(input.body ?? ''), seq: store.nextSeq() };
      issue.comments.push(comment);
      void repo;
      return wrap('AddCommentPayload', {
        commentEdge: wrap('CommentEdge', { node: wrap('IssueComment', { comment }) }),
        subject: target,
      });
    },
  },
  User: {
    login: () => store.viewerLogin ?? '',
    id: () => encodeGlobalId('User', [1000]),
    name: () => store.viewerLogin ?? '',
  },
  Repository: {
    id: (source) => encodeGlobalId('Repository', [(source.repo as RepoRec).dbId]),
    databaseId: (source) => (source.repo as RepoRec).dbId,
    name: (source) => (source.repo as RepoRec).name,
    nameWithOwner: (source) => `${store.viewerLogin ?? ''}/${(source.repo as RepoRec).name}`,
    owner: () => wrap('User', {}),
    description: (source) => (source.repo as RepoRec).description,
    isPrivate: (source) => (source.repo as RepoRec).isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    defaultBranchRef: (source) => {
      const repo = source.repo as RepoRec;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : wrap('Ref', { name: repo.defaultBranch });
    },
    issue: (source, args) => {
      const repo = source.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueWrap(repo, issue);
    },
    issues: (source, args) => {
      const repo = source.repo as RepoRec;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'DESC');
      issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      const total = issues.length;
      const after = typeof args.after === 'string' ? numberOfCursor(args.after) : null;
      let start = 0;
      if (after !== null) {
        const index = issues.findIndex((issue) => issue.number === after);
        if (index >= 0) start = index + 1;
      }
      const first = typeof args.first === 'number' ? args.first : total;
      const page = issues.slice(start, start + Math.max(0, first));
      return wrap('IssueConnection', {
        nodes: page.map((issue) => issueWrap(repo, issue)),
        pageInfo: wrap('PageInfo', {
          hasNextPage: start + page.length < total,
          hasPreviousPage: start > 0,
          startCursor: page.length === 0 ? null : cursorOf(page[0].number),
          endCursor: page.length === 0 ? null : cursorOf(page[page.length - 1].number),
        }),
        totalCount: total,
      });
    },
    pullRequest: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullWrap(repo, pull);
    },
    pullRequests: (source, args) => {
      const repo = source.repo as RepoRec;
      const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      const first = typeof args.first === 'number' ? args.first : pulls.length;
      const page = pulls.slice(0, Math.max(0, first));
      return wrap('PullRequestConnection', {
        nodes: page.map((pull) => pullWrap(repo, pull)),
        pageInfo: wrap('PageInfo', {
          hasNextPage: page.length < pulls.length,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        }),
        totalCount: pulls.length,
      });
    },
  },
  Issue: {
    id: (source) => encodeGlobalId('Issue', [(source.repo as RepoRec).dbId, (source.issue as IssueRec).number]),
    databaseId: (source) => (source.issue as IssueRec).id,
    number: (source) => (source.issue as IssueRec).number,
    title: (source) => (source.issue as IssueRec).title,
    body: (source) => (source.issue as IssueRec).body,
    state: (source) => (source.issue as IssueRec).state.toUpperCase(),
  },
  PullRequest: {
    id: (source) => encodeGlobalId('PullRequest', [(source.repo as RepoRec).dbId, (source.pull as PullRec).number]),
    databaseId: (source) => (source.pull as PullRec).id,
    number: (source) => (source.pull as PullRec).number,
    title: (source) => (source.pull as PullRec).title,
    body: (source) => (source.pull as PullRec).body,
    state: (source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.pull as PullRec).merged,
    headRefName: (source) => (source.pull as PullRec).headRef,
    baseRefName: (source) => (source.pull as PullRec).baseRef,
    mergeable: (source) => {
      const pull = source.pull as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullMergeable(source.repo as RepoRec, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      const files = pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : files.length;
      return wrap('PullRequestChangedFileConnection', {
        nodes: files.slice(0, Math.max(0, first)).map((file) => wrap('PullRequestChangedFile', {
          path: file.filename, additions: file.additions, deletions: file.deletions,
        })),
        pageInfo: wrap('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
        totalCount: files.length,
      });
    },
  },
  Ref: {
    name: (source) => source.name as string,
  },
  IssueComment: {
    id: (source) => encodeGlobalId('IssueComment', [(source.comment as { id: number }).id]),
    body: (source) => (source.comment as { body: string }).body,
  },
  __Type: {
    name: (source) => source.name as string,
    kind: (source) => (SCHEMA_ENUMS[source.name as string] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (source) => (SCHEMA_FIELDS[source.name as string] ?? []).map((name) => wrap('__Field', { name })),
    enumValues: (source) => (SCHEMA_ENUMS[source.name as string] ?? []).map((name) => wrap('__EnumValue', { name })),
  },
  __Field: {
    name: (source) => source.name as string,
  },
  __EnumValue: {
    name: (source) => source.name as string,
  },
};

// ------------------------------------------------------------------ executor

function executeSelections(typeName: string, source: Wrapped | null, selections: Selection[], ctx: Ctx): Record<string, unknown> | null {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  const expand = (sels: Selection[], currentType: string): void => {
    for (const sel of sels) {
      if (sel.kind === 'inline') {
        if (sel.typeCondition === currentType || sel.typeCondition === 'Node') expand(sel.selections, currentType);
        continue;
      }
      if (sel.kind === 'spread') {
        const fragment = ctx.fragments.get(sel.name);
        if (fragment !== undefined && fragment.typeCondition === currentType) expand(fragment.selections, currentType);
        continue;
      }
      const key = sel.alias ?? sel.name;
      if (sel.name === '__typename') {
        out[key] = currentType;
        continue;
      }
      const resolver = RESOLVERS[currentType]?.[sel.name];
      if (resolver === undefined) {
        // Passthrough wrappers (connections, mutation payloads, page info) carry their fields as
        // plain properties; a name the wrapper does not carry is a genuine unknown field.
        if (Object.prototype.hasOwnProperty.call(source, sel.name)) {
          out[key] = completeValue(currentType, sel, source[sel.name], ctx);
          continue;
        }
        ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${currentType}'` });
        out[key] = null;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const arg of sel.args) args[arg.name] = evalValue(arg.value, ctx.variables);
      const value = resolver(source, args, ctx);
      out[key] = completeValue(currentType, sel, value, ctx);
    }
  };
  expand(selections, typeName);
  return out;
}

function completeValue(parentType: string, sel: FieldSel, value: unknown, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (sel.selections === null) return value;
  const fieldType = FIELD_TYPES[parentType]?.[sel.name];
  if (Array.isArray(value)) {
    const itemType = fieldType?.type ?? 'Node';
    return value.map((item) => executeSelections(itemType === 'Node' ? (item as Wrapped).__gqlType : itemType, item as Wrapped, sel.selections!, ctx));
  }
  const wrapped = value as Wrapped;
  const type = fieldType?.type === 'Node' || fieldType === undefined ? wrapped.__gqlType : fieldType.type;
  return executeSelections(type, wrapped, sel.selections, ctx);
}

/** Execute one GraphQL document (one operation) and answer the response body object. */
function executeOne(payload: Record<string, unknown>): Record<string, unknown> {
  const query = typeof payload.query === 'string' ? payload.query : '';
  const variables = (typeof payload.variables === 'object' && payload.variables !== null ? payload.variables : {}) as Record<string, unknown>;
  const operationName = typeof payload.operationName === 'string' ? payload.operationName : null;
  let document: Document;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: `Syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in document' }] };
  const ctx: Ctx = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, wrap(rootType, {}), operation.selections, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

/** POST /api/graphql: a single document, or a batched array answered in order. */
export function handleGraphQL(body: Buffer): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] })) };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOne((entry ?? {}) as Record<string, unknown>));
    return { status: 200, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify(results)) };
  }
  const result = executeOne((parsed ?? {}) as Record<string, unknown>);
  return { status: 200, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify(result)) };
}
