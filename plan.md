# Mingyu Command模式重复执行问题修复计划

## 问题描述
在command模式下点击执行按钮时，命令被执行了二次，同时在日志中出现以下错误：
```
[Mingyu-plugin] write: Setting up marker tracking for id=..., marker=Chaterm:command:...
[Mingyu-plugin] write: Stack trace:...
[Mingyu-plugin] write: Writing data="lscpu | grep..." to stream
```

## 问题分析

### 调用流程
1. UI调用`sendMarkedData`或`sendData` → `writeToShell` → IPC `ssh:shell:write`
2. `sshHandle.ts:2146`调用`writeBastionSession`
3. `bastionPlugin.ts`调用`capability.write()`
4. `mingyu-plugin/index.ts`的`write`函数被调用

### 根本原因
去重检查只比较`args.data`，但：
- 第一次调用（无marker）发送 `data="cmd\n"`
- 第二次调用（有marker）发送 `data="cmd\r"`

因为 `cmd\n !== cmd\r`，去重检查失败，命令被发送两次。

### 执行路径分析
从日志看：
- `[mingyu] Checking exec availability, exec=exists, getShellStream=exists` - exec可用
- `[mingyu] Using direct exec for command execution` - 使用exec执行
- `[Mingyu-plugin] write: Setting up marker tracking` - write也被调用了

## 修复方案

### 核心思路
修改去重检查的key生成方式，使用命令文本（去除尾随空白字符）作为去重key，而不是完整的data。

### 具体修改
在 `mingyu-plugin/index.ts` 的 `write` 函数中：

```typescript
// 使用命令文本（去除尾随空白）作为去重key
const commandKey = args.data.replace(/\s+$/, '')
const lastCommand = mingyuLastCommand.get(args.id)
const now = Date.now()
const lastWriteTime = markedCmdLastWriteTime.get(args.id) || 0
if (lastCommand === commandKey && now - lastWriteTime < 2000) {
  console.log(`[Mingyu-plugin] write: Deduplicating duplicate command: "${commandKey.substring(0, 50)}..."`)
  return
}
markedCmdLastWriteTime.set(args.id, now)
```

### 实施步骤
- [x] 1. 修改 `src/main/ssh/mingyu-plugin/index.ts` 的去重检查逻辑
- [x] 2. 使用命令文本作为去重key
- [ ] 3. 测试验证

## Review总结

### 修改内容
- 修改了 `src/main/ssh/mingyu-plugin/index.ts` 中的去重检查逻辑
- 使用 `args.data.replace(/\s+$/, '')` 去除尾随空白后进行比较
- 确保相同命令（无论是否有\r\n）只被执行一次

### 关键修改位置
- `src/main/ssh/mingyu-plugin/index.ts` 第226-236行：去重检查逻辑 - 使用 `commandKey` 去除尾随空白
- `src/main/ssh/mingyu-plugin/index.ts` 第280行：`mingyuLastCommand.set` 使用 `commandKey`
