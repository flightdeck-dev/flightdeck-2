# Flightdeck 2.0 - 简易指南

欢迎使用 **Flightdeck 2.0**，一个强大的多代理编排引擎！

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 运行测试

```bash
npm test
```

### 3. 查看更多信息

- 📐 **[完整架构文档](./ARCHITECTURE.md)** — 深入了解系统设计
- 📖 **[贡献指南](./CONTRIBUTING.md)** — 如何参与开发
- 🎨 **[设计文档](./DESIGN.md)** — 核心设计原理

## 📋 主要特性

| 特性 | 说明 |
|------|------|
| **多代理编排** | 支持 Lead、Director、Workers 等多种角色 |
| **任务管理** | DAG 依赖解析、文件冲突检测 |
| **代码审查** | 自动跨模型验证、阻塞质量门 |
| **持久化存储** | SQLite 数据库（每项目隔离） |
| **CLI 工具** | 命令行接口管理任务、代理、消息 |
| **MCP 服务器** | HTTP API 接口 |

## 🏗️ 系统架构

```
User → Lead → Director → Orchestrator → Workers → Reviewers
```

## 📦 核心模块

- `core/` — 核心数据类型和状态机
- `dag/` — 任务依赖关系管理
- `agents/` — 代理生命周期管理
- `orchestrator/` — 事件驱动的任务分配
- `isolation/` — 文件隔离和 Git 集成
- `verification/` — 代码审查验证
- `cli/` — 命令行接口

## 🔧 基本用法

### 任务管理

```bash
flightdeck task add "Build auth" --role backend
flightdeck task list
flightdeck task start tk-abc123 --agent coder-1
```

### 代理管理

```bash
flightdeck agent register coder-1 --role backend
flightdeck agent list
```

### 系统状态

```bash
flightdeck status
flightdeck providers
```

## 📚 更多信息

完整的命令文档和 API 说明，请查看 [README.md](./README.md)。

## 📝 许可证

有关许可证信息，请查看项目根目录。
