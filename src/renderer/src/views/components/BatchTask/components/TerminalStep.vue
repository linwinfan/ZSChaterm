<template>
  <div class="terminal-step">
    <a-form layout="vertical">
      <a-form-item :label="$t('batchTask.selectTerminals')">
        <a-select
          v-model:value="selectorType"
          style="width: 200px"
        >
          <!-- "active" is only meaningful at run time: connected sessions come
               and go, so locking them in at task-definition time would be a
               stale snapshot. Hide the option entirely in `define` mode. -->
          <a-select-option
            v-if="mode === 'run'"
            value="active"
            :disabled="!hasActiveTerminals"
          >
            {{ $t('batchTask.terminalsActive') }}
          </a-select-option>
          <a-select-option value="asset">{{ $t('batchTask.terminalsAsset') }}</a-select-option>
          <a-select-option value="template">{{ $t('batchTask.terminalsTemplate') }}</a-select-option>
        </a-select>
      </a-form-item>

      <a-alert
        v-if="mode === 'define'"
        class="active-restriction-hint"
        type="info"
        show-icon
        :message="$t('batchTask.activeRestrictionHint')"
      />

      <a-form-item
        v-if="selectorType === 'active'"
        :label="$t('batchTask.selectTerminalsPlaceholder')"
      >
        <a-empty
          v-if="!hasActiveTerminals"
          :description="$t('batchTask.openTerminalFirst')"
        />
        <a-checkbox-group
          v-else
          v-model:value="selectedIds"
          :options="activeTerminalOptions"
        />
      </a-form-item>

      <a-form-item
        v-if="selectorType === 'asset'"
        :label="$t('batchTask.selectAsset')"
      >
        <div class="asset-selector">
          <a-select
            v-model:value="selectedAssetId"
            show-search
            placeholder="Select an asset"
            style="width: 300px"
            :loading="assetLoading"
            :filter-option="false"
            @search="handleAssetSearch"
            @focus="loadAssets('')"
          >
            <a-select-option
              v-for="asset in assetList"
              :key="asset.uuid"
              :value="asset.uuid"
            >
              {{ getAssetDisplayName(asset) }}
            </a-select-option>
          </a-select>
          <a-input
            v-model:value="assetIds"
            placeholder="Or enter asset ID directly (UUID or IP)"
            style="width: 300px; margin-left: 8px"
          />
        </div>
      </a-form-item>

      <a-form-item
        v-if="selectorType === 'template'"
        :label="$t('batchTask.terminalsTemplate')"
      >
        <a-input
          v-model:value="templateExpr"
          placeholder="${env}"
        />
      </a-form-item>

      <a-button
        type="primary"
        @click="addTerminal"
      >
        {{ $t('batchTask.addTerminal') }}
      </a-button>

      <div
        v-if="terminals.length > 0"
        class="terminal-list"
      >
        <a-table
          :columns="columns"
          :data-source="terminals"
          :pagination="false"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'type'">
              {{ selectorTypeLabel(record.selectorType) }}
            </template>
            <template v-if="column.key === 'selector'">
              <span
                v-if="record.selectorType === 'asset' || record.selectorType === 'active'"
                class="selector-display"
              >
                {{ formatNamedSelector(record) }}
              </span>
              <span v-else>{{ record.selector }}</span>
            </template>
            <template v-if="column.key === 'action'">
              <a-button
                type="link"
                danger
                @click="removeTerminal(record.id)"
              >
                {{ $t('batchTask.remove') }}
              </a-button>
            </template>
          </template>
        </a-table>
      </div>
    </a-form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from 'ant-design-vue'
import { v4 as uuidv4 } from 'uuid'
import { connectedTerminals as sharedConnectedTerminals } from '@utils/terminalState'
import { createRendererLogger } from '@/utils/logger'

const logger = createRendererLogger('batch.TerminalStep')

interface AssetNode {
  key: string
  label: string
  title?: string
  uuid: string
  type: string
  selectable: boolean
  children?: AssetNode[]
}

const props = withDefaults(
  defineProps<{
    terminals: Array<{ selectorType: string; selector: string }>
    // Pre-populated friendly-name cache. Used by the ExecuteConfirmView to
    // render the existing saved selectors' display names without requiring the
    // user to re-select terminals. Merged into the local cache on mount and
    // whenever the prop changes (e.g. when the parent re-derives names).
    prePopulatedNames?: Record<string, string>
    // `define` (default): editing/creating a task; hide the "active" option
    // since live sessions are too volatile to bake into a saved task.
    // `run`: the execute-confirm view; show all options so the user can
    // pick whichever currently-connected sessions they want.
    mode?: 'define' | 'run'
  }>(),
  { mode: 'define' }
)

