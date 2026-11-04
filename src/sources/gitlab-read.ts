/** GitLab REST reads through the agent's glab CLI: project paths, notes, Merge Requests, and pipelines. */
import type { Commands } from '../infra/commands.ts'
import type { Trigger } from '../core/index.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import { NoteSchema, type GitlabKind, type GitlabMr, type GitlabNote, MergeRequestSchema, IssueSchema } from './gitlab-trigger.ts'
import { z } from 'zod'

export function gitlabProject(commands: Commands): { host: string; project: string; cli: string; login: string } {
  const gitlab = commands.deployment.gitlab
  if (!gitlab) throw new Error('The GitLab Source is not configured')
  return gitlab
}
const basePath = (commands: Commands): string => `projects/${encodeURIComponent(gitlabProject(commands).project)}`
/** Calls one GitLab API path through the configured glab CLI and parses its JSON answer. */
export async function gitlabApi<T>(commands: Commands, schema: z.ZodType<T>, path: string): Promise<T> {
  const { cli } = gitlabProject(commands)
  return schema.parse(JSON.parse(await commands.run(cli, ['api', path])))
}
/** Reads a page of notes on an Issue or Merge Request, oldest first. */
export async function gitlabNotes(commands: Commands, kind: GitlabKind, iid: number): Promise<GitlabNote[]> {
  const path = `${basePath(commands)}/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}/notes?per_page=100&sort=asc&order_by=created_at`
  return gitlabApi(commands, z.array(NoteSchema), path)
}
export async function readIssue(commands: Commands, iid: number) {
  return gitlabApi(commands, IssueSchema, `${basePath(commands)}/issues/${iid}`)
}
export async function readMergeRequest(commands: Commands, iid: number): Promise<GitlabMr> {
  return gitlabApi(commands, MergeRequestSchema, `${basePath(commands)}/merge_requests/${iid}`)
}
/** Thread context for an Issue or Merge Request: its notes, as messages, with the trigger's note at its place. */
export const gitlabThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => String(trigger.meta.noteId ?? ''),
  async read(commands, trigger, part, cursor): Promise<ContextPart> {
    const kind = trigger.meta.kind === 'mr' ? 'mr' : 'issue'
    const iid = Number(trigger.meta.number)
    if (!iid) throw new Error('GitLab thread has no Issue or Merge Request number')
    const notes = await gitlabNotes(commands, kind, iid)
    const messages: ContextMessage[] = notes.filter(note => !note.system).map<ContextMessage>(note => ({
      id: String(note.id), from: note.author.username, at: note.updated_at ?? note.created_at, text: note.body ?? '',
      ...(note.author.bot ? { bot: true as const } : {}),
    }))
    if (part === 'root') return { messages: messages.slice(0, 1), body: { page: 'root' } }
    if (part === 'parent') return { messages: messages.slice(-1), body: { page: 'parent' } }
    const start = cursor ? Math.max(0, messages.findIndex(message => message.id === cursor) + 1) : 0
    const page = messages.slice(start, start + 50)
    return { messages: page, body: { page: cursor ?? 'first', total: messages.length }, ...(start + 50 < messages.length ? { next: page.at(-1)?.id } : {}) }
  },
  images: text => [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].flatMap(match => match[1] ? [match[1]] : []),
}
