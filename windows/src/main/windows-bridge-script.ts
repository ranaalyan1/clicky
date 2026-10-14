/**
 * The PowerShell helper Clickaa keeps running for everything Windows will not
 * let Electron do: real key injection, media/volume control, window control,
 * wallpaper, and the installed-app list.
 *
 * The helper reads one JSON command per line on stdin and answers with one JSON
 * line per command on stdout:
 *
 *   {"id":4,"command":"send_keys","keys":"ctrl+s"}
 *   {"id":4,"ok":true,"result":{}}
 *
 * It is written to disk at start-up (Electron cannot pass a file inside an asar
 * to `powershell -File`) and is deliberately ASCII-only, because Windows
 * PowerShell 5.1 reads un-BOM'd files as ANSI.
 */
export const clickaaWindowsBridgeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

$windowStyleFill = 10
$spiSetDeskWallpaper = 20
$spifUpdateIniFile = 1
$spifSendChange = 2

Add-Type -AssemblyName System.Drawing | Out-Null
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null } catch { }

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class ClickaaNative
{
    public const int KeyEventExtendedKey = 0x0001;
    public const int KeyEventKeyUp = 0x0002;
    public const int KeyEventUnicode = 0x0004;
    public const int MouseEventWheel = 0x0800;

    public const uint InputKeyboard = 1;

    public const int SwMinimize = 6;
    public const int SwMaximize = 3;
    public const int SwRestore = 9;

    public const uint WmClose = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION union;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr windowHandle, StringBuilder text, int maximumCharacterCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr windowHandle, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr windowHandle);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr windowHandle);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr windowHandle);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr windowHandle, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool SystemParametersInfo(uint action, uint parameter, string value, uint update);

    public delegate bool EnumWindowsCallback(IntPtr windowHandle, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    private static INPUT[] MakeKeyInputs(ushort virtualKey, bool isKeyUp)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = InputKeyboard;
        inputs[0].union.ki.wVk = virtualKey;
        inputs[0].union.ki.wScan = 0;
        inputs[0].union.ki.dwFlags = isKeyUp ? KeyEventKeyUp : 0;
        inputs[0].union.ki.time = 0;
        inputs[0].union.ki.dwExtraInfo = IntPtr.Zero;
        return inputs;
    }

    public static void PressVirtualKeys(ushort[] virtualKeys)
    {
        foreach (ushort virtualKey in virtualKeys)
        {
            SendInput(1, MakeKeyInputs(virtualKey, false), Marshal.SizeOf(typeof(INPUT)));
        }

        for (int keyIndex = virtualKeys.Length - 1; keyIndex >= 0; keyIndex--)
        {
            SendInput(1, MakeKeyInputs(virtualKeys[keyIndex], true), Marshal.SizeOf(typeof(INPUT)));
        }
    }

    public static void TapVirtualKey(ushort virtualKey)
    {
        PressVirtualKeys(new ushort[] { virtualKey });
    }

    public static void SendUnicodeText(string text)
    {
        foreach (char character in text)
        {
            INPUT[] downInputs = new INPUT[1];
            downInputs[0].type = InputKeyboard;
            downInputs[0].union.ki.wVk = 0;
            downInputs[0].union.ki.wScan = (ushort)character;
            downInputs[0].union.ki.dwFlags = KeyEventUnicode;
            downInputs[0].union.ki.time = 0;
            downInputs[0].union.ki.dwExtraInfo = IntPtr.Zero;
            SendInput(1, downInputs, Marshal.SizeOf(typeof(INPUT)));

            INPUT[] upInputs = new INPUT[1];
            upInputs[0].type = InputKeyboard;
            upInputs[0].union.ki.wVk = 0;
            upInputs[0].union.ki.wScan = (ushort)character;
            upInputs[0].union.ki.dwFlags = KeyEventUnicode | KeyEventKeyUp;
            upInputs[0].union.ki.time = 0;
            upInputs[0].union.ki.dwExtraInfo = IntPtr.Zero;
            SendInput(1, upInputs, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    public static string DescribeWindowTitle(IntPtr windowHandle)
    {
        if (windowHandle == IntPtr.Zero)
        {
            return string.Empty;
        }
        StringBuilder titleBuilder = new StringBuilder(512);
        GetWindowText(windowHandle, titleBuilder, titleBuilder.Capacity);
        return titleBuilder.ToString();
    }

    public static string DescribeProcessName(IntPtr windowHandle)
    {
        if (windowHandle == IntPtr.Zero)
        {
            return string.Empty;
        }

        uint processId;
        GetWindowThreadProcessId(windowHandle, out processId);
        if (processId == 0)
        {
            return string.Empty;
        }

        try
        {
            return Process.GetProcessById((int)processId).ProcessName;
        }
        catch
        {
            return string.Empty;
        }
    }

    public static IntPtr FindWindow(string fragment, bool matchProcessName)
    {
        string searchFragment = (fragment ?? string.Empty).Trim().ToLowerInvariant();
        IntPtr bestMatch = IntPtr.Zero;
        IntPtr foregroundWindow = GetForegroundWindow();

        EnumWindows(delegate (IntPtr windowHandle, IntPtr parameter)
        {
            if (!IsWindowVisible(windowHandle))
            {
                return true;
            }

            bool matches = false;
            if (matchProcessName)
            {
                matches = DescribeProcessName(windowHandle).ToLowerInvariant().Contains(searchFragment);
            }
            else
            {
                matches = DescribeWindowTitle(windowHandle).ToLowerInvariant().Contains(searchFragment);
            }

            if (matches)
            {
                if (windowHandle == foregroundWindow)
                {
                    bestMatch = windowHandle;
                    return false;
                }
                if (bestMatch == IntPtr.Zero)
                {
                    bestMatch = windowHandle;
                }
            }
            return true;
        }, IntPtr.Zero);

        return bestMatch;
    }

    public static bool ApplyWallpaper(string imagePath, uint updateFlags)
    {
        return SystemParametersInfo(20, 0, imagePath, updateFlags);
    }

    public static void ScrollWheel(int amount)
    {
        mouse_event(MouseEventWheel, 0, 0, amount * 120, UIntPtr.Zero);
    }

    public const int MouseEventLeftDown = 0x0002;
    public const int MouseEventLeftUp = 0x0004;
    public const int MouseEventRightDown = 0x0008;
    public const int MouseEventRightUp = 0x0010;
    public const int MouseEventMiddleDown = 0x0020;
    public const int MouseEventMiddleUp = 0x0040;

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int x;
        public int y;
    }

    /** Parks the pointer where the user asked, in whole pixels. */
    public static bool MoveTo(int x, int y)
    {
        return SetCursorPos(x, y);
    }

    public static int[] ReadCursorPosition()
    {
        POINT point;
        GetCursorPos(out point);
        int[] position = new int[2];
        position[0] = point.x;
        position[1] = point.y;
        return position;
    }

    /**
     * A real click: the pointer moves first so hover states, tooltips and focus
     * all land the way they would for the user's own hand.
     */
    public static void ClickAt(int x, int y, string button, bool isDoubleClick)
    {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(60);

        int downFlag = MouseEventLeftDown;
        int upFlag = MouseEventLeftUp;
        if (button == "right")
        {
            downFlag = MouseEventRightDown;
            upFlag = MouseEventRightUp;
        }
        else if (button == "middle")
        {
            downFlag = MouseEventMiddleDown;
            upFlag = MouseEventMiddleUp;
        }

        int clickCount = isDoubleClick ? 2 : 1;
        for (int clickIndex = 0; clickIndex < clickCount; clickIndex++)
        {
            mouse_event((uint)downFlag, 0, 0, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(40);
            mouse_event((uint)upFlag, 0, 0, 0, UIntPtr.Zero);
            if (clickIndex + 1 < clickCount)
            {
                System.Threading.Thread.Sleep(80);
            }
        }
    }

    private const int RenderDataFlow = 0;
    private const int MultimediaRole = 1;
    private const int AllClassContexts = 23;

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject
    {
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice endpoint);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        int Activate(ref Guid interfaceId, int classContext, IntPtr activationParameters, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
        int OpenPropertyStore(int storageAccess, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr notify);
        int UnregisterControlChangeNotify(IntPtr notify);
        int GetChannelCount(out int channelCount);
        int SetMasterVolumeLevel(float level, ref Guid eventContext);
        int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        int GetMasterVolumeLevel(out float level);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float level, ref Guid eventContext);
        int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        int GetChannelVolumeLevel(uint channel, out float level);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        int GetVolumeStepInfo(out uint step, out uint stepCount);
        int VolumeStepUp(ref Guid eventContext);
        int VolumeStepDown(ref Guid eventContext);
        int QueryHardwareSupport(out uint hardwareSupportMask);
        int GetVolumeRange(out float minimum, out float maximum, out float increment);
    }

    private static IAudioEndpointVolume GetEndpointVolume()
    {
        IMMDeviceEnumerator deviceEnumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice defaultDevice;
        int resultCode = deviceEnumerator.GetDefaultAudioEndpoint(RenderDataFlow, MultimediaRole, out defaultDevice);
        if (resultCode != 0)
        {
            throw new COMException("Windows would not hand over the default audio endpoint", resultCode);
        }

        Guid endpointVolumeInterfaceId = typeof(IAudioEndpointVolume).GUID;
        object endpointVolumeObject;
        resultCode = defaultDevice.Activate(ref endpointVolumeInterfaceId, AllClassContexts, IntPtr.Zero, out endpointVolumeObject);
        if (resultCode != 0)
        {
            throw new COMException("Windows would not activate the volume endpoint", resultCode);
        }

        return (IAudioEndpointVolume)endpointVolumeObject;
    }

    public static int SetVolumeScalar(double scalar)
    {
        IAudioEndpointVolume endpointVolume = GetEndpointVolume();
        Guid eventContext = Guid.Empty;
        int resultCode = endpointVolume.SetMasterVolumeLevelScalar((float)Math.Max(0.0, Math.Min(1.0, scalar)), ref eventContext);
        if (resultCode != 0)
        {
            throw new COMException("Windows refused the volume change", resultCode);
        }
        return (int)Math.Round(scalar * 100);
    }

    public static bool SetMute(bool shouldMute)
    {
        IAudioEndpointVolume endpointVolume = GetEndpointVolume();
        Guid eventContext = Guid.Empty;
        int resultCode = endpointVolume.SetMute(shouldMute, ref eventContext);
        if (resultCode != 0)
        {
            throw new COMException("Windows refused the mute change", resultCode);
        }
        return shouldMute;
    }

    public static bool IsMuted()
    {
        IAudioEndpointVolume endpointVolume = GetEndpointVolume();
        bool isMuted;
        endpointVolume.GetMute(out isMuted);
        return isMuted;
    }
}
'@

$script:winRtTaskFactoryMethod = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]

