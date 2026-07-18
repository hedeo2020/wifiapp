$ErrorActionPreference = "Stop"

$LogPath = "C:\Users\PC\Documents\pisowifi\enable_wifi_to_ethernet_ics.log"
Set-Content -LiteralPath $LogPath -Value "Starting Wi-Fi to Ethernet ICS setup"

function Log {
    param([string]$Message)
    Add-Content -LiteralPath $LogPath -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
}

try {
    $share = New-Object -ComObject HNetCfg.HNetShare
    $connections = @{}

    $share.EnumEveryConnection() | ForEach-Object {
        $props = $share.NetConnectionProps($_)
        $connections[$props.Name] = $_
        Log ("Found connection: {0} / {1}" -f $props.Name, $props.DeviceName)
    }

    if (-not $connections.ContainsKey("Wi-Fi")) {
        throw "Wi-Fi connection was not found"
    }
    if (-not $connections.ContainsKey("Ethernet")) {
        throw "Ethernet connection was not found"
    }

    foreach ($conn in $connections.Values) {
        $cfg = $share.INetSharingConfigurationForINetConnection($conn)
        if ($cfg.SharingEnabled) {
            $props = $share.NetConnectionProps($conn)
            Log ("Disabling existing sharing on {0}" -f $props.Name)
            $cfg.DisableSharing()
        }
    }

    Log "Enabling sharing: Wi-Fi as public internet"
    $share.INetSharingConfigurationForINetConnection($connections["Wi-Fi"]).EnableSharing(0)

    Log "Enabling sharing: Ethernet as private network"
    $share.INetSharingConfigurationForINetConnection($connections["Ethernet"]).EnableSharing(1)

    Log "ICS setup complete"
}
catch {
    Log ("ERROR: {0}" -f $_.Exception.Message)
    throw
}
