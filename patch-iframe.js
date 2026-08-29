const fs = require('fs');
let code = fs.readFileSync('src/components/projects/preview-panel.tsx', 'utf8');

code = code.replace(
  'allow="accelerometer;',
  'allow="cross-origin-isolated; accelerometer;'
);

fs.writeFileSync('src/components/projects/preview-panel.tsx', code);
