import {createUnprotectedReadStream,assertMemoryFilesystemAccess} from '../memory/encryption/protected-filesystem.js';
/**
 * Storage Manager — unified Cache + CDN system
 *
 * Two zones:
 *   cache/ — temporary, TTL-based (audio, screenshots, web)
 *   cdn/   — persistent, agent-managed (avatars, images, files, data)
 *
 * Storage backend is selected via STORAGE_PROVIDER env var:
 *   local (default) → .data/storage/  on disk
 *   s3              → AWS S3 + optional CloudFront
 *   r2              → Cloudflare R2
 *
 * All files are indexed in the `storage_files` table regardless of provider,
 * on the process database driver (SQLite or PostgreSQL, B2.2d-1).
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { insertOrIgnore } from '../db/pg/dialect.js';
import { num, q } from '../repositories/sql-steps.js';
import { getStorageProvider, LocalStorageProvider } from './storage-providers/index.js';

export type StorageZone = 'cache' | 'cdn';
export type StorageTTL = 'session' | '24h' | '7d' | 'persistent';

export interface StorageFile {
  id: string;
  zone: StorageZone;
  category: string;
  filename: string;
  filepath: string;    // storage key: "{zone}/{category}/{filename}"
  originalName?: string;
  mimeType?: string;
  sizeBytes: number;
  description?: string;
  tags: string[];
  ttl: StorageTTL;
  expiresAt?: string;
  sourceUrl?: string;
  createdBy: string;
  createdAt: string;
  lastAccessed?: string;
  accessCount: number;
}

export interface StorageSaveOptions {
  zone: StorageZone;
  category: string;
  data: Buffer | string;
  filename?: string;
  mimeType?: string;
  description?: string;
  tags?: string[];
  ttl?: StorageTTL;
  sourceUrl?: string;
  createdBy?: string;
}

export interface StorageQuery {
  zone?: StorageZone;
  category?: string;
  /** FIX-STO-01: also match sub-categories (`<category>/…`), e.g. an extension's folders. */
  categoryTree?: boolean;
  q?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

const TTL_MS: Record<StorageTTL, number | null> = {
  session: 0,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  persistent: null,
};

function calcExpiresAt(ttl: StorageTTL): string | null {
  const ms = TTL_MS[ttl];
  if (ms === null) return null;
  if (ms === 0) return new Date(Date.now() + 60 * 1000).toISOString();
  return new Date(Date.now() + ms).toISOString();
}

/**
 * FIX-STO-01: SQL for "this category or any `<category>/…` below it", with
 * LIKE wildcards in the name escaped (an extension id may contain `_`), so
 * `extensions/ab` never matches `extensions/abc` or `extensions/a_`.
 * The same text works on SQLite and PostgreSQL.
 */
export function categorySubtreeSql(column = 'category'): string {
  return `(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`;
}
export function categorySubtreeParams(category: string): [string, string] {
  return [category, `${category.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`];
}
/** True when `category` is `base` or below it (`base/…`). */
export function inCategoryTree(category: string, base: string): boolean {
  return category === base || category.startsWith(`${base}/`);
}

function rowToFile(row: Record<string, unknown>): StorageFile {
  return {
    id: row.id as string,
    zone: row.zone as StorageZone,
    category: row.category as string,
    filename: row.filename as string,
    filepath: row.filepath as string,
    originalName: (row.original_name as string) ?? undefined,
    mimeType: (row.mime_type as string) ?? undefined,
    sizeBytes: (row.size_bytes as number) ?? 0,
    description: (row.description as string) ?? undefined,
    tags: row.tags ? JSON.parse(row.tags as string) : [],
    ttl: row.ttl as StorageTTL,
    expiresAt: (row.expires_at as string) ?? undefined,
    sourceUrl: (row.source_url as string) ?? undefined,
    createdBy: (row.created_by as string) ?? 'system',
    createdAt: row.created_at as string,
    lastAccessed: (row.last_accessed as string) ?? undefined,
    accessCount: (row.access_count as number) ?? 0,
  };
}