function Invoke-WinRtOperation($operation, $resultType) {
    $asTaskMethod = $script:winRtTaskFactoryMethod.MakeGenericMethod($resultType)
    $netTask = $asTaskMethod.Invoke($null, @($operation))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

function Get-MediaStatusResult {
    try {
        $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime]
        $propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media, ContentType = WindowsRuntime]

        $manager = Invoke-WinRtOperation ($managerType::RequestAsync()) $managerType
        $session = $manager.GetCurrentSession()
        if ($null -eq $session) {
            return @{ supported = $true; hasSession = $false; title = ''; artist = ''; album = ''; appName = ''; isPlaying = $false }
        }

        $properties = Invoke-WinRtOperation ($session.TryGetMediaPropertiesAsync()) $propertiesType
        $playbackStatus = $session.GetPlaybackInfo().PlaybackStatus.ToString()

        return @{
            supported = $true
            hasSession = $true
            title = [string]$properties.Title
            artist = [string]$properties.Artist
            album = [string]$properties.AlbumTitle
            appName = [string]$session.SourceAppUserModelId
            isPlaying = ($playbackStatus -eq 'Playing')
            playbackStatus = $playbackStatus
        }
    } catch {
        return @{ supported = $false; hasSession = $false; title = ''; artist = ''; album = ''; appName = ''; isPlaying = $false; error = $_.Exception.Message }
    }
}

