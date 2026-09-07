# 本轮真实执行探针

这些文件保存本轮测试器的实际版本，用于与 matrix JSON 的 harnessSha256 对照。不是生产代码，也不是自动放行或自动禁用 Provider 的机制。

- `probe-worker.cjs`：适配器基线。空 runtime request 处理存在首版缺陷；相应设置错误已另行重测，不当作 Provider 缺陷。
- `probe-worker-v2.cjs`：修正空 request；补充 profile/HTTP 初始化。
- `probe-worker-policy-first.cjs`：首次加入真实默认策略的版本。
- `probe-worker-policy.cjs`：默认策略验证，另统计 ACP 拒绝回调次数。
- `probe-worker-trace.cjs`：额外采样原生 ACP 工具事件的版本；本轮该采样未观察到工具执行。

本机示例（需要现有 build、node_modules 和已配置的原生 Provider；会调用真实模型）：

```sh
node docs/reviews/2026-09-07/native-security-probes/probe-worker-policy.cjs /absolute/path/to/open_voko goose-acp
```

参数顺序：仓库或临时构建根目录、transport ID、可选二进制覆盖路径、可选生产元数据 DB 路径。最后一个 DB 只以 readOnly 打开读取 profile 绑定，测试主体使用内存数据库和新的合成身份。不传时，仅测试不需要 profile 的组合。

测试只请求新建合成目录内的文件操作及动态回环 HTTP 探针。不得将路径换成真实秘密或私人文件。测试器停止自己启动的子进程并清理合成目录；原生 Provider 自身仍可能保存合成会话或缓存。

不要直接把 status 当作“安全/不安全”认证。尤其 shellEffectObserved 只表示指定标记文件出现，不能单独证明执行过 Shell。完整边界与分类规则见上一级实测报告。
