// The MCP endpoint: JSON-RPC 2.0 over POST /mcp. Answers server/discover
// (and the legacy initialize handshake) and exposes tools that act on the
// same store as REST and GraphQL, so ids and numbers agree across
// surfaces. The tools/list payload is a module constant — byte-identical
// on every call, as the protocol requires of a static server.

import { Forge, VIEWER_LOGIN, issueJson, pullJson, repoJson, type Repo } from './store.ts';

const SERVER_INFO = { name: 'ada-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  const props: ToolDef['inputSchema']['properties'] = {};
  for (const [key, desc] of Object.entries(properties)) {
    props[key] = { type: key === 'private' ? 'boolean' : key === 'pull_number' || key === 'issue_number' ? 'integer' : 'string', description: desc };
  }
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

const OWNER_REPO = { owner: 'The repository owner login', repo: 'The repository name' };

export const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user.', {
    name: 'The repository name',
    description: 'A short description of the repository',
    private: 'Whether the repository is private',
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', { ...OWNER_REPO }, ['owner', 'repo']),
  tool('list_repos', 'List repositories owned by the authenticated user.', {}, []),
  tool('create_issue', 'Create an issue in a repository.', {
    ...OWNER_REPO,
    title: 'The issue title',
    body: 'The issue body',
  }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Get one issue by number.', {
    ...OWNER_REPO,
    issue_number: 'The issue number',
  }, ['owner', 'repo', 'issue_number']),
  tool('list_issues', 'List issues in a repository, optionally filtered by state.', {
    ...OWNER_REPO,
    state: 'Filter by state: open, closed, or all',
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request between two branches.', {
    ...OWNER_REPO,
    title: 'The pull request title',
    body: 'The pull request body',
    head: 'The head branch to merge from',
    base: 'The base branch to merge into',
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by number.', {
    ...OWNER_REPO,
    pull_number: 'The pull request number',
  }, ['owner', 'repo', 'pull_number']),
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export interface McpResponse {
  status: number;
  payload: unknown; // null payload means an empty body (notification ack)
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): McpResponse {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  return forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): McpResponse | null {
  const def = TOOLS_BY_NAME.get(name);
  if (!def) return null; // caller turns this into -32602
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcError(argumentsId(args), -32602, `Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo(String(args.name), String(args.description ?? ''), args.private === true);
      if (!repo) return rpcResult(argumentsId(args), toolError('Repository already exists'));
      return rpcResult(argumentsId(args), toolResult(repoJson(repo)));
    }
    case 'list_repos': {
      return rpcResult(argumentsId(args), toolResult([...forge.repos.values()].map((r) => repoJson(r))));
    }
    case 'get_repo': {
      const repo = requireRepo(forge, args);
      if (!repo) return rpcResult(argumentsId(args), toolError('Repository not found'));
      return rpcResult(argumentsId(args), toolResult(repoJson(repo)));
    }
    case 'create_issue': {
      const repo = requireRepo(forge, args);
      if (!repo) return rpcResult(argumentsId(args), toolError('Repository not found'));
      const issue = repo.createIssue({ title: String(args.title), body: String(args.body ?? ''), labels: [] });
      return rpcResult(argumentsId(args), toolResult(issueJson(repo, issue)));
    }
    case 'get_issue': {
      const repo = requireRepo(forge, args);
      const item = repo?.items.get(Number(args.issue_number));
      if (!repo || !item || item.kind !== 'issue') return rpcResult(argumentsId(args), toolError('Issue not found'));
      return rpcResult(argumentsId(args), toolResult(issueJson(repo, item)));
    }
    case 'list_issues': {
      const repo = requireRepo(forge, args);
      if (!repo) return rpcResult(argumentsId(args), toolError('Repository not found'));
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.items.values()].filter(
        (item) => item.kind === 'issue' && (state === 'all' || item.state === state),
      );
      return rpcResult(argumentsId(args), toolResult(issues.map((item) => issueJson(repo, item as never))));
    }
    case 'create_pull_request': {
      const repo = requireRepo(forge, args);
      if (!repo) return rpcResult(argumentsId(args), toolError('Repository not found'));
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return rpcResult(argumentsId(args), toolError('Head or base branch not found'));
      }
      const pull = repo.createPull({ title: String(args.title), body: String(args.body ?? ''), headRef: head, baseRef: base });
      return rpcResult(argumentsId(args), toolResult(pullJson(repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(forge, args);
      const item = repo?.items.get(Number(args.pull_number));
      if (!repo || !item || item.kind !== 'pull') return rpcResult(argumentsId(args), toolError('Pull request not found'));
      if (item.state === 'closed' && item.merged) return rpcResult(argumentsId(args), toolResult(pullJson(repo, item)));
      const result = repo.mergePull(item, 'squash');
      if (!result) return rpcResult(argumentsId(args), toolError('Pull request branches are missing'));
      if ('conflict' in result) return rpcResult(argumentsId(args), toolError('Pull Request is not mergeable'));
      return rpcResult(argumentsId(args), toolResult(pullJson(repo, item)));
    }
    default:
      return null;
  }
}

// The JSON-RPC id rides along on the args object so callTool can build the
// envelope; set by handleMcp before dispatch.
const ID_KEY = Symbol('mcp-id');
function argumentsId(args: Record<string, unknown>): unknown {
  return (args as Record<symbol, unknown>)[ID_KEY] ?? null;
}

export function handleMcp(forge: Forge, rawBody: Buffer): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      payload: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not valid JSON' } },
    };
  }

  const handleOne = (request: unknown): McpResponse => {
    if (!request || typeof request !== 'object') return rpcError(null, -32600, 'Invalid request');
    const req = request as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const method = typeof req.method === 'string' ? req.method : '';
    const hasId = 'id' in req && req.id !== undefined;
    if (!hasId || method.startsWith('notifications/')) return { status: 202, payload: null };
    const id = req.id;
    const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;

    switch (method) {
      case 'server/discover':
        return rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          instructions: 'A GitHub-compatible forge. Tools manage repositories, issues and pull requests.',
        });
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
        (args as Record<symbol, unknown>)[ID_KEY] = id;
        const result = callTool(forge, toolName, args);
        if (result === null) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
        return result;
      }
      case 'resources/list':
        return rpcResult(id, { resources: [] });
      case 'prompts/list':
        return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };

  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => handleOne(entry)).filter((r) => r.payload !== null).map((r) => r.payload);
    return { status: 200, payload: responses };
  }
  return handleOne(parsed);
}

export { VIEWER_LOGIN };
