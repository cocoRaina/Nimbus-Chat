#!/bin/bash
# One-time fix: move root-level files to correct paths + insert exec endpoint
# Run: cd ~/Nimbus-Chat && bash scripts/fix-paths.sh
set -e
cd "$(dirname "$0")/.."

echo '[1/5] Copying root files to correct paths...'
[ -f App.tsx ] && cp App.tsx src/App.tsx && echo '  App.tsx -> src/App.tsx'
[ -f definitions.ts ] && cp definitions.ts src/tools/definitions.ts && echo '  definitions.ts -> src/tools/definitions.ts'

echo '[2/5] Inserting exec endpoint into vps/index.js...'
node -e "
const fs = require('fs');
const f = 'vps/index.js';
let c = fs.readFileSync(f, 'utf8');
if (c.includes('api/exec')) { console.log('  exec endpoint already exists, skipping'); process.exit(0); }
const block = [
  '// ══ Shell exec ═══════════════════════════════════════════════════════',
  \"app.post('/api/exec', authenticate, (req, res) => {\",
  '  const { command, timeout_seconds } = req.body',
  \"  if (!command) return res.status(400).json({ error: 'Missing command' })\",
  '  const timeout = Math.min(60, Math.max(5, timeout_seconds || 30))',
  '  const start = Date.now()',
  '  try {',
  '    const stdout = execSync(command, {',
  '      timeout: timeout * 1000,',
  '      maxBuffer: 1024 * 1024,',
  \"      encoding: 'utf8',\",
  '      cwd: REPO_DIR,',
  '    })',
  \"    logOp({ action: 'exec', level: 'yellow', detail: command.slice(0, 120), result: 'ok' })\",
  '    res.json({ ok: true, stdout: stdout.slice(0, 50000), exit_code: 0, duration_ms: Date.now() - start })',
  '  } catch (err) {',
  \"    logOp({ action: 'exec', level: 'yellow', detail: command.slice(0, 120), result: err.status || 'error' })\",
  '    res.json({',
  '      ok: err.killed ? false : true,',
  \"      stdout: (err.stdout || '').slice(0, 50000),\",
  \"      stderr: (err.stderr || err.message || '').slice(0, 50000),\",
  '      exit_code: err.status || 1,',
  '      duration_ms: Date.now() - start,',
  '    })',
  '  }',
  '})',
  '',
].join('\\n');
c = c.replace('// ══ Code Sandbox', block + '\\n// ══ Code Sandbox');
fs.writeFileSync(f, c);
console.log('  exec endpoint inserted');
"

echo '[3/5] Removing misplaced root files...'
rm -f App.tsx definitions.ts index.js

echo '[4/5] Installing new dependencies...'
cd vps && npm install && cd ..

echo '[5/5] Committing and pushing...'
git add -A
git commit -m 'fix: move files to correct paths + add exec endpoint'
git push

echo ''
echo 'Done! Now run: pm2 restart nimbus-api'
