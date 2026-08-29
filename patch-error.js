const fs = require('fs');
let code = fs.readFileSync('src/app/sandbox/page.tsx', 'utf8');

// Do not return a different div on error. Just keep the same UI and show the error in the terminal.
code = code.replace(
  `  if (error) return (
    <div className="flex flex-col h-screen bg-red-50 text-red-600 p-8 font-mono text-sm">
      <h3 className="font-bold text-lg mb-2">Erro Crítico no Motor</h3>
      <p>{error}</p>
      <div ref={terminalRef} className="mt-4 flex-1 bg-black rounded-lg overflow-hidden p-2" />
    </div>
  )`,
  ""
);

code = code.replace(
  `{!url && (
        <div className="flex flex-col flex-1 items-center justify-center bg-zinc-950 text-white font-mono text-sm">
          <div className="animate-pulse mb-4 text-emerald-400">⚡ {status}</div>
          <div className="w-full max-w-2xl h-64 bg-black rounded-xl border border-zinc-800 overflow-hidden p-2" ref={terminalRef} />
        </div>
      )}`,
  `{!url && (
        <div className="flex flex-col flex-1 items-center justify-center bg-zinc-950 text-white font-mono text-sm">
          {error ? (
            <div className="mb-4 text-red-400 font-bold">❌ {error}</div>
          ) : (
            <div className="animate-pulse mb-4 text-emerald-400">⚡ {status}</div>
          )}
          <div className="w-full max-w-4xl h-96 bg-black rounded-xl border border-zinc-800 overflow-hidden p-2" ref={terminalRef} />
        </div>
      )}`
);

fs.writeFileSync('src/app/sandbox/page.tsx', code);
