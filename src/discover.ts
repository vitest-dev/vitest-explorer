import * as vscode from "vscode";
import { sep } from "path";
import parse from "./pure/parsers";
import { NamedBlock } from "./pure/parsers/parser_nodes";
import {
  TestCase,
  TestData,
  TestDescribe,
  TestFile,
  testItemIdMap,
  WEAKMAP_TEST_DATA,
} from "./TestData";
import { shouldIncludeFile } from "./vscodeUtils";

import minimatch from "minimatch";
import { getConfig } from "./config";
import { debounce } from "mighty-promise";

export class TestFileDiscoverer extends vscode.Disposable {
  private lastWatches = [] as vscode.FileSystemWatcher[];
  private readonly workspacePaths = [] as string[];
  private workspaceCommonPrefix: Map<string, string> = new Map();
  private workspaceItems: Map<string, Set<vscode.TestItem>> = new Map();
  private pathToFileItem: Map<string, TestFile> = new Map();

  constructor() {
    super(() => {
      for (const watch of this.lastWatches) {
        watch.dispose();
      }

      this.lastWatches = [];
      this.workspaceItems.clear();
      this.pathToFileItem.clear();
      this.workspaceCommonPrefix.clear();
    });
    this.workspacePaths =
      vscode.workspace.workspaceFolders?.map((x) => x.uri.fsPath) || [];
  }

  async discoverAllFilesInWorkspace(
    controller: vscode.TestController,
  ): Promise<vscode.FileSystemWatcher[]> {
    for (const watch of this.lastWatches) {
      watch.dispose();
    }

    if (!vscode.workspace.workspaceFolders) {
      return []; // handle the case of no open folders
    }

    const watchers = [] as vscode.FileSystemWatcher[];
    await Promise.all(
      vscode.workspace.workspaceFolders.map(async (workspaceFolder) => {
        const exclude = getConfig().exclude;
        for (const include of getConfig().include) {
          const pattern = new vscode.RelativePattern(
            workspaceFolder.uri,
            include,
          );
          const watcher = vscode.workspace.createFileSystemWatcher(pattern);
          const filter = (v: vscode.Uri) =>
            exclude.every((x) => !minimatch(v.fsPath, x, { dot: true }));
          watcher.onDidCreate(
            (uri) => filter(uri) && this.getOrCreateFile(controller, uri),
          );

          watcher.onDidChange(
            debounce((uri) => {
              if (!filter(uri)) {
                return;
              }

              const { data, file } = this.getOrCreateFile(controller, uri);
              if (!data.resolved) {
                return;
              }

              data.updateFromDisk(controller);
            }, 500),
          );

          watcher.onDidDelete((uri) => controller.items.delete(uri.toString()));

          for (const file of await vscode.workspace.findFiles(pattern)) {
            filter(file) && this.getOrCreateFile(controller, file);
          }

          watchers.push(watcher);
        }

        return watchers;
      }),
    );
    this.lastWatches = watchers.concat();
    return watchers;
  }

  public discoverTestFromDoc(
    ctrl: vscode.TestController,
    e: vscode.TextDocument,
  ) {
    if (e.uri.scheme !== "file") {
      return;
    }

    if (!shouldIncludeFile(e.uri.fsPath)) {
      return;
    }

    const { file, data } = this.getOrCreateFile(ctrl, e.uri);
    discoverTestFromFileContent(ctrl, e.getText(), file, data);
  }

  discoverTestFromPath(
    controller: vscode.TestController,
    path: string,
  ) {
    const { data } = this.getOrCreateFile(controller, vscode.Uri.file(path));
    if (!data.resolved) {
      data.updateFromDisk(controller);
    }
    return data;
  }

  private getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
    const existing = controller.items.get(uri.toString());
    if (existing) {
      return {
        file: existing,
        data: WEAKMAP_TEST_DATA.get(existing) as TestFile,
      };
    }

