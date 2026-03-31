import { access, readFile, readdir } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { findGitRoot } from '../utils/git.js'
import { safeParseJSON } from '../utils/json.js'

export type VerificationCommandKind = 'test' | 'lint' | 'typecheck' | 'build'

export type ProjectDetectionResult = {
  rootDir: string
  signals: string[]
  commands: Partial<Record<VerificationCommandKind, string>>
}

const MANIFEST_FILES = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Makefile',
  'makefile',
  'GNUmakefile',
] as const

const detectionCache = new Map<string, Promise<ProjectDetectionResult | null>>()

type PackageJsonLike = {
  packageManager?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

export async function detectProjectContext(
  cwd: string = getCwd(),
): Promise<ProjectDetectionResult | null> {
  const resolvedCwd = resolve(cwd)
  const cached = detectionCache.get(resolvedCwd)
  if (cached) {
    return cached
  }

  const pending = detectProjectContextUncached(resolvedCwd)
  detectionCache.set(resolvedCwd, pending)
  return pending
}

export function clearProjectDetectionCache(): void {
  detectionCache.clear()
}

export function formatProjectDetectionForPrompt(
  result: ProjectDetectionResult | null,
): string[] {
  if (!result) {
    return []
  }

  const lines: string[] = []
  if (result.signals.length > 0) {
    lines.push(`Likely project stack: ${result.signals.join(', ')}`)
  }

  const commandSummary = (
    ['test', 'lint', 'typecheck', 'build'] as const
  )
    .map(kind =>
      result.commands[kind] ? `${kind}: \`${result.commands[kind]}\`` : null,
    )
    .filter((value): value is string => value !== null)

  if (commandSummary.length > 0) {
    lines.push(`Likely verification commands: ${commandSummary.join('; ')}`)
  }

  return lines
}

async function detectProjectContextUncached(
  cwd: string,
): Promise<ProjectDetectionResult | null> {
  try {
    const projectDir = await findProjectDir(cwd)
    if (!projectDir) {
      return null
    }

    const [
      packageJsonText,
      hasTsConfig,
      pyprojectText,
      cargoTomlText,
      goModText,
      pomXmlText,
      gradleText,
      gradleKtsText,
      makefileText,
    ] = await Promise.all([
      readTextIfExists(join(projectDir, 'package.json')),
      pathExists(join(projectDir, 'tsconfig.json')),
      readTextIfExists(join(projectDir, 'pyproject.toml')),
      readTextIfExists(join(projectDir, 'Cargo.toml')),
      readTextIfExists(join(projectDir, 'go.mod')),
      readTextIfExists(join(projectDir, 'pom.xml')),
      readTextIfExists(join(projectDir, 'build.gradle')),
      readTextIfExists(join(projectDir, 'build.gradle.kts')),
      readFirstExistingText(projectDir, ['Makefile', 'makefile', 'GNUmakefile']),
    ])

    const signals = new Set<string>()
    const commands: ProjectDetectionResult['commands'] = {}

    if (hasTsConfig) {
      signals.add('TypeScript')
    }
    if (packageJsonText) {
      await detectNodeProject(projectDir, packageJsonText, signals, commands)
    }
    if (pyprojectText) {
      await detectPythonProject(projectDir, pyprojectText, signals, commands)
    }
    if (cargoTomlText) {
      signals.add('Rust')
      commands.test ??= 'cargo test'
      commands.typecheck ??= 'cargo check'
      commands.build ??= 'cargo build'
    }
    if (goModText) {
      signals.add('Go')
      commands.test ??= 'go test ./...'
      commands.build ??= 'go build ./...'
    }
    if (pomXmlText) {
      signals.add('Java')
      signals.add('Maven')
      commands.test ??= 'mvn test'
      commands.build ??= 'mvn package'
    }
    if (gradleText || gradleKtsText) {
      signals.add('Gradle')
      signals.add('JVM')
      commands.test ??= './gradlew test'
      commands.build ??= './gradlew build'
    }
    if (makefileText) {
      detectMakefileTargets(makefileText, commands)
      signals.add('Makefile')
    }

    const dedupedSignals = Array.from(signals)
    if (dedupedSignals.length === 0 && Object.keys(commands).length === 0) {
      return null
    }

    return {
      rootDir: projectDir,
      signals: dedupedSignals,
      commands,
    }
  } catch (error) {
    logForDebugging(
      `[projectDetection] failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

async function findProjectDir(startDir: string): Promise<string | null> {
  const resolvedStart = resolve(startDir)
  const gitRoot = findGitRoot(resolvedStart)
  const stopDir = gitRoot ? resolve(gitRoot) : resolvedStart

  let current = resolvedStart
  while (true) {
    if (await directoryHasManifest(current)) {
      return current
    }
    if (current === stopDir) {
      break
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return findManifestInImmediateChildren(stopDir)
}

async function findManifestInImmediateChildren(
  directory: string,
): Promise<string | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const childDir = join(directory, entry.name)
      if (await directoryHasManifest(childDir)) {
        return childDir
      }
    }
  } catch {
    return null
  }
  return null
}

async function directoryHasManifest(directory: string): Promise<boolean> {
  const checks = await Promise.all(
    MANIFEST_FILES.map(fileName => pathExists(join(directory, fileName))),
  )
  return checks.some(Boolean)
}

async function detectNodeProject(
  projectDir: string,
  packageJsonText: string,
  signals: Set<string>,
  commands: ProjectDetectionResult['commands'],
): Promise<void> {
  const parsed = safeParseJSON(packageJsonText, false)
  const packageJson =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PackageJsonLike)
      : null

  if (!packageJson) {
    signals.add('Node.js')
    return
  }

  signals.add('Node.js')

  const dependencies = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ])

  const hasTsConfig = await pathExists(join(projectDir, 'tsconfig.json'))
  if (hasTsConfig || dependencies.has('typescript')) {
    signals.add('TypeScript')
  }
  if (dependencies.has('next')) {
    signals.add('Next.js')
  } else if (dependencies.has('react')) {
    signals.add('React')
  } else if (dependencies.has('vue')) {
    signals.add('Vue')
  } else if (dependencies.has('svelte')) {
    signals.add('Svelte')
  }

  const packageManager = await detectNodePackageManager(projectDir, packageJson)
  const scripts = packageJson.scripts ?? {}
  const runner = getNodeScriptRunner(packageManager)

  commands.test ??= buildNodeScriptCommand(
    runner,
    pickFirstKey(scripts, ['test:unit', 'test', 'test:ci']),
  )
  commands.lint ??= buildNodeScriptCommand(
    runner,
    pickFirstKey(scripts, ['lint', 'lint:ci', 'eslint', 'check:lint']),
  )
  commands.typecheck ??= buildNodeScriptCommand(
    runner,
    pickFirstKey(scripts, [
      'typecheck',
      'type-check',
      'check-types',
      'types',
      'tsc',
    ]),
  )
  commands.build ??= buildNodeScriptCommand(
    runner,
    pickFirstKey(scripts, ['build', 'build:prod', 'compile']),
  )

  if (!commands.test && packageManager === 'bun') {
    commands.test = 'bun test'
  }
}

async function detectPythonProject(
  projectDir: string,
  pyprojectText: string,
  signals: Set<string>,
  commands: ProjectDetectionResult['commands'],
): Promise<void> {
  signals.add('Python')

  if (await pathExists(join(projectDir, 'uv.lock'))) {
    signals.add('uv')
  } else if (await pathExists(join(projectDir, 'poetry.lock'))) {
    signals.add('Poetry')
  }

  if (/\bpytest\b/i.test(pyprojectText)) {
    commands.test ??= 'pytest'
  }
  if (/\bruff\b/i.test(pyprojectText)) {
    commands.lint ??= 'ruff check .'
  }
  if (/\bmypy\b/i.test(pyprojectText)) {
    commands.typecheck ??= 'mypy .'
  } else if (/\bpyright\b/i.test(pyprojectText)) {
    commands.typecheck ??= 'pyright'
  }
  if (/\[build-system\]/.test(pyprojectText)) {
    commands.build ??= 'python -m build'
  }
}

function detectMakefileTargets(
  makefileText: string,
  commands: ProjectDetectionResult['commands'],
): void {
  const targets = new Set<string>()
  for (const line of makefileText.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9][^:#=\s]*)\s*:/)
    if (match?.[1]) {
      targets.add(match[1])
    }
  }

  if (targets.has('test')) {
    commands.test ??= 'make test'
  }
  if (targets.has('lint')) {
    commands.lint ??= 'make lint'
  }
  if (targets.has('typecheck')) {
    commands.typecheck ??= 'make typecheck'
  } else if (targets.has('check-types')) {
    commands.typecheck ??= 'make check-types'
  }
  if (targets.has('build')) {
    commands.build ??= 'make build'
  }
}

async function detectNodePackageManager(
  projectDir: string,
  packageJson: PackageJsonLike,
): Promise<'bun' | 'pnpm' | 'yarn' | 'npm'> {
  const packageManager = packageJson.packageManager?.trim()
  if (packageManager) {
    const declared = packageManager.split('@')[0]
    if (
      declared === 'bun' ||
      declared === 'pnpm' ||
      declared === 'yarn' ||
      declared === 'npm'
    ) {
      return declared
    }
  }

  if (
    (await pathExists(join(projectDir, 'bun.lock'))) ||
    (await pathExists(join(projectDir, 'bun.lockb')))
  ) {
    return 'bun'
  }
  if (await pathExists(join(projectDir, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }
  if (await pathExists(join(projectDir, 'yarn.lock'))) {
    return 'yarn'
  }
  return 'npm'
}

function getNodeScriptRunner(
  packageManager: 'bun' | 'pnpm' | 'yarn' | 'npm',
): string {
  switch (packageManager) {
    case 'bun':
      return 'bun run'
    case 'pnpm':
      return 'pnpm run'
    case 'yarn':
      return 'yarn run'
    case 'npm':
    default:
      return 'npm run'
  }
}

function buildNodeScriptCommand(
  runner: string,
  scriptName: string | null,
): string | undefined {
  return scriptName ? `${runner} ${scriptName}` : undefined
}

function pickFirstKey(
  record: Record<string, string>,
  candidates: readonly string[],
): string | null {
  for (const candidate of candidates) {
    if (record[candidate]) {
      return candidate
    }
  }
  return null
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

async function readFirstExistingText(
  directory: string,
  candidates: readonly string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    const content = await readTextIfExists(join(directory, candidate))
    if (content !== null) {
      return content
    }
  }
  return null
}
