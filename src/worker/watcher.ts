import type { ProvidedContext } from 'vitest'
import { relative } from 'pathe'
import type { WorkspaceSpec } from 'vitest/node'
import { Vitest } from './vitest'

export class VitestWatcher {
  private files: string[] = []
  private testNamePattern: string | undefined
  private watchEveryFile = false
  private rerunTriggered = false

  private enabled = false

  constructor(vitest: Vitest) {
    // eslint-disable-next-line ts/no-this-alias
    const state = this
    const ctx = vitest.ctx
    ;(ctx.getCoreWorkspaceProject().provide as <T extends keyof ProvidedContext>(key: T, value: ProvidedContext[T]) => {})('__vscode', {
      get continuousFiles() {
        return state.files || []
      },
      get watchEveryFile() {
        return state.watchEveryFile ?? true
      },
      get rerunTriggered() {
        return state.rerunTriggered ?? false
      },
    })

    // @ts-expect-error modifying a private property
    const originalScheduleRerun = ctx.scheduleRerun.bind(ctx)
    // @ts-expect-error modifying a private property
    ctx.scheduleRerun = async function (files: string[]) {
      // if trigger is not a test file, remove all non-continious files from this.changedTests
      const triggerFile = files[0]
      const isTestFileTrigger = this.changedTests.has(triggerFile)

      // no continuous files for this Vitest instance, just collect tests
      if (!state.enabled) {
        // do not run any tests if continuous run was not enabled
        if (!isTestFileTrigger) {
          this.changedTests.clear()
          this.invalidates.clear()
          return await originalScheduleRerun.call(this, files)
        }

        const tests = Array.from(this.changedTests)
        const specs = tests.flatMap(file => this.getProjectsByTestFile(file))
        const browserSpecs: WorkspaceSpec[] = []

        for (const [project, file] of specs) {
          if (project.config.browser.enabled) {
            browserSpecs.push([project, file])
          }
        }

        ctx.configOverride.testNamePattern = new RegExp(Vitest.COLLECT_NAME_PATTERN)
        ctx.logger.log('Collecting tests due to file changes:', ...files.map(f => relative(ctx.config.root, f)))

        if (browserSpecs.length) {
          ctx.logger.log('Collecting using AST explorer...')
          await vitest.astCollect(browserSpecs)
          return await originalScheduleRerun.call(this, [])
        }

        return await originalScheduleRerun.call(this, files)
      }

      state.rerunTriggered = true

      const namePattern = state.testNamePattern ? new RegExp(state.testNamePattern) : undefined
      ctx.configOverride.testNamePattern = namePattern
      if (state.watchEveryFile) {
        ctx.logger.log(
          'Rerunning all tests due to file changes:',
          ...files.map(f => relative(ctx.config.root, f)),
          namePattern ? `with pattern ${namePattern}` : '',
        )
        return await originalScheduleRerun.call(this, files)
      }

      if (!isTestFileTrigger) {
        // if souce code is changed and related tests are not continious, remove them from changedTests
        const updatedTests = new Set<string>()
        for (const file of this.changedTests) {
          if (state.isTestFileWatched(file))
            updatedTests.add(file)
        }
        this.changedTests = updatedTests
      }

      if (this.changedTests.size) {
        ctx.logger.log(
          'Rerunning tests due to file changes:',
          ...[...this.changedTests].map(f => relative(ctx.config.root, f)),
          namePattern ? `with pattern ${namePattern}` : '',
        )
      }

      return await originalScheduleRerun.call(this, files)
    }
  }

  private isTestFileWatched(testFile: string) {
    if (!this.files?.length)
      return false

    return this.files.some((file) => {
      if (file === testFile)
        return true
      if (file[file.length - 1] === '/')
        return testFile.startsWith(file)
      return false
    })
  }

  markRerun(rerun: boolean) {
    this.rerunTriggered = rerun
  }

  trackTests(files: string[], testNamePatern: string | undefined) {
    this.enabled = true
    this.files = files
    this.watchEveryFile = false
    this.testNamePattern = testNamePatern
    this.rerunTriggered = false
  }

  trackEveryFile() {
    this.enabled = true
    this.watchEveryFile = true
    this.files = []
    this.testNamePattern = undefined
    this.rerunTriggered = false
  }

  stopTracking() {
    this.enabled = false
  }
}
