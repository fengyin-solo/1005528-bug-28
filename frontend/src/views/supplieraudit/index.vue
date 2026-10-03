<template>
  <section class="page" data-module="supplieraudit">
    <header class="page-head">
      <div>
        <h2>供应商审计管理</h2>
        <p class="page-desc">维护供应商审计记录，围绕审计编号、供应商名称、物料类别、审计方式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记供应商审计记录</button>
        <button class="btn" type="button" @click="exportRows">导出供应商审计清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ show(row[column]) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDrawer(row)">处理</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无供应商审计数据，可先登记供应商审计记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条供应商审计记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="drawerRow" class="drawer-mask" @click.self="closeDrawer">
      <aside class="drawer" data-module="supplieraudit-drawer">
        <header class="drawer-head">
          <h3>审计单 · {{ show(drawerRow['审计编号']) }}</h3>
          <button class="btn ghost" type="button" @click="closeDrawer">关闭</button>
        </header>

        <dl class="detail-grid">
          <div v-for="field in detailFields" :key="field" class="detail-item">
            <dt>{{ field }}</dt>
            <dd>{{ show(drawerRow[field]) }}</dd>
          </div>
          <div class="detail-item">
            <dt>当前状态</dt>
            <dd>{{ drawerRow.status }}</dd>
          </div>
        </dl>

        <form v-if="drawerRow.status === '待审计'" class="drawer-form" @submit.prevent="submitContent">
          <label class="form-item">
            <span>审计方式</span>
            <input v-model="draft.审计方式" placeholder="如：现场审计 / 书面审计" />
          </label>
          <label class="form-item">
            <span>缺陷项数</span>
            <input v-model="draft.缺陷项数" type="number" min="0" step="1" placeholder="0" />
          </label>
          <label class="form-item">
            <span>整改期限</span>
            <input v-model="draft.整改期限" type="date" />
          </label>
          <button class="btn primary" type="submit">提交审计</button>
        </form>

        <div v-else-if="drawerRow.status === '审计中'" class="drawer-actions">
          <button class="btn primary" type="button" @click="conclude('判定通过')">判定通过</button>
          <button class="btn" type="button" @click="conclude('要求整改')">要求整改</button>
          <button class="btn ghost" type="button" @click="reject">驳回审计</button>
        </div>

        <p v-else class="drawer-hint">
          该审计已完成复核，结论「{{ show(drawerRow['审计结论']) }}」，重复复核只算一次。
        </p>

        <p v-if="drawerMessage" class="drawer-message" :class="drawerOk ? 'ok' : 'error'">
          {{ drawerMessage }}
        </p>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  concludeAudit,
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  rejectAudit,
  submitAudit,
} from '@/api/local-service'
import type { ActionResult, EntryRow } from '@/data/types'

const meta = moduleMeta('supplieraudit')
const columns = ["审计编号", "供应商名称", "物料类别", "审计方式", "缺陷项数", "审计结论", "整改期限", "审计状态"]
const statuses = ["待审计", "审计中", "已通过", "需整改"]
const detailFields = ["审计编号", "供应商名称", "物料类别", "审计方式", "缺陷项数", "审计结论", "整改期限"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 抽屉里展示的这条记录：每次打开、每次操作后都重新从数据层取，和工作台列表读的是同一条持久化记录
const drawerRow = ref<EntryRow | null>(null)
const draft = ref<{ 审计方式: string; 缺陷项数: string | number; 整改期限: string }>({
  审计方式: '',
  缺陷项数: '',
  整改期限: '',
})
const drawerMessage = ref('')
const drawerOk = ref(false)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: countByStatus(status),
  })),
)
const stats = computed(() => [
  { label: '待审计供应商', value: countByStatus('待审计') },
  { label: '审计中供应商', value: countByStatus('审计中') },
  { label: '需整改供应商数', value: countByStatus('需整改') },
])

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function show(value: unknown): string {
  return value === '' || value === undefined || value === null ? '—' : String(value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '供应商审计记录登记入口尚未接入审批流'
}

function openDrawer(row: EntryRow) {
  const fresh = getEntry(meta.key, Number(row.id))
  drawerRow.value = fresh ? { ...fresh } : null
  draft.value = { 审计方式: '', 缺陷项数: '', 整改期限: '' }
  drawerMessage.value = ''
  drawerOk.value = false
}

function closeDrawer() {
  drawerRow.value = null
}

function refreshDrawer() {
  if (!drawerRow.value) {
    return
  }
  const fresh = getEntry(meta.key, Number(drawerRow.value.id))
  drawerRow.value = fresh ? { ...fresh } : null
}

// 每次流转动作之后，工作台和抽屉都重新对齐持久化那份，两处看到的永远是同一条
function feedback(result: ActionResult) {
  drawerOk.value = result.ok
  drawerMessage.value = result.message
  reload()
  refreshDrawer()
}

function submitContent() {
  if (!drawerRow.value) {
    return
  }
  feedback(submitAudit(Number(drawerRow.value.id), { ...draft.value }))
}

function conclude(decision: '判定通过' | '要求整改') {
  if (!drawerRow.value) {
    return
  }
  feedback(concludeAudit(Number(drawerRow.value.id), decision))
}

function reject() {
  if (!drawerRow.value) {
    return
  }
  feedback(rejectAudit(Number(drawerRow.value.id)))
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '供应商审计列表读取失败'
  }
}

onMounted(reload)
</script>
