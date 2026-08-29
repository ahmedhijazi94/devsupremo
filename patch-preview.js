const fs = require('fs');
let code = fs.readFileSync('src/app/(protected)/projects/[id]/page.tsx', 'utf8');

// 1. Add import
code = code.replace(
  "import { ScaffoldForm } from '@/components/projects/scaffold-form'",
  "import { ScaffoldForm } from '@/components/projects/scaffold-form'\nimport { PreviewPanel } from '@/components/projects/preview-panel'"
);

// 2. Render preview
const previewCode = `      {project.github_repo_full_name && project.supabase_project_ref && (
        <div className="mt-8">
          <div className="mb-4">
            <h2 className="text-xl font-semibold">Live Preview</h2>
            <p className="text-sm text-muted-foreground">O ambiente é recriado em tempo real via WebContainers conforme o Github recebe os commits.</p>
          </div>
          <PreviewPanel repoFullName={project.github_repo_full_name} />
        </div>
      )}`;

code = code.replace(
  "      {(!project.github_repo_full_name || !project.supabase_project_ref) && (",
  previewCode + "\n\n      {(!project.github_repo_full_name || !project.supabase_project_ref) && ("
);

fs.writeFileSync('src/app/(protected)/projects/[id]/page.tsx', code);
