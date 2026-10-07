import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);
const MAX_CACHE_BYTES = 50 * 1024 * 1024;

export type RemoteMediaKind = 'image' | 'video' | 'remote';

export interface ResolvedRemoteMedia {
  source: string;
  kind: RemoteMediaKind;
  remoteUrl?: string;
  cacheKey: string;
  cachePath?: string;
  mimeType?: string;
}

function mediaCacheRoot(): string {
  return path.join(config.dataDir, 'cache', 'media');
}

export function mediaCacheFile(cacheKey: string): string {
  if (!/^[a-f0-9]{64}$/i.test(cacheKey)) throw new Error('Invalid media cache key');
  return path.join(mediaCacheRoot(), cacheKey + '.bin');
}

function mediaCacheMetaFile(cacheKey: string): string {
  return path.join(mediaCacheRoot(), cacheKey + '.json');
}

function cacheKeyFor(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

async function ensureCacheRoot(): Promise<void> {
  await fs.mkdir(mediaCacheRoot(), { recursive: true });
}

function isSupportedSocialMediaPage(source: string): boolean {
  try {
    const url = new URL(source);
    return /(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)mobile\.twitter\.com$/i.test(url.hostname)
      && /\/status\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function looksLikeDirectMedia(source: string, kind: RemoteMediaKind): boolean {
  try {
    const pathname = new URL(source).pathname.toLowerCase();
    if (kind === 'video') return /\.(mp4|webm|mov|m4v)$/.test(pathname);
    if (kind === 'image') return /\.(png|jpe?g|webp|gif|avif)$/.test(pathname);
    return /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v)$/.test(pathname);
  } catch {
    return false;
  }
}

function mimeFromMediaUrl(value: string): string | undefined {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    if (/\.(png|jpe?g|webp|gif|avif)$/.test(pathname)) {
      return pathname.endsWith('.png') ? 'image/png'
        : pathname.endsWith('.webp') ? 'image/webp'
          : pathname.endsWith('.gif') ? 'image/gif'
            : 'image/jpeg';
    }
    if (/\.(webm)$/.test(pathname)) return 'video/webm';
    if (/\.(mov|m4v)$/.test(pathname)) return 'video/quicktime';
    if (/\.(mp4)$/.test(pathname)) return 'video/mp4';
  } catch {}
  return undefined;
}

async function resolveWithYtDlp(source: string, kind: RemoteMediaKind): Promise<{ remoteUrl?: string; mimeType?: string }> {
  if (kind !== 'video' && !isSupportedSocialMediaPage(source)) return {};
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      [
        '--no-playlist',
        '--no-warnings',
        '--skip-download',
        '--get-url',
        '-f', 'best[ext=mp4]/best',
        source,
      ],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const remoteUrl = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return remoteUrl ? { remoteUrl, ...(mimeFromMediaUrl(remoteUrl) ? { mimeType: mimeFromMediaUrl(remoteUrl) } : {}) } : {};
  } catch {
    return {};
  }
}