const emit = defineEmits<{
  'update:terminals': [terminals: Array<{ selectorType: string; selector: string }>]
}>()

const { t: $t } = useI18n()

const selectorType = ref('active')
const selectedIds = ref<string[]>([])
const assetIds = ref('')
const templateExpr = ref('')

const assetList = ref<AssetNode[]>([])
const assetLoading = ref(false)
const selectedAssetId = ref<string | null>(null)
const bastionAssetIds = ref<Set<string>>(new Set())

const connectedTerminals = sharedConnectedTerminals

const activeTerminalOptions = computed(() =>
  connectedTerminals.value.map((t) => ({
    label: t.ip ? `${t.title} (${t.ip})` : t.title,
    value: t.id
  }))
)

const hasActiveTerminals = computed(() => connectedTerminals.value.length > 0)

const columns = computed(() => [
  { title: $t('batchTask.columnType'), key: 'type', dataIndex: 'selectorType' },
  { title: $t('batchTask.columnAsset'), key: 'selector', dataIndex: 'selector' },
  { title: $t('batchTask.action'), key: 'action' }
])

const terminals = computed({
  get: () => props.terminals,
  set: (val) => emit('update:terminals', val)
})

// Flatten tree structure for select options
const flattenAssets = (nodes: AssetNode[]): AssetNode[] => {
  const result: AssetNode[] = []
  for (const node of nodes) {
    if (node.selectable && node.uuid) {
      result.push(node)
    }
    if (node.children) {
      result.push(...flattenAssets(node.children))
    }
  }
  return result
}

// Flatten from different API response structure
// Returns selectable personal assets and the set of bastion-child asset identifiers
// (uuid or host) so we can also block manual input that targets bastion children.
// Bastion-child assets need a second login and cannot be executed in batch.
const flattenAssetsFromResponse = (response: any): { personal: AssetNode[]; bastionIds: Set<string> } => {
  const personal: AssetNode[] = []
  const bastionIds = new Set<string>()
  if (!response) return { personal, bastionIds }

  const data = response.data || response
  const personalNodes = data.personal || []
  const jumpservers = data.jumpservers || []

  for (const node of personalNodes) {
    if (node.selectable && node.uuid) {
      personal.push(node)
    }
  }

  for (const js of jumpservers) {
    if (js.children) {
      for (const child of js.children) {
        if (child.selectable && child.uuid) {
          bastionIds.add(child.uuid)
          if (child.label) bastionIds.add(child.label)
        }
      }
    }
  }

  return { personal, bastionIds }
}

const loadAssets = async (search: string) => {
  if (!window.api?.getUserHosts) return

  assetLoading.value = true
  try {
    const results = await window.api.getUserHosts(search, 50)
    logger.info('[TerminalStep] getUserHosts raw results')
    // API returns { data: { personal: [], jumpservers: [] }, total: N }
    // Only personal assets are eligible; bastion children are excluded because
    // they require a second login that batch execution cannot perform.
    const { personal, bastionIds } = flattenAssetsFromResponse(results)
    logger.info('[TerminalStep] flattened assets', { count: personal.length })
    assetList.value = personal
    bastionAssetIds.value = bastionIds
  } catch (error) {
    logger.error('Failed to load assets', { error })
  } finally {
    assetLoading.value = false
  }
}

const handleAssetSearch = (value: string) => {
  loadAssets(value)
}

const getAssetDisplayName = (asset: AssetNode): string => {
  // Prefer the human-readable name (title) set by the user, fall back to the
  // asset IP (label), and only show the UUID as a last resort. Never extract
  // an ID from the key — that surfaced raw "personal_<uuid>" fragments.
  if (asset.title) return asset.title
  if (asset.label) return asset.label
  return asset.uuid || 'unknown'
}

// Per-form id→display-name cache so the selected-terminals table can show
// asset / connected-terminal titles instead of raw UUIDs.
// Built at add-time; we never persist it to the task config.
const terminalNameCache = ref<Map<string, string>>(new Map())

const lookupName = (id: string): string => terminalNameCache.value.get(id) || id

