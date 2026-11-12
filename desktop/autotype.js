// Windows helper (one resident PowerShell process, values only via stdin – never on a command line):
//  - auto-type like KeePass: types into the focused window via SendInput (Unicode, layout independent; real keys with
//    scan codes in remote desktop/VM windows #332; nothing into Windows' credential dialog #336 – same as Typing.cs)
//  - secret clipboard: copies text with the markers that keep it out of the Windows clipboard history (Win+V)
//    and the cloud clipboard (sync to other devices).

import { spawn } from 'node:child_process';

export const SOURCE = String.raw`
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
    // Another program (clipboard monitor, history, sync) may hold it: up to ~5 s, pauses 25 ms doubling to 250 ms
    // (#526, same as windows/Setup/Clip.cs).
    bool open = false;
    var watch = System.Diagnostics.Stopwatch.StartNew();
    for (int pause = 25; !(open = OpenClipboard(IntPtr.Zero)) && watch.ElapsedMilliseconds < 5000; pause = Math.Min(pause * 2, 250)) Thread.Sleep(pause);
    if (!open) throw new Exception("clipboard held by another program");
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

  [DllImport("user32.dll")] static extern short GetKeyState(int key);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanEx(char ch, IntPtr layout);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr layout);

  const uint KEYUP = 2, UNICODE = 4;
  const ushort VK_SHIFT = 0xA0, VK_CONTROL = 0xA2, VK_MENU = 0xA4, VK_CAPITAL = 0x14, VK_SPACE = 0x20;

  // Same lists and rules as windows/Setup/Typing.cs (#332, #336) – keep the two in step.
  static readonly string[] RemotePrograms = { "mstsc", "msrdc", "vmconnect", "vmware", "vmplayer", "VirtualBoxVM", "RDCMan", "mRemoteNG", "RoyalTS", "RemoteDesktopManager", "vncviewer", "tvnviewer", "wfica32", "CDViewer" };
  static readonly string[] RemoteClasses = { "TscShellContainerClass" };
  const string SecureDialogClass = "Credential Dialog Xaml Host";

  struct Stroke { public ushort Vk, Scan; public uint Flags; }

  static bool Key(ushort vk, ushort scan, uint flags) {
    var input = new INPUT[1];
    input[0].type = 1;
    input[0].u.ki.wVk = vk;
    input[0].u.ki.wScan = scan;
    input[0].u.ki.dwFlags = flags;
    return SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  static bool Press(ushort vk, IntPtr layout) {
    ushort scan = (ushort)MapVirtualKeyEx(vk, 0, layout); // MAPVK_VK_TO_VSC
    return Key(vk, scan, 0) & Key(vk, scan, KEYUP);
  }

  static void Add(System.Collections.Generic.List<Stroke> plan, ushort vk, IntPtr layout, uint flags) {
    Stroke s = new Stroke();
    s.Vk = vk; s.Scan = (ushort)MapVirtualKeyEx(vk, 0, layout); s.Flags = flags;
    plan.Add(s);
  }

  // One character as real keys of the layout (Shift/Ctrl/Alt around it); a dead key is followed by a space. Null: Unicode.
  static System.Collections.Generic.List<Stroke> PlanChar(char c, IntPtr layout) {
    short r = VkKeyScanEx(c, layout);
    if (r == -1) return null;
    ushort vk = (ushort)(r & 0xFF);
    int mods = (r >> 8) & 0xFF;
    if (vk == 0xFF || (mods & ~7) != 0) return null;
    var down = new System.Collections.Generic.List<ushort>();
    if ((mods & 2) != 0) down.Add(VK_CONTROL);
    if ((mods & 4) != 0) down.Add(VK_MENU);
    if ((mods & 1) != 0) down.Add(VK_SHIFT);
    var plan = new System.Collections.Generic.List<Stroke>();
    foreach (ushort m in down) Add(plan, m, layout, 0);
    Add(plan, vk, layout, 0);
    Add(plan, vk, layout, KEYUP);
    for (int i = down.Count - 1; i >= 0; i--) Add(plan, down[i], layout, KEYUP);
    if ((MapVirtualKeyEx(vk, 2, layout) & 0x80000000) != 0) { // MAPVK_VK_TO_CHAR: high bit = dead key
      Add(plan, VK_SPACE, layout, 0);
      Add(plan, VK_SPACE, layout, KEYUP);
    }
    return plan;
  }

  // Program and class of the window in front; true for remote desktop and VM windows (they forward scan codes only).
  static bool IsRemoteWindow(IntPtr hwnd, out string program, out string cls, out uint thread) {
    var sb = new System.Text.StringBuilder(256);
    GetClassName(hwnd, sb, sb.Capacity);
    cls = sb.ToString();
    uint pid;
    thread = GetWindowThreadProcessId(hwnd, out pid);
    program = "";
    try { program = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
    foreach (string p in RemotePrograms) if (string.Equals(p, program, StringComparison.OrdinalIgnoreCase)) return true;
    foreach (string c in RemoteClasses) if (string.Equals(c, cls, StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }

  // Checks the key plan for a fixed sample in this process's layout (types nothing): "ok" or the list of errors.
  public static string SelfTest() {
    IntPtr layout = GetKeyboardLayout(0);
    var errors = new System.Collections.Generic.List<string>();
    var a = PlanChar('a', layout);
    if (a == null || a.Count != 2 || a[0].Vk != 0x41 || a[0].Scan == 0 || a[1].Flags != KEYUP) errors.Add("a");
    var upper = PlanChar('A', layout);
    if (upper == null || upper.Count != 4 || upper[0].Vk != VK_SHIFT || upper[1].Vk != 0x41 || upper[3].Vk != VK_SHIFT || upper[3].Flags != KEYUP) errors.Add("A");
    if (PlanChar((char)0x6F22, layout) != null) errors.Add("unicode");
    foreach (char c in "aZ1!@#$%^&*()_+-=[]{};:'\",.<>/?\\|~") {
      var plan = PlanChar(c, layout);
      if (plan == null) continue;
      var held = new System.Collections.Generic.HashSet<ushort>();
      foreach (Stroke s in plan) {
        if (s.Scan == 0) errors.Add("scan " + (int)c);
        if (s.Flags == 0) held.Add(s.Vk); else held.Remove(s.Vk);
      }
      if (held.Count > 0) errors.Add("held " + (int)c);
    }
    return errors.Count == 0 ? "ok" : string.Join(", ", errors.ToArray());
  }

  // Types the text. Returns "secure" without typing anything if Windows' credential dialog is in front (it drops all
  // injected input but SendInput still reports success – #336); else "remote" or "unicode" (how it was typed).
  public static string Type(string text) {
    // Wait until Ctrl/Shift/Alt/Win of the shortcut are released – otherwise characters would become shortcuts.
    for (int i = 0; i < 300; i++) {
      bool held = false;
      foreach (int vk in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) if ((GetAsyncKeyState(vk) & 0x8000) != 0) held = true;
      if (!held) break;
      Thread.Sleep(10);
    }
    string program, cls;
    uint thread;
    bool remote = IsRemoteWindow(GetForegroundWindow(), out program, out cls, out thread);
    if (string.Equals(cls, SecureDialogClass, StringComparison.OrdinalIgnoreCase)) return "secure";
    IntPtr layout = GetKeyboardLayout(remote ? thread : 0);
    bool ok = true;
    // Caps Lock would turn Shift+A into "a": off while typing, on again afterwards.
    bool caps = remote && (GetKeyState(VK_CAPITAL) & 1) != 0;
    if (caps) ok &= Press(VK_CAPITAL, layout);
    try {
      foreach (char c in text) {
        if (c == '\r') continue;
        if (c == '\n') ok &= Key(0x0D, 0x1C, 0) & Key(0x0D, 0x1C, KEYUP);
        else if (c == '\t') ok &= Key(0x09, 0x0F, 0) & Key(0x09, 0x0F, KEYUP);
        else {
          var plan = remote ? PlanChar(c, layout) : null;
          if (plan == null) ok &= Key(0, c, UNICODE) & Key(0, c, UNICODE | KEYUP);
          else foreach (Stroke s in plan) ok &= Key(s.Vk, s.Scan, s.Flags);
        }
        // The remote side needs a little more time per key (its sign-in screen drops keys otherwise).
        Thread.Sleep(remote ? 20 : 6);
      }
    } finally {
      if (caps) Press(VK_CAPITAL, layout);
    }
    if (!ok) throw new Exception("input refused (target runs elevated?)");
    return remote ? "remote" : "unicode";
  }
}
`;

// The helper stays running (compiling the C# part takes seconds): one line per value, base64 (UTF-8).
// #526: no progress records – with -EncodedCommand they go to stderr as CLIXML, which nobody reads here.
const SCRIPT = `$ProgressPreference = 'SilentlyContinue'\nAdd-Type -TypeDefinition @'\n${SOURCE}\n'@
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(2)))
    if ($line.StartsWith('C:')) { [KvAutoType]::SetSecretClipboard($text); [Console]::Out.WriteLine('done') }
    elseif ([KvAutoType]::Type($text) -eq 'secure') { [Console]::Out.WriteLine('secure') }
    else { [Console]::Out.WriteLine('done') }
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
      // Windows' credential dialog took no input (#336): nothing was typed.
      else if (line === 'secure') state.waiting.shift()?.reject(Object.assign(new Error('secure dialog'), { code: 'SECURE_DIALOG' }));
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
