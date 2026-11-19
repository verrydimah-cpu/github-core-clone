// gitobj.ts — the git object model over the store's per-repository object maps: SHA-1 addressing,
// commit and tree parsing/building, ancestry walks, tree flattening, and pack v2/v3 reading and
// writing. The forge never shells out to a git binary; everything here is the object format itself.
//
// Packs the forge sends are always plain (no deltas): legal, simple, and fast at this scale.
// Packs it receives may carry OFS/REF deltas and thin-pack bases, and are fully resolved on read.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, RepoRec } from './store.ts';

export type ObjectType = GitObject['type'];

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 over `<type> <size>\0` + bytes — the object id of a would-be object. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'latin1');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object in the repository (idempotently) and answer its id. */
export function putObject(repo: RepoRec, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Fetch an object by id, or null. */
export function getObject(repo: RepoRec, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a commit object's headers and message. Throws on malformed bytes. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  if (tree === '') throw new Error('commit without a tree');
  return { tree, parents, message };
}

/** Build and store a commit with the forge's fixed author identity. */
export function makeCommit(repo: RepoRec, tree: string, parents: string[], message: string, seq: number): string {
  const stamp = 1_735_689_600 + seq;
  const ident = `Forge Bot <forge@localhost> ${stamp} +0000`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return putObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/** Follow a tag chain to the commit it ultimately names, or null. */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = getObject(repo, current);
    if (object === null) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1];
  }
  return null;
}

/** The commit an oid names (through tags), or null. */
export function commitOf(repo: RepoRec, oid: string): { oid: string; info: CommitInfo } | null {
  const commitOid = peelToCommit(repo, oid);
  if (commitOid === null) return null;
  const object = getObject(repo, commitOid);
  if (object === null) return null;
  try {
    return { oid: commitOid, info: parseCommit(object.data) };
  } catch {
    return null;
  }
}

/** Every ancestor of a commit (itself included), breadth-first, newest generation first. */
export function ancestorClosure(repo: RepoRec, tip: string, boundary: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    seen.add(commit.oid);
    if (boundary.has(commit.oid)) continue;
    for (const parent of commit.info.parents) queue.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is reachable from `tip` (both commit ids). */
export function isAncestor(repo: RepoRec, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.info.parents) queue.push(parent);
  }
  return false;
}

/** The nearest common ancestor of two commits (the fixtures' histories are shallow; BFS suffices). */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = ancestorClosure(repo, a, new Set());
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    if (ancestorsOfA.has(commit.oid)) return commit.oid;
    for (const parent of commit.info.parents) queue.push(parent);
  }
  return null;
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('latin1', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories sort as if their name carried a trailing slash. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build and store a tree from entries (sorting them the way git does). */
export function makeTree(repo: RepoRec, entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : 1));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return putObject(repo, 'tree', Buffer.concat(parts));
}

/** Flatten a tree (recursively) into path -> blob oid/mode. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const object = getObject(repo, treeOid);
  if (object === null || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** The path -> blob map of a commit's tree (empty map for a missing commit). */
export function treeMapOfCommit(repo: RepoRec, commitOid: string): Map<string, { oid: string; mode: string }> {
  const commit = commitOf(repo, commitOid);
  if (commit === null) return new Map();
  return flattenTree(repo, commit.info.tree);
}

/** Build (and store) a tree hierarchy from a flat path -> blob map; answers the root tree id. */
export function buildTreeFromMap(repo: RepoRec, map: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, blob] of map) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.push({ mode: blob.mode, name: parts[parts.length - 1], oid: blob.oid });
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [...dir.files];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return makeTree(repo, entries);
  };
  return build(root);
}

/** The tree oid of a directory prefix inside a commit (for contents listings), or null. */
export function subtreeOid(repo: RepoRec, treeOid: string, parts: string[]): string | null {
  let current = treeOid;
  for (const part of parts) {
    const object = getObject(repo, current);
    if (object === null || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

// ------------------------------------------------------------------ closures

/** Every object reachable from the given roots: commits, their trees and blobs, tags and targets. */
export function objectClosure(repo: RepoRec, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1]);
    }
  }
  return seen;
}

// ------------------------------------------------------------------ packs

