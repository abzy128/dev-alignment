import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const dir = await mkdtemp(join(tmpdir(), 'alignment-tests-'))
try {
  const outfile = join(dir, 'test.mjs')
  await build({ entryPoints: ['tests/gitlab.test.ts'], bundle: true, platform: 'node', format: 'esm', outfile })
  process.exitCode = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' }).status ?? 1
} finally { await rm(dir, { recursive: true, force: true }) }
