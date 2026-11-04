/** GitLab Merge Request binding and lifecycle: observe merged/closed only; never merge or approve. */
import { liveTicket, type Ticket } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import type { SourcePull } from './kind.ts'
import { gitlabThread, type GitlabMr } from './gitlab-trigger.ts'
import { gitlabProject, readMergeRequest } from './gitlab-read.ts'

/** The Merge Request number a ticket follows, if any. */
export function mrOf(ticket: Pick<Ticket, 'follows'>): number | undefined {
  for (const follow of ticket.follows ?? []) {
    const match = /^gitlab:mr:(\d+)$/.exec(follow.thread)
    if (match) return Number(match[1])
  }
  return undefined
}
const branchMatches = (ticket: Ticket, branch: string): boolean =>
  !!ticket.execution?.name && branch.split('/').at(-1) === ticket.execution.name
/** Binds an open Merge Request to a ticket when it is the ticket's origin MR or an agent MR on the ticket's branch. */
export function claimMr(ctx: SourceContext, ticketId: string, pull: unknown): string | undefined {
  const mr = pull as GitlabMr
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its Merge Request was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === 'gitlab' && source.meta.kind === 'mr' && source.meta.number === mr.iid
  const opened = mr.author.username === gitlabProject(ctx.commands).login && branchMatches(ticket, mr.source_branch)
  if (!started && !opened) return `Merge Request does not belong to this ticket: use the source MR or an MR by ${gitlabProject(ctx.commands).login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no MR exists`
  const owner = ctx.tickets.open().find(item => mrOf(item) === mr.iid)
  if (owner && owner.id !== ticketId) return 'Merge Request already belongs to another active ticket'
  const thread = { source: 'gitlab' as const, id: `mr:${mr.iid}` }
  const follow = ticket.follows?.find(item => item.thread === gitlabThread('mr', mr.iid))
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) {
    ctx.tickets.bindThread(ticketId, thread, opened)
    const gitlab = gitlabProject(ctx.commands)
    ctx.threads.describe(gitlabThread('mr', mr.iid), { label: `GitLab MR !${mr.iid}`, url: mr.web_url })
  }
  return undefined
}
/** Reconciles a polled Merge Request's open/merged/closed state with the tickets that follow it. */
export function observeMr(ctx: SourceContext, mr: GitlabMr): boolean {
  const merged = !!mr.merged_at || mr.state === 'merged'
  const ended = mr.state === 'closed' || mr.state === 'locked' || merged
  if (ended) {
    const outcome = merged ? 'merged' as const : 'closed' as const
    ctx.tickets.threadClosed({ source: 'gitlab', id: `mr:${mr.iid}` }, outcome, mr.closed_at ?? mr.merged_at ?? new Date().toISOString())
  }
  ctx.threads.describe(gitlabThread('mr', mr.iid), { label: `GitLab MR !${mr.iid}`, url: mr.web_url })
  return ended
}
/** Pull adapter registered on the GitLab Source kind. */
export const gitlabPull: SourcePull = {
  read: (ctx, number, signal) => readMergeRequest(ctx.commands.withSignal(signal), number),
  claim: (ctx, ticketId, pull) => claimMr(ctx, ticketId, pull),
  of: ticket => mrOf(ticket),
  endNotices: () => [],
}
