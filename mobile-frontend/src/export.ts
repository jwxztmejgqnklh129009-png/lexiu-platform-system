import { inventory, stockLogs, imageVersions, assets, assetLogs } from './stores/warehouse'
import { records, recordVersions, recordEdits } from './stores/records'
import { firePhotos, fireOrders } from './stores/fire'
import { drinkPages, drinkNote } from './stores/drinks'
import { accountLedger } from './stores/accounts'
import { handledReviews } from './reviews'
import { session } from './session'
import { nowText } from './persistence'

export function downloadLedger() {
  if (!session.signedIn || session.role !== 'admin') throw new Error('文字台账仅管理员可下载。')
  const payload = {
    title: '乐秀手机前端 · 本机演示文字台账', exportedAt: nowText(),
    scope: '仅本浏览器演示记录和附件文件名，不包含图片/PDF/Office文件本体、密码或密码摘要；不能用作完整附件备份。',
    inventory: inventory.value, inventoryLogs: stockLogs.value, inventoryImageVersions: imageVersions.value,
    assets: assets.value, assetLogs: assetLogs.value, certificates: records.value, certificateVersions: recordVersions.value,
    certificateEdits: recordEdits.value, firePhotos: firePhotos.value, fireOrders: fireOrders.value,
    drinkPages: drinkPages.value, drinkNote: drinkNote.value, accounts: accountLedger.value,
    reviewResults: handledReviews.value,
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = `乐秀-演示文字台账-${nowText().slice(0, 10)}.json`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
