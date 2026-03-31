import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('../utils/cwd.js', () => ({
  getCwd: () => process.cwd(),
}))

mock.module('../utils/debug.js', () => ({
  logForDebugging: () => {},
  isDebugToStdErr: () => false,
}))

mock.module('../utils/git.js', () => ({
  findGitRoot: () => null,
}))

mock.module('../utils/json.js', () => ({
  safeParseJSON(json: string | null | undefined): unknown {
    if (!json) {
      return null
    }
    try {
      return JSON.parse(json)
    } catch {
      return null
    }
  },
}))

const {
  clearProjectDetectionCache,
  detectProjectContext,
  formatProjectDetectionForPrompt,
} = await import('./projectDetection.js')

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

afterEach(() => {
  clearProjectDetectionCache()
})

describe('projectDetection', () => {
  test('detects bun TypeScript projects and prefers script-based verification commands', async () => {
    const dir = await createTempDir('glm-project-detection-node-')

    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify(
          {
            packageManager: 'bun@1.1.20',
            scripts: {
              test: 'test',
              lint: 'lint',
              typecheck: 'typecheck',
              build: 'build',
            },
            dependencies: {
              react: '^19.0.0',
            },
            devDependencies: {
              typescript: '^5.8.0',
            },
          },
          null,
          2,
        ),
      )
      await writeFile(join(dir, 'tsconfig.json'), '{}')

      const result = await detectProjectContext(dir)

      expect(result).not.toBeNull()
      expect(result?.rootDir).toBe(dir)
      expect(result?.signals).toEqual(
        expect.arrayContaining(['Node.js', 'TypeScript', 'React']),
      )
      expect(result?.commands).toEqual({
        test: 'bun run test',
        lint: 'bun run lint',
        typecheck: 'bun run typecheck',
        build: 'bun run build',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('detects Python verification commands and preserves build detection', async () => {
    const dir = await createTempDir('glm-project-detection-python-')

    try {
      await writeFile(
        join(dir, 'pyproject.toml'),
        `
[project]
name = "demo"
version = "0.1.0"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.pytest.ini_options]
addopts = "-q"

[tool.ruff]
line-length = 100

[tool.pyright]
typeCheckingMode = "basic"
        `.trim(),
      )
      await writeFile(
        join(dir, 'Makefile'),
        ['test:', '\tpytest', 'lint:', '\truff check .', 'build:', '\tpython -m build'].join('\n'),
      )

      const result = await detectProjectContext(dir)

      expect(result).not.toBeNull()
      expect(result?.signals).toEqual(
        expect.arrayContaining(['Python', 'Makefile']),
      )
      expect(result?.commands).toEqual({
        test: 'pytest',
        lint: 'ruff check .',
        typecheck: 'pyright',
        build: 'python -m build',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('finds a project manifest in an immediate child directory and formats prompt hints', async () => {
    const dir = await createTempDir('glm-project-detection-child-')
    const appDir = join(dir, 'app')

    try {
      await mkdir(appDir)
      await writeFile(
        join(appDir, 'package.json'),
        JSON.stringify(
          {
            scripts: {
              test: 'test',
            },
          },
          null,
          2,
        ),
      )

      const result = await detectProjectContext(dir)
      const promptLines = formatProjectDetectionForPrompt(result)

      expect(result?.rootDir).toBe(appDir)
      expect(promptLines).toContain('Likely project stack: Node.js')
      expect(promptLines).toContain(
        'Likely verification commands: test: `npm run test`',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
