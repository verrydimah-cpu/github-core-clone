// domain.ts — the operations every surface shares, written once against the store: committing a
// file through the contents API, opening an issue or a pull request, diffing a pull request, and
// merging one (three-way, per path, squash). REST, GraphQL and MCP are three spellings of these.

import { store, ZERO_OID, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import {
  buildTreeFromMap, commitOf, getObject, isAncestor, makeCommit, mergeBase, putObject,
  treeMapOfCommit,
} from './gitobj.ts';

/** A branch's tip commit id, or null when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a ref-ish string (branch name, full ref, tag, or raw oid) to a commit id, or null. */
export function resolveCommit(repo: RepoRec, ref: string): string | null {
  const direct = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  const oid = direct ?? (getObject(repo, ref) !== null ? ref : null);
  if (oid === null) return null;
  const commit = commitOf(repo, oid);
  return commit === null ? null : commit.oid;
}

/** The tip a contents/commits read should use: the named ref, else the default branch. */
export function readTip(repo: RepoRec, ref: string | null): string | null {
  if (ref !== null && ref !== '') return resolveCommit(repo, ref);
  return branchTip(repo, repo.defaultBranch);
}

export interface ContentsResult {
  ok: boolean;
  status: number;
  message: string;
  blobOid?: string;
  commitOid?: string;
  created?: boolean;
}

/**
 * Create or update a file on a branch, as the contents API does: a stale `sha` is a 409, a write
 * to an unborn default branch makes the first commit, a write to a fresh named branch forks it
 * from the default branch's tip.
 */
export function putContents(
  repo: RepoRec,
  path: string,
  content: Buffer,
  message: string,
  branch: string | null,
  sha: string | null,
): ContentsResult {
  const target = branch ?? repo.defaultBranch;
  let tip = branchTip(repo, target);
  if (tip === null && branch !== null && target !== repo.defaultBranch) {
    tip = branchTip(repo, repo.defaultBranch);
  }
  const map = tip === null ? new Map<string, { oid: string; mode: string }>() : treeMapOfCommit(repo, tip);
  const existing = map.get(path);
  if (sha !== null && existing !== undefined && existing.oid !== sha) {
    return { ok: false, status: 409, message: `${path} has changed since it was read: sha does not match` };
  }
  if (sha !== null && existing === undefined && tip !== null) {
    return { ok: false, status: 404, message: `${path} does not exist on ${target}` };
  }
  const blobOid = putObject(repo, 'blob', content);
  map.set(path, { oid: blobOid, mode: '100644' });
  const tree = buildTreeFromMap(repo, map);
  const commitOid = makeCommit(repo, tree, tip === null ? [] : [tip], message, store.nextSeq());
  repo.refs.set(`refs/heads/${target}`, commitOid);
  return { ok: true, status: existing === undefined ? 201 : 200, message: 'ok', blobOid, commitOid, created: existing === undefined };
}

/** Delete a file through the contents API (the caller checks the sha first). */
export function deleteContents(repo: RepoRec, path: string, message: string, branch: string | null): ContentsResult {
  const target = branch ?? repo.defaultBranch;
  const tip = branchTip(repo, target);
  if (tip === null) return { ok: false, status: 404, message: 'branch not found' };
  const map = treeMapOfCommit(repo, tip);
  if (!map.has(path)) return { ok: false, status: 404, message: `${path} does not exist` };
  map.delete(path);
  const tree = buildTreeFromMap(repo, map);
  const commitOid = makeCommit(repo, tree, [tip], message, store.nextSeq());
  repo.refs.set(`refs/heads/${target}`, commitOid);
  return { ok: true, status: 200, message: 'ok', commitOid };
}

export interface IssueResult {
  ok: boolean;
  status: number;
  message: string;
  issue?: IssueRec;
}

/** Open an issue; a label that does not exist on the repository is a 422, as GitHub answers. */
export function createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueResult {
  for (const label of labels) {
    if (!repo.labels.has(label)) {
      return { ok: false, status: 422, message: `Validation Failed: label "${label}" does not exist on this repository` };
    }
  }
  const issue: IssueRec = {
    id: store.nextIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: store.nextSeq(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { ok: true, status: 201, message: 'ok', issue };
}

export interface PullResult {
  ok: boolean;
  status: number;
  message: string;
  pull?: PullRec;
}

/** Open a pull request between two existing branches; a duplicate open request is a 422. */
export function createPull(repo: RepoRec, title: string, body: string, head: string, base: string): PullResult {
  const cleanHead = head.includes(':') ? head.split(':').pop()! : head;
  const cleanBase = base.includes(':') ? base.split(':').pop()! : base;
  if (branchTip(repo, cleanHead) === null) return { ok: false, status: 422, message: `Validation Failed: head branch "${cleanHead}" does not exist` };
  if (branchTip(repo, cleanBase) === null) return { ok: false, status: 422, message: `Validation Failed: base branch "${cleanBase}" does not exist` };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === cleanHead && pull.baseRef === cleanBase) {
      return { ok: false, status: 422, message: `Validation Failed: a pull request already exists for ${cleanHead} into ${cleanBase}` };
    }
  }
  const pull: PullRec = {
    id: store.nextIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: cleanHead,
    baseRef: cleanBase,
    seq: store.nextSeq(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { ok: true, status: 201, message: 'ok', pull };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** The file-level diff between a pull request's base tip tree and head tip tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): FileDiff[] {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  const baseMap = baseTip === null ? new Map<string, { oid: string; mode: string }>() : treeMapOfCommit(repo, baseTip);
  const headMap = headTip === null ? new Map<string, { oid: string; mode: string }>() : treeMapOfCommit(repo, headTip);
  const diffs: FileDiff[] = [];
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseMap.get(path);
    const after = headMap.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const beforeData = before === undefined ? null : getObject(repo, before.oid)?.data ?? null;
    const afterData = after === undefined ? null : getObject(repo, after.oid)?.data ?? null;
    const additions = afterData === null ? 0 : lineCount(afterData);
    const deletions = beforeData === null ? 0 : lineCount(beforeData);
    diffs.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.oid ?? before?.oid ?? ZERO_OID,
    });
  }
  return diffs;
}

