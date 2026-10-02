# Portal 身份协议与 Go 测试适配

协议来源是 Portal `3925a9dc101a3928e5e590047b0b3c7a3be729db` 的实际签名器、接入规范第5节和原始[公共样例](../examples/portal-identity.vectors.json)。固定JSON含56项，SHA256为 `e5203003723a6d442c7ff1ddc9336efb70ef3cd6a8cde5eb6247b115468f8fc3`；测试检查文件字节、版本、协议、用例总数及唯一名字。测试密钥和用户均为公开虚构数据，不能用于部署。

## UUID 与认证边界

身份UUID按Portal的大小写不敏感 `8-4-4-4-12` 十六进制形状检查，不额外限制版本、variant或nil UUID；不接受紧凑、花括号或URN形式。`uuid.Parse`允许更广输入，不能代替生产身份格式检查。

HMAC七行使用原始头字符串，保留UUID原大小写及编码字节；不能先小写化、解码或trim后再验签。成功验证及解码之后，返回的 `PortalUser.UID` 才转为小写。其他返回字段、通用401、日志reason、时间界限和恒定时间比较保持同一协议。numeric userId仍参与HMAC但不用于业务关联；本应用现有PortalUser仅含UID/username/roles，固定样例测试仅在真实验签通过后透明投影被签名绑定的numeric ID。

成员目录已经保存canonical UUID；应用继续用精确UID查询既有成员、角色和owner，不修改这些表、角色规则、对象key或历史审计。维护审计actor与grantor来源字段不属于入口用户身份，不新增UUID数据库约束，也不重写这些记录。上线前用只读聚合检查历史大写、非法UUID与大小写碰撞；发现异常需先单独决定兼容方案，不自动合并身份或角色。

## 56分类：55 native 与1项 N/A

原JSON的 `array-header-roles` 含**单元素JS数组**，示例函数由于输入类型不是string而拒绝。Go的 `http.Header` 本来就是 `map[string][]string`：正常单值也存成一元素slice。两种JSON类型映射到原生Header后完全相同，这个JS输入类型错误无法等价表达。

- 55个可表达输入按Go canonical header name映射，真实调用生产verifier。13个正例严格比较真实UID/name/roles和验签后的numeric ID投影；42个反例检查真实reason。
- 唯一上述用例明确为 **N/A：JS输入类型无法等价表达为Go原生Header**。独立适配测试核对原JSON类型/长度及原生结构碰撞，且只允许这一项N/A；它不伪造拒绝，不复制数组元素，不计作runtime通过，也不静默跳过。
- 必需头的两元素数组可映射为两个原生值，实际拒绝。真实TCP HTTP/1.1补充测试另验证正常单值、大小写头名、真实重复字段、缺失/空roles、非法roles及UUID、原大小写签名和验签后canonical输出。

因此报告“官方56分类 = **55 native runtime + 1 N/A类型边界**”，不能声称56个跨语言runtime结果全等。Go测试通过的N/A分类断言只证明这一限制被显式检查。

## 本地与镜像验收

`scripts/test-backend-postgres.sh ./middleware ./router` 使用一次性测试数据库，不读取生产.env。完整Go回归、race、前端测试/typecheck/build以及现有生命周期测试按CI关卡运行；有效鉴权fixture用 `testportal.SyntheticUID` 将可读标签显式构造成稳定UUID，签名辅助函数本身不更改原始身份，所以不会掩盖非法输入负例。

真实linux/amd64镜像测试必须显式提供 `TEST_IMAGE`：

```sh
TEST_IMAGE=<new-image> node --test scripts/test-production-image.test.mjs
TEST_IMAGE=<new-image> TEST_ROLLBACK_IMAGE=<verified-baseline-image> node --test scripts/test-production-image.test.mjs
```

第二条在同一个隔离数据库中实际运行基线镜像，再运行新镜像，验证已排空的写入仍可读取、成员不变、强制验签和正常停机。只有提供并实际执行回滚镜像分支才报告该验证通过。它使用本地合成画布及回环OSS配置，不读取生产凭据，不打开真实业务UI。
