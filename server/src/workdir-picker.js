import { spawn } from "node:child_process";
import path from "node:path";

function quotePowerShellString(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

export async function browseForDirectory({
  initialDirectory,
  title = "Select working directory",
} = {}) {
  if (process.platform !== "win32") {
    throw new Error("Browsing for working directories is currently supported on Windows only.");
  }

  const normalizedInitialDirectory = initialDirectory
    ? path.resolve(String(initialDirectory))
    : null;
  const scriptLines = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.ShowNewFolderButton = $false",
    `$dialog.Description = ${quotePowerShellString(title)}`,
  ];

  if (normalizedInitialDirectory) {
    scriptLines.push(
      `$dialog.SelectedPath = ${quotePowerShellString(normalizedInitialDirectory)}`,
    );
  }

  scriptLines.push(
    "$result = $dialog.ShowDialog()",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK -and -not [string]::IsNullOrWhiteSpace($dialog.SelectedPath)) {",
    "  @{ cancelled = $false; path = $dialog.SelectedPath } | ConvertTo-Json -Compress",
    "} else {",
    "  @{ cancelled = $true } | ConvertTo-Json -Compress",
    "}",
  );

  const script = scriptLines.join("; ");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `PowerShell exited with code ${code}`;
        reject(new Error(`Failed to open the folder picker. ${detail}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim() || '{"cancelled":true}');
        resolve(parsed);
      } catch (error) {
        reject(
          new Error(
            `Folder picker returned an unreadable response. ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}
