const fs = require('fs');
let code = fs.readFileSync('src/components/projects/preview-panel.tsx', 'utf8');

// We need to pass projectId to PreviewPanel. Let's add it to the props.
code = code.replace(
  "interface PreviewPanelProps {\n  repoFullName: string\n}",
  "interface PreviewPanelProps {\n  repoFullName: string\n  projectId: string\n}"
);

code = code.replace(
  "export function PreviewPanel({ repoFullName }: PreviewPanelProps) {",
  "export function PreviewPanel({ repoFullName, projectId }: PreviewPanelProps) {"
);

// Update URLs
code = code.replace(
  "const previewUrl = `https://stackblitz.com/github/${repoFullName}?embed=1&view=preview&hideExplorer=1&hideNavigation=1`\n  const editorUrl = `https://stackblitz.com/github/${repoFullName}?embed=1&view=editor`",
  "const previewUrl = `/sandbox?projectId=${projectId}`\n  const editorUrl = `https://github.com/${repoFullName}`"
);

fs.writeFileSync('src/components/projects/preview-panel.tsx', code);
