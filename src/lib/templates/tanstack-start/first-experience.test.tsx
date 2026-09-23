// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ts from 'typescript'
import { buildProjectFiles } from '../project-files'

const files = new Map(buildProjectFiles({ projectName: 'Meu espaço', description: 'Um lugar para começar.', stack: 'tanstack-start-vite' }).map(file => [file.path, file.content]))

/** Run the emitted components; only framework navigation, auth I/O and primitives are replaced. */
function emitted<T>(path: string, dependencies: Record<string, unknown>): T {
  const source = files.get(path)
  if (!source) throw new Error(`Missing generated component: ${path}`)
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports: Record<string, unknown> = {}
  new Function('exports', 'require', output)(exports, (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`)
    return dependencies[name]
  })
  return exports as T
}

const Button = ({ loading, disabled, ...props }: React.ComponentProps<'button'> & { loading?: boolean }) => <button {...props} disabled={disabled || loading} />
const Link = ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => <a href={to} className={className}>{children}</a>
const SiteFrame = ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => <main>{actions}{children}</main>
const Icon = () => <span />
const primitives: Record<string, unknown> = {
  react: React, 'react/jsx-runtime': jsxRuntime,
  '@/components/ui/button': { Button, buttonClass: () => '' },
  '@/components/ui/input': { Input: (props: React.ComponentProps<'input'>) => <input {...props} />, Label: (props: React.ComponentProps<'label'>) => <label {...props} /> },
  '@/components/site-frame': { SiteFrame },
  'lucide-react': { ArrowLeft: Icon, Compass: Icon, LoaderCircle: Icon, RotateCcw: Icon, LogOut: Icon, Mail: Icon, UserRound: Icon },
}
type AuthResult = { data: { session: object | null }; error: { message: string } | null }
type LoginMode = 'login' | 'signup'
type LoginProps = { mode?: LoginMode; onModeChange?: (mode: LoginMode) => void }

function loginFixture() {
  const auth = {
    signInWithPassword: vi.fn(async (): Promise<AuthResult> => ({ data: { session: {} }, error: null })),
    signUp: vi.fn(async (): Promise<AuthResult> => ({ data: { session: null }, error: null })),
  }
  const router = { navigate: vi.fn(), invalidate: vi.fn(async () => undefined) }
  const { LoginForm } = emitted<{ LoginForm: React.ComponentType<LoginProps> }>('src/features/auth/login-form.tsx', {
    ...primitives,
    '@tanstack/react-router': { useRouter: () => router },
    '@/lib/supabase/client': { createClient: () => ({ auth }) },
  })
  return { auth, router, LoginForm }
}

function fillCredentials() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@example.invalid' } })
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'synthetic-password' } })
}

afterEach(cleanup)

describe('Start first access', () => {
  it('accepts only the signup mode from the URL and drops unrelated input', () => {
    const { Route } = emitted<{ Route: { validateSearch: (value: Record<string, unknown>) => { mode?: LoginMode } } }>('src/routes/login.tsx', {
      ...primitives,
      '@tanstack/react-router': { createFileRoute: () => (options: unknown) => options, Link },
      '@/features/auth/login-form': { LoginForm: () => null },
    })
    expect(Route.validateSearch({ mode: 'signup', next: 'https://outside.invalid', error: 'private detail' })).toEqual({ mode: 'signup' })
    for (const mode of [undefined, 'login', 'other', ['signup'], { mode: 'signup' }]) expect(Route.validateSearch({ mode })).toEqual({})
  })

  it('keeps typed credentials when the URL changes between signup and login', () => {
    const fixture = loginFixture()
    const onModeChange = vi.fn()
    const { rerender } = render(<fixture.LoginForm mode="signup" onModeChange={onModeChange} />)
    fillCredentials()
    expect(screen.getByLabelText('Senha').getAttribute('autocomplete')).toBe('new-password')
    fireEvent.click(screen.getByRole('button', { name: 'Já tenho uma conta' }))
    expect(onModeChange).toHaveBeenCalledWith('login')
    rerender(<fixture.LoginForm mode="login" onModeChange={onModeChange} />)
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('ana@example.invalid')
    expect((screen.getByLabelText('Senha') as HTMLInputElement).value).toBe('synthetic-password')
    expect(screen.getByLabelText('Senha').getAttribute('autocomplete')).toBe('current-password')
    expect(fixture.auth.signInWithPassword).not.toHaveBeenCalled()
    expect(fixture.auth.signUp).not.toHaveBeenCalled()
  })

  it('keeps signup confirmation on the form and preserves the existing callback', async () => {
    const fixture = loginFixture()
    render(<fixture.LoginForm mode="signup" />)
    fillCredentials()
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
    await screen.findByRole('status')
    expect(fixture.auth.signUp).toHaveBeenCalledWith({ email: 'ana@example.invalid', password: 'synthetic-password', options: { emailRedirectTo: `${window.location.origin}/auth/callback` } })
    expect(fixture.router.navigate).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('ana@example.invalid')
  })

  it('prevents duplicate submissions and mode changes while pending, then allows retry', async () => {
    const fixture = loginFixture()
    let reject: (reason: Error) => void = () => { throw new Error('Request has not started') }
    fixture.auth.signInWithPassword.mockImplementationOnce(() => new Promise<AuthResult>((_resolve, rejectRequest) => { reject = rejectRequest }))
    render(<fixture.LoginForm />)
    fillCredentials()
    const form = screen.getByRole('button', { name: 'Entrar' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(fixture.auth.signInWithPassword).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Criar uma conta' }) as HTMLButtonElement).disabled).toBe(true)
    reject(new Error('private network detail'))
    await screen.findByRole('status')
    expect(screen.queryByText(/private network detail/)).toBeNull()
    expect((screen.getByLabelText('Senha') as HTMLInputElement).value).toBe('synthetic-password')
    fireEvent.submit(form)
    await waitFor(() => expect(fixture.router.navigate).toHaveBeenCalledWith({ to: '/app' }))
    expect(fixture.router.invalidate).toHaveBeenCalledOnce()
  })

  it('retains the server identity gate and POST signout in the private page', async () => {
    const getCurrentUser = vi.fn(async (): Promise<{ email: string } | null> => null)
    const redirect = vi.fn((value: { to: string }) => new Error(value.to))
    const { Route } = emitted<{ Route: { loader: () => Promise<{ user: { email: string } }>; component: React.ComponentType } }>('src/routes/app.tsx', {
      ...primitives,
      '@tanstack/react-router': { redirect, createFileRoute: () => (options: object) => ({ ...options, useLoaderData: () => ({ user: { email: 'ana@example.invalid' } }) }) },
      '@/features/auth/auth.functions': { getCurrentUser },
      '@/features/profile/profile-form': { ProfileForm: () => <form aria-label="Perfil" /> },
      '@/components/ui/card': { Card: (props: React.ComponentProps<'div'>) => <div {...props} />, CardTitle: (props: React.ComponentProps<'h2'>) => <h2 {...props} />, CardDescription: (props: React.ComponentProps<'p'>) => <p {...props} /> },
    })
    await expect(Route.loader()).rejects.toThrow('/login')
    getCurrentUser.mockResolvedValue({ email: 'ana@example.invalid' })
    await expect(Route.loader()).resolves.toEqual({ user: { email: 'ana@example.invalid' } })
    render(<Route.component />)
    const form = screen.getByRole('button', { name: 'Sair' }).closest('form')!
    expect(form.getAttribute('action')).toBe('/auth/signout')
    expect(form.getAttribute('method')).toBe('post')
  })
})

describe('Start recovery states', () => {
  it('retries route data before resetting and recovers from a failed retry without exposing details', async () => {
    const invalidate = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('private backend detail'))
    const reset = vi.fn()
    const { RouteError, RoutePending, RouteNotFound } = emitted<{ RouteError: React.ComponentType<{ reset: () => void }>; RoutePending: React.ComponentType; RouteNotFound: React.ComponentType }>('src/components/route-state.tsx', {
      ...primitives, '@tanstack/react-router': { Link, useRouter: () => ({ invalidate }) },
    })
    const { unmount } = render(<RouteError reset={reset} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    await screen.findByRole('alert')
    expect(reset).not.toHaveBeenCalled()
    expect(screen.queryByText(/private backend detail/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    await waitFor(() => expect(reset).toHaveBeenCalledOnce())
    expect(invalidate).toHaveBeenCalledTimes(2)
    unmount()
    const pending = render(<RoutePending />)
    expect(screen.getByRole('status')).toBeTruthy()
    pending.unmount()
    render(<RouteNotFound />)
    expect(screen.getByRole('link', { name: 'Voltar ao início' }).getAttribute('href')).toBe('/')
  })
})
