/** The anti-slop lint: the badge on the frame's name and the Quality
 *  section of the Inspector. */
export const lint = {
  badgeTitle: 'Anti-slop lint',
  clean: 'No lint issues',
  issueCount: { one: '{count} lint issue', other: '{count} lint issues' },
  scoreLabel: 'score {score}/100',
  groupQuality: 'Quality',
  noIssues: 'No lint issues — the design passes every check.',
  notLinted: 'Not linted yet — the check runs after each design change.',
  issueSeverityError: 'Error',
  issueSeverityWarning: 'Warning',
  pickIssueTitle: 'Select the element this issue is about',
  engineStatic: 'checked from HTML only (no rendered page)',
} as const
