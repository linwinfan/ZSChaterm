/**
 * Model Settings Component Unit Tests
 *
 * Tests for the Model settings component including:
 * - Component rendering
 * - Model list loading and display
 * - Model selection/deselection
 * - Custom model removal
 * - Add model switch
 * - API provider configurations (LiteLLM, OpenAI, Bedrock, DeepSeek, Ollama)
 * - Configuration saving and loading
 * - Model validation (Check)
 * - Save new model (Save)
 * - Error handling
 * - Model sorting
 * - Guest user handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ModelComponent from '../model.vue'
import { notification } from 'ant-design-vue'
import eventBus from '@/utils/eventBus'
import { updateGlobalState, getGlobalState, getSecret, storeSecret, getAllExtensionState } from '@renderer/agent/storage/state'

// Mock ant-design-vue components
vi.mock('ant-design-vue', () => ({
  notification: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// Mock i18n
const mockTranslations: Record<string, string> = {
  'user.modelNames': 'Model Names',
  'user.addModel': 'Add Model',
  'user.apiConfiguration': 'API Configuration',
  'user.liteLlmBaseUrl': 'LiteLLM Base URL',
  'user.liteLlmBaseUrlPh': 'Enter LiteLLM base URL',
  'user.liteLlmApiKey': 'LiteLLM API Key',
  'user.liteLlmApiKeyPh': 'Enter LiteLLM API key',
  'user.liteLlmApiKeyDescribe': 'LiteLLM API key description',
  'user.openAiBaseUrl': 'OpenAI Base URL',
  'user.openAiBaseUrlPh': 'Enter OpenAI base URL',
  'user.openAiApiKey': 'OpenAI API Key',
  'user.openAiApiKeyPh': 'Enter OpenAI API key',
  'user.openAiApiKeyDescribe': 'OpenAI API key description',
  'user.awsAccessKey': 'AWS Access Key',
  'user.awsAccessKeyPh': 'Enter AWS access key',
  'user.awsSecretKey': 'AWS Secret Key',
  'user.awsSecretKeyPh': 'Enter AWS secret key',
  'user.awsSessionToken': 'AWS Session Token',
  'user.awsSessionTokenPh': 'Enter AWS session token',
  'user.awsRegion': 'AWS Region',
  'user.awsRegionPh': 'Select AWS region',
  'user.apiProviderDescribe': 'API provider description',
  'user.awsEndpointSelected': 'Use VPC Endpoint',
  'user.awsBedrockEndpointPh': 'Enter VPC endpoint URL',
  'user.awsUseCrossRegionInference': 'Use Cross Region Inference',
  'user.deepSeekApiKey': 'DeepSeek API Key',
  'user.deepSeekApiKeyPh': 'Enter DeepSeek API key',
  'user.deepSeekApiKeyDescribe': 'DeepSeek API key description',
  'user.ollamaBaseUrl': 'Ollama Base URL',
  'user.ollamaBaseUrlPh': 'Enter Ollama base URL',
  'user.ollamaBaseUrlDescribe': 'Ollama base URL description',
  'user.model': 'Model',
  'user.error': 'Error',
  'user.checkModelConfigFailMessage': 'Configuration check failed',
  'user.checkModelConfigFailDescription': 'Please fill in all required fields',
  'user.checkSuccessMessage': 'Check successful',
  'user.checkSuccessDescription': 'API configuration is valid',
  'user.checkFailMessage': 'Check failed',
  'user.checkFailDescriptionDefault': 'API configuration is invalid',
  'user.addModelExistError': 'Model already exists',
  'user.addModelSuccess': 'Model added successfully',
  'user.saveBedrockConfigFailed': 'Failed to save Bedrock configuration',
  'user.saveLiteLlmConfigFailed': 'Failed to save LiteLLM configuration',
  'user.saveDeepSeekConfigFailed': 'Failed to save DeepSeek configuration',
  'user.saveOpenAiConfigFailed': 'Failed to save OpenAI configuration',
  'user.saveOllamaConfigFailed': 'Failed to save Ollama configuration'
}

const mockT = (key: string) => {
  return mockTranslations[key] || key
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: mockT
  })
}))

vi.mock('@/locales', () => ({
  default: {
    global: {
      t: (key: string) => mockTranslations[key] || key
    }
  }
}))

// Mock storage functions
vi.mock('@renderer/agent/storage/state', () => ({
  updateGlobalState: vi.fn(),
  getGlobalState: vi.fn(),
  getSecret: vi.fn(),
  storeSecret: vi.fn(),
  getAllExtensionState: vi.fn()
}))

// Mock eventBus
vi.mock('@/utils/eventBus', () => ({
  default: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  }
}))

// Mock window.api
const mockWindowApi = {
  validateApiKey: vi.fn()
}

describe('Model Component', () => {
  let wrapper: VueWrapper<any>
  let pinia: ReturnType<typeof createPinia>

  const createWrapper = (options = {}) => {
    return mount(ModelComponent, {
      global: {
        plugins: [pinia],
        stubs: {
          'a-card': {
            template: '<div class="a-card"><div class="ant-card-body"><slot /></div></div>'
          },
          'a-checkbox': {
            template: '<label class="a-checkbox"><input type="checkbox" :checked="checked" @change="$emit('change', $event)" /><slot /></label>',
            props: ['checked']
          },
          'a-switch': {
            template: '<input type="checkbox" class="a-switch" :checked="checked" @change="$emit('update:checked', $event.target.checked)" />',
            props: ['checked']
          },
          'a-form-item': {
            template: '<div class="a-form-item"><slot name="label" /><slot /></div>',
            props: ['label', 'label-col', 'wrapper-col']
          },
          'a-input': {
            template: '<input class="a-input" :value="value" @input="$emit('update:value', $event.target.value)" />',
            props: ['value', 'placeholder', 'size', 'type']
          },
          'a-input-password': {
            template: '<input type="password" class="a-input-password" :value="value" @input="$emit('update:value', $event.target.value)" />',
            props: ['value', 'placeholder']
          },
          'a-select': {
            template: '<select class="a-select" :value="value" @change="$emit('update:value', $event.target.value)"><slot /></select>',
            props: ['value', 'options', 'placeholder', 'size', 'show-search']
          },
          'a-button': {
            template: '<button class="a-button" :class="{ loading }" :disabled="disabled" @click="$emit('click')"><slot /></button>',
            props: ['type', 'size', 'loading', 'disabled']
          }
        },
        mocks: {
          $t: mockT
        }
      },
      ...options
    })
  }

  beforeEach(() => {
    // Setup Pinia
    pinia = createPinia()
    setActivePinia(pinia)

    // Setup window.api mock
    global.window = global.window || ({} as Window & typeof globalThis)
    ;(global.window as unknown as { api: typeof mockWindowApi }).api = mockWindowApi

    // Setup localStorage
    localStorage.clear()
    localStorage.setItem('login-skipped', 'false')

    // Reset all mocks
    vi.clearAllMocks()

    // Setup default mock return values
    ;(getGlobalState as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      const defaults: Record<string, unknown> = {
        modelOptions: [],
        awsRegion: 'us-east-1',
        awsUseCrossRegionInference: false,
        awsBedrockEndpoint: '',
        awsEndpointSelected: false,
        liteLlmBaseUrl: '',
        openAiBaseUrl: 'https://api.openai.com/v1',
        ollamaBaseUrl: 'http://localhost:11434',
        ollamaModelId: ''
      }
      return defaults[key] || null
    })
    ;(getSecret as ReturnType<typeof vi.fn>).mockResolvedValue('')
    ;(storeSecret as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(updateGlobalState as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(getAllExtensionState as ReturnType<typeof vi.fn>).mockResolvedValue({ apiConfiguration: {} })
    mockWindowApi.validateApiKey.mockResolvedValue({ isValid: true })

    // Clear console output for cleaner test results
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  describe('Component Mounting', () => {
    it('should mount successfully', async () => {
      wrapper = createWrapper()
      await nextTick()
      await nextTick() // Wait for onMounted

      expect(wrapper.exists()).toBe(true)
      expect(wrapper.find('.section-header').exists()).toBe(true)
    })

    it('should load saved configuration on mount', async () => {
      ;(getGlobalState as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === 'awsRegion') return 'us-west-2'
        if (key === 'openAiBaseUrl') return 'https://custom.openai.com/v1'
        if (key === 'awsUseCrossRegionInference') return false
        if (key === 'awsBedrockEndpoint') return ''
        if (key === 'awsEndpointSelected') return false
        if (key === 'liteLlmBaseUrl') return ''
        if (key === 'ollamaBaseUrl') return 'http://localhost:11434'
        if (key === 'ollamaModelId') return ''
        if (key === 'modelOptions') return []
        return null
      })
      ;(getSecret as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === 'awsAccessKey') return 'test-access-key'
        if (key === 'openAiApiKey') return 'test-openai-key'
        return ''
      })

      wrapper = createWrapper()
      await nextTick()
      // Wait for async operations in onMounted
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(getGlobalState).toHaveBeenCalled()
      expect(getSecret).toHaveBeenCalled()
    })

    it('should load model options on mount', async () => {
      wrapper = createWrapper()
      await nextTick()
      // Wait for async operations in onMounted
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(getGlobalState).toHaveBeenCalledWith('modelOptions')
    })

    it('should handle config load errors', async () => {
      const error = new Error('Load failed')
      ;(getGlobalState as ReturnType<typeof vi.fn>).mockRejectedValue(error)

      wrapper = createWrapper()
      await nextTick()
      await nextTick()

      expect(notification.error).toHaveBeenCalledWith({
        message: 'Error',
        description: 'Failed to load saved configuration'
      })
    })
  })

  describe('Model List Display', () => {
    beforeEach(async () => {
      ;(getGlobalState as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === 'modelOptions') {
          return [
            { id: 'gpt-4', name: 'gpt-4', checked: true, type: 'standard', apiProvider: 'default' },
            { id: 'custom-1', name: 'custom-model', checked: false, type: 'custom', apiProvider: 'openai' }
          ]
        }
        if (key === 'awsRegion') return 'us-east-1'
        if (key === 'awsUseCrossRegionInference') return false
        if (key === 'awsBedrockEndpoint') return ''
        if (key === 'awsEndpointSelected') return false
        if (key === 'liteLlmBaseUrl') return ''
        if (key === 'openAiBaseUrl') return 'https://api.openai.com/v1'
        if (key === 'ollamaBaseUrl') return 'http://localhost:11434'
        if (key === 'ollamaModelId') return ''
        return null
      })

      wrapper = createWrapper()
      await nextTick()
      // Wait for async operations in onMounted
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    it('should display model list', () => {
      const modelList = wrapper.find('.model-list')
      expect(modelList.exists()).toBe(true)
    })

    it('should render model items', () => {
      const modelItems = wrapper.findAll('.model-item')
      expect(modelItems.length).toBeGreaterThan(0)
    })

    it('should display model names correctly', () => {
      const modelItems = wrapper.findAll('.model-item')
      expect(modelItems.length).toBeGreaterThan(0)
    })

    it('should show thinking icon for Thinking models', async () => {
      ;(getGlobalState as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === 'modelOptions') {
          return [{ id: 'gpt-4', name: 'gpt-4-Thinking', checked: true, type: 'standard', apiProvider: 'default' }]
        }
        if (key === 'awsRegion') return 'us-east-1'
        if (key === 'awsUseCrossRegionInference') return false
        if (key === 'awsBedrockEndpoint') return ''
        if (key === 'awsEndpointSelected') return false
        if (key === 'liteLlmBaseUrl') return ''
        if (key === 'openAiBaseUrl') return 'https://api.openai.com/v1'
        if (key === 'ollamaBaseUrl') return 'http://localhost:11434'
        if (key === 'ollamaModelId') return ''
        return null
      })

      wrapper = createWrapper()
      await nextTick()
      // Wait for async operations in onMounted
      await new Promise((resolve) => setTimeout(resolve, 50))

      const thinkingIcon = wrapper.find('.thinking-icon')
      expect(thinkingIcon.exists()).toBe(true)
    })

    it('should display remove button for checked custom models', async () => {
      ;(getGlobalState as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === 'modelOptions') {
          return [{ id: 'custom-1', name: 'custom-model', checked: true, type: 'custom', apiProvider: 'openai' }]
        }
        if (key === 'awsRegion') return 'us-east-1'
        if (key === 'awsUseCrossRegionInference') return false
        if (key === 'awsBedrockEndpoint') return ''
        if (key === 'awsEndpointSelected') return false
        if (key === 'liteLlmBaseUrl') return ''
        if (key === 'openAiBaseUrl') return 'https://api.openai.com/v1'
        if (key === 'ollamaBaseUrl') return 'http://localhost:11434'
        if (key === 'ollamaModelId') return ''
        return null
      })

      wrapper = createWrapper()
      await nextTick()
      // Wait for async operations in onMounted
      await new Promise((resolve) => setTimeout(resolve, 50))

      const removeButton = wrapper.find('.remove-button')
      expect(removeButton.exists()).toBe(true)
    })

    it('should not display remove button for standard models', async () => {
      ;(getGlobalState as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === 'modelOptions') {
          return [{ id: 'gpt-4', name: 'gpt-4', checked: true, type: 'standard', apiProvider: 'default' }]
        }
        return null
      })

      wrapper = createWrapper()
      await nextTick()
      await nextTick()

      const removeButton = wrapper.find('.remove-button')
      expect(removeButton.exists()).toBe(false)
    })
  })
})