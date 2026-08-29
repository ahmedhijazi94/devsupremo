const fs = require('fs');
let code = fs.readFileSync('src/lib/templates/project-files.ts', 'utf8');

code = code.replace(
  '"@supabase/supabase-js": "^2.39.0",',
  '"@supabase/supabase-js": "^2.39.0",\n      "@supabase/ssr": "^0.1.0",'
);

fs.writeFileSync('src/lib/templates/project-files.ts', code);
