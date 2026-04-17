# Mingyu 命令输出收集修复

## 问题描述

Mingyu 堡垒机在 AI Chat command 模式下执行命令时，输出无法被正确收集和返回。

### 根本原因

Mingyu 插件缺少 `markedCommands` 机制来跟踪和收集命令输出。

### 对比分析

| 组件 | markedCommands 设置位置 | shell handler 输出收集 |
|------|------------------------|----------------------|
| 普通 SSH | `sshHandle.ts:2159-2170` | `sshHandle.ts:1968-1998` |
| JumpServer | `jumpserverHandle.ts:869-879` | `sshHandle.ts:1847-1877` |
| **Mingyu** | **❌ 缺失** | **❌ 缺失** |

## 修复内容

### 1. 修改 `mingyu-plugin/index.ts`

#### 1.1 修改 `write` 方法 (约第 140-165 行)

**修复前：**
```typescript
write: (args: MingyuWriteArgs): void => {
  const stream = mingyuShellStreams.get(args.id) as ShellStream | undefined
  if (!stream) return

  stream.write(args.data)
  mingyuLastCommand.set(args.id, args.data)
}
```

**修复后：**
```typescript
write: (args: MingyuWriteArgs): void => {
  const stream = mingyuShellStreams.get(args.id) as ShellStream | undefined
  if (!stream) return

  // Set markedCommands for command output collection (same logic as jumpserverHandle.ts)
  if (mingyuMarkedCommands.has(args.id)) {
    mingyuMarkedCommands.delete(args.id)
  }
  if (args.marker) {
    mingyuMarkedCommands.set(args.id, {
      marker: args.marker,
      output: '',
      completed: false,
      rawChunks: [],
      rawBytes: 0,
      raw: [],
      lastActivity: Date.now(),
      idleTimer: null
    })
  }

  stream.write(args.data)
  mingyuLastCommand.set(args.id, args.data)
}
```

#### 1.2 修改 `shell` 方法中的 `stream.on('data')` (约第 127-170 行)

**修复前：**
```typescript
stream.on('data', (data) => {
  const dataStr = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  buffer += dataStr
  if (Buffer.isBuffer(data)) {
    rawChunks.push(data)
    rawBytes += data.length
  }
  scheduleFlush()
})
```

**修复后：**
```typescript
stream.on('data', (data) => {
  const dataStr = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)

  // Check if this is a marked command output collection
  const markedCmd = mingyuMarkedCommands.get(args.id)
  if (markedCmd !== undefined) {
    // For Chaterm:command marker, send each chunk immediately (same as jumpserver)
    if (markedCmd.marker === 'Chaterm:command') {
      const rawData = Buffer.isBuffer(data) ? data : Buffer.from(dataStr, 'utf8')
      event.sender.send(`ssh:shell:data:${args.id}`, {
        data: dataStr,
        raw: rawData,
        marker: markedCmd.marker
      })
      return
    }
    // Otherwise, accumulate output
    markedCmd.output += dataStr
    markedCmd.rawChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(dataStr, 'utf8'))
    markedCmd.rawBytes += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(dataStr, 'utf8')
    markedCmd.lastActivity = Date.now()
    if (markedCmd.idleTimer) {
      clearTimeout(markedCmd.idleTimer)
    }
    markedCmd.idleTimer = setTimeout(() => {
      if (markedCmd && !markedCmd.completed) {
        markedCmd.completed = true
        const markedRaw = markedCmd.rawBytes ? Buffer.concat(markedCmd.rawChunks, markedCmd.rawBytes) : undefined
        event.sender.send(`ssh:shell:data:${args.id}`, {
          data: markedCmd.output,
          raw: markedRaw,
          marker: markedCmd.marker
        })
        mingyuMarkedCommands.delete(args.id)
      }
    }, 200)
    return
  }

  // Normal shell output handling (non-marked)
  buffer += dataStr
  if (Buffer.isBuffer(data)) {
    rawChunks.push(data)
    rawBytes += data.length
  }
  scheduleFlush()
})
```

