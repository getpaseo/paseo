import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const rootPackagePath = path.join(rootDir, 'package.json')

const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'))
const rootVersion = rootPackage.version
const workspacePaths = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : []

if (typeof rootVersion !== 'string' || rootVersion.length === 0) {
  throw new Error('Root package.json must contain a valid "version"')
}

const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

const touched = []

function syncDesktopTauriConfigVersion(version) {
  const tauriConfigPath = path.join(
    rootDir,
    'packages',
    'desktop',
    'src-tauri',
    'tauri.conf.json'
  )

  if (!existsSync(tauriConfigPath)) {
    return
  }

  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'))
  if (tauriConfig.version === version) {
    return
  }

  tauriConfig.version = version
  writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`)
  touched.push(path.relative(rootDir, tauriConfigPath))
}

function syncDesktopCargoPackageVersion(version) {
  const cargoTomlPath = path.join(
    rootDir,
    'packages',
    'desktop',
    'src-tauri',
    'Cargo.toml'
  )

  if (!existsSync(cargoTomlPath)) {
    return
  }

  const cargoLines = readFileSync(cargoTomlPath, 'utf8').split(/\r?\n/)
  let inPackageSection = false
  let updated = false

  const nextLines = cargoLines.map((line) => {
    if (/^\[package\]\s*$/.test(line)) {
      inPackageSection = true
      return line
    }

    if (inPackageSection && /^\[/.test(line)) {
      inPackageSection = false
      return line
    }

    if (inPackageSection && /^version\s*=\s*".*"\s*$/.test(line)) {
      const expectedLine = `version = "${version}"`
      if (line === expectedLine) {
        return line
      }
      updated = true
      return expectedLine
    }

    return line
  })

  if (!updated) {
    return
  }

  writeFileSync(cargoTomlPath, `${nextLines.join('\n')}\n`)
  touched.push(path.relative(rootDir, cargoTomlPath))
}

function syncDesktopInfoPlistVersion(version) {
  const infoPlistPath = path.join(
    rootDir,
    'packages',
    'desktop',
    'src-tauri',
    'Info.plist'
  )

  if (!existsSync(infoPlistPath)) {
    return
  }

  const current = readFileSync(infoPlistPath, 'utf8')

  const shortVersionPattern = /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]+)(<\/string>)/
  const bundleVersionPattern = /(<key>CFBundleVersion<\/key>\s*<string>)([^<]+)(<\/string>)/

  let next = current.replace(shortVersionPattern, `$1${version}$3`)
  next = next.replace(bundleVersionPattern, `$1${version}$3`)

  if (next === current) {
    return
  }

  writeFileSync(infoPlistPath, next)
  touched.push(path.relative(rootDir, infoPlistPath))
}

for (const workspacePath of workspacePaths) {
  const packagePath = path.join(rootDir, workspacePath, 'package.json')
  if (!existsSync(packagePath)) {
    continue
  }

  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  let changed = false

  if (pkg.version !== rootVersion) {
    pkg.version = rootVersion
    changed = true
  }

  for (const section of dependencySections) {
    const deps = pkg[section]
    if (!deps || typeof deps !== 'object') {
      continue
    }

    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@getpaseo/')) {
        continue
      }
      if (name === pkg.name) {
        continue
      }
      if (deps[name] !== rootVersion) {
        deps[name] = rootVersion
        changed = true
      }
    }
  }

  if (changed) {
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
    touched.push(path.relative(rootDir, packagePath))
  }
}

syncDesktopTauriConfigVersion(rootVersion)
syncDesktopCargoPackageVersion(rootVersion)
syncDesktopInfoPlistVersion(rootVersion)

if (touched.length === 0) {
  console.log(`Workspace versions and internal deps already synced to ${rootVersion}`)
} else {
  console.log(`Synced to ${rootVersion}:`)
  for (const file of touched) {
    console.log(`- ${file}`)
  }
}
