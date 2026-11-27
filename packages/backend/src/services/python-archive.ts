import {assertMemoryFilesystemAccess} from '../memory/encryption/protected-filesystem.js';
import { execFileSync } from 'node:child_process';

/** Use matching system modules; keep archive paths out of PowerShell source. */
export function extractPythonArchive(archive: string, destination: string): void {
  assertMemoryFilesystemAccess(archive);assertMemoryFilesystemAccess(destination,true);
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; $env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules'); Import-Module Microsoft.PowerShell.Archive -Force; Expand-Archive -LiteralPath $env:DPRO_PYTHON_ARCHIVE -DestinationPath $env:DPRO_PYTHON_DESTINATION -Force",
  ], {
    env: { ...process.env, DPRO_PYTHON_ARCHIVE: archive, DPRO_PYTHON_DESTINATION: destination },
    stdio: 'inherit', timeout: 120000,
  });
}
