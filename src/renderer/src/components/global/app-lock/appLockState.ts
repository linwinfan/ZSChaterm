import { computed, ref } from 'vue'

interface AppLockStatusSnapshot {
  hasPassword: boolean
  isUnlocked: boolean
}

export const showAppLockDialog = ref(false)
export const hasAppLockPassword = ref(false)
export const isAppUnlocked = ref(false)
export const isAppLockInitialized = ref(false)
export const isAppLockInitializing = ref(false)
export const isAppLockSetupMode = computed(() => !hasAppLockPassword.value)

const unlockWaiters = new Set<() => void>()
let initializePromise: Promise<AppLockStatusSnapshot> | null = null

const getCurrentSnapshot = (): AppLockStatusSnapshot => ({
  hasPassword: hasAppLockPassword.value,
  isUnlocked: isAppUnlocked.value
})

const resolveUnlockWaiters = () => {
  unlockWaiters.forEach((resolveWaiter) => resolveWaiter())
  unlockWaiters.clear()
}

const applyAppLockStatus = (status: AppLockStatusSnapshot) => {
  hasAppLockPassword.value = status.hasPassword
  isAppUnlocked.value = status.isUnlocked
  isAppLockInitialized.value = true
  showAppLockDialog.value = !status.isUnlocked

  if (status.isUnlocked) {
    resolveUnlockWaiters()
  }
}

export const initializeAppLock = async (forceRefresh = false): Promise<AppLockStatusSnapshot> => {
  if (isAppLockInitialized.value && !forceRefresh) {
    return getCurrentSnapshot()
  }

  if (initializePromise && !forceRefresh) {
    return initializePromise
  }

  isAppLockInitializing.value = true

  const pendingInitialization = window.api
    .getAppLockStatus()
    .then((status) => {
      const nextStatus = {
        hasPassword: status.hasPassword,
        isUnlocked: status.isUnlocked
      }
      applyAppLockStatus(nextStatus)
      return nextStatus
    })
    .finally(() => {
      isAppLockInitializing.value = false
      initializePromise = null
    })

  initializePromise = pendingInitialization
  return pendingInitialization
}

export const waitForAppUnlock = async (): Promise<void> => {
  const status = await initializeAppLock()
  if (status.isUnlocked) {
    return
  }

  await new Promise<void>((resolve) => {
    if (isAppUnlocked.value) {
      resolve()
      return
    }

    unlockWaiters.add(resolve)

    if (isAppUnlocked.value) {
      unlockWaiters.delete(resolve)
      resolve()
    }
  })
}

export const setAppLockPassword = async (password: string): Promise<AppLockStatusSnapshot> => {
  const result = await window.api.setAppLockPassword(password)
  const nextStatus = {
    hasPassword: result.hasPassword,
    isUnlocked: result.isUnlocked
  }
  applyAppLockStatus(nextStatus)
  return nextStatus
}

export const verifyAppLockPassword = async (password: string): Promise<{ success: boolean; isUnlocked: boolean }> => {
  const result = await window.api.verifyAppLockPassword(password)

  if (result.success) {
    applyAppLockStatus({
      hasPassword: true,
      isUnlocked: result.isUnlocked
    })
  } else {
    applyAppLockStatus({
      hasPassword: true,
      isUnlocked: false
    })
  }

  return result
}

export const lockApp = async (): Promise<AppLockStatusSnapshot> => {
  const result = await window.api.lockApp()
  const nextStatus = {
    hasPassword: result.hasPassword,
    isUnlocked: result.isUnlocked
  }
  applyAppLockStatus(nextStatus)
  return nextStatus
}

export const resetAppLockState = () => {
  unlockWaiters.clear()
  initializePromise = null
  showAppLockDialog.value = false
  hasAppLockPassword.value = false
  isAppUnlocked.value = false
  isAppLockInitialized.value = false
  isAppLockInitializing.value = false
}
