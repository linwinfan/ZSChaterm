<template>
  <div class="trigger-step">
    <a-form layout="vertical">
      <a-form-item :label="$t('batchTask.triggerType')">
        <a-radio-group v-model:value="triggerType">
          <a-radio value="manual">{{ $t('batchTask.triggerManual') }}</a-radio>
          <a-radio value="scheduled">{{ $t('batchTask.triggerScheduled') }}</a-radio>
        </a-radio-group>
      </a-form-item>

      <a-form-item :label="$t('batchTask.executionMode')">
        <a-select
          v-model:value="executionMode"
          style="width: 200px"
        >
          <a-select-option value="serial">{{ $t('batchTask.executionSerial') }}</a-select-option>
          <a-select-option value="parallel">{{ $t('batchTask.executionParallel') }}</a-select-option>
          <a-select-option value="limited">{{ $t('batchTask.executionLimited') }}</a-select-option>
        </a-select>
      </a-form-item>

      <a-form-item
        v-if="executionMode === 'limited'"
        :label="$t('batchTask.maxConcurrency')"
      >
        <a-input-number
          v-model:value="maxConcurrency"
          :min="1"
          :max="100"
          style="width: 200px"
        />
      </a-form-item>

      <a-form-item
        v-if="triggerType === 'scheduled'"
        :label="$t('batchTask.cronExpression')"
      >
        <a-input
          v-model:value="cronExpression"
          placeholder="* * * * *"
          style="width: 300px"
        />
      </a-form-item>

      <a-form-item
        v-if="triggerType === 'scheduled'"
        :label="$t('batchTask.cronDisplay')"
      >
        <a-input
          v-model:value="cronDisplay"
          placeholder="Daily at 2am"
          style="width: 300px"
        />
      </a-form-item>
    </a-form>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  triggerType: string
  cronExpression?: string
  cronDisplay?: string
  executionMode: string
  maxConcurrency: number
}>()

const emit = defineEmits<{
  'update:triggerType': [value: string]
  'update:cronExpression': [value: string]
  'update:cronDisplay': [value: string]
  'update:executionMode': [value: string]
  'update:maxConcurrency': [value: number]
}>()

const triggerType = computed({
  get: () => props.triggerType,
  set: (val) => emit('update:triggerType', val)
})

const cronExpression = computed({
  get: () => props.cronExpression || '',
  set: (val) => emit('update:cronExpression', val)
})

const cronDisplay = computed({
  get: () => props.cronDisplay || '',
  set: (val) => emit('update:cronDisplay', val)
})

const executionMode = computed({
  get: () => props.executionMode,
  set: (val) => emit('update:executionMode', val)
})

const maxConcurrency = computed({
  get: () => props.maxConcurrency,
  set: (val) => emit('update:maxConcurrency', val)
})
</script>

<style scoped>
.trigger-step {
  padding: 16px;
}
</style>
