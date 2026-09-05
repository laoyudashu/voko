# 审查证据探针

这些脚本保存首审与对抗复核使用的源码级断言，便于复核证据。**断言描述的是修复前错误/反例，不是修复后应该继续通过的产品回归测试。** 修复阶段要针对真实模块另写期望正确行为的回归，不能将它们直接接入正常CI。

- `primary-probes.cjs`：首审10组断言。
- `adversarial-probes.cjs`：对抗复核新增8组断言。
- 原执行环境：Node26.7，本地安装的TypeScript，源码基线 `a6e8f35`。未代替Node22/24及跨平台验收。
- 归档只调整了根路径定位：默认当前归档所在仓库，可用第一个参数指定审查的checkout。其他断言与专家执行稿相同。

在明确的审查checkout中可执行：

```sh
node docs/reviews/2026-09-04/evidence/primary-probes.cjs /absolute/path/to/review-checkout
node docs/reviews/2026-09-04/evidence/adversarial-probes.cjs /absolute/path/to/review-checkout
```

副作用边界：读取所选checkout源码/文件清单，内存转译和AST提取，内存SQLite，模拟网络与文件删除，临时内存Ed25519密钥，合成日志。正则探针在100ms VM预算内中断。不会访问真实服务、读用户数据库、使用真实凭据或执行真实删除。

输出中的PASS表示观察到了该断言描述的源码行为。R06会输出预期的合成COMMIT失败日志；脚本退出码和断言才用于判断探针是否完成。R13的对抗断言专门证明生产callback返回void，不能把首审async callback的类级现象直接外推为Provider排空缺陷。

归档脚本不保证未来源码变化后的AST抽取/依赖加载仍兼容；须先检查实际版本。`node --check`只证明语法可解析，不代表行为探针或产品测试通过。

## 实施阶段证据

以下脚本在仓库根目录运行，读取当前 `build/`，使用 Node22。先完成构建。它们不连接真实服务，临时文件及数据库在结束时清理。

- `voko-r14-attachment-benchmark.cjs staging 25 4`：附件分阶段基准；首参数也可为 `crypto`，大小为10或25MiB，并发为1或4。JSON为本次原始结果。
- `voko-s5-query-benchmark.cjs`：会话查询次数、计时与EXPLAIN；各jsonl保留修复前/后结果。调用数下降不等于稳定整体提速。
- `voko-s6-r19-boundary-probe.cjs`：实际SQLite缺前序仍可开始seq2，以及worker坏批次不执行/不ACK的证据。验证回调为合成，不替代真实签名/Gateway验证。

产品回归位于仓库 `test/` 和 `e2e/`；这些审查与基准脚本不是完整门禁。
