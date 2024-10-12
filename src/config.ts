import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { WorkspaceConfiguration, WorkspaceFolder } from 'vscode'
import * as vscode from 'vscode'

export const extensionId = 'vitest.explorer'
export const testControllerId = 'vitest'

export function getConfigValue<T>(
  rootConfig: WorkspaceConfiguration,
  folderConfig: WorkspaceConfiguration,
  key: string,
  defaultValue?: T,
): T | undefined {
  if (typeof defaultValue === 'boolean') {
    return folderConfig.get(key) ?? rootConfig.get(key) ?? defaultValue
  }
  return folderConfig.get(key) || rootConfig.get(key) || defaultValue
}

export function getConfig(workspaceFolder?: WorkspaceFolder) {
  if (!workspaceFolder && vscode.workspace.workspaceFolders?.length === 1)
    workspaceFolder = vscode.workspace.workspaceFolders[0]

  const folderConfig = vscode.workspace.getConfiguration('vitest', workspaceFolder)
  const rootConfig = vscode.workspace.getConfiguration('vitest')

  const get = <T>(key: string, defaultValue?: T) => getConfigValue<T>(
    rootConfig,
    folderConfig,
    key,
    defaultValue,
  )

  const nodeExecutable = get<string | undefined>('nodeExecutable')
  const workspaceConfig = get<string | undefined>('workspaceConfig')
  const rootConfigFile = get<string | undefined>('rootConfig')

  const configSearchPatternExclude = get<string>(
    'configSearchPatternExclude',
    '{**/node_modules/**,**/.*/**,**/*.d.ts}',
  )!

  const vitestPackagePath = get<string | undefined>('vitestPackagePath')
  const resolvedVitestPackagePath = workspaceFolder && vitestPackagePath
    ? resolve(
      workspaceFolder.uri.fsPath,
      // eslint-disable-next-line no-template-curly-in-string
      vitestPackagePath.replace('${workspaceFolder}', workspaceFolder.uri.fsPath),
    )
    : vitestPackagePath

  const logLevel = get<string>('logLevel', 'info')

  const filesWatcherInclude = get<string>('filesWatcherInclude', '**/*')!

  const terminalShellArgs = get<string[] | undefined>('terminalShellArgs')
  const terminalShellPath = get<string | undefined>('terminalShellPath')
  const shellType = get<'child_process' | 'terminal'>('shellType', 'child_process')
  const nodeExecArgs = get<string[] | undefined>('nodeExecArgs')

  const previewBrowser = get<boolean>('previewBrowser', false)

  return {
    env: get<null | Record<string, string>>('nodeEnv', null),
    debugExclude: get<string[]>('debugExclude', []),
    filesWatcherInclude,
    previewBrowser,
    terminalShellArgs,
    terminalShellPath,
    shellType,
    nodeExecArgs,
    vitestPackagePath: resolvedVitestPackagePath,
    workspaceConfig: resolveConfigPath(workspaceConfig),
    rootConfig: resolveConfigPath(rootConfigFile),
    configSearchPatternExclude,
    maximumConfigs: get<number>('maximumConfigs', 3),
    nodeExecutable: resolveConfigPath(nodeExecutable),
    disableWorkspaceWarning: get<boolean>('disableWorkspaceWarning', false),
    debuggerPort: get<number>('debuggerPort') || undefined,
    debuggerAddress: get<string>('debuggerAddress', undefined) || undefined,
    logLevel,
  }
}

export function resolveConfigPath(path: string | undefined) {
  if (!path || isAbsolute(path))
    return path
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2))
  }
  // if there is a workspace file, then it should be relative to it because
  // this option cannot be configured on a workspace folder level
  if (vscode.workspace.workspaceFile)
    return resolve(dirname(vscode.workspace.workspaceFile.fsPath), path)
  const workspaceFolders = vscode.workspace.workspaceFolders
  // if there is no workspace file, then it's probably a single folder workspace
  if (workspaceFolders?.length === 1)
    return resolve(workspaceFolders[0].uri.fsPath, path)
  // if there are still several folders, then we can't reliably resolve the path
  return path
}
