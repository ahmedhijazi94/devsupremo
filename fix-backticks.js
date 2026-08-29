const fs = require('fs');
let code = fs.readFileSync('src/actions/github-tree.ts', 'utf8');
code = code.replace(/\\`/g, '`');
code = code.replace(/\\\$/g, '$');
fs.writeFileSync('src/actions/github-tree.ts', code);
