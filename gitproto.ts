// gitproto.ts — git smart HTTP: protocol v2 ls-refs and fetch over POST /git-upload-pack, the v0
// advertisement and fetch fallback, and receive-pack pushes with report-status. Pkt-line framing
// throughout; packs sent are always plain objects (no deltas), packs received are fully resolved
// by gitobj.readPack, thin-pack bases included.
//
// Fetch object selection, in one paragraph: the client's `have` commits close over their ancestry
// (stopping at the client's declared shallow boundary) and everything they contain is withheld;
// the `want` commits are walked by generation, bounded by the requested depth, stopping wherever
// the walk meets a have; commits sent whose parents stay behind are named in shallow-info, and
// client boundary commits whose parents are now sent are unshallowed.

import type { RepoRec } from './store.ts';
import { ZERO_OID } from './store.ts';
import {
  ancestorClosure, buildPack, commitOf, getObject, isAncestor, parseCommit, parseTree,
  peelToCommit, readPack,
} from './gitobj.ts';

/** A commit plus its full tree closure (trees and blobs) — never its parents. */
function treeClosure(repo: RepoRec, commitOid: string, out: Set<string>): void {
  const commit = commitOf(repo, commitOid);
  if (commit === null) return;
  out.add(commit.oid);
  const walk = (treeOid: string): void => {
    const object = getObject(repo, treeOid);
    if (object === null || object.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid);
      else out.add(entry.oid);
    }
  };
  walk(commit.info.tree);
}

export interface Reply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

const AGENT = 'coreclone/1.0';
const UPLOAD_CAPS = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

// ------------------------------------------------------------------ pkt-lines

/** One pkt-line: 4 hex digits of total length, then the payload. */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'latin1'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'latin1');
export const PKT_DELIM = Buffer.from('0001', 'latin1');

export interface PktStream {
  lines: Buffer[];
  /** Offset just past the terminating flush/delim (or past the last full line). */
  end: number;
  endedBy: 'flush' | 'delim' | 'data';
}

/** Parse pkt-lines from `start` until a flush, a delim, or the first byte that is not a pkt-line. */
export function parsePktLines(buf: Buffer, start: number): PktStream {
  const lines: Buffer[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const hex = buf.toString('latin1', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { lines, end: pos, endedBy: 'data' };
    const length = parseInt(hex, 16);
    if (length === 0) return { lines, end: pos + 4, endedBy: 'flush' };
    if (length === 1) return { lines, end: pos + 4, endedBy: 'delim' };
    if (length === 2) return { lines, end: pos + 4, endedBy: 'flush' };
    if (length < 4 || pos + length > buf.length) return { lines, end: pos, endedBy: 'data' };
    lines.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
  return { lines, end: pos, endedBy: 'data' };
}

/** Chunk bytes into side-band-64k band-1 pkt-lines (payload + band byte stays under the 65520 cap). */
export function sidebandPackets(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65_512;
  for (let pos = 0; pos < data.length; pos += CHUNK) {
    packets.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(pos, pos + CHUNK)])));
  }
  if (packets.length === 0) packets.push(pkt(Buffer.from([1])));
  return packets;
}

// ------------------------------------------------------------------ ref advertisement

interface RefLine {
  ref: string;
  oid: string;
  peeled: string | null;
}

/** Every ref, sorted by name, with peeled targets for annotated tags. */
function refLines(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const ref of names) {
    const oid = repo.refs.get(ref)!;
    let peeled: string | null = null;
    const object = getObject(repo, oid);
    if (object !== null && object.type === 'tag') peeled = peelToCommit(repo, oid);
    lines.push({ ref, oid, peeled });
  }
  return lines;
}

