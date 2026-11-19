// store.ts — the forge's whole world in memory: repositories, their git object stores, refs,
// issues, pull requests, labels and comments. One process, one store, no disk: the trial hands
// the forge a fresh process and drives every surface (git smart HTTP, REST v3, GraphQL v4, MCP)
// against the same objects, so an issue created over MCP is the issue REST reads back.
//
// Ownership model: the suite's bearer token names one login, but the forge is never told which.
// The first owner segment any surface presents (a git path, a /repos/{owner}/... path, a GraphQL
// variable, an MCP argument) claims the login; every repository belongs to it, and a repository
// addressed under any other owner is a 404, never a 403 — GitHub hides what you cannot see.

/** One git object: its type and its raw (uncompressed) bytes. */
export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
}

export interface RepoRec {
  /** The numeric id GraphQL calls databaseId; REST exposes it as `id`. */
  dbId: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** oid -> object, this repository's private object store. */
  objects: Map<string, GitObject>;
  /** full ref name (refs/heads/main) -> oid. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as they do on GitHub. */
  nextNumber: number;
  seq: number;
}

/** The epoch every synthetic timestamp hangs off (2025-01-01T00:00:00Z). */
const EPOCH_MS = 1_735_689_600_000;

class Store {
  repos = new Map<string, RepoRec>();
  viewerLogin: string | null = null;
  private seqCounter = 0;
  private repoIdCounter = 5000;
  private issueIdCounter = 100_000;
  private commentIdCounter = 200_000;

  /** A monotonically increasing sequence number: creation order without a wall clock. */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  /** An ISO timestamp derived from a sequence number, so repeated reads never drift. */
  isoAt(seq: number): string {
    return new Date(EPOCH_MS + seq * 1000).toISOString();
  }

  nowIso(): string {
    return this.isoAt(this.nextSeq());
  }

  nextRepoId(): number {
    this.repoIdCounter += 1;
    return this.repoIdCounter;
  }

  nextIssueId(): number {
    this.issueIdCounter += 1;
    return this.issueIdCounter;
  }

  nextCommentId(): number {
    this.commentIdCounter += 1;
    return this.commentIdCounter;
  }

  /**
   * Claim the token owner's login from the first owner segment seen, or verify a later one.
   * Returns true when `login` is (now) the owner; false when another login already owns the forge.
   */
  claimLogin(login: string): boolean {
    if (login === '') return false;
    if (this.viewerLogin === null) {
      this.viewerLogin = login;
      return true;
    }
    return this.viewerLogin === login;
  }

  /** Create a repository owned by the token's login (claimed or not — it adopts the claim). */
  createRepo(name: string, isPrivate: boolean, description: string): RepoRec | null {
    if (this.repos.has(name)) return null;
    const repo: RepoRec = {
      dbId: this.nextRepoId(),
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.nextSeq(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * The repository addressed as {owner}/{name}, or null when it must read as Not Found:
   * either the owner is not the token's login, or no repository carries the name.
   */
  repoFor(owner: string, name: string): RepoRec | null {
    if (!this.claimLogin(owner)) return null;
    return this.repos.get(name) ?? null;
  }

  /** A repository by name alone (surfaces that already know the owner, e.g. a global id). */
  repoByName(name: string): RepoRec | null {
    return this.repos.get(name) ?? null;
  }

  /** Every repository the viewer owns, in creation order. */
  allRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }
}

/** The one store the whole process shares. */
export const store = new Store();

/** GitHub's zero oid, the "no object" sentinel of the wire protocols. */
export const ZERO_OID = '0'.repeat(40);

/** Whether a string is a full 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * Global (Relay-style) ids: base64 of `Kind:part:part...`, self-describing so node(id:) can route
 * without a lookup table, opaque enough that an id never equals the plain numeric id it wraps,
 * and stable because every part is a permanent id from the store.
 */
export function encodeGlobalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id into its kind and parts, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}