/** Serialize objects into a pack v2 with no deltas: header, plain entries, SHA-1 trailer. */
export function buildPack(repo: RepoRec, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = getObject(repo, oid);
    if (object === null) continue;
    const size = object.data.length;
    const code = TYPE_CODES[object.type];
    const bytes: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) { offset |= delta[pos]; pos += 1; }
      if ((op & 0x02) !== 0) { offset |= delta[pos] << 8; pos += 1; }
      if ((op & 0x04) !== 0) { offset |= delta[pos] << 16; pos += 1; }
      if ((op & 0x08) !== 0) { offset |= delta[pos] << 24; pos += 1; }
      if ((op & 0x10) !== 0) { size |= delta[pos]; pos += 1; }
      if ((op & 0x20) !== 0) { size |= delta[pos] << 8; pos += 1; }
      if ((op & 0x40) !== 0) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Inflate one object's compressed bytes starting at `pos`; answers the bytes and the next offset. */
function inflateEntry(buf: Buffer, pos: number): { data: Buffer; next: number } {
  // zlib streams are self-terminating and Node's inflater tolerates trailing bytes, so success is
  // monotonic in the window length: grow the window until inflation succeeds, then binary-search
  // the smallest succeeding window — that is exactly how many bytes the stream consumed.
  const available = buf.length - pos;
  let failing = 0;
  let length = Math.min(available, 64);
  for (;;) {
    try {
      inflateSync(buf.subarray(pos, pos + length));
      break;
    } catch {
      if (length >= available) throw new Error('truncated pack entry');
      failing = length;
      length = Math.min(available, length * 2);
    }
  }
  let lo = failing;
  let hi = length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(pos, pos + mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buf.subarray(pos, pos + hi)), next: pos + hi };
}

export interface UnpackedPack {
  /** Every object the pack defines, fully resolved, by id. */
  objects: Map<string, GitObject>;
  /** Bytes consumed by the pack (header through the last object, excluding the trailer). */
  consumed: number;
}

/**
 * Read a pack that starts at `offset` in `buf`. Delta bases may come from the pack itself, from
 * earlier entries, or from the repository (a thin pack). Everything resolves to plain objects.
 */
export function readPack(repo: RepoRec, buf: Buffer, offset: number): UnpackedPack {
  if (buf.length - offset < 12 || buf.toString('latin1', offset, offset + 4) !== 'PACK') {
    throw new Error('not a pack');
  }
  const version = buf.readUInt32BE(offset + 4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(offset + 8);
  let pos = offset + 12;
  const byOffset = new Map<number, string>();
  const objects = new Map<string, GitObject>();
  const resolve = (type: ObjectType, data: Buffer): string => {
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
    return oid;
  };
  const baseData = (oid: string): GitObject => {
    const local = objects.get(oid) ?? repo.objects.get(oid);
    if (local === undefined) throw new Error(`delta base ${oid} not available`);
    return local;
  };
  for (let index = 0; index < count; index += 1) {
    const entryOffset = pos;
    let byte = buf[pos];
    pos += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (code === 6) {
      // OFS_DELTA: a negative offset back to the base entry.
      byte = buf[pos];
      pos += 1;
      let back = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[pos];
        pos += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      const baseOid = byOffset.get(entryOffset - back);
      if (baseOid === undefined) throw new Error('OFS_DELTA base not in pack');
      const base = baseData(baseOid);
      const inflated = inflateEntry(buf, pos);
      pos = inflated.next;
      const oid = resolve(base.type, applyDelta(base.data, inflated.data));
      byOffset.set(entryOffset, oid);
    } else if (code === 7) {
      // REF_DELTA: the base named by id.
      const baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
      const base = baseData(baseOid);
      const inflated = inflateEntry(buf, pos);
      pos = inflated.next;
      const oid = resolve(base.type, applyDelta(base.data, inflated.data));
      byOffset.set(entryOffset, oid);
    } else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`pack object type code ${code}`);
      const inflated = inflateEntry(buf, pos);
      pos = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
      const oid = resolve(type, inflated.data);
      byOffset.set(entryOffset, oid);
    }
  }
  return { objects, consumed: pos - offset };
}
