const fs = require('fs');
let code = fs.readFileSync('src/actions/github-sync.ts', 'utf8');

code = code.replace(
  "let token = decipher.update(encryptedDataHex, 'hex', 'utf8')",
  "let token = decipher.update(encryptedDataHex || '', 'hex', 'utf8')"
);

fs.writeFileSync('src/actions/github-sync.ts', code);
