import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// ---------------------------------------------------------------------------
// 供应商审计专用流转：状态一节一节走，跨级拒收；读写都落在同一份持久化数据上，
// 工作台列表和详情抽屉看到的永远是同一条审计单。
// ---------------------------------------------------------------------------

const AUDIT_KEY = 'supplieraudit'
const TRAINING_KEY = 'training'

// 审计方式只认这三种，别的写法按无效值处理。
export const AUDIT_METHODS = ['现场审计', '书面审计', '远程审计']

// 整改期限有效窗口：今天起 180 天内，超出范围按无效值处理。
export const AUDIT_DEADLINE_MAX_DAYS = 180

// 流转表：每个动作只允许从列出的状态过来，别的起点一律拒收。
const AUDIT_TRANSITIONS: Record<string, { from: string[]; target: string }> = {
  提交审计: { from: ['待审计', '需整改'], target: '审计中' },
  判定通过: { from: ['审计中'], target: '已通过' },
  要求整改: { from: ['审计中'], target: '需整改' },
  驳回审计: { from: ['审计中'], target: '待审计' },
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function todayStr(): string {
  return formatDate(new Date())
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00`)
  date.setDate(date.getDate() + days)
  return formatDate(date)
}

// 页面和服务层共用同一套期限窗口，两处查到的整改期限口径一致。
export function auditDeadlineRange(): { min: string; max: string } {
  const min = todayStr()
  return { min, max: addDays(min, AUDIT_DEADLINE_MAX_DAYS) }
}

function isValidDeadline(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime()) || formatDate(parsed) !== value) {
    return false
  }
  const { min, max } = auditDeadlineRange()
  return value >= min && value <= max
}

function isValidAuditMethod(value: string): boolean {
  return AUDIT_METHODS.includes(value)
}

function isValidDefectCount(value: string): boolean {
  return /^\d+$/.test(value)
}

// 同一个字段可能有两份来源（页面新填的、单上已有的）。相左时先判优先级——
// 页面新填的有效值优先，其次单上已有的有效值，两份都无效就按空处理。
function resolveFieldValue(
  formValue: unknown,
  recordValue: unknown,
  isValid: (value: string) => boolean,
): string {
  const formText = String(formValue ?? '').trim()
  if (formText !== '' && isValid(formText)) {
    return formText
  }
  const recordText = String(recordValue ?? '').trim()
  if (recordText !== '' && isValid(recordText)) {
    return recordText
  }
  return ''
}

function findAudit(id: number): { rows: EntryRow[]; index: number } | null {
  const rows = listRows(AUDIT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  return index < 0 ? null : { rows, index }
}

function checkAuditTransition(action: string, current: string): ActionResult | null {
  const rule = AUDIT_TRANSITIONS[action]
  if (!rule) {
    return { ok: false, message: `供应商审计记录没有登记「${action}」这个动作` }
  }
  if (current === rule.target) {
    return { ok: false, message: `供应商审计记录已经是「${rule.target}」，不用重复操作` }
  }
  if (!rule.from.includes(current)) {
    return {
      ok: false,
      message: `供应商审计记录当前状态「${current}」，不能跨级流转到「${rule.target}」，请先流转到「${rule.from.join('」或「')}」`,
    }
  }
  return null
}

function persistAudit(rows: EntryRow[], index: number, updated: EntryRow): void {
  const next = [...rows]
  next[index] = updated
  saveRows(AUDIT_KEY, next)
}

// 抽屉和工作台都从这里拿单条记录：读的是持久化那份的克隆，谁也不会拿到另一份。
export function getAudit(id: number): EntryRow | null {
  const found = findAudit(id)
  return found ? clone(found.rows[found.index]) : null
}

// 提交审计：缺陷项数与审计方式一次写全，单次落库，状态同步推进到「审计中」。
export function submitAudit(
  id: number,
  draft: { 审计方式?: unknown; 缺陷项数?: unknown } = {},
): ActionResult {
  const found = findAudit(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的供应商审计记录` }
  }
  const blocked = checkAuditTransition('提交审计', String(found.rows[found.index].status))
  if (blocked) {
    return blocked
  }
  const 审计方式 = resolveFieldValue(draft.审计方式, found.rows[found.index]['审计方式'], isValidAuditMethod)
  const 缺陷项数 = resolveFieldValue(draft.缺陷项数, found.rows[found.index]['缺陷项数'], isValidDefectCount)
  if (审计方式 === '' || 缺陷项数 === '') {
    return {
      ok: false,
      message: `提交审计前请把审计方式（${AUDIT_METHODS.join('/')}）与缺陷项数（非负整数）一次填全`,
    }
  }
  persistAudit(found.rows, found.index, {
    ...found.rows[found.index],
    审计方式,
    缺陷项数,
    status: '审计中',
    审计状态: '审计中',
    pending: true,
    abnormal: false,
  })
  return { ok: true, message: '供应商审计记录已提交审计，审计方式与缺陷项数已一次写全，当前状态「审计中」' }
}

