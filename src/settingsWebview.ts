import * as vscode from 'vscode'
import { getConfig } from './config'
import { nanoid } from './utils'

export class SettingsWebview implements vscode.WebviewViewProvider, vscode.Disposable {
  private disposables: vscode.Disposable[]
  private view: vscode.WebviewView | undefined

  constructor(
    private extensionUri: vscode.Uri,
  ) {
    this.disposables = [
      vscode.window.registerWebviewViewProvider('vitest.webviewSettings', this),
    ]
  }

  resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): Thenable<void> | void {
    this.view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }

    webviewView.webview.html = createHtmlView(webviewView.webview)

    this.disposables.push(
      // when we get the message from the view, process it
      webviewView.webview.onDidReceiveMessage((message) => {
        if (message.method === 'toggle') {
          const settings = vscode.workspace.getConfiguration('vitest')
          settings.update(message.args.setting, !settings.get(message.args.setting))
        }
      }),
      // when the user changes the configuration manually, update the view
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vitest.previewBrowser')) {
          this.updateSettings()
        }
      }),
      // when the weview is opened, make sure it's up to date
      webviewView.onDidChangeVisibility(() => {
        if (!webviewView.visible)
          return
        this.updateSettings()
      }),
    )

    this.updateSettings()
  }

  updateSettings() {
    this.view?.webview.postMessage({
      method: 'settings',
      args: {
        settings: getConfig(),
      },
    })
  }

  dispose() {
    this.disposables.forEach(d => d.dispose())
    this.disposables = []
  }
}

// based on
// https://github.com/microsoft/playwright-vscode/blob/4454e6876bfde1b4a8570dbaeca1ad14e8cd37c8/src/settingsView.ts
function createHtmlView(webview: vscode.Webview) {
  // <link href="${styleUri}" rel="stylesheet">
  const nonce = nanoid()
  return `
<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vitest</title>
  </head>
  <body>
    <div class="list">
      <div>
        <label title="${vscode.l10n.t('Show the browser when running tests in the Browser Mode. This will disable parallel execution.')}">
          <input type="checkbox" data-setting="previewBrowser"></input>
          ${vscode.l10n.t('Show browser')}
        </label>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      for (const input of document.querySelectorAll('input[type=checkbox]')) {
      console.log('input', input)
        input.addEventListener('change', event => {
          vscode.postMessage({ method: 'toggle', args: { setting: event.target.dataset.setting } });
        });
      }
      window.addEventListener('message', event => {
        const { method, args } = event.data;
        if (method === 'settings') {
          for (const [key, value] of Object.entries(args.settings)) {
            const input = document.querySelector('input[data-setting=' + key + ']');
            console.log('input', input, key, value)
            if (!input)
              continue;
            if (typeof value === 'boolean')
              input.checked = value;
            else
              input.value = value;
          }
        }
      })
    </script>
  </body>
</html>
  `
}