/**
 * The three-way per-path merge at the heart of a pull-request merge: a path conflicts only when
 * both sides changed it differently from the merge base. Answers the merged path map, or null on
 * conflict.
 */
export function threeWayMerge(
  repo: RepoRec,
  baseTip: string,
  headTip: string,
): Map<string, { oid: string; mode: string }> | null {
  const base = mergeBase(repo, baseTip, headTip);
  const baseMap = treeMapOfCommit(repo, baseTip);
  const headMap = treeMapOfCommit(repo, headTip);
  const originMap = base === null ? new Map<string, { oid: string; mode: string }>() : treeMapOfCommit(repo, base);
  const result = new Map(baseMap);
  const paths = new Set([...originMap.keys(), ...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const origin = originMap.get(path)?.oid;
    const baseOid = baseMap.get(path)?.oid;
    const headOid = headMap.get(path)?.oid;
    if (headOid === baseOid) continue;
    if (origin === baseOid) {
      // Only the head side moved: take its version (or its deletion).
      if (headOid === undefined) result.delete(path);
      else result.set(path, headMap.get(path)!);
      continue;
    }
    if (origin === headOid) continue; // only the base side moved
    return null; // both sides changed the same path differently
  }
  return result;
}

/** Whether a pull request would merge cleanly right now. */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return false;
  if (isAncestor(repo, headTip, baseTip)) return true;
  return threeWayMerge(repo, baseTip, headTip) !== null;
}

export interface MergeResult {
  ok: boolean;
  status: number;
  message: string;
  sha?: string;
}

/** Merge a pull request with one squash commit on its base branch. */
export function mergePull(repo: RepoRec, pull: PullRec): MergeResult {
  if (pull.merged || pull.state !== 'open') {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable: it is already closed' };
  }
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, status: 405, message: 'Pull Request is not mergeable: a branch is gone' };
  const mergedMap = threeWayMerge(repo, baseTip, headTip);
  if (mergedMap === null) return { ok: false, status: 405, message: 'Pull Request is not mergeable: conflicts must be resolved first' };
  const tree = buildTreeFromMap(repo, mergedMap);
  const baseCommit = commitOf(repo, baseTip);
  if (baseCommit !== null && baseCommit.info.tree === tree && isAncestor(repo, headTip, baseTip)) {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable: already up to date' };
  }
  const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
  const sha = makeCommit(repo, tree, [baseTip], message, store.nextSeq());
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = sha;
  return { ok: true, status: 200, message: 'Pull Request successfully merged', sha };
}
