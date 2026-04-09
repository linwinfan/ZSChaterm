# 修改计划：Mingyu堡垒机自动选择目标主机

## 问题描述

mingyu类型的JumpServer在显示GateShell菜单时，用户希望程序能自动定位并选择要连接的主机，而不是手动操作。

## 修改内容

### 修改1：连接时的自动选择尝试

**位置**: `src/main/ssh/jumpserver/interaction.ts` 第881-909行

**修改说明**：
- 检测到GateShell菜单时，进入`selectTarget` phase，调用`tryProgressMingyuSelection`尝试自动选择
- 如果`outputBuffer`中已包含完整菜单且能找到匹配主机，自动发送选择命令
- 如果`outputBuffer`中菜单不完整，发送`r`命令刷新列表，等待下一批数据

### 修改2：selectTarget phase的处理

**位置**: `src/main/ssh/jumpserver/interaction.ts` 第1018行附近

**修改说明**：
- 在`selectTarget` phase下收到数据时，调用`tryProgressMingyuSelection`继续选择流程
- 如果`tryProgressMingyuSelection`返回`false`（无法自动选择），回退到手动模式

## 自动选择流程

1. 检测到菜单 → 进入`selectTarget` phase
2. 解析`outputBuffer`中的资产列表
3. 根据`targetIp`/`targetHostname`/`targetAsset`查找匹配的主机
4. 找到 → 发送选择命令（`:编号\r`或上下键）
5. 未找到 → 发送`r`命令刷新列表
6. 刷新后仍未找到 → 回退到手动模式

## 预期行为

- 如果用户选择的主机（如172.21.16.16 zabbix-web）在JumpServer菜单中 → 自动选择并连接
- 如果主机不在菜单中 → 显示手动操作提示

## 待确认

需要确认：
1. 用户选择主机的IP是否正确传递（检查日志中的`targetIp`）
2. JumpServer菜单中是否包含用户想要连接的主机
