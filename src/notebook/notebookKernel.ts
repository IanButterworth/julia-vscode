import { Subject } from 'await-notify'
import * as net from 'net'
import { homedir } from 'os'
import * as path from 'path'
import { uuid } from 'uuidv4'
import * as vscode from 'vscode'
import { createMessageConnection, MessageConnection, NotificationType, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import { getAbsEnvPath } from '../jlpkgenv'
import { getJuliaExePath } from '../juliaexepath'
import { getCrashReportingPipename } from '../telemetry'
import { generatePipeName } from '../utils'

interface ExecutionRequest {
    executionOrder: number
    execution: vscode.NotebookCellExecution
}

const notifyTypeDisplay = new NotificationType<{ mimetype: string, current_request_id: number, data: string }>('notebook/display')
const notifyTypeStreamoutput = new NotificationType<{ name: string, current_request_id: number, data: string }>('streamoutput')
const notifyTypeRunCell = new NotificationType<{ current_request_id: number, code: string }>('notebook/runcell')
const notifyTypeRunCellSucceeded = new NotificationType<{ request_id: number }>('runcellsucceeded')
const notifyTypeRunCellFailed = new NotificationType<{ request_id: number, output: { ename: string, evalue: string, traceback: string } }>('runcellfailed')

function getDisplayPathName(pathValue: string): string {
    return pathValue.startsWith(homedir()) ? `~${path.relative(homedir(), pathValue)}` : pathValue
}

export class JuliaKernel {
    private _localDisposables: vscode.Disposable[] = []

    private executionRequests = new Map<number, ExecutionRequest>();
    private _terminal: vscode.Terminal;
    public _msgConnection: MessageConnection;
    private _current_request_id: number = 0;

    private _onCellRunFinished = new vscode.EventEmitter<void>()
    public onCellRunFinished = this._onCellRunFinished.event

    private _onConnected = new vscode.EventEmitter<void>()
    public onConnected = this._onConnected.event

    constructor(private extensionPath: string, private controller: vscode.NotebookController, public notebook: vscode.NotebookDocument) {
    }

    public dispose() {
        this._localDisposables.forEach(d => d.dispose())
        this.stop()
    }

    private readonly cellExecutions = new WeakMap<vscode.NotebookCell, vscode.NotebookCellExecution>();

    public async executeCell(cell: vscode.NotebookCell): Promise<void> {
        await this.start()
        const executionOrder = ++this._current_request_id

        const execution = this.controller.createNotebookCellExecution(cell)
        this.executionRequests.set(executionOrder, { executionOrder: executionOrder, execution })
        this.cellExecutions.set(cell, execution)

        const runStartTime = Date.now()
        execution.start(runStartTime)
        execution.clearOutput()
        execution.executionOrder = executionOrder

        this._msgConnection.sendNotification(notifyTypeRunCell, { current_request_id: this._current_request_id, code: cell.document.getText() })
    }

    private async start() {
        if (!this._terminal) {
            this._current_request_id = 0
            const connectedPromise = new Subject()
            const serverListeningPromise = new Subject()

            const pn = generatePipeName(uuid(), 'vscjl-nbk')

            const server = net.createServer(socket => {
                this._msgConnection = createMessageConnection(
                    new StreamMessageReader(socket),
                    new StreamMessageWriter(socket)
                )

                this._msgConnection.onNotification(notifyTypeRunCellSucceeded, ({ request_id }) => {
                    const runEndTime = Date.now()

                    const request = this.executionRequests.get(request_id)
                    const execution = this.cellExecutions.get(request.execution.cell)
                    if (execution) {
                        execution.end(true, runEndTime)
                    }
                    this._onCellRunFinished.fire()
                })

                this._msgConnection.onNotification(notifyTypeRunCellFailed, ({ request_id, output }) => {
                    const runEndTime = Date.now()

                    const request = this.executionRequests.get(request_id)
                    const execution = this.cellExecutions.get(request.execution.cell)
                    if (execution) {
                        execution.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error({ message: output.evalue, name: output.ename, stack: output.traceback })]))
                        execution.end(false, runEndTime)
                    }
                    this._onCellRunFinished.fire()
                })

                this._msgConnection.onNotification(notifyTypeDisplay, ({ mimetype, current_request_id, data }) => {
                    const request = this.executionRequests.get(current_request_id)
                    const execution = this.cellExecutions.get(request.execution.cell)
                    if (execution) {
                        execution.appendOutput(new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(Buffer.from(data), mimetype)]))
                    }
                })

                this._msgConnection.onNotification(notifyTypeStreamoutput, ({ name, current_request_id, data }) => {
                    if (name === 'stdout') {
                        const request = this.executionRequests.get(current_request_id)
                        const execution = this.cellExecutions.get(request.execution.cell)
                        if (execution) {
                            execution.appendOutput([new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(data)])])
                        }
                    }
                    else if (name === 'stderr') {
                        const request = this.executionRequests.get(current_request_id)
                        const execution = this.cellExecutions.get(request.execution.cell)
                        if (execution) {
                            execution.appendOutput([new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(data)])])
                        }
                    }
                    else {
                        throw (new Error('Unknown stream type.'))
                    }
                })

                this._msgConnection.listen()

                this._onConnected.fire(null)

                connectedPromise.notify()
            })

            server.listen(pn, () => {
                serverListeningPromise.notify()
            })

            await serverListeningPromise.wait()

            const jlexepath = await getJuliaExePath()
            const pkgenvpath = await getAbsEnvPath()

            this._terminal = vscode.window.createTerminal({
                name: `Julia Notebook Kernel ${getDisplayPathName(this.notebook.uri.fsPath)}`,
                shellPath: jlexepath,
                shellArgs: [
                    '--color=yes',
                    `--project=${pkgenvpath}`,
                    '--startup-file=no',
                    '--history-file=no',
                    path.join(this.extensionPath, 'scripts', 'notebook', 'notebook.jl'),
                    pn,
                    getCrashReportingPipename()
                ]
            })
            this._terminal.show(false)
            const asdf: Array<vscode.Disposable> = []
            vscode.window.onDidCloseTerminal((terminal) => {
                if (terminal === this._terminal) {
                    asdf[0].dispose()
                    this._terminal = undefined
                }
            }, this, asdf)

            await connectedPromise.wait()
        }
    }

    // private async restart() {
    //     this.stop()
    //     await this.start()
    // }

    private stop() {

        if (this._terminal) {
            this._terminal.dispose()
            this._terminal = undefined
        }
    }
}
