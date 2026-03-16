# 堡垒机插件类型选择问题分析

## 问题描述

用户在添加堡垒机类型主机时，没有看到具体的堡垒机类型（如 Qizhi、腾讯云等）可选择，只能看到基本的"堡垒机"选项。

## 根本原因

### 1. 前端显示条件

在 `AssetForm.vue` 中，具体堡垒机类型的选择组件有严格的显示条件：

```vue
v-if="!isEditMode && deviceTypePath[0] === 'server' && deviceTypePath[1] === 'bastion' && hasPluginBastions"
```

其中关键条件是 `hasPluginBastions`，其定义为：
```typescript
const hasPluginBastions = computed(() => availableBastions.value.length > 0)
```

### 2. 插件加载机制

`availableBastions` 是通过以下 API 调用获取的：
```typescript
const definitions = await window.api.getBastionDefinitions()
availableBastions.value = definitions || []
```

而 `getBastionDefinitions()` 最终调用的是：
```typescript
return capabilityRegistry.listBastionDefinitions()
```

### 3. 自动注册机制

系统采用**自动注册**机制，插件一旦存在就会自动注册其能力。从代码注释可以看出：
```typescript
// Set Qizhi plugin enabled state - no longer supported (plugins auto-register)
```

这意味着不再需要手动启用插件，插件会自动注册。

## 问题分析

当 `hasPluginBastions` 为 false 时，说明 `capabilityRegistry.listBastionDefinitions()` 返回空数组，即**没有插件成功注册堡垒机能力**。

### 可能原因：

1. **插件文件不存在**：系统中没有安装 Qizhi 或其他插件化堡垒机插件
2. **插件未正确配置**：插件缺少 `plugin.json` 文件或配置不正确
3. **插件加载失败**：插件主文件 (`index.js`) 不存在或格式错误
4. **插件未注册能力**：插件没有正确调用 `registerBastionDefinition()` 和 `registerBastionCapability()`
5. **插件被禁用**：插件存在但被标记为禁用状态

## 当前行为

当没有插件堡垒机时：

1. **用户界面**：只显示基本的"堡垒机"选项，隐藏具体的类型选择
2. **默认类型**：系统默认使用内置 JumpServer (`asset_type = 'organization'`)
3. **认证方式**：JumpServer 强制使用密钥认证，所以密钥不能为空
4. **用户体验**：用户只能配置 JumpServer 类型的堡垒机

## 架构流程图

```mermaid
flowchart TD
    A[用户添加堡垒机] --> B{选择设备类型}
    B -->|服务器 → 堡垒机| C[检查 hasPluginBastions]
    C -->|false| D[只显示 JumpServer 选项]
    C -->|true| E[显示 JumpServer + 插件堡垒机选项]

    D --> F[用户只能选择 JumpServer]
    E --> G[用户可以选择具体堡垒机类型]

    H[hasPluginBastions = availableBastions.length > 0] --> I[availableBastions = capabilityRegistry.listBastionDefinitions()]
    I --> J{插件是否已加载并注册?}
    J -->|否| K[availableBastions = []]
    J -->|是| L[availableBastions = [插件定义...]]
```

## 解决方案

### 方案1：安装插件
如果您需要使用 Qizhi 或其他堡垒机类型，需要先安装对应的插件。

**插件目录位置**：
- 用户数据目录：`%APPDATA%\Chaterm\plugins\`
- 应用目录：`D:\UGit\ZSChaterm\plugins\`

### 方案2：验证插件结构
确保插件包含正确的文件结构：

**plugin.json 示例**：
```json
{
  "id": "qizhi-bastion",
  "displayName": "齐治堡垒机",
  "version": "1.0.0",
  "description": "Qizhi Bastion Host integration",
  "main": "index.js",
  "type": "bastion"
}
```

**index.js 示例**：
```javascript
module.exports = {
  async register(host) {
    // 注册堡垒机定义
    host.registerBastionDefinition({
      type: 'qizhi',
      version: 1,
      displayNameKey: 'bastion.qizhi.name',
      assetTypePrefix: 'organization-qizhi',
      authPolicy: ['password', 'keyBased'],
      supportsRefresh: true,
      supportsShellStream: true,
      agentExec: 'stream'
    });

    // 注册堡垒机能力
    host.registerBastionCapability({
      type: 'qizhi',
      // ... 实现具体的连接、shell、刷新等方法
    });
  }
};
```

### 方案3：调试插件加载
检查控制台日志，查看是否有插件加载错误信息：
- `[pluginLoader] invalid manifest for...`
- `[pluginLoader] main entry not found for...`
- `[pluginLoader] load error for...`

### 方案4：验证插件注册
可以通过 IPC 调用验证插件是否正确注册：
```typescript
// 检查 Qizhi 插件是否启用
const isQizhiEnabled = await window.api.isQizhiPluginEnabled()
// 获取所有堡垒机定义
const bastionDefinitions = await window.api.getBastionDefinitions()
```

## 支持的堡垒机类型

从代码分析，系统支持以下堡垒机类型：

1. **内置 JumpServer** (`asset_type = 'organization'`)
2. **Qizhi 齐治堡垒机** (`asset_type = 'organization-qizhi'`)
3. **腾讯云堡垒机** (`asset_type = 'organization-tencent'`)
4. **其他插件化堡垒机** (`asset_type = 'organization-{type}'`)

## 总结

用户看不到具体堡垒机类型选项的根本原因是**没有插件成功注册堡垒机能力**。系统只有在检测到插件堡垒机时才会显示类型选择器，否则默认使用内置的 JumpServer。

要解决此问题，需要确保相应的插件已正确安装、配置和加载。