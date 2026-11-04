/** Normalizes GitLab Issues, Merge Requests, notes, and pipelines into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
export type GitlabKind = 'issue' | 'mr'
export const gitlabThread = (kind: GitlabKind, iid: number): string => `${SOURCE}:${kind}:${iid}`
export const gitlabChannel = (kind: GitlabKind, iid: number): ChannelRef =>
  ({ source: SOURCE, thread: gitlabThread(kind, iid), address: { kind, number: String(iid) } })
export const gitlabPage = (host: string, project: string, kind: GitlabKind, iid: number): string =>
  `${host}/${project}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}`
export const GitlabUser = z.looseObject({ username: z.string(), name: z.string().nullish(), bot: z.boolean().nullish() })
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), created_at: z.string(), updated_at: z.string().nullish(), system: z.boolean().nullish(),
  author: GitlabUser, noteable_iid: z.number().nullish(), noteable_type: z.string().nullish(),
})
export const IssueSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(), web_url: z.string(),
  created_at: z.string(), updated_at: z.string(), author: GitlabUser,
})
export const MergeRequestSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(), web_url: z.string(),
  created_at: z.string(), updated_at: z.string(), author: GitlabUser,
  source_branch: z.string(), target_branch: z.string().nullish(), sha: z.string().nullish(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), merge_status: z.string().nullish(),
})
export const PipelineSchema = z.looseObject({
  id: z.number(), status: z.string(), ref: z.string(), sha: z.string().nullish(), web_url: z.string().nullish(), updated_at: z.string().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
export type GitlabIssue = z.infer<typeof IssueSchema>
export type GitlabMr = z.infer<typeof MergeRequestSchema>
export type GitlabPipeline = z.infer<typeof PipelineSchema>
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: z.infer<typeof GitlabUser>, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: !user.bot && !sameName(user.username, agent) })
/** A GitLab note is a comment on an Issue or Merge Request; system notes carry state changes, not a person's words. */
export function noteTrigger(note: GitlabNote, kind: GitlabKind, iid: number, agent: string, host: string, project: string): Trigger | undefined {
  if (note.system) return undefined
  const body = note.body ?? ''
  if (!body.trim()) return undefined
  const at = note.updated_at ?? note.created_at
  return { id: key('gitlab-note', String(note.id), at), source: SOURCE, threads: [{ source: SOURCE, id: `${kind}:${iid}` }],
    ...author(note.author, agent), at, text: body,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(kind, iid), url: `${host}/${project}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}#note_${note.id}`,
    meta: { kind, number: iid, isPr: kind === 'mr', noteId: note.id } }
}
export function issueTrigger(issue: GitlabIssue, agent: string, host: string, project: string): Trigger {
  const body = issue.description ?? ''
  return { id: key('gitlab-issue', String(issue.iid)), source: SOURCE, threads: [{ source: SOURCE, id: `issue:${issue.iid}` }],
    ...author(issue.author, agent), at: issue.created_at, text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel('issue', issue.iid), url: gitlabPage(host, project, 'issue', issue.iid),
    meta: { kind: 'issue', number: issue.iid, isPr: false } }
}
export function mrTrigger(mr: GitlabMr, agent: string, host: string, project: string): Trigger {
  const body = mr.description ?? ''
  return { id: key('gitlab-mr', String(mr.iid)), source: SOURCE, threads: [{ source: SOURCE, id: `mr:${mr.iid}` }],
    ...author(mr.author, agent), at: mr.created_at, text: `${mr.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel('mr', mr.iid), url: gitlabPage(host, project, 'mr', mr.iid),
    meta: { kind: 'mr', number: mr.iid, isPr: true, prAuthor: mr.author.username, sourceBranch: mr.source_branch } }
}
export function pipelineTrigger(pipe: GitlabPipeline, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-ci', String(pipe.id), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: `ci:${pipe.ref}` }],
    actor: { source: SOURCE, id: '' }, human: false, at: pipe.updated_at ?? new Date().toISOString(), text: summary, url,
    meta: { ci: true, kind: 'ci', branch: pipe.ref, sha: pipe.sha ?? '', revision } }
}
