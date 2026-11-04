---
name: dsh-superagent-gitlab
description: Use for GitLab work on this deployment: Issues, Merge Requests, notes, CI and repository reads through the restricted glab wrapper.
---

GitLab is reached through the `glab` on PATH, which is the restricted `glab-safe` wrapper. Use it for every GitLab operation. Never merge, approve, tag, release, or change protected branches; those actions are not in the allowlist.

The Execution environment gives the instance and project:
- `DSH_SUPERAGENT_GITLAB_HOST`: the GitLab origin.
- `DSH_SUPERAGENT_GITLAB_PROJECT`: the project path, such as `group/subgroup/project`.
- `DSH_SUPERAGENT_GITLAB_ACCOUNT` and `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL`: the account and commit email to use.
- `DSH_SUPERAGENT_GITLAB_NUMBER` and `DSH_SUPERAGENT_GITLAB_MR_HEAD`: the Issue or MR this Ticket came from.

## Read

- `glab api "projects/<url-encoded project>"` for project facts.
- `glab api "projects/<url-encoded project>/issues?state=opened"` and ~`.../merge_requests?state=opened` for lists.
- `glab api "projects/<url-encoded project>/issues/<iid>/notes?per_page=100&sort=asc"` for a conversation.
- `glab repo view`, or `glab api .../repository/files/<path>/raw?ref=<branch>`, for repository files and `.gitlab-ci.yml`.
- `glab ci list`, `glab ci view <pipeline>`, and `glab ci trace <job>` for pipelines and job logs.

## Write (safe allowlist)

- Issue comment: `glab issue note <iid> --message`, or `glab api .../issues/<iid>/notes --method POST -f body=...`.
- MR comment: `glab mr note <iid> --message`, or the same through `api`.
- New Issue: `glab issue create` (no merge, approve, or tag flags).
- New Merge Request: push the ticket branch with git, then `glab mr create --source-branch <branch> --target-branch <base>`. Do not merge it.

## Boundaries

- The wrapper refuses `mr merge`, `mr approve`, `tag`, `release`, and non-GET `api` calls outside the allowlist. Do not try to work around it.
- Do not print tokens or CI secrets. Truncate job logs before quoting them.
- Respect the team Prompt's Delivery requirements for commit author, disclosure, and review.
