// A small GraphQL engine for the subset the checks exercise: named and
// anonymous operations, variables, aliases, inline fragments, input
// objects, lists, enums, connections with cursors, the mutations the
// forge supports, and __type introspection. Unknown fields produce a
// GraphQL errors array naming the field, as real GitHub does.

import { Forge, Repo, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Issue, type PullRequest } from './store.ts';

// ---------------------------------------------------------------- global ids

export function globalId(type: string, ...parts: (string | number)[]): string {
  return Buffer.from(`v1:${type}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'v1' || parts.length < 3) return null;
    return { type: parts[1] as string, parts: parts.slice(2) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string) => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:=!$@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      while (j < source.length && /[-+0-9.eE]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      const value = Number(text);
      if (Number.isNaN(value)) throw new Error(`bad number ${text}`);
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({
          operation: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName(); // type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      return { kind: 'fragmentSpread', name: this.expectName() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: FieldNode['args'] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }
}

// ---------------------------------------------------------------- schema

type Ctx = { forge: Forge; variables: Record<string, unknown> };

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', user: 'User' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: {},
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
  },
  Ref: { target: 'Commit' },
  Commit: {},
  Issue: { author: 'User', repository: 'Repository' },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo' },
  PageInfo: {},
  PullRequest: {
    author: 'User',
    repository: 'Repository',
    headRef: 'Ref',
    baseRef: 'Ref',
    mergeCommit: 'Commit',
    files: 'PullRequestChangedFileConnection',
  },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo' },
  PullRequestChangedFile: {},
  IssueComment: { author: 'User' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '[__Field]', enumValues: '[__EnumValue]', possibleTypes: '[__Type]', inputFields: '[__InputValue]', ofType: '__Type' },
  __Field: { type: '__Type', args: '[__InputValue]' },
  __EnumValue: {},
  __InputValue: { type: '__Type' },
};

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'user', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'closePullRequest'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'description', 'isPrivate', 'isFork', 'url', 'createdAt', 'updatedAt', 'primaryLanguage',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'author'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'author', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'assignees', 'milestone',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit',
    'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author',
    'repository', 'url', 'createdAt', 'updatedAt', 'closedAt', 'additions', 'deletions', 'changedFiles',
  ],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const OBJECT_TYPES = new Set(Object.keys(FIELD_TYPES));

// ---------------------------------------------------------------- value helpers

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

function paginate<T>(items: T[], args: Record<string, unknown>): Connection<T> {
  const start = indexFromCursor(args.after);
  const first = typeof args.first === 'number' ? args.first : items.length;
  const nodes = items.slice(start, start + first);
  const end = start + nodes.length;
  return {
    nodes,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? cursorFor(start + 1) : null,
      endCursor: nodes.length > 0 ? cursorFor(end) : null,
    },
  };
}

// ---------------------------------------------------------------- object builders

function userObject(): GqlObject {
  return { __type: 'User', login: VIEWER_LOGIN, id: globalId('User', VIEWER_LOGIN), databaseId: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoObject(repo: Repo): GqlObject {
  return { __type: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __type: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: PullRequest): GqlObject {
  return { __type: 'PullRequest', repo, pull };
}

function commentObject(repo: Repo, item: Issue | PullRequest, commentId: number, body: string): GqlObject {
  return { __type: 'IssueComment', repo, itemNumber: item.number, commentId, body };
}

// ---------------------------------------------------------------- resolvers

class FieldError extends Error {}

function resolveField(typeName: string, obj: GqlObject | null, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  if (field === '__typename') return typeName;

  if (typeName === 'Query') {
    switch (field) {
      case 'viewer':
        return userObject();
      case 'user':
        return args.login === VIEWER_LOGIN ? userObject() : null;
      case 'repository': {
        const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObject(repo) : null;
      }
      case 'node': {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (!parsed) return null;
        if (parsed.type === 'Repository') {
          const repo = ctx.forge.repos.get(parsed.parts[0] as string);
          return repo ? repoObject(repo) : null;
        }
        if (parsed.type === 'User') return userObject();
        if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
          const repo = ctx.forge.repos.get(parsed.parts[0] as string);
          const item = repo?.items.get(Number(parsed.parts[1]));
          if (!repo || !item) return null;
          return item.kind === 'issue' ? issueObject(repo, item) : pullObject(repo, item);
        }
        if (parsed.type === 'IssueComment') {
          const repo = ctx.forge.repos.get(parsed.parts[0] as string);
          const item = repo?.items.get(Number(parsed.parts[1]));
          const comment = item?.comments.find((c) => c.id === Number(parsed.parts[2]));
          if (!repo || !item || !comment) return null;
          return commentObject(repo, item, comment.id, comment.body);
        }
        return null;
      }
      default:
        break;
    }
  }

  if (typeName === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field) {
      case 'createIssue': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed?.type === 'Repository' ? ctx.forge.repos.get(parsed.parts[0] as string) : undefined;
        if (!repo) throw new FieldError('Repository not found');
        const issue = repo.createIssue({ title: String(input.title ?? ''), body: String(input.body ?? ''), labels: [] });
        return { __type: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
      }
      case 'closeIssue': {
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        const repo = parsed ? ctx.forge.repos.get(parsed.parts[0] as string) : undefined;
        const item = repo?.items.get(Number(parsed?.parts[1]));
        if (!repo || !item || item.kind !== 'issue') throw new FieldError('Issue not found');
        item.state = 'closed';
        return { __type: 'CloseIssuePayload', issue: issueObject(repo, item), clientMutationId: input.clientMutationId ?? null };
      }
      case 'createPullRequest': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed?.type === 'Repository' ? ctx.forge.repos.get(parsed.parts[0] as string) : undefined;
        if (!repo) throw new FieldError('Repository not found');
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        if (!repo.refs.has(`refs/heads/${headRef}`) || !repo.refs.has(`refs/heads/${baseRef}`)) {
          throw new FieldError('Head or base branch not found');
        }
        const pull = repo.createPull({ title: String(input.title ?? ''), body: String(input.body ?? ''), headRef, baseRef });
        return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null };
      }
      case 'mergePullRequest': {
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        const repo = parsed ? ctx.forge.repos.get(parsed.parts[0] as string) : undefined;
        const item = repo?.items.get(Number(parsed?.parts[1]));
        if (!repo || !item || item.kind !== 'pull') throw new FieldError('Pull request not found');
        const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
        const result = repo.mergePull(item, method === 'merge' ? 'merge' : 'squash');
        if (!result) throw new FieldError('Pull request branches are missing');
        if ('conflict' in result) throw new FieldError('Pull Request is not mergeable');
        return { __type: 'MergePullRequestPayload', pullRequest: pullObject(repo, item), clientMutationId: input.clientMutationId ?? null };
      }
      case 'addComment': {
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        const repo = parsed ? ctx.forge.repos.get(parsed.parts[0] as string) : undefined;
        const item = repo?.items.get(Number(parsed?.parts[1]));
        if (!repo || !item) throw new FieldError('Subject not found');
        const comment = repo.addComment(item, String(input.body ?? ''));
        return {
          __type: 'AddCommentPayload',
          commentEdge: { __type: 'IssueCommentEdge', node: commentObject(repo, item, comment.id, comment.body), cursor: cursorFor(comment.id) },
          clientMutationId: input.clientMutationId ?? null,
        };
      }
      default:
        break;
    }
  }

  if (obj === null) return null;

  if (typeName === 'User') {
    const user = obj as unknown as { login: string; id: string; databaseId: number; name: string; email: string };
    switch (field) {
      case 'login': return user.login;
      case 'id': return user.id;
      case 'databaseId': return user.databaseId;
      case 'name': return user.name;
      case 'email': return user.email;
      case 'avatarUrl': return '';
      case 'url': return '';
      case 'createdAt': case 'updatedAt': return '2026-01-01T00:00:00Z';
      default: break;
    }
  }

  if (typeName === 'Repository') {
    const repo = obj.repo as Repo;
    switch (field) {
      case 'id': return globalId('Repository', repo.name);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${VIEWER_LOGIN}/${repo.name}`;
      case 'owner': return userObject();
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'isFork': return false;
      case 'url': return '';
      case 'createdAt': case 'updatedAt': return '2026-01-01T00:00:00Z';
      case 'primaryLanguage': return null;
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'hasPullRequestsEnabled': return true;
      case 'defaultBranchRef': {
        const tip = repo.headCommit();
        if (!tip) return null;
        return { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', targetOid: tip };
      }
      case 'issue': {
        const item = repo.items.get(Number(args.number));
        return item && item.kind === 'issue' ? issueObject(repo, item) : null;
      }
      case 'pullRequest': {
        const item = repo.items.get(Number(args.number));
        return item && item.kind === 'pull' ? pullObject(repo, item) : null;
      }
      case 'issues': {
        let issues = [...repo.items.values()].filter((i): i is Issue => i.kind === 'issue');
        const states = args.states as string[] | undefined;
        if (Array.isArray(states)) issues = issues.filter((i) => states.includes(i.state.toUpperCase()));
        const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
        issues.sort((a, b) => a.number - b.number);
        if (orderBy.direction === 'DESC') issues.reverse();
        const page = paginate(issues.map((i) => issueObject(repo, i)), args);
        return { __type: 'IssueConnection', ...page };
      }
      case 'pullRequests': {
        let pulls = [...repo.items.values()].filter((i): i is PullRequest => i.kind === 'pull');
        const states = args.states as string[] | undefined;
        if (Array.isArray(states)) {
          pulls = pulls.filter((p) => {
            const state = p.merged ? 'MERGED' : p.state.toUpperCase();
            return states.includes(state);
          });
        }
        pulls.sort((a, b) => a.number - b.number);
        const orderBy = (args.orderBy ?? {}) as { direction?: string };
        if (orderBy.direction === 'DESC') pulls.reverse();
        const page = paginate(pulls.map((p) => pullObject(repo, p)), args);
        return { __type: 'PullRequestConnection', ...page };
      }
      default: break;
    }
  }

  if (typeName === 'Ref') {
    switch (field) {
      case 'id': return globalId('Ref', `${VIEWER_LOGIN}:${String(obj.name)}`);
      case 'name': return obj.name;
      case 'prefix': return obj.prefix ?? 'refs/heads/';
      case 'target': return { __type: 'Commit', oid: obj.targetOid };
      default: break;
    }
  }

  if (typeName === 'Commit') {
    switch (field) {
      case 'id': return globalId('Commit', String(obj.oid));
      case 'oid': return obj.oid;
      case 'message': return '';
      case 'messageHeadline': return '';
      case 'committedDate': return '2026-01-01T00:00:00Z';
      default: break;
    }
  }

  if (typeName === 'Issue') {
    const repo = obj.repo as Repo;
    const issue = obj.issue as Issue;
    switch (field) {
      case 'id': return globalId('Issue', repo.name, issue.number);
      case 'databaseId': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state.toUpperCase();
      case 'url': return '';
      case 'author': return userObject();
      case 'repository': return repoObject(repo);
      case 'createdAt': case 'updatedAt': return '2026-01-01T00:00:00Z';
      case 'closedAt': return issue.state === 'closed' ? '2026-01-01T00:00:00Z' : null;
      default: break;
    }
  }

  if (typeName === 'PullRequest') {
    const repo = obj.repo as Repo;
    const pull = obj.pull as PullRequest;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
    switch (field) {
      case 'id': return globalId('PullRequest', repo.name, pull.number);
      case 'databaseId': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.mergedAt;
      case 'mergeCommit': return pull.mergeCommitSha ? { __type: 'Commit', oid: pull.mergeCommitSha } : null;
      case 'mergeable': return repo.pullMergeable(pull);
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRef': return headTip ? { __type: 'Ref', name: pull.headRef, prefix: 'refs/heads/', targetOid: headTip } : null;
      case 'baseRef': return baseTip ? { __type: 'Ref', name: pull.baseRef, prefix: 'refs/heads/', targetOid: baseTip } : null;
      case 'author': return userObject();
      case 'repository': return repoObject(repo);
      case 'url': return '';
      case 'createdAt': case 'updatedAt': return '2026-01-01T00:00:00Z';
      case 'closedAt': return pull.state === 'closed' ? (pull.mergedAt ?? '2026-01-01T00:00:00Z') : null;
      case 'files': {
        const diff = repo.diffCommits(baseTip, headTip);
        const files = diff.map((d) => ({
          __type: 'PullRequestChangedFile',
          path: d.filename,
          additions: d.additions,
          deletions: d.deletions,
          changeType: d.status === 'added' ? 'ADDED' : d.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }));
        const page = paginate(files, args);
        return { __type: 'PullRequestChangedFileConnection', ...page };
      }
      case 'additions': return repo.diffCommits(baseTip, headTip).reduce((sum, d) => sum + d.additions, 0);
      case 'deletions': return repo.diffCommits(baseTip, headTip).reduce((sum, d) => sum + d.deletions, 0);
      case 'changedFiles': return repo.diffCommits(baseTip, headTip).length;
      default: break;
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (field === 'nodes') return obj.nodes;
    if (field === 'pageInfo') return { __type: 'PageInfo', ...(obj.pageInfo as object) };
    if (field === 'totalCount') return obj.totalCount;
  }

  if (typeName === 'PageInfo') {
    switch (field) {
      case 'hasNextPage': return obj.hasNextPage;
      case 'hasPreviousPage': return obj.hasPreviousPage;
      case 'startCursor': return obj.startCursor;
      case 'endCursor': return obj.endCursor;
      default: break;
    }
  }

  if (typeName === 'PullRequestChangedFile') {
    switch (field) {
      case 'path': return obj.path;
      case 'additions': return obj.additions;
      case 'deletions': return obj.deletions;
      case 'changeType': return obj.changeType;
      default: break;
    }
  }

  if (typeName === 'IssueComment') {
    switch (field) {
      case 'id': return globalId('IssueComment', (obj.repo as Repo).name, Number(obj.itemNumber), Number(obj.commentId));
      case 'databaseId': return obj.commentId;
      case 'body': return obj.body;
      case 'author': return userObject();
      case 'createdAt': case 'updatedAt': return '2026-01-01T00:00:00Z';
      case 'url': return '';
      default: break;
    }
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field === 'issue') return obj.issue;
    if (field === 'clientMutationId') return obj.clientMutationId ?? null;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field === 'pullRequest') return obj.pullRequest;
    if (field === 'clientMutationId') return obj.clientMutationId ?? null;
  }
  if (typeName === 'AddCommentPayload') {
    if (field === 'commentEdge') return obj.commentEdge;
    if (field === 'clientMutationId') return obj.clientMutationId ?? null;
  }
  if (typeName === 'IssueCommentEdge') {
    if (field === 'node') return obj.node;
    if (field === 'cursor') return obj.cursor;
  }

  if (typeName === '__Type') {
    const typeName2 = String(obj.name);
    switch (field) {
      case 'name': return typeName2;
      case 'kind': return ENUM_VALUES[typeName2] ? 'ENUM' : 'OBJECT';
      case 'description': return null;
      case 'fields':
        return (TYPE_FIELDS[typeName2] ?? []).map((name) => ({ __type: '__Field', name, ownerType: typeName2 }));
      case 'enumValues':
        return (ENUM_VALUES[typeName2] ?? []).map((name) => ({ __type: '__EnumValue', name }));
      case 'possibleTypes': return null;
      case 'inputFields': return [];
      case 'ofType': return null;
      case 'specifiedByURL': return null;
      case 'isOneOf': return false;
      default: break;
    }
  }
  if (typeName === '__Field') {
    switch (field) {
      case 'name': return obj.name;
      case 'description': return null;
      case 'type': return { __type: '__Type', name: 'String' };
      case 'args': return [];
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: break;
    }
  }
  if (typeName === '__EnumValue') {
    switch (field) {
      case 'name': return obj.name;
      case 'description': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: break;
    }
  }
  if (typeName === '__InputValue') {
    switch (field) {
      case 'name': return obj.name;
      case 'description': return null;
      case 'type': return { __type: '__Type', name: 'String' };
      case 'defaultValue': return null;
      default: break;
    }
  }

  throw new FieldError(`Cannot query field "${field}" on type "${typeName}".`);
}

