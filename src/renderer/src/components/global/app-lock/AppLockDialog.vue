<template>
  <a-modal
    v-model:visible="showAppLockDialog"
    :title="dialogTitle"
    width="460px"
    :mask-closable="false"
    :keyboard="false"
    :closable="false"
    :footer="null"
    class="app-lock-modal"
  >
    <div class="app-lock-content">
      <div class="description-text">
        {{ dialogDescription }}
      </div>

      <div class="form-section">
        <a-input-password
          v-model:value="password"
          :placeholder="passwordPlaceholder"
          size="large"
          @press-enter="submitAppLock"
        />

        <template v-if="isAppLockSetupMode">
          <a-input-password
            v-model:value="confirmPassword"
            :placeholder="t('userInfo.pleaseInputConfirmPassword')"
            size="large"
            @press-enter="submitAppLock"
          />

          <div
            v-if="password.length > 0"
            class="strength-row"
          >
            <span class="strength-label">{{ t('userInfo.passwordStrength') }}</span>
            <span :class="['strength-value', `strength-${strengthLevel}`]">{{ strengthText }}</span>
          </div>
        </template>
      </div>

      <div class="action-section">
        <a-button
          type="primary"
          size="large"
          class="submit-button"
          :loading="isSubmitting || isAppLockInitializing"
          @click="submitAppLock"
        >
          {{ submitText }}
        </a-button>
      </div>
    </div>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import zxcvbn from 'zxcvbn'
import { showAppLockDialog, isAppLockSetupMode, isAppLockInitializing, setAppLockPassword, verifyAppLockPassword } from './appLockState'

const { t } = useI18n()

const password = ref('')
const confirmPassword = ref('')
const isSubmitting = ref(false)

const strengthScore = computed(() => {
  if (password.value.length === 0) {
    return null
  }

  return zxcvbn(password.value).score
})

const strengthLevel = computed(() => {
  if (strengthScore.value === null || strengthScore.value <= 1) {
    return 'weak'
  }

  if (strengthScore.value === 2) {
    return 'medium'
  }

  return 'strong'
})

const strengthText = computed(() => {
  if (strengthScore.value === null || strengthScore.value <= 1) {
    return t('userInfo.passwordStrengthWeak')
  }

  if (strengthScore.value === 2) {
    return t('userInfo.passwordStrengthMedium')
  }

  return t('userInfo.passwordStrengthStrong')
})

const dialogTitle = computed(() => (isAppLockSetupMode.value ? t('appLock.titleSetup') : t('appLock.titleUnlock')))

const dialogDescription = computed(() => (isAppLockSetupMode.value ? t('appLock.setupDescription') : t('appLock.unlockDescription')))

const submitText = computed(() => (isAppLockSetupMode.value ? t('appLock.setupSubmit') : t('appLock.unlockSubmit')))

const passwordPlaceholder = computed(() => (isAppLockSetupMode.value ? t('userInfo.pleaseInputNewPassword') : t('appLock.unlockPasswordPlaceholder')))

const resetForm = () => {
  password.value = ''
  confirmPassword.value = ''
  isSubmitting.value = false
}

const validateSetupPassword = (): boolean => {
  if (password.value.length < 6) {
    message.error(t('userInfo.passwordLengthError'))
    return false
  }

  if ((strengthScore.value ?? 0) < 1) {
    message.error(t('userInfo.passwordStrengthError'))
    return false
  }

  if (confirmPassword.value.length === 0) {
    message.error(t('userInfo.pleaseInputConfirmPassword'))
    return false
  }

  if (password.value !== confirmPassword.value) {
    message.error(t('userInfo.passwordMismatch'))
    return false
  }

  return true
}

const validateUnlockPassword = (): boolean => {
  if (password.value.length < 6) {
    message.error(t('userInfo.passwordLengthError'))
    return false
  }

  return true
}

const submitAppLock = async () => {
  if (isSubmitting.value || isAppLockInitializing.value) {
    return
  }

  const isValid = isAppLockSetupMode.value ? validateSetupPassword() : validateUnlockPassword()
  if (!isValid) {
    return
  }

  try {
    isSubmitting.value = true

    if (isAppLockSetupMode.value) {
      await setAppLockPassword(password.value)
      resetForm()
      return
    }

    const result = await verifyAppLockPassword(password.value)
    if (!result.success) {
      message.error(t('appLock.unlockFailed'))
      return
    }

    resetForm()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : t('appLock.operationFailed')
    message.error(errorMessage)
  } finally {
    isSubmitting.value = false
  }
}

watch(showAppLockDialog, (visible) => {
  if (visible) {
    resetForm()
  }
})
</script>

<style scoped>
.app-lock-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px 0 8px 0;
}

.description-text {
  color: var(--text-color-secondary-light);
  font-size: 14px;
  line-height: 1.6;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.strength-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.strength-label {
  color: var(--text-color-secondary-light);
}

.strength-value {
  font-weight: 500;
}

.strength-weak {
  color: #faad14;
}

.strength-medium {
  color: #1677ff;
}

.strength-strong {
  color: #52c41a;
}

.action-section {
  display: flex;
  justify-content: center;
}

.submit-button {
  width: 100%;
  height: 40px;
}
</style>

<style>
.app-lock-modal .ant-modal-content {
  background-color: var(--bg-color-secondary) !important;
  color: var(--text-color) !important;
  border: 1px solid var(--border-color-light) !important;
}

.app-lock-modal .ant-modal-header {
  background-color: var(--bg-color-secondary) !important;
  border-bottom: 1px solid var(--border-color-light) !important;
}

.app-lock-modal .ant-modal-title {
  color: var(--text-color) !important;
}

.app-lock-modal .ant-modal-body {
  background-color: var(--bg-color-secondary) !important;
}
</style>
