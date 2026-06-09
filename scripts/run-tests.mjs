import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

/** 当前脚本所在目录。 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根目录。 */
const root = path.resolve(__dirname, '..')
/** 测试源码目录。 */
const testDir = path.join(root, 'test')

/**
 * 递归收集所有 TypeScript 测试入口。
 */
async function collectTestFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory())
      return collectTestFiles(fullPath)
    return /\.test\.ts$/.test(entry.name) ? [fullPath] : []
  }))
  return files.flat().sort()
}

/**
 * 为纯逻辑单测提供最小 VS Code API stub。
 *
 * 测试目标模块会 import `vscode`，但 Node 测试环境中没有真实扩展宿主；
 * 这里仅模拟当前测试实际会触达的 l10n、Uri、window 和 workspace 能力。
 */
function vscodeStubPlugin() {
  return {
    name: 'vscode-stub',
    setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({
        path: 'vscode',
        namespace: 'vscode-stub',
      }))
      build.onLoad({ filter: /^vscode$/, namespace: 'vscode-stub' }, () => ({
        loader: 'js',
        contents: `
          const format = (message, ...args) => String(message).replace(/\\{(\\d+)\\}/g, (_, i) => args[Number(i)] ?? '')
          exports.l10n = { t: format }
          exports.ProgressLocation = { Notification: 15 }
          exports.Uri = {
            file: (fsPath) => ({ scheme: 'file', fsPath, path: fsPath, toString: () => fsPath }),
            joinPath: (base, ...parts) => ({ ...base, path: [base.path || base.fsPath || '', ...parts].join('/') }),
          }
          exports.window = {
            showSaveDialog: async () => undefined,
            withProgress: async (_options, task) => task(),
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
          }
          exports.workspace = {
            fs: {
              stat: async () => ({ size: 0, mtime: 0 }),
              readFile: async () => new Uint8Array(),
              writeFile: async () => undefined,
            },
            workspaceFolders: [],
          }
          exports.env = { language: 'en' }
        `,
      }))
    },
  }
}

/**
 * 将测试源码临时打包为 CommonJS，再交给 Node 内置测试运行器执行。
 */
async function main() {
  const testFiles = await collectTestFiles(testDir)
  if (testFiles.length === 0) {
    console.error('未找到测试文件。')
    process.exit(1)
  }

  // 测试 bundle 写入系统临时目录，避免在仓库中留下构建产物。
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stata-preview-tests-'))
  const entryFile = path.join(tmpDir, 'entry.ts')
  const bundleFile = path.join(tmpDir, 'tests.cjs')
  const imports = testFiles.map(file => `import ${JSON.stringify(file)}`).join('\n')
  await fs.writeFile(entryFile, `${imports}\n`)

  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundleFile,
    sourcemap: 'inline',
    logLevel: 'silent',
    plugins: [vscodeStubPlugin()],
  })

  const child = spawn(process.execPath, ['--test', bundleFile], {
    cwd: root,
    stdio: 'inherit',
  })

  const code = await new Promise(resolve => child.on('close', resolve))
  process.exit(code ?? 1)
}

main().catch((e) => {
  console.error('测试运行失败：')
  console.error(e)
  process.exit(1)
})
