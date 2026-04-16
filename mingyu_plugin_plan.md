# Mingyu 堡垒机独立插件计划

## 目标

创建一个独立于 jumpserver 的 mingyu 插件，实现 BastionCapability 接口，复用 jumpserver 的核心逻辑（连接管理、MFA、状态管理），但不修改原有 jumpserver 代码。

## 架构设计

```
src/main/ssh/
├── jumpserver/           # 现有 JumpServer 实现（不修改）
│   ├── connectionManager.ts
│   ├── interaction.ts
│   ├── parser.ts
│   ├── navigator.ts
│   ├── mfa.ts
│   ├── state.ts
│   └── ...
└── mingyu-plugin/        # 新建 Mingyu 插件目录
    ├── index.ts          # 插件入口，注册 BastionCapability
    ├── connectionManager.ts  # 引用 jumpserver 的 connectionManager 逻辑
    ├── interaction.ts     # 引用 jumpserver 的 interaction.ts
    ├── state.ts          # Mingyu 独立状态（复制并重命名 jumpserver state）
    ├── types.ts           # Mingyu 特定类型定义
    └── constants.ts       # Mingyu 特定常量
```

## 实施步骤

### Phase 1: 创建插件基础结构

#### 1.1 创建 `src/main/ssh/mingyu-plugin/` 目录结构

新建以下文件：

**mingyu-plugin/index.ts** - 插件入口：
```typescript
import { capabilityRegistry } from '../capabilityRegistry'
import type { BastionCapability, BastionDefinition } from '../capabilityRegistry'
import { handleMingyuConnection, registerMingyuHandlers } from './connectionManager'
import { mingyuShellStreams, mingyuConnections, mingyuConnectionStatus, mingyuLastCommand, mingyuInputBuffer } from './state'
import type { MingyuConnectionInfo, MingyuConnectResult, MingyuShellArgs, MingyuShellResult, MingyuWriteArgs, MingyuResizeArgs } from './types'

// Stream type for shell sessions
interface ShellStream {
  write(data: string): void
  end(): void
  emit(event: string, ...args: unknown[]): void
}

let mingyuRegistered = false

export const createMingyuBastionCapability = (): BastionCapability => {
  return {
    type: 'mingyu',

    connect: async (connectionInfo: any, event?: any): Promise<MingyuConnectResult> => {
      try {
        const result = await handleMingyuConnection(connectionInfo as MingyuConnectionInfo, event)
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { status: 'error', message }
      }
    },

    shell: async (_event: any, args: MingyuShellArgs): Promise<MingyuShellResult> => {
      const stream = mingyuShellStreams.get(args.id) as ShellStream | undefined
      if (!stream) {
        return { status: 'error', message: 'Shell session not found' }
      }
      return { status: 'success' }
    },

    write: (args: MingyuWriteArgs): void => {
      const stream = mingyuShellStreams.get(args.id) as ShellStream | undefined
      if (!stream) {
        console.warn('[Mingyu] Write to non-existent shell session:', args.id)
        return
      }
      const data = args.data + '\n'
      stream.write(data)
      mingyuLastCommand.set(args.id, args.data)
    },

    resize: async (args: MingyuResizeArgs): Promise<void> => {
      const stream = mingyuShellStreams.get(args.id) as ShellStream | undefined
      if (!stream) {
        console.warn('[Mingyu] Resize on non-existent shell session:', args.id)
        return
      }
      stream.emit('resize', args.cols, args.rows)
    },

    disconnect: async (args: { id: string }): Promise<void> => {
      const { id } = args
      const stream = mingyuShellStreams.get(id) as ShellStream | undefined
      if (stream) {
        stream.end()
        mingyuShellStreams.delete(id)
      }
      const connData = mingyuConnections.get(id)
      if (connData) {
        mingyuConnections.delete(id)
        connData.conn.end()
      }
      mingyuConnectionStatus.delete(id)
      mingyuLastCommand.delete(id)
      mingyuInputBuffer.delete(id)
      console.log(`[Mingyu] Disconnected session: ${id}`)
    },

    refreshAssets: async (_options: any): Promise<{ success: boolean; error?: string }> => {
      return { success: false, error: 'Mingyu does not support asset refresh' }
    },

    getShellStream: (id: string): unknown => {
      return mingyuShellStreams.get(id)
    }
  }
}

export const getMingyuBastionDefinition = (): BastionDefinition => {
  return {
    type: 'mingyu',
    version: 1,
    displayNameKey: 'bastion.mingyu.name',
    assetTypePrefix: 'organization-mingyu',
    authPolicy: ['password', 'keyBased'],
    supportsRefresh: false,
    supportsShellStream: true,
    agentExec: 'stream'
  }
}

export const registerMingyuPlugin = (): void => {
  if (mingyuRegistered && capabilityRegistry.hasBastion('mingyu')) {
    console.log('[Mingyu] Plugin already registered, skipping')
    return
  }

  registerMingyuHandlers()
  capabilityRegistry.registerBastionDefinition(getMingyuBastionDefinition())
  capabilityRegistry.registerBastion(createMingyuBastionCapability())
  mingyuRegistered = true
  console.log('[Mingyu] Plugin registered successfully')
}
```

**mingyu-plugin/types.ts** - 类型定义：
```typescript
export interface MingyuConnectionInfo {
  id: string
  assetUuid?: string
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  targetIp: string
  targetHostname?: string
  targetAsset?: string
  targetUsername?: string
  targetPassword?: string
  terminalType?: string
  needProxy: boolean
  connIdentToken: string
  proxyConfig?: any
}

export interface MingyuConnectResult {
  status: 'connected' | 'error'
  sessionId?: string
  message?: string
}

export interface MingyuShellArgs {
  id: string
  terminalType?: string
}

export interface MingyuShellResult {
  status: 'success' | 'error'
  message?: string
}

export interface MingyuWriteArgs {
  id: string
  data: string
  marker?: string
  lineCommand?: string
  isBinary?: boolean
}

export interface MingyuResizeArgs {
  id: string
  rows: number
  cols: number
}
```

