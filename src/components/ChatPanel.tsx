import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatMessage, ChatPlan, ChatPlanScreen } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { MAX_CHAT_TEXT_CHARS, chatThreadId, isOpenPlan } from '../../shared/chat'
import { canCommentOpenCanvas, canEditOpenCanvas, useStore } from '../lib/store'
import { api, errorMessage } from '../lib/api'
import { posthog } from '../lib/posthog'
import { timeAgo } from '../lib/time'
import { isComposingEnter } from '../lib/keys'
import { isResidentLimit } from './TeamAllowance'
import { refreshLocalRepo, useLocalRepo } from '../lib/localRepo'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { PanelBody } from './ui/panel'
import { Card } from './ui/card'
import { Badge } from './ui/badge'
import { Avatar } from './ui/avatar'
import { StatusLabel } from './ui/status-label'
import { Note } from './ui/note'
import { ArrowUpIcon, CheckIcon, FolderIcon } from './ui/icons'
import { useT } from '@/lib/i18n'

const emptyNote = 'px-4 py-6 text-center text-body text-ink-faint'
/** the field grows with the draft up to this many lines, then scrolls */
const MAX_COMPOSER_LINES = 6

/* feedback and plan launches are metered like any other resident task — a
   403 means the free tier ran out, so raise the connect wall */
function reportLimit(err: unknown) {
  if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
  else console.error(err)
}