    const workspacePath = this.workspacePaths.find((x) =>
      uri.fsPath.startsWith(x)
    );
    let name;
    if (workspacePath) {
      if (!this.workspaceCommonPrefix.has(workspacePath)) {
        const path = uri.fsPath.split(sep);
        this.workspaceCommonPrefix.set(
          workspacePath,
          path.slice(0, -1).join(sep) + sep,
        );
        this.workspaceItems.set(workspacePath, new Set());
      }

      let workspacePrefix = this.workspaceCommonPrefix.get(workspacePath)!;
      if (!uri.fsPath.startsWith(workspacePrefix)) {
        const p = uri.fsPath;
        for (let i = 0; i < workspacePrefix.length; i++) {
          if (p[i] !== workspacePrefix[i]) {
            workspacePrefix = workspacePrefix.slice(0, i);
            break;
          }
        }

        this.workspaceCommonPrefix.set(workspacePath, workspacePrefix);
        const items = this.workspaceItems.get(workspacePath)!;
        items.forEach((v) => {
          v.label = v.uri!.fsPath.substring(workspacePrefix.length);
        });
      }

      name = uri.fsPath.substring(workspacePrefix.length);
    } else {
      name = uri.fsPath.split(sep).pop()!;
    }

    const file = controller.createTestItem(uri.toString(), name, uri);
    workspacePath && this.workspaceItems.get(workspacePath)!.add(file);
    controller.items.add(file);
    const data = new TestFile(file);
    WEAKMAP_TEST_DATA.set(file, data);
    this.pathToFileItem.set(uri.fsPath, data);

    file.canResolveChildren = true;
    return { file, data };
  }
}

export function discoverTestFromFileContent(
  controller: vscode.TestController,
  content: string,
  fileItem: vscode.TestItem,
  data: TestFile,
) {
  if (testItemIdMap.get(controller) == null) {
    testItemIdMap.set(controller, new Map());
  }

  const idMap = testItemIdMap.get(controller)!;
  idMap.set(fileItem.id, fileItem);
  const ancestors = [
    {
      item: fileItem,
      block: undefined as NamedBlock | undefined,
      children: [] as vscode.TestItem[],
      dataChildren: [] as (TestCase | TestDescribe)[],
      data: data as TestData,
    },
  ];

  function getParent(block: NamedBlock): typeof ancestors[number] {
    let parent = ancestors[ancestors.length - 1];
    if (parent.block == null) {
      return parent;
    }

    while (parent.block && block.start!.line >= parent.block.end!.line) {
      const top = ancestors.pop();
      if (top) {
        top.item.children.replace(top.children);
        (top.data as (TestFile | TestDescribe)).children = [
          ...top.dataChildren,
        ];
      }

      parent = ancestors[ancestors.length - 1];
    }

    return parent;
  }

  let result: ReturnType<typeof parse>;
  try {
    result = parse(fileItem.id, content);
  } catch (e) {
    console.log("parse error");
    return;
  }

  const arr: NamedBlock[] = [...result.describeBlocks, ...result.itBlocks];
  arr.sort((a, b) => (a.start?.line || 0) - (b.start?.line || 0));
  let testCaseIndex = 0;
  let index = 0;
  for (const block of arr) {
    const parent = getParent(block);
    const fullName = ancestors.slice(1).map((x) => x.block?.name || "").concat([
      block.name!,
    ]).join(" ").trim();
    const id = `${fileItem.uri}/${fullName}@${index++}`;
    const caseItem = controller.createTestItem(id, block.name!, fileItem.uri);
    idMap.set(id, caseItem);
    caseItem.range = new vscode.Range(
      new vscode.Position(block.start!.line - 1, block.start!.column),
      new vscode.Position(block.end!.line - 1, block.end!.column),
    );
    parent.children.push(caseItem);
    if (block.type === "describe") {
      const data = new TestDescribe(
        block.name!,
        fileItem,
        caseItem,
        parent.data as TestFile,
      );
      parent.dataChildren.push(data);
      WEAKMAP_TEST_DATA.set(caseItem, data);
      ancestors.push({
        item: caseItem,
        block,
        children: [],
        data,
        dataChildren: [],
      });
    } else if (block.type === "it") {
      const testCase = new TestCase(
        block.name!,
        fileItem,
        caseItem,
        parent.data as TestFile | TestDescribe,
        testCaseIndex++,
      );
      parent.dataChildren.push(testCase);
      WEAKMAP_TEST_DATA.set(caseItem, testCase);
    } else {
      throw new Error();
    }
  }

  while (ancestors.length) {
    const top = ancestors.pop();
    if (top) {
      top.item.children.replace(top.children);
      (top.data as (TestFile | TestDescribe)).children = [
        ...top.dataChildren,
      ];
    }
  }
}
