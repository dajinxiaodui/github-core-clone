// The forge's in-memory store: one viewer (the trial identity), repos keyed
// by name, each with its own git object store, refs, labels, issues and pull
// requests. All timestamps and ids come from per-repo logical counters, so
// ordering is deterministic and replay exports stay byte-identical.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
  ZERO_OID,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

const IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
}

export interface PullRequest {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  createdSeq: number;
}

export type IssueOrPull = Issue | PullRequest;

export interface FileEntry {
  path: string;
  oid: string;
  mode: string;
}

export class Repo {
  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly items = new Map<number, IssueOrPull>();
  nextNumber = 1;
  nextItemId: number;
  nextCommentId: number;
  seq = 0;
  lastTimestamp = 1700000000;

  constructor(id: number, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.nextItemId = id * 100000;
    this.nextCommentId = id * 100000;
  }

  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Strictly increasing unix timestamp for commits built by the API. */
  nextTimestamp(): number {
    const now = Math.floor(Date.now() / 1000);
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  isoNow(): string {
    return new Date(this.nextTimestamp() * 1000).toISOString();
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** The commit HEAD points at, or null while the default branch is unborn. */
  headCommit(): string | null {
    return this.refs.get(this.headRef()) ?? null;
  }

  /** Resolve a branch name, full ref, HEAD, or raw oid to a commit oid. */
  resolveCommit(ref: string | null | undefined): string | null {
    if (!ref) return this.headCommit();
    if (ref === 'HEAD') return this.headCommit();
    let oid: string | undefined;
    if (this.refs.has(ref)) oid = this.refs.get(ref);
    else if (this.refs.has(`refs/heads/${ref}`)) oid = this.refs.get(`refs/heads/${ref}`);
    else if (this.refs.has(`refs/tags/${ref}`)) oid = this.refs.get(`refs/tags/${ref}`);
    else if (isObjectId(ref) && this.objects.has(ref)) oid = ref;
    if (!oid) return null;
    return this.peelToCommit(oid);
  }

  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let guard = 0; guard < 64; guard += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  commitView(oid: string) {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /**
   * Commit list from `start` in git-log order: a priority walk that always
   * emits the newest frontier commit next, so the start commit comes first
   * and a parent never precedes its child.
   */
  commitsFrom(start: string): string[] {
    const timeOf = (oid: string): number => {
      const view = this.commitView(oid);
      if (!view) return 0;
      const match = / (\d{10,}) [+-]\d{4}$/.exec(view.committer);
      return match ? Number(match[1]) : 0;
    };
    const out: string[] = [];
    const seen = new Set<string>();
    const frontier: string[] = [start];
    while (frontier.length > 0) {
      let best = 0;
      for (let i = 1; i < frontier.length; i += 1) {
        if (timeOf(frontier[i] as string) >= timeOf(frontier[best] as string)) best = i;
      }
      const oid = frontier.splice(best, 1)[0] as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitView(oid);
      if (!view) continue;
      out.push(oid);
      for (const parent of view.parents) if (!seen.has(parent)) frontier.push(parent);
    }
    return out;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const reachable = collectReachable([descendant], this.lookup, { allowMissing: true });
    return reachable.has(ancestor);
  }

  mergeBase(a: string, b: string): string | null {
    const fromA = collectReachable([a], this.lookup, { allowMissing: true });
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (fromA.has(current)) {
        const view = this.commitView(current);
        if (view) return current;
      }
      const view = this.commitView(current);
      if (view) queue.push(...view.parents);
    }
    return null;
  }

  /** Flatten a tree (by oid) into path -> entry, recursing into subtrees. */
  flattenTree(treeOid: string | null, prefix = ''): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    if (!treeOid) return out;
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        for (const [p, e] of this.flattenTree(entry.oid, path)) out.set(p, e);
      } else {
        out.set(path, { path, oid: entry.oid, mode: entry.mode });
      }
    }
    return out;
  }

  treeOfCommit(commitOid: string | null): Map<string, FileEntry> {
    if (!commitOid) return new Map();
    const view = this.commitView(commitOid);
    if (!view) return new Map();
    return this.flattenTree(view.tree);
  }

  /** Build (and store) a tree from a flat path -> blob map. */
  buildTreeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    interface Dir {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        if (!dir.dirs.has(part)) dir.dirs.set(part, { files: new Map(), dirs: new Map() });
        dir = dir.dirs.get(part) as Dir;
      }
      dir.files.set(parts[parts.length - 1] as string, entry);
    }
    const build = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Directory listing of `dirPath` at `ref`; null when the path is absent. */
  listDir(ref: string | null, dirPath: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | null {
    const commit = this.resolveCommit(ref);
    const files = this.treeOfCommit(commit);
    const prefix = dirPath === '' ? '' : `${dirPath}/`;
    const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [path, entry] of files) {
      if (prefix && !path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        seen.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
      } else {
        const name = rest.slice(0, slash);
        if (!seen.has(name)) {
          const subPath = prefix + name;
          seen.set(name, { type: 'dir', name, path: subPath, sha: this.subtreeOid(commit, subPath) ?? '' });
        }
      }
    }
    if (dirPath !== '' && seen.size === 0) return null;
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  subtreeOid(commitOid: string | null, dirPath: string): string | null {
    if (!commitOid) return null;
    const view = this.commitView(commitOid);
    if (!view) return null;
    let treeOid = view.tree;
    for (const part of dirPath.split('/')) {
      const object = this.objects.get(treeOid);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === part && e.mode === '40000');
      if (!entry) return null;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  readFile(ref: string | null, path: string): { oid: string; data: Buffer } | null {
    const commit = this.resolveCommit(ref);
    const files = this.treeOfCommit(commit);
    const entry = files.get(path);
    if (!entry) return null;
    const object = this.objects.get(entry.oid);
    if (!object || object.type !== 'blob') return null;
    return { oid: entry.oid, data: object.data };
  }

  /**
   * Commit a single file write on `branch` (contents-API semantics): the
   * branch is created from the default tip when missing, or as a root
   * commit on an unborn repo. Returns the new commit and blob ids.
   */
  commitFile(options: { branch?: string; path: string; content: Buffer; message: string }): { commitSha: string; blobSha: string; created: boolean } {
    const branch = options.branch ?? this.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let parent = this.refs.get(ref) ?? null;
    if (!parent && branch !== this.defaultBranch) parent = this.headCommit();
    const files = this.treeOfCommit(parent);
    const existed = files.has(options.path);
    const blobSha = this.putObject('blob', options.content);
    files.set(options.path, { path: options.path, oid: blobSha, mode: '100644' });
    const tree = this.buildTreeFromFiles(files);
    const commitData = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      author: IDENTITY,
      committer: IDENTITY,
      timestamp: this.nextTimestamp(),
      message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
    });
    const commitSha = this.putObject('commit', commitData);
    this.refs.set(ref, commitSha);
    return { commitSha, blobSha, created: !existed };
  }

  deleteFile(options: { branch?: string; path: string; message: string }): { commitSha: string } | null {
    const branch = options.branch ?? this.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const parent = this.refs.get(ref) ?? null;
    if (!parent) return null;
    const files = this.treeOfCommit(parent);
    if (!files.delete(options.path)) return null;
    const tree = this.buildTreeFromFiles(files);
    const commitData = buildCommit({
      tree,
      parents: [parent],
      author: IDENTITY,
      committer: IDENTITY,
      timestamp: this.nextTimestamp(),
      message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
    });
    const commitSha = this.putObject('commit', commitData);
    this.refs.set(ref, commitSha);
    return { commitSha };
  }

  /** File-level diff between two commits (base -> head). */
  diffCommits(baseCommit: string | null, headCommit: string | null): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const baseFiles = this.treeOfCommit(baseCommit);
    const headFiles = this.treeOfCommit(headCommit);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const countLines = (oid: string | undefined): number => {
      if (!oid) return 0;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'blob') return 0;
      const text = object.data.toString('utf8');
      if (text.length === 0) return 0;
      return text.split('\n').length;
    };
    for (const path of new Set([...baseFiles.keys(), ...headFiles.keys()])) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before && after && before.oid === after.oid) continue;
      const status = !before ? 'added' : !after ? 'removed' : 'modified';
      const additions = status === 'removed' ? 0 : Math.max(1, countLines(after?.oid));
      const deletions = status === 'added' ? 0 : countLines(before?.oid);
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
    return out;
  }

  /**
   * Three-way file-level merge of head into base. Returns the merged tree
   * oid, or null on conflict (both sides changed the same path to
   * different blobs since the merge base, or modify/delete).
   */
  mergeTrees(baseCommit: string, headCommit: string): string | null {
    const ancestor = this.mergeBase(baseCommit, headCommit);
    const ancestorFiles = this.treeOfCommit(ancestor);
    const baseFiles = this.treeOfCommit(baseCommit);
    const headFiles = this.treeOfCommit(headCommit);
    const merged = new Map(baseFiles);
    for (const path of new Set([...ancestorFiles.keys(), ...headFiles.keys()])) {
      const anc = ancestorFiles.get(path);
      const head = headFiles.get(path);
      const base = baseFiles.get(path);
      const headChanged = (head?.oid ?? null) !== (anc?.oid ?? null);
      const baseChanged = (base?.oid ?? null) !== (anc?.oid ?? null);
      if (!headChanged) continue;
      if (baseChanged && (base?.oid ?? null) !== (head?.oid ?? null)) return null;
      if (head) merged.set(path, head);
      else merged.delete(path);
    }
    return this.buildTreeFromFiles(merged);
  }

  createIssue(fields: { title: string; body: string; labels: string[] }): Issue {
    const issue: Issue = {
      kind: 'issue',
      id: this.nextItemId++,
      number: this.nextNumber++,
      title: fields.title,
      body: fields.body,
      state: 'open',
      labels: [...fields.labels],
      comments: [],
      createdSeq: this.tick(),
    };
    this.items.set(issue.number, issue);
    return issue;
  }

  createPull(fields: { title: string; body: string; headRef: string; baseRef: string }): PullRequest {
    const pull: PullRequest = {
      kind: 'pull',
      id: this.nextItemId++,
      number: this.nextNumber++,
      title: fields.title,
      body: fields.body,
      headRef: fields.headRef,
      baseRef: fields.baseRef,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      createdSeq: this.tick(),
    };
    this.items.set(pull.number, pull);
    return pull;
  }

  addComment(item: IssueOrPull, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, createdSeq: this.tick() };
    item.comments.push(comment);
    return comment;
  }

  /** Mergeability of a pull: conflict when the three-way merge conflicts. */
  pullMergeable(pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state === 'closed') return pull.merged ? 'MERGEABLE' : 'UNKNOWN';
    const baseTip = this.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = this.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return 'UNKNOWN';
    return this.mergeTrees(baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Perform a squash (or merge) of a pull into its base branch. */
  mergePull(pull: PullRequest, method: string): { sha: string } | { conflict: true } | null {
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseTip = this.refs.get(baseRef);
    const headTip = this.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return null;
    const tree = this.mergeTrees(baseTip, headTip);
    if (tree === null) return { conflict: true };
    const isSquash = method !== 'merge';
    const message = isSquash
      ? `${pull.title} (#${pull.number})\n\n${pull.body ?? ''}`.trimEnd() + '\n'
      : `Merge pull request #${pull.number} from ${pull.headRef}\n`;
    const commitData = buildCommit({
      tree,
      parents: isSquash ? [baseTip] : [baseTip, headTip],
      author: IDENTITY,
      committer: IDENTITY,
      timestamp: this.nextTimestamp(),
      message,
    });
    const sha = this.putObject('commit', commitData);
    this.refs.set(baseRef, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(this.lastTimestamp * 1000).toISOString();
    pull.mergeCommitSha = sha;
    return { sha };
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;

  createRepo(name: string, description = '', isPrivate = false): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(this.nextRepoId++, name, description, isPrivate);
    this.repos.set(name, repo);
    return repo;
  }

  /** Repos are only visible under the viewer's login; anything else 404s. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(name);
  }
}

export function isoFromSeq(repo: Repo, seq: number): string {
  // Deterministic created_at derived from the repo clock: base time + seq.
  return new Date((1700000000 + seq * 60) * 1000).toISOString();
}

// ---------------------------------------------------------------- REST serializers

const REPO_EPOCH = '2026-11-14T00:00:00Z';

export function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `repo-${repo.id}`,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${VIEWER_LOGIN}/${repo.name}`,
    created_at: REPO_EPOCH,
    updated_at: REPO_EPOCH,
    pushed_at: REPO_EPOCH,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `issue-${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: null, default: false };
    }),
    user: userJson(),
    comments: issue.comments.length,
    created_at: isoFromSeq(repo, issue.createdSeq),
    updated_at: isoFromSeq(repo, issue.createdSeq),
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: `pull-${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    created_at: isoFromSeq(repo, pull.createdSeq),
    updated_at: isoFromSeq(repo, pull.createdSeq),
  };
}

export function commentJson(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `comment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: isoFromSeq(repo, comment.createdSeq),
    updated_at: isoFromSeq(repo, comment.createdSeq),
  };
}

export { ZERO_OID };
