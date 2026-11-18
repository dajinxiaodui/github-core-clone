# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dajinxiaodui/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dajinxiaodui/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard
library only, no git binary. It keeps its own object store and serves four
surfaces from it: git smart HTTP (upload-pack protocol v2 with ls-refs and
shallow fetch, receive-pack v0 with report-status in side-band-64k), the
REST v3 API (repositories, branches, commits, contents, labels, issues,
comments, pull requests with squash merges), the GraphQL v4 API (the
documents gh and github-mcp-server send, introspection included), and an
MCP endpoint (server/discover plus tools for repos, issues and pull
requests) acting on the same store.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
# binds an ephemeral port, registers it with the env, serves until the env says done
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=qtgxrqfw&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