/** Size the field to its draft, up to MAX_COMPOSER_LINES. */
function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  if (!ta.scrollHeight) return
  const line = parseFloat(getComputedStyle(ta).lineHeight) || 20
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(line * MAX_COMPOSER_LINES))}px`
}

/**
 * The canvas chat: where the room talks the next design over with the
 * resident agent before anything touches the canvas. A design ask comes back
 * as a plan card; only an editor's Go design turns it into board cards.
 */
export function ChatPanel({ canvasId }: { canvasId: string }) {
  const chat = useStore((s) => s.chat)
  const canComment = useStore(canCommentOpenCanvas)
  const t = useT()
  const bottomRef = useRef<HTMLDivElement>(null)
  /* thread views: a root and its replies, oldest thread first so the newest
     conversation is the one the scroll lands on */
  const threads = useMemo(() => {
    const byAt = [...chat].reverse()
    const roots = byAt.filter((m) => !m.threadId)
    return roots.map((root) => ({
      root,
      replies: byAt.filter((m) => m.threadId === chatThreadId(root)),
    }))
  }, [chat])

  /* follow the conversation while it grows at the bottom */
  const latestId = chat[0]?.id
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [threads.length, latestId])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LocalProjectChip canvasId={canvasId} />
      <PanelBody className="py-2">
        {threads.length === 0 ? (
          <div className={emptyNote}>{t('panels.chatEmpty')}</div>
        ) : (
          threads.map((thread) => <ChatThread key={thread.root.id} root={thread.root} replies={thread.replies} />)
        )}
        <div ref={bottomRef} />
      </PanelBody>
      {canComment && <ChatComposer canvasId={canvasId} />}
    </div>
  )
}

/** The linked local project, as the chip over the chat: while the asker's
 *  app is open, the agent reads it for the plans it writes here. */
function LocalProjectChip({ canvasId }: { canvasId: string }) {
  const status = useLocalRepo((s) => s.status[canvasId])
  const t = useT()
  useEffect(() => {
    void refreshLocalRepo(canvasId).catch(() => {})
  }, [canvasId])
  if (!status?.link) return null
  return (
    <div className="flex flex-none items-center gap-1.5 border-b border-line-soft px-3 py-1.5">
      <FolderIcon size="rail" className="flex-none text-ink-faint" />
      <b className="min-w-0 truncate text-label font-medium text-ink-soft">{status.link.name}</b>
      <StatusLabel tone={status.online ? 'done' : 'muted'} className="min-w-0 truncate">
        {status.online ? t('panels.chatRepoReading') : t('panels.localProjectOffline')}
      </StatusLabel>
    </div>
  )
}

/** One face: a person's initials on their colour, or the agent's mark. */
function ChatAvatar({ message }: { message: ChatMessage }) {
  return (
    <Avatar
      name={message.from}
      kind={message.agent ? 'agent' : 'user'}
      color={colorFor(message.from)}
      size={16}
      className="flex-none shadow-none dark:shadow-none"
    />
  )
}

/** A thread: its root line, the replies under it, then a reply field for
 *  anyone who may comment. The agent's plan cards live inside the thread. */
function ChatThread({ root, replies }: { root: ChatMessage; replies: ChatMessage[] }) {
  const canComment = useStore(canCommentOpenCanvas)
  return (
    <div className="mx-1.5 py-1">
      <ChatLine message={root} />
      {replies.map((reply) => (
        <div key={reply.id} className="pl-[22px]">
          <ChatLine message={reply} />
        </div>
      ))}
      {canComment && <ReplyField root={root} />}
    </div>
  )
}

/** One line of the conversation: who and when, then the text — or the plan
 *  card the line carries. An ask shows where it stands: queued, thinking,
 *  or failed with its reason and a Retry. */
function ChatLine({ message }: { message: ChatMessage }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const canEdit = useStore(canEditOpenCanvas)
  const t = useT()
  const asking = message.forAgent && !message.answeredAt && !message.failedAt
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-[2px] rounded-row px-1.5 py-1.5">
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <ChatAvatar message={message} />
        <b className="truncate text-body font-medium text-ink">{message.from}</b>
      </span>
      <span className="text-caption text-ink-faint tabular-nums">{timeAgo(message.at)}</span>
      <span className="col-span-2 min-w-0 break-words pl-[22px] whitespace-pre-wrap text-body text-ink-soft">
        {message.text}
      </span>
      {message.plan && (
        <div className="col-span-2 pl-[22px]">
          <PlanCard message={message} plan={message.plan} />
        </div>
      )}
      {asking && (
        <span className="col-span-2 pl-[22px] text-caption text-ink-faint">
          {message.claimedBy
            ? t('panels.chatThinking', { agent: message.claimedBy })
            : t('panels.chatQueued', { agent: message.targetAgent ?? '' })}
        </span>
      )}
      {message.failedAt && (
        <span className="col-span-2 flex min-w-0 items-start gap-2 pl-[22px]">
          <Note tone="error" className="line-clamp-3 min-w-0 break-words">
            {message.failureReason ?? t('panels.chatAskFailed')}
          </Note>
          {canEdit && canvasId && (
            <Button
              variant="danger-solid"
              size="pill"
              className="ml-auto flex-none"
              onClick={() => api.retryChatAsk(message.id).catch(reportLimit)}
            >
              {t('panels.chatRetry')}
            </Button>
          )}
        </span>
      )}
    </div>
  )
}

/** The reply field under a thread — sends a plain chat message in it. */
function ReplyField({ root }: { root: ChatMessage }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const t = useT()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

  async function reply() {
    const text = draft.trim()
    if (!text || sending || !canvasId) return
    setSending(true)
    setFailed(false)
    try {
      await api.sendChat(canvasId, { text, threadId: root.id })
      setDraft((current) => (current === draft ? '' : current))
    } catch (err) {
      setFailed(true)
      reportLimit(err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="py-1 pr-1.5 pl-[28px]">
      <Input
        variant="bare"
        inputSize="auto"
        className="h-7 min-w-0 flex-1 rounded-row bg-surface px-2.5 shadow-ring focus:shadow-elevation-1-focus"
        placeholder={t('panels.chatReplyPlaceholder')}
        aria-label={t('panels.chatReplyTo', { name: root.from })}
        value={draft}
        disabled={sending}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !isComposingEnter(e)) void reply()
        }}
      />
      {failed && (
        <Note tone="error" size="sm" className="mt-1">
          {t('panels.chatSendFailed')}
        </Note>
      )}
    </div>
  )
}

/* ---- the plan card ---- */

const STATUS_TONES: Record<ChatPlan['status'], 'outline' | 'brand' | 'success' | 'default'> = {
  proposed: 'outline',
  approved: 'brand',
  launched: 'success',
  revised: 'default',
  canceled: 'default',
}

/** A design plan the agent put in chat: what it is for, the screens it
 *  would make, the questions it still owes — and, for editors while it is
 *  open, the buttons that shape or launch it. Go design queues one board
 *  card per screen under the editor's name. */
function PlanCard({ message, plan }: { message: ChatMessage; plan: ChatPlan }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const canEdit = useStore(canEditOpenCanvas)
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [revising, setRevising] = useState(false)
  const [busy, setBusy] = useState(false)
  const open = isOpenPlan(plan)

  const act = (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    fn()
      .catch(reportLimit)
      .finally(() => setBusy(false))
  }

  return (
    <Card tone="flat" className="mt-1 mb-1.5 p-2 text-body">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-medium text-ink-soft">{t('panels.chatPlanTitle')}</span>
        <Badge tone={STATUS_TONES[plan.status]}>{t(`panels.chatPlanStatus_${plan.status}`)}</Badge>
      </div>
      {editing ? (
        <PlanEditor message={message} plan={plan} busy={busy} onDone={() => setEditing(false)} />
      ) : (
        <>
          <p className="mt-1 break-words whitespace-pre-wrap text-ink">{plan.summary}</p>
          <ul className="mt-1.5 space-y-1">
            {plan.screens.map((screen, i) => (
              <li key={i} className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="min-w-0 truncate font-medium text-ink">{screen.name}</span>
                  <span className="flex-none text-micro text-ink-faint tabular-nums">
                    {screen.width}×{screen.height}
                  </span>
                </div>
                <div className="line-clamp-2 break-words text-ink-soft">{screen.outline}</div>
                {screen.reuse && screen.reuse.length > 0 && (
                  <div className="truncate text-caption text-ink-faint" title={screen.reuse.join(', ')}>
                    {t('panels.chatPlanReuse', { items: screen.reuse.join(', ') })}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {plan.openQuestions && plan.openQuestions.length > 0 && (
            <div className="mt-1.5 border-t border-line-soft pt-1.5">
              <span className="text-caption font-medium text-ink-faint">{t('panels.chatPlanQuestions')}</span>
              <ul className="mt-0.5 space-y-0.5 text-ink-soft">
                {plan.openQuestions.map((q, i) => (
                  <li key={i} className="break-words">
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.status === 'launched' && (
            <div className="mt-1.5 flex items-center gap-1.5 border-t border-line-soft pt-1.5 text-caption text-ink-faint">
              <CheckIcon size="rail" className="flex-none" />
              <span className="min-w-0 truncate">
                {t('panels.chatPlanLaunched', {
                  count: plan.taskIds?.length ?? plan.screens.length,
                  name: plan.launchedBy ?? '',
                })}
              </span>
            </div>
          )}
          {open && canEdit && (
            <div className="mt-2 flex items-center gap-1 border-t border-line-soft pt-1.5">
              <Button
                variant="primary"
                size="pill"
                disabled={busy}
                title={t('panels.chatPlanLaunchTitle')}
                onClick={() =>
                  act(() => api.launchChatPlan(message.id).then(() => posthog.capture('chat_plan_launched')))
                }
              >
                {t('panels.chatPlanLaunch')}
              </Button>
              <Button variant="bare" size="pill" disabled={busy} onClick={() => setEditing(true)}>
                {t('panels.chatPlanEdit')}
              </Button>
              <Button
                variant="bare"
                size="pill"
                disabled={busy}
                title={t('panels.chatPlanReviseTitle')}
                onClick={() => setRevising((v) => !v)}
              >
                {t('panels.chatPlanRevise')}
              </Button>
              <Button
                variant="bare"
                size="pill"
                className="ml-auto text-ink-faint"
                disabled={busy}
                title={t('panels.chatPlanCancelTitle')}
                onClick={() => act(() => api.cancelChatPlan(message.id))}
              >
                {t('panels.chatPlanCancel')}
              </Button>
            </div>
          )}
          {open && revising && canEdit && canvasId && <ReviseField canvasId={canvasId} message={message} />}
        </>
      )}
    </Card>
  )
}

/** "Ask for changes": a line to the agent in the plan's own thread. The new
 *  plan it posts supersedes this one — that is what Revise means here. */
function ReviseField({ canvasId, message }: { canvasId: string; message: ChatMessage }) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setFailed(false)
    try {
      /* routed like the composer: the @mention turns it into an ask, the
         thread ties the next plan to this one */
      await api.sendChat(canvasId, { text: `@Doop ${text}`, threadId: message.id })
      setDraft('')
    } catch (err) {
      setFailed(true)
      reportLimit(err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mt-1.5">
      <Input
        variant="bare"
        inputSize="auto"
        className="h-7 w-full rounded-row bg-paper px-2.5 shadow-ring focus:shadow-elevation-1-focus"
        placeholder={t('panels.chatPlanRevisePlaceholder')}
        value={draft}
        disabled={sending}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !isComposingEnter(e)) void send()
        }}
      />
      {failed && (
        <Note tone="error" size="sm" className="mt-1">
          {t('panels.chatSendFailed')}
        </Note>
      )}
    </div>
  )
}

/** The editor's version of the plan: its summary, and each screen's name
 *  and outline. Saving marks it approved — a person shaped it. */
function PlanEditor({
  message,
  plan,
  busy,
  onDone,
}: {
  message: ChatMessage
  plan: ChatPlan
  busy: boolean
  onDone: () => void
}) {
  const t = useT()
  const [summary, setSummary] = useState(plan.summary)
  const [screens, setScreens] = useState<ChatPlanScreen[]>(plan.screens)

  const save = () => {
    const next = {
      summary: summary.trim(),
      screens,
      ...(plan.openQuestions ? { openQuestions: plan.openQuestions } : {}),
    }
    if (!next.summary || next.screens.length === 0) return
    api.editChatPlan(message.id, next).then(onDone).catch(reportLimit)
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <Textarea
        variant="well"
        rows={2}
        aria-label={t('panels.chatPlanEditSummary')}
        className="text-body"
        value={summary}
        disabled={busy}
        onChange={(e) => setSummary(e.target.value)}
      />
      {screens.map((screen, i) => (
        <div key={i} className="rounded-control bg-paper px-2 py-1 shadow-ring">
          <Input
            variant="bare"
            inputSize="auto"
            aria-label={t('panels.chatPlanEditScreenName')}
            className="h-6 w-full font-medium"
            value={screen.name}
            disabled={busy}
            onChange={(e) => setScreens((cur) => cur.map((s, j) => (j === i ? { ...s, name: e.target.value } : s)))}
          />
          <Textarea
            variant="bare"
            rows={2}
            aria-label={t('panels.chatPlanEditScreenOutline')}
            className="w-full text-ink-soft"
            value={screen.outline}
            disabled={busy}
            onChange={(e) => setScreens((cur) => cur.map((s, j) => (j === i ? { ...s, outline: e.target.value } : s)))}
          />
          <span className="text-micro text-ink-faint tabular-nums">
            {screen.width}×{screen.height}
          </span>
        </div>
      ))}
      <div className="flex items-center gap-1 pt-0.5">
        <Button variant="primary" size="pill" disabled={busy || !summary.trim()} onClick={save}>
          {t('panels.chatPlanSave')}
        </Button>
        <Button variant="bare" size="pill" disabled={busy} onClick={onDone}>
          {t('panels.chatPlanCancelEdit')}
        </Button>
      </div>
    </div>
  )
}

/** The composer docked under the conversation: a message to the room, or an
 *  @mention to the agent — same field, the server tells them apart. */
function ChatComposer({ canvasId }: { canvasId: string }) {
  const canEdit = useStore(canEditOpenCanvas)
  const t = useT()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    if (inputRef.current) autosize(inputRef.current)
  }, [text])

  async function submit() {
    const clean = text.trim()
    if (!clean || sending) return
    setSending(true)
    setError(null)
    try {
      await api.sendChat(canvasId, { text: clean })
      posthog.capture('chat_message_sent')
      setText('')
    } catch (err) {
      setError(errorMessage(err, t('panels.chatSendFailed')))
      reportLimit(err)
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <form
      className="flex shrink-0 flex-col gap-1.5 border-t border-line-soft bg-surface px-3 pt-2.5 pb-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Textarea
        ref={inputRef}
        variant="bare"
        rows={1}
        maxLength={MAX_CHAT_TEXT_CHARS}
        aria-label={t('panels.chatAria')}
        className="block overflow-y-auto px-0.5 text-body"
        value={text}
        disabled={sending}
        placeholder={canEdit ? t('panels.chatPlaceholderAgent') : t('panels.chatPlaceholder')}
        onKeyDown={onKeyDown}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-1">
        <span className="flex-1 text-caption text-ink-ghost">{canEdit && t('panels.chatMentionHint')}</span>
        <IconButton
          variant="primary"
          size="lg"
          shape="round"
          type="submit"
          aria-label={t('panels.chatSend')}
          disabled={sending || !text.trim()}
        >
          {sending ? <span aria-hidden>…</span> : <ArrowUpIcon />}
        </IconButton>
      </div>
      {error && (
        <Note tone="error" size="sm">
          {error}
        </Note>
      )}
    </form>
  )
}
