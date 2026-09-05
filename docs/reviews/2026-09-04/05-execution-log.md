# 已批准优化执行记录

用户已批准 v1；批准计划本体保持不变，当前状态以 execution-plan.json 为准。

## S0

- 集成工作树：`/Users/laoyu/Documents/ChatGPT/open_voko-optimization-20260904`。
- 基线：`a6e8f35d93940dfd021e443ab332060062aab181`。
- 独立 Node22.23.2/npm11.19.0；未替换全局环境。
- `npm ci --no-audit --no-fund`完成，锁文件未变。
- `npm run release:gate:code`退出0：1377通过，2个既有平台专用跳过，0失败。跳过为Windows DACL和Linux process-owned rollout。类型、构建、i18n、覆盖率基线、源码扫描通过。
- S1、S3、S4在分别独立源码/build工作树先写失败用例；只读共享锁定依赖，集成仍按阶段验证。
- 当前尚未进行生产/真实Provider/跨OS操作。

## S1 / S7

- 40项新增边界用例原26红；修复后40绿，扩展63通过。已合入79fa7b8。
- 独立复核发现MCP SDK ID类型比通用JSON-RPC更严格；null/小数修复7294212，unsafe integer补测修正中。
- R08仅提前128KiB长度上限；501字节自定义回溯正则仍可阻塞，保留风险。

## S2

- 旧owner、无凭据WS、注销后广播的原7项用例5红；修复及定向回归73通过，Node22构建/类型通过。
- 独立复核另外确认selected owner/token map不一致、介入页断线回调错误；各自增加失败行为测试后修复。
- 新增两项真实Chromium测试明确使用空extraHTTPHeaders：匿名健康可用/敏感WS关闭、HttpOnly Cookie收事件、注销关闭、新Cookie恢复；2/2通过。
- 相关提交5db04d0、56fc2b2；新增HTTP/WS/页面脚本单元测试11/11通过。

## S3

- 合入ae1dd0f。30新增行为用例，定向111/111通过；另一个专家独立复核42/42通过。
- 检查点仅首次无记录时bootstrap，后续按已提交检查点重试；不假设序号连续，不回放历史。
- 普通收集的Provider转发仅COMMIT后执行；不宣称UI/系统/E2EE副作用全事务。commit后进程退出仍无outbox级自动重投保证。

## S4

- 初版合入a764fa0，21新增行为用例，定向175/175通过；独立复核提出stop/start交错与挂起路由问题，正追加复现。
- 集成者误在Provider专属树执行cherry-pick/abort导致未提交代码丢失；已从全部13个暂存blob逐文件恢复，重新构建与175/175通过，提交14903c3后才合入。备份/tmp/voko-s4-recovered-20260904.tar。原主工作树未受影响。
- accepted并非最终成功；unknown外部执行不自动重投、不声称已取消，附件按有界TTL保留。

## S5 / S6 / S7 与追加复核

- S5提交5d7790a，4项SQLite红→绿，既有群工具47检查通过；另一专家4/4及144差分检查通过。R14八组基准已记录，不做IO/crypto改造。
- S6提交9b27e5a及e7bdeda，初12项10红→12绿。独立复核又复现APFS大小写/Unicode路径覆盖漏扫，新增预检与dev+ino防线，最终16/16及真实包扫描通过。GNU tar/Windows实跑仍未覆盖。
- R19真实SQLite缺前序可begin seq2；坏项首中尾时全批无执行无ACK。按批准条件保持failclosed，deferred_design。
- S4最后合入8e87d4b、15b2f48；实施者195/195相关测试及最后容量16/16，独立专家精确源码41/41。原反例（旧/重复final、停止后restart、CLI exit0 parser.error）均由独立探针确认已修。
- 不采用无界pending轮次集合或全局uncertain开关；每会话常量未决状态、有界session/reply元数据，只有显式可关联轮次才能提前清理附件，legacy附件保留TTL。未知执行结果不能当成取消或自动重投资格。

## S8 首轮集成验证

- 第一轮code gate在独立并行用例中1417通过/1失败/1平台跳过；另外前置1通过、23通过/1平台跳过。失败为旧provider-modularization测试仍把已写marker的子进程退出7当not_delivered；根据批准R12改为outcome_unknown并保留只执行一次断言，定向49/49通过。未削弱实现或绕过测试。
- 第一轮完整Chromium38/38通过。早期新增浏览器fixture使用非数字IM ID导致Fake服务退出，修为协议要求的数字ID；该失败留下的两个临时E2E runtime进程已按精确临时db路径停止。
- npm audit --omit=dev --audit-level=high：0 vulnerabilities。Gitleaks第一轮645 commits无命中。最终CodeQL和完整code gate在产品源码15b2f48启动，等待结果。
