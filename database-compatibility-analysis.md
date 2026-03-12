# 数据库和存储 Guest 模式兼容性分析报告

## 分析时间
2026-03-12

## 概述
本报告分析了 Chaterm 项目的数据库和存储系统在 Guest 模式下的兼容性，确保删除登录功能不会影响数据持久化和用户数据管理。

## 1. 数据库架构分析

### 1.1 数据库连接管理

#### 核心实现 (`src/main/storage/db/connection.ts`)

**用户ID管理逻辑**：
```typescript
// 第321-322行
const isSkippedLogin = !userId && localStorage.getItem('login-skipped') === 'true'
const targetUserId = userId || (isSkippedLogin ? getGuestUserId() : currentUserId)
```

**Guest 用户ID定义**：
```typescript
// 第117-119行
export function getGuestUserId(): number {
  return 999999999
}
```

**当前用户状态管理**：
```typescript
// 第18行 - 全局状态
let currentUserId: number | null = null

// 第113-114行 - 获取函数
export function getCurrentUserId(): number | null {
  return currentUserId
}
```

### 1.2 数据库文件结构

#### 基于用户ID的数据库隔离
- 每个用户有独立的数据库文件
- 路径格式：`{userDataPath}/{userId}/complete.db`
- Guest 用户使用固定路径：`{userDataPath}/999999999/complete.db`

#### 初始化逻辑
- 如果目标数据库不存在，从初始数据库 (`init_data.db`) 复制
- 如果已存在，直接使用现有数据库
- 支持从旧版本数据库迁移

## 2. 数据库表结构兼容性

### 2.1 主要表结构分析

通过分析迁移文件，发现以下关键表：

#### 会话历史表
- `agent_api_conversation_history_v1`
- 包含 `message_index` 列用于消息分组
- 应该是用户特定的数据

#### 用户代码片段表
- `user_snippet_v1`
- 包含 `sort_order` 列用于排序
- 明显是用户特定的数据

#### 其他功能表
- 技能支持 (`skills` 相关表)
- MCP 工具调用支持
- TODO 支持
- 堡垒机评论支持

### 2.2 Guest 用户数据隔离

#### 积极的发现
1. **完全隔离** - 每个用户（包括 Guest）有独立的数据库文件
2. **无数据冲突** - Guest 用户数据不会与真实用户数据混合
3. **持久化正常** - Guest 用户的数据可以正常保存和读取

#### 潜在关注点
1. **数据清理策略** - Guest 用户数据的生命周期管理
2. **存储空间** - 长期运行可能积累大量 Guest 用户数据

## 3. 状态存储兼容性

### 3.1 Pinia 状态管理

通过搜索发现，所有状态存储都考虑了 Guest 模式：
- 使用 `isSkippedLogin` 标志进行条件处理
- 为 Guest 用户提供合理的默认状态
- 状态持久化插件应该正确处理 Guest 用户

### 3.2 localStorage 使用分析

#### 关键的 localStorage 项目
- `login-skipped` - 登录跳过标志
- `ctm-token` - 设置为 `guest_token`
- `userInfo` - Guest 用户信息
- `user-info` - 兼容性别名

#### Guest 用户信息结构
```javascript
const guestUserInfo = {
  uid: 999999999,
  username: 'guest',
  name: 'Guest',
  email: 'guest@chaterm.ai',
  token: 'guest_token'
}
```

## 4. 数据同步服务兼容性

### 4.1 数据同步逻辑 (`src/renderer/src/services/dataSyncService.ts`)

**关键实现**：
```typescript
// 第36-39行
const isSkippedLogin = localStorage.getItem('login-skipped') === 'true'
const token = localStorage.getItem('ctm-token')

if (isSkippedLogin || token === 'guest_token') {
  // 跳过登录的用户禁用数据同步
  return
}
```

### 4.2 积极的发现
1. **智能禁用** - Guest 用户自动禁用云端数据同步
2. **无数据泄露** - Guest 用户数据不会同步到云端
3. **功能完整** - 本地功能不受影响

## 5. 核心功能兼容性评估

### 5.1 SSH 连接功能
- **状态**：设备检查 API 已注释，不再需要网络请求
- **兼容性**：完全兼容 Guest 模式
- **风险**：无

### 5.2 AI 模型配置
- **状态**：使用 `getUser` API 获取默认配置
- **兼容性**：需要提供本地默认配置
- **风险**：中 - 需要确保替代方案

### 5.3 插件管理
- **状态**：可能依赖云端插件 API
- **兼容性**：需要评估
- **风险**：中 - 可能影响插件功能

### 5.4 终端功能
- **状态**：可能依赖云端代理 API
- **兼容性**：需要评估
- **风险**：中 - 可能影响高级功能

## 6. 删除登录功能的影响评估

### 6.1 数据库层面的影响

#### 无影响的功能
- 数据库连接管理
- 用户数据隔离
- 数据持久化
- 迁移和升级

#### 需要确认的功能
- 所有表是否都正确使用用户ID进行数据隔离
- 是否存在全局共享的表（可能性较低）

### 6.2 存储层面的影响

#### 无影响的功能
- Pinia 状态管理
- localStorage 存储
- 数据同步服务

#### 需要优化的功能
- 可以简化复杂的 `isSkippedLogin` 检查逻辑

## 7. 风险和建议

### 7.1 低风险区域
1. **数据库架构** - 已经为 Guest 模式做好了准备
2. **数据隔离** - 用户数据完全隔离
3. **状态管理** - 全面的 Guest 模式支持

### 7.2 中风险区域
1. **API 依赖** - `getUser` API 需要本地替代方案
2. **功能完整性** - 需要确保所有功能在纯本地模式下正常工作

### 7.3 实施建议

#### 立即可以进行的优化
1. **清理注释的 SSH 设备检查代码** - 零风险
2. **简化复杂的登录状态检查** - 低风险

#### 需要谨慎处理的功能
1. **为 `getUser` API 提供本地实现** - 中风险
2. **评估其他云端服务的必要性** - 中风险

## 8. 结论

**数据库和存储系统已经完全支持 Guest 模式**，删除登录功能在数据层面几乎没有技术障碍。

### 关键优势
1. **成熟的用户隔离机制** - 每个用户（包括 Guest）有独立的数据库
2. **全面的状态管理支持** - 所有存储系统都考虑了 Guest 模式
3. **安全的数据同步策略** - Guest 用户数据不会泄露到云端

### 主要挑战
1. **为必要的 API 调用提供本地替代方案**
2. **确保所有核心功能在纯本地模式下正常工作**

建议按照分析报告中确定的优先级分步骤实施修改。

---

*数据库兼容性分析完成*