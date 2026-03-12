import { ref, watch, computed } from 'vue'
import { createGlobalState } from '@vueuse/core'
import { getGlobalState, updateGlobalState, storeSecret, getSecret } from '@renderer/agent/storage/state'
import { GlobalStateKey } from '@renderer/agent/storage/state-keys'
import { notification } from 'ant-design-vue'
import { focusChatInput } from './useTabManagement'
import { useSessionState } from './useSessionState'

interface ModelSelectOption {
  label: string
  value: string
}

interface ModelOption {
  id: string
  name: string
  checked: boolean
  type: string
  apiProvider: string
}

const isEmptyValue = (value: unknown): boolean => value === undefined || value === ''

/**
 * Mapping from API provider to corresponding model ID global state key
 */
export const PROVIDER_MODEL_KEY_MAP: Record<string, GlobalStateKey> = {
  bedrock: 'apiModelId',
  litellm: 'liteLlmModelId',
  deepseek: 'apiModelId',
  openai: 'openAiModelId',
  default: 'defaultModelId'
}

/**
 * Composable for AI model configuration management
 * Handles model selection, configuration and initialization
 */
export const useModelConfiguration = createGlobalState(() => {
  const { chatAiModelValue } = useSessionState()

  const AgentAiModelsOptions = ref<ModelSelectOption[]>([])
  const modelsLoading = ref(true)

  const handleChatAiModelChange = async () => {
    const modelOptions = (await getGlobalState('modelOptions')) as ModelOption[]
    const selectedModel = modelOptions.find((model) => model.name === chatAiModelValue.value)

    if (selectedModel && selectedModel.apiProvider) {
      await updateGlobalState('apiProvider', selectedModel.apiProvider)
    }

    const apiProvider = selectedModel?.apiProvider
    const key = PROVIDER_MODEL_KEY_MAP[apiProvider || 'default'] || 'defaultModelId'
    await updateGlobalState(key, chatAiModelValue.value)

    focusChatInput()
  }

  const initModel = async () => {
    try {
      // Initialize model options list from existing global state
      const modelOptions = (await getGlobalState('modelOptions')) as ModelOption[]

      modelOptions.sort((a, b) => {
        const aIsThinking = a.name.endsWith('-Thinking')
        const bIsThinking = b.name.endsWith('-Thinking')

        if (aIsThinking && !bIsThinking) return -1
        if (!aIsThinking && bIsThinking) return 1

        return a.name.localeCompare(b.name)
      })

      AgentAiModelsOptions.value = modelOptions
        .filter((item) => item.checked)
        .map((item) => ({
          label: item.name,
          value: item.name
        }))

      if (chatAiModelValue.value && chatAiModelValue.value !== '') {
        const isValidModel = AgentAiModelsOptions.value.some((option) => option.value === chatAiModelValue.value)
        if (isValidModel) {
          return
        }
      }

      const apiProvider = (await getGlobalState('apiProvider')) as string
      const key = PROVIDER_MODEL_KEY_MAP[apiProvider || 'default'] || 'defaultModelId'
      chatAiModelValue.value = (await getGlobalState(key)) as string

      if ((chatAiModelValue.value === undefined || chatAiModelValue.value === '') && AgentAiModelsOptions.value[0]) {
        chatAiModelValue.value = AgentAiModelsOptions.value[0].label
        await handleChatAiModelChange()
      }
    } finally {
      modelsLoading.value = false
    }
  }

  const checkModelConfig = async (): Promise<{ success: boolean; message?: string; description?: string }> => {
    // Check if there are any available models
    const modelOptions = (await getGlobalState('modelOptions')) as ModelOption[]
    const availableModels = modelOptions.filter((model) => model.checked)

    if (availableModels.length === 0) {
      return {
        success: false,
        message: 'user.noAvailableModelMessage',
        description: 'user.noAvailableModelDescription'
      }
    }

    const apiProvider = (await getGlobalState('apiProvider')) as string

    switch (apiProvider) {
      case 'bedrock':
        const awsAccessKey = await getSecret('awsAccessKey')
        const awsSecretKey = await getSecret('awsSecretKey')
        const awsRegion = await getGlobalState('awsRegion')
        const apiModelId = await getGlobalState('apiModelId')
        if (isEmptyValue(apiModelId) || isEmptyValue(awsAccessKey) || isEmptyValue(awsSecretKey) || isEmptyValue(awsRegion)) {
          return {
            success: false,
            message: 'user.checkModelConfigFailMessage',
            description: 'user.checkModelConfigFailDescription'
          }
        }
        break
      case 'litellm':
        const liteLlmBaseUrl = await getGlobalState('liteLlmBaseUrl')
        const liteLlmApiKey = await getSecret('liteLlmApiKey')
        const liteLlmModelId = await getGlobalState('liteLlmModelId')
        if (isEmptyValue(liteLlmBaseUrl) || isEmptyValue(liteLlmApiKey) || isEmptyValue(liteLlmModelId)) {
          return {
            success: false,
            message: 'user.checkModelConfigFailMessage',
            description: 'user.checkModelConfigFailDescription'
          }
        }
        break
      case 'deepseek':
        const deepSeekApiKey = await getSecret('deepSeekApiKey')
        const apiModelIdDeepSeek = await getGlobalState('apiModelId')
        if (isEmptyValue(deepSeekApiKey) || isEmptyValue(apiModelIdDeepSeek)) {
          return {
            success: false,
            message: 'user.checkModelConfigFailMessage',
            description: 'user.checkModelConfigFailDescription'
          }
        }
        break
      case 'openai':
        const openAiBaseUrl = await getGlobalState('openAiBaseUrl')
        const openAiApiKey = await getSecret('openAiApiKey')
        const openAiModelId = await getGlobalState('openAiModelId')
        if (isEmptyValue(openAiBaseUrl) || isEmptyValue(openAiApiKey) || isEmptyValue(openAiModelId)) {
          return {
            success: false,
            message: 'user.checkModelConfigFailMessage',
            description: 'user.checkModelConfigFailDescription'
          }
        }
        break
    }
    return { success: true }
  }

  const initModelOptions = async () => {
    try {
      modelsLoading.value = true
      // Just load existing model options without server calls
      const savedModelOptions = ((await getGlobalState('modelOptions')) || []) as ModelOption[]

      if (savedModelOptions.length === 0) {
        // Initialize with empty model options for guest users
        const isSkippedLogin = localStorage.getItem('login-skipped') === 'true'
        if (isSkippedLogin) {
          await updateGlobalState('modelOptions', [])
        }
        return
      }
    } catch (error) {
      console.error('Failed to get/save model options:', error)
      notification.error({
        message: 'Error',
        description: 'Failed to get/save model options'
      })
      modelsLoading.value = false
    }
  }

  const refreshModelOptions = async (): Promise<void> => {
    // This function is now a no-op since we don't fetch from server anymore
    const isSkippedLogin = localStorage.getItem('login-skipped') === 'true'
    if (isSkippedLogin) return

    // Simply refresh from local state without server calls
    await initModel()
  }

  // Check if there are available models
  const hasAvailableModels = computed(() => {
    if (modelsLoading.value) {
      return true
    }
    return AgentAiModelsOptions.value && AgentAiModelsOptions.value.length > 0
  })

  watch(
    AgentAiModelsOptions,
    async (newOptions) => {
      if (newOptions.length > 0) {
        const isCurrentValueValid = newOptions.some((option) => option.value === chatAiModelValue.value)
        if (!isCurrentValueValid && newOptions[0]) {
          chatAiModelValue.value = ''
        }
      }
    },
    { immediate: true }
  )

  return {
    AgentAiModelsOptions,
    modelsLoading,
    hasAvailableModels,
    initModel,
    handleChatAiModelChange,
    checkModelConfig,
    initModelOptions,
    refreshModelOptions
  }
})