const selectorTypeLabel = (t: string): string => {
  if (t === 'asset') return $t('batchTask.selectorTypeAsset')
  if (t === 'active') return $t('batchTask.selectorTypeActive')
  if (t === 'template') return $t('batchTask.selectorTypeTemplate')
  return t
}

const formatNamedSelector = (record: { selector: string; selectorType: string }): string => {
  try {
    const selector = JSON.parse(record.selector)
    const ids: string[] = selector.ids || []
    return ids.map(lookupName).join(', ')
  } catch {
    return record.selector
  }
}

const addTerminal = () => {
  let selector = ''
  if (selectorType.value === 'active') {
    // Resolve names for the currently open connected terminals so the table
    // can render titles instead of tab ids.
    const terminalMetadata: Array<{ id: string; title: string; ip?: string }> = []
    for (const id of selectedIds.value) {
      const term = connectedTerminals.value.find((t) => t.id === id)
      if (term) {
        const label = term.ip ? `${term.title} (${term.ip})` : term.title
        terminalNameCache.value.set(id, label)
        terminalMetadata.push({ id, title: term.title, ip: term.ip || undefined })
      } else {
        // Terminal not found in the live list (just disconnected?): keep the
        // entry so the saved selector still records the id; main process will
        // fall back to using the id as the displayed name.
        terminalMetadata.push({ id, title: id })
      }
    }
    selector = JSON.stringify({ type: 'active', ids: selectedIds.value, terminals: terminalMetadata })
  } else if (selectorType.value === 'asset') {
    const ids: string[] = []
    // Add selected from dropdown
    if (selectedAssetId.value) {
      const id = selectedAssetId.value
      ids.push(id)
      const asset = assetList.value.find((a) => a.uuid === id)
      terminalNameCache.value.set(id, asset ? getAssetDisplayName(asset) : id)
    }
    // Add manually entered IDs, blocking any that belong to bastion children
    const manualIds = assetIds.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const manualId of manualIds) {
      if (bastionAssetIds.value.has(manualId)) {
        message.error($t('batchTask.bastionAssetBlocked', { id: manualId }))
        return
      }
      ids.push(manualId)
      // Manual entries may match an asset in the list (by uuid or IP); fall
      // back to the raw id if no match is found.
      const asset = assetList.value.find((a) => a.uuid === manualId || a.label === manualId)
      terminalNameCache.value.set(manualId, asset ? getAssetDisplayName(asset) : manualId)
    }

    if (ids.length === 0) {
      logger.warn('No asset selected or entered')
      return
    }
    selector = JSON.stringify({ type: 'asset', ids })
  } else {
    selector = JSON.stringify({ type: 'template', expr: templateExpr.value })
  }

  const newTerminals = [...terminals.value, { id: uuidv4(), selectorType: selectorType.value, selector }]
  emit('update:terminals', newTerminals)

  // Reset inputs
  selectedIds.value = []
  assetIds.value = ''
  templateExpr.value = ''
  selectedAssetId.value = null
}

const removeTerminal = (id: string) => {
  emit(
    'update:terminals',
    terminals.value.filter((t) => (t as any).id !== id)
  )
}

// Watch for selector type change to load assets
watch(selectorType, (newType) => {
  if (newType === 'asset' && assetList.value.length === 0) {
    loadAssets('')
  }
})

// In `define` mode the "active" option is hidden, so the dropdown value
// must not stay on it. Snap it back to `asset` if mode flips (or mounts
// — see `immediate`) while selectorType happens to be `active`. Net effect:
// define mode boots with selectorType='asset', run mode keeps 'active'.
watch(
  () => props.mode,
  (newMode) => {
    if (newMode === 'define' && selectorType.value === 'active') {
      selectorType.value = 'asset'
    }
  },
  { immediate: true }
)

// Merge parent-supplied display names into the local cache so the rendered
// table can show friendly labels for pre-existing saved terminals.
watch(
  () => props.prePopulatedNames,
  (names) => {
    if (!names) return
    for (const [id, label] of Object.entries(names)) {
      if (!terminalNameCache.value.has(id)) {
        terminalNameCache.value.set(id, label)
      }
    }
  },
  { immediate: true, deep: true }
)
</script>

<style scoped>
.terminal-step {
  padding: 16px;
}

.terminal-list {
  margin-top: 16px;
}

.asset-selector {
  display: flex;
  align-items: center;
  gap: 8px;
}

.selector-display {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.active-restriction-hint {
  margin-bottom: 12px;
}
</style>
