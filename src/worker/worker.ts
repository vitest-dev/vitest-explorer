import v8 from 'node:v8'
import { createWorkerRPC } from './rpc'
import type { WorkerRunnerOptions } from './types'
import { Vitest } from './vitest'
import { initVitest } from './init'
import { WorkerProcessEmitter, WorkerWSEventEmitter } from './emitter'

const _require = require

const emitter = process.env.VITEST_WS_ADDRESS
  ? new WorkerWSEventEmitter(new (_require('ws').WebSocket)(process.env.VITEST_WS_ADDRESS))
  : new WorkerProcessEmitter()

emitter.on('message', async function onMessage(message: any) {
  if (emitter.name === 'ws') {
    message = JSON.parse(message.toString())
  }

  if (message.type === 'init') {
    emitter.off('message', onMessage)
    const data = message as WorkerRunnerOptions

    try {
      const { reporter, vitest } = await initVitest(
        data.meta,
        data.debug
          ? {
              fileParallelism: false,
              testTimeout: Number.POSITIVE_INFINITY,
              hookTimeout: Number.POSITIVE_INFINITY,
            }
          : {},
      )

      const rpc = createWorkerRPC(new Vitest(vitest, data.debug), {
        on(listener) {
          emitter.on('message', listener)
        },
        post(message) {
          emitter.send(message)
        },
        serialize: v8.serialize,
        deserialize: v => v8.deserialize(Buffer.from(v) as any),
      })
      reporter.initRpc(rpc)
      emitter.ready()
    }
    catch (err: any) {
      emitter.error(err)
    }
  }
})
