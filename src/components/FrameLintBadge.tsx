import type { Frame } from '../../shared/types'
import { Badge } from './ui/badge'
import { Tooltip } from './ui/tooltip'
import { useT } from '../lib/i18n'

/** The frame's latest anti-slop verdict, next to its name: ✓ when clean,
 *  ⚠ n with the issue count. Nothing shows until a first lint ran. */
export function FrameLintBadge({ frame }: { frame: Frame }) {
  const t = useT()
  const lint = frame.lint
  if (!lint) return null
  const count = lint.issues.length
  const label = count === 0 ? t('lint.clean') : t('lint.issueCount', { count })
  const title = `${t('lint.badgeTitle')} · ${t('lint.scoreLabel', { score: lint.score })}`
  return (
    <Tooltip label={title} side="top" align="start">
      <Badge tone={count === 0 ? 'success' : 'banned'} className="shrink-0" aria-label={label}>
        {count === 0 ? '✓' : `⚠ ${count}`}
      </Badge>
    </Tooltip>
  )
}
