// The HTTP layer: one server, four surfaces over a single Forge store.
//   - git smart HTTP: info/refs + upload-pack (protocol v2 ls-refs/fetch,
//     v0 fetch fallback) and receive-pack v0 with report-status.
//   - REST v3 under /api/v3.
//   - GraphQL at /api/graphql.
//   - MCP at /mcp.
// Every JSON reply carries a request id; errors always carry a message.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  collectReachable,
  decodeAllPktLines,
  decodePktLines,
  encodePktLine,
  isObjectId,
  parseCommit,
  PKT_DELIM,
  PKT_FLUSH,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type PktPacket,
} from './git.ts';
import {
  Forge,
  VIEWER_LOGIN,
  commentJson,
  issueJson,
  labelJson,
  pullJson,
  repoJson,
  userJson,
  type Repo,
} from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

// ---------------------------------------------------------------- plumbing

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': `req-${++requestCounter}`,
    ...headers,
  });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

const notFound = (res: ServerResponse) => sendJson(res, 404, { message: 'Not Found' });

// ---------------------------------------------------------------- REST

interface RestContext {
  forge: Forge;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  body: Record<string, unknown>;
}

function pageParams(url: URL): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(ctx: RestContext, items: T[]): T[] {
  const { perPage, page } = pageParams(ctx.url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const next = new URL(ctx.url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const host = ctx.req.headers.host ?? '127.0.0.1';
    ctx.res.setHeader('link', `<http://${host}${next.pathname}${next.search}>; rel="next"`);
  }
  return slice;
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const view = repo.commitView(oid);
  if (!view) return null;
  const ident = (raw: string) => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(raw);
    if (!match) return { name: raw, email: '', date: '2026-01-01T00:00:00Z' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    node_id: `commit-${oid}`,
    commit: { message: view.message.replace(/\n+$/, ''), author: ident(view.author), committer: ident(view.committer), tree: { sha: view.tree } },
    parents: view.parents.map((sha) => ({ sha })),
    author: userJson(),
    committer: userJson(),
  };
}

function restRoot(ctx: RestContext): void {
  sendJson(ctx.res, 200, {
    current_user_url: '/api/v3/user',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    issue_url: '/api/v3/repos/{owner}/{repo}/issues',
    organization_url: '/api/v3/orgs/{org}',
  }, { 'x-oauth-scopes': 'repo, user, admin:org' });
}

function restRepo(ctx: RestContext, segments: string[], method: string): void {
  const { forge, res, body } = ctx;
  const owner = segments[0] as string;
  const name = segments[1] as string;
  const rest = segments.slice(2);
  const repo = forge.getRepo(owner, name);

  if (rest.length === 0) {
    if (!repo) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
      return res.end();
    }
    return notFound(res);
  }
  if (!repo) return notFound(res);

  const [head, ...tail] = rest as [string, ...string[]];

  if (head === 'branches' && method === 'GET') {
    if (tail.length === 0) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return sendJson(res, 200, branches);
    }
    const branch = tail.join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound(res);
    return sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
  }

  if (head === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const ref = String(body.ref ?? '');
      const sha = String(body.sha ?? '');
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
        return sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' });
      }
      if (repo.refs.has(ref)) return sendJson(res, 422, { message: 'Reference already exists' });
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, node_id: `ref-${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (method === 'GET' && tail.length >= 2) {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound(res);
      return sendJson(res, 200, { ref, node_id: `ref-${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    return notFound(res);
  }

  if (head === 'commits' && method === 'GET') {
    if (tail.length === 0) {
      const startRef = ctx.url.searchParams.get('sha');
      const start = repo.resolveCommit(startRef);
      if (!start) return sendJson(res, 200, []);
      const commits = repo.commitsFrom(start).map((oid) => commitJson(repo, oid)).filter(Boolean);
      return sendJson(res, 200, paginate(ctx, commits));
    }
    const single = commitJson(repo, tail[0] as string);
    if (!single) return notFound(res);
    return sendJson(res, 200, single);
  }

  if (head === 'contents') {
    const path = tail.join('/');
    if (method === 'GET') {
      const ref = ctx.url.searchParams.get('ref');
      if (path === '') {
        const entries = repo.listDir(ref, '') ?? [];
        return sendJson(res, 200, entries.map((e) => ({ ...e, size: e.type === 'file' ? (repo.objects.get(e.sha)?.data.length ?? 0) : 0 })));
      }
      const file = repo.readFile(ref, path);
      if (file) {
        return sendJson(res, 200, {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: file.oid,
          size: file.data.length,
          encoding: 'base64',
          content: file.data.toString('base64'),
        });
      }
      const entries = repo.listDir(ref, path);
      if (entries) {
        return sendJson(res, 200, entries.map((e) => ({ ...e, size: e.type === 'file' ? (repo.objects.get(e.sha)?.data.length ?? 0) : 0 })));
      }
      return notFound(res);
    }
    if (method === 'PUT') {
      const branch = typeof body.branch === 'string' ? body.branch : undefined;
      const suppliedSha = typeof body.sha === 'string' ? body.sha : undefined;
      const current = repo.readFile(branch ?? null, path);
      if (current && !suppliedSha) return sendJson(res, 422, { message: "sha wasn't supplied." });
      if (current && suppliedSha !== current.oid) return sendJson(res, 409, { message: `${path} does not match ${suppliedSha}` });
      if (!current && suppliedSha) return sendJson(res, 422, { message: 'sha was supplied but the file does not exist' });
      const content = Buffer.from(String(body.content ?? '').replace(/\s+/g, ''), 'base64');
      const result = repo.commitFile({ branch, path, content, message: String(body.message ?? 'Update file') });
      return sendJson(res, result.created ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commitSha, message: String(body.message ?? 'Update file') },
      });
    }
    if (method === 'DELETE') {
      const branch = typeof body.branch === 'string' ? body.branch : undefined;
      const suppliedSha = typeof body.sha === 'string' ? body.sha : undefined;
      const current = repo.readFile(branch ?? null, path);
      if (!current) return notFound(res);
      if (suppliedSha !== current.oid) return sendJson(res, 409, { message: `${path} does not match ${suppliedSha}` });
      const result = repo.deleteFile({ branch, path, message: String(body.message ?? 'Delete file') });
      if (!result) return notFound(res);
      return sendJson(res, 200, { content: null, commit: { sha: result.commitSha } });
    }
    return notFound(res);
  }

  if (head === 'labels') {
    if (method === 'GET' && tail.length === 0) return sendJson(res, 200, [...repo.labels.values()].map(labelJson));
    if (method === 'POST' && tail.length === 0) {
      const labelName = String(body.name ?? '');
      if (!labelName) return sendJson(res, 422, { message: 'Validation Failed: name is required' });
      if (repo.labels.has(labelName)) return sendJson(res, 422, { message: 'Validation Failed: label already exists' });
      const label = {
        name: labelName,
        color: typeof body.color === 'string' ? body.color : 'ededed',
        description: typeof body.description === 'string' ? body.description : null,
      };
      repo.labels.set(labelName, label);
      return sendJson(res, 201, labelJson(label));
    }
    if (method === 'GET' && tail.length === 1) {
      const label = repo.labels.get(tail[0] as string);
      if (!label) return notFound(res);
      return sendJson(res, 200, labelJson(label));
    }
    return notFound(res);
  }

  if (head === 'issues') {
    if (tail.length === 0) {
      if (method === 'POST') {
        const labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return sendJson(res, 422, { message: `Label "${label}" does not exist` });
        }
        const issue = repo.createIssue({ title: String(body.title ?? ''), body: String(body.body ?? ''), labels });
        return sendJson(res, 201, issueJson(repo, issue));
      }
      if (method === 'GET') {
        const state = ctx.url.searchParams.get('state') ?? 'open';
        const direction = ctx.url.searchParams.get('direction') ?? 'desc';
        let issues = [...repo.items.values()].filter((i) => i.kind === 'issue');
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return sendJson(res, 200, paginate(ctx, issues.map((i) => issueJson(repo, i as never))));
      }
      return notFound(res);
    }
    const number = Number.parseInt(tail[0] as string, 10);
    const item = repo.items.get(number);
    if (tail.length === 1) {
      if (!item || item.kind !== 'issue') return notFound(res);
      if (method === 'GET') return sendJson(res, 200, issueJson(repo, item));
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') item.state = body.state;
        if (typeof body.title === 'string') item.title = body.title;
        if (typeof body.body === 'string') item.body = body.body;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.map(String);
          for (const label of labels) if (!repo.labels.has(label)) return sendJson(res, 422, { message: `Label "${label}" does not exist` });
          item.labels = labels;
        }
        return sendJson(res, 200, issueJson(repo, item));
      }
      return notFound(res);
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (!item) return notFound(res);
      if (method === 'GET') return sendJson(res, 200, item.comments.map((c) => commentJson(repo, c)));
      if (method === 'POST') {
        const comment = repo.addComment(item, String(body.body ?? ''));
        return sendJson(res, 201, commentJson(repo, comment));
      }
      return notFound(res);
    }
    return notFound(res);
  }

  if (head === 'pulls') {
    if (tail.length === 0) {
      if (method === 'POST') {
        const headBranch = String(body.head ?? '');
        const baseBranch = String(body.base ?? '');
        if (!repo.refs.has(`refs/heads/${headBranch}`)) return sendJson(res, 422, { message: `Head branch "${headBranch}" does not exist` });
        if (!repo.refs.has(`refs/heads/${baseBranch}`)) return sendJson(res, 422, { message: `Base branch "${baseBranch}" does not exist` });
        const pull = repo.createPull({ title: String(body.title ?? ''), body: String(body.body ?? ''), headRef: headBranch, baseRef: baseBranch });
        return sendJson(res, 201, pullJson(repo, pull));
      }
      if (method === 'GET') {
        const state = ctx.url.searchParams.get('state') ?? 'open';
        const direction = ctx.url.searchParams.get('direction') ?? 'desc';
        let pulls = [...repo.items.values()].filter((i) => i.kind === 'pull');
        if (state !== 'all') pulls = pulls.filter((i) => i.state === state);
        pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return sendJson(res, 200, paginate(ctx, pulls.map((p) => pullJson(repo, p as never))));
      }
      return notFound(res);
    }
    const number = Number.parseInt(tail[0] as string, 10);
    const item = repo.items.get(number);
    if (!item || item.kind !== 'pull') return notFound(res);
    if (tail.length === 1 && method === 'GET') return sendJson(res, 200, pullJson(repo, item));
    if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
      const baseTip = repo.refs.get(`refs/heads/${item.baseRef}`) ?? null;
      const headTip = repo.refs.get(`refs/heads/${item.headRef}`) ?? null;
      return sendJson(res, 200, repo.diffCommits(baseTip, headTip));
    }
    if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
      if (item.state === 'closed') return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      const result = repo.mergePull(item, typeof body.merge_method === 'string' ? body.merge_method : 'merge');
      if (!result) return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      if ('conflict' in result) return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound(res);
  }

  return notFound(res);
}

