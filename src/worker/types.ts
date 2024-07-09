export interface WorkerMeta {
  vitestNodePath: string
  id: string
  cwd: string
  arguments?: string
  configFile?: string
  workspaceFile?: string
  env: Record<string, any> | undefined
}

export interface WorkerRunnerOptions {
  type: 'init'
  meta: WorkerMeta
  loader?: string
}

export interface EventReady {
  type: 'ready'
}

export interface EventDebug {
  type: 'debug'
  args: string[]
}

export interface EventError {
  type: 'error'
  error: string
}

export type WorkerEvent = EventReady | EventDebug | EventError

declare module 'vitest' {
  export interface ProvidedContext {
    __vscode: {
      continuousFiles: string[]
      watchEveryFile: boolean
      rerunTriggered: boolean
    }
  }
}
