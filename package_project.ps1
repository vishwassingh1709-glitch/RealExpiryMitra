$sourceDir = "c:\Users\ADMIN\OneDrive\Desktop\mainprojectfile\DemoOfExpiryMitra"
$staging = "c:\Users\ADMIN\OneDrive\Desktop\mainprojectfile\staging_clean\DemoOfExpiryMitra"
$zipOutput = "c:\Users\ADMIN\OneDrive\Desktop\mainprojectfile\ExpiryMitra-Completed.zip"

if (Test-Path "c:\Users\ADMIN\OneDrive\Desktop\mainprojectfile\staging_clean") {
    Remove-Item -Recurse -Force "c:\Users\ADMIN\OneDrive\Desktop\mainprojectfile\staging_clean"
}
if (Test-Path $zipOutput) {
    Remove-Item -Force $zipOutput
}

New-Item -ItemType Directory -Path $staging -Force | Out-Null

$items = Get-ChildItem -Path $sourceDir -Force | Where-Object { $_.Name -notmatch '^(node_modules|\.git|\.env)$' }

foreach ($item in $items) {
    Copy-Item -Path $item.FullName -Destination $staging -Recurse -Force
}

Compress-Archive -Path "c:\Users\ADMIN\OneDrive\Desktop\mainprojectfile\staging_clean\*" -DestinationPath $zipOutput -CompressionLevel Optimal

Remove-Item -Recurse -Force "c:\Users\ADMIN\OneDrive\Desktop\mainprojectfile\staging_clean"

Write-Host "Created ZIP successfully: $zipOutput"
Get-Item $zipOutput | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
