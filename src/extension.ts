import * as vscode from 'vscode';
import * as path from 'path';
import { exec, ChildProcess } from 'child_process';
import * as os from 'os';

// ─── State ────────────────────────────────────────────────────────────────────
let enabled: boolean = true;
let statusBarItem: vscode.StatusBarItem;
let currentSoundProcess: ChildProcess | null = null;

// Debounce: prevent duplicate plays within a short window
let lastPlayTime: number = 0;
const DEBOUNCE_MS = 2000; // don't re-trigger within 2 seconds

// ─── Error patterns to detect instantly in terminal output ────────────────────
const ERROR_PATTERNS: RegExp = new RegExp(
    [
        // Generic error keywords (must be at word boundary)
        '\\b(?:error|ERROR|Error)(?:\\s*[:\\[]|\\s+\\w)',
        '\\bFATAL\\b',
        '\\bfatal error\\b',
        '\\bUnhandled\\s+(?:Exception|Rejection)\\b',
        // Common stack trace / exception markers
        '\\bTraceback \\(most recent call last\\)',
        '\\b(?:TypeError|SyntaxError|ReferenceError|RangeError|ValueError|KeyError|AttributeError|ImportError|ModuleNotFoundError|NameError|IndexError|FileNotFoundError|PermissionError|IOError|OSError|RuntimeError|ZeroDivisionError)\\b',
        '\\bException in thread\\b',
        '\\bpanic:\\b',
        // Build / compile errors
        '\\bBUILD FAILED\\b',
        '\\bCompilation failed\\b',
        '\\bFAILED\\b',
        // npm / node
        '\\bnpm ERR!\\b',
        '\\bERR!\\b',
        // Rust
        '\\berror\\[E\\d+\\]',
        // Go
        '\\b\\.go:\\d+:\\d+:.*',
        // C/C++ compiler
        '\\b(?:error|fatal error):\\s',
        // Segfault
        '\\bSegmentation fault\\b',
        '\\bsegfault\\b',
        // Command not found
        '\\bcommand not found\\b',
        '\\bis not recognized as\\b',
        // Permission
        '\\bAccess is denied\\b',
        '\\bPermission denied\\b',
    ].join('|'),
    'i'
);

