/** O lint anti-slop: o selo no nome do frame e a seção Qualidade do
 *  Inspector. */
export const lint = {
  badgeTitle: 'Lint anti-slop',
  clean: 'Sem problemas de lint',
  issueCount: { one: '{count} problema de lint', other: '{count} problemas de lint' },
  scoreLabel: 'nota {score}/100',
  groupQuality: 'Qualidade',
  noIssues: 'Sem problemas de lint — o design passa em todas as verificações.',
  notLinted: 'Ainda não verificado — a checagem roda após cada mudança no design.',
  issueSeverityError: 'Erro',
  issueSeverityWarning: 'Aviso',
  pickIssueTitle: 'Selecionar o elemento deste problema',
  engineStatic: 'verificado só pelo HTML (sem página renderizada)',
} as const
