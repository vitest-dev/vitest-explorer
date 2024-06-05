import * as vscode from 'vscode'
import './polyfills'
import { version } from '../package.json'
import { getConfig, testControllerId } from './config'
import type { VitestAPI } from './api'
import { resolveVitestAPI } from './api'
import { TestRunner } from './runner/runner'
import { TestTree } from './testTree'
import { configGlob, workspaceGlob } from './constants'
import { log } from './log'
import { createVitestWorkspaceFile, debounce, noop, showVitestError } from './utils'
import { resolveVitestPackages } from './api/pkg'
import type { TestFile } from './testTreeData'
import { getTestData } from './testTreeData'
import { TagsManager } from './tagsManager'
import { coverageContext } from './coverage'
import { debugTests } from './debug/api'

export async function activate(context: vscode.ExtensionContext) {
  const extension = new VitestExtension()
  context.subscriptions.push(extension)
  await extension.activate()
}

export function deactivate() {}

class VitestExtension {
  private testController: vscode.TestController
  private loadingTestItem: vscode.TestItem

  private runProfiles = new Map<string, vscode.TestRunProfile>()

  private testTree: TestTree
  private tagsManager: TagsManager
  private api: VitestAPI | undefined

  private disposables: vscode.Disposable[] = []

  constructor() {
    log.info(`[v${version}] Vitest extension is activated because Vitest is installed or there is a Vite/Vitest config file in the workspace.`)

    this.testController = vscode.tests.createTestController(testControllerId, 'Vitest')
    this.testController.refreshHandler = () => this.defineTestProfiles(true).catch(() => {})
    this.testController.resolveHandler = item => this.resolveTestFile(item)
    this.loadingTestItem = this.testController.createTestItem('_resolving', 'Resolving Vitest...')
    this.loadingTestItem.sortText = '.0' // show it first
    this.testTree = new TestTree(this.testController, this.loadingTestItem)
    this.tagsManager = new TagsManager(this.testTree)
  }

  private async defineTestProfiles(showWarning: boolean) {
    // TODO: this function can be called multiple times in quick succession
    // we need to make sure that the previous call is cancelled/finished before starting a new one
    this.testTree.reset([])

    const vitest = await resolveVitestPackages(showWarning)

    if (!vitest.length) {
      log.error('[API]', 'Failed to start Vitest: No vitest config files found')
      this.testController.items.delete(this.loadingTestItem.id)

      await this.api?.dispose()
      return
    }

    const configFiles = vitest.filter(x => x.configFile && !x.workspaceFile)

    const maximumConfigs = getConfig().maximumConfigs ?? 3

    if (configFiles.length > maximumConfigs) {
      const warningMessage = `Vitest found multiple config files. The extension will use only the first ${maximumConfigs} due to performance concerns. Consider using a workspace configuration to group your configs.`
      // remove all but the first 3
      const discardedConfigs = configFiles.splice(maximumConfigs)

      if (configFiles.every(c => getConfig(c.folder).disableWorkspaceWarning !== true)) {
        vscode.window.showWarningMessage(
          warningMessage,
          'Create vitest.workspace.js',
          'Disable notification',
        ).then((result) => {
          if (result === 'Create vitest.workspace.js')
            createVitestWorkspaceFile(configFiles).catch(noop)

          if (result === 'Disable notification') {
            configFiles.forEach((c) => {
              const rootConfig = vscode.workspace.getConfiguration('vitest', c.folder)
              rootConfig.update('disableWorkspaceWarning', true)
            })
          }
        })
      }
      else {
        log.info(warningMessage)
        log.info(`Discarded config files: ${discardedConfigs.map(x => x.workspaceFile || x.configFile).join(', ')}`)
      }
    }

    const folders = new Set(vitest.map(x => x.folder))
    this.testTree.reset(Array.from(folders))

    const previousRunProfiles = this.runProfiles
    this.runProfiles = new Map()

    try {
      await this.api?.dispose()

      this.api = await resolveVitestAPI(showWarning, vitest)

      this.api.onUnexpectedExit((code) => {
        if (code) {
          showVitestError('Vitest process exited unexpectedly')
          this.testTree.reset([])
          this.testController.items.delete(this.loadingTestItem.id)
        }
        else {
          log.info('[API] Reloading API due to unexpected empty exit code. This usually happens when "Stop" is clicked during debugging instead of "Disconnect".')
          this.api?.dispose()
          this.api = undefined
          this.defineTestProfiles(false).catch(() => {})
        }
      })

      for (const api of this.api.folderAPIs) {
        await this.testTree.watchTestFilesInWorkspace(
          api,
          await api.getFiles(),
        )
      }
    }
    finally {
      this.testController.items.delete(this.loadingTestItem.id)
    }

    this.api.forEach((api) => {
      const runner = new TestRunner(
        this.testController,
        this.testTree,
        api,
      )

      const prefix = api.prefix
      let runProfile = previousRunProfiles.get(`${api.id}:run`)
      if (!runProfile) {
        runProfile = this.testController.createRunProfile(
          prefix,
          vscode.TestRunProfileKind.Run,
          () => {},
          false,
          undefined,
          true,
        )
      }
      runProfile.tag = api.tag
      runProfile.runHandler = (request, token) => runner.runTests(request, token)
      this.runProfiles.set(`${api.id}:run`, runProfile)
      let debugProfile = previousRunProfiles.get(`${api.id}:debug`)
      if (!debugProfile) {
        debugProfile = this.testController.createRunProfile(
          prefix,
          vscode.TestRunProfileKind.Debug,
          () => {},
          false,
          undefined,
          false, // continues debugging is not supported
        )
      }
      debugProfile.tag = api.tag
      debugProfile.runHandler = async (request, token) => {
        await debugTests(
          this.testController,
          this.testTree,
          api.package,

          request,
          token,
        )
      }
      this.runProfiles.set(`${api.id}:debug`, debugProfile)

      // coverage is supported since VS Code 1.88
      if (vscode.TestRunProfileKind.Coverage && 'FileCoverage' in vscode) {
        let coverageProfile = previousRunProfiles.get(`${api.id}:coverage`)
        if (!coverageProfile) {
          coverageProfile = this.testController.createRunProfile(
            prefix,
            vscode.TestRunProfileKind.Coverage,
            () => {},
            false,
            undefined,
            true,
          )
        }
        coverageProfile.tag = api.tag
        coverageProfile.runHandler = (request, token) => runner.runCoverage(request, token)
        coverageProfile.loadDetailedCoverage = coverageContext.loadDetailedCoverage
        this.runProfiles.set(`${api.id}:coverage`, coverageProfile)
      }
    })

    for (const [id, profile] of previousRunProfiles) {
      if (!this.runProfiles.has(id))
        profile.dispose()
    }

    // collect tests inside a test file
    vscode.window.visibleTextEditors.forEach(async (editor) => {
      const testItems = this.testTree.getFileTestItems(editor.document.uri.fsPath)
      const apis = new Set()
      for (const item of testItems) {
        const data = getTestData(item) as TestFile
        if (!apis.has(data.api)) {
          await this.resolveTestFile(item)
          apis.add(data.api)
        }
      }
    })
  }

