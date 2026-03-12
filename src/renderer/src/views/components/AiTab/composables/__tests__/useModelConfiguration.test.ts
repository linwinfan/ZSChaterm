import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useModelConfiguration } from '../useModelConfiguration'
import * as stateModule from '@renderer/agent/storage/state'
import { ref } from 'vue'

// Create a shared mock ref that can be updated in tests
const mockChatAiModelValue = ref('')

// Mock dependencies
vi.mock('@renderer/agent/storage/state', () => ({
  getGlobalState: vi.fn(),
  updateGlobalState: vi.fn(),
  storeSecret: vi.fn(),
  getSecret: vi.fn()
}))

vi.mock('../useTabManagement', () => ({
  focusChatInput: vi.fn()
}))

vi.mock('../useSessionState', () => ({
  useSessionState: () => ({
    chatAiModelValue: mockChatAiModelValue
  })
}))

describe('useModelConfiguration', () => {
  const mockModelOptions = [
    { id: '1', name: 'claude-3-5-sonnet', checked: true, type: 'chat', apiProvider: 'anthropic' },
    { id: '2', name: 'gpt-4', checked: true, type: 'chat', apiProvider: 'openai' },
    { id: '3', name: 'claude-3-opus', checked: false, type: 'chat', apiProvider: 'anthropic' },
    { id: '4', name: 'deepseek-chat', checked: true, type: 'chat', apiProvider: 'deepseek' }
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockChatAiModelValue.value = ''
  })

  describe('initModel', () => {
    it('should initialize model options from global state', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return mockModelOptions
        if (key === 'apiProvider') return 'anthropic'
        if (key === 'defaultModelId') return 'claude-3-5-sonnet'
        return null
      })

      const { initModel, AgentAiModelsOptions } = useModelConfiguration()
      await initModel()

      expect(AgentAiModelsOptions.value).toHaveLength(3) // Only checked models
      expect(AgentAiModelsOptions.value[0].label).toBe('claude-3-5-sonnet')
      expect(AgentAiModelsOptions.value[1].label).toBe('deepseek-chat')
      expect(AgentAiModelsOptions.value[2].label).toBe('gpt-4')
    })

    it('should filter out unchecked models', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return mockModelOptions
        if (key === 'apiProvider') return 'anthropic'
        if (key === 'defaultModelId') return 'claude-3-5-sonnet'
        return null
      })

      const { initModel, AgentAiModelsOptions } = useModelConfiguration()
      await initModel()

      const hasUncheckedModel = AgentAiModelsOptions.value.some((option) => option.label === 'claude-3-opus')
      expect(hasUncheckedModel).toBe(false)
    })

    it('should use default model when current model is not set', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return mockModelOptions
        if (key === 'apiProvider') return 'anthropic'
        if (key === 'defaultModelId') return 'claude-3-5-sonnet'
        return null
      })

      const { initModel } = useModelConfiguration()
      await initModel()

      expect(stateModule.getGlobalState).toHaveBeenCalledWith('defaultModelId')
    })

    it('should use provider-specific model key based on apiProvider', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return mockModelOptions
        if (key === 'apiProvider') return 'openai'
        if (key === 'openAiModelId') return 'gpt-4'
        return null
      })

      const { initModel } = useModelConfiguration()
      await initModel()

      expect(stateModule.getGlobalState).toHaveBeenCalledWith('openAiModelId')
    })

    it('should handle bedrock provider model key', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return mockModelOptions
        if (key === 'apiProvider') return 'bedrock'
        if (key === 'apiModelId') return 'claude-3-5-sonnet'
        return null
      })

      const { initModel } = useModelConfiguration()
      await initModel()

      expect(stateModule.getGlobalState).toHaveBeenCalledWith('apiModelId')
    })

    it('should sort thinking models first', async () => {
      const modelsWithThinking = [
        { id: '1', name: 'claude-3-5-sonnet', checked: true, type: 'chat', apiProvider: 'anthropic' },
        { id: '2', name: 'gpt-4-Thinking', checked: true, type: 'chat', apiProvider: 'openai' },
        { id: '3', name: 'claude-3-opus-Thinking', checked: true, type: 'chat', apiProvider: 'anthropic' }
      ]

      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return modelsWithThinking
        if (key === 'apiProvider') return 'anthropic'
        if (key === 'defaultModelId') return 'claude-3-5-sonnet'
        return null
      })

      const { initModel, AgentAiModelsOptions } = useModelConfiguration()
      await initModel()

      // Thinking models should come first
      expect(AgentAiModelsOptions.value[0].label).toBe('claude-3-opus-Thinking')
      expect(AgentAiModelsOptions.value[1].label).toBe('gpt-4-Thinking')
      expect(AgentAiModelsOptions.value[2].label).toBe('claude-3-5-sonnet')
    })
  })

  describe('handleChatAiModelChange', () => {
    it('should update apiProvider when model changes', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return mockModelOptions
        return null
      })

      mockChatAiModelValue.value = 'gpt-4'
      const { handleChatAiModelChange } = useModelConfiguration()

      await handleChatAiModelChange()

      expect(stateModule.updateGlobalState).toHaveBeenCalledWith('apiProvider', 'openai')
    })

    it('should update correct provider model key', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return mockModelOptions
        return null
      })

      mockChatAiModelValue.value = 'gpt-4'
      const { handleChatAiModelChange } = useModelConfiguration()

      await handleChatAiModelChange()

      expect(stateModule.updateGlobalState).toHaveBeenCalledWith('openAiModelId', 'gpt-4')
    })

    it('should handle deepseek provider model key', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return mockModelOptions
        return null
      })

      mockChatAiModelValue.value = 'deepseek-chat'
      const { handleChatAiModelChange } = useModelConfiguration()

      await handleChatAiModelChange()

      expect(stateModule.updateGlobalState).toHaveBeenCalledWith('apiModelId', 'deepseek-chat')
    })
  })

  describe('checkModelConfig', () => {
    it('should validate model configuration', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'apiProvider') return 'anthropic'
        if (key === 'defaultModelId') return 'claude-3-5-sonnet'
        if (key === 'modelOptions') return [{ id: '1', name: 'test', checked: true, type: 'standard', apiProvider: 'default' }]
        return null
      })

      const { checkModelConfig } = useModelConfiguration()
      const result = await checkModelConfig()

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })

    it('should show notification when model config is invalid', async () => {
      vi.mocked(stateModule.getGlobalState).mockImplementation(async (key) => {
        if (key === 'modelOptions') return []
        return null
      })

      const { checkModelConfig } = useModelConfiguration()
      const result = await checkModelConfig()

      // Verify that the function handles invalid config gracefully
      expect(result).toBeDefined()
      expect(result.success).toBe(false)
    })
  })
})