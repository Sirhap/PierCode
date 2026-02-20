# Ground-Link 实施计划

**版本**: v1.0
**日期**: 2026-02-18
**参考**: [设计文档](./2026-02-18-ground-link-design.md)

---

## 概述

实施 ground-link 浏览器本地代理系统,包含 Go Server 和 Chrome Extension 两个核心组件。

---

## Phase 1: Go Server 基础框架

### 1.1 初始化项目
- 创建 go.mod
- 搭建目录结构
- 安装 Gin 依赖

### 1.2 实现核心数据结构
**文件**: `internal/types/types.go`
- ToolRequest
- ToolResponse
- Config

### 1.3 实现安全层
**文件**: `internal/security/sandbox.go`
- SafePath() 函数
- 命令黑名单检查

### 1.4 实现 HTTP 服务
**文件**: `internal/server/server.go`
- GET /health
- GET /config
- POST /exec (框架)

### 1.5 实现入口
**文件**: `cmd/server/main.go`
- 命令行参数解析
- 启动 HTTP 服务

**验收标准**:
- `go run cmd/server/main.go -dir=. -port=8080` 可启动
- `curl http://localhost:8080/health` 返回正确响应

---

## Phase 2: 工具执行器

### 2.1 实现工具执行器框架
**文件**: `internal/executor/executor.go`
- Execute() 主函数
- 超时控制 (context.WithTimeout)

### 2.2 实现 list_dir
- 读取目录
- 返回文件列表

### 2.3 实现 read_file
- SafePath 校验
- 读取文件内容

### 2.4 实现 write_file
- SafePath 校验
- 支持 overwrite/append 模式

### 2.5 实现 exec_cmd
- 命令黑名单检查
- 执行 shell 命令
- 超时控制

**验收标准**:
- curl 测试所有 4 个工具均可正常执行
- 路径越界被正确拦截
- 危险命令被正确拦截

---

## Phase 3: 浏览器插件基础

### 3.1 创建插件目录结构
- extension/manifest.json
- extension/background.js
- extension/content.js
- extension/injected.js
- extension/popup.html/js
- extension/styles.css

### 3.2 实现 manifest.json
- Manifest V3 配置
- 权限声明
- Content Script 注入规则

### 3.3 实现 injected.js
- 劫持 fetch/XMLHttpRequest
- 监听流式响应
- 提取 <tool> 标签

**验收标准**:
- 插件可加载到 Chrome
- Console 可看到拦截日志

---

## Phase 4: 插件交互功能

### 4.1 实现 XML 解析器
**文件**: `extension/content.js`
- parseToolCall() 函数
- 实时解析流式响应

### 4.2 实现确认 UI
- 渲染确认卡片
- 运行/拒绝按钮
- 显示工具名称和参数

### 4.3 实现与 Server 通信
- 发送 POST /exec 请求
- 处理响应

### 4.4 实现输入框回填
- 查找 textarea
- 填充结果
- 模拟点击发送

**验收标准**:
- 在 DeepSeek 输出 <tool> 时弹出确认 UI
- 点击运行后结果自动回填并发送

---

## Phase 5: 集成测试与优化

### 5.1 端到端测试
- 启动 Go Server
- 加载插件
- 在 DeepSeek 测试完整流程

### 5.2 安全测试
- 测试路径越界攻击
- 测试危险命令拦截
- 测试超时机制

### 5.3 UI 优化
- 美化确认卡片样式
- 添加加载状态
- 错误提示优化

**验收标准**:
- 完整流程可正常运行
- 所有安全测试通过
- UI 体验流畅

---

## 关键文件清单

### Go Server
```
cmd/server/main.go              # 入口,命令行参数
internal/types/types.go         # 数据结构
internal/security/sandbox.go    # 安全层
internal/executor/executor.go   # 工具执行器
internal/server/server.go       # HTTP 服务
```

### Browser Extension
```
extension/manifest.json         # 插件配置
extension/injected.js           # fetch 劫持
extension/content.js            # UI 和通信
extension/popup.html/js         # 插件弹窗
extension/styles.css            # 样式
```

---

## 实施顺序

1. Phase 1 → Phase 2 (Go Server 完整实现)
2. Phase 3 → Phase 4 (插件完整实现)
3. Phase 5 (集成测试)

**预计时间**: 3-5 天
