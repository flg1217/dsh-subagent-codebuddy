/**
 * CodeBuddy 图片 blob 存取:内容寻址存储 `~/.codebuddy/blobs/<ab>/<sha256>.<ext>`。
 *
 * - dsh 图片块(attachment 引用)→ 读出字节 → 写 blob → `image_blob_ref` 内容块,
 *   历史/提示词里的图片以原生形态进入 CodeBuddy;
 * - CodeBuddy `image_blob_ref` → 读 blob 字节 → 交给 attachments 服务入库 →
 *   dsh 图片块(消息栏预览)。
 * @module subagent-codebuddy/image-blob
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** mediaType → 扩展名。 */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** CodeBuddy 侧的一条 `image_blob_ref` 内容块。 */
export interface ImageBlobRefBlock {
  type: 'image_blob_ref'
  blob_id: string
  mime: string
  size: number
  blob_path: string
}

/** 默认 blobs 根目录。 */
export function defaultBlobsRoot(): string {
  return join(homedir(), '.codebuddy', 'blobs')
}

/** 内容寻址:写入(或复用)一张图片,返回 CodeBuddy 原生引用块。 */
export function writeImageBlob(data: Uint8Array, mediaType: string, blobsRoot?: string): ImageBlobRefBlock {
  const root = blobsRoot ?? defaultBlobsRoot()
  const blobId = createHash('sha256').update(data).digest('hex')
  const ext = IMAGE_EXT[mediaType] ?? 'png'
  const dir = join(root, blobId.slice(0, 2))
  const blobPath = join(dir, `${blobId}.${ext}`)
  if (!existsSync(blobPath)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(blobPath, data)
  }
  return { type: 'image_blob_ref', blob_id: blobId, mime: mediaType, size: data.byteLength, blob_path: blobPath }
}

/** 读取一张 CodeBuddy blob;文件缺失/不可读返回 undefined。 */
export function readImageBlob(blobPath: string): { data: Uint8Array; mediaType: string } | undefined {
  try {
    const data = readFileSync(blobPath)
    const ext = blobPath.split('.').pop()?.toLowerCase() ?? ''
    const mediaType = Object.entries(IMAGE_EXT).find(([, value]) => value === ext)?.[0] ?? 'image/png'
    return { data: new Uint8Array(data), mediaType }
  } catch {
    return undefined
  }
}

/** dsh 消息内容块里 image 块的宽形态(只取需要的字段,避免新增依赖)。 */
export interface DshImageBlockLike {
  type: 'image'
  attachment: unknown
}
