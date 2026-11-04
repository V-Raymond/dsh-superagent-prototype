/** GitLab Source: project polling, Issue/Merge Request notes, pipelines, and the pull adapter. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitlabProjectSchema } from '../deployment.ts'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { pause } from './poll.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { gitlabPull, observeMr } from './gitlab-mr.ts'
import { gitlabProject, gitlabThreadContext, readMergeRequest } from './gitlab-read.ts'
import { IssueSchema, MergeRequestSchema, NoteSchema, PipelineSchema, SOURCE, gitlabChannel, gitlabPage, gitlabThread,
  issueTrigger, mrTrigger, noteTrigger, pipelineTrigger } from './gitlab-trigger.ts'

const OBSERVED = { issues: 'observeIssues', mergeRequests: 'observeMergeRequests', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
export const GitlabConfigSchema = GitlabProjectSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observeMergeRequests: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return 'ci'
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'mergeRequests'
  return typeof meta.noteId === 'number' ? 'comments' : undefined
}
const note = (observed: boolean | undefined): Localized => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
const row = (id: Scope, label: Localized, config: Partial<GitlabConfig>) => ({ id, label, note: note(config[OBSERVED[id]]),
  cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收项目里发给它的 Issue、Merge Request、评论和流水线状态变化。', en: 'The agent\'s GitLab account; receives Issues, Merge Requests, notes, and pipeline changes in the project.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', label: { zh: 'GitLab 实例', en: 'GitLab host' },
      hint: { zh: '例如 https://gitlab.example.com；自建实例写完整 origin。', en: 'For example https://gitlab.example.com; write the full origin for a self-hosted instance.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\-]+(/[A-Za-z0-9_.\-]+)+', label: { zh: '监听的 project', en: 'Project' },
      hint: { zh: '写作 group/subgroup/project。', en: 'Written group/subgroup/project.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '通常是用 login 登录智能体账号的 glab 包装脚本；保存时检查账号和推送权限。', en: 'Usually a glab wrapper signed in to the agent account; saving checks the account and push access.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败多少次后报错', en: 'Failures before an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收新 Issue', en: 'Receive new Issues' }, hint: { zh: '打开后，未 @ 智能体的新 Issue 也接收，由接收表决定是否成为候选。', en: 'Also receive new Issues that do not mention the agent; the admission table decides whether they become candidates.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收新 MR', en: 'Receive new Merge Requests' }, hint: { zh: '打开后，未 @ 智能体的新 MR 也接收。', en: 'Also receive new Merge Requests that do not mention the agent.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收评论', en: 'Receive comments' }, hint: { zh: '打开后，未 @ 智能体的评论也接收。', en: 'Also receive comments that do not mention the agent.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收流水线状态', en: 'Receive pipeline status' }, hint: { zh: '打开后，失败的流水线会作为候选。', en: 'Failed pipelines become candidates.' } },
  ],
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    host: deployment.gitlab.host, project: deployment.gitlab.project, cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
  health: ['gitlab'],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return row ? { listened: true, observed: config[OBSERVED[row]], row } : { listened: true, observed: false }
  },
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  pull: gitlabPull,
  find: query => {
    const number = (/^#?(\d+)$/.exec(query.trim()) ?? /gitlab[^ ]*\/-(?:issues|merge_requests)\/(\d+)/.exec(query))?.[1]
    return { threads: number ? [`${SOURCE}:issue:${number}`, `${SOURCE}:mr:${number}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.-]+' }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.-]+' }] },
    ],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows: stored => {
      const config = GitlabConfigSchema.partial().parse(stored)
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }, config), row('mergeRequests', { zh: '新 MR', en: 'New Merge Requests' }, config),
        row('comments', { zh: '评论', en: 'Comments' }, config),
        { id: 'ci', label: { zh: '流水线', en: 'Pipelines' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 实例 origin', en: 'GitLab host origin' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的 project', en: 'The project this Source watches' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录', en: 'The agent\'s GitLab account; glab is signed in to it' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱', en: 'Commit email of the agent account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NUMBER', description: { zh: '接下工单的 Issue 或 MR 编号', en: 'Number of the Issue or Merge Request that started the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: 'MR 的 head ref refs/merge-requests/<编号>/head；不是 MR 时为空', en: 'Head ref refs/merge-requests/<number>/head of the MR; empty when it was not an MR' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitlab = deployment.gitlab
      const number = trigger && (trigger.meta.kind === 'issue' || trigger.meta.kind === 'mr') ? Number(trigger.meta.number) || 0 : 0
      return { DSH_SUPERAGENT_GITLAB_HOST: gitlab?.host ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: gitlab?.project ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.noreply ?? '',
        DSH_SUPERAGENT_GITLAB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: number && trigger?.meta.kind === 'mr' ? `refs/merge-requests/${number}/head` : '' }
    },
  },
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
const failure = (failures: number, threshold: number, error: unknown): Health | undefined =>
  failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  if (!ctx.deployment.gitlab) { ctx.report('gitlab', health('paused', 'sourceOff')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = failure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
/** Polls Issues, Merge Requests, their notes, and failed pipelines updated since the last round. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const gitlab = ctx.deployment.gitlab
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!gitlab || !config) return 60
  const started = new Date().toISOString()
  const since = ctx.state.get(KV.gitlab.since)
  if (!since) { ctx.state.set(KV.gitlab.since, started); return config.pollSeconds }
  const commands = ctx.commands.withSignal(signal)
  const base = `projects/${encodeURIComponent(gitlab.project)}`
  const suffix = `?updated_after=${encodeURIComponent(since)}&per_page=100`
  const issues = z.array(IssueSchema).parse(JSON.parse(await commands.run(gitlab.cli, ['api', `${base}/issues${suffix}&state=all`])))
  for (const issue of issues) {
    if (Date.parse(issue.created_at) > Date.parse(since)) await ctx.receive(issueTrigger(issue, gitlab.login, gitlab.host, gitlab.project))
    const notes = z.array(NoteSchema).parse(JSON.parse(await commands.run(gitlab.cli, ['api', `${base}/issues/${issue.iid}/notes?per_page=100&sort=asc`])))
    for (const item of notes) {
      const at = item.updated_at ?? item.created_at
      if (Date.parse(at) <= Date.parse(since)) continue
      const trigger = noteTrigger(item, 'issue', issue.iid, gitlab.login, gitlab.host, gitlab.project)
      if (trigger) await ctx.receive(trigger)
    }
  }
  const mrs = z.array(MergeRequestSchema).parse(JSON.parse(await commands.run(gitlab.cli, ['api', `${base}/merge_requests${suffix}&state=all`])))
  for (const mr of mrs) {
    observeMr(ctx, mr)
    if (Date.parse(mr.created_at) > Date.parse(since)) await ctx.receive(mrTrigger(mr, gitlab.login, gitlab.host, gitlab.project))
    const notes = z.array(NoteSchema).parse(JSON.parse(await commands.run(gitlab.cli, ['api', `${base}/merge_requests/${mr.iid}/notes?per_page=100&sort=asc`])))
    for (const item of notes) {
      const at = item.updated_at ?? item.created_at
      if (Date.parse(at) <= Date.parse(since)) continue
      const trigger = noteTrigger(item, 'mr', mr.iid, gitlab.login, gitlab.host, gitlab.project)
      if (trigger) await ctx.receive(trigger)
    }
  }
  if (config.observeCi) {
    const pipelines = z.array(PipelineSchema).parse(JSON.parse(await commands.run(gitlab.cli, ['api', `${base}/pipelines${suffix}`])))
    for (const pipe of pipelines) {
      if (pipe.status !== 'failed') continue
      const summary = `GitLab pipeline #${pipe.id} on ${pipe.ref} failed.`
      await ctx.receive(pipelineTrigger(pipe, 0, summary, pipe.web_url ?? `${gitlab.host}/${gitlab.project}/-/pipelines/${pipe.id}`))
    }
  }
  ctx.state.set(KV.gitlab.since, started)
  return config.pollSeconds
}
