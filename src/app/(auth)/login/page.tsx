import { LoginForm } from '@/components/auth/login-form'

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold">Supremo</h1>
          <p className="text-muted-foreground">Entre para gerenciar seus apps</p>
        </div>
        <LoginForm />
      </div>
    </main>
  )
}
