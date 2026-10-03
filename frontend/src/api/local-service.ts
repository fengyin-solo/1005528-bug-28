import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

// 按编号取单条：工作台列表和详情抽屉都从这里读，保证两处看到的是同一条持久化记录。
export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
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

// —— 供应商审计流转 ——————————————————————————————————————————
// 状态一节一节走：待审计 → 审计中 → 已通过 / 需整改，驳回只退一节回待审计；
// 跨级流转（待审计直接复核、已定审再驳回等）一律拒收。
// 缺陷项数与审计方式一次写全；驳回先把中间态清干净，再退回待审计，同一次写库落盘。

const AUDIT_KEY = 'supplieraudit'
const TRAINING_KEY = 'training'

type AuditDecision = '判定通过' | '要求整改'
type AuditAction = '提交审计' | AuditDecision | '驳回审计'

// 每个动作只允许从某一节状态出发：from 不符就是跨级，直接拒收
const AUDIT_FLOW: Record<AuditAction, { from: string; to: string }> = {
  提交审计: { from: '待审计', to: '审计中' },
  判定通过: { from: '审计中', to: '已通过' },
  要求整改: { from: '审计中', to: '需整改' },
  驳回审计: { from: '审计中', to: '待审计' },
}

// 审计过程中填的中间内容：驳回时一次清干净，不留半截在单上
const AUDIT_DRAFT_FIELDS = ['审计方式', '缺陷项数', '审计结论', '整改期限']

// 整改期限有效范围：今天起最长 180 天，超出按无效值处理
const RECTIFICATION_MAX_DAYS = 180
const DAY_MS = 24 * 60 * 60 * 1000

export type AuditContent = {
  审计方式?: string
  缺陷项数?: string | number
  整改期限?: string
}

function textValue(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value
  }
  return undefined
}

function todayOnly(): number {
  const now = new Date()
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
}

function parseDateOnly(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) {
    return null
  }
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const date = new Date(time)
  const same =
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  return same ? time : null
}

