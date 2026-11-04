import { describe, expect, it } from 'vitest'
import type { Commands } from '../src/infra/commands.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { KV } from '../src/kv.ts'
import { pollRound } from '../src/sources/gitlab.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { claimMr, observeMr } from '../src/sources/gitlab-mr.ts'
import { testDeployment } from './fixtures/deployment.ts'

const config = { host: 'https://gitlab.example.com', project: 'acme/widgets', cli: 'glab-agent', pollSeconds: 60, failuresBeforeError: 3,
  observeIssues: false, observeMergeRequests: false, observeComments: false, observeCi: false }
const issue = { iid: 12, title: 'Fix login', description: 'The login fails', state: 'opened', web_url: 'https://gitlab.example.com/acme/widgets/-/issues/12',
  created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', author: { username: 'alice' } }
const note = { id: 99, body: '@agent-bot please fix', created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z',
  author: { username: 'alice' }, noteable_iid: 12, noteable_type: 'Issue' }
const deployment = testDeployment({ github: undefined, feishu: undefined, gitlab: { host: config.host, project: config.project, cli: config.cli,
  login: 'agent-bot', noreply: 'agent@example.com' } })

function harness(replies: (path: string) => unknown) {
  const received: unknown[] = []
  const bound: unknown[] = []
  const closed: unknown[] = []
  const calls: string[] = []
  const state = new Map<string, unknown>([[KV.gitlab.since, '2026-01-01T00:00:00Z']])
  const commands = { deployment, withSignal: () => commands, run: async (_program: string, args: string[]) => {
    const path = args[1] ?? ''; calls.push(path); const value = replies(path)
    return typeof value === 'string' ? value : JSON.stringify(value ?? [])
  } } as unknown as Commands
  const ctx = { deployment, commands, ready: Promise.resolve(), configured: () => true, problem: undefined,
    config: () => config, receive: async (trigger: unknown) => { received.push(trigger) }, atomic: <T>(work: () => T) => work(),
    state: { get: (key: string) => state.get(key) as never, set: (key: string, value: unknown) => { state.set(key, value) }, keys: () => [] },
    threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
    tickets: { get: () => undefined, open: () => [], bindThread: (...args: unknown[]) => { bound.push(args) }, threadClosed: (...args: unknown[]) => { closed.push(args) } },
    triggers: { get: () => undefined, latest: () => undefined }, notify: () => {}, report: () => {} } as unknown as SourceContext
  return { ctx, received, bound, closed, calls, state }
}

describe('GitLab Source', () => {
  it('polls Issues and notes once, then advances its cursor', async () => {
    const h = harness(path => path.includes('/issues?') ? [issue] : path.includes('/issues/12/notes') ? [note] : path.includes('/merge_requests?') ? [] : [])
    expect(await pollRound(h.ctx)).toBe(60)
    expect(h.received.map(item => (item as { meta: { kind: string } }).meta.kind)).toEqual(['issue', 'issue'])
    expect(h.state.get(KV.gitlab.since)).not.toBe('2026-01-01T00:00:00Z')
    expect(await pollRound(h.ctx)).toBe(60)
    expect(h.received).toHaveLength(2)
  })
  it('posts a note once and detects its marker', async () => {
    const message = { id: 'reply-1', channel: { source: 'gitlab', thread: 'gitlab:issue:12', address: { kind: 'issue', number: '12' } },
      text: 'Done', kind: 'reply' as const }
    const first = harness(path => path.includes('/notes?') ? [] : '{}')
    expect(await sendGitlab(first.ctx, message)).toBe('sent')
    expect(first.calls).toContain('note')
    const second = harness(path => path.includes('/notes?') ? [{ ...note, body: `<!-- dsh-superagent:reply-1 -->` }] : '{}')
    expect(await sendGitlab(second.ctx, message)).toBe('sent')
    expect(second.calls).not.toContain('note')
  })
  it('observes a merged MR and binds an agent MR to its ticket', () => {
    const mr = { iid: 7, title: 'Fix', description: '', state: 'opened', web_url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/7',
      created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', author: { username: 'agent-bot' }, source_branch: 'agent/login' }
    const h = harness(() => [])
    const ticket = { id: 't1', origin: { triggerId: 'trigger-1' }, execution: { name: 'login' }, follows: [] }
    ;(h.ctx.tickets as unknown as { get: () => unknown; open: () => unknown[] }).get = () => ticket
    ;(h.ctx.tickets as unknown as { open: () => unknown[] }).open = () => [ticket]
    ;(h.ctx.triggers as unknown as { get: () => unknown }).get = () => undefined
    expect(claimMr(h.ctx, 't1', mr)).toBeUndefined()
    expect(h.bound).toHaveLength(1)
    observeMr(h.ctx, { ...mr, state: 'merged', merged_at: '2026-01-03T00:00:00Z' })
    const closed = h.closed[0] as [unknown, string]
    expect(closed[0]).toEqual({ source: 'gitlab', id: 'mr:7' })
    expect(closed[1]).toBe('merged')
  })
})