function Set-SystemVolumeScalar([double]$level) {
    $scalar = [Math]::Max(0.0, [Math]::Min(1.0, $level))
    try {
        $appliedLevel = [ClickaaNative]::SetVolumeScalar($scalar)
        return @{ ok = $true; level = $appliedLevel }
    } catch {
        # Fallback: walk the volume keys. Pressing down 60 times saturates at 0,
        # so the upward presses land at roughly the requested level (2% steps).
        for ($pressIndex = 0; $pressIndex -lt 60; $pressIndex++) {
            [ClickaaNative]::TapVirtualKey(0xAE)
        }
        $upPressCount = [int]([Math]::Round($scalar * 50))
        for ($pressIndex = 0; $pressIndex -lt $upPressCount; $pressIndex++) {
            [ClickaaNative]::TapVirtualKey(0xAF)
        }
        return @{ ok = $true; level = [int]([Math]::Round($scalar * 100)); mode = 'volume-keys' }
    }
}

function Set-SystemMute([bool]$shouldMute) {
    try {
        $isMutedNow = [ClickaaNative]::SetMute($shouldMute)
        return @{ ok = $true; muted = $isMutedNow }
    } catch {
        [ClickaaNative]::TapVirtualKey(0xAD)
        return @{ ok = $true; muted = 'toggled'; mode = 'volume-keys' }
    }
}

