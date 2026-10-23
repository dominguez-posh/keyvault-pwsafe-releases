// Windows helper (one resident PowerShell process, values only via stdin – never on a command line):
//  - auto-type like KeePass: types into the focused window via SendInput (Unicode, layout independent)
//  - secret clipboard: copies text with the markers that keep it out of the Windows clipboard history (Win+V)
//    and the cloud clipboard (sync to other devices).

import { spawn } from 'node:child_process';

const SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class KvAutoType {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern bool EmptyClipboard();
  [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr mem);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr mem);

  static IntPtr Global(byte[] data) {
    IntPtr mem = GlobalAlloc(0x0002, (UIntPtr)data.Length); // GMEM_MOVEABLE
    IntPtr p = GlobalLock(mem);
    Marshal.Copy(data, 0, p, data.Length);
    GlobalUnlock(mem);
    return mem;
  }

  public static void SetSecretClipboard(string text) {
    bool open = false;
    for (int i = 0; i < 20 && !(open = OpenClipboard(IntPtr.Zero)); i++) Thread.Sleep(25);
    if (!open) throw new Exception("clipboard busy");
    try {
      EmptyClipboard();
      SetClipboardData(13, Global(System.Text.Encoding.Unicode.GetBytes(text + "\0"))); // CF_UNICODETEXT
      byte[] no = BitConverter.GetBytes(0);
      SetClipboardData(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"), Global(new byte[] { 0 }));
      SetClipboardData(RegisterClipboardFormat("CanIncludeInClipboardHistory"), Global(no));
      SetClipboardData(RegisterClipboardFormat("CanUploadToCloudClipboard"), Global(no));
    } finally {
      CloseClipboard();
    }
  }

  const uint KEYUP = 2, UNICODE = 4;

  static void Key(ushort vk, ushort scan, uint flags) {
    var input = new INPUT[1];
    input[0].type = 1;
    input[0].u.ki.wVk = vk;
    input[0].u.ki.wScan = scan;
    input[0].u.ki.dwFlags = flags;
    SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Type(string text) {
    // Wait until Ctrl/Shift/Alt/Win of the shortcut are released – otherwise characters would become shortcuts.
    for (int i = 0; i < 300; i++) {
      bool held = false;
      foreach (int vk in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) if ((GetAsyncKeyState(vk) & 0x8000) != 0) held = true;
      if (!held) break;
      Thread.Sleep(10);
    }
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { Key(0x0D, 0, 0); Key(0x0D, 0, KEYUP); }
      else if (c == '\t') { Key(0x09, 0, 0); Key(0x09, 0, KEYUP); }
      else { Key(0, c, UNICODE); Key(0, c, UNICODE | KEYUP); }
      Thread.Sleep(6);
    }
  }
}
`;

// The helper stays running (compiling the C# part takes seconds): one line per value, base64 (UTF-8).
const SCRIPT = `Add-Type -TypeDefinition @'\n${SOURCE}\n'@
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(2)))
    if ($line.StartsWith('C:')) { [KvAutoType]::SetSecretClipboard($text) } else { [KvAutoType]::Type($text) }
    [Console]::Out.WriteLine('done')
  }
  catch { [Console]::Out.WriteLine('error ' + $_.Exception.Message) }
}`;
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

let helper = null;

function startHelper() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], { windowsHide: true });
  const state = { child, waiting: [], buffer: '', ready: null };
  state.ready = new Promise((resolve, reject) => {
    state.onReady = resolve;
    child.on('error', reject);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.buffer += chunk;
    let i;
    while ((i = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, i).trim();
      state.buffer = state.buffer.slice(i + 1);
      if (line === 'ready') state.onReady();
      else if (line === 'done') state.waiting.shift()?.resolve();
      else if (line.startsWith('error')) state.waiting.shift()?.reject(new Error(line.slice(6)));
    }
  });
  child.on('exit', () => {
    for (const w of state.waiting.splice(0)) w.reject(new Error('auto-type helper ended'));
    if (helper === state) helper = null;
  });
  return state;
}

/** Starts the helper ahead of time so that the first auto-type is instant (Windows only). */
export function warmUpAutoType() {
  if (process.platform === 'win32' && !helper) helper = startHelper();
}

function send(kind, text) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Only available on Windows'));
  warmUpAutoType();
  const h = helper;
  return h.ready.then(() => new Promise((resolve, reject) => {
    h.waiting.push({ resolve, reject });
    h.child.stdin.write(`${kind}:${Buffer.from(String(text), 'utf8').toString('base64')}\n`);
  }));
}

/** Types text into the focused window (Windows only). Resolves when done. */
export const typeText = (text) => send('T', text);

/** Puts text on the clipboard, excluded from clipboard history and cloud clipboard (Windows only). */
export const copySecret = (text) => send('C', text);

export function stopAutoType() {
  helper?.child.stdin.end();
  helper = null;
}
