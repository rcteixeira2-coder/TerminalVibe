import { createReadStream, promises as fsp, statSync, type ReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PreviewInfo, TreeEntry, TreeListing } from '@shared/types'
import { isInside } from './security'

const MAX_ENTRIES = 2000
const PACKAGE_EXT = /\.(app|bundle|framework|xcodeproj|xcworkspace|playground|rtfd|photoslibrary)$/i
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })

// Um nível por vez; links simbólicos aparecem mas não são seguidos (porte de ProjectFiles.swift:13-37).
export async function listDir(root: string, dir: string): Promise<TreeListing | { error: string }> {
  const target = dir ? dir : root
  if (!isInside(root, target)) return { error: 'Fora da pasta do projeto.' }
  let dirents
  try {
    dirents = await fsp.readdir(target, { withFileTypes: true })
  } catch {
    return { error: 'Não foi possível ler esta pasta.' }
  }
  const entries: TreeEntry[] = dirents.map((d) => {
    const path = join(target, d.name)
    const kind: TreeEntry['kind'] = d.isSymbolicLink()
      ? 'symlink'
      : d.isDirectory()
        ? PACKAGE_EXT.test(d.name) ? 'package' : 'dir'
        : 'file'
    return { name: d.name, path, kind, hidden: d.name.startsWith('.') }
  })
  entries.sort((a, b) => {
    const da = a.kind === 'dir' ? 0 : 1
    const db = b.kind === 'dir' ? 0 : 1
    return da - db || collator.compare(a.name, b.name)
  })
  const truncated = Math.max(0, entries.length - MAX_ENTRIES)
  return { entries: entries.slice(0, MAX_ENTRIES), truncated }
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'])
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv'])
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus'])
const HTML = new Set(['.html', '.htm'])
const TEXT_LIMIT = 1024 * 1024

export function previewKind(path: string): PreviewInfo['kind'] {
  const ext = extname(path).toLowerCase()
  if (IMAGE.has(ext)) return 'image'
  if (VIDEO.has(ext)) return 'video'
  if (AUDIO.has(ext)) return 'audio'
  if (HTML.has(ext)) return 'html'
  return 'text'
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export async function preview(root: string, projectId: string, path: string): Promise<PreviewInfo | { error: string }> {
  if (!isInside(root, path)) return { error: 'Fora da pasta do projeto.' }
  let size = 0
  try {
    const st = statSync(path)
    if (!st.isFile()) return { error: 'Não é um arquivo.' }
    size = st.size
  } catch {
    return { error: 'Arquivo não encontrado.' }
  }
  const kind = previewKind(path)
  const url = previewUrl(projectId, root, path)
  if (kind !== 'text') return { path, kind, url, size }
  if (size > TEXT_LIMIT) return { path, kind: 'other', size, tooLarge: true }
  const buf = await fsp.readFile(path)
  if (looksBinary(buf)) return { path, kind: 'other', size }
  return { path, kind: 'text', text: buf.toString('utf8'), size }
}

// preview://<projectId codificado>/<caminho relativo>
export function previewUrl(projectId: string, root: string, path: string): string {
  const rel = relative(root, path).split(sep).map(encodeURIComponent).join('/')
  return `preview://${Buffer.from(projectId).toString('hex')}/${rel}`
}

export function resolvePreviewRequest(url: string, projectRoot: (id: string) => string | null): { file: string } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'preview:') return null
  let projectId: string
  try {
    projectId = Buffer.from(u.hostname, 'hex').toString('utf8')
  } catch {
    return null
  }
  const root = projectRoot(projectId)
  if (!root) return null
  let rel: string
  try {
    rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
  // Arquivos e pastas ocultos (.env, .git, .ssh…) nunca são servidos.
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return null
  const file = resolve(root, rel || 'index.html')
  if (!isInside(root, file)) return null
  return { file }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
}

export function mimeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

// Resposta com suporte a Range (vídeo/áudio precisam para buscar).
export function fileResponse(file: string, rangeHeader: string | null): Response {
  let size: number
  try {
    const st = statSync(file)
    if (!st.isFile()) return new Response('não encontrado', { status: 404 })
    size = st.size
  } catch {
    return new Response('não encontrado', { status: 404 })
  }
  const type = mimeOf(file)
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/)
  if (m && size > 0) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2])
    let end = m[1] && m[2] ? Number(m[2]) : size - 1
    if (!m[1]) end = size - 1
    start = Math.max(0, start)
    end = Math.min(size - 1, end)
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    headers['Content-Length'] = String(end - start + 1)
    return new Response(toWeb(createReadStream(file, { start, end })), { status: 206, headers })
  }
  headers['Content-Length'] = String(size)
  return new Response(toWeb(createReadStream(file)), { status: 200, headers })
}

// Com contrapressão: o arquivo só é lido conforme o consumidor pede (vídeos grandes não vão inteiros para a memória).
function toWeb(stream: ReadStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
}

// `src/x.ts:12:3` → caminho dentro do cwd da sessão.
export function resolveTerminalPath(cwd: string, root: string, text: string): { path: string; line?: number } | null {
  const m = text.trim().match(/^(.+?)(?::(\d+))?(?::(\d+))?$/)
  if (!m) return null
  let raw = m[1].replace(/^['"(]+|['")]+$/g, '')
  if (raw.startsWith('~/')) return null
  if (raw.startsWith('file://')) raw = decodeURIComponent(raw.slice(7))
  const path = isAbsolute(raw) ? raw : resolve(cwd, raw)
  if (!isInside(root, path)) return null
  try {
    statSync(path)
  } catch {
    return null
  }
  return { path, line: m[2] ? Number(m[2]) : undefined }
}