$virtualKeyByName = @{
    'backspace' = 0x08; 'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D; 'esc' = 0x1B; 'escape' = 0x1B
    'space' = 0x20; 'pageup' = 0x21; 'pagedown' = 0x22; 'end' = 0x23; 'home' = 0x24
    'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
    'printscreen' = 0x2C; 'insert' = 0x2D; 'delete' = 0x2E; 'del' = 0x2E
    'win' = 0x5B; 'windows' = 0x5B; 'meta' = 0x5B; 'shift' = 0x10; 'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12
    'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91
    ';' = 0xBA; '=' = 0xBB; ',' = 0xBC; '-' = 0xBD; '.' = 0xBE; '/' = 0xBF
    '[' = 0xDB; ']' = 0xDD; 'quote' = 0xDE; 'backtick' = 0xC0
    'multiply' = 0x6A; 'add' = 0x6B; 'subtract' = 0x6D; 'decimal' = 0x6E; 'divide' = 0x6F
}
for ($functionKeyIndex = 1; $functionKeyIndex -le 24; $functionKeyIndex++) {
    $virtualKeyByName['f' + $functionKeyIndex] = 0x6F + $functionKeyIndex
}

function ConvertTo-VirtualKey([string]$keyName) {
    $normalizedKeyName = $keyName.Trim().ToLowerInvariant()
    if ([string]::IsNullOrEmpty($normalizedKeyName)) {
        throw 'empty key name'
    }
    if ($normalizedKeyName.Length -eq 1) {
        $character = $normalizedKeyName[0]
        if ($character -ge 'a' -and $character -le 'z') {
            return [int]([char]::ToUpperInvariant($character))
        }
        if ($character -ge '0' -and $character -le '9') {
            return [int]$character
        }
    }
    if ($virtualKeyByName.ContainsKey($normalizedKeyName)) {
        return $virtualKeyByName[$normalizedKeyName]
    }
    throw ('unknown key: ' + $keyName)
}

function Send-KeyCombination([string]$combination) {
    $keyNames = $combination -split '\+' | Where-Object { $_.Trim() -ne '' }
    if ($keyNames.Count -eq 0) {
        throw 'no keys were given'
    }
    $virtualKeys = New-Object 'System.Collections.Generic.List[UInt16]'
    foreach ($keyName in $keyNames) {
        $virtualKeys.Add([UInt16](ConvertTo-VirtualKey $keyName))
    }
    [ClickaaNative]::PressVirtualKeys($virtualKeys.ToArray())
    return @{ pressed = $combination }
}

function Get-ForegroundWindowResult {
    $windowHandle = [ClickaaNative]::GetForegroundWindow()
    return @{
        title = [ClickaaNative]::DescribeWindowTitle($windowHandle)
        processName = [ClickaaNative]::DescribeProcessName($windowHandle)
    }
}

