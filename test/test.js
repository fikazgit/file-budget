'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseSize, parseRule, globToRegExp, check } = require('../bin/file-budget.js');

const BIN = path.join(__dirname, '..', 'bin', 'file-budget.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-budget-'));
  const put = (rel, bytes) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'a'.repeat(bytes));
  };
  put('dist/index.html', 2000);
  put('dist/js/app.js', 5000);
  put('dist/js/vendor/lib.js', 300);
  put('dist/css/site.css', 100);
  put('dist/node_modules/x/big.js', 99999);
  return dir;
}

const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

test('parseSize', () => {
  assert.equal(parseSize('500'), 500);
  assert.equal(parseSize('500b'), 500);
  assert.equal(parseSize('1kb'), 1024);
  assert.equal(parseSize('1.5 MB'), 1572864);
  assert.equal(parseSize('2k'), 2048);
  assert.equal(parseSize('1KiB'), 1024);
  assert.throws(() => parseSize('big'));
});

test('parseRule keeps Windows drive letters in the glob', () => {
  assert.deepEqual(parseRule('dist/*.js:10kb:gzip'), { path: 'dist/*.js', max: 10240, compression: 'gzip' });
  assert.deepEqual(parseRule('C:\\out\\*.js:1kb'), { path: 'C:\\out\\*.js', max: 1024, compression: 'none' });
  assert.throws(() => parseRule('dist/*.js'));
});

test('globToRegExp', () => {
  assert.ok(globToRegExp('dist/**/*.js').test('dist/a.js'));
  assert.ok(globToRegExp('dist/**/*.js').test('dist/a/b/c.js'));
  assert.ok(!globToRegExp('dist/*.js').test('dist/a/b.js'));
  assert.ok(globToRegExp('*.{js,css}').test('x.css'));
  assert.ok(!globToRegExp('*.{js,css}').test('x.html'));
  assert.ok(!globToRegExp('a.js').test('axjs'));
});

test('check: within budget, node_modules skipped', () => {
  const r = check([parseRule('dist/**/*.js:6kb')], { cwd: fixture() });
  assert.equal(r.code, 0);
  assert.deepEqual(r.results.map((x) => x.file), ['dist/js/app.js', 'dist/js/vendor/lib.js']);
});

test('check: over budget reports the right file', () => {
  const r = check([parseRule('dist/**/*.js:1kb')], { cwd: fixture() });
  assert.equal(r.code, 1);
  assert.equal(r.over, 1);
  assert.equal(r.results.find((x) => !x.ok).file, 'dist/js/app.js');
});

test('check: exact limit passes, one byte over fails', () => {
  const cwd = fixture();
  assert.equal(check([parseRule('dist/index.html:2000b')], { cwd }).code, 0);
  assert.equal(check([parseRule('dist/index.html:1999b')], { cwd }).code, 1);
});

test('check: gzip measures compressed size', () => {
  const r = check([parseRule('dist/js/app.js:200b:gzip')], { cwd: fixture() });
  assert.equal(r.code, 0);
  assert.ok(r.results[0].size < 200);
});

test('check: --total sums files', () => {
  const cwd = fixture();
  const r = check([parseRule('dist/**/*.js:5200b')], { cwd, total: true });
  assert.equal(r.results[0].size, 5300);
  assert.equal(r.code, 1);
});

test('check: empty glob fails unless allowed', () => {
  const cwd = fixture();
  assert.equal(check([parseRule('dist/**/*.wasm:1kb')], { cwd }).code, 2);
  assert.equal(check([parseRule('dist/**/*.wasm:1kb')], { cwd, allowEmpty: true }).code, 0);
});

test('cli: exit codes and output', () => {
  const cwd = fixture();
  const ok = run(cwd, 'dist/**/*.{html,css}:4kb');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /2 checked, all within budget/);

  const over = run(cwd, 'dist/**/*.js:1kb', '--quiet');
  assert.equal(over.status, 1);
  assert.match(over.stdout, /OVER.*dist\/js\/app\.js/);
  assert.doesNotMatch(over.stdout, /lib\.js/);

  assert.equal(run(cwd).status, 2);
  assert.equal(run(cwd, '--nope').status, 2);
});

test('cli: config file and --json', () => {
  const cwd = fixture();
  fs.writeFileSync(
    path.join(cwd, 'file-budget.json'),
    JSON.stringify({ budgets: [{ path: 'dist/**/*.js', max: '1kb', compression: 'gzip' }, { path: 'dist/index.html', max: 100 }] })
  );
  const r = run(cwd, '--json');
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.over, 1);
  assert.equal(out.results.find((x) => !x.ok).file, 'dist/index.html');
});
