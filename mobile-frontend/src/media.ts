import { ref } from 'vue'
export const pendingMediaWrites = ref(0)
export type MediaRef = { id: string; name: string; mime: string; size: number }
type StoredMedia = { id: string; blob: Blob; name: string; mime: string; size: number }
const urls = new Map<string, string>()
let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('当前浏览器不支持本机附件保存，请更换浏览器后重试。')); return }
    const request = indexedDB.open('lexiu-demo-media-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('media', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(new Error('无法打开本机附件存储，请检查浏览器存储权限。')) }
    request.onblocked = () => { database = undefined; reject(new Error('附件存储正被其他页面占用，请关闭旧版演示页面后重试。')) }
  })
  return database
}
async function writeMedia(operation: (store: IDBObjectStore) => void) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('media', 'readwrite')
    operation(tx.objectStore('media'))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(new Error('附件未保存，浏览器存储空间可能不足，请换一张较小的图片重试。'))
    tx.onabort = tx.onerror
  })
}
export async function saveMedia(file: File, maxPixels = 30_000_000): Promise<MediaRef> {
  if (!file.size) throw new Error('文件为空，请重新选择。')
  if (file.size > 20 * 1024 * 1024) throw new Error('单个附件请控制在 20MB 以内。')
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((n, i) => bytes[i] === n)
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  const officeMime: Record<string, string> = { doc: 'application/msword', xls: 'application/vnd.ms-excel', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  const office = ole && ['doc', 'xls'].includes(ext) || zip && ['docx', 'xlsx'].includes(ext)
  if (!jpeg && !png && !pdf && !office) throw new Error('文件类型或内容不正确，请重新选择受支持的附件。')
  if (jpeg && !['jpg', 'jpeg'].includes(ext) || png && ext !== 'png' || pdf && ext !== 'pdf') throw new Error('文件扩展名与内容不一致，请重新选择原文件。')
  const mime = office ? officeMime[ext]! : pdf ? 'application/pdf' : jpeg ? 'image/jpeg' : 'image/png'
  if (jpeg || png) {
    let bitmap: ImageBitmap
    try { bitmap = await createImageBitmap(file) }
    catch { throw new Error('图片无法读取，可能已损坏，请重新选择。') }
    const pixels = bitmap.width * bitmap.height
    bitmap.close()
    if (pixels > maxPixels) throw new Error(`图片像素过大，请缩小到 ${maxPixels / 1_000_000} 百万像素以内再选择。`)
  }
  const ref: MediaRef = { id: crypto.randomUUID(), name: file.name, mime, size: file.size }
  await writeMedia(store => store.put({ ...ref, blob: file.slice(0, file.size, mime) } satisfies StoredMedia))
  return ref
}
export async function getMediaUrl(ref: MediaRef | string): Promise<string> {
  const id = typeof ref === 'string' ? ref : ref.id
  if (id.startsWith('sample:')) {
    const name = id.slice(7)
    if (!['record', 'menu-1', 'menu-2', 'fire'].includes(name)) throw new Error('演示附件不存在。')
    return `./assets/demo/${name}.svg`
  }
  if (urls.has(id)) return urls.get(id)!
  const db = await openDatabase()
  const saved = await new Promise<StoredMedia | undefined>((resolve, reject) => {
    const request = db.transaction('media', 'readonly').objectStore('media').get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('附件暂时无法读取，请重试。'))
  })
  if (!saved?.blob) throw new Error('本机附件已被清理或不在此浏览器中，请重新选择文件。')
  const url = URL.createObjectURL(saved.blob)
  urls.set(id, url)
  return url
}
export async function deleteMedia(id: string) {
  if (id.startsWith('sample:')) return
  if (urls.has(id)) URL.revokeObjectURL(urls.get(id)!)
  urls.delete(id)
  await writeMedia(store => store.delete(id))
}
export async function clearMedia() {
  await writeMedia(store => store.clear())
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
}
export async function downloadMedia(file: MediaRef) {
  const url = await getMediaUrl(file)
  const link = document.createElement('a')
  link.href = url; link.download = file.name; link.click()
}