// ---------------------------------------------------------------- executor

interface ExecResult {
  data: Record<string, unknown>;
  errors?: { message: string; path?: (string | number)[] }[];
}

function namedType(typeRef: string): string {
  return typeRef.replace(/[[\]!]/g, '');
}

function executeSelectionSet(
  typeName: string,
  obj: GqlObject | null,
  selections: SelectionNode[],
  ctx: Ctx,
  fragments: Map<string, SelectionNode[]>,
  path: (string | number)[],
  errors: { message: string; path?: (string | number)[] }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const runSelections = (sels: SelectionNode[], currentObj: GqlObject | null, currentType: string) => {
    for (const sel of sels) {
      if (sel.kind === 'inlineFragment') {
        if (!sel.typeCondition || sel.typeCondition === currentType || sel.typeCondition === 'Node') {
          Object.assign(out, executeSelectionSet(currentType, currentObj, sel.selectionSet, ctx, fragments, path, errors));
        }
        continue;
      }
      if (sel.kind === 'fragmentSpread') {
        const frag = fragments.get(sel.name);
        if (frag) Object.assign(out, executeSelectionSet(currentType, currentObj, frag, ctx, fragments, path, errors));
        continue;
      }
      const key = sel.alias ?? sel.name;
      const fieldPath = [...path, key];
      try {
        if (sel.name === '__type' && (currentType === 'Query')) {
          const args = argsOf(sel, ctx);
          const typeObj: GqlObject = { __type: '__Type', name: String(args.name ?? '') };
          out[key] = sel.selectionSet ? executeSelectionSet('__Type', typeObj, sel.selectionSet, ctx, fragments, fieldPath, errors) : typeObj;
          continue;
        }
        if (sel.name === '__schema') {
          out[key] = null;
          continue;
        }
        const value = resolveField(currentType, currentObj, sel.name, argsOf(sel, ctx), ctx);
        out[key] = completeValue(currentType, sel, value, ctx, fragments, fieldPath, errors);
      } catch (error) {
        out[key] = null;
        errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
      }
    }
  };
  runSelections(selections, obj, typeName);
  return out;
}

