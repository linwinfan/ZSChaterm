/**
 * LLM Startup Check Service
 * Reliable startup check without Vue composable dependencies
 */

import eventBus from '@/utils/eventBus'
import { getGlobalState } from '@renderer/agent/storage/state'

interface ModelOption {
  id: string
  name: string
  checked: boolean
  type: string
  apiProvider: string
}

/**
 * Simple model check without using Vue composables
 */
const hasAvailableModels = async (): Promise<boolean> => {
  try {
    const modelOptions = (await getGlobalState('modelOptions')) as ModelOption[]
    const availableModels = modelOptions.filter(model => model.checked)
    return availableModels.length > 0
  } catch (error) {
    console.error('Failed to check available models:', error)
    return false
  }
}

/**
 * Initialize startup LLM model check
 * Uses direct storage access for reliable checking
 */
export const initializeStartupModelCheck = () => {
  // Use a longer timeout to ensure app and storage are fully ready
  setTimeout(async () => {
    try {
      console.log('Starting LLM model startup check...')

      // Check if models are available
      const hasModels = await hasAvailableModels()

      if (!hasModels) {
        console.log('No LLM models configured, automatically opening model configuration...')

        // Use existing system functions to open model settings
        eventBus.emit('openUserTab', 'userConfig')

        setTimeout(() => {
          eventBus.emit('switchToModelSettingsTab')

          // Additional delay to ensure the tab is loaded
          setTimeout(() => {
            // Emit event to automatically enable the "Add Model" switch
            eventBus.emit('autoEnableAddModelSwitch')

            console.log('Model configuration guide completed')
          }, 500)
        }, 300)
      } else {
        console.log('LLM models are available, no need for configuration guide')
      }
    } catch (error) {
      console.error('Failed to initialize startup model check:', error)
    }
  }, 2000) // Increased to 2 seconds to ensure app is ready
}