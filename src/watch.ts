import {
  Disposable,
  TestController,
  TestItem,
  TestMessage,
  TestRun,
  TestRunRequest,
  workspace,
} from "vscode";
import Fuse from "fuse.js";
import { buildWatchClient } from "./pure/watch/client";
import type { File, Task, TaskResult } from "vitest";
import { TestFileDiscoverer } from "./discover";
import { effect, ref } from "@vue/reactivity";
import { ChildProcess } from "child_process";
import { getTasks } from "@vitest/ws-client";
import {
  TestCase,
  TestDescribe,
  TestFile,
  WEAKMAP_TEST_DATA,
} from "./TestData";
import { execWithLog } from "./pure/utils";
import { getConfig } from "./config";

export class TestWatcher extends Disposable {
  static cache: undefined | TestWatcher;
  static isWatching() {
    return !!this.cache?.isWatching.value;
  }

  static create(
    ctrl: TestController,
    discover: TestFileDiscoverer,
    vitest: { cmd: string; args: string[] },
  ) {
    if (this.cache) {
      return this.cache;
    }

    TestWatcher.cache = new TestWatcher(ctrl, discover, vitest);

    return TestWatcher.cache;
  }

  public isWatching = ref(false);
  public isRunning = ref(false);
  public testStatus = ref({ passed: 0, failed: 0, skipped: 0 });
  private process?: ChildProcess;
  private vitestState?: ReturnType<typeof buildWatchClient>;
  private run: TestRun | undefined;
  private constructor(
    private ctrl: TestController,
    private discover: TestFileDiscoverer,
    private vitest: { cmd: string; args: string[] },
  ) {
    super(() => {
      this.dispose();
      this.vitestState?.client.ws.close();
      this.vitestState = undefined;
    });
  }

  public watch() {
    this.isRunning.value = true;
    this.isWatching.value = true;
    const logs = [] as string[];
    let timer: any;
    this.process = execWithLog(
      this.vitest.cmd,
      [...this.vitest.args, "--api"],
      {
        cwd: workspace.workspaceFolders?.[0].uri.fsPath,
        env: { ...process.env, ...getConfig().env },
      },
      (line) => {
        logs.push(line);
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.log(logs.join("\n"));
          logs.length = 0;
        }, 200);
      },
      (line) => {
        logs.push(line);
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.log(logs.join("\n"));
          logs.length = 0;
        }, 200);
      },
    ).child;

    this.process.on("exit", () => {
      console.log("VITEST WATCH PROCESS EXIT");
    });

    if (this.vitestState) {
      this.vitestState.client.reconnect();
    } else {
      this.vitestState = buildWatchClient({
        handlers: {
          onTaskUpdate: (packs) => {
            try {
              if (!this.vitestState) {
                return;
              }

              this.isRunning.value = true;
              const idMap = this.vitestState.client.state.idMap;
              const fileSet = new Set<File>();
              for (const [id, _] of packs) {
                const task = idMap.get(id);
                if (!task) {
                  continue;
                }

                task.file && fileSet.add(task.file);
              }

              this.onUpdated(Array.from(fileSet), false);
            } catch (e) {
              console.error(e);
            }
          },
          onFinished: (files) => {
            try {
              this.isRunning.value = false;
              this.onUpdated(files, true);
              if (!this.run) {
                return;
              }

              this.run.end();
              this.run = undefined;
              this.updateStatus();
            } catch (e) {
              console.error(e);
            }
          },
        },
      });
    }

    this.vitestState.loadingPromise.then(() => {
      this.updateStatus();
      this.isRunning.value = false;
    });

    effect(() => {
      this.onFileUpdated(this.vitestState!.files.value);
    });
  }

  updateStatus() {
    if (!this.vitestState) {
      return;
    }

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const idMap = this.vitestState.client.state.idMap;
    for (const task of idMap.values()) {
      if (task.type !== "test") {
        continue;
      }

      if (!task.result) {
        skipped++;
        continue;
      }
      if (task.result.state === "pass") {
        passed++;
      }
      if (task.result.state === "fail") {
        failed++;
      }
    }

    this.testStatus.value = { passed, failed, skipped };
  }

  public runTests(tests?: readonly TestItem[]) {
    if (!this.vitestState) {
      return;
    }

    if (tests == null) {
      const files = this.vitestState.files.value;
      this.runFiles(files);
      return;
    }

    this.runFiles(
      this.vitestState.files.value.filter((file) =>
        tests.some((test) =>
          WEAKMAP_TEST_DATA.get(test)!.getFilePath().includes(file.filepath)
        )
      ),
    );
  }

  private runFiles(files: File[]) {
    if (!this.vitestState) {
      return;
    }

    if (!this.run) {
      this.run = this.ctrl.createTestRun(new TestRunRequest());
    }

    for (const file of files) {
      const data = this.discover.discoverTestFromPath(
        this.ctrl,
        file.filepath,
      );

      const run = this.run;
      started(data.item);

      function started(item: TestItem) {
        run.started(item);
        if (item.children) {
          item.children.forEach((child) => {
            started(child);
          });
        }
      }
    }

    files.forEach((f) => {
      delete f.result;
      getTasks(f).forEach((i) => delete i.result);
    });

    const client = this.vitestState.client;
    return client.rpc.rerun(files.map((i) => i.filepath));
  }

  private readonly onFileUpdated = (files?: File[]) => {
    if (files == undefined) {
      this.discover.watchAllTestFilesInWorkspace(this.ctrl);
    } else {
      for (const file of files) {
        this.discover.discoverTestFromPath(
          this.ctrl,
          file.filepath,
        );
      }
    }
  };

  private readonly onUpdated = (
    files: File[] | undefined,
    finished: boolean,
  ) => {
    if (!files) {
      return;
    }

    let shouldReloadFileContent = true;
    if (!this.run) {
      this.run = this.ctrl.createTestRun(new TestRunRequest());
    }

    for (const file of files) {
      const data = this.discover.discoverTestFromPath(
        this.ctrl,
        file.filepath,
        shouldReloadFileContent,
      );

      this.syncTestStatusToVsCode(data, file, finished);
    }
  };

  private syncTestStatusToVsCode(
    vscodeFile: TestFile,
    vitestFile: File,
    finished: boolean,
  ) {
    const run = this.run;
    if (!run) {
      return;
    }

    sync(run, vscodeFile.children, vitestFile.tasks);

    function sync(
      run: TestRun,
      vscode: (TestDescribe | TestCase)[],
      vitest: Task[],
    ) {
      const set = new Set(vscode);
      for (const task of vitest) {
        const data = matchTask(task, set, task.type);
        if (task.type === "test") {
          if (task.result == null) {
            if (finished) {
              run.skipped(data.item);
            }
          } else {
            switch (task.result?.state) {
              case "pass":
                run.passed(data.item, task.result.duration);
                break;
              case "fail":
                run.failed(
                  data.item,
                  new TestMessage(task.result.error?.message ?? ""),
                );
                break;
              case "skip":
              case "todo":
                run.skipped(data.item);
                break;
              case "run":
                run.started(data.item);
                break;
              case "only":
                break;
              default:
                console.error("unexpected result state", task.result);
            }
          }
        } else {
          sync(run, (data as TestDescribe).children, task.tasks);
        }
      }
    }

    function matchTask(
      task: Task,
      candidates: Set<TestDescribe | TestCase>,
      type: "suite" | "test",
    ): (TestDescribe | TestCase) {
      let ans: (TestDescribe | TestCase) | undefined;
      for (const candidate of candidates) {
        if (type === "suite" && !(candidate instanceof TestDescribe)) {
          continue;
        }

        if (type === "test" && !(candidate instanceof TestCase)) {
          continue;
        }

        if (candidate.pattern === task.name) {
          ans = candidate;
          break;
        }
      }

      if (ans) {
        candidates.delete(ans);
      } else {
        ans = new Fuse(Array.from(candidates), { keys: ["pattern"] }).search(
          task.name,
        )[0]?.item;
        // should not delete ans from candidates here, because there are usages like `test.each`
        // TODO: should we create new TestCase here?
      }

      return ans;
    }
  }

  public dispose() {
    console.log("Stop watch mode");
    this.isWatching.value = false;
    this.process?.kill();
    this.process = undefined;
  }
}
