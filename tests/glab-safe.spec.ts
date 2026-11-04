import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'glab-safe')
const DIRECTORY = mkdtempSync(join(tmpdir(), 'glab-safe-'))
const FAKE = join(DIRECTORY, 'glab')
writeFileSync(FAKE, '#!/bin/sh\nprintf \'FAKE:%s\\n\' "$*"\n')
chmodSync(FAKE, 0o755)
const run = (...args: string[]) => spawnSync('python3', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8',
  env: { ...process.env, GLAB_SAFE_REAL: FAKE } })

afterAll(() => { rmSync(DIRECTORY, { recursive: true, force: true }) })

describe('glab-safe', () => {
  it('runs allowed reads and safe writes through the real glab', () => {
    expect(run('mr', 'list')).toMatchObject({ status: 0, stdout: 'FAKE:mr list\n' })
    expect(run('mr', 'note', '1', '--message', 'hi')).toMatchObject({ status: 0, stdout: 'FAKE:mr note 1 --message hi\n' })
    expect(run('api', 'projects/1', '--method', 'GET')).toMatchObject({ status: 0 })
    expect(run('--version')).toMatchObject({ status: 0 })
  })
  it('refuses merge, approve, tag, release and write API calls', () => {
    for (const args of [['mr', 'merge', '1'], ['mr', 'approve', '1'], ['tag', 'list'], ['release', 'list'],
      ['api', 'projects/1', '--method', 'POST'], ['api', 'projects/1', '-f', 'x=1']]) {
      const result = run(...args)
      expect(result.status, args.join(' ')).toBe(126)
      expect(result.stderr).toContain('refused')
    }
  })
})
