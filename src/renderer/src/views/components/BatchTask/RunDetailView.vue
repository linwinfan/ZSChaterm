<template>
  <div class="run-detail-view">
    <div class="detail-header">
      <a-space>
        <a-button
          v-if="run?.status === 'running'"
          danger
          @click="cancelRun"
        >
          {{ $t('batchTask.cancelRun') }}
        </a-button>
        <a-button @click="exportReport('json')">
          {{ $t('batchTask.exportJson') }}
        </a-button>
        <a-button @click="exportReport('html')">
          {{ $t('batchTask.exportHtml') }}
        </a-button>
      </a-space>
    </div>

    <a-spin :spinning="loading">
      <div class="run-info">
        <a-descriptions
          :column="2"
          bordered
        >
          <a-descriptions-item :label="$t('batchTask.status')">
            <a-tag :color="getStatusColor(run?.status, isPartialRun(run))">
              {{ getStatusText(run?.status, isPartialRun(run)) }}
            </a-tag>
          </a-descriptions-item>
          <a-descriptions-item :label="$t('batchTask.progress')">
            {{ run?.completedTerminals || 0 }} / {{ run?.totalTerminals || 0 }}
          </a-descriptions-item>
          <a-descriptions-item :label="$t('batchTask.statusSuccess')">
            <a-tag color="green">{{ run?.completedTerminals || 0 }}</a-tag>
          </a-descriptions-item>
          <a-descriptions-item :label="$t('batchTask.statusFailed')">
            <a-tag color="red">{{ run?.failedTerminals || 0 }}</a-tag>
          </a-descriptions-item>
        </a-descriptions>
      </div>

      <a-progress
        v-if="run"
        :percent="getProgressPercent()"
        :status="getProgressStatus()"
      />

      <div class="terminal-results">
        <a-empty
          v-if="!loading && results.length === 0"
          :description="emptyDescription"
        >
          <template #description>
            <div class="empty-description">
              <p>{{ emptyDescription }}</p>
              <p class="empty-hint">{{ $t('batchTask.checkMainLogHint') }}</p>
            </div>
          </template>
        </a-empty>
        <a-table
          v-else
          :columns="columns"
          :data-source="results"
          :pagination="{ pageSize: 10 }"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'status'">
              <a-tag :color="getStatusColor(record.status)">
                {{ getStatusText(record.status) }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'duration'">
              {{ getDuration(record) }}
            </template>
            <template v-else-if="column.key === 'output'">
              <a-tooltip v-if="record.output">
                <template #title>{{ record.output.substring(0, 100) }}...</template>
                <span>{{ record.output.substring(0, 50) }}...</span>
              </a-tooltip>
              <span v-else>-</span>
            </template>
            <template v-else-if="column.key === 'error'">
              <span
                v-if="record.error"
                class="error-text"
                >{{ record.error }}</span
              >
              <span v-else>-</span>
            </template>
            <template v-else-if="column.key === 'aiSummary'">
              <div
                v-if="record.aiSummary"
                class="ai-summary-cell"
                v-html="markdownToHtml(record.aiSummary)"
              ></div>
              <span v-else>-</span>
            </template>
          </template>
        </a-table>
      </div>
    </a-spin>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BatchTaskRun, BatchTerminalResult } from '../../../../../preload/index.d'

const { t: $t } = useI18n()

const props = defineProps<{
  runId: string
}>()

const loading = ref(false)
const run = ref<BatchTaskRun | null>(null)
const results = ref<BatchTerminalResult[]>([])

const columns = computed(() => [
  { title: $t('batchTask.terminal'), key: 'terminalName', dataIndex: 'terminalName' },
  { title: $t('batchTask.status'), key: 'status', dataIndex: 'status' },
  { title: $t('batchTask.duration'), key: 'duration' },
  { title: $t('batchTask.error'), key: 'error', dataIndex: 'error' },
  { title: $t('batchTask.output'), key: 'output' },
  { title: $t('batchTask.aiSummary'), key: 'aiSummary' }
])

const emptyDescription = computed(() => {
  if (run.value?.status === 'failed') {
    return $t('batchTask.noTerminalResultsFailed')
  }
  return $t('batchTask.noTerminalResults')
})

// Simple markdown to HTML converter
function markdownToHtml(markdown: string): string {
  if (!markdown) return ''

  let html = markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>')

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Lists
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>)(?!\n<li>)/g, '<ul>$1</ul>')
  html = html.replace(/<\/ul>\n<ul>/g, '\n')

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>')
  html = html.replace(/\n/g, '<br>')

  if (!html.startsWith('<')) {
    html = '<p>' + html + '</p>'
  }

  return html
}