async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
  const ctx: RestContext = { forge, url, req, res, body: parsed.value };
  const segments = url.pathname
    .slice('/api/v3'.length)
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));

  if (segments.length === 0) {
    if (method === 'GET') return restRoot(ctx);
    return notFound(res);
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return sendJson(res, 200, { ...userJson(), name: 'ada iversen', email: 'adaiversen@example.invalid' });
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = [...forge.repos.values()].sort((a, b) => a.id - b.id).map(repoJson);
      return sendJson(res, 200, paginate(ctx, repos));
    }
    if (method === 'POST') {
      const name = String(ctx.body.name ?? '');
      if (!name) return sendJson(res, 422, { message: 'Validation Failed: name is required' });
      const repo = forge.createRepo(name, String(ctx.body.description ?? ''), ctx.body.private === true);
      if (!repo) return sendJson(res, 422, { message: 'Repository creation failed: name already exists on this account' });
      if (typeof ctx.body.default_branch === 'string' && ctx.body.default_branch) repo.defaultBranch = ctx.body.default_branch;
      return sendJson(res, 201, repoJson(repo));
    }
    return notFound(res);
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    return restRepo(ctx, segments.slice(1), method);
  }
  return notFound(res);
}

// ---------------------------------------------------------------- git smart HTTP

function refLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = repo.headRef();
  const headTip = repo.refs.get(headRef);
  const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!headTip && sorted.length === 0) {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  let first = true;
  const pushLine = (text: string) => {
    lines.push(encodePktLine(first ? `${text}\0${caps}\n` : `${text}\n`));
    first = false;
  };
  if (headTip) pushLine(`${headTip} HEAD`);
  else pushLine(`${ZERO_OID} capabilities^{}`);
  for (const [ref, oid] of sorted) {
    pushLine(`${oid} ${ref}`);
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const peeled = repo.peelToCommit(oid);
      if (peeled) lines.push(encodePktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return lines;
}

function handleInfoRefs(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, owner: string, name: string): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return sendBuffer(res, 400, Buffer.from('missing or unknown service\n'), 'text/plain');
  }
  const repo = forge.getRepo(owner, name);
  if (!repo) return sendBuffer(res, 404, Buffer.from('repository not found\n'), 'text/plain');
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  if (isV2) {
    const body = Buffer.concat([
      encodePktLine('version 2\n'),
      encodePktLine('agent=ada-forge/1.0\n'),
      encodePktLine('ls-refs=unborn\n'),
      encodePktLine('fetch=shallow\n'),
      encodePktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
  }
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k symref=HEAD:refs/heads/${repo.defaultBranch} agent=ada-forge/1.0`
      : 'report-status delete-refs side-band-64k agent=ada-forge/1.0';
  const body = Buffer.concat([encodePktLine(`# service=${service}\n`), PKT_FLUSH, ...refLines(repo, caps), PKT_FLUSH]);
  return sendBuffer(res, 200, body, `application/x-git-${service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack'}-advertisement`);
}

interface FetchPlan {
  pack: Buffer;
  newShallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

function planFetch(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
  const lookup = repo.lookup;
  const held = new Set<string>();
  for (const have of haves) {
    if (repo.objects.has(have)) {
      for (const oid of collectReachable([have], lookup, { allowMissing: true })) held.add(oid);
    }
  }
  const heldCommits = new Set<string>();
  for (const oid of held) if (repo.objects.get(oid)?.type === 'commit') heldCommits.add(oid);

  const wantCommits: string[] = [];
  for (const want of wants) {
    const commit = repo.peelToCommit(want);
    if (commit && !wantCommits.includes(commit)) wantCommits.push(commit);
  }

  const included = new Set<string>();
  const newShallow: string[] = [];
  const unshallow: string[] = [];

  if (depth !== null && depth > 0) {
    // Generation-limited closure: BFS from the wants, parents one deeper.
    const generation = new Map<string, number>();
    const queue: { oid: string; gen: number }[] = wantCommits.map((oid) => ({ oid, gen: 0 }));
    while (queue.length > 0) {
      const { oid, gen } = queue.shift() as { oid: string; gen: number };
      if (generation.has(oid) && (generation.get(oid) as number) <= gen) continue;
      generation.set(oid, gen);
      const view = repo.commitView(oid);
      if (view) for (const parent of view.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
    const depthCommits = [...generation.entries()].filter(([, gen]) => gen < depth).map(([oid]) => oid);
    for (const commit of depthCommits) {
      const view = repo.commitView(commit);
      if (!view) continue;
      included.add(commit);
      for (const oid of collectReachable([view.tree], lookup, { allowMissing: true })) included.add(oid);
    }
    // Boundary: an included commit whose parent exists but is not included
    // and not fully held. Computed before held-subtraction so a deepen
    // re-declares the boundary commit the client already knows.
    for (const commit of depthCommits) {
      const view = repo.commitView(commit);
      if (!view) continue;
      const parentOutside = view.parents.some((p) => {
        if (!repo.objects.has(p)) return false;
        const gen = generation.get(p);
        return gen === undefined || gen >= depth;
      });
      if (parentOutside) newShallow.push(commit);
    }
    // Shallow commits the client holds lose their boundary when every
    // parent is now included or held.
    for (const shallow of clientShallow) {
      const view = repo.commitView(shallow);
      if (!view) continue;
      const complete = view.parents.every((p) => included.has(p) || heldCommits.has(p));
      if (complete && view.parents.length > 0) unshallow.push(shallow);
    }
    // Subtract only what the client provably holds from its shallow
    // clone: each declared shallow commit and its own tree closure. The
    // haves closure must NOT be subtracted here — a deepen request names
    // the tip itself as a have, and its closure is the whole history.
    for (const shallow of clientShallow) {
      included.delete(shallow);
      const view = repo.commitView(shallow);
      if (view) for (const oid of collectReachable([view.tree], lookup, { allowMissing: true })) included.delete(oid);
    }
  } else {
    const closure = new Set<string>();
    for (const commit of wantCommits) {
      for (const oid of collectReachable([commit], lookup, { allowMissing: true })) closure.add(oid);
    }
    for (const oid of closure) if (!held.has(oid)) included.add(oid);
    for (const shallow of clientShallow) {
      const view = repo.commitView(shallow);
      if (!view) continue;
      if (view.parents.length > 0 && view.parents.every((p) => closure.has(p) || heldCommits.has(p))) unshallow.push(shallow);
    }
  }

  // A want that names a tag object must deliver the tag itself, not only
  // the commit it peels to.
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag') included.add(want);
  }

  const objects: GitObject[] = [];
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return {
    pack: writePack(objects),
    newShallow: [...new Set(newShallow)],
    unshallow: [...new Set(unshallow)],
    commonHaves: haves.filter((h) => repo.objects.has(h)),
  };
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const CHUNK = 65515; // 4 length bytes + 1 band byte + payload <= 65520
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, offset + CHUNK);
    const packet = Buffer.allocUnsafe(slice.length + 5);
    packet.write((slice.length + 5).toString(16).padStart(4, '0'), 0, 4, 'ascii');
    packet[4] = 1;
    slice.copy(packet, 5);
    chunks.push(packet);
  }
  return chunks;
}

function shallowPackets(plan: FetchPlan): Buffer[] {
  return [
    ...plan.newShallow.map((oid) => encodePktLine(`shallow ${oid}\n`)),
    ...plan.unshallow.map((oid) => encodePktLine(`unshallow ${oid}\n`)),
  ];
}

function handleUploadPackV2(repo: Repo, res: ServerResponse, body: Buffer): void {
  let packets: PktPacket[];
  try {
    packets = decodeAllPktLines(body);
  } catch {
    return sendBuffer(res, 400, Buffer.from('malformed pkt-line request\n'), 'text/plain');
  }
  // First section: command + capabilities, then delim, then args, then flush.
  let command = '';
  const args: string[] = [];
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = 1;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      args.push(line);
    }
  }

  if (command === 'ls-refs') {
    const wantPeel = args.includes('peel');
    const wantSymrefs = args.includes('symrefs');
    const wantUnborn = args.includes('unborn');
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
    const includedByPrefix = (ref: string) => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
    const lines: Buffer[] = [];
    const headRef = repo.headRef();
    const headTip = repo.refs.get(headRef);
    if (includedByPrefix('HEAD')) {
      if (headTip) lines.push(encodePktLine(`${headTip} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
      else if (wantUnborn) lines.push(encodePktLine(`unborn HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
    const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [ref, oid] of sorted) {
      if (!includedByPrefix(ref)) continue;
      let suffix = '';
      const object = repo.objects.get(oid);
      if (wantPeel && object?.type === 'tag') {
        const peeled = repo.peelToCommit(oid);
        if (peeled) suffix = ` peeled:${peeled}`;
      }
      lines.push(encodePktLine(`${oid} ${ref}${suffix}\n`));
    }
    lines.push(PKT_FLUSH);
    return sendBuffer(res, 200, Buffer.concat(lines), 'application/x-git-upload-pack-result');
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | null = null;
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
    }
    const plan = planFetch(repo, wants, haves, clientShallow, depth);
    const parts: Buffer[] = [encodePktLine('acknowledgments\n')];
    if (plan.commonHaves.length === 0) parts.push(encodePktLine('NAK\n'));
    else for (const have of plan.commonHaves) parts.push(encodePktLine(`ACK ${have}\n`));
    parts.push(PKT_FLUSH);
    if (depth !== null || clientShallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'), ...shallowPackets(plan), PKT_FLUSH);
    }
    parts.push(encodePktLine('packfile\n'), ...sidebandChunks(plan.pack), PKT_FLUSH);
    return sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  }

  return sendBuffer(res, 400, Buffer.from(`unknown command ${command}\n`), 'text/plain');
}

function handleUploadPackV0(repo: Repo, res: ServerResponse, body: Buffer): void {
  let packets: PktPacket[];
  try {
    packets = decodeAllPktLines(body);
  } catch {
    return sendBuffer(res, 400, Buffer.from('malformed pkt-line request\n'), 'text/plain');
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, clientShallow, depth);
  const parts: Buffer[] = [encodePktLine('NAK\n'), ...shallowPackets(plan), ...sidebandChunks(plan.pack), PKT_FLUSH];
  return sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleUploadPack(forge: Forge, req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  const repo = forge.getRepo(owner, name);
  if (!repo) return sendBuffer(res, 404, Buffer.from('repository not found\n'), 'text/plain');
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (isV2) return handleUploadPackV2(repo, res, body);
  return handleUploadPackV0(repo, res, body);
}

async function handleReceivePack(forge: Forge, req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  const repo = forge.getRepo(owner, name);
  if (!repo) return sendBuffer(res, 404, Buffer.from('repository not found\n'), 'text/plain');
  const body = await readBody(req);
  const { packets, consumed } = decodePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let requestedCaps = '';
  let firstData = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    if (firstData) {
      firstData = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        requestedCaps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length === 3 && isObjectId(parts[0] as string) && isObjectId(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  const packBytes = body.subarray(consumed);
  let unpackLine = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, repo.lookup);
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (error) {
      unpackLine = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  const report: string[] = [`unpack ${unpackLine}\n`];
  if (unpackLine === 'ok') {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      const fail = (reason: string) => report.push(`ng ${command.ref} ${reason}\n`);
      if (command.oldOid !== current) {
        fail('stale info');
        continue;
      }
      if (command.newOid === ZERO_OID) {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      const target = repo.objects.get(command.newOid);
      if (!target) {
        fail('invalid object');
        continue;
      }
      if (command.ref.startsWith('refs/heads/')) {
        const newCommit = repo.peelToCommit(command.newOid);
        if (!newCommit) {
          fail('invalid object');
          continue;
        }
        if (current !== ZERO_OID) {
          const currentCommit = repo.peelToCommit(current);
          if (!currentCommit || !repo.isAncestor(currentCommit, newCommit)) {
            fail('non-fast-forward');
            continue;
          }
        }
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  }

  const reportStream = Buffer.concat([...report.map((line) => encodePktLine(line)), PKT_FLUSH]);
  const useSideband = requestedCaps.includes('side-band-64k');
  const responseBody = useSideband ? Buffer.concat([...sidebandChunks(reportStream), PKT_FLUSH]) : reportStream;
  return sendBuffer(res, 200, responseBody, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- server

export interface ForgeHandle {
  port: number;
  close: () => Promise<void>;
}

export function startForge(token: string): Promise<ForgeHandle> {
  const forge = new Forge();
  const authed = (req: IncomingMessage): boolean => {
    if (!token) return true;
    return req.headers.authorization === `Bearer ${token}`;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge.invalid');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (path === '/healthz' && method === 'GET') {
          return sendJson(res, 200, { ok: true });
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          if (!authed(req)) return sendJson(res, 401, { message: 'Requires authentication' });
          const owner = decodeURIComponent(gitMatch[1] as string);
          const name = decodeURIComponent(gitMatch[2] as string);
          if (gitMatch[3] === 'info/refs') return handleInfoRefs(forge, req, res, url, owner, name);
          if (gitMatch[3] === 'git-upload-pack') return await handleUploadPack(forge, req, res, owner, name);
          return await handleReceivePack(forge, req, res, owner, name);
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req)) return sendJson(res, 401, { message: 'Requires authentication' });
          return await handleRest(forge, req, res, url);
        }

        if (path === '/api/graphql') {
          if (!authed(req)) return sendJson(res, 401, { message: 'Requires authentication' });
          if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
          const raw = await readBody(req);
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(raw.toString('utf8'));
          } catch {
            return sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
          }
          const { status, payload } = executeGraphQL(forge, parsedBody);
          return sendJson(res, status, payload);
        }

        if (path === '/mcp') {
          if (!authed(req)) return sendJson(res, 401, { message: 'Requires authentication' });
          if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
          const raw = await readBody(req);
          const { status, payload } = handleMcp(forge, raw);
          if (payload === null) {
            res.writeHead(status);
            return res.end();
          }
          return sendJson(res, status, payload);
        }

        return sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal error' });
        else res.end();
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no address'));
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