// ─── Activation ───────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
    // Read persisted setting
    const config = vscode.workspace.getConfiguration('terminalSounds');
    enabled = config.get<boolean>('enabled', true);

    // ── Status Bar ──────────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'terminalSounds.toggle';
    refreshStatusBar();
    statusBarItem.show();

    // ── Commands ────────────────────────────────────────────────────────────
    const toggleCmd = vscode.commands.registerCommand(
        'terminalSounds.toggle',
        () => {
            enabled = !enabled;
            vscode.workspace
                .getConfiguration('terminalSounds')
                .update('enabled', enabled, vscode.ConfigurationTarget.Global);
            refreshStatusBar();
            vscode.window.showInformationMessage(
                enabled
                    ? 'Terminal Sounds: Enabled 🔊'
                    : 'Terminal Sounds: Disabled 🔇'
            );
        }
    );

    const testErrorCmd = vscode.commands.registerCommand(
        'terminalSounds.testError',
        () => {
            playErrorSound(context);
            vscode.window.showInformationMessage('💥 Playing error sound...');
        }
    );

    // ── INSTANT: Detect errors from terminal output in real-time ─────────
    let writeListener: vscode.Disposable | undefined;
    try {
        const win = vscode.window as any;
        if (typeof win.onDidWriteTerminalData === 'function') {
            writeListener = win.onDidWriteTerminalData((e: any) => {
                if (!enabled) {
                    return;
                }
                // Strip ANSI escape codes to get clean text
                const clean = stripAnsi(e.data);
                if (ERROR_PATTERNS.test(clean)) {
                    const now = Date.now();
                    if (now - lastPlayTime > DEBOUNCE_MS) {
                        lastPlayTime = now;
                        playErrorSound(context);
                    }
                }
            });
        }
    } catch {
        console.log(
            '[Terminal Sounds] onDidWriteTerminalData not available'
        );
    }

    // ── Fallback: Task exit code listener ────────────────────────────────
    const taskListener = vscode.tasks.onDidEndTaskProcess((e) => {
        if (!enabled) {
            return;
        }
        if (e.exitCode !== undefined && e.exitCode !== 0) {
            const now = Date.now();
            if (now - lastPlayTime > DEBOUNCE_MS) {
                lastPlayTime = now;
                playErrorSound(context);
            }
        }
    });

    // ── Fallback: Shell execution exit code (VS Code 1.93+) ─────────────
    let shellListener: vscode.Disposable | undefined;
    try {
        const win = vscode.window as any;
        if (typeof win.onDidEndTerminalShellExecution === 'function') {
            shellListener = win.onDidEndTerminalShellExecution((e: any) => {
                if (!enabled) {
                    return;
                }
                if (e.exitCode !== undefined && e.exitCode !== 0) {
                    const now = Date.now();
                    if (now - lastPlayTime > DEBOUNCE_MS) {
                        lastPlayTime = now;
                        playErrorSound(context);
                    }
                }
            });
        }
    } catch {
        console.log(
            '[Terminal Sounds] onDidEndTerminalShellExecution not available'
        );
    }

    // ── Register disposables ────────────────────────────────────────────────
    context.subscriptions.push(toggleCmd, testErrorCmd, taskListener, statusBarItem);
    if (writeListener) {
        context.subscriptions.push(writeListener);
    }
    if (shellListener) {
        context.subscriptions.push(shellListener);
    }

    console.log('[Terminal Sounds] Extension activated ✅');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip ANSI escape sequences from terminal output */
function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function refreshStatusBar() {
    statusBarItem.text = enabled ? '$(unmute) Sounds' : '$(mute) Sounds';
    statusBarItem.tooltip = enabled
        ? 'Terminal Sounds ON — click to mute'
        : 'Terminal Sounds OFF — click to unmute';
}

/**
 * Play the error sound INSTANTLY using platform-native tools.
 *
 * Windows  → cscript + WMPlayer COM  (starts in ~50ms, no PowerShell delay)
 * macOS    → afplay
 * Linux    → paplay / aplay / mpv
 */
function playErrorSound(context: vscode.ExtensionContext) {
    // Kill any currently playing sound so they don't overlap
    if (currentSoundProcess) {
        currentSoundProcess.kill();
        currentSoundProcess = null;
    }

    const soundPath = path.join(context.extensionPath, 'sounds', 'error.mp3');
    const volume = vscode.workspace
        .getConfiguration('terminalSounds')
        .get<number>('volume', 0.7);

    const platform = os.platform();
    let command: string;

    if (platform === 'win32') {
        // Use VBScript + WMPlayer.OCX for near-instant playback
        const vbsPath = path.join(context.extensionPath, 'scripts', 'play.vbs');
        const vol = Math.round(volume * 100);
        command = `cscript //nologo "${vbsPath}" "${soundPath}" ${vol}`;
    } else if (platform === 'darwin') {
        command = `afplay --volume ${volume} "${soundPath}"`;
    } else {
        command =
            `paplay "${soundPath}" 2>/dev/null || ` +
            `aplay "${soundPath}" 2>/dev/null || ` +
            `mpv --no-video --volume=${Math.round(volume * 100)} "${soundPath}" 2>/dev/null`;
    }

    currentSoundProcess = exec(command, (err) => {
        currentSoundProcess = null;
        if (err && !err.killed) {
            console.error(
                '[Terminal Sounds] Failed to play error sound:',
                err.message
            );
        }
    });
}

// ─── Deactivation ─────────────────────────────────────────────────────────────
export function deactivate() {
    if (currentSoundProcess) {
        currentSoundProcess.kill();
        currentSoundProcess = null;
    }
}
