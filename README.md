# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/verrydimah-cpu/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/verrydimah-cpu/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, with no dependencies and no git binary: one in-memory store backs four surfaces at once — git smart HTTP (protocol v2 ls-refs/fetch with shallow and deepen support, v0 advertisements, receive-pack pushes with report-status and fast-forward enforcement), the REST v3 API (repositories with Link-header pagination, branches, git refs, commits, the contents API, labels, issues, comments, and pull requests with file diffs and three-way squash merges), GraphQL v4 (the queries and mutations gh sends, Relay node ids, cursor pagination, batched operations, __type introspection), and an MCP endpoint (server/discover plus the initialize handshake; create_repo, get_repo, create_issue, list_issues, create_pull_request and merge_pull_request acting on the same store as REST). Objects are real git objects — SHA-1 addressed, packed and delta-resolved by the forge itself.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done), kept as the harness specifies.
- `app.ts` — the HTTP server: bearer-token gate, request ids, and routing for all four surfaces.
- `store.ts` — the single in-memory store: repositories, refs, objects, issues, pulls, labels.
- `gitobj.ts` — the git object model: SHA-1 addressing, trees/commits, pack read/write, deltas.
- `gitproto.ts` — smart HTTP: v2 ls-refs/fetch (shallow, deepen), v0 fallback, receive-pack.
- `domain.ts` — the shared operations: contents commits, issues, pull requests, three-way merges.
- `rest.ts` — REST v3. `graphql.ts` — GraphQL v4 (a small purpose-built parser/executor). `mcp.ts` — the MCP endpoint and its tools.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=your-token node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, serves until the env reports the trial done, and exits 0. With no env handy, point `MAKEFUN_ENV_URL` at any stub that accepts `POST /register` and answers `GET /done`, then drive `http://localhost:<port>/api/v3`, `/api/graphql`, `/mcp` and `/{owner}/{repo}.git` with `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.

<sub>Entered on [make.fun](https://make.fun/?ref=hz6kvzj2&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
