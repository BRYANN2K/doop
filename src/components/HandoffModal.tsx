import { useEffect, useMemo, useRef, useState } from 'react'
import type { HandoffFile, HandoffPack, HandoffWriteResult } from '../../shared/handoff'
import { api, errorMessage } from '../lib/api'
import { t as translate, useT } from '../lib/i18n'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Segmented, SegmentedItem } from './ui/segmented'
import { Badge } from './ui/badge'

/* The "Ready for dev → Stip" preview: the server drafted a Stip change pack;
   here the requester reads it, edits proposal/spec/tasks, then sends it to
   the linked project. Nothing reaches the repo until the desktop app's own
   native dialog confirms the file list — writing is the exception, and the
   pack's create-new rule means an existing change folder simply refuses. */

type Tab = 'spec' | 'proposal' | 'tasks'

export function HandoffModal({
  canvasId,
  input,
  onClose,
}: {
  canvasId: string
  input: { frameIds?: string[]; planMessageId?: string; title?: string }
  onClose: () => void
}) {
  const t = useT()
  const [pack, setPack] = useState<HandoffPack | null>(null)
  const [linkName, setLinkName] = useState<string | null>(null)
  const [writable, setWritable] = useState(false)
  const [tab, setTab] = useState<Tab>('spec')
  const [proposal, setProposal] = useState('')
  const [spec, setSpec] = useState('')
  const [tasks, setTasks] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<HandoffWriteResult | null>(null)

  /* the modal is a one-shot: it builds once on mount — input is an inline
     literal at every call site, so only the canvas id may sit in deps */
  const inputRef = useRef(input)
  useEffect(() => {
    let live = true
    api
      .buildHandoff(canvasId, inputRef.current)
      .then((res) => {
        if (!live) return
        setPack(res.pack)
        setLinkName(res.link?.name ?? null)
        setWritable(res.writable)
        setProposal(res.pack.proposal)
        setSpec(res.pack.spec)
        setTasks(res.pack.tasks)
      })
      .catch((e) => live && setError(errorMessage(e, translate('handoff.buildFailed'))))
    return () => {
      live = false
    }
  }, [canvasId])

  /* the edited docs rejoin the pack's file list at write time */
  const files = useMemo<HandoffFile[]>(
    () =>
      (pack?.files ?? []).map((f) => {
        if (f.path.endsWith('/proposal.md')) return { ...f, text: proposal }
        if (f.path.endsWith('/spec.md')) return { ...f, text: spec }
        if (f.path.endsWith('/tasks.md')) return { ...f, text: tasks }
        return f
      }),
    [pack, proposal, spec, tasks],
  )

  const acCount = useMemo(() => (spec.match(/^- AC-\d+:/gm) ?? []).length, [spec])

  async function write() {
    if (!pack || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.writeHandoff(canvasId, pack.changeId, files)
      setDone(res.result)
    } catch (e) {
      setError(errorMessage(e, t('handoff.writeFailed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal size="xl" onClose={onClose} aria-label={t('handoff.title')}>
      <ModalEyebrow>{t('handoff.eyebrow')}</ModalEyebrow>
      <ModalTitle>{t('handoff.title')}</ModalTitle>
      {!pack && !error && <ModalLede className="mt-4">{t('handoff.building')}</ModalLede>}
      {error && !pack && <p className="mt-4 text-copy text-accent-ink">{error}</p>}
      {pack && !done && (
        <>
          <ModalLede>
            {t('handoff.lede', { dir: pack.dir, count: files.length })}
            {linkName && ` ${t('handoff.ledeRepo', { repo: linkName })}`}
          </ModalLede>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Segmented value={tab} onValueChange={(v) => setTab(v as Tab)}>
              <SegmentedItem value="spec">{t('handoff.tabSpec')}</SegmentedItem>
              <SegmentedItem value="proposal">{t('handoff.tabProposal')}</SegmentedItem>
              <SegmentedItem value="tasks">{t('handoff.tabTasks')}</SegmentedItem>
            </Segmented>
            <Badge tone={pack.draftedBy === 'agent' ? 'brand' : 'outline'}>
              {pack.draftedBy === 'agent'
                ? t('handoff.draftedByAgent', { model: pack.modelLabel ?? '' })
                : t('handoff.draftedByTemplate')}
            </Badge>
            {tab === 'spec' && acCount === 0 && (
              <span className="text-caption text-accent-ink">{t('handoff.specNeedsAc')}</span>
            )}
          </div>
          <Textarea
            variant="code"
            className="mt-2 h-[300px] w-full"
            spellCheck={false}
            aria-label={t(`handoff.tab${tab === 'spec' ? 'Spec' : tab === 'proposal' ? 'Proposal' : 'Tasks'}`)}
            value={tab === 'spec' ? spec : tab === 'proposal' ? proposal : tasks}
            onChange={(e) =>
              tab === 'spec'
                ? setSpec(e.target.value)
                : tab === 'proposal'
                  ? setProposal(e.target.value)
                  : setTasks(e.target.value)
            }
          />
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-micro text-ink-faint">
            {files.map((f) => (
              <span key={f.path} className="truncate" title={f.path}>
                {f.path.replace(`${pack.dir}/`, '')}
              </span>
            ))}
          </div>
          {pack.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-caption text-ink-faint">
              {pack.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {error && <p className="mt-2 text-caption text-accent-ink">{error}</p>}
          <ModalActions>
            <Button variant="bare" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !writable || acCount === 0}
              title={writable ? t('handoff.writeTitle') : t('handoff.notWritable')}
              onClick={() => void write()}
            >
              {busy ? t('handoff.writing') : t('handoff.write')}
            </Button>
          </ModalActions>
          {!writable && <p className="mt-2 text-caption text-ink-faint">{t('handoff.notWritableHint')}</p>}
        </>
      )}
      {done && (
        <>
          <ModalLede className="mt-4">{t('handoff.done', { dir: done.dir, repo: done.repo })}</ModalLede>
          <ul className="mt-2 max-h-[240px] space-y-0.5 overflow-y-auto text-micro text-ink-faint">
            {done.written.map((p) => (
              <li key={p} className="truncate">
                {p}
              </li>
            ))}
          </ul>
          <ModalActions>
            <Button variant="primary" onClick={onClose}>
              {t('common.close')}
            </Button>
          </ModalActions>
        </>
      )}
    </Modal>
  )
}
