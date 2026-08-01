import { build } from 'vite'

try {
  await build()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
