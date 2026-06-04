<template>
  <div class="run-history-view">
    <a-table
      :columns="columns"
      :data-source="runs"
      :loading="loading"
      :pagination="{ pageSize: 10 }"
      row-key="id"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'status'">
          <a-tag :color="getStatusColor(record)">
            {{ $t(getStatusKey(record)) }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'startedAt'">
          {{ formatTime(record.startedAt) }}
        </template>
        <template v-else-if="column.key === 'progress'">
          {{ (record.completedTerminals || 0) + (record.failedTerminals || 0) }} / {{ record.totalTerminals || 0 }}
        </template>
        <template v-else-if="column.key === 'action'">
          <a-space>
            <a-button
              size="small"
              type="primary"
              @click="viewRun(record.id)"
            >
              {{ $t('batchTask.viewReport') }}
            </a-button>
            <a-popconfirm
              :title="$t('batchTask.deleteRunConfirm')"
              @confirm="deleteRun(record.id)"
            >
              <a-button
                size="small"
                danger
              >
                {{ $t('batchTask.delete') }}
              </a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </template>
    </a-table>

    <div
      v-if="!loading && runs.length === 0"
      class="empty-state"
    >
      <a-empty :description="$t('batchTask.noRunHistory')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import eventBus from '@/utils/eventBus'
import type { BatchTaskRunWithTaskName } from '../../../../../preload/index.d'

const { t: $t } = useI18n()

const loading = ref(false)
const runs = ref<BatchTaskRunWithTaskName[]>([])

const columns = computed(() => [
  { title: $t('batchTask.taskName'), key: 'taskName', dataIndex: 'taskName' },
  { title: $t('batchTask.status'), key: 'status', dataIndex: 'status' },
  { title: $t('batchTask.startedAt'), key: 'startedAt', dataIndex: 'startedAt' },
  { title: $t('batchTask.progress'), key: 'progress' },
  { title: $t('batchTask.action'), key: 'action' }
])

const deleteRun = async (runId: string) => {
  try {
    // eslint-disable-next-line no-console
    console.log('[RunHistoryView] Deleting run:', runId)
    await window.api.batchDeleteRun(runId)
    // eslint-disable-next-line no-console
    console.log('[RunHistoryView] Delete success, reloading runs')
    await loadRuns()
    // eslint-disable-next-line no-console
    console.log('[RunHistoryView] Reload complete, runs count:', runs.value.length)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[RunHistoryView] Failed to delete run:', error)
  }
}

const getStatusColor = (record?: BatchTaskRunWithTaskName) => {
  const status = record?.status
  const completed = record?.completedTerminals || 0
  const failed = record?.failedTerminals || 0

  if (status === 'running') return 'blue'
  if (status === 'cancelled') return 'orange'
  if (status === 'failed') {
    return failed > 0 && completed > 0 ? 'gold' : 'red'
  }
  if (status === 'completed' || status === 'success') {
    return 'green'
  }
  return 'default'
}

const getStatusKey = (record?: BatchTaskRunWithTaskName) => {
  const status = record?.status
  const completed = record?.completedTerminals || 0
  const failed = record?.failedTerminals || 0

  if (status === 'running') return 'batchTask.statusRunning'
  if (status === 'cancelled') return 'batchTask.statusCancelled'
  if (status === 'failed') {
    return failed > 0 && completed > 0 ? 'batchTask.statusPartial' : 'batchTask.statusFailed'
  }
  if (status === 'completed' || status === 'success') return 'batchTask.statusSuccess'
  return 'batchTask.statusPending'
}

const formatTime = (timestamp: number) => {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString()
}

const loadRuns = async () => {
  loading.value = true
  try {
    runs.value = await window.api.batchListRuns()
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load runs:', error)
  } finally {
    loading.value = false
  }
}

const viewRun = (runId: string) => {
  // Wait for runs to be loaded before opening tab
  if (runs.value.length === 0) {
    loadRuns().then(() => {
      openRunTab(runId)
    })
  } else {
    openRunTab(runId)
  }
}

const openRunTab = (runId: string) => {
  const selectedRun = runs.value.find((r) => r.id === runId)
  const taskName = selectedRun?.taskName || $t('batchTask.runDetail')
  const startTime = selectedRun?.startedAt ? formatTime(selectedRun.startedAt) : ''
  const title = startTime ? `${taskName} (${startTime})` : taskName
  eventBus.emit('openUserTab', {
    id: `batch-run-detail-${runId}`,
    title,
    content: 'BatchRunDetail',
    type: 'batch',
    props: { runId }
  })
}

onMounted(() => {
  loadRuns()
})
</script>

<style scoped>
.run-history-view {
  width: 100%;
}

.empty-state {
  padding: 40px;
  text-align: center;
}
</style>
