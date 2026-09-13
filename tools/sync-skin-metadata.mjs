import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const thisFilePath = fileURLToPath(import.meta.url)
const rootDir = path.resolve(path.dirname(thisFilePath), '..')

const sourceSkinsDir = path.join(rootDir, 'apps', 'viewer', 'public', 'skins')
const targetSkinsDirs = [
  path.join(rootDir, 'apps', 'control', 'public', 'skins'),
  path.join(rootDir, 'apps', 'overlay', 'public', 'skins'),
]

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function syncSkinMetadata() {
  const sourceExists = await fileExists(sourceSkinsDir)
  if (!sourceExists) {
    throw new Error(`Viewer skins directory not found: ${sourceSkinsDir}`)
  }

  for (const targetDir of targetSkinsDirs) {
    await fs.mkdir(targetDir, { recursive: true })
  }

  const entries = await fs.readdir(sourceSkinsDir, { withFileTypes: true })
  let syncedCount = 0

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const skinId = entry.name
    const sourceSkinJson = path.join(sourceSkinsDir, skinId, 'skin.json')
    const hasMetadata = await fileExists(sourceSkinJson)
    if (!hasMetadata) {
      continue
    }

    const skinJsonContent = await fs.readFile(sourceSkinJson, 'utf8')

    // Validate that the source metadata is valid JSON before mirroring.
    JSON.parse(skinJsonContent)

    for (const targetSkinsDir of targetSkinsDirs) {
      const targetSkinDir = path.join(targetSkinsDir, skinId)
      await fs.mkdir(targetSkinDir, { recursive: true })
      const targetSkinJson = path.join(targetSkinDir, 'skin.json')
      await fs.writeFile(targetSkinJson, skinJsonContent, 'utf8')
    }

    syncedCount += 1
  }

  console.log(`[sync-skin-metadata] Mirrored metadata for ${syncedCount} skin(s).`)
}

await syncSkinMetadata()