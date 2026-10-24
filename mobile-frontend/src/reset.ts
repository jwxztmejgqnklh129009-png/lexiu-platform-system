import { resetWarehouse } from './stores/warehouse'
import { resetRecords } from './stores/records'
import { resetFire } from './stores/fire'
import { resetDrinks } from './stores/drinks'
import { resetAccounts } from './stores/accounts'
import { handledReviews } from './reviews'
import { clearMedia } from './media'
import { storageProblem } from './persistence'
export async function resetDemo() {
  storageProblem.value = ''
  resetWarehouse(); resetRecords(); resetFire(); resetDrinks()
  handledReviews.value = []
  resetAccounts()
  if (storageProblem.value) throw new Error('文字记录未能完整保存，重置未完成，原有附件已保留。请检查浏览器存储后重试。')
  await clearMedia()
}
