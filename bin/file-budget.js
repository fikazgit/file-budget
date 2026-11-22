#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
const SKIP_DIRS = ['node_modules', '.git'];

const HELP = `file-budget - fail the build when files grow past a size limit

Usage:
  file-budget <rule> [<rule> ...] [options]
  file-budget --config file-budget.json

Rule:
  "<glob>:<limit>[:gzip|:brotli]"     e.g. "dist/**/*.js:150kb:gzip"

Options:
  --config <file>   read rules from a JSON file ({"budgets":[{"path","max","compression"}]})
  --total           compare the SUM of matched files to the limit, not each file
  --allow-empty     do not fail when a glob matches no files
  --json            print machine-readable JSON
  --quiet           print only files that are over budget
  -h, --help        show this help
  -v, --version     show version

Exit codes: 0 all within budget, 1 over budget, 2 usage error or glob matched nothing`;

class UsageError extends Error {}

function parseSize(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?i?b?)\s*$/i.exec(String(text));
  if (!m) throw new UsageError(`Invalid size "${text}" (use e.g. 500b, 150kb, 1.5mb)`);
  const unit = m[2].toLowerCase().replace('i', '');
  const mult = UNITS[unit.length === 1 && unit !== 'b' ? unit + 'b' : unit || 'b'];
  return Math.round(Number(m[1]) * mult);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function parseRule(text) {
  const parts = String(text).split(':');
  let compression = 'none';
  const last = parts[parts.length - 1].toLowerCase();
  if (last === 'gzip' || last === 'brotli' || last === 'none') {
    compression = last;
    parts.pop();
  }
  if (parts.length < 2) throw new UsageError(`Invalid rule "${text}" (expected "<glob>:<limit>[:gzip|:brotli]")`);
  const max = parseSize(parts.pop());
  return { path: parts.join(':'), max, compression };
}

function globToRegExp(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth) {
      depth--;
      re += ')';
    } else if (c === ',' && depth) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function findFiles(glob, cwd) {
  const pattern = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = pattern.split('/');
  const fixed = [];
  while (segments.length > 1 && !/[*?{]/.test(segments[0])) fixed.push(segments.shift());
  const baseRel = fixed.join('/');
  const base = path.resolve(cwd, baseRel || '.');
  const re = globToRegExp(pattern);
  const skip = SKIP_DIRS.filter((d) => !pattern.split('/').includes(d));
  const out = [];

  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.includes(e.name)) walk(full, childRel);
      } else if (e.isFile() && re.test(childRel)) out.push({ file: childRel, full });
    }
  };
  walk(base, baseRel);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function measure(full, compression) {
  const buf = fs.readFileSync(full);
  if (compression === 'gzip') return zlib.gzipSync(buf, { level: 9 }).length;
  if (compression === 'brotli') return zlib.brotliCompressSync(buf).length;
  return buf.length;
}

function check(rules, { cwd = process.cwd(), total = false, allowEmpty = false } = {}) {
  const results = [];
  const empty = [];
  for (const rule of rules) {
    const files = findFiles(rule.path, cwd);
    if (!files.length) {
      empty.push(rule.path);
      continue;
    }
    const sized = files.map((f) => ({ file: f.file, size: measure(f.full, rule.compression) }));
    const rows = total
      ? [{ file: `${rule.path} (${sized.length} files, total)`, size: sized.reduce((s, f) => s + f.size, 0) }]
      : sized;
    for (const r of rows) {
      results.push({ ...r, max: rule.max, compression: rule.compression, ok: r.size <= rule.max });
    }
  }
  const over = results.filter((r) => !r.ok).length;
  const emptyFails = allowEmpty ? [] : empty;
  return { ok: over === 0 && emptyFails.length === 0, over, results, empty, code: emptyFails.length ? 2 : over ? 1 : 0 };
}

function loadConfig(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`Cannot read config "${file}": ${e.message}`);
  }
  const list = Array.isArray(data) ? data : data.budgets;
  if (!Array.isArray(list)) throw new UsageError(`Config "${file}" needs a "budgets" array`);
  return list.map((b, i) => {
    if (!b || typeof b.path !== 'string' || b.max == null) {
      throw new UsageError(`Config "${file}": budgets[${i}] needs "path" and "max"`);
    }
    const compression = String(b.compression || 'none').toLowerCase();
    if (!['none', 'gzip', 'brotli'].includes(compression)) {
      throw new UsageError(`Config "${file}": budgets[${i}] has unknown compression "${b.compression}"`);
    }
    return { path: b.path, max: typeof b.max === 'number' ? b.max : parseSize(b.max), compression };
  });
}

function main(argv) {
  const opts = { total: false, allowEmpty: false, json: false, quiet: false };
  let rules = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return console.log(HELP), 0;
    if (a === '-v' || a === '--version') return console.log(require('../package.json').version), 0;
    if (a === '--total') opts.total = true;
    else if (a === '--allow-empty') opts.allowEmpty = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--config') {
      if (!argv[i + 1]) throw new UsageError('--config needs a file path');
      rules = rules.concat(loadConfig(argv[++i]));
    } else if (a.startsWith('-')) throw new UsageError(`Unknown option "${a}"`);
    else rules.push(parseRule(a));
  }
  if (!rules.length) {
    if (fs.existsSync('file-budget.json')) rules = loadConfig('file-budget.json');
    else throw new UsageError('No rules given. Run "file-budget --help".');
  }

  const report = check(rules, opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.code;
  }
  const rows = opts.quiet ? report.results.filter((r) => !r.ok) : report.results;
  const width = Math.max(0, ...rows.map((r) => formatSize(r.size).length));
  for (const r of rows) {
    const tag = r.compression === 'none' ? '' : ` ${r.compression}`;
    const pct = r.max ? ` (${Math.round((r.size / r.max) * 100)}%)` : '';
    console.log(`${r.ok ? 'ok  ' : 'OVER'}  ${formatSize(r.size).padStart(width)} / ${formatSize(r.max)}${tag}${pct}  ${r.file}`);
  }
  for (const g of report.empty) {
    console.error(`${opts.allowEmpty ? 'warning' : 'error'}: no files match "${g}"`);
  }
  const checked = report.results.length;
  if (checked) console.log(report.over ?`\n${report.over} of ${checked} over budget` : `\n${checked} checked, all within budget`);
  return report.code;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`file-budget: ${e.message}`);
    process.exitCode = 2;
  }
}

module.exports = { parseSize, formatSize, parseRule, globToRegExp, findFiles, check, loadConfig };
