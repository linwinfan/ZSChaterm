<template>
  <div class="execute-confirm-view">
    <div class="form-header">
      <span class="form-title">{{ $t('batchTask.runTask') }}: {{ task?.name || '…' }}</span>
    </div>

    <a-spin :spinning="loading">
      <p class="hint">{{ $t('batchTask.runConfirmHint') }}</p>
      <TerminalStep
        v-model:terminals="formDataTerminals"
        :pre-populated-names="prePopulatedNames"
        mode="run"
      />
    </a-spin>

    <div class="form-footer">
      <a-button @click="handleCancel">{{ $t('batchTask.cancel') }}</a-button>
      <a-button
        type="primary"
        :loading="executing"
        :disabled="!canExecute"
        @click="handleConfirm"
      >
        {{ $t('batchTask.confirmExecute') }}
      </a-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from 'ant-design-vue'
import eventBus from '@/utils/eventBus'
import TerminalStep from './components/TerminalStep.vue'
import type { BatchTask, BatchTaskConfig } from '../../../../../preload/index.d'

const { t: $t } = useI18n()

const props = defineProps<{
  taskId: string
}>()

const emit = defineEmits<{
  cancel: []
  executed: [runId: string]
}>()

const loading = ref(false)
const executing = ref(false)
const task = ref<BatchTask | null>(null)
const formData = ref<BatchTaskConfig>({
  name: '',
  terminals: [],
  operations: []
})

// `formData.terminals` is optional in the BatchTaskConfig type but
// TerminalStep requires a non-undefined array. Bridge it via a computed
// so v-model stays two-way.
const formDataTerminals = computed({
  get: () => formData.value.terminals ?? [],
  set: (val) => {
    formData.value.terminals = val
  }
})

// id -> "title (ip)" or "title". Derived from each saved selector's
// `terminals` metadata so the table renders friendly names instead of
// raw connectionIds. Re-derived from the latest formData after the user
// edits the list, so newly added terminals get cached correctly.
const prePopulatedNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const t of formData.value.terminals ?? []) {
    if (t.selectorType !== 'active' && t.selectorType !== 'asset') continue
    try {
      const sel = JSON.parse(t.selector)
      const list: Array<{ id: string; title: string; ip?: string }> = sel.terminals || []
      for (const meta of list) {
        const label = meta.ip ? `${meta.title} (${meta.ip})` : meta.title
        map[meta.id] = label
      }
    } catch {
      // Selector JSON malformed; nothing to seed.
    }
  }
  return map
})

const canExecute = computed(() => (formData.value.terminals?.length ?? 0) > 0)

const loadTask = async () => {
  loading.value = true
  try {
    const loaded = await window.api.batchGetTask(props.taskId)
    if (!loaded) {
      message.error($t('batchTask.taskNotFound'))
      emit('cancel')
      return
    }
    task.value = loaded
    formData.value.terminals = (loaded.terminals as unknown as BatchTaskConfig['terminals']) || []
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load task:', error)
    message.error($t('batchTask.executeFailed'))
  } finally {
    loading.value = false
  }
}

const closeSelf = () => {
  // TabsPanel registered the panel as 'panel_<taskId>'. We can't read the
  // closeCurrentPanel closure directly from here, so we just notify the
  // parent and let it close.
  emit('cancel')
}

const navigateToRun = (runId: string) => {
  // Open the run detail tab (same pattern as RunHistoryView.openRunTab).
  eventBus.emit('openUserTab', {
    id: `batch-run-detail-${runId}`,
    title: $t('batchTask.runDetail'),
    content: 'BatchRunDetail',
    type: 'batch',
    props: { runId }
  })
}

const handleCancel = () => {
  closeSelf()
}

const handleConfirm = async () => {
  if (!canExecute.value) {
    message.warning($t('batchTask.noTerminalsForRun'))
    return
  }
  executing.value = true
  try {
    // JSON round-trip strips Vue reactivity proxies that the IPC bridge
    // can't serialise.
    const config = JSON.parse(JSON.stringify(formData.value))
    const run = await window.api.batchExecuteTask(props.taskId, config.terminals)
    emit('executed', run.id)
    // Navigate to the freshly created run; the parent will close this tab.
    navigateToRun(run.id)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to execute task:', error)
    message.error($t('batchTask.executeFailed'))
  } finally {
    executing.value = false
  }
}

onMounted(() => {
  loadTask()
})
</script>

<style scoped>
.execute-confirm-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
}

.form-header {
  margin-bottom: 12px;
}

.form-title {
  font-size: 16px;
  font-weight: 500;
}

.hint {
  color: var(--text-color-secondary);
  font-size: 13px;
  margin-bottom: 12px;
}

.form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--f0-f0-f0, #f0f0f0);
  margin-top: 12px;
}
</style>
