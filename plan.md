# Mingyu AI Chat 自动打开问题修复计划

## 问题描述
- 用户测试的是 Mingyu 类型连接
- 希望 AI Chat 在检测到控制台有 `#` 或 `$` 等提示符时才自动打开
- 当前 AI Chat 在不应该打开的时候自动打开了

## 数据流分析

### 当前流程（标准 JumpServer）
1. `interaction.ts` 中 `handleConnectionSuccess` 发送 `connectedToTarget`
2. renderer 中的 listener 收到消息，触发 `openAiRightNoFocus`
3. AI Chat 打开

### Mingyu 流程（当前）
1. `interaction.ts` 检测到 mingyu 菜单后，不发送 `connectedToTarget`
2. `sshHandle.ts` 处理 `main-shell` 数据（目标主机输出）
3. **问题**：提示符检测应该在步骤 2 中进行

## 解决方案

### 核心思路
在 `sshHandle.ts` 中，当 JumpServer shell 接收到数据时，检查是否包含 shell 提示符（`#` 或 `$`），如果检测到，则通过 status 消息机制发送 `ssh.jumpserver.connectedToTarget`。

### 具体修改

#### 1. 修改 `sshHandle.ts`（第 1778 行附近）
在发送 `ssh:shell:data:${id}` 事件时，检测数据中是否包含提示符模式。

提示符模式：
- 行尾有 # 或 $ 的命令提示符

如果检测到提示符且之前未发送过 `connectedToTarget`，则发送状态消息。

#### 2. 需要在 `sshHandle.ts` 中
- 维护一个 `hasSentConnectedToTarget` 的 Map 来跟踪每个连接是否已发送
- 获取 connectionId 对应的 jumpserverUuid

#### 3. 条件
- 只对 JumpServer 类型连接生效（非 `ssh` 类型）
- 只发送一次
- 需要知道 jumpserverUuid 来发送状态消息

## 实现步骤

- [x] 1. 检查 jumpserverConnections 和 jumpserverUuidToConnectionId 的关系
- [x] 2. 在 `sshHandle.ts` 中添加提示符检测逻辑
- [x] 3. 发送 `connectedToTarget` 状态消息
- [ ] 4. 测试验证

## 实现总结

### 修改文件
- `src/main/ssh/sshHandle.ts`

### 添加内容
1. Shell 提示符检测正则表达式 `SHELL_PROMPT_REGEX`
2. `jumpserverConnectedToTargetSent` Set 跟踪已发送 `connectedToTarget` 的连接
3. 在 `flushBuffer` 函数中添加提示符检测和状态消息发送
4. 在 `stream.on('close')` 中清理 `jumpserverConnectedToTargetSent` 记录

### 关键代码位置
- 第 41 行：添加 `SHELL_PROMPT_REGEX`
- 第 63-65 行：添加 `jumpserverConnectedToTargetSent`
- 第 1782-1797 行：在 `flushBuffer` 中添加提示符检测和状态消息发送
- 第 1898 行：在 `stream.on('close')` 中添加清理逻辑
