import { persistedRef, uid, nowText } from '../persistence'
import { session } from '../session'
import type { MediaRef } from '../media'

export type DrinkPage = { id: string; title: string; image: MediaRef; uploadedAt: string }
const seedPages = (): DrinkPage[] => [
  { id: 'drink-demo-1', title: '啤酒与软饮 · 演示样张', image: { id: 'sample:menu-1', name: '酒水单演示页1.svg', mime: 'image/svg+xml', size: 0 }, uploadedAt: '初始演示样张' },
  { id: 'drink-demo-2', title: '洋酒与小食 · 演示样张', image: { id: 'sample:menu-2', name: '酒水单演示页2.svg', mime: 'image/svg+xml', size: 0 }, uploadedAt: '初始演示样张' },
]
export const drinkPages = persistedRef<DrinkPage[]>('drink-pages', seedPages())
export const drinkNote = persistedRef<string>('drink-note', '演示酒水单，具体酒水与价格请以门店实际说明为准。')

function requireAdmin() {
  if (!session.signedIn || session.role !== 'admin') throw new Error('请使用演示管理员账号维护酒水单')
}
function requireImage(image: MediaRef | undefined) {
  if (!image) throw new Error('请先选择一张酒单图片')
  if (!['image/jpeg', 'image/png'].includes(image.mime)) throw new Error('酒单只支持 JPG / PNG 图片')
  if (!image.size) throw new Error('这张图片是空文件，请重新选择')
  return image
}

export function saveDrinkPage(input: { id?: string; title: string; image?: MediaRef }) {
  requireAdmin()
  const title = input.title.trim()
  if (input.id) {
    const existing = drinkPages.value.find(page => page.id === input.id)
    if (!existing) throw new Error('这一页已经不存在，请返回列表重试')
    const image = input.image ? requireImage(input.image) : existing.image
    drinkPages.value = drinkPages.value.map(page => page.id === input.id ? { ...page, title, image, uploadedAt: nowText() } : page)
  } else {
    const image = requireImage(input.image)
    drinkPages.value = [...drinkPages.value, { id: uid('drink'), title, image, uploadedAt: nowText() }]
  }
}

export function moveDrinkPage(id: string, direction: 'up' | 'down') {
  requireAdmin()
  const pages = [...drinkPages.value]
  const index = pages.findIndex(page => page.id === id)
  if (index < 0) throw new Error('这一页已经不存在')
  const target = index + (direction === 'up' ? -1 : 1)
  if (target < 0 || target >= pages.length) return
  ;[pages[index], pages[target]] = [pages[target]!, pages[index]!]
  drinkPages.value = pages
}

export function deleteDrinkPage(id: string) {
  requireAdmin()
  if (!drinkPages.value.some(page => page.id === id)) throw new Error('这一页已经不存在')
  drinkPages.value = drinkPages.value.filter(page => page.id !== id)
}

export function saveDrinkNote(note: string) {
  requireAdmin()
  if (note.trim().length > 200) throw new Error('底部说明不能超过200字')
  drinkNote.value = note.trim()
}

export function resetDrinks() {
  drinkPages.value = seedPages()
  drinkNote.value = '演示酒水单，具体酒水与价格请以门店实际说明为准。'
}
