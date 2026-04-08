import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import AssetForm from '../AssetForm.vue'
import { message } from 'ant-design-vue'

const mockTranslations: Record<string, string> = {
  'personal.editHost': 'Edit Host',
  'personal.newHost': 'New Host',
  'personal.deviceCategory': 'Device Category',
  'personal.selectDeviceType': 'Select Device Type',
  'personal.bastionType': 'Bastion Type',
  'personal.address': 'Address',
  'personal.remoteHost': 'Remote Host',
  'personal.pleaseInputRemoteHost': 'Please input remote host',
  'personal.port': 'Port',
  'personal.pleaseInputPort': 'Please input port',
  'personal.verificationMethod': 'Verification Method',
  'personal.username': 'Username',
  'personal.pleaseInputUsername': 'Please input username',
  'personal.password': 'Password',
  'personal.pleaseInputPassword': 'Please input password',
  'personal.key': 'Key',
  'personal.pleaseSelectKeychain': 'Please select keychain',
  'personal.proxyConfig': 'Proxy Config',
  'personal.pleaseSelectSshProxy': 'Please select SSH proxy',
  'personal.general': 'General',
  'personal.alias': 'Alias',
  'personal.pleaseInputAlias': 'Please input alias',
  'personal.group': 'Group',
  'personal.pleaseSelectGroup': 'Please select group',
  'personal.saveAsset': 'Save Asset',
  'personal.createAsset': 'Create Asset',
  'personal.defaultGroup': 'Hosts',
  'personal.validationRemoteHostRequired': 'Remote host is required',
  'personal.validationPortRequired': 'Port is required',
  'personal.validationUsernameRequired': 'Username is required',
  'personal.validationKeychainRequired': 'Keychain is required',
  'personal.validationPasswordRequired': 'Password is required'
}

vi.mock('ant-design-vue', () => ({
  message: {
    error: vi.fn()
  }
}))

vi.mock('@/locales', () => ({
  default: {
    global: {
      t: (key: string) => mockTranslations[key] || key
    }
  }
}))

vi.mock('@/utils/eventBus', () => ({
  default: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  }
}))

const mockWindowApi = {
  getBastionDefinitions: vi.fn()
}

describe('AssetForm', () => {
  let wrapper: VueWrapper<any>

  const createWrapper = (props = {}) => {
    return mount(AssetForm, {
      props,
      global: {
        stubs: {
          ToTopOutlined: { template: '<span class="close-icon-stub" />' },
          'a-form': { template: '<form class="a-form"><slot /></form>' },
          'a-form-item': {
            template: '<div class="a-form-item"><slot name="label" /><slot /></div>',
            props: ['label', 'validateStatus', 'help', 'class']
          },
          'a-input': {
            template: '<input class="a-input" :value="value" @input="$emit(\'update:value\', $event.target.value); $emit(\'input\', $event)" />',
            props: ['value', 'placeholder', 'class', 'min', 'max', 'style']
          },
          'a-input-password': {
            template:
              '<input class="a-input-password" :value="value" @input="$emit(\'update:value\', $event.target.value); $emit(\'input\', $event)" />',
            props: ['value', 'placeholder', 'class']
          },
          'a-select': {
            template:
              '<select class="a-select" :value="value" @change="$emit(\'update:value\', $event.target.value); $emit(\'change\', $event.target.value)"><slot /></select>',
            props: ['value', 'options', 'placeholder', 'style', 'showSearch', 'maxTagCount', 'optionFilterProp', 'fieldNames', 'allowClear', 'mode']
          },
          'a-select-option': {
            template: '<option class="a-select-option" :value="value"><slot /></option>',
            props: ['value']
          },
          'a-button': {
            template: '<button class="a-button" @click="$emit(\'click\')"><slot /></button>',
            props: ['type', 'class']
          },
          'a-switch': {
            template: '<input class="a-switch" type="checkbox" :checked="checked" @change="$emit(\'change\', $event.target.checked)" />',
            props: ['checked', 'class']
          },
          'a-cascader': {
            template: '<div class="a-cascader"></div>',
            props: ['value', 'options', 'placeholder', 'allowClear']
          },
          'a-radio-group': {
            template: '<div class="a-radio-group"><slot /></div>',
            props: ['value', 'buttonStyle', 'style']
          },
          'a-radio-button': {
            template: '<button class="a-radio-button" :data-value="value"><slot /></button>',
            props: ['value']
          }
        }
      }
    })
  }

  beforeEach(() => {
    global.window = global.window || ({} as Window & typeof globalThis)
    ;(global.window as unknown as { api: typeof mockWindowApi }).api = mockWindowApi
    mockWindowApi.getBastionDefinitions.mockResolvedValue([])
    vi.clearAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('shows auth selector for built-in jumpserver', async () => {
    wrapper = createWrapper({
      initialData: {
        asset_type: 'organization',
        auth_type: 'password',
        ip: '1.1.1.1',
        port: 22,
        username: 'root',
        password: 'secret',
        group_name: 'Hosts',
        label: 'test'
      }
    })

    await nextTick()
    await nextTick()

    expect(wrapper.find('.a-radio-group').exists()).toBe(true)
    expect(wrapper.findAll('.a-radio-button')).toHaveLength(2)
  })

  it('keeps password auth in edit mode for built-in jumpserver', async () => {
    wrapper = createWrapper({
      isEditMode: true,
      initialData: {
        asset_type: 'organization',
        auth_type: 'password',
        ip: '1.1.1.1',
        port: 22,
        username: 'root',
        password: 'secret',
        group_name: 'Hosts',
        label: 'test'
      }
    })

    await nextTick()
    await nextTick()

    expect((wrapper.vm as any).formData.auth_type).toBe('password')
    expect(wrapper.find('.a-input-password').exists()).toBe(true)
  })

  it('requires password for built-in jumpserver password auth', async () => {
    wrapper = createWrapper({
      isEditMode: true,
      initialData: {
        asset_type: 'organization',
        auth_type: 'password',
        ip: '1.1.1.1',
        port: 22,
        username: 'root',
        password: '',
        group_name: 'Hosts',
        label: 'test'
      }
    })

    await nextTick()
    await nextTick()
    ;(wrapper.vm as any).handleSubmit()

    expect(message.error).toHaveBeenCalledWith('Password is required')
    expect(wrapper.emitted('submit')).toBeFalsy()
  })

  it('requires keychain for built-in jumpserver keyBased auth', async () => {
    wrapper = createWrapper({
      isEditMode: true,
      initialData: {
        asset_type: 'organization',
        auth_type: 'keyBased',
        ip: '1.1.1.1',
        port: 22,
        username: 'root',
        password: 'jump-password',
        keyChain: undefined,
        group_name: 'Hosts',
        label: 'test'
      }
    })

    await nextTick()
    await nextTick()
    ;(wrapper.vm as any).handleSubmit()

    expect(message.error).toHaveBeenCalledWith('Keychain is required')
    expect(wrapper.emitted('submit')).toBeFalsy()
  })
})
