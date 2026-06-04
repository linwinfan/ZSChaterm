<template>
  <div class="operation-step">
    <a-form layout="vertical">
      <a-form-item :label="$t('batchTask.selectOperations')">
        <a-select
          v-model:value="operationType"
          style="width: 200px"
        >
          <a-select-option value="script">{{ $t('batchTask.operationScript') }}</a-select-option>
          <a-select-option value="skill">{{ $t('batchTask.operationSkill') }}</a-select-option>
          <a-select-option value="kb_script">{{ $t('batchTask.operationKbScript') }}</a-select-option>
        </a-select>
      </a-form-item>

      <a-form-item
        v-if="operationType === 'script'"
        :label="$t('batchTask.scriptContent')"
      >
        <a-textarea
          v-model:value="scriptContent"
          :rows="6"
          placeholder="echo 'Hello World'"
        />
      </a-form-item>

      <template v-if="operationType === 'skill'">
        <a-form-item :label="$t('batchTask.operationSkill')">
          <a-select
            v-model:value="selectedSkillId"
            :placeholder="$t('batchTask.operationSkillPlaceholder')"
            style="width: 300px"
            show-search
            :filter-option="filterSkill"
          >
            <a-select-option
              v-for="skill in skills"
              :key="skill.name"
              :value="skill.name"
              :label="skillSearchLabel(skill)"
            >
              {{ skill.name }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item :label="$t('batchTask.operationInstruction')">
          <a-textarea
            v-model:value="skillInstruction"
            :rows="3"
            :placeholder="$t('batchTask.operationInstructionPlaceholder')"
          />
        </a-form-item>
      </template>

      <template v-if="operationType === 'kb_script'">
        <a-form-item :label="$t('batchTask.operationKbScript')">
          <a-input
            v-model:value="kbPath"
            :placeholder="$t('batchTask.kbPathPlaceholder')"
            readonly
            @click="openKbPicker"
          >
            <template #suffix>
              <FolderOpenOutlined
                v-if="!kbPath"
                style="cursor: pointer; color: #1890ff"
                @click.stop="openKbPicker"
              />
              <CloseOutlined
                v-else
                style="cursor: pointer; color: #999"
                @click.stop="kbPath = ''"
              />
            </template>
          </a-input>
        </a-form-item>
        <a-form-item :label="$t('batchTask.operationInstruction')">
          <a-textarea
            v-model:value="kbInstruction"
            :rows="3"
            :placeholder="$t('batchTask.operationInstructionPlaceholder')"
          />
        </a-form-item>
      </template>

      <a-button
        type="primary"
        :disabled="!canAdd"
        @click="addOperation"
      >
        {{ $t('batchTask.addOperation') }}
      </a-button>

      <div
        v-if="operations.length > 0"
        class="operation-list"
      >
        <a-table
          :columns="columns"
          :data-source="operations"
          :pagination="false"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'operationType'">
              {{ getTypeLabel(record.operationType) }}
            </template>
            <template v-else-if="column.key === 'operationConfig'">
              <div class="config-cell">
                <div class="config-target">{{ formatConfigTarget(record) }}</div>
                <div
                  v-if="getConfigInstruction(record)"
                  class="config-instruction"
                >
                  {{ getConfigInstruction(record) }}
                </div>
              </div>
            </template>
            <template v-else-if="column.key === 'action'">
              <a-button
                type="link"
                danger
                @click="removeOperation(record.id)"
              >
                {{ $t('batchTask.remove') }}
              </a-button>
            </template>
          </template>
        </a-table>
      </div>
    </a-form>

    <a-modal
      v-model:open="kbPickerOpen"
      :title="$t('batchTask.kbPickerTitle')"
      :width="520"
      :footer="null"
      :destroy-on-close="true"
    >
      <a-spin :spinning="kbPickerLoading">
        <a-tree
          v-if="kbTreeData.length > 0"
          :tree-data="kbTreeData"
          :load-data="onLoadKbNode"
          @select="onKbSelect"
        />
        <a-empty
          v-else-if="!kbPickerLoading"
          :description="$t('batchTask.kbEmpty')"
        />
      </a-spin>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { v4 as uuidv4 } from 'uuid'
import { FolderOpenOutlined, CloseOutlined } from '@ant-design/icons-vue'

const { t: $t } = useI18n()

interface SkillInfo {
  name: string
  description?: string
  enabled?: boolean
  path?: string
}

interface Operation {
  id?: string
  operationType: string
  operationConfig: string
  executionOrder: number
}

interface KbTreeNode {
  key: string
  title: string
  isLeaf: boolean
  children?: KbTreeNode[]
}

const props = defineProps<{
  operations: Operation[]
}>()

const emit = defineEmits<{
  'update:operations': [operations: Operation[]]
}>()

const operationType = ref('script')
const scriptContent = ref('')
const selectedSkillId = ref('')
const skillInstruction = ref('')
const kbPath = ref('')
const kbInstruction = ref('')
const skills = ref<SkillInfo[]>([])

// KB picker state
const kbPickerOpen = ref(false)
const kbPickerLoading = ref(false)
const kbTreeData = ref<KbTreeNode[]>([])

const columns = computed(() => [
  { title: $t('batchTask.columnOrder'), key: 'executionOrder', dataIndex: 'executionOrder', width: 80 },
  { title: $t('batchTask.columnType'), key: 'operationType', dataIndex: 'operationType', width: 120 },
  { title: $t('batchTask.columnConfig'), key: 'operationConfig', dataIndex: 'operationConfig' },
  { title: $t('batchTask.columnAction'), key: 'action', width: 100 }
])

const operations = computed({
  get: () => props.operations,
  set: (val) => emit('update:operations', val)
})

// Gate the Add button so we never persist { "skillId": null } / empty
// script / empty kbPath / empty instruction.
const canAdd = computed(() => {
  if (operationType.value === 'script') return scriptContent.value.trim().length > 0
  if (operationType.value === 'skill') return selectedSkillId.value.trim().length > 0 && skillInstruction.value.trim().length > 0
  if (operationType.value === 'kb_script') return kbPath.value.trim().length > 0 && kbInstruction.value.trim().length > 0
  return false
})

// ant-design-vue passes the option's `label` prop to the filter function —
// we stitch name + description into one searchable string so the user can
// filter by either. Using `option.children` would be wrong: that's the
// VNode array, not a string.
const skillSearchLabel = (skill: SkillInfo): string => {
  return [skill.name, skill.description || ''].filter(Boolean).join(' ').toLowerCase()
}

const filterSkill = (input: string, option: any): boolean => {
  const haystack = (option?.label ?? '').toString().toLowerCase()
  return haystack.includes(input.toLowerCase())
}

const loadSkills = async () => {
  try {
    const list = (await window.api.getSkills()) as SkillInfo[]
    skills.value = list || []
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load skills:', error)
  }
}

const addOperation = () => {
  if (!canAdd.value) return

  let operationConfig = ''
  if (operationType.value === 'script') {
    operationConfig = JSON.stringify({ scriptContent: scriptContent.value })
  } else if (operationType.value === 'skill') {
    operationConfig = JSON.stringify({ skillId: selectedSkillId.value, instruction: skillInstruction.value })
  } else if (operationType.value === 'kb_script') {
    operationConfig = JSON.stringify({ kbPath: kbPath.value, instruction: kbInstruction.value })
  }

  const newOperations: Operation[] = [
    ...operations.value,
    {
      id: uuidv4(),
      operationType: operationType.value,
      operationConfig,
      executionOrder: operations.value.length
    }
  ]
  emit('update:operations', newOperations)

  // Reset inputs
  scriptContent.value = ''
  selectedSkillId.value = ''
  skillInstruction.value = ''
  kbPath.value = ''
  kbInstruction.value = ''
}

const removeOperation = (id: string) => {
  emit(
    'update:operations',
    operations.value.filter((op) => op.id !== id).map((op, idx) => ({ ...op, executionOrder: idx }))
  )
}

const getTypeLabel = (type: string): string => {
  if (type === 'script') return $t('batchTask.operationScript')
  if (type === 'skill') return $t('batchTask.operationSkill')
  if (type === 'kb_script') return $t('batchTask.operationKbScript')
  return type
}

const formatConfigTarget = (record: Operation): string => {
  try {
    const cfg = JSON.parse(record.operationConfig) as Record<string, string>
    if (record.operationType === 'script') {
      return cfg.scriptContent || ''
    }
    if (record.operationType === 'skill') {
      const skill = skills.value.find((s) => s.name === cfg.skillId)
      return skill ? `${skill.name}  (${cfg.skillId})` : cfg.skillId || ''
    }
    if (record.operationType === 'kb_script') {
      const fileName = (cfg.kbPath || '').split('/').pop() || cfg.kbPath
      return cfg.kbPath ? `${fileName}  (${cfg.kbPath})` : ''
    }
  } catch {
    // fall through
  }
  return record.operationConfig
}

const getConfigInstruction = (record: Operation): string => {
  try {
    const cfg = JSON.parse(record.operationConfig) as Record<string, string>
    return cfg.instruction || ''
  } catch {
    return ''
  }
}

// --- KB picker ---

const openKbPicker = async () => {
  kbPickerOpen.value = true
  await loadKbRoot()
}

const loadKbRoot = async () => {
  kbPickerLoading.value = true
  try {
    const list = await window.api.kbListDir('')
    kbTreeData.value = list
      .filter((n) => n.type === 'file' || n.type === 'dir')
      .map((n) => ({
        key: n.relPath,
        title: n.name,
        isLeaf: n.type === 'file'
      }))
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to list KB root:', error)
    kbTreeData.value = []
  } finally {
    kbPickerLoading.value = false
  }
}

const findNode = (nodes: KbTreeNode[], key: string): KbTreeNode | undefined => {
  for (const n of nodes) {
    if (n.key === key) return n
    if (n.children) {
      const found = findNode(n.children, key)
      if (found) return found
    }
  }
  return undefined
}

const onLoadKbNode = async (treeNode: any): Promise<void> => {
  const key: string = treeNode.key
  const node = findNode(kbTreeData.value, key)
  if (!node || node.children || node.isLeaf) return

  try {
    const list = await window.api.kbListDir(key)
    node.children = list
      .filter((n) => n.type === 'file' || n.type === 'dir')
      .map((n) => ({
        key: n.relPath,
        title: n.name,
        isLeaf: n.type === 'file'
      }))
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to list KB subdir:', error)
    node.children = []
  }
}

const onKbSelect = (selectedKeys: string[], _info: any) => {
  const key = selectedKeys[0]
  if (!key) return
  // Only files are valid script sources.
  const node = findNode(kbTreeData.value, key)
  if (!node || !node.isLeaf) return
  kbPath.value = key
  kbPickerOpen.value = false
}

onMounted(() => {
  loadSkills()
})
</script>

<style scoped>
.operation-step {
  padding: 16px;
}

.operation-list {
  margin-top: 16px;
}

.config-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.config-target {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: var(--text-color);
}

.config-instruction {
  font-size: 12px;
  color: var(--text-color-secondary);
  font-style: italic;
  white-space: pre-wrap;
}
</style>