**mingyu-plugin/state.ts** - 状态管理（独立于 jumpserver）：
```typescript
import type { Client } from 'ssh2'

export const mingyuConnections = new Map<string, {
  conn: Client
  stream?: unknown
  mingyuUuid?: string
  targetIp?: string
  navigationPath?: any
}>()

export const mingyuShellStreams = new Map<string, unknown>()
export const mingyuExecStreams = new Map<string, unknown>()
export const mingyuMarkedCommands = new Map<string, unknown>()
export const mingyuLastCommand = new Map<string, string>()
export const mingyuInputBuffer = new Map<string, string>()
export const mingyuConnectionStatus = new Map<string, unknown>()
export const mingyuUuidToConnectionId = new Map<string, string>()
```

**mingyu-plugin/constants.ts** - 特定常量：
```typescript
// Mingyu 菜单提示符
export const MINGYU_MENU_PROMPT = '[GateShell]'

// 复用 jumpserver 的 MFA 常量
export const MAX_MINGYU_MFA_ATTEMPTS = 3

// 其他 Mingyu 特定常量从 jumpserver 复制
```

### Phase 2: 实现 connectionManager

**mingyu-plugin/connectionManager.ts** - 核心实现：

关键点：
1. **复用** jumpserver 的 MFA 处理逻辑（调用 `handleJumpServerKeyboardInteractive`）
2. **复用** jumpserver 的 SFTP 逻辑（`sftpAsync`）
3. **复用** jumpserver 的 proxy 逻辑（`createProxySocket`）
4. **独立** 的状态管理（`mingyuConnections` 等）
5. **独立** 的 interaction 逻辑，但引用 jumpserver 的 parser/navigator

```typescript
// 引用 jumpserver 的共享模块
import { handleJumpServerKeyboardInteractive } from '../jumpserver/mfa'
import { sftpAsync } from '../jumpserver/connectionManager'
import { createProxySocket } from '../proxy'
import { LEGACY_ALGORITHMS } from '../algorithms'
import { getPackageInfo, safeAppPath } from '../jumpserver/connectionManager'

// 自己的状态
import { mingyuConnections, mingyuShellStreams, mingyuUuidToConnectionId } from './state'
import { setupMingyuInteraction } from './interaction'

// 自己的连接处理
export const handleMingyuConnection = async (connectionInfo: MingyuConnectionInfo, event?: any): Promise<any> => {
  // 参考 jumpserver/connectionManager.ts 的连接逻辑
  // 但使用 mingyu-* 状态和 setupMingyuInteraction
}
```

### Phase 3: 实现 interaction

**mingyu-plugin/interaction.ts**：

关键点：
1. **直接复制** jumpserver/interaction.ts 中 mingyu profile 相关的代码
2. 不做任何修改，只修改状态引用（`jumpserverConnections` → `mingyuConnections`）
3. 复用 jumpserver 的 `hasJumpServerInitialMenuPrompt`, `resolveMingyuTargetSelection`, `buildMingyuArrowNavigationCommands` 等函数

```typescript
// 从 jumpserver/interaction.ts 复制 mingyu profile 处理逻辑
// 主要修改：
// - jumpserverConnections → mingyuConnections
// - jumpserverShellStreams → mingyuShellStreams
// - jumpserverUuid → mingyuUuid
// - 其他 jumpserver 特定状态 → mingyu 特定状态
```

### Phase 4: 注册插件

#### 4.1 在应用启动时注册插件

可能的位置：
- `src/main/index.ts`
- 或创建 `src/main/ssh/plugins.ts` 统一注册

```typescript
// src/main/ssh/plugins.ts
import { registerMingyuPlugin } from './mingyu-plugin'

export const registerAllPlugins = () => {
  registerMingyuPlugin()
}
```

#### 4.2 确保插件在 capabilityRegistry 中可用

`getOrganizationAssetTypes()` 应该已经能识别 `organization-mingyu` 类型（因为 assetTypePrefix 是 `organization-mingyu`）。

## 文件清单

### 新建文件
- `src/main/ssh/mingyu-plugin/index.ts` - 插件入口
- `src/main/ssh/mingyu-plugin/types.ts` - 类型定义
- `src/main/ssh/mingyu-plugin/state.ts` - 状态管理
- `src/main/ssh/mingyu-plugin/constants.ts` - 常量定义
- `src/main/ssh/mingyu-plugin/connectionManager.ts` - 连接管理
- `src/main/ssh/mingyu-plugin/interaction.ts` - 交互处理

### 修改文件
- `src/main/index.ts` 或新建 `src/main/ssh/plugins.ts` - 添加插件注册调用

## 风险和注意事项

1. **不要修改 jumpserver 目录下的任何文件**
2. **interaction.ts 需要完整复制 jumpserver/interaction.ts 的 mingyu 相关逻辑**
3. **测试时要确保 jumpserver 和 mingyu 插件可以同时工作**
4. **注意状态隔离** - mingyu 使用自己的状态 Map，不与 jumpserver 共享

## 预期结果

- Mingyu 堡垒机作为独立插件运行
- 通过 `sshType='mingyu'` 路由到 capabilityRegistry
- 与现有 JumpServer 实现完全隔离
- 可以独立于 jumpserver 进行修改和测试
