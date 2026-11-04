/** GitLab issue/Merge Request notes as replies, idempotent by a hidden marker, plus link rendering. */
import type { ChannelLink, ChannelLinks } from './kind.ts'
import type { OutboundMessage } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { CliError } from '../infra/commands.ts'
import { gitlabProject } from './gitlab-read.ts'
import { NoteSchema } from './gitlab-trigger.ts'
import { z } from 'zod'

const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 403 || error.code === 404)
/** Sends a reply as a note on the Issue or Merge Request, skipping it when a note with this message's marker exists. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const gitlab = gitlabProject(host.commands)
  const kind = message.channel.address.kind === 'mr' ? 'merge_requests' : 'issues'
  const iid = Number(message.channel.address.number)
  if (!iid) throw new Error('Missing GitLab reply target')
  const path = `projects/${encodeURIComponent(gitlab.project)}/${kind}/${iid}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const notes = z.array(NoteSchema).parse(JSON.parse(await host.commands.run(gitlab.cli, ['api', `${path}?per_page=100&sort=desc`])))
    if (notes.some(note => (note.body ?? '').includes(marker))) return 'sent'
    // Use the glab subcommand the safe wrapper allows; a raw POST API call is outside its allowlist.
    const command = message.channel.address.kind === 'mr' ? 'mr' : 'issue'
    await host.commands.run(gitlab.cli, [command, 'note', String(iid), '-R', gitlab.project, '--message', `${message.text}\n\n${marker}`])
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** Builds a link to the Issue or Merge Request when the Source is configured, or an empty URL. */
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const kind = address.kind === 'mr' ? 'mr' : 'issue'
  const iid = address.number ?? ''
  const gitlab = links.gitlab
  const url = gitlab ? `${gitlab.host}/${gitlab.project}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}` : ''
  const label = kind === 'mr' ? { zh: `GitLab MR !${iid}`, en: `GitLab MR !${iid}` } : { zh: `GitLab Issue #${iid}`, en: `GitLab Issue #${iid}` }
  return { url, label }
}