function defaultTip(repo: RepoRec): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** GET info/refs for either service. */
export function infoRefs(repo: RepoRec, service: string, protocol: string): Reply {
  if (service === 'git-upload-pack') {
    if (protocol.includes('version=2')) {
      const body = Buffer.concat([
        pkt('version 2\n'),
        pkt(`agent=${AGENT}\n`),
        pkt('ls-refs=unborn\n'),
        pkt('fetch=shallow\n'),
        pkt('object-format=sha1\n'),
        PKT_FLUSH,
      ]);
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
    }
    const parts: Buffer[] = [pkt('# service=git-upload-pack\n'), PKT_FLUSH];
    const lines = refLines(repo);
    const caps = `\0${UPLOAD_CAPS.replace('refs/heads/main', `refs/heads/${repo.defaultBranch}`)}\n`;
    if (lines.length === 0) {
      parts.push(pkt(`${ZERO_OID} capabilities^{}${caps}`));
    } else {
      parts.push(pkt(`${defaultTip(repo) ?? ZERO_OID} HEAD${caps}`));
      for (const line of lines) {
        parts.push(pkt(`${line.oid} ${line.ref}\n`));
        if (line.peeled !== null) parts.push(pkt(`${line.peeled} ${line.ref}^{}\n`));
      }
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  if (service === 'git-receive-pack') {
    const parts: Buffer[] = [pkt('# service=git-receive-pack\n'), PKT_FLUSH];
    const lines = refLines(repo);
    if (lines.length === 0) {
      parts.push(pkt(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
    } else {
      lines.forEach((line, index) => {
        const caps = index === 0 ? `\0${RECEIVE_CAPS}` : '';
        parts.push(pkt(`${line.oid} ${line.ref}${caps}\n`));
        if (line.peeled !== null) parts.push(pkt(`${line.peeled} ${line.ref}^{}\n`));
      });
    }
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: Buffer.concat(parts) };
  }
  return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`unknown service ${service}\n`) };
}

// ------------------------------------------------------------------ ls-refs (v2)

function lsRefs(repo: RepoRec, args: string[]): Buffer {
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const parts: Buffer[] = [];
  const tip = defaultTip(repo);
  const headIncluded = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headIncluded) {
    const target = `refs/heads/${repo.defaultBranch}`;
    const symref = wantSymrefs ? ` symref-target:${target}` : '';
    if (tip !== null) parts.push(pkt(`${tip} HEAD${symref}\n`));
    else if (wantUnborn) parts.push(pkt(`unborn HEAD${symref}\n`));
  }
  for (const line of refLines(repo)) {
    if (!matches(line.ref)) continue;
    const peeled = wantPeel && line.peeled !== null ? ` peeled:${line.peeled}` : '';
    parts.push(pkt(`${line.oid} ${line.ref}${peeled}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch planning

interface FetchPlan {
  send: string[];
  shallow: string[];
  unshallow: string[];
}

/** Decide exactly which objects a fetch sends, and how the shallow boundary moves. */
function planFetch(repo: RepoRec, wants: string[], haves: string[], clientShallow: string[], depth: number): FetchPlan {
  const boundary = new Set(clientShallow);
  const haveCommits = new Set<string>();
  for (const have of haves) {
    for (const oid of ancestorClosure(repo, have, boundary)) haveCommits.add(oid);
  }
  // What the client holds: exactly those commits and their tree closures. (Following parents
  // here — or in the send set below — is the classic shallow-fetch leak: depth would mean nothing.)
  const haveObjects = new Set<string>();
  for (const oid of haveCommits) treeClosure(repo, oid, haveObjects);

  const included = new Set<string>();
  const tagObjects: string[] = [];
  const queue: Array<{ oid: string; dist: number; root: boolean }> = [];
  for (const want of wants) {
    let current = want;
    // Include the tag chain itself, then walk from the commit it names.
    for (let hops = 0; hops < 16; hops += 1) {
      const object = getObject(repo, current);
      if (object === null || object.type !== 'tag') break;
      if (!haveObjects.has(current)) tagObjects.push(current);
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null) break;
      current = match[1];
    }
    const commit = commitOf(repo, current);
    if (commit !== null) queue.push({ oid: commit.oid, dist: 0, root: true });
  }
  const distOf = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, dist, root } = queue.shift()!;
    if (distOf.has(oid) && distOf.get(oid)! <= dist) continue;
    distOf.set(oid, dist);
    const held = haveCommits.has(oid);
    if (!held && dist < depth) included.add(oid);
    // A held commit ends the walk — except at a want root: a deepen request starts exactly at
    // the held boundary commit and must expand from it, or the parent generation never ships.
    if (held && !root) continue;
    if (dist >= depth) continue;
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    // Parents at exactly `depth` are visited (and recorded) but not included: that is the cut.
    if (dist + 1 <= depth) {
      for (const parent of commit.info.parents) queue.push({ oid: parent, dist: dist + 1, root: false });
    }
  }

  const shallow: string[] = [];
  for (const oid of included) {
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    const cut = commit.info.parents.some((parent) => {
      const parentCommit = commitOf(repo, parent);
      return parentCommit !== null && !included.has(parentCommit.oid) && !haveCommits.has(parentCommit.oid);
    });
    if (cut) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundaryOid of clientShallow) {
    const commit = commitOf(repo, boundaryOid);
    if (commit === null) continue;
    if (commit.info.parents.some((parent) => included.has(parent))) unshallow.push(boundaryOid);
  }

  const sendSet = new Set<string>();
  for (const oid of included) treeClosure(repo, oid, sendSet);
  for (const oid of tagObjects) sendSet.add(oid);
  const send = [...sendSet].filter((oid) => !haveObjects.has(oid));
  // Commits first, then trees, then blobs, then tags: a natural pack order.
  const rank = (oid: string): number => {
    const object = getObject(repo, oid);
    if (object === null) return 4;
    return object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'blob' ? 2 : 3;
  };
  send.sort((a, b) => rank(a) - rank(b));
  return { send, shallow, unshallow };
}

// ------------------------------------------------------------------ upload-pack POST

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: Number.POSITIVE_INFINITY, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) args.depth = parsed;
    } else if (line === 'done') args.done = true;
  }
  return args;
}

/** POST /git-upload-pack: a v2 command (ls-refs or fetch) or a v0 fetch. */
export function uploadPack(repo: RepoRec, body: Buffer): Reply {
  const first = parsePktLines(body, 0);
  if (first.lines.length === 0) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('empty upload-pack request\n') };
  }
  const firstText = first.lines[0].toString('utf8');
  if (firstText.startsWith('command=ls-refs')) {
    const args = parsePktLines(body, first.end);
    const argLines = args.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, argLines) };
  }
  if (firstText.startsWith('command=fetch')) {
    const argsStream = parsePktLines(body, first.end);
    const argLines = argsStream.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
    const args = parseFetchArgs(argLines);
    const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
    const pack = buildPack(repo, plan.send);
    const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), PKT_DELIM];
    const depthInvolved = args.depth !== Number.POSITIVE_INFINITY || args.shallow.length > 0;
    if (depthInvolved || plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  if (firstText.startsWith('want ')) {
    // Protocol v0: want lines to a flush, then have/deepen lines to "done".
    const wants: string[] = [];
    for (const line of first.lines) {
      const text = line.toString('utf8');
      if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    }
    const rest = parsePktLines(body, first.end);
    const argLines = rest.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
    const args = parseFetchArgs(argLines);
    const plan = planFetch(repo, wants, args.haves, args.shallow, args.depth);
    const pack = buildPack(repo, plan.send);
    const parts: Buffer[] = [];
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    parts.push(pkt('NAK\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unrecognized upload-pack request\n') };
}

// ------------------------------------------------------------------ receive-pack POST

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /git-receive-pack: unpack, validate each ref update, apply the good ones, report status. */
export function receivePack(repo: RepoRec, body: Buffer): Reply {
  const stream = parsePktLines(body, 0);
  const commands: PushCommand[] = [];
  for (const raw of stream.lines) {
    const text = raw.toString('utf8').replace(/\n$/, '');
    const command = text.split('\0')[0];
    const parts = command.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const rest = body.subarray(stream.end);
  let unpackLine = 'unpack ok\n';
  if (rest.length >= 12 && rest.toString('latin1', 0, 4) === 'PACK') {
    try {
      const pack = readPack(repo, rest, 0);
      for (const [oid, object] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackLine = `unpack error ${err instanceof Error ? err.message : String(err)}\n`;
    }
  }

  const reportLines: string[] = [unpackLine];
  const unpackOk = unpackLine === 'unpack ok\n';
  for (const command of commands) {
    const verdict = unpackOk ? applyPush(repo, command) : 'unpack failed';
    reportLines.push(verdict === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict}\n`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pkt(line)), PKT_FLUSH]);
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat([...sidebandPackets(report), PKT_FLUSH]),
  };
}

