import { describe, expect, it } from 'vitest'
import { issueTrigger, mentions, mrTrigger, noteTrigger, pipelineTrigger, type GitlabIssue, type GitlabMr, type GitlabNote }
  from '../src/sources/gitlab-trigger.ts'

const issue: GitlabIssue = { iid: 12, title: 'Fix login', description: 'The login fails', state: 'opened', web_url: 'https://gitlab.example.com/acme/widgets/-/issues/12',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', author: { username: 'alice' } }
const mr: GitlabMr = { iid: 7, title: 'Fix login', description: 'Closes #12', state: 'opened', web_url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/7',
  created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', author: { username: 'agent-bot' }, source_branch: 'agent/login', target_branch: 'main' }
const note: GitlabNote = { id: 99, body: '@agent-bot please fix', created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z',
  author: { username: 'alice' }, noteable_iid: 12, noteable_type: 'Issue' }

describe('GitLab triggers', () => {
  it('maps an Issue, a Merge Request, a note, and a pipeline', () => {
    const i = issueTrigger(issue, 'agent-bot', 'https://gitlab.example.com', 'acme/widgets')
    expect(i).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'issue:12' }], actor: { source: 'gitlab', id: 'alice' }, human: true,
      text: 'Fix login\n\nThe login fails', channel: { source: 'gitlab', thread: 'gitlab:issue:12', address: { kind: 'issue', number: '12' } },
      meta: { kind: 'issue', number: 12, isPr: false } })
    const m = mrTrigger(mr, 'agent-bot', 'https://gitlab.example.com', 'acme/widgets')
    expect(m.meta).toMatchObject({ kind: 'mr', number: 7, isPr: true, prAuthor: 'agent-bot', sourceBranch: 'agent/login' })
    expect(noteTrigger(note, 'issue', 12, 'agent-bot', 'https://gitlab.example.com', 'acme/widgets')).toMatchObject({
      addressed: 'mention', meta: { kind: 'issue', number: 12, noteId: 99 }, channel: { address: { kind: 'issue', number: '12' } } })
    expect(noteTrigger({ ...note, system: true }, 'issue', 12, 'agent-bot', 'https://gitlab.example.com', 'acme/widgets')).toBeUndefined()
    expect(pipelineTrigger({ id: 5, status: 'failed', ref: 'main', sha: 'abc' }, 0, 'failed', 'https://ci')).toMatchObject({ source: 'gitlab', human: false,
      threads: [{ source: 'gitlab', id: 'ci:main' }], meta: { ci: true, branch: 'main' } })
  })
  it('matches an @mention only as a whole account name', () => {
    expect(mentions('@agent-bot hi', 'agent-bot')).toBe(true)
    expect(mentions('@agent-bot2 hi', 'agent-bot')).toBe(false)
    expect(mentions('mail agent-bot', 'agent-bot')).toBe(false)
  })
})
