import { pathToFileURL } from 'node:url'
import { WebSocket, type WebSocketServer } from 'ws'
import { gte } from 'semver'
import type { ResolvedMeta } from '../api'
import { log } from '../log'
import type { WorkerEvent, WorkerRunnerOptions } from '../worker/types'
import { getConfig } from '../config'
import type { VitestProcess } from './types'
import { createVitestRpc } from './rpc'
import type { VitestPackage } from './pkg'

export function waitForWsResolvedMeta(
  wss: WebSocketServer,
  pkg: VitestPackage,
  debug: boolean,
) {
  return new Promise<ResolvedMeta>((resolve, reject) => {
    wss.once('connection', (ws) => {
      function onMessage(_message: any) {
        const message = JSON.parse(_message.toString()) as WorkerEvent

        if (message.type === 'debug')
          log.worker('info', ...message.args)

        if (message.type === 'ready') {
          const { api, handlers } = createVitestRpc({
            on: listener => ws.on('message', listener),
            send: message => ws.send(message),
          })
          resolve({
            rpc: api,
            handlers,
            process: new VitestWebSocketProcess(Math.random(), wss, ws),
            pkg,
          })
        }

        if (message.type === 'error') {
          const error = new Error(`Vitest failed to start: \n${message.error}`)
          reject(error)
        }
        ws.off('error', onError)
        ws.off('message', onMessage)
        ws.off('close', onExit)
      }

      function onError(err: Error) {
        log.error('[API]', err)
        reject(err)
        ws.off('error', onError)
        ws.off('message', onMessage)
        ws.off('close', onExit)
      }

      function onExit(code: number) {
        reject(new Error(`Vitest process exited with code ${code}`))
      }

      wss.off('error', onUnexpectedError)
      wss.off('exit', onUnexpectedExit)

      ws.on('error', onError)
      ws.on('message', onMessage)
      ws.on('close', onExit)

      const pnpLoader = pkg.loader
      const pnp = pkg.pnp

      const runnerOptions: WorkerRunnerOptions = {
        type: 'init',
        meta: {
          vitestNodePath: pkg.vitestNodePath,
          env: getConfig(pkg.folder).env || undefined,
          configFile: pkg.configFile,
          cwd: pkg.cwd,
          arguments: pkg.arguments,
          workspaceFile: pkg.workspaceFile,
          id: pkg.id,
          pnpApi: pnp,
          pnpLoader: pnpLoader && gte(process.version, '18.19.0')
            ? pathToFileURL(pnpLoader).toString()
            : undefined,
        },
        debug,
      }

      ws.send(JSON.stringify(runnerOptions))
    })

    function onUnexpectedExit() {
      reject(new Error('Cannot establish connection with Vitest process.'))
    }

    function onUnexpectedError(err: Error) {
      reject(err)
    }

    wss.on('error', onUnexpectedError)
    wss.once('close', onUnexpectedExit)
  })
}

export class VitestWebSocketProcess implements VitestProcess {
  constructor(
    public id: number,
    public wss: WebSocketServer,
    public ws: WebSocket,
  ) {}

  get closed() {
    return this.ws.readyState === WebSocket.CLOSED
  }

  close() {
    this.wss.close()
  }

  on(event: string, listener: (...args: any[]) => void) {
    this.ws.on(event, listener)
  }

  once(event: string, listener: (...args: any[]) => void) {
    this.ws.once(event, listener)
  }

  off(event: string, listener: (...args: any[]) => void) {
    this.ws.off(event, listener)
  }
}
