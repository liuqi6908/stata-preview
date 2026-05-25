import type * as vscode from 'vscode'
import { DtaEditorProvider } from './editorProvider'

export function activate(context: vscode.ExtensionContext) {
  console.log('Stata Preview is now active!')
  context.subscriptions.push(DtaEditorProvider.register(context))
}

export function deactivate() { }