// 审计结论同步落到人员培训清单；同一份审计重复复核只算一次——
// 单上已经挂过培训记录编号的，直接复用，不再重复登记。
function ensureTrainingRecord(audit: EntryRow, conclusion: string): string {
  const linked = String(audit['培训记录编号'] ?? '').trim()
  const rows = listRows(TRAINING_KEY)
  if (linked !== '' && rows.some((row) => String(row['培训编号']) === linked)) {
    return linked
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const code = `TRAI-${String(nextId).padStart(4, '0')}`
  const today = todayStr()
  const record: EntryRow = {
    id: nextId,
    status: '待培训',
    pending: true,
    abnormal: false,
    培训编号: code,
    培训主题: `供应商审计结论培训：${String(audit['供应商名称'] ?? '')}（${conclusion}）`,
    受训岗位: '质量保证岗',
    培训方式: '集中培训',
    考核成绩: '待考核',
    培训日期: today,
    有效期至: addDays(today, 365),
    培训状态: '待培训',
  }
  saveRows(TRAINING_KEY, [...rows, record])
  return code
}

// 判定通过 / 要求整改：只能由「审计中」过来；要求整改时整改期限超出范围按无效值拒收。
export function concludeAudit(
  id: number,
  action: '判定通过' | '要求整改',
  draft: { 审计结论?: unknown; 整改期限?: unknown } = {},
): ActionResult {
  const found = findAudit(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的供应商审计记录` }
  }
  const blocked = checkAuditTransition(action, String(found.rows[found.index].status))
  if (blocked) {
    return blocked
  }
  const target = AUDIT_TRANSITIONS[action].target
  const conclusion =
    String(draft.审计结论 ?? '').trim() || (action === '判定通过' ? '审计通过' : '审计发现缺陷，需限期整改')
  let deadline = ''
  if (action === '要求整改') {
    deadline = String(draft.整改期限 ?? '').trim()
    if (!isValidDeadline(deadline)) {
      const { min, max } = auditDeadlineRange()
      return {
        ok: false,
        message: `整改期限「${deadline || '空'}」超出有效范围（${min} 至 ${max}），按无效值处理，请重新填写`,
      }
    }
  }
  const trainingCode = ensureTrainingRecord(found.rows[found.index], target)
  persistAudit(found.rows, found.index, {
    ...found.rows[found.index],
    审计结论: conclusion,
    整改期限: deadline,
    培训记录编号: trainingCode,
    status: target,
    审计状态: target,
    pending: target !== '已通过',
    abnormal: false,
  })
  return {
    ok: true,
    message: `供应商审计记录已${action}，结论已落到人员培训清单（${trainingCode}），当前状态「${target}」`,
  }
}

// 驳回审计：先把审计中填的中间态（审计方式、缺陷项数、审计结论、整改期限）清干净，
// 再退到「待审计」，单次写库，退出再进来读到的就是这份。
export function rejectAudit(id: number): ActionResult {
  const found = findAudit(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的供应商审计记录` }
  }
  const blocked = checkAuditTransition('驳回审计', String(found.rows[found.index].status))
  if (blocked) {
    return blocked
  }
  persistAudit(found.rows, found.index, {
    ...found.rows[found.index],
    审计方式: '',
    缺陷项数: '',
    审计结论: '',
    整改期限: '',
    status: '待审计',
    审计状态: '待审计',
    pending: true,
    abnormal: true,
  })
  return {
    ok: true,
    message: '供应商审计记录已驳回，审计方式、缺陷项数、审计结论、整改期限已清空，当前状态「待审计」',
  }
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
