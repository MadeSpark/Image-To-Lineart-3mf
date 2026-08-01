import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const versionFilePath = path.join(rootDir, 'version.json')
const packageJsonPath = path.join(rootDir, 'package.json')
const packageLockPath = path.join(rootDir, 'package-lock.json')

if (!fs.existsSync(versionFilePath)) {
  throw new Error(`找不到版本文件：${versionFilePath}`)
}

const { version } = JSON.parse(fs.readFileSync(versionFilePath, 'utf8'))

if (typeof version !== 'string' || !version.trim()) {
  throw new Error('version.json 中缺少有效的 version 字段')
}

const normalizedVersion = version.trim()

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
if (packageJson.version !== normalizedVersion) {
  packageJson.version = normalizedVersion
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
}

if (fs.existsSync(packageLockPath)) {
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'))
  packageLock.version = normalizedVersion
  if (packageLock.packages?.['']) {
    packageLock.packages[''].version = normalizedVersion
  }
  fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, 'utf8')
}

console.log(`已同步版本号：${normalizedVersion}`)
