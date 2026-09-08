// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LiveGateBadge } from './live-gate-badge'

const mocks = vi.hoisted(() => ({ checks: vi.fn() }))
vi.mock('@/actions/checks', () => ({ getProjectChecks: mocks.checks }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('labels successful checks without claiming every integration protection passed', async () => {
  mocks.checks.mockResolvedValue({ data: { state: 'passed', summary: 'As verificações do GitHub foram aprovadas.' } })
  render(<LiveGateBadge projectId="project" />)
  expect(await screen.findByText('Testes aprovados')).toBeTruthy()
  expect(screen.queryByText('Tudo verde')).toBeNull()
  expect(screen.queryByText('Integrado')).toBeNull()
})

it('exposes a known integration block while keeping the CI result in its explanation', async () => {
  const summary = 'As verificações do GitHub foram aprovadas. A integração desta versão está bloqueada.'
  mocks.checks.mockResolvedValue({ data: { state: 'failed', badgeLabel: 'Integração bloqueada', summary } })
  render(<LiveGateBadge projectId="project" />)
  expect(await screen.findByText('Integração bloqueada')).toBeTruthy()
  expect(screen.getByTitle(summary)).toBeTruthy()
  expect(screen.queryByText('Testes aprovados')).toBeNull()
})
