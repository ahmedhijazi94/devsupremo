export default function SandboxLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full m-0 p-0 overflow-hidden bg-white text-black">
        {children}
      </body>
    </html>
  )
}