  private async resolveTestFile(item?: vscode.TestItem) {
    if (!item)
      return
    try {
      await this.testTree.discoverFileTests(item)
    }
    catch (err) {
      showVitestError('There was an error during test discovery', err)
    }
  }

  async activate() {
    this.loadingTestItem.busy = true
    this.testController.items.replace([this.loadingTestItem])

    const reloadConfigNames = [
      'vitest.vitestPackagePath',
      'vitest.nodeExecutable',
      'vitest.workspaceConfig',
      'vitest.rootConfig',
    ]

    this.disposables = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (reloadConfigNames.some(x => event.affectsConfiguration(x)))
          this.defineTestProfiles(false)
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.defineTestProfiles(false)),
      vscode.commands.registerCommand('vitest.openOutput', () => {
        log.openOuput()
      }),
      vscode.commands.registerCommand('vitest.updateSnapshot', async (testItem: vscode.TestItem | undefined) => {
        if (!testItem)
          return
        const api = this.testTree.getAPIFromTestItem(testItem)
        if (!api)
          return
        const profile = this.runProfiles.get(`${api.id}:run`)
        if (!profile)
          return
        const request = new vscode.TestRunRequest(
          [testItem],
          undefined,
          profile,
          false,
        )
        Object.assign(request, { updateSnapshots: true })
        const tokenSource = new vscode.CancellationTokenSource()
        await profile.runHandler(request, tokenSource.token)
      }),
    ]

    // if the config changes, re-define all test profiles
    const configWatchers = [
      vscode.workspace.createFileSystemWatcher(configGlob),
      vscode.workspace.createFileSystemWatcher(workspaceGlob),
      vscode.workspace.createFileSystemWatcher('**/package.json'),
    ]
    this.disposables.push(...configWatchers)

    const redefineTestProfiles = debounce((uri: vscode.Uri) => {
      if (uri.fsPath.includes('node_modules') || uri.fsPath.includes('.timestamp-'))
        return
      this.defineTestProfiles(false)
    }, 300)

    configWatchers.forEach(watcher => watcher.onDidChange(redefineTestProfiles))
    configWatchers.forEach(watcher => watcher.onDidCreate(redefineTestProfiles))
    configWatchers.forEach(watcher => watcher.onDidDelete(redefineTestProfiles))

    try {
      await this.defineTestProfiles(true)

      this.tagsManager.activate()
    }
    catch (err) {
      showVitestError('There was an error during Vitest startup', err)
    }
  }

  async dispose() {
    this.api?.dispose()
    this.testTree.dispose()
    this.tagsManager.dispose()
    this.testController.dispose()
    this.runProfiles.forEach(profile => profile.dispose())
    this.disposables.forEach(d => d.dispose())
  }
}
