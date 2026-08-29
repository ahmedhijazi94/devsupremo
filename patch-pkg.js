const fs = require('fs');
let code = fs.readFileSync('src/lib/templates/project-files.ts', 'utf8');

const oldDeps = `"dependencies": {
      "@supabase/supabase-js": "^2.39.0",
      "next": "15.0.0",
      "react": "^18.2.0",
      "react-dom": "^18.2.0",
      "zod": "^3.22.4"
    },`;

const newDeps = `"dependencies": {
      "@supabase/supabase-js": "^2.39.0",
      "clsx": "^2.1.1",
      "lucide-react": "^0.460.0",
      "next": "15.0.0",
      "react": "^18.2.0",
      "react-dom": "^18.2.0",
      "tailwind-merge": "^2.5.5",
      "zod": "^3.22.4"
    },`;

const oldDevDeps = `"devDependencies": {
      "@playwright/test": "^1.40.1",`;

const newDevDeps = `"devDependencies": {
      "autoprefixer": "^10.4.20",
      "postcss": "^8.4.49",
      "tailwindcss": "^3.4.15",
      "@playwright/test": "^1.40.1",`;

code = code.replace(oldDeps, newDeps).replace(oldDevDeps, newDevDeps);
fs.writeFileSync('src/lib/templates/project-files.ts', code);
