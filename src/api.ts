import type { ChildProcess } from 'node:child_process'
import { fork } from 'node:child_process'
import { gte } from 'semver'
import { dirname, normalize } from 'pathe'
import * as vscode from 'vscode'
import { log } from './log'
import { configGlob, minimumVersion, workerPath } from './constants'
import { getConfig } from './config'
import type { BirpcEvents, VitestEvents, VitestRPC } from './api/rpc'
import { createVitestRpc } from './api/rpc'
import { resolveVitestPackage } from './api/resolve'
import type { TestTree } from './testTree'

const _require = require

export class VitestReporter {
  constructor(
    protected folderFsPath: string,
    protected handlers: ResolvedMeta['handlers'],
  ) {}

  onConsoleLog = this.createHandler('onConsoleLog')
  onTaskUpdate = this.createHandler('onTaskUpdate')
  onFinished = this.createHandler('onFinished')
  onCollected = this.createHandler('onCollected')
  onWatcherStart = this.createHandler('onWatcherStart')
  onWatcherRerun = this.createHandler('onWatcherRerun')

  clearListeners(name?: Exclude<keyof ResolvedMeta['handlers'], 'clearListeners' | 'removeListener'>) {
    if (name)
      this.handlers.removeListener(name, this.handlers[name])

    this.handlers.clearListeners()
  }

  private createHandler<K extends Exclude<keyof ResolvedMeta['handlers'], 'clearListeners' | 'removeListener'>>(name: K) {
    return (callback: VitestEvents[K]) => {
      this.handlers[name]((folder, ...args) => {
        if (folder === this.folderFsPath)
          (callback as any)(...args)
      })
    }
  }
}

export interface FilesMap {
  api: VitestFolderAPI
  files: string[]
}

export class VitestAPI {
  constructor(
    private readonly api: VitestFolderAPI[],
    private readonly meta: ResolvedMeta,
  ) {}

  forEach<T>(callback: (api: VitestFolderAPI, index: number) => T) {
    return this.api.forEach(callback)
  }

  getFiles(): Promise<FilesMap[]> {
    const promises = this.api.map(async (api) => {
      const files = await api.getFiles()
      return {
        api,
        files,
      }
    })
    return Promise.all(promises)
  }

  async isTestFile(file: string) {
    return this.meta.rpc.isTestFile(file)
  }

  async dispose() {
    this.forEach(api => api.dispose())
    await this.meta.rpc.close()
    this.meta.process.kill()
  }
}

const WEAKMAP_API_FOLDER = new WeakMap<VitestFolderAPI, vscode.WorkspaceFolder>()

export class VitestFolderAPI extends VitestReporter {
  constructor(
    folder: vscode.WorkspaceFolder,
    private meta: ResolvedMeta,
    public readonly configFile: string,
  ) {
    super(normalize(folder.uri.fsPath), meta.handlers)
    WEAKMAP_API_FOLDER.set(this, folder)
    this.configFile = normalize(configFile)
  }

  get processId() {
    return this.meta.process.pid
  }

  get workspaceFolder() {
    return WEAKMAP_API_FOLDER.get(this)!
  }

  isTestFile(file: string) {
    return this.meta.rpc.isTestFile(file)
  }

  async runFiles(files?: string[], testNamePatern?: string) {
    await this.meta.rpc.runTests(this.configFile, files?.map(normalize), testNamePatern)
  }

  getFiles() {
    return this.meta.rpc.getFiles(this.configFile)
  }

  async collectTests(testFile: string) {
    await this.meta.rpc.collectTests(this.configFile, normalize(testFile))
  }

  dispose() {
    WEAKMAP_API_FOLDER.delete(this)
    this.handlers.clearListeners()
  }

  async cancelRun() {
    await this.meta.rpc.cancelRun(this.configFile)
  }

  stopInspect() {
    return this.meta.rpc.stopInspect()
  }

  startInspect(port: number) {
    return this.meta.rpc.startInspect(port)
  }
}

export async function resolveVitestAPI(tree: TestTree, meta: VitestMeta[]) {
  const vitest = await createVitestProcess(tree, meta)
  const apis = meta.map(({ folder, configFile }) =>
    new VitestFolderAPI(folder, vitest, configFile),
  )
  return new VitestAPI(apis, vitest)
}

interface ResolvedMeta {
  rpc: VitestRPC
  process: ChildProcess
  handlers: {
    onConsoleLog: (listener: BirpcEvents['onConsoleLog']) => void
    onTaskUpdate: (listener: BirpcEvents['onTaskUpdate']) => void
    onFinished: (listener: BirpcEvents['onFinished']) => void
    onCollected: (listener: BirpcEvents['onCollected']) => void
    onWatcherStart: (listener: BirpcEvents['onWatcherStart']) => void
    onWatcherRerun: (listener: BirpcEvents['onWatcherRerun']) => void
    clearListeners: () => void
    removeListener: (name: string, listener: any) => void
  }
}

function nonNullable<T>(value: T | null | undefined): value is T {
  return value != null
}

interface VitestMeta {
  folder: vscode.WorkspaceFolder
  vitestNodePath: string
  configFile: string
  version: string
  loader?: string
  pnp?: string
}

