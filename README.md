# Flightdeck

**Flightdeck** 是一个多代理编排平台（Multi-Agent Orchestration Platform），用于协调多个 AI 代理协同完成复杂的软件工程任务。

## 什么是 Flightdeck？

在大型项目中，单个 AI 代理往往难以独立处理复杂的工程任务。Flightdeck 通过层次化的代理架构，将工作分解、分配、执行和验证，实现多个代理的高效协作。

### 核心能力

- **🎯 任务编排** — 自动将需求拆解为 DAG 任务图，按依赖关系调度执行
- **🤖 多代理协作** — 支持 Worker、Reviewer、Scout 等多种角色，各司其职
- **🔌 多运行时支持** — 兼容 Codex、Claude Code、Gemini、Copilot 等主流 AI 代理
- **🛡️ 质量保障** — 内置交叉审查、质量门禁和独立验证机制
- **📡 MCP 协议** — 通过 MCP Server 无缝接入各类 AI 客户端

### 架构概览

```
用户 → Lead（决策） → Director（执行管理） → Orchestrator（调度） → Workers（实现） → Reviewers（审查）
```

### 快速开始

```bash
pnpm install
flightdeck init
flightdeck start
```

## 了解更多

- [架构设计](./ARCHITECTURE.md)
- [设计文档](./DESIGN.md)
- [贡献指南](./CONTRIBUTING.md)

## License

MIT