function completeValue(
  parentType: string,
  field: FieldNode,
  value: unknown,
  ctx: Ctx,
  fragments: Map<string, SelectionNode[]>,
  path: (string | number)[],
  errors: { message: string; path?: (string | number)[] }[],
): unknown {
  if (value === null || value === undefined) return null;
  if (!field.selectionSet) return value;
  const typeRef = FIELD_TYPES[parentType]?.[field.name];
  if (Array.isArray(value)) {
    const elemType = typeRef ? namedType(typeRef) : null;
    return value.map((item, index) => {
      if (item === null || typeof item !== 'object') return item;
      const itemObj = item as GqlObject;
      const itemType = itemObj.__type ?? elemType ?? parentType;
      return executeSelectionSet(itemType, itemObj, field.selectionSet as SelectionNode[], ctx, fragments, [...path, index], errors);
    });
  }
  if (typeof value === 'object') {
    const valueObj = value as GqlObject;
    const valueType = valueObj.__type ?? (typeRef ? namedType(typeRef) : parentType);
    if (!OBJECT_TYPES.has(valueType) && valueType !== '__Type' && valueType !== '__Field' && valueType !== '__EnumValue') return value;
    return executeSelectionSet(valueType, valueObj, field.selectionSet, ctx, fragments, path, errors);
  }
  return value;
}

