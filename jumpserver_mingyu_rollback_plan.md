# 回退 Jumpserver/Mingyu 混合代码计划

## 背景

在将 Mingyu 堡垒机插件独立后（commit `d7e3ec40`），原来在 Jumpserver 插件中混入的 Mingyu 相关代码需要回退。

## 当前问题

`src/main/ssh/jumpserver/` 目录中的以下文件混入了 Mingyu 相关代码：
- `constants.ts` - 定义了 `JumpServerShellProfile = 'standard' | 'mingyu'`
- `navigator.ts` - 大量 `mingyu` profile 判断
- `parser.ts` - `parseMingyuAssets()` 函数
- `interaction.ts` - Mingyu 特定的交互逻辑
- `streamManager.ts` - Mingyu 特定的流管理
- `connectionManager.ts` - 连接复用时跳过 mingyu profile

---

## 可回退的修改清单

### 1. `src/main/ssh/jumpserver/constants.ts`

**问题**：第13行定义了 `JumpServerShellProfile = 'standard' | 'mingyu'`，第24-27行定义了 mingyu 专用字段。

**当前内容**：
```typescript
export type JumpServerShellProfile = 'standard' | 'mingyu'
// ...
mingyuSelector?: string
mingyuSelectionCommand?: string
mingyuTargetOrdinal?: number
mingyuCurrentOrdinal?: number
```

**建议**：回退到仅支持 `standard` profile。

---

### 2. `src/main/ssh/jumpserver/navigator.ts`

**问题**：大量 mingyu 相关的判断和函数。

**涉及内容**：
- `detectJumpServerShellProfile()` 返回 'mingyu'
- `resolveJumpServerShellProfile()` 处理 'mingyu'
- `getJumpServerListCommand('mingyu')` 返回 'r'
- `getJumpServerNextPageCommand('mingyu')` 返回 null
- `getJumpServerExitCommand('mingyu')` 返回 ':q'
- `hasJumpServerInitialMenuPrompt(output, 'mingyu')`
- `hasJumpServerCommandPrompt(output, 'mingyu')`
- `hasJumpServerMenuReturn(output, 'mingyu')`
- `extractJumpServerAuthenticationTarget(ctx, 'mingyu')`
- `getJumpServerAuthenticationTargetMismatch(ctx, ip, 'mingyu')`
- `hasPasswordError(text, 'mingyu')`

---

### 3. `src/main/ssh/jumpserver/parser.ts`

**问题**：
- 第313行 `mingyuMatch = output.match(MINGYU_PAGINATION_REGEX)`
- 第336-344行 `parseMingyuAssets()` 和相关逻辑

**涉及内容**：
- `MINGYU_PAGINATION_REGEX` 正则
- `parseMingyuAssets()` 函数
- `parseJumpserverOutput()` 中的 mingyu 处理分支

---

### 4. `src/main/ssh/jumpserver/interaction.ts`

**问题**：大量 mingyu 特定的处理逻辑，约占文件 60% 以上。

**涉及内容**：
- `mingyuListRequested` 状态变量
- `mingyuSelectionCommands` 数组
- `profile === 'mingyu'` 判断分支
- `hasJumpServerMenuReturn(outputBuffer, 'mingyu')`
- 等等

---

### 5. `src/main/ssh/jumpserver/streamManager.ts`

**问题**：类似 interaction.ts，混入了大量 mingyu 逻辑。

**涉及内容**：
- `createJumpServerExecStream` 中的 mingyu 逻辑
- `navigationPath.profile === 'mingyu'` 判断

---

### 6. `src/main/ssh/jumpserver/connectionManager.ts`

**问题**：
- 第235-236行：连接复用时跳过 mingyu profile

```typescript
if (existingData.jumpserverUuid === jumpserverUuid && existingData.navigationPath?.profile !== 'mingyu')
```

---

### 7. `src/main/ssh/jumpserver/__tests__/` 目录下的测试文件

**问题**：测试用例中包含 mingyu 相关的测试。

---

## 回退策略

### 方案 A：选择性回退（推荐）
- 仅删除/回退 mingyu 相关的判断、分支和字段
- 保留 standard profile 的所有功能
- 最小化代码变动

### 方案 B：完整回退到 e790c00d
- 将 jumpserver 目录完全回退到 mingyu 独立前的状态
- 丢失之后对 jumpserver standard profile 的改进

---

## 需要你确认

请逐个确认以下回退项，我将依次进行回退：

1. [ ] `constants.ts` - 移除 mingyu profile 类型和字段定义
2. [ ] `navigator.ts` - 移除 mingyu 相关的检测和返回函数
3. [ ] `parser.ts` - 移除 mingyu 相关的解析逻辑
4. [ ] `interaction.ts` - 移除 mingyu 特定的交互逻辑
5. [ ] `streamManager.ts` - 移除 mingyu 特定的流管理逻辑
6. [ ] `connectionManager.ts` - 移除 mingyu profile 跳过逻辑
7. [ ] 测试文件 - 移除 mingyu 相关的测试用例

请告诉我你想从哪个开始，或者是否需要更详细的说明。
