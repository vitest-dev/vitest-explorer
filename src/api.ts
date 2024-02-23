import { Worker } from 'node:worker_threads'
import { type Server, createServer } from 'node:net'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import type * as vscode from 'vscode'
import { dirname, resolve } from 'pathe'
import { type BirpcReturn, createBirpc } from 'birpc'
import type { File, ResolvedConfig, TaskResultPack, UserConsoleLog } from 'vitest'
import { parse, stringify } from 'flatted'
import { log } from './log'
import { workerPath } from './constants'
import type { DebugSessionAPI } from './debug/startSession'
import { startDebugSession } from './debug/startSession'
import {} from 'node-ipc'

const _require = require

// import { getConfig, getRootConfig } from './config'

export interface BirpcMethods {
  getFiles: () => Promise<string[]>
  runFiles: (files?: string[], testNamePattern?: string) => Promise<void>
  getConfig: () => Promise<ResolvedConfig>
  isTestFile: (file: string) => Promise<boolean>
  terminate: () => void
}

export interface BirpcEvents {
  onReady: () => void
  onError: (err: object) => void

  onConsoleLog: (log: UserConsoleLog) => void
  onTaskUpdate: (task: TaskResultPack[]) => void
  onFinished: (files?: File[], errors?: unknown[]) => void
  onCollected: (files?: File[]) => void
  onWatcherStart: (files?: File[], errors?: unknown[]) => void
  onWatcherRerun: (files: string[], trigger?: string) => void
}

type VitestRPC = BirpcReturn<BirpcMethods, BirpcEvents>

function resolveVitestPackagePath(workspace: vscode.WorkspaceFolder) {
  try {
    return require.resolve('vitest/package.json', {
      paths: [workspace.uri.fsPath],
    })
  }
  catch (err: any) {
    log.info('[API]', `Vitest not found in "${workspace.name}" workspace folder`)
    return null
  }
}

function resolveVitestNodePath(vitestPkgPath: string) {
  return resolve(dirname(vitestPkgPath), './dist/node.js')
}

export class VitestReporter {
  constructor(
    protected handlers: ResolvedRPC['handlers'],
  ) {}

  onConsoleLog = this.createHandler('onConsoleLog')
  onTaskUpdate = this.createHandler('onTaskUpdate')
  onFinished = this.createHandler('onFinished')
  onCollected = this.createHandler('onCollected')
  onWatcherStart = this.createHandler('onWatcherStart')
  onWatcherRerun = this.createHandler('onWatcherRerun')

  clearListeners() {
    this.handlers.clearListeners()
  }

  private createHandler<K extends Exclude<keyof ResolvedRPC['handlers'], 'clearListeners'>>(name: K) {
    return (callback: BirpcEvents[K]) => {
      this.handlers[name](callback as any)
    }
  }
}

export class VitestAPI {
  constructor(
    protected api: VitestFolderAPI[],
  ) {}

  get enabled() {
    return this.api.length > 0
  }

  get length() {
    return this.api.length
  }

  get(folder: vscode.WorkspaceFolder) {
    return this.api.find(api => api.folder === folder)!
  }

  filter(callback: (api: VitestFolderAPI, index: number) => boolean) {
    return this.api.filter(callback)
  }

  map<T>(callback: (api: VitestFolderAPI, index: number) => T) {
    return this.api.map(callback)
  }

  forEach<T>(callback: (api: VitestFolderAPI, index: number) => T) {
    return this.api.forEach(callback)
  }

  async getTestFileData(file: string) {
    for (const rpc of this.api) {
      if (await rpc.isTestFile(file)) {
        return {
          folder: rpc.folder,
        }
      }
    }
    return null
  }

  dispose() {
    // TODO: terminate?
  }
}

const WEAKMAP_API_FOLDER = new WeakMap<VitestFolderAPI, vscode.WorkspaceFolder>()

export class VitestFolderAPI extends VitestReporter {
  constructor(
    folder: vscode.WorkspaceFolder,
    private rpc: VitestRPC,
    handlers: ResolvedRPC['handlers'],
    private debug?: DebugSessionAPI,
  ) {
    super(handlers)
    WEAKMAP_API_FOLDER.set(this, folder)
  }

  get folder() {
    return WEAKMAP_API_FOLDER.get(this)!
  }

  getFiles() {
    return this.rpc.getFiles()
  }

  runFiles(files?: string[], testNamePattern?: string) {
    return this.rpc.runFiles(files, testNamePattern)
  }

  isTestFile(file: string) {
    return this.rpc.isTestFile(file)
  }

  stopDebugger() {
    this.debug?.stop()
  }

  dispose() {
    // TODO: terminate?
  }
}

