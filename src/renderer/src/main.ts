import './assets/main.css'
import './assets/theme.less'
import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
import i18n from './locales'
import contextmenu from 'v-contextmenu'
import 'v-contextmenu/dist/themes/default.css'
import 'ant-design-vue/dist/reset.css'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { notification } from 'ant-design-vue'
import { shortcutService } from './services/shortcutService'
import { APP_EDITION } from './utils/edition'
import * as storageState from './agent/storage/state'
import { setupIndexDBMigrationListener } from './services/indexdb-migration-listener'
import { initializeStartupModelCheck } from './services/llmStartupCheck'
import { waitForAppUnlock } from './components/global/app-lock'
import { userConfigStore } from '@/services/userConfigStoreService'

let isUserConfigIpcRegistered = false

// Set document title based on edition
document.title = APP_EDITION === 'cn' ? 'Chaterm CN' : 'Chaterm'

// Set global notification top position
notification.config({
  top: '30px'
})

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)
const app = createApp(App)
// Router
app.use(router)
// Internationalization
app.use(i18n)
// State management
app.use(pinia)
// Context menu
app.use(contextmenu)

// Expose storage API to global window object for main process calls
declare global {
  interface Window {
    storageAPI: typeof storageState
  }
}

window.storageAPI = storageState

app.mount('#app')

// Initialize startup LLM model check after app is mounted
initializeStartupModelCheck()

if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', () => {
    void waitForAppUnlock().then(() => {
      shortcutService.init()
    })
  })
}

function registerUserConfigIpcHandler() {
  if (isUserConfigIpcRegistered) {
    return
  }

  const electronAPI = (window as any).electron

  if (!electronAPI?.ipcRenderer) {
    return
  }

  const { ipcRenderer } = electronAPI

  ipcRenderer.on('userConfig:get', async (_event, payload: { requestId: string }) => {
    try {
      const config = await userConfigStore.getConfig()
      ipcRenderer.send('userConfig:get-response', {
        requestId: payload.requestId,
        config
      })
    } catch (error) {
      const currentError = error as Error
      ipcRenderer.send('userConfig:get-error', {
        requestId: payload.requestId,
        message: currentError.message
      })
    }
  })

  isUserConfigIpcRegistered = true
}

function enablePostUnlockRendererServices() {
  registerUserConfigIpcHandler()
  setupIndexDBMigrationListener()
}

function setupDeferredRendererRegistrations() {
  const electronAPI = (window as any).electron

  if (!electronAPI?.ipcRenderer) {
    return
  }

  const { ipcRenderer } = electronAPI

  ipcRenderer.on('app:register-user-config-ipc', () => {
    registerUserConfigIpcHandler()
  })

  ipcRenderer.on('app:register-indexdb-migration-listener', () => {
    setupIndexDBMigrationListener()
  })

  void waitForAppUnlock().then(() => {
    enablePostUnlockRendererServices()
  })
}

setupDeferredRendererRegistrations()

export { pinia }
