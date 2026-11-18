# 043 证书测试夹具（certs/）

2026-11-17 在探针工作区（D:\code\probe-042）生成的**一次性本地测试证书**，
用于真机验证 043 证书策略（自签 interstitial / 域名不匹配 / 私有 CA 放行）。

⚠️ 全部密钥与证书仅限本地测试使用：自签名、无真实域名、生成时无任何真实凭据
参与。严禁用于任何真实服务。

| 文件 | 用途 |
|---|---|
| `self-signed.crt/.key` | 自签证书 → 触发 `ERR_CERT_AUTHORITY_INVALID` interstitial（043 FR-002） |
| `wrong-domain.crt/.key` | 域名不匹配 → `ERR_CERT_COMMON_NAME_INVALID` |
| `ca.crt/.key` + `private-ca.crt/.key` | 私有 CA 签发链 → 验证 043「受信 CA 放行」策略 |

用法：`openssl` 起一个带证书的本地 https 服务（如
`openssl s_server -cert self-signed.crt -key self-signed.key -www -port 8443`），
再用内置浏览器页签访问 `https://127.0.0.1:8443/`，观察 interstitial 与 043
策略接管后的行为。
