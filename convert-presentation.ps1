param(
    [Parameter(Mandatory=$true)][string]$PresentationPath,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$powerPoint = $null
$deck = $null
$printRange = $null
$previousSecurity = $null
$previousAlerts = $null
$stage = 'validate'
$succeeded = $false

try {
    $source = Get-Item -LiteralPath $PresentationPath
    if ($source.Extension.ToLowerInvariant() -notin @('.pptx', '.ppsx')) {
        throw 'For direct slides, save this older PowerPoint file as .pptx or PDF, then select it here.'
    }

    # PowerPoint has no Open(... UpdateLinks:=false) parameter. Inspect the package BEFORE
    # opening it, rather than changing links after an automatic update could already occur.
    # Ordinary click-only hyperlinks are harmless to static export. Other external relationships
    # must be embedded by the author or exported to PDF, so this conversion never refreshes them.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($source.FullName)
    try {
        if ($archive.Entries.Count -gt 15000) { throw 'This PowerPoint contains too many parts. Save it as PDF and select that PDF here.' }
        if ($null -eq $archive.GetEntry('ppt/presentation.xml')) { throw 'This file is not a valid modern PowerPoint presentation.' }
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -match '(?i)(^|/)(vbaProject\.bin|activeX)(/|$)') {
                throw 'This presentation contains macros or active controls. Export it as PDF and select that PDF here.'
            }
            if (-not $entry.FullName.EndsWith('.rels', [StringComparison]::OrdinalIgnoreCase)) { continue }
            if ($entry.Length -gt 4MB) { throw 'This PowerPoint has unusually large relationship data. Save it as PDF and select that PDF here.' }
            $stream = $entry.Open()
            $reader = $null
            try {
                $settings = New-Object System.Xml.XmlReaderSettings
                $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
                $settings.XmlResolver = $null
                $settings.MaxCharactersInDocument = 4MB
                $reader = [System.Xml.XmlReader]::Create($stream, $settings)
                while ($reader.Read()) {
                    if ($reader.NodeType -ne [System.Xml.XmlNodeType]::Element -or $reader.LocalName -ne 'Relationship') { continue }
                    $targetMode = $reader.GetAttribute('TargetMode')
                    $type = $reader.GetAttribute('Type')
                    $target = $reader.GetAttribute('Target')
                    $outsidePackage = ($targetMode -eq 'External') -or ($target -match '^[A-Za-z][A-Za-z0-9+.-]*:|^\\\\|^//')
                    if ($outsidePackage -and $type -notmatch '/hyperlink$') {
                        throw 'This PowerPoint links to external media or data. Static import stopped before opening the deck. Embed those items in PowerPoint and add the deck again, or use Play animations to present it in PowerPoint.'
                    }
                }
            } finally {
                if ($null -ne $reader) { $reader.Dispose() }
                $stream.Dispose()
            }
        }
    } finally { $archive.Dispose() }

    $stage = 'start'
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $previousSecurity = $powerPoint.AutomationSecurity
    $previousAlerts = $powerPoint.DisplayAlerts
    $powerPoint.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
    $powerPoint.DisplayAlerts = 1 # ppAlertsNone; do not interact with dialogs
    $stage = 'open'
    try {
        # ReadOnly=msoTrue, Untitled=msoFalse, WithWindow=msoFalse.
        $deck = $powerPoint.Presentations.Open($source.FullName, -1, 0, 0)
    } finally {
        # Restore the user's global setting immediately after the only programmatic file open.
        $powerPoint.AutomationSecurity = $previousSecurity
    }
    if ($deck.Slides.Count -lt 1) { throw 'This presentation contains no slides.' }
    $stage = 'export'
    # Fixed-format PDF is deliberately static: no animations, transitions, audio or embedded video.
    # KeepIRMSettings=true preserves any document protection; nothing relaxes user security settings.
    $printRange = $deck.PrintOptions.Ranges.Add(1, $deck.Slides.Count)
    $deck.ExportAsFixedFormat($OutputPath, 2, 2, 0, 1, 1, 0, $printRange, 4, '', $false, $true, $true, $true, $false)
    if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) { throw 'PowerPoint did not create a PDF.' }
    $succeeded = $true
} catch {
    $validationMessage = $_.Exception.Message
    $message = switch ($stage) {
        'validate' { $validationMessage }
        'start' { 'Microsoft PowerPoint could not start. Install and activate PowerPoint, or save the presentation as PDF and select that PDF here.' }
        'open' { 'PowerPoint could not open this presentation. Open it in PowerPoint, finish any activation or password prompt, then save it as PDF and select that PDF here.' }
        'export' { 'PowerPoint could not export these slides. Open it in PowerPoint, finish any activation prompt, then save it as PDF and select that PDF here.' }
    }
    [Console]::Error.WriteLine('THEATER_ERROR: ' + ($message -replace '[\r\n]+', ' '))
} finally {
    if ($null -ne $printRange) { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($printRange) }
    if ($null -ne $deck) {
        try { $deck.Close() } catch {}
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck)
    }
    if ($null -ne $powerPoint) {
        try { if ($null -ne $previousSecurity) { $powerPoint.AutomationSecurity = $previousSecurity } } catch {}
        try { if ($null -ne $previousAlerts) { $powerPoint.DisplayAlerts = $previousAlerts } } catch {}
        # PowerPoint may share a process with the user's own open files. Never Quit() or kill it.
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint)
    }
}
if (-not $succeeded) { exit 1 }