const loadRun = async () => {
  loading.value = true
  try {
    // eslint-disable-next-line no-console
    console.log('[RunDetailView] loadRun called with runId:', props.runId)
    run.value = await window.api.batchGetRun(props.runId)
    results.value = await window.api.batchGetRunResults(props.runId)
    // eslint-disable-next-line no-console
    console.log('[RunDetailView] Loaded run:', run.value)
    // eslint-disable-next-line no-console
    console.log('[RunDetailView] Loaded results:', results.value)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load run:', error)
  } finally {
    loading.value = false
  }
}

const cancelRun = async () => {
  try {
    await window.api.batchCancelRun(props.runId)
    await loadRun()
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to cancel run:', error)
  }
}

const exportReport = async (format: 'json' | 'html') => {
  try {
    const path = await window.api.batchExportReport(props.runId, format)
    // eslint-disable-next-line no-console
    console.log('Report exported to:', path)
    if (path) {
      const result = await window.api.openPath(path)
      if (!result.success && result.error) {
        // eslint-disable-next-line no-console
        console.error('Failed to open report:', result.error)
      }
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to export report:', error)
  }
}

const isPartialRun = (run?: BatchTaskRun | null) => run?.status === 'failed' && (run.completedTerminals || 0) > 0 && (run.failedTerminals || 0) > 0

const getStatusColor = (status?: string, partial: boolean = false) => {
  if (status === 'running') return 'blue'
  if (status === 'cancelled') return 'orange'
  if (status === 'failed') return partial ? 'gold' : 'red'
  if (status === 'completed' || status === 'success') return 'green'
  return 'default'
}

const getStatusText = (status?: string, partial: boolean = false) => {
  if (status === 'running') return $t('batchTask.statusRunning')
  if (status === 'cancelled') return $t('batchTask.statusCancelled')
  if (status === 'failed') return partial ? $t('batchTask.statusPartial') : $t('batchTask.statusFailed')
  if (status === 'completed' || status === 'success') return $t('batchTask.statusSuccess')
  return $t('batchTask.statusPending')
}

const getProgressPercent = () => {
  if (!run.value || run.value.totalTerminals === 0) return 0
  return Math.round(((run.value.completedTerminals + run.value.failedTerminals) / run.value.totalTerminals) * 100)
}

const getProgressStatus = () => {
  if (!run.value) return 'normal'
  if (run.value.failedTerminals > 0) return 'exception'
  if (run.value.status === 'completed') return 'success'
  return 'normal'
}

const getDuration = (result: BatchTerminalResult) => {
  if (!result.startedAt || !result.finishedAt) return '-'
  return `${result.finishedAt - result.startedAt}ms`
}

let pollInterval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  loadRun()
  // Poll for updates if run is still in progress
  pollInterval = setInterval(() => {
    if (run.value?.status === 'running') {
      loadRun()
    }
  }, 2000)
})

onUnmounted(() => {
  if (pollInterval) {
    clearInterval(pollInterval)
  }
})
</script>

<style scoped>
.run-detail-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.run-info {
  margin-bottom: 16px;
}

.terminal-results {
  margin-top: 16px;
}

.error-text {
  color: #ff4d4f;
  font-family: monospace;
  font-size: 12px;
  word-break: break-all;
}

.empty-description {
  text-align: center;
}

.empty-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-color-tertiary);
}

:deep(.ai-summary-cell) {
  background: #e6f7ff;
  padding: 8px;
  border-radius: 4px;
  border-left: 3px solid #1890ff;
  max-height: 150px;
  overflow-y: auto;
}

:deep(.ai-summary-cell h2),
:deep(.ai-summary-cell h3),
:deep(.ai-summary-cell h4) {
  margin: 0 0 6px 0;
  color: #333;
}

:deep(.ai-summary-cell p) {
  margin: 4px 0;
}

:deep(.ai-summary-cell ul),
:deep(.ai-summary-cell ol) {
  margin: 4px 0;
  padding-left: 18px;
}

:deep(.ai-summary-cell li) {
  margin: 2px 0;
}

:deep(.ai-summary-cell code) {
  background: #f0f0f0;
  padding: 1px 4px;
  border-radius: 3px;
}

:deep(.ai-summary-cell pre) {
  background: #f0f0f0;
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
}
</style>
