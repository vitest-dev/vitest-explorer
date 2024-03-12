import { join, sep } from 'node:path'
import * as vscode from 'vscode'
import type { TestData } from './TestData'
import {
  TestCase,
  TestDescribe,
  TestFile,
  WEAKMAP_TEST_DATA,
  testItemIdMap,
} from './TestData'
import parse from './pure/parsers'
import type { NamedBlock } from './pure/parsers/parser_nodes'
import { log } from './log'
import { openTestTag } from './tags'
import type { VitestAPI } from './api'
import { runTest } from './runner/runTests'

export class TestFileDiscoverer extends vscode.Disposable {
  private lastWatches = [] as vscode.FileSystemWatcher[]
  private readonly workspacePaths = [] as string[]
  private workspaceCommonPrefix: Map<string, string> = new Map()
  private workspaceItems: Map<string, Set<vscode.TestItem>> = new Map()
  private pathToFileItem: Map<string, TestFile> = new Map()
  private api: VitestAPI

  constructor(
    private readonly ctrl: vscode.TestController,
    private readonly profile: vscode.TestRunProfile,
    api: VitestAPI,
  ) {
    super(() => {
      for (const watch of this.lastWatches)
        watch.dispose()

      this.lastWatches = []
      this.workspaceItems.clear()
      this.pathToFileItem.clear()
      this.workspaceCommonPrefix.clear()
    })
    this.api = api
    this.workspacePaths
      = vscode.workspace.workspaceFolders?.map(x => x.uri.fsPath) || []
  }

  async watchAllTestFilesInWorkspace(
    controller: vscode.TestController,
  ): Promise<vscode.FileSystemWatcher[]> {
    for (const watch of this.lastWatches)
      watch.dispose()

    if (!this.api.enabled)
      return [] // handle the case of no opened folders

    const watchers = [] as vscode.FileSystemWatcher[]

    await Promise.all(
      this.api.map(async (api) => {
        const workspacePath = api.folder.uri.fsPath
        const files = await api.getFiles()
        for (const file of files) {
          this.getOrCreateFile(controller, vscode.Uri.file(file)).data.updateFromDisk(
            controller,
          )
        }

        const watcher = vscode.workspace.createFileSystemWatcher(join(workspacePath, '**'))
        watcher.onDidCreate(
          async uri => await api.isTestFile(uri.fsPath) && this.getOrCreateFile(controller, uri),
        )

        watcher.onDidChange(
          async (uri) => {
            if (!await api.isTestFile(uri.fsPath))
              return

            const { data } = this.getOrCreateFile(controller, uri)
            if (!data.resolved)
              return

            await data.updateFromDisk(controller)

            if (this.profile.supportsContinuousRun) {
              controller.invalidateTestResults([data.item])
              await runTest(
                controller,
                this.api,
                this,
                new vscode.TestRunRequest([data.item], [], this.profile, true),
                new vscode.CancellationTokenSource().token,
              )
            }
          },
        )

        watcher.onDidDelete(uri => controller.items.delete(uri.toString()))
        watchers.push(watcher)

        return watcher
      }),
    )
    this.lastWatches = watchers
    return watchers
  }

  async discoverAllTestFilesInWorkspace(
    controller: vscode.TestController,
  ): Promise<void> {
    if (!this.api.enabled)
      return

    await Promise.all(
      this.api.map(async (api) => {
        const files = await api.getFiles()
        for (const file of files) {
          this.getOrCreateFile(controller, vscode.Uri.file(file)).data.updateFromDisk(
            controller,
          )
        }
      }),
    )
  }

  public async discoverTestFromDoc(
    ctrl: vscode.TestController,
    e: vscode.TextDocument,
  ) {
    if (e.uri.scheme !== 'file')
      return

    if (!await this.api.isTestFile(e.uri.fsPath))
      return

    const { file, data } = this.getOrCreateFile(ctrl, e.uri)
    discoverTestFromFileContent(ctrl, e.getText(), file, data)

    return file
  }

  discoverTestFromPath(
    controller: vscode.TestController,
    path: string,
    forceReload = false,
  ) {
    const { data } = this.getOrCreateFile(controller, vscode.Uri.file(path))
    if (!data.resolved || forceReload)
      data.updateFromDisk(controller)

    return data
  }

  private getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
    const existing = controller.items.get(uri.toString())
    if (existing) {
      return {
        file: existing,
        data: WEAKMAP_TEST_DATA.get(existing) as TestFile,
      }
    }

