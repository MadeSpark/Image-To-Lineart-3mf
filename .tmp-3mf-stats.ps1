Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-EntryText($zipPath,$entryName){
  $zip=[System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entry=$zip.GetEntry($entryName)
    if(-not $entry){ return $null }
    $reader=New-Object System.IO.StreamReader($entry.Open())
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $zip.Dispose() }
}
$afterObj=Get-EntryText 'c:\Users\MadeSpark\Desktop\转向量\拓竹切片后.3mf' '3D/Objects/object_1.model'
([regex]::Matches($afterObj,'<triangle\b')).Count
