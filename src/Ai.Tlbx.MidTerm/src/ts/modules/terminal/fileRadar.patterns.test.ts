import { describe, it, expect } from 'vitest';
import {
  UNIX_PATH_PATTERN,
  WIN_PATH_PATTERN,
  UNIX_PATH_PATTERN_GLOBAL,
  WIN_PATH_PATTERN_GLOBAL,
  RELATIVE_PATH_PATTERN,
  FOLDER_PATH_PATTERN,
  KNOWN_FILE_PATTERN,
  isValidPath,
  isLikelyFalsePositive,
  shouldRejectFolderMatch,
  shouldRejectKnownFileMatch,
  shouldRejectRelativeMatch,
} from './fileRadar.patterns';

// ===========================================================================
// Category A: Unix Absolute Paths (UNIX_PATH_PATTERN)
// ===========================================================================

describe('UNIX_PATH_PATTERN', () => {
  it.each([
    ['Modified: /home/user/project/src/main.rs', '/home/user/project/src/main.rs'],
    ['Error in /var/log/nginx/error.log line 42', '/var/log/nginx/error.log'],
    ['cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak', '/etc/nginx/nginx.conf'],
    ['Compiled /usr/local/lib/libfoo.so.2.1', '/usr/local/lib/libfoo.so.2.1'],
    ['reading /proc/self/status', '/proc/self/status'],
    ['drwxr-xr-x  /home/user/.config/nvim', '/home/user/.config/nvim'],
    ['GOPATH=/home/user/go', '/home/user/go'],
    [
      'at Module._compile (/app/node_modules/ts-node/src/index.ts:1618:12)',
      '/app/node_modules/ts-node/src/index.ts',
    ],
    ['warning: /tmp/build-abc123/CMakeCache.txt', '/tmp/build-abc123/CMakeCache.txt'],
    ['rsync user@host:/var/www/html/index.html .', '/var/www/html/index.html'],
  ])('matches Unix path in: %s', (input, expected) => {
    const match = input.match(UNIX_PATH_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(expected);
  });

  it('does not match path preceded by alphanumeric (negative lookbehind)', () => {
    const input = 'node_modules/@xterm/xterm/lib/index.js:42';
    const match = input.match(UNIX_PATH_PATTERN);
    // The pattern has a negative lookbehind for alphanumeric chars
    // "s/" — 's' is alphanumeric, so /xterm/... should not match as a Unix absolute path
    if (match) {
      // If it matches at all, it should not start at the / after "modules"
      expect(match[1]).not.toBe('/xterm/xterm/lib/index.js');
    }
  });

  it('matches /bin but isValidPath rejects bare Unix dirs', () => {
    const match = '/bin'.match(UNIX_PATH_PATTERN);
    expect(match).not.toBeNull();
    expect(isValidPath('/bin')).toBe(false);
  });
});

// ===========================================================================
// Category B: Windows Absolute Paths (WIN_PATH_PATTERN)
// ===========================================================================

describe('WIN_PATH_PATTERN', () => {
  it.each([
    ['Error CS1234: C:\\Users\\dev\\src\\Program.cs(42,10)', 'C:\\Users\\dev\\src\\Program.cs'],
    ['Copying C:/tools/cmake/bin/cmake.exe', 'C:/tools/cmake/bin/cmake.exe'],
    [
      'APPDATA=C:\\Users\\johan\\AppData\\Roaming',
      'C:\\Users\\johan\\AppData\\Roaming',
    ],
    [
      'at Foo.Bar() in D:\\repos\\MyProject\\Foo.cs:line 15',
      'D:\\repos\\MyProject\\Foo.cs',
    ],
    [
      'nuget restore "E:\\packages\\Newtonsoft.Json.13.0.3"',
      'E:\\packages\\Newtonsoft.Json.13.0.3',
    ],
    ['Published to C:\\publish\\win-x64\\mt.exe', 'C:\\publish\\win-x64\\mt.exe'],
    [
      '> esbuild C:\\code\\frontend\\src\\main.ts --bundle',
      'C:\\code\\frontend\\src\\main.ts',
    ],
    [
      'MSBuild: Q:\\repos\\MidTermWorkspace3\\src\\Ai.Tlbx.MidTerm.csproj',
      'Q:\\repos\\MidTermWorkspace3\\src\\Ai.Tlbx.MidTerm.csproj',
    ],
    [
      'Certificate: C:\\Users\\user\\.midterm\\cert.pfx',
      'C:\\Users\\user\\.midterm\\cert.pfx',
    ],
    [
      'Loading C:\\ProgramData\\MidTerm\\settings.json',
      'C:\\ProgramData\\MidTerm\\settings.json',
    ],
  ])('matches Windows path in: %s', (input, expected) => {
    const match = input.match(WIN_PATH_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(expected);
  });
});

// ===========================================================================
// Category C: Relative Paths (RELATIVE_PATH_PATTERN)
// ===========================================================================

describe('RELATIVE_PATH_PATTERN', () => {
  it.each([
    ['Modified src/main.ts', 'src/main.ts'],
    ['Created ./output/report.pdf', './output/report.pdf'],
    ['Edit src\\Ai\\Services\\Foo.cs', 'src\\Ai\\Services\\Foo.cs'],
    ['comparing old.json and new.json', 'old.json'],
    ['Built dist/terminal.min.js', 'dist/terminal.min.js'],
    ['Added docs/api/README.md', 'docs/api/README.md'],
    ['Opened settings.json', 'settings.json'],
    ['tests/unit/auth.spec.ts passed', 'tests/unit/auth.spec.ts'],
    ['Reading config/webpack.config.js', 'config/webpack.config.js'],
    ['data.csv written to disk', 'data.csv'],
    [
      'node_modules/@angular/core/index.ts',
      'node_modules/@angular/core/index.ts',
    ],
  ])('matches relative path in: %s', (input, expected) => {
    const match = input.match(RELATIVE_PATH_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(expected);
  });

  it('matches ../shared/utils.ts but isValidPath rejects .. traversal', () => {
    const match = '../shared/utils.ts'.match(RELATIVE_PATH_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('../shared/utils.ts');
    expect(isValidPath('../shared/utils.ts')).toBe(false);
  });
});

// ===========================================================================
// Category D: Folder Paths (FOLDER_PATH_PATTERN)
// ===========================================================================

describe('FOLDER_PATH_PATTERN', () => {
  it.each([
    ['Scanning src/', 'src/'],
    ['Created docs/api/', 'docs/api/'],
    ['Deleted ./tmp/cache/', './tmp/cache/'],
    ['Looking in src\\components\\', 'src\\components\\'],
    ['Cleaning dist/assets/css/', 'dist/assets/css/'],
    ['Ignoring .git/', '.git/'],
    ['Indexing packages/core/src/', 'packages/core/src/'],
    ['Checking node_modules/', 'node_modules/'],
  ])('matches folder path in: %s', (input, expected) => {
    const match = input.match(FOLDER_PATH_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(expected);
  });
});

// ===========================================================================
// Category E: Known Extensionless Files (KNOWN_FILE_PATTERN)
// ===========================================================================

describe('KNOWN_FILE_PATTERN', () => {
  it.each([
    ['Modified Dockerfile', 'Dockerfile'],
    ['Updated Makefile target', 'Makefile'],
    ['Check the LICENSE file', 'LICENSE'],
    ['Edited .gitignore', '.gitignore'],
    ['See README for details', 'README'],
    ['Added .editorconfig', '.editorconfig'],
    ['Build uses Procfile', 'Procfile'],
    ['Loaded .env.production', '.env.production'],
    ['Updated docker/Dockerfile', 'docker/Dockerfile'],
    ['Modified src/api/.prettierrc', 'src/api/.prettierrc'],
    ['Checking CONTRIBUTING guide', 'CONTRIBUTING'],
    ['Parsing .browserslistrc', '.browserslistrc'],
  ])('matches known file in: %s', (input, expected) => {
    const match = input.match(KNOWN_FILE_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(expected);
  });
});

// ===========================================================================
// Category F: False Positive Filtering (isLikelyFalsePositive)
// ===========================================================================

describe('isLikelyFalsePositive', () => {
  describe('returns true for false positives', () => {
    it.each([
      ['1.2.3', 'version number (3-part)'],
      ['12.0.1', 'version number (3-part)'],
      ['3.12', 'version number (2-part)'],
      ['e.g.', 'abbreviation'],
      ['i.e.', 'abbreviation'],
      ['etc.', 'abbreviation'],
      ['vs.', 'abbreviation'],
      ['google.com', 'domain TLD (com)'],
      ['npmjs.org', 'domain TLD (org)'],
      ['github.io', 'domain TLD (io)'],
      ['claude.ai', 'domain TLD (ai)'],
      ['railway.app', 'domain TLD (app)'],
    ])('%s — %s', (input) => {
      expect(isLikelyFalsePositive(input)).toBe(true);
    });
  });

  describe('returns false for real file paths', () => {
    it.each([
      ['output.pdf', 'PDF file'],
      ['data.csv', 'CSV file'],
      ['model.json', 'JSON file'],
    ])('%s — %s', (input) => {
      expect(isLikelyFalsePositive(input)).toBe(false);
    });
  });
});

// ===========================================================================
// Category G: Path Validation (isValidPath)
// ===========================================================================

describe('isValidPath', () => {
  describe('rejects invalid paths', () => {
    it.each([
      ['', 'empty string'],
      ['/', 'single slash'],
      ['a', 'single character'],
      ['../../../etc/passwd', 'traversal attack'],
      ['/bin', 'bare Unix dir'],
      ['/usr', 'bare Unix dir'],
      ['/etc', 'bare Unix dir'],
    ])('%s — %s', (input) => {
      expect(isValidPath(input)).toBe(false);
    });
  });

  describe('accepts valid paths', () => {
    it.each([
      ['ab', 'minimal 2-char path'],
      ['/home/user/file.txt', 'Unix absolute with file'],
      ['C:\\file.txt', 'Windows absolute'],
    ])('%s — %s', (input) => {
      expect(isValidPath(input)).toBe(true);
    });
  });
});

// ===========================================================================
// Category H: matchCallback Filters
// ===========================================================================

describe('shouldRejectFolderMatch', () => {
  it.each([
    ['C:\\foo\\', true, 'Windows drive letter'],
    ['D:/bar/', true, 'Windows drive with forward slash'],
    ['http://', true, 'HTTP URL scheme'],
    ['https://example.com/', true, 'HTTPS URL scheme'],
    ['ftp://files/', true, 'FTP URL scheme'],
    ['src/components/', false, 'valid relative folder'],
  ])('%s → rejected=%s (%s)', (input, expected) => {
    expect(shouldRejectFolderMatch(input)).toBe(expected);
  });
});

describe('shouldRejectKnownFileMatch', () => {
  it.each([
    ['/etc/Dockerfile', true, 'absolute Unix path'],
    ['C:\\Dockerfile', true, 'Windows absolute path'],
    ['docker/Dockerfile', false, 'valid relative path'],
    ['Makefile', false, 'bare known file'],
  ])('%s → rejected=%s (%s)', (input, expected) => {
    expect(shouldRejectKnownFileMatch(input)).toBe(expected);
  });
});

describe('shouldRejectRelativeMatch', () => {
  it.each([
    ['/home/user/file.ts', true, 'absolute Unix path'],
    ['google.com', true, 'false positive (TLD)'],
    ['1.2.3', true, 'false positive (version)'],
    ['src/main.ts', false, 'valid relative path'],
  ])('%s → rejected=%s (%s)', (input, expected) => {
    expect(shouldRejectRelativeMatch(input)).toBe(expected);
  });
});

// ===========================================================================
// Category K: Real-World Terminal Snippets (Full Pipeline)
// ===========================================================================

describe('Real-world terminal output', () => {
  function extractPaths(text: string): string[] {
    const paths: string[] = [];

    // Reset global regexes
    UNIX_PATH_PATTERN_GLOBAL.lastIndex = 0;
    WIN_PATH_PATTERN_GLOBAL.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = UNIX_PATH_PATTERN_GLOBAL.exec(text)) !== null) {
      if (m[1] && isValidPath(m[1])) paths.push(m[1]);
    }
    while ((m = WIN_PATH_PATTERN_GLOBAL.exec(text)) !== null) {
      if (m[1] && isValidPath(m[1])) paths.push(m[1]);
    }

    const relMatch = text.match(RELATIVE_PATH_PATTERN);
    if (relMatch?.[1] && !shouldRejectRelativeMatch(relMatch[1]) && isValidPath(relMatch[1])) {
      paths.push(relMatch[1]);
    }

    const knownMatch = text.match(KNOWN_FILE_PATTERN);
    if (knownMatch?.[1] && !shouldRejectKnownFileMatch(knownMatch[1])) {
      paths.push(knownMatch[1]);
    }

    const folderMatch = text.match(FOLDER_PATH_PATTERN);
    if (folderMatch?.[1] && !shouldRejectFolderMatch(folderMatch[1])) {
      paths.push(folderMatch[1]);
    }

    return [...new Set(paths)];
  }

  it('git diff stat line', () => {
    const paths = extractPaths('src/main.ts | 42 +++---');
    expect(paths).toContain('src/main.ts');
  });

  it('test runner PASS line', () => {
    const paths = extractPaths('PASS tests/unit/auth.test.ts (2.34s)');
    expect(paths).toContain('tests/unit/auth.test.ts');
  });

  it('AI chat mentioning a file', () => {
    const paths = extractPaths("I've updated src/Services/FileEndpoints.cs");
    expect(paths).toContain('src/Services/FileEndpoints.cs');
  });

  it('AI chat mentioning multiple files', () => {
    const paths = extractPaths('check settings.json and .editorconfig');
    expect(paths).toContain('settings.json');
    expect(paths).toContain('.editorconfig');
  });

  it('AI chat mentioning deep path', () => {
    const paths = extractPaths('modify src/ts/modules/terminal/fileLinks.ts');
    expect(paths).toContain('src/ts/modules/terminal/fileLinks.ts');
  });

  it('Node.js stack trace — global pattern blocked by :linenum suffix', () => {
    // UNIX_PATH_PATTERN_GLOBAL requires whitespace/quote/paren boundary after path.
    // The :42:10 suffix prevents the global pattern from matching the absolute path.
    // However, RELATIVE_PATH_PATTERN matches the path without leading /
    const paths = extractPaths(
      'at Object.<anonymous> (/home/user/project/node_modules/@xterm/xterm/lib/index.js:42:10)',
    );
    // The absolute path with leading / is NOT found (global pattern boundary issue)
    expect(paths).not.toContain(
      '/home/user/project/node_modules/@xterm/xterm/lib/index.js',
    );
    // But relative pattern captures the path without leading /
    const hasRelativePath = paths.some((p) => p.includes('index.js'));
    expect(hasRelativePath).toBe(true);
  });

  it('npm warning with version number — no paths', () => {
    const paths = extractPaths('npm warn deprecated package@1.2.3');
    // Version numbers should be filtered, no meaningful file paths
    const realFiles = paths.filter((p) => !isLikelyFalsePositive(p));
    expect(realFiles).toHaveLength(0);
  });

  it('docker build command', () => {
    const paths = extractPaths('docker build -f docker/Dockerfile .');
    expect(paths).toContain('docker/Dockerfile');
  });

  it('pytest invocation', () => {
    const paths = extractPaths('python -m pytest tests/test_api.py::TestLogin');
    expect(paths).toContain('tests/test_api.py');
  });

  it('Python traceback', () => {
    const paths = extractPaths('File "scripts/deploy.py", line 23');
    expect(paths).toContain('scripts/deploy.py');
  });

  it('Java compile command with multiple paths', () => {
    const paths = extractPaths(
      'javac -cp lib/gson-2.10.1.jar src/Main.java',
    );
    // At least one of these should be detected
    const hasJar = paths.some((p) => p.includes('gson'));
    const hasJava = paths.some((p) => p.includes('Main.java'));
    expect(hasJar || hasJava).toBe(true);
  });

  it('cmake build directory', () => {
    const paths = extractPaths('cmake -S . -B build/');
    expect(paths).toContain('build/');
  });

  it('TypeScript error with line:col', () => {
    const paths = extractPaths('Error at src/foo.ts:42:10');
    expect(paths).toContain('src/foo.ts');
  });

  it('quoted paths (double quotes)', () => {
    const paths = extractPaths('"src/main.ts"');
    expect(paths).toContain('src/main.ts');
  });

  it('quoted paths (single quotes)', () => {
    const paths = extractPaths("'src/main.ts'");
    expect(paths).toContain('src/main.ts');
  });
});

// ===========================================================================
// Category L: URLs That Must NOT Match As Paths
// ===========================================================================

describe('URLs — current filter behavior', () => {
  // In production, URLs are handled by xterm web-links addon (higher priority)
  // before file radar patterns run. These tests document what the regex layer
  // itself would match — not all URL fragments are filtered.

  it('http://localhost:2000/api/health — no relative match (no extension)', () => {
    const relMatch = 'http://localhost:2000/api/health'.match(RELATIVE_PATH_PATTERN);
    // "health" has no file extension, so RELATIVE_PATH_PATTERN won't match
    expect(relMatch).toBeNull();
  });

  it('shouldRejectFolderMatch catches URL schemes in folder paths', () => {
    expect(shouldRejectFolderMatch('http://')).toBe(true);
    expect(shouldRejectFolderMatch('https://example.com/')).toBe(true);
    expect(shouldRejectFolderMatch('ftp://files/')).toBe(true);
  });

  it('shouldRejectFolderMatch does NOT catch scheme-less URL fragments', () => {
    // When FOLDER_PATH_PATTERN extracts "example.com/" from a URL,
    // shouldRejectFolderMatch doesn't see the original scheme
    expect(shouldRejectFolderMatch('example.com/')).toBe(false);
  });

  it('isLikelyFalsePositive catches single-segment TLD domains', () => {
    // Matches like "example.com" from URLs are caught by TLD check
    expect(isLikelyFalsePositive('example.com')).toBe(true);
    expect(isLikelyFalsePositive('github.io')).toBe(true);
  });

  it('isLikelyFalsePositive does NOT catch multi-segment domains', () => {
    // "docs.microsoft.com" has two dots — TLD check only catches "word.tld"
    expect(isLikelyFalsePositive('docs.microsoft.com')).toBe(false);
    expect(isLikelyFalsePositive('api.example.com')).toBe(false);
  });

  it('RELATIVE_PATH_PATTERN extracts fragments from URLs with file extensions', () => {
    // URLs containing paths with file extensions will produce regex matches
    const m = 'ftp://files.server.com/pub/release.tar.gz'.match(RELATIVE_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('files.server.com/pub/release.tar.gz');
  });
});

// ===========================================================================
// Category M: Global Pattern Scanning
// ===========================================================================

describe('Global pattern scanning', () => {
  it('UNIX_PATH_PATTERN_GLOBAL finds multiple paths', () => {
    const text = 'cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak';
    UNIX_PATH_PATTERN_GLOBAL.lastIndex = 0;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = UNIX_PATH_PATTERN_GLOBAL.exec(text)) !== null) {
      if (m[1]) matches.push(m[1]);
    }
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches).toContain('/etc/nginx/nginx.conf');
  });

  it('WIN_PATH_PATTERN_GLOBAL finds Windows paths in text', () => {
    const text = 'copy C:\\src\\file.cs D:\\dest\\file.cs';
    WIN_PATH_PATTERN_GLOBAL.lastIndex = 0;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = WIN_PATH_PATTERN_GLOBAL.exec(text)) !== null) {
      if (m[1]) matches.push(m[1]);
    }
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]).toBe('C:\\src\\file.cs');
  });

  it('UNIX_PATH_PATTERN_GLOBAL does not match inside words', () => {
    const text = 'node_modules/@xterm/xterm/lib/index.js';
    UNIX_PATH_PATTERN_GLOBAL.lastIndex = 0;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = UNIX_PATH_PATTERN_GLOBAL.exec(text)) !== null) {
      if (m[1]) matches.push(m[1]);
    }
    // Should not match /xterm/... because it's inside a word
    const absMatches = matches.filter((p) => p.startsWith('/'));
    expect(absMatches).toHaveLength(0);
  });
});

