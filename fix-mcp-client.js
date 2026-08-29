const fs = require('fs');
let code = fs.readFileSync('src/app/api/mcp/route.ts', 'utf8');

code = code.replace(
  "import { createClient } from '@/lib/supabase/server'",
  "import { createClient } from '@supabase/supabase-js'"
);

code = code.replace(
  "const supabase = await createClient()",
  "const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)"
);

fs.writeFileSync('src/app/api/mcp/route.ts', code);