/** Validate one ref update against the store; apply it and answer null, or answer the refusal reason. */
function applyPush(repo: RepoRec, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..') || ref.endsWith('/')) return 'invalid refname';
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    if (oldOid !== current) return 'stale info';
    repo.refs.delete(ref);
    return null;
  }
  const object = getObject(repo, newOid);
  if (object === null) return 'invalid object';
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return 'reference already exists';
    repo.refs.set(ref, newOid);
    return null;
  }
  if (oldOid !== current) return 'stale info';
  if (ref.startsWith('refs/heads/')) {
    const newCommit = peelToCommit(repo, newOid);
    if (newCommit === null) return 'invalid object';
    let oldCommit: string | null = null;
    const oldObject = getObject(repo, oldOid);
    if (oldObject !== null) oldCommit = peelToCommit(repo, oldOid);
    if (oldCommit !== null && !isAncestor(repo, oldCommit, newCommit)) return 'non-fast-forward';
  }
  repo.refs.set(ref, newOid);
  return null;
}

/** Parse a commit's message for protocol helpers (kept here to share with REST). */
export function commitMessage(repo: RepoRec, oid: string): string | null {
  const object = getObject(repo, oid);
  if (object === null || object.type !== 'commit') return null;
  try {
    return parseCommit(object.data).message;
  } catch {
    return null;
  }
}
