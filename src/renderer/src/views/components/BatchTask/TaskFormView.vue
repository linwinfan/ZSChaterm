<template>
  <div class="task-form-view">
    <div class="form-header">
      <span class="form-title">{{ taskId ? $t('batchTask.editTask') : $t('batchTask.newTask') }}</span>
    </div>

    <a-form layout="vertical">
      <a-form-item :label="$t('batchTask.taskName')">
        <a-input
          v-model:value="formData.name"
          :placeholder="$t('batchTask.taskNamePlaceholder')"
        />
      </a-form-item>
      <a-form-item :label="$t('batchTask.taskDescription')">
        <a-textarea
          v-model:value="formData.description"
          :placeholder="$t('batchTask.taskDescriptionPlaceholder')"
          :rows="2"
        />
      </a-form-item>
    </a-form>

    <a-steps
      :current="currentStep"
      class="form-steps"
    >
      <a-step :title="$t('batchTask.stepOperations')" />
      <a-step :title="$t('batchTask.stepTrigger')" />
      <a-step :title="$t('batchTask.stepTerminals')" />
      <a-step :title="$t('batchTask.stepConfirm')" />
    </a-steps>

    <div class="form-content">
      <OperationStep
        v-if="currentStep === 0"
        v-model:operations="formDataOperations"
      />
      <TriggerStep
        v-if="currentStep === 1"
        v-model:trigger-type="formDataTriggerType"
        v-model:cron-expression="formDataCronExpression"
        v-model:cron-display="formDataCronDisplay"
        v-model:execution-mode="formDataExecutionMode"
        v-model:max-concurrency="formDataMaxConcurrency"
      />
      <TerminalStep
        v-if="currentStep === 2"
        v-model:terminals="formDataTerminals"
        mode="define"
      />
      <ConfirmStep
        v-if="currentStep === 3"
        :form-data="formData"
        @confirm="handleConfirm"
      />
    </div>

    <div class="form-footer">
      <a-button
        v-if="currentStep > 0"
        @click="currentStep--"
      >
        {{ $t('batchTask.prev') }}
      </a-button>
      <a-button
        v-if="currentStep < 3"
        type="primary"
        @click="currentStep++"
      >
        {{ $t('batchTask.next') }}
      </a-button>
      <a-button
        v-if="currentStep === 3"
        type="primary"
        @click="handleConfirm"
      >
        {{ $t('batchTask.confirm') }}
      </a-button>
      <a-button @click="emit('cancel')">
        {{ $t('batchTask.cancel') }}
      </a-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import TerminalStep from './components/TerminalStep.vue'
import OperationStep from './components/OperationStep.vue'
import TriggerStep from './components/TriggerStep.vue'
import ConfirmStep from './components/ConfirmStep.vue'
import type { BatchTaskConfig } from '../../../../../preload/index.d'

const { t: $t } = useI18n()

const props = defineProps<{
  taskId?: string | null
}>()

const emit = defineEmits<{
  saved: []
  cancel: []
}>()

const currentStep = ref(0)
const formData = ref<BatchTaskConfig>({
  name: '',
  description: '',
  triggerType: 'manual',
  executionMode: 'serial',
  maxConcurrency: 5,
  terminals: [],
  operations: []
})
const formDataTerminals = computed({
  get: () => formData.value.terminals ?? [],
  set: (val) => {
    formData.value.terminals = val
  }
})
const formDataOperations = computed({
  get: () => formData.value.operations ?? [],
  set: (val) => {
    formData.value.operations = val
  }
})
const formDataTriggerType = computed({
  get: () => formData.value.triggerType ?? 'manual',
  set: (val) => {
    formData.value.triggerType = val as 'manual' | 'scheduled'
  }
})
const formDataCronExpression = computed({
  get: () => formData.value.cronExpression ?? '',
  set: (val) => {
    formData.value.cronExpression = val
  }
})
const formDataCronDisplay = computed({
  get: () => formData.value.cronDisplay ?? '',
  set: (val) => {
    formData.value.cronDisplay = val
  }
})
const formDataExecutionMode = computed({
  get: () => formData.value.executionMode ?? 'serial',
  set: (val) => {
    formData.value.executionMode = val as 'serial' | 'parallel' | 'limited'
  }
})
const formDataMaxConcurrency = computed({
  get: () => formData.value.maxConcurrency ?? 5,
  set: (val) => {
    formData.value.maxConcurrency = val
  }
})

const loadTask = async () => {
  if (!props.taskId) return

  try {
    const task = await window.api.batchGetTask(props.taskId)
    if (task) {
      formData.value = {
        name: task.name,
        description: task.description || '',
        triggerType: task.triggerType,
        cronExpression: task.cronExpression,
        cronDisplay: task.cronDisplay,
        executionMode: task.executionMode,
        maxConcurrency: task.maxConcurrency,
        terminals: task.terminals as BatchTaskConfig['terminals'],
        operations: task.operations as BatchTaskConfig['operations']
      }
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load task:', error)
  }
}

const handleConfirm = async () => {
  try {
    // Deep clone to remove Vue reactive properties that cannot be cloned by IPC
    const config = JSON.parse(JSON.stringify(formData.value))
    if (props.taskId) {
      await window.api.batchUpdateTask(props.taskId, config)
    } else {
      await window.api.batchCreateTask(config)
    }
    emit('saved')
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to save task:', error)
  }
}

onMounted(() => {
  if (props.taskId) {
    loadTask()
  }
})
</script>

<style scoped>
.task-form-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.form-header {
  margin-bottom: 16px;
}

.form-title {
  font-size: 16px;
  font-weight: 500;
}

.form-steps {
  margin-bottom: 24px;
}

.form-content {
  flex: 1;
  overflow: auto;
}

.form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid #f0f0f0;
}
</style>
