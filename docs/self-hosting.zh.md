# 将 DSH 作为 systemd 服务自托管

[English](self-hosting.md) | 中文

本页说明如何在 Linux 主机上把已构建的检出作为长期运行的服务来运行、切换它所提供的版本，以及回滚。它补充 [development.md](development.zh.md)（贡献者工作流），并假定读者已经知道如何构建本仓库。

## 前置条件

- 主机上安装了 Node.js 24.9 或更高版本，并且在服务的 `PATH` 中可通过 `node` 访问。
- 本仓库的一份检出，已安装依赖并由 `pnpm run build:artifacts` 构建出产物。
- 一个 systemd 单元，它从服务用户拥有的路径运行 `dsh` 启动器，从而无需 root 即可替换该启动器。

## 从源码构建

构建一次产物；后续启动会复用它们，不会重新构建。

```sh
cd deepseek-harness
pnpm install
CI=1 DSH_GATE_CONCURRENCY=1 pnpm run build:artifacts --serial
```

内存约 2 GiB 的主机需要 `--serial` 配合 `DSH_GATE_CONCURRENCY=1`，因为每个编译步骤都会申请 8 GiB 的 V8 老生代上限，并发执行会耗尽交换空间。在两个 vCPU 上，冷构建大约需要十一分钟，其中最长的步骤是宿主编译器。

## 作为 systemd 服务运行

单元的 `ExecStart` 必须通过服务用户可改写的路径解析启动器。pnpm 生成的全局 shim 就是这样一个路径：它是一个普通 shell 脚本，其 `exec` 行以已安装的 `bin.js` 结尾。

```sh
ExecStart=/home/ubuntu/.local/share/pnpm/bin/dsh web --host 127.0.0.1 --port 3080 --no-open
```

将 `Restart=always` 与较短的 `RestartSec` 一起设置。配合由用户拥有的启动器路径，这一对配置就是完整的升级机制：systemd 会通过该路径当前包含的内容重新启动进程。

## 切换服务所运行的版本

把启动器重新指向新的构建，然后向主进程发送信号，使 systemd 通过它重新派生进程。整个过程既不修改单元也不使用 `systemctl restart`，因此除了服务用户之外不需要任何特权。

```sh
OLD=$(systemctl show dsh-web -p MainPID --value)
kill "$OLD"
```

一个直接运行检出的朴素启动器是最简单的形式。

```sh
#!/bin/sh
exec /usr/bin/node /home/ubuntu/deepseek-harness/apps/cli/lib/bin.js "$@"
```

服务只在一次 `RestartSec` 加上启动时间内中断，在小型主机上是数十秒。

## 验证正在运行的版本

- 确认单元处于活动状态且主 PID 已改变：`systemctl is-active dsh-web` 与 `systemctl show dsh-web -p MainPID --value`。
- 确认进程命令行指向新的入口：`tr '\0' ' ' < /proc/$PID/cmdline`。
- 确认启动器报告预期的版本：`dsh --version`。
- 确认 Web 监听器有响应：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/`。
- 确认组合后的配置保留了每一个条目：`dsh web --dump-config`，然后将其条目数量和标识符与上一个发行版比较。

## 回滚

恢复先前的启动器，并再次向主进程发送信号。复用相同的重新派生路径，使回滚的中断时间不超过升级。

```sh
cp -a backup/dsh-shim /home/ubuntu/.local/share/pnpm/bin/dsh
kill "$(systemctl show dsh-web -p MainPID --value)"
```

## 注意事项

- 切换前备份启动器和 DSH 主目录。`~/.dsh` 保存配置文件、凭据、会话和存储，而配置文件里的 `cordis.patch.yml` 承载运维者自己的插件覆盖。
- 发行版可能改变会话格式。跨此类发行版回滚时也要恢复备份的主目录，因为较旧的二进制可能无法读取升级后写入的会话。
- 从检出运行会使服务依赖该目录。删除它会破坏服务，直到恢复启动器。
- 跨发行版比较 `--dump-config` 输出，以发现上游删除或重命名的条目，并检查组合后的树，而不只是配置文件。