export class StorageManager {
  async initialize(): Promise<void> {
    const provider = getStorageProvider();

    // For local provider: ensure all directories exist
    if (provider instanceof LocalStorageProvider) {
      const dirs = [
        'cache/audio', 'cache/screenshots', 'cache/web',
        'cdn/avatars', 'cdn/images', 'cdn/files', 'cdn/data', 'cdn/worlds',
        'extensions', // Extension-specific folders created on-demand
      ];
      for (const dir of dirs) {
        const absPath = provider.absolutePath(dir);
        if (!fs.existsSync(absPath)) fs.mkdirSync(absPath, { recursive: true, mode: 0o700 });
      }
    }

    // Sync on-disk files that aren't yet indexed
    await this.syncDiskFiles();

    console.log(`[StorageManager] ✅ Ready (provider: ${provider.name})`);
  }

  /**
   * Scan the local storage root (.data/uploads, CL-05) and index any files missing from storage_files table.
   * Covers cache/, cdn/, avatars/, and backgrounds/ directories.
   */
  private async syncDiskFiles(): Promise<void> {
    const provider = getStorageProvider();
    if (!(provider instanceof LocalStorageProvider)) return;
    const storageRoot = provider.absolutePath('');
    if (!fs.existsSync(storageRoot)) return;

    const existing = new Set(
      (await q.all<{ filepath: string }>('SELECT filepath FROM storage_files'))
        .map(r => r.filepath)
    );

    const extToMime: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.fbx': 'application/octet-stream',
      '.json': 'application/json', '.txt': 'text/plain', '.pdf': 'application/pdf',
    };

    // Zones to scan: standard cache/cdn + extra top-level dirs
    const scanDirs: { dir: string; zone: StorageZone; defaultCategory?: string }[] = [
      { dir: 'cache', zone: 'cache' },
      { dir: 'cdn', zone: 'cdn' },
      { dir: 'avatars', zone: 'cdn', defaultCategory: 'avatars' },
      { dir: 'backgrounds', zone: 'cdn', defaultCategory: 'images' },
    ];

    const found: Array<{ id: string; zone: StorageZone; category: string; filename: string; key: string; mime: string | null; size: number; mtime: string }> = [];

    for (const { dir, zone, defaultCategory } of scanDirs) {
      const dirPath = path.join(storageRoot, dir);
      if (!fs.existsSync(dirPath)) continue;

      const walkDir = (currentPath: string, relBase: string) => {
        for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
          const fullPath = path.join(currentPath, entry.name);
          const relPath = path.join(relBase, entry.name).replace(/\\/g, '/');
          if (entry.isDirectory()) {
            walkDir(fullPath, relPath);
          } else if (entry.isFile()) {
            // Key format: "zone/category/filename" or full relative path
            const storageKey = `${dir}/${relPath}`;
            const absPath = fullPath.replace(/\\/g, '/');

            // Skip if already indexed (by relative key or absolute path)
            if (existing.has(storageKey) || existing.has(absPath)) continue;

            const ext = path.extname(entry.name).toLowerCase();
            const mime = extToMime[ext] ?? null;
            const stat = fs.statSync(fullPath);

            // Determine category from directory structure
            // For cache/cdn: first subfolder is the category (e.g. cache/audio/file.mp3 → audio)
            // For avatars/backgrounds: use defaultCategory
            const parts = relPath.split('/');
            const category = defaultCategory ?? (parts.length > 1 ? parts[0] : 'files');

            found.push({
              id: randomUUID(), zone, category, filename: entry.name, key: storageKey,
              mime, size: stat.size, mtime: stat.mtime.toISOString(),
            });
          }
        }
      };

