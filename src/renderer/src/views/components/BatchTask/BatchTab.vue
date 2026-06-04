<template>
  <div class="batch-launcher">
    <div class="launcher-header">
      <span class="launcher-title">{{ $t('batchTask.title') }}</span>
    </div>

    <div class="launcher-buttons">
      <div
        class="launcher-item"
        @click="openCreateTask"
      >
        <PlusOutlined class="launcher-icon" />
        <div class="launcher-content">
          <span class="launcher-label">{{ $t('batchTask.createTask') }}</span>
          <span class="launcher-desc">{{ $t('batchTask.createTaskDesc') }}</span>
        </div>
      </div>
      <div
        class="launcher-item"
        @click="openTaskList"
      >
        <FileTextOutlined class="launcher-icon" />
        <div class="launcher-content">
          <span class="launcher-label">{{ $t('batchTask.taskList') }}</span>
          <span class="launcher-desc">{{ $t('batchTask.taskListDesc') }}</span>
        </div>
      </div>
      <div
        class="launcher-item"
        @click="openRunHistory"
      >
        <HistoryOutlined class="launcher-icon" />
        <div class="launcher-content">
          <span class="launcher-label">{{ $t('batchTask.runHistory') }}</span>
          <span class="launcher-desc">{{ $t('batchTask.runHistoryDesc') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import eventBus from '@/utils/eventBus'
import { FileTextOutlined, HistoryOutlined, PlusOutlined } from '@ant-design/icons-vue'

const { t: $t } = useI18n()

const openTaskList = () => {
  eventBus.emit('openUserTab', {
    id: 'batch-task-list',
    title: $t('batchTask.taskList'),
    content: 'BatchTaskList',
    type: 'batch'
  })
}

const openRunHistory = () => {
  eventBus.emit('openUserTab', {
    id: 'batch-run-history',
    title: $t('batchTask.runHistory'),
    content: 'BatchRunHistory',
    type: 'batch'
  })
}

const openCreateTask = () => {
  eventBus.emit('openUserTab', {
    id: 'batch-create-task',
    title: $t('batchTask.createTask'),
    content: 'BatchTaskForm',
    type: 'batch',
    props: { isNew: true }
  })
}
</script>

<style scoped>
.batch-launcher {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 24px 16px;
}

.launcher-header {
  margin-bottom: 24px;
}

.launcher-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-color);
}

.launcher-buttons {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.launcher-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  background-color: var(--bg-color-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.launcher-item:hover {
  border-color: #1890ff;
  background-color: rgba(24, 144, 255, 0.05);
}

.launcher-icon {
  font-size: 20px;
  color: var(--text-color-secondary);
  flex-shrink: 0;
  margin-top: 2px;
}

.launcher-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.launcher-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-color);
}

.launcher-desc {
  font-size: 12px;
  color: var(--text-color-tertiary);
}
</style>