function Invoke-WindowControl([string]$operation, [string]$appName) {
    $windowHandle = [IntPtr]::Zero
    if ([string]::IsNullOrEmpty($appName) -or $appName -eq 'active' -or $appName -eq 'current') {
        $windowHandle = [ClickaaNative]::GetForegroundWindow()
    } else {
        $windowHandle = [ClickaaNative]::FindWindow($appName, $true)
        if ($windowHandle -eq [IntPtr]::Zero) {
            $windowHandle = [ClickaaNative]::FindWindow($appName, $false)
        }
    }

    if ($windowHandle -eq [IntPtr]::Zero) {
        throw ('no open window matched ' + $appName)
    }

    $matchedTitle = [ClickaaNative]::DescribeWindowTitle($windowHandle)
    switch ($operation) {
        'minimize' { [ClickaaNative]::ShowWindow($windowHandle, $SwMinimize) | Out-Null }
        'maximize' {
            [ClickaaNative]::ShowWindow($windowHandle, $SwRestore) | Out-Null
            [ClickaaNative]::ShowWindow($windowHandle, $SwMaximize) | Out-Null
        }
        'restore' { [ClickaaNative]::ShowWindow($windowHandle, $SwRestore) | Out-Null }
        'close' { [ClickaaNative]::PostMessage($windowHandle, $WmClose, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
        'focus' {
            if ([ClickaaNative]::IsIconic($windowHandle)) {
                [ClickaaNative]::ShowWindow($windowHandle, $SwRestore) | Out-Null
            }
            [ClickaaNative]::SetForegroundWindow($windowHandle) | Out-Null
        }
        default { throw ('unsupported window operation: ' + $operation) }
    }

    return @{ window = $matchedTitle; operation = $operation }
}

function Invoke-WallpaperCommand([string]$imagePath, [int]$style) {
    if (-not (Test-Path -LiteralPath $imagePath)) {
        throw ('wallpaper file not found: ' + $imagePath)
    }
    Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name WallpaperStyle -Value ([string]$style)
    Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name TileWallpaper -Value '0'
    $updateFlags = $spifUpdateIniFile -bor $spifSendChange
    $didApply = [ClickaaNative]::ApplyWallpaper($imagePath, [uint32]$updateFlags)
    if (-not $didApply) {
        throw 'Windows refused the wallpaper change'
    }
    return @{ path = $imagePath; style = $style }
}

function Invoke-SolidWallpaperCommand([string]$colorHex) {
    $trimmedColor = $colorHex.TrimStart('#')
    if ($trimmedColor.Length -ne 6) {
        throw 'a solid wallpaper colour must look like #101820'
    }
    $redChannel = [Convert]::ToInt32($trimmedColor.Substring(0, 2), 16)
    $greenChannel = [Convert]::ToInt32($trimmedColor.Substring(2, 2), 16)
    $blueChannel = [Convert]::ToInt32($trimmedColor.Substring(4, 2), 16)

    $bitmap = New-Object System.Drawing.Bitmap 2, 2
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $colour = [System.Drawing.Color]::FromArgb($redChannel, $greenChannel, $blueChannel)
    $graphics.Clear($colour)
    $graphics.Dispose()

    $solidWallpaperPath = Join-Path $env:TEMP ('clickaa-wallpaper-' + $trimmedColor + '.bmp')
    $bitmap.Save($solidWallpaperPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bitmap.Dispose()

    return (Invoke-WallpaperCommand $solidWallpaperPath 10)
}

function Get-InstalledStartApps {
    $startApps = @()
    try {
        $startApps = Get-StartApps | ForEach-Object {
            @{ name = [string]$_.Name; appId = [string]$_.AppID }
        }
    } catch {
        $startApps = @()
    }
    return @{ apps = @($startApps) }
}

function Invoke-BridgeCommand($request) {
    $commandName = [string]$request.command
    switch ($commandName) {
        'ping' { return @{ version = 1; platform = [System.Environment]::OSVersion.VersionString } }
        'send_keys' { return (Send-KeyCombination ([string]$request.keys)) }
        'type_unicode' {
            [ClickaaNative]::SendUnicodeText([string]$request.text)
            return @{ characters = ([string]$request.text).Length }
        }
        'scroll' {
            $scrollAmount = 3
            if ($null -ne $request.amount) { $scrollAmount = [int]$request.amount }
            $directionMultiplier = 1
            if ([string]$request.direction -eq 'up') { $directionMultiplier = -1 }
            [ClickaaNative]::ScrollWheel(($scrollAmount * $directionMultiplier) * 1)
            return @{ direction = [string]$request.direction; amount = $scrollAmount }
        }
        'move_mouse' {
            $pointX = [int]$request.x
            $pointY = [int]$request.y
            [ClickaaNative]::MoveTo($pointX, $pointY) | Out-Null
            return @{ x = $pointX; y = $pointY }
        }
        'click' {
            $clickX = [int]$request.x
            $clickY = [int]$request.y
            $clickButton = 'left'
            if ($null -ne $request.button) { $clickButton = [string]$request.button }
            $isDoubleClick = $false
            if ($null -ne $request.double) { $isDoubleClick = [bool]$request.double }
            [ClickaaNative]::ClickAt($clickX, $clickY, $clickButton, $isDoubleClick)
            return @{ x = $clickX; y = $clickY; button = $clickButton; double = $isDoubleClick }
        }
        'cursor_position' {
            $cursorPosition = [ClickaaNative]::ReadCursorPosition()
            return @{ x = $cursorPosition[0]; y = $cursorPosition[1] }
        }
        'volume' {
            $volumeOperation = [string]$request.operation
            switch ($volumeOperation) {
                'up' { [ClickaaNative]::TapVirtualKey(0xAF); return @{ operation = 'up' } }
                'down' { [ClickaaNative]::TapVirtualKey(0xAE); return @{ operation = 'down' } }
                'mute' { return (Set-SystemMute $true) }
                'unmute' { return (Set-SystemMute $false) }
                'set' {
                    $requestedLevel = 50
                    if ($null -ne $request.level) { $requestedLevel = [int]$request.level }
                    return (Set-SystemVolumeScalar ($requestedLevel / 100.0))
                }
                default { throw ('unsupported volume operation: ' + $volumeOperation) }
            }
        }
        'media' {
            $mediaOperation = [string]$request.operation
            switch ($mediaOperation) {
                'play_pause' { [ClickaaNative]::TapVirtualKey(0xB3); return @{ operation = 'play_pause' } }
                'next' { [ClickaaNative]::TapVirtualKey(0xB0); return @{ operation = 'next' } }
                'previous' { [ClickaaNative]::TapVirtualKey(0xB1); return @{ operation = 'previous' } }
                'stop' { [ClickaaNative]::TapVirtualKey(0xB2); return @{ operation = 'stop' } }
                default { throw ('unsupported media operation: ' + $mediaOperation) }
            }
        }
        'media_status' { return (Get-MediaStatusResult) }
        'foreground_window' { return (Get-ForegroundWindowResult) }
        'window_control' {
            return (Invoke-WindowControl ([string]$request.operation) ([string]$request.app))
        }
        'wallpaper' { return (Invoke-WallpaperCommand ([string]$request.path) ([int]$request.style)) }
        'wallpaper_solid' { return (Invoke-SolidWallpaperCommand ([string]$request.color)) }
        'list_start_apps' { return (Get-InstalledStartApps) }
        'open_path' {
            Start-Process -FilePath ([string]$request.path) | Out-Null
            return @{ path = [string]$request.path }
        }
        default { throw ('unknown command: ' + $commandName) }
    }
}

while ($true) {
    $requestLine = [Console]::In.ReadLine()
    if ($null -eq $requestLine) {
        break
    }
    if ($requestLine.Trim() -eq '') {
        continue
    }

    $requestId = 0
    try {
        $request = $requestLine | ConvertFrom-Json
        if ($null -ne $request.id) { $requestId = [int]$request.id }
        $result = Invoke-BridgeCommand $request
        $response = @{ id = $requestId; ok = $true; result = $result }
    } catch {
        $response = @{ id = $requestId; ok = $false; error = $_.Exception.Message }
    }

    $responseJson = $response | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($responseJson)
    [Console]::Out.Flush()
}
`.trim();
