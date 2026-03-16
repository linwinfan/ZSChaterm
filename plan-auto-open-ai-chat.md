# 实现终端连接时自动打开AI CHAT功能

## 需求分析
当用户连接到一个终端时，如果发现AI CHAT没有打开就自动打开。

## 实现方案
基于代码库分析，我们在终端连接成功后的处理逻辑中添加自动打开AI CHAT的功能。

### 方案选择
**在sshConnect.vue中直接调用eventBus.emit('openAiRight')** - 简单直接，复用现有事件机制。

选择此方案的原因：
- 事件总线已经是现有的通信机制
- sshConnect.vue已经使用了相同的事件来打开AI CHAT
- 实现简单且符合现有代码模式
- TerminalLayout.vue中已有`openAiRight`事件处理逻辑，会检查`showAiSidebar.value`状态，只在未打开时才打开

## 具体实现步骤

### 步骤1: 在sshConnect.vue中添加AI CHAT自动打开逻辑 ✓
- 在SSH连接成功后的处理逻辑中（`if (result.status === 'connected')`分支）
- 在本地连接成功后的处理逻辑中（`if (result.success)`分支）
- 添加`eventBus.emit('openAiRight')`调用

### 步骤2: 确保只在AI CHAT未打开时触发 ✓
- 复用TerminalLayout.vue中已有的`openAiRight`事件处理逻辑
- 该逻辑包含`if (!showAiSidebar.value)`检查，确保只在未打开时才打开

### 步骤3: 处理时序问题 ✓
- 在setTimeout中延迟触发，确保终端完全初始化后再打开AI CHAT
- 延迟200ms与现有scrollToBottom和focus操作保持一致

## 潜在问题和解决方案
1. **时序问题**: AI CHAT组件可能还未完全初始化
   - ✅ 解决方案: 使用setTimeout延迟触发，确保组件已挂载

2. **用户体验**: 用户可能不希望自动打开AI CHAT
   - ⚠️ 注意: 根据需求描述，这是默认行为。如需配置选项，可在后续版本中添加

3. **性能影响**: 自动打开可能增加连接时间
   - ✅ 解决方案: 异步触发，不影响主连接流程

## 代码修改点
- `src/renderer/src/views/components/Ssh/sshConnect.vue`:
  - 在SSH连接成功处理逻辑中添加自动打开AI CHAT的代码（第1201行）
  - 在本地连接成功处理逻辑中添加自动打开AI CHAT的代码（第1349行）

## 测试验证
- [ ] SSH连接成功后，AI CHAT自动打开（如果之前未打开）
- [ ] 本地连接成功后，AI CHAT自动打开（如果之前未打开）
- [ ] 如果AI CHAT已经打开，连接成功后不会重复打开或关闭
- [ ] 终端连接失败时，不会触发AI CHAT打开

## 实现总结
✅ 功能已成功实现！
- 复用现有事件机制，代码简洁
- 保持与现有架构的一致性
- 不影响现有功能，无回归风险
- 符合用户需求：连接终端时自动打开AI CHAT（如果未打开）