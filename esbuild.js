const fs = require('node:fs/promises')
const path = require('node:path')
const process = require('node:process')
const esbuild = require('esbuild')

const watch = process.argv.includes('--watch')
const production = process.argv.includes('--production')

/**
 * 创建 esbuild 问题匹配插件。
 *
 * type 用于区分当前构建通道：extension、media 或 l10n。
 *
 * @param {'extension' | 'media' | 'l10n'} type
 * @returns {import('esbuild').Plugin} 问题匹配插件
 */
function esbuildProblemMatcherPlugin(type) {
  return {
    name: `esbuild-problem-matcher-${type}`,
    setup(build) {
      build.onStart(() => {
        console.log(`[watch] ${type} 开始构建`)
      })
      build.onEnd((result) => {
        result.errors.forEach(({ text, location }) => {
          console.error(`✘ [${type.toUpperCase()} ERROR] ${text}`)
          if (location)
            console.error(`    ${location.file}:${location.line}:${location.column}:`)
        })
        console.log(`[watch] ${type} 构建完成`)
      })
    },
  }
}

/**
 * 构建本地化资源的 esbuild 插件。
 *
 * esbuild 默认会把 JSON entry 编译成 JS 模块，copy loader 又不会压缩 JSON。
 * 这里使用虚拟入口接入 esbuild watch 生命周期，并手动输出压缩后的 JSON 文件。
 *
 * @type {import('esbuild').Plugin}
 */
const esbuildL10nBundlePlugin = {
  name: 'esbuild-l10n-bundle',
  setup(build) {
    build.onResolve(
      {
        filter: /^l10n$/,
      },
      () => ({
        path: 'l10n',
        namespace: 'l10n-bundle',
        watchDirs: ['l10n'],
      }),
    )
    build.onLoad(
      {
        filter: /^l10n$/,
        namespace: 'l10n-bundle',
      },
      async () => {
        const files = await buildL10n()
        return {
          contents: '',
          loader: 'js',
          watchDirs: ['l10n'],
          watchFiles: files,
        }
      },
    )
  },
}

/**
 * 清理媒体资源输出目录的 esbuild 插件。
 *
 * media 使用 glob entry points；每次重建前清空 dist/media，
 * 避免删除源文件后旧产物残留。
 *
 * @type {import('esbuild').Plugin}
 */
const esbuildCleanMediaPlugin = {
  name: 'esbuild-clean-media',
  setup(build) {
    build.onStart(() => {
      return fs.rm('dist/media', { recursive: true, force: true })
    })
  },
}

/**
 * 构建压缩后的 l10n 本地化资源。
 */
async function buildL10n() {
  const outDir = 'dist/l10n'
  const entries = (await fs.readdir('l10n')).filter(file => file.endsWith('.json'))
  const bundles = await Promise.all(entries.map(async (file) => {
    const sourcePath = path.join('l10n', file)
    const source = await fs.readFile(sourcePath, 'utf8')
    return [sourcePath, file, JSON.stringify(JSON.parse(source))]
  }))

  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })
  await Promise.all(bundles.map(([, file, minified]) => fs.writeFile(path.join(outDir, file), `${minified}\n`)))
  return bundles.map(([sourcePath]) => sourcePath)
}

async function main() {
  const contexts = await Promise.all([
    esbuild.context({
      entryPoints: [
        'src/extension.ts',
      ],
      bundle: true,
      format: 'cjs',
      minify: production,
      sourcemap: !production,
      sourcesContent: false,
      platform: 'node',
      outfile: 'dist/extension.js',
      external: ['vscode'],
      logLevel: 'silent',
      plugins: [
        esbuildProblemMatcherPlugin('extension'),
      ],
    }),
    esbuild.context({
      entryPoints: [
        'media/**/*.js',
        'media/**/*.css',
      ],
      bundle: false,
      minify: production,
      sourcemap: !production,
      sourcesContent: false,
      platform: 'browser',
      outbase: 'media',
      outdir: 'dist/media',
      entryNames: '[dir]/[name]',
      logLevel: 'silent',
      plugins: [
        esbuildProblemMatcherPlugin('media'),
        esbuildCleanMediaPlugin,
      ],
    }),
    esbuild.context({
      entryPoints: [
        'l10n',
      ],
      bundle: true,
      write: false,
      logLevel: 'silent',
      plugins: [
        esbuildProblemMatcherPlugin('l10n'),
        esbuildL10nBundlePlugin,
      ],
    }),
  ])
  if (watch) {
    await Promise.all(contexts.map(ctx => ctx.watch()))
  }
  else {
    await Promise.all(contexts.map(ctx => ctx.rebuild()))
    await Promise.all(contexts.map(ctx => ctx.dispose()))
  }
}

main().catch((e) => {
  console.error('构建失败：')
  console.error(e)
  process.exit(1)
})
