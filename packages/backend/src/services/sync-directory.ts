import fs from 'node:fs/promises';

/** Windows cannot flush directory handles; callers must still sync each written file. */
export async function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform, open: typeof fs.open = fs.open): Promise<void> {
  if (platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