export async function resolveVitestPackages(showWarning: boolean): Promise<VitestMeta[]> {
  const configs = await vscode.workspace.findFiles(configGlob, '**/node_modules/**')

  if (!configs.length)
    log.error('[API]', 'Failed to start Vitest: No vitest config files found')

  return configs.map((configFile) => {
    const folder = vscode.workspace.getWorkspaceFolder(configFile)!
    const vitest = resolveVitestPackage(folder)

    if (!vitest) {
      if (showWarning)
        vscode.window.showWarningMessage('Vitest not found. Please run `npm i --save-dev vitest` to install Vitest.')
      log.error('[API]', `Vitest not found for ${configFile.fsPath}.`)
      return null
    }

    if (vitest.pnp) {
      // TODO: try to load vitest package version from pnp
      return {
        folder,
        configFile: normalize(configFile.fsPath),
        vitestNodePath: vitest.vitestNodePath,
        version: 'pnp',
        loader: vitest.pnp.loaderPath,
        pnp: vitest.pnp.pnpPath,
      }
    }

    const pkg = _require(vitest.vitestPackageJsonPath)
    if (!gte(pkg.version, minimumVersion)) {
      const warning = `Vitest v${pkg.version} is not supported. Vitest v${minimumVersion} or newer is required.`
      if (showWarning)
        vscode.window.showWarningMessage(warning)
      else
        log.error('[API]', `[${folder}] Vitest v${pkg.version} is not supported. Vitest v${minimumVersion} or newer is required.`)
      return null
    }

    return {
      folder,
      configFile: normalize(configFile.fsPath),
      vitestNodePath: vitest.vitestNodePath,
      version: pkg.version,
    }
  }).filter(nonNullable)
}

function createChildVitestProcess(tree: TestTree, meta: VitestMeta[]) {
  const pnpLoaders = [
    ...new Set(meta.map(meta => meta.loader).filter(Boolean) as string[]),
  ]
  const pnp = meta.find(meta => meta.pnp)?.pnp as string
  if (pnpLoaders.length > 1)
    throw new Error(`Multiple loaders are not supported: ${pnpLoaders.join(', ')}`)
  if (pnpLoaders.length && !pnp)
    throw new Error('pnp file is required if loader option is used')
  const execArgv = pnpLoaders[0] && !gte(process.version, '18.19.0')
    ? [
        '--require',
        pnp,
        '--experimental-loader',
        pnpLoaders[0],
      ]
    : undefined
  const vitest = fork(
    workerPath,
    {
      execPath: getConfig().nodeExecutable,
      execArgv,
      env: {
        VITEST_VSCODE: 'true',
      },
      stdio: 'overlapped',
      cwd: pnp ? dirname(pnp) : undefined,
    },
  )
  return new Promise<ChildProcess>((resolve, reject) => {
    vitest.on('error', (error) => {
      log.error('[API]', error)
      reject(error)
    })
    vitest.on('message', function ready(message: any) {
      if (message.type === 'debug')
        log.info('[WORKER]', ...message.args)

      if (message.type === 'ready') {
        vitest.off('message', ready)
        // started _some_ projects, but some failed - log them, this can only happen if there are multiple projects
        if (message.errors.length) {
          message.errors.forEach(([configFile, error]: [string, string]) => {
            const metaIndex = meta.findIndex(m => m.configFile === configFile)
            const metaItem = meta[metaIndex]
            const workspaceItem = tree.getOrCreateWorkspaceFolderItem(metaItem.folder.uri)
            workspaceItem.error = error // display error message in the tree
            workspaceItem.canResolveChildren = false
            meta.splice(metaIndex, 1)
            log.error('[API]', `Vitest failed to start for ${configFile}: \n${error}`)
          })
        }
        resolve(vitest)
      }
      if (message.type === 'error') {
        vitest.off('message', ready)
        const error = new Error(`Vitest failed to start: \n${message.errors.map((r: any) => r[1]).join('\n')}`)
        reject(error)
      }
    })
    vitest.on('spawn', () => {
      vitest.send({
        type: 'init',
        meta: meta.map(m => ({
          vitestNodePath: m.vitestNodePath,
          folder: normalize(m.folder.uri.fsPath),
          env: getConfig(m.folder).env || undefined,
          configFile: m.configFile,
        })),
        loader: pnpLoaders[0] && gte(process.version, '18.19.0') ? pnpLoaders[0] : undefined,
      })
    })
  })
}

export async function createVitestProcess(tree: TestTree, meta: VitestMeta[]): Promise<ResolvedMeta> {
  log.info('[API]', `Running Vitest: ${meta.map(x => `v${x.version} (${x.folder.name})`).join(', ')}`)

  const vitest = await createChildVitestProcess(tree, meta)

  log.info('[API]', `Vitest process ${vitest.pid} created`)

  vitest.stdout?.on('data', d => log.info('[Worker]', d.toString()))
  vitest.stderr?.on('data', d => log.error('[Worker]', d.toString()))

  const { handlers, api } = createVitestRpc(vitest)

  return {
    rpc: api,
    process: vitest,
    handlers,
  }
}