    const workspacePath = this.workspacePaths.find(x =>
      uri.fsPath.startsWith(x),
    )
    let name
    if (workspacePath) {
      if (!this.workspaceCommonPrefix.has(workspacePath)) {
        const path = uri.fsPath.split(sep)
        this.workspaceCommonPrefix.set(
          workspacePath,
          path.slice(0, -1).join(sep) + sep,
        )
        this.workspaceItems.set(workspacePath, new Set())
      }

      let workspacePrefix = this.workspaceCommonPrefix.get(workspacePath)!
      if (!uri.fsPath.startsWith(workspacePrefix)) {
        const p = uri.fsPath
        for (let i = 0; i < workspacePrefix.length; i++) {
          if (p[i] !== workspacePrefix[i]) {
            workspacePrefix = workspacePrefix.slice(0, i)
            break
          }
        }

        this.workspaceCommonPrefix.set(workspacePath, workspacePrefix)
        const items = this.workspaceItems.get(workspacePath)!
        items.forEach((v) => {
          v.label = v.uri!.fsPath.substring(workspacePrefix.length)
        })
      }

      name = uri.fsPath.substring(workspacePrefix.length)
    }
    else {
      name = uri.fsPath.split(sep).pop()!
    }

    const file = controller.createTestItem(uri.toString(), name, uri)
    workspacePath && this.workspaceItems.get(workspacePath)!.add(file)
    controller.items.add(file)
    const data = new TestFile(file)
    WEAKMAP_TEST_DATA.set(file, data)
    this.pathToFileItem.set(uri.fsPath, data)

    file.canResolveChildren = true
    return { file, data }
  }
}

export function discoverTestFromFileContent(
  controller: vscode.TestController,
  content: string,
  fileItem: vscode.TestItem,
  data: TestFile,
) {
  if (testItemIdMap.get(controller) == null)
    testItemIdMap.set(controller, new Map())

  const idMap = testItemIdMap.get(controller)!
  idMap.set(fileItem.id, fileItem)
  const ancestors = [
    {
      item: fileItem,
      block: undefined as NamedBlock | undefined,
      children: [] as vscode.TestItem[],
      dataChildren: [] as (TestCase | TestDescribe)[],
      data: data as TestData,
    },
  ]

  function getParent(block: NamedBlock): typeof ancestors[number] {
    let parent = ancestors[ancestors.length - 1]
    if (parent.block == null)
      return parent

    while (parent.block && block.start!.line >= parent.block.end!.line) {
      const top = ancestors.pop()
      if (top) {
        top.item.children.replace(top.children);
        (top.data as (TestFile | TestDescribe)).children = [
          ...top.dataChildren,
        ]
      }

      parent = ancestors[ancestors.length - 1]
    }

    return parent
  }

  let result: ReturnType<typeof parse>
  try {
    result = parse(fileItem.id, content)
  }
  catch (e) {
    log.error('parse error', fileItem.id, e)
    return
  }

  const arr: NamedBlock[] = [...result.describeBlocks, ...result.itBlocks]
  arr.sort((a, b) => (a.start?.line || 0) - (b.start?.line || 0))
  let testCaseIndex = 0
  let index = 0
  for (const block of arr) {
    const parent = getParent(block)
    const fullName = ancestors.slice(1).map(x => x.block?.name || '').concat([
      block.name!,
    ]).join(' ').trim()
    const id = `${fileItem.uri}/${fullName}@${index++}`
    const caseItem = controller.createTestItem(id, block.name!, fileItem.uri)
    idMap.set(id, caseItem)
    caseItem.range = new vscode.Range(
      new vscode.Position(block.start!.line - 1, block.start!.column),
      new vscode.Position(block.end!.line - 1, block.end!.column),
    )
    parent.children.push(caseItem)
    if (block.type === 'describe') {
      const isEach = block.lastProperty === 'each'
      const data = new TestDescribe(
        block.name!,
        isEach,
        fileItem,
        caseItem,
        parent.data as TestFile,
      )
      parent.dataChildren.push(data)
      WEAKMAP_TEST_DATA.set(caseItem, data)
      ancestors.push({
        item: caseItem,
        block,
        children: [],
        data,
        dataChildren: [],
      })
    }
    else if (block.type === 'it') {
      const isEach = block.lastProperty === 'each'
      const testCase = new TestCase(
        block.name!,
        isEach,
        fileItem,
        caseItem,
        parent.data as TestFile | TestDescribe,
        testCaseIndex++,
      )
      parent.dataChildren.push(testCase)
      WEAKMAP_TEST_DATA.set(caseItem, testCase)
    }
    else {
      throw new Error('unexpected block type')
    }
  }

  while (ancestors.length) {
    const top = ancestors.pop()
    if (top) {
      top.item.children.replace(top.children);
      (top.data as (TestFile | TestDescribe)).children = [
        ...top.dataChildren,
      ]
    }
  }

  const childTestItems = [fileItem]
  const allTestItems = new Array<vscode.TestItem>()

  while (childTestItems.length) {
    const child = childTestItems.pop()
    if (!child)
      continue

    allTestItems.push(child)
    childTestItems.push(...[...child.children].map(x => x[1]))
  }

  const isFileOpen = vscode.workspace.textDocuments.some(
    x => x.uri.fsPath === fileItem.uri?.fsPath,
  )
  const existingTagsWithoutOpenTag = fileItem.tags.filter(
    x => x !== openTestTag,
  )
  const newTags = isFileOpen
    ? [...existingTagsWithoutOpenTag, openTestTag]
    : existingTagsWithoutOpenTag
  for (const testItem of allTestItems)
    testItem.tags = newTags
}