// ===========================================================================
// Category N: Real dotnet test / build output (from actual session)
// ===========================================================================

describe('dotnet test output — true positives', () => {
  it('dotnet test command — Windows absolute path to csproj', () => {
    const input =
      'dotnet test "Q:\\repos\\MidTermWorkspace3\\src\\Ai.Tlbx.MidTerm.UnitTests\\Ai.Tlbx.MidTerm.UnitTests.csproj" --verbosity normal';
    const m = input.match(WIN_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(
      'Q:\\repos\\MidTermWorkspace3\\src\\Ai.Tlbx.MidTerm.UnitTests\\Ai.Tlbx.MidTerm.UnitTests.csproj',
    );
  });

  it('vitest RUN line — Windows path with forward slashes', () => {
    const input = 'RUN  v4.0.18 Q:/repos/MidTermWorkspace3';
    const m = input.match(WIN_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('Q:/repos/MidTermWorkspace3');
  });

  it('vitest passed file — relative path with dots in directories', () => {
    const input =
      '✓ src/Ai.Tlbx.MidTerm/src/ts/modules/terminal/fileRadar.patterns.test.ts (117 tests) 22ms';
    const m = input.match(RELATIVE_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(
      'src/Ai.Tlbx.MidTerm/src/ts/modules/terminal/fileRadar.patterns.test.ts',
    );
  });

  it('dotnet build output line — project arrow notation', () => {
    const input =
      'Ai.Tlbx.MidTerm -> Q:\\repos\\MidTermWorkspace3\\src\\Ai.Tlbx.MidTerm\\bin\\Debug\\net10.0\\mt.dll';
    const m = input.match(WIN_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(
      'Q:\\repos\\MidTermWorkspace3\\src\\Ai.Tlbx.MidTerm\\bin\\Debug\\net10.0\\mt.dll',
    );
  });

  it('build output — js asset paths', () => {
    expect('js/audio-processor.js'.match(RELATIVE_PATH_PATTERN)![1]).toBe(
      'js/audio-processor.js',
    );
    expect('js/webAudioAccess.js'.match(RELATIVE_PATH_PATTERN)![1]).toBe(
      'js/webAudioAccess.js',
    );
  });

  it('prose mention — bare .cs filename', () => {
    const input = '20 C# endpoint tests in FileEndpointsTests.cs';
    const m = input.match(RELATIVE_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('FileEndpointsTests.cs');
  });

  it('prose mention — bare .test.ts filename', () => {
    const input = '117 TypeScript tests in fileRadar.patterns.test.ts';
    const m = input.match(RELATIVE_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('fileRadar.patterns.test.ts');
  });
});

describe('dotnet test output — false positives now filtered', () => {
  it('.NET FQN (4+ dots) is caught by isLikelyFalsePositive', () => {
    const input =
      'Passed Ai.Tlbx.MidTerm.UnitTests.FileEndpointsTests.ValidatePath_RejectsRelativePath [< 1 ms]';
    const m = input.match(RELATIVE_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(
      'Ai.Tlbx.MidTerm.UnitTests.FileEndpointsTests.ValidatePa',
    );
    // 5 dots, no path separator → FQN heuristic catches it
    expect(isLikelyFalsePositive(m![1])).toBe(true);
    expect(shouldRejectRelativeMatch(m![1])).toBe(true);
  });

  it('.NET FQN — AuthServiceTests also caught', () => {
    const input =
      'Passed Ai.Tlbx.MidTerm.UnitTests.AuthServiceTests.RateLimit_FiveFailures_30SecondLockout [3 ms]';
    const m = input.match(RELATIVE_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('Ai.Tlbx.MidTerm');
    // 4+ dots → caught
    expect(shouldRejectRelativeMatch(m![1])).toBe(true);
  });

  it('C# method call caught by PascalCase extension heuristic', () => {
    const input = 'Results.Forbid()';
    const m = input.match(RELATIVE_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('Results.Forbid');
    // "Forbid" is 6 chars, starts uppercase, no separator → caught
    expect(isLikelyFalsePositive('Results.Forbid')).toBe(true);
    expect(shouldRejectRelativeMatch(m![1])).toBe(true);
  });

  it('.NET project name caught by PascalCase extension heuristic', () => {
    const input =
      'Ai.Tlbx.MidTerm -> Q:\\repos\\MidTermWorkspace3\\src\\Ai.Tlbx.MidTerm\\bin\\Debug\\net10.0\\mt.dll';
    const rel = input.match(RELATIVE_PATH_PATTERN);
    expect(rel).not.toBeNull();
    expect(rel![1]).toBe('Ai.Tlbx.MidTerm');
    // "MidTerm" is 7 chars, starts uppercase → caught
    expect(isLikelyFalsePositive('Ai.Tlbx.MidTerm')).toBe(true);
  });
});

describe('dotnet test output — remaining edge cases', () => {
  it('API endpoint path still matches as Unix absolute path', () => {
    const input = '/api/files/resolve';
    const m = input.match(UNIX_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/api/files/resolve');
    // Has path separators, so FQN heuristic doesn't apply
    expect(isValidPath('/api/files/resolve')).toBe(true);
  });

  it('glob pattern fragment still matches as relative path', () => {
    const input = 'ESLint config: Added **/*.test.ts to ignores';
    const m = input.match(RELATIVE_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('.test.ts');
  });

  it('C# method name with slash still matches as folder', () => {
    const input =
      '2 MuxProtocolTests referencing deleted CreateProcessEventFrame/CreateForegroundChangeFrame methods';
    const m = input.match(FOLDER_PATH_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('CreateProcessEventFrame/');
  });
});

// ===========================================================================
// Category P: FQN heuristic does NOT break real files
// ===========================================================================

describe('FQN heuristic preserves real file patterns', () => {
  it.each([
    ['package.json', 'common config file'],
    ['settings.json', 'common config file'],
    ['main.ts', 'source file'],
    ['README.md', 'documentation'],
    ['data.csv', 'data file'],
    ['output.pdf', 'document'],
    ['file.test.ts', 'test file (2 dots)'],
    ['jquery.min.js', 'minified JS (2 dots)'],
    ['file.spec.ts', 'spec file (2 dots)'],
    ['app.module.css', 'CSS module (2 dots)'],
    ['vite.config.ts', 'config with dots (2 dots)'],
    ['.env.production', 'dotenv variant (2 dots)'],
  ])('%s — %s is NOT a false positive', (input) => {
    expect(isLikelyFalsePositive(input)).toBe(false);
  });

  it('file.test.spec.ts (3 dots) is NOT falsely rejected', () => {
    // 3 dots but extension is "ts" (lowercase, 2 chars) → safe
    expect(isLikelyFalsePositive('file.test.spec.ts')).toBe(false);
  });

  it('jquery.min.js.map (3 dots) is NOT falsely rejected', () => {
    expect(isLikelyFalsePositive('jquery.min.js.map')).toBe(false);
  });

  it('Microsoft.Extensions.DependencyInjection.dll (3 dots) is NOT falsely rejected', () => {
    // 3 dots, but extension "dll" is lowercase and short → safe
    expect(isLikelyFalsePositive('Microsoft.Extensions.DependencyInjection.dll')).toBe(false);
  });

  it('paths WITH separators are never caught by FQN heuristic', () => {
    expect(isLikelyFalsePositive('src/Ai.Tlbx.MidTerm/Services/FileEndpoints.cs')).toBe(false);
    expect(isLikelyFalsePositive('node_modules/@angular/core/index.ts')).toBe(false);
  });
});
