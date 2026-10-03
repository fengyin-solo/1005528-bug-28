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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDrawer(row)">详情 / 处理</button>
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

    <div v-if="drawerRow" class="drawer-mask" @click="closeDrawer"></div>
    <aside v-if="drawerRow" class="drawer">
      <header class="drawer-head">
        <h3 class="drawer-title">审计单详情 · {{ drawerRow['审计编号'] }}</h3>
        <button class="link" type="button" @click="closeDrawer">关闭</button>
      </header>
      <div class="drawer-body">
        <dl class="detail-grid">
          <template v-for="field in columns" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ drawerRow[field] || '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ drawerRow.status }}</dd>
          <template v-if="drawerRow['培训记录编号']">
            <dt>培训记录编号</dt>
            <dd>{{ drawerRow['培训记录编号'] }}</dd>
          </template>
        </dl>

        <form v-if="canSubmit" class="drawer-form" @submit.prevent="submitFromDrawer">
          <p class="drawer-hint">审计方式与缺陷项数一次写全后，单据进入「审计中」。</p>
          <label>
            审计方式
            <select v-model="draft.审计方式">
              <option value="" disabled>请选择审计方式</option>
              <option v-for="method in auditMethods" :key="method" :value="method">{{ method }}</option>
            </select>
          </label>
          <label>
            缺陷项数
            <input v-model="draft.缺陷项数" type="number" min="0" step="1" placeholder="非负整数" />
          </label>
          <div class="drawer-actions">
            <button class="btn primary" type="submit">
              {{ drawerRow.status === '需整改' ? '重新提交审计' : '提交审计' }}
            </button>
          </div>
        </form>

        <form v-if="drawerRow.status === '审计中'" class="drawer-form" @submit.prevent>
          <p class="drawer-hint">
            结论判定后同步落到人员培训清单；要求整改时整改期限须在 {{ deadlineRange.min }} 至
            {{ deadlineRange.max }} 之间，超出范围按无效值处理。
          </p>
          <label>
            审计结论
            <input v-model="draft.审计结论" placeholder="填写审计结论" />
          </label>
          <label>
            整改期限（要求整改时必填）
            <input
              v-model="draft.整改期限"
              type="date"
              :min="deadlineRange.min"
              :max="deadlineRange.max"
            />
          </label>
          <div class="drawer-actions">
            <button class="btn primary" type="button" @click="concludeFromDrawer('判定通过')">判定通过</button>
            <button class="btn" type="button" @click="concludeFromDrawer('要求整改')">要求整改</button>
            <button class="btn danger" type="button" @click="rejectFromDrawer">驳回审计</button>
          </div>
        </form>

        <p v-if="drawerRow.status === '已通过'" class="drawer-hint">
          审计已结论通过，结论已落到人员培训清单，单据只读。
        </p>
      </div>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  AUDIT_METHODS,
  auditDeadlineRange,
  concludeAudit,
  downloadEntries,
  getAudit,
  listEntries,
  moduleMeta,
  rejectAudit,
  submitAudit,
} from '@/api/local-service'
import type { ActionResult, EntryRow } from '@/data/types'

const meta = moduleMeta('supplieraudit')
const columns = ["审计编号", "供应商名称", "物料类别", "审计方式", "缺陷项数", "审计结论", "整改期限", "审计状态"]
const statuses = ["待审计", "审计中", "已通过", "需整改"]
const stats = [{"label": "待审计供应商", "value": 0}, {"label": "审计中供应商", "value": 0}, {"label": "需整改供应商数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 抽屉只记当前单据 id，内容永远从持久化那份重读，和工作台列表看到的是同一条。
const drawerRow = ref<EntryRow | null>(null)
const auditMethods = AUDIT_METHODS
const deadlineRange = auditDeadlineRange()
const draft = ref({ 审计方式: '', 缺陷项数: '', 审计结论: '', 整改期限: '' })

const canSubmit = computed(
  () => drawerRow.value !== null && ['待审计', '需整改'].includes(String(drawerRow.value.status)),
)

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
  errorMessage.value = ''
  const fresh = getAudit(Number(row.id))
  if (!fresh) {
    errorMessage.value = '这条供应商审计记录已不存在，列表已刷新'
    reload()
    return
  }
  drawerRow.value = fresh
  draft.value = {
    审计方式: auditMethods.includes(String(fresh['审计方式'])) ? String(fresh['审计方式']) : '',
    缺陷项数: /^\d+$/.test(String(fresh['缺陷项数'])) ? String(fresh['缺陷项数']) : '',
    审计结论: '',
    整改期限: '',
  }
}

function closeDrawer() {
  drawerRow.value = null
}

function afterAction(result: ActionResult) {
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  reload()
  if (drawerRow.value) {
    drawerRow.value = getAudit(Number(drawerRow.value.id))
  }
}

function submitFromDrawer() {
  if (!drawerRow.value) return
  afterAction(
    submitAudit(Number(drawerRow.value.id), {
      审计方式: draft.value.审计方式,
      缺陷项数: draft.value.缺陷项数,
    }),
  )
}

function concludeFromDrawer(action: '判定通过' | '要求整改') {
  if (!drawerRow.value) return
  afterAction(
    concludeAudit(Number(drawerRow.value.id), action, {
      审计结论: draft.value.审计结论,
      整改期限: draft.value.整改期限,
    }),
  )
}

function rejectFromDrawer() {
  if (!drawerRow.value) return
  afterAction(rejectAudit(Number(drawerRow.value.id)))
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
