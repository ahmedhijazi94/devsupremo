const fs = require('fs');
let code = fs.readFileSync('src/app/(protected)/projects/[id]/page.tsx', 'utf8');

code = code.replace(
  "<PreviewPanel repoFullName={project.github_repo_full_name} />",
  "<PreviewPanel repoFullName={project.github_repo_full_name} projectId={project.id} />"
);

fs.writeFileSync('src/app/(protected)/projects/[id]/page.tsx', code);