export function executeGraphQL(forge: Forge, body: unknown): { status: number; payload: unknown } {
  const runOne = (entry: unknown): ExecResult => {
    if (!entry || typeof entry !== 'object') return { data: {}, errors: [{ message: 'Invalid GraphQL request' }] };
    const request = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof request.query !== 'string') return { data: {}, errors: [{ message: 'Must provide query string.' }] };
    const variables = (request.variables && typeof request.variables === 'object' ? request.variables : {}) as Record<string, unknown>;
    let document: { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> };
    try {
      document = new Parser(lex(request.query)).parseDocument();
    } catch (error) {
      return { data: {}, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
    const operation =
      document.operations.find((op) => op.name === request.operationName) ?? document.operations[0];
    if (!operation) return { data: {}, errors: [{ message: 'No operation found' }] };
    const ctx: Ctx = { forge, variables };
    const errors: { message: string; path?: (string | number)[] }[] = [];
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelectionSet(rootType, null, operation.selectionSet, ctx, document.fragments, [], errors);
    const result: ExecResult = { data };
    if (errors.length > 0) result.errors = errors;
    return result;
  };

  if (Array.isArray(body)) {
    return { status: 200, payload: body.map((entry) => runOne(entry)) };
  }
  const result = runOne(body);
  return { status: 200, payload: result };
}