### 2. 新增 `mingyu-plugin/mingyuHandle.ts`

创建 AI Agent 使用的简化接口，类似于 `jumpserverHandle.ts` 的核心函数。

#### 导出函数

| 函数 | 作用 |
|------|------|
| `mingyuShellWrite(sessionId, data, marker?)` | 写入 shell 并设置 markedCommands |
| `mingyuExec(sessionId, command)` | 通过 SSH exec 执行命令 |
| `mingyuDisconnect(sessionId)` | 断开连接并清理状态 |

#### 导出状态

- `mingyuShellStreams`
- `mingyuConnections`
- `mingyuConnectionStatus`

## 数据流图

```
AI Chat command 模式执行流程：

1. useCommandInteraction.ts
   └── eventBus.emit('executeTerminalCommand', { command, tabId })

2. sshConnect.vue (handleExecuteCommand)
   └── sendMarkedData(command, uniqueMarker)
       └── api.writeToShell({ id, data, marker, ... })

3. sshHandle.ts (ssh:shell:write)
   └── writeBastionSession(id, data, marker, ...)

4. bastionPlugin.ts (writeBastionSession)
   └── capability.write({ id, data, marker, ... })

5. mingyu-plugin/index.ts (BastionCapability.write)
   ✅ mingyuMarkedCommands.set(id, { marker, ... })  // 新增
   └── stream.write(data)

6. mingyu-plugin/index.ts (BastionCapability.shell - stream.on('data'))
   ✅ 检查 mingyuMarkedCommands.get(id)              // 新增
   ├── marker === 'Chaterm:command' → 立即发送
   └── 其他 marker → 累积 200ms 后发送

7. sshConnect.vue (handleServerOutput)
   └── eventBus.emit('sendMessageToAi', { content, tabId })
```

## AI Agent 使用方式

```typescript
import { mingyuShellWrite, mingyuExec, mingyuDisconnect } from '@services/mingyuHandle'

// 写入命令（会设置 markedCommands）
mingyuShellWrite(sessionId, command + '\n', 'Chaterm:command:xxx')

// 或直接执行命令（绕过 shell）
const result = await mingyuExec(sessionId, command)

// 断开连接
await mingyuDisconnect(sessionId)
```

## 相关文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/main/ssh/mingyu-plugin/index.ts` | 修改 | 添加 markedCommands 设置和输出收集 |
| `src/main/ssh/mingyu-plugin/mingyuHandle.ts` | 新增 | AI Agent 简化接口 |
| `src/main/ssh/mingyu-plugin/state.ts` | 无需修改 | 已有 mingyuMarkedCommands 定义 |
| `src/main/ssh/mingyu-plugin/constants.ts` | 无需修改 | 已有 MingyuMarkedCommand 类型定义 |

## 验证方法

1. 打开 Mingyu 堡垒机连接
2. 切换到 AI Chat command 模式
3. 执行命令（如 `ls -la`）
4. 检查命令输出是否正确返回到 AI Chat

## 附加修复：mingyuUuid 大小写统一

### 问题

类型定义 `MingyuConnectionData` 和 `MingyuNavigationPath` 中的属性名是 `mingyuUuid`（小写 m），但代码中有地方使用了 `MingyuUuid`（大写 M），导致 TypeScript 类型检查失败。

### 修复的文件

| 文件 | 修改 |
|------|------|
| `constants.ts` | `MingyuUuid` → `mingyuUuid`（已是小写） |
| `mingyuHandle.ts` | `connData.MingyuUuid` → `connData.mingyuUuid` |
| `interaction.ts` | `MingyuNavigationPath` 导入路径从 `./state` 改为 `./constants` |
| `interaction.ts` | 创建 `navigationPath` 对象时添加缺失的 `mingyuUuid` 字段 |

## 修复日期

2026-04-17