async function cacheRemoteResource(cacheKey: string, remoteUrl: string, kind: RemoteMediaKind, mimeHint?: string): Promise<{ cachePath: string; mimeType?: string } | undefined> {
  await ensureCacheRoot();
  const target = mediaCacheFile(cacheKey);
  const metadata = mediaCacheMetaFile(cacheKey);
  try {
    const stat = await fs.stat(target);
    if (stat.isFile() && stat.size > 0) {
      let mimeType = mimeHint;
      try {
        const raw = JSON.parse(await fs.readFile(metadata, 'utf8')) as { mimeType?: unknown };
        if (!mimeType && typeof raw.mimeType === 'string') mimeType = raw.mimeType;
      } catch {}
      return { cachePath: target, ...(mimeType ? { mimeType } : {}) };
    }
  } catch {}

  const response = await fetch(remoteUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 agentic-data-architect remote-media-cache',
    },
  });
  if (!response.ok || !response.body) return undefined;

  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim() || mimeHint;
  if (!mimeType || (kind === 'video' && !mimeType.startsWith('video/')) || (kind === 'image' && !mimeType.startsWith('image/')) || (kind === 'remote' && !mimeType.startsWith('image/') && !mimeType.startsWith('video/'))) {
    return undefined;
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_CACHE_BYTES) return undefined;

  const temporary = target + '.tmp-' + process.pid + '-' + Date.now();
  let bytes = 0;
  const limited = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);

  const limiter = async function* () {
    for await (const chunk of limited) {
      bytes += Buffer.byteLength(chunk as Uint8Array);
      if (bytes > MAX_CACHE_BYTES) throw new Error('Remote media exceeds cache size limit');
      yield chunk;
    }
  };

  try {
    await pipeline(limiter(), fsSync.createWriteStream(temporary));
    await fs.rename(temporary, target);
    await fs.writeFile(
      metadata,
      JSON.stringify({ source: remoteUrl, mimeType, sizeBytes: bytes, cachedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
    return { cachePath: target, ...(mimeType ? { mimeType } : {}) };
  } catch {
    await fs.rm(temporary, { force: true });
    return undefined;
  }
}

export async function getCachedRemoteMedia(cacheKey: string): Promise<{ path: string; mimeType?: string; sizeBytes: number } | undefined> {
  const target = mediaCacheFile(cacheKey);
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size <= 0) return undefined;
    let mimeType: string | undefined;
    try {
      const metadata = JSON.parse(await fs.readFile(mediaCacheMetaFile(cacheKey), 'utf8')) as { mimeType?: unknown };
      if (typeof metadata.mimeType === 'string') mimeType = metadata.mimeType;
    } catch {}
    return { path: target, sizeBytes: stat.size, ...(mimeType ? { mimeType } : {}) };
  } catch {
    return undefined;
  }
}

export async function resolveAndCacheRemoteMedia(
  source: string,
  kind: RemoteMediaKind = 'remote',
): Promise<ResolvedRemoteMedia> {
  const normalizedSource = source.trim();
  let url: URL;
  try {
    url = new URL(normalizedSource);
  } catch {
    throw new Error('远程媒体 URL 无效。');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 HTTP/HTTPS 远程媒体 URL。');

  const resolvedKind: RemoteMediaKind = kind === 'remote' && /\/video\//i.test(url.pathname) && isSupportedSocialMediaPage(normalizedSource)
    ? 'video'
    : kind;
  const cacheKey = cacheKeyFor(normalizedSource);
  const existingMeta = await (async () => {
    try {
      return JSON.parse(await fs.readFile(mediaCacheMetaFile(cacheKey), 'utf8')) as {
        source?: unknown; mimeType?: unknown;
      };
    } catch {
      return undefined;
    }
  })();

  let remoteUrl = typeof existingMeta?.source === 'string' ? existingMeta.source : undefined;
  let mimeType = typeof existingMeta?.mimeType === 'string' ? existingMeta.mimeType : undefined;

  const resolved = await resolveWithYtDlp(normalizedSource, resolvedKind);
  remoteUrl = resolved.remoteUrl ?? remoteUrl ?? (looksLikeDirectMedia(normalizedSource, resolvedKind) ? normalizedSource : undefined);
  mimeType = resolved.mimeType ?? mimeType;

  const cached = remoteUrl
    ? await cacheRemoteResource(cacheKey, remoteUrl, resolvedKind, mimeType)
    : undefined;
  return {
    source: normalizedSource,
    kind: resolvedKind,
    ...(remoteUrl ? { remoteUrl } : {}),
    cacheKey,
    ...(cached?.cachePath ? { cachePath: cached.cachePath } : {}),
    ...(cached?.mimeType ? { mimeType: cached.mimeType } : {}),
  };
}