function formatDateOnly(time: number): string {
  const date = new Date(time)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

// 缺陷项数与审计方式相左时先判优先级，再定按哪一份：
// 1) 本次提交把两项写全了 → 整份按本次提交；
// 2) 本次没写全 → 整份回退到持久化在库的那份；
// 3) 两份都凑不齐 → 内容不完整，拒收。
// 两份绝不拼接：不拿新提交的缺陷项数去配在库里的审计方式。
function resolveAuditContent(
  submitted: AuditContent,
  persisted: EntryRow,
): { 审计方式: string; 缺陷项数: string | number } | null {
  const 方式 = textValue(submitted.审计方式)
  const 项数 = textValue(submitted.缺陷项数)
  if (方式 !== undefined && 项数 !== undefined) {
    return { 审计方式: String(方式).trim(), 缺陷项数: 项数 }
  }
  const 在库方式 = textValue(persisted['审计方式'])
  const 在库项数 = textValue(persisted['缺陷项数'])
  if (在库方式 !== undefined && 在库项数 !== undefined) {
    return { 审计方式: String(在库方式).trim(), 缺陷项数: 在库项数 }
  }
  return null
}

function normalizeDefectCount(value: string | number): number | null {
  const num = typeof value === 'number' ? value : Number(value.trim())
  if (!Number.isInteger(num) || num < 0) {
    return null
  }
  return num
}

function isValidRectificationDeadline(value: string): boolean {
  const time = parseDateOnly(value)
  if (time === null) {
    return false
  }
  const today = todayOnly()
  return time >= today && time <= today + RECTIFICATION_MAX_DAYS * DAY_MS
}

function auditRow(id: number): { rows: EntryRow[]; index: number } | null {
  const rows = listRows(AUDIT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  return index < 0 ? null : { rows, index }
}

// 提交审计：待审计 → 审计中。缺陷项数、审计方式、整改期限一次写全，同一个持久化动作落库。
export function submitAudit(id: number, content: AuditContent): ActionResult {
  const found = auditRow(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的供应商审计记录` }
  }
  const { rows, index } = found
  const status = String(rows[index].status)
  if (status !== AUDIT_FLOW.提交审计.from) {
    return { ok: false, message: `供应商审计记录当前是「${status}」，只有「待审计」能提交审计，跨级流转不予接收` }
  }
  const resolved = resolveAuditContent(content, rows[index])
  if (!resolved) {
    return { ok: false, message: '缺陷项数与审计方式应一次写全，本次提交与在库内容都凑不齐一份' }
  }
  const 缺陷项数 = normalizeDefectCount(resolved.缺陷项数)
  if (缺陷项数 === null) {
    return { ok: false, message: '缺陷项数应为不小于 0 的整数，本次按无效值处理' }
  }
  const 整改期限 = String(content.整改期限 ?? '').trim()
  if (!整改期限) {
    return { ok: false, message: `整改期限未填，按无效值处理：请填今天起 ${RECTIFICATION_MAX_DAYS} 天内的日期` }
  }
  if (!isValidRectificationDeadline(整改期限)) {
    return { ok: false, message: `整改期限超出有效范围（今天起 ${RECTIFICATION_MAX_DAYS} 天内），按无效值处理` }
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    审计方式: resolved.审计方式,
    缺陷项数,
    整改期限,
    status: AUDIT_FLOW.提交审计.to,
    审计状态: AUDIT_FLOW.提交审计.to,
    pending: true,
    abnormal: false,
  }
  saveRows(AUDIT_KEY, next)
  return { ok: true, message: '供应商审计记录已提交审计，缺陷项数与审计方式一次写全，当前状态「审计中」' }
}

// 复核结论：审计中 → 已通过 / 需整改。同一份审计重复复核只算一次；需整改的结论落到人员培训清单。
export function concludeAudit(id: number, decision: AuditDecision): ActionResult {
  const found = auditRow(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的供应商审计记录` }
  }
  const { rows, index } = found
  const status = String(rows[index].status)
  if (status === '已通过' || status === '需整改') {
    return { ok: false, message: `供应商审计记录已复核，结论「${rows[index]['审计结论'] ?? status}」，重复复核只算一次` }
  }
  const flow = AUDIT_FLOW[decision]
  if (status !== flow.from) {
    return { ok: false, message: `供应商审计记录还在「${status}」，不能跨级复核，请先提交审计` }
  }
  const 结论 = decision === '判定通过' ? '通过' : '需整改'
  const next = [...rows]
  next[index] = {
    ...rows[index],
    审计结论: 结论,
    status: flow.to,
    审计状态: flow.to,
    pending: flow.to !== '已通过',
    abnormal: flow.to === '需整改',
  }
  saveRows(AUDIT_KEY, next)
  if (decision === '要求整改') {
    appendRectificationTraining(next[index])
    return { ok: true, message: '供应商审计记录要求整改，结论已落到人员培训清单，当前状态「需整改」' }
  }
  return { ok: true, message: '供应商审计记录已判定通过，当前状态「已通过」' }
}

// 驳回：审计中 → 待审计。先把中间态清干净，再退回待审计，同一次写库，库里不留半截内容。
export function rejectAudit(id: number): ActionResult {
  const found = auditRow(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的供应商审计记录` }
  }
  const { rows, index } = found
  const status = String(rows[index].status)
  if (status !== AUDIT_FLOW.驳回审计.from) {
    return { ok: false, message: `只有「审计中」的供应商审计记录能驳回，当前是「${status}」，跨级驳回不予接收` }
  }
  const cleared: EntryRow = {
    ...rows[index],
    status: AUDIT_FLOW.驳回审计.to,
    审计状态: AUDIT_FLOW.驳回审计.to,
    pending: true,
    abnormal: false,
  }
  for (const field of AUDIT_DRAFT_FIELDS) {
    cleared[field] = ''
  }
  const next = [...rows]
  next[index] = cleared
  saveRows(AUDIT_KEY, next)
  return { ok: true, message: '供应商审计记录已驳回，中间态已清干净，退回「待审计」' }
}

// 结论落到人员培训的清单：同一份审计只落一条培训记录，重复复核不重复落。
function appendRectificationTraining(audit: EntryRow): void {
  const 审计编号 = String(audit['审计编号'] ?? '').trim()
  const rows = listRows(TRAINING_KEY)
  if (审计编号 && rows.some((row) => String(row['来源审计'] ?? '') === 审计编号)) {
    return
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const record: EntryRow = {
    id: nextId,
    status: '待培训',
    pending: true,
    abnormal: false,
    培训编号: nextTrainingCode(rows),
    培训主题: `供应商审计整改培训（${审计编号}·${String(audit['供应商名称'] ?? '')}）`,
    受训岗位: '供应商管理',
    培训方式: '专项整改培训',
    考核成绩: '',
    培训日期: formatDateOnly(todayOnly()),
    有效期至: '',
    培训状态: '待培训',
    来源审计: 审计编号,
  }
  saveRows(TRAINING_KEY, [...rows, record])
}

function nextTrainingCode(rows: EntryRow[]): string {
  const max = rows.reduce((acc, row) => {
    const match = /^TRAI-(\d+)$/.exec(String(row['培训编号'] ?? ''))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `TRAI-${String(max + 1).padStart(4, '0')}`
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
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
