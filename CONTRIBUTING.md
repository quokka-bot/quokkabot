# Contributing

## Setup

`pnpm install`, then `pnpm check` (typecheck, unit tests, text check). Running the whole stack on a Mac:
[docs/install.md](docs/install.md#development-on-a-mac). Layout, commands and rules: [AGENTS.md](AGENTS.md).

## Read this first

Quokka Bot is maintained by a small team with limited review time. Opening a PR does not oblige us to review or
merge it. We may close it, defer it, ask for a smaller scope, or build the idea ourselves later. Following this guide
makes a PR eligible for review; it does not guarantee a merge.

The rules apply to every open PR, drafts included.

Focused bug fixes, reliability, security and performance fixes, and maintenance are the most likely to be merged.
Unrequested features, rewrites and unrelated cleanup are the least likely.

Bugs go in [issues](https://github.com/quokka-bot/quokkabot/issues/new/choose). Feature ideas go in
[Ideas discussions](https://github.com/quokka-bot/quokkabot/discussions/categories/ideas). Search both first.
Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

<a id="problem-first"></a>

## Agree on the problem first

Features and changes to how the product behaves need a maintainer's explicit approval of the direction and scope in
a discussion or issue before you write code. Link that approval in the PR. Calling a behavior change a bug fix does
not skip this step.

A larger bug fix links an issue a maintainer has confirmed, with the failure and the intended behavior.

A small, obvious bug fix can come without an issue. Say what the defect is and why the fix is small. We judge what
the change does, not its line count.

<a id="one-problem"></a>

## One problem per PR

A PR that fixes several independent problems gets split, even when each fix is good. Include everything that one
problem needs: shared types, control plane, web, tests and docs. A side cleanup or a second fix goes in its own PR.

<a id="boundaries"></a>

## Boundaries need a test

The agent's limits are enforced outside the model, by the control plane, the egress proxy and the vault. A change to
the control plane, supervisor, browser service or egress proxy needs a test that proves the boundary still holds:
the agent still cannot reach the vault, raw CDP, the CLI token, or the network around the proxy. A PR that opens a
route around a boundary is closed, whatever it adds.

<a id="evidence"></a>

## Show that it works

The PR says how you found the problem, how you checked the fix, and what you saw: steps to reproduce, environment,
the focused tests or manual checks you ran and their results, and what you could not check. "Tests pass" alone is not
evidence.

Match the evidence to the change. UI changes need before and after screenshots, and a short recording when timing or
motion matters. Attach them to the PR; do not commit them.

`pnpm check` must pass. Control plane integration tests need Docker on Linux:
`QB_INTEGRATION=1 pnpm vitest run apps/control`.

<a id="text"></a>

## Text

User-facing text says what happens, in short plain sentences. No em dashes; `pnpm check` rejects them. No secrets,
personal data or real accounts in code, tests or docs.

<a id="agents"></a>

## Agents

PRs written by AI agents are welcome. Name the model and the tool in the PR. You are the author and answer for every
line; we judge the PR by the rules above, not by who or what wrote it. [AGENTS.md](AGENTS.md) is written for your
agent.

<a id="closing"></a>

## Closing and reopening

A PR that breaks these rules can be closed before review. The closing comment names the rule, the evidence, and what
would fix it. Fix it and ask for another look, or open focused replacement PRs that link the original. If we decline
a fix but the problem is real, we keep the problem open.

## License

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