export async function resolveVitestAPI(folders: readonly vscode.WorkspaceFolder[]) {
  const apis = await Promise.all(folders.map(async (folder) => {
    const api = await createVitestRPC(folder)
    if (!api)
      return null
    return new VitestFolderAPI(folder, api.rpc, api.handlers)
  }))
  return new VitestAPI(apis.filter(x => x !== null) as VitestFolderAPI[])
}

function getIPCSocket() {
  let path = 'vitest-explorer.sock'
  if (process.platform === 'win32')
    path = `\\\\.\\pipe\\${path}`
  else
    path = resolve(__dirname, path)
  if (!existsSync(dirname(path)))
    mkdirSync(dirname(path), { recursive: true })
  // cleanup socket
  if (existsSync(path))
    rmSync(path)
  return path
}

export function createIPCServer() {
  const socket = getIPCSocket()
  const server = createServer().listen(socket)
  return {
    server,
    socket,
  }
}

export async function resolveVitestDebugAPI(server: Server, socketPath: string, folders: readonly vscode.WorkspaceFolder[]) {
  const apis = await Promise.all(folders.map(async (folder) => {
    const api = await createVitestDebugRpc(server, socketPath, folder)
    if (!api)
      return null
    return new VitestFolderAPI(folder, api.rpc, api.handlers, api.debug)
  }))
  return new VitestAPI(apis.filter(x => x !== null) as VitestFolderAPI[])
}

interface ResolvedRPC {
  rpc: VitestRPC
  version: string
  handlers: {
    onConsoleLog: (listener: BirpcEvents['onConsoleLog']) => void
    onTaskUpdate: (listener: BirpcEvents['onTaskUpdate']) => void
    onFinished: (listener: BirpcEvents['onFinished']) => void
    onCollected: (listener: BirpcEvents['onCollected']) => void
    onWatcherStart: (listener: BirpcEvents['onWatcherStart']) => void
    onWatcherRerun: (listener: BirpcEvents['onWatcherRerun']) => void
    clearListeners: () => void
  }
}

interface ResolvedDebugRPC {
  rpc: VitestRPC
  version: string
  debug: DebugSessionAPI
  handlers: {
    onConsoleLog: (listener: BirpcEvents['onConsoleLog']) => void
    onTaskUpdate: (listener: BirpcEvents['onTaskUpdate']) => void
    onFinished: (listener: BirpcEvents['onFinished']) => void
    onCollected: (listener: BirpcEvents['onCollected']) => void
    onWatcherStart: (listener: BirpcEvents['onWatcherStart']) => void
    onWatcherRerun: (listener: BirpcEvents['onWatcherRerun']) => void
    clearListeners: () => void
  }
}

function createHandler<T extends (...args: any) => any>() {
  const handlers: T[] = []
  return {
    handlers,
    register: (listener: any) => handlers.push(listener),
    trigger: (data: any) => handlers.forEach(handler => handler(data)),
    clear: () => handlers.length = 0,
  }
}

export async function createVitestDebugRpc(server: Server, socketPath: string, folder: vscode.WorkspaceFolder): Promise<ResolvedDebugRPC | null> {
  const vitestPackagePath = resolveVitestPackagePath(folder)
  if (!vitestPackagePath)
    return null
  const pkg = _require(vitestPackagePath)
  const vitestNodePath = resolveVitestNodePath(vitestPackagePath)
  log.info('[API][DEBUG]', `Running Vitest ${pkg.version} for "${folder.name}" workspace folder from ${vitestNodePath}`)

  const onConsoleLog = createHandler<BirpcEvents['onConsoleLog']>()
  const onTaskUpdate = createHandler<BirpcEvents['onTaskUpdate']>()
  const onFinished = createHandler<BirpcEvents['onFinished']>()
  const onCollected = createHandler<BirpcEvents['onCollected']>()
  const onWatcherRerun = createHandler<BirpcEvents['onWatcherRerun']>()
  const onWatcherStart = createHandler<BirpcEvents['onWatcherStart']>()

  return new Promise<ResolvedDebugRPC | null>((resolve) => {
    const debug = startDebugSession(
      folder,
      socketPath,
      vitestNodePath,
    )

    server.on('connection', function connection(socket) {
      socket.on('data', function ready(buffer) {
        const data = JSON.parse(buffer.toString('utf-8'))
        if (data.type === 'ready' && data.root === folder.uri.fsPath) {
          socket.off('data', ready)
          server.off('connection', connection)
          const api = createBirpc<BirpcMethods, BirpcEvents>(
            {
              onReady() {
                // not called
              },
              onError(err: any) {
                log.error('[API]', err?.stack)
                resolve(null)
              },
              onConsoleLog: onConsoleLog.trigger,
              onFinished: onFinished.trigger,
              onTaskUpdate: onTaskUpdate.trigger,
              onCollected: onCollected.trigger,
              onWatcherRerun: onWatcherRerun.trigger,
              onWatcherStart: onWatcherStart.trigger,
            },
            {
              on(listener) {
                socket.on('data', (data) => {
                  data.toString('utf-8').split('$~0~$').forEach((message) => {
                    if (message)
                      listener(message)
                  })
                })
              },
              post(message) {
                // We add "$~0~$" to the end of the message to split it on the other side
                // Because socket can send multiple messages at once
                socket.write(`${message}$~0~$`)
              },
              serialize(data: unknown): string {
                return stringify(data)
              },
              deserialize(data: string): unknown {
                return parse(data)
              },
            },
          )

          log.info('[API][DEBUG]', `Vitest for "${folder.name}" workspace folder is resolved.`)
          resolve({
            rpc: api,
            version: pkg.version,
            debug,
            handlers: {
              onConsoleLog: onConsoleLog.register,
              onTaskUpdate: onTaskUpdate.register,
              onFinished: onFinished.register,
              onCollected: onCollected.register,
              onWatcherRerun: onWatcherRerun.register,
              onWatcherStart: onWatcherStart.register,
              clearListeners() {
                onConsoleLog.clear()
                onTaskUpdate.clear()
                onFinished.clear()
                onCollected.clear()
                onWatcherRerun.clear()
                onWatcherStart.clear()
              },
            },
          })
        }
      })
    })
  })
}

