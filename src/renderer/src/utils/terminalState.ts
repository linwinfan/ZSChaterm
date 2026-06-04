import { ref } from 'vue'

export interface ConnectedTerminal {
  id: string
  title: string
  ip: string
  organizationId: string
}

/**
 * Shared reactive state for connected terminals across panel boundaries.
 * Use this instead of provide/inject because dockview-vue panel content
 * components are not direct descendants in the Vue component tree, so
 * provide/inject does not propagate through them.
 */
export const connectedTerminals = ref<ConnectedTerminal[]>([])
