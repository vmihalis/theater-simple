param([Parameter(Mandatory=$true)][string]$PresentationPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$powerPoint = $null
$deck = $null
$show = $null
$previousSecurity = $null
$previousAlerts = $null
$restoreSettings = $false
$busyRetry = $false
$nativeHelpers = $false
$nativeHelperError = ''
$windowsBefore = @()
$stage = 'validate'
function Reply($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

# PowerPoint rejects calls from other processes while it is busy, for example while a
# slideshow is starting or an animation is rendering (RPC_E_CALL_REJECTED, 0x80010001).
# Without a message filter, COM fails the call at once. This is the filter Microsoft
# documents for Office automation: retry calls PowerPoint asks us to retry later.
$filterSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace TheaterSimple {
    [ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IOleMessageFilter {
        [PreserveSig] int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo);
        [PreserveSig] int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType);
        [PreserveSig] int MessagePending(IntPtr taskCallee, int tickCount, int pendingType);
    }
    public sealed class BusyRetryFilter : IOleMessageFilter {
        [DllImport("ole32.dll")] static extern int CoRegisterMessageFilter(IOleMessageFilter newFilter, out IOleMessageFilter oldFilter);
        public static int Register() { IOleMessageFilter old; return CoRegisterMessageFilter(new BusyRetryFilter(), out old); }
        public static int Revoke() { IOleMessageFilter old; return CoRegisterMessageFilter(null, out old); }
        public int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo) { return 0; }
        // SERVERCALL_RETRYLATER (2): retry after 100 ms for up to 30 s. Anything else is cancelled.
        public int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType) { return rejectType == 2 && tickCount < 30000 ? 100 : -1; }
        public int MessagePending(IntPtr taskCallee, int tickCount, int pendingType) { return 2; }
    }
    // Lists top-level windows of the given processes as "handle|class|visible".
    public static class TopWindows {
        delegate bool EnumProc(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr window);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
        public static string[] List(int[] processIds) {
            var owners = new HashSet<uint>();
            foreach (var id in processIds) owners.Add((uint)id);
            var found = new List<string>();
            EnumProc callback = (window, parameter) => {
                uint owner;
                GetWindowThreadProcessId(window, out owner);
                if (owners.Contains(owner)) {
                    var name = new StringBuilder(256);
                    GetClassName(window, name, name.Capacity);
                    var title = new StringBuilder(Math.Min(GetWindowTextLength(window) + 1, 4096));
                    if (title.Capacity > 1) GetWindowText(window, title, title.Capacity);
                    var encodedTitle = Convert.ToBase64String(Encoding.UTF8.GetBytes(title.ToString()));
                    found.Add(window.ToInt64() + "|" + name + "|" + (IsWindowVisible(window) ? "1" : "0") + "|" + encodedTitle);
                }
                return true;
            };
            EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return found.ToArray();
        }
    }
}
'@