export async function createVitestRPC(workspace: vscode.WorkspaceFolder) {
  // TODO: respect config? Why does enable exist? Can't you just disable the extension?
  // if (getConfig(workspace).enable === false || getRootConfig().disabledWorkspaceFolders.includes(workspace.name))
  //   return null
  // TODO: check compatibility with version >= 0.34.0(?)
  const vitestPackagePath = resolveVitestPackagePath(workspace)
  if (!vitestPackagePath)
    return null
  const pkg = _require(vitestPackagePath)
  const vitestNodePath = resolveVitestNodePath(vitestPackagePath)
  log.info('[API]', `Running Vitest ${pkg.version} for "${workspace.name}" workspace folder from ${vitestNodePath}`)
  const worker = new Worker(workerPath, {
    workerData: {
      root: workspace.uri.fsPath,
      vitestPath: vitestNodePath,
    },
    env: {
      VITEST_VSCODE: 'true',
    },
  })
  worker.stdout.on('data', d => log.info('[Worker]', d.toString()))
  worker.stderr.on('data', d => log.error('[Worker]', d.toString()))

  const onConsoleLog = createHandler<BirpcEvents['onConsoleLog']>()
  const onTaskUpdate = createHandler<BirpcEvents['onTaskUpdate']>()
  const onFinished = createHandler<BirpcEvents['onFinished']>()
  const onCollected = createHandler<BirpcEvents['onCollected']>()
  const onWatcherRerun = createHandler<BirpcEvents['onWatcherRerun']>()
  const onWatcherStart = createHandler<BirpcEvents['onWatcherStart']>()

  return await new Promise<ResolvedRPC | null>((resolve) => {
    const api = createBirpc<BirpcMethods, BirpcEvents>(
      {
        onReady() {
          log.info('[API]', `Vitest for "${workspace.name}" workspace folder is resolved.`)
          resolve({
            rpc: api,
            version: pkg.version,
            handlers: {
              onConsoleLog: onConsoleLog.register,
              onTaskUpdate: onTaskUpdate.register,
              onFinished: onFinished.register,
              onCollected: onCollected.register,
              onWatcherRerun: onWatcherRerun.register,
              onWatcherStart: onWatcherStart.register,
              clearListeners() {
                onConsoleLog.clear()
                onTaskUpdate.clear()
                onFinished.clear()
                onCollected.clear()
                onWatcherRerun.clear()
                onWatcherStart.clear()
              },
            },
          })
        },
        onError(err: any) {
          log.error('[API]', err?.stack)
          resolve(null)
        },
        onConsoleLog: onConsoleLog.trigger,
        onFinished: onFinished.trigger,
        onTaskUpdate: onTaskUpdate.trigger,
        onCollected: onCollected.trigger,
        onWatcherRerun: onWatcherRerun.trigger,
        onWatcherStart: onWatcherStart.trigger,
      },
      {
        on(listener) {
          worker.on('message', listener)
        },
        post(message) {
          worker.postMessage(message)
        },
      },
    )
  })
}
