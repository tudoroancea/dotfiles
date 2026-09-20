---
name: github
description: Work with GitHub-hosted resources using gh or GitHub URLs, including remote repositories, pull requests, issues, releases, Actions, and remote commit inspection. Do not use for ordinary local git operations such as status, diff, add, commit, branch, merge, or rebase unless the request also involves GitHub.
compatibility: Requires gh for authenticated or private-repository operations; public URL reading and broader research can use Pi web tools.
---

# GitHub

Choose the narrowest route that answers the request.

## Route the task

1. Use `fetch_content` for reading a known public GitHub URL, repository, file, issue, pull request, release, or documentation page.
2. Use `gh` through `bash` for deterministic GitHub-native queries, authenticated/private repositories, precise JSON fields, checks, logs, or explicitly requested mutations.
3. Use `agentflow_librarian` for broad or ambiguous research, cross-repository tracing, or answers that need cited synthesis from multiple remote sources.
4. Use `web_search` to discover relevant GitHub resources when no repository or URL is known.

Do not delegate a simple `gh` lookup to the librarian. Do not use browser extraction as a substitute for authenticated access to a private repository.

## Establish context

Before repository-relative `gh` commands, check authentication and repository identity when they are not already clear:

```bash
gh auth status
gh repo view --json nameWithOwner,url,defaultBranchRef
```

For a repository other than the current checkout, pass `--repo OWNER/REPO` where supported. Prefer explicit repositories over relying on ambient Git remotes.

## Read-only workflows

Prefer bounded structured output with `--json` and `--jq`.

### Repository metadata

```bash
gh repo view OWNER/REPO --json nameWithOwner,description,url,defaultBranchRef,visibility,isArchived
```

### Files and directories

For a public known URL, prefer `fetch_content`. For authenticated API access:

```bash
gh api -H 'Accept: application/vnd.github.raw+json' repos/OWNER/REPO/contents/PATH
gh api repos/OWNER/REPO/contents/PATH --jq '.[] | [.type,.path] | @tsv'
```

For a complete path inventory, first resolve the default branch, then query its tree. Avoid printing an unbounded tree when a narrower path or code search suffices.

```bash
branch=$(gh repo view OWNER/REPO --json defaultBranchRef --jq '.defaultBranchRef.name')
gh api "repos/OWNER/REPO/git/trees/$branch?recursive=1" --jq '.tree[] | select(.type == "blob") | .path' | head -n 200
```

### Code search

```bash
gh search code 'QUERY' --repo OWNER/REPO --limit 30 --json path,repository,url,textMatches
```

Use GitHub search qualifiers where useful. Narrow by repository, language, extension, symbol, or path before increasing limits.

### Commits and comparisons

```bash
gh api -X GET repos/OWNER/REPO/commits --paginate -f per_page=30 --jq '.[] | [.sha[0:12],.commit.author.date,.commit.message] | @tsv' | head -n 60
gh api repos/OWNER/REPO/compare/BASE...HEAD --jq '{status,ahead_by,behind_by,total_commits,files:[.files[]|{filename,status,additions,deletions,patch}]}'
```

When a commit path filter is needed, pass it as an API field rather than downloading all history. Omit patches unless the task requires them because patches can be large or truncated by GitHub.

### Pull requests

```bash
gh pr view NUMBER --repo OWNER/REPO --json number,title,url,state,author,baseRefName,headRefName,body,files,commits,reviews,statusCheckRollup
gh pr diff NUMBER --repo OWNER/REPO
gh pr checks NUMBER --repo OWNER/REPO
```

Use `gh api repos/OWNER/REPO/pulls/NUMBER/comments --paginate` when inline review comments are required.

### Issues

```bash
gh issue view NUMBER --repo OWNER/REPO --json number,title,url,state,author,body,labels,assignees,comments
gh issue list --repo OWNER/REPO --state open --limit 30 --json number,title,url,labels,updatedAt
```

### Releases and tags

```bash
gh release view TAG --repo OWNER/REPO --json tagName,name,url,isDraft,isPrerelease,publishedAt,body,assets
gh release list --repo OWNER/REPO --limit 20
```

### Actions

```bash
gh run list --repo OWNER/REPO --limit 20 --json databaseId,name,workflowName,status,conclusion,headBranch,headSha,url,createdAt
gh run view RUN_ID --repo OWNER/REPO --json jobs,status,conclusion,url
gh run view RUN_ID --repo OWNER/REPO --log-failed
```

Prefer failed logs over all logs unless the complete run is specifically needed.

## Mutations

Treat GitHub mutations separately from inspection. Create, edit, merge, close, comment, rerun, dispatch, release, or delete only when the user explicitly asks for that action. Before mutation:

- Confirm the target `OWNER/REPO` and item number or branch.
- Inspect current state first.
- Use flags that make the intended change explicit.
- Never expose tokens or authentication headers.
- Never force-push.

After mutation, return the resulting URL and verify the new state with a read-only command.

## Research and citations

For a direct answer from one resource, retain its canonical GitHub URL. For broader claims, use `agentflow_librarian` and request primary-source citations to repository files, commits, issues, pull requests, releases, or official documentation. Distinguish observed evidence from inference and do not invent line anchors or revisions.

## Output discipline

- Keep API output bounded and select only fields needed for the question.
- Use `--paginate` only when completeness matters, then filter or cap locally.
- Prefer stable commit URLs over moving branch URLs when citing implementation details.
- Report repository, ref, and item identifiers so results are reproducible.
- If GitHub truncates a tree, diff, or patch, say so and choose a narrower query.
