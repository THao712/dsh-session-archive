# session-archive — 每个对话一个工作区目录

DeepSeek Harness 的默认工作区里，同一工作区的多个会话共用一个工作目录，中间文件和结果文件容易混在一起。这个插件让**每个新会话自动拥有自己的文件夹**，并在第一次请求之前把会话的工作目录切进去，于是工具里的相对路径天然落在该文件夹内。

```text
<workspace>/conversations/2026-11-17_1430_标题/
  work/        中间文件
  out/         最终产物
  session.json 会话 ID、工作区、目录名
  AGENTS.md    工作区规则的本地副本
```

## 设计目标

这个插件主要解决**默认工作区**的混乱：默认工作区是未归属到具体项目的对话的通用收件箱，所有会话共享同一个工作目录，时间一长文件和中间产物容易混在一起。

其他工作区通常是用户主动选择的项目目录，通常由项目自身的目录结构管理；同一个项目里的多个会话仍然共享该目录，DSH 不会自动按对话再分一层。因此插件默认只处理 `default-workspace`，不会在项目仓库里额外创建 `conversations/`。如果确实希望某个项目工作区也按会话隔离，把它的绝对路径加入 `roots`。

## 搭配会话清理插件效果更好

推荐同时安装：

- 会话清理：[THao712/dsh-session-cleaner](https://github.com/THao712/dsh-session-cleaner)

session-archive 负责“每个对话一个目录”，会话清理插件负责预览并永久删除已归档会话、日志、检查点、附件、工作区文件，以及这些对话目录。

两者配合后，会话清理可以：

- 从 `conversations/index.json` 和 `session.json` 找到会话对应的对话目录；
- 删除会话时可选“同时整目录删除”；
- 在独立的“对话目录”区域按“保留 out”或“全部删除”清理；
- 清理会话记录已经不存在、但目录仍残留的孤儿目录；
- 通过共享的 `conversations/.index.lock` 串行更新索引，避免两边互相覆盖。

单独使用会话清理插件也可以清理日志、附件和工作区文件，只是没有按对话隔离的目录可管理。推荐使用兼容版本：session-archive `1.3.0` 与 session-cleaner `1.10.0` 或更高。

**安装 session-cleaner 不会自动下载或启用 session-archive。** 两者是独立的 bundle，需要分别安装；这样用户可以选择是否采用“每个对话一个目录”的布局。

## 行为

会话第一次组装提示词时（`system-prompt/assemble`）：

1. 判断会话是否属于配置里的工作区（`roots`），子会话（`delegationDepth > 0`）默认跳过。
2. 若当前工作目录已经在 `conversations/` 下，说明是恢复的会话，直接沿用。
3. 否则按 `conversations/<YYYY-MM-DD_HHmm>_<标题>/` 建目录，内部再建 `work/` 与 `out/`，写 `session.json`，并把映射追加到 `conversations/index.json`。
4. 索引采用临时文件加原子替换；更新前先持有 `conversations/.index.lock`，与会话清理插件共用同一把锁。锁只属于仍存活的持有者：不会因为任务耗时超过固定秒数而接管，进程退出后才恢复。
5. 直接提交 `working-directory/change` 事件把会话目录切过去（持久化，恢复会话后仍然有效）。

   **不**调用 `workingDirectory.set()` 的“通知”分支：那个方法还会向模型收件箱塞一条 “The working directory changed from … to …” 的用户消息，模型会把它当成新一步去回复，于是每个新对话开头都会多出一段“收到，当前工作目录已经是…”。直接提交事件只移动目录，提示词里的 `Current working directory` 照样正确，界面也不会多一条助手消息。想恢复旧行为就把 `notifyModel` 设为 `true`。

6. 兜底修正本轮提示词里的 `Current working directory`，保证模型第一次请求看到的就是新目录。
7. 把工作区根目录的 `AGENTS.md` 复制一份到会话文件夹（已有则不动）。原因：DSH 的指令发现从 cwd 向上找项目根标记，切进 `conversations/<dir>/` 后工作区根不再被认作项目根，根目录规则会被移出提示词；文件夹内这份副本让规则继续生效。

文件夹名优先取会话标题（`session/title`），没有标题时取第一条用户消息，再退化为 `session-<id 尾号>`；非法字符会折叠成 `-`，长度可配置。

**同一个会话无论隔多少天继续聊，都复用原目录**；只有新的 Session ID 才会创建新目录。目录名中的日期取自会话创建时间，不是每次回复的时间。

## 安装

从 GitHub 安装（GitHub-only 分发，不依赖 npm）：

```text
dsh plugin --profile <profile> add https://github.com/THao712/dsh-session-archive.git
```

Desktop 用户也可以在插件管理器中使用同一地址安装：

```text
plugin_manager install_bundle  target: https://github.com/THao712/dsh-session-archive.git
```

如果本机 npm 的 Git 协议配置允许 HTTPS shorthand，也可以使用 `github:THao712/dsh-session-archive`；遇到 SSH publickey 错误时改用上面的 HTTPS 地址。

本地开发时，把仓库绝对路径作为 bundle 安装：

```text
plugin_manager install_bundle  target: <仓库绝对路径>
```

安装完成后刷新页面，并**完全重启 DeepSeek Harness**（Host 插件在启动时加载）。仓库自带的 `cordis.patch.yml` 会插入插件条目，profile 的 `cordis.patch.yml` 不需要手写一条。

## 配置

在 `cordis.patch.yml` 的 `config` 下：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时完全不介入 |
| `roots` | `[]` | 要额外归档的工作区绝对路径；空数组表示只处理 `default-workspace` |
| `baseDir` | `conversations` | 会话文件夹的父目录 |
| `layout` | `split` | `split` 建 `work/`+`out/`；`flat` 只建一层 |
| `includeSubagents` | `false` | 子会话是否也单独归档 |
| `maxSlugLength` | `40` | 文件夹名中标题片段的长度上限 |
| `applyDirectory` | `true` | `false` 时只建目录、不切换工作目录（试运行用） |
| `notifyModel` | `false` | `true` 时改用 `workingDirectory.set()`，会多出一条“工作目录已变更”的用户消息，模型通常会回一句“收到…” |

`roots: []` 只处理默认工作区。如果要额外归档某个项目工作区，在 `cordis.patch.yml` 中写入它的绝对路径：

```yaml
config:
  roots:
    - 'D:\path\to\workspace'
```

## 自测

```powershell
node test/smoke.mjs
```

用桩 `ctx` 驱动 hook，覆盖：建目录、静默切换工作目录（只提交事件、不排队通知）、`notifyModel: true` 的旧行为、重复调用幂等、已归档会话不再移动、非目标工作区不动、子会话跳过、文件名清洗、并发会话写入索引、陈旧 `.index.lock` 恢复，以及活跃索引锁超过 15 秒仍保持互斥。

## License

MIT © 2026 THao712
