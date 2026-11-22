# file-budget

Fail the build when files grow past a size limit.

One file, zero dependencies. Point it at your build output, give each glob a limit, and it exits non-zero when something is too big, so CI catches the 400 KB image or the bundle that doubled before your users do.

```
$ npx github:fikazgit/file-budget "dist/**/*.js:150kb:gzip" "dist/**/*.html:100kb"

ok     41.20 KB / 150.00 KB gzip (27%)  dist/js/app.js
OVER  212.67 KB / 150.00 KB gzip (142%)  dist/js/vendor.js
ok     18.03 KB / 100.00 KB (18%)  dist/index.html

1 of 3 over budget
```

## Install

Run it without installing:

```sh
npx github:fikazgit/file-budget "dist/**/*.js:150kb"
```

Or add it to a project:

```sh
npm install --save-dev github:fikazgit/file-budget
```

Requires Node 18 or newer.

## Rules

A rule is `"<glob>:<limit>[:gzip|:brotli]"`. Quote it so the shell does not expand the glob.

| Part | Examples | Notes |
| --- | --- | --- |
| glob | `dist/**/*.js`, `public/*.{png,jpg}`, `build/index.html` | `*`, `**`, `?` and `{a,b}`. `node_modules` and `.git` are skipped unless the glob names them. |
| limit | `500b`, `150kb`, `1.5mb` | 1 KB = 1024 bytes. A file exactly at the limit passes. |
| compression | `gzip`, `brotli` | Optional. Measures the compressed size instead of the size on disk. |

## Options

| Option | What it does |
| --- | --- |
| `--config <file>` | Read rules from a JSON file. |
| `--total` | Compare the sum of the matched files to the limit instead of each file. |
| `--allow-empty` | Do not fail when a glob matches no files. |
| `--json` | Print the full report as JSON. |
| `--quiet` | Print only the files that are over budget. |

## Config file

With no rules on the command line, `file-budget` reads `file-budget.json` from the current directory:

```json
{
  "budgets": [
    { "path": "dist/**/*.js", "max": "150kb", "compression": "gzip" },
    { "path": "dist/**/*.css", "max": "50kb", "compression": "brotli" },
    { "path": "dist/**/*.html", "max": "100kb" }
  ]
}
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Everything is within budget. |
| 1 | At least one file is over budget. |
| 2 | Usage error, or a glob matched no files. |

A glob that matches nothing is an error on purpose: a check that silently looks at zero files passes forever. Use `--allow-empty` if that is what you want.

## In CI

`package.json`:

```json
{
  "scripts": {
    "build": "vite build",
    "size": "file-budget"
  }
}
```

GitHub Actions:

```yaml
- run: npm run build
- run: npx github:fikazgit/file-budget "dist/**/*.js:150kb:gzip"
```

## From JavaScript

```js
const { check, parseRule } = require('file-budget');

const report = check([parseRule('dist/**/*.js:150kb:gzip')], { cwd: process.cwd() });
// { ok, over, code, empty: [...], results: [{ file, size, max, compression, ok }] }
```

## License

MIT
