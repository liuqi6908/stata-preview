/**
 * VS Code 扩展入口。
 *
 * 负责在扩展激活时注册 Stata .dta 自定义编辑器。
 */

import type { ExtensionContext } from 'vscode'
import { l10n } from 'vscode'
import { DtaEditorProvider } from './editor/dtaEditorProvider'

// ---------- 生命周期 ----------

/**
 * 扩展激活入口
 */
export function activate(context: ExtensionContext) {
  console.log(l10n.t('Stata Preview is now active!'))
  context.subscriptions.push(DtaEditorProvider.register(context))
}

/**
 * 扩展停用入口
 */
export function deactivate() {}
