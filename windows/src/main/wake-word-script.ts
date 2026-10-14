/**
 * The wake word listener Clickaa keeps running when the wake word is switched on.
 *
 * It listens on the default microphone for one word ("clickaa") using the speech
 * recognizer that Windows already ships, so there is no model to download and no
 * audio ever leaves the machine. The script prints one line per event:
 *
 *   READY
 *   WAKE 87 clickaa
 *   UNAVAILABLE no offline speech recognizer is installed for this windows language
 *   ERROR <message>
 *
 * Windows PowerShell 5.1 reads un-BOM'd files as ANSI and the file is written
 * with a UTF-8 BOM anyway, so the script stays ASCII-only on purpose.
 */
export const clickaaWakeWordScript = String.raw`
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.ASCIIEncoding

function Emit([string] $line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

# The recognizer only ever hears these phrases; anything else is discarded by
# the grammar, which is what keeps an always-on microphone cheap and private.
$wakePhrases = @(
  'clickaa',
  'click a',
  'click ah',
  'hey clickaa',
  'ok clickaa',
  'hi clickaa'
)

# Easily confused with ordinary speech ("click a button"), so they have to be
# said more clearly before Clickaa responds.
$strictPhrases = @('click a', 'click ah')
$defaultThreshold = 0.62
$strictThreshold = 0.78

try {
  Add-Type -AssemblyName System.Speech | Out-Null
} catch {
  Emit 'UNAVAILABLE the windows speech assembly is missing'
  exit 1
}

$recognizer = $null
$cultureNames = @(
  [System.Globalization.CultureInfo]::CurrentUICulture.Name,
  'en-US',
  'en-GB'
)

foreach ($cultureName in $cultureNames) {
  try {
    $culture = New-Object System.Globalization.CultureInfo($cultureName)
    $candidate = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
    $recognizer = $candidate
    break
  } catch {
    $recognizer = $null
  }
}

if ($null -eq $recognizer) {
  Emit 'UNAVAILABLE no offline speech recognizer is installed for this windows language'
  exit 2
}

try {
  $recognizer.SetInputToDefaultAudioDevice()
  $choices = New-Object System.Speech.Recognition.Choices
  $choices.Add($wakePhrases)
  $grammarBuilder = New-Object System.Speech.Recognition.GrammarBuilder
  $grammarBuilder.Append($choices)
  $wakeGrammar = New-Object System.Speech.Recognition.Grammar($grammarBuilder)
  $wakeGrammar.Name = 'clickaa wake word'
  $recognizer.LoadGrammar($wakeGrammar)
} catch {
  Emit ('UNAVAILABLE ' + $_.Exception.Message)
  exit 3
}

Emit 'READY'

# Recognize() blocks until it hears one of the phrases or the timeout expires,
# so the loop costs nothing between words.
while ($true) {
  try {
    $result = $recognizer.Recognize([TimeSpan]::FromSeconds(20))
  } catch {
    Emit ('ERROR ' + $_.Exception.Message)
    Start-Sleep -Milliseconds 400
    continue
  }

  if ($null -eq $result) {
    continue
  }

  $heard = $result.Text.ToLowerInvariant()
  $confidence = [double] $result.Confidence
  $threshold = $defaultThreshold
  if ($strictPhrases -contains $heard) {
    $threshold = $strictThreshold
  }
  if ($confidence -lt $threshold) {
    continue
  }

  Emit ('WAKE ' + [int] [Math]::Round($confidence * 100) + ' ' + $heard)
}
`;
