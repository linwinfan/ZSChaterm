<template>
  <div class="task-list-view">
    <a-table
      :columns="columns"
      :data-source="tasks"
      :loading="loading"
      row-key="id"
      :pagination="{ pageSize: 10 }"
      @row-click="onRowClick"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <a @click.stop="emit('select', record.id)">{{ record.name }}</a>
        </template>
        <template v-else-if="column.key === 'triggerType'">
          {{ record.triggerType === 'manual' ? $t('batchTask.triggerManual') : $t('batchTask.triggerScheduled') }}
        </template>
        <template v-else-if="column.key === 'executionMode'">
          {{ getExecutionModeText(record.executionMode) }}
        </template>
        <template v-else-if="column.key === 'action'">
          <a-space>
            <a-button
              size="small"
              type="primary"
              @click.stop="runTask(record)"
            >
              {{ $t('batchTask.runNow') }}
            </a-button>
            <a-button
              size="small"
              @click.stop="emit('select', record.id)"
            >
              {{ $t('batchTask.editTask') }}
            </a-button>
            <a-popconfirm
              :title="$t('batchTask.deleteConfirm')"
              @confirm.stop="emit('delete', record.id)"
            >
              <a-button
                size="small"
                danger
              >
                {{ $t('batchTask.deleteTask') }}
              </a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </template>
    </a-table>

    <div
      v-if="!loading && tasks.length === 0"
      class="empty-state"
    >
      <a-empty :description="$t('batchTask.noTasks')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BatchTask } from '../../../../../preload/index.d'

const { t: $t } = useI18n()

const emit = defineEmits<{
  select: [taskId: string]
  // The current payload is the task id, not a run id. The parent opens the
  // ExecuteConfirmView; the actual batch:execute-task IPC is fired from
  // there once the user confirms.
  run: [taskId: string]
  delete: [taskId: string]
}>()

const tasks = ref<BatchTask[]>([])
const loading = ref(false)

const columns = computed(() => [
  { title: $t('batchTask.taskName'), key: 'name', dataIndex: 'name' },
  { title: $t('batchTask.triggerType'), key: 'triggerType', dataIndex: 'triggerType' },
  { title: $t('batchTask.executionMode'), key: 'executionMode', dataIndex: 'executionMode' },
  { title: $t('batchTask.action'), key: 'action', width: 300 }
])

const loadTasks = async () => {
  loading.value = true
  try {
    tasks.value = await window.api.batchListTasks()
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load tasks:', error)
  } finally {
    loading.value = false
  }
}

const getExecutionModeText = (mode: string) => {
  const modeMap: Record<string, string> = {
    serial: 'batchTask.executionSerial',
    parallel: 'batchTask.executionParallel',
    limited: 'batchTask.executionLimited'
  }
  return $t(modeMap[mode] || mode)
}

const onRowClick = (record: BatchTask) => {
  emit('select', record.id)
}

const runTask = async (task: BatchTask) => {
  // The parent (tabsPanel) opens the ExecuteConfirmView; the actual
  // `batchExecuteTask` IPC call is fired from there once the user has
  // reviewed/edited the terminal selection and clicked confirm.
  emit('run', task.id)
}

onMounted(() => {
  loadTasks()
})
</script>

<style scoped>
.task-list-view {
  width: 100%;
}

.empty-state {
  padding: 40px;
  text-align: center;
}
</style>