# Retries a step that PowerPoint may refuse until the slideshow has finished starting.
function Retry([scriptblock]$action, [int]$milliseconds = 10000) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($milliseconds)
    while ($true) {
        try { return & $action }
        catch { if ([DateTime]::UtcNow -ge $deadline) { throw } ; Start-Sleep -Milliseconds 200 }
    }
}
function Position($id) {
    $view = $show.View
    return @{id=$id; slide=[int]$view.CurrentShowPosition; slides=[int]$deck.Slides.Count; click=[int]$view.GetClickIndex(); clicks=[int]$view.GetClickCount()}
}
function Get-PowerPointWindows {
    if (-not $nativeHelpers) { return @() }
    $ids = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    if ($ids.Count -eq 0) { return @() }
    return @([TheaterSimple.TopWindows]::List([int[]]$ids) | ForEach-Object {
        $parts = $_.Split('|')
        [pscustomobject]@{ Handle = [int64]$parts[0]; Class = $parts[1]; Visible = ($parts[2] -eq '1'); Title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[3])) }
    })
}
function Find-OwnedSlideshowWindow($windows, $existing, [string]$name) {
    # Windows from other presentations, editor windows and Office dialogs must
    # never become the projector picture, even if they appeared at the same time.
    $newShows = @($windows | Where-Object { $_.Visible -and $_.Class -eq 'screenClass' -and ($existing -notcontains $_.Handle) })
    $owned = @($newShows | Where-Object { $_.Title -and $_.Title.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($owned.Count -eq 1) { return $owned[0].Handle }
    if ($owned.Count -gt 1) { throw 'PowerPoint opened multiple matching slideshow windows.' }
    if ($newShows.Count -eq 0) { throw 'PowerPoint did not report a new slideshow window.' }
    throw 'PowerPoint opened a slideshow window, but it could not be matched to this presentation.'
}
function Get-SlideshowWindowHandle {
    $handle = $null
    # HWND is hidden in PowerPoint's type library, so PowerShell does not list it, and its
    # dispatch number differs between versions. Ask PowerPoint for it by name instead.
    try { $handle = $show.GetType().InvokeMember('HWND', [Reflection.BindingFlags]::GetProperty, $null, $show, $null) } catch {}
    if (-not $handle) {
        if (-not $nativeHelpers) { throw "PowerPoint window inspection could not start: $nativeHelperError" }
        # The private copy has a unique basename, so its window title identifies
        # the show even when another PowerPoint instance starts concurrently.
        $name = [IO.Path]::GetFileNameWithoutExtension($PresentationPath)
        $handle = Find-OwnedSlideshowWindow (Get-PowerPointWindows) $windowsBefore $name
    }
    return ([uint64]([int64]$handle -band 0xffffffff)).ToString()
}
# Names the failing step and PowerPoint's own code and message, so a failure can be diagnosed.
function Describe($record) {
    $exception = $record.Exception
    while ($exception.InnerException -and -not ($exception -is [Runtime.InteropServices.COMException])) { $exception = $exception.InnerException }
    $text = ($exception.Message -replace '\s+', ' ').Trim()
    if ($text.Length -gt 240) { $text = $text.Substring(0, 240) + '...' }
    $detail = 'step {0}, code 0x{1:X8}: {2}' -f $stage, $exception.HResult, $text
    if (-not $busyRetry) { $detail += ' (busy-retry off)' }
    return $detail
}

try {
    & (Join-Path $PSScriptRoot 'validate-presentation.ps1') -PresentationPath $PresentationPath
    $stage = 'prepare'
    try {
        Add-Type -TypeDefinition $filterSource -Language CSharp
        $nativeHelpers = $true
        $busyRetry = ([TheaterSimple.BusyRetryFilter]::Register() -eq 0)
    } catch { $busyRetry = $false; $nativeHelperError = $_.Exception.Message }
    $stage = 'app'
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $stage = 'open'
    $previousSecurity = $powerPoint.AutomationSecurity
    $previousAlerts = $powerPoint.DisplayAlerts
    try {
        $restoreSettings = $true
        $powerPoint.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
        $powerPoint.DisplayAlerts = 1 # ppAlertsNone: never wait on a hidden dialog
        # Read-only private copy, no editing window to accidentally advance separately.
        $deck = $powerPoint.Presentations.Open($PresentationPath, -1, 0, 0)
    } finally {
        if ($restoreSettings) {
            $powerPoint.AutomationSecurity = $previousSecurity
            $powerPoint.DisplayAlerts = $previousAlerts
            $restoreSettings = $false
        }
    }
    if ($deck.Slides.Count -lt 1) { throw 'This presentation contains no slides.' }
    $stage = 'show'
    $deck.SlideShowSettings.ShowType = 2 # ppShowTypeWindow: works with one or two displays.
    $deck.SlideShowSettings.ShowWithAnimation = -1
    $windowsBefore = @(Get-PowerPointWindows | ForEach-Object { $_.Handle })
    $show = $deck.SlideShowSettings.Run()
    $stage = 'ready'
    # Wait until the show is running before reading its position.
    Retry { if ([int]$show.View.CurrentShowPosition -lt 1) { throw 'Slideshow is still starting.' } } | Out-Null
    # Window placement is cosmetic; the projector captures the window wherever it is.
    try { $show.Left = 10; $show.Top = 10; $show.Width = 960; $show.Height = 600 } catch {}
    $ready = Retry { Position 0 }
    $stage = 'window'
    $ready.hwnd = Retry { Get-SlideshowWindowHandle }
    Reply $ready
    while ($null -ne ($line = [Console]::ReadLine())) {
        $request = $null
        $navigationAttempted = $false
        $navigationApplied = $false
        try {
            $request = $line | ConvertFrom-Json
            switch ($request.action) {
                'next' { $navigationAttempted = $true; $show.View.Next(); $navigationApplied = $true }
                'previous' { $navigationAttempted = $true; $show.View.Previous(); $navigationApplied = $true }
                'focus' { $show.Activate() }
                'status' { }
                default { throw 'Unsupported command' }
            }
            try { Reply (Retry { Position $request.id } 3000) }
            catch {
                # Navigation succeeded; a later position read must not imply that
                # the click failed and invite the operator to advance again.
                if (-not $navigationApplied) { throw }
                Reply @{id=$request.id; positionUnknown=$true}
            }
        } catch {
            Reply @{id=$request.id; error='The slideshow has ended or PowerPoint is busy. Choose the file again to restart it.'; uncertain=$navigationAttempted}
        }
    }
} catch {
    # Inside switch, $_ is the value being switched on, so keep the caught error first.
    $failure = $_
    $message = switch ($stage) {
        'validate' { $failure.Exception.Message }
        'prepare' { 'Theater Simple could not prepare PowerPoint automation on this PC.' }
        'app' { 'Theater Simple could not start Microsoft PowerPoint. Open PowerPoint once, finish any activation or sign-in prompt, close it, then choose the file again.' }
        'open' { 'PowerPoint could not open this presentation. Open it in PowerPoint, resolve any password, repair or protected-view prompt, save it as .pptx, then choose it again.' }
        default { 'PowerPoint opened the presentation but could not start or control the slideshow. Close other PowerPoint slideshows and dialogs, then choose the file again.' }
    }
    if ($stage -ne 'validate') { $message += ' Details: ' + (Describe $failure) }
    Reply @{id=0; error=$message}
} finally {
    if ($null -ne $show) { try { $show.View.Exit() } catch {} }
    if ($null -ne $deck) {
        try { $deck.Saved = -1; $deck.Close() } catch {}
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck)
    }
    if ($null -ne $powerPoint) {
        try { if ($restoreSettings) { $powerPoint.AutomationSecurity = $previousSecurity; $powerPoint.DisplayAlerts = $previousAlerts } } catch {}
        # The Office process may also own unrelated user documents.
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint)
    }
    if ($busyRetry) { try { [void][TheaterSimple.BusyRetryFilter]::Revoke() } catch {} }
}
