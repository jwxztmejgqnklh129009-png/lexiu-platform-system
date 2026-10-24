import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const files = [
  'warehouse-store-and-upload-check.cjs',
  'warehouse-inventory-form-check.cjs',
  'warehouse-asset-logs-check.cjs',
  'record-form-router-regression.mjs',
  'drinks-accounts-store-check.cjs',
  'drinks-preview-check.cjs',
  'reset-storage-check.cjs',
]

for (const file of files) {
  console.log(`\nRunning ${file}`)
  const result = spawnSync(process.execPath, [`tests/demo/${file}`], { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status || 1)
}

console.log(`\nAll ${files.length} isolated demo regression scripts passed.`)
