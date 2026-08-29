const fs = require('fs');

// Patch scaffold.ts (CLAUDE.md)
let scaffoldCode = fs.readFileSync('src/actions/scaffold.ts', 'utf8');
scaffoldCode = scaffoldCode.replace(
  "3. Unit Tests: \\`vitest run\\`",
  "3. Unit Tests: \\`npm run test\\`\n4. E2E Tests: \\`npm run test:e2e\\`\n5. Se algum teste falhar, você DEVE corrigi-lo antes de finalizar a resposta."
);
fs.writeFileSync('src/actions/scaffold.ts', scaffoldCode);

// Patch project-files.ts (vercel.json)
let projectFilesCode = fs.readFileSync('src/lib/templates/project-files.ts', 'utf8');
const oldVercel = `          {
            "key": "Permissions-Policy",
            "value": "camera=(), microphone=(), geolocation=()"
          }
        ]
      }
    ]
  }, null, 2)`;

const newVercel = `          {
            "key": "Permissions-Policy",
            "value": "camera=(), microphone=(), geolocation=()"
          }
        ]
      }
    ],
    "crons": [
      {
        "path": "/api/cron",
        "schedule": "0 * * * *"
      }
    ]
  }, null, 2)`;

projectFilesCode = projectFilesCode.replace(oldVercel, newVercel);
fs.writeFileSync('src/lib/templates/project-files.ts', projectFilesCode);

