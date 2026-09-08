// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import ts from 'typescript'
import { buildProjectFiles } from './project-files'

const files = buildProjectFiles({ projectName: 'auth-fixture', description: '', kind: 'solo' })

/** Execute the generated implementation; mocks replace only its I/O and UI primitives. */
function generatedModule<T>(filePath: string, dependencies: Record<string, unknown>): T {
  const source = files.find((file) => file.path === filePath)?.content
  if (!source) throw new Error(`Generated auth file missing: ${filePath}`)
  const output = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports: Record<string, unknown> = {}
  new Function('exports', 'require', output)(exports, (name: string): unknown => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`)
    return dependencies[name]
  })
  return exports as T
}

type AuthResult = { data: { session: object | null }; error: { message: string } | null }
type LoginProps = { confirmationError?: boolean }
type LoginPageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> }

function loginFixture() {
  const auth = {
    signInWithPassword: vi.fn(async (): Promise<AuthResult> => ({ data: { session: {} }, error: null })),
    signUp: vi.fn(async (): Promise<AuthResult> => ({ data: { session: null }, error: null })),
  }
  const router = { push: vi.fn(), refresh: vi.fn() }
  const dependencies: Record<string, unknown> = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    'next/navigation': { useRouter: () => router },
    '@/lib/supabase/client': { createClient: () => ({ auth }) },
    '@/components/ui/button': { Button: (props: React.ComponentProps<'button'>) => React.createElement('button', props) },
    '@/components/ui/input': {
      Input: (props: React.ComponentProps<'input'>) => React.createElement('input', props),
      Label: (props: React.ComponentProps<'label'>) => React.createElement('label', props),
    },
    '@/components/ui/card': { Card: (props: React.ComponentProps<'div'>) => React.createElement('div', props) },
  }
  const { LoginForm } = generatedModule<{ LoginForm: React.ComponentType<LoginProps> }>('app/login/login-form.tsx', dependencies)
  const { default: LoginPage } = generatedModule<{ default: (props: LoginPageProps) => Promise<React.ReactElement> }>('app/login/page.tsx', {
    ...dependencies, './login-form': { LoginForm },
  })
  return { auth, router, LoginForm, LoginPage }
}

function fillCredentials() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.invalid' } })
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'synthetic-password' } })
}

afterEach(cleanup)

describe('generated login session flow', () => {
  it('keeps signup without a session on the form with confirmation guidance', async () => {
    const fixture = loginFixture()
    render(<fixture.LoginForm />)
    fillCredentials()
    fireEvent.click(screen.getByRole('button', { name: 'Não tem conta? Criar uma' }))
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
    expect((await screen.findByRole('status')).textContent).toContain('Confira seu email')
    expect(fixture.auth.signUp).toHaveBeenCalledWith({
      email: 'test@example.invalid', password: 'synthetic-password',
      options: { emailRedirectTo: `${location.origin}/auth/callback` },
    })
    expect(fixture.router.push).not.toHaveBeenCalled()
    expect(fixture.router.refresh).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('test@example.invalid')
    expect((screen.getByLabelText('Senha') as HTMLInputElement).value).toBe('synthetic-password')
    expect((screen.getByRole('button', { name: 'Criar conta' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Já tem conta? Entrar' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each(['signin', 'signup'] as const)('opens the app only after %s returns a session', async (mode) => {
    const fixture = loginFixture()
    fixture.auth.signUp.mockResolvedValue({ data: { session: {} }, error: null })
    render(<fixture.LoginForm />)
    fillCredentials()
    if (mode === 'signup') fireEvent.click(screen.getByRole('button', { name: 'Não tem conta? Criar uma' }))
    fireEvent.click(screen.getByRole('button', { name: mode === 'signup' ? 'Criar conta' : 'Entrar' }))
    await waitFor(() => expect(fixture.router.push).toHaveBeenCalledWith('/app'))
    expect(fixture.router.refresh).toHaveBeenCalledOnce()
  })

  it('never treats a login response without a session as authenticated', async () => {
    const fixture = loginFixture()
    fixture.auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: null })
    render(<fixture.LoginForm />)
    fillCredentials()
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    expect((await screen.findByRole('alert')).textContent).toContain('iniciar a sessão')
    expect(fixture.router.push).not.toHaveBeenCalled()
  })

  it('recovers from a network rejection and allows retry with the same credentials', async () => {
    const fixture = loginFixture()
    fixture.auth.signInWithPassword.mockRejectedValueOnce(new Error('internal network details'))
    render(<fixture.LoginForm />)
    fillCredentials()
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Tente novamente')
    expect(screen.queryByText(/internal network details/)).toBeNull()
    expect(fixture.router.push).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    await waitFor(() => expect(fixture.router.push).toHaveBeenCalledWith('/app'))
  })

  it('renders a fixed recovery message after a confirmation opened in another browser', async () => {
    const fixture = loginFixture()
    render(await fixture.LoginPage({ searchParams: Promise.resolve({ auth: 'confirmation-error', error_description: 'untrusted-token' }) }))
    expect(screen.getByRole('alert').textContent).toContain('entre com sua senha')
    expect(screen.getByRole('alert').textContent).toContain('navegador em que iniciou')
    expect(screen.queryByText(/untrusted-token/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Entrar' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each([undefined, 'untrusted-error', ['confirmation-error']])('does not interpret arbitrary query input as a confirmation error: %j', async (auth) => {
    const fixture = loginFixture()
    render(await fixture.LoginPage({ searchParams: Promise.resolve({ auth }) }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

function callbackFixture() {
  const exchange = vi.fn(async (): Promise<{ error: { message: string } | null }> => ({ error: null }))
  const createClient = vi.fn(async () => ({ auth: { exchangeCodeForSession: exchange } }))
  const { GET } = generatedModule<{ GET: (request: Request) => Promise<Response> }>('app/auth/callback/route.ts', {
    'next/server': { NextResponse }, zod: { z }, '@/lib/supabase/server': { createClient },
  })
  return { GET, exchange, createClient }
}

describe('generated auth callback', () => {
  it('opens the same-origin app after a successful code exchange', async () => {
    const fixture = callbackFixture()
    const response = await fixture.GET(new Request('http://localhost:3000/auth/callback?code=synthetic-code&next=https://external.invalid'))
    expect(fixture.exchange).toHaveBeenCalledWith('synthetic-code')
    expect(response.headers.get('location')).toBe('http://localhost:3000/app')
  })

  it.each(['', '?code=', '?error=access_denied&code=synthetic-code', `?code=${'x'.repeat(2049)}`])('rejects an invalid callback before any auth call: %.60s', async (query) => {
    const fixture = callbackFixture()
    const response = await fixture.GET(new Request(`http://localhost:3000/auth/callback${query}`))
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?auth=confirmation-error')
    expect(fixture.createClient).not.toHaveBeenCalled()
  })

  it.each(['expired-code', 'missing-pkce-verifier'])('returns to recoverable login for %s instead of implying a session exists', async (message) => {
    const fixture = callbackFixture()
    fixture.exchange.mockResolvedValue({ error: { message } })
    const response = await fixture.GET(new Request('http://localhost:3000/auth/callback?code=synthetic-code'))
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?auth=confirmation-error')
  })

  it.each(['exchange', 'client'] as const)('handles a thrown %s error without leaking details', async (source) => {
    const fixture = callbackFixture()
    if (source === 'exchange') fixture.exchange.mockRejectedValue(new Error('internal-details'))
    else fixture.createClient.mockRejectedValue(new Error('internal-details'))
    const response = await fixture.GET(new Request('http://localhost:3000/auth/callback?code=synthetic-code'))
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?auth=confirmation-error')
  })
})
