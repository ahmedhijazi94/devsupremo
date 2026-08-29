const fs = require('fs');
let code = fs.readFileSync('src/lib/templates/project-files.ts', 'utf8');

const oldDeps = `"dependencies": {
      "@supabase/supabase-js": "^2.39.0",`;

const newDeps = `"dependencies": {
      "@supabase/ssr": "^0.5.2",
      "@supabase/supabase-js": "^2.39.0",`;

code = code.replace(oldDeps, newDeps);
fs.writeFileSync('src/lib/templates/project-files.ts', code);
