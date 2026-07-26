# Prints the native window tree of a running Electron app, top of the Z order
# first, so it can be seen where Chromium puts its rendering output.
#
#   pwsh -File scripts/embedded-mpv/windows-window-tree.ps1
#   pwsh -File scripts/embedded-mpv/windows-window-tree.ps1 -ProcessName Remo
#
# WHY THIS EXISTS
#
# empv's Windows backend gives mpv an OS child window and reparents it into the
# Electron window. Whether that window can composite *beneath* the page --
# zOrder 'underlay', which only the macOS backend offers today -- turns on one
# fact that cannot be reasoned out from the Win32 rules alone:
#
#   If Chromium paints into a child HWND of its own, that window and mpv's are
#   siblings, and sibling Z order is settable. Underlay becomes a SetWindowPos
#   call.
#
#   If Chromium composites through DirectComposition straight onto the top-level
#   window, mpv's window is a child of the surface being drawn, and a child HWND
#   is always painted after its parent's client area. No flag changes that, and
#   underlay would need a different presentation model entirely -- rendering
#   offscreen and handing the surface to the compositor, the way macOS does with
#   a CALayer.
#
# The two answers differ by about two orders of magnitude in work, which is why
# this runs before anything is written.
#
# WHAT TO LOOK FOR
#
# A child named Chrome_RenderWidgetHostHWND under the top-level Chrome_WidgetWin_*
# means the first case. Its absence -- a top-level window with no painting child --
# means the second. "Intermediate D3D Window" appearing under the render widget
# host is a further hint that composition is happening in a child surface.
#
# Note what this does NOT establish: a window class existing is not proof that
# pixels arrive through it. Chromium can keep a legacy child HWND around for
# input while compositing elsewhere. A positive result here justifies the pixel
# test, it does not replace it.
[CmdletBinding()]
param(
    [string]$ProcessName = 'electron'
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowTree
{
    public delegate bool EnumProc(IntPtr handle, IntPtr param);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr handle, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr handle, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr handle, uint command);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowLongPtrW(IntPtr handle, int index);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr handle, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static string ClassOf(IntPtr handle)
    {
        var text = new StringBuilder(256);
        GetClassNameW(handle, text, text.Capacity);
        return text.ToString();
    }

    public static string TitleOf(IntPtr handle)
    {
        var text = new StringBuilder(256);
        GetWindowTextW(handle, text, text.Capacity);
        return text.ToString();
    }
}
'@

# GW_HWNDNEXT walks siblings in Z order, nearest the top first. Enumerating with
# EnumChildWindows alone gives no ordering, and ordering is the whole question.
$GW_HWNDNEXT = 2
$GWL_STYLE = -16
$GWL_EXSTYLE = -20

function Show-Children {
    param([IntPtr]$Parent, [int]$Depth)

    $children = New-Object System.Collections.ArrayList
    $collector = [WindowTree+EnumProc] {
        param($handle, $unused)
        if ([WindowTree]::GetParent($handle) -eq $Parent) {
            [void]$children.Add($handle)
        }
        return $true
    }
    [void][WindowTree]::EnumChildWindows($Parent, $collector, [IntPtr]::Zero)
    if ($children.Count -eq 0) { return }

    # Re-order by Z: start from the first child and follow GW_HWNDNEXT.
    $ordered = New-Object System.Collections.ArrayList
    $cursor = [WindowTree]::GetWindow($children[0], 3) # GW_HWNDFIRST
    while ($cursor -ne [IntPtr]::Zero) {
        if ($children -contains $cursor) { [void]$ordered.Add($cursor) }
        $cursor = [WindowTree]::GetWindow($cursor, $GW_HWNDNEXT)
    }
    foreach ($handle in $children) {
        if (-not ($ordered -contains $handle)) { [void]$ordered.Add($handle) }
    }

    $pad = '  ' * $Depth
    foreach ($handle in $ordered) {
        $rect = New-Object WindowTree+RECT
        [void][WindowTree]::GetWindowRect($handle, [ref]$rect)
        $style = [WindowTree]::GetWindowLongPtrW($handle, $GWL_STYLE)
        $exStyle = [WindowTree]::GetWindowLongPtrW($handle, $GWL_EXSTYLE)
        $visible = if ([WindowTree]::IsWindowVisible($handle)) { 'visible' } else { 'hidden ' }
        $title = [WindowTree]::TitleOf($handle)
        $suffix = if ($title) { " `"$title`"" } else { '' }
        Write-Host ("{0}0x{1:X8}  {2}  {3,-34} {4}x{5}  style=0x{6:X} ex=0x{7:X}{8}" -f `
            $pad, $handle.ToInt64(), $visible, [WindowTree]::ClassOf($handle), `
            ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top), $style, $exStyle, $suffix)
        Show-Children -Parent $handle -Depth ($Depth + 1)
    }
}

$processes = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 })

if ($processes.Count -eq 0) {
    Write-Host "No visible window found for a process named '$ProcessName'."
    Write-Host 'Start the app first, or pass -ProcessName with the executable name.'
    exit 1
}

foreach ($process in $processes) {
    $handle = $process.MainWindowHandle
    Write-Host ''
    Write-Host ("top-level 0x{0:X8}  {1,-34} `"{2}`"  (pid {3})" -f `
        $handle.ToInt64(), [WindowTree]::ClassOf($handle), $process.MainWindowTitle, $process.Id)
    Write-Host '  children, top of the Z order first:'
    Show-Children -Parent $handle -Depth 2
}

Write-Host ''
Write-Host 'Chrome_RenderWidgetHostHWND present -> mpv''s window can be its sibling; underlay may be a SetWindowPos away.'
Write-Host 'Absent -> Chromium composites onto the top-level window and a child HWND cannot get beneath it.'