      walkDir(dirPath, '');
    }

    const insert = insertOrIgnore(q.dialect, `
      INSERT INTO storage_files
        (id, zone, category, filename, filepath, mime_type, size_bytes, description,
         tags, ttl, expires_at, source_url, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let indexed = 0;
    for (const f of found) {
      const { changes } = await q.run(
        insert,
        f.id, f.zone, f.category, f.filename, f.key,
        f.mime, f.size,
        null, '[]', 'persistent', null, null, 'disk-sync',
        f.mtime,
      );
      indexed += changes;
    }

    if (indexed > 0) {
      console.log(`[StorageManager] 📂 Indexed ${indexed} existing file(s) from disk`);
    }
  }

  async save(options: StorageSaveOptions): Promise<StorageFile> {
    const {
      zone, category,
      data, filename: givenFilename,
      mimeType, description,
      tags = [], ttl = 'persistent',
      sourceUrl, createdBy = 'system',
    } = options;

    const ext = mimeType ? mimeToExt(mimeType) : '';
    const filename = givenFilename ?? `${randomUUID()}${ext}`;
    const key = `${zone}/${category}/${filename}`;

    // Resolve data to Buffer
    let buffer: Buffer;
    if (typeof data === 'string') {
      if (data.startsWith('data:') || data.startsWith('base64:')) {
        const b64 = data.includes(',') ? data.split(',')[1] : data.replace('base64:', '');
        buffer = Buffer.from(b64, 'base64');
      } else if (data.startsWith('http://') || data.startsWith('https://')) {
        buffer = await downloadUrl(data);
      } else {
        buffer = Buffer.from(data, 'utf-8');
      }
    } else {
      buffer = data;
    }

    const provider = getStorageProvider();
    await provider.put(key, buffer, mimeType);

    const id = randomUUID();
    const expiresAt = calcExpiresAt(ttl);

    await q.run(`
      INSERT INTO storage_files
        (id, zone, category, filename, filepath, mime_type, size_bytes, description,
         tags, ttl, expires_at, source_url, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, zone, category, filename, key,
      mimeType ?? null, buffer.length,
      description ?? null,
      JSON.stringify(tags), ttl, expiresAt ?? null,
      sourceUrl ?? null, createdBy
    );

    return (await this.getById(id)) as StorageFile;
  }

  /**
   * Index an existing file that lives outside the storage directory
   * (e.g. TTS audio in .data/audio/, browser screenshots).
   * Adds a manifest entry but does NOT move the file.
   */
  async indexExistingFile(options: {
    zone: StorageZone;
    category: string;
    filepath: string;      // absolute path on disk (local only)
    filename?: string;
    mimeType?: string;
    description?: string;
    tags?: string[];
    ttl?: StorageTTL;
    sourceUrl?: string;
    createdBy?: string;
  }): Promise<StorageFile> {
    const {
      zone, category, filepath,
      filename: givenFilename,
      mimeType, description,
      tags = [], ttl = 'persistent',
      sourceUrl, createdBy = 'system',
    } = options;

    const filename = givenFilename ?? path.basename(filepath);
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(filepath).size; } catch { /* file may not exist yet */ }

    const id = randomUUID();
    const expiresAt = calcExpiresAt(ttl);

    await q.run(insertOrIgnore(q.dialect, `
      INSERT INTO storage_files
        (id, zone, category, filename, filepath, mime_type, size_bytes, description,
         tags, ttl, expires_at, source_url, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      id, zone, category, filename,
      filepath,   // store absolute path for externally-managed files
      mimeType ?? null, sizeBytes,
      description ?? null,
      JSON.stringify(tags), ttl, expiresAt ?? null,
      sourceUrl ?? null, createdBy
    );

    return (await this.getById(id)) as StorageFile;
  }

  async getById(id: string): Promise<StorageFile | null> {
    const row = await q.one<Record<string, unknown>>('SELECT * FROM storage_files WHERE id = ?', id);
    if (!row) return null;
    await q.run('UPDATE storage_files SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?',
      new Date().toISOString(), id);
    return rowToFile(row);
  }

  /**
   * Get a readable stream for serving via backend.
   * Returns null if the provider serves the file directly (cloud).
   */
  async getStream(id: string): Promise<{ stream: NodeJS.ReadableStream; file: StorageFile } | null> {
    const file = await this.getById(id);
    if (!file) return null;

    const provider = getStorageProvider();
    const stream = provider.getReadStream(file.filepath);

    // If cloud provider returns null, check if it's an external file (absolute path)
    if (!stream) {
      if (path.isAbsolute(file.filepath) && fs.existsSync(file.filepath)) {
        assertMemoryFilesystemAccess(file.filepath);
        return { stream: createUnprotectedReadStream(file.filepath), file };
      }
      return null;
    }

    return { stream, file };
  }

  /**
   * Get the public URL for a file.
   * - Cloud providers return a direct URL (S3/R2/CloudFront)
   * - Local provider returns /api/storage/:id (served by backend)
   */
  async getPublicUrl(id: string): Promise<string> {
    const file = await this.getById(id);
    if (!file) return `/api/storage/${id}`;

    const provider = getStorageProvider();
    const direct = provider.getDirectUrl(file.filepath);
    return direct ?? `/api/storage/${id}`;
  }

  /** Shorthand — returns /api/storage/:id (used before file is saved) */
  getApiUrl(id: string): string {
    return `/api/storage/${id}`;
  }

  async search(query: StorageQuery): Promise<StorageFile[]> {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    // SQLite LIKE ignores ASCII case; ILIKE gives the same match on PostgreSQL.
    const like = q.dialect === 'postgres' ? 'ILIKE' : 'LIKE';

    if (query.zone) { conditions.push('zone = ?'); params.push(query.zone); }
    if (query.category) {
      if (query.categoryTree) { conditions.push(categorySubtreeSql()); params.push(...categorySubtreeParams(query.category)); }
      else { conditions.push('category = ?'); params.push(query.category); }
    }
    if (query.q) {
      conditions.push(`(description ${like} ? OR filename ${like} ?)`);
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    if (query.tags?.length) {
      conditions.push(`(${query.tags.map(() => `tags ${like} ?`).join(' OR ')})`);
      for (const t of query.tags) params.push(`%"${t}"%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const rows = await q.all<Record<string, unknown>>(`
      SELECT * FROM storage_files ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset);

    return rows.map(rowToFile);
  }

  async delete(id: string): Promise<boolean> {
    const file = await this.getById(id);
    if (!file) return false;

    const provider = getStorageProvider();
    void provider.remove(file.filepath).catch(() => {});

    // Also try absolute path (for externally indexed files)
    if (path.isAbsolute(file.filepath)) {
      try { if (fs.existsSync(file.filepath)) fs.unlinkSync(file.filepath); } catch { /* ignore */ }
    }

    await q.run('DELETE FROM storage_files WHERE id = ?', id);
    return true;
  }

  async cleanup(): Promise<{ deleted: number; freedBytes: number }> {
    const now = new Date().toISOString();
    // SQLite keeps expires_at as the ISO text written by calcExpiresAt, so the
    // ISO bound compares as text; PostgreSQL compares timestamptz values.
    const bound = q.dialect === 'postgres' ? '(?)::timestamptz' : '?';
    const expired = await q.all<Record<string, unknown>>(
      `SELECT * FROM storage_files WHERE expires_at IS NOT NULL AND expires_at < ${bound}`, now);

    let deleted = 0, freedBytes = 0;
    const provider = getStorageProvider();

    for (const row of expired) {
      const file = rowToFile(row);
      void provider.remove(file.filepath).catch(() => {});
      if (path.isAbsolute(file.filepath)) {
        try { if (fs.existsSync(file.filepath)) fs.unlinkSync(file.filepath); } catch { /* ignore */ }
      }
      await q.run('DELETE FROM storage_files WHERE id = ?', file.id);
      deleted++;
      freedBytes += file.sizeBytes;
    }

    if (deleted > 0) {
      console.log(`[StorageManager] 🧹 Cleaned ${deleted} expired files (${(freedBytes / 1024 / 1024).toFixed(1)} MB freed)`);
    }
    return { deleted, freedBytes };
  }

  async stats(): Promise<{ totalFiles: number; totalBytes: number; byZone: Record<string, number>; byCategory: Record<string, number> }> {
    const total = await q.one<{ count: number; bytes: unknown }>('SELECT COUNT(*) as count, SUM(size_bytes) as bytes FROM storage_files');
    const byZone = await q.all<{ zone: string; count: number }>('SELECT zone, COUNT(*) as count FROM storage_files GROUP BY zone');
    const byCat = await q.all<{ category: string; count: number }>('SELECT category, COUNT(*) as count FROM storage_files GROUP BY category ORDER BY count DESC');

    return {
      totalFiles: total?.count ?? 0,
      // SUM is numeric (text) on PostgreSQL, null on an empty table.
      totalBytes: num<number | null>(total?.bytes) ?? 0,
      byZone: Object.fromEntries(byZone.map(r => [r.zone, r.count])),
      byCategory: Object.fromEntries(byCat.map(r => [r.category, r.count])),
    };
  }
}

let instance: StorageManager | null = null;
export function getStorageManager(): StorageManager {
  if (!instance) instance = new StorageManager();
  return instance;
}

// --- Helpers ---

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'video/mp4': '.mp4', 'video/webm': '.webm',
    'application/pdf': '.pdf', 'application/json': '.json',
    'text/plain': '.txt', 'text/html': '.html', 'text/csv': '.csv',
    'model/gltf-binary': '.glb', 'model/gltf+json': '.gltf',
  };
  return map[mime] ?? '';
}

async function downloadUrl(url: string): Promise<Buffer> {
  const { default: https } = await import('https');
  const { default: http } = await import('http');
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}
