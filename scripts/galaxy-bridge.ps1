# galaxy-bridge.ps1 - StarCraft II Galaxy Editor automation bridge.
#
# Runs as a long-lived process and speaks one JSON object per line on stdin,
# answering with one JSON object per line on stdout. Requires -STA for
# clipboard access. All window access goes through Win32 P/Invoke, so no UIA
# or third-party module is needed.
param([switch]$Serve)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

if (-not ("GalaxyNative" -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class GalaxyNative {
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] public static extern IntPtr SendMessageString(IntPtr h, uint msg, IntPtr w, string l);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMenuItemInfoW(IntPtr m, uint item, bool byPos, ref MENUITEMINFO info);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct MENUITEMINFO {
        public uint cbSize; public uint fMask; public uint fType; public uint fState; public uint wID;
        public IntPtr hSubMenu; public IntPtr hbmpChecked; public IntPtr hbmpUnchecked; public IntPtr dwItemData;
        public IntPtr dwTypeData; public uint cch; public IntPtr hbmpItem;
    }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static List<IntPtr> TopWindows(uint pid) {
        var list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint wpid; GetWindowThreadProcessId(h, out wpid);
            if (wpid == pid && IsWindowVisible(h)) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static List<IntPtr> Children(IntPtr root, string className) {
        var list = new List<IntPtr>();
        EnumChildWindows(root, delegate(IntPtr h, IntPtr p) {
            var cn = new StringBuilder(256); GetClassName(h, cn, 256);
            if (className == null || cn.ToString() == className) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static string Text(IntPtr h) {
        var sb = new StringBuilder(2048); GetWindowText(h, sb, 2048); return sb.ToString();
    }
    public static string Class(IntPtr h) {
        var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString();
    }
    public static string MenuDump(IntPtr menu, int depth) {
        var sb = new StringBuilder();
        int n = GetMenuItemCount(menu);
        for (int i = 0; i < n; i++) {
            var info = new MENUITEMINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(MENUITEMINFO));
            info.fMask = 0x2 | 0x4 | 0x40;
            info.dwTypeData = Marshal.AllocHGlobal(2048);
            info.cch = 1024;
            if (GetMenuItemInfoW(menu, (uint)i, true, ref info)) {
                string text = Marshal.PtrToStringUni(info.dwTypeData) ?? "";
                sb.Append(' ', depth * 2).Append(info.wID).Append('\t').Append(text.Replace("\t", " ")).Append('\n');
                if (info.hSubMenu != IntPtr.Zero) sb.Append(MenuDump(info.hSubMenu, depth + 1));
            }
            Marshal.FreeHGlobal(info.dwTypeData);
        }
        return sb.ToString();
    }
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);

    // SetForegroundWindow alone is refused for background processes; attaching
    // to the foreground thread's input queue is the documented workaround.
    public static bool ForceForeground(IntPtr h) {
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
        uint myThread = GetCurrentThreadId();
        if (fgThread != myThread) AttachThreadInput(myThread, fgThread, true);
        ShowWindow(h, 9);
        BringWindowToTop(h);
        bool ok = SetForegroundWindow(h);
        if (fgThread != myThread) AttachThreadInput(myThread, fgThread, false);
        System.Threading.Thread.Sleep(180);
        return GetForegroundWindow() == h;
    }
    public static void SendKey(byte vk, bool down) {
        keybd_event(vk, 0, down ? 0u : 2u, IntPtr.Zero);
    }
    public static void Click(int x, int y, bool right, bool dbl) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(120);
        uint downFlag = right ? 0x0008u : 0x0002u;
        uint upFlag = right ? 0x0010u : 0x0004u;
        mouse_event(downFlag, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(upFlag, 0, 0, 0, IntPtr.Zero);
        if (dbl) {
            System.Threading.Thread.Sleep(80);
            mouse_event(downFlag, 0, 0, 0, IntPtr.Zero);
            System.Threading.Thread.Sleep(60);
            mouse_event(upFlag, 0, 0, 0, IntPtr.Zero);
        }
    }
}
'@

}

# Storm menu command ids observed in the SC2 editor build used for testing.
$script:Commands = @{
    new = 157; open = 158; openReadOnly = 159; close = 160; save = 162; saveAs = 163
    dependencies = 164; publish = 165; testDocument = 170; preferences = 171
    exit = 318
    undo = 180; redo = 181; cut = 182; copy = 183; copyAsText = 184; paste = 185
    delete = 186; selectAll = 187; rename = 188; find = 175; replace = 176
}

function Get-DelayMs($req, $default = 250, $Key = "delayMs") {
    $v = $req.$Key
    if ($v -eq $null) { return $default }
    return [int]$v
}
function ConvertTo-Hashtable($obj) {
    if ($obj -is [System.Collections.IDictionary]) { return $obj }
    return $obj
}

function Get-EditorProcess {
    param([int]$ProcessId)
    if ($ProcessId -gt 0) { return Get-Process -Id $ProcessId -ErrorAction SilentlyContinue }
    $procs = @(Get-Process -Name SC2Editor -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { return $null }
    $best = $null
    foreach ($p in $procs) {
        if ($p.MainWindowHandle -ne 0) { return $p }
        if ($best -eq $null) { $best = $p }
    }
    return $best
}

function Get-WindowInfo([IntPtr]$h) {
    $r = New-Object GalaxyNative+RECT
    [void][GalaxyNative]::GetWindowRect($h, [ref]$r)
    return [ordered]@{
        hwnd = $h.ToInt64()
        title = [GalaxyNative]::Text($h)
        class = [GalaxyNative]::Class($h)
        rect = @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
        visible = [GalaxyNative]::IsWindowVisible($h)
    }
}

function Get-PrimaryWindow($editor) {
    # Document frames, message panels and dialogs are all top-level windows of
    # the editor process. The map frame is the one worth focusing/capturing, so
    # prefer document-looking titles, then the largest visible window.
    $best = $null
    $bestArea = -1
    $bestDoc = $false
    foreach ($h in [GalaxyNative]::TopWindows([uint32]$editor.Id)) {
        $info = Get-WindowInfo $h
        $area = [int]$info.rect.width * [int]$info.rect.height
        if ($area -le 0) { continue }
        $isDoc = ($info.title -like '*触发器*') -or ($info.title -like '*地形*') -or
                 ($info.title -like '*数据*') -or ($info.title -like '*地图*')
        if (($isDoc -and -not $bestDoc) -or ($isDoc -eq $bestDoc -and $area -gt $bestArea)) {
            $best = $h
            $bestArea = $area
            $bestDoc = $isDoc
        }
    }
    if ($best -eq $null) { return $editor.MainWindowHandle }
    return $best
}

function Invoke-Request($req) {
    $cmd = [string]$req.cmd
    switch ($cmd) {
        'ping' { return @{ pong = $true; sta = [System.Threading.Thread]::CurrentThread.ApartmentState.ToString() } }

        'status' {
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            $result = [ordered]@{}
            if ($editor -eq $null) {
                $result.running = $false
            } else {
                $result.running = $true
                $result.pid = $editor.Id
                $result.responding = $editor.Responding
                $wins = @()
                foreach ($h in [GalaxyNative]::TopWindows([uint32]$editor.Id)) {
                    $wins += Get-WindowInfo $h
                }
                $result.windows = $wins
                $main = Get-PrimaryWindow $editor
                if ($main -ne 0) { $result.main = Get-WindowInfo $main }
            }
            $fg = [GalaxyNative]::GetForegroundWindow()
            $result.foreground = @{ hwnd = $fg.ToInt64(); title = [GalaxyNative]::Text($fg) }
            return $result
        }

        'windows' {
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            if ($editor -eq $null) { throw "editor is not running" }
            $wins = @()
            foreach ($h in [GalaxyNative]::TopWindows([uint32]$editor.Id)) { $wins += Get-WindowInfo $h }
            return @{ pid = $editor.Id; windows = $wins }
        }

        'focus' {
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            if ($editor -eq $null) { throw "editor is not running" }
            $h = $editor.MainWindowHandle
            $wasMinimized = [GalaxyNative]::IsIconic($h)
            $focused = [GalaxyNative]::ForceForeground($h)
            return @{ hwnd = $h.ToInt64(); focused = $focused; wasMinimized = $wasMinimized }
        }

        'command' {
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            if ($editor -eq $null) { throw "editor is not running" }
            $id = 0
            if ($req.id -ne $null) { $id = [int]$req.id }
            elseif ($req.name -ne $null) {
                $key = [string]$req.name
                if (-not $script:Commands.ContainsKey($key)) { throw "unknown command name: $key" }
                $id = [int]$script:Commands[$key]
            } else { throw "command requires id or name" }
            $h = $editor.MainWindowHandle
            if ($req.focus -ne $false) { [void][GalaxyNative]::SetForegroundWindow($h) }
            [void][GalaxyNative]::PostMessage($h, 0x0111, [IntPtr]$id, [IntPtr]::Zero)
            Start-Sleep -Milliseconds ((Get-DelayMs $req))
            return @{ command = $id }
        }

        'commands' { return $script:Commands }

        'menu' {
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            if ($editor -eq $null) { throw "editor is not running" }
            return @{ text = [GalaxyNative]::MenuDump([GalaxyNative]::GetMenu($editor.MainWindowHandle), 0) }
        }

        'keys' {
            if ($req.hwnd -ne $null) {
                [void][GalaxyNative]::ForceForeground([IntPtr][int64]$req.hwnd)
            } else {
                $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
                if ($editor -ne $null -and $req.focus -ne $false) {
                    [void][GalaxyNative]::ForceForeground($editor.MainWindowHandle)
                }
            }
            Start-Sleep -Milliseconds 150
            if ($req.sendKeys -ne $null) {
                [System.Windows.Forms.SendKeys]::SendWait([string]$req.sendKeys)
            } elseif ($req.vk -ne $null) {
                $vk = [byte][int]$req.vk
                if ($req.ctrl) { [GalaxyNative]::SendKey(0x11, $true) }
                if ($req.shift) { [GalaxyNative]::SendKey(0x10, $true) }
                if ($req.alt) { [GalaxyNative]::SendKey(0x12, $true) }
                Start-Sleep -Milliseconds 60
                [GalaxyNative]::SendKey($vk, $true)
                Start-Sleep -Milliseconds 60
                [GalaxyNative]::SendKey($vk, $false)
                if ($req.alt) { [GalaxyNative]::SendKey(0x12, $false) }
                if ($req.shift) { [GalaxyNative]::SendKey(0x10, $false) }
                if ($req.ctrl) { [GalaxyNative]::SendKey(0x11, $false) }
            } else { throw "keys requires sendKeys or vk" }
            Start-Sleep -Milliseconds ((Get-DelayMs $req 200))
            return @{ sent = $true }
        }

        'clipboard.get' {
            $do = [System.Windows.Forms.Clipboard]::GetDataObject()
            if ($do -eq $null) { return @{ text = $null; formats = @() } }
            $fmts = @($do.GetFormats())
            $text = $null
            if ($do.GetDataPresent([System.Windows.Forms.DataFormats]::UnicodeText)) {
                $text = [string]$do.GetData([System.Windows.Forms.DataFormats]::UnicodeText)
            }
            return @{ text = $text; formats = $fmts }
        }

        'clipboard.set' {
            $text = [string]$req.text
            $script:lastClip = $text
            [System.Windows.Forms.Clipboard]::SetText($text)
            return @{ bytes = $text.Length }
        }

        'screenshot' {
            if ($req.hwnd -ne $null) {
                $h = [IntPtr][int64]$req.hwnd
            } else {
                $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
                if ($editor -eq $null) { throw "editor is not running" }
                $h = Get-PrimaryWindow $editor
            }
            if ([GalaxyNative]::IsIconic($h)) {
                [void][GalaxyNative]::ShowWindow($h, 9)
                Start-Sleep -Milliseconds 400
            }
            $info = Get-WindowInfo $h
            if ([int]$info.rect.width -lt 300 -or [int]$info.rect.left -lt -10000) {
                [void][GalaxyNative]::ForceForeground($h)
                Start-Sleep -Milliseconds 500
                $info = Get-WindowInfo $h
            }
            $w = [int]$info.rect.width
            $ht = [int]$info.rect.height
            $bmp = New-Object System.Drawing.Bitmap $w, $ht
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $hdc = $g.GetHdc()
            $ok = [GalaxyNative]::PrintWindow($h, $hdc, 2)
            $g.ReleaseHdc($hdc)
            $g.Dispose()
            $out = [string]$req.out
            if ([string]::IsNullOrWhiteSpace($out)) {
                $out = Join-Path $env:TEMP ("galaxy-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".png")
            }
            $dir = Split-Path -Parent $out
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            return @{ path = $out; width = $w; height = $ht; printWindow = $ok }
        }

        'click' {
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            if ($editor -ne $null -and $req.focus -ne $false) {
                [void][GalaxyNative]::SetForegroundWindow($editor.MainWindowHandle)
                Start-Sleep -Milliseconds 150
            }
            $x = [int]$req.x; $y = [int]$req.y
            if ($req.relative -and $editor -ne $null) {
                $info = Get-WindowInfo $editor.MainWindowHandle
                $x = [int]$info.rect.left + $x
                $y = [int]$info.rect.top + $y
            }
            [GalaxyNative]::Click($x, $y, [bool]$req.right, [bool]$req.double)
            Start-Sleep -Milliseconds ((Get-DelayMs $req))
            return @{ x = $x; y = $y }
        }

        'children' {
            $target = [IntPtr][int64]$req.hwnd
            if ($target -eq [IntPtr]::Zero) {
                $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
                if ($editor -eq $null) { throw "editor is not running" }
                $target = $editor.MainWindowHandle
            }
            $list = @()
            foreach ($c in [GalaxyNative]::Children($target, $null)) {
                $list += (Get-WindowInfo $c)
            }
            return @{ hwnd = $target.ToInt64(); children = $list }
        }

        'dialogs' {
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            if ($editor -eq $null) { throw "editor is not running" }
            $list = @()
            foreach ($h in [GalaxyNative]::TopWindows([uint32]$editor.Id)) {
                $i = Get-WindowInfo $h
                if ($h -eq $editor.MainWindowHandle) { continue }
                if ($i.title -like '*编辑器*') { continue }
                $list += $i
            }
            return @{ dialogs = $list }
        }

        'fillDialog' {
            # Set the file-name field of the modal open/save dialog and confirm.
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            if ($editor -eq $null) { throw "editor is not running" }
            $target = $null
            foreach ($h in [GalaxyNative]::TopWindows([uint32]$editor.Id)) {
                if ($h -eq $editor.MainWindowHandle) { continue }
                $title = [GalaxyNative]::Text($h)
                if ([string]::IsNullOrEmpty($req.title) -or $title -like ("*" + $req.title + "*")) { $target = $h; break }
            }
            if ($target -eq $null) { throw "no dialog window found" }
            [void][GalaxyNative]::SetForegroundWindow($target)
            Start-Sleep -Milliseconds 300
            $edit = $null
            foreach ($c in [GalaxyNative]::Children($target, "Edit")) {
                $t = [GalaxyNative]::Text($c)
                if ($t -ne $null) { $edit = $c; break }
            }
            if ($edit -eq $null) {
                foreach ($c in [GalaxyNative]::Children($target, "ComboBox")) {
                    $kids = [GalaxyNative]::Children($c, "Edit")
                    if ($kids.Count -gt 0) { $edit = $kids[0]; break }
                }
            }
            if ($edit -eq $null) { throw "file name field not found in dialog" }
            [void][GalaxyNative]::SetFocus($edit)
            [void][GalaxyNative]::SendMessageString($edit, 0x000C, [IntPtr]::Zero, [string]$req.path)
            Start-Sleep -Milliseconds 200
            [void][GalaxyNative]::PostMessage($target, 0x0111, [IntPtr]1, [IntPtr]::Zero)
            Start-Sleep -Milliseconds ((Get-DelayMs $req 600))
            return @{ dialog = [GalaxyNative]::Text($target); path = [string]$req.path }
        }

        'closeDialog' {
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            if ($editor -eq $null) { throw "editor is not running" }
            $closed = @()
            foreach ($h in [GalaxyNative]::TopWindows([uint32]$editor.Id)) {
                if ($h -eq $editor.MainWindowHandle) { continue }
                $title = [GalaxyNative]::Text($h)
                # Document frames live in their own top-level windows and are
                # titled "... - 《星际争霸II》编辑器"; never close those.
                if ($title -like '*编辑器*') { continue }
                if ($req.title -and ($title -notlike ("*" + $req.title + "*"))) { continue }
                [void][GalaxyNative]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
                $closed += $title
            }
            Start-Sleep -Milliseconds 300
            return @{ closed = $closed }
        }

        'launch' {
            $exe = [string]$req.exe
            if (-not (Test-Path $exe)) { throw "not found: $exe" }
            $args = [string]$req.arguments
            $workdir = [string]$req.workdir
            if ($workdir) {
                Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory $workdir
            } else {
                Start-Process -FilePath $exe -ArgumentList $args
            }
            return @{ launched = $exe }
        }

        'waitWindow' {
            $deadline = (Get-Date).AddMilliseconds((Get-DelayMs $req 15000 -Key "timeoutMs"))
            $pattern = [string]$req.title
            while ((Get-Date) -lt $deadline) {
                $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
                if ($editor -ne $null) {
                    foreach ($h in [GalaxyNative]::TopWindows([uint32]$editor.Id)) {
                        $t = [GalaxyNative]::Text($h)
                        if ($t -like ("*" + $pattern + "*")) {
                            return @{ found = $true; window = (Get-WindowInfo $h) }
                        }
                    }
                }
                Start-Sleep -Milliseconds 250
            }
            return @{ found = $false }
        }

        'close' {
            $editor = Get-EditorProcess -ProcessId ([int]($req.pid))
            if ($editor -eq $null) { throw "editor is not running" }
            [void][GalaxyNative]::PostMessage($editor.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
            if ($req.force) {
                Start-Sleep -Milliseconds 1500
                $editor.Refresh()
                if (-not $editor.HasExited) { $editor.Kill() }
            }
            return @{ closed = $true }
        }

        default { throw "unknown cmd: $cmd" }
    }
}

function Write-Response($obj) {
    $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

if (-not $Serve) {
    # One-shot mode: run the JSON request given on the command line.
    $req = ConvertFrom-Json $args[0]
    try {
        $r = Invoke-Request $req
        Write-Response @{ ok = $true; result = $r }
    } catch {
        Write-Response @{ ok = $false; error = $_.Exception.Message }
        exit 1
    }
    exit 0
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $seq = $null
    try {
        $req = ConvertFrom-Json $line
        # 'seq' correlates the envelope; 'id' stays free for menu command ids.
        $seq = $req.seq
        $result = Invoke-Request $req
        Write-Response @{ seq = $seq; ok = $true; result = $result }
    } catch {
        Write-Response @{ seq = $seq; ok = $false; error = $_.Exception.Message }
    }
}




