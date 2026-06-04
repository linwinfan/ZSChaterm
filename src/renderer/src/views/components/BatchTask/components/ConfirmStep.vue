<template>
  <div class="confirm-step">
    <a-descriptions
      :title="$t('batchTask.taskSummary')"
      :column="1"
      bordered
    >
      <a-descriptions-item :label="$t('batchTask.taskName')">
        {{ formData.name }}
      </a-descriptions-item>
      <a-descriptions-item :label="$t('batchTask.taskDescription')">
        {{ formData.description || '-' }}
      </a-descriptions-item>
      <a-descriptions-item :label="$t('batchTask.triggerType')">
        {{ formData.triggerType === 'manual' ? $t('batchTask.triggerManual') : $t('batchTask.triggerScheduled') }}
      </a-descriptions-item>
      <a-descriptions-item
        v-if="formData.triggerType === 'scheduled'"
        :label="$t('batchTask.cronDisplay')"
      >
        {{ formData.cronDisplay || formData.cronExpression }}
      </a-descriptions-item>
      <a-descriptions-item :label="$t('batchTask.executionMode')">
        {{ getExecutionModeText(formData.executionMode || 'serial') }}
      </a-descriptions-item>
      <a-descriptions-item
        v-if="formData.executionMode === 'limited'"
        :label="$t('batchTask.maxConcurrency')"
      >
        {{ formData.maxConcurrency }}
      </a-descriptions-item>
      <a-descriptions-item :label="$t('batchTask.selectTerminals')">
        {{ formData.terminals?.length || 0 }}
      </a-descriptions-item>
      <a-descriptions-item :label="$t('batchTask.selectOperations')">
        {{ formData.operations?.length || 0 }}
      </a-descriptions-item>
    </a-descriptions>
  </div>
</template>

<script setup lang="ts">
import type { BatchTaskConfig } from '../../../../../../preload/index.d'

const props = defineProps<{
  formData: BatchTaskConfig
}>()

const emit = defineEmits<{
  confirm: []
}>()

const getExecutionModeText = (mode: string) => {
  const modeMap: Record<string, string> = {
    serial: 'batchTask.executionSerial',
    parallel: 'batchTask.executionParallel',
    limited: 'batchTask.executionLimited'
  }
  return modeMap[mode] || mode
}
</script>

<style scoped>
.confirm-step {
  padding: 16px;
}
</style>
