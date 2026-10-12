import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('../../src/Ai.Tlbx.MidTerm/node_modules/typescript');
const source = fs.readFileSync(new URL('../../src/Ai.Tlbx.MidTerm/src/ts/modules/git/gitCommands.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
const { buildFileCommandSuggestions, buildCommitCommandSuggestions, quoteGitPath } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-command-quoting'); fs.mkdirSync(out, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-quote-'));
const root = path.join(base, "repo ä $HOME " + String.fromCharCode(96) + " ‘smart’ it's"); fs.mkdirSync(root);
const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
const files = ['space name.txt', 'Unicode ä字.txt', '$HOME.txt', 'literal' + String.fromCharCode(96) + 'tick.txt', "it's quoted.txt", 'smart‘quote’.txt', '--option.txt', 'glob[abc].txt', "attack'$(touch injected.marker)'.txt", 'attack‘$(Set-Content injected.marker owned)’.txt'];
if (process.platform !== 'win32') files.push('double"quote.txt', "both'\"quotes.txt", ':(glob)*.txt', 'literal\\backslash.txt');
for (const [i, file] of files.entries()) fs.writeFileSync(path.join(root, file), 'Baseline ' + i + '\n');
git(['init', '--quiet']); git(['config', 'user.name', 'Quoting acceptance']); git(['config', 'user.email', 'quote@tlbx.invalid']); git(['config', 'commit.gpgSign', 'false']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Baseline']);
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const result = { ok: false, platform: process.platform, root, cases: [], shellExecutions: [], unsupported: [] };
try {
  for (const shell of ['Pwsh', 'Bash']) {
    for (const [i, file] of files.entries()) {
      fs.writeFileSync(path.join(root, file), 'Exact reviewed change ' + i + '\n');
      const suggestions = buildFileCommandSuggestions({ path: file, status: 'modified' }, 'worktree', root, shell);
      const run = label => {
        const command = suggestions.find(item => item.label === label)?.command; assert.ok(command);
        result.shellExecutions.push({ shell, file, label, command });
        const args = shell === 'Pwsh' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['--noprofile', '--norc', '-c', command];
        return execFileSync(shell === 'Pwsh' ? 'pwsh' : bash, args, { cwd: base, windowsHide: true, stdio: 'pipe' }).toString('utf8');
      };
      const diff = run('Show diff'); assert.ok(diff.includes('+Exact reviewed change ' + i), shell + ': ' + file);
      run('Stage file'); assert.deepEqual(git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean), [file]);
      const unstage = buildFileCommandSuggestions({ path: file, status: 'modified' }, 'staged', root, shell).find(item => item.label === 'Unstage file').command;
      execFileSync(shell === 'Pwsh' ? 'pwsh' : bash, shell === 'Pwsh' ? ['-NoProfile', '-NonInteractive', '-Command', unstage] : ['--noprofile', '--norc', '-c', unstage], { cwd: base, windowsHide: true, stdio: 'pipe' });
      assert.equal(git(['diff', '--cached', '--name-only']), '');
      assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'Exact reviewed change ' + i + '\n');
      assert.ok(!fs.existsSync(path.join(root, 'injected.marker')) && !fs.existsSync(path.join(base, 'injected.marker')));
      result.cases.push({ shell, file, exactIndex: true, noExpansion: true, unchangedDisk: true });
      fs.writeFileSync(path.join(root, file), 'Baseline ' + i + '\n');
    }
  }
  for (const shell of ['Cmd', 'fish', 'Unknown', '']) {
    assert.equal(quoteGitPath('path', shell), null);
    assert.deepEqual(buildFileCommandSuggestions({ path: files[0], status: 'modified' }, 'worktree', root, shell), []);
    assert.deepEqual(buildCommitCommandSuggestions({ hash: git(['rev-parse', 'HEAD']).trim() }, root, shell), []);
    result.unsupported.push(shell);
  }
  assert.equal(git(['status', '--porcelain']), ''); result.ok = true;
} catch (error) { result.failure = String(error.stack || error); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, platform: result.platform, cases: result.cases.length, failure: result.failure, summary: path.join(out, 'summary.json') })); }